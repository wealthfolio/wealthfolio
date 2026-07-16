//! Device sync API endpoints for the web server.
//!
//! This module provides REST endpoints that mirror the Tauri device sync commands,
//! using the shared wealthfolio-device-sync crate for cloud API communication.

use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    routing::{delete, get, patch, post},
    Json, Router,
};
use serde::Deserialize;
use tracing::{debug, info, warn};

use crate::api::device_sync_engine;
use crate::error::{ApiError, ApiResult};
use crate::main_lib::AppState;
use wealthfolio_device_sync::{
    ClaimPairingRequest, ClaimPairingResponse, CommitInitializeKeysRequest,
    CommitInitializeKeysResponse, CommitRotateKeysRequest, CommitRotateKeysResponse,
    CompletePairingRequest, CompletePairingResponse, ConfirmPairingRequest, ConfirmPairingResponse,
    CreatePairingRequest, CreatePairingResponse, Device, DeviceSyncClient, EnrollDeviceResponse,
    GetPairingResponse, InitializeKeysResult, PairingMessagesResponse, RegisterDeviceRequest,
    ResetTeamSyncResponse, RotateKeysResponse, SuccessResponse, SyncIdentity, UpdateDeviceRequest,
};

// Storage keys (without prefix - the SecretStore adds "wealthfolio_" prefix)
const DEVICE_ID_KEY: &str = "sync_device_id";
const SYNC_IDENTITY_KEY: &str = "sync_identity";

fn cloud_api_base_url() -> String {
    crate::features::cloud_api_base_url().unwrap_or_default()
}

/// Get a fresh access token by refreshing via the stored refresh token.
async fn get_access_token(state: &AppState) -> ApiResult<String> {
    super::connect::mint_access_token(state).await
}

/// Get the device ID from secret store.
fn get_device_id(state: &AppState) -> Option<String> {
    // Preferred source: sync_identity (used by DeviceEnrollService).
    match state.secret_store.get_secret(SYNC_IDENTITY_KEY) {
        Ok(Some(identity_json)) => match serde_json::from_str::<SyncIdentity>(&identity_json) {
            Ok(identity) => {
                if let Some(device_id) = identity.device_id {
                    debug!(
                        "[DeviceSync] Using device ID from sync_identity: {}",
                        device_id
                    );
                    return Some(device_id);
                }
                debug!("[DeviceSync] sync_identity present but missing deviceId");
            }
            Err(e) => {
                tracing::warn!("[DeviceSync] Failed to parse sync_identity: {}", e);
            }
        },
        Ok(None) => {
            debug!("[DeviceSync] No sync_identity in store");
        }
        Err(e) => {
            tracing::warn!("[DeviceSync] Failed to read sync_identity: {}", e);
        }
    }

    // Legacy fallback for older flows.
    match state.secret_store.get_secret(DEVICE_ID_KEY) {
        Ok(Some(id)) => {
            debug!("[DeviceSync] Using legacy device ID from store: {}", id);
            Some(id)
        }
        Ok(None) => {
            debug!("[DeviceSync] No legacy device ID in store");
            None
        }
        Err(e) => {
            tracing::warn!("[DeviceSync] Failed to read legacy device ID: {}", e);
            None
        }
    }
}

/// Create a device sync client.
fn create_client() -> DeviceSyncClient {
    DeviceSyncClient::new(&cloud_api_base_url())
}

