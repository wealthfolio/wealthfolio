use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose, Engine as _};
use serde::Deserialize;
use tokio::sync::{Mutex, RwLock};
use wealthfolio_core::secrets::{SecretStore, LEGACY_SYNC_DEVICE_ID_KEY, SYNC_IDENTITY_KEY};

use crate::request_metadata::{
    log_failed_cloud_request, request_metadata_suffix, server_request_id, CloudRequestContext,
    CLIENT_REQUEST_ID_HEADER,
};

pub use wealthfolio_core::secrets::{CLOUD_ACCESS_TOKEN_KEY, CLOUD_REFRESH_TOKEN_KEY};

const DEFAULT_EXPIRY_BUFFER_SECS: u64 = 60;
const DEFAULT_REFRESH_TIMEOUT_SECS: u64 = 10;

#[derive(Debug, Clone)]
pub struct TokenLifecycleConfig {
    pub auth_url: String,
    pub publishable_key: String,
    pub expiry_buffer_secs: u64,
    pub refresh_timeout_secs: u64,
}

impl TokenLifecycleConfig {
    pub fn new(auth_url: String, publishable_key: String) -> Self {
        Self {
            auth_url: auth_url.trim().trim_end_matches('/').to_string(),
            publishable_key: publishable_key.trim().to_string(),
            expiry_buffer_secs: DEFAULT_EXPIRY_BUFFER_SECS,
            refresh_timeout_secs: DEFAULT_REFRESH_TIMEOUT_SECS,
        }
    }

    pub fn is_configured(&self) -> bool {
        !self.auth_url.is_empty() && !self.publishable_key.is_empty()
    }
}

/// A restored database must enroll against a new sync baseline. Keep saved
/// Connect and provider credentials; the database reconnect gate blocks cloud
/// access until explicit login. Verify deletion before reopening that gate.
pub fn clear_restored_sync_identity(store: &dyn SecretStore) -> Result<(), String> {
    // Keep installation identifiers, never key material from the old baseline.
    // Account rebind uses clear_connect_binding_credentials and retains nothing.
    let retained = store
        .get_secret(SYNC_IDENTITY_KEY)
        .map_err(|e| e.to_string())?
        .and_then(|value| serde_json::from_str::<serde_json::Value>(&value).ok())
        .and_then(|identity| {
            let nonce = identity.get("deviceNonce")?.as_str()?;
            let device = identity.get("deviceId")?.as_str()?;
            uuid::Uuid::parse_str(nonce).ok()?;
            uuid::Uuid::parse_str(device).ok()?;
            Some(serde_json::json!({"version": 2, "deviceNonce": nonce, "deviceId": device}))
        });
    clear_credentials(
        store,
        &[
            SYNC_IDENTITY_KEY,
            LEGACY_SYNC_DEVICE_ID_KEY,
            wealthfolio_core::secrets::CLOUD_BACKUP_CONSENT_KEY,
        ],
    )?;
    if let Some(identity) = retained {
        let value = identity.to_string();
        store
            .set_secret(SYNC_IDENTITY_KEY, &value)
            .map_err(|e| e.to_string())?;
        if store
            .get_secret(SYNC_IDENTITY_KEY)
            .map_err(|e| e.to_string())?
            .as_deref()
            != Some(&value)
        {
            return Err("Restored installation identity could not be saved".into());
        }
    }
    Ok(())
}

/// An explicitly confirmed account change also removes the old login.
fn clear_connect_binding_credentials(store: &dyn SecretStore) -> Result<(), String> {
    clear_credentials(
        store,
        &[
            CLOUD_ACCESS_TOKEN_KEY,
            CLOUD_REFRESH_TOKEN_KEY,
            SYNC_IDENTITY_KEY,
            LEGACY_SYNC_DEVICE_ID_KEY,
            wealthfolio_core::secrets::CLOUD_BACKUP_CONSENT_KEY,
        ],
    )
}

fn clear_credentials(store: &dyn SecretStore, keys: &[&str]) -> Result<(), String> {
    for key in keys {
        if store.get_secret(key).map_err(|e| e.to_string())?.is_some() {
            store.delete_secret(key).map_err(|e| e.to_string())?;
        }
        if store.get_secret(key).map_err(|e| e.to_string())?.is_some() {
            return Err(
                "Previous cloud credentials could not be cleared. Reconnect remains required."
                    .into(),
            );
        }
    }
    Ok(())
}

struct PendingProfileLogin {
    supplied_token: String,
    refreshed_token: String,
    created: Instant,
}

impl std::fmt::Debug for PendingProfileLogin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PendingProfileLogin([redacted])")
    }
}

/// Profile-owned services used to validate and commit a Connect login.
#[derive(Clone, Copy)]
pub struct ProfileLoginContext<'a> {
    pub store: &'a dyn SecretStore,
    pub settings: &'a dyn wealthfolio_core::settings::SettingsServiceTrait,
    pub registry: &'a wealthfolio_core::profiles::ProfileRegistry,
    pub profile_id: uuid::Uuid,
}

#[derive(Debug)]
pub struct TokenLifecycleState {
    cache: RwLock<Option<CachedAccessToken>>,
    refresh_lock: Mutex<()>,
    terminated: AtomicBool,
    pending_login: std::sync::Mutex<Option<PendingProfileLogin>>,
}

impl TokenLifecycleState {
    pub fn new() -> Self {
        Self {
            cache: RwLock::new(None),
            refresh_lock: Mutex::new(()),
            terminated: AtomicBool::new(false),
            pending_login: std::sync::Mutex::new(None),
        }
    }

    pub fn is_session_configured(
        &self,
        store: &dyn SecretStore,
    ) -> Result<bool, TokenLifecycleError> {
        if self.terminated.load(Ordering::SeqCst) {
            return Ok(false);
        }
        store
            .get_secret(CLOUD_REFRESH_TOKEN_KEY)
            .map(|token| token.is_some_and(|token| !token.trim().is_empty()))
            .map_err(|err| TokenLifecycleError::Internal(err.to_string()))
    }

    /// Explicit login and logout share the refresh lock, preventing token resurrection.
    pub async fn store_session(
        &self,
        store: &dyn SecretStore,
        token: &str,
    ) -> Result<(), TokenLifecycleError> {
        let _guard = self.refresh_lock.lock().await;
        self.store_session_locked(store, token).await
    }

    /// Reconnect is one transition with login/logout/refresh, including clearing
    /// the database gate. A competing login cannot delete the new identity.
    pub async fn store_session_after_restore(
        &self,
        store: &dyn SecretStore,
        settings: &dyn wealthfolio_core::settings::SettingsServiceTrait,
        token: &str,
    ) -> Result<(), TokenLifecycleError> {
        let _guard = self.refresh_lock.lock().await;
        let reconnect = settings
            .requires_cloud_reconnect()
            .map_err(|e| TokenLifecycleError::Internal(e.to_string()))?;
        if reconnect {
            clear_restored_sync_identity(store).map_err(TokenLifecycleError::Internal)?;
        }
        self.store_session_locked(store, token).await?;
        if reconnect {
            settings
                .set_setting_value("restore_reconnect_required", "false")
                .await
                .map_err(|e| TokenLifecycleError::Internal(e.to_string()))?;
        }
        Ok(())
    }

