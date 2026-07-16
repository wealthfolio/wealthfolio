use std::{net::SocketAddr, time::Duration};

use crate::auth::{decode_secret_key, derive_keys, AuthConfig, CookieSecurePolicy};
use crate::oidc::OidcConfig;

pub struct Config {
    pub listen_addr: SocketAddr,
    pub db_path: String,
    pub cors_allow: Vec<String>,
    pub request_timeout: Duration,
    pub static_dir: String,
    pub addons_root: String,
    /// Raw master key (used only for secret-store migration from old raw key)
    pub raw_secret_key: Vec<u8>,
    /// HKDF-derived key for secrets encryption
    pub secrets_encryption_key: [u8; 32],
    /// Session-signing config. Present when password login OR OIDC is configured.
    pub auth: Option<AuthConfig>,
    /// OIDC SSO config. Present when `WF_OIDC_ISSUER_URL` + `WF_OIDC_CLIENT_ID` are set.
    pub oidc: Option<OidcConfig>,
    /// Expose the `/mcp` endpoint (WF_MCP_ENABLED, default false).
    pub mcp_enabled: bool,
    /// Write agent tool calls to the audit log (WF_MCP_AUDIT_ENABLED,
    /// default true).
    pub mcp_audit_enabled: bool,
    /// Allowed `Host` header values for `/mcp` (WF_MCP_ALLOWED_HOSTS,
    /// comma-separated). `None` disables Host validation: rmcp's default
    /// allowlist is loopback-only and would break any deployment behind a
    /// reverse proxy / domain. Disabling is safe here because `/mcp` is
    /// guarded by PAT bearer auth (browsers cannot attach Authorization
    /// headers cross-site, so DNS rebinding gains nothing). Deployments
    /// that want strict Host pinning set WF_MCP_ALLOWED_HOSTS explicitly.
    pub mcp_allowed_hosts: Option<Vec<String>>,
}

impl Config {
    pub fn from_env() -> Self {
        dotenvy::dotenv().ok();
        let listen_addr: SocketAddr = std::env::var("WF_LISTEN_ADDR")
            .unwrap_or_else(|_| "0.0.0.0:8088".to_string())
            .parse()
            .expect("Invalid WF_LISTEN_ADDR");
        let db_path = std::env::var("WF_DB_PATH").unwrap_or_else(|_| "./db/app.db".into());
        let cors_allow: Vec<String> = std::env::var("WF_CORS_ALLOW_ORIGINS")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "*".into())
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        let timeout_ms: u64 = std::env::var("WF_REQUEST_TIMEOUT_MS")
            .unwrap_or_else(|_| "300000".into())
            .parse()
            .unwrap_or(300000);
        let static_dir = std::env::var("WF_STATIC_DIR").unwrap_or_else(|_| "dist".into());
        let secret_key = std::env::var("WF_SECRET_KEY")
            .unwrap_or_else(|_| panic!("WF_SECRET_KEY must be set and contain a 32-byte key"))
            .trim()
            .to_string();
        if secret_key.is_empty() {
            panic!("WF_SECRET_KEY must not be empty");
        }
        let raw_secret_key = decode_secret_key(&secret_key)
            .unwrap_or_else(|e| panic!("Failed to decode WF_SECRET_KEY: {e}"));
        let (jwt_key, secrets_encryption_key) = derive_keys(&raw_secret_key);
        let addons_root = std::env::var("WF_ADDONS_DIR").unwrap_or_else(|_| {
            std::path::Path::new(&db_path)
                .parent()
                .unwrap_or_else(|| std::path::Path::new("."))
                .to_string_lossy()
                .into_owned()
        });
        let password_hash = std::env::var("WF_AUTH_PASSWORD_HASH")
            .ok()
            .map(|hash| hash.trim().to_string())
            .filter(|hash| !hash.is_empty());

        let oidc = OidcConfig::from_env();

