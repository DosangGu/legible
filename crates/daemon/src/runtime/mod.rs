//! Foreground runtime. Claims ownership before loading state; never spawns agents or opens a UI.

pub mod control;
mod ownership;

use std::{
    env,
    future::Future,
    io,
    path::PathBuf,
    sync::Arc,
    time::{Duration, SystemTime},
};

use chrono::{DateTime, SecondsFormat, Utc};
use legible_protocol::{
    DaemonStatus, PreflightCheck, PreflightReport, PreflightStatus, PreflightTool,
};
use tokio::{
    net::UnixStream,
    sync::{mpsc, watch},
    task::JoinHandle,
    time::timeout,
};

use crate::{
    api::{ApiState, BrowserAccess, DaemonPhase, build_app},
    sessions::SessionStore,
    state::{DaemonState, Initialization, Shutdown, StateError},
};
use control::{Context, ControlResponse};
use ownership::Ownership;

type RuntimeError = Box<dyn std::error::Error + Send + Sync>;
const TRANSPORT_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug)]
pub struct RuntimeOptions {
    pub state_directory: PathBuf,
    pub port: u16,
}

pub fn default_state_directory() -> io::Result<PathBuf> {
    if let Some(directory) = env::var_os("XDG_STATE_HOME").filter(|value| !value.is_empty()) {
        let directory = PathBuf::from(directory);
        if !directory.is_absolute() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "XDG_STATE_HOME must be absolute",
            ));
        }

        return Ok(directory.join("legible"));
    }

    let home = env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "Set HOME or use --state-dir")
        })?;

    Ok(PathBuf::from(home).join(".local/state/legible"))
}

pub fn control_socket_path(state_directory: &std::path::Path) -> io::Result<PathBuf> {
    ownership::socket_path(state_directory)
}

/// Signals are registered by the caller before startup. A signal during loading discards recovery
/// without checkpointing; a ready daemon drains and checkpoints before releasing its listeners.
pub async fn run(
    options: RuntimeOptions,
    shutdown: impl Future<Output = ()> + Send,
) -> Result<(), RuntimeError> {
    let root = std::path::absolute(options.state_directory)?;
    let (ownership, http, socket) = Ownership::claim(root, options.port).await?;
    let access = BrowserAccess::new()?;
    let token = access.bootstrap_token().to_owned();
    let store = SessionStore::new(&ownership.root)?;
    let (owner, mut initialized) =
        DaemonState::load(store, pending_preflight(), ownership.clone())?;
    let state = ApiState::from_owner(owner, access);
    let (stopping, stopped) = watch::channel(false);
    let (stop_requests, mut stops) = mpsc::channel(1);
    let context = Context {
        state: state.clone(),
        instance_id: uuid::Uuid::new_v4().to_string(),
        api_origin: format!("http://{}", ownership.address),
        token,
        stops: stop_requests,
    };

    let mut servers = Servers::start(http, socket, context.clone(), stopping, stopped);
    tokio::pin!(shutdown);

    let startup = tokio::select! {
        result = initialize(&state, &mut initialized) => result,
        _ = &mut shutdown => {
            return finish_startup_stop(state, ownership, servers).await;
        }
        result = &mut servers.http => Err(server_failure(result)),
        result = &mut servers.control => Err(server_failure(result)),
    };

    if let Err(error) = startup {
        let _ = finish_startup_stop(state, ownership, servers).await;
        return Err(error);
    }

    state.set_phase(DaemonPhase::Ready);
    eprintln!("Legible daemon ready at {}", context.api_origin);

    let (ticket, stop_reply, failure) = loop {
        tokio::select! {
            _ = &mut shutdown => {
                state.set_phase(DaemonPhase::Stopping);
                break (state.owner().begin_shutdown(true).await, None, None);
            }
            Some(mut stream) = stops.recv() => {
                match state.owner().try_begin_shutdown().await {
                    Ok(ticket) => {
                        state.set_phase(DaemonPhase::Stopping);
                        break (Ok(ticket), Some(stream), None);
                    }
                    Err(StateError::Busy) => {
                        let response = ControlResponse::error("busy", "Daemon has active work; wait and retry");
                        let _ = control::write_json(&mut stream, &response).await;
                    }
                    Err(error) => {
                        state.set_phase(DaemonPhase::Stopping);
                        break (Err(error), Some(stream), None);
                    }
                }
            }
            result = &mut servers.http => {
                state.set_phase(DaemonPhase::Stopping);
                break (state.owner().begin_shutdown(true).await, None, Some(server_failure(result)));
            }
            result = &mut servers.control => {
                state.set_phase(DaemonPhase::Stopping);
                break (state.owner().begin_shutdown(true).await, None, Some(server_failure(result)));
            }
            _ = state.owner().closed() => {
                state.set_phase(DaemonPhase::Stopping);
                break (Err(StateError::Stopped), None, None);
            }
        }
    };

    finish(
        state,
        ownership,
        &mut servers,
        ShutdownPlan {
            ticket,
            reply: stop_reply,
            failure,
        },
        &mut stops,
        &context,
    )
    .await
}

