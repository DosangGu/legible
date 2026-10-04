use std::{env, ffi::OsString, process::ExitCode};

#[cfg(unix)]
use std::path::PathBuf;

const HELP: &str = "legible-daemon: foreground Rust daemon

Usage:
  legible-daemon serve [--state-dir PATH] [--port PORT]
  legible-daemon status|connect|stop [--state-dir PATH]
  legible-daemon --help | --version

The API listens on 127.0.0.1:7777 by default. Use --port 0 for an ephemeral port.
State defaults to $XDG_STATE_HOME/legible or $HOME/.local/state/legible.
Existing state directories must be private (0700); no legacy formats are converted.
Connect explicitly prints a bootstrap token to stdout. Status never exposes credentials.
Web UI serving, background start/attach, and agent execution are not implemented yet.";

type CliError = Box<dyn std::error::Error + Send + Sync>;

#[tokio::main(worker_threads = 2)]
async fn main() -> ExitCode {
    let arguments: Vec<_> = env::args_os().skip(1).collect();

    match arguments.as_slice() {
        [argument] if argument == "--version" || argument == "-V" => {
            println!("legible-daemon {}", legible_daemon::VERSION);
            return ExitCode::SUCCESS;
        }
        [argument] if argument == "--help" || argument == "-h" => {
            println!("{HELP}");
            return ExitCode::SUCCESS;
        }
        _ => {}
    }

    match execute(arguments).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("Legible: {error}");
            ExitCode::from(1)
        }
    }
}

#[cfg(unix)]
async fn execute(arguments: Vec<OsString>) -> Result<(), CliError> {
    use legible_daemon::runtime::{RuntimeOptions, run};
    use tokio::signal::unix::{SignalKind, signal};

    let command = parse(arguments)?;

    match command {
        Command::Serve {
            state_directory,
            port,
        } => {
            // Register signals before claiming listeners or starting blocking initialization.
            let mut interrupt = signal(SignalKind::interrupt())?;
            let mut terminate = signal(SignalKind::terminate())?;
            let shutdown = async move {
                tokio::select! { _ = interrupt.recv() => {}, _ = terminate.recv() => {} }
            };

            run(
                RuntimeOptions {
                    state_directory,
                    port,
                },
                shutdown,
            )
            .await
        }
        Command::Control {
            method,
            state_directory,
        } => control(method, state_directory).await,
    }
}

#[cfg(not(unix))]
async fn execute(_: Vec<OsString>) -> Result<(), CliError> {
    Err("The Rust daemon runtime currently supports Linux, macOS, and WSL only".into())
}

#[cfg(unix)]
enum Command {
    Serve {
        state_directory: PathBuf,
        port: u16,
    },
    Control {
        method: legible_daemon::runtime::control::ControlMethod,
        state_directory: PathBuf,
    },
}

#[cfg(unix)]
fn parse(arguments: Vec<OsString>) -> Result<Command, CliError> {
    use legible_daemon::runtime::{control::ControlMethod, default_state_directory};

    let mut arguments = arguments.into_iter();
    let verb = arguments.next().ok_or(HELP)?;
    let serve = verb == "serve";
    let method = match verb.to_str() {
        Some("serve" | "status") => ControlMethod::Status,
        Some("connect") => ControlMethod::Connect,
        Some("stop") => ControlMethod::Stop,
        _ => return Err(HELP.into()),
    };
    let mut directory = None;
    let mut port = None;

    while let Some(option) = arguments.next() {
        let value = arguments.next().ok_or("Option requires a value")?;

        match option.to_str() {
            Some("--state-dir") if directory.is_none() && !value.is_empty() => {
                directory = Some(PathBuf::from(value));
            }
            Some("--port") if serve && port.is_none() => {
                let value = value
                    .to_str()
                    .ok_or("Port must be an integer from 0 to 65535")?;
                if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
                    return Err("Port must be an integer from 0 to 65535".into());
                }

                port = Some(
                    value
                        .parse::<u16>()
                        .map_err(|_| "Port must be an integer from 0 to 65535")?,
                );
            }
            _ => return Err("Unknown, duplicate, or unsupported option".into()),
        }
    }

    let state_directory = match directory {
        Some(directory) => std::path::absolute(directory)?,
        None => default_state_directory()?,
    };

    if serve {
        Ok(Command::Serve {
            state_directory,
            port: port.unwrap_or(7777),
        })
    } else {
        Ok(Command::Control {
            method,
            state_directory,
        })
    }
}

#[cfg(unix)]
async fn control(
    method: legible_daemon::runtime::control::ControlMethod,
    directory: PathBuf,
) -> Result<(), CliError> {
    use legible_daemon::{
        VERSION,
        runtime::{
            control::{ControlMethod, ControlRequest, ControlResponse, PROTOCOL_VERSION, request},
            control_socket_path,
        },
    };

    let path = control_socket_path(&directory)?;
    let status_request = ControlRequest {
        protocol: PROTOCOL_VERSION,
        method: ControlMethod::Status,
        instance_id: None,
    };
    let response = request(&path, &status_request).await?;
    let ControlResponse::Status { status } = response else {
        return Err("Invalid daemon status response".into());
    };

    if status.protocol != PROTOCOL_VERSION || status.version != VERSION {
        return Err("Daemon version differs; stop it manually before restarting".into());
    }

    let response = if method == ControlMethod::Status {
        ControlResponse::Status { status }
    } else {
        let control_request = ControlRequest {
            protocol: PROTOCOL_VERSION,
            method,
            instance_id: Some(status.instance_id),
        };
        request(&path, &control_request).await?
    };

    let json = serde_json::to_string(&response)?;
    println!("{json}");

    match response {
        ControlResponse::Error { .. } => Err("Control command failed".into()),
        _ => Ok(()),
    }
}
