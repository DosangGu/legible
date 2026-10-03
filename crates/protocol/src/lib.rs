//! Normalized Legible wire models, compatible with the current TypeScript protocol.
//!
//! Vendor agent schemas stay inside daemon adapters. Shared JSON fixtures constrain the
//! migration until schema generation replaces the current TypeScript definitions.

pub mod api;
pub mod chat;
pub mod diff;
pub mod directory;
pub mod model;
pub mod search;

pub use api::*;
pub use chat::*;
pub use diff::*;
pub use directory::*;
pub use model::*;
pub use search::*;

use serde::{Deserialize, Deserializer};

// `deserialize_with` makes nullable-but-required fields fail when their key is missing.
fn required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

// TypeScript's optional fields may be absent, but do not accept explicit JSON null.
fn optional<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}
