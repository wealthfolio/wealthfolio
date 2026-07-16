//! Shared Personal Access Token (PAT) helpers for MCP transport auth.
//!
//! Both runtime hosts (the Axum web server and the embedded Tauri server)
//! mint and validate the same token format:
//!
//! `wfp_` + 43-char base64url (no padding) of 32 OS-random bytes. Lookup
//! uses the first 12 chars after the prefix; verification is a
//! constant-time comparison of the SHA-256 hex of the full presented
//! string against stored hashes. Raw tokens are never stored or logged.
//!
//! This module owns generation/prefix/hash plus the [`authenticate`]
//! routine that turns a presented bearer string into the authenticated
//! token's scopes + fingerprint. Hosts wrap this in their own HTTP
//! middleware (throttling `last_used_at`, injecting an auth context, etc.).

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::rngs::OsRng;
use rand::RngCore;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use wealthfolio_storage_sqlite::agent::PatRepository;

/// Bearer token prefix for personal access tokens.
pub const PAT_PREFIX: &str = "wfp_";
/// Length of the lookup prefix stored alongside the hash (chars after `wfp_`).
pub const TOKEN_PREFIX_LEN: usize = 12;

/// Generates a fresh PAT: `wfp_` + 43-char base64url of 32 OsRng bytes.
pub fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    format!("{PAT_PREFIX}{}", URL_SAFE_NO_PAD.encode(bytes))
}

/// Lookup prefix: the first 12 chars after `wfp_`. `None` when the token
/// does not look like a PAT.
pub fn token_prefix(token: &str) -> Option<&str> {
    let rest = token.strip_prefix(PAT_PREFIX)?;
    rest.get(..TOKEN_PREFIX_LEN)
}

/// SHA-256 hex of the full presented token string.
pub fn hash_token(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    format!("{digest:x}")
}

/// A presented PAT that matched a stored, unrevoked, unexpired row.
#[derive(Debug, Clone)]
pub struct AuthenticatedPat {
    /// Row id of the matched token.
    pub id: String,
    /// Canonical scope strings persisted with the token.
    pub scopes: Vec<String>,
    /// `sha256:<hex-prefix>` of the presented credential — never the raw token.
    pub fingerprint: String,
}

/// Validates a presented bearer string against the PAT store.
///
/// Returns `Some(AuthenticatedPat)` only when the token matches a stored
/// hash (constant-time) and is neither revoked nor expired. Any failure —
/// malformed prefix, lookup error, no match, revoked, expired, or
/// unparseable expiry — returns `None` (fails closed).
///
/// `last_used_at` is updated best-effort and never blocks or affects the
/// result; hosts that want throttling should handle it themselves.
pub async fn authenticate(repo: &PatRepository, presented: &str) -> Option<AuthenticatedPat> {
    let prefix = token_prefix(presented)?;
    let presented_hash = hash_token(presented);
    let candidates = repo.find_by_prefix(prefix).ok()?;

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

    // Best-effort; failures are logged, not surfaced.
    if let Err(err) = repo.touch_last_used(&matched.id).await {
        log::warn!("Failed to update PAT last_used_at: {err}");
    }

    let scopes: Vec<String> = serde_json::from_str(&matched.scopes_json).unwrap_or_default();
    Some(AuthenticatedPat {
        id: matched.id,
        scopes,
        fingerprint: format!("sha256:{}", &presented_hash[..16]),
    })
}