        // The session signer is needed whenever ANY auth method is enabled.
        let auth = if password_hash.is_some() || oidc.is_some() {
            let ttl_minutes = std::env::var("WF_AUTH_TOKEN_TTL_MINUTES")
                .ok()
                .and_then(|value| value.parse::<u64>().ok())
                .filter(|value| *value > 0)
                .unwrap_or(60);
            let cookie_secure_raw =
                std::env::var("WF_COOKIE_SECURE").unwrap_or_else(|_| "auto".into());
            let cookie_secure = match cookie_secure_raw.trim().to_ascii_lowercase().as_str() {
                "auto" => CookieSecurePolicy::Auto,
                "true" | "1" | "yes" => CookieSecurePolicy::Always,
                "false" | "0" | "no" => CookieSecurePolicy::Never,
                other => panic!(
                    "Invalid WF_COOKIE_SECURE value: \"{other}\". \
                     Expected one of: auto, true, false"
                ),
            };
            Some(AuthConfig {
                password_hash,
                jwt_secret: jwt_key.to_vec(),
                access_token_ttl: Duration::from_secs(ttl_minutes.saturating_mul(60)),
                cookie_secure,
            })
        } else {
            None
        };
        let mcp_enabled = std::env::var("WF_MCP_ENABLED")
            .map(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "true" | "1" | "yes"))
            .unwrap_or(false);
        let mcp_audit_enabled = std::env::var("WF_MCP_AUDIT_ENABLED")
            .map(|v| !matches!(v.trim().to_ascii_lowercase().as_str(), "false" | "0" | "no"))
            .unwrap_or(true);
        let mcp_allowed_hosts: Option<Vec<String>> = std::env::var("WF_MCP_ALLOWED_HOSTS")
            .ok()
            .map(|s| {
                s.split(',')
                    .map(|h| h.trim().to_string())
                    .filter(|h| !h.is_empty())
                    .collect::<Vec<_>>()
            })
            .filter(|hosts| !hosts.is_empty());

        // When auth is enabled, wildcard CORS is incompatible with credentials
        if auth.is_some() && cors_allow.iter().any(|o| o == "*") {
            panic!(
                "WF_CORS_ALLOW_ORIGINS cannot be \"*\" when authentication is enabled. \
                 Set explicit origins, e.g. WF_CORS_ALLOW_ORIGINS=https://my.domain.com"
            );
        }

        // Fail-closed: refuse to start on non-loopback without auth,
        // unless explicitly opted out via WF_AUTH_REQUIRED=false.
        if auth.is_none() && !listen_addr.ip().is_loopback() {
            let auth_required = std::env::var("WF_AUTH_REQUIRED")
                .map(|v| !v.eq_ignore_ascii_case("false"))
                .unwrap_or(true);
            if auth_required {
                panic!(
                    "Refusing to start: listening on non-loopback address {listen_addr} without \
                     authentication.\n\
                     \n\
                     To fix this, do one of the following:\n\
                     \n\
                     1. Set WF_AUTH_PASSWORD_HASH to an Argon2id hash of your password.\n\
                        Generate one with: printf 'your-password' | argon2 yoursalt16chars! -id -e\n\
                        In app-loaded dotenv files, use the hash as-is.\n\
                        In Docker Compose .env/--env-file, single-quote it or double every $ sign.\n\
                        In Docker Compose YAML, double every $ sign: '$$argon2id$$v=19$$...'\n\
                     \n\
                     2. Set WF_AUTH_REQUIRED=false if a reverse proxy handles authentication."
                );
            }
        }

        // Fail-closed for MCP: the agent-access API that mints Personal
        // Access Tokens must never be reachable unauthenticated off-host.
        // There is no WF_AUTH_REQUIRED escape hatch here — server MCP has
        // no trusted reverse proxy bypass.
        if mcp_enabled && auth.is_none() && !listen_addr.ip().is_loopback() {
            panic!(
                "Refusing to start: WF_MCP_ENABLED=true while listening on non-loopback \
                 address {listen_addr} without authentication.\n\
                 \n\
                 Personal Access Tokens are created through the JWT-protected agent-access \
                 API; without authentication anyone reaching this server could mint one.\n\
                 Set WF_AUTH_PASSWORD_HASH, bind a loopback address, or set \
                 WF_MCP_ENABLED=false."
            );
        }

        Self {
            listen_addr,
            db_path,
            cors_allow,
            request_timeout: Duration::from_millis(timeout_ms),
            static_dir,
            addons_root,
            raw_secret_key,
            secrets_encryption_key,
            auth,
            oidc,
            mcp_enabled,
            mcp_audit_enabled,
            mcp_allowed_hosts,
        }
    }
}
