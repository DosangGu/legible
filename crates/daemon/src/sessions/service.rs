use std::time::SystemTime;

use chrono::{DateTime, SecondsFormat, Utc};
use legible_protocol::{DaemonEvent, RemovedItem};

use super::{PersistedSessionRecord, SessionError, SessionRegistry, SessionStore, recover_chat};

/// Owns the durable mutation boundary. Mutable access serializes changes; no registry mutator is
/// exposed. Async callers must run these synchronous operations on a dedicated blocking owner.
#[derive(Debug)]
pub struct SessionService {
    store: SessionStore,
    registry: SessionRegistry,
}

impl SessionService {
    /// Validate and recover every record before exposing the registry. Opening never rewrites
    /// records or starts agents; checkpoint the recovered state with an explicit flush.
    /// The runtime must acquire daemon singleton ownership before opening a real state root.
    pub fn open(store: SessionStore) -> Result<Self, SessionError> {
        let records = store.load_all()?;
        let restored_at =
            DateTime::<Utc>::from(SystemTime::now()).to_rfc3339_opts(SecondsFormat::Millis, true);

        let recovered = records
            .into_iter()
            .map(|record| recover_record(record, &restored_at))
            .collect::<Result<Vec<_>, SessionError>>()?;
        let registry = SessionRegistry::from_records(recovered)?;

        Ok(Self { store, registry })
    }

    pub fn registry(&self) -> &SessionRegistry {
        &self.registry
    }

    /// Return the publication event only after persistence and in-memory ownership succeed.
    pub fn add(&mut self, record: PersistedSessionRecord) -> Result<DaemonEvent, SessionError> {
        self.registry.assert_absent(&record.session.id)?;
        self.store.save(&record)?;

        let event = DaemonEvent::SessionAdded(Box::new(record.session.clone()));
        self.registry.put(record);

        Ok(event)
    }

    /// Revision-checked metadata replacement, including archive/restore transitions. Operation-
    /// specific services still need to validate agent, submission, and worktree preconditions.
    pub fn replace(
        &mut self,
        record: PersistedSessionRecord,
        expected_revision: u64,
    ) -> Result<DaemonEvent, SessionError> {
        self.registry
            .assert_current(&record.session.id, expected_revision)?;
        let current = self
            .registry
            .get(&record.session.id)
            .expect("assert_current verified the session");

        if record.session.review_revision < current.review_revision {
            return Err(SessionError::RevisionWentBackwards {
                id: record.session.id,
                current: current.review_revision,
                next: record.session.review_revision,
            });
        }

        self.store.save(&record)?;

        let event = DaemonEvent::SessionUpdated(Box::new(record.session.clone()));
        self.registry.put(record);

        Ok(event)
    }

    /// Draft handlers use this boundary to reject archived/deleting reviews before saving.
    pub fn update_draft(
        &mut self,
        record: PersistedSessionRecord,
        expected_revision: u64,
    ) -> Result<DaemonEvent, SessionError> {
        self.registry
            .assert_mutable(&record.session.id, expected_revision)?;

        self.replace(record, expected_revision)
    }

    /// Metadata-only removal. The caller must safely clean up the worktree before invoking it.
    /// A failed disk removal leaves registry ownership intact and returns no event.
    pub fn remove_record(
        &mut self,
        id: &str,
        expected_revision: u64,
    ) -> Result<DaemonEvent, SessionError> {
        self.registry.assert_current(id, expected_revision)?;
        self.store.remove(id)?;

        self.registry.remove(id);

        Ok(DaemonEvent::SessionRemoved(RemovedItem { id: id.into() }))
    }

    /// Checkpoint every record, including recovered transcripts. Attempt all writes so a failure
    /// in one review does not prevent other reviews from being saved during shutdown.
    pub fn flush(&self) -> Result<(), SessionError> {
        let mut errors = Vec::new();

        for session in self.registry.list() {
            let record = self
                .registry
                .record(&session.id)
                .expect("listed session is owned");

            if let Err(error) = self.store.save(record) {
                errors.push(error);
            }
        }

        if errors.is_empty() {
            Ok(())
        } else {
            Err(SessionError::Flush(errors))
        }
    }
}

fn recover_record(
    mut record: PersistedSessionRecord,
    restored_at: &str,
) -> Result<PersistedSessionRecord, SessionError> {
    if let Some(chat) = record.chat.take() {
        let recovered = recover_chat(chat, restored_at, || uuid::Uuid::new_v4().to_string())?;
        record.chat = Some(recovered);
    }

    Ok(record)
}
