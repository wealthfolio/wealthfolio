use std::{ffi::OsString, net::SocketAddr, time::Duration};

use anyhow::Context;

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
        let raw_secret_key = load_secret_key(
            std::env::var_os("WF_SECRET_KEY"),
            std::env::var_os("WF_SECRET_KEY_FILE"),
        )
        .unwrap_or_else(|e| panic!("Failed to load server secret key: {e:#}"));
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

// Empty environment values are unset, allowing Compose to pass optional inputs.
// File paths are OS-native and must not be trimmed or converted lossily.
fn load_secret_key(key: Option<OsString>, key_file: Option<OsString>) -> anyhow::Result<Vec<u8>> {
    let key = key.filter(|value| !value.is_empty());
    let key_file = key_file.filter(|value| !value.is_empty());
    let (value, source) = match (key, key_file) {
        (Some(_), Some(_)) => anyhow::bail!("Set only one of WF_SECRET_KEY or WF_SECRET_KEY_FILE"),
        (None, None) => anyhow::bail!("WF_SECRET_KEY or WF_SECRET_KEY_FILE must be set"),
        (Some(value), None) => (
            value
                .into_string()
                .map_err(|_| anyhow::anyhow!("WF_SECRET_KEY must be valid UTF-8"))?,
            "WF_SECRET_KEY",
        ),
        (None, Some(path)) => (
            std::fs::read_to_string(path).context("Cannot read WF_SECRET_KEY_FILE")?,
            "WF_SECRET_KEY_FILE",
        ),
    };
    decode_secret_key(&value).with_context(|| format!("Invalid {source}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "--------------------------------";

    #[test]
    fn file_and_environment_derive_identical_keys() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("master key é.txt");
        for value in [
            KEY.to_string(),
            format!("{KEY}\n"),
            format!("{KEY}\r\n"),
            "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=".to_string(),
        ] {
            std::fs::write(&path, &value).unwrap();
            let env = load_secret_key(Some(value.into()), Some(OsString::new())).unwrap();
            let file = load_secret_key(Some(OsString::new()), Some(path.clone().into())).unwrap();
            assert_eq!(env, file);
            assert_eq!(derive_keys(&env), derive_keys(&file));
        }
    }

    #[test]
    fn startup_reads_file_key_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("startup key.txt");
        std::fs::write(&path, format!("{KEY}\r\n")).unwrap();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "config::tests::startup_worker", "--nocapture"])
            .current_dir(dir.path())
            .env_clear()
            .env("WF_KEY_INPUT_TEST", "1")
            .env("WF_LISTEN_ADDR", "127.0.0.1:8088")
            .env("WF_SECRET_KEY_FILE", &path)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(!path.exists(), "startup worker must execute");
    }

    #[test]
    fn startup_worker() {
        if std::env::var_os("WF_KEY_INPUT_TEST").is_none() {
            return;
        }
        let config = Config::from_env();
        std::fs::remove_file(std::env::var_os("WF_SECRET_KEY_FILE").unwrap()).unwrap();
        assert_eq!(config.raw_secret_key, KEY.as_bytes());
        assert_eq!(config.secrets_encryption_key, derive_keys(KEY.as_bytes()).1);
    }

    #[test]
    fn rejects_conflicting_or_missing_sources() {
        assert!(load_secret_key(None, None).is_err());
        assert!(load_secret_key(Some(OsString::new()), Some(OsString::new())).is_err());
        let error = load_secret_key(Some(KEY.into()), Some("missing-file".into())).unwrap_err();
        assert!(error.to_string().contains("Set only one"));
        assert!(!error.to_string().contains(KEY));
        assert!(load_secret_key(Some("   ".into()), None).is_err());
    }

    #[test]
    fn invalid_files_fail_without_fallback() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("key");
        assert!(load_secret_key(None, Some(path.clone().into())).is_err());
        assert!(load_secret_key(None, Some(dir.path().into())).is_err());
        for bytes in [b"".as_slice(), b"  \r\n", b"invalid-key", &[0xff]] {
            std::fs::write(&path, bytes).unwrap();
            let error = load_secret_key(None, Some(path.clone().into())).unwrap_err();
            assert!(format!("{error:#}").contains("WF_SECRET_KEY_FILE"));
            assert!(!format!("{error:#}").contains("invalid-key"));
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn supports_non_utf8_file_paths() {
        use std::os::unix::ffi::OsStringExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(OsString::from_vec(vec![0xff]));
        std::fs::write(&path, KEY).unwrap();
        assert_eq!(
            load_secret_key(None, Some(path.into())).unwrap(),
            KEY.as_bytes()
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_non_utf8_keys() {
        use std::os::unix::ffi::OsStringExt;
        assert!(load_secret_key(Some(OsString::from_vec(vec![0xff])), None).is_err());
    }
}
