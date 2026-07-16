//! MCP/agent tool execution audit log repository.

use std::sync::Arc;

use diesel::prelude::*;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::db::{get_connection, DbPool, WriteHandle};
use crate::errors::StorageError;
use crate::schema::mcp_audit_log;
use wealthfolio_core::errors::Result;

#[derive(Queryable, Identifiable, Selectable, Insertable, Serialize, Deserialize, Debug, Clone)]
#[diesel(table_name = crate::schema::mcp_audit_log)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct McpAuditLogDB {
    pub id: String,
    pub session_id: String,
    pub actor_kind: String,
    pub actor_fingerprint: String,
    pub tool: String,
    pub scopes_json: String,
    pub args_summary: Option<String>,
    pub outcome: String,
    pub error_message: Option<String>,
    pub created_at: String,
}

/// Input for one audit row. `args_summary` must already be sanitized by
/// the tool's audit sanitizer — this layer persists it verbatim.
#[derive(Debug, Clone)]
pub struct NewMcpAuditLogDB {
    pub session_id: String,
    pub actor_kind: String,
    pub actor_fingerprint: String,
    pub tool: String,
    pub scopes_json: String,
    pub args_summary: Option<String>,
    pub outcome: String,
    pub error_message: Option<String>,
}

/// Server-side filters for [`McpAuditRepository::list_paged`]. Empty slices /
/// `None` mean "no constraint"; multiple values within a field are OR-ed
/// (`IN`), and the fields are AND-ed together.
#[derive(Default, Debug, Clone)]
pub struct AuditFilter<'a> {
    /// Case-insensitive substring match on the tool name.
    pub tool_search: Option<&'a str>,
    /// Exact tool names to include.
    pub tools: &'a [String],
    /// Outcomes to include (`success` | `denied` | `error`).
    pub outcomes: &'a [String],
    /// Actor kinds to include (`pat` | `local_token` | `desktop_bridge`).
    pub actor_kinds: &'a [String],
}

pub struct McpAuditRepository {
    pool: Arc<DbPool>,
    writer: WriteHandle,
}

impl McpAuditRepository {
    pub fn new(pool: Arc<DbPool>, writer: WriteHandle) -> Self {
        Self { pool, writer }
    }

    pub async fn insert(&self, entry: NewMcpAuditLogDB) -> Result<()> {
        let row = McpAuditLogDB {
            id: Uuid::new_v4().to_string(),
            session_id: entry.session_id,
            actor_kind: entry.actor_kind,
            actor_fingerprint: entry.actor_fingerprint,
            tool: entry.tool,
            scopes_json: entry.scopes_json,
            args_summary: entry.args_summary,
            outcome: entry.outcome,
            error_message: entry.error_message,
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        self.writer
            .exec(move |conn| {
                diesel::insert_into(mcp_audit_log::table)
                    .values(&row)
                    .execute(conn)
                    .map_err(StorageError::from)?;
                Ok(())
            })
            .await
    }

    /// One page of audit rows (newest first) plus the total row count for
    /// the active filter. `page` is 1-based. All filters are applied
    /// server-side and combined with AND.
    pub fn list_paged(
        &self,
        page: i64,
        page_size: i64,
        filter: &AuditFilter,
    ) -> Result<(Vec<McpAuditLogDB>, i64)> {
        let page = page.max(1);
        let page_size = page_size.clamp(1, 200);
        let mut conn = get_connection(&self.pool)?;

        let mut count_query = mcp_audit_log::table.into_boxed();
        let mut rows_query = mcp_audit_log::table.into_boxed();

        if let Some(search) = filter.tool_search.filter(|s| !s.is_empty()) {
            // Escape LIKE wildcards so a literal `_`/`%` in the search matches
            // literally. Every tool name contains `_` (e.g.
            // `commit_activity_draft`), which would otherwise act as a
            // single-char wildcard and over-match.
            let escaped = search
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_");
            let pattern = format!("%{escaped}%");
            count_query =
                count_query.filter(mcp_audit_log::tool.like(pattern.clone()).escape('\\'));
            rows_query = rows_query.filter(mcp_audit_log::tool.like(pattern).escape('\\'));
        }
        if !filter.tools.is_empty() {
            count_query = count_query.filter(mcp_audit_log::tool.eq_any(filter.tools.to_vec()));
            rows_query = rows_query.filter(mcp_audit_log::tool.eq_any(filter.tools.to_vec()));
        }
        if !filter.outcomes.is_empty() {
            count_query =
                count_query.filter(mcp_audit_log::outcome.eq_any(filter.outcomes.to_vec()));
            rows_query = rows_query.filter(mcp_audit_log::outcome.eq_any(filter.outcomes.to_vec()));
        }
        if !filter.actor_kinds.is_empty() {
            count_query =
                count_query.filter(mcp_audit_log::actor_kind.eq_any(filter.actor_kinds.to_vec()));
            rows_query =
                rows_query.filter(mcp_audit_log::actor_kind.eq_any(filter.actor_kinds.to_vec()));
        }

        let total: i64 = count_query
            .count()
            .get_result(&mut conn)
            .map_err(StorageError::from)?;
        let rows = rows_query
            .order(mcp_audit_log::created_at.desc())
            .limit(page_size)
            .offset((page - 1) * page_size)
            .select(McpAuditLogDB::as_select())
            .load(&mut conn)
            .map_err(StorageError::from)?;
        Ok((rows, total))
    }

    /// Distinct tool names across the whole log, ascending — used to populate
    /// the Tool filter regardless of the current page.
    pub fn distinct_tools(&self) -> Result<Vec<String>> {
        let mut conn = get_connection(&self.pool)?;
        mcp_audit_log::table
            .select(mcp_audit_log::tool)
            .distinct()
            .order(mcp_audit_log::tool.asc())
            .load::<String>(&mut conn)
            .map_err(|e| StorageError::from(e).into())
    }

    /// Delete every audit row. Returns the number of rows removed.
    pub async fn purge_all(&self) -> Result<u64> {
        self.writer
            .exec(move |conn| {
                let deleted = diesel::delete(mcp_audit_log::table)
                    .execute(conn)
                    .map_err(StorageError::from)?;
                Ok(deleted as u64)
            })
            .await
    }
}
