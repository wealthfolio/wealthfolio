//! Device sync API client for communicating with the Wealthfolio Connect cloud service.
//!
//! This client uses the REST API endpoints for device synchronization.

use crate::transfer::{ConnectTransferTransport, TransferDescriptor};
use log::debug;
use rand::Rng;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use reqwest::{Method, RequestBuilder, StatusCode};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, OnceLock};
use std::time::Duration;
use tokio::sync::Mutex;
use tokio::time::sleep;
use uuid::Uuid;

use crate::error::{DeviceSyncError, Result};
use crate::types::*;

/// Default timeout for API requests.
const DEFAULT_TIMEOUT_SECS: u64 = 30;
pub(crate) const SNAPSHOT_UPLOAD_MAX_ATTEMPTS: usize = 5;
const SNAPSHOT_UPLOAD_BASE_BACKOFF_MS: u64 = 250;
const SNAPSHOT_UPLOAD_MAX_BACKOFF_MS: u64 = 8_000;
const CLIENT_REQUEST_ID_HEADER: &str = "x-wf-client-request-id";
const SERVER_REQUEST_ID_HEADER: &str = "x-request-id";

static SNAPSHOT_UPLOAD_IN_FLIGHT: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
static API_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    wealthfolio_http::client_builder()
        .timeout(Duration::from_secs(DEFAULT_TIMEOUT_SECS))
        .connect_timeout(Duration::from_secs(DEFAULT_TIMEOUT_SECS))
        .build()
        .expect("Failed to build HTTP client")
});

fn snapshot_upload_in_flight() -> &'static Mutex<HashSet<String>> {
    SNAPSHOT_UPLOAD_IN_FLIGHT.get_or_init(|| Mutex::new(HashSet::new()))
}

fn compute_sha256_checksum(payload: &[u8]) -> String {
    crate::crypto::sha256_checksum(payload)
}

fn is_valid_sha256_checksum(checksum: &str) -> bool {
    let Some(hex) = checksum.strip_prefix("sha256:") else {
        return false;
    };
    hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit())
}

pub(crate) fn is_retryable_snapshot_status(status: u16) -> bool {
    matches!(status, 408 | 429 | 500..=599)
}

fn is_retryable_snapshot_error(status: u16, code: Option<&str>, message: Option<&str>) -> bool {
    if is_retryable_snapshot_status(status) {
        return true;
    }
    if matches!(code, Some("SYNC_TRANSACTION_FAILED")) {
        let message = message.unwrap_or_default().to_ascii_lowercase();
        if message.contains("snapshot index conflict") {
            return false;
        }
        return true;
    }
    false
}

pub(crate) fn is_retryable_transport_error(err: &reqwest::Error) -> bool {
    err.is_timeout() || err.is_connect() || err.is_request() || err.is_body()
}

pub(crate) fn snapshot_backoff_with_jitter(attempt: usize) -> Duration {
    let exp = (attempt.saturating_sub(1) as u32).min(8);
    let backoff = (SNAPSHOT_UPLOAD_BASE_BACKOFF_MS.saturating_mul(1_u64 << exp))
        .min(SNAPSHOT_UPLOAD_MAX_BACKOFF_MS);
    let jitter = rand::thread_rng().gen_range(0..=(backoff / 5).max(1));
    Duration::from_millis(backoff.saturating_add(jitter))
}

#[derive(Debug, Clone)]
struct CloudRequestContext {
    method: String,
    path: String,
    client_request_id: String,
    device_id: Option<String>,
}

impl CloudRequestContext {
    fn new(method: &str, path: impl Into<String>, device_id: Option<&str>) -> Self {
        Self {
            method: method.to_string(),
            path: path.into(),
            client_request_id: generate_client_request_id(device_id),
            device_id: device_id.map(str::to_string),
        }
    }
}

fn generate_client_request_id(device_id: Option<&str>) -> String {
    let uuid = Uuid::new_v4();
    if let Some(device_id) = device_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .filter(|value| is_log_safe_request_id(value))
    {
        let candidate = format!("{}:{}", device_id, uuid);
        if is_log_safe_request_id(&candidate) {
            return candidate;
        }
    }
    format!("app:{}", uuid)
}

fn is_log_safe_request_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
}

fn server_request_id(headers: &HeaderMap) -> Option<String> {
    headers
        .get(SERVER_REQUEST_ID_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| is_log_safe_request_id(value))
        .map(str::to_string)
}

fn request_metadata_suffix(
    context: &CloudRequestContext,
    server_request_id: Option<&str>,
) -> String {
    match server_request_id {
        Some(request_id) => format!(
            "clientRequestId={}, requestId={}",
            context.client_request_id, request_id
        ),
        None => format!(
            "clientRequestId={}, requestId=none",
            context.client_request_id
        ),
    }
}

fn with_request_metadata(
    message: impl Into<String>,
    context: &CloudRequestContext,
    server_request_id: Option<&str>,
) -> String {
    format!(
        "{} ({})",
        message.into(),
        request_metadata_suffix(context, server_request_id)
    )
}

fn fallback_api_error_message(body: &str) -> String {
    let body = body.trim();
    if body.is_empty() {
        "Request failed".to_string()
    } else {
        format!("Request failed: {}", body)
    }
}

fn details_with_request_metadata(
    details: Option<serde_json::Value>,
    context: &CloudRequestContext,
    server_request_id: Option<&str>,
) -> Option<serde_json::Value> {
    let mut metadata = serde_json::Map::new();
    metadata.insert(
        "clientRequestId".to_string(),
        serde_json::Value::String(context.client_request_id.clone()),
    );
    if let Some(request_id) = server_request_id {
        metadata.insert(
            "requestId".to_string(),
            serde_json::Value::String(request_id.to_string()),
        );
    }

    match details {
        Some(serde_json::Value::Object(mut object)) => {
            object.extend(metadata);
            Some(serde_json::Value::Object(object))
        }
        Some(value) => {
            metadata.insert("apiDetails".to_string(), value);
            Some(serde_json::Value::Object(metadata))
        }
        None => Some(serde_json::Value::Object(metadata)),
    }
}

fn log_failed_cloud_request(
    context: &CloudRequestContext,
    status: Option<StatusCode>,
    server_request_id: Option<&str>,
    cause: &'static str,
    api_code: Option<&str>,
) {
    let status = status
        .map(|status| status.as_u16().to_string())
        .unwrap_or_else(|| "no_response".to_string());
    let request_id = server_request_id.unwrap_or("none");
    let device_id = context.device_id.as_deref().unwrap_or("none");
    let api_code = api_code
        .filter(|code| {
            !code.is_empty()
                && code.len() <= 64
                && code
                    .bytes()
                    .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
        })
        .unwrap_or("none");

    log::warn!(
        "[DeviceSync] Cloud request failed method={} path={} status={} cause={} apiCode={} clientRequestId={} requestId={} deviceId={}",
        context.method,
        context.path,
        status,
        cause,
        api_code,
        context.client_request_id,
        request_id,
        device_id
    );
}

fn transport_error_kind(error: &reqwest::Error) -> &'static str {
    if error.is_timeout() {
        "timeout"
    } else if error.is_connect() {
        "connection"
    } else if error.is_request() {
        "request"
    } else if error.is_body() {
        "body"
    } else if error.is_decode() {
        "decode"
    } else {
        "transport"
    }
}

/// Client for the Wealthfolio device sync cloud API.
///
/// This client handles all communication with the cloud service for device
/// registration, pairing, and key synchronization.
#[derive(Debug, Clone)]
pub struct DeviceSyncClient {
    client: reqwest::Client,
    base_url: String,
}

impl DeviceSyncClient {
    fn is_backend_strict_uuid(input: &str) -> bool {
        let value = input.trim();
        if value.eq_ignore_ascii_case("00000000-0000-0000-0000-000000000000")
            || value.eq_ignore_ascii_case("ffffffff-ffff-ffff-ffff-ffffffffffff")
        {
            return true;
        }

        let bytes = value.as_bytes();
        if bytes.len() != 36 {
            return false;
        }

        let is_hex = |b: u8| b.is_ascii_hexdigit();
        let is_ver = |b: u8| matches!(b, b'1'..=b'8');
        let is_variant = |b: u8| matches!(b, b'8' | b'9' | b'a' | b'b' | b'A' | b'B');

        for (idx, byte) in bytes.iter().enumerate() {
            match idx {
                8 | 13 | 18 | 23 => {
                    if *byte != b'-' {
                        return false;
                    }
                }
                14 => {
                    if !is_ver(*byte) {
                        return false;
                    }
                }
                19 => {
                    if !is_variant(*byte) {
                        return false;
                    }
                }
                _ => {
                    if !is_hex(*byte) {
                        return false;
                    }
                }
            }
        }
        true
    }

