use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose, Engine as _};
use serde::Deserialize;
use tokio::sync::{Mutex, RwLock};
use wealthfolio_core::secrets::SecretStore;

use crate::request_metadata::{
    log_failed_cloud_request, request_metadata_suffix, server_request_id, CloudRequestContext,
    CLIENT_REQUEST_ID_HEADER,
};

pub const CLOUD_REFRESH_TOKEN_KEY: &str = "sync_refresh_token";
pub const CLOUD_ACCESS_TOKEN_KEY: &str = "sync_access_token";

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

#[derive(Debug)]
pub struct TokenLifecycleState {
    cache: RwLock<Option<CachedAccessToken>>,
    refresh_lock: Mutex<()>,
}

impl TokenLifecycleState {
    pub fn new() -> Self {
        Self {
            cache: RwLock::new(None),
            refresh_lock: Mutex::new(()),
        }
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
    if let Some(token) = read_cached_token(state).await {
        return Ok(token);
    }

    let _refresh_guard = state.refresh_lock.lock().await;

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
                let _ = secret_store.delete_secret(CLOUD_ACCESS_TOKEN_KEY);
                let _ = secret_store.delete_secret(CLOUD_REFRESH_TOKEN_KEY);
                state.clear_cache().await;
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
    let client = reqwest::Client::builder()
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

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;

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
}
