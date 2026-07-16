//! Embedded loopback MCP HTTP server.
//!
//! Binds `127.0.0.1` only: the fixed default port first, falling back to
//! a random high port when taken (the lock file is the source of truth
//! for discovery).

use std::io;
use std::sync::Arc;

use axum::routing::get;
use axum::{middleware, Json, Router};
use chrono::Utc;
use rmcp::transport::streamable_http_server::StreamableHttpServerConfig;
use tokio_util::sync::CancellationToken;
use wealthfolio_agent_tools::AgentEnvironment;
use wealthfolio_mcp::{AuditSink, McpServerBuilder};
use wealthfolio_storage_sqlite::agent::PatRepository;

use super::middleware::{require_pat, validate_origin};
use super::RunningServer;

/// Fixed default port; falls back to a random port when already in use.
pub const DEFAULT_PORT: u16 = 8639;

const INSTRUCTIONS: &str = "Read and write access to the user's Wealthfolio portfolio: accounts, \
holdings, valuations, performance, activities, income, goals, health, and classifications. \
Write capabilities (drafting and committing activities, classification suggestions and commits) depend on the \
scopes granted to the access token in use.";

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "status": "ok",
        "server": "wealthfolio-mcp",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

/// Builds the router: `GET /health` (no auth) plus `/mcp` behind the
/// Origin and bearer middlewares. `cancel` tears down active MCP sessions
/// (a child token is handed to the rmcp transport). `audit_sink` is
/// `None` when audit logging is disabled.
pub fn build_router(
    env: Arc<dyn AgentEnvironment>,
    audit_sink: Option<Arc<dyn AuditSink>>,
    pat_repository: Arc<PatRepository>,
    cancel: CancellationToken,
) -> Router {
    let mut builder = McpServerBuilder::new(env).instructions(INSTRUCTIONS);
    if let Some(sink) = audit_sink {
        builder = builder.audit(sink);
    }
    let mcp_service = builder.build_http_service(
        StreamableHttpServerConfig::default().with_cancellation_token(cancel.child_token()),
    );

    let protected = Router::new()
        .nest_service("/mcp", mcp_service)
        .layer(middleware::from_fn_with_state(pat_repository, require_pat))
        .layer(middleware::from_fn(validate_origin));

    Router::new().route("/health", get(health)).merge(protected)
}

/// Binds `127.0.0.1:<port>` (configured override or [`DEFAULT_PORT`]),
/// falling back to a random port on conflict, and serves the router in a
/// spawned task until cancelled.
pub async fn start(
    env: Arc<dyn AgentEnvironment>,
    audit_sink: Option<Arc<dyn AuditSink>>,
    pat_repository: Arc<PatRepository>,
    configured_port: Option<u16>,
) -> Result<RunningServer, String> {
    let preferred = configured_port.unwrap_or(DEFAULT_PORT);
    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", preferred)).await {
        Ok(listener) => listener,
        Err(err) if err.kind() == io::ErrorKind::AddrInUse => {
            log::warn!(
                "MCP server port {} is in use; falling back to a random port",
                preferred
            );
            tokio::net::TcpListener::bind(("127.0.0.1", 0))
                .await
                .map_err(|e| format!("Failed to bind MCP server fallback port: {e}"))?
        }
        Err(err) => return Err(format!("Failed to bind MCP server port {preferred}: {err}")),
    };
    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to read MCP server address: {e}"))?
        .port();

    let cancel = CancellationToken::new();
    let router = build_router(env, audit_sink, pat_repository, cancel.clone());

    let serve_cancel = cancel.clone();
    let join = tokio::spawn(async move {
        if let Err(err) = axum::serve(listener, router)
            .with_graceful_shutdown(serve_cancel.cancelled_owned())
            .await
        {
            log::error!("MCP server terminated with error: {err}");
        }
    });

    log::info!("MCP server listening on 127.0.0.1:{port}");
    Ok(RunningServer {
        port,
        started_at: Utc::now(),
        cancel,
        join,
    })
}
