use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, OnceLock};

use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
use chrono::{Duration, Utc};
use uuid::Uuid;

use crate::main_lib::AppState;
use wealthfolio_core::events::DomainEvent;
use wealthfolio_core::sync::APP_SYNC_TABLES;
use wealthfolio_device_sync::engine::{
    self, CredentialStore, OutboxStore, ReadyReconcileStore, ReplayEvent, ReplayStore,
    SyncIdentity, SyncTransport, TransportError,
};
use wealthfolio_device_sync::{
    DeviceSyncClient, ReconcileReadyStateResponse, SyncPullResponse, SyncPushRequest,
    SyncPushResponse, SyncState,
};

fn transport_err_from_sync(e: wealthfolio_device_sync::DeviceSyncError) -> TransportError {
    TransportError {
        message: e.to_string(),
        retry_class: e.retry_class(),
        error_code: e.error_code().map(|s| s.to_string()),
        details: match &e {
            wealthfolio_device_sync::DeviceSyncError::Api { details, .. } => details.clone(),
            _ => None,
        },
    }
}
use wealthfolio_storage_sqlite::sync::{SqliteSyncEngineDbPorts, SyncTableRowCount};

const SYNC_IDENTITY_KEY: &str = "sync_identity";
const DEVICE_ID_KEY: &str = "sync_device_id";
static MIN_SNAPSHOT_CREATED_AT: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
static READY_STATE_OVERWRITE_APPROVALS: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();
static PAIRING_OVERWRITE_APPROVALS: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();
const SNAPSHOT_FRESHNESS_CLOCK_SKEW_LEEWAY_SECS: i64 = 120;
const SYNC_SOURCE_RESTORE_REQUIRED_CODE: &str = "SYNC_SOURCE_RESTORE_REQUIRED";