    /// Validate and commit an explicit login under the same lock as logout and
    /// refresh. A confirmation challenge changes only short-lived process memory.
    pub async fn store_profile_session<F, Fut>(
        &self,
        context: ProfileLoginContext<'_>,
        supplied_token: &str,
        confirm_rebind: bool,
        config: &TokenLifecycleConfig,
        api_url: &str,
        cleanup: F,
    ) -> Result<(), String>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<(), String>>,
    {
        let _guard = self.refresh_lock.lock().await;
        let candidate_token = self
            .pending_login
            .lock()
            .map_err(|_| "Connect login unavailable")?
            .as_ref()
            .filter(|pending| {
                pending.supplied_token == supplied_token
                    && pending.created.elapsed() < Duration::from_secs(600)
            })
            .map(|pending| pending.refreshed_token.clone())
            .unwrap_or_else(|| supplied_token.to_owned());
        let candidate = refresh_access_token(&candidate_token, config)
            .await
            .map_err(|e| e.message)?;
        let token = candidate.refresh_token.unwrap_or(candidate_token);
        // Rotation has already happened remotely. Retain the candidate before
        // identity lookup or registry checks can fail, without admitting it.
        *self
            .pending_login
            .lock()
            .map_err(|_| "Connect login unavailable")? = Some(PendingProfileLogin {
            supplied_token: supplied_token.into(),
            refreshed_token: token.clone(),
            created: Instant::now(),
        });
        let binding = verified_profile_binding(&candidate.access_token, config, api_url).await?;
        self.commit_profile_login(
            context,
            supplied_token,
            token,
            binding,
            confirm_rebind,
            cleanup,
        )
        .await
    }

    // Caller holds refresh_lock; identity must have been verified by the cloud API.
    async fn commit_profile_login<F, Fut>(
        &self,
        context: ProfileLoginContext<'_>,
        supplied_token: &str,
        token: String,
        binding: wealthfolio_core::profiles::ConnectBinding,
        confirm_rebind: bool,
        cleanup: F,
    ) -> Result<(), String>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<(), String>>,
    {
        let ProfileLoginContext {
            store,
            settings,
            registry,
            profile_id,
        } = context;
        let changed = registry
            .connect_rebind_required(profile_id, &binding)
            .map_err(|e| e.to_string())?;
        let profile = registry.profile(profile_id).map_err(|e| e.to_string())?;
        // The adopted legacy database predates account bindings. Its first
        // verified login establishes ownership without resetting existing links
        // or enrollment. Restored databases still require the reconnect cleanup.
        let unverified_existing_state = profile.connect.is_none()
            && (profile.legacy_database.is_none()
                || settings
                    .requires_cloud_reconnect()
                    .map_err(|e| e.to_string())?)
            && [
                SYNC_IDENTITY_KEY,
                CLOUD_REFRESH_TOKEN_KEY,
                CLOUD_ACCESS_TOKEN_KEY,
                LEGACY_SYNC_DEVICE_ID_KEY,
                wealthfolio_core::secrets::CLOUD_BACKUP_CONSENT_KEY,
            ]
            .iter()
            .try_fold(false, |found, key| {
                store
                    .get_secret(key)
                    .map(|value| found || value.is_some())
                    .map_err(|e| e.to_string())
            })?;
        let changed = changed || unverified_existing_state;
        // Preserve refresh rotation across a human confirmation delay or a failed cleanup.
        *self
            .pending_login
            .lock()
            .map_err(|_| "Connect login unavailable")? = Some(PendingProfileLogin {
            supplied_token: supplied_token.into(),
            refreshed_token: token.clone(),
            created: Instant::now(),
        });
        if changed && !confirm_rebind {
            return Err(
                "CONNECT_REBIND_REQUIRED: Confirm changing this profile's Connect account or team."
                    .into(),
            );
        }
        if changed {
            // Fail closed if cleanup is interrupted. Portfolio and encryption data
            // are retained; no old session may resume over partially reset state.
            settings
                .set_setting_value("restore_reconnect_required", "true")
                .await
                .map_err(|e| e.to_string())?;
            self.clear_session_locked(store)
                .await
                .map_err(|e| e.to_string())?;
            cleanup().await?;
            clear_connect_binding_credentials(store)?;
            registry
                .replace_connect(profile_id, binding)
                .map_err(|e| e.to_string())?;
        } else {
            registry
                .bind_connect(profile_id, binding)
                .map_err(|e| e.to_string())?;
            if settings
                .requires_cloud_reconnect()
                .map_err(|e| e.to_string())?
            {
                clear_restored_sync_identity(store)?;
            }
        }
        self.store_session_locked(store, &token)
            .await
            .map_err(|e| e.to_string())?;
        settings
            .set_setting_value("restore_reconnect_required", "false")
            .await
            .map_err(|e| e.to_string())?;
        *self
            .pending_login
            .lock()
            .map_err(|_| "Connect login unavailable")? = None;
        Ok(())
    }

    async fn store_session_locked(
        &self,
        store: &dyn SecretStore,
        token: &str,
    ) -> Result<(), TokenLifecycleError> {
        store
            .set_secret(CLOUD_REFRESH_TOKEN_KEY, token)
            .map_err(|err| TokenLifecycleError::Internal(err.to_string()))?;
        self.terminated.store(false, Ordering::SeqCst);
        self.clear_cache().await;
        let _ = store.delete_secret(CLOUD_ACCESS_TOKEN_KEY);
        Ok(())
    }

    /// Explicit logout removes persistent credentials and stops future refreshes.
    pub async fn clear_session(
        &self,
        store: &dyn SecretStore,
    ) -> Result<bool, TokenLifecycleError> {
        self.clear_session_with(store, || async {}).await
    }

    /// Keep worker shutdown in the same transition as credential cleanup so a
    /// replacement login cannot start a worker that the old logout then aborts.
    pub async fn clear_session_with<F, Fut>(
        &self,
        store: &dyn SecretStore,
        after_clear: F,
    ) -> Result<bool, TokenLifecycleError>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = ()>,
    {
        let _guard = self.refresh_lock.lock().await;
        *self
            .pending_login
            .lock()
            .map_err(|_| TokenLifecycleError::Internal("Connect login unavailable".into()))? = None;
        let result = self.clear_session_locked(store).await;
        after_clear().await;
        result.map(|_| true)
    }

    async fn clear_session_locked(
        &self,
        store: &dyn SecretStore,
    ) -> Result<(), TokenLifecycleError> {
        self.terminated.store(true, Ordering::SeqCst);
        self.clear_cache().await;
        let _ = store.delete_secret(CLOUD_ACCESS_TOKEN_KEY);
        store
            .delete_secret(CLOUD_REFRESH_TOKEN_KEY)
            .map_err(|err| TokenLifecycleError::Internal(err.to_string()))
    }

    pub async fn clear_cache(&self) {
        let mut cache = self.cache.write().await;
        *cache = None;
    }
}

