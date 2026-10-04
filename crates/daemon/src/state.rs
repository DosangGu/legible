//! Serialized state ownership shared by HTTP reads and WebSocket subscriptions.

use std::{
    fmt, io,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    thread,
    time::SystemTime,
};

use chrono::{DateTime, SecondsFormat, Utc};
use legible_protocol::{
    ChatSnapshot, DaemonEvent, DaemonEventEnvelope, DaemonSnapshot, PreflightReport, ReviewSession,
};
use tokio::sync::{broadcast, mpsc, oneshot};

use crate::sessions::{PersistedSessionRecord, SessionError, SessionService, SessionStore};

const COMMAND_CAPACITY: usize = 64;
const EVENT_CAPACITY: usize = 128;
const MAX_SAFE_SEQUENCE: u64 = 9_007_199_254_740_991;

type Job = Box<dyn FnOnce(&mut Owner) + Send>;

/// Clones share one blocking owner; disk I/O never runs on HTTP or WebSocket tasks.
/// Dropping all handles drains queued jobs and exits the owner without an implicit checkpoint.
/// Runtime startup must claim singleton ownership before loading the supplied service.
#[derive(Clone)]
pub struct DaemonState {
    shared: Arc<Shared>,
}

struct Shared {
    commands: mpsc::Sender<Command>,
    accepting: tokio::sync::Mutex<bool>,
    mutations: Arc<AtomicUsize>,
    thread: Mutex<Option<thread::JoinHandle<()>>>,
}

enum Command {
    Run(Job),
    Shutdown {
        checkpoint: bool,
        reply: oneshot::Sender<Result<(), StateError>>,
    },
}

pub struct Initialization(oneshot::Receiver<Result<(), StateError>>);

impl Initialization {
    pub async fn wait(&mut self) -> Result<(), StateError> {
        (&mut self.0).await.map_err(|_| StateError::Stopped)?
    }
}

pub struct Shutdown {
    result: oneshot::Receiver<Result<(), StateError>>,
    shared: Arc<Shared>,
}

impl Shutdown {
    /// The owner drops its service/ownership lease before replying; joining also covers panics.
    pub async fn finish(self) -> Result<(), StateError> {
        let result = self.result.await.unwrap_or(Err(StateError::Stopped));
        join_owner(&self.shared).await?;

        result
    }
}

struct MutationLease(Arc<AtomicUsize>);

impl Drop for MutationLease {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
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
    Busy,
    SequenceExhausted,
    Session(SessionError),
}

