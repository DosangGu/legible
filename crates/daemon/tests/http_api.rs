mod common;

use std::{fs, net::SocketAddr, time::Duration};

use axum::{
    Router,
    body::{Body, Bytes, to_bytes},
    http::{HeaderValue, Method, Request, StatusCode, header, request::Builder},
    response::Response,
};
use legible_daemon::{
    VERSION,
    api::{ApiState, BrowserAccess, DaemonPhase, bind_loopback, build_app},
    sessions::{SessionService, SessionStore},
};
use legible_protocol::{
    ChatSnapshot, ChatStatus, DaemonHealth, DaemonStatus, PreflightCheck, PreflightReport,
    PreflightStatus, PreflightTool, ReviewSession,
};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tower::ServiceExt;

const HOST: &str = "localhost:7777";
const ORIGIN: &str = "http://localhost:7777";
const REVISION: &str = "x-legible-review-revision";
const TEST_TIMEOUT: Duration = Duration::from_secs(5);

struct Fixture {
    root: TempDir,
    state: ApiState,
    app: Router,
    token: String,
    cookie: String,
}

impl Fixture {
    async fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let service = saved_sessions(&root);

        let access = BrowserAccess::new().unwrap();
        let token = access.bootstrap_token().to_owned();
        let state = ApiState::new(service, report(), access);
        let app = build_app(state.clone());

        state.set_phase(DaemonPhase::Ready);

        let response = authenticate(&app, &token).await;
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        let cookie = cookie_from(&response);

        Self {
            root,
            state,
            app,
            token,
            cookie,
        }
    }

    fn get(&self, path: &str) -> Builder {
        local_get(path).header(header::COOKIE, &self.cookie)
    }

    async fn send(&self, builder: Builder) -> Response {
        let request = builder.body(Body::empty()).unwrap();

        send_request(&self.app, request).await
    }

    async fn send_json(&self, builder: Builder, body: Value) -> Response {
        let request = builder.body(Body::from(body.to_string())).unwrap();

        send_request(&self.app, request).await
    }
}

fn saved_sessions(root: &TempDir) -> SessionService {
    let store = SessionStore::new(root.path()).unwrap();

    for index in 0..3 {
        store.save(&common::record(index)).unwrap();
    }

    SessionService::open(store).unwrap()
}

fn report() -> PreflightReport {
    PreflightReport {
        status: DaemonStatus::Degraded,
        checked_at: "2026-10-03T00:00:00.000Z".into(),
        checks: vec![PreflightCheck {
            tool: PreflightTool::Claude,
            status: PreflightStatus::Missing,
            version: None,
            message: Some("Claude CLI is not installed".into()),
        }],
    }
}

fn local_get(path: &str) -> Builder {
    Request::builder().uri(path).header(header::HOST, HOST)
}

fn post_auth() -> Builder {
    local_get("/api/auth")
        .method(Method::POST)
        .header(header::ORIGIN, ORIGIN)
        .header(header::CONTENT_TYPE, "application/json")
}

async fn send_request(app: &Router, request: Request<Body>) -> Response {
    app.clone().oneshot(request).await.unwrap()
}

async fn authenticate(app: &Router, token: &str) -> Response {
    let body = json!({ "token": token });
    let request = post_auth().body(Body::from(body.to_string())).unwrap();

    send_request(app, request).await
}

fn cookie_from(response: &Response) -> String {
    let cookie = response.headers()[header::SET_COOKIE].to_str().unwrap();

    cookie.split(';').next().unwrap().to_owned()
}

async fn body_bytes(response: Response) -> Bytes {
    to_bytes(response.into_body(), 1024 * 1024).await.unwrap()
}

async fn json_body(response: Response) -> Value {
    let bytes = body_bytes(response).await;

    serde_json::from_slice(&bytes).unwrap()
}

fn assert_security_headers(response: &Response) {
    let headers = response.headers();

    assert_eq!(headers[header::CACHE_CONTROL], "no-store");
    assert_eq!(headers[header::REFERRER_POLICY], "no-referrer");
    assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
    assert!(headers.contains_key(header::CONTENT_SECURITY_POLICY));
}

