use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodeSearchMatch {
    pub path: String,
    pub line: u64,
    pub preview: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeSearchResult {
    pub review_revision: u64,
    pub head_sha: String,
    pub query: String,
    pub matches: Vec<CodeSearchMatch>,
    pub truncated: bool,
    pub skipped_large_files: u64,
}
