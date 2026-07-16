//! Agent Access (embedded MCP server) commands.

use std::sync::Arc;

#[cfg(desktop)]
use log::debug;
use serde::Serialize;
use tauri::{AppHandle, State};
#[cfg(desktop)]
use wealthfolio_agent_tools::{AgentScope, AgentScopeSet};
use wealthfolio_storage_sqlite::agent::McpAuditLogDB;
#[cfg(desktop)]
use wealthfolio_storage_sqlite::agent::{
    AuditFilter, NewPersonalAccessToken, PersonalAccessTokenDB,
};

use crate::context::ServiceContext;
use crate::mcp::{self, McpServerState};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub enabled: bool,
    pub auto_start: bool,
    pub audit_enabled: bool,
    pub running: bool,
    pub port: Option<u16>,
    pub started_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpAuditPage {
    pub items: Vec<McpAuditLogDB>,
    pub total_count: i64,
    /// Distinct tool names across the whole log (for the Tool filter).
    pub available_tools: Vec<String>,
}

/// Per-client Personal Access Token metadata. Never exposes the hash.
/// Mirrors `apps/server/src/api/agent_access.rs::TokenInfo`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenInfo {
    pub id: String,
    pub name: String,
    pub token_prefix: String,
    /// `sha256:<hex-prefix>` matching the audit log's `actor_fingerprint`,
    /// so the UI can attribute audit entries to a named token.
    pub fingerprint: String,
    pub scopes: Vec<String>,
    pub created_at: String,
    pub expires_at: Option<String>,
    pub last_used_at: Option<String>,
    pub revoked_at: Option<String>,
}

#[cfg(desktop)]
impl From<PersonalAccessTokenDB> for TokenInfo {
    fn from(row: PersonalAccessTokenDB) -> Self {
        let scopes: Vec<String> = serde_json::from_str(&row.scopes_json).unwrap_or_default();
        let fingerprint = format!("sha256:{}", &row.token_hash[..16]);
        Self {
            id: row.id,
            name: row.name,
            token_prefix: row.token_prefix,
            fingerprint,
            scopes,
            created_at: row.created_at,
            expires_at: row.expires_at,
            last_used_at: row.last_used_at,
            revoked_at: row.revoked_at,
        }
    }
}

/// A freshly minted PAT — the full `token` is returned exactly once.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedToken {
    /// Full token — shown once, never retrievable again.
    pub token: String,
    pub id: String,
    pub name: String,
    pub token_prefix: String,
    pub scopes: Vec<String>,
    pub created_at: String,
    pub expires_at: Option<String>,
}

/// Validate requested scope strings and return the canonical, deduped set.
/// Mirrors the server's `validate_requested_scopes`.
#[cfg(desktop)]
fn validate_requested_scopes(requested: &[String]) -> Result<Vec<String>, String> {
    if requested.is_empty() {
        return Err("At least one scope is required".to_string());
    }
    let mut set = AgentScopeSet::new();
    for scope in requested {
        let parsed = AgentScope::parse(scope).ok_or_else(|| format!("Unknown scope: {scope}"))?;
        set.insert(parsed);
    }
    if let Some(err) = set.dependency_error() {
        return Err(err);
    }
    Ok(set.iter().map(|s| s.as_str().to_string()).collect())
}

#[cfg(desktop)]
async fn build_status(state: &McpServerState, ctx: &ServiceContext) -> McpStatus {
    let (enabled, auto_start) = mcp::flags(ctx);
    let running = state.running_info().await;
    McpStatus {
        enabled,
        auto_start,
        audit_enabled: mcp::audit_enabled(ctx),
        running: running.is_some(),
        port: running.as_ref().map(|(port, _)| *port),
        started_at: running.map(|(_, started_at)| started_at),
    }
}

