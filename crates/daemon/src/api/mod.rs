//! Authenticated, read-only HTTP application. Construction does not bind, open state, or run agents.

mod access;
mod error;

use std::{
    io,
    net::SocketAddr,
    sync::{
        Arc,
        atomic::{AtomicU8, Ordering},
    },
    time::Instant,
};

use axum::{
    Json, Router,
    extract::{
        DefaultBodyLimit, Path, Request, State,
        rejection::{JsonRejection, PathRejection},
    },
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
};
use legible_protocol::{
    ChatSnapshot, ChatStatus, DaemonHealth, DraftComment, PreflightReport, ReviewSession,
};
use serde::Deserialize;
use tokio::net::TcpListener;

use crate::{
    VERSION,
    sessions::{SessionRegistry, SessionService},
};

pub use access::BrowserAccess;
use access::{local_request, single_header};
use error::ApiFailure;

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const REVIEW_REVISION_HEADER: &str = "x-legible-review-revision";
const CONTENT_SECURITY_POLICY: &str = concat!(
    "default-src 'self'; ",
    "script-src 'self'; ",
    "style-src 'self' 'unsafe-inline'; ",
    "connect-src 'self'; ",
    "img-src 'self' data:; ",
    "frame-ancestors 'none'; ",
    "base-uri 'none'; ",
    "form-action 'self'",
);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum DaemonPhase {
    Starting,
    Ready,
    Stopping,
}

/// This slice holds a read-only service. Future mutations need a serialized blocking owner,
/// not filesystem operations on HTTP tasks. The runtime claims singleton ownership before load.
#[derive(Clone)]
pub struct ApiState(Arc<InnerState>);

struct InnerState {
    sessions: SessionService,
    preflight: PreflightReport,
    access: BrowserAccess,
    started_at: Instant,
    phase: AtomicU8,
}

impl ApiState {
    pub fn new(
        sessions: SessionService,
        preflight: PreflightReport,
        access: BrowserAccess,
    ) -> Self {
        Self(Arc::new(InnerState {
            sessions,
            preflight,
            access,
            started_at: Instant::now(),
            phase: AtomicU8::new(DaemonPhase::Starting as u8),
        }))
    }

    /// Readiness is explicit; constructing a router never claims that startup has completed.
    pub fn set_phase(&self, phase: DaemonPhase) {
        self.0.phase.store(phase as u8, Ordering::Release);
    }

    pub fn phase(&self) -> DaemonPhase {
        match self.0.phase.load(Ordering::Acquire) {
            0 => DaemonPhase::Starting,
            1 => DaemonPhase::Ready,
            _ => DaemonPhase::Stopping,
        }
    }

    fn registry(&self) -> &SessionRegistry {
        self.0.sessions.registry()
    }
}

/// Safe listener boundary for a future runtime. It does not initialize or checkpoint state.
pub async fn bind_loopback(address: SocketAddr) -> io::Result<TcpListener> {
    if !address.ip().is_loopback() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Only loopback binding is supported; use an SSH tunnel for remote access",
        ));
    }

    TcpListener::bind(address).await
}

pub fn build_app(state: ApiState) -> Router {
    Router::new()
        .route(
            "/api/auth",
            get(authenticated)
                .post(authenticate)
                .layer(DefaultBodyLimit::max(1024)),
        )
        .route("/api/health", get(health))
        .route("/api/preflight", get(preflight))
        .merge(session_routes())
        .fallback(not_found)
        .method_not_allowed_fallback(method_not_allowed)
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .with_state(state)
}

fn session_routes() -> Router<ApiState> {
    Router::new()
        .route("/api/sessions", get(sessions))
        .route("/api/sessions/{session_id}", get(session))
        .route("/api/sessions/{session_id}/comments", get(comments))
        .route("/api/sessions/{session_id}/chat", get(chat))
}

async fn guard(State(state): State<ApiState>, request: Request, next: Next) -> Response {
    let response = match request_rejection(&state, &request) {
        Some(response) => response,
        None => next.run(request).await,
    };

    secure_headers(response)
}

fn request_rejection(state: &ApiState, request: &Request) -> Option<Response> {
    if let Some(response) = phase_rejection(state.phase()) {
        return Some(response);
    }

    if !local_request(request.headers(), request.method(), request.uri()) {
        let error = ApiFailure::new(
            StatusCode::FORBIDDEN,
            "origin_forbidden",
            "Only same-origin local connections are accepted",
        );

        return Some(error.into_response());
    }

    let path = request.uri().path();
    let api = path == "/api" || path.starts_with("/api/");
    let exchange = path == "/api/auth" && request.method() == Method::POST;

    if api && !exchange && !state.0.access.authenticated(request.headers()) {
        let error = ApiFailure::new(
            StatusCode::UNAUTHORIZED,
            "browser_auth_required",
            "Open the connection URL printed by the daemon to reconnect",
        );

        return Some(error.into_response());
    }

    None
}

fn phase_rejection(phase: DaemonPhase) -> Option<Response> {
    let (code, message) = match phase {
        DaemonPhase::Starting => ("daemon_starting", "Legible is starting"),
        DaemonPhase::Stopping => ("daemon_stopping", "Legible is stopping"),
        DaemonPhase::Ready => return None,
    };

    let mut response =
        ApiFailure::new(StatusCode::SERVICE_UNAVAILABLE, code, message).into_response();
    response
        .headers_mut()
        .insert(header::RETRY_AFTER, HeaderValue::from_static("1"));

    Some(response)
}

fn secure_headers(mut response: Response) -> Response {
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(CONTENT_SECURITY_POLICY),
    );

    response
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AuthRequest {
    token: String,
}

