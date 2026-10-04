#![cfg(unix)]

mod common;

use std::{
    fs,
    net::{SocketAddr, TcpListener},
    os::unix::{
        fs::{MetadataExt, PermissionsExt},
        net::UnixListener,
    },
    path::{Path, PathBuf},
    process::{Output, Stdio},
    time::Duration,
};

use futures_util::StreamExt;
use legible_daemon::{
    api::DaemonPhase,
    runtime::{
        control::{
            ControlMethod, ControlRequest, ControlResponse, ControlStatus, PROTOCOL_VERSION,
            request,
        },
        control_socket_path,
    },
    sessions::SessionStore,
};
use legible_protocol::{ChatStatus, DaemonEventEnvelope};
use rustix::process::{Pid, Signal, kill_process};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpStream, UnixStream},
    process::{Child, Command},
    time::{interval, timeout},
};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Message, client::IntoClientRequest},
};

const TEST_TIMEOUT: Duration = Duration::from_secs(10);
const BINARY: &str = env!("CARGO_BIN_EXE_legible-daemon");

struct Fixture {
    _root: TempDir,
    directory: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::Builder::new().prefix("lg").tempdir().unwrap();
        let directory = root.path().canonicalize().unwrap().join("state");

        Self {
            _root: root,
            directory,
        }
    }

    fn store(&self) -> SessionStore {
        SessionStore::new(&self.directory).unwrap()
    }

    fn spawn(&self, port: u16) -> Child {
        Command::new(BINARY)
            .arg("serve")
            .arg("--state-dir")
            .arg(&self.directory)
            .arg("--port")
            .arg(port.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap()
    }

    async fn control(&self, method: ControlMethod, instance: Option<&str>) -> ControlResponse {
        let request_value = ControlRequest {
            protocol: PROTOCOL_VERSION,
            method,
            instance_id: instance.map(str::to_owned),
        };
        let path = control_socket_path(&self.directory).unwrap();

        request(&path, &request_value).await.unwrap()
    }

    async fn ready(&self, child: &mut Child) -> ControlStatus {
        let poll = async {
            let mut ticks = interval(Duration::from_millis(10));

            loop {
                if let Some(status) = child.try_wait().unwrap() {
                    let mut error = String::new();
                    child
                        .stderr
                        .take()
                        .unwrap()
                        .read_to_string(&mut error)
                        .await
                        .unwrap();
                    panic!("daemon exited before readiness: {status}: {error}");
                }

                let path = control_socket_path(&self.directory).unwrap();
                let status_request = ControlRequest {
                    protocol: PROTOCOL_VERSION,
                    method: ControlMethod::Status,
                    instance_id: None,
                };

                if let Ok(ControlResponse::Status { status }) =
                    request(&path, &status_request).await
                {
                    if status.phase == DaemonPhase::Ready {
                        return status;
                    }
                }

                ticks.tick().await;
            }
        };

        timeout(TEST_TIMEOUT, poll).await.unwrap()
    }

    async fn stop(&self, child: &mut Child, status: &ControlStatus) {
        let response = self
            .control(ControlMethod::Stop, Some(&status.instance_id))
            .await;
        assert!(matches!(response, ControlResponse::Stopped { .. }));
        assert_resources_released(&self.directory, status);
        assert!(
            timeout(TEST_TIMEOUT, child.wait())
                .await
                .unwrap()
                .unwrap()
                .success()
        );
    }
}

async fn cli(method: &str, directory: &Path) -> Output {
    let output = Command::new(BINARY)
        .arg(method)
        .arg("--state-dir")
        .arg(directory)
        .kill_on_drop(true)
        .output();

    timeout(TEST_TIMEOUT, output).await.unwrap().unwrap()
}

fn address(status: &ControlStatus) -> SocketAddr {
    status
        .api_origin
        .strip_prefix("http://")
        .unwrap()
        .parse()
        .unwrap()
}

fn assert_resources_released(directory: &Path, status: &ControlStatus) {
    assert!(!directory.join("daemon.sock").exists());
    let listener = TcpListener::bind(address(status)).unwrap();
    drop(listener);
}

async fn assert_startup_failure(mut child: Child) -> String {
    assert!(
        !timeout(TEST_TIMEOUT, child.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );
    let mut error = String::new();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut error)
        .await
        .unwrap();

    assert!(!error.contains("daemon ready"));
    error
}

struct HttpResponse {
    status: u16,
    body: Value,
    cookie: Option<String>,
}