impl fmt::Display for StateError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Stopped => formatter.write_str("Daemon state owner stopped"),
            Self::Busy => formatter.write_str("Daemon has active mutations"),
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
        let (state, _) = Self::launch(move || Ok(Owner::new(sessions, preflight)), ())?;

        Ok(state)
    }

    /// Load only after claiming runtime resources. Keep the ownership lease on the blocking
    /// thread so a cancelled startup cannot release singleton ownership during storage I/O.
    pub fn load(
        store: SessionStore,
        preflight: PreflightReport,
        lease: impl Send + 'static,
    ) -> io::Result<(Self, Initialization)> {
        Self::launch(
            move || {
                let sessions = SessionService::open(store)?;
                Ok(Owner::new(sessions, preflight))
            },
            lease,
        )
    }

    fn launch(
        initialize: impl FnOnce() -> Result<Owner, SessionError> + Send + 'static,
        lease: impl Send + 'static,
    ) -> io::Result<(Self, Initialization)> {
        let (commands, mut jobs) = mpsc::channel::<Command>(COMMAND_CAPACITY);
        let (ready, initialized) = oneshot::channel();

        let thread = thread::Builder::new()
            .name("legible-state".into())
            .spawn(move || {
                let lease = lease;
                let mut owner = match initialize() {
                    Ok(owner) => owner,
                    Err(error) => {
                        let _ = ready.send(Err(error.into()));
                        return;
                    }
                };
                let _ = ready.send(Ok(()));

                while let Some(command) = jobs.blocking_recv() {
                    match command {
                        Command::Run(job) => job(&mut owner),
                        Command::Shutdown { checkpoint, reply } => {
                            let result = if checkpoint {
                                owner.sessions.flush().map_err(StateError::from)
                            } else {
                                Ok(())
                            };

                            drop(owner);
                            drop(lease);
                            let _ = reply.send(result);
                            return;
                        }
                    }
                }
            })?;

        let shared = Shared {
            commands,
            accepting: tokio::sync::Mutex::new(true),
            mutations: Arc::new(AtomicUsize::new(0)),
            thread: Mutex::new(Some(thread)),
        };

        Ok((
            Self {
                shared: Arc::new(shared),
            },
            Initialization(initialized),
        ))
    }

    pub async fn preflight(&self) -> Result<PreflightReport, StateError> {
        self.request(false, |owner| Ok(owner.preflight.clone()))
            .await
    }

    pub async fn sessions(&self) -> Result<Vec<ReviewSession>, StateError> {
        self.request(false, |owner| {
            Ok(owner.sessions.registry().list().cloned().collect())
        })
        .await
    }

    pub async fn session(&self, id: &str) -> Result<Option<SessionView>, StateError> {
        let id = id.to_owned();

        self.request(false, move |owner| {
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
        self.request(false, |owner| Ok(owner.subscribe())).await
    }

    pub async fn add(&self, record: PersistedSessionRecord) -> Result<(), StateError> {
        self.request(true, move |owner| {
            owner.mutate(|sessions| sessions.add(record))
        })
        .await
    }

    pub async fn replace(
        &self,
        record: PersistedSessionRecord,
        expected_revision: u64,
    ) -> Result<(), StateError> {
        self.request(true, move |owner| {
            owner.mutate(|sessions| sessions.replace(record, expected_revision))
        })
        .await
    }

    pub async fn update_draft(
        &self,
        record: PersistedSessionRecord,
        expected_revision: u64,
    ) -> Result<(), StateError> {
        self.request(true, move |owner| {
            owner.mutate(|sessions| sessions.update_draft(record, expected_revision))
        })
        .await
    }

    /// Metadata removal only; the caller remains responsible for safe worktree cleanup first.
    pub async fn remove_record(&self, id: &str, expected_revision: u64) -> Result<(), StateError> {
        let id = id.to_owned();

        self.request(true, move |owner| {
            owner.mutate(|sessions| sessions.remove_record(&id, expected_revision))
        })
        .await
    }

    pub async fn update_preflight(&self, report: PreflightReport) -> Result<(), StateError> {
        self.request(true, move |owner| {
            let sequence = owner.next_sequence()?;
            owner.preflight = report.clone();
            owner.publish(DaemonEvent::PreflightUpdated(report), sequence);

            Ok(())
        })
        .await
    }

    /// Explicit recovery/shutdown checkpoint; it does not change visible state or emit events.
    pub async fn flush(&self) -> Result<(), StateError> {
        self.request(true, |owner| {
            owner.sessions.flush().map_err(StateError::from)
        })
        .await
    }

    /// Atomically reject new work, then drain accepted jobs and optionally checkpoint the service.
    /// Startup failures use `checkpoint: false`; shutdown after readiness uses `true`.
    pub async fn begin_shutdown(&self, checkpoint: bool) -> Result<Shutdown, StateError> {
        let accepting = self.shared.accepting.lock().await;
        self.enqueue_shutdown(accepting, checkpoint).await
    }

    /// Join a failed initializer before the runtime releases its singleton resources.
    pub async fn join_stopped(&self) -> Result<(), StateError> {
        if !self.shared.commands.is_closed() {
            return Err(StateError::Busy);
        }

        join_owner(&self.shared).await
    }

    pub async fn closed(&self) {
        self.shared.commands.closed().await;
    }

    /// Control stop refuses busy work without closing admission or changing readiness.
    pub async fn try_begin_shutdown(&self) -> Result<Shutdown, StateError> {
        let accepting = self
            .shared
            .accepting
            .try_lock()
            .map_err(|_| StateError::Busy)?;

        if self.shared.mutations.load(Ordering::Acquire) != 0 {
            return Err(StateError::Busy);
        }

        self.enqueue_shutdown(accepting, true).await
    }

    async fn enqueue_shutdown(
        &self,
        mut accepting: tokio::sync::MutexGuard<'_, bool>,
        checkpoint: bool,
    ) -> Result<Shutdown, StateError> {
        if !*accepting {
            return Err(StateError::Stopped);
        }

        let (reply, result) = oneshot::channel();
        let permit = self
            .shared
            .commands
            .reserve()
            .await
            .map_err(|_| StateError::Stopped)?;
        *accepting = false;
        permit.send(Command::Shutdown { checkpoint, reply });

        Ok(Shutdown {
            result,
            shared: self.shared.clone(),
        })
    }

    /// Once queued, a mutation finishes even if the caller disconnects before receiving its reply.
    async fn request<T: Send + 'static>(
        &self,
        mutating: bool,
        operation: impl FnOnce(&mut Owner) -> Result<T, StateError> + Send + 'static,
    ) -> Result<T, StateError> {
        let accepting = self.shared.accepting.lock().await;
        if !*accepting {
            return Err(StateError::Stopped);
        }

        let lease = if mutating {
            self.shared.mutations.fetch_add(1, Ordering::AcqRel);
            Some(MutationLease(self.shared.mutations.clone()))
        } else {
            None
        };
        let (reply, result) = oneshot::channel();
        let job = Box::new(move |owner: &mut Owner| {
            let _lease = lease;
            let outcome = operation(owner);
            let _ = reply.send(outcome);
        });

        self.shared
            .commands
            .send(Command::Run(job))
            .await
            .map_err(|_| StateError::Stopped)?;
        drop(accepting);
        result.await.map_err(|_| StateError::Stopped)?
    }
}

