//! Commands for device sync and E2EE pairing.
//!
//! This module provides Tauri commands that wrap the shared device sync client,
//! handling token/device ID storage via the keyring.

mod engine;
mod snapshot;

use async_trait::async_trait;
use log::{debug, info, warn};
use std::collections::HashMap;
use std::process::Command;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, State};

use crate::context::ServiceContext;
use crate::secret_store::KeyringSecretStore;
use wealthfolio_core::secrets::SecretStore;
use wealthfolio_device_sync::engine as shared_sync_engine;
use wealthfolio_device_sync::{
    ClaimPairingRequest, ClaimPairingResponse, CommitInitializeKeysRequest,
    CommitInitializeKeysResponse, CommitRotateKeysRequest, CommitRotateKeysResponse,
    CompletePairingRequest, CompletePairingResponse, ConfirmPairingRequest, ConfirmPairingResponse,
    CreatePairingRequest, CreatePairingResponse, Device, DevicePlatform, DeviceSyncClient,
    EnrollDeviceResponse, GetPairingResponse, InitializeKeysResult, PairingMessagesResponse,
    RegisterDeviceRequest, ResetTeamSyncResponse, RotateKeysResponse, SuccessResponse,
    UpdateDeviceRequest,
};
use wealthfolio_storage_sqlite::sync::SyncTableRowCount;

// Re-export public items consumed by lib.rs
pub use engine::{ensure_background_engine_started, ensure_background_engine_stopped};

// ─────────────────────────────────────────────────────────────────────────────
// Shared Constants & Helpers
// ─────────────────────────────────────────────────────────────────────────────

fn cloud_api_base_url() -> Result<String, String> {
    crate::services::cloud_api_base_url().ok_or_else(|| {
        "Cloud API base URL is unavailable. Device sync operations are disabled.".to_string()
    })
}

pub(super) async fn get_access_token(context: &Arc<ServiceContext>) -> Result<String, String> {
    context.connect_service().get_valid_access_token().await
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncIdentity {
    device_id: Option<String>,
    root_key: Option<String>,
    key_version: Option<i32>,
}

pub(crate) fn get_sync_identity_from_store() -> Option<SyncIdentity> {
    const SYNC_IDENTITY_KEY: &str = "sync_identity";

    match KeyringSecretStore.get_secret(SYNC_IDENTITY_KEY) {
        Ok(Some(json)) => match serde_json::from_str::<SyncIdentity>(&json) {
            Ok(identity) => {
                if let Some(ref device_id) = identity.device_id {
                    debug!(
                            "[DeviceSync] Loaded sync_identity (device_id={}, has_root_key={}, key_version={})",
                            device_id,
                            identity.root_key.is_some(),
                            identity.key_version.unwrap_or_default()
                        );
                } else {
                    debug!(
                            "[DeviceSync] sync_identity exists but deviceId is not set (has_root_key={}, key_version={})",
                            identity.root_key.is_some(),
                            identity.key_version.unwrap_or_default()
                        );
                }
                Some(identity)
            }
            Err(e) => {
                log::warn!("[DeviceSync] Failed to parse sync_identity: {}", e);
                None
            }
        },
        Ok(None) => {
            debug!("[DeviceSync] No sync_identity found in keyring");
            None
        }
        Err(e) => {
            log::warn!("[DeviceSync] Failed to read sync_identity: {}", e);
            None
        }
    }
}

pub(crate) fn sync_identity_can_run_background(identity: &SyncIdentity) -> bool {
    identity.device_id.is_some() && identity.root_key.is_some()
}

fn get_device_id_from_store() -> Option<String> {
    get_sync_identity_from_store().and_then(|identity| identity.device_id)
}

fn is_pairing_already_confirmed_error(err: &wealthfolio_device_sync::DeviceSyncError) -> bool {
    match err {
        wealthfolio_device_sync::DeviceSyncError::Api {
            status,
            code,
            message,
            ..
        } if matches!(*status, 400 | 409) => {
            let code = code.to_ascii_lowercase();
            let message = message.to_ascii_lowercase();
            code.contains("already_confirmed")
                || message.contains("already confirmed")
                || message.contains("already completed")
        }
        _ => false,
    }
}

fn is_pairing_already_approved_error(err: &wealthfolio_device_sync::DeviceSyncError) -> bool {
    match err {
        wealthfolio_device_sync::DeviceSyncError::Api {
            status,
            code,
            message,
            ..
        } if matches!(*status, 400 | 409) => {
            let code = code.to_ascii_lowercase();
            let message = message.to_ascii_lowercase();
            code.contains("already_approved") || message.contains("already approved")
        }
        _ => false,
    }
}

pub(super) const SYNC_SOURCE_RESTORE_REQUIRED_CODE: &str = "SYNC_SOURCE_RESTORE_REQUIRED";

static MIN_SNAPSHOT_CREATED_AT: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
static READY_STATE_OVERWRITE_APPROVALS: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();
static PAIRING_OVERWRITE_APPROVALS: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();

fn min_snapshot_created_at_state() -> &'static Mutex<HashMap<String, String>> {
    MIN_SNAPSHOT_CREATED_AT.get_or_init(|| Mutex::new(HashMap::new()))
}

fn ready_state_overwrite_approval_state() -> &'static Mutex<HashMap<String, bool>> {
    READY_STATE_OVERWRITE_APPROVALS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn pairing_overwrite_approval_state() -> &'static Mutex<HashMap<String, bool>> {
    PAIRING_OVERWRITE_APPROVALS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(super) fn get_min_snapshot_created_at_from_store(device_id: &str) -> Option<String> {
    min_snapshot_created_at_state()
        .lock()
        .ok()
        .and_then(|map| map.get(device_id).cloned())
}

fn set_min_snapshot_created_at_in_store(device_id: &str, value: &str) {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return;
    }
    if let Ok(mut guard) = min_snapshot_created_at_state().lock() {
        guard.insert(device_id.to_string(), trimmed.to_string());
    }
}

pub(super) fn remove_min_snapshot_created_at_from_store(device_id: &str) {
    if let Ok(mut guard) = min_snapshot_created_at_state().lock() {
        guard.remove(device_id);
    }
}

pub(super) fn clear_min_snapshot_created_at_from_store() {
    if let Ok(mut guard) = min_snapshot_created_at_state().lock() {
        guard.clear();
    }
}

fn has_ready_state_overwrite_approval(device_id: &str) -> bool {
    ready_state_overwrite_approval_state()
        .lock()
        .ok()
        .and_then(|map| map.get(device_id).copied())
        .unwrap_or(false)
}

fn set_ready_state_overwrite_approval(device_id: &str) {
    if let Ok(mut guard) = ready_state_overwrite_approval_state().lock() {
        guard.insert(device_id.to_string(), true);
    }
}

fn clear_ready_state_overwrite_approval(device_id: &str) {
    if let Ok(mut guard) = ready_state_overwrite_approval_state().lock() {
        guard.remove(device_id);
    }
}

fn has_pairing_overwrite_approval(pairing_id: &str) -> bool {
    pairing_overwrite_approval_state()
        .lock()
        .ok()
        .and_then(|map| map.get(pairing_id).copied())
        .unwrap_or(false)
}

fn set_pairing_overwrite_approval(pairing_id: &str) {
    if let Ok(mut guard) = pairing_overwrite_approval_state().lock() {
        guard.insert(pairing_id.to_string(), true);
    }
}

