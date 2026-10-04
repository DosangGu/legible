//! Rust daemon domain services and HTTP/WebSocket application. The binary does not start them yet.

pub mod api;
pub mod sessions;
pub mod state;

pub use legible_protocol as protocol;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