async fn join_owner(shared: &Shared) -> Result<(), StateError> {
    let thread = shared
        .thread
        .lock()
        .map_err(|_| StateError::Stopped)?
        .take();

    if let Some(thread) = thread {
        tokio::task::spawn_blocking(move || thread.join())
            .await
            .map_err(|_| StateError::Stopped)?
            .map_err(|_| StateError::Stopped)?;
    }

    Ok(())
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
            .shared
            .commands
            .send(Command::Run(Box::new(move |_| {
                let _ = started.send(());
                let _ = blocked.recv();
            })))
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
        assert_eq!(state.shared.commands.capacity(), COMMAND_CAPACITY - 1);
        drop(mutation);
        unblock.send(()).unwrap();

        assert_eq!(state.preflight().await.unwrap(), updated);
        let event = subscription.events.recv().await.unwrap();
        assert_eq!(event.sequence, 1);
        assert_eq!(event.event, DaemonEvent::PreflightUpdated(updated));
    }

    #[tokio::test]
    async fn idle_stop_refuses_active_work_but_signal_shutdown_drains_it_before_exiting() {
        let root = tempfile::tempdir().unwrap();
        let service = SessionService::open(SessionStore::new(root.path()).unwrap()).unwrap();
        let report = PreflightReport {
            status: DaemonStatus::Ready,
            checked_at: "2026-10-04T00:00:00.000Z".into(),
            checks: Vec::new(),
        };
        let state = DaemonState::start(service, report).unwrap();
        let (started, waiting) = oneshot::channel();
        let (unblock, blocked) = std::sync::mpsc::channel();
        let mut mutation = Box::pin(state.request(true, move |_| {
            let _ = started.send(());
            let _ = blocked.recv();
            Ok(())
        }));

        assert!(matches!(
            futures_util::poll!(mutation.as_mut()),
            Poll::Pending
        ));
        waiting.await.unwrap();
        assert!(matches!(
            state.try_begin_shutdown().await,
            Err(StateError::Busy)
        ));
        assert!(*state.shared.accepting.lock().await);

        let ticket = state.begin_shutdown(true).await.unwrap();
        assert!(matches!(state.preflight().await, Err(StateError::Stopped)));
        unblock.send(()).unwrap();
        mutation.await.unwrap();
        ticket.finish().await.unwrap();

        assert_eq!(state.shared.mutations.load(Ordering::Acquire), 0);
        assert!(state.shared.thread.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn cancelled_startup_keeps_its_ownership_lease_until_the_blocking_loader_exits() {
        use std::sync::atomic::AtomicBool;

        struct Lease(Arc<AtomicBool>);
        impl Drop for Lease {
            fn drop(&mut self) {
                self.0.store(false, Ordering::Release);
            }
        }

        let root = tempfile::tempdir().unwrap();
        let store = SessionStore::new(root.path()).unwrap();
        let retained = Arc::new(AtomicBool::new(true));
        let lease = Lease(retained.clone());
        let (started, waiting) = oneshot::channel();
        let (unblock, blocked) = std::sync::mpsc::channel();
        let report = PreflightReport {
            status: DaemonStatus::Ready,
            checked_at: "2026-10-04T00:00:00.000Z".into(),
            checks: Vec::new(),
        };
        let (state, initialized) = DaemonState::launch(
            move || {
                let _ = started.send(());
                let _ = blocked.recv();
                let service = SessionService::open(store)?;
                Ok(Owner::new(service, report))
            },
            lease,
        )
        .unwrap();
        waiting.await.unwrap();
        let thread = state.shared.thread.lock().unwrap().take().unwrap();
        drop(initialized);
        drop(state);

        assert!(retained.load(Ordering::Acquire));
        unblock.send(()).unwrap();
        tokio::task::spawn_blocking(move || thread.join())
            .await
            .unwrap()
            .unwrap();

        assert!(!retained.load(Ordering::Acquire));
    }
}