async fn http(
    status: &ControlStatus,
    method: &str,
    path: &str,
    cookie: Option<&str>,
    body: Option<Value>,
) -> HttpResponse {
    let address = address(status);
    let body = body.map(|body| body.to_string()).unwrap_or_default();
    let mut request = format!(
        "{method} {path} HTTP/1.1\r\nHost: {address}\r\nOrigin: http://{address}\r\nConnection: close\r\n"
    );

    if let Some(cookie) = cookie {
        request.push_str(&format!("Cookie: {cookie}\r\n"));
    }
    request.push_str(&format!(
        "Content-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    ));

    let response = timeout(TEST_TIMEOUT, async {
        let mut stream = TcpStream::connect(address).await.unwrap();
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).await.unwrap();
        response
    })
    .await
    .unwrap();
    let (headers, body) = response.split_once("\r\n\r\n").unwrap();
    let status = headers.split_whitespace().nth(1).unwrap().parse().unwrap();
    let cookie = headers.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("set-cookie")
            .then(|| value.trim().split(';').next().unwrap().to_owned())
    });
    let body = if body.is_empty() {
        Value::Null
    } else {
        serde_json::from_str(body).unwrap()
    };

    HttpResponse {
        status,
        body,
        cookie,
    }
}

#[tokio::test]
async fn foreground_binary_serves_authenticated_http_websocket_and_secret_free_status() {
    let fixture = Fixture::new();
    fixture.store().save(&common::record(0)).unwrap();
    let mut child = fixture.spawn(0);
    let status = fixture.ready(&mut child).await;
    let control = fixture
        .control(ControlMethod::Connect, Some(&status.instance_id))
        .await;
    let ControlResponse::Connected { token, .. } = control else {
        panic!()
    };

    let denied = http(&status, "GET", "/api/health", None, None).await;
    assert_eq!(denied.status, 401);
    let auth = http(
        &status,
        "POST",
        "/api/auth",
        None,
        Some(json!({ "token": token })),
    )
    .await;
    assert_eq!(auth.status, 204);
    let cookie = auth.cookie.unwrap();

    let health = http(&status, "GET", "/api/health", Some(&cookie), None).await;
    assert_eq!(health.status, 200);
    assert_eq!(health.body["status"], "degraded");
    let sessions = http(&status, "GET", "/api/sessions", Some(&cookie), None).await;
    assert_eq!(sessions.body[0]["id"], "draft-review");

    let mut upgrade = format!("ws://{}/api/events", address(&status))
        .into_client_request()
        .unwrap();
    upgrade
        .headers_mut()
        .insert("origin", status.api_origin.parse().unwrap());
    upgrade
        .headers_mut()
        .insert("cookie", cookie.parse().unwrap());
    let (mut socket, _) = connect_async(upgrade).await.unwrap();
    let Message::Text(snapshot) = socket.next().await.unwrap().unwrap() else {
        panic!()
    };
    let snapshot: DaemonEventEnvelope = serde_json::from_str(&snapshot).unwrap();
    assert_eq!(snapshot.sequence, 0);

    for (path, mode) in [
        (&fixture.directory, 0o700),
        (&fixture.directory.join("daemon.sock"), 0o600),
        (&fixture.directory.join("daemon.lock"), 0o600),
    ] {
        assert_eq!(fs::symlink_metadata(path).unwrap().mode() & 0o777, mode);
    }

    let output = cli("status", &fixture.directory).await;
    assert!(output.status.success());
    let plain = String::from_utf8(output.stdout).unwrap();
    assert!(!plain.contains(&token));
    assert!(!plain.contains("token"));

    fixture.stop(&mut child, &status).await;
    let Message::Close(Some(frame)) = socket.next().await.unwrap().unwrap() else {
        panic!()
    };
    assert_eq!(u16::from(frame.code), 1001);
    let mut logs = String::new();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut logs)
        .await
        .unwrap();
    assert!(!logs.contains(&token));
    assert!(!logs.contains(&cookie));
}

#[tokio::test]
async fn occupied_port_rejects_startup_before_creating_another_state_directory() {
    let first = Fixture::new();
    let mut child = first.spawn(0);
    let status = first.ready(&mut child).await;
    let second = Fixture::new();

    assert_startup_failure(second.spawn(address(&status).port())).await;

    assert!(!second.directory.exists());
    first.stop(&mut child, &status).await;
}

