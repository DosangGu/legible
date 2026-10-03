//! Rust daemon domain services. The executable does not start these services yet.

pub mod sessions;

pub use legible_protocol as protocol;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