async fn assert_error(response: Response, status: StatusCode, code: &str) {
    assert_eq!(response.status(), status);
    assert_security_headers(&response);

    let body = json_body(response).await;

    assert_eq!(body["error"]["code"], code);
    assert!(body["error"]["message"].is_string());
}

async fn loopback_http(address: SocketAddr, cookie: &str) -> String {
    let request = format!(
        concat!(
            "GET /api/health HTTP/1.1\r\n",
            "Host: {address}\r\n",
            "Cookie: {cookie}\r\n",
            "Connection: close\r\n",
            "\r\n",
        ),
        address = address,
        cookie = cookie,
    );

    let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
    stream.write_all(request.as_bytes()).await.unwrap();

    let mut response = String::new();
    stream.read_to_string(&mut response).await.unwrap();

    response
}

#[tokio::test]
async fn bootstrap_is_exchanged_for_a_distinct_private_cookie() {
    let fixture = Fixture::new().await;

    assert_eq!(fixture.token.len(), 43);
    assert!(!fixture.cookie.contains(&fixture.token));

    let response = authenticate(&fixture.app, &fixture.token).await;
    let cookie = response.headers()[header::SET_COOKIE].to_str().unwrap();

    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert!(cookie.ends_with("; HttpOnly; SameSite=Strict; Path=/api"));
    assert!(body_bytes(response).await.is_empty());

    let response = fixture.send(fixture.get("/api/auth")).await;

    assert_eq!(json_body(response).await, json!({ "authenticated": true }));
}

#[test]
fn access_debug_does_not_reveal_credentials() {
    let access = BrowserAccess::new().unwrap();
    let debug = format!("{access:?}");

    assert_eq!(debug, "BrowserAccess { .. }");
    assert!(!debug.contains(access.bootstrap_token()));
}

#[tokio::test]
async fn every_api_route_including_unknown_routes_requires_a_cookie() {
    let fixture = Fixture::new().await;
    let paths = [
        "/api",
        "/api/auth",
        "/api/health",
        "/api/preflight",
        "/api/sessions",
        "/api/sessions/draft-review",
        "/api/sessions/draft-review/comments",
        "/api/sessions/draft-review/chat",
        "/api/events",
        "/api/unknown",
    ];

    for path in paths {
        let response = fixture.send(local_get(path)).await;

        assert_error(response, StatusCode::UNAUTHORIZED, "browser_auth_required").await;
    }
}

#[tokio::test]
async fn bearer_and_query_tokens_cannot_authenticate_browser_apis() {
    let fixture = Fixture::new().await;

    for token in ["agent-only", &fixture.token] {
        let path = format!("/api/health?token={token}");
        let request = local_get(&path).header(header::AUTHORIZATION, format!("Bearer {token}"));

        let response = fixture.send(request).await;

        assert_error(response, StatusCode::UNAUTHORIZED, "browser_auth_required").await;
    }
}

#[tokio::test]
async fn invalid_cookie_and_bootstrap_token_in_a_cookie_are_rejected() {
    let fixture = Fixture::new().await;
    let cookies = [
        "legible_session=wrong".to_owned(),
        format!("legible_session={}", fixture.token),
    ];

    for cookie in cookies {
        let request = local_get("/api/health").header(header::COOKIE, cookie);
        let response = fixture.send(request).await;

        assert_error(response, StatusCode::UNAUTHORIZED, "browser_auth_required").await;
    }
}