#[tokio::test]
async fn another_port_cannot_load_or_checkpoint_the_same_state_directory() {
    let fixture = Fixture::new();
    fixture.store().save(&common::record(0)).unwrap();
    let mut child = fixture.spawn(0);
    let status = fixture.ready(&mut child).await;
    let path = fixture.store().path_for("draft-review").unwrap();
    let inode = fs::metadata(&path).unwrap().ino();

    let error = assert_startup_failure(fixture.spawn(0)).await;

    assert!(error.contains("state directory"));
    assert_eq!(fs::metadata(path).unwrap().ino(), inode);
    assert!(matches!(
        fixture.control(ControlMethod::Status, None).await,
        ControlResponse::Status { .. }
    ));
    fixture.stop(&mut child, &status).await;
}

#[tokio::test]
async fn stale_owned_socket_is_reclaimed_after_listener_and_state_lock_are_claimed() {
    let fixture = Fixture::new();
    fixture.store().load_all().unwrap();
    let path = fixture.directory.join("daemon.sock");
    let stale = UnixListener::bind(&path).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    drop(stale);

    let mut child = fixture.spawn(0);
    let status = fixture.ready(&mut child).await;

    fixture.stop(&mut child, &status).await;
}

#[tokio::test]
async fn live_control_socket_is_never_reclaimed_or_followed_by_storage_recovery() {
    let fixture = Fixture::new();
    fixture.store().save(&common::record(2)).unwrap();
    let record = fixture.store().path_for("codex-review").unwrap();
    let original = fs::read(&record).unwrap();
    let path = fixture.directory.join("daemon.sock");
    let _live = UnixListener::bind(&path).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let inode = fs::metadata(&path).unwrap().ino();

    assert_startup_failure(fixture.spawn(0)).await;

    assert_eq!(fs::metadata(path).unwrap().ino(), inode);
    assert_eq!(fs::read(record).unwrap(), original);
}

#[tokio::test]
async fn regular_files_and_symlinks_at_the_control_path_are_never_removed() {
    for linked in [false, true] {
        let fixture = Fixture::new();
        fixture.store().load_all().unwrap();
        let socket = fixture.directory.join("daemon.sock");
        let target = fixture._root.path().join("contributor-data");
        fs::write(&target, b"keep this data").unwrap();

        if linked {
            std::os::unix::fs::symlink(&target, &socket).unwrap();
        } else {
            fs::write(&socket, b"keep this data").unwrap();
        }

        assert_startup_failure(fixture.spawn(0)).await;

        assert_eq!(fs::read(&socket).unwrap(), b"keep this data");
        assert_eq!(fs::read(target).unwrap(), b"keep this data");
    }
}

#[tokio::test]
async fn non_private_state_directories_are_rejected_without_changing_permissions() {
    let fixture = Fixture::new();
    fs::create_dir(&fixture.directory).unwrap();
    fs::set_permissions(&fixture.directory, fs::Permissions::from_mode(0o755)).unwrap();

    assert_startup_failure(fixture.spawn(0)).await;

    assert_eq!(
        fs::metadata(&fixture.directory).unwrap().mode() & 0o777,
        0o755
    );
    assert!(!fixture.directory.join("daemon.lock").exists());
    assert!(!fixture.directory.join("sessions").exists());
}

#[tokio::test]
async fn corrupt_state_fails_startup_without_checkpointing_other_records_and_allows_retry() {
    let fixture = Fixture::new();
    fixture.store().save(&common::record(2)).unwrap();
    let path = fixture.store().path_for("codex-review").unwrap();
    let original = fs::read(&path).unwrap();
    let broken = fixture.store().path_for("zzz-broken").unwrap();
    fs::write(&broken, b"invalid JSON").unwrap();

    assert_startup_failure(fixture.spawn(0)).await;

    assert_eq!(fs::read(path).unwrap(), original);
    assert_eq!(fs::read(&broken).unwrap(), b"invalid JSON");
    assert!(!fixture.directory.join("daemon.sock").exists());
    fs::remove_file(broken).unwrap();

    let mut retry = fixture.spawn(0);
    let status = fixture.ready(&mut retry).await;
    fixture.stop(&mut retry, &status).await;
}

