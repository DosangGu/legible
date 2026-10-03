use std::error::Error;
use std::fmt;
use std::fs::{self, DirBuilder, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use chrono::DateTime;
use legible_protocol::{ChatSnapshot, DraftComment, ReviewSession};
use serde::{Deserialize, Deserializer, Serialize, de::Error as _};
use serde_json::Value;

#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};

const CURRENT_VERSION: u8 = 1;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// An interrupted request is data only: loading it never starts an agent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum PersistedChatRequest {
    Review,
    Message {
        message: String,
        #[serde(
            rename = "itemId",
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "optional"
        )]
        item_id: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PersistedChatState {
    pub snapshot: ChatSnapshot,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional"
    )]
    pub retry: Option<PersistedChatRequest>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional"
    )]
    pub active: Option<PersistedChatRequest>,
}

/// The current Rust storage format. Older Node formats are not supported or converted.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PersistedSessionRecord {
    version: u8,
    pub session: ReviewSession,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat: Option<PersistedChatState>,
}

impl PersistedSessionRecord {
    pub fn new(session: ReviewSession, chat: Option<PersistedChatState>) -> Self {
        Self {
            version: CURRENT_VERSION,
            session,
            chat,
        }
    }

    pub fn version(&self) -> u8 {
        self.version
    }

    fn validate(&self) -> Result<(), &'static str> {
        if !safe_id(&self.session.id) {
            return Err("invalid session id");
        }
        if self.session.review_revision > MAX_SAFE_INTEGER {
            return Err("invalid review revision");
        }
        if self
            .session
            .worktree_generation
            .as_deref()
            .is_some_and(|value| !is_generation(value))
        {
            return Err("invalid worktree generation");
        }
        if self
            .session
            .archived_at
            .as_deref()
            .is_some_and(|value| !is_timestamp(value))
        {
            return Err("invalid archive timestamp");
        }
        if let Some(deleted_at) = &self.session.deletion_requested_at {
            if self.session.archived_at.is_none() || !is_timestamp(deleted_at) {
                return Err("invalid deletion metadata");
            }
        }
        if !valid_comments(&self.session.comments) {
            return Err("invalid comment revision");
        }
        if let Some(history) = &self.session.submission_history {
            if history.iter().any(|entry| {
                entry.review_revision > MAX_SAFE_INTEGER || !valid_comments(&entry.comments)
            }) {
                return Err("invalid submission history revision");
            }
        }
        if let Some(chat) = &self.chat {
            if chat.snapshot.session_id != self.session.id {
                return Err("chat snapshot does not match session");
            }
        }
        Ok(())
    }
}

impl<'de> Deserialize<'de> for PersistedSessionRecord {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        struct StoredRecord {
            version: u8,
            session: ReviewSession,
            #[serde(default, deserialize_with = "optional")]
            chat: Option<PersistedChatState>,
        }

        let value = Value::deserialize(deserializer)?;
        let stored: StoredRecord =
            serde_json::from_value(value.clone()).map_err(D::Error::custom)?;
        if stored.version != CURRENT_VERSION {
            return Err(D::Error::custom("unsupported session record version"));
        }
        let record = Self::new(stored.session, stored.chat);
        record.validate().map_err(D::Error::custom)?;
        // Keep strict disk validation even though wire models allow additional HTTP fields.
        if serde_json::to_value(&record).map_err(D::Error::custom)? != value {
            return Err(D::Error::custom("unsupported fields in session record"));
        }
        Ok(record)
    }
}

#[derive(Debug)]
pub struct SessionStoreError {
    path: PathBuf,
    source: Box<dyn Error + Send + Sync>,
}

impl SessionStoreError {
    fn new(path: impl Into<PathBuf>, source: impl Error + Send + Sync + 'static) -> Self {
        Self {
            path: path.into(),
            source: Box::new(source),
        }
    }

    fn invalid(path: impl Into<PathBuf>, reason: &'static str) -> Self {
        Self::new(path, io::Error::new(io::ErrorKind::InvalidData, reason))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl fmt::Display for SessionStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "Session store error at {}: {}",
            self.path.display(),
            self.source
        )
    }
}

impl Error for SessionStoreError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(self.source.as_ref())
    }
}

/// Synchronous file storage, to be run off the async request thread when HTTP is ported.
/// The caller supplies a state root; constructing this type performs no filesystem operations.
#[derive(Debug, Clone)]
pub struct SessionStore {
    directory: PathBuf,
}

impl SessionStore {
    pub fn new(state_directory: impl AsRef<Path>) -> Result<Self, SessionStoreError> {
        let root = std::path::absolute(state_directory.as_ref())
            .map_err(|error| SessionStoreError::new(state_directory.as_ref(), error))?;
        Ok(Self {
            directory: root.join("sessions"),
        })
    }

    pub fn path_for(&self, session_id: &str) -> Result<PathBuf, SessionStoreError> {
        if !safe_id(session_id) {
            return Err(SessionStoreError::invalid(
                &self.directory,
                "invalid session id",
            ));
        }
        Ok(self.directory.join(format!("{session_id}.json")))
    }

