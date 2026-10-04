//! Private, bounded control protocol. Tokens are handed out only by an explicit connect request.

use std::{io, path::Path, time::Duration};

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{UnixListener, UnixStream},
    sync::{mpsc, watch},
    task::JoinSet,
    time::timeout,
};

use super::ownership::{current_uid, inspect_socket};
use crate::{
    VERSION,
    api::{ApiState, DaemonPhase},
};

pub const PROTOCOL_VERSION: u32 = 1;
const MAX_BYTES: u64 = 16 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(2);
const STOP_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_CONNECTIONS: usize = 32;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ControlMethod {
    Status,
    Connect,
    Stop,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControlRequest {
    pub protocol: u32,
    pub method: ControlMethod,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControlStatus {
    pub protocol: u32,
    pub instance_id: String,
    pub pid: u32,
    pub version: String,
    pub phase: DaemonPhase,
    pub api_origin: String,
}

// No Debug derivation: connect responses contain a secret.
#[derive(Serialize, Deserialize)]
#[serde(tag = "result", rename_all = "lowercase", deny_unknown_fields)]
pub enum ControlResponse {
    Status {
        status: ControlStatus,
    },
    Connected {
        status: ControlStatus,
        token: String,
    },
    Stopped {
        status: ControlStatus,
    },
    Error {
        code: String,
        message: String,
    },
}

impl ControlResponse {
    pub(super) fn error(code: &str, message: &str) -> Self {
        Self::Error {
            code: code.into(),
            message: message.into(),
        }
    }
}

#[derive(Clone)]
pub(super) struct Context {
    pub(super) state: ApiState,
    pub(super) instance_id: String,
    pub(super) api_origin: String,
    pub(super) token: String,
    pub(super) stops: mpsc::Sender<UnixStream>,
}

impl Context {
    pub(super) fn status(&self) -> ControlStatus {
        ControlStatus {
            protocol: PROTOCOL_VERSION,
            instance_id: self.instance_id.clone(),
            pid: std::process::id(),
            version: VERSION.into(),
            phase: self.state.phase(),
            api_origin: self.api_origin.clone(),
        }
    }

    async fn handle(&self, mut stream: UnixStream) -> io::Result<()> {
        if stream.peer_cred()?.uid() != current_uid() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Control peer is not the current user",
            ));
        }

        let request = match read_json::<ControlRequest>(&mut stream, REQUEST_TIMEOUT).await {
            Ok(request) if request.protocol == PROTOCOL_VERSION => request,
            _ => {
                let response = ControlResponse::error(
                    "invalid_request",
                    "Invalid or unsupported control request",
                );
                return write_json(&mut stream, &response).await;
            }
        };

        if request.method != ControlMethod::Status
            && request.instance_id.as_deref() != Some(&self.instance_id)
        {
            let response =
                ControlResponse::error("instance_changed", "Daemon instance changed; reconnect");
            return write_json(&mut stream, &response).await;
        }

        let response = match request.method {
            ControlMethod::Status => ControlResponse::Status {
                status: self.status(),
            },
            ControlMethod::Connect if self.state.phase() == DaemonPhase::Ready => {
                ControlResponse::Connected {
                    status: self.status(),
                    token: self.token.clone(),
                }
            }
            ControlMethod::Stop if self.state.phase() == DaemonPhase::Ready => {
                match self.stops.try_send(stream) {
                    Ok(()) => return Ok(()),
                    Err(error) => {
                        stream = error.into_inner();
                        ControlResponse::error("busy", "A stop request is already pending")
                    }
                }
            }
            _ => ControlResponse::error("not_ready", "Daemon is not ready; wait and retry"),
        };

        write_json(&mut stream, &response).await
    }
}

pub(super) async fn serve(
    listener: UnixListener,
    context: Context,
    mut stopping: watch::Receiver<bool>,
) -> io::Result<()> {
    let mut connections = JoinSet::new();

    loop {
        tokio::select! {
            biased;
            _ = stopping.changed() => break,
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
            connection = listener.accept(), if connections.len() < MAX_CONNECTIONS => {
                let (stream, _) = connection?;
                let context = context.clone();
                connections.spawn(async move { let _ = context.handle(stream).await; });
            }
        }
    }

    connections.shutdown().await;

    Ok(())
}

pub async fn request(path: &Path, request: &ControlRequest) -> io::Result<ControlResponse> {
    if inspect_socket(path)?.is_none() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "Daemon is not running",
        ));
    }

    let mut stream = timeout(REQUEST_TIMEOUT, UnixStream::connect(path))
        .await
        .map_err(|_| timed_out())??;
    if stream.peer_cred()?.uid() != current_uid() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Daemon peer is not the current user",
        ));
    }

    write_json(&mut stream, request).await?;
    let deadline = if request.method == ControlMethod::Stop {
        STOP_TIMEOUT
    } else {
        REQUEST_TIMEOUT
    };

    read_json(&mut stream, deadline).await
}

async fn read_json<T: DeserializeOwned>(
    stream: &mut UnixStream,
    deadline: Duration,
) -> io::Result<T> {
    let read = async {
        let mut bytes = Vec::new();
        let mut reader = BufReader::new(stream.take(MAX_BYTES + 1));
        reader.read_until(b'\n', &mut bytes).await?;

        if bytes.len() as u64 > MAX_BYTES || bytes.last() != Some(&b'\n') {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Invalid control frame",
            ));
        }

        serde_json::from_slice(&bytes)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "Invalid control JSON"))
    };

    timeout(deadline, read).await.map_err(|_| timed_out())?
}

pub(super) async fn write_json<T: Serialize>(stream: &mut UnixStream, value: &T) -> io::Result<()> {
    let mut bytes = serde_json::to_vec(value).map_err(io::Error::other)?;
    bytes.push(b'\n');

    if bytes.len() as u64 > MAX_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Control response is too large",
        ));
    }

    timeout(REQUEST_TIMEOUT, stream.write_all(&bytes))
        .await
        .map_err(|_| timed_out())?
}

fn timed_out() -> io::Error {
    io::Error::new(io::ErrorKind::TimedOut, "Control request timed out")
}