async fn authenticate(
    State(state): State<ApiState>,
    body: Result<Json<AuthRequest>, JsonRejection>,
) -> Result<Response, ApiFailure> {
    let Json(body) = body.map_err(auth_request_error)?;

    if !state.0.access.accepts_bootstrap(&body.token) {
        return Err(ApiFailure::new(
            StatusCode::UNAUTHORIZED,
            "browser_auth_required",
            "Invalid connection token. Use the current daemon URL.",
        ));
    }

    let mut response = StatusCode::NO_CONTENT.into_response();
    response
        .headers_mut()
        .insert(header::SET_COOKIE, state.0.access.set_cookie());

    Ok(response)
}

fn auth_request_error(error: JsonRejection) -> ApiFailure {
    let status = match error.status() {
        StatusCode::PAYLOAD_TOO_LARGE => StatusCode::PAYLOAD_TOO_LARGE,
        StatusCode::UNSUPPORTED_MEDIA_TYPE => StatusCode::UNSUPPORTED_MEDIA_TYPE,
        _ => StatusCode::BAD_REQUEST,
    };

    ApiFailure::new(
        status,
        "invalid_auth_request",
        "A JSON connection token is required",
    )
}

async fn authenticated() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "authenticated": true }))
}

async fn health(State(state): State<ApiState>) -> Json<DaemonHealth> {
    Json(DaemonHealth {
        status: state.0.preflight.status,
        version: VERSION.into(),
        uptime_seconds: state.0.started_at.elapsed().as_secs(),
    })
}

async fn preflight(State(state): State<ApiState>) -> Json<PreflightReport> {
    Json(state.0.preflight.clone())
}

async fn sessions(State(state): State<ApiState>) -> Json<Vec<ReviewSession>> {
    Json(state.registry().list().cloned().collect())
}

type SessionPath = Result<Path<String>, PathRejection>;

async fn session(
    State(state): State<ApiState>,
    path: SessionPath,
) -> Result<Json<ReviewSession>, ApiFailure> {
    let id = session_id(path)?;
    Ok(Json(find_session(&state, &id)?.clone()))
}

async fn comments(
    State(state): State<ApiState>,
    path: SessionPath,
    headers: HeaderMap,
) -> Result<Json<Vec<DraftComment>>, ApiFailure> {
    let id = session_id(path)?;
    let session = current_session(&state, &id, &headers)?;
    Ok(Json(session.comments.clone()))
}

async fn chat(
    State(state): State<ApiState>,
    path: SessionPath,
    headers: HeaderMap,
) -> Result<Json<ChatSnapshot>, ApiFailure> {
    let id = session_id(path)?;
    let session = current_session(&state, &id, &headers)?;

    let snapshot = match state.registry().chat(&id) {
        Some(chat) => chat.snapshot.clone(),
        None => unavailable_chat(session),
    };

    Ok(Json(snapshot))
}

fn unavailable_chat(session: &ReviewSession) -> ChatSnapshot {
    ChatSnapshot {
        session_id: session.id.clone(),
        revision: 0,
        status: ChatStatus::Unavailable,
        backend: session.config.main.backend,
        model: session.config.main.model.clone(),
        unavailable_reason: Some(
            "Agent execution is not implemented in the Rust daemon yet".into(),
        ),
        review_pending: None,
        current_turn_id: None,
        current_item_id: None,
        retry_item_id: None,
        entries: Vec::new(),
        last_usage: None,
    }
}

fn session_id(path: SessionPath) -> Result<String, ApiFailure> {
    path.map(|Path(id)| id).map_err(|_| {
        ApiFailure::new(
            StatusCode::BAD_REQUEST,
            "invalid_session_id",
            "Invalid session ID",
        )
    })
}

fn find_session<'a>(state: &'a ApiState, id: &str) -> Result<&'a ReviewSession, ApiFailure> {
    state.registry().get(id).ok_or_else(|| {
        ApiFailure::new(
            StatusCode::NOT_FOUND,
            "session_not_found",
            "Review session not found",
        )
    })
}

fn current_session<'a>(
    state: &'a ApiState,
    id: &str,
    headers: &HeaderMap,
) -> Result<&'a ReviewSession, ApiFailure> {
    let session = find_session(state, id)?;
    let revision = review_revision(headers)?;

    if session.review_revision != revision {
        return Err(ApiFailure::new(
            StatusCode::CONFLICT,
            "stale_review_revision",
            "Review revision changed; reload this session",
        ));
    }

    Ok(session)
}

fn review_revision(headers: &HeaderMap) -> Result<u64, ApiFailure> {
    let value = single_header(
        headers,
        header::HeaderName::from_static(REVIEW_REVISION_HEADER),
    )
    .ok_or_else(invalid_review_revision)?;

    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(invalid_review_revision());
    }

    let revision = value
        .parse::<u64>()
        .map_err(|_| invalid_review_revision())?;

    if revision > MAX_SAFE_INTEGER {
        return Err(invalid_review_revision());
    }

    Ok(revision)
}

fn invalid_review_revision() -> ApiFailure {
    ApiFailure::new(
        StatusCode::BAD_REQUEST,
        "invalid_review_revision",
        "An explicit valid review revision is required",
    )
}

async fn not_found() -> ApiFailure {
    ApiFailure::new(StatusCode::NOT_FOUND, "not_found", "Route not found")
}

async fn method_not_allowed() -> ApiFailure {
    ApiFailure::new(
        StatusCode::METHOD_NOT_ALLOWED,
        "method_not_allowed",
        "Method not allowed",
    )
}
