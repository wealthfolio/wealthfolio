//! Agent access management: Personal Access Tokens for the `/mcp`
//! endpoint plus the MCP audit log. JWT-protected like the rest of
//! `/api/v1`. Raw tokens are returned exactly once at creation; only
//! hashes are stored, and the hash is never serialized.

use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    routing::{delete, get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use wealthfolio_agent_tools::{AgentScope, AgentScopeSet};
use wealthfolio_storage_sqlite::agent::{
    AuditFilter, McpAuditLogDB, NewPersonalAccessToken, PersonalAccessTokenDB,
};

use crate::{
    error::{ApiError, ApiResult},
    main_lib::AppState,
    mcp::auth::{generate_token, hash_token, token_prefix},
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentAccessStatus {
    mcp_enabled: bool,
    audit_enabled: bool,
    endpoint: &'static str,
}

async fn status(State(state): State<Arc<AppState>>) -> Json<AgentAccessStatus> {
    Json(AgentAccessStatus {
        mcp_enabled: state.mcp_enabled,
        audit_enabled: state.mcp_audit_enabled,
        endpoint: "/mcp",
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TokenInfo {
    id: String,
    name: String,
    token_prefix: String,
    /// `sha256:<hex-prefix>` matching the audit log's `actor_fingerprint`,
    /// so the UI can attribute audit entries to a named token.
    fingerprint: String,
    scopes: Vec<String>,
    created_at: String,
    expires_at: Option<String>,
    last_used_at: Option<String>,
    revoked_at: Option<String>,
}

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

async fn list_tokens(State(state): State<Arc<AppState>>) -> ApiResult<Json<Vec<TokenInfo>>> {
    let tokens = state.pat_repository.list()?;
    Ok(Json(tokens.into_iter().map(TokenInfo::from).collect()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateTokenRequest {
    name: String,
    expires_at: Option<String>,
    /// Canonical scope strings (e.g. `"accounts:read"`). Must be non-empty;
    /// unknown scopes and unmet dependencies are rejected.
    #[serde(default)]
    scopes: Vec<String>,
}

/// Validate the requested scope strings and return the canonical, deduped set.
fn validate_requested_scopes(requested: &[String]) -> Result<Vec<String>, ApiError> {
    if requested.is_empty() {
        return Err(ApiError::BadRequest(
            "At least one scope is required".into(),
        ));
    }
    let mut set = AgentScopeSet::new();
    for scope in requested {
        let parsed = AgentScope::parse(scope)
            .ok_or_else(|| ApiError::BadRequest(format!("Unknown scope: {scope}")))?;
        set.insert(parsed);
    }
    if let Some(err) = set.dependency_error() {
        return Err(ApiError::BadRequest(err));
    }
    Ok(set.iter().map(|s| s.as_str().to_string()).collect())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreatedTokenResponse {
    /// Full token — shown exactly once, never retrievable again.
    token: String,
    id: String,
    name: String,
    token_prefix: String,
    scopes: Vec<String>,
    created_at: String,
    expires_at: Option<String>,
}

async fn create_token(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<CreateTokenRequest>,
) -> ApiResult<(StatusCode, Json<CreatedTokenResponse>)> {
    let name = payload.name.trim().to_string();
    if name.is_empty() {
        return Err(ApiError::BadRequest("Token name must not be empty".into()));
    }
    if let Some(expires_at) = &payload.expires_at {
        chrono::DateTime::parse_from_rfc3339(expires_at)
            .map_err(|_| ApiError::BadRequest("expiresAt must be an RFC 3339 timestamp".into()))?;
    }

    let scopes = validate_requested_scopes(&payload.scopes)?;

    let token = generate_token();
    let prefix = token_prefix(&token)
        .ok_or_else(|| ApiError::Internal("Generated token has invalid format".into()))?
        .to_string();
    let row = state
        .pat_repository
        .create(NewPersonalAccessToken {
            name,
            token_prefix: prefix,
            token_hash: hash_token(&token),
            scopes_json: serde_json::to_string(&scopes)
                .map_err(|e| ApiError::Internal(e.to_string()))?,
            expires_at: payload.expires_at,
        })
        .await?;

    Ok((
        StatusCode::CREATED,
        Json(CreatedTokenResponse {
            token,
            id: row.id,
            name: row.name,
            token_prefix: row.token_prefix,
            scopes,
            created_at: row.created_at,
            expires_at: row.expires_at,
        }),
    ))
}

async fn delete_token(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    if state.pat_repository.delete(&id).await? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::NotFound)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuditQuery {
    page: Option<i64>,
    page_size: Option<i64>,
    /// Case-insensitive substring search on the tool name.
    q: Option<String>,
    /// Comma-separated exact tool names.
    tools: Option<String>,
    /// Comma-separated outcomes.
    outcomes: Option<String>,
    /// Comma-separated actor kinds.
    actor_kinds: Option<String>,
}

/// Split a comma-separated query param into trimmed, non-empty values.
fn csv(value: &Option<String>) -> Vec<String> {
    value
        .as_deref()
        .map(|raw| {
            raw.split(',')
                .map(str::trim)
                .filter(|part| !part.is_empty())
                .map(String::from)
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuditEntry {
    id: String,
    session_id: String,
    actor_kind: String,
    actor_fingerprint: String,
    tool: String,
    scopes: Vec<String>,
    args_summary: Option<String>,
    outcome: String,
    error_message: Option<String>,
    created_at: String,
}

impl From<McpAuditLogDB> for AuditEntry {
    fn from(row: McpAuditLogDB) -> Self {
        let scopes: Vec<String> = serde_json::from_str(&row.scopes_json).unwrap_or_default();
        Self {
            id: row.id,
            session_id: row.session_id,
            actor_kind: row.actor_kind,
            actor_fingerprint: row.actor_fingerprint,
            tool: row.tool,
            scopes,
            args_summary: row.args_summary,
            outcome: row.outcome,
            error_message: row.error_message,
            created_at: row.created_at,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuditPage {
    items: Vec<AuditEntry>,
    total_count: i64,
    /// Distinct tool names across the whole log (for the Tool filter).
    available_tools: Vec<String>,
}

async fn list_audit(
    State(state): State<Arc<AppState>>,
    Query(query): Query<AuditQuery>,
) -> ApiResult<Json<AuditPage>> {
    let tools = csv(&query.tools);
    let outcomes = csv(&query.outcomes);
    let actor_kinds = csv(&query.actor_kinds);
    let filter = AuditFilter {
        tool_search: query.q.as_deref(),
        tools: &tools,
        outcomes: &outcomes,
        actor_kinds: &actor_kinds,
    };
    let (rows, total_count) = state.mcp_audit_repository.list_paged(
        query.page.unwrap_or(1),
        query.page_size.unwrap_or(50),
        &filter,
    )?;
    let available_tools = state.mcp_audit_repository.distinct_tools()?;
    Ok(Json(AuditPage {
        items: rows.into_iter().map(AuditEntry::from).collect(),
        total_count,
        available_tools,
    }))
}

#[derive(Serialize)]
struct PurgeResponse {
    purged: u64,
}

async fn purge_audit(State(state): State<Arc<AppState>>) -> ApiResult<Json<PurgeResponse>> {
    let purged = state.mcp_audit_repository.purge_all().await?;
    Ok(Json(PurgeResponse { purged }))
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/agent-access/status", get(status))
        .route("/agent-access/tokens", get(list_tokens).post(create_token))
        .route("/agent-access/tokens/{id}", delete(delete_token))
        .route("/agent-access/audit", get(list_audit))
        .route("/agent-access/audit/purge", post(purge_audit))
}
