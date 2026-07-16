//! Personal Access Token authentication for the `/mcp` endpoint.
//!
//! Token format: `wfp_` + 43-char base64url (no padding) of 32 OS-random
//! bytes. Lookup uses the first 12 chars after the prefix; verification is
//! a constant-time comparison of the SHA-256 hex of the full presented
//! string against stored hashes. Raw tokens are never stored or logged.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use subtle::ConstantTimeEq;
use wealthfolio_agent_tools::AgentScopeSet;
use wealthfolio_mcp::{ActorKind, McpAuthContext};
use wealthfolio_storage_sqlite::agent::PatRepository;

// Token format primitives are shared with the embedded Tauri server. Re-export
// so existing imports (`crate::mcp::auth::{generate_token, hash_token,
// token_prefix}`) keep working.
pub use wealthfolio_mcp::pat::{generate_token, hash_token, token_prefix};

/// Minimum interval between `last_used_at` writes per token.
const TOUCH_INTERVAL: Duration = Duration::from_secs(60);

/// Shared middleware state: repository handle plus a per-token throttle
/// for `last_used_at` writes.
#[derive(Clone)]
pub struct PatAuthState(Arc<Inner>);

struct Inner {
    repo: Arc<PatRepository>,
    last_touch: Mutex<HashMap<String, Instant>>,
}

impl PatAuthState {
    pub fn new(repo: Arc<PatRepository>) -> Self {
        Self(Arc::new(Inner {
            repo,
            last_touch: Mutex::new(HashMap::new()),
        }))
    }
}

/// Rejects requests without a valid, unrevoked, unexpired PAT. On success
/// injects the [`McpAuthContext`] the MCP handler requires.
pub async fn require_pat(
    State(auth): State<PatAuthState>,
    mut req: Request<Body>,
    next: Next,
) -> Response {
    let presented = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));

    let Some(presented) = presented else {
        return unauthorized();
    };
    let Some(context) = authenticate(&auth.0, presented) else {
        return unauthorized();
    };

    req.extensions_mut().insert(context);
    next.run(req).await
}

/// Validates the presented token and returns the auth context to inject.
fn authenticate(inner: &Inner, presented: &str) -> Option<McpAuthContext> {
    let prefix = token_prefix(presented)?;
    let presented_hash = hash_token(presented);
    let candidates = inner.repo.find_by_prefix(prefix).ok()?;

    let now = chrono::Utc::now();
    let matched = candidates.into_iter().find(|candidate| {
        let stored = candidate.token_hash.as_bytes();
        let received = presented_hash.as_bytes();
        received.len() == stored.len() && bool::from(received.ct_eq(stored))
    })?;

    if matched.revoked_at.is_some() {
        return None;
    }
    if let Some(expires_at) = &matched.expires_at {
        // Unparseable expiry fails closed.
        let expiry = chrono::DateTime::parse_from_rfc3339(expires_at).ok()?;
        if expiry < now {
            return None;
        }
    }

    touch_last_used(inner, &matched.id);

    let scopes: Vec<String> = serde_json::from_str(&matched.scopes_json).unwrap_or_default();
    Some(McpAuthContext {
        actor_kind: ActorKind::Pat,
        actor_fingerprint: format!("sha256:{}", &presented_hash[..16]),
        granted_scopes: AgentScopeSet::from_strs(scopes.iter().map(String::as_str)),
    })
}

/// Updates `last_used_at` at most once per [`TOUCH_INTERVAL`] per token,
/// off the request path.
fn touch_last_used(inner: &Inner, token_id: &str) {
    let should_touch = {
        let mut map = inner.last_touch.lock().unwrap();
        match map.get(token_id) {
            Some(last) if last.elapsed() < TOUCH_INTERVAL => false,
            _ => {
                map.insert(token_id.to_string(), Instant::now());
                true
            }
        }
    };
    if should_touch {
        let repo = inner.repo.clone();
        let token_id = token_id.to_string();
        tokio::spawn(async move {
            if let Err(err) = repo.touch_last_used(&token_id).await {
                tracing::warn!("Failed to update PAT last_used_at: {err}");
            }
        });
    }
}

/// 401 with a JSON-RPC-shaped body so MCP clients surface a useful error.
fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        [(header::CONTENT_TYPE, "application/json")],
        r#"{"jsonrpc":"2.0","error":{"code":-32000,"message":"Unauthorized: a valid personal access token is required"},"id":null}"#,
    )
        .into_response()
}
