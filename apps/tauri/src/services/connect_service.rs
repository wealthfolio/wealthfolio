//! Service for interacting with Wealthfolio Connect cloud API.
//!
//! This service wraps the ConnectApiClient with keyring token retrieval,
//! providing a simple interface for cloud API operations.

use std::sync::Arc;

use wealthfolio_connect::{
    ensure_valid_access_token, ConnectApiClient, TokenLifecycleConfig, TokenLifecycleState,
    DEFAULT_CLOUD_API_URL,
};
use wealthfolio_core::secrets::SecretStore;

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
pub fn cloud_api_base_url() -> Option<String> {
    if !is_cloud_sync_enabled() {
        return None;
    }

    option_env!("CONNECT_API_URL")
        .map(|v| v.trim().trim_end_matches('/').to_string())
        .filter(|v| !v.is_empty())
        .or_else(|| Some(DEFAULT_CLOUD_API_URL.to_string()))
}

fn connect_auth_url() -> Option<String> {
    option_env!("CONNECT_AUTH_URL")
        .map(|v| v.trim().trim_end_matches('/').to_string())
        .filter(|v| !v.is_empty())
}

fn connect_auth_publishable_key() -> Option<String> {
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

    pub fn is_session_configured(&self) -> Result<bool, String> {
        self.token_lifecycle
            .is_session_configured(self.secret_store.as_ref())
            .map_err(|err| err.to_string())
    }

    pub async fn store_session(&self, token: &str) -> Result<(), String> {
        self.token_lifecycle
            .store_session(self.secret_store.as_ref(), token)
            .await
            .map_err(|err| err.to_string())
    }

    pub async fn clear_session_with<F, Fut>(&self, after_clear: F) -> Result<bool, String>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = ()>,
    {
        self.token_lifecycle
            .clear_session_with(self.secret_store.as_ref(), after_clear)
            .await
            .map_err(|err| err.to_string())
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

    pub async fn has_device_sync(&self) -> Result<bool, String> {
        let token = self.get_valid_access_token().await?;
        let url = cloud_api_base_url().ok_or("Cloud sync is disabled")?;
        ConnectApiClient::new(&url, &token)
            .map_err(|err| err.to_string())?
            .has_device_sync()
            .await
            .map_err(|err| err.to_string())
    }

    pub async fn ensure_device_sync_subscription(&self) -> Result<(), String> {
        if !self.has_device_sync().await? {
            return Err("Device sync is paused: an active subscription is required.".to_string());
        }
        Ok(())
    }

    /// Check if the current user's plan includes broker sync.
    ///
    /// Returns `Ok(true)` only when the user has an active subscription
    /// on a plan that includes broker sync (i.e. not "basic").
    pub async fn has_broker_sync(&self) -> Result<bool, String> {
        let client = self.get_api_client().await?;
        client.has_broker_sync().await.map_err(|e| e.to_string())
    }
}