fn clear_pairing_overwrite_approval(pairing_id: &str) {
    if let Ok(mut guard) = pairing_overwrite_approval_state().lock() {
        guard.remove(pairing_id);
    }
}

fn pairing_bootstrap_phase(
    bootstrap: &SyncBootstrapResult,
) -> Result<Option<PairingFlowPhase>, String> {
    match bootstrap.status.as_str() {
        "requested" => Ok(Some(PairingFlowPhase::Syncing {
            detail: "waiting_snapshot".to_string(),
        })),
        "applied" | "skipped" => Ok(None),
        "skipped_not_ready" => Err(bootstrap.message.clone()),
        other => Err(format!(
            "Snapshot bootstrap did not complete (status={}): {}",
            other, bootstrap.message
        )),
    }
}

async fn abort_pairing_flow_local_state(context: &Arc<ServiceContext>, pairing_id: &str) {
    clear_pairing_overwrite_approval(pairing_id);

    let device_id = get_device_id_from_store();
    if let Some(device_id) = device_id.as_deref() {
        if let Ok(token) = get_access_token(context).await {
            if let Ok(client) = create_client() {
                let _ = client.cancel_pairing(&token, device_id, pairing_id).await;
                if let Err(err) = client.delete_device(&token, device_id).await {
                    warn!(
                        "[DeviceSync] Failed to delete confirmed pairing device while cancelling flow: {}",
                        err
                    );
                }
            }
        }
        remove_min_snapshot_created_at_from_store(device_id);
        let _ = context
            .app_sync_repository()
            .clear_min_snapshot_created_at(device_id.to_string())
            .await;
    }

    if let Err(err) = ensure_background_engine_stopped(Arc::clone(context)).await {
        warn!(
            "[DeviceSync] Failed to stop engine while cancelling pairing flow: {}",
            err
        );
    }
    if let Err(err) = context.device_enroll_service().clear_sync_data() {
        warn!(
            "[DeviceSync] Failed to clear local sync identity while cancelling pairing flow: {}",
            err.message
        );
    }
    let _ = context
        .app_sync_repository()
        .reset_local_sync_session()
        .await;
    clear_min_snapshot_created_at_from_store();
    let _ = context
        .app_sync_repository()
        .clear_all_min_snapshot_created_at()
        .await;
}

fn should_keep_ready_state_overwrite_approval(
    result: &shared_sync_engine::SyncReadyReconcileResult,
) -> bool {
    if result.status == "error" {
        return true;
    }

    result.bootstrap_status == "requested"
        || result.cycle_needs_bootstrap
        || matches!(
            result.cycle_status.as_deref(),
            Some("wait_snapshot") | Some("stale_cursor")
        )
        || matches!(
            result.retry_cycle_status.as_deref(),
            Some("wait_snapshot") | Some("stale_cursor")
        )
}

async fn persist_device_config_from_identity(
    context: &ServiceContext,
    identity: &SyncIdentity,
    trust_state: &str,
) {
    if let Some(device_id) = &identity.device_id {
        if let Err(err) = context
            .app_sync_repository()
            .upsert_device_config(
                device_id.clone(),
                identity.key_version,
                trust_state.to_string(),
            )
            .await
        {
            log::warn!("[DeviceSync] Failed to persist device config: {}", err);
        }
    }
}

fn create_client() -> Result<DeviceSyncClient, String> {
    Ok(DeviceSyncClient::new(&cloud_api_base_url()?))
}

