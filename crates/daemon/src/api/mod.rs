//! Authenticated HTTP reads and WebSocket events. Construction never binds, loads, or runs agents.

mod access;
mod error;
mod events;

use std::{io, net::SocketAddr, sync::Arc, time::Instant};

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
use tokio::{net::TcpListener, sync::watch};

use crate::{
    VERSION,
    sessions::SessionService,
    state::{DaemonState, SessionView},
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
pub enum DaemonPhase {
    Starting,
    Ready,
    Stopping,
}

/// HTTP reads and events use the same serialized owner. The runtime must claim singleton
/// ownership before loading state; router construction does not complete startup or checkpoint it.
#[derive(Clone)]
pub struct ApiState(Arc<InnerState>);

struct InnerState {
    owner: DaemonState,
    access: BrowserAccess,
    started_at: Instant,
    phase: watch::Sender<DaemonPhase>,
}

impl ApiState {
    pub fn new(
        sessions: SessionService,
        preflight: PreflightReport,
        access: BrowserAccess,
    ) -> io::Result<Self> {
        let owner = DaemonState::start(sessions, preflight)?;
        let (phase, _) = watch::channel(DaemonPhase::Starting);

        Ok(Self(Arc::new(InnerState {
            owner,
            access,
            started_at: Instant::now(),
            phase,
        })))
    }

    /// Readiness is explicit; constructing a router never claims that startup has completed.
    pub fn set_phase(&self, phase: DaemonPhase) {
        self.0.phase.send_replace(phase);
    }

    pub fn phase(&self) -> DaemonPhase {
        *self.0.phase.borrow()
    }

    pub fn owner(&self) -> &DaemonState {
        &self.0.owner
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
        .route("/api/events", get(events::upgrade))
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

async fn health(State(state): State<ApiState>) -> Result<Json<DaemonHealth>, ApiFailure> {
    let preflight = state.owner().preflight().await?;

    Ok(Json(DaemonHealth {
        status: preflight.status,
        version: VERSION.into(),
        uptime_seconds: state.0.started_at.elapsed().as_secs(),
    }))
}

async fn preflight(State(state): State<ApiState>) -> Result<Json<PreflightReport>, ApiFailure> {
    Ok(Json(state.owner().preflight().await?))
}

async fn sessions(State(state): State<ApiState>) -> Result<Json<Vec<ReviewSession>>, ApiFailure> {
    Ok(Json(state.owner().sessions().await?))
}

type SessionPath = Result<Path<String>, PathRejection>;

async fn session(
    State(state): State<ApiState>,
    path: SessionPath,
) -> Result<Json<ReviewSession>, ApiFailure> {
    let id = session_id(path)?;
    let view = find_session(&state, &id).await?;

    Ok(Json(view.session))
}

async fn comments(
    State(state): State<ApiState>,
    path: SessionPath,
    headers: HeaderMap,
) -> Result<Json<Vec<DraftComment>>, ApiFailure> {
    let id = session_id(path)?;
    let view = current_session(&state, &id, &headers).await?;

    Ok(Json(view.session.comments))
}

async fn chat(
    State(state): State<ApiState>,
    path: SessionPath,
    headers: HeaderMap,
) -> Result<Json<ChatSnapshot>, ApiFailure> {
    let id = session_id(path)?;
    let view = current_session(&state, &id, &headers).await?;

    let snapshot = match view.chat {
        Some(snapshot) => snapshot,
        None => unavailable_chat(&view.session),
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

async fn find_session(state: &ApiState, id: &str) -> Result<SessionView, ApiFailure> {
    state.owner().session(id).await?.ok_or_else(|| {
        ApiFailure::new(
            StatusCode::NOT_FOUND,
            "session_not_found",
            "Review session not found",
        )
    })
}

async fn current_session(
    state: &ApiState,
    id: &str,
    headers: &HeaderMap,
) -> Result<SessionView, ApiFailure> {
    let view = find_session(state, id).await?;
    let revision = review_revision(headers)?;

    if view.session.review_revision != revision {
        return Err(ApiFailure::new(
            StatusCode::CONFLICT,
            "stale_review_revision",
            "Review revision changed; reload this session",
        ));
    }

    Ok(view)
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
