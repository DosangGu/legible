mod common;

use std::{net::SocketAddr, time::Duration};

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
};
use futures_util::{SinkExt, StreamExt};
use legible_daemon::{
    api::{ApiState, BrowserAccess, DaemonPhase, bind_loopback, build_app},
    sessions::{SessionService, SessionStore},
};
use legible_protocol::{DaemonEvent, DaemonEventEnvelope, DaemonStatus, PreflightReport};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::{net::TcpStream, sync::oneshot, task::JoinHandle, time::timeout};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::{Error, Message, client::IntoClientRequest, protocol::frame::coding::CloseCode},
};
use tower::ServiceExt;

const TEST_TIMEOUT: Duration = Duration::from_secs(5);
type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

struct Fixture {
    _root: TempDir,
    state: ApiState,
    app: Router,
    address: SocketAddr,
    token: String,
    cookie: String,
    shutdown: Option<oneshot::Sender<()>>,
    server: JoinHandle<()>,
}

impl Fixture {
    async fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let store = SessionStore::new(root.path()).unwrap();
        let service = SessionService::open(store).unwrap();
        let access = BrowserAccess::new().unwrap();
        let token = access.bootstrap_token().to_owned();
        let state = ApiState::new(service, report(), access).unwrap();
        state.set_phase(DaemonPhase::Ready);
        let app = build_app(state.clone());

        let listener = bind_loopback("127.0.0.1:0".parse().unwrap()).await.unwrap();
        let address = listener.local_addr().unwrap();
        let cookie = authenticate(&app, address, &token).await;
        let (shutdown, stopped) = oneshot::channel();
        let served_app = app.clone();
        let server = tokio::spawn(async move {
            axum::serve(listener, served_app)
                .with_graceful_shutdown(async {
                    let _ = stopped.await;
                })
                .await
                .unwrap();
        });

        Self {
            _root: root,
            state,
            app,
            address,
            token,
            cookie,
            shutdown: Some(shutdown),
            server,
        }
    }

    fn request(&self) -> Request<()> {
        let mut request = format!("ws://{}/api/events", self.address)
            .into_client_request()
            .unwrap();
        let headers = request.headers_mut();
        headers.insert(
            header::ORIGIN,
            format!("http://{}", self.address).parse().unwrap(),
        );
        headers.insert(header::COOKIE, self.cookie.parse().unwrap());
        headers.insert(
            header::SEC_WEBSOCKET_EXTENSIONS,
            "permessage-deflate".parse().unwrap(),
        );

        request
    }

    async fn connect(&self) -> Socket {
        let (socket, response) = timeout(TEST_TIMEOUT, connect_async(self.request()))
            .await
            .unwrap()
            .unwrap();

        assert_eq!(response.status(), StatusCode::SWITCHING_PROTOCOLS);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        assert!(
            !response
                .headers()
                .contains_key(header::SEC_WEBSOCKET_EXTENSIONS)
        );
        assert!(
            !response
                .headers()
                .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN)
        );

        socket
    }

    async fn get(&self, path: &str, revision: Option<u64>) -> (StatusCode, Value) {
        let mut request = Request::builder()
            .uri(path)
            .header(header::HOST, self.address.to_string())
            .header(header::COOKIE, &self.cookie);

        if let Some(revision) = revision {
            request = request.header("x-legible-review-revision", revision.to_string());
        }

        let response = self
            .app
            .clone()
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();

        (status, serde_json::from_slice(&bytes).unwrap())
    }

    async fn stop(&mut self) {
        self.state.set_phase(DaemonPhase::Stopping);
        self.shutdown.take().unwrap().send(()).unwrap();
        timeout(TEST_TIMEOUT, &mut self.server)
            .await
            .unwrap()
            .unwrap();
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.state.set_phase(DaemonPhase::Stopping);
        self.server.abort();
    }
}

fn report() -> PreflightReport {
    PreflightReport {
        status: DaemonStatus::Ready,
        checked_at: "2026-10-04T00:00:00.000Z".into(),
        checks: Vec::new(),
    }
}

