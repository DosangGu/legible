use serde::{Deserialize, Serialize};

use crate::DiffSide;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentBackendKind {
    Claude,
    Codex,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Repo {
    pub id: String,
    pub owner: String,
    pub name: String,
    pub checkouts: Vec<String>,
    pub primary_checkout: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutDetails {
    pub path: String,
    pub available: bool,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::optional"
    )]
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryDetails {
    pub repo: Repo,
    pub checkouts: Vec<CheckoutDetails>,
    pub session_count: u64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::optional"
    )]
    pub primary_change_blocked: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSession {
    pub review_revision: u64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::optional"
    )]
    pub base_tip_sha: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::optional"
    )]
    pub base_ref: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::optional"
    )]
    pub worktree_generation: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::optional"
    )]
    pub submission_history: Option<Vec<SubmittedReviewRecord>>,
    pub id: String,
    pub repo_id: String,
    pub pr_number: u64,
    pub head_sha: String,
    pub base_sha: String,
    pub worktree_path: String,
    pub config: ReviewConfig,
    pub comments: Vec<DraftComment>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::optional"
    )]
    pub submission: Option<ReviewSubmission>,
    pub created_at: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::optional"
    )]
    pub last_opened_at: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::optional"
    )]
    pub archived_at: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::optional"
    )]
    pub deletion_requested_at: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::optional"
    )]
    pub pull_request: Option<ReviewPullRequest>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReviewPullRequest {
    pub title: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmittedReviewRecord {
    pub review_revision: u64,
    pub head_sha: String,
    pub base_sha: String,
    pub comments: Vec<DraftComment>,
    pub submission: SubmittedReviewSubmission,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewUpdate {
    pub review_revision: u64,
    pub pinned_head_sha: String,
    pub head_sha: String,
    pub base_tip_sha: String,
    pub base_ref: String,
    pub head_changed: bool,
    #[serde(deserialize_with = "crate::required_nullable")]
    pub base_changed: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RefreshReviewResponse {
    pub session: ReviewSession,
    pub changed: bool,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::optional"
    )]
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PullRequestState {
    Open,
    Closed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestSummary {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub author: String,
    pub base_ref: String,
    pub head_ref: String,
    pub draft: bool,
    pub state: PullRequestState,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestPage {
    pub items: Vec<PullRequestSummary>,
    pub page: u64,
    pub has_next_page: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionRequest {
    pub repo_id: String,
    pub pr_number: u64,
    pub config: ReviewConfig,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CreateSessionResponse {
    pub session: ReviewSession,
    pub reused: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ReviewEvent {
    Comment,
    RequestChanges,
    Approve,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum ReviewSubmission {
    Submitting(SubmissionDetails),
    Uncertain(SubmissionDetails),
    Submitted(SubmittedReviewDetails),
}

/// Historical receipts accept only completed submissions.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum SubmittedReviewSubmission {
    Submitted(SubmittedReviewDetails),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmissionDetails {
    pub event: ReviewEvent,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::optional"
    )]
    pub body: Option<String>,
    pub marker: String,
    pub started_at: String,
    pub current_head_sha: String,
    pub stale_head: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmittedReviewDetails {
    #[serde(flatten)]
    pub details: SubmissionDetails,
    pub github_review_id: u64,
    pub html_url: String,
    pub submitted_at: String,
    pub cleanup: SubmissionCleanup,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CleanupStatus {
    Pending,
    Complete,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SubmissionCleanup {
    pub status: CleanupStatus,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::optional"
    )]
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitReviewRequest {
    pub event: ReviewEvent,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::optional"
    )]
    pub body: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::optional"
    )]
    pub allow_stale_head: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnchorStatus {
    Current,
    NeedsReview,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CommentOrigin {
    Claude,
    Codex,
    Human,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftComment {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::optional"
    )]
    pub anchor_status: Option<AnchorStatus>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::optional"
    )]
    pub anchor_revision: Option<u64>,
    pub id: String,
    pub path: String,
    pub line: u64,
    pub side: DiffSide,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::optional"
    )]
    pub start_line: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::optional"
    )]
    pub start_side: Option<DiffSide>,
    pub body: String,
    pub origin: CommentOrigin,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateDraftCommentRequest {
    pub path: String,
    pub line: u64,
    pub side: DiffSide,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::optional"
    )]
    pub start_line: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::optional"
    )]
    pub start_side: Option<DiffSide>,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UpdateDraftCommentRequest {
    pub body: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShellPolicy {
    None,
    Git,
    Broad,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NetworkPolicy {
    Off,
    Fetch,
    Free,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OutOfScopePolicy {
    Deny,
    Ask,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSpec {
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
    pub effort: Option<String>,
    pub shell: ShellPolicy,
    pub network: NetworkPolicy,
    pub on_out_of_scope: OutOfScopePolicy,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReviewConfig {
    pub main: AgentSpec,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::optional"
    )]
    pub assist: Option<AgentSpec>,
}