fn is_snapshot_index_conflict(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    message.contains("sync_transaction_failed") && message.contains("snapshot index conflict")
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

#[derive(Debug, Clone)]
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

#[derive(Debug, Clone)]
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

#[derive(Debug, Clone)]
pub struct SyncBootstrapOverwriteCheckResult {
    pub bootstrap_required: bool,
    pub has_local_data: bool,
    pub local_rows: i64,
    pub non_empty_tables: Vec<SyncBootstrapOverwriteCheckTableResult>,
}

#[derive(Debug, Clone)]
pub struct SyncBootstrapResult {
    pub status: String,
    pub message: String,
    pub snapshot_id: Option<String>,
    pub cursor: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct SyncSnapshotUploadResult {
    pub status: String,
    pub snapshot_id: Option<String>,
    pub oplog_seq: Option<i64>,
    pub message: String,
}

#[derive(Debug, Clone)]
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

impl From<engine::SyncReadyReconcileResult> for SyncReconcileReadyStateResult {
    fn from(value: engine::SyncReadyReconcileResult) -> Self {
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

fn cloud_api_base_url() -> String {
    crate::features::cloud_api_base_url().unwrap_or_default()
}

fn ensure_device_sync_enabled() -> Result<(), String> {
    if crate::features::device_sync_enabled() {
        Ok(())
    } else {
        Err("Device sync feature is disabled in this build.".to_string())
    }
}

fn create_client() -> DeviceSyncClient {
    DeviceSyncClient::new(&cloud_api_base_url())
}

pub(crate) fn get_sync_identity_from_store(state: &AppState) -> Option<SyncIdentity> {
    let raw = state
        .secret_store
        .get_secret(SYNC_IDENTITY_KEY)
        .ok()
        .flatten()?;
    let identity: wealthfolio_device_sync::SyncIdentity = serde_json::from_str(&raw).ok()?;
    Some(SyncIdentity {
        device_id: identity.device_id,
        root_key: identity.root_key,
        key_version: identity.key_version,
    })
}

pub(crate) fn sync_identity_can_run_background(identity: &SyncIdentity) -> bool {
    identity.device_id.is_some() && identity.root_key.is_some()
}

fn min_snapshot_created_at_state() -> &'static Mutex<HashMap<String, String>> {
    MIN_SNAPSHOT_CREATED_AT.get_or_init(|| Mutex::new(HashMap::new()))
}

fn ready_state_overwrite_approval_state() -> &'static Mutex<HashMap<String, bool>> {
    READY_STATE_OVERWRITE_APPROVALS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn pairing_overwrite_approval_state() -> &'static Mutex<HashMap<String, bool>> {
    PAIRING_OVERWRITE_APPROVALS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn set_min_snapshot_created_at_in_store(device_id: &str, value: &str) -> Result<(), String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    let mut guard = min_snapshot_created_at_state()
        .lock()
        .map_err(|_| "Failed to lock in-memory freshness gate".to_string())?;
    guard.insert(device_id.to_string(), trimmed.to_string());
    Ok(())
}

fn remove_min_snapshot_created_at_from_store(device_id: &str) {
    if let Ok(mut guard) = min_snapshot_created_at_state().lock() {
        guard.remove(device_id);
    }
}

pub fn clear_min_snapshot_created_at_from_store() {
    if let Ok(mut guard) = min_snapshot_created_at_state().lock() {
        guard.clear();
    }
}

fn get_min_snapshot_created_at_from_store(device_id: &str) -> Option<String> {
    min_snapshot_created_at_state()
        .lock()
        .ok()
        .and_then(|map| map.get(device_id).cloned())
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

async fn abort_pairing_flow_local_state(state: &Arc<AppState>, pairing_id: &str) {
    clear_pairing_overwrite_approval(pairing_id);

    let device_id = get_sync_identity_from_store(state).and_then(|identity| identity.device_id);
    if let Some(device_id) = device_id.as_deref() {
        if let Ok(token) = crate::api::connect::mint_access_token(state).await {
            let client = create_client();
            let _ = client.cancel_pairing(&token, device_id, pairing_id).await;
            if let Err(err) = client.delete_device(&token, device_id).await {
                tracing::warn!(
                    "[DeviceSync] Failed to delete confirmed pairing device while cancelling flow: {}",
                    err
                );
            }
        }
        remove_min_snapshot_created_at_from_store(device_id);
        let _ = state
            .app_sync_repository
            .clear_min_snapshot_created_at(device_id.to_string())
            .await;
    }

    if let Err(err) = ensure_background_engine_stopped(Arc::clone(state)).await {
        tracing::warn!(
            "[DeviceSync] Failed to stop engine while cancelling pairing flow: {}",
            err
        );
    }
    if let Err(err) = state.device_enroll_service.clear_sync_data() {
        tracing::warn!(
            "[DeviceSync] Failed to clear local sync identity while cancelling pairing flow: {}",
            err.message
        );
    }
    let _ = state.app_sync_repository.reset_local_sync_session().await;
    let _ = state.secret_store.delete_secret(DEVICE_ID_KEY);
    clear_min_snapshot_created_at_from_store();
    let _ = state
        .app_sync_repository
        .clear_all_min_snapshot_created_at()
        .await;
}

fn should_keep_ready_state_overwrite_approval(result: &engine::SyncReadyReconcileResult) -> bool {
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
    state: &AppState,
    identity: &SyncIdentity,
    trust_state: &str,
) {
    if let Some(device_id) = &identity.device_id {
        let _ = state
            .app_sync_repository
            .upsert_device_config(
                device_id.clone(),
                identity.key_version,
                trust_state.to_string(),
            )
            .await;
    }
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

fn is_sqlite_image(bytes: &[u8]) -> bool {
    bytes.starts_with(b"SQLite format 3\0")
}

fn sha256_checksum(bytes: &[u8]) -> String {
    wealthfolio_device_sync::crypto::sha256_checksum(bytes)
}

fn decode_snapshot_sqlite_payload(
    blob: Vec<u8>,
    identity: &SyncIdentity,
) -> Result<Vec<u8>, String> {
    let root_key = identity
        .root_key
        .as_deref()
        .ok_or("Missing root_key in sync identity")?;
    let key_version = identity
        .key_version
        .ok_or("Missing key_version in sync identity")?;
    if key_version <= 0 {
        return Err("Invalid key version in sync identity".to_string());
    }

    let blob_text = String::from_utf8(blob)
        .map_err(|_| "Snapshot payload is not valid UTF-8 (expected encrypted ciphertext)")?;
    let dek = wealthfolio_device_sync::crypto::derive_dek(root_key, key_version as u32)
        .map_err(|e| format!("Failed to derive snapshot DEK: {}", e))?;
    let decrypted = wealthfolio_device_sync::crypto::decrypt(&dek, blob_text.trim())
        .map_err(|e| format!("Failed to decrypt snapshot payload: {}", e))?;

    let sqlite_bytes = BASE64_STANDARD
        .decode(decrypted.trim())
        .map_err(|e| format!("Failed to base64-decode decrypted snapshot: {}", e))?;
    if !is_sqlite_image(&sqlite_bytes) {
        return Err("Decrypted snapshot is not a valid SQLite image".to_string());
    }
    Ok(sqlite_bytes)
}

struct ServerEnginePorts {
    state: Arc<AppState>,
    db: SqliteSyncEngineDbPorts,
}

impl ServerEnginePorts {
    fn new(state: Arc<AppState>) -> Self {
        let db = SqliteSyncEngineDbPorts::new(Arc::clone(&state.app_sync_repository));
        Self { state, db }
    }
}

#[async_trait]
impl OutboxStore for ServerEnginePorts {
    async fn list_pending_outbox(
        &self,
        limit: i64,
    ) -> Result<Vec<wealthfolio_core::sync::SyncOutboxEvent>, String> {
        self.db.list_pending_outbox(limit).await
    }

    async fn mark_outbox_dead(
        &self,
        event_ids: Vec<String>,
        error_message: Option<String>,
        error_code: Option<String>,
    ) -> Result<(), String> {
        self.db
            .mark_outbox_dead(event_ids, error_message, error_code)
            .await
    }

    async fn mark_outbox_sent(&self, event_ids: Vec<String>) -> Result<(), String> {
        self.db.mark_outbox_sent(event_ids).await
    }

    async fn schedule_outbox_retry(
        &self,
        event_ids: Vec<String>,
        delay_seconds: i64,
        error_message: Option<String>,
        error_code: Option<String>,
    ) -> Result<(), String> {
        self.db
            .schedule_outbox_retry(event_ids, delay_seconds, error_message, error_code)
            .await
    }

    async fn mark_push_completed(&self) -> Result<(), String> {
        self.db.mark_push_completed().await
    }

    async fn has_pending_outbox(&self) -> Result<bool, String> {
        self.db.has_pending_outbox().await
    }
}

#[async_trait]
impl ReplayStore for ServerEnginePorts {
    async fn acquire_cycle_lock(&self) -> Result<i64, String> {
        self.db.acquire_cycle_lock().await
    }

    async fn verify_cycle_lock(&self, lock_version: i64) -> Result<bool, String> {
        self.db.verify_cycle_lock(lock_version).await
    }

    async fn get_cursor(&self) -> Result<i64, String> {
        self.db.get_cursor().await
    }

    async fn set_cursor(&self, cursor: i64) -> Result<(), String> {
        self.db.set_cursor(cursor).await
    }

    async fn apply_remote_events_lww_batch(
        &self,
        events: Vec<ReplayEvent>,
    ) -> Result<usize, String> {
        self.db.apply_remote_events_lww_batch(events).await
    }

    async fn apply_remote_event_lww(&self, event: ReplayEvent) -> Result<bool, String> {
        self.db.apply_remote_event_lww(event).await
    }

    async fn mark_pull_completed(&self) -> Result<(), String> {
        self.db.mark_pull_completed().await
    }

    async fn mark_cycle_outcome(
        &self,
        status: String,
        duration_ms: i64,
        next_retry_at: Option<String>,
    ) -> Result<(), String> {
        self.db
            .mark_cycle_outcome(status, duration_ms, next_retry_at)
            .await
    }

    async fn mark_engine_error(&self, message: String) -> Result<(), String> {
        self.db.mark_engine_error(message).await
    }

    async fn prune_sync_outbox(
        &self,
        sent_before: chrono::DateTime<chrono::Utc>,
        dead_before: chrono::DateTime<chrono::Utc>,
    ) -> Result<usize, String> {
        self.db.prune_sync_outbox(sent_before, dead_before).await
    }

    async fn prune_applied_events_up_to_seq(&self, seq: i64) -> Result<(), String> {
        self.db.prune_applied_events_up_to_seq(seq).await
    }

    async fn get_engine_status(&self) -> Result<wealthfolio_core::sync::SyncEngineStatus, String> {
        self.db.get_engine_status().await
    }

    async fn on_pull_complete(&self, pulled_count: usize) -> Result<(), String> {
        if pulled_count > 0 {
            self.state
                .domain_event_sink
                .emit(DomainEvent::device_sync_pull_complete());
        }
        Ok(())
    }
}

#[async_trait]
impl SyncTransport for ServerEnginePorts {
    async fn get_events_cursor(
        &self,
        token: &str,
        device_id: &str,
    ) -> Result<wealthfolio_device_sync::SyncCursorResponse, TransportError> {
        create_client()
            .get_events_cursor(token, device_id)
            .await
            .map_err(transport_err_from_sync)
    }

    async fn push_events(
        &self,
        token: &str,
        device_id: &str,
        request: SyncPushRequest,
    ) -> Result<SyncPushResponse, TransportError> {
        create_client()
            .push_events(token, device_id, request)
            .await
            .map_err(transport_err_from_sync)
    }

    async fn pull_events(
        &self,
        token: &str,
        device_id: &str,
        from_cursor: Option<i64>,
        limit: Option<i64>,
    ) -> Result<SyncPullResponse, TransportError> {
        create_client()
            .pull_events(
                token,
                device_id,
                from_cursor,
                limit.map(|value| value as i32),
            )
            .await
            .map_err(transport_err_from_sync)
    }

    async fn get_reconcile_ready_state(
        &self,
        token: &str,
        device_id: &str,
    ) -> Result<ReconcileReadyStateResponse, TransportError> {
        create_client()
            .get_reconcile_ready_state(token, device_id)
            .await
            .map_err(transport_err_from_sync)
    }
}

#[async_trait]
impl CredentialStore for ServerEnginePorts {
    fn get_sync_identity(&self) -> Option<SyncIdentity> {
        get_sync_identity_from_store(&self.state)
    }

    fn get_access_token(&self) -> Result<String, String> {
        tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current()
                .block_on(crate::api::connect::mint_access_token(&self.state))
                .map_err(|e| e.to_string())
        })
    }

    async fn get_sync_state(&self) -> Result<SyncState, String> {
        let token = crate::api::connect::mint_access_token(&self.state)
            .await
            .map_err(|e| e.to_string())?;
        self.state
            .device_enroll_service
            .get_sync_state(&token)
            .await
            .map(|value| value.state)
            .map_err(|err| err.message)
    }

    async fn persist_device_config(&self, identity: &SyncIdentity, trust_state: &str) {
        persist_device_config_from_identity(&self.state, identity, trust_state).await;
    }

    fn encrypt_sync_payload(
        &self,
        plaintext_payload: &str,
        identity: &SyncIdentity,
        payload_key_version: i32,
    ) -> Result<String, String> {
        encrypt_sync_payload(plaintext_payload, identity, payload_key_version)
    }

    fn decrypt_sync_payload(
        &self,
        encrypted_payload: &str,
        identity: &SyncIdentity,
        payload_key_version: i32,
    ) -> Result<String, String> {
        decrypt_sync_payload(encrypted_payload, identity, payload_key_version)
    }
}

pub async fn get_engine_status(state: &Arc<AppState>) -> Result<SyncEngineStatusResult, String> {
    ensure_device_sync_enabled()?;
    let status = state
        .app_sync_repository
        .get_engine_status()
        .map_err(|e| e.to_string())?;
    let bootstrap_required = match get_sync_identity_from_store(state).and_then(|i| i.device_id) {
        Some(device_id) => state
            .app_sync_repository
            .needs_bootstrap(&device_id)
            .map_err(|e| e.to_string())?,
        None => true,
    };
    let background_running = state.device_sync_runtime.is_background_running().await;

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

pub async fn get_pairing_source_status(
    state: &Arc<AppState>,
) -> Result<SyncPairingSourceStatusResult, String> {
    ensure_device_sync_enabled()?;
    let identity = get_sync_identity_from_store(state)
        .ok_or_else(|| "No sync identity configured. Please enable sync first.".to_string())?;
    let device_id = identity
        .device_id
        .clone()
        .ok_or_else(|| "No device ID configured".to_string())?;
    let token = crate::api::connect::mint_access_token(state)
        .await
        .map_err(|e| e.to_string())?;
    let client = create_client();
    let sync_state = client
        .get_device(&token, &device_id)
        .await
        .map_err(|e| e.to_string())?;
    if sync_state.trust_state != wealthfolio_device_sync::TrustState::Trusted {
        return Err("Current device is not ready to connect another device yet.".to_string());
    }

    let local_cursor = state
        .app_sync_repository
        .get_cursor()
        .map_err(|e| e.to_string())?;
    let server_cursor = client
        .get_events_cursor(&token, &device_id)
        .await
        .map_err(|e| e.to_string())?
        .cursor;

    if local_cursor > server_cursor {
        return Ok(SyncPairingSourceStatusResult {
            status: "restore_required".to_string(),
            message: "This device needs to set up sync again before you add another device."
                .to_string(),
            local_cursor,
            server_cursor,
        });
    }

    Ok(SyncPairingSourceStatusResult {
        status: "ready".to_string(),
        message: "This device is ready to connect another device.".to_string(),
        local_cursor,
        server_cursor,
    })
}

pub async fn get_bootstrap_overwrite_check(
    state: &Arc<AppState>,
) -> Result<SyncBootstrapOverwriteCheckResult, String> {
    ensure_device_sync_enabled()?;
    let device_id = get_sync_identity_from_store(state).and_then(|i| i.device_id);
    let bootstrap_required = match device_id.as_deref() {
        Some(device_id) => state
            .app_sync_repository
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

    let summary = state
        .app_sync_repository
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

pub async fn run_sync_cycle(
    state: Arc<AppState>,
    post_bootstrap: bool,
) -> Result<engine::SyncCycleResult, String> {
    ensure_device_sync_enabled()?;
    let ports = ServerEnginePorts::new(Arc::clone(&state));
    let result = state
        .device_sync_runtime
        .run_cycle(&ports, post_bootstrap)
        .await?;

    // Note: on_pull_complete is now called by the engine itself via ReplayStore trait

    Ok(result)
}

struct ServerReadyReconcileRunner {
    state: Arc<AppState>,
}

#[async_trait]
impl ReadyReconcileStore for ServerReadyReconcileRunner {
    async fn get_sync_state(&self) -> Result<SyncState, String> {
        let token = crate::api::connect::mint_access_token(&self.state)
            .await
            .map_err(|e| e.to_string())?;
        self.state
            .device_enroll_service
            .get_sync_state(&token)
            .await
            .map(|value| value.state)
            .map_err(|err| err.message)
    }

    async fn bootstrap_snapshot_if_needed(&self) -> Result<engine::SyncBootstrapResult, String> {
        let result = sync_bootstrap_snapshot_if_needed(Arc::clone(&self.state)).await?;
        Ok(engine::SyncBootstrapResult {
            status: result.status,
            message: result.message,
            snapshot_id: result.snapshot_id,
        })
    }

    async fn run_sync_cycle(
        &self,
        post_bootstrap: bool,
    ) -> Result<engine::SyncCycleResult, String> {
        run_sync_cycle(Arc::clone(&self.state), post_bootstrap).await
    }

    async fn ensure_background_started(&self) -> Result<bool, String> {
        ensure_background_engine_started(Arc::clone(&self.state)).await?;
        Ok(self.state.device_sync_runtime.is_background_running().await)
    }
}

pub async fn reconcile_ready_state(
    state: Arc<AppState>,
    allow_overwrite: bool,
) -> Result<SyncReconcileReadyStateResult, String> {
    ensure_device_sync_enabled()?;
    let device_id = get_sync_identity_from_store(&state).and_then(|identity| identity.device_id);
    let has_overwrite_approval = device_id
        .as_deref()
        .map(has_ready_state_overwrite_approval)
        .unwrap_or(false);
    if allow_overwrite {
        if let Some(device_id) = device_id.as_deref() {
            set_ready_state_overwrite_approval(device_id);
        }
    }
    let runner = ServerReadyReconcileRunner { state };
    let result = engine::run_ready_reconcile_state(&runner).await;

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

pub async fn ensure_background_engine_started(state: Arc<AppState>) -> Result<(), String> {
    ensure_device_sync_enabled()?;
    let Some(identity) = get_sync_identity_from_store(&state) else {
        return Ok(());
    };
    if !sync_identity_can_run_background(&identity) {
        return Ok(());
    }
    let ports = Arc::new(ServerEnginePorts::new(Arc::clone(&state)));
    state
        .device_sync_runtime
        .ensure_background_started(ports)
        .await;
    Ok(())
}

pub async fn ensure_background_engine_stopped(state: Arc<AppState>) -> Result<(), String> {
    ensure_device_sync_enabled()?;
    state.device_sync_runtime.ensure_background_stopped().await;
    Ok(())
}

fn snapshot_upload_cancelled_result(message: &str) -> SyncSnapshotUploadResult {
    SyncSnapshotUploadResult {
        status: "cancelled".to_string(),
        snapshot_id: None,
        oplog_seq: None,
        message: message.to_string(),
    }
}

fn sync_source_restore_required_error() -> String {
    format!(
        "{SYNC_SOURCE_RESTORE_REQUIRED_CODE}: This device needs to set up sync again before you add another device."
    )
}

enum MissingSnapshotDisposition {
    CompleteNoBootstrap { message: String },
    WaitForSnapshot { message: String },
}

async fn classify_missing_snapshot_disposition(
    client: &DeviceSyncClient,
    token: &str,
    device_id: &str,
) -> MissingSnapshotDisposition {
    match client.get_reconcile_ready_state(token, device_id).await {
        Ok(reconcile) => match reconcile.action.as_str() {
            "NOOP" | "PULL_TAIL" => MissingSnapshotDisposition::CompleteNoBootstrap {
                message: "No remote snapshot is required for this device".to_string(),
            },
            "WAIT_SNAPSHOT" | "BOOTSTRAP_SNAPSHOT" => MissingSnapshotDisposition::WaitForSnapshot {
                message: "Waiting for a trusted device to upload a snapshot".to_string(),
            },
            other => {
                tracing::debug!(
                    "[DeviceSync] Snapshot missing with reconcile action='{}'; waiting for remote snapshot",
                    other
                );
                MissingSnapshotDisposition::WaitForSnapshot {
                    message:
                        "Snapshot is not available yet. Waiting for upload from a trusted device."
                            .to_string(),
                }
            }
        },
        Err(err) => {
            tracing::debug!(
                "[DeviceSync] Failed to inspect reconcile action while snapshot missing: {}",
                err
            );
            MissingSnapshotDisposition::WaitForSnapshot {
                message: "Snapshot is not available yet. Waiting for upload from a trusted device."
                    .to_string(),
            }
        }
    }
}

async fn snapshot_satisfies_freshness_gate(
    client: &DeviceSyncClient,
    token: &str,
    device_id: &str,
    latest: &wealthfolio_device_sync::SnapshotLatestResponse,
    min_created_at: &str,
) -> Result<bool, String> {
    let latest_created_at = wealthfolio_device_sync::parse_sync_datetime_to_utc(&latest.created_at)
        .map_err(|e| format!("Invalid snapshot created_at in metadata: {}", e))?;
    let min_created_at = wealthfolio_device_sync::parse_sync_datetime_to_utc(min_created_at)
        .map_err(|e| format!("Invalid min snapshot freshness gate: {}", e))?;
    if latest_created_at + Duration::seconds(SNAPSHOT_FRESHNESS_CLOCK_SKEW_LEEWAY_SECS)
        > min_created_at
    {
        return Ok(true);
    }

    match client.get_events_cursor(token, device_id).await {
        Ok(cursor) if latest.oplog_seq >= cursor.cursor => {
            tracing::info!(
                "[DeviceSync] Accepting snapshot {} older than freshness gate because oplog_seq {} already covers remote cursor {}",
                latest.snapshot_id,
                latest.oplog_seq,
                cursor.cursor
            );
            Ok(true)
        }
        Ok(cursor) => {
            tracing::debug!(
                "[DeviceSync] Snapshot {} is older than freshness gate and oplog_seq {} does not cover remote cursor {}",
                latest.snapshot_id,
                latest.oplog_seq,
                cursor.cursor
            );
            Ok(false)
        }
        Err(err) => {
            tracing::debug!(
                "[DeviceSync] Failed to verify remote cursor for freshness gate on snapshot {}: {}",
                latest.snapshot_id,
                err
            );
            Ok(false)
        }
    }
}

pub async fn sync_bootstrap_snapshot_if_needed(
    state: Arc<AppState>,
) -> Result<SyncBootstrapResult, String> {
    ensure_device_sync_enabled()?;
    let identity = get_sync_identity_from_store(&state)
        .ok_or_else(|| "No sync identity configured. Please enable sync first.".to_string())?;
    let device_id = identity
        .device_id
        .clone()
        .ok_or_else(|| "No device ID configured".to_string())?;
    let token = crate::api::connect::mint_access_token(&state)
        .await
        .map_err(|e| e.to_string())?;
    // Check in-memory first, then fall back to SQLite (survives restart)
    let raw_freshness_gate = get_min_snapshot_created_at_from_store(&device_id).or_else(|| {
        state
            .app_sync_repository
            .get_min_snapshot_created_at(&device_id)
            .ok()
            .flatten()
    });
    let min_snapshot_created_at = match raw_freshness_gate {
        Some(value) => match wealthfolio_device_sync::normalize_sync_datetime(&value) {
            Ok(normalized) => Some(normalized),
            Err(_) => {
                tracing::warn!(
                    "[DeviceSync] Dropping invalid min snapshot freshness gate: {}",
                    value
                );
                remove_min_snapshot_created_at_from_store(&device_id);
                let _ = state
                    .app_sync_repository
                    .clear_min_snapshot_created_at(device_id.clone())
                    .await;
                None
            }
        },
        None => None,
    };

    let sync_state = state
        .device_enroll_service
        .get_sync_state(&token)
        .await
        .map_err(|e| e.message)?;
    if sync_state.state != SyncState::Ready {
        return Ok(SyncBootstrapResult {
            status: "skipped_not_ready".to_string(),
            message: "Device is not in READY state".to_string(),
            snapshot_id: None,
            cursor: None,
        });
    }
    persist_device_config_from_identity(&state, &identity, "trusted").await;

    let sync_repo = Arc::clone(&state.app_sync_repository);
    let reconcile_action = create_client()
        .get_reconcile_ready_state(&token, &device_id)
        .await
        .ok()
        .map(|reconcile| reconcile.action);

    let needs_bootstrap = sync_repo
        .needs_bootstrap(&device_id)
        .map_err(|e| e.to_string())?;
    if !needs_bootstrap && min_snapshot_created_at.is_none() {
        let reconcile_requires_snapshot = matches!(
            reconcile_action.as_deref(),
            Some("WAIT_SNAPSHOT") | Some("BOOTSTRAP_SNAPSHOT")
        );
        if !reconcile_requires_snapshot {
            clear_min_snapshot_created_at_from_store();
            return Ok(SyncBootstrapResult {
                status: "skipped".to_string(),
                message: "Snapshot bootstrap already completed".to_string(),
                snapshot_id: None,
                cursor: Some(sync_repo.get_cursor().map_err(|e| e.to_string())?),
            });
        }

        tracing::debug!(
            "[DeviceSync] Local bootstrap marked complete but reconcile still requires snapshot; re-checking latest snapshot metadata"
        );
    }

    if reconcile_action.as_deref() == Some("WAIT_SNAPSHOT") {
        tracing::debug!(
            "[DeviceSync] Reconcile indicates WAIT_SNAPSHOT; checking latest snapshot metadata for race-safe bootstrap"
        );
    }

    let latest = match create_client()
        .get_latest_snapshot_with_cursor_fallback(&token, &device_id)
        .await
    {
        Ok(value) => value,
        Err(err) => {
            if err.status_code() == Some(404) {
                if min_snapshot_created_at.is_some() {
                    tracing::debug!(
                        "[DeviceSync] No snapshot found (404) while freshness gate is active; waiting for trusted device upload"
                    );
                    return Ok(SyncBootstrapResult {
                        status: "requested".to_string(),
                        message: "Waiting for a snapshot generated after pairing confirmation"
                            .to_string(),
                        snapshot_id: None,
                        cursor: Some(sync_repo.get_cursor().map_err(|e| e.to_string())?),
                    });
                }
                let client = create_client();
                match classify_missing_snapshot_disposition(&client, &token, &device_id).await {
                    MissingSnapshotDisposition::CompleteNoBootstrap { message } => {
                        sync_repo
                            .reset_and_mark_bootstrap_complete(device_id, identity.key_version)
                            .await
                            .map_err(|e| e.to_string())?;
                        clear_min_snapshot_created_at_from_store();
                        return Ok(SyncBootstrapResult {
                            status: "skipped".to_string(),
                            message,
                            snapshot_id: None,
                            cursor: Some(sync_repo.get_cursor().map_err(|e| e.to_string())?),
                        });
                    }
                    MissingSnapshotDisposition::WaitForSnapshot { message } => {
                        return Ok(SyncBootstrapResult {
                            status: "requested".to_string(),
                            message,
                            snapshot_id: None,
                            cursor: Some(sync_repo.get_cursor().map_err(|e| e.to_string())?),
                        });
                    }
                }
            }
            return Err(err.to_string());
        }
    };

    let latest = match latest {
        Some(value) => value,
        None => {
            if min_snapshot_created_at.is_some() {
                tracing::debug!(
                    "[DeviceSync] Snapshot metadata is empty while freshness gate is active; waiting for trusted device upload"
                );
                return Ok(SyncBootstrapResult {
                    status: "requested".to_string(),
                    message: "Waiting for a snapshot generated after pairing confirmation"
                        .to_string(),
                    snapshot_id: None,
                    cursor: Some(sync_repo.get_cursor().map_err(|e| e.to_string())?),
                });
            }
            let client = create_client();
            match classify_missing_snapshot_disposition(&client, &token, &device_id).await {
                MissingSnapshotDisposition::CompleteNoBootstrap { message } => {
                    sync_repo
                        .reset_and_mark_bootstrap_complete(device_id, identity.key_version)
                        .await
                        .map_err(|e| e.to_string())?;
                    clear_min_snapshot_created_at_from_store();
                    return Ok(SyncBootstrapResult {
                        status: "skipped".to_string(),
                        message,
                        snapshot_id: None,
                        cursor: Some(sync_repo.get_cursor().map_err(|e| e.to_string())?),
                    });
                }
                MissingSnapshotDisposition::WaitForSnapshot { message } => {
                    return Ok(SyncBootstrapResult {
                        status: "requested".to_string(),
                        message,
                        snapshot_id: None,
                        cursor: Some(sync_repo.get_cursor().map_err(|e| e.to_string())?),
                    });
                }
            }
        }
    };

    const LOCAL_SCHEMA_VERSION: i32 = 1;
    if latest.schema_version > LOCAL_SCHEMA_VERSION {
        return Err(format!(
            "Snapshot schema version {} is newer than local version {}. Please update the app.",
            latest.schema_version, LOCAL_SCHEMA_VERSION
        ));
    }

    let snapshot_id = latest.snapshot_id.trim().to_string();
    if snapshot_id.is_empty() {
        return Err(
            "Latest snapshot metadata had empty snapshot_id. No valid snapshot available."
                .to_string(),
        );
    }

    let snapshot_oplog_seq = latest.oplog_seq;
    if let Some(min_created_at) = min_snapshot_created_at.as_deref() {
        let client = create_client();
        if !snapshot_satisfies_freshness_gate(&client, &token, &device_id, &latest, min_created_at)
            .await?
        {
            tracing::debug!(
                "[DeviceSync] Snapshot {} is older than required freshness gate beyond leeway and does not cover current remote cursor",
                latest.snapshot_id,
            );
            return Ok(SyncBootstrapResult {
                status: "requested".to_string(),
                message: "Waiting for a snapshot generated after pairing confirmation".to_string(),
                snapshot_id: None,
                cursor: Some(sync_repo.get_cursor().map_err(|e| e.to_string())?),
            });
        }
    }
    let latest_checksum = if latest.checksum.trim().is_empty() {
        None
    } else {
        Some(latest.checksum)
    };
    let latest_tables = if latest.covers_tables.is_empty() {
        APP_SYNC_TABLES.iter().map(|v| v.to_string()).collect()
    } else {
        latest.covers_tables
    };

    let (headers, blob) = match create_client()
        .download_snapshot(&token, &device_id, &snapshot_id)
        .await
    {
        Ok(value) => value,
        Err(err) => {
            if err.status_code() == Some(404) {
                return Err(format!(
                    "Snapshot {} is no longer available. No valid snapshot to download.",
                    snapshot_id
                ));
            }
            return Err(err.to_string());
        }
    };
    let actual_checksum = sha256_checksum(&blob);
    if headers.checksum != actual_checksum {
        return Err(format!(
            "Snapshot checksum mismatch (download header): expected={}, got={}",
            headers.checksum, actual_checksum
        ));
    }
    if let Some(expected_checksum) = latest_checksum.as_ref() {
        if expected_checksum != &actual_checksum {
            return Err(format!(
                "Snapshot checksum mismatch (latest metadata): expected={}, got={}",
                expected_checksum, actual_checksum
            ));
        }
    }

    let sqlite_image = decode_snapshot_sqlite_payload(blob, &identity)?;
    let temp_snapshot_path =
        std::env::temp_dir().join(format!("wf_snapshot_server_{}.db", Uuid::new_v4()));
    std::fs::write(&temp_snapshot_path, sqlite_image)
        .map_err(|e| format!("Failed to persist snapshot image: {}", e))?;
    let snapshot_path_str = temp_snapshot_path.to_string_lossy().to_string();

    let mut tables_to_restore: Vec<String> = latest_tables
        .iter()
        .filter(|table| APP_SYNC_TABLES.contains(&table.as_str()))
        .map(|table| table.to_string())
        .collect();
    if tables_to_restore.is_empty() {
        tables_to_restore = APP_SYNC_TABLES
            .iter()
            .map(|table| table.to_string())
            .collect();
    }

    let restore_result = sync_repo
        .restore_snapshot_tables_from_file(
            snapshot_path_str,
            tables_to_restore,
            snapshot_oplog_seq,
            device_id.clone(),
            identity.key_version,
        )
        .await;
    let _ = std::fs::remove_file(&temp_snapshot_path);
    restore_result.map_err(|e| e.to_string())?;

    // Trigger portfolio recalculation so derived state is up-to-date
    state
        .domain_event_sink
        .emit(DomainEvent::device_sync_pull_complete());

    // Clear freshness gate from both in-memory and SQLite
    clear_min_snapshot_created_at_from_store();
    if let Err(err) = sync_repo.clear_min_snapshot_created_at(device_id).await {
        tracing::warn!(
            "[DeviceSync] Failed to clear freshness gate from SQLite: {}",
            err
        );
    }

    Ok(SyncBootstrapResult {
        status: "applied".to_string(),
        message: "Snapshot bootstrap completed".to_string(),
        snapshot_id: Some(snapshot_id),
        cursor: Some(snapshot_oplog_seq),
    })
}

pub async fn generate_snapshot_now(
    state: Arc<AppState>,
) -> Result<SyncSnapshotUploadResult, String> {
    ensure_device_sync_enabled()?;
    state
        .device_sync_runtime
        .snapshot_upload_cancelled
        .store(false, Ordering::Relaxed);

    let identity = get_sync_identity_from_store(&state)
        .ok_or_else(|| "No sync identity configured. Please enable sync first.".to_string())?;
    let device_id = identity
        .device_id
        .clone()
        .ok_or_else(|| "No device ID configured".to_string())?;
    let key_version = identity.key_version.unwrap_or(1).max(1);
    let token = crate::api::connect::mint_access_token(&state)
        .await
        .map_err(|e| e.to_string())?;

    let sync_state = create_client()
        .get_device(&token, &device_id)
        .await
        .map_err(|e| e.to_string())?;
    if sync_state.trust_state != wealthfolio_device_sync::TrustState::Trusted {
        return Ok(SyncSnapshotUploadResult {
            status: "skipped".to_string(),
            snapshot_id: None,
            oplog_seq: None,
            message: "Current device is not trusted".to_string(),
        });
    }
    if state
        .device_sync_runtime
        .snapshot_upload_cancelled
        .load(Ordering::Relaxed)
    {
        return Ok(snapshot_upload_cancelled_result(
            "Snapshot upload cancelled before export",
        ));
    }

    let local_cursor = state.app_sync_repository.get_cursor().ok();
    let server_cursor = create_client()
        .get_events_cursor(&token, &device_id)
        .await
        .map_err(|e| e.to_string())?
        .cursor;
    if local_cursor.is_some_and(|cursor| cursor > server_cursor) {
        return Err(sync_source_restore_required_error());
    }
    if let Some(cursor) = local_cursor {
        if let Ok(Some(latest_snapshot)) = create_client()
            .get_latest_snapshot_with_cursor_fallback(&token, &device_id)
            .await
        {
            if latest_snapshot.oplog_seq >= cursor {
                return Ok(SyncSnapshotUploadResult {
                    status: "uploaded".to_string(),
                    snapshot_id: Some(latest_snapshot.snapshot_id),
                    oplog_seq: Some(latest_snapshot.oplog_seq),
                    message: "Latest remote snapshot already covers current cursor".to_string(),
                });
            }
        }
    }

    let sync_tables = APP_SYNC_TABLES
        .iter()
        .map(|value| value.to_string())
        .collect::<Vec<_>>();
    state
        .app_sync_repository
        .validate_snapshot_upload_integrity(sync_tables.clone())
        .await
        .map_err(|e| format!("Cannot upload snapshot: {}", e))?;

    let sqlite_bytes = state
        .app_sync_repository
        .export_snapshot_sqlite_image(sync_tables)
        .await
        .map_err(|e| format!("Failed to export snapshot SQLite image: {}", e))?;
    if state
        .device_sync_runtime
        .snapshot_upload_cancelled
        .load(Ordering::Relaxed)
    {
        return Ok(snapshot_upload_cancelled_result(
            "Snapshot upload cancelled after export",
        ));
    }

    let encoded_snapshot = BASE64_STANDARD.encode(sqlite_bytes);
    let encrypted_snapshot_payload =
        encrypt_sync_payload(&encoded_snapshot, &identity, key_version)?;
    let payload = encrypted_snapshot_payload.into_bytes();
    let checksum = sha256_checksum(&payload);
    let metadata_payload = encrypt_sync_payload(
        &serde_json::json!({
            "schemaVersion": 1,
            "coversTables": APP_SYNC_TABLES,
            "generatedAt": Utc::now().to_rfc3339(),
        })
        .to_string(),
        &identity,
        key_version,
    )?;

    let base_seq = local_cursor;
    tracing::debug!(
        "[DeviceSync] Snapshot upload cursor anchor local_cursor={:?} server_cursor={} base_seq={:?}",
        local_cursor,
        server_cursor,
        base_seq
    );
    let upload_headers = wealthfolio_device_sync::SnapshotUploadHeaders {
        event_id: Some(Uuid::now_v7().to_string()),
        schema_version: 1,
        covers_tables: APP_SYNC_TABLES.iter().map(|v| v.to_string()).collect(),
        size_bytes: payload.len() as i64,
        checksum,
        metadata_payload,
        payload_key_version: key_version,
        base_seq,
    };

    let upload_result = create_client()
        .upload_snapshot_with_cancel_flag(
            &token,
            &device_id,
            upload_headers,
            payload,
            Some(&state.device_sync_runtime.snapshot_upload_cancelled),
        )
        .await;
    let response = match upload_result {
        Ok(value) => value,
        Err(err) => {
            let message = err.to_string();
            if message.to_ascii_lowercase().contains("cancelled") {
                return Ok(snapshot_upload_cancelled_result(
                    "Snapshot upload cancelled during transfer",
                ));
            }
            if is_snapshot_index_conflict(&message) {
                let latest = create_client()
                    .get_latest_snapshot_with_cursor_fallback(&token, &device_id)
                    .await
                    .ok()
                    .flatten();
                if let (Some(cursor), Some(snapshot)) = (local_cursor, latest) {
                    if snapshot.oplog_seq >= cursor {
                        tracing::info!(
                            "[DeviceSync] Snapshot conflict resolved by existing remote snapshot id={} oplog_seq={} cursor={}",
                            snapshot.snapshot_id,
                            snapshot.oplog_seq,
                            cursor
                        );
                        return Ok(SyncSnapshotUploadResult {
                            status: "uploaded".to_string(),
                            snapshot_id: Some(snapshot.snapshot_id),
                            oplog_seq: Some(snapshot.oplog_seq),
                            message: "Latest remote snapshot already covers current cursor"
                                .to_string(),
                        });
                    }
                }
            }
            return Err(message);
        }
    };

    Ok(SyncSnapshotUploadResult {
        status: "uploaded".to_string(),
        snapshot_id: Some(response.snapshot_id),
        oplog_seq: Some(response.oplog_seq),
        message: "Snapshot uploaded".to_string(),
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// Composite Pairing Endpoints
// ─────────────────────────────────────────────────────────────────────────────

/// Issuer: Run sync cycle → generate snapshot → approve → complete pairing in one call.
/// Frontend handles crypto (ECDH, SAS, encrypt key bundle) then calls this.
pub async fn complete_pairing_with_transfer(
    state: Arc<AppState>,
    pairing_id: String,
    encrypted_key_bundle: String,
    sas_proof: serde_json::Value,
    signature: String,
) -> Result<(), String> {
    ensure_device_sync_enabled()?;
    let identity = get_sync_identity_from_store(&state)
        .ok_or_else(|| "No sync identity configured".to_string())?;
    let device_id = identity
        .device_id
        .clone()
        .ok_or_else(|| "No device ID configured".to_string())?;

    // 1. Run sync cycle to flush any pending outbox events
    tracing::info!("[DeviceSync] complete_pairing_with_transfer: running sync cycle");
    let _cycle_result = run_sync_cycle(Arc::clone(&state), false).await?;

    // 2. Generate snapshot (full local SQLite export — always contains all local data)
    tracing::info!("[DeviceSync] complete_pairing_with_transfer: generating snapshot");
    let snapshot = generate_snapshot_now(Arc::clone(&state)).await?;
    if snapshot.status != "uploaded" {
        return Err(format!("Snapshot upload failed: {}", snapshot.message));
    }

    // 3. Approve pairing (idempotent if already approved)
    let token = crate::api::connect::mint_access_token(&state)
        .await
        .map_err(|e| e.to_string())?;
    let client = create_client();
    tracing::info!("[DeviceSync] complete_pairing_with_transfer: approving pairing");
    match client
        .approve_pairing(&token, &device_id, &pairing_id)
        .await
    {
        Ok(_) => {}
        Err(e) => {
            if is_pairing_already_approved_error(&e) {
                tracing::info!(
                    "[DeviceSync] approve_pairing already done, continuing: {}",
                    e
                );
            } else {
                return Err(e.to_string());
            }
        }
    }

    // 4. Complete pairing (send encrypted key bundle)
    tracing::info!("[DeviceSync] complete_pairing_with_transfer: completing pairing");
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

    // 5. Ensure background engine is running
    let engine_state = Arc::clone(&state);
    tokio::spawn(async move {
        if let Err(err) = ensure_background_engine_started(engine_state).await {
            tracing::warn!("[DeviceSync] Post-pairing engine start failed: {}", err);
        }
    });

    Ok(())
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmPairingWithBootstrapResult {
    pub status: String, // "applied", "overwrite_required", "already_complete"
    pub message: String,
    pub local_rows: Option<i64>,
    pub non_empty_tables: Option<Vec<SyncBootstrapOverwriteCheckTableResult>>,
}

/// Claimer: Confirm pairing → check overwrite → bootstrap → sync cycle in one call.
/// Call with allow_overwrite=false first. If returns "overwrite_required", show dialog,
/// then call again with allow_overwrite=true.
pub async fn confirm_pairing_with_bootstrap(
    state: Arc<AppState>,
    pairing_id: String,
    proof: Option<String>,
    min_snapshot_created_at: Option<String>,
    allow_overwrite: bool,
) -> Result<ConfirmPairingWithBootstrapResult, String> {
    ensure_device_sync_enabled()?;
    let identity = get_sync_identity_from_store(&state)
        .ok_or_else(|| "No sync identity configured".to_string())?;
    let device_id = identity
        .device_id
        .clone()
        .ok_or_else(|| "No device ID configured".to_string())?;
    let token = crate::api::connect::mint_access_token(&state)
        .await
        .map_err(|e| e.to_string())?;
    let client = create_client();

    // 1. Confirm pairing via Connect API (idempotent — tolerate "already confirmed")
    tracing::info!("[DeviceSync] confirm_pairing_with_bootstrap: confirming pairing");
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
                tracing::info!(
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
                    let _ = set_min_snapshot_created_at_in_store(&device_id, &normalized);
                    let _ = state
                        .app_sync_repository
                        .set_min_snapshot_created_at(device_id.clone(), normalized)
                        .await;
                }
            }
        }
    }

    // 3. Check if bootstrap is needed
    let needs_bootstrap = state
        .app_sync_repository
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
        let summary = state
            .app_sync_repository
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
                        .map(|t| SyncBootstrapOverwriteCheckTableResult {
                            table: t.table,
                            rows: t.rows,
                        })
                        .collect(),
                ),
            });
        }
    }

    // 5. Bootstrap snapshot
    tracing::info!("[DeviceSync] confirm_pairing_with_bootstrap: bootstrapping");
    let bootstrap = sync_bootstrap_snapshot_if_needed(Arc::clone(&state)).await?;
    if bootstrap.status == "requested" {
        // Snapshot not yet available — caller should retry
        return Ok(ConfirmPairingWithBootstrapResult {
            status: "waiting_snapshot".to_string(),
            message: bootstrap.message,
            local_rows: None,
            non_empty_tables: None,
        });
    }

    // 6. Run sync cycle after bootstrap
    tracing::info!("[DeviceSync] confirm_pairing_with_bootstrap: running sync cycle");
    let _ = run_sync_cycle(Arc::clone(&state), true).await;

    // 7. Start background engine
    let engine_state = Arc::clone(&state);
    tokio::spawn(async move {
        if let Err(err) = ensure_background_engine_started(engine_state).await {
            tracing::warn!("[DeviceSync] Post-bootstrap engine start failed: {}", err);
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
// Pairing Flow Coordinator
// ─────────────────────────────────────────────────────────────────────────────

use wealthfolio_device_sync::engine::{
    OverwriteInfo, OverwriteTableInfo, PairingFlowPhase, PairingFlowResponse,
};

pub async fn begin_pairing_confirm(
    state: Arc<AppState>,
    pairing_id: String,
    proof: String,
    min_snapshot_created_at: Option<String>,
) -> Result<PairingFlowResponse, String> {
    ensure_device_sync_enabled()?;
    let identity = get_sync_identity_from_store(&state)
        .ok_or_else(|| "No sync identity configured".to_string())?;
    let device_id = identity
        .device_id
        .clone()
        .ok_or_else(|| "No device ID configured".to_string())?;
    let token = crate::api::connect::mint_access_token(&state)
        .await
        .map_err(|e| e.to_string())?;
    let client = create_client();
    let runtime = &state.device_sync_runtime;

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
                tracing::info!("[DeviceSync] begin_pairing_confirm: already confirmed, continuing");
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
                    let _ = set_min_snapshot_created_at_in_store(&device_id, &normalized);
                    let _ = state
                        .app_sync_repository
                        .set_min_snapshot_created_at(device_id.clone(), normalized)
                        .await;
                }
            }
        }
    }

    // 3. Check if bootstrap is needed
    let needs_bootstrap = state
        .app_sync_repository
        .needs_bootstrap(&device_id)
        .map_err(|e| e.to_string())?;
    if !needs_bootstrap {
        return Ok(PairingFlowResponse {
            flow_id: uuid::Uuid::new_v4().to_string(),
            phase: PairingFlowPhase::Success,
        });
    }

    // 4. If real local portfolio data exists, keep consent inside the pairing flow.
    let summary = state
        .app_sync_repository
        .get_local_sync_overwrite_risk_summary()
        .map_err(|e| e.to_string())?;
    if summary.total_rows > 0 {
        tracing::info!(
            "[DeviceSync] begin_pairing_confirm: overwrite risk found ({} rows)",
            summary.total_rows
        );
        let phase = PairingFlowPhase::OverwriteRequired {
            info: OverwriteInfo {
                local_rows: summary.total_rows,
                non_empty_tables: summary
                    .non_empty_tables
                    .into_iter()
                    .map(|t| OverwriteTableInfo {
                        table: t.table,
                        rows: t.rows,
                    })
                    .collect(),
            },
        };
        let flow_id = runtime.create_flow(pairing_id, phase.clone());
        return Ok(PairingFlowResponse { flow_id, phase });
    }

    // 5. Bootstrap snapshot
    let bootstrap = sync_bootstrap_snapshot_if_needed(Arc::clone(&state)).await?;
    if let Some(phase) = pairing_bootstrap_phase(&bootstrap)? {
        let flow_id = runtime.create_flow(pairing_id, phase.clone());
        return Ok(PairingFlowResponse { flow_id, phase });
    }

    // 6. Run sync cycle + start engine
    let _ = run_sync_cycle(Arc::clone(&state), true).await;
    let engine_state = Arc::clone(&state);
    tokio::spawn(async move {
        if let Err(err) = ensure_background_engine_started(engine_state).await {
            tracing::warn!("[DeviceSync] Post-bootstrap engine start failed: {}", err);
        }
    });

    Ok(PairingFlowResponse {
        flow_id: uuid::Uuid::new_v4().to_string(),
        phase: PairingFlowPhase::Success,
    })
}

pub async fn get_pairing_flow_state_handler(
    state: Arc<AppState>,
    flow_id: String,
) -> Result<PairingFlowResponse, String> {
    ensure_device_sync_enabled()?;
    let runtime = &state.device_sync_runtime;

    let phase = runtime
        .get_flow_phase(&flow_id)
        .ok_or_else(|| "Flow not found".to_string())?;

    // If syncing, re-check bootstrap
    if let PairingFlowPhase::Syncing { ref detail } = phase {
        if detail == "waiting_snapshot" {
            match sync_bootstrap_snapshot_if_needed(Arc::clone(&state)).await {
                Ok(bootstrap) => match pairing_bootstrap_phase(&bootstrap) {
                    Ok(Some(phase)) => {
                        runtime.set_flow_phase(&flow_id, phase.clone());
                        return Ok(PairingFlowResponse { flow_id, phase });
                    }
                    Ok(None) => {
                        let _ = run_sync_cycle(Arc::clone(&state), true).await;
                        let engine_state = Arc::clone(&state);
                        tokio::spawn(async move {
                            if let Err(err) = ensure_background_engine_started(engine_state).await {
                                tracing::warn!(
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

pub async fn approve_pairing_overwrite_handler(
    state: Arc<AppState>,
    flow_id: String,
) -> Result<PairingFlowResponse, String> {
    ensure_device_sync_enabled()?;
    let runtime = &state.device_sync_runtime;

    let phase = runtime
        .get_flow_phase(&flow_id)
        .ok_or_else(|| "Flow not found".to_string())?;
    if !matches!(phase, PairingFlowPhase::OverwriteRequired { .. }) {
        return Err("Flow is not in overwrite_required phase".to_string());
    }

    let pairing_id = runtime
        .get_flow_pairing_id(&flow_id)
        .ok_or_else(|| "Flow not found".to_string())?;

    set_pairing_overwrite_approval(&pairing_id);

    runtime.set_flow_phase(
        &flow_id,
        PairingFlowPhase::Syncing {
            detail: "bootstrapping".to_string(),
        },
    );

    match sync_bootstrap_snapshot_if_needed(Arc::clone(&state)).await {
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

            let _ = run_sync_cycle(Arc::clone(&state), true).await;
            let engine_state = Arc::clone(&state);
            tokio::spawn(async move {
                if let Err(err) = ensure_background_engine_started(engine_state).await {
                    tracing::warn!("[DeviceSync] Post-overwrite engine start failed: {}", err);
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

pub async fn cancel_pairing_flow_handler(
    state: Arc<AppState>,
    flow_id: String,
) -> Result<PairingFlowResponse, String> {
    let runtime = &state.device_sync_runtime;

    if let Some(pairing_id) = runtime.get_flow_pairing_id(&flow_id) {
        abort_pairing_flow_local_state(&state, &pairing_id).await;
    }

    runtime.remove_flow(&flow_id);

    Ok(PairingFlowResponse {
        flow_id,
        phase: PairingFlowPhase::Success,
    })
}

pub async fn cancel_snapshot_upload(state: Arc<AppState>) {
    if !crate::features::device_sync_enabled() {
        return;
    }
    state
        .device_sync_runtime
        .snapshot_upload_cancelled
        .store(true, Ordering::Relaxed);
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
        let source = engine::SyncReadyReconcileResult {
            status: "ok".to_string(),
            message: "done".to_string(),
            bootstrap_action: "none".to_string(),
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
