//! Bridges the MCP audit hook to the SQLite `mcp_audit_log` repository.

use std::sync::Arc;

use wealthfolio_mcp::{AuditSink, McpAuditEntry};
use wealthfolio_storage_sqlite::agent::{McpAuditRepository, NewMcpAuditLogDB};

pub struct RepoAuditSink(pub Arc<McpAuditRepository>);

#[async_trait::async_trait]
impl AuditSink for RepoAuditSink {
    async fn record(&self, entry: McpAuditEntry) {
        let args_summary = if entry.args_summary.is_null() {
            None
        } else {
            Some(entry.args_summary.to_string())
        };
        let row = NewMcpAuditLogDB {
            session_id: entry.session_id,
            actor_kind: entry.actor_kind.as_str().to_string(),
            actor_fingerprint: entry.actor_fingerprint,
            tool: entry.tool,
            scopes_json: serde_json::to_string(&entry.scopes).unwrap_or_else(|_| "[]".to_string()),
            args_summary,
            outcome: entry.outcome.as_str().to_string(),
            error_message: entry.error_message,
        };
        if let Err(err) = self.0.insert(row).await {
            log::error!("Failed to persist MCP audit entry: {err}");
        }
    }
}
