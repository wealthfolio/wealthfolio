//! Commands for device sync and E2EE pairing.
//!
//! This module provides Tauri commands that wrap the shared device sync client,
//! handling token/device ID storage via the keyring.

use crate::profiles::ConnectAccess;
mod engine;
mod restore;
mod snapshot;

use log::{debug, info};
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use tauri::AppHandle;

use crate::context::ServiceContext;
use wealthfolio_core::secrets::SYNC_IDENTITY_KEY;
use wealthfolio_device_sync::engine::{RestoreOperation, StartRestore};
use wealthfolio_device_sync::{
    ClaimPairingRequest, ClaimPairingResponse, CompletePairingRequest, CompletePairingResponse,
    ConfirmPairingRequest, ConfirmPairingResponse, CreatePairingRequest, CreatePairingResponse,
    Device, DeviceSyncClient, GetPairingResponse, PairingMessagesResponse, ResetTeamSyncResponse,
    SuccessResponse, UpdateDeviceRequest,
};

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

pub(crate) fn get_sync_identity_from_store(context: &ServiceContext) -> Option<SyncIdentity> {
    match context.secret_store.get_secret(SYNC_IDENTITY_KEY) {
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

pub(super) fn get_device_id_from_store(context: &ServiceContext) -> Option<String> {
    get_sync_identity_from_store(context).and_then(|identity| identity.device_id)
}

pub(super) fn is_pairing_already_confirmed_error(
    err: &wealthfolio_device_sync::DeviceSyncError,
) -> bool {
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

/// Pairing freshness gates kept in memory beside their SQLite copies.
#[derive(Default)]
pub struct SyncApprovals {
    min_snapshot: Mutex<HashMap<String, String>>,
}
impl SyncApprovals {
    pub(crate) fn clear(&self) -> Result<(), String> {
        self.min_snapshot
            .lock()
            .map_err(|_| "Sync approval state unavailable")?
            .clear();
        Ok(())
    }
}

pub(super) fn get_min_snapshot_created_at_from_store(
    context: &ServiceContext,
    device_id: &str,
) -> Option<String> {
    context
        .sync_approvals
        .min_snapshot
        .lock()
        .ok()
        .and_then(|map| map.get(device_id).cloned())
}

pub(super) fn set_min_snapshot_created_at_in_store(
    context: &ServiceContext,
    device_id: &str,
    value: &str,
) {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return;
    }
    if let Ok(mut guard) = context.sync_approvals.min_snapshot.lock() {
        guard.insert(device_id.to_string(), trimmed.to_string());
    }
}

pub(super) fn clear_min_snapshot_created_at_from_store(context: &ServiceContext) {
    if let Ok(mut guard) = context.sync_approvals.min_snapshot.lock() {
        guard.clear();
    }
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

// ─────────────────────────────────────────────────────────────────────────────
// Shared utility functions
// ─────────────────────────────────────────────────────────────────────────────

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
// Device Management
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command(rename_all = "camelCase")]
pub async fn get_device(device_id: Option<String>, state: ConnectAccess) -> Result<Device, String> {
    let context = state.context()?;
    let token = get_access_token(&context).await?;
    let device_id = device_id
        .or_else(|| get_device_id_from_store(&context))
        .ok_or_else(|| "No device ID configured".to_string())?;

    create_client()?
        .get_device(&token, &device_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_devices(
    scope: Option<String>,
    state: ConnectAccess,
) -> Result<Vec<Device>, String> {
    let context = state.context()?;
    info!("[DeviceSync] Listing devices (scope: {:?})...", scope);

    let token = get_access_token(&context).await?;

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
    state: ConnectAccess,
) -> Result<SuccessResponse, String> {
    let context = state.context()?;
    info!(
        "[DeviceSync] Updating device {}: name={:?}",
        device_id, display_name
    );

    let token = get_access_token(&context).await?;

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
    state: ConnectAccess,
) -> Result<SuccessResponse, String> {
    let context = state.context()?;
    info!("[DeviceSync] Deleting device: {}", device_id);

    let token = get_access_token(&context).await?;

    create_client()?
        .delete_device(&token, &device_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn revoke_device(
    device_id: String,
    state: ConnectAccess,
) -> Result<SuccessResponse, String> {
    let context = state.context()?;
    info!("[DeviceSync] Revoking device: {}", device_id);

    let token = get_access_token(&context).await?;

    create_client()?
        .revoke_device(&token, &device_id)
        .await
        .map_err(|e| e.to_string())
}

// ─────────────────────────────────────────────────────────────────────────────
// Sync reset
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn reset_team_sync(
    reason: Option<String>,
    state: ConnectAccess,
) -> Result<ResetTeamSyncResponse, String> {
    let context = state.context()?;
    info!("[DeviceSync] Resetting team sync...");

    let token = get_access_token(&context).await?;

    create_client()?
        .reset_team_sync(&token, reason.as_deref())
        .await
        .map_err(|e| e.to_string())
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine Status & Tauri Command Wrappers
// ─────────────────────────────────────────────────────────────────────────────

pub async fn sync_engine_status(state: ConnectAccess) -> Result<SyncEngineStatusResult, String> {
    let context = state.context()?;
    let sync_repo = context.app_sync_repository();
    let status = sync_repo.get_engine_status().map_err(|e| e.to_string())?;
    let bootstrap_required = match get_device_id_from_store(&context) {
        Some(device_id) => sync_repo
            .needs_bootstrap(&device_id)
            .map_err(|e| e.to_string())?,
        None => true,
    };
    let runtime = context.device_sync_runtime();
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

pub async fn sync_trigger_cycle(state: ConnectAccess) -> Result<SyncCycleResult, String> {
    let context = state.context()?;
    engine::run_sync_cycle(Arc::clone(&context), false).await
}

#[tauri::command]
pub async fn device_sync_start_background_engine(
    state: ConnectAccess,
) -> Result<SyncBackgroundEngineResult, String> {
    let context = state.context()?;
    ensure_background_engine_started(Arc::clone(&context)).await?;
    let background_running = context.device_sync_runtime().is_background_running().await;
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
    state: ConnectAccess,
) -> Result<SyncBackgroundEngineResult, String> {
    let context = state.context()?;
    ensure_background_engine_stopped(Arc::clone(&context)).await?;
    Ok(SyncBackgroundEngineResult {
        status: "stopped".to_string(),
        message: "Device sync background engine stopped".to_string(),
    })
}

#[tauri::command]
pub async fn device_sync_generate_snapshot_now(
    handle: AppHandle,
    state: ConnectAccess,
) -> Result<SyncSnapshotUploadResult, String> {
    let context = state.context()?;
    snapshot::generate_snapshot_now_internal(Some(&handle), Arc::clone(&context)).await
}

#[tauri::command]
pub async fn device_sync_cancel_snapshot_upload(
    state: ConnectAccess,
) -> Result<SyncBackgroundEngineResult, String> {
    let context = state.context()?;
    context
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
    state: ConnectAccess,
) -> Result<SyncEngineStatusResult, String> {
    sync_engine_status(state).await
}

#[tauri::command]
pub async fn device_sync_pairing_source_status(
    state: ConnectAccess,
) -> Result<SyncPairingSourceStatusResult, String> {
    let context = state.context()?;
    snapshot::get_pairing_source_status_internal(Arc::clone(&context)).await
}

#[tauri::command]
pub async fn device_sync_trigger_cycle(state: ConnectAccess) -> Result<SyncCycleResult, String> {
    sync_trigger_cycle(state).await
}

// ─────────────────────────────────────────────────────────────────────────────
// Pairing — Issuer Side
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command(rename_all = "camelCase")]
pub async fn create_pairing(
    code_hash: String,
    ephemeral_public_key: String,
    state: ConnectAccess,
) -> Result<CreatePairingResponse, String> {
    let context = state.context()?;
    debug!("[DeviceSync] Creating pairing session...");

    let token = get_access_token(&context).await?;
    let device_id =
        get_device_id_from_store(&context).ok_or_else(|| "No device ID configured".to_string())?;

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
    state: ConnectAccess,
) -> Result<GetPairingResponse, String> {
    let context = state.context()?;
    debug!("[DeviceSync] Getting pairing session: {}", pairing_id);

    let token = get_access_token(&context).await?;
    let device_id =
        get_device_id_from_store(&context).ok_or_else(|| "No device ID configured".to_string())?;

    create_client()?
        .get_pairing(&token, &device_id, &pairing_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn approve_pairing(
    pairing_id: String,
    state: ConnectAccess,
) -> Result<SuccessResponse, String> {
    let context = state.context()?;
    debug!("[DeviceSync] Approving pairing session: {}", pairing_id);

    let token = get_access_token(&context).await?;
    let device_id =
        get_device_id_from_store(&context).ok_or_else(|| "No device ID configured".to_string())?;

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
    state: ConnectAccess,
) -> Result<CompletePairingResponse, String> {
    let context = state.context()?;
    debug!("[DeviceSync] Completing pairing session: {}", pairing_id);

    // Snapshot upload is now handled by the frontend issuer flow BEFORE calling
    // this command, so complete_pairing only sends the key bundle.

    let token = get_access_token(&context).await?;
    let device_id =
        get_device_id_from_store(&context).ok_or_else(|| "No device ID configured".to_string())?;

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
    let engine_context = Arc::clone(&context);
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
    state: ConnectAccess,
) -> Result<SuccessResponse, String> {
    let context = state.context()?;
    debug!("[DeviceSync] Canceling pairing session: {}", pairing_id);

    let token = get_access_token(&context).await?;
    let device_id =
        get_device_id_from_store(&context).ok_or_else(|| "No device ID configured".to_string())?;

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
    state: ConnectAccess,
) -> Result<ClaimPairingResponse, String> {
    let context = state.context()?;
    info!("[DeviceSync] Claiming pairing session...");

    let token = get_access_token(&context).await?;
    let device_id =
        get_device_id_from_store(&context).ok_or_else(|| "No device ID configured".to_string())?;

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
    state: ConnectAccess,
) -> Result<PairingMessagesResponse, String> {
    let context = state.context()?;
    debug!("[DeviceSync] Polling for pairing messages: {}", pairing_id);

    let token = get_access_token(&context).await?;
    let device_id =
        get_device_id_from_store(&context).ok_or_else(|| "No device ID configured".to_string())?;

    create_client()?
        .get_pairing_messages(&token, &device_id, &pairing_id)
        .await
        .map_err(|e| e.to_string())
}

/// Issuer: Sync cycle → snapshot → approve → complete pairing atomically.
#[tauri::command(rename_all = "camelCase")]
pub async fn complete_pairing_with_transfer(
    pairing_id: String,
    encrypted_key_bundle: String,
    sas_proof: serde_json::Value,
    signature: String,
    handle: AppHandle,
    state: ConnectAccess,
) -> Result<serde_json::Value, String> {
    let context = state.context()?;
    info!("[DeviceSync] complete_pairing_with_transfer: starting");
    let cloned_context = Arc::clone(&context);
    let identity = get_sync_identity_from_store(&context)
        .ok_or_else(|| "No sync identity configured".to_string())?;
    let device_id = identity
        .device_id
        .clone()
        .ok_or_else(|| "No device ID configured".to_string())?;

    // 1. Run sync cycle to flush any pending outbox events
    info!("[DeviceSync] complete_pairing_with_transfer: running sync cycle");
    let _cycle_result = engine::run_sync_cycle(Arc::clone(&cloned_context), false).await?;

    // 2. Generate snapshot (full local SQLite export — always contains all local data)
    info!("[DeviceSync] complete_pairing_with_transfer: generating snapshot");
    let snapshot =
        snapshot::generate_snapshot_now_internal(Some(&handle), Arc::clone(&cloned_context))
            .await?;
    if snapshot.status != "uploaded" {
        return Err(format!("Snapshot upload failed: {}", snapshot.message));
    }

    // 3. Approve pairing
    let token = get_access_token(&context).await?;
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
    let engine_context = Arc::clone(&context);
    tauri::async_runtime::spawn(async move {
        if let Err(err) = ensure_background_engine_started(engine_context).await {
            log::warn!("[DeviceSync] Post-pairing engine start failed: {}", err);
        }
    });

    Ok(serde_json::json!({ "success": true }))
}

// ─────────────────────────────────────────────────────────────────────────────
// Restore Operation
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command(rename_all = "camelCase")]
pub async fn device_sync_start_restore(
    new_attempt: bool,
    handle: AppHandle,
    state: ConnectAccess,
) -> Result<Option<RestoreOperation>, String> {
    let context = state.context()?;
    let ports = restore::restore_ports(&context, handle, &state);
    context
        .device_sync_runtime()
        .start_restore(
            ports,
            if new_attempt {
                StartRestore::NewAttempt
            } else {
                StartRestore::Recurring
            },
        )
        .await
}

/// Read-only: polling never starts or advances restoration.
#[tauri::command]
pub async fn device_sync_get_restore(
    state: ConnectAccess,
) -> Result<Option<RestoreOperation>, String> {
    state.context()?.device_sync_runtime().restore_operation()
}

#[tauri::command(rename_all = "camelCase")]
pub async fn device_sync_approve_restore(
    operation_id: String,
    backup: bool,
    handle: AppHandle,
    state: ConnectAccess,
) -> Result<RestoreOperation, String> {
    let context = state.context()?;
    let ports = restore::restore_ports(&context, handle, &state);
    context
        .device_sync_runtime()
        .approve_restore(ports, &operation_id, backup)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn device_sync_retry_restore(
    operation_id: String,
    handle: AppHandle,
    state: ConnectAccess,
) -> Result<RestoreOperation, String> {
    let context = state.context()?;
    let ports = restore::restore_ports(&context, handle, &state);
    context
        .device_sync_runtime()
        .retry_restore(ports, &operation_id)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn device_sync_cancel_restore(
    operation_id: String,
    handle: AppHandle,
    state: ConnectAccess,
) -> Result<RestoreOperation, String> {
    let context = state.context()?;
    let ports = restore::restore_ports(&context, handle, &state);
    context
        .device_sync_runtime()
        .cancel_restore(&*ports, &operation_id)
}

/// Receiving device: confirm pairing and hand restoration to the restore owner.
#[tauri::command(rename_all = "camelCase")]
pub async fn device_sync_begin_pairing_restore(
    pairing_id: String,
    proof: String,
    min_snapshot_created_at: Option<String>,
    handle: AppHandle,
    state: ConnectAccess,
) -> Result<RestoreOperation, String> {
    restore::begin_pairing_restore(pairing_id, proof, min_snapshot_created_at, handle, state).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn confirm_pairing(
    pairing_id: String,
    proof: Option<String>,
    min_snapshot_created_at: Option<String>,
    state: ConnectAccess,
) -> Result<ConfirmPairingResponse, String> {
    let context = state.context()?;
    info!("[DeviceSync] Confirming pairing: {}", pairing_id);

    let token = get_access_token(&context).await?;
    let device_id =
        get_device_id_from_store(&context).ok_or_else(|| "No device ID configured".to_string())?;

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
                        set_min_snapshot_created_at_in_store(&context, &device_id, &normalized);
                        // Persist to SQLite so the gate survives process restarts
                        if let Err(err) = context
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
}