#[tauri::command]
pub async fn mcp_get_status(
    state: State<'_, Arc<ServiceContext>>,
    mcp_state: State<'_, McpServerState>,
) -> Result<McpStatus, String> {
    #[cfg(desktop)]
    {
        Ok(build_status(&mcp_state, &state).await)
    }
    #[cfg(not(desktop))]
    {
        let _ = (&state, &mcp_state);
        Err("MCP server is not available on mobile".to_string())
    }
}

#[tauri::command]
pub async fn mcp_set_enabled(
    enabled: bool,
    state: State<'_, Arc<ServiceContext>>,
    mcp_state: State<'_, McpServerState>,
    handle: AppHandle,
) -> Result<McpStatus, String> {
    #[cfg(desktop)]
    {
        debug!("Setting Agent Access feature enabled={}", enabled);
        mcp::set_enabled(&handle, &state, enabled).await?;
        Ok(build_status(&mcp_state, &state).await)
    }
    #[cfg(not(desktop))]
    {
        let _ = (enabled, &state, &mcp_state, &handle);
        Err("MCP server is not available on mobile".to_string())
    }
}

#[tauri::command]
pub async fn mcp_set_auto_start(
    auto_start: bool,
    state: State<'_, Arc<ServiceContext>>,
    mcp_state: State<'_, McpServerState>,
    handle: AppHandle,
) -> Result<McpStatus, String> {
    #[cfg(desktop)]
    {
        debug!("Setting MCP auto-start={}", auto_start);
        mcp::set_auto_start(&handle, &state, auto_start).await?;
        Ok(build_status(&mcp_state, &state).await)
    }
    #[cfg(not(desktop))]
    {
        let _ = (auto_start, &state, &mcp_state, &handle);
        Err("MCP server is not available on mobile".to_string())
    }
}

#[tauri::command]
pub async fn mcp_start(
    state: State<'_, Arc<ServiceContext>>,
    mcp_state: State<'_, McpServerState>,
    handle: AppHandle,
) -> Result<McpStatus, String> {
    #[cfg(desktop)]
    {
        debug!("Starting MCP server");
        mcp::start_server(&handle, &state).await?;
        Ok(build_status(&mcp_state, &state).await)
    }
    #[cfg(not(desktop))]
    {
        let _ = (&state, &mcp_state, &handle);
        Err("MCP server is not available on mobile".to_string())
    }
}

#[tauri::command]
pub async fn mcp_stop(
    state: State<'_, Arc<ServiceContext>>,
    mcp_state: State<'_, McpServerState>,
    handle: AppHandle,
) -> Result<McpStatus, String> {
    #[cfg(desktop)]
    {
        debug!("Stopping MCP server");
        mcp::stop_server(&handle).await;
        Ok(build_status(&mcp_state, &state).await)
    }
    #[cfg(not(desktop))]
    {
        let _ = (&state, &mcp_state, &handle);
        Err("MCP server is not available on mobile".to_string())
    }
}

#[tauri::command]
pub async fn mcp_set_audit_enabled(
    enabled: bool,
    state: State<'_, Arc<ServiceContext>>,
    mcp_state: State<'_, McpServerState>,
    handle: AppHandle,
) -> Result<McpStatus, String> {
    #[cfg(desktop)]
    {
        debug!("Setting MCP audit logging enabled={}", enabled);
        mcp::set_audit_enabled(&handle, &state, enabled).await?;
        Ok(build_status(&mcp_state, &state).await)
    }
    #[cfg(not(desktop))]
    {
        let _ = (enabled, &state, &mcp_state, &handle);
        Err("MCP server is not available on mobile".to_string())
    }
}