    /// Load all records before exposing any. Corrupt/unsupported records abort the entire load.
    pub fn load_all(&self) -> Result<Vec<PersistedSessionRecord>, SessionStoreError> {
        self.prepare_directory()?;
        let entries = fs::read_dir(&self.directory)
            .and_then(|entries| {
                entries
                    .map(|entry| entry.map(|entry| entry.path()))
                    .collect::<io::Result<Vec<_>>>()
            })
            .map_err(|error| SessionStoreError::new(&self.directory, error))?;
        let mut paths: Vec<_> = entries
            .into_iter()
            .filter(|path| {
                path.extension()
                    .is_some_and(|extension| extension == "json")
            })
            .collect();
        paths.sort();
        paths.into_iter().map(|path| self.load(&path)).collect()
    }

    pub fn save(&self, record: &PersistedSessionRecord) -> Result<(), SessionStoreError> {
        let target = self.path_for(&record.session.id)?;
        record
            .validate()
            .map_err(|reason| SessionStoreError::invalid(&target, reason))?;
        let mut bytes = serde_json::to_vec_pretty(record)
            .map_err(|error| SessionStoreError::new(&target, error))?;
        bytes.push(b'\n');
        self.prepare_directory()?;
        regular_file_or_missing(&target).map_err(|error| SessionStoreError::new(&target, error))?;

        write_atomically(&self.directory, &target, &bytes)
            .map_err(|error| SessionStoreError::new(&target, error))
    }

    /// Removing a missing record is idempotent and does not create a state directory.
    pub fn remove(&self, session_id: &str) -> Result<(), SessionStoreError> {
        let target = self.path_for(session_id)?;
        match fs::symlink_metadata(&self.directory) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(SessionStoreError::new(&self.directory, error)),
            Ok(_) => self.check_directory()?,
        }
        regular_file_or_missing(&target).map_err(|error| SessionStoreError::new(&target, error))?;
        match fs::remove_file(&target) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(SessionStoreError::new(&target, error)),
        }
    }

    fn load(&self, path: &Path) -> Result<PersistedSessionRecord, SessionStoreError> {
        regular_file_or_missing(path).map_err(|error| SessionStoreError::new(path, error))?;
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        let file = options
            .open(path)
            .map_err(|error| SessionStoreError::new(path, error))?;
        if !file
            .metadata()
            .map_err(|error| SessionStoreError::new(path, error))?
            .is_file()
        {
            return Err(SessionStoreError::invalid(
                path,
                "session path is not a regular file",
            ));
        }
        let record: PersistedSessionRecord =
            serde_json::from_reader(file).map_err(|error| SessionStoreError::new(path, error))?;
        if self.path_for(&record.session.id)? != path {
            return Err(SessionStoreError::invalid(
                path,
                "session id does not match filename",
            ));
        }
        Ok(record)
    }

    fn prepare_directory(&self) -> Result<(), SessionStoreError> {
        let mut builder = DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        builder.mode(0o700);
        builder
            .create(&self.directory)
            .map_err(|error| SessionStoreError::new(&self.directory, error))?;
        self.check_directory()?;
        #[cfg(unix)]
        {
            let directory = OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY)
                .open(&self.directory)
                .map_err(|error| SessionStoreError::new(&self.directory, error))?;
            directory
                .set_permissions(fs::Permissions::from_mode(0o700))
                .map_err(|error| SessionStoreError::new(&self.directory, error))?;
        }
        Ok(())
    }

    fn check_directory(&self) -> Result<(), SessionStoreError> {
        let metadata = fs::symlink_metadata(&self.directory)
            .map_err(|error| SessionStoreError::new(&self.directory, error))?;
        if !metadata.is_dir() {
            return Err(SessionStoreError::invalid(
                &self.directory,
                "sessions path is not a real directory",
            ));
        }
        Ok(())
    }
}

fn write_atomically(directory: &Path, target: &Path, bytes: &[u8]) -> io::Result<()> {
    // Exclusive, private creation; dropping cleans up on failure, including failed rename.
    // Match the Node durability boundary: sync file contents before replacing the old record.
    let mut temporary = tempfile::Builder::new()
        .prefix(".legible-")
        .suffix(".tmp")
        .tempfile_in(directory)?;
    #[cfg(unix)]
    temporary
        .as_file()
        .set_permissions(fs::Permissions::from_mode(0o600))?;
    temporary.write_all(bytes)?;
    temporary.as_file().sync_all()?;
    temporary.persist(target).map_err(|error| error.error)?;
    Ok(())
}

fn regular_file_or_missing(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() => Ok(()),
        Ok(_) => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "session path is not a regular file",
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn safe_id(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn is_generation(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_digit() || matches!(byte, b'a'..=b'f')
            }
        })
}

fn is_timestamp(value: &str) -> bool {
    DateTime::parse_from_rfc3339(value).is_ok()
}

fn valid_comments(comments: &[DraftComment]) -> bool {
    comments.iter().all(|comment| {
        comment
            .anchor_revision
            .is_none_or(|revision| revision <= MAX_SAFE_INTEGER)
    })
}

fn optional<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_rename_removes_the_temporary_file_and_preserves_the_target() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("blocked.json");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("keep.txt"), b"keep").unwrap();

        assert!(write_atomically(directory.path(), &target, b"{}\n").is_err());
        assert_eq!(fs::read(target.join("keep.txt")).unwrap(), b"keep");
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }
}
