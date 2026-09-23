use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use wealthfolio_core::secrets::SYNC_IDENTITY_KEY;
use wealthfolio_core::settings::SettingsServiceTrait;

use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
use chrono::{Duration, Utc};
use uuid::Uuid;

use crate::main_lib::AppState;
use wealthfolio_core::events::DomainEvent;
use wealthfolio_core::sync::{
    snapshot_covers_cursor_and_schema, APP_SYNC_TABLES, SNAPSHOT_SCHEMA_VERSION,
};
use wealthfolio_device_sync::engine::{
    self, CredentialStore, OutboxStore, ReplayEvent, ReplayStore, RestoreFile, RestoreOperation,
    RestorePorts, StartRestore, SyncIdentity, SyncTransport, TransportError,
};
use wealthfolio_device_sync::{
    DeviceSyncClient, ReconcileReadyStateResponse, SyncPullResponse, SyncPushRequest,
    SyncPushResponse, SyncState,
};
use wealthfolio_storage_sqlite::sync::SqliteSyncEngineDbPorts;

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

#[derive(Debug, Clone)]
pub struct SyncSnapshotUploadResult {
    pub status: String,
    pub snapshot_id: Option<String>,
    pub oplog_seq: Option<i64>,
    pub message: String,
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

pub fn set_min_snapshot_created_at_in_store(
    state: &AppState,
    device_id: &str,
    value: &str,
) -> Result<(), String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    let mut guard = state
        .sync_approvals
        .min_snapshot
        .lock()
        .map_err(|_| "Failed to lock in-memory freshness gate".to_string())?;
    guard.insert(device_id.to_string(), trimmed.to_string());
    Ok(())
}

pub fn clear_min_snapshot_created_at_from_store(state: &AppState) {
    if let Ok(mut guard) = state.sync_approvals.min_snapshot.lock() {
        guard.clear();
    }
}

