//! Serialized state ownership shared by HTTP reads and WebSocket subscriptions.

use std::{fmt, io, sync::Arc, thread, time::SystemTime};

use chrono::{DateTime, SecondsFormat, Utc};
use legible_protocol::{
    ChatSnapshot, DaemonEvent, DaemonEventEnvelope, DaemonSnapshot, PreflightReport, ReviewSession,
};
use tokio::sync::{broadcast, mpsc, oneshot};

use crate::sessions::{PersistedSessionRecord, SessionError, SessionService};

const COMMAND_CAPACITY: usize = 64;
const EVENT_CAPACITY: usize = 128;
const MAX_SAFE_SEQUENCE: u64 = 9_007_199_254_740_991;

type Job = Box<dyn FnOnce(&mut Owner) + Send>;

/// Clones share one blocking owner; disk I/O never runs on HTTP or WebSocket tasks.
/// Dropping all handles drains queued jobs and exits the owner without an implicit checkpoint.
/// Runtime startup must claim singleton ownership before loading the supplied service.
#[derive(Clone)]
pub struct DaemonState {
    commands: mpsc::Sender<Job>,
}

/// A single atomic read, without private active/retry requests from persisted chat state.
#[derive(Debug)]
pub struct SessionView {
    pub session: ReviewSession,
    pub chat: Option<ChatSnapshot>,
}

/// The snapshot includes every change through its sequence; the receiver starts strictly after it.
pub struct EventSubscription {
    pub snapshot: DaemonEventEnvelope,
    pub events: broadcast::Receiver<Arc<DaemonEventEnvelope>>,
}

#[derive(Debug)]
pub enum StateError {
    Stopped,
    SequenceExhausted,
    Session(SessionError),
}

impl fmt::Display for StateError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Stopped => formatter.write_str("Daemon state owner stopped"),
            Self::SequenceExhausted => formatter.write_str("Daemon event sequence exhausted"),
            Self::Session(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for StateError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Session(error) => Some(error),
            _ => None,
        }
    }
}

impl From<SessionError> for StateError {
    fn from(error: SessionError) -> Self {
        Self::Session(error)
    }
}

impl DaemonState {
    pub fn start(sessions: SessionService, preflight: PreflightReport) -> io::Result<Self> {
        let (commands, mut jobs) = mpsc::channel::<Job>(COMMAND_CAPACITY);
        let mut owner = Owner::new(sessions, preflight);

        thread::Builder::new()
            .name("legible-state".into())
            .spawn(move || {
                while let Some(job) = jobs.blocking_recv() {
                    job(&mut owner);
                }
            })?;

        Ok(Self { commands })
    }

    pub async fn preflight(&self) -> Result<PreflightReport, StateError> {
        self.request(|owner| Ok(owner.preflight.clone())).await
    }

    pub async fn sessions(&self) -> Result<Vec<ReviewSession>, StateError> {
        self.request(|owner| Ok(owner.sessions.registry().list().cloned().collect()))
            .await
    }

    pub async fn session(&self, id: &str) -> Result<Option<SessionView>, StateError> {
        let id = id.to_owned();

        self.request(move |owner| {
            let registry = owner.sessions.registry();
            let view = registry.get(&id).map(|session| SessionView {
                session: session.clone(),
                chat: registry.chat(&id).map(|chat| chat.snapshot.clone()),
            });

            Ok(view)
        })
        .await
    }

    /// Snapshot creation and subscription share one queue position with durable mutations.
    pub async fn subscribe(&self) -> Result<EventSubscription, StateError> {
        self.request(|owner| Ok(owner.subscribe())).await
    }

    pub async fn add(&self, record: PersistedSessionRecord) -> Result<(), StateError> {
        self.request(move |owner| owner.mutate(|sessions| sessions.add(record)))
            .await
    }

    pub async fn replace(
        &self,
        record: PersistedSessionRecord,
        expected_revision: u64,
    ) -> Result<(), StateError> {
        self.request(move |owner| {
            owner.mutate(|sessions| sessions.replace(record, expected_revision))
        })
        .await
    }

    pub async fn update_draft(
        &self,
        record: PersistedSessionRecord,
        expected_revision: u64,
    ) -> Result<(), StateError> {
        self.request(move |owner| {
            owner.mutate(|sessions| sessions.update_draft(record, expected_revision))
        })
        .await
    }

    /// Metadata removal only; the caller remains responsible for safe worktree cleanup first.
    pub async fn remove_record(&self, id: &str, expected_revision: u64) -> Result<(), StateError> {
        let id = id.to_owned();

        self.request(move |owner| {
            owner.mutate(|sessions| sessions.remove_record(&id, expected_revision))
        })
        .await
    }

    pub async fn update_preflight(&self, report: PreflightReport) -> Result<(), StateError> {
        self.request(move |owner| {
            let sequence = owner.next_sequence()?;
            owner.preflight = report.clone();
            owner.publish(DaemonEvent::PreflightUpdated(report), sequence);

            Ok(())
        })
        .await
    }

    /// Explicit recovery/shutdown checkpoint; it does not change visible state or emit events.
    pub async fn flush(&self) -> Result<(), StateError> {
        self.request(|owner| owner.sessions.flush().map_err(StateError::from))
            .await
    }