async fn initialize(
    state: &ApiState,
    initialized: &mut Initialization,
) -> Result<(), RuntimeError> {
    initialized.wait().await?;
    state.owner().flush().await?;

    Ok(())
}

async fn finish_startup_stop(
    state: ApiState,
    ownership: Arc<Ownership>,
    mut servers: Servers,
) -> Result<(), RuntimeError> {
    state.set_phase(DaemonPhase::Stopping);
    if let Ok(ticket) = state.owner().begin_shutdown(false).await {
        ticket.finish().await?;
    } else {
        state.owner().join_stopped().await?;
    }

    servers.close().await;
    ownership.release_socket()?;

    Ok(())
}

struct ShutdownPlan {
    ticket: Result<Shutdown, StateError>,
    reply: Option<UnixStream>,
    failure: Option<RuntimeError>,
}

async fn finish(
    state: ApiState,
    ownership: Arc<Ownership>,
    servers: &mut Servers,
    plan: ShutdownPlan,
    stops: &mut mpsc::Receiver<UnixStream>,
    context: &Context,
) -> Result<(), RuntimeError> {
    let ShutdownPlan {
        ticket,
        reply,
        failure,
    } = plan;
    let persisted = match ticket {
        Ok(ticket) => ticket
            .finish()
            .await
            .map_err(|error| Box::new(error) as RuntimeError),
        Err(error) => {
            let _ = state.owner().join_stopped().await;
            Err(Box::new(error) as RuntimeError)
        }
    };

    // Listener guards remain pinned throughout the blocking checkpoint and owner join.
    servers.close().await;
    let mut replies: Vec<_> = reply.into_iter().collect();

    // A validated stop may have raced with a signal before the lifecycle loop dequeued it.
    while let Ok(stream) = stops.try_recv() {
        replies.push(stream);
    }

    let socket_removed = ownership
        .release_socket()
        .map_err(|error| Box::new(error) as RuntimeError);
    drop(ownership);
    drop(state);

    let outcome = persisted
        .and(socket_removed)
        .and(failure.map_or(Ok(()), Err));
    for mut stream in replies {
        let response = match &outcome {
            Ok(()) => ControlResponse::Stopped {
                status: context.status(),
            },
            Err(_) => ControlResponse::error(
                "shutdown_failed",
                "Daemon stopped with persistence or cleanup errors",
            ),
        };
        let _ = control::write_json(&mut stream, &response).await;
    }

    outcome
}

struct Servers {
    http: JoinHandle<io::Result<()>>,
    control: JoinHandle<io::Result<()>>,
    stopping: watch::Sender<bool>,
}

impl Servers {
    fn start(
        http: tokio::net::TcpListener,
        socket: tokio::net::UnixListener,
        context: Context,
        stopping: watch::Sender<bool>,
        mut stopped: watch::Receiver<bool>,
    ) -> Self {
        let app = build_app(context.state.clone());
        let control_stopped = stopped.clone();
        let http = tokio::spawn(async move {
            axum::serve(http, app)
                .with_graceful_shutdown(async move {
                    let _ = stopped.changed().await;
                })
                .await
        });
        let control = tokio::spawn(control::serve(socket, context, control_stopped));

        Self {
            http,
            control,
            stopping,
        }
    }

    async fn close(&mut self) {
        self.stopping.send_replace(true);
        close_task(&mut self.http).await;
        close_task(&mut self.control).await;
    }
}

impl Drop for Servers {
    fn drop(&mut self) {
        self.stopping.send_replace(true);
        self.http.abort();
        self.control.abort();
    }
}

async fn close_task(task: &mut JoinHandle<io::Result<()>>) {
    if !task.is_finished()
        && timeout(TRANSPORT_SHUTDOWN_TIMEOUT, &mut *task)
            .await
            .is_err()
    {
        task.abort();
        let _ = task.await;
    }
}

fn server_failure(result: Result<io::Result<()>, tokio::task::JoinError>) -> RuntimeError {
    match result {
        Ok(Err(error)) => Box::new(error),
        Err(error) => Box::new(error),
        Ok(Ok(())) => Box::new(io::Error::other("Daemon transport stopped unexpectedly")),
    }
}

fn pending_preflight() -> PreflightReport {
    let checked_at =
        DateTime::<Utc>::from(SystemTime::now()).to_rfc3339_opts(SecondsFormat::Millis, true);
    let checks = [
        PreflightTool::Git,
        PreflightTool::Gh,
        PreflightTool::Claude,
        PreflightTool::Codex,
    ]
    .into_iter()
    .map(|tool| PreflightCheck {
        tool,
        status: PreflightStatus::Error,
        version: None,
        message: Some("Tool checks are not implemented in the Rust daemon yet".into()),
    })
    .collect();

    PreflightReport {
        status: DaemonStatus::Degraded,
        checked_at,
        checks,
    }
}