fn get_min_snapshot_created_at_from_store(state: &AppState, device_id: &str) -> Option<String> {
    state
        .sync_approvals
        .min_snapshot
        .lock()
        .ok()
        .and_then(|map| map.get(device_id).cloned())
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

fn sha256_checksum(bytes: &[u8]) -> String {
    wealthfolio_device_sync::crypto::sha256_checksum(bytes)
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
    fn has_cloud_session(&self) -> Result<bool, String> {
        if self
            .state
            .settings_service
            .requires_cloud_reconnect()
            .map_err(|e| e.to_string())?
        {
            return Ok(false);
        }
        self.state
            .token_lifecycle
            .is_session_configured(self.state.secret_store.as_ref())
            .map_err(|err| err.to_string())
    }

    async fn is_sync_allowed(&self) -> Result<bool, String> {
        crate::api::connect::has_device_sync(&self.state).await
    }

    fn get_sync_identity(&self) -> Option<SyncIdentity> {
        get_sync_identity_from_store(&self.state)
    }

    async fn get_access_token(&self) -> Result<String, String> {
        crate::api::connect::mint_access_token(&self.state)
            .await
            .map_err(|e| e.to_string())
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

pub async fn ensure_background_engine_started(state: Arc<AppState>) -> Result<(), String> {
    let _lifecycle = state.profile_lifecycle.lock().await;
    if let Some((registry, id)) = state.profile_binding.get() {
        registry.profile(*id).map_err(|e| e.to_string())?;
    }
    ensure_device_sync_enabled()?;
    if state
        .settings_service
        .requires_cloud_reconnect()
        .map_err(|e| e.to_string())?
    {
        return Ok(());
    }
    let has_session = state
        .token_lifecycle
        .is_session_configured(state.secret_store.as_ref())
        .map_err(|err| err.to_string())?;
    if !has_session {
        return Ok(());
    }
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

pub async fn generate_snapshot_now(
    state: Arc<AppState>,
) -> Result<SyncSnapshotUploadResult, String> {
    crate::api::connect::ensure_device_sync_subscription(&state).await?;
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
            if snapshot_covers_cursor_and_schema(
                latest_snapshot.oplog_seq,
                latest_snapshot.schema_version,
                cursor,
                SNAPSHOT_SCHEMA_VERSION,
            ) {
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
            "schemaVersion": SNAPSHOT_SCHEMA_VERSION,
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
        schema_version: SNAPSHOT_SCHEMA_VERSION,
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
                    if snapshot_covers_cursor_and_schema(
                        snapshot.oplog_seq,
                        snapshot.schema_version,
                        cursor,
                        SNAPSHOT_SCHEMA_VERSION,
                    ) {
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

// ─────────────────────────────────────────────────────────────────────────────
// Restore Operation
// ─────────────────────────────────────────────────────────────────────────────

const DEVICE_SYNC_RESTORE_EVENT: &str = "device-sync:restore-operation";

#[async_trait]
impl RestorePorts for ServerEnginePorts {
    async fn get_latest_snapshot(
        &self,
        token: &str,
        device_id: &str,
    ) -> Result<Option<wealthfolio_device_sync::SnapshotLatestResponse>, TransportError> {
        match create_client()
            .get_latest_snapshot_with_cursor_fallback(token, device_id)
            .await
        {
            Ok(snapshot) => Ok(snapshot),
            Err(err) if err.status_code() == Some(404) => Ok(None),
            Err(err) => Err(transport_err_from_sync(err)),
        }
    }

    async fn download_snapshot(
        &self,
        token: &str,
        device_id: &str,
        snapshot_id: &str,
    ) -> Result<Option<(wealthfolio_device_sync::SnapshotDownloadHeaders, Vec<u8>)>, TransportError>
    {
        match create_client()
            .download_snapshot(token, device_id, snapshot_id)
            .await
        {
            Ok(snapshot) => Ok(Some(snapshot)),
            Err(err) if err.status_code() == Some(404) => Ok(None),
            Err(err) => Err(transport_err_from_sync(err)),
        }
    }

    fn needs_bootstrap(&self, device_id: &str) -> Result<bool, String> {
        self.state
            .app_sync_repository
            .needs_bootstrap(device_id)
            .map_err(|e| e.to_string())
    }

    fn last_cycle_status(&self) -> Result<Option<String>, String> {
        self.state
            .app_sync_repository
            .get_engine_status()
            .map(|status| status.last_cycle_status)
            .map_err(|e| e.to_string())
    }

    fn freshness_gate(&self, device_id: &str) -> Option<String> {
        // In memory first, then SQLite, which survives restarts.
        get_min_snapshot_created_at_from_store(&self.state, device_id).or_else(|| {
            self.state
                .app_sync_repository
                .get_min_snapshot_created_at(device_id)
                .ok()
                .flatten()
        })
    }

    async fn clear_freshness_gate(&self, device_id: &str) {
        clear_min_snapshot_created_at_from_store(&self.state);
        if let Err(err) = self
            .state
            .app_sync_repository
            .clear_min_snapshot_created_at(device_id.to_string())
            .await
        {
            tracing::warn!("[DeviceSync] Failed to clear freshness gate: {}", err);
        }
    }

    fn local_rows(&self) -> Result<i64, String> {
        self.state
            .app_sync_repository
            .get_local_sync_overwrite_risk_summary()
            .map(|summary| summary.total_rows)
            .map_err(|e| e.to_string())
    }

    async fn mark_restore_not_needed(
        &self,
        device_id: &str,
        key_version: Option<i32>,
    ) -> Result<(), String> {
        self.state
            .app_sync_repository
            .reset_and_mark_bootstrap_complete(device_id.to_string(), key_version)
            .await
            .map_err(|e| e.to_string())
    }

    fn scratch_dir(&self) -> Result<std::path::PathBuf, String> {
        wealthfolio_storage_sqlite::db::profile_scratch_dir(&self.state.data_root)
            .map_err(|e| format!("Failed to prepare the snapshot scratch directory: {e}"))
    }

    async fn backup_before_restore(&self) -> Result<(), String> {
        let access = self.state.db_access.clone();
        let data_root = self.state.data_root.clone();
        let owner = self.state._database_owner.clone();
        tokio::task::spawn_blocking(move || {
            let _owner = owner;
            wealthfolio_storage_sqlite::db::backup_database(&access, &data_root)
        })
        .await
        .map_err(|e| format!("Backup task failed: {e}"))?
        .map_err(|e| e.to_string())?;
        tracing::info!("[DeviceSync] Backup saved before restore");
        Ok(())
    }

    async fn replace_local_data(&self, snapshot: RestoreFile<'_>) -> Result<(), String> {
        self.state
            .app_sync_repository
            .restore_snapshot_tables_from_file(
                snapshot.path.to_string_lossy().to_string(),
                snapshot.tables,
                snapshot.oplog_seq,
                snapshot.device_id,
                snapshot.key_version,
            )
            .await
            .map_err(|e| e.to_string())
    }

    async fn resume_sync(&self, restored: bool) -> Result<(), String> {
        if restored {
            // The snapshot is committed; a failed initial cycle must not prevent
            // the background engine from starting and retrying sync.
            if let Err(error) = run_sync_cycle(Arc::clone(&self.state), true).await {
                tracing::warn!("[DeviceSync] Post-restore sync cycle failed: {}", error);
            }
        }
        ensure_background_engine_started(Arc::clone(&self.state)).await
    }

    fn refresh_portfolio(&self) {
        // The same signal a sync pull sends: the portfolio pipeline recalculates
        // and reports its own progress and errors.
        self.state
            .domain_event_sink
            .emit(DomainEvent::device_sync_pull_complete());
    }

    fn publish_restore(&self, operation: &RestoreOperation) {
        match serde_json::to_value(operation) {
            Ok(payload) => self
                .state
                .event_bus
                .publish(crate::events::ServerEvent::with_payload(
                    DEVICE_SYNC_RESTORE_EVENT,
                    payload,
                )),
            Err(err) => tracing::warn!("[DeviceSync] Failed to publish restore state: {}", err),
        }
    }
}

fn restore_ports(state: &Arc<AppState>) -> Arc<ServerEnginePorts> {
    Arc::new(ServerEnginePorts::new(Arc::clone(state)))
}

pub async fn start_restore(
    state: Arc<AppState>,
    request: StartRestore,
) -> Result<Option<RestoreOperation>, String> {
    ensure_device_sync_enabled()?;
    state
        .device_sync_runtime
        .start_restore(restore_ports(&state), request)
        .await
}

/// Read-only: polling never starts or advances restoration.
pub fn get_restore(state: &AppState) -> Result<Option<RestoreOperation>, String> {
    ensure_device_sync_enabled()?;
    state.device_sync_runtime.restore_operation()
}

pub fn approve_restore(
    state: Arc<AppState>,
    operation_id: &str,
    backup: bool,
) -> Result<RestoreOperation, String> {
    ensure_device_sync_enabled()?;
    state
        .device_sync_runtime
        .approve_restore(restore_ports(&state), operation_id, backup)
}

pub fn retry_restore(state: Arc<AppState>, operation_id: &str) -> Result<RestoreOperation, String> {
    ensure_device_sync_enabled()?;
    state
        .device_sync_runtime
        .retry_restore(restore_ports(&state), operation_id)
}

pub fn cancel_restore(
    state: Arc<AppState>,
    operation_id: &str,
) -> Result<RestoreOperation, String> {
    ensure_device_sync_enabled()?;
    state
        .device_sync_runtime
        .cancel_restore(&*restore_ports(&state), operation_id)
}

/// Receiving device: confirm pairing, record the freshness gate, then hand
/// restoration to the profile's restore operation.
pub async fn begin_pairing_restore(
    state: Arc<AppState>,
    pairing_id: String,
    proof: String,
    min_snapshot_created_at: Option<String>,
) -> Result<RestoreOperation, String> {
    ensure_device_sync_enabled()?;
    let device_id = get_sync_identity_from_store(&state)
        .and_then(|identity| identity.device_id)
        .ok_or_else(|| "No device ID configured".to_string())?;
    let token = crate::api::connect::mint_access_token(&state)
        .await
        .map_err(|e| e.to_string())?;
    match create_client()
        .confirm_pairing(
            &token,
            &device_id,
            &pairing_id,
            wealthfolio_device_sync::ConfirmPairingRequest { proof: Some(proof) },
        )
        .await
    {
        Ok(_) => {}
        Err(err) if is_pairing_already_confirmed_error(&err) => {
            tracing::info!("[DeviceSync] Pairing already confirmed, continuing");
        }
        Err(err) => return Err(err.to_string()),
    }

    if let Some(min_created_at) = min_snapshot_created_at.as_deref() {
        let within_limit = wealthfolio_device_sync::parse_sync_datetime_to_utc(min_created_at)
            .is_ok_and(|parsed| parsed <= Utc::now() + Duration::minutes(10));
        match wealthfolio_device_sync::normalize_sync_datetime(min_created_at) {
            Ok(normalized) if within_limit => {
                set_min_snapshot_created_at_in_store(&state, &device_id, &normalized)?;
                if let Err(err) = state
                    .app_sync_repository
                    .set_min_snapshot_created_at(device_id.clone(), normalized)
                    .await
                {
                    tracing::warn!("[DeviceSync] Failed to persist freshness gate: {}", err);
                }
            }
            _ => tracing::warn!("[DeviceSync] Ignoring invalid pairing freshness gate"),
        }
    }

    state
        .device_sync_runtime
        .start_restore(restore_ports(&state), StartRestore::Pairing)
        .await?
        .ok_or_else(|| "Setup could not start.".to_string())
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
}
