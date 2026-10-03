use serde::{Deserialize, Serialize};

use crate::AgentBackendKind;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatStatus {
    Unavailable,
    Idle,
    Starting,
    Running,
    Interrupting,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatUsage {
    pub input_tokens: u64,
    pub cached_input_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_output_tokens: u64,
    pub total_tokens: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatEntryBase {
    pub id: String,
    pub turn_id: String,
    pub created_at: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::optional"
    )]
    pub item_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatRole {
    User,
    Assistant,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolStatus {
    Running,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CompletedToolStatus {
    Completed,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NoticeScope {
    Session,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NoticeLevel {
    Info,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ChatEntry {
    Message(ChatMessageEntry),
    Tool(ChatToolEntry),
    Notice(ChatNoticeEntry),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageEntryKind {
    Message,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolEntryKind {
    Tool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NoticeEntryKind {
    Notice,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatMessageEntry {
    pub kind: MessageEntryKind,
    #[serde(flatten)]
    pub base: ChatEntryBase,
    pub role: ChatRole,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatToolEntry {
    pub kind: ToolEntryKind,
    #[serde(flatten)]
    pub base: ChatEntryBase,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::optional"
    )]
    pub call_id: Option<String>,
    pub name: String,
    pub status: ToolStatus,
    pub input: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::optional"
    )]
    pub output: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatNoticeEntry {
    pub kind: NoticeEntryKind,
    #[serde(flatten)]
    pub base: ChatEntryBase,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::optional"
    )]
    pub scope: Option<NoticeScope>,
    pub level: NoticeLevel,
    pub message: String,
    pub retryable: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSnapshot {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::optional"
    )]
    pub review_pending: Option<bool>,
    pub session_id: String,
    pub revision: u64,
    pub status: ChatStatus,
    pub backend: AgentBackendKind,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::optional"
    )]
    pub model: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::optional"
    )]
    pub unavailable_reason: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::optional"
    )]
    pub current_turn_id: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::optional"
    )]
    pub current_item_id: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::optional"
    )]
    pub retry_item_id: Option<String>,
    pub entries: Vec<ChatEntry>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::optional"
    )]
    pub last_usage: Option<ChatUsage>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub enum ChatStreamEvent {
    #[serde(rename = "status")]
    Status {
        status: ChatStatus,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::optional"
        )]
        current_turn_id: Option<String>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::optional"
        )]
        current_item_id: Option<String>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::optional"
        )]
        retry_item_id: Option<String>,
    },
    #[serde(rename = "entry.added")]
    EntryAdded { entry: ChatEntry },
    #[serde(rename = "assistant.delta")]
    AssistantDelta { entry_id: String, text: String },
    #[serde(rename = "tool.completed")]
    ToolCompleted {
        entry_id: String,
        status: CompletedToolStatus,
        output: String,
    },
    #[serde(rename = "usage")]
    Usage { usage: ChatUsage },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatEventPayload {
    pub session_id: String,
    pub revision: u64,
    pub event: ChatStreamEvent,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatCommandAccepted {
    pub session_id: String,
    pub turn_id: String,
    pub revision: u64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::optional"
    )]
    pub item_id: Option<String>,
}