#[tokio::test]
async fn ready_means_recovery_is_checkpointed_and_restart_does_not_add_another_notice() {
    let fixture = Fixture::new();
    fixture.store().save(&common::record(2)).unwrap();
    let mut child = fixture.spawn(0);
    let status = fixture.ready(&mut child).await;
    let first = fixture.store().load_all().unwrap();
    let snapshot = &first[0].chat.as_ref().unwrap().snapshot;

    assert_eq!(snapshot.status, ChatStatus::Failed);
    assert_eq!(snapshot.revision, 10);
    fixture.stop(&mut child, &status).await;

    let mut restarted = fixture.spawn(address(&status).port());
    let next = fixture.ready(&mut restarted).await;

    assert_ne!(status.instance_id, next.instance_id);
    assert_eq!(fixture.store().load_all().unwrap(), first);
    fixture.stop(&mut restarted, &next).await;
}

#[tokio::test]
async fn shutdown_failure_reaches_the_control_client_after_resources_are_released() {
    let fixture = Fixture::new();
    fixture.store().save(&common::record(0)).unwrap();
    let mut child = fixture.spawn(0);
    let status = fixture.ready(&mut child).await;
    let path = fixture.store().path_for("draft-review").unwrap();
    let backup = fixture._root.path().join("saved-record.bak");
    fs::rename(&path, &backup).unwrap();
    fs::create_dir(&path).unwrap();

    let response = fixture
        .control(ControlMethod::Stop, Some(&status.instance_id))
        .await;

    assert!(matches!(response, ControlResponse::Error { code, .. } if code == "shutdown_failed"));
    assert_resources_released(&fixture.directory, &status);
    assert!(
        !timeout(TEST_TIMEOUT, child.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(backup).unwrap()).unwrap()["session"]["id"],
        "draft-review"
    );
    assert!(path.is_dir());
}

#[tokio::test]
async fn interrupt_and_terminate_use_the_same_checkpoint_and_release_path() {
    for signal in [Signal::INT, Signal::TERM] {
        let fixture = Fixture::new();
        fixture.store().save(&common::record(0)).unwrap();
        let mut child = fixture.spawn(0);
        let status = fixture.ready(&mut child).await;
        let mut outside = common::record(0);
        outside.session.comments.clear();
        fixture.store().save(&outside).unwrap();

        let pid = Pid::from_raw(child.id().unwrap() as i32).unwrap();
        kill_process(pid, signal).unwrap();
        assert!(
            timeout(TEST_TIMEOUT, child.wait())
                .await
                .unwrap()
                .unwrap()
                .success()
        );

        assert_resources_released(&fixture.directory, &status);
        assert_eq!(fixture.store().load_all().unwrap(), vec![common::record(0)]);
    }
}

#[tokio::test]
async fn stale_instance_ids_cannot_connect_or_stop_the_daemon() {
    let fixture = Fixture::new();
    let mut child = fixture.spawn(0);
    let status = fixture.ready(&mut child).await;

    for method in [ControlMethod::Connect, ControlMethod::Stop] {
        let response = fixture.control(method, Some("outdated-instance")).await;
        assert!(
            matches!(response, ControlResponse::Error { code, .. } if code == "instance_changed")
        );
    }

    assert!(matches!(
        fixture.control(ControlMethod::Status, None).await,
        ControlResponse::Status { .. }
    ));
    fixture.stop(&mut child, &status).await;
}

#[tokio::test]
async fn malformed_unknown_and_oversized_control_requests_fail_without_echoing_input() {
    let fixture = Fixture::new();
    let mut child = fixture.spawn(0);
    let status = fixture.ready(&mut child).await;
    let inputs = [
        b"not JSON\n".to_vec(),
        b"{\"protocol\":2,\"method\":\"status\"}\n".to_vec(),
        b"{\"protocol\":1,\"method\":\"status\",\"token\":\"must-not-echo\"}\n".to_vec(),
        vec![b'x'; 16 * 1024 + 1],
    ];

    for input in inputs {
        let mut stream = UnixStream::connect(fixture.directory.join("daemon.sock"))
            .await
            .unwrap();
        stream.write_all(&input).await.unwrap();
        let mut response = String::new();
        timeout(TEST_TIMEOUT, stream.read_to_string(&mut response))
            .await
            .unwrap()
            .unwrap();
        let response: Value = serde_json::from_str(&response).unwrap();

        assert_eq!(response["code"], "invalid_request");
        assert!(!response.to_string().contains("must-not-echo"));
    }

    fixture.stop(&mut child, &status).await;
}