// ─────────────────────────────────────────────────────────────────────────────
// Result types
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncBootstrapResult {
    pub status: String,
    pub message: String,
    pub snapshot_id: Option<String>,
    pub cursor: Option<i64>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncEngineStatusResult {
    pub cursor: i64,
    pub last_push_at: Option<String>,
    pub last_pull_at: Option<String>,
    pub last_error: Option<String>,
    pub consecutive_failures: i32,
    pub next_retry_at: Option<String>,
    pub last_cycle_status: Option<String>,
    pub last_cycle_duration_ms: Option<i64>,
    pub background_running: bool,
    pub bootstrap_required: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPairingSourceStatusResult {
    pub status: String,
    pub message: String,
    pub local_cursor: i64,
    pub server_cursor: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncBootstrapOverwriteCheckTableResult {
    pub table: String,
    pub rows: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncBootstrapOverwriteCheckResult {
    pub bootstrap_required: bool,
    pub has_local_data: bool,
    pub local_rows: i64,
    pub non_empty_tables: Vec<SyncBootstrapOverwriteCheckTableResult>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncCycleResult {
    pub status: String,
    pub lock_version: i64,
    pub pushed_count: usize,
    pub pulled_count: usize,
    pub cursor: i64,
    pub needs_bootstrap: bool,
    pub bootstrap_snapshot_id: Option<String>,
    pub bootstrap_snapshot_seq: Option<i64>,
    pub dead_letter_count: usize,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncBackgroundEngineResult {
    pub status: String,
    pub message: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSnapshotUploadResult {
    pub status: String,
    pub snapshot_id: Option<String>,
    pub oplog_seq: Option<i64>,
    pub message: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReconcileReadyStateResult {
    pub status: String,
    pub message: String,
    pub bootstrap_action: String,
    pub bootstrap_status: String,
    pub bootstrap_message: Option<String>,
    pub bootstrap_snapshot_id: Option<String>,
    pub cycle_status: Option<String>,
    pub cycle_needs_bootstrap: bool,
    pub retry_attempted: bool,
    pub retry_cycle_status: Option<String>,
    pub background_status: String,
}

impl From<shared_sync_engine::SyncReadyReconcileResult> for SyncReconcileReadyStateResult {
    fn from(value: shared_sync_engine::SyncReadyReconcileResult) -> Self {
        Self {
            status: value.status,
            message: value.message,
            bootstrap_action: value.bootstrap_action,
            bootstrap_status: value.bootstrap_status,
            bootstrap_message: value.bootstrap_message,
            bootstrap_snapshot_id: value.bootstrap_snapshot_id,
            cycle_status: value.cycle_status,
            cycle_needs_bootstrap: value.cycle_needs_bootstrap,
            retry_attempted: value.retry_attempted,
            retry_cycle_status: value.retry_cycle_status,
            background_status: value.background_status,
        }
    }
}

struct TauriReadyReconcileRunner {
    handle: AppHandle,
    context: Arc<ServiceContext>,
}

#[async_trait]
impl shared_sync_engine::ReadyReconcileStore for TauriReadyReconcileRunner {
    async fn get_sync_state(&self) -> Result<wealthfolio_device_sync::SyncState, String> {
        let token = self
            .context
            .connect_service()
            .get_valid_access_token()
            .await?;
        self.context
            .device_enroll_service()
            .get_sync_state(&token)
            .await
            .map(|value| value.state)
            .map_err(|err| err.message)
    }

    async fn bootstrap_snapshot_if_needed(
        &self,
    ) -> Result<shared_sync_engine::SyncBootstrapResult, String> {
        let result =
            snapshot::sync_bootstrap_snapshot_if_needed(self.handle.clone(), &self.context).await?;
        Ok(shared_sync_engine::SyncBootstrapResult {
            status: result.status,
            message: result.message,
            snapshot_id: result.snapshot_id,
        })
    }

    async fn run_sync_cycle(
        &self,
        post_bootstrap: bool,
    ) -> Result<shared_sync_engine::SyncCycleResult, String> {
        let result = engine::run_sync_cycle(Arc::clone(&self.context), post_bootstrap).await?;
        Ok(shared_sync_engine::SyncCycleResult {
            status: result.status,
            lock_version: result.lock_version,
            pushed_count: result.pushed_count,
            pulled_count: result.pulled_count,
            cursor: result.cursor,
            needs_bootstrap: result.needs_bootstrap,
            bootstrap_snapshot_id: result.bootstrap_snapshot_id,
            bootstrap_snapshot_seq: result.bootstrap_snapshot_seq,
            dead_letter_count: result.dead_letter_count,
        })
    }

    async fn ensure_background_started(&self) -> Result<bool, String> {
        ensure_background_engine_started(Arc::clone(&self.context)).await?;
        Ok(self
            .context
            .device_sync_runtime()
            .is_background_running()
            .await)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared utility functions
// ─────────────────────────────────────────────────────────────────────────────

fn is_sqlite_image(bytes: &[u8]) -> bool {
    bytes.starts_with(b"SQLite format 3\0")
}

fn sha256_checksum(bytes: &[u8]) -> String {
    wealthfolio_device_sync::crypto::sha256_checksum(bytes)
}

fn encrypt_sync_payload(
    plaintext_payload: &str,
    identity: &SyncIdentity,
    payload_key_version: i32,
) -> Result<String, String> {
    let root_key = identity
        .root_key
        .as_ref()
        .ok_or_else(|| "Sync root key is not configured".to_string())?;
    let key_version = payload_key_version.max(1) as u32;
    let dek = wealthfolio_device_sync::crypto::derive_dek(root_key, key_version)
        .map_err(|e| format!("Failed to derive event DEK: {}", e))?;
    wealthfolio_device_sync::crypto::encrypt(&dek, plaintext_payload)
        .map_err(|e| format!("Failed to encrypt sync payload: {}", e))
}

fn decrypt_sync_payload(
    encrypted_payload: &str,
    identity: &SyncIdentity,
    payload_key_version: i32,
) -> Result<String, String> {
    let root_key = identity
        .root_key
        .as_ref()
        .ok_or_else(|| "Sync root key is not configured".to_string())?;
    let key_version = payload_key_version.max(1) as u32;
    let dek = wealthfolio_device_sync::crypto::derive_dek(root_key, key_version)
        .map_err(|e| format!("Failed to derive event DEK: {}", e))?;
    wealthfolio_device_sync::crypto::decrypt(&dek, encrypted_payload)
        .map_err(|e| format!("Failed to decrypt sync payload: {}", e))
}

// ─────────────────────────────────────────────────────────────────────────────
// OS version detection
// ─────────────────────────────────────────────────────────────────────────────

fn get_os_version() -> Option<String> {
    let version = get_os_version_impl();
    if version.is_none() {
        debug!("[DeviceSync] Could not detect OS version");
    }
    version
}

#[cfg(target_os = "macos")]
fn get_os_version_impl() -> Option<String> {
    Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                String::from_utf8(o.stdout).ok()
            } else {
                None
            }
        })
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

#[cfg(target_os = "windows")]
fn get_os_version_impl() -> Option<String> {
    Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "[System.Environment]::OSVersion.Version.ToString()",
        ])
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                String::from_utf8(o.stdout).ok()
            } else {
                None
            }
        })
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

#[cfg(target_os = "linux")]
fn get_os_version_impl() -> Option<String> {
    std::fs::read_to_string("/etc/os-release")
        .ok()
        .and_then(|content| {
            content
                .lines()
                .find(|l| l.starts_with("VERSION_ID="))
                .map(|l| {
                    l.trim_start_matches("VERSION_ID=")
                        .trim_matches('"')
                        .to_string()
                })
        })
        .or_else(|| {
            std::fs::read_to_string("/etc/lsb-release")
                .ok()
                .and_then(|content| {
                    content
                        .lines()
                        .find(|l| l.starts_with("DISTRIB_RELEASE="))
                        .map(|l| {
                            l.trim_start_matches("DISTRIB_RELEASE=")
                                .trim_matches('"')
                                .to_string()
                        })
                })
        })
        .or_else(|| {
            Command::new("uname")
                .arg("-r")
                .output()
                .ok()
                .and_then(|o| String::from_utf8(o.stdout).ok())
                .map(|s| s.trim().to_string())
        })
        .filter(|s| !s.is_empty())
}

#[cfg(target_os = "ios")]
fn get_os_version_impl() -> Option<String> {
    None
}

#[cfg(target_os = "android")]
fn get_os_version_impl() -> Option<String> {
    None
}

#[cfg(not(any(
    target_os = "macos",
    target_os = "windows",
    target_os = "linux",
    target_os = "ios",
    target_os = "android"
)))]
fn get_os_version_impl() -> Option<String> {
    None
}

fn get_app_version() -> Option<String> {
    Some(env!("CARGO_PKG_VERSION").to_string())
}

