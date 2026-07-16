//! MCP protocol layer for Wealthfolio.
//!
//! Converts the `wealthfolio-agent-tools` catalog into an MCP server
//! (Streamable HTTP) that runtime hosts embed: the Tauri desktop app on
//! loopback, and the Axum web server at `/mcp`. This crate owns protocol
//! conversion, scope enforcement at the tool boundary, and audit hooks —
//! it does not build services, open the database, or perform transport
//! authentication (hosts do that in their HTTP middleware and inject the
//! resulting [`auth::McpAuthContext`] into request extensions).

pub mod audit;
pub mod auth;
pub mod handler;
pub mod pat;
pub mod service;

pub use audit::{AuditOutcome, AuditSink, McpAuditEntry};
pub use auth::{ActorKind, McpAuthContext};
pub use handler::WealthfolioMcpHandler;
pub use service::McpServerBuilder;

/// Fingerprint a bearer token for discovery files and audit rows:
/// `sha256:<hex>` of the token bytes. Never log or store raw tokens.
pub fn token_fingerprint(token: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(token.as_bytes());
    format!("sha256:{digest:x}")
}