impl Default for TokenLifecycleState {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum TokenLifecycleError {
    #[error("{0}")]
    Unauthorized(String),
    #[error("{0}")]
    NotConfigured(String),
    #[error("{0}")]
    RefreshFailed(String),
    #[error("{0}")]
    Internal(String),
}

#[derive(Debug, Clone)]
struct CachedAccessToken {
    token: String,
    expires_at: Instant,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
struct RefreshTokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct RefreshErrorResponse {
    error: Option<String>,
    error_description: Option<String>,
}

#[derive(Debug, Deserialize)]
struct JwtClaims {
    exp: Option<i64>,
}

pub async fn ensure_valid_access_token(
    secret_store: &dyn SecretStore,
    state: &TokenLifecycleState,
    config: Option<&TokenLifecycleConfig>,
) -> Result<String, TokenLifecycleError> {
    let _refresh_guard = state.refresh_lock.lock().await;
    if state.terminated.load(Ordering::SeqCst) {
        return Err(TokenLifecycleError::Unauthorized(
            "Cloud session has ended. Please sign in again.".to_string(),
        ));
    }

    if let Some(token) = read_cached_token(state).await {
        return Ok(token);
    }

    let Some(config) = config else {
        return Err(TokenLifecycleError::NotConfigured(
            "Auth refresh configuration is missing".to_string(),
        ));
    };
    if !config.is_configured() {
        return Err(TokenLifecycleError::NotConfigured(
            "CONNECT_AUTH_URL or CONNECT_AUTH_PUBLISHABLE_KEY is not configured".to_string(),
        ));
    }

    let refresh_token = secret_store
        .get_secret(CLOUD_REFRESH_TOKEN_KEY)
        .map_err(|e| TokenLifecycleError::Internal(format!("Failed to read refresh token: {}", e)))?
        .ok_or_else(|| {
            TokenLifecycleError::Unauthorized(
                "No refresh token configured. Please sign in first.".to_string(),
            )
        })?;

    let response = refresh_access_token(&refresh_token, config).await;
    match response {
        Ok(response) => {
            let rotated_refresh = response
                .refresh_token
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or(&refresh_token);
            secret_store
                .set_secret(CLOUD_REFRESH_TOKEN_KEY, rotated_refresh)
                .map_err(|e| {
                    TokenLifecycleError::Internal(format!("Failed to store refresh token: {}", e))
                })?;
            // Best-effort cleanup for legacy versions that persisted access tokens at rest.
            let _ = secret_store.delete_secret(CLOUD_ACCESS_TOKEN_KEY);

            let expires_at = compute_expires_at(
                &response.access_token,
                response.expires_in,
                config.expiry_buffer_secs,
            );
            write_cache(state, response.access_token.clone(), expires_at).await;

            Ok(response.access_token)
        }
        Err(err) => {
            if err.is_session_invalid() {
                state.clear_session_locked(secret_store).await?;
                return Err(TokenLifecycleError::Unauthorized(format!(
                    "Session expired. Please sign in again. ({})",
                    err.message
                )));
            }
            Err(TokenLifecycleError::RefreshFailed(err.message))
        }
    }
}

pub fn is_access_token_fresh(token: &str, now: SystemTime, expiry_buffer_secs: u64) -> bool {
    let Some(exp) = parse_jwt_exp(token) else {
        return false;
    };

    let Ok(now_secs) = now.duration_since(UNIX_EPOCH).map(|value| value.as_secs()) else {
        return false;
    };

    exp > now_secs as i64 + expiry_buffer_secs as i64
}

async fn read_cached_token(state: &TokenLifecycleState) -> Option<String> {
    let cache = state.cache.read().await;
    cache
        .as_ref()
        .filter(|value| value.expires_at > Instant::now())
        // Also verify wall-clock expiry: Instant doesn't advance during
        // device sleep (iOS/macOS), so the monotonic check alone can return
        // a JWT whose real `exp` has already passed.
        .filter(|value| {
            is_access_token_fresh(&value.token, SystemTime::now(), DEFAULT_EXPIRY_BUFFER_SECS)
        })
        .map(|value| value.token.clone())
}

async fn write_cache(state: &TokenLifecycleState, token: String, expires_at: Instant) {
    let mut cache = state.cache.write().await;
    *cache = Some(CachedAccessToken { token, expires_at });
}

fn compute_expires_at(token: &str, expires_in: Option<i64>, buffer_secs: u64) -> Instant {
    if let Some(ttl_secs) = expires_in.filter(|value| *value > 0) {
        let adjusted = (ttl_secs as u64).saturating_sub(buffer_secs).max(1);
        return Instant::now() + Duration::from_secs(adjusted);
    }

    compute_expires_at_from_jwt(token, buffer_secs).unwrap_or_else(Instant::now)
}

fn compute_expires_at_from_jwt(token: &str, buffer_secs: u64) -> Option<Instant> {
    let exp = parse_jwt_exp(token)?;
    let now_secs = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs() as i64;
    let adjusted = exp - now_secs - buffer_secs as i64;
    if adjusted <= 0 {
        return Some(Instant::now());
    }
    Some(Instant::now() + Duration::from_secs(adjusted as u64))
}

fn parse_jwt_exp(token: &str) -> Option<i64> {
    let mut parts = token.split('.');
    let _header = parts.next()?;
    let payload = parts.next()?;
    let _sig = parts.next()?;

    let decoded = general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .or_else(|_| general_purpose::URL_SAFE.decode(payload))
        .ok()?;

    let claims = serde_json::from_slice::<JwtClaims>(&decoded).ok()?;
    claims.exp
}

async fn refresh_access_token(
    refresh_token: &str,
    config: &TokenLifecycleConfig,
) -> Result<RefreshTokenResponse, RefreshRequestError> {
    let client = wealthfolio_http::client_builder()
        .timeout(Duration::from_secs(config.refresh_timeout_secs))
        .build()
        .map_err(|e| {
            RefreshRequestError::new(false, format!("Failed to create HTTP client: {}", e))
        })?;

    let token_url = format!("{}/auth/v1/token?grant_type=refresh_token", config.auth_url);
    let context = CloudRequestContext::new("POST", "/auth/v1/token?grant_type=refresh_token", None);
    let response = client
        .post(&token_url)
        .header("apikey", &config.publishable_key)
        .header("Content-Type", "application/json")
        .header(CLIENT_REQUEST_ID_HEADER, context.client_request_id.as_str())
        .json(&serde_json::json!({ "refresh_token": refresh_token }))
        .send()
        .await
        .map_err(|e| {
            log_failed_cloud_request("ConnectAuth", &context, None, None);
            RefreshRequestError::new(
                false,
                format!(
                    "Failed to refresh token: {} ({})",
                    e,
                    request_metadata_suffix(&context, None)
                ),
            )
        })?;

    let status = response.status();
    let request_id = server_request_id(response.headers());
    let body = response.text().await.map_err(|e| {
        log_failed_cloud_request("ConnectAuth", &context, Some(status), request_id.as_deref());
        RefreshRequestError::new(
            false,
            format!(
                "Failed to read response: {} ({})",
                e,
                request_metadata_suffix(&context, request_id.as_deref())
            ),
        )
    })?;

    if !status.is_success() {
        log_failed_cloud_request("ConnectAuth", &context, Some(status), request_id.as_deref());
        let parsed = serde_json::from_str::<RefreshErrorResponse>(&body).ok();
        let error_code = parsed
            .as_ref()
            .and_then(|value| value.error.clone())
            .unwrap_or_default();
        let error_message = parsed
            .as_ref()
            .and_then(|value| value.error_description.clone().or(value.error.clone()))
            .unwrap_or_else(|| fallback_refresh_error_message(status.as_u16(), &body));
        let invalid = is_session_invalid(status.as_u16(), &error_code, &error_message);
        return Err(RefreshRequestError::new(
            invalid,
            format!(
                "{} ({})",
                error_message,
                request_metadata_suffix(&context, request_id.as_deref())
            ),
        ));
    }

    serde_json::from_str::<RefreshTokenResponse>(&body).map_err(|e| {
        log_failed_cloud_request("ConnectAuth", &context, Some(status), request_id.as_deref());
        RefreshRequestError::new(
            false,
            format!(
                "Failed to parse token response: {} ({})",
                e,
                request_metadata_suffix(&context, request_id.as_deref())
            ),
        )
    })
}

fn fallback_refresh_error_message(status: u16, body: &str) -> String {
    let body = body.trim();
    if body.is_empty() {
        format!("HTTP {}", status)
    } else {
        body.to_string()
    }
}

fn is_session_invalid(status: u16, error_code: &str, message: &str) -> bool {
    if status == 401 || status == 403 {
        return true;
    }

    let code = error_code.to_ascii_lowercase();
    if code == "invalid_grant" || code == "refresh_token_not_found" {
        return true;
    }

    let lower = message.to_ascii_lowercase();
    lower.contains("invalid refresh token")
        || lower.contains("refresh token not found")
        || lower.contains("token has expired")
        || lower.contains("invalid grant")
}

#[derive(Debug)]
struct RefreshRequestError {
    session_invalid: bool,
    message: String,
}

impl RefreshRequestError {
    fn new(session_invalid: bool, message: String) -> Self {
        Self {
            session_invalid,
            message,
        }
    }