async fn authenticate(app: &Router, address: SocketAddr, token: &str) -> String {
    let body = json!({ "token": token });
    let request = Request::builder()
        .method("POST")
        .uri("/api/auth")
        .header(header::HOST, address.to_string())
        .header(header::ORIGIN, format!("http://{address}"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();

    assert_eq!(response.status(), StatusCode::NO_CONTENT);

    response.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned()
}

async fn message(socket: &mut Socket) -> Message {
    timeout(TEST_TIMEOUT, socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
}

async fn event(socket: &mut Socket) -> DaemonEventEnvelope {
    let Message::Text(text) = message(socket).await else {
        panic!("expected a JSON text frame")
    };

    serde_json::from_str(&text).unwrap()
}

async fn assert_rejected(request: Request<()>, status: StatusCode, code: &str) {
    let result = timeout(TEST_TIMEOUT, connect_async(request)).await.unwrap();
    let Err(Error::Http(response)) = result else {
        panic!("expected a rejected handshake")
    };
    let body: Value = serde_json::from_slice(response.body().as_ref().unwrap()).unwrap();

    assert_eq!(response.status(), status);
    assert_eq!(body["error"]["code"], code);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
}

#[tokio::test]
async fn first_frame_is_a_current_snapshot_and_subsequent_deltas_match_http_state() {
    let mut fixture = Fixture::new().await;
    fixture.state.owner().add(common::record(0)).await.unwrap();
    let mut socket = fixture.connect().await;
    let snapshot = event(&mut socket).await;
    let DaemonEvent::Snapshot(body) = snapshot.event else {
        panic!()
    };

    assert_eq!(snapshot.sequence, 1);
    assert_eq!(body.sessions, vec![common::record(0).session]);
    assert_eq!(body.preflight, report());

    let mut changed = common::record(0);
    changed.session.review_revision = 1;
    changed.session.comments.clear();
    fixture
        .state
        .owner()
        .replace(changed.clone(), 0)
        .await
        .unwrap();
    let update = event(&mut socket).await;

    assert_eq!(update.sequence, 2);
    assert_eq!(
        update.event,
        DaemonEvent::SessionUpdated(Box::new(changed.session.clone()))
    );

    let (status, session) = fixture.get("/api/sessions/draft-review", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(session, serde_json::to_value(changed.session).unwrap());

    let (status, stale) = fixture
        .get("/api/sessions/draft-review/comments", Some(0))
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(stale["error"]["code"], "stale_review_revision");

    let (status, comments) = fixture
        .get("/api/sessions/draft-review/comments", Some(1))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(comments, json!([]));

    socket.close(None).await.unwrap();
    fixture.stop().await;
}

#[tokio::test]
async fn reconnect_includes_changes_made_while_disconnected_without_replaying_old_deltas() {
    let fixture = Fixture::new().await;
    let mut socket = fixture.connect().await;
    assert_eq!(event(&mut socket).await.sequence, 0);
    socket.close(None).await.unwrap();
    drop(socket);

    fixture.state.owner().add(common::record(0)).await.unwrap();
    fixture.state.owner().add(common::record(1)).await.unwrap();
    fixture
        .state
        .owner()
        .remove_record("draft-review", 0)
        .await
        .unwrap();

    let mut reconnected = fixture.connect().await;
    let snapshot = event(&mut reconnected).await;
    let DaemonEvent::Snapshot(body) = snapshot.event else {
        panic!()
    };

    assert_eq!(snapshot.sequence, 3);
    assert_eq!(body.sessions, vec![common::record(1).session]);

    fixture
        .state
        .owner()
        .update_preflight(report())
        .await
        .unwrap();
    assert_eq!(event(&mut reconnected).await.sequence, 4);
}

#[tokio::test]
async fn independent_clients_receive_identical_ordered_events() {
    let fixture = Fixture::new().await;
    let mut first = fixture.connect().await;
    let mut second = fixture.connect().await;
    assert_eq!(event(&mut first).await.sequence, 0);
    assert_eq!(event(&mut second).await.sequence, 0);

    fixture.state.owner().add(common::record(0)).await.unwrap();
    fixture.state.owner().add(common::record(1)).await.unwrap();

    for sequence in 1..=2 {
        let left = event(&mut first).await;
        let right = event(&mut second).await;

        assert_eq!(left.sequence, sequence);
        assert_eq!(left, right);
    }
}

#[tokio::test]
async fn websocket_handshakes_require_same_origin_and_local_host_even_with_a_valid_cookie() {
    let fixture = Fixture::new().await;
    let mut missing = fixture.request();
    missing.headers_mut().remove(header::ORIGIN);
    assert_rejected(missing, StatusCode::FORBIDDEN, "origin_forbidden").await;

    for origin in [
        "http://evil.test",
        "null",
        "https://127.0.0.1",
        "http://localhost",
    ] {
        let mut request = fixture.request();
        request
            .headers_mut()
            .insert(header::ORIGIN, origin.parse().unwrap());

        assert_rejected(request, StatusCode::FORBIDDEN, "origin_forbidden").await;
    }

    let mut rebinding = fixture.request();
    rebinding
        .headers_mut()
        .insert(header::HOST, "evil.test".parse().unwrap());
    rebinding
        .headers_mut()
        .insert(header::ORIGIN, "http://evil.test".parse().unwrap());
    assert_rejected(rebinding, StatusCode::FORBIDDEN, "origin_forbidden").await;

    let mut duplicate = fixture.request();
    duplicate.headers_mut().append(
        header::ORIGIN,
        format!("http://{}", fixture.address).parse().unwrap(),
    );
    assert_rejected(duplicate, StatusCode::FORBIDDEN, "origin_forbidden").await;
}

#[tokio::test]
async fn bootstrap_query_and_bearer_tokens_cannot_authenticate_a_websocket() {
    let fixture = Fixture::new().await;
    let mut request = fixture.request();
    request.headers_mut().remove(header::COOKIE);
    assert_rejected(request, StatusCode::UNAUTHORIZED, "browser_auth_required").await;

    let mut request = fixture.request();
    request.headers_mut().insert(
        header::COOKIE,
        format!("legible_session={}", fixture.token)
            .parse()
            .unwrap(),
    );
    assert_rejected(request, StatusCode::UNAUTHORIZED, "browser_auth_required").await;

    let mut request = fixture.request();
    request.headers_mut().remove(header::COOKIE);
    request.headers_mut().insert(
        header::AUTHORIZATION,
        format!("Bearer {}", fixture.token).parse().unwrap(),
    );
    *request.uri_mut() = format!(
        "ws://{}/api/events?token={}",
        fixture.address, fixture.token
    )
    .parse()
    .unwrap();
    assert_rejected(request, StatusCode::UNAUTHORIZED, "browser_auth_required").await;

    let mut duplicate = fixture.request();
    duplicate
        .headers_mut()
        .append(header::COOKIE, fixture.cookie.parse().unwrap());
    assert_rejected(duplicate, StatusCode::UNAUTHORIZED, "browser_auth_required").await;
}

#[tokio::test]
async fn a_cookie_from_another_daemon_cannot_upgrade() {
    let first = Fixture::new().await;
    let second = Fixture::new().await;
    let mut request = second.request();
    request
        .headers_mut()
        .insert(header::COOKIE, first.cookie.parse().unwrap());

    assert_rejected(request, StatusCode::UNAUTHORIZED, "browser_auth_required").await;
}

#[tokio::test]
async fn invalid_upgrade_headers_return_structured_errors() {
    let fixture = Fixture::new().await;

    for name in [
        header::UPGRADE,
        header::CONNECTION,
        header::SEC_WEBSOCKET_KEY,
        header::SEC_WEBSOCKET_VERSION,
    ] {
        let mut request = fixture.request();
        request.headers_mut().remove(name);
        *request.uri_mut() = "/api/events".parse().unwrap();

        // The client rejects some missing headers before sending any handshake bytes.
        let request = request.map(|_| Body::empty());
        let response = fixture.app.clone().oneshot(request).await.unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);

        let bytes = to_bytes(response.into_body(), 1024).await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["error"]["code"], "invalid_websocket_request");
    }
}

#[tokio::test]
async fn application_messages_close_the_read_only_stream_without_mutating_sessions() {
    let fixture = Fixture::new().await;
    fixture.state.owner().add(common::record(0)).await.unwrap();

    for command in [
        Message::Text("{\"type\":\"session.remove\"}".into()),
        Message::Binary(vec![1, 2, 3].into()),
    ] {
        let mut socket = fixture.connect().await;
        event(&mut socket).await;
        socket.send(command).await.unwrap();
        let Message::Close(Some(frame)) = message(&mut socket).await else {
            panic!()
        };

        assert_eq!(frame.code, CloseCode::Policy);
        assert_eq!(frame.reason, "Event stream is read-only");
    }

    assert_eq!(
        fixture.state.owner().sessions().await.unwrap(),
        vec![common::record(0).session]
    );
}

#[tokio::test]
async fn ping_pong_control_frames_keep_the_read_only_stream_usable() {
    let fixture = Fixture::new().await;
    let mut socket = fixture.connect().await;
    event(&mut socket).await;
    socket
        .send(Message::Ping(vec![1, 2, 3].into()))
        .await
        .unwrap();

    assert_eq!(
        message(&mut socket).await,
        Message::Pong(vec![1, 2, 3].into())
    );

    fixture.state.owner().add(common::record(0)).await.unwrap();
    assert_eq!(event(&mut socket).await.sequence, 1);
}

#[tokio::test]
async fn client_close_is_acknowledged_without_releasing_session_ownership() {
    let fixture = Fixture::new().await;
    fixture.state.owner().add(common::record(0)).await.unwrap();
    let mut socket = fixture.connect().await;
    event(&mut socket).await;

    socket.close(None).await.unwrap();

    assert!(matches!(message(&mut socket).await, Message::Close(_)));
    assert_eq!(fixture.state.owner().sessions().await.unwrap().len(), 1);
}

#[tokio::test]
async fn oversized_frames_are_rejected_without_changing_state() {
    let fixture = Fixture::new().await;
    let mut socket = fixture.connect().await;
    event(&mut socket).await;

    socket
        .send(Message::Binary(vec![0; 64 * 1024 + 1].into()))
        .await
        .unwrap();
    let result = timeout(TEST_TIMEOUT, socket.next()).await.unwrap();

    assert!(matches!(result, None | Some(Err(_))));
    assert!(fixture.state.owner().sessions().await.unwrap().is_empty());

    let mut reconnected = fixture.connect().await;
    assert_eq!(event(&mut reconnected).await.sequence, 0);
}

#[tokio::test]
async fn stopping_closes_existing_streams_and_rejects_new_upgrades() {
    let mut fixture = Fixture::new().await;
    let mut socket = fixture.connect().await;
    event(&mut socket).await;
    fixture.state.set_phase(DaemonPhase::Stopping);

    let Message::Close(Some(frame)) = message(&mut socket).await else {
        panic!()
    };
    assert_eq!(frame.code, CloseCode::Away);
    assert_rejected(
        fixture.request(),
        StatusCode::SERVICE_UNAVAILABLE,
        "daemon_stopping",
    )
    .await;

    fixture.stop().await;
}

#[tokio::test]
async fn starting_rejects_upgrades_until_readiness_is_explicit() {
    let fixture = Fixture::new().await;
    fixture.state.set_phase(DaemonPhase::Starting);
    assert_rejected(
        fixture.request(),
        StatusCode::SERVICE_UNAVAILABLE,
        "daemon_starting",
    )
    .await;

    fixture.state.set_phase(DaemonPhase::Ready);
    let mut socket = fixture.connect().await;
    assert_eq!(event(&mut socket).await.sequence, 0);
}