#[tauri::command]
pub async fn mcp_list_audit_log(
    page: u32,
    page_size: u32,
    q: Option<String>,
    tools: Option<Vec<String>>,
    outcomes: Option<Vec<String>>,
    actor_kinds: Option<Vec<String>>,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<McpAuditPage, String> {
    #[cfg(desktop)]
    {
        let tools = tools.unwrap_or_default();
        let outcomes = outcomes.unwrap_or_default();
        let actor_kinds = actor_kinds.unwrap_or_default();
        let filter = AuditFilter {
            tool_search: q.as_deref(),
            tools: &tools,
            outcomes: &outcomes,
            actor_kinds: &actor_kinds,
        };
        let repo = state.mcp_audit_repository();
        let (items, total_count) = repo
            .list_paged(page as i64, page_size as i64, &filter)
            .map_err(|e| format!("Failed to list MCP audit log: {e}"))?;
        let available_tools = repo
            .distinct_tools()
            .map_err(|e| format!("Failed to list MCP audit tools: {e}"))?;
        Ok(McpAuditPage {
            items,
            total_count,
            available_tools,
        })
    }
    #[cfg(not(desktop))]
    {
        let _ = (page, page_size, &q, &tools, &outcomes, &actor_kinds, &state);
        Err("MCP server is not available on mobile".to_string())
    }
}

#[tauri::command]
pub async fn mcp_list_tokens(
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Vec<TokenInfo>, String> {
    #[cfg(desktop)]
    {
        let tokens = state
            .pat_repository()
            .list()
            .map_err(|e| format!("Failed to list access tokens: {e}"))?;
        Ok(tokens.into_iter().map(TokenInfo::from).collect())
    }
    #[cfg(not(desktop))]
    {
        let _ = &state;
        Err("MCP server is not available on mobile".to_string())
    }
}

#[tauri::command]
pub async fn mcp_create_token(
    name: String,
    expires_at: Option<String>,
    scopes: Vec<String>,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<CreatedToken, String> {
    #[cfg(desktop)]
    {
        let name = name.trim().to_string();
        if name.is_empty() {
            return Err("Token name must not be empty".to_string());
        }
        if let Some(expires_at) = &expires_at {
            chrono::DateTime::parse_from_rfc3339(expires_at)
                .map_err(|_| "expiresAt must be an RFC 3339 timestamp".to_string())?;
        }

        let scopes = validate_requested_scopes(&scopes)?;

        let token = wealthfolio_mcp::pat::generate_token();
        let prefix = wealthfolio_mcp::pat::token_prefix(&token)
            .ok_or_else(|| "Generated token has invalid format".to_string())?
            .to_string();
        let row = state
            .pat_repository()
            .create(NewPersonalAccessToken {
                name,
                token_prefix: prefix,
                token_hash: wealthfolio_mcp::pat::hash_token(&token),
                scopes_json: serde_json::to_string(&scopes).map_err(|e| e.to_string())?,
                expires_at,
            })
            .await
            .map_err(|e| format!("Failed to create access token: {e}"))?;

        Ok(CreatedToken {
            token,
            id: row.id,
            name: row.name,
            token_prefix: row.token_prefix,
            scopes,
            created_at: row.created_at,
            expires_at: row.expires_at,
        })
    }
    #[cfg(not(desktop))]
    {
        let _ = (name, expires_at, scopes, &state);
        Err("MCP server is not available on mobile".to_string())
    }
}

#[tauri::command]
pub async fn mcp_delete_token(
    id: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<(), String> {
    #[cfg(desktop)]
    {
        let deleted = state
            .pat_repository()
            .delete(&id)
            .await
            .map_err(|e| format!("Failed to remove access token: {e}"))?;
        if deleted {
            Ok(())
        } else {
            Err("Access token not found".to_string())
        }
    }
    #[cfg(not(desktop))]
    {
        let _ = (id, &state);
        Err("MCP server is not available on mobile".to_string())
    }
}

#[tauri::command]
pub async fn mcp_purge_audit_log(state: State<'_, Arc<ServiceContext>>) -> Result<u64, String> {
    #[cfg(desktop)]
    {
        debug!("Purging MCP audit log");
        state
            .mcp_audit_repository()
            .purge_all()
            .await
            .map_err(|e| format!("Failed to purge MCP audit log: {e}"))
    }
    #[cfg(not(desktop))]
    {
        let _ = &state;
        Err("MCP server is not available on mobile".to_string())
    }
}
