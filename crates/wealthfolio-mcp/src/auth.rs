//! Authentication context contract between runtime hosts and the handler.
//!
//! Transport auth (bearer validation, Origin checks) is the HOST's job, in
//! its HTTP middleware, BEFORE a request reaches the MCP service. The
//! middleware inserts an [`McpAuthContext`] into the request extensions;
//! the handler reads it back from the `http::request::Parts` that rmcp
//! forwards with each message, and fails closed when it is missing.

use wealthfolio_agent_tools::AgentScopeSet;

/// Who is calling: which credential kind authenticated this session.
///
/// Both runtimes (desktop loopback HTTP and the web server) authenticate with
/// Personal Access Tokens, so `Pat` is currently the only kind. Kept as an
/// enum so the audit log can distinguish future credential kinds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActorKind {
    /// Personal Access Token.
    Pat,
}

impl ActorKind {
    /// Stable string used in audit rows.
    pub fn as_str(&self) -> &'static str {
        match self {
            ActorKind::Pat => "pat",
        }
    }
}

/// Authenticated caller context, produced by host middleware.
#[derive(Debug, Clone)]
pub struct McpAuthContext {
    pub actor_kind: ActorKind,
    /// `sha256:<hex-prefix>` of the credential — never the credential itself.
    pub actor_fingerprint: String,
    pub granted_scopes: AgentScopeSet,
}
