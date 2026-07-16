//! Server-mode MCP endpoint (`/mcp`), authenticated with Personal Access
//! Tokens. The rmcp service is mounted outside the `/api/v1` subtree (and
//! outside its request timeout, which would kill SSE streams) behind the
//! PAT middleware in [`auth`].

pub mod audit_sink;
pub mod auth;

use std::sync::Arc;
use std::time::Duration;

use axum::{middleware, Router};
use rmcp::transport::streamable_http_server::StreamableHttpServerConfig;
use wealthfolio_mcp::McpServerBuilder;

use crate::{config::Config, main_lib::AppState};

const INSTRUCTIONS: &str = "Read and write access to the user's Wealthfolio portfolio: accounts, \
holdings, valuations, performance, activities, income, goals, health, and classifications. \
Write capabilities (drafting and committing activities, classification suggestions and commits) depend on the \
scopes granted to the access token in use.";

/// Builds the `/mcp` router: the Streamable HTTP MCP service behind PAT
/// bearer authentication.
pub fn router(state: Arc<AppState>, config: &Config) -> Router {
    let http_config =
        StreamableHttpServerConfig::default().with_sse_keep_alive(Some(Duration::from_secs(30)));
    // Host header validation: explicit allowlist when configured, disabled
    // otherwise (rmcp's default is loopback-only, which breaks reverse
    // proxy deployments; PAT bearer auth is the security boundary here —
    // see `Config::mcp_allowed_hosts`).
    let http_config = match &config.mcp_allowed_hosts {
        Some(hosts) => http_config.with_allowed_hosts(hosts.clone()),
        None => http_config.disable_allowed_hosts(),
    };

    let mut builder =
        McpServerBuilder::new(state.agent_environment.clone()).instructions(INSTRUCTIONS);
    // Audit logging is opt-out via WF_MCP_AUDIT_ENABLED=false.
    if config.mcp_audit_enabled {
        builder = builder.audit(Arc::new(audit_sink::RepoAuditSink(
            state.mcp_audit_repository.clone(),
        )));
    }
    let service = builder.build_http_service(http_config);

    Router::new()
        .nest_service("/mcp", service)
        .layer(middleware::from_fn_with_state(
            auth::PatAuthState::new(state.pat_repository.clone()),
            auth::require_pat,
        ))
}
