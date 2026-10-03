use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DirectoryEntry {
    pub name: String,
    pub path: String,
    pub repository: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DirectoryListing {
    pub root: String,
    pub path: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::optional"
    )]
    pub parent: Option<String>,
    pub repository: bool,
    pub entries: Vec<DirectoryEntry>,
    pub truncated: bool,
}