    /// Once queued, a mutation finishes even if the caller disconnects before receiving its reply.
    async fn request<T: Send + 'static>(
        &self,
        operation: impl FnOnce(&mut Owner) -> Result<T, StateError> + Send + 'static,
    ) -> Result<T, StateError> {
        let (reply, result) = oneshot::channel();
        let job = Box::new(move |owner: &mut Owner| {
            let outcome = operation(owner);
            let _ = reply.send(outcome);
        });

        self.commands
            .send(job)
            .await
            .map_err(|_| StateError::Stopped)?;
        result.await.map_err(|_| StateError::Stopped)?
    }
}

struct Owner {
    sessions: SessionService,
    preflight: PreflightReport,
    sequence: u64,
    events: broadcast::Sender<Arc<DaemonEventEnvelope>>,
}

impl Owner {
    fn new(sessions: SessionService, preflight: PreflightReport) -> Self {
        let (events, _) = broadcast::channel(EVENT_CAPACITY);

        Self {
            sessions,
            preflight,
            sequence: 0,
            events,
        }
    }

    fn subscribe(&self) -> EventSubscription {
        let events = self.events.subscribe();
        let snapshot = DaemonSnapshot {
            preflight: self.preflight.clone(),
            sessions: self.sessions.registry().list().cloned().collect(),
        };
        let snapshot = envelope(DaemonEvent::Snapshot(snapshot), self.sequence);

        EventSubscription { snapshot, events }
    }

    fn mutate(
        &mut self,
        operation: impl FnOnce(&mut SessionService) -> Result<DaemonEvent, SessionError>,
    ) -> Result<(), StateError> {
        let sequence = self.next_sequence()?;
        let event = operation(&mut self.sessions)?;

        self.publish(event, sequence);

        Ok(())
    }

    fn next_sequence(&self) -> Result<u64, StateError> {
        if self.sequence >= MAX_SAFE_SEQUENCE {
            return Err(StateError::SequenceExhausted);
        }

        Ok(self.sequence + 1)
    }

    fn publish(&mut self, event: DaemonEvent, sequence: u64) {
        self.sequence = sequence;
        let event = Arc::new(envelope(event, sequence));

        // No subscribers is normal. Slow subscribers cannot stall or roll back a durable change.
        let _ = self.events.send(event);
    }
}

fn envelope(event: DaemonEvent, sequence: u64) -> DaemonEventEnvelope {
    let emitted_at =
        DateTime::<Utc>::from(SystemTime::now()).to_rfc3339_opts(SecondsFormat::Millis, true);

    DaemonEventEnvelope {
        event,
        sequence,
        emitted_at,
    }
}

#[cfg(test)]
mod tests {
    use std::task::Poll;

    use legible_protocol::DaemonStatus;

    use super::*;
    use crate::sessions::SessionStore;

    #[test]
    fn sequence_exhaustion_rejects_before_mutation_runs() {
        let root = tempfile::tempdir().unwrap();
        let service = SessionService::open(SessionStore::new(root.path()).unwrap()).unwrap();
        let report = PreflightReport {
            status: DaemonStatus::Ready,
            checked_at: "2026-10-04T00:00:00.000Z".into(),
            checks: Vec::new(),
        };
        let mut owner = Owner::new(service, report);
        owner.sequence = MAX_SAFE_SEQUENCE;

        let result = owner.mutate(|_| panic!("exhausted sequences must not mutate state"));

        assert!(matches!(result, Err(StateError::SequenceExhausted)));
        assert_eq!(owner.subscribe().snapshot.sequence, MAX_SAFE_SEQUENCE);
    }

    #[tokio::test]
    async fn dropping_a_queued_mutation_reply_does_not_cancel_its_change_or_event() {
        let root = tempfile::tempdir().unwrap();
        let service = SessionService::open(SessionStore::new(root.path()).unwrap()).unwrap();
        let report = PreflightReport {
            status: DaemonStatus::Ready,
            checked_at: "2026-10-04T00:00:00.000Z".into(),
            checks: Vec::new(),
        };
        let state = DaemonState::start(service, report.clone()).unwrap();
        let mut subscription = state.subscribe().await.unwrap();
        let (started, waiting) = oneshot::channel();
        let (unblock, blocked) = std::sync::mpsc::channel();

        // Hold the owner so the next operation is accepted but cannot start yet.
        state
            .commands
            .send(Box::new(move |_| {
                let _ = started.send(());
                let _ = blocked.recv();
            }))
            .await
            .unwrap();
        waiting.await.unwrap();

        let mut updated = report;
        updated.status = DaemonStatus::Degraded;
        let mut mutation = Box::pin(state.update_preflight(updated.clone()));

        assert!(matches!(
            futures_util::poll!(mutation.as_mut()),
            Poll::Pending
        ));
        assert_eq!(state.commands.capacity(), COMMAND_CAPACITY - 1);
        drop(mutation);
        unblock.send(()).unwrap();

        assert_eq!(state.preflight().await.unwrap(), updated);
        let event = subscription.events.recv().await.unwrap();
        assert_eq!(event.sequence, 1);
        assert_eq!(event.event, DaemonEvent::PreflightUpdated(updated));
    }
}
