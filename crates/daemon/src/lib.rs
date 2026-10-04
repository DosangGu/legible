//! Rust daemon domain services, authenticated transports, and foreground runtime.

pub mod api;
pub mod sessions;
pub mod state;

#[cfg(unix)]
pub mod runtime;

pub use legible_protocol as protocol;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