// ─────────────────────────────────────────────────────────────────────────────
// Device Management
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command(rename_all = "camelCase")]
pub async fn enroll_device(
    device_nonce: String,
    display_name: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<EnrollDeviceResponse, String> {
    info!("[DeviceSync] Enrolling device: {}", display_name);

    let token = get_access_token(state.inner()).await?;
    let client = create_client()?;

    let platform = DevicePlatform::detect().to_string();
    let os_version = get_os_version();
    let app_version = get_app_version();

    info!(
        "[DeviceSync] Platform: {}, OS version: {:?}, App version: {:?}",
        platform, os_version, app_version
    );

    let request = RegisterDeviceRequest {
        device_nonce,
        display_name,
        platform,
        os_version,
        app_version,
    };

    let result = client
        .enroll_device(&token, request)
        .await
        .map_err(|e| e.to_string())?;

    let device_id = match &result {
        EnrollDeviceResponse::Bootstrap { device_id, .. } => device_id,
        EnrollDeviceResponse::Pair { device_id, .. } => device_id,
        EnrollDeviceResponse::Ready { device_id, .. } => device_id,
    };

    info!(
        "[DeviceSync] Device enrolled: {} (mode: {:?})",
        device_id,
        match &result {
            EnrollDeviceResponse::Bootstrap { .. } => "BOOTSTRAP",
            EnrollDeviceResponse::Pair { .. } => "PAIR",
            EnrollDeviceResponse::Ready { .. } => "READY",
        }
    );
    Ok(result)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_device(
    device_id: Option<String>,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Device, String> {
    let token = get_access_token(state.inner()).await?;
    let device_id = device_id
        .or_else(get_device_id_from_store)
        .ok_or_else(|| "No device ID configured".to_string())?;

    create_client()?
        .get_device(&token, &device_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_devices(
    scope: Option<String>,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Vec<Device>, String> {
    info!("[DeviceSync] Listing devices (scope: {:?})...", scope);

    let token = get_access_token(state.inner()).await?;

    let devices = create_client()?
        .list_devices(&token, scope.as_deref())
        .await
        .map_err(|e| e.to_string())?;

    info!("[DeviceSync] Found {} devices", devices.len());
    Ok(devices)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn update_device(
    device_id: String,
    display_name: Option<String>,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<SuccessResponse, String> {
    info!(
        "[DeviceSync] Updating device {}: name={:?}",
        device_id, display_name
    );

    let token = get_access_token(state.inner()).await?;

    create_client()?
        .update_device(
            &token,
            &device_id,
            UpdateDeviceRequest {
                display_name,
                metadata: None,
            },
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn delete_device(
    device_id: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<SuccessResponse, String> {
    info!("[DeviceSync] Deleting device: {}", device_id);

    let token = get_access_token(state.inner()).await?;

    create_client()?
        .delete_device(&token, &device_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn revoke_device(
    device_id: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<SuccessResponse, String> {
    info!("[DeviceSync] Revoking device: {}", device_id);

    let token = get_access_token(state.inner()).await?;

    create_client()?
        .revoke_device(&token, &device_id)
        .await
        .map_err(|e| e.to_string())
}

// ─────────────────────────────────────────────────────────────────────────────
// Team Keys (E2EE)
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn initialize_team_keys(
    state: State<'_, Arc<ServiceContext>>,
) -> Result<InitializeKeysResult, String> {
    info!("[DeviceSync] Initializing team keys...");

    let token = get_access_token(state.inner()).await?;
    let device_id =
        get_device_id_from_store().ok_or_else(|| "No device ID configured".to_string())?;

    let result = create_client()?
        .initialize_team_keys(&token, &device_id)
        .await
        .map_err(|e| e.to_string())?;

    info!(
        "[DeviceSync] Initialize team keys result: {:?}",
        match &result {
            InitializeKeysResult::Bootstrap { .. } => "BOOTSTRAP",
            InitializeKeysResult::PairingRequired { .. } => "PAIRING_REQUIRED",
            InitializeKeysResult::Ready { .. } => "READY",
        }
    );

    Ok(result)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn commit_initialize_team_keys(
    key_version: i32,
    device_key_envelope: String,
    signature: String,
    challenge_response: Option<String>,
    recovery_envelope: Option<String>,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<CommitInitializeKeysResponse, String> {
    info!("[DeviceSync] Committing team key initialization...");

    let token = get_access_token(state.inner()).await?;
    let device_id =
        get_device_id_from_store().ok_or_else(|| "No device ID configured".to_string())?;

    let request = CommitInitializeKeysRequest {
        device_id: device_id.clone(),
        key_version,
        device_key_envelope,
        signature,
        challenge_response,
        recovery_envelope,
    };

    create_client()?
        .commit_initialize_team_keys(&token, request)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn rotate_team_keys(
    state: State<'_, Arc<ServiceContext>>,
) -> Result<RotateKeysResponse, String> {
    info!("[DeviceSync] Starting key rotation...");

    let token = get_access_token(state.inner()).await?;
    let device_id =
        get_device_id_from_store().ok_or_else(|| "No device ID configured".to_string())?;

    create_client()?
        .rotate_team_keys(&token, &device_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn commit_rotate_team_keys(
    request: CommitRotateKeysRequest,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<CommitRotateKeysResponse, String> {
    info!("[DeviceSync] Committing key rotation...");

    let token = get_access_token(state.inner()).await?;
    let device_id =
        get_device_id_from_store().ok_or_else(|| "No device ID configured".to_string())?;

    create_client()?
        .commit_rotate_team_keys(&token, &device_id, request)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn reset_team_sync(
    reason: Option<String>,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<ResetTeamSyncResponse, String> {
    info!("[DeviceSync] Resetting team sync...");

    let token = get_access_token(state.inner()).await?;

    create_client()?
        .reset_team_sync(&token, reason.as_deref())
        .await
        .map_err(|e| e.to_string())
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine Status & Tauri Command Wrappers
// ─────────────────────────────────────────────────────────────────────────────

pub async fn sync_engine_status(
    state: State<'_, Arc<ServiceContext>>,
) -> Result<SyncEngineStatusResult, String> {
    let sync_repo = state.app_sync_repository();
    let status = sync_repo.get_engine_status().map_err(|e| e.to_string())?;
    let bootstrap_required = match get_device_id_from_store() {
        Some(device_id) => sync_repo
            .needs_bootstrap(&device_id)
            .map_err(|e| e.to_string())?,
        None => true,
    };
    let runtime = state.inner().device_sync_runtime();
    let background_running = runtime.is_background_running().await;

    Ok(SyncEngineStatusResult {
        cursor: status.cursor,
        last_push_at: status.last_push_at,
        last_pull_at: status.last_pull_at,
        last_error: status.last_error,
        consecutive_failures: status.consecutive_failures,
        next_retry_at: status.next_retry_at,
        last_cycle_status: status.last_cycle_status,
        last_cycle_duration_ms: status.last_cycle_duration_ms,
        background_running,
        bootstrap_required,
    })
}

#[tauri::command]
pub async fn device_sync_bootstrap_overwrite_check(
    state: State<'_, Arc<ServiceContext>>,
) -> Result<SyncBootstrapOverwriteCheckResult, String> {
    let sync_repo = state.app_sync_repository();
    let device_id = get_device_id_from_store();
    let bootstrap_required = match device_id.as_deref() {
        Some(device_id) => sync_repo
            .needs_bootstrap(device_id)
            .map_err(|e| e.to_string())?,
        None => true,
    };
    if !bootstrap_required {
        if let Some(device_id) = device_id.as_deref() {
            clear_ready_state_overwrite_approval(device_id);
        }
        return Ok(SyncBootstrapOverwriteCheckResult {
            bootstrap_required,
            has_local_data: false,
            local_rows: 0,
            non_empty_tables: Vec::new(),
        });
    }

    if let Some(device_id) = device_id.as_deref() {
        if has_ready_state_overwrite_approval(device_id) {
            return Ok(SyncBootstrapOverwriteCheckResult {
                bootstrap_required,
                has_local_data: false,
                local_rows: 0,
                non_empty_tables: Vec::new(),
            });
        }
    }

    let summary = sync_repo
        .get_local_sync_overwrite_risk_summary()
        .map_err(|e| e.to_string())?;

    Ok(SyncBootstrapOverwriteCheckResult {
        bootstrap_required,
        has_local_data: summary.total_rows > 0,
        local_rows: summary.total_rows,
        non_empty_tables: summary
            .non_empty_tables
            .into_iter()
            .map(
                |SyncTableRowCount { table, rows }| SyncBootstrapOverwriteCheckTableResult {
                    table,
                    rows,
                },
            )
            .collect(),
    })
}

pub async fn sync_trigger_cycle(
    state: State<'_, Arc<ServiceContext>>,
) -> Result<SyncCycleResult, String> {
    engine::run_sync_cycle(Arc::clone(state.inner()), false).await
}

#[tauri::command]
pub async fn device_sync_start_background_engine(
    state: State<'_, Arc<ServiceContext>>,
) -> Result<SyncBackgroundEngineResult, String> {
    ensure_background_engine_started(Arc::clone(state.inner())).await?;
    let background_running = state
        .inner()
        .device_sync_runtime()
        .is_background_running()
        .await;
    Ok(SyncBackgroundEngineResult {
        status: if background_running {
            "started".to_string()
        } else {
            "skipped".to_string()
        },
        message: if background_running {
            "Device sync background engine started".to_string()
        } else {
            "Background engine not started because sync identity is not configured".to_string()
        },
    })
}

#[tauri::command]
pub async fn device_sync_stop_background_engine(
    state: State<'_, Arc<ServiceContext>>,
) -> Result<SyncBackgroundEngineResult, String> {
    ensure_background_engine_stopped(Arc::clone(state.inner())).await?;
    Ok(SyncBackgroundEngineResult {
        status: "stopped".to_string(),
        message: "Device sync background engine stopped".to_string(),
    })
}

#[tauri::command]
pub async fn device_sync_generate_snapshot_now(
    handle: AppHandle,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<SyncSnapshotUploadResult, String> {
    snapshot::generate_snapshot_now_internal(Some(&handle), Arc::clone(state.inner())).await
}

#[tauri::command]
pub async fn device_sync_cancel_snapshot_upload(
    state: State<'_, Arc<ServiceContext>>,
) -> Result<SyncBackgroundEngineResult, String> {
    state
        .inner()
        .device_sync_runtime()
        .snapshot_upload_cancelled
        .store(true, Ordering::Relaxed);
    Ok(SyncBackgroundEngineResult {
        status: "cancel_requested".to_string(),
        message: "Snapshot upload cancellation requested".to_string(),
    })
}

#[tauri::command]
pub async fn device_sync_engine_status(
    state: State<'_, Arc<ServiceContext>>,
) -> Result<SyncEngineStatusResult, String> {
    sync_engine_status(state).await
}

#[tauri::command]
pub async fn device_sync_pairing_source_status(
    state: State<'_, Arc<ServiceContext>>,
) -> Result<SyncPairingSourceStatusResult, String> {
    snapshot::get_pairing_source_status_internal(Arc::clone(state.inner())).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn device_sync_reconcile_ready_state(
    allow_overwrite: bool,
    handle: AppHandle,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<SyncReconcileReadyStateResult, String> {
    let device_id = get_device_id_from_store();
    let has_overwrite_approval = device_id
        .as_deref()
        .map(has_ready_state_overwrite_approval)
        .unwrap_or(false);
    if allow_overwrite {
        if let Some(device_id) = device_id.as_deref() {
            set_ready_state_overwrite_approval(device_id);
        }
    }

    let runner = TauriReadyReconcileRunner {
        handle,
        context: Arc::clone(state.inner()),
    };
    let result = shared_sync_engine::run_ready_reconcile_state(&runner).await;

    if let Some(device_id) = device_id.as_deref() {
        if (allow_overwrite || has_overwrite_approval)
            && should_keep_ready_state_overwrite_approval(&result)
        {
            set_ready_state_overwrite_approval(device_id);
        } else {
            clear_ready_state_overwrite_approval(device_id);
        }
    }

    Ok(result.into())
}

#[tauri::command]
pub async fn device_sync_bootstrap_snapshot_if_needed(
    handle: AppHandle,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<SyncBootstrapResult, String> {
    let context = Arc::clone(state.inner());
    let result = snapshot::sync_bootstrap_snapshot_if_needed(handle, &context).await?;
    let should_start_engine = match context.connect_service().get_valid_access_token().await {
        Ok(token) => context
            .device_enroll_service()
            .get_sync_state(&token)
            .await
            .map(|sync_state| sync_state.state == wealthfolio_device_sync::SyncState::Ready)
            .unwrap_or_else(|err| {
                log::warn!(
                    "[DeviceSync] Post-bootstrap sync state check failed: {}",
                    err.message
                );
                false
            }),
        Err(err) => {
            log::warn!(
                "[DeviceSync] Post-bootstrap token refresh failed while starting engine: {}",
                err
            );
            false
        }
    };

    // Start the background sync engine whenever this device is READY.
    if should_start_engine {
        let engine_context = Arc::clone(state.inner());
        tauri::async_runtime::spawn(async move {
            if let Err(err) = ensure_background_engine_started(engine_context).await {
                log::warn!("[DeviceSync] Post-bootstrap engine start failed: {}", err);
            }
        });
    }

    Ok(result)
}

#[tauri::command]
pub async fn device_sync_trigger_cycle(
    state: State<'_, Arc<ServiceContext>>,
) -> Result<SyncCycleResult, String> {
    sync_trigger_cycle(state).await
}

// ─────────────────────────────────────────────────────────────────────────────
// Pairing — Issuer Side
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command(rename_all = "camelCase")]
pub async fn create_pairing(
    code_hash: String,
    ephemeral_public_key: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<CreatePairingResponse, String> {
    debug!("[DeviceSync] Creating pairing session...");

    let token = get_access_token(state.inner()).await?;
    let device_id =
        get_device_id_from_store().ok_or_else(|| "No device ID configured".to_string())?;

    create_client()?
        .create_pairing(
            &token,
            &device_id,
            CreatePairingRequest {
                code_hash,
                ephemeral_public_key,
            },
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_pairing(
    pairing_id: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<GetPairingResponse, String> {
    debug!("[DeviceSync] Getting pairing session: {}", pairing_id);

    let token = get_access_token(state.inner()).await?;
    let device_id =
        get_device_id_from_store().ok_or_else(|| "No device ID configured".to_string())?;

    create_client()?
        .get_pairing(&token, &device_id, &pairing_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn approve_pairing(
    pairing_id: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<SuccessResponse, String> {
    debug!("[DeviceSync] Approving pairing session: {}", pairing_id);

    let token = get_access_token(state.inner()).await?;
    let device_id =
        get_device_id_from_store().ok_or_else(|| "No device ID configured".to_string())?;

    create_client()?
        .approve_pairing(&token, &device_id, &pairing_id)
        .await
        .map_err(|e| e.to_string())
}

/// Complete a pairing session with key bundle.
/// Uploads snapshot BEFORE sending the key bundle so the claimer can bootstrap
/// immediately upon receiving it — no polling/retry gap.
#[tauri::command(rename_all = "camelCase")]
pub async fn complete_pairing(
    pairing_id: String,
    encrypted_key_bundle: String,
    sas_proof: serde_json::Value,
    signature: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<CompletePairingResponse, String> {
    debug!("[DeviceSync] Completing pairing session: {}", pairing_id);

    // Snapshot upload is now handled by the frontend issuer flow BEFORE calling
    // this command, so complete_pairing only sends the key bundle.

    let token = get_access_token(state.inner()).await?;
    let device_id =
        get_device_id_from_store().ok_or_else(|| "No device ID configured".to_string())?;

    let result = create_client()?
        .complete_pairing(
            &token,
            &device_id,
            &pairing_id,
            CompletePairingRequest {
                encrypted_key_bundle,
                sas_proof,
                signature,
            },
        )
        .await
        .map_err(|e| e.to_string())?;

    // Ensure the background sync engine is running (may be a no-op if already started).
    let engine_context = Arc::clone(state.inner());
    tauri::async_runtime::spawn(async move {
        if let Err(err) = ensure_background_engine_started(engine_context).await {
            log::warn!("[DeviceSync] Post-pairing engine start failed: {}", err);
        }
    });

    Ok(result)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn cancel_pairing(
    pairing_id: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<SuccessResponse, String> {
    debug!("[DeviceSync] Canceling pairing session: {}", pairing_id);

    let token = get_access_token(state.inner()).await?;
    let device_id =
        get_device_id_from_store().ok_or_else(|| "No device ID configured".to_string())?;

    create_client()?
        .cancel_pairing(&token, &device_id, &pairing_id)
        .await
        .map_err(|e| e.to_string())
}

// ─────────────────────────────────────────────────────────────────────────────
// Claimer-Side Pairing (New Device)
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command(rename_all = "camelCase")]
pub async fn claim_pairing(
    code: String,
    ephemeral_public_key: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<ClaimPairingResponse, String> {
    info!("[DeviceSync] Claiming pairing session...");

    let token = get_access_token(state.inner()).await?;
    let device_id =
        get_device_id_from_store().ok_or_else(|| "No device ID configured".to_string())?;

    create_client()?
        .claim_pairing(
            &token,
            &device_id,
            ClaimPairingRequest {
                code,
                ephemeral_public_key,
            },
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_pairing_messages(
    pairing_id: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<PairingMessagesResponse, String> {
    debug!("[DeviceSync] Polling for pairing messages: {}", pairing_id);

    let token = get_access_token(state.inner()).await?;
    let device_id =
        get_device_id_from_store().ok_or_else(|| "No device ID configured".to_string())?;

    create_client()?
        .get_pairing_messages(&token, &device_id, &pairing_id)
        .await
        .map_err(|e| e.to_string())
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmPairingWithBootstrapResult {
    pub status: String,
    pub message: String,
    pub local_rows: Option<i64>,
    pub non_empty_tables: Option<Vec<SyncBootstrapOverwriteCheckTableResult>>,
}

/// Issuer: Sync cycle → snapshot → approve → complete pairing atomically.
#[tauri::command(rename_all = "camelCase")]
pub async fn complete_pairing_with_transfer(
    pairing_id: String,
    encrypted_key_bundle: String,
    sas_proof: serde_json::Value,
    signature: String,
    handle: AppHandle,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<serde_json::Value, String> {
    info!("[DeviceSync] complete_pairing_with_transfer: starting");
    let context = Arc::clone(state.inner());
    let identity =
        get_sync_identity_from_store().ok_or_else(|| "No sync identity configured".to_string())?;
    let device_id = identity
        .device_id
        .clone()
        .ok_or_else(|| "No device ID configured".to_string())?;

    // 1. Run sync cycle to flush any pending outbox events
    info!("[DeviceSync] complete_pairing_with_transfer: running sync cycle");
    let _cycle_result = engine::run_sync_cycle(Arc::clone(&context), false).await?;

    // 2. Generate snapshot (full local SQLite export — always contains all local data)
    info!("[DeviceSync] complete_pairing_with_transfer: generating snapshot");
    let snapshot =
        snapshot::generate_snapshot_now_internal(Some(&handle), Arc::clone(&context)).await?;
    if snapshot.status != "uploaded" {
        return Err(format!("Snapshot upload failed: {}", snapshot.message));
    }

    // 3. Approve pairing
    let token = get_access_token(state.inner()).await?;
    let client = create_client()?;
    info!("[DeviceSync] complete_pairing_with_transfer: approving pairing");
    match client
        .approve_pairing(&token, &device_id, &pairing_id)
        .await
    {
        Ok(_) => {}
        Err(e) => {
            if is_pairing_already_approved_error(&e) {
                info!(
                    "[DeviceSync] approve_pairing already done, continuing: {}",
                    e
                );
            } else {
                return Err(e.to_string());
            }
        }
    }

    // 4. Complete pairing
    info!("[DeviceSync] complete_pairing_with_transfer: completing pairing");
    client
        .complete_pairing(
            &token,
            &device_id,
            &pairing_id,
            wealthfolio_device_sync::CompletePairingRequest {
                encrypted_key_bundle,
                sas_proof,
                signature,
            },
        )
        .await
        .map_err(|e| e.to_string())?;

    // 5. Start background engine
    let engine_context = Arc::clone(state.inner());
    tauri::async_runtime::spawn(async move {
        if let Err(err) = ensure_background_engine_started(engine_context).await {
            log::warn!("[DeviceSync] Post-pairing engine start failed: {}", err);
        }
    });

    Ok(serde_json::json!({ "success": true }))
}

/// Claimer: Confirm → overwrite check → bootstrap → sync cycle atomically.
#[tauri::command(rename_all = "camelCase")]
pub async fn confirm_pairing_with_bootstrap(
    pairing_id: String,
    proof: Option<String>,
    min_snapshot_created_at: Option<String>,
    allow_overwrite: bool,
    handle: AppHandle,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<ConfirmPairingWithBootstrapResult, String> {
    info!("[DeviceSync] confirm_pairing_with_bootstrap: starting");
    let context = Arc::clone(state.inner());
    let device_id =
        get_device_id_from_store().ok_or_else(|| "No device ID configured".to_string())?;
    let token = get_access_token(state.inner()).await?;
    let client = create_client()?;

    // 1. Confirm pairing (idempotent — tolerate "already confirmed")
    info!("[DeviceSync] confirm_pairing_with_bootstrap: confirming pairing");
    match client
        .confirm_pairing(
            &token,
            &device_id,
            &pairing_id,
            wealthfolio_device_sync::ConfirmPairingRequest { proof },
        )
        .await
    {
        Ok(_) => {}
        Err(e) => {
            // If the pairing was already confirmed (e.g. retry after partial failure),
            // only tolerate the specific already-confirmed response.
            let is_already_confirmed = is_pairing_already_confirmed_error(&e);
            if is_already_confirmed {
                info!(
                    "[DeviceSync] confirm_pairing already done, continuing: {}",
                    e
                );
            } else {
                return Err(e.to_string());
            }
        }
    }

    // 2. Set freshness gate
    if let Some(min_created_at) = min_snapshot_created_at.as_deref() {
        if let Ok(parsed_min) = wealthfolio_device_sync::parse_sync_datetime_to_utc(min_created_at)
        {
            let max_allowed = chrono::Utc::now() + chrono::Duration::minutes(10);
            if parsed_min <= max_allowed {
                if let Ok(normalized) =
                    wealthfolio_device_sync::normalize_sync_datetime(min_created_at)
                {
                    set_min_snapshot_created_at_in_store(&device_id, &normalized);
                    let _ = context
                        .app_sync_repository()
                        .set_min_snapshot_created_at(device_id.clone(), normalized)
                        .await;
                }
            }
        }
    }

    // 3. Check if bootstrap is needed
    let needs_bootstrap = context
        .app_sync_repository()
        .needs_bootstrap(&device_id)
        .map_err(|e| e.to_string())?;
    if !needs_bootstrap {
        clear_pairing_overwrite_approval(&pairing_id);
        return Ok(ConfirmPairingWithBootstrapResult {
            status: "already_complete".to_string(),
            message: "No bootstrap needed".to_string(),
            local_rows: None,
            non_empty_tables: None,
        });
    }

    // 4. Check overwrite risk
    if allow_overwrite {
        set_pairing_overwrite_approval(&pairing_id);
    }
    let overwrite_approved = allow_overwrite || has_pairing_overwrite_approval(&pairing_id);
    if !overwrite_approved {
        let summary = context
            .app_sync_repository()
            .get_local_sync_overwrite_risk_summary()
            .map_err(|e| e.to_string())?;
        if summary.total_rows > 0 {
            return Ok(ConfirmPairingWithBootstrapResult {
                status: "overwrite_required".to_string(),
                message: format!(
                    "Local data ({} rows) will be replaced by remote snapshot",
                    summary.total_rows
                ),
                local_rows: Some(summary.total_rows),
                non_empty_tables: Some(
                    summary
                        .non_empty_tables
                        .into_iter()
                        .map(|SyncTableRowCount { table, rows }| {
                            SyncBootstrapOverwriteCheckTableResult { table, rows }
                        })
                        .collect(),
                ),
            });
        }
    }

    // 5. Bootstrap snapshot
    info!("[DeviceSync] confirm_pairing_with_bootstrap: bootstrapping");
    let bootstrap = snapshot::sync_bootstrap_snapshot_if_needed(handle, &context).await?;
    if bootstrap.status == "requested" {
        return Ok(ConfirmPairingWithBootstrapResult {
            status: "waiting_snapshot".to_string(),
            message: bootstrap.message,
            local_rows: None,
            non_empty_tables: None,
        });
    }

    // 6. Run sync cycle
    info!("[DeviceSync] confirm_pairing_with_bootstrap: running sync cycle");
    let _ = engine::run_sync_cycle(Arc::clone(&context), true).await;

    // 7. Start background engine
    let engine_context = Arc::clone(state.inner());
    tauri::async_runtime::spawn(async move {
        if let Err(err) = ensure_background_engine_started(engine_context).await {
            log::warn!("[DeviceSync] Post-bootstrap engine start failed: {}", err);
        }
    });

    clear_pairing_overwrite_approval(&pairing_id);

    Ok(ConfirmPairingWithBootstrapResult {
        status: "applied".to_string(),
        message: "Bootstrap completed and sync cycle run".to_string(),
        local_rows: None,
        non_empty_tables: None,
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// Pairing Flow Coordinator Commands
// ─────────────────────────────────────────────────────────────────────────────

use wealthfolio_device_sync::engine::{
    OverwriteInfo, OverwriteTableInfo, PairingFlowPhase, PairingFlowResponse,
};

/// Begin the post-SAS confirm+bootstrap phase. Creates a flow entry and returns its state.
#[tauri::command(rename_all = "camelCase")]
pub async fn begin_pairing_confirm(
    pairing_id: String,
    proof: String,
    min_snapshot_created_at: Option<String>,
    handle: AppHandle,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<PairingFlowResponse, String> {
    info!("[DeviceSync] begin_pairing_confirm: starting");
    let context = Arc::clone(state.inner());
    let device_id =
        get_device_id_from_store().ok_or_else(|| "No device ID configured".to_string())?;
    let token = get_access_token(state.inner()).await?;
    let client = create_client()?;
    let runtime = context.device_sync_runtime();

    // 1. Confirm pairing (idempotent)
    match client
        .confirm_pairing(
            &token,
            &device_id,
            &pairing_id,
            wealthfolio_device_sync::ConfirmPairingRequest { proof: Some(proof) },
        )
        .await
    {
        Ok(_) => {}
        Err(e) => {
            if is_pairing_already_confirmed_error(&e) {
                info!("[DeviceSync] begin_pairing_confirm: already confirmed, continuing");
            } else {
                return Err(e.to_string());
            }
        }
    }

    // 2. Set freshness gate
    if let Some(min_created_at) = min_snapshot_created_at.as_deref() {
        if let Ok(parsed_min) = wealthfolio_device_sync::parse_sync_datetime_to_utc(min_created_at)
        {
            let max_allowed = chrono::Utc::now() + chrono::Duration::minutes(10);
            if parsed_min <= max_allowed {
                if let Ok(normalized) =
                    wealthfolio_device_sync::normalize_sync_datetime(min_created_at)
                {
                    set_min_snapshot_created_at_in_store(&device_id, &normalized);
                    let _ = context
                        .app_sync_repository()
                        .set_min_snapshot_created_at(device_id.clone(), normalized)
                        .await;
                }
            }
        }
    }

    // 3. Check if bootstrap is needed
    let needs_bootstrap = context
        .app_sync_repository()
        .needs_bootstrap(&device_id)
        .map_err(|e| e.to_string())?;
    if !needs_bootstrap {
        return Ok(PairingFlowResponse {
            flow_id: uuid::Uuid::new_v4().to_string(),
            phase: PairingFlowPhase::Success,
        });
    }

    // 4. If real local portfolio data exists, keep consent inside the pairing flow.
    let summary = context
        .app_sync_repository()
        .get_local_sync_overwrite_risk_summary()
        .map_err(|e| e.to_string())?;
    if summary.total_rows > 0 {
        info!(
            "[DeviceSync] begin_pairing_confirm: overwrite risk found ({} rows)",
            summary.total_rows
        );
        let phase = PairingFlowPhase::OverwriteRequired {
            info: OverwriteInfo {
                local_rows: summary.total_rows,
                non_empty_tables: summary
                    .non_empty_tables
                    .into_iter()
                    .map(|SyncTableRowCount { table, rows }| OverwriteTableInfo { table, rows })
                    .collect(),
            },
        };
        let flow_id = runtime.create_flow(pairing_id, phase.clone());
        return Ok(PairingFlowResponse { flow_id, phase });
    }

    // 5. Bootstrap snapshot
    let bootstrap = snapshot::sync_bootstrap_snapshot_if_needed(handle, &context).await?;
    if let Some(phase) = pairing_bootstrap_phase(&bootstrap)? {
        let flow_id = runtime.create_flow(pairing_id, phase.clone());
        return Ok(PairingFlowResponse { flow_id, phase });
    }

    // 6. Run sync cycle + start engine
    let _ = engine::run_sync_cycle(Arc::clone(&context), true).await;
    let engine_context = Arc::clone(state.inner());
    tauri::async_runtime::spawn(async move {
        if let Err(err) = ensure_background_engine_started(engine_context).await {
            log::warn!("[DeviceSync] Post-bootstrap engine start failed: {}", err);
        }
    });

    Ok(PairingFlowResponse {
        flow_id: uuid::Uuid::new_v4().to_string(),
        phase: PairingFlowPhase::Success,
    })
}

/// Poll the flow state. When syncing, re-checks bootstrap and advances if ready.
#[tauri::command(rename_all = "camelCase")]
pub async fn get_pairing_flow_state(
    flow_id: String,
    handle: AppHandle,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<PairingFlowResponse, String> {
    let context = Arc::clone(state.inner());
    let runtime = context.device_sync_runtime();

    let phase = runtime
        .get_flow_phase(&flow_id)
        .ok_or_else(|| "Flow not found".to_string())?;

    // If syncing, re-check bootstrap
    if let PairingFlowPhase::Syncing { ref detail } = phase {
        if detail == "waiting_snapshot" {
            match snapshot::sync_bootstrap_snapshot_if_needed(handle, &context).await {
                Ok(bootstrap) => match pairing_bootstrap_phase(&bootstrap) {
                    Ok(Some(phase)) => {
                        runtime.set_flow_phase(&flow_id, phase.clone());
                        return Ok(PairingFlowResponse { flow_id, phase });
                    }
                    Ok(None) => {
                        // Bootstrap applied — run sync cycle + start engine
                        let _ = engine::run_sync_cycle(Arc::clone(&context), true).await;
                        let engine_context = Arc::clone(state.inner());
                        tauri::async_runtime::spawn(async move {
                            if let Err(err) = ensure_background_engine_started(engine_context).await
                            {
                                log::warn!(
                                    "[DeviceSync] Post-bootstrap engine start failed: {}",
                                    err
                                );
                            }
                        });
                        if let Some(pid) = runtime.get_flow_pairing_id(&flow_id) {
                            clear_pairing_overwrite_approval(&pid);
                        }
                        runtime.remove_flow(&flow_id);
                        return Ok(PairingFlowResponse {
                            flow_id,
                            phase: PairingFlowPhase::Success,
                        });
                    }
                    Err(e) => {
                        if let Some(pid) = runtime.get_flow_pairing_id(&flow_id) {
                            clear_pairing_overwrite_approval(&pid);
                        }
                        runtime.remove_flow(&flow_id);
                        return Ok(PairingFlowResponse {
                            flow_id,
                            phase: PairingFlowPhase::Error { message: e },
                        });
                    }
                },
                Err(e) => {
                    if let Some(pid) = runtime.get_flow_pairing_id(&flow_id) {
                        clear_pairing_overwrite_approval(&pid);
                    }
                    runtime.remove_flow(&flow_id);
                    return Ok(PairingFlowResponse {
                        flow_id,
                        phase: PairingFlowPhase::Error { message: e },
                    });
                }
            }
        }
    }

    Ok(PairingFlowResponse { flow_id, phase })
}

/// Approve overwrite and continue bootstrap.
#[tauri::command(rename_all = "camelCase")]
pub async fn approve_pairing_overwrite(
    flow_id: String,
    handle: AppHandle,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<PairingFlowResponse, String> {
    let context = Arc::clone(state.inner());
    let runtime = context.device_sync_runtime();

    let phase = runtime
        .get_flow_phase(&flow_id)
        .ok_or_else(|| "Flow not found".to_string())?;
    if !matches!(phase, PairingFlowPhase::OverwriteRequired { .. }) {
        return Err("Flow is not in overwrite_required phase".to_string());
    }

    let pairing_id = runtime
        .get_flow_pairing_id(&flow_id)
        .ok_or_else(|| "Flow not found".to_string())?;

    // Set approval flag so bootstrap proceeds
    set_pairing_overwrite_approval(&pairing_id);

    // Transition to syncing
    runtime.set_flow_phase(
        &flow_id,
        PairingFlowPhase::Syncing {
            detail: "bootstrapping".to_string(),
        },
    );

    // Run bootstrap
    match snapshot::sync_bootstrap_snapshot_if_needed(handle, &context).await {
        Ok(bootstrap) => {
            if let Some(phase) = match pairing_bootstrap_phase(&bootstrap) {
                Ok(phase) => phase,
                Err(e) => {
                    clear_pairing_overwrite_approval(&pairing_id);
                    runtime.remove_flow(&flow_id);
                    return Ok(PairingFlowResponse {
                        flow_id,
                        phase: PairingFlowPhase::Error { message: e },
                    });
                }
            } {
                runtime.set_flow_phase(&flow_id, phase.clone());
                return Ok(PairingFlowResponse { flow_id, phase });
            }

            // Bootstrap applied — run sync cycle + start engine
            let _ = engine::run_sync_cycle(Arc::clone(&context), true).await;
            let engine_context = Arc::clone(state.inner());
            tauri::async_runtime::spawn(async move {
                if let Err(err) = ensure_background_engine_started(engine_context).await {
                    log::warn!("[DeviceSync] Post-overwrite engine start failed: {}", err);
                }
            });
            clear_pairing_overwrite_approval(&pairing_id);
            runtime.remove_flow(&flow_id);
            Ok(PairingFlowResponse {
                flow_id,
                phase: PairingFlowPhase::Success,
            })
        }
        Err(e) => {
            clear_pairing_overwrite_approval(&pairing_id);
            runtime.remove_flow(&flow_id);
            Ok(PairingFlowResponse {
                flow_id,
                phase: PairingFlowPhase::Error { message: e },
            })
        }
    }
}

/// Cancel and clean up the pairing flow.
#[tauri::command(rename_all = "camelCase")]
pub async fn cancel_pairing_flow(
    flow_id: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<PairingFlowResponse, String> {
    let context = Arc::clone(state.inner());
    let runtime = context.device_sync_runtime();

    if let Some(pairing_id) = runtime.get_flow_pairing_id(&flow_id) {
        abort_pairing_flow_local_state(&context, &pairing_id).await;
    }

    runtime.remove_flow(&flow_id);

    Ok(PairingFlowResponse {
        flow_id,
        phase: PairingFlowPhase::Success, // terminal — flow is gone
    })
}

#[tauri::command(rename_all = "camelCase")]
pub async fn confirm_pairing(
    pairing_id: String,
    proof: Option<String>,
    min_snapshot_created_at: Option<String>,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<ConfirmPairingResponse, String> {
    info!("[DeviceSync] Confirming pairing: {}", pairing_id);

    let token = get_access_token(state.inner()).await?;
    let device_id =
        get_device_id_from_store().ok_or_else(|| "No device ID configured".to_string())?;

    let result = create_client()?
        .confirm_pairing(
            &token,
            &device_id,
            &pairing_id,
            ConfirmPairingRequest { proof },
        )
        .await
        .map_err(|e| e.to_string())?;

    if let Some(min_created_at) = min_snapshot_created_at.as_deref() {
        if let Ok(parsed_min) = wealthfolio_device_sync::parse_sync_datetime_to_utc(min_created_at)
        {
            let max_allowed = chrono::Utc::now() + chrono::Duration::minutes(10);
            if parsed_min > max_allowed {
                log::warn!(
                    "[DeviceSync] Ignoring minSnapshotCreatedAt too far in the future: {}",
                    min_created_at
                );
            } else {
                match wealthfolio_device_sync::normalize_sync_datetime(min_created_at) {
                    Ok(normalized) => {
                        set_min_snapshot_created_at_in_store(&device_id, &normalized);
                        // Persist to SQLite so the gate survives process restarts
                        if let Err(err) = state
                            .app_sync_repository()
                            .set_min_snapshot_created_at(device_id.clone(), normalized)
                            .await
                        {
                            log::warn!(
                                "[DeviceSync] Failed to persist freshness gate to SQLite: {}",
                                err
                            );
                        }
                    }
                    Err(err) => {
                        log::warn!(
                            "[DeviceSync] Ignoring invalid minSnapshotCreatedAt value after normalization: {} ({})",
                            min_created_at,
                            err
                        );
                    }
                }
            }
        } else {
            log::warn!(
                "[DeviceSync] Ignoring invalid minSnapshotCreatedAt value: {}",
                min_created_at
            );
        }
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairing_already_approved_error_is_detected() {
        let err = wealthfolio_device_sync::DeviceSyncError::api_structured(
            409,
            "PAIRING_ALREADY_APPROVED",
            "Pairing already approved",
            None,
        );

        assert!(is_pairing_already_approved_error(&err));
    }

    #[test]
    fn pairing_invalid_approval_error_is_not_detected_as_idempotent() {
        let err = wealthfolio_device_sync::DeviceSyncError::api_structured(
            400,
            "PAIRING_INVALID_STATE",
            "Pairing cannot be approved from this state",
            None,
        );

        assert!(!is_pairing_already_approved_error(&err));
    }

    #[test]
    fn reconcile_result_conversion_preserves_fields() {
        let source = shared_sync_engine::SyncReadyReconcileResult {
            status: "ok".to_string(),
            message: "done".to_string(),
            bootstrap_action: "NO_BOOTSTRAP".to_string(),
            bootstrap_status: "applied".to_string(),
            bootstrap_message: Some("bootstrap ok".to_string()),
            bootstrap_snapshot_id: Some("snap-1".to_string()),
            cycle_status: Some("ok".to_string()),
            cycle_needs_bootstrap: false,
            retry_attempted: true,
            retry_cycle_status: Some("ok".to_string()),
            background_status: "started".to_string(),
        };

        let converted: SyncReconcileReadyStateResult = source.clone().into();
        assert_eq!(converted.status, source.status);
        assert_eq!(converted.message, source.message);
        assert_eq!(converted.bootstrap_action, source.bootstrap_action);
        assert_eq!(converted.bootstrap_status, source.bootstrap_status);
        assert_eq!(converted.bootstrap_message, source.bootstrap_message);
        assert_eq!(
            converted.bootstrap_snapshot_id,
            source.bootstrap_snapshot_id
        );
        assert_eq!(converted.cycle_status, source.cycle_status);
        assert_eq!(
            converted.cycle_needs_bootstrap,
            source.cycle_needs_bootstrap
        );
        assert_eq!(converted.retry_attempted, source.retry_attempted);
        assert_eq!(converted.retry_cycle_status, source.retry_cycle_status);
        assert_eq!(converted.background_status, source.background_status);
    }
}
