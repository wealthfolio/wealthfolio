use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use wealthfolio_core::sync::{SyncEngineStatus, SyncEntity, SyncOperation, SyncOutboxEvent};

use crate::{
    ApiRetryClass, ReconcileReadyStateResponse, SyncCursorResponse, SyncPullResponse,
    SyncPushRequest, SyncPushResponse, SyncState,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncIdentity {
    pub device_id: Option<String>,
    pub root_key: Option<String>,
    pub key_version: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncCycleResult {
    pub status: String,
    pub lock_version: i64,
    pub pushed_count: usize,
    pub pulled_count: usize,
    pub cursor: i64,
    pub needs_bootstrap: bool,
    #[serde(default)]
    pub bootstrap_snapshot_id: Option<String>,
    #[serde(default)]
    pub bootstrap_snapshot_seq: Option<i64>,
    /// Number of outbox events dead-lettered during this cycle (e.g. key version mismatch).
    #[serde(default)]
    pub dead_letter_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncBootstrapResult {
    pub status: String,
    pub message: String,
    pub snapshot_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReadyReconcileResult {
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

#[derive(Debug, Clone)]
pub struct ReplayEvent {
    pub entity: SyncEntity,
    pub entity_id: String,
    pub op: SyncOperation,
    pub event_id: String,
    pub client_timestamp: String,
    pub seq: i64,
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone)]
pub struct TransportError {
    pub message: String,
    pub retry_class: ApiRetryClass,
    pub error_code: Option<String>,
    pub details: Option<serde_json::Value>,
}

impl TransportError {
    pub fn is_subscription_blocked(&self) -> bool {
        self.error_code
            .as_deref()
            .is_some_and(|code| code.starts_with("SUBSCRIPTION_"))
    }
}

impl std::fmt::Display for TransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for TransportError {}

#[async_trait]
pub trait OutboxStore: Send + Sync {
    async fn list_pending_outbox(&self, limit: i64) -> Result<Vec<SyncOutboxEvent>, String>;
    async fn mark_outbox_dead(
        &self,
        event_ids: Vec<String>,
        error_message: Option<String>,
        error_code: Option<String>,
    ) -> Result<(), String>;
    async fn mark_outbox_sent(&self, event_ids: Vec<String>) -> Result<(), String>;
    async fn schedule_outbox_retry(
        &self,
        event_ids: Vec<String>,
        delay_seconds: i64,
        error_message: Option<String>,
        error_code: Option<String>,
    ) -> Result<(), String>;
    async fn mark_push_completed(&self) -> Result<(), String>;
    async fn has_pending_outbox(&self) -> Result<bool, String>;
}

#[async_trait]
pub trait ReplayStore: Send + Sync {
    async fn acquire_cycle_lock(&self) -> Result<i64, String>;
    async fn verify_cycle_lock(&self, lock_version: i64) -> Result<bool, String>;
    async fn get_cursor(&self) -> Result<i64, String>;
    async fn set_cursor(&self, cursor: i64) -> Result<(), String>;
    async fn apply_remote_events_lww_batch(
        &self,
        events: Vec<ReplayEvent>,
    ) -> Result<usize, String>;
    async fn apply_remote_event_lww(&self, event: ReplayEvent) -> Result<bool, String>;
    async fn mark_pull_completed(&self) -> Result<(), String>;
    async fn mark_cycle_outcome(
        &self,
        status: String,
        duration_ms: i64,
        next_retry_at: Option<String>,
    ) -> Result<(), String>;
    async fn mark_engine_error(&self, message: String) -> Result<(), String>;
    async fn prune_sync_outbox(
        &self,
        sent_before: chrono::DateTime<chrono::Utc>,
        dead_before: chrono::DateTime<chrono::Utc>,
    ) -> Result<usize, String>;
    async fn prune_applied_events_up_to_seq(&self, seq: i64) -> Result<(), String>;
    async fn get_engine_status(&self) -> Result<SyncEngineStatus, String>;
    /// Called after a sync cycle completes with pulled changes.
    /// Implementations can use this to trigger portfolio recalculation.
    async fn on_pull_complete(&self, _pulled_count: usize) -> Result<(), String> {
        Ok(())
    }
}

#[async_trait]
pub trait SyncTransport: Send + Sync {
    async fn get_events_cursor(
        &self,
        token: &str,
        device_id: &str,
    ) -> Result<SyncCursorResponse, TransportError>;
    async fn push_events(
        &self,
        token: &str,
        device_id: &str,
        request: SyncPushRequest,
    ) -> Result<SyncPushResponse, TransportError>;
    async fn pull_events(
        &self,
        token: &str,
        device_id: &str,
        from_cursor: Option<i64>,
        limit: Option<i64>,
    ) -> Result<SyncPullResponse, TransportError>;
    async fn get_reconcile_ready_state(
        &self,
        token: &str,
        device_id: &str,
    ) -> Result<ReconcileReadyStateResponse, TransportError>;
}

#[async_trait]
pub trait CredentialStore: Send + Sync {
    fn has_cloud_session(&self) -> Result<bool, String>;
    async fn is_sync_allowed(&self) -> Result<bool, String>;
    fn get_sync_identity(&self) -> Option<SyncIdentity>;
    fn get_access_token(&self) -> Result<String, String>;
    async fn get_sync_state(&self) -> Result<SyncState, String>;
    async fn persist_device_config(&self, identity: &SyncIdentity, trust_state: &str);
    fn encrypt_sync_payload(
        &self,
        plaintext_payload: &str,
        identity: &SyncIdentity,
        payload_key_version: i32,
    ) -> Result<String, String>;
    fn decrypt_sync_payload(
        &self,
        encrypted_payload: &str,
        identity: &SyncIdentity,
        payload_key_version: i32,
    ) -> Result<String, String>;
}

#[async_trait]
pub trait ReadyReconcileStore: Send + Sync {
    async fn get_sync_state(&self) -> Result<SyncState, String>;
    async fn bootstrap_snapshot_if_needed(&self) -> Result<SyncBootstrapResult, String>;
    async fn run_sync_cycle(&self, post_bootstrap: bool) -> Result<SyncCycleResult, String>;
    async fn ensure_background_started(&self) -> Result<bool, String>;
}
