use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiffLineKind {
    Context,
    Addition,
    Deletion,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: DiffLineKind,
    pub content: String,
    #[serde(deserialize_with = "crate::required_nullable")]
    pub left_line: Option<u64>,
    #[serde(deserialize_with = "crate::required_nullable")]
    pub right_line: Option<u64>,
    pub no_newline_at_end: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub old_start: u64,
    pub old_lines: u64,
    pub new_start: u64,
    pub new_lines: u64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::optional"
    )]
    pub heading: Option<String>,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiffFileStatus {
    Added,
    Deleted,
    Modified,
    Renamed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffFile {
    #[serde(deserialize_with = "crate::required_nullable")]
    pub old_path: Option<String>,
    #[serde(deserialize_with = "crate::required_nullable")]
    pub new_path: Option<String>,
    pub status: DiffFileStatus,
    pub is_binary: bool,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::optional"
    )]
    pub old_mode: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::optional"
    )]
    pub new_mode: Option<String>,
    pub additions: u64,
    pub deletions: u64,
    pub hunks: Vec<DiffHunk>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffDocument {
    pub base_sha: String,
    pub head_sha: String,
    pub additions: u64,
    pub deletions: u64,
    pub files: Vec<DiffFile>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DiffSide {
    Left,
    Right,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewFileContent {
    pub path: String,
    pub side: DiffSide,
    pub sha: String,
    #[serde(deserialize_with = "crate::required_nullable")]
    pub content: Option<String>,
    pub is_binary: bool,
    pub byte_length: u64,
}
