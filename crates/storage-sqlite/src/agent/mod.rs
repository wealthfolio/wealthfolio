//! Storage for agent/MCP access: personal access tokens and the audit log.
//!
//! Both tables are local-only (no device-sync outbox participation):
//! credentials and audit history must not replicate across devices.

pub mod audit_log;
pub mod pat;

pub use audit_log::{AuditFilter, McpAuditLogDB, McpAuditRepository, NewMcpAuditLogDB};
pub use pat::{NewPersonalAccessToken, PatRepository, PersonalAccessTokenDB};
