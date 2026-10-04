use std::error::Error;
use std::fmt;

use super::{ChatRecoveryError, SessionStoreError};

#[derive(Debug)]
pub enum SessionError {
    DuplicateSession {
        id: String,
    },
    SessionNotFound {
        id: String,
    },
    StaleReviewRevision {
        id: String,
        expected: u64,
        current: u64,
    },
    ReviewArchived {
        id: String,
    },
    ReviewDeleting {
        id: String,
    },
    RevisionWentBackwards {
        id: String,
        current: u64,
        next: u64,
    },
    Store(SessionStoreError),
    Recovery(ChatRecoveryError),
    Flush(Vec<SessionStoreError>),
}

impl fmt::Display for SessionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DuplicateSession { id } => write!(formatter, "Session already exists: {id}"),
            Self::SessionNotFound { id } => write!(formatter, "Session not found: {id}"),
            Self::StaleReviewRevision {
                id,
                expected,
                current,
            } => write!(
                formatter,
                "Stale review revision for {id}: expected {expected}, current {current}"
            ),
            Self::ReviewArchived { id } => write!(
                formatter,
                "Restore this archived review before continuing: {id}"
            ),
            Self::ReviewDeleting { id } => write!(formatter, "Review is pending deletion: {id}"),
            Self::RevisionWentBackwards { id, current, next } => write!(
                formatter,
                "Review revision cannot go backwards for {id}: {current} to {next}"
            ),
            Self::Store(error) => error.fmt(formatter),
            Self::Recovery(error) => error.fmt(formatter),
            Self::Flush(errors) => write!(
                formatter,
                "Unable to flush {} session records",
                errors.len()
            ),
        }
    }
}

impl Error for SessionError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Store(error) => Some(error),
            Self::Recovery(error) => Some(error),
            Self::Flush(errors) => errors.first().map(|error| error as &dyn Error),
            _ => None,
        }
    }
}

impl From<SessionStoreError> for SessionError {
    fn from(error: SessionStoreError) -> Self {
        Self::Store(error)
    }
}

impl From<ChatRecoveryError> for SessionError {
    fn from(error: ChatRecoveryError) -> Self {
        Self::Recovery(error)
    }
}