    fn snapshot_from_cursor_latest(value: SyncLatestSnapshotRef) -> SnapshotLatestResponse {
        SnapshotLatestResponse {
            snapshot_id: value.snapshot_id,
            schema_version: value.schema_version,
            covers_tables: Vec::new(),
            oplog_seq: value.oplog_seq,
            size_bytes: 0,
            checksum: String::new(),
            created_at: String::new(),
        }
    }

    fn choose_snapshot_from_latest_and_cursor(
        latest: SnapshotLatestResponse,
        cursor_latest: Option<SyncLatestSnapshotRef>,
    ) -> SnapshotLatestResponse {
        let latest_id = latest.snapshot_id.trim();
        let Some(cursor_latest) = cursor_latest else {
            return latest;
        };
        let cursor_id = cursor_latest.snapshot_id.trim();
        if cursor_id.is_empty() {
            return latest;
        }

        let latest_is_strict_uuid = Self::is_backend_strict_uuid(latest_id);
        let cursor_is_strict_uuid = Self::is_backend_strict_uuid(cursor_id);

        if !latest_is_strict_uuid && cursor_is_strict_uuid {
            debug!(
                "Using cursor latest snapshot id '{}' over non-UUID snapshots/latest id '{}'",
                cursor_id, latest_id
            );
            return Self::snapshot_from_cursor_latest(cursor_latest);
        }

        if cursor_latest.oplog_seq > latest.oplog_seq {
            debug!(
                "Using cursor latest snapshot id '{}' because oplog_seq {} > snapshots/latest {}",
                cursor_id, cursor_latest.oplog_seq, latest.oplog_seq
            );
            return Self::snapshot_from_cursor_latest(cursor_latest);
        }

        latest
    }

    /// Create a new device sync client.
    ///
    /// # Arguments
    ///
    /// * `base_url` - The base URL of the cloud API (e.g., "https://api.wealthfolio.app")
    pub fn new(base_url: &str) -> Self {
        Self {
            client: API_CLIENT.clone(),
            base_url: base_url.trim_end_matches('/').to_string(),
        }
    }

