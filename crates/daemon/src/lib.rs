//! Rust daemon domain services and HTTP application. The executable does not start them yet.

pub mod api;
pub mod sessions;

pub use legible_protocol as protocol;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