#[tokio::test]
async fn duplicate_session_cookies_are_rejected_across_and_within_headers() {
    let fixture = Fixture::new().await;
    let duplicate = format!("{}; {}", fixture.cookie, fixture.cookie);
    let requests = [
        local_get("/api/health").header(header::COOKIE, duplicate),
        fixture
            .get("/api/health")
            .header(header::COOKIE, &fixture.cookie),
    ];

    for request in requests {
        let response = fixture.send(request).await;

        assert_error(response, StatusCode::UNAUTHORIZED, "browser_auth_required").await;
    }

    let request = fixture
        .get("/api/health")
        .header(header::COOKIE, "unrelated=value");
    let response = fixture.send(request).await;

    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn a_new_instance_rejects_both_old_bootstrap_and_old_cookie() {
    let first = Fixture::new().await;
    let second = Fixture::new().await;

    assert_ne!(first.token, second.token);

    let request = local_get("/api/health").header(header::COOKIE, &first.cookie);
    let response = second.send(request).await;

    assert_error(response, StatusCode::UNAUTHORIZED, "browser_auth_required").await;

    let response = authenticate(&second.app, &first.token).await;

    assert_error(response, StatusCode::UNAUTHORIZED, "browser_auth_required").await;
}

#[tokio::test]
async fn wrong_bootstrap_never_sets_a_cookie() {
    let fixture = Fixture::new().await;
    let response = authenticate(&fixture.app, "wrong").await;

    assert!(!response.headers().contains_key(header::SET_COOKIE));
    assert_error(response, StatusCode::UNAUTHORIZED, "browser_auth_required").await;
}

#[tokio::test]
async fn auth_rejects_invalid_json_missing_tokens_and_extra_fields_without_echoing_input() {
    let fixture = Fixture::new().await;
    let bodies = [
        "not-json".to_owned(),
        "{}".into(),
        "{\"token\":null}".into(),
        "{\"token\":12}".into(),
        json!({ "token": fixture.token, "extra": true }).to_string(),
    ];

    for body in bodies {
        let request = post_auth().body(Body::from(body)).unwrap();
        let response = send_request(&fixture.app, request).await;

        let status = response.status();
        let body = json_body(response).await;

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"]["code"], "invalid_auth_request");
        assert!(!body.to_string().contains(&fixture.token));
    }
}

#[tokio::test]
async fn auth_limits_the_actual_body_even_without_a_content_length() {
    let fixture = Fixture::new().await;
    let body = json!({ "token": "a".repeat(2048) });

    let response = fixture.send_json(post_auth(), body).await;

    assert!(!response.headers().contains_key(header::SET_COOKIE));
    assert_error(
        response,
        StatusCode::PAYLOAD_TOO_LARGE,
        "invalid_auth_request",
    )
    .await;
}

#[tokio::test]
async fn auth_requires_json_content_type() {
    let fixture = Fixture::new().await;
    let request = local_get("/api/auth")
        .method(Method::POST)
        .header(header::ORIGIN, ORIGIN);
    let body = json!({ "token": fixture.token });

    let response = fixture.send_json(request, body).await;

    assert_error(
        response,
        StatusCode::UNSUPPORTED_MEDIA_TYPE,
        "invalid_auth_request",
    )
    .await;
}

#[tokio::test]
async fn foreign_null_and_mismatched_origins_are_rejected_even_with_a_cookie() {
    let fixture = Fixture::new().await;
    let origins = [
        "http://evil.test",
        "null",
        "https://localhost:7777",
        "http://localhost:7778",
        "http://127.0.0.1:7777",
        "http://localhost:7777/",
        "",
    ];

    for origin in origins {
        let request = fixture.get("/api/health").header(header::ORIGIN, origin);
        let response = fixture.send(request).await;

        assert_error(response, StatusCode::FORBIDDEN, "origin_forbidden").await;
    }
}

#[tokio::test]
async fn writes_and_websocket_upgrades_require_an_origin() {
    let fixture = Fixture::new().await;
    let request = local_get("/api/auth")
        .method(Method::POST)
        .header(header::CONTENT_TYPE, "application/json");
    let body = json!({ "token": fixture.token });

    let response = fixture.send_json(request, body).await;

    assert_error(response, StatusCode::FORBIDDEN, "origin_forbidden").await;

    for upgrade in ["websocket", "WebSocket", "other, websocket"] {
        let request = fixture.get("/api/events").header(header::UPGRADE, upgrade);
        let response = fixture.send(request).await;

        assert_error(response, StatusCode::FORBIDDEN, "origin_forbidden").await;
    }
}

#[tokio::test]
async fn dns_rebinding_and_malformed_hosts_are_rejected() {
    let fixture = Fixture::new().await;
    let hosts = [
        "evil.test",
        "localhost.evil.test",
        "127.0.0.1.evil.test",
        "0.0.0.0:7777",
        "127.1:7777",
        "localhost:",
        "localhost:65536",
        "localhost:abc",
        "localhost:7777/path",
        "localhost@evil.test",
        "[::1]:7777?x",
        "localhost.",
    ];

    for host in hosts {
        let request = Request::builder()
            .uri("/api/health")
            .header(header::HOST, host)
            .header(header::COOKIE, &fixture.cookie);
        let response = fixture.send(request).await;

        assert_error(response, StatusCode::FORBIDDEN, "origin_forbidden").await;
    }

    let request = Request::builder()
        .uri("/api/health")
        .header(header::COOKIE, &fixture.cookie);
    let response = fixture.send(request).await;

    assert_error(response, StatusCode::FORBIDDEN, "origin_forbidden").await;
}

#[tokio::test]
async fn duplicate_host_and_origin_headers_are_rejected() {
    let fixture = Fixture::new().await;
    let requests = [
        fixture.get("/api/health").header(header::HOST, HOST),
        fixture
            .get("/api/health")
            .header(header::ORIGIN, ORIGIN)
            .header(header::ORIGIN, ORIGIN),
    ];

    for request in requests {
        let response = fixture.send(request).await;

        assert_error(response, StatusCode::FORBIDDEN, "origin_forbidden").await;
    }
}

#[tokio::test]
async fn conflicting_absolute_request_targets_are_rejected() {
    let fixture = Fixture::new().await;
    let targets = [
        "http://evil.test/api/health",
        "http://localhost:7778/api/health",
        "https://localhost:7777/api/health",
    ];

    for target in targets {
        let response = fixture.send(fixture.get(target)).await;

        assert_error(response, StatusCode::FORBIDDEN, "origin_forbidden").await;
    }
}

#[tokio::test]
async fn loopback_host_forms_and_matching_origins_are_accepted() {
    let fixture = Fixture::new().await;
    let hosts = [
        "localhost",
        "localhost:7777",
        "127.0.0.1",
        "127.0.0.1:7777",
        "[::1]",
        "[::1]:7777",
        "LOCALHOST:7777",
    ];

    for host in hosts {
        let request = Request::builder()
            .uri("/api/health")
            .header(header::HOST, host)
            .header(header::ORIGIN, format!("http://{host}"))
            .header(header::COOKIE, &fixture.cookie);
        let response = fixture.send(request).await;

        assert_eq!(response.status(), StatusCode::OK);
    }
}

#[tokio::test]
async fn health_and_preflight_use_the_supplied_report_without_running_tools() {
    let fixture = Fixture::new().await;
    let response = fixture.send(fixture.get("/api/health")).await;

    let health: DaemonHealth = serde_json::from_value(json_body(response).await).unwrap();

    assert_eq!(health.status, DaemonStatus::Degraded);
    assert_eq!(health.version, VERSION);

    let response = fixture.send(fixture.get("/api/preflight")).await;

    assert_eq!(
        json_body(response).await,
        serde_json::to_value(report()).unwrap()
    );
}

#[tokio::test]
async fn session_reads_expose_wire_models_not_storage_records() {
    let fixture = Fixture::new().await;
    let response = fixture.send(fixture.get("/api/sessions")).await;

    let sessions: Vec<ReviewSession> = serde_json::from_value(json_body(response).await).unwrap();
    let ids: Vec<_> = sessions.iter().map(|session| session.id.as_str()).collect();

    assert_eq!(ids, ["claude-review", "codex-review", "draft-review"]);

    let response = fixture
        .send(fixture.get("/api/sessions/draft-review"))
        .await;
    let body = json_body(response).await;

    assert_eq!(
        body,
        serde_json::to_value(common::record(0).session).unwrap()
    );
    assert!(body.get("version").is_none());
    assert!(body.get("chat").is_none());
}

#[tokio::test]
async fn comments_and_chat_require_explicit_safe_review_revisions() {
    let fixture = Fixture::new().await;
    let invalid_revisions = [
        "",
        "-1",
        "+0",
        "0.0",
        " 0",
        "1e0",
        "9007199254740992",
        "18446744073709551616",
        "0,0",
    ];

    for endpoint in ["comments", "chat"] {
        let path = format!("/api/sessions/draft-review/{endpoint}");
        let response = fixture.send(fixture.get(&path)).await;

        assert_error(response, StatusCode::BAD_REQUEST, "invalid_review_revision").await;

        for revision in invalid_revisions {
            let request = fixture.get(&path).header(REVISION, revision);
            let response = fixture.send(request).await;

            assert_error(response, StatusCode::BAD_REQUEST, "invalid_review_revision").await;
        }

        let request = fixture
            .get(&path)
            .header(REVISION, "0")
            .header(REVISION, "0");
        let response = fixture.send(request).await;

        assert_error(response, StatusCode::BAD_REQUEST, "invalid_review_revision").await;
    }
}

#[tokio::test]
async fn stale_review_revisions_reject_reads_but_current_archived_reviews_remain_readable() {
    let fixture = Fixture::new().await;

    for endpoint in ["comments", "chat"] {
        let path = format!("/api/sessions/codex-review/{endpoint}");

        let request = fixture.get(&path).header(REVISION, "0");
        let response = fixture.send(request).await;

        assert_error(response, StatusCode::CONFLICT, "stale_review_revision").await;

        let request = fixture.get(&path).header(REVISION, "2");
        let response = fixture.send(request).await;

        assert_eq!(response.status(), StatusCode::OK);
    }
}

#[tokio::test]
async fn comments_preserve_saved_anchors_and_chat_reads_preserve_recovery_without_writes() {
    let fixture = Fixture::new().await;
    let store = SessionStore::new(fixture.root.path()).unwrap();
    let persisted = store.path_for("codex-review").unwrap();
    let before = fs::read(&persisted).unwrap();

    let request = fixture
        .get("/api/sessions/codex-review/comments")
        .header(REVISION, "2");
    let response = fixture.send(request).await;

    assert_eq!(
        json_body(response).await,
        serde_json::to_value(common::record(2).session.comments).unwrap(),
    );

    let request = fixture
        .get("/api/sessions/codex-review/chat")
        .header(REVISION, "2");
    let response = fixture.send(request).await;
    let body = json_body(response).await;

    assert!(body.get("retry").is_none());
    assert!(body.get("active").is_none());

    let snapshot: ChatSnapshot = serde_json::from_value(body).unwrap();

    assert_eq!(snapshot.status, ChatStatus::Failed);
    assert_eq!(snapshot.revision, 10);
    assert!(snapshot.current_turn_id.is_none());
    assert!(snapshot.current_item_id.is_none());
    assert_eq!(fs::read(persisted).unwrap(), before);
}

#[tokio::test]
async fn absent_chat_returns_an_unavailable_snapshot_without_starting_an_agent() {
    let fixture = Fixture::new().await;
    let request = fixture
        .get("/api/sessions/draft-review/chat")
        .header(REVISION, "0");

    let response = fixture.send(request).await;
    let snapshot: ChatSnapshot = serde_json::from_value(json_body(response).await).unwrap();

    assert_eq!(snapshot.session_id, "draft-review");
    assert_eq!(snapshot.status, ChatStatus::Unavailable);
    assert_eq!(snapshot.revision, 0);
    assert!(snapshot.entries.is_empty());
    assert!(snapshot.unavailable_reason.is_some());
}

#[tokio::test]
async fn missing_sessions_and_invalid_path_encoding_have_structured_errors() {
    let fixture = Fixture::new().await;
    let paths = [
        "/api/sessions/missing",
        "/api/sessions/missing/comments",
        "/api/sessions/missing/chat",
    ];

    for path in paths {
        let request = fixture.get(path).header(REVISION, "0");
        let response = fixture.send(request).await;

        assert_error(response, StatusCode::NOT_FOUND, "session_not_found").await;
    }

    let response = fixture.send(fixture.get("/api/sessions/%FF")).await;

    assert_error(response, StatusCode::BAD_REQUEST, "invalid_session_id").await;
}

#[tokio::test]
async fn startup_and_shutdown_gate_every_request_before_authentication() {
    let fixture = Fixture::new().await;
    let phases = [
        (DaemonPhase::Starting, "daemon_starting"),
        (DaemonPhase::Stopping, "daemon_stopping"),
    ];
    let paths = ["/api/health", "/api/auth", "/api/events", "/not-a-route"];

    for (phase, code) in phases {
        fixture.state.set_phase(phase);

        assert_eq!(fixture.state.phase(), phase);

        for path in paths {
            let request = Request::builder().uri(path);
            let response = fixture.send(request).await;

            assert_eq!(response.headers()[header::RETRY_AFTER], "1");
            assert_error(response, StatusCode::SERVICE_UNAVAILABLE, code).await;
        }
    }

    fixture.state.set_phase(DaemonPhase::Ready);
    let response = fixture.send(fixture.get("/api/health")).await;

    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn new_application_state_starts_gated() {
    let root = tempfile::tempdir().unwrap();
    let store = SessionStore::new(root.path()).unwrap();
    let service = SessionService::open(store).unwrap();
    let access = BrowserAccess::new().unwrap();
    let state = ApiState::new(service, report(), access);

    assert_eq!(state.phase(), DaemonPhase::Starting);

    let app = build_app(state);
    let request = Request::builder()
        .uri("/api/health")
        .body(Body::empty())
        .unwrap();
    let response = send_request(&app, request).await;

    assert_error(response, StatusCode::SERVICE_UNAVAILABLE, "daemon_starting").await;
}

#[tokio::test]
async fn unknown_routes_and_unsupported_methods_have_structured_errors() {
    let fixture = Fixture::new().await;

    for path in ["/api/unknown", "/api/events"] {
        let response = fixture.send(fixture.get(path)).await;

        assert_error(response, StatusCode::NOT_FOUND, "not_found").await;
    }

    let request = fixture
        .get("/api/sessions")
        .method(Method::POST)
        .header(header::ORIGIN, ORIGIN);
    let response = fixture.send(request).await;

    assert_error(
        response,
        StatusCode::METHOD_NOT_ALLOWED,
        "method_not_allowed",
    )
    .await;
}

#[tokio::test]
async fn authenticated_head_returns_headers_without_a_body() {
    let fixture = Fixture::new().await;
    let request = fixture.get("/api/health").method(Method::HEAD);

    let response = fixture.send(request).await;

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    assert!(body_bytes(response).await.is_empty());
}

#[tokio::test]
async fn loopback_binding_rejects_external_addresses_before_listening() {
    for address in ["0.0.0.0:0", "[::]:0", "192.0.2.1:0"] {
        let result = bind_loopback(address.parse().unwrap()).await;

        assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::InvalidInput);
    }

    let listener = bind_loopback("127.0.0.1:0".parse().unwrap()).await.unwrap();

    assert!(listener.local_addr().unwrap().ip().is_loopback());
}

#[tokio::test]
async fn application_serves_authenticated_reads_over_real_loopback_http() {
    let fixture = Fixture::new().await;
    let listener = bind_loopback("127.0.0.1:0".parse().unwrap()).await.unwrap();
    let address = listener.local_addr().unwrap();
    let (shutdown, stopped) = tokio::sync::oneshot::channel::<()>();

    let server = tokio::spawn(async move {
        let shutdown_signal = async {
            let _ = stopped.await;
        };

        axum::serve(listener, fixture.app)
            .with_graceful_shutdown(shutdown_signal)
            .await
            .unwrap();
    });

    let request = loopback_http(address, &fixture.cookie);
    let response = tokio::time::timeout(TEST_TIMEOUT, request).await.unwrap();

    assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));

    let body = response.split_once("\r\n\r\n").unwrap().1;
    let health: DaemonHealth = serde_json::from_str(body).unwrap();

    assert_eq!(health.status, DaemonStatus::Degraded);
    assert!(!response.contains(&fixture.token));
    assert!(!response.contains(&fixture.cookie));

    shutdown.send(()).unwrap();

    tokio::time::timeout(TEST_TIMEOUT, server)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn non_ascii_header_values_fail_closed() {
    let fixture = Fixture::new().await;

    let mut request = fixture.get("/api/health").body(Body::empty()).unwrap();
    request.headers_mut().insert(
        header::COOKIE,
        HeaderValue::from_bytes(b"legible_session=\xff").unwrap(),
    );
    let response = send_request(&fixture.app, request).await;

    assert_error(response, StatusCode::UNAUTHORIZED, "browser_auth_required").await;

    let mut request = fixture.get("/api/health").body(Body::empty()).unwrap();
    request.headers_mut().insert(
        header::ORIGIN,
        HeaderValue::from_bytes(b"http://localhost:\xff").unwrap(),
    );
    let response = send_request(&fixture.app, request).await;

    assert_error(response, StatusCode::FORBIDDEN, "origin_forbidden").await;
}