    /// Create headers for an API request with optional device ID.
    fn headers_with_device(
        &self,
        token: &str,
        device_id: Option<&str>,
        context: &CloudRequestContext,
    ) -> Result<HeaderMap> {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));

        let auth_value = HeaderValue::from_str(&format!("Bearer {}", token))
            .map_err(|_| DeviceSyncError::auth("Invalid access token format"))?;
        headers.insert(AUTHORIZATION, auth_value);
        headers.insert(
            CLIENT_REQUEST_ID_HEADER,
            HeaderValue::from_str(&context.client_request_id)
                .map_err(|_| DeviceSyncError::auth("Invalid client request ID format"))?,
        );

        if let Some(device_id) = device_id {
            let device_id_value = HeaderValue::from_str(device_id)
                .map_err(|_| DeviceSyncError::auth("Invalid device ID format"))?;
            headers.insert("x-wf-device-id", device_id_value);
        }

        Ok(headers)
    }

    pub(crate) async fn send_json_no_body<T: DeserializeOwned>(
        &self,
        method: Method,
        path: String,
        token: &str,
        device_id: Option<&str>,
    ) -> Result<T> {
        let context = CloudRequestContext::new(method.as_str(), path.clone(), device_id);
        let url = format!("{}{}", self.base_url, path);
        let headers = self.headers_with_device(token, device_id, &context)?;
        let response = self
            .send_request(&context, self.client.request(method, &url).headers(headers))
            .await?;
        Self::parse_response(response, &context).await
    }

    pub(crate) async fn send_json_body<T: DeserializeOwned, B: Serialize + ?Sized>(
        &self,
        method: Method,
        path: String,
        token: &str,
        device_id: Option<&str>,
        body: &B,
    ) -> Result<T> {
        let context = CloudRequestContext::new(method.as_str(), path.clone(), device_id);
        let url = format!("{}{}", self.base_url, path);
        let headers = self.headers_with_device(token, device_id, &context)?;
        let response = self
            .send_request(
                &context,
                self.client
                    .request(method, &url)
                    .headers(headers)
                    .json(body),
            )
            .await?;
        Self::parse_response(response, &context).await
    }

    async fn send_request(
        &self,
        context: &CloudRequestContext,
        request: RequestBuilder,
    ) -> Result<reqwest::Response> {
        request.send().await.map_err(|err| {
            log_failed_cloud_request(context, None, None, transport_error_kind(&err), None);
            DeviceSyncError::Http(err)
        })
    }

    /// Parse a JSON response body.
    async fn parse_response<T: DeserializeOwned>(
        response: reqwest::Response,
        context: &CloudRequestContext,
    ) -> Result<T> {
        let status = response.status();
        let request_id = server_request_id(response.headers());
        let body = response.text().await.map_err(|err| {
            log_failed_cloud_request(
                context,
                Some(status),
                request_id.as_deref(),
                transport_error_kind(&err),
                None,
            );
            DeviceSyncError::Http(err)
        })?;

        if !status.is_success() {
            if let Ok(error) = serde_json::from_str::<ApiErrorResponse>(&body) {
                let code = if error.code.is_empty() {
                    error.error
                } else {
                    error.code
                };
                log_failed_cloud_request(
                    context,
                    Some(status),
                    request_id.as_deref(),
                    "http",
                    Some(&code),
                );
                return Err(DeviceSyncError::api_structured(
                    status.as_u16(),
                    code,
                    with_request_metadata(error.message, context, request_id.as_deref()),
                    details_with_request_metadata(error.details, context, request_id.as_deref()),
                ));
            }
            log_failed_cloud_request(context, Some(status), request_id.as_deref(), "http", None);
            return Err(DeviceSyncError::api(
                status.as_u16(),
                with_request_metadata(
                    fallback_api_error_message(&body),
                    context,
                    request_id.as_deref(),
                ),
            ));
        }

        serde_json::from_str(&body).map_err(|e| {
            log_failed_cloud_request(
                context,
                Some(status),
                request_id.as_deref(),
                "invalid_json",
                None,
            );
            log::error!(
                "Failed to deserialize cloud response: {} ({})",
                e,
                request_metadata_suffix(context, request_id.as_deref())
            );
            DeviceSyncError::api(
                status.as_u16(),
                with_request_metadata(
                    format!("Failed to parse response: {}", e),
                    context,
                    request_id.as_deref(),
                ),
            )
        })
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Device Management
    // ─────────────────────────────────────────────────────────────────────────

    /// Enroll a device with the cloud API.
    ///
    /// This is the single entry point for device enrollment. Returns the next step:
    /// - BOOTSTRAP: First device for this team - generate RK locally
    /// - PAIR: E2EE already enabled - device must pair with existing trusted device
    /// - READY: Device is already trusted and ready to sync
    ///
    /// POST /api/v1/sync/team/devices
    pub async fn enroll_device(
        &self,
        token: &str,
        info: RegisterDeviceRequest,
    ) -> Result<EnrollDeviceResponse> {
        debug!("Enrolling device: {:?}", info);

        self.send_json_body(
            Method::POST,
            "/api/v1/sync/team/devices".to_string(),
            token,
            None,
            &info,
        )
        .await
    }

    /// Get device info by ID.
    ///
    /// GET /api/v1/sync/team/devices/{deviceId}
    pub async fn get_device(&self, token: &str, device_id: &str) -> Result<Device> {
        self.send_json_no_body(
            Method::GET,
            format!("/api/v1/sync/team/devices/{}", device_id),
            token,
            None,
        )
        .await
    }

    /// List all devices.
    ///
    /// GET /api/v1/sync/team/devices?scope=my|team
    pub async fn list_devices(&self, token: &str, scope: Option<&str>) -> Result<Vec<Device>> {
        let mut path = "/api/v1/sync/team/devices".to_string();
        if let Some(s) = scope {
            path = format!("{}?scope={}", path, s);
        }

        debug!("[DeviceSync] list_devices path: {}", path);

        self.send_json_no_body(Method::GET, path, token, None).await
    }

    /// Update a device (e.g., rename).
    ///
    /// PATCH /api/v1/sync/team/devices/{deviceId}
    pub async fn update_device(
        &self,
        token: &str,
        device_id: &str,
        update: UpdateDeviceRequest,
    ) -> Result<SuccessResponse> {
        self.send_json_body(
            Method::PATCH,
            format!("/api/v1/sync/team/devices/{}", device_id),
            token,
            None,
            &update,
        )
        .await
    }

    /// Delete a device.
    ///
    /// DELETE /api/v1/sync/team/devices/{deviceId}
    pub async fn delete_device(&self, token: &str, device_id: &str) -> Result<SuccessResponse> {
        self.send_json_no_body(
            Method::DELETE,
            format!("/api/v1/sync/team/devices/{}", device_id),
            token,
            None,
        )
        .await
    }

    /// Revoke a device's trust.
    ///
    /// POST /api/v1/sync/team/devices/{deviceId}/revoke
    pub async fn revoke_device(&self, token: &str, device_id: &str) -> Result<SuccessResponse> {
        self.send_json_no_body(
            Method::POST,
            format!("/api/v1/sync/team/devices/{}/revoke", device_id),
            token,
            None,
        )
        .await
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Team Keys (E2EE)
    // ─────────────────────────────────────────────────────────────────────────

    /// Initialize team keys (Phase 1).
    ///
    /// Returns next step for key initialization:
    /// - BOOTSTRAP: Ready to initialize - challenge/nonce returned for key generation
    /// - PAIRING_REQUIRED: Already initialized - device must pair with trusted device
    /// - READY: Device already trusted at current key version
    ///
    /// POST /api/v1/sync/team/keys/initialize
    pub async fn initialize_team_keys(
        &self,
        token: &str,
        device_id: &str,
    ) -> Result<InitializeKeysResult> {
        self.send_json_body(
            Method::POST,
            "/api/v1/sync/team/keys/initialize".to_string(),
            token,
            Some(device_id),
            &serde_json::json!({ "device_id": device_id }),
        )
        .await
    }

    /// Commit team key initialization (Phase 2).
    /// Upload signed proof and key envelopes.
    ///
    /// POST /api/v1/sync/team/keys/initialize/commit
    pub async fn commit_initialize_team_keys(
        &self,
        token: &str,
        req: CommitInitializeKeysRequest,
    ) -> Result<CommitInitializeKeysResponse> {
        let device_id = req.device_id.clone();

        self.send_json_body(
            Method::POST,
            "/api/v1/sync/team/keys/initialize/commit".to_string(),
            token,
            Some(&device_id),
            &req,
        )
        .await
    }

    /// Reset the authenticated user’s sync (destructive).
    /// Legacy URL is preserved; other household members are unaffected.
    ///
    /// POST /api/v1/sync/team/keys/reset
    pub async fn reset_team_sync(
        &self,
        token: &str,
        reason: Option<&str>,
    ) -> Result<ResetTeamSyncResponse> {
        // Build body - only include reason if provided (API rejects null)
        let body = match reason {
            Some(r) => serde_json::json!({ "reason": r }),
            None => serde_json::json!({}),
        };

        self.send_json_body(
            Method::POST,
            "/api/v1/sync/team/keys/reset".to_string(),
            token,
            None,
            &body,
        )
        .await
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Sync Events + Snapshots
    // ─────────────────────────────────────────────────────────────────────────

    /// Push local outbox events.
    ///
    /// POST /api/v1/sync/events/push
    pub async fn push_events(
        &self,
        token: &str,
        device_id: &str,
        req: SyncPushRequest,
    ) -> Result<SyncPushResponse> {
        self.send_json_body(
            Method::POST,
            "/api/v1/sync/events/push".to_string(),
            token,
            Some(device_id),
            &req,
        )
        .await
    }

    /// Pull remote events after a cursor.
    ///
    /// GET /api/v1/sync/events/pull?since={cursor}&limit={n}
    pub async fn pull_events(
        &self,
        token: &str,
        device_id: &str,
        since: Option<i64>,
        limit: Option<i32>,
    ) -> Result<SyncPullResponse> {
        let mut path = "/api/v1/sync/events/pull".to_string();
        let mut query = Vec::new();
        if let Some(value) = since {
            query.push(format!("since={}", value));
        }
        if let Some(value) = limit {
            query.push(format!("limit={}", value));
        }
        if !query.is_empty() {
            path = format!("{}?{}", path, query.join("&"));
        }

        self.send_json_no_body(Method::GET, path, token, Some(device_id))
            .await
    }

    /// Get the reconcile-ready-state for this device.
    ///
    /// GET /api/v1/sync/events/reconcile-ready-state
    pub async fn get_reconcile_ready_state(
        &self,
        token: &str,
        device_id: &str,
    ) -> Result<ReconcileReadyStateResponse> {
        self.send_json_no_body(
            Method::GET,
            "/api/v1/sync/events/reconcile-ready-state".to_string(),
            token,
            Some(device_id),
        )
        .await
    }

    /// Get lightweight current server cursor.
    ///
    /// GET /api/v1/sync/events/cursor
    pub async fn get_events_cursor(
        &self,
        token: &str,
        device_id: &str,
    ) -> Result<SyncCursorResponse> {
        self.send_json_no_body(
            Method::GET,
            "/api/v1/sync/events/cursor".to_string(),
            token,
            Some(device_id),
        )
        .await
    }

    /// Get metadata for the latest available snapshot.
    ///
    /// GET /api/v1/sync/snapshots/latest
    pub async fn get_latest_snapshot(
        &self,
        token: &str,
        device_id: &str,
    ) -> Result<SnapshotLatestResponse> {
        self.send_json_no_body(
            Method::GET,
            "/api/v1/sync/snapshots/latest".to_string(),
            token,
            Some(device_id),
        )
        .await
    }

    /// Resolve latest snapshot with server-bug fallback to /events/cursor.latest_snapshot.
    pub async fn get_latest_snapshot_with_cursor_fallback(
        &self,
        token: &str,
        device_id: &str,
    ) -> Result<Option<SnapshotLatestResponse>> {
        match self.get_latest_snapshot(token, device_id).await {
            Ok(snapshot) => {
                let snapshot_id = snapshot.snapshot_id.trim();
                if snapshot_id.is_empty() {
                    let cursor = self.get_events_cursor(token, device_id).await?;
                    return Ok(cursor
                        .latest_snapshot
                        .map(Self::snapshot_from_cursor_latest));
                }
                if Self::is_backend_strict_uuid(snapshot_id) {
                    return Ok(Some(snapshot));
                }
                match self.get_events_cursor(token, device_id).await {
                    Ok(cursor) => Ok(Some(Self::choose_snapshot_from_latest_and_cursor(
                        snapshot,
                        cursor.latest_snapshot,
                    ))),
                    Err(err) => {
                        debug!(
                            "Failed to resolve cursor fallback for non-UUID snapshots/latest id '{}': {}. Using snapshots/latest.",
                            snapshot_id, err
                        );
                        Ok(Some(snapshot))
                    }
                }
            }
            Err(err) if err.is_snapshot_id_validation_error() => {
                let cursor = self.get_events_cursor(token, device_id).await?;
                Ok(cursor
                    .latest_snapshot
                    .map(Self::snapshot_from_cursor_latest))
            }
            Err(err) => Err(err),
        }
    }

    async fn upload_snapshot_direct<F, Fut>(
        &self,
        token: &F,
        device: &str,
        headers: &SnapshotUploadHeaders,
        bytes: Vec<u8>,
        cancel_flag: Option<&AtomicBool>,
    ) -> Result<SnapshotUploadResponse>
    where
        F: Fn() -> Fut,
        Fut: std::future::Future<Output = Result<String>>,
    {
        #[derive(Deserialize)]
        struct Prepared {
            published: Option<SnapshotUploadResponse>,
            ticket: Option<String>,
            transfer: Option<TransferDescriptor>,
        }
        let check_cancel = || {
            if cancel_flag.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
                Err(DeviceSyncError::invalid_request(
                    "Snapshot upload cancelled",
                ))
            } else {
                Ok(())
            }
        };
        check_cancel()?;
        let snapshot_seq = headers
            .base_seq
            .filter(|seq| *seq >= 0)
            .ok_or_else(|| DeviceSyncError::invalid_request("Snapshot cursor unavailable"))?;
        let input = serde_json::json!({ "event_id": headers.event_id, "snapshot_seq": snapshot_seq, "schema_version": headers.schema_version, "size_bytes": headers.size_bytes, "checksum": headers.checksum, "metadata_payload": headers.metadata_payload, "payload_key_version": headers.payload_key_version });
        let mut attempt = 0usize;
        let prepared: Prepared = loop {
            check_cancel()?;
            attempt += 1;
            let access_token = token().await?;
            check_cancel()?;
            match self
                .send_json_body(
                    Method::POST,
                    "/api/v1/sync/snapshots/prepare-upload".into(),
                    &access_token,
                    Some(device),
                    &input,
                )
                .await
            {
                Ok(prepared) => break prepared,
                Err(error) => {
                    let retryable = match &error {
                        DeviceSyncError::Api {
                            status,
                            code,
                            message,
                            ..
                        } => is_retryable_snapshot_error(*status, Some(code), Some(message)),
                        DeviceSyncError::Http(error) => is_retryable_transport_error(error),
                        _ => false,
                    };
                    if !retryable || attempt >= SNAPSHOT_UPLOAD_MAX_ATTEMPTS {
                        return Err(error);
                    }
                    sleep(snapshot_backoff_with_jitter(attempt)).await;
                }
            }
        };
        if let Some(published) = prepared.published {
            return Ok(published);
        }
        let ticket = prepared
            .ticket
            .ok_or_else(|| DeviceSyncError::invalid_request("Missing transfer ticket"))?;
        let transfer = prepared
            .transfer
            .ok_or_else(|| DeviceSyncError::invalid_request("Missing transfer descriptor"))?;
        check_cancel()?;
        // Resolve completion even after a lost PUT response; publication stays idempotent.
        let put = match ConnectTransferTransport::configured()?
            .upload(&transfer, bytes)
            .await
        {
            // No request was sent when local validation rejected the descriptor.
            Err(error @ DeviceSyncError::InvalidRequest(_)) => return Err(error),
            result => result,
        };
        self.complete_snapshot_upload(token, device, &ticket, put, cancel_flag)
            .await
    }

    async fn complete_snapshot_upload<F, Fut>(
        &self,
        token: &F,
        device: &str,
        ticket: &str,
        put: Result<()>,
        cancel_flag: Option<&AtomicBool>,
    ) -> Result<SnapshotUploadResponse>
    where
        F: Fn() -> Fut,
        Fut: std::future::Future<Output = Result<String>>,
    {
        let mut last = None;
        for attempt in 0..3 {
            if cancel_flag.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
                return Err(DeviceSyncError::invalid_request(
                    "Snapshot upload cancelled",
                ));
            }
            let access_token = token().await?;
            if cancel_flag.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
                return Err(DeviceSyncError::invalid_request(
                    "Snapshot upload cancelled",
                ));
            }
            match self
                .send_json_body(
                    Method::POST,
                    "/api/v1/sync/snapshots/complete-upload".into(),
                    &access_token,
                    Some(device),
                    &serde_json::json!({ "ticket": ticket }),
                )
                .await
            {
                Ok(result) => return Ok(result),
                Err(error) => {
                    if error.error_code() == Some("TRANSFER_OBJECT_MISSING") {
                        return Err(put.err().unwrap_or(error));
                    }
                    if error
                        .status_code()
                        .is_some_and(|status| status < 500 && !matches!(status, 408 | 429))
                    {
                        return Err(error);
                    }
                    last = Some(error);
                    if attempt < 2 {
                        sleep(snapshot_backoff_with_jitter(attempt + 1)).await;
                    }
                }
            }
        }
        Err(last.expect("completion failed"))
    }
    /// Authorize and download an encrypted snapshot directly from Connect storage.
    ///
    /// POST /api/v1/sync/snapshots/{snapshotId}/download-url
    pub async fn download_snapshot(
        &self,
        token: &str,
        device_id: &str,
        snapshot_id: &str,
    ) -> Result<(SnapshotDownloadHeaders, Vec<u8>)> {
        #[derive(Deserialize)]
        struct Download {
            transfer: TransferDescriptor,
            snapshot: SnapshotLatestResponse,
        }
        uuid::Uuid::parse_str(snapshot_id)
            .map_err(|_| DeviceSyncError::invalid_request("Invalid snapshot ID"))?;
        let result: Download = self
            .send_json_body(
                Method::POST,
                format!("/api/v1/sync/snapshots/{snapshot_id}/download-url"),
                token,
                Some(device_id),
                &serde_json::json!({}),
            )
            .await?;
        if result.snapshot.snapshot_id != snapshot_id {
            return Err(DeviceSyncError::invalid_request("Transfer object mismatch"));
        }
        let bytes = ConnectTransferTransport::configured()?
            .download(
                &result.transfer,
                usize::try_from(result.snapshot.size_bytes)
                    .map_err(|_| DeviceSyncError::invalid_request("Transfer size invalid"))?,
                &result.snapshot.checksum,
            )
            .await?;
        Ok((
            SnapshotDownloadHeaders {
                schema_version: result.snapshot.schema_version,
                covers_tables: result.snapshot.covers_tables,
                checksum: result.snapshot.checksum,
            },
            bytes,
        ))
    }

    /// Upload a snapshot blob.
    ///
    /// Prepare, upload encrypted bytes to Connect storage, and complete idempotent publication:
    /// - validates size/checksum against payload bytes
    /// - reuses the same event ID across retries
    /// - retries transient/unknown-outcome failures with exponential backoff + jitter
    ///
    /// POST /api/v1/sync/snapshots/prepare-upload and complete-upload
    #[cfg(test)]
    async fn upload_snapshot(
        &self,
        token: &str,
        device_id: &str,
        upload_headers: SnapshotUploadHeaders,
        payload: Vec<u8>,
    ) -> Result<SnapshotUploadResponse> {
        self.upload_snapshot_with_cancel_flag(
            || std::future::ready(Ok(token.to_string())),
            device_id,
            upload_headers,
            payload,
            None,
        )
        .await
    }

    /// Upload a snapshot blob with cooperative cancellation support.
    pub async fn upload_snapshot_with_cancel_flag<F, Fut>(
        &self,
        token: F,
        device_id: &str,
        mut upload_headers: SnapshotUploadHeaders,
        payload: Vec<u8>,
        cancel_flag: Option<&AtomicBool>,
    ) -> Result<SnapshotUploadResponse>
    where
        F: Fn() -> Fut,
        Fut: std::future::Future<Output = Result<String>>,
    {
        if payload.len() > i64::MAX as usize {
            return Err(DeviceSyncError::invalid_request(
                "Snapshot payload is too large for size header",
            ));
        }
        let payload_size = payload.len() as i64;
        if upload_headers.size_bytes != payload_size {
            return Err(DeviceSyncError::invalid_request(format!(
                "Snapshot size header mismatch: header={} payload={}",
                upload_headers.size_bytes, payload_size
            )));
        }
        if !is_valid_sha256_checksum(&upload_headers.checksum) {
            return Err(DeviceSyncError::invalid_request(
                "Invalid snapshot checksum format; expected sha256:<hex>",
            ));
        }
        let computed_checksum = compute_sha256_checksum(&payload);
        if !upload_headers
            .checksum
            .eq_ignore_ascii_case(&computed_checksum)
        {
            return Err(DeviceSyncError::invalid_request(
                "Snapshot checksum does not match payload bytes",
            ));
        }
        upload_headers.checksum = computed_checksum.to_ascii_lowercase();

        let stable_event_id = match upload_headers.event_id.take() {
            Some(value) => {
                Uuid::parse_str(&value)
                    .map_err(|_| DeviceSyncError::invalid_request("Invalid snapshot event ID"))?;
                value
            }
            None => Uuid::new_v4().to_string(),
        };
        upload_headers.event_id = Some(stable_event_id.clone());

        let dedupe_key = format!(
            "{}:{}",
            device_id,
            upload_headers
                .event_id
                .as_deref()
                .unwrap_or("missing_snapshot_event_id")
        );
        {
            let mut in_flight = snapshot_upload_in_flight().lock().await;
            if !in_flight.insert(dedupe_key.clone()) {
                return Err(DeviceSyncError::invalid_request(
                    "Snapshot upload already in progress for this snapshot event",
                ));
            }
        }

        let result = self
            .upload_snapshot_direct(&token, device_id, &upload_headers, payload, cancel_flag)
            .await;

        let mut in_flight = snapshot_upload_in_flight().lock().await;
        in_flight.remove(&dedupe_key);
        result
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Pairing
    // ─────────────────────────────────────────────────────────────────────────

    /// Create a new pairing session (trusted device side).
    ///
    /// POST /api/v1/sync/team/devices/{deviceId}/pairings
    pub async fn create_pairing(
        &self,
        token: &str,
        device_id: &str,
        req: CreatePairingRequest,
    ) -> Result<CreatePairingResponse> {
        self.send_json_body(
            Method::POST,
            format!("/api/v1/sync/team/devices/{}/pairings", device_id),
            token,
            Some(device_id),
            &req,
        )
        .await
    }

    /// Get pairing session details.
    ///
    /// GET /api/v1/sync/team/devices/{deviceId}/pairings/{pairingId}
    pub async fn get_pairing(
        &self,
        token: &str,
        device_id: &str,
        pairing_id: &str,
    ) -> Result<GetPairingResponse> {
        self.send_json_no_body(
            Method::GET,
            format!(
                "/api/v1/sync/team/devices/{}/pairings/{}",
                device_id, pairing_id
            ),
            token,
            Some(device_id),
        )
        .await
    }

    /// Approve a pairing session.
    ///
    /// POST /api/v1/sync/team/devices/{deviceId}/pairings/{pairingId}/approve
    pub async fn approve_pairing(
        &self,
        token: &str,
        device_id: &str,
        pairing_id: &str,
    ) -> Result<SuccessResponse> {
        self.send_json_no_body(
            Method::POST,
            format!(
                "/api/v1/sync/team/devices/{}/pairings/{}/approve",
                device_id, pairing_id
            ),
            token,
            Some(device_id),
        )
        .await
    }

    /// Complete a pairing session with key bundle.
    ///
    /// POST /api/v1/sync/team/devices/{deviceId}/pairings/{pairingId}/complete
    pub async fn complete_pairing(
        &self,
        token: &str,
        device_id: &str,
        pairing_id: &str,
        req: CompletePairingRequest,
    ) -> Result<CompletePairingResponse> {
        self.send_json_body(
            Method::POST,
            format!(
                "/api/v1/sync/team/devices/{}/pairings/{}/complete",
                device_id, pairing_id
            ),
            token,
            Some(device_id),
            &req,
        )
        .await
    }

    /// Cancel a pairing session.
    ///
    /// POST /api/v1/sync/team/devices/{deviceId}/pairings/{pairingId}/cancel
    pub async fn cancel_pairing(
        &self,
        token: &str,
        device_id: &str,
        pairing_id: &str,
    ) -> Result<SuccessResponse> {
        self.send_json_no_body(
            Method::POST,
            format!(
                "/api/v1/sync/team/devices/{}/pairings/{}/cancel",
                device_id, pairing_id
            ),
            token,
            Some(device_id),
        )
        .await
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Claimer-Side Pairing (New Device)
    // ─────────────────────────────────────────────────────────────────────────

    /// Claim a pairing session using the code displayed on the issuer device.
    ///
    /// This is called by the claimer (new device) to join a pairing session.
    /// Returns the issuer's ephemeral public key for deriving the shared secret.
    ///
    /// POST /api/v1/sync/team/devices/{claimerDeviceId}/pairings/claim
    pub async fn claim_pairing(
        &self,
        token: &str,
        claimer_device_id: &str,
        req: ClaimPairingRequest,
    ) -> Result<ClaimPairingResponse> {
        self.send_json_body(
            Method::POST,
            format!(
                "/api/v1/sync/team/devices/{}/pairings/claim",
                claimer_device_id
            ),
            token,
            Some(claimer_device_id),
            &req,
        )
        .await
    }

    /// Poll for messages/key bundle from the issuer (claimer side).
    ///
    /// The claimer polls this endpoint to receive the encrypted RK bundle
    /// from the issuer after they complete the pairing.
    ///
    /// GET /api/v1/sync/team/devices/{claimerDeviceId}/pairings/{pairingId}/messages
    pub async fn get_pairing_messages(
        &self,
        token: &str,
        claimer_device_id: &str,
        pairing_id: &str,
    ) -> Result<PairingMessagesResponse> {
        self.send_json_no_body(
            Method::GET,
            format!(
                "/api/v1/sync/team/devices/{}/pairings/{}/messages",
                claimer_device_id, pairing_id
            ),
            token,
            Some(claimer_device_id),
        )
        .await
    }

    /// Confirm pairing and become trusted (claimer side).
    ///
    /// This is the final step in the pairing flow. After successfully
    /// decrypting the RK bundle, the claimer calls this to confirm and
    /// be marked as trusted.
    ///
    /// POST /api/v1/sync/team/devices/{claimerDeviceId}/pairings/{pairingId}/confirm
    pub async fn confirm_pairing(
        &self,
        token: &str,
        claimer_device_id: &str,
        pairing_id: &str,
        req: ConfirmPairingRequest,
    ) -> Result<ConfirmPairingResponse> {
        self.send_json_body(
            Method::POST,
            format!(
                "/api/v1/sync/team/devices/{}/pairings/{}/confirm",
                claimer_device_id, pairing_id
            ),
            token,
            Some(claimer_device_id),
            &req,
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, VecDeque};
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::sync::Mutex as TokioMutex;

    fn latest_snapshot(snapshot_id: &str, oplog_seq: i64) -> SnapshotLatestResponse {
        SnapshotLatestResponse {
            snapshot_id: snapshot_id.to_string(),
            schema_version: 1,
            covers_tables: Vec::new(),
            oplog_seq,
            size_bytes: 0,
            checksum: String::new(),
            created_at: String::new(),
        }
    }

    fn cursor_snapshot(snapshot_id: &str, oplog_seq: i64) -> SyncLatestSnapshotRef {
        SyncLatestSnapshotRef {
            snapshot_id: snapshot_id.to_string(),
            schema_version: 1,
            oplog_seq,
        }
    }

    #[derive(Debug, Clone)]
    struct CapturedUploadRequest {
        authorization: Option<String>,
        event_id: Option<String>,
        client_request_id: Option<String>,
        request_id: Option<String>,
        device_id: Option<String>,
        path: String,
        input: serde_json::Value,
    }

    #[derive(Debug, Clone)]
    enum MockUploadOutcome {
        DropConnection,
        Respond {
            status: u16,
            body: String,
            delay_ms: u64,
        },
    }

    fn success_upload_body(snapshot_id: &str) -> String {
        serde_json::json!({ "published": {
            "snapshot_id": snapshot_id,
            "r2_key": format!("snapshots/test/{snapshot_id}"),
            "oplog_seq": 123,
            "created_at": "2026-01-01T00:00:00.000Z"
        }})
        .to_string()
    }

    fn api_error_body(code: &str, message: &str) -> String {
        format!(
            r#"{{"error":"error","code":"{}","message":"{}"}}"#,
            code, message
        )
    }

    fn build_upload_headers(event_id: Option<String>, payload: &[u8]) -> SnapshotUploadHeaders {
        SnapshotUploadHeaders {
            event_id,
            schema_version: 1,
            size_bytes: payload.len() as i64,
            checksum: compute_sha256_checksum(payload),
            metadata_payload: "meta".to_string(),
            payload_key_version: 1,
            base_seq: Some(0),
        }
    }

    fn header_end_offset(buffer: &[u8]) -> Option<usize> {
        buffer.windows(4).position(|window| window == b"\r\n\r\n")
    }

    async fn read_http_request(
        stream: &mut tokio::net::TcpStream,
    ) -> Option<(HashMap<String, String>, String, serde_json::Value)> {
        let mut buffer = Vec::new();
        loop {
            let mut chunk = [0_u8; 2048];
            let read = stream.read(&mut chunk).await.ok()?;
            if read == 0 {
                return None;
            }
            buffer.extend_from_slice(&chunk[..read]);
            if header_end_offset(&buffer).is_some() {
                break;
            }
        }

        let header_end = header_end_offset(&buffer)?;
        let head = String::from_utf8_lossy(&buffer[..header_end]).to_string();
        let mut lines = head.lines();
        let request_line = lines.next()?.to_string();
        let path = request_line.split_whitespace().nth(1)?.to_string();

        let mut headers = HashMap::new();
        for line in lines {
            if let Some((name, value)) = line.split_once(':') {
                headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
            }
        }

        let content_length = headers
            .get("content-length")
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or(0);

        let mut body_read = buffer.len().saturating_sub(header_end + 4);
        while body_read < content_length {
            let mut chunk = [0_u8; 2048];
            let read = stream.read(&mut chunk).await.ok()?;
            if read == 0 {
                break;
            }
            body_read = body_read.saturating_add(read);
            buffer.extend_from_slice(&chunk[..read]);
        }

        let body = &buffer[header_end + 4..];
        let input = serde_json::from_slice(body).unwrap_or(serde_json::Value::Null);
        Some((headers, path, input))
    }

    fn status_text(status: u16) -> &'static str {
        match status {
            200 => "OK",
            201 => "Created",
            400 => "Bad Request",
            408 => "Request Timeout",
            429 => "Too Many Requests",
            500 => "Internal Server Error",
            _ => "Error",
        }
    }

    async fn write_http_response(
        stream: &mut tokio::net::TcpStream,
        status: u16,
        body: &str,
    ) -> std::io::Result<()> {
        let response = format!(
            "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            status,
            status_text(status),
            body.len(),
            body
        );
        stream.write_all(response.as_bytes()).await?;
        stream.flush().await
    }

    async fn start_mock_upload_server(
        outcomes: Vec<MockUploadOutcome>,
    ) -> (
        String,
        Arc<TokioMutex<Vec<CapturedUploadRequest>>>,
        tokio::task::JoinHandle<()>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test listener");
        let addr = listener.local_addr().expect("listener addr");
        let captured = Arc::new(TokioMutex::new(Vec::<CapturedUploadRequest>::new()));
        let scripted = Arc::new(TokioMutex::new(VecDeque::from(outcomes)));
        let captured_clone = Arc::clone(&captured);
        let scripted_clone = Arc::clone(&scripted);

        let handle = tokio::spawn(async move {
            loop {
                let (mut stream, _) = match listener.accept().await {
                    Ok(value) => value,
                    Err(_) => break,
                };
                let captured_inner = Arc::clone(&captured_clone);
                let scripted_inner = Arc::clone(&scripted_clone);
                tokio::spawn(async move {
                    let Some((headers, path, input)) = read_http_request(&mut stream).await else {
                        return;
                    };
                    let event_id = input
                        .get("event_id")
                        .and_then(|v| v.as_str())
                        .map(str::to_string);
                    let client_request_id = headers.get(CLIENT_REQUEST_ID_HEADER).cloned();
                    let request_id = headers.get(SERVER_REQUEST_ID_HEADER).cloned();
                    let device_id = headers.get("x-wf-device-id").cloned();

                    captured_inner.lock().await.push(CapturedUploadRequest {
                        authorization: headers.get("authorization").cloned(),
                        event_id,
                        client_request_id,
                        request_id,
                        device_id,
                        path,
                        input,
                    });

                    let outcome = scripted_inner.lock().await.pop_front().unwrap_or(
                        MockUploadOutcome::Respond {
                            status: 500,
                            body: api_error_body("INTERNAL", "unexpected request"),
                            delay_ms: 0,
                        },
                    );

                    match outcome {
                        MockUploadOutcome::DropConnection => {}
                        MockUploadOutcome::Respond {
                            status,
                            body,
                            delay_ms,
                        } => {
                            if delay_ms > 0 {
                                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                            }
                            let _ = write_http_response(&mut stream, status, &body).await;
                        }
                    }
                });
            }
        });

        (format!("http://{}", addr), captured, handle)
    }

    #[test]
    fn choose_snapshot_prefers_cursor_when_latest_id_is_non_uuid_and_cursor_is_uuid() {
        let latest = latest_snapshot("snap-legacy-id", 100);
        let cursor = cursor_snapshot("019bb9fe-f707-71e9-a40d-733575f4f246", 90);

        let selected =
            DeviceSyncClient::choose_snapshot_from_latest_and_cursor(latest, Some(cursor));
        assert_eq!(selected.snapshot_id, "019bb9fe-f707-71e9-a40d-733575f4f246");
    }

    #[test]
    fn choose_snapshot_prefers_higher_oplog_seq_from_cursor() {
        let latest = latest_snapshot("019bb9fe-f707-71e9-a40d-733575f4f246", 100);
        let cursor = cursor_snapshot("019bb9fe-f707-71e9-a40d-733575f4f247", 120);

        let selected =
            DeviceSyncClient::choose_snapshot_from_latest_and_cursor(latest, Some(cursor));
        assert_eq!(selected.snapshot_id, "019bb9fe-f707-71e9-a40d-733575f4f247");
    }

    #[test]
    fn choose_snapshot_keeps_latest_when_cursor_missing() {
        let latest = latest_snapshot("019bb9fe-f707-71e9-a40d-733575f4f246", 100);

        let selected = DeviceSyncClient::choose_snapshot_from_latest_and_cursor(latest, None);
        assert_eq!(selected.snapshot_id, "019bb9fe-f707-71e9-a40d-733575f4f246");
    }

    #[test]
    fn fallback_error_preserves_snapshot_validation_body_with_metadata() {
        let context = CloudRequestContext::new(
            "GET",
            "/api/v1/sync/snapshots/not-a-uuid",
            Some("019bb9fe-f707-71e9-a40d-733575f4f246"),
        );
        let body = r#"{"path":["snapshotId"],"message":"Invalid UUID"}"#;
        let err = DeviceSyncError::api(
            400,
            with_request_metadata(
                fallback_api_error_message(body),
                &context,
                Some("server-req-1"),
            ),
        );

        assert!(err.is_snapshot_id_validation_error());
    }

    // Shorten the client's ordinary deadline so these tests exercise the real
    // control requests without waiting 30 seconds. Encrypted transfers use their own client.
    fn client_with_short_timeout(base_url: &str) -> DeviceSyncClient {
        DeviceSyncClient {
            client: wealthfolio_http::client_builder()
                .no_proxy()
                .timeout(Duration::from_millis(50))
                .build()
                .unwrap(),
            base_url: base_url.to_string(),
        }
    }

    #[tokio::test]
    async fn snapshot_download_uses_signed_route_without_negotiation_or_fallback() {
        let snapshot_id = Uuid::new_v4().to_string();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut data = vec![0; 4096];
            let count = stream.read(&mut data).await.unwrap();
            let request = String::from_utf8_lossy(&data[..count]).to_string();
            write_http_response(
                &mut stream,
                404,
                &api_error_body("TRANSFER_OBJECT_MISSING", "missing"),
            )
            .await
            .unwrap();
            request
        });
        let result = DeviceSyncClient::new(&base_url)
            .download_snapshot("token", "device", &snapshot_id)
            .await;
        assert_eq!(result.unwrap_err().status_code(), Some(404));
        let request = server.await.unwrap();
        assert!(
            request.starts_with(&format!(
                "POST /api/v1/sync/snapshots/{snapshot_id}/download-url "
            )),
            "{request}"
        );
    }

    #[tokio::test]
    async fn snapshot_download_does_not_fallback_on_authorization_or_integrity_errors() {
        for (status, code) in [(403, "DEVICE_UNTRUSTED"), (409, "TRANSFER_SIZE_MISMATCH")] {
            let (base_url, captured, server) =
                start_mock_upload_server(vec![MockUploadOutcome::Respond {
                    status,
                    body: api_error_body(code, "rejected"),
                    delay_ms: 0,
                }])
                .await;
            let id = Uuid::new_v4().to_string();
            let result = DeviceSyncClient::new(&base_url)
                .download_snapshot("token", "device", &id)
                .await;
            assert_eq!(result.unwrap_err().error_code(), Some(code));
            let requests = captured.lock().await;
            assert_eq!(requests.len(), 1);
            assert_eq!(
                requests[0].path,
                format!("/api/v1/sync/snapshots/{id}/download-url")
            );
            server.abort();
        }
    }

    #[tokio::test]
    async fn snapshot_upload_does_not_fallback_on_missing_route_or_rejection() {
        for (status, code) in [
            (404, "NOT_FOUND"),
            (403, "DEVICE_UNTRUSTED"),
            (409, "TRANSFER_CHECKSUM_MISMATCH"),
        ] {
            let (base_url, captured, server) =
                start_mock_upload_server(vec![MockUploadOutcome::Respond {
                    status,
                    body: api_error_body(code, "rejected"),
                    delay_ms: 0,
                }])
                .await;
            let bytes = b"encrypted snapshot".to_vec();
            let result = DeviceSyncClient::new(&base_url)
                .upload_snapshot("token", "device", build_upload_headers(None, &bytes), bytes)
                .await;
            assert_eq!(result.unwrap_err().error_code(), Some(code));
            let requests = captured.lock().await;
            assert_eq!(requests.len(), 1);
            assert_eq!(requests[0].path, "/api/v1/sync/snapshots/prepare-upload");
            server.abort();
        }
    }

    #[tokio::test]
    async fn snapshot_upload_local_validation_failure_does_not_attempt_completion() {
        let bytes = b"encrypted snapshot".to_vec();
        let prepared = serde_json::json!({
            "ticket": "opaque-ticket",
            "transfer": {
                "url": "https://unapproved.invalid/object",
                "method": "PUT",
                "headers": {"content-length": bytes.len().to_string()},
                "expires_at": (chrono::Utc::now() + chrono::Duration::minutes(1)).to_rfc3339(),
            }
        });
        let (base_url, captured, server) = start_mock_upload_server(vec![
            MockUploadOutcome::Respond {
                status: 200,
                body: prepared.to_string(),
                delay_ms: 0,
            },
            MockUploadOutcome::Respond {
                status: 403,
                body: api_error_body("REJECTED", "unexpected completion"),
                delay_ms: 0,
            },
        ])
        .await;
        let result = DeviceSyncClient::new(&base_url)
            .upload_snapshot("token", "device", build_upload_headers(None, &bytes), bytes)
            .await;
        assert!(
            matches!(result, Err(DeviceSyncError::InvalidRequest(message)) if message == "Unapproved transfer destination" || message == "Connect transfer destinations are not configured in this build")
        );
        assert_eq!(captured.lock().await.len(), 1);
        server.abort();
    }

    #[tokio::test]
    async fn snapshot_api_phases_and_retries_acquire_current_credentials() {
        use std::sync::atomic::AtomicUsize;
        let (url, captured, server) = start_mock_upload_server(vec![
            MockUploadOutcome::Respond {
                status: 503,
                body: api_error_body("UNAVAILABLE", "retry"),
                delay_ms: 0,
            },
            MockUploadOutcome::Respond {
                status: 200,
                body: success_upload_body("already-published"),
                delay_ms: 0,
            },
            MockUploadOutcome::Respond {
                status: 503,
                body: api_error_body("UNAVAILABLE", "retry"),
                delay_ms: 0,
            },
            MockUploadOutcome::Respond {
                status: 200,
                body: serde_json::from_str::<serde_json::Value>(&success_upload_body("published"))
                    .unwrap()["published"]
                    .to_string(),
                delay_ms: 0,
            },
        ])
        .await;
        let calls = AtomicUsize::new(0);
        let token = || {
            std::future::ready(Ok(format!(
                "current-{}",
                calls.fetch_add(1, Ordering::SeqCst)
            )))
        };
        let client = DeviceSyncClient::new(&url);
        let payload = b"encrypted".to_vec();
        client
            .upload_snapshot_with_cancel_flag(
                &token,
                "device",
                build_upload_headers(None, &payload),
                payload,
                None,
            )
            .await
            .unwrap();
        // Simulate the transfer boundary: the first two credentials have expired.
        // Completion must resolve publication with the same ticket, without a new prepare/export.
        let result = client
            .complete_snapshot_upload(
                &token,
                "device",
                "same-attempt",
                Err(DeviceSyncError::api(503, "lost upload response")),
                None,
            )
            .await
            .unwrap();
        assert_eq!(result.snapshot_id, "published");
        let requests = captured.lock().await;
        assert_eq!(
            requests
                .iter()
                .map(|r| r.authorization.as_deref().unwrap())
                .collect::<Vec<_>>(),
            [
                "Bearer current-0",
                "Bearer current-1",
                "Bearer current-2",
                "Bearer current-3"
            ]
        );
        assert_eq!(requests[0].event_id, requests[1].event_id);
        assert_eq!(requests[2].input, requests[3].input);
        assert_eq!(requests[2].input["ticket"], "same-attempt");
        server.abort();
    }

    #[tokio::test]
    async fn snapshot_session_revocation_or_cancellation_during_refresh_prevents_publication() {
        let (url, captured, server) = start_mock_upload_server(vec![]).await;
        let client = DeviceSyncClient::new(&url);
        let revoked = || std::future::ready(Err(DeviceSyncError::Auth("Session ended".into())));
        assert!(matches!(
            client
                .complete_snapshot_upload(&revoked, "device", "attempt", Ok(()), None)
                .await,
            Err(DeviceSyncError::Auth(_))
        ));
        let cancelled = AtomicBool::new(false);
        let token = || {
            cancelled.store(true, Ordering::Relaxed);
            std::future::ready(Ok("current".into()))
        };
        assert!(client
            .complete_snapshot_upload(&token, "device", "attempt", Ok(()), Some(&cancelled))
            .await
            .unwrap_err()
            .to_string()
            .contains("cancelled"));
        assert!(captured.lock().await.is_empty());
        server.abort();
    }

    #[tokio::test]
    async fn snapshot_upload_cancellation_prevents_preparation() {
        let (base_url, captured, server) = start_mock_upload_server(vec![]).await;
        let bytes = b"encrypted snapshot".to_vec();
        let cancelled = AtomicBool::new(true);
        let result = DeviceSyncClient::new(&base_url)
            .upload_snapshot_with_cancel_flag(
                || std::future::ready(Ok("token".into())),
                "device",
                build_upload_headers(None, &bytes),
                bytes,
                Some(&cancelled),
            )
            .await;
        assert!(
            matches!(result, Err(DeviceSyncError::InvalidRequest(message)) if message.contains("cancelled"))
        );
        assert!(captured.lock().await.is_empty());
        server.abort();
    }

    #[tokio::test]
    async fn snapshot_upload_rejects_unknown_cursor_without_network() {
        let (base_url, captured, server) =
            start_mock_upload_server(vec![MockUploadOutcome::Respond {
                status: 201,
                body: success_upload_body("unused"),
                delay_ms: 0,
            }])
            .await;
        let payload = b"snapshot".to_vec();
        let mut headers = build_upload_headers(None, &payload);
        headers.base_seq = None;
        let result = DeviceSyncClient::new(&base_url)
            .upload_snapshot("token", "device", headers, payload)
            .await;
        assert!(
            matches!(result, Err(DeviceSyncError::InvalidRequest(message)) if message.contains("cursor unavailable"))
        );
        assert!(captured.lock().await.is_empty());
        server.abort();
    }
    #[tokio::test]
    async fn ordinary_api_request_keeps_client_timeout() {
        let (base_url, _, server) = start_mock_upload_server(vec![MockUploadOutcome::Respond {
            status: 200,
            body: r#"{"cursor":0}"#.to_string(),
            delay_ms: 200,
        }])
        .await;
        let result = client_with_short_timeout(&base_url)
            .get_events_cursor("token", "device")
            .await;
        server.abort();
        assert!(matches!(result, Err(DeviceSyncError::Http(err)) if err.is_timeout()));
    }

    #[tokio::test]
    async fn snapshot_upload_retry_reuses_same_generated_event_id() {
        let (base_url, captured, server) = start_mock_upload_server(vec![
            MockUploadOutcome::Respond {
                status: 500,
                body: api_error_body("INTERNAL", "retry please"),
                delay_ms: 0,
            },
            MockUploadOutcome::Respond {
                status: 201,
                body: success_upload_body("snap-1"),
                delay_ms: 0,
            },
        ])
        .await;

        let client = DeviceSyncClient::new(&base_url);
        let payload = b"snapshot-payload".to_vec();
        let result = client
            .upload_snapshot(
                "token",
                "019bb9fe-f707-71e9-a40d-733575f4f246",
                build_upload_headers(None, &payload),
                payload,
            )
            .await
            .expect("upload success");

        assert_eq!(result.snapshot_id, "snap-1");
        let requests = captured.lock().await.clone();
        assert_eq!(requests.len(), 2);
        let first_id = requests[0].event_id.clone().expect("first event id");
        let second_id = requests[1].event_id.clone().expect("second event id");
        assert_eq!(first_id, second_id);
        assert!(Uuid::parse_str(&first_id).is_ok());
        let first_client_request_id = requests[0]
            .client_request_id
            .clone()
            .expect("first client request id");
        let second_client_request_id = requests[1]
            .client_request_id
            .clone()
            .expect("second client request id");
        assert!(first_client_request_id.starts_with("019bb9fe-f707-71e9-a40d-733575f4f246:"));
        assert!(second_client_request_id.starts_with("019bb9fe-f707-71e9-a40d-733575f4f246:"));
        assert!(is_log_safe_request_id(&first_client_request_id));
        assert!(is_log_safe_request_id(&second_client_request_id));
        assert_ne!(first_client_request_id, second_client_request_id);
        assert_eq!(
            requests[0].device_id.as_deref(),
            Some("019bb9fe-f707-71e9-a40d-733575f4f246")
        );
        assert!(requests[0].request_id.is_none());
        for request in &requests {
            assert_eq!(request.path, "/api/v1/sync/snapshots/prepare-upload");
            assert!(request.input["size_bytes"].as_i64().unwrap() > 0);
            assert!(request.input.get("covers_tables").is_none());
        }

        server.abort();
    }

    #[tokio::test]
    async fn snapshot_upload_retries_unknown_outcome_with_same_event_id() {
        let stable_event_id = Uuid::new_v4().to_string();
        let (base_url, captured, server) = start_mock_upload_server(vec![
            MockUploadOutcome::DropConnection,
            MockUploadOutcome::Respond {
                status: 201,
                body: success_upload_body("snap-2"),
                delay_ms: 0,
            },
        ])
        .await;

        let client = DeviceSyncClient::new(&base_url);
        let payload = b"snapshot-payload-unknown".to_vec();
        let result = client
            .upload_snapshot(
                "token",
                "019bb9fe-f707-71e9-a40d-733575f4f246",
                build_upload_headers(Some(stable_event_id.clone()), &payload),
                payload,
            )
            .await
            .expect("upload success after retry");

        assert_eq!(result.snapshot_id, "snap-2");
        let requests = captured.lock().await.clone();
        assert_eq!(requests.len(), 2);
        assert_eq!(
            requests[0].event_id.as_deref(),
            Some(stable_event_id.as_str())
        );
        assert_eq!(
            requests[1].event_id.as_deref(),
            Some(stable_event_id.as_str())
        );

        server.abort();
    }

    #[tokio::test]
    async fn snapshot_upload_retries_sync_transaction_failed_code() {
        let (base_url, captured, server) = start_mock_upload_server(vec![
            MockUploadOutcome::Respond {
                status: 400,
                body: api_error_body("SYNC_TRANSACTION_FAILED", "retryable transaction failure"),
                delay_ms: 0,
            },
            MockUploadOutcome::Respond {
                status: 201,
                body: success_upload_body("snap-transaction-retry"),
                delay_ms: 0,
            },
        ])
        .await;

        let client = DeviceSyncClient::new(&base_url);
        let payload = b"snapshot-payload-transaction-retry".to_vec();
        let result = client
            .upload_snapshot(
                "token",
                "019bb9fe-f707-71e9-a40d-733575f4f246",
                build_upload_headers(None, &payload),
                payload,
            )
            .await
            .expect("upload success after retry");

        assert_eq!(result.snapshot_id, "snap-transaction-retry");
        let requests = captured.lock().await.clone();
        assert_eq!(requests.len(), 2);
        let first_id = requests[0].event_id.clone().expect("first event id");
        let second_id = requests[1].event_id.clone().expect("second event id");
        assert_eq!(first_id, second_id);
        assert!(Uuid::parse_str(&first_id).is_ok());
        for request in &requests {
            assert_eq!(request.path, "/api/v1/sync/snapshots/prepare-upload");
            assert!(request.input["size_bytes"].as_i64().unwrap() > 0);
            assert!(request.input.get("covers_tables").is_none());
        }

        server.abort();
    }

    #[tokio::test]
    async fn snapshot_upload_does_not_retry_snapshot_index_conflict() {
        let (base_url, captured, server) = start_mock_upload_server(vec![
            MockUploadOutcome::Respond {
                status: 400,
                body: api_error_body(
                    "SYNC_TRANSACTION_FAILED",
                    "Snapshot index conflict detected. Please retry upload.",
                ),
                delay_ms: 0,
            },
            MockUploadOutcome::Respond {
                status: 201,
                body: success_upload_body("snap-should-not-retry"),
                delay_ms: 0,
            },
        ])
        .await;

        let client = DeviceSyncClient::new(&base_url);
        let payload = b"snapshot-payload-index-conflict".to_vec();
        let result = client
            .upload_snapshot(
                "token",
                "019bb9fe-f707-71e9-a40d-733575f4f246",
                build_upload_headers(None, &payload),
                payload,
            )
            .await;

        assert!(result.is_err());
        let requests = captured.lock().await.clone();
        assert_eq!(requests.len(), 1);

        server.abort();
    }

    #[tokio::test]
    async fn snapshot_upload_accepts_idempotent_200_response() {
        let (base_url, _captured, server) =
            start_mock_upload_server(vec![MockUploadOutcome::Respond {
                status: 200,
                body: success_upload_body("snap-idempotent"),
                delay_ms: 0,
            }])
            .await;

        let client = DeviceSyncClient::new(&base_url);
        let payload = b"snapshot-payload-idempotent".to_vec();
        let result = client
            .upload_snapshot(
                "token",
                "019bb9fe-f707-71e9-a40d-733575f4f246",
                build_upload_headers(None, &payload),
                payload,
            )
            .await
            .expect("idempotent 200 success");

        assert_eq!(result.snapshot_id, "snap-idempotent");
        server.abort();
    }

    #[tokio::test]
    async fn snapshot_upload_blocks_duplicate_concurrent_payload_uploads() {
        let (base_url, captured, server) =
            start_mock_upload_server(vec![MockUploadOutcome::Respond {
                status: 201,
                body: success_upload_body("snap-concurrent"),
                delay_ms: 450,
            }])
            .await;

        let client = DeviceSyncClient::new(&base_url);
        let payload = b"snapshot-concurrency-payload".to_vec();
        let stable_event_id = "019bb9fe-f707-71e9-a40d-733575f4f246".to_string();
        let first_headers = build_upload_headers(Some(stable_event_id.clone()), &payload);
        let second_headers = build_upload_headers(Some(stable_event_id), &payload);

        let client_for_first = client.clone();
        let first_payload = payload.clone();
        let first = tokio::spawn(async move {
            client_for_first
                .upload_snapshot(
                    "token",
                    "019bb9fe-f707-71e9-a40d-733575f4f246",
                    first_headers,
                    first_payload,
                )
                .await
        });

        tokio::time::sleep(Duration::from_millis(80)).await;
        let second = client
            .upload_snapshot(
                "token",
                "019bb9fe-f707-71e9-a40d-733575f4f246",
                second_headers,
                payload,
            )
            .await;

        match second {
            Err(DeviceSyncError::InvalidRequest(message)) => {
                assert!(message.contains("already in progress"));
            }
            other => panic!("expected duplicate-in-flight guard error, got {:?}", other),
        }

        let first_result = first
            .await
            .expect("first task join")
            .expect("first upload ok");
        assert_eq!(first_result.snapshot_id, "snap-concurrent");
        let requests = captured.lock().await.clone();
        assert_eq!(requests.len(), 1);

        server.abort();
    }
}
