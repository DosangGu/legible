use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::{ChatEventPayload, DiffSide, Repo, ReviewSession};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PreflightTool {
    Git,
    Gh,
    Claude,
    Codex,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PreflightStatus {
    Ready,
    Missing,
    Unauthenticated,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PreflightCheck {
    pub tool: PreflightTool,
    pub status: PreflightStatus,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::optional"
    )]
    pub version: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::optional"
    )]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DaemonStatus {
    Ready,
    Degraded,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightReport {
    pub status: DaemonStatus,
    pub checked_at: String,
    pub checks: Vec<PreflightCheck>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonHealth {
    pub status: DaemonStatus,
    pub version: String,
    pub uptime_seconds: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DaemonSnapshot {
    pub preflight: PreflightReport,
    pub sessions: Vec<ReviewSession>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ApiError {
    pub error: ApiErrorDetails,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ApiErrorDetails {
    pub code: String,
    pub message: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::optional"
    )]
    pub details: Option<Map<String, Value>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewFocusRequest {
    pub session_id: String,
    pub path: String,
    pub line: u64,
    pub side: DiffSide,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::optional"
    )]
    pub start_line: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RemovedItem {
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum DaemonEvent {
    #[serde(rename = "daemon.snapshot")]
    Snapshot(DaemonSnapshot),
    #[serde(rename = "preflight.updated")]
    PreflightUpdated(PreflightReport),
    #[serde(rename = "repo.updated")]
    RepoUpdated(Repo),
    #[serde(rename = "repo.removed")]
    RepoRemoved(RemovedItem),
    #[serde(rename = "session.added")]
    SessionAdded(Box<ReviewSession>),
    #[serde(rename = "session.updated")]
    SessionUpdated(Box<ReviewSession>),
    #[serde(rename = "session.removed")]
    SessionRemoved(RemovedItem),
    #[serde(rename = "chat.event")]
    ChatEvent(ChatEventPayload),
    #[serde(rename = "review.focus.requested")]
    ReviewFocusRequested(ReviewFocusRequest),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonEventEnvelope {
    #[serde(flatten)]
    pub event: DaemonEvent,
    pub sequence: u64,
    pub emitted_at: String,
}