    fn is_session_invalid(&self) -> bool {
        self.session_invalid
    }
}

/// Verify the server-reported user/team with the configured issuer. No JWT
/// payload or caller-supplied email is accepted as an identity assertion.
pub async fn verified_profile_binding(
    access_token: &str,
    config: &TokenLifecycleConfig,
    api_url: &str,
) -> Result<wealthfolio_core::profiles::ConnectBinding, String> {
    let user = crate::ConnectApiClient::new(api_url, access_token)
        .map_err(|e| e.to_string())?
        .get_user_info()
        .await
        .map_err(|e| e.to_string())?;
    Ok(wealthfolio_core::profiles::ConnectBinding {
        issuer: config.auth_url.clone(),
        user_id: user.id,
        team_id: user.team.map(|t| t.id),
    })
}

/// Verify mutable cloud membership before admitting automatic cloud work.
/// Access-token equality does not establish team identity. A legacy profile's
/// existing session may establish its initial binding; replacing a binding
/// requires explicit login and confirmation/cleanup.
/// This preflight cannot make a subsequent cloud request atomic with membership
/// changes; that requires an expected-scope check in the cloud API contract.
pub async fn admit_profile_binding(
    access_token: &str,
    config: &TokenLifecycleConfig,
    api_url: &str,
    registry: &wealthfolio_core::profiles::ProfileRegistry,
    profile_id: uuid::Uuid,
) -> Result<(), String> {
    let binding = verified_profile_binding(access_token, config, api_url).await?;
    let profile = registry.profile(profile_id).map_err(|e| e.to_string())?;
    if profile.connect.is_none() && profile.legacy_database.is_some() {
        // The server has verified the inherited session. Bind atomically so
        // duplicate-account reservations and concurrent bindings stay enforced.
        return registry
            .bind_connect(profile_id, binding)
            .map_err(|e| e.to_string());
    }
    // Also enforce the installation's one-profile-per-account reservation.
    if profile.connect.is_none()
        || registry
            .connect_rebind_required(profile_id, &binding)
            .map_err(|e| e.to_string())?
    {
        return Err("CONNECT_REBIND_REQUIRED: Reconnect Wealthfolio Connect and confirm this profile's account or household before syncing.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use std::sync::Arc;
    use wealthfolio_core::profiles::{DATABASE_KEY_SECRET, PROFILE_LOCK_KEY};

    #[test]
    fn restore_resets_identity_without_touching_saved_credentials() {
        let store = MemorySecrets::default();
        let preserved = [
            CLOUD_ACCESS_TOKEN_KEY,
            CLOUD_REFRESH_TOKEN_KEY,
            DATABASE_KEY_SECRET,
            "YAHOO",
            "addon.test.key",
            "cloud_backup_master_v1:synthetic-user",
            "cloud_backup_source_v1:synthetic-user",
        ];
        for key in preserved.into_iter().chain([
            SYNC_IDENTITY_KEY,
            LEGACY_SYNC_DEVICE_ID_KEY,
            wealthfolio_core::secrets::CLOUD_BACKUP_CONSENT_KEY,
        ]) {
            store.set_secret(key, "synthetic secret").unwrap();
        }
        clear_restored_sync_identity(&store).unwrap();
        for key in [
            SYNC_IDENTITY_KEY,
            LEGACY_SYNC_DEVICE_ID_KEY,
            wealthfolio_core::secrets::CLOUD_BACKUP_CONSENT_KEY,
        ] {
            assert!(store.get_secret(key).unwrap().is_none());
        }
        for key in preserved {
            assert_eq!(
                store.get_secret(key).unwrap().as_deref(),
                Some("synthetic secret")
            );
        }
        clear_restored_sync_identity(&store).unwrap();
        clear_connect_binding_credentials(&store).unwrap();
        for key in [CLOUD_ACCESS_TOKEN_KEY, CLOUD_REFRESH_TOKEN_KEY] {
            assert!(store.get_secret(key).unwrap().is_none());
        }
        assert!(store.get_secret(DATABASE_KEY_SECRET).unwrap().is_some());
    }

    #[test]
    fn restore_retains_only_installation_ids_and_rebind_removes_them() {
        let store = MemorySecrets::default();
        let nonce = uuid::Uuid::new_v4().to_string();
        let device = uuid::Uuid::new_v4().to_string();
        store
            .set_secret(
                SYNC_IDENTITY_KEY,
                &serde_json::json!({
                    "deviceNonce": nonce, "deviceId": device, "rootKey": "old-key",
                    "keyVersion": 5, "deviceSecretKey": "private", "devicePublicKey": "public"
                })
                .to_string(),
            )
            .unwrap();
        for _ in 0..2 {
            clear_restored_sync_identity(&store).unwrap();
            let identity: serde_json::Value =
                serde_json::from_str(&store.get_secret(SYNC_IDENTITY_KEY).unwrap().unwrap())
                    .unwrap();
            assert_eq!(
                identity,
                serde_json::json!({"version": 2, "deviceNonce": nonce, "deviceId": device})
            );
        }
        clear_connect_binding_credentials(&store).unwrap();
        assert!(store.get_secret(SYNC_IDENTITY_KEY).unwrap().is_none());
    }

    #[test]
    fn restored_identity_rejects_a_store_that_does_not_delete() {
        struct BrokenStore(&'static str);
        impl SecretStore for BrokenStore {
            fn get_secret(&self, key: &str) -> wealthfolio_core::errors::Result<Option<String>> {
                Ok((key == self.0).then(|| "still present".into()))
            }
            fn set_secret(&self, _: &str, _: &str) -> wealthfolio_core::errors::Result<()> {
                Ok(())
            }
            fn delete_secret(&self, _: &str) -> wealthfolio_core::errors::Result<()> {
                Ok(())
            }
        }
        for key in [
            SYNC_IDENTITY_KEY,
            LEGACY_SYNC_DEVICE_ID_KEY,
            wealthfolio_core::secrets::CLOUD_BACKUP_CONSENT_KEY,
        ] {
            assert!(clear_restored_sync_identity(&BrokenStore(key)).is_err());
        }
    }

    struct ReconnectSettings {
        required: AtomicBool,
        clearing: tokio::sync::Notify,
        release: tokio::sync::Notify,
    }

    #[async_trait::async_trait]
    impl wealthfolio_core::settings::SettingsServiceTrait for ReconnectSettings {
        fn get_setting_value(&self, _: &str) -> wealthfolio_core::errors::Result<Option<String>> {
            Ok(Some(self.required.load(Ordering::SeqCst).to_string()))
        }
        async fn set_setting_value(
            &self,
            _: &str,
            _: &str,
        ) -> wealthfolio_core::errors::Result<()> {
            self.clearing.notify_one();
            self.release.notified().await;
            self.required.store(false, Ordering::SeqCst);
            Ok(())
        }
        fn get_settings(
            &self,
        ) -> wealthfolio_core::errors::Result<wealthfolio_core::settings::Settings> {
            unreachable!()
        }
        async fn update_settings(
            &self,
            _: &wealthfolio_core::settings::SettingsUpdate,
        ) -> wealthfolio_core::errors::Result<()> {
            unreachable!()
        }
        fn get_base_currency(&self) -> wealthfolio_core::errors::Result<Option<String>> {
            unreachable!()
        }
        async fn update_base_currency(&self, _: &str) -> wealthfolio_core::errors::Result<()> {
            unreachable!()
        }
        fn is_auto_update_check_enabled(&self) -> wealthfolio_core::errors::Result<bool> {
            unreachable!()
        }
        fn is_sync_enabled(&self) -> wealthfolio_core::errors::Result<bool> {
            unreachable!()
        }
    }

    struct BindingSettings {
        required: AtomicBool,
    }
    #[async_trait::async_trait]
    impl wealthfolio_core::settings::SettingsServiceTrait for BindingSettings {
        fn get_setting_value(&self, _: &str) -> wealthfolio_core::errors::Result<Option<String>> {
            Ok(Some(self.required.load(Ordering::SeqCst).to_string()))
        }
        async fn set_setting_value(
            &self,
            _: &str,
            value: &str,
        ) -> wealthfolio_core::errors::Result<()> {
            self.required.store(value == "true", Ordering::SeqCst);
            Ok(())
        }
        fn get_settings(
            &self,
        ) -> wealthfolio_core::errors::Result<wealthfolio_core::settings::Settings> {
            unreachable!()
        }
        async fn update_settings(
            &self,
            _: &wealthfolio_core::settings::SettingsUpdate,
        ) -> wealthfolio_core::errors::Result<()> {
            unreachable!()
        }
        fn get_base_currency(&self) -> wealthfolio_core::errors::Result<Option<String>> {
            unreachable!()
        }
        async fn update_base_currency(&self, _: &str) -> wealthfolio_core::errors::Result<()> {
            unreachable!()
        }
        fn is_auto_update_check_enabled(&self) -> wealthfolio_core::errors::Result<bool> {
            unreachable!()
        }
        fn is_sync_enabled(&self) -> wealthfolio_core::errors::Result<bool> {
            unreachable!()
        }
    }

    fn serve_binding_responses(bodies: Vec<&'static str>) -> (String, std::thread::JoinHandle<()>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            for body in bodies {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = [0; 4096];
                let n = stream.read(&mut request).unwrap();
                let request = String::from_utf8_lossy(&request[..n]);
                assert!(request.contains("/api/v1/user/me"));
                assert!(request.contains("Bearer unchanged-token"));
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
            }
        });
        (url, server)
    }

    #[tokio::test]
    async fn automatic_admission_rechecks_membership_with_unchanged_access_token() {
        let (url, server) = serve_binding_responses(vec![
            r#"{"id":"user","team":{"id":"team-a"}}"#,
            r#"{"id":"user","team":{"id":"team-b"}}"#,
        ]);
        let root = std::env::temp_dir().join(format!("wf-admission-{}", uuid::Uuid::new_v4()));
        let store = Arc::new(MemorySecrets::default());
        let registry = wealthfolio_core::profiles::ProfileRegistry::open(
            root.clone(),
            root.join("db"),
            store.clone(),
        )
        .unwrap();
        let id = registry.default_id().unwrap();
        let original = wealthfolio_core::profiles::ConnectBinding {
            issuer: url.clone(),
            user_id: "user".into(),
            team_id: Some("team-a".into()),
        };
        registry.bind_connect(id, original.clone()).unwrap();
        store
            .set_secret(SYNC_IDENTITY_KEY, "team-a enrollment")
            .unwrap();
        let config = TokenLifecycleConfig::new(url.clone(), "test-key".into());
        admit_profile_binding("unchanged-token", &config, &url, &registry, id)
            .await
            .unwrap();
        let result = admit_profile_binding("unchanged-token", &config, &url, &registry, id).await;
        assert!(
            result.unwrap_err().starts_with("CONNECT_REBIND_REQUIRED"),
            "membership change must block cloud work even when the token is unchanged"
        );
        assert_eq!(registry.profile(id).unwrap().connect, Some(original));
        assert_eq!(
            store.get_secret(SYNC_IDENTITY_KEY).unwrap().as_deref(),
            Some("team-a enrollment")
        );
        server.join().unwrap();
        drop(registry);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn automatic_admission_does_not_bind_unknown_nonlegacy_cloud_state() {
        let (url, server) =
            serve_binding_responses(vec![r#"{"id":"user","team":{"id":"current-team"}}"#]);
        let root =
            std::env::temp_dir().join(format!("wf-legacy-admission-{}", uuid::Uuid::new_v4()));
        let store = Arc::new(MemorySecrets::default());
        let registry = wealthfolio_core::profiles::ProfileRegistry::open(
            root.clone(),
            root.join("db"),
            store.clone(),
        )
        .unwrap();
        let id = registry.default_id().unwrap();
        store
            .set_secret(SYNC_IDENTITY_KEY, "unknown previous enrollment")
            .unwrap();
        store
            .set_secret(CLOUD_REFRESH_TOKEN_KEY, "legacy-refresh")
            .unwrap();
        let config = TokenLifecycleConfig::new(url.clone(), "test-key".into());
        let result = admit_profile_binding("unchanged-token", &config, &url, &registry, id).await;
        assert!(
            result.unwrap_err().starts_with("CONNECT_REBIND_REQUIRED"),
            "unknown nonlegacy ownership must require explicit confirmed reconnect"
        );
        assert!(registry.profile(id).unwrap().connect.is_none());
        assert_eq!(
            store.get_secret(SYNC_IDENTITY_KEY).unwrap().as_deref(),
            Some("unknown previous enrollment")
        );
        assert_eq!(
            store
                .get_secret(CLOUD_REFRESH_TOKEN_KEY)
                .unwrap()
                .as_deref(),
            Some("legacy-refresh")
        );
        server.join().unwrap();
        drop(registry);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn legacy_admission_migrates_existing_session_without_resetting_enrollment() {
        let (url, server) = serve_binding_responses(vec![
            r#"{"id":"reserved-user","team":{"id":"team"}}"#,
            r#"{"id":"user","team":{"id":"team"}}"#,
            r#"{"id":"user","team":{"id":"other-team"}}"#,
        ]);
        let root = std::env::temp_dir().join(format!("wf-legacy-session-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("db"), b"legacy database").unwrap();
        let store = Arc::new(MemorySecrets::default());
        let registry = wealthfolio_core::profiles::ProfileRegistry::open(
            root.clone(),
            root.join("db"),
            store.clone(),
        )
        .unwrap();
        let id = registry.default_id().unwrap();
        for key in [
            SYNC_IDENTITY_KEY,
            LEGACY_SYNC_DEVICE_ID_KEY,
            wealthfolio_core::secrets::CLOUD_BACKUP_CONSENT_KEY,
            CLOUD_REFRESH_TOKEN_KEY,
        ] {
            store.set_secret(key, "preserved").unwrap();
        }
        let config = TokenLifecycleConfig::new(url.clone(), "test-key".into());
        let other = registry
            .create("Other", wealthfolio_core::profiles::PROFILE_AVATARS[0])
            .unwrap();
        registry
            .bind_connect(
                other.id,
                wealthfolio_core::profiles::ConnectBinding {
                    issuer: url.clone(),
                    user_id: "reserved-user".into(),
                    team_id: Some("team".into()),
                },
            )
            .unwrap();
        assert!(
            admit_profile_binding("unchanged-token", &config, &url, &registry, id)
                .await
                .is_err()
        );
        assert!(registry.profile(id).unwrap().connect.is_none());
        admit_profile_binding("unchanged-token", &config, &url, &registry, id)
            .await
            .unwrap();
        assert_eq!(
            registry
                .profile(id)
                .unwrap()
                .connect
                .unwrap()
                .team_id
                .as_deref(),
            Some("team")
        );
        assert!(
            admit_profile_binding("unchanged-token", &config, &url, &registry, id)
                .await
                .unwrap_err()
                .starts_with("CONNECT_REBIND_REQUIRED")
        );
        for key in [
            SYNC_IDENTITY_KEY,
            LEGACY_SYNC_DEVICE_ID_KEY,
            wealthfolio_core::secrets::CLOUD_BACKUP_CONSENT_KEY,
            CLOUD_REFRESH_TOKEN_KEY,
        ] {
            assert_eq!(store.get_secret(key).unwrap().as_deref(), Some("preserved"));
        }
        server.join().unwrap();
        drop(registry);
        let reopened =
            wealthfolio_core::profiles::ProfileRegistry::open(root.clone(), root.join("db"), store)
                .unwrap();
        assert_eq!(
            reopened
                .profile(id)
                .unwrap()
                .connect
                .unwrap()
                .team_id
                .as_deref(),
            Some("team")
        );
        drop(reopened);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn legacy_first_login_preserves_state_and_later_account_changes_require_confirmation() {
        use wealthfolio_core::profiles::{ConnectBinding, ProfileRegistry};
        let root = std::env::temp_dir().join(format!("wf-legacy-login-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("db"), b"legacy database").unwrap();
        let store = Arc::new(MemorySecrets::default());
        let registry = ProfileRegistry::open(root.clone(), root.join("db"), store.clone()).unwrap();
        let id = registry.default_id().unwrap();
        for key in [SYNC_IDENTITY_KEY, LEGACY_SYNC_DEVICE_ID_KEY] {
            store.set_secret(key, "preserved").unwrap();
        }
        let state = TokenLifecycleState::new();
        let settings = BindingSettings {
            required: AtomicBool::new(false),
        };
        let binding = ConnectBinding {
            issuer: "issuer".into(),
            user_id: "user".into(),
            team_id: Some("team".into()),
        };
        // A restored database must not be mistaken for an ordinary upgrade.
        settings.required.store(true, Ordering::SeqCst);
        assert!(state
            .commit_profile_login(
                ProfileLoginContext {
                    store: store.as_ref(),
                    settings: &settings,
                    registry: &registry,
                    profile_id: id
                },
                "candidate",
                "rotated".into(),
                binding.clone(),
                false,
                || async { panic!("restore cleanup requires confirmation") },
            )
            .await
            .unwrap_err()
            .starts_with("CONNECT_REBIND_REQUIRED"));
        assert!(registry.profile(id).unwrap().connect.is_none());
        settings.required.store(false, Ordering::SeqCst);
        // A signed-out legacy installation has enrollment but no refresh token.
        for _ in 0..2 {
            state
                .commit_profile_login(
                    ProfileLoginContext {
                        store: store.as_ref(),
                        settings: &settings,
                        registry: &registry,
                        profile_id: id,
                    },
                    "candidate",
                    "rotated".into(),
                    binding.clone(),
                    false,
                    || async { panic!("migration must not clear broker or sync state") },
                )
                .await
                .unwrap();
        }
        assert_eq!(registry.profile(id).unwrap().connect, Some(binding.clone()));
        assert!(!settings.required.load(Ordering::SeqCst));
        let changed = ConnectBinding {
            user_id: "other-user".into(),
            ..binding
        };
        assert!(state
            .commit_profile_login(
                ProfileLoginContext {
                    store: store.as_ref(),
                    settings: &settings,
                    registry: &registry,
                    profile_id: id
                },
                "other",
                "other-rotated".into(),
                changed,
                false,
                || async { panic!("account changes require confirmation") },
            )
            .await
            .unwrap_err()
            .starts_with("CONNECT_REBIND_REQUIRED"));
        for key in [SYNC_IDENTITY_KEY, LEGACY_SYNC_DEVICE_ID_KEY] {
            assert_eq!(store.get_secret(key).unwrap().as_deref(), Some("preserved"));
        }
        assert_eq!(
            store
                .get_secret(CLOUD_REFRESH_TOKEN_KEY)
                .unwrap()
                .as_deref(),
            Some("rotated")
        );
        drop(registry);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn confirmation_reuses_rotated_candidate_and_reverifies_cloud_identity() {
        retry_rotated_candidate(false).await;
    }

    #[tokio::test]
    async fn failed_identity_lookup_retains_rotated_candidate_for_retry() {
        retry_rotated_candidate(true).await;
    }

    async fn retry_rotated_candidate(identity_unavailable: bool) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            for step in 0..4 {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = Vec::new();
                loop {
                    let mut chunk = [0; 4096];
                    let n = stream.read(&mut chunk).unwrap();
                    assert!(n > 0);
                    request.extend_from_slice(&chunk[..n]);
                    let text = String::from_utf8_lossy(&request);
                    if let Some((headers, body)) = text.split_once("\r\n\r\n") {
                        let length = headers
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .and_then(|v| v.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if body.len() >= length {
                            break;
                        }
                    }
                }
                let request = String::from_utf8(request).unwrap();
                if step == 1 && identity_unavailable {
                    // An invalid response fails identity decoding after successful rotation.
                    write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}").unwrap();
                    continue;
                }
                let body = if step % 2 == 0 {
                    assert!(request.contains(if step == 0 {
                        "original-candidate"
                    } else {
                        "rotated-candidate"
                    }));
                    r#"{"access_token":"verified-access","refresh_token":"rotated-candidate","expires_in":3600}"#
                } else {
                    assert!(request.contains("/api/v1/user/me"));
                    r#"{"id":"new-user"}"#
                };
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
            }
        });
        let root =
            std::env::temp_dir().join(format!("wf-rebinding-network-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let store = Arc::new(MemorySecrets::default());
        let registry = wealthfolio_core::profiles::ProfileRegistry::open(
            root.clone(),
            root.join("db"),
            store.clone(),
        )
        .unwrap();
        let id = registry.default_id().unwrap();
        registry
            .bind_connect(
                id,
                wealthfolio_core::profiles::ConnectBinding {
                    issuer: url.clone(),
                    user_id: "old-user".into(),
                    team_id: None,
                },
            )
            .unwrap();
        let config = TokenLifecycleConfig::new(url.clone(), "test-key".into());
        let state = TokenLifecycleState::new();
        let settings = BindingSettings {
            required: AtomicBool::new(false),
        };
        let error = state
            .store_profile_session(
                ProfileLoginContext {
                    store: store.as_ref(),
                    settings: &settings,
                    registry: &registry,
                    profile_id: id,
                },
                "original-candidate",
                false,
                &config,
                &url,
                || async { panic!("confirmation required") },
            )
            .await
            .unwrap_err();
        assert_eq!(
            error.starts_with("CONNECT_REBIND_REQUIRED"),
            !identity_unavailable
        );
        assert!(store.get_secret(CLOUD_REFRESH_TOKEN_KEY).unwrap().is_none());
        state
            .store_profile_session(
                ProfileLoginContext {
                    store: store.as_ref(),
                    settings: &settings,
                    registry: &registry,
                    profile_id: id,
                },
                "original-candidate",
                true,
                &config,
                &url,
                || async { Ok(()) },
            )
            .await
            .unwrap();
        assert_eq!(
            registry.profile(id).unwrap().connect.unwrap().user_id,
            "new-user"
        );
        server.join().unwrap();
        drop(registry);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn confirmed_binding_changes_are_explicit_and_fail_closed() {
        use wealthfolio_core::profiles::{ConnectBinding, ProfileRegistry, PROFILE_AVATARS};
        let root = std::env::temp_dir().join(format!("wf-rebinding-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let store = Arc::new(MemorySecrets::default());
        let registry = ProfileRegistry::open(root.clone(), root.join("db"), store.clone()).unwrap();
        let id = registry.default_id().unwrap();
        let other = registry.create("Other", PROFILE_AVATARS[0]).unwrap().id;
        let old = ConnectBinding {
            issuer: "issuer".into(),
            user_id: "old".into(),
            team_id: Some("team".into()),
        };
        let new = ConnectBinding {
            user_id: "new".into(),
            ..old.clone()
        };
        let duplicate = ConnectBinding {
            user_id: "reserved".into(),
            ..old.clone()
        };
        registry.bind_connect(id, old.clone()).unwrap();
        registry.bind_connect(other, duplicate.clone()).unwrap();
        let state = TokenLifecycleState::new();
        let settings = BindingSettings {
            required: AtomicBool::new(false),
        };
        for key in [
            CLOUD_REFRESH_TOKEN_KEY,
            SYNC_IDENTITY_KEY,
            DATABASE_KEY_SECRET,
            PROFILE_LOCK_KEY,
            "unrelated",
        ] {
            store.set_secret(key, "original").unwrap();
        }
        let unbound = registry.create("Migrated", PROFILE_AVATARS[0]).unwrap().id;
        let migrated_candidate = ConnectBinding {
            user_id: "migrated-candidate".into(),
            ..old.clone()
        };
        assert!(state
            .commit_profile_login(
                ProfileLoginContext {
                    store: store.as_ref(),
                    settings: &settings,
                    registry: &registry,
                    profile_id: unbound
                },
                "candidate",
                "rotated".into(),
                migrated_candidate,
                false,
                || async { panic!("unknown old state requires confirmation") }
            )
            .await
            .unwrap_err()
            .starts_with("CONNECT_REBIND_REQUIRED"));
        assert!(registry.profile(unbound).unwrap().connect.is_none());
        let error = state
            .commit_profile_login(
                ProfileLoginContext {
                    store: store.as_ref(),
                    settings: &settings,
                    registry: &registry,
                    profile_id: id,
                },
                "candidate",
                "rotated".into(),
                new.clone(),
                false,
                || async { panic!("must not clean before confirmation") },
            )
            .await
            .unwrap_err();
        assert!(error.starts_with("CONNECT_REBIND_REQUIRED"));
        assert_eq!(registry.profile(id).unwrap().connect, Some(old.clone()));
        assert_eq!(
            store
                .get_secret(CLOUD_REFRESH_TOKEN_KEY)
                .unwrap()
                .as_deref(),
            Some("original")
        );
        assert!(!settings.required.load(Ordering::SeqCst));
        // Confirming never bypasses another profile's reservation.
        assert!(state
            .commit_profile_login(
                ProfileLoginContext {
                    store: store.as_ref(),
                    settings: &settings,
                    registry: &registry,
                    profile_id: id
                },
                "candidate",
                "rotated".into(),
                duplicate,
                true,
                || async { panic!("must not clean duplicate") }
            )
            .await
            .unwrap_err()
            .starts_with("CONNECT_PROFILE_EXISTS"));
        // Same identity reconnect does not clear enrollment.
        state
            .commit_profile_login(
                ProfileLoginContext {
                    store: store.as_ref(),
                    settings: &settings,
                    registry: &registry,
                    profile_id: id,
                },
                "same",
                "same".into(),
                old.clone(),
                false,
                || async { panic!("same account must retain sync") },
            )
            .await
            .unwrap();
        assert_eq!(
            store.get_secret(SYNC_IDENTITY_KEY).unwrap().as_deref(),
            Some("original")
        );
        // Failed cleanup cannot reactivate old credentials or bind the new user.
        assert!(state
            .commit_profile_login(
                ProfileLoginContext {
                    store: store.as_ref(),
                    settings: &settings,
                    registry: &registry,
                    profile_id: id
                },
                "candidate",
                "rotated".into(),
                new.clone(),
                true,
                || async { Err("cleanup failed".into()) }
            )
            .await
            .is_err());
        assert!(settings.required.load(Ordering::SeqCst));
        assert!(store.get_secret(CLOUD_REFRESH_TOKEN_KEY).unwrap().is_none());
        assert_eq!(registry.profile(id).unwrap().connect, Some(old));
        state
            .commit_profile_login(
                ProfileLoginContext {
                    store: store.as_ref(),
                    settings: &settings,
                    registry: &registry,
                    profile_id: id,
                },
                "candidate",
                "rotated".into(),
                new.clone(),
                true,
                || async { Ok(()) },
            )
            .await
            .unwrap();
        assert_eq!(registry.profile(id).unwrap().connect, Some(new));
        assert!(!settings.required.load(Ordering::SeqCst));
        assert!(store.get_secret(SYNC_IDENTITY_KEY).unwrap().is_none());
        for key in [DATABASE_KEY_SECRET, PROFILE_LOCK_KEY, "unrelated"] {
            assert_eq!(store.get_secret(key).unwrap().as_deref(), Some("original"));
        }
        assert_eq!(
            store
                .get_secret(CLOUD_REFRESH_TOKEN_KEY)
                .unwrap()
                .as_deref(),
            Some("rotated")
        );
        drop(registry);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn reconnect_transition_serializes_competing_login_and_logout() {
        for logout in [false, true] {
            let state = Arc::new(TokenLifecycleState::new());
            let store = Arc::new(MemorySecrets::default());
            let settings = Arc::new(ReconnectSettings {
                required: AtomicBool::new(true),
                clearing: tokio::sync::Notify::new(),
                release: tokio::sync::Notify::new(),
            });
            store.set_secret(SYNC_IDENTITY_KEY, "old identity").unwrap();
            store
                .set_secret(LEGACY_SYNC_DEVICE_ID_KEY, "old device")
                .unwrap();
            let first = {
                let (state, store, settings) = (state.clone(), store.clone(), settings.clone());
                tokio::spawn(async move {
                    state
                        .store_session_after_restore(
                            store.as_ref(),
                            settings.as_ref(),
                            "first login",
                        )
                        .await
                })
            };
            settings.clearing.notified().await;
            // First login has stored its token, but must still hold the lifecycle
            // lock while the persistent reconnect gate is being cleared.
            let mut second = {
                let (state, store, settings) = (state.clone(), store.clone(), settings.clone());
                tokio::spawn(async move {
                    if logout {
                        state.clear_session(store.as_ref()).await.map(|_| ())
                    } else {
                        state
                            .store_session_after_restore(
                                store.as_ref(),
                                settings.as_ref(),
                                "second login",
                            )
                            .await
                    }
                })
            };
            assert!(tokio::time::timeout(Duration::from_millis(25), &mut second)
                .await
                .is_err());
            assert_eq!(
                store
                    .get_secret(CLOUD_REFRESH_TOKEN_KEY)
                    .unwrap()
                    .as_deref(),
                Some("first login")
            );
            settings.release.notify_one();
            first.await.unwrap().unwrap();
            second.await.unwrap().unwrap();
            assert_eq!(
                store
                    .get_secret(CLOUD_REFRESH_TOKEN_KEY)
                    .unwrap()
                    .as_deref(),
                if logout { None } else { Some("second login") }
            );
            assert!(store.get_secret(SYNC_IDENTITY_KEY).unwrap().is_none());
            assert!(store
                .get_secret(LEGACY_SYNC_DEVICE_ID_KEY)
                .unwrap()
                .is_none());
        }
    }

    fn fake_jwt_with_exp(exp: i64) -> String {
        let header = URL_SAFE_NO_PAD.encode(r#"{"alg":"HS256","typ":"JWT"}"#);
        let payload = URL_SAFE_NO_PAD.encode(format!(r#"{{"exp":{}}}"#, exp));
        format!("{}.{}.sig", header, payload)
    }

    #[test]
    fn token_with_future_exp_is_fresh() {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("current time after epoch")
            .as_secs() as i64;
        let token = fake_jwt_with_exp(now + 3600);
        assert!(is_access_token_fresh(&token, SystemTime::now(), 60));
    }

    #[test]
    fn token_near_expiry_is_stale() {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("current time after epoch")
            .as_secs() as i64;
        let token = fake_jwt_with_exp(now + 30);
        assert!(!is_access_token_fresh(&token, SystemTime::now(), 60));
    }

    #[test]
    fn malformed_token_is_stale() {
        assert!(!is_access_token_fresh(
            "malformed.token",
            SystemTime::now(),
            60
        ));
    }

    #[test]
    fn invalid_grant_is_classified_as_session_invalid() {
        assert!(is_session_invalid(
            400,
            "invalid_grant",
            "Invalid refresh token"
        ));
        assert!(is_session_invalid(401, "", "unauthorized"));
    }

    #[test]
    fn fallback_refresh_error_preserves_invalid_session_body() {
        let message =
            fallback_refresh_error_message(400, "non-json response: invalid refresh token");

        assert!(is_session_invalid(400, "", &message));
    }
    #[derive(Default)]
    struct MemorySecrets(std::sync::Mutex<std::collections::HashMap<String, String>>);

    impl SecretStore for MemorySecrets {
        fn get_secret(&self, key: &str) -> wealthfolio_core::errors::Result<Option<String>> {
            Ok(self.0.lock().unwrap().get(key).cloned())
        }
        fn set_secret(&self, key: &str, value: &str) -> wealthfolio_core::errors::Result<()> {
            self.0
                .lock()
                .unwrap()
                .insert(key.to_string(), value.to_string());
            Ok(())
        }
        fn delete_secret(&self, key: &str) -> wealthfolio_core::errors::Result<()> {
            self.0.lock().unwrap().remove(key);
            Ok(())
        }
    }

    #[tokio::test]
    async fn logout_clears_credentials_even_without_a_ui_listener() {
        let store = MemorySecrets::default();
        let state = TokenLifecycleState::new();
        state.store_session(&store, "account-a").await.unwrap();
        state.clear_session(&store).await.unwrap();
        assert!(!state.is_session_configured(&store).unwrap());
        assert!(!TokenLifecycleState::new()
            .is_session_configured(&store)
            .unwrap());
        assert!(ensure_valid_access_token(&store, &state, None)
            .await
            .is_err());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn termination_waits_for_refresh_and_removes_rotated_credentials() {
        use std::io::{Read, Write};
        use std::sync::Arc;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let config = TokenLifecycleConfig::new(
            format!("http://{}", listener.local_addr().unwrap()),
            "test-key".into(),
        );
        let (received_tx, received_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 4096];
            assert!(stream.read(&mut request).unwrap() > 0);
            received_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            let body = r#"{"access_token":"test-access","refresh_token":"rotated-refresh","expires_in":3600}"#;
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        });
        let state = Arc::new(TokenLifecycleState::new());
        let store = Arc::new(MemorySecrets::default());
        state
            .store_session(store.as_ref(), "original-refresh")
            .await
            .unwrap();
        let refresh = tokio::spawn({
            let state = Arc::clone(&state);
            let store = Arc::clone(&store);
            async move { ensure_valid_access_token(store.as_ref(), &state, Some(&config)).await }
        });
        received_rx.await.unwrap();
        let mut terminate = tokio::spawn({
            let state = Arc::clone(&state);
            let store = Arc::clone(&store);
            async move { state.clear_session(store.as_ref()).await }
        });
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut terminate)
                .await
                .is_err()
        );
        release_tx.send(()).unwrap();
        refresh.await.unwrap().unwrap();
        terminate.await.unwrap().unwrap();
        assert!(store.get_secret(CLOUD_REFRESH_TOKEN_KEY).unwrap().is_none());
        assert!(state.cache.read().await.is_none());
        assert!(!state.is_session_configured(store.as_ref()).unwrap());
        server.join().unwrap();
    }
    #[tokio::test]
    async fn replacement_login_waits_until_old_worker_shutdown_finishes() {
        use std::sync::Arc;
        let state = Arc::new(TokenLifecycleState::new());
        let store = Arc::new(MemorySecrets::default());
        state
            .store_session(store.as_ref(), "account-a")
            .await
            .unwrap();
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let terminate = tokio::spawn({
            let state = Arc::clone(&state);
            let store = Arc::clone(&store);
            async move {
                state
                    .clear_session_with(store.as_ref(), || async {
                        shutdown_tx.send(()).unwrap();
                        release_rx.await.unwrap();
                    })
                    .await
            }
        });
        shutdown_rx.await.unwrap();
        let mut login = tokio::spawn({
            let state = Arc::clone(&state);
            let store = Arc::clone(&store);
            async move { state.store_session(store.as_ref(), "account-b").await }
        });
        assert!(tokio::time::timeout(Duration::from_millis(20), &mut login)
            .await
            .is_err());
        release_tx.send(()).unwrap();
        terminate.await.unwrap().unwrap();
        login.await.unwrap().unwrap();
        assert_eq!(
            store
                .get_secret(CLOUD_REFRESH_TOKEN_KEY)
                .unwrap()
                .as_deref(),
            Some("account-b")
        );
        assert!(state.is_session_configured(store.as_ref()).unwrap());
    }
}
