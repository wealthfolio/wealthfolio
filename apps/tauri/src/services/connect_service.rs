//! Service for interacting with Wealthfolio Connect cloud API.
//!
//! This service wraps the ConnectApiClient with keyring token retrieval,
//! providing a simple interface for cloud API operations.
//! Supports custom server URL for self-hosting via settings or env var.

use std::sync::{OnceLock, RwLock};

use std::sync::Arc;

use wealthfolio_connect::{
    ensure_valid_access_token, ConnectApiClient, TokenLifecycleConfig, TokenLifecycleState,
    DEFAULT_CLOUD_API_URL,
};
use wealthfolio_core::secrets::SecretStore;

/// Global cache for custom server URL set via settings UI.
/// Allows runtime override for self-hosted instances without recompilation.
static CUSTOM_SERVER_URL: OnceLock<RwLock<Option<String>>> = OnceLock::new();

fn custom_server_url_cache() -> &'static RwLock<Option<String>> {
    CUSTOM_SERVER_URL.get_or_init(|| RwLock::new(None))
}

/// Set custom server URL (called when settings are updated).
/// Pass None or empty string to clear custom URL and use default.
pub fn set_custom_server_url(url: Option<String>) {
    let normalized = url
        .map(|v| v.trim().trim_end_matches('/').to_string())
        .filter(|v| !v.is_empty());

    // Validate URL format - must be http(s):// or empty
    if let Some(ref u) = normalized {
        if !u.starts_with("http://") && !u.starts_with("https://") {
            // Invalid URL, ignore - keep previous value
            return;
        }
    }

    if let Ok(mut guard) = custom_server_url_cache().write() {
        *guard = normalized;
    }
}

/// Get currently set custom server URL, if any.
pub fn get_custom_server_url() -> Option<String> {
    custom_server_url_cache()
        .read()
        .ok()
        .and_then(|guard| guard.clone())
}

/// Returns true when broker/connect sync was compiled in.
pub fn is_connect_sync_enabled() -> bool {
    cfg!(feature = "connect-sync")
}

/// Returns true when device sync was compiled in.
pub fn is_device_sync_enabled() -> bool {
    cfg!(feature = "device-sync")
}

/// Returns true when any cloud sync feature is compiled in.
pub fn is_cloud_sync_enabled() -> bool {
    is_connect_sync_enabled() || is_device_sync_enabled()
}

/// Returns the cloud API base URL when a sync feature is enabled.
///
/// Priority order (highest first):
/// 1. Custom URL set via settings UI (for self-hosting)
/// 2. Runtime env var `CONNECT_API_URL` or `WEALTHFOLIO_SERVER_URL`
/// 3. Compile-time env var `CONNECT_API_URL` (baked via build.rs)
/// 4. Default hosted URL (https://api.wealthfolio.app)
pub fn cloud_api_base_url() -> Option<String> {
    if !is_cloud_sync_enabled() {
        return None;
    }

    // 1. Custom URL from settings UI
    if let Ok(guard) = custom_server_url_cache().read() {
        if let Some(ref custom) = *guard {
            if !custom.is_empty() {
                return Some(custom.clone());
            }
        }
    }

    // 2. Runtime environment variables (allows Docker / env override without recompile)
    if let Ok(val) = std::env::var("CONNECT_API_URL") {
        let trimmed = val.trim().trim_end_matches('/').to_string();
        if !trimmed.is_empty() {
            return Some(trimmed);
        }
    }
    if let Ok(val) = std::env::var("WEALTHFOLIO_SERVER_URL") {
        let trimmed = val.trim().trim_end_matches('/').to_string();
        if !trimmed.is_empty() {
            return Some(trimmed);
        }
    }

    // 3. Compile-time env (for backwards compatibility)
    if let Some(val) = option_env!("CONNECT_API_URL") {
        let trimmed = val.trim().trim_end_matches('/').to_string();
        if !trimmed.is_empty() {
            return Some(trimmed);
        }
    }

    // 4. Default hosted
    Some(DEFAULT_CLOUD_API_URL.to_string())
}

fn connect_auth_url() -> Option<String> {
    // Runtime env takes precedence
    if let Ok(val) = std::env::var("CONNECT_AUTH_URL") {
        let trimmed = val.trim().trim_end_matches('/').to_string();
        if !trimmed.is_empty() {
            return Some(trimmed);
        }
    }
    option_env!("CONNECT_AUTH_URL")
        .map(|v| v.trim().trim_end_matches('/').to_string())
        .filter(|v| !v.is_empty())
}

fn connect_auth_publishable_key() -> Option<String> {
    if let Ok(val) = std::env::var("CONNECT_AUTH_PUBLISHABLE_KEY") {
        let trimmed = val.trim().to_string();
        if !trimmed.is_empty() {
            return Some(trimmed);
        }
    }
    option_env!("CONNECT_AUTH_PUBLISHABLE_KEY")
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn token_lifecycle_config() -> Option<TokenLifecycleConfig> {
    let auth_url = connect_auth_url()?;
    let publishable_key = connect_auth_publishable_key()?;
    Some(TokenLifecycleConfig::new(auth_url, publishable_key))
}

/// Service for interacting with Wealthfolio Connect cloud API.
///
/// This service handles keyring token retrieval and provides
/// convenient methods for common cloud API operations.
pub struct ConnectService {
    secret_store: Arc<dyn SecretStore>,
    token_lifecycle: Arc<TokenLifecycleState>,
}

impl ConnectService {
    /// Create a new ConnectService instance.
    pub fn new(secret_store: Arc<dyn SecretStore>) -> Self {
        Self {
            secret_store,
            token_lifecycle: Arc::new(TokenLifecycleState::new()),
        }
    }

    /// Returns a valid access token, refreshing it through Supabase when needed.
    pub async fn get_valid_access_token(&self) -> Result<String, String> {
        if !is_cloud_sync_enabled() {
            return Err("Cloud sync feature is disabled in this build.".to_string());
        }

        let config = token_lifecycle_config();
        ensure_valid_access_token(
            self.secret_store.as_ref(),
            self.token_lifecycle.as_ref(),
            config.as_ref(),
        )
        .await
        .map_err(|err| err.to_string())
    }

    pub async fn clear_cached_token(&self) {
        self.token_lifecycle.clear_cache().await;
    }

    /// Get an authenticated API client using the stored access token.
    ///
    /// # Returns
    ///
    /// Returns `Ok(ConnectApiClient)` if a valid token is found and the client
    /// can be created, or `Err(String)` if no token is configured or an error occurs.
    pub async fn get_api_client(&self) -> Result<ConnectApiClient, String> {
        if !is_connect_sync_enabled() {
            return Err("Connect sync feature is disabled in this build.".to_string());
        }

        let cloud_api_base_url = cloud_api_base_url().ok_or_else(|| {
            "Cloud API base URL is unavailable. Connect API operations are disabled.".to_string()
        })?;

        let access_token = self.get_valid_access_token().await?;

        ConnectApiClient::new(&cloud_api_base_url, &access_token).map_err(|e| e.to_string())
    }

    /// Check if the current user's plan includes broker sync.
    ///
    /// Returns `Ok(true)` only when the user has an active subscription
    /// on a plan that includes broker sync (i.e. not \"basic\").
    pub async fn has_broker_sync(&self) -> Result<bool, String> {
        let client = self.get_api_client().await?;
        client.has_broker_sync().await.map_err(|e| e.to_string())
    }
}
