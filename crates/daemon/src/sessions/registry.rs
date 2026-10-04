use std::collections::BTreeMap;

use legible_protocol::ReviewSession;

use super::{PersistedChatState, PersistedSessionRecord, SessionError};

/// Owns complete session/chat records. Callers only receive immutable references.
#[derive(Debug, Default)]
pub struct SessionRegistry {
    records: BTreeMap<String, PersistedSessionRecord>,
}

impl SessionRegistry {
    pub fn get(&self, id: &str) -> Option<&ReviewSession> {
        self.records.get(id).map(|record| &record.session)
    }

    pub fn record(&self, id: &str) -> Option<&PersistedSessionRecord> {
        self.records.get(id)
    }

    pub fn chat(&self, id: &str) -> Option<&PersistedChatState> {
        self.record(id).and_then(|record| record.chat.as_ref())
    }

    /// Stable ID order; the review UI chooses its own recent-review ordering.
    pub fn list(&self) -> impl ExactSizeIterator<Item = &ReviewSession> {
        self.records.values().map(|record| &record.session)
    }

    pub fn assert_current(&self, id: &str, expected_revision: u64) -> Result<(), SessionError> {
        let session = self
            .get(id)
            .ok_or_else(|| SessionError::SessionNotFound { id: id.into() })?;
        if session.review_revision != expected_revision {
            return Err(SessionError::StaleReviewRevision {
                id: id.into(),
                expected: expected_revision,
                current: session.review_revision,
            });
        }
        Ok(())
    }

    pub fn assert_mutable(&self, id: &str, expected_revision: u64) -> Result<(), SessionError> {
        self.assert_current(id, expected_revision)?;
        let session = self.get(id).expect("assert_current verified the session");
        if session.deletion_requested_at.is_some() {
            return Err(SessionError::ReviewDeleting { id: id.into() });
        }
        if session.archived_at.is_some() {
            return Err(SessionError::ReviewArchived { id: id.into() });
        }
        Ok(())
    }

    pub(super) fn from_records(records: Vec<PersistedSessionRecord>) -> Result<Self, SessionError> {
        let mut registry = Self::default();
        for record in records {
            registry.assert_absent(&record.session.id)?;
            registry.put(record);
        }
        Ok(registry)
    }

    pub(super) fn assert_absent(&self, id: &str) -> Result<(), SessionError> {
        if self.records.contains_key(id) {
            return Err(SessionError::DuplicateSession { id: id.into() });
        }
        Ok(())
    }

    pub(super) fn put(&mut self, record: PersistedSessionRecord) {
        self.records.insert(record.session.id.clone(), record);
    }

    pub(super) fn remove(&mut self, id: &str) {
        self.records.remove(id);
    }
}
