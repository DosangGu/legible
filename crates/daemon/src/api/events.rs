use std::{sync::Arc, time::Duration};

use axum::{
    extract::{
        State, WebSocketUpgrade,
        ws::{CloseFrame, Message, WebSocket, close_code, rejection::WebSocketUpgradeRejection},
    },
    http::StatusCode,
    response::{IntoResponse, Response},
};
use futures_util::SinkExt;
use legible_protocol::DaemonEventEnvelope;
use tokio::{
    sync::{broadcast, watch},
    time::timeout,
};

use super::{ApiState, DaemonPhase, error::ApiFailure, phase_rejection};
use crate::state::EventSubscription;

const MAX_INCOMING_BYTES: usize = 64 * 1024;
const SEND_TIMEOUT: Duration = Duration::from_secs(5);

pub(super) async fn upgrade(
    State(state): State<ApiState>,
    upgrade: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Result<Response, ApiFailure> {
    let upgrade = upgrade.map_err(|_| {
        ApiFailure::new(
            StatusCode::BAD_REQUEST,
            "invalid_websocket_request",
            "A valid WebSocket upgrade is required",
        )
    })?;

    let phase = state.0.phase.subscribe();
    let subscription = state.owner().subscribe().await?;

    if let Some(response) = phase_rejection(*phase.borrow()) {
        return Ok(response);
    }

    let response = upgrade
        .max_message_size(MAX_INCOMING_BYTES)
        .max_frame_size(MAX_INCOMING_BYTES)
        .on_upgrade(move |socket| stream(socket, subscription, phase));

    Ok(response.into_response())
}

async fn stream(
    mut socket: WebSocket,
    subscription: EventSubscription,
    mut phase: watch::Receiver<DaemonPhase>,
) {
    let EventSubscription {
        snapshot,
        mut events,
    } = subscription;

    if *phase.borrow() != DaemonPhase::Ready {
        close(&mut socket, close_code::AWAY, "Daemon is stopping").await;
        return;
    }

    if !send_event(&mut socket, &snapshot).await {
        return;
    }

    loop {
        tokio::select! {
            // Readiness takes priority over buffered deltas during shutdown.
            biased;

            changed = phase.changed() => {
                if changed.is_err() || *phase.borrow_and_update() != DaemonPhase::Ready {
                    close(&mut socket, close_code::AWAY, "Daemon is stopping").await;
                    return;
                }
            }
            message = socket.recv() => {
                match message {
                    Some(Ok(Message::Text(_) | Message::Binary(_))) => {
                        close(&mut socket, close_code::POLICY, "Event stream is read-only").await;
                        return;
                    }
                    Some(Ok(Message::Ping(_))) => {
                        // Tungstenite queues the automatic pong; flush it with a deadline.
                        let result = timeout(SEND_TIMEOUT, socket.flush()).await;

                        if !matches!(result, Ok(Ok(()))) {
                            return;
                        }
                    }
                    Some(Ok(Message::Close(_))) => {
                        // Dropping immediately would discard the queued close acknowledgement.
                        let _ = timeout(SEND_TIMEOUT, socket.flush()).await;
                        return;
                    }
                    Some(Ok(Message::Pong(_))) => {}
                    _ => return,
                }
            }
            event = events.recv() => {
                if !send_update(&mut socket, event).await {
                    return;
                }
            }
        }
    }
}

async fn send_update(
    socket: &mut WebSocket,
    event: Result<Arc<DaemonEventEnvelope>, broadcast::error::RecvError>,
) -> bool {
    match event {
        Ok(event) => send_event(socket, &event).await,
        Err(broadcast::error::RecvError::Lagged(_)) => {
            close(
                socket,
                close_code::AGAIN,
                "Events missed; reconnect for a snapshot",
            )
            .await;
            false
        }
        Err(broadcast::error::RecvError::Closed) => {
            close(socket, close_code::AWAY, "Daemon state stopped").await;
            false
        }
    }
}

async fn send_event(socket: &mut WebSocket, event: &DaemonEventEnvelope) -> bool {
    let json = match serde_json::to_string(event) {
        Ok(json) => json,
        Err(_) => {
            close(socket, close_code::ERROR, "Event serialization failed").await;
            return false;
        }
    };

    let message = Message::Text(json.into());

    matches!(
        timeout(SEND_TIMEOUT, socket.send(message)).await,
        Ok(Ok(()))
    )
}

async fn close(socket: &mut WebSocket, code: u16, reason: &'static str) {
    let frame = CloseFrame {
        code,
        reason: reason.into(),
    };

    let _ = timeout(SEND_TIMEOUT, socket.send(Message::Close(Some(frame)))).await;
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use axum::{Router, routing::get};
    use futures_util::StreamExt;
    use legible_protocol::{DaemonEvent, DaemonSnapshot, DaemonStatus, PreflightReport};
    use tokio_tungstenite::{connect_async, tungstenite};

    use super::*;
    use crate::api::bind_loopback;

    fn snapshot() -> DaemonEventEnvelope {
        DaemonEventEnvelope {
            event: DaemonEvent::Snapshot(DaemonSnapshot {
                preflight: PreflightReport {
                    status: DaemonStatus::Ready,
                    checked_at: "2026-10-04T00:00:00.000Z".into(),
                    checks: Vec::new(),
                },
                sessions: Vec::new(),
            }),
            sequence: 0,
            emitted_at: "2026-10-04T00:00:00.000Z".into(),
        }
    }

    async fn stream_close_frame(
        subscription: EventSubscription,
    ) -> tungstenite::protocol::CloseFrame {
        let subscription = Arc::new(Mutex::new(Some(subscription)));
        let (phase, _) = watch::channel(DaemonPhase::Ready);
        let handler = move |upgrade: WebSocketUpgrade| {
            let subscription = subscription.lock().unwrap().take().unwrap();
            let phase = phase.subscribe();

            async move { upgrade.on_upgrade(move |socket| stream(socket, subscription, phase)) }
        };

        let listener = bind_loopback("127.0.0.1:0".parse().unwrap()).await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new().route("/events", get(handler));
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let (mut socket, _) = connect_async(format!("ws://{address}/events"))
            .await
            .unwrap();
        let first = socket.next().await.unwrap().unwrap();
        assert!(matches!(first, tungstenite::Message::Text(_)));

        let message = timeout(SEND_TIMEOUT, socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        server.abort();

        let tungstenite::Message::Close(Some(frame)) = message else {
            panic!("expected stream close")
        };

        frame
    }

    #[tokio::test]
    async fn lagged_subscriptions_close_instead_of_silently_skipping_deltas() {
        let (events, receiver) = broadcast::channel(1);
        events.send(Arc::new(snapshot())).unwrap();
        events.send(Arc::new(snapshot())).unwrap();
        let subscription = EventSubscription {
            snapshot: snapshot(),
            events: receiver,
        };

        let frame = stream_close_frame(subscription).await;

        assert_eq!(
            frame.code,
            tungstenite::protocol::frame::coding::CloseCode::Again
        );
        assert_eq!(frame.reason, "Events missed; reconnect for a snapshot");
    }

    #[tokio::test]
    async fn closed_state_owners_close_event_streams() {
        let (events, receiver) = broadcast::channel(1);
        drop(events);
        let subscription = EventSubscription {
            snapshot: snapshot(),
            events: receiver,
        };

        let frame = stream_close_frame(subscription).await;

        assert_eq!(
            frame.code,
            tungstenite::protocol::frame::coding::CloseCode::Away
        );
        assert_eq!(frame.reason, "Daemon state stopped");
    }
}