#[tokio::test]
async fn explicit_cli_connect_and_stop_use_the_current_private_daemon() {
    let fixture = Fixture::new();
    let mut child = fixture.spawn(0);
    let status = fixture.ready(&mut child).await;

    let connect = cli("connect", &fixture.directory).await;
    assert!(connect.status.success());
    let connected: Value = serde_json::from_slice(&connect.stdout).unwrap();
    assert_eq!(connected["result"], "connected");
    assert_eq!(connected["token"].as_str().unwrap().len(), 43);
    assert_eq!(connected["status"]["instanceId"], status.instance_id);

    let stopped = cli("stop", &fixture.directory).await;
    assert!(stopped.status.success());
    assert_resources_released(&fixture.directory, &status);
    assert!(
        timeout(TEST_TIMEOUT, child.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );
}

#[tokio::test]
async fn invalid_cli_arguments_and_status_of_an_absent_daemon_do_not_create_state() {
    let fixture = Fixture::new();
    let status = cli("status", &fixture.directory).await;
    assert!(!status.status.success());
    assert!(!fixture.directory.exists());

    let invalid = Command::new(BINARY)
        .arg("serve")
        .arg("--state-dir")
        .arg(&fixture.directory)
        .arg("--port")
        .arg("65536")
        .kill_on_drop(true)
        .output()
        .await
        .unwrap();

    assert!(!invalid.status.success());
    assert!(!fixture.directory.exists());
}

#[tokio::test]
async fn simultaneous_starts_serialize_stale_socket_reclamation_and_only_one_becomes_ready() {
    let fixture = Fixture::new();
    fixture.store().load_all().unwrap();
    let path = fixture.directory.join("daemon.sock");
    let stale = UnixListener::bind(&path).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    drop(stale);
    let mut first = fixture.spawn(0);
    let mut second = fixture.spawn(0);
    let first_pid = first.id().unwrap();
    let status_request = ControlRequest {
        protocol: PROTOCOL_VERSION,
        method: ControlMethod::Status,
        instance_id: None,
    };

    let status = timeout(TEST_TIMEOUT, async {
        let mut ticks = interval(Duration::from_millis(10));
        loop {
            if let Ok(ControlResponse::Status { status }) = request(&path, &status_request).await {
                if status.phase == DaemonPhase::Ready {
                    break status;
                }
            }
            ticks.tick().await;
        }
    })
    .await
    .unwrap();

    let (winner, loser) = if status.pid == first_pid {
        (&mut first, &mut second)
    } else {
        (&mut second, &mut first)
    };
    assert!(
        !timeout(TEST_TIMEOUT, loser.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );
    fixture.stop(winner, &status).await;
}

#[tokio::test]
async fn linked_state_directories_and_lock_files_are_rejected_without_touching_their_targets() {
    let fixture = Fixture::new();
    let target = fixture._root.path().join("existing-directory");
    fs::create_dir(&target).unwrap();
    fs::set_permissions(&target, fs::Permissions::from_mode(0o700)).unwrap();
    std::os::unix::fs::symlink(&target, &fixture.directory).unwrap();

    assert_startup_failure(fixture.spawn(0)).await;
    assert_eq!(fs::read_dir(&target).unwrap().count(), 0);

    let fixture = Fixture::new();
    fixture.store().load_all().unwrap();
    let target = fixture._root.path().join("contributor-file");
    fs::write(&target, b"preserve lock target").unwrap();
    std::os::unix::fs::symlink(&target, fixture.directory.join("daemon.lock")).unwrap();

    assert_startup_failure(fixture.spawn(0)).await;
    assert_eq!(fs::read(target).unwrap(), b"preserve lock target");
    assert!(!fixture.directory.join("daemon.sock").exists());
}

#[tokio::test]
async fn default_state_uses_absolute_xdg_root_and_rejects_a_relative_one() {
    let mut fixture = Fixture::new();
    let xdg = fixture._root.path().canonicalize().unwrap().join("xdg");
    fixture.directory = xdg.join("legible");
    let mut child = Command::new(BINARY)
        .arg("serve")
        .arg("--port")
        .arg("0")
        .env("XDG_STATE_HOME", &xdg)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let status = fixture.ready(&mut child).await;
    fixture.stop(&mut child, &status).await;

    let output = Command::new(BINARY)
        .arg("status")
        .current_dir(fixture._root.path())
        .env("XDG_STATE_HOME", "relative-state")
        .kill_on_drop(true)
        .output()
        .await
        .unwrap();

    assert!(!output.status.success());
    assert!(!fixture._root.path().join("relative-state").exists());
}