// ─────────────────────────────────────────────────────────────────────────────
// Request/Response Types
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterDeviceBody {
    pub display_name: String,
    pub platform: String,
    pub os_version: Option<String>,
    pub app_version: Option<String>,
    #[serde(alias = "instanceId")]
    pub device_nonce: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDeviceBody {
    pub display_name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListDevicesQuery {
    pub scope: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePairingBody {
    pub code_hash: String,
    pub ephemeral_public_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletePairingBody {
    pub encrypted_key_bundle: String,
    pub sas_proof: serde_json::Value,
    pub signature: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInitializeKeysBody {
    pub key_version: i32,
    pub device_key_envelope: String,
    pub signature: String,
    pub challenge_response: Option<String>,
    pub recovery_envelope: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetTeamSyncBody {
    pub reason: Option<String>,
}

// Claimer-side pairing body types
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimPairingBody {
    pub code: String,
    pub ephemeral_public_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmPairingBody {
    pub proof: String,
    pub min_snapshot_created_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletePairingWithTransferBody {
    pub pairing_id: String,
    pub encrypted_key_bundle: String,
    pub sas_proof: serde_json::Value,
    pub signature: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmPairingWithBootstrapBody {
    pub pairing_id: String,
    pub proof: Option<String>,
    pub min_snapshot_created_at: Option<String>,
    pub allow_overwrite: bool,
}

// Pairing flow coordinator body types
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeginPairingConfirmBody {
    pub pairing_id: String,
    pub proof: String,
    pub min_snapshot_created_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowIdBody {
    pub flow_id: String,
}

// ─────────────────────────────────────────────────────────────────────────────
// Device Management
// ─────────────────────────────────────────────────────────────────────────────

async fn register_device(
    State(state): State<Arc<AppState>>,
    Json(body): Json<RegisterDeviceBody>,
) -> ApiResult<Json<EnrollDeviceResponse>> {
    info!("[DeviceSync] Registering device: {}", body.display_name);

    let token = get_access_token(&state).await?;
    let client = create_client();

    let request = RegisterDeviceRequest {
        device_nonce: body.device_nonce,
        display_name: body.display_name,
        platform: body.platform,
        os_version: body.os_version,
        app_version: body.app_version,
    };

    let result = client
        .enroll_device(&token, request)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    // Extract device_id from the discriminated union response
    let device_id = match &result {
        EnrollDeviceResponse::Bootstrap { device_id, .. } => device_id,
        EnrollDeviceResponse::Pair { device_id, .. } => device_id,
        EnrollDeviceResponse::Ready { device_id, .. } => device_id,
    };

    // Store the device ID
    info!("[DeviceSync] Storing device ID: {}", device_id);
    state
        .secret_store
        .set_secret(DEVICE_ID_KEY, device_id)
        .map_err(|e| ApiError::Internal(format!("Failed to store device ID: {}", e)))?;

    info!("[DeviceSync] Device enrolled successfully: {}", device_id);
    Ok(Json(result))
}

async fn get_device_endpoint(
    State(state): State<Arc<AppState>>,
    Path(device_id): Path<String>,
) -> ApiResult<Json<Device>> {
    let token = get_access_token(&state).await?;

    let device = create_client()
        .get_device(&token, &device_id)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    Ok(Json(device))
}

async fn get_current_device(State(state): State<Arc<AppState>>) -> ApiResult<Json<Device>> {
    let token = get_access_token(&state).await?;
    let device_id = get_device_id(&state)
        .ok_or_else(|| ApiError::BadRequest("No device ID configured".to_string()))?;

    let device = create_client()
        .get_device(&token, &device_id)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    Ok(Json(device))
}

async fn list_devices(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ListDevicesQuery>,
) -> ApiResult<Json<Vec<Device>>> {
    info!("[DeviceSync] Listing devices (scope: {:?})...", query.scope);

    let token = get_access_token(&state).await?;

    let devices = create_client()
        .list_devices(&token, query.scope.as_deref())
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    info!("[DeviceSync] Found {} devices", devices.len());
    Ok(Json(devices))
}

async fn update_device_endpoint(
    State(state): State<Arc<AppState>>,
    Path(device_id): Path<String>,
    Json(body): Json<UpdateDeviceBody>,
) -> ApiResult<Json<SuccessResponse>> {
    info!(
        "Updating device {}: name={:?}",
        device_id, body.display_name
    );

    let token = get_access_token(&state).await?;

    let result = create_client()
        .update_device(
            &token,
            &device_id,
            UpdateDeviceRequest {
                display_name: body.display_name,
                metadata: None,
            },
        )
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    Ok(Json(result))
}

async fn delete_device_endpoint(
    State(state): State<Arc<AppState>>,
    Path(device_id): Path<String>,
) -> ApiResult<Json<SuccessResponse>> {
    info!("Deleting device: {}", device_id);

    let token = get_access_token(&state).await?;

    let result = create_client()
        .delete_device(&token, &device_id)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    Ok(Json(result))
}

async fn revoke_device_endpoint(
    State(state): State<Arc<AppState>>,
    Path(device_id): Path<String>,
) -> ApiResult<Json<SuccessResponse>> {
    info!("Revoking device: {}", device_id);

    let token = get_access_token(&state).await?;

    let result = create_client()
        .revoke_device(&token, &device_id)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    Ok(Json(result))
}

// ─────────────────────────────────────────────────────────────────────────────
// Team Keys (E2EE)
// ─────────────────────────────────────────────────────────────────────────────

async fn initialize_team_keys(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<InitializeKeysResult>> {
    info!("[DeviceSync] Initializing team keys...");

    let token = get_access_token(&state).await?;
    let device_id = get_device_id(&state)
        .ok_or_else(|| ApiError::BadRequest("No device ID configured".to_string()))?;

    let result = create_client()
        .initialize_team_keys(&token, &device_id)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    Ok(Json(result))
}

async fn commit_initialize_team_keys(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CommitInitializeKeysBody>,
) -> ApiResult<Json<CommitInitializeKeysResponse>> {
    info!("[DeviceSync] Committing team key initialization...");

    let token = get_access_token(&state).await?;
    let device_id = get_device_id(&state)
        .ok_or_else(|| ApiError::BadRequest("No device ID configured".to_string()))?;

    let request = CommitInitializeKeysRequest {
        device_id,
        key_version: body.key_version,
        device_key_envelope: body.device_key_envelope,
        signature: body.signature,
        challenge_response: body.challenge_response,
        recovery_envelope: body.recovery_envelope,
    };

    let result = create_client()
        .commit_initialize_team_keys(&token, request)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    Ok(Json(result))
}

async fn rotate_team_keys(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<RotateKeysResponse>> {
    info!("[DeviceSync] Starting key rotation...");

    let token = get_access_token(&state).await?;
    let device_id = get_device_id(&state)
        .ok_or_else(|| ApiError::BadRequest("No device ID configured".to_string()))?;

    let result = create_client()
        .rotate_team_keys(&token, &device_id)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    Ok(Json(result))
}

async fn commit_rotate_team_keys(
    State(state): State<Arc<AppState>>,
    Json(request): Json<CommitRotateKeysRequest>,
) -> ApiResult<Json<CommitRotateKeysResponse>> {
    info!("[DeviceSync] Committing key rotation...");

    let token = get_access_token(&state).await?;
    let device_id = get_device_id(&state)
        .ok_or_else(|| ApiError::BadRequest("No device ID configured".to_string()))?;

    let result = create_client()
        .commit_rotate_team_keys(&token, &device_id, request)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    Ok(Json(result))
}

async fn reset_team_sync(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ResetTeamSyncBody>,
) -> ApiResult<Json<ResetTeamSyncResponse>> {
    info!("[DeviceSync] Resetting team sync...");

    let token = get_access_token(&state).await?;

    let result = create_client()
        .reset_team_sync(&token, body.reason.as_deref())
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    Ok(Json(result))
}

// ─────────────────────────────────────────────────────────────────────────────
// Pairing
// ─────────────────────────────────────────────────────────────────────────────

async fn create_pairing(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreatePairingBody>,
) -> ApiResult<Json<CreatePairingResponse>> {
    debug!("Creating pairing session...");

    let token = get_access_token(&state).await?;
    let device_id = get_device_id(&state)
        .ok_or_else(|| ApiError::BadRequest("No device ID configured".to_string()))?;

    let result = create_client()
        .create_pairing(
            &token,
            &device_id,
            CreatePairingRequest {
                code_hash: body.code_hash,
                ephemeral_public_key: body.ephemeral_public_key,
            },
        )
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    Ok(Json(result))
}

async fn get_pairing(
    State(state): State<Arc<AppState>>,
    Path(pairing_id): Path<String>,
) -> ApiResult<Json<GetPairingResponse>> {
    debug!("Getting pairing session: {}", pairing_id);

    let token = get_access_token(&state).await?;
    let device_id = get_device_id(&state)
        .ok_or_else(|| ApiError::BadRequest("No device ID configured".to_string()))?;

    let result = create_client()
        .get_pairing(&token, &device_id, &pairing_id)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    Ok(Json(result))
}

async fn approve_pairing(
    State(state): State<Arc<AppState>>,
    Path(pairing_id): Path<String>,
) -> ApiResult<Json<SuccessResponse>> {
    debug!("Approving pairing session: {}", pairing_id);

    let token = get_access_token(&state).await?;
    let device_id = get_device_id(&state)
        .ok_or_else(|| ApiError::BadRequest("No device ID configured".to_string()))?;

    let result = create_client()
        .approve_pairing(&token, &device_id, &pairing_id)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    Ok(Json(result))
}

async fn complete_pairing(
    State(state): State<Arc<AppState>>,
    Path(pairing_id): Path<String>,
    Json(body): Json<CompletePairingBody>,
) -> ApiResult<Json<CompletePairingResponse>> {
    debug!("Completing pairing session: {}", pairing_id);

    // Snapshot upload is now handled by the frontend issuer flow BEFORE calling
    // this endpoint, so complete_pairing only sends the key bundle.

    let token = get_access_token(&state).await?;
    let device_id = get_device_id(&state)
        .ok_or_else(|| ApiError::BadRequest("No device ID configured".to_string()))?;

    let result = create_client()
        .complete_pairing(
            &token,
            &device_id,
            &pairing_id,
            CompletePairingRequest {
                encrypted_key_bundle: body.encrypted_key_bundle,
                sas_proof: body.sas_proof,
                signature: body.signature,
            },
        )
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    // Ensure the background sync engine is running (no-op if already active).
    let engine_state = Arc::clone(&state);
    tokio::spawn(async move {
        if let Err(err) = device_sync_engine::ensure_background_engine_started(engine_state).await {
            warn!("[DeviceSync] Post-pairing engine start failed: {}", err);
        }
    });

    Ok(Json(result))
}

async fn cancel_pairing(
    State(state): State<Arc<AppState>>,
    Path(pairing_id): Path<String>,
) -> ApiResult<Json<SuccessResponse>> {
    debug!("Canceling pairing session: {}", pairing_id);

    let token = get_access_token(&state).await?;
    let device_id = get_device_id(&state)
        .ok_or_else(|| ApiError::BadRequest("No device ID configured".to_string()))?;

    let result = create_client()
        .cancel_pairing(&token, &device_id, &pairing_id)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    Ok(Json(result))
}

// ─────────────────────────────────────────────────────────────────────────────
// Pairing (Claimer - New Device)
// ─────────────────────────────────────────────────────────────────────────────

async fn claim_pairing(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ClaimPairingBody>,
) -> ApiResult<Json<ClaimPairingResponse>> {
    debug!("Claiming pairing session with code...");

    let token = get_access_token(&state).await?;
    let device_id = get_device_id(&state)
        .ok_or_else(|| ApiError::BadRequest("No device ID configured".to_string()))?;

    let result = create_client()
        .claim_pairing(
            &token,
            &device_id,
            ClaimPairingRequest {
                code: body.code,
                ephemeral_public_key: body.ephemeral_public_key,
            },
        )
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    Ok(Json(result))
}

async fn get_pairing_messages(
    State(state): State<Arc<AppState>>,
    Path(pairing_id): Path<String>,
) -> ApiResult<Json<PairingMessagesResponse>> {
    debug!("Getting pairing messages: {}", pairing_id);

    let token = get_access_token(&state).await?;
    let device_id = get_device_id(&state)
        .ok_or_else(|| ApiError::BadRequest("No device ID configured".to_string()))?;

    let result = create_client()
        .get_pairing_messages(&token, &device_id, &pairing_id)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    Ok(Json(result))
}

async fn confirm_pairing_endpoint(
    State(state): State<Arc<AppState>>,
    Path(pairing_id): Path<String>,
    Json(body): Json<ConfirmPairingBody>,
) -> ApiResult<Json<ConfirmPairingResponse>> {
    debug!("Confirming pairing session: {}", pairing_id);

    let token = get_access_token(&state).await?;
    let device_id = get_device_id(&state)
        .ok_or_else(|| ApiError::BadRequest("No device ID configured".to_string()))?;

    let result = create_client()
        .confirm_pairing(
            &token,
            &device_id,
            &pairing_id,
            ConfirmPairingRequest {
                proof: Some(body.proof),
            },
        )
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    if let Some(min_created_at) = body.min_snapshot_created_at.as_deref() {
        if let Ok(parsed_min) = wealthfolio_device_sync::parse_sync_datetime_to_utc(min_created_at)
        {
            let max_allowed = chrono::Utc::now() + chrono::Duration::minutes(10);
            if parsed_min > max_allowed {
                warn!(
                    "[DeviceSync] Ignoring minSnapshotCreatedAt too far in the future: {}",
                    min_created_at
                );
            } else {
                match wealthfolio_device_sync::normalize_sync_datetime(min_created_at) {
                    Ok(normalized) => {
                        if let Err(err) = device_sync_engine::set_min_snapshot_created_at_in_store(
                            &device_id,
                            &normalized,
                        ) {
                            warn!(
                                "[DeviceSync] Failed to set in-memory freshness gate after confirm_pairing: {}",
                                err
                            );
                        }
                        // Persist to SQLite so the gate survives process restarts
                        if let Err(err) = state
                            .app_sync_repository
                            .set_min_snapshot_created_at(device_id.clone(), normalized)
                            .await
                        {
                            warn!(
                                "[DeviceSync] Failed to persist freshness gate to SQLite: {}",
                                err
                            );
                        }
                    }
                    Err(err) => {
                        warn!(
                            "[DeviceSync] Ignoring invalid minSnapshotCreatedAt value after normalization: {} ({})",
                            min_created_at, err
                        );
                    }
                }
            }
        } else {
            warn!(
                "[DeviceSync] Ignoring invalid minSnapshotCreatedAt value: {}",
                min_created_at
            );
        }
    }

    Ok(Json(result))
}

// ─────────────────────────────────────────────────────────────────────────────
// Composite Pairing Endpoints
// ─────────────────────────────────────────────────────────────────────────────

async fn complete_pairing_with_transfer(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CompletePairingWithTransferBody>,
) -> ApiResult<Json<serde_json::Value>> {
    device_sync_engine::complete_pairing_with_transfer(
        state,
        body.pairing_id,
        body.encrypted_key_bundle,
        body.sas_proof,
        body.signature,
    )
    .await
    .map_err(ApiError::Internal)?;
    Ok(Json(serde_json::json!({ "success": true })))
}

async fn confirm_pairing_with_bootstrap(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ConfirmPairingWithBootstrapBody>,
) -> ApiResult<Json<device_sync_engine::ConfirmPairingWithBootstrapResult>> {
    let result = device_sync_engine::confirm_pairing_with_bootstrap(
        state,
        body.pairing_id,
        body.proof,
        body.min_snapshot_created_at,
        body.allow_overwrite,
    )
    .await
    .map_err(ApiError::Internal)?;
    Ok(Json(result))
}

// ─────────────────────────────────────────────────────────────────────────────
// Pairing Flow Coordinator
// ─────────────────────────────────────────────────────────────────────────────

async fn begin_pairing_confirm(
    State(state): State<Arc<AppState>>,
    Json(body): Json<BeginPairingConfirmBody>,
) -> ApiResult<Json<wealthfolio_device_sync::engine::PairingFlowResponse>> {
    let result = device_sync_engine::begin_pairing_confirm(
        state,
        body.pairing_id,
        body.proof,
        body.min_snapshot_created_at,
    )
    .await
    .map_err(ApiError::Internal)?;
    Ok(Json(result))
}

async fn get_pairing_flow_state(
    State(state): State<Arc<AppState>>,
    Json(body): Json<FlowIdBody>,
) -> ApiResult<Json<wealthfolio_device_sync::engine::PairingFlowResponse>> {
    let result = device_sync_engine::get_pairing_flow_state_handler(state, body.flow_id)
        .await
        .map_err(ApiError::Internal)?;
    Ok(Json(result))
}

async fn approve_pairing_overwrite_endpoint(
    State(state): State<Arc<AppState>>,
    Json(body): Json<FlowIdBody>,
) -> ApiResult<Json<wealthfolio_device_sync::engine::PairingFlowResponse>> {
    let result = device_sync_engine::approve_pairing_overwrite_handler(state, body.flow_id)
        .await
        .map_err(ApiError::Internal)?;
    Ok(Json(result))
}

async fn cancel_pairing_flow(
    State(state): State<Arc<AppState>>,
    Json(body): Json<FlowIdBody>,
) -> ApiResult<Json<wealthfolio_device_sync::engine::PairingFlowResponse>> {
    let result = device_sync_engine::cancel_pairing_flow_handler(state, body.flow_id)
        .await
        .map_err(ApiError::Internal)?;
    Ok(Json(result))
}

// ─────────────────────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────────────────────

pub fn router() -> Router<Arc<AppState>> {
    if !crate::features::device_sync_enabled() {
        return Router::new();
    }

    Router::new()
        // Device management
        .route("/sync/device/register", post(register_device))
        .route("/sync/device/current", get(get_current_device))
        .route("/sync/devices", get(list_devices))
        .route("/sync/device/{device_id}", get(get_device_endpoint))
        .route("/sync/device/{device_id}", patch(update_device_endpoint))
        .route("/sync/device/{device_id}", delete(delete_device_endpoint))
        .route(
            "/sync/device/{device_id}/revoke",
            post(revoke_device_endpoint),
        )
        // Team keys (E2EE)
        .route("/sync/keys/initialize", post(initialize_team_keys))
        .route(
            "/sync/keys/initialize/commit",
            post(commit_initialize_team_keys),
        )
        .route("/sync/keys/rotate", post(rotate_team_keys))
        .route("/sync/keys/rotate/commit", post(commit_rotate_team_keys))
        .route("/sync/team/reset", post(reset_team_sync))
        // Pairing (Issuer - Trusted Device)
        .route("/sync/pairing", post(create_pairing))
        .route("/sync/pairing/{pairing_id}", get(get_pairing))
        .route("/sync/pairing/{pairing_id}/approve", post(approve_pairing))
        .route(
            "/sync/pairing/{pairing_id}/complete",
            post(complete_pairing),
        )
        .route("/sync/pairing/{pairing_id}/cancel", post(cancel_pairing))
        // Pairing (Claimer - New Device)
        .route("/sync/pairing/claim", post(claim_pairing))
        .route(
            "/sync/pairing/{pairing_id}/messages",
            get(get_pairing_messages),
        )
        .route(
            "/sync/pairing/{pairing_id}/confirm",
            post(confirm_pairing_endpoint),
        )
        // Composite pairing endpoints
        .route(
            "/sync/pairing/complete-with-transfer",
            post(complete_pairing_with_transfer),
        )
        .route(
            "/sync/pairing/confirm-with-bootstrap",
            post(confirm_pairing_with_bootstrap),
        )
        // Pairing flow coordinator
        .route("/sync/pairing/flow/begin", post(begin_pairing_confirm))
        .route("/sync/pairing/flow/state", post(get_pairing_flow_state))
        .route(
            "/sync/pairing/flow/approve-overwrite",
            post(approve_pairing_overwrite_endpoint),
        )
        .route("/sync/pairing/flow/cancel", post(cancel_pairing_flow))
}
