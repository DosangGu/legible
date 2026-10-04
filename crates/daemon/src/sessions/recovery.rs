use std::error::Error;
use std::fmt;

use legible_protocol::{
    ChatEntry, ChatEntryBase, ChatNoticeEntry, ChatSnapshot, ChatStatus, NoticeEntryKind,
    NoticeLevel, ToolStatus,
};

use super::store::MAX_SAFE_INTEGER;
use super::{PersistedChatRequest, PersistedChatState};

const INTERRUPTED_TURN: &str =
    "The daemon stopped during this turn. Retry to continue in a new agent session.";
const INTERRUPTED_TOOL: &str = "The daemon stopped before this tool completed.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChatRecoveryError {
    RevisionExhausted { session_id: String },
    InvalidTimestamp,
    InvalidNoticeId,
    InvalidTurnId,
}

impl fmt::Display for ChatRecoveryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RevisionExhausted { session_id } => {
                write!(formatter, "Chat revision is exhausted: {session_id}")
            }
            Self::InvalidTimestamp => formatter.write_str("Invalid chat recovery timestamp"),
            Self::InvalidNoticeId => {
                formatter.write_str("Invalid or duplicate chat recovery notice id")
            }
            Self::InvalidTurnId => formatter.write_str("Invalid chat recovery turn id"),
        }
    }
}

impl Error for ChatRecoveryError {}

/// Recover transcript data only. No CLI, MCP lease, or agent is created by this operation.
pub fn recover_chat(
    mut chat: PersistedChatState,
    restored_at: &str,
    mut id_factory: impl FnMut() -> String,
) -> Result<PersistedChatState, ChatRecoveryError> {
    validate_recovery_context(&chat.snapshot, restored_at)?;

    let has_running_tools = chat.snapshot.entries.iter().any(is_running_tool);
    let active = chat.active.take();
    let can_retry_interrupted_turn = active.is_some();
    let interrupted_item_id = match &active {
        Some(request) => request_item_id(request).map(str::to_owned),
        None => chat.snapshot.current_item_id.clone(),
    };
    let interrupted = active.is_some()
        || has_running_tools
        || matches!(
            chat.snapshot.status,
            ChatStatus::Starting | ChatStatus::Running | ChatStatus::Interrupting,
        );

    if let Some(active) = active {
        chat.retry = Some(active);
    }

    let retry_item_id = chat
        .retry
        .as_ref()
        .and_then(request_item_id)
        .map(str::to_owned);
    let changed = interrupted
        || chat.snapshot.current_turn_id.is_some()
        || chat.snapshot.current_item_id.is_some()
        || chat.snapshot.retry_item_id != retry_item_id;

    if changed {
        advance_revision(&mut chat.snapshot)?;
    }

    if interrupted {
        let notice = interruption_notice(
            &chat.snapshot,
            restored_at,
            interrupted_item_id,
            can_retry_interrupted_turn,
            &mut id_factory,
        )?;

        fail_running_tools(&mut chat.snapshot.entries);
        chat.snapshot.entries.push(ChatEntry::Notice(notice));
        chat.snapshot.status = ChatStatus::Failed;
    }

    chat.snapshot.current_turn_id = None;
    chat.snapshot.current_item_id = None;
    chat.snapshot.retry_item_id = retry_item_id;

    Ok(chat)
}

fn validate_recovery_context(
    snapshot: &ChatSnapshot,
    restored_at: &str,
) -> Result<(), ChatRecoveryError> {
    if chrono::DateTime::parse_from_rfc3339(restored_at).is_err() {
        return Err(ChatRecoveryError::InvalidTimestamp);
    }

    if snapshot.revision > MAX_SAFE_INTEGER {
        return Err(ChatRecoveryError::RevisionExhausted {
            session_id: snapshot.session_id.clone(),
        });
    }

    Ok(())
}

fn advance_revision(snapshot: &mut ChatSnapshot) -> Result<(), ChatRecoveryError> {
    let revision = snapshot
        .revision
        .checked_add(1)
        .filter(|revision| *revision <= MAX_SAFE_INTEGER)
        .ok_or_else(|| ChatRecoveryError::RevisionExhausted {
            session_id: snapshot.session_id.clone(),
        })?;

    snapshot.revision = revision;

    Ok(())
}

fn is_running_tool(entry: &ChatEntry) -> bool {
    matches!(entry, ChatEntry::Tool(tool) if tool.status == ToolStatus::Running)
}

fn fail_running_tools(entries: &mut [ChatEntry]) {
    for entry in entries {
        let ChatEntry::Tool(tool) = entry else {
            continue;
        };

        if tool.status != ToolStatus::Running {
            continue;
        }

        tool.status = ToolStatus::Failed;

        let output = tool.output.get_or_insert_default();
        if !output.is_empty() {
            output.push('\n');
        }
        output.push_str(INTERRUPTED_TOOL);
    }
}

fn interruption_notice(
    snapshot: &ChatSnapshot,
    restored_at: &str,
    item_id: Option<String>,
    retryable: bool,
    id_factory: &mut impl FnMut() -> String,
) -> Result<ChatNoticeEntry, ChatRecoveryError> {
    let notice_id = id_factory();

    if notice_id.is_empty()
        || snapshot
            .entries
            .iter()
            .any(|entry| entry_id(entry) == notice_id)
    {
        return Err(ChatRecoveryError::InvalidNoticeId);
    }

    let turn_id = snapshot.current_turn_id.clone().unwrap_or_else(id_factory);

    if turn_id.is_empty() {
        return Err(ChatRecoveryError::InvalidTurnId);
    }

    let message = if retryable {
        INTERRUPTED_TURN
    } else {
        "The daemon stopped during this turn. Start a new turn to continue."
    };

    Ok(ChatNoticeEntry {
        kind: NoticeEntryKind::Notice,
        base: ChatEntryBase {
            id: notice_id,
            turn_id,
            created_at: restored_at.into(),
            item_id,
        },
        scope: None,
        level: NoticeLevel::Error,
        message: message.into(),
        retryable,
    })
}

fn request_item_id(request: &PersistedChatRequest) -> Option<&str> {
    match request {
        PersistedChatRequest::Review => None,
        PersistedChatRequest::Message { item_id, .. } => item_id.as_deref(),
    }
}

fn entry_id(entry: &ChatEntry) -> &str {
    match entry {
        ChatEntry::Message(entry) => &entry.base.id,
        ChatEntry::Tool(entry) => &entry.base.id,
        ChatEntry::Notice(entry) => &entry.base.id,
    }
}
