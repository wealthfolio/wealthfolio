//! HTTP middleware guarding the embedded MCP endpoint.
//!
//! Two layers, applied outside the rmcp service (origin first, then
//! bearer). On success the bearer layer injects the [`McpAuthContext`]
//! the MCP handler requires — without it the handler fails closed.

use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use wealthfolio_agent_tools::AgentScopeSet;
use wealthfolio_mcp::pat;
use wealthfolio_mcp::{ActorKind, McpAuthContext};
use wealthfolio_storage_sqlite::agent::PatRepository;

/// Authenticates `/mcp` requests against a per-client Personal Access
/// Token (`wfp_`) — granted exactly its persisted scopes. Anything else
/// is `401`. On success the matching [`McpAuthContext`] is injected for
/// the MCP handler.
pub async fn require_pat(
    State(pat_repository): State<Arc<PatRepository>>,
    mut req: Request<Body>,
    next: Next,
) -> Response {
    let provided = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));

    let Some(token) = provided else {
        return StatusCode::UNAUTHORIZED.into_response();
    };

    if let Some(authenticated) = pat::authenticate(&pat_repository, token).await {
        req.extensions_mut().insert(McpAuthContext {
            actor_kind: ActorKind::Pat,
            actor_fingerprint: authenticated.fingerprint,
            granted_scopes: AgentScopeSet::from_strs(
                authenticated.scopes.iter().map(String::as_str),
            ),
        });
        return next.run(req).await;
    }

    StatusCode::UNAUTHORIZED.into_response()
}

/// Allows requests with no `Origin` header or exactly `Origin: null`
/// (non-browser MCP clients); everything else is rejected. No configured
/// allowlist in v1.
pub async fn validate_origin(req: Request<Body>, next: Next) -> Response {
    match req.headers().get(header::ORIGIN) {
        None => next.run(req).await,
        Some(value) if value.as_bytes() == b"null" => next.run(req).await,
        Some(_) => StatusCode::FORBIDDEN.into_response(),
    }
}
