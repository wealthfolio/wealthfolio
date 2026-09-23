use super::*;
use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tokio::sync::Semaphore;

use crate::{
    ApiRetryClass, ReconcileReadyStateResponse, SnapshotDownloadHeaders, SnapshotLatestResponse,
    SyncCursorResponse, SyncPullResponse, SyncPushRequest, SyncPushResponse, SyncState,
};

const DEVICE_ID: &str = "device-new";

struct FakeSnapshot {
    meta: SnapshotLatestResponse,
    blob: Vec<u8>,
}

fn fake_snapshot(root_key: &str, id: &str, oplog_seq: i64) -> FakeSnapshot {
    let mut image = b"SQLite format 3\0".to_vec();
    image.extend_from_slice(id.as_bytes());
    let dek = crate::crypto::derive_dek(root_key, 1).unwrap();
    let blob = crate::crypto::encrypt(&dek, &BASE64_STANDARD.encode(image))
        .unwrap()
        .into_bytes();
    FakeSnapshot {
        meta: SnapshotLatestResponse {
            snapshot_id: id.to_string(),
            schema_version: wealthfolio_core::sync::SNAPSHOT_SCHEMA_VERSION,
            covers_tables: vec!["accounts".to_string(), "activities".to_string()],
            oplog_seq,
            size_bytes: blob.len() as i64,
            checksum: crate::crypto::sha256_checksum(&blob),
            created_at: chrono::Utc::now().to_rfc3339(),
        },
        blob,
    }
}

struct FakePorts {
    root_key: String,
    device_id: StdMutex<String>,
    reconcile_action: StdMutex<String>,
    last_cycle_status: StdMutex<Option<String>>,
    sync_state: StdMutex<SyncState>,
    snapshots: StdMutex<Vec<FakeSnapshot>>,
    latest: StdMutex<Option<String>>,
    download_gate: Option<Arc<Semaphore>>,
    backup_gate: Option<Arc<Semaphore>>,
    download_failures: AtomicUsize,
    snapshot_missing: AtomicBool,
    local_rows: AtomicI64,
    needs_bootstrap: AtomicBool,
    backup_fails: AtomicBool,
    replace_fails: AtomicBool,
    downloads: StdMutex<Vec<String>>,
    backups: AtomicUsize,
    replacements: StdMutex<Vec<(String, i64)>>,
    portfolio_refreshes: AtomicUsize,
    resumed: AtomicUsize,
    resumed_after_restore: AtomicUsize,
    key_version: StdMutex<i32>,
    published: StdMutex<Vec<RestoreOperation>>,
    scratch: PathBuf,
}

impl FakePorts {
    fn new(local_rows: i64) -> Self {
        let root_key = crate::crypto::generate_root_key();
        let snapshot = fake_snapshot(&root_key, "snap-1", 42);
        let scratch = std::env::temp_dir().join(format!("wf-restore-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&scratch).unwrap();
        Self {
            root_key,
            device_id: StdMutex::new(DEVICE_ID.to_string()),
            reconcile_action: StdMutex::new("BOOTSTRAP_SNAPSHOT".to_string()),
            last_cycle_status: StdMutex::new(None),
            sync_state: StdMutex::new(SyncState::Ready),
            snapshots: StdMutex::new(vec![snapshot]),
            latest: StdMutex::new(Some("snap-1".to_string())),
            download_gate: None,
            backup_gate: None,
            download_failures: AtomicUsize::new(0),
            snapshot_missing: AtomicBool::new(false),
            local_rows: AtomicI64::new(local_rows),
            needs_bootstrap: AtomicBool::new(true),
            backup_fails: AtomicBool::new(false),
            replace_fails: AtomicBool::new(false),
            downloads: StdMutex::new(Vec::new()),
            backups: AtomicUsize::new(0),
            replacements: StdMutex::new(Vec::new()),
            portfolio_refreshes: AtomicUsize::new(0),
            resumed: AtomicUsize::new(0),
            resumed_after_restore: AtomicUsize::new(0),
            key_version: StdMutex::new(1),
            published: StdMutex::new(Vec::new()),
            scratch,
        }
    }

    /// Downloads wait until the test adds permits.
    fn gated(mut self) -> Self {
        self.download_gate = Some(Arc::new(Semaphore::new(0)));
        self
    }

    /// Backups wait until the test adds a permit.
    fn gated_backups(mut self) -> Self {
        self.backup_gate = Some(Arc::new(Semaphore::new(0)));
        self
    }

    fn release_downloads(&self, permits: usize) {
        self.download_gate.as_ref().unwrap().add_permits(permits);
    }

    fn add_snapshot(&self, id: &str, oplog_seq: i64) {
        let snapshot = fake_snapshot(&self.root_key, id, oplog_seq);
        self.snapshots.lock().unwrap().push(snapshot);
        *self.latest.lock().unwrap() = Some(id.to_string());
    }

    fn downloads(&self) -> Vec<String> {
        self.downloads.lock().unwrap().clone()
    }

    fn replacements(&self) -> Vec<(String, i64)> {
        self.replacements.lock().unwrap().clone()
    }

    /// Distinct operations that asked the user to approve replacement.
    fn consent_prompts(&self) -> usize {
        let published = self.published.lock().unwrap();
        let mut ids: Vec<&str> = published
            .iter()
            .filter(|op| op.phase == RestorePhase::AwaitingConsent)
            .map(|op| op.operation_id.as_str())
            .collect();
        ids.sort();
        ids.dedup();
        ids.len()
    }

    fn published_phases(&self) -> Vec<RestorePhase> {
        self.published
            .lock()
            .unwrap()
            .iter()
            .map(|op| op.phase.clone())
            .collect()
    }
}

#[async_trait]
impl SyncTransport for FakePorts {
    async fn get_events_cursor(
        &self,
        _token: &str,
        _device_id: &str,
    ) -> Result<SyncCursorResponse, TransportError> {
        Ok(SyncCursorResponse {
            cursor: 0,
            gc_watermark: None,
            latest_snapshot: None,
        })
    }

    async fn push_events(
        &self,
        _token: &str,
        _device_id: &str,
        _request: SyncPushRequest,
    ) -> Result<SyncPushResponse, TransportError> {
        unreachable!("restore never pushes")
    }

    async fn pull_events(
        &self,
        _token: &str,
        _device_id: &str,
        _from_cursor: Option<i64>,
        _limit: Option<i64>,
    ) -> Result<SyncPullResponse, TransportError> {
        unreachable!("restore never pulls")
    }

    async fn get_reconcile_ready_state(
        &self,
        _token: &str,
        _device_id: &str,
    ) -> Result<ReconcileReadyStateResponse, TransportError> {
        Ok(ReconcileReadyStateResponse {
            action: self.reconcile_action.lock().unwrap().clone(),
            cursor: Some(42),
            latest_snapshot: None,
        })
    }
}

#[async_trait]
impl CredentialStore for FakePorts {
    fn has_cloud_session(&self) -> Result<bool, String> {
        Ok(true)
    }

    async fn is_sync_allowed(&self) -> Result<bool, String> {
        Ok(true)
    }

    fn get_sync_identity(&self) -> Option<SyncIdentity> {
        Some(SyncIdentity {
            device_id: Some(self.device_id.lock().unwrap().clone()),
            root_key: Some(self.root_key.clone()),
            key_version: Some(*self.key_version.lock().unwrap()),
        })
    }

    async fn get_access_token(&self) -> Result<String, String> {
        Ok("token".to_string())
    }

    async fn get_sync_state(&self) -> Result<SyncState, String> {
        Ok(self.sync_state.lock().unwrap().clone())
    }

    async fn persist_device_config(&self, _identity: &SyncIdentity, _trust_state: &str) {}

    fn encrypt_sync_payload(
        &self,
        plaintext_payload: &str,
        _identity: &SyncIdentity,
        _payload_key_version: i32,
    ) -> Result<String, String> {
        Ok(plaintext_payload.to_string())
    }

    fn decrypt_sync_payload(
        &self,
        encrypted_payload: &str,
        _identity: &SyncIdentity,
        _payload_key_version: i32,
    ) -> Result<String, String> {
        Ok(encrypted_payload.to_string())
    }
}

#[async_trait]
impl RestorePorts for FakePorts {
    async fn get_latest_snapshot(
        &self,
        _token: &str,
        _device_id: &str,
    ) -> Result<Option<SnapshotLatestResponse>, TransportError> {
        let latest = self.latest.lock().unwrap().clone();
        Ok(latest.and_then(|id| {
            self.snapshots
                .lock()
                .unwrap()
                .iter()
                .find(|snapshot| snapshot.meta.snapshot_id == id)
                .map(|snapshot| snapshot.meta.clone())
        }))
    }

    async fn download_snapshot(
        &self,
        _token: &str,
        _device_id: &str,
        snapshot_id: &str,
    ) -> Result<Option<(SnapshotDownloadHeaders, Vec<u8>)>, TransportError> {
        if let Some(gate) = &self.download_gate {
            gate.acquire().await.unwrap().forget();
        }
        self.downloads.lock().unwrap().push(snapshot_id.to_string());
        if self
            .download_failures
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
            .is_ok()
        {
            return Err(TransportError {
                message: "connection reset".to_string(),
                retry_class: ApiRetryClass::Retryable,
                error_code: None,
                details: None,
            });
        }
        if self.snapshot_missing.load(Ordering::SeqCst) {
            return Ok(None);
        }
        let snapshots = self.snapshots.lock().unwrap();
        let snapshot = snapshots
            .iter()
            .find(|snapshot| snapshot.meta.snapshot_id == snapshot_id)
            .expect("known snapshot");
        Ok(Some((
            SnapshotDownloadHeaders {
                schema_version: snapshot.meta.schema_version,
                covers_tables: snapshot.meta.covers_tables.clone(),
                checksum: snapshot.meta.checksum.clone(),
            },
            snapshot.blob.clone(),
        )))
    }

    fn needs_bootstrap(&self, _device_id: &str) -> Result<bool, String> {
        Ok(self.needs_bootstrap.load(Ordering::SeqCst))
    }

    fn last_cycle_status(&self) -> Result<Option<String>, String> {
        Ok(self.last_cycle_status.lock().unwrap().clone())
    }

    fn freshness_gate(&self, _device_id: &str) -> Option<String> {
        None
    }

    async fn clear_freshness_gate(&self, _device_id: &str) {}

    fn local_rows(&self) -> Result<i64, String> {
        Ok(self.local_rows.load(Ordering::SeqCst))
    }

    async fn mark_restore_not_needed(
        &self,
        _device_id: &str,
        _key_version: Option<i32>,
    ) -> Result<(), String> {
        self.needs_bootstrap.store(false, Ordering::SeqCst);
        Ok(())
    }

    fn scratch_dir(&self) -> Result<PathBuf, String> {
        Ok(self.scratch.clone())
    }

    async fn backup_before_restore(&self) -> Result<(), String> {
        self.backups.fetch_add(1, Ordering::SeqCst);
        if let Some(gate) = &self.backup_gate {
            gate.acquire().await.unwrap().forget();
        }
        if self.backup_fails.load(Ordering::SeqCst) {
            return Err("disk full".to_string());
        }
        Ok(())
    }

    async fn replace_local_data(&self, snapshot: RestoreFile<'_>) -> Result<(), String> {
        let image = std::fs::read(snapshot.path).map_err(|e| e.to_string())?;
        assert!(image.starts_with(b"SQLite format 3\0"));
        if self.replace_fails.load(Ordering::SeqCst) {
            return Err("foreign key violation".to_string());
        }
        let id = String::from_utf8_lossy(&image[16..]).to_string();
        self.replacements
            .lock()
            .unwrap()
            .push((id, snapshot.oplog_seq));
        self.needs_bootstrap.store(false, Ordering::SeqCst);
        Ok(())
    }

    async fn resume_sync(&self, restored: bool) -> Result<(), String> {
        self.resumed.fetch_add(1, Ordering::SeqCst);
        if restored {
            self.resumed_after_restore.fetch_add(1, Ordering::SeqCst);
        }
        Ok(())
    }

    fn refresh_portfolio(&self) {
        self.portfolio_refreshes.fetch_add(1, Ordering::SeqCst);
    }

    fn publish_restore(&self, operation: &RestoreOperation) {
        self.published.lock().unwrap().push(operation.clone());
    }
}

fn runtime() -> Arc<DeviceSyncRuntimeState> {
    Arc::new(DeviceSyncRuntimeState::new())
}

async fn start(
    runtime: &Arc<DeviceSyncRuntimeState>,
    ports: &Arc<FakePorts>,
    request: StartRestore,
) -> RestoreOperation {
    runtime
        .start_restore(Arc::clone(ports), request)
        .await
        .expect("start restore")
        .expect("restore operation")
}

async fn wait_for(
    runtime: &DeviceSyncRuntimeState,
    matches: impl Fn(&RestoreOperation) -> bool,
) -> RestoreOperation {
    for _ in 0..500 {
        if let Some(op) = runtime.restore_operation().unwrap() {
            if matches(&op) {
                return op;
            }
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!(
        "restore did not reach the expected state: {:?}",
        runtime.restore_operation()
    );
}

async fn wait_for_phase(runtime: &DeviceSyncRuntimeState, phase: RestorePhase) -> RestoreOperation {
    wait_for(runtime, |op| op.phase == phase).await
}

// Regression: a pairing confirmation and a recurring sync check used to own
// restoration independently, so both could download and ask for consent.
#[tokio::test]
async fn overlapping_pairing_and_recurring_checks_share_one_operation() {
    let ports = Arc::new(FakePorts::new(12).gated());
    let runtime = runtime();

    // Pairing replaces a check that has not started replacing; the replaced
    // check never downloads. Later requests join the pairing's operation.
    let recurring = start(&runtime, &ports, StartRestore::Recurring).await;
    let pairing = start(&runtime, &ports, StartRestore::Pairing).await;
    let recurring_again = start(&runtime, &ports, StartRestore::Recurring).await;

    assert_ne!(recurring.operation_id, pairing.operation_id);
    assert_eq!(pairing.operation_id, recurring_again.operation_id);

    ports.release_downloads(1);
    let consent = wait_for_phase(&runtime, RestorePhase::AwaitingConsent).await;
    let during_consent = start(&runtime, &ports, StartRestore::Recurring).await;

    assert_eq!(consent.operation_id, pairing.operation_id);
    assert_eq!(consent.operation_id, during_consent.operation_id);
    assert_eq!(during_consent.phase, RestorePhase::AwaitingConsent);
    assert_eq!(ports.downloads(), vec!["snap-1".to_string()]);
    assert_eq!(ports.consent_prompts(), 1);
    assert!(ports.replacements().is_empty());
}

#[tokio::test]
async fn polling_repeated_approval_and_reopening_do_not_repeat_restoration() {
    let ports = Arc::new(FakePorts::new(3));
    let runtime = runtime();
    let op = start(&runtime, &ports, StartRestore::Pairing).await;
    let op = wait_for(&runtime, |current| {
        current.operation_id == op.operation_id && current.phase == RestorePhase::AwaitingConsent
    })
    .await;

    for _ in 0..5 {
        assert_eq!(
            runtime.restore_operation().unwrap().unwrap().operation_id,
            op.operation_id
        );
    }
    runtime
        .approve_restore(Arc::clone(&ports), &op.operation_id, false)
        .unwrap();
    runtime
        .approve_restore(Arc::clone(&ports), &op.operation_id, false)
        .unwrap();
    let ready = wait_for_phase(&runtime, RestorePhase::Ready).await;
    assert!(ready.replaced);

    let reopened = start(&runtime, &ports, StartRestore::Recurring).await;
    assert_eq!(reopened.operation_id, op.operation_id);
    assert_eq!(ports.downloads().len(), 1);
    assert_eq!(ports.replacements(), vec![("snap-1".to_string(), 42)]);
    assert_eq!(ports.portfolio_refreshes.load(Ordering::SeqCst), 1);
}

// Ready as soon as the data is in place and syncing; the portfolio update is
// the app's usual follow-up, triggered without waiting for it.
#[tokio::test]
async fn empty_profile_skips_consent_and_is_ready_once_replaced() {
    let ports = Arc::new(FakePorts::new(0));
    let runtime = runtime();
    start(&runtime, &ports, StartRestore::Pairing).await;

    let ready = wait_for_phase(&runtime, RestorePhase::Ready).await;
    assert!(ready.replaced);
    assert!(ready.error.is_none());
    assert_eq!(ports.consent_prompts(), 0);
    let phases = ports.published_phases();
    assert_eq!(phases.last(), Some(&RestorePhase::Ready));
    assert!(phases.contains(&RestorePhase::Replacing));
    assert_eq!(ports.resumed_after_restore.load(Ordering::SeqCst), 1);
    assert_eq!(ports.portfolio_refreshes.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn approved_backup_runs_before_the_replacement() {
    let ports = Arc::new(FakePorts::new(5));
    let runtime = runtime();
    let op = start(&runtime, &ports, StartRestore::Recurring).await;
    wait_for_phase(&runtime, RestorePhase::AwaitingConsent).await;

    runtime
        .approve_restore(Arc::clone(&ports), &op.operation_id, true)
        .unwrap();
    wait_for_phase(&runtime, RestorePhase::Ready).await;

    assert_eq!(ports.backups.load(Ordering::SeqCst), 1);
    assert_eq!(ports.replacements().len(), 1);
    let phases = ports.published_phases();
    let backing_up = phases.iter().position(|p| *p == RestorePhase::BackingUp);
    let replacing = phases.iter().position(|p| *p == RestorePhase::Replacing);
    assert!(backing_up < replacing);
}

#[tokio::test]
async fn backup_failure_requires_fresh_consent() {
    let ports = Arc::new(FakePorts::new(5));
    ports.backup_fails.store(true, Ordering::SeqCst);
    let runtime = runtime();
    let op = start(&runtime, &ports, StartRestore::Recurring).await;
    wait_for_phase(&runtime, RestorePhase::AwaitingConsent).await;

    runtime
        .approve_restore(Arc::clone(&ports), &op.operation_id, true)
        .unwrap();
    let failed = wait_for_phase(&runtime, RestorePhase::Failed).await;
    let error = failed.error.expect("backup error");
    assert_eq!(error.code, RestoreErrorCode::BackupFailed);
    assert_eq!(error.retry, RestoreRetry::Consent);
    assert!(!failed.replaced);
    assert!(ports.replacements().is_empty());

    // The earlier approval does not carry over to the next attempt.
    let retried = runtime
        .retry_restore(Arc::clone(&ports), &op.operation_id)
        .unwrap();
    assert_eq!(retried.phase, RestorePhase::AwaitingConsent);

    ports.backup_fails.store(false, Ordering::SeqCst);
    runtime
        .approve_restore(Arc::clone(&ports), &op.operation_id, false)
        .unwrap();
    wait_for_phase(&runtime, RestorePhase::Ready).await;
    assert_eq!(ports.downloads().len(), 1);
    assert_eq!(ports.replacements().len(), 1);
}

#[tokio::test]
async fn download_failure_retry_uses_the_latest_snapshot() {
    let ports = Arc::new(FakePorts::new(5));
    ports.download_failures.store(1, Ordering::SeqCst);
    let runtime = runtime();
    let op = start(&runtime, &ports, StartRestore::Recurring).await;

    let failed = wait_for_phase(&runtime, RestorePhase::Failed).await;
    let error = failed.error.expect("download error");
    assert_eq!(error.code, RestoreErrorCode::TransferFailed);
    assert_eq!(error.retry, RestoreRetry::Transfer);
    assert_eq!(failed.snapshot.as_ref().unwrap().snapshot_id, "snap-1");

    // Nothing was approved yet, so a retry simply takes the newest upload.
    ports.add_snapshot("snap-2", 50);
    runtime
        .retry_restore(Arc::clone(&ports), &op.operation_id)
        .unwrap();
    let consent = wait_for_phase(&runtime, RestorePhase::AwaitingConsent).await;
    assert_eq!(consent.operation_id, op.operation_id);
    assert_eq!(consent.snapshot.unwrap().snapshot_id, "snap-2");
    assert_eq!(
        ports.downloads(),
        vec!["snap-1".to_string(), "snap-2".to_string()]
    );
}

// Review finding: a snapshot replaced on the server needed a second "Start
// again"; a retry now selects the latest one directly.
#[tokio::test]
async fn unavailable_snapshot_retry_selects_the_latest_one() {
    let ports = Arc::new(FakePorts::new(5));
    ports.snapshot_missing.store(true, Ordering::SeqCst);
    let runtime = runtime();
    let op = start(&runtime, &ports, StartRestore::Recurring).await;

    let failed = wait_for_phase(&runtime, RestorePhase::Failed).await;
    let error = failed.error.clone().expect("unavailable error");
    assert_eq!(error.code, RestoreErrorCode::SnapshotUnavailable);
    assert_eq!(error.retry, RestoreRetry::Transfer);

    // A recurring check reports the failure instead of retrying on its own.
    let recurring = start(&runtime, &ports, StartRestore::Recurring).await;
    assert_eq!(recurring.operation_id, op.operation_id);
    assert_eq!(recurring.phase, RestorePhase::Failed);

    ports.snapshot_missing.store(false, Ordering::SeqCst);
    ports.add_snapshot("snap-2", 50);
    runtime
        .retry_restore(Arc::clone(&ports), &op.operation_id)
        .unwrap();
    let consent = wait_for_phase(&runtime, RestorePhase::AwaitingConsent).await;
    assert_eq!(consent.operation_id, op.operation_id);
    assert_eq!(consent.snapshot.unwrap().snapshot_id, "snap-2");
}

#[tokio::test]
async fn restore_failure_rolls_back_and_requires_fresh_consent() {
    let ports = Arc::new(FakePorts::new(5));
    ports.replace_fails.store(true, Ordering::SeqCst);
    let runtime = runtime();
    let op = start(&runtime, &ports, StartRestore::Recurring).await;
    wait_for_phase(&runtime, RestorePhase::AwaitingConsent).await;
    runtime
        .approve_restore(Arc::clone(&ports), &op.operation_id, false)
        .unwrap();

    let failed = wait_for_phase(&runtime, RestorePhase::Failed).await;
    let error = failed.error.expect("restore error");
    assert_eq!(error.code, RestoreErrorCode::RestoreFailed);
    assert_eq!(error.retry, RestoreRetry::Consent);
    assert!(!failed.replaced);

    ports.replace_fails.store(false, Ordering::SeqCst);
    let retried = runtime
        .retry_restore(Arc::clone(&ports), &op.operation_id)
        .unwrap();
    assert_eq!(retried.phase, RestorePhase::AwaitingConsent);
}

#[tokio::test]
async fn cancellation_stops_before_replacement_and_needs_a_new_attempt() {
    let ports = Arc::new(FakePorts::new(5).gated());
    let runtime = runtime();
    let op = start(&runtime, &ports, StartRestore::Recurring).await;

    let cancelled = runtime.cancel_restore(&*ports, &op.operation_id).unwrap();
    assert_eq!(cancelled.phase, RestorePhase::Cancelled);
    ports.release_downloads(1);
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert_eq!(
        runtime.restore_operation().unwrap().unwrap().phase,
        RestorePhase::Cancelled
    );

    // Recurring checks report the cancelled operation instead of prompting again.
    let recurring = start(&runtime, &ports, StartRestore::Recurring).await;
    assert_eq!(recurring.operation_id, op.operation_id);
    assert_eq!(recurring.phase, RestorePhase::Cancelled);

    let next = start(&runtime, &ports, StartRestore::NewAttempt).await;
    assert_ne!(next.operation_id, op.operation_id);
    ports.release_downloads(1);
    wait_for_phase(&runtime, RestorePhase::AwaitingConsent).await;
    assert!(ports.replacements().is_empty());
}

#[tokio::test]
async fn cancelling_consent_ends_the_attempt() {
    let ports = Arc::new(FakePorts::new(5));
    let runtime = runtime();
    let op = start(&runtime, &ports, StartRestore::Recurring).await;
    wait_for_phase(&runtime, RestorePhase::AwaitingConsent).await;

    let cancelled = runtime.cancel_restore(&*ports, &op.operation_id).unwrap();
    assert_eq!(cancelled.phase, RestorePhase::Cancelled);
    assert!(runtime
        .approve_restore(Arc::clone(&ports), &op.operation_id, false)
        .is_err());
}

#[tokio::test]
async fn every_change_is_published_with_increasing_revisions() {
    let ports = Arc::new(FakePorts::new(5));
    let runtime = runtime();
    let op = start(&runtime, &ports, StartRestore::Recurring).await;
    wait_for_phase(&runtime, RestorePhase::AwaitingConsent).await;
    runtime.cancel_restore(&*ports, &op.operation_id).unwrap();

    let published = ports.published.lock().unwrap().clone();
    assert!(published
        .windows(2)
        .all(|pair| pair[0].revision < pair[1].revision));
    assert_eq!(
        published.last().map(|op| op.phase.clone()),
        Some(RestorePhase::Cancelled)
    );
}

#[tokio::test]
async fn committed_restore_is_not_repeated_after_restart() {
    let ports = Arc::new(FakePorts::new(5));
    ports.needs_bootstrap.store(false, Ordering::SeqCst);
    let restarted = runtime();

    let result = restarted
        .start_restore(Arc::clone(&ports), StartRestore::Recurring)
        .await
        .unwrap();
    assert!(result.is_none());
    assert!(ports.downloads().is_empty());
}

#[tokio::test]
async fn unfinished_replacement_after_restart_asks_for_consent_again() {
    let ports = Arc::new(FakePorts::new(5));
    let restarted = runtime();
    start(&restarted, &ports, StartRestore::Recurring).await;
    let consent = wait_for_phase(&restarted, RestorePhase::AwaitingConsent).await;
    assert!(!consent.replaced);
}

#[tokio::test]
async fn sequence_zero_snapshot_is_restored() {
    let ports = Arc::new(FakePorts::new(0));
    ports.add_snapshot("snap-zero", 0);
    let runtime = runtime();
    start(&runtime, &ports, StartRestore::Pairing).await;

    wait_for_phase(&runtime, RestorePhase::Ready).await;
    assert_eq!(ports.replacements(), vec![("snap-zero".to_string(), 0)]);
}

#[tokio::test]
async fn shutdown_cancels_transfer_and_forgets_the_operation() {
    let ports = Arc::new(FakePorts::new(5).gated());
    let runtime = runtime();
    start(&runtime, &ports, StartRestore::Recurring).await;

    runtime.clear_restore().await;
    ports.release_downloads(1);
    tokio::time::sleep(Duration::from_millis(30)).await;

    assert!(runtime.restore_operation().unwrap().is_none());
    assert!(ports.downloads().is_empty());
    assert_eq!(Arc::strong_count(&ports), 1);
}

#[tokio::test]
async fn devices_that_are_not_ready_fail_before_downloading() {
    let ports = Arc::new(FakePorts::new(5));
    *ports.sync_state.lock().unwrap() = SyncState::Registered;
    let runtime = runtime();
    start(&runtime, &ports, StartRestore::Pairing).await;

    let failed = wait_for_phase(&runtime, RestorePhase::Failed).await;
    assert_eq!(failed.error.unwrap().code, RestoreErrorCode::DeviceNotReady);
    assert!(ports.downloads().is_empty());
}

#[tokio::test(start_paused = true)]
async fn waits_for_the_source_upload_before_transferring() {
    let ports = Arc::new(FakePorts::new(0));
    *ports.latest.lock().unwrap() = None;
    let runtime = runtime();
    start(&runtime, &ports, StartRestore::Pairing).await;

    wait_for_phase(&runtime, RestorePhase::WaitingForSnapshot).await;
    ports.add_snapshot("snap-late", 7);
    let ready = wait_for_phase(&runtime, RestorePhase::Ready).await;
    assert_eq!(ready.snapshot.unwrap().snapshot_id, "snap-late");
}

#[tokio::test]
async fn pairing_without_a_required_snapshot_resumes_sync_without_replacing() {
    let ports = Arc::new(FakePorts::new(5));
    ports.needs_bootstrap.store(false, Ordering::SeqCst);
    *ports.reconcile_action.lock().unwrap() = "NOOP".to_string();
    let runtime = runtime();
    start(&runtime, &ports, StartRestore::Pairing).await;

    let ready = wait_for_phase(&runtime, RestorePhase::Ready).await;
    assert!(!ready.replaced);
    assert!(ports.downloads().is_empty());
    assert_eq!(ports.consent_prompts(), 0);
    assert_eq!(ports.resumed.load(Ordering::SeqCst), 1);
    // Nothing was restored, so no post-bootstrap cycle bypasses the engine's guard.
    assert_eq!(ports.resumed_after_restore.load(Ordering::SeqCst), 0);
    assert_eq!(ports.portfolio_refreshes.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn identity_change_before_approval_requires_a_new_attempt() {
    let ports = Arc::new(FakePorts::new(5));
    let runtime = runtime();
    let op = start(&runtime, &ports, StartRestore::Recurring).await;
    wait_for_phase(&runtime, RestorePhase::AwaitingConsent).await;

    *ports.device_id.lock().unwrap() = "device-rebound".to_string();
    runtime
        .approve_restore(Arc::clone(&ports), &op.operation_id, false)
        .unwrap();

    let failed = wait_for_phase(&runtime, RestorePhase::Failed).await;
    let error = failed.error.unwrap();
    assert_eq!(error.code, RestoreErrorCode::DeviceNotReady);
    assert_eq!(error.retry, RestoreRetry::NewAttempt);
    assert!(ports.replacements().is_empty());
}

// Once approved, the backup and the replacement run to the end.
#[tokio::test]
async fn cancelling_after_approval_changes_nothing() {
    let ports = Arc::new(FakePorts::new(5).gated_backups());
    let runtime = runtime();
    let op = start(&runtime, &ports, StartRestore::Recurring).await;
    wait_for_phase(&runtime, RestorePhase::AwaitingConsent).await;

    runtime
        .approve_restore(Arc::clone(&ports), &op.operation_id, true)
        .unwrap();
    let unchanged = runtime.cancel_restore(&*ports, &op.operation_id).unwrap();
    assert_eq!(unchanged.phase, RestorePhase::BackingUp);
    ports.backup_gate.as_ref().unwrap().add_permits(1);

    wait_for_phase(&runtime, RestorePhase::Ready).await;
    assert_eq!(ports.replacements().len(), 1);
}

// Consent was skipped for an empty profile, but data was added while the
// snapshot downloaded (e.g. an import); it must not be replaced unasked.
#[tokio::test]
async fn data_added_before_replacement_requires_consent() {
    let ports = Arc::new(FakePorts::new(0));
    let runtime = runtime();
    let cycle = runtime.cycle_mutex.lock().await;
    let op = start(&runtime, &ports, StartRestore::Pairing).await;
    wait_for_phase(&runtime, RestorePhase::Replacing).await;

    ports.local_rows.store(7, Ordering::SeqCst);
    drop(cycle);

    let consent = wait_for_phase(&runtime, RestorePhase::AwaitingConsent).await;
    assert_eq!(consent.operation_id, op.operation_id);
    assert!(ports.replacements().is_empty());
    assert_eq!(ports.backups.load(Ordering::SeqCst), 0);

    runtime
        .approve_restore(Arc::clone(&ports), &op.operation_id, false)
        .unwrap();
    wait_for_phase(&runtime, RestorePhase::Ready).await;
    assert_eq!(ports.replacements().len(), 1);
}

#[tokio::test]
async fn clearing_for_a_new_identity_still_allows_later_setup() {
    let ports = Arc::new(FakePorts::new(5));
    let runtime = runtime();
    let first = start(&runtime, &ports, StartRestore::Recurring).await;
    wait_for_phase(&runtime, RestorePhase::AwaitingConsent).await;

    runtime.clear_restore().await;
    assert!(runtime.restore_operation().unwrap().is_none());

    let next = start(&runtime, &ports, StartRestore::Pairing).await;
    assert_ne!(next.operation_id, first.operation_id);
}

#[tokio::test]
async fn key_rotation_before_approval_requires_a_new_attempt() {
    let ports = Arc::new(FakePorts::new(5));
    let runtime = runtime();
    let op = start(&runtime, &ports, StartRestore::Recurring).await;
    wait_for_phase(&runtime, RestorePhase::AwaitingConsent).await;

    *ports.key_version.lock().unwrap() = 2;
    runtime
        .approve_restore(Arc::clone(&ports), &op.operation_id, false)
        .unwrap();

    let failed = wait_for_phase(&runtime, RestorePhase::Failed).await;
    assert_eq!(failed.error.unwrap().retry, RestoreRetry::NewAttempt);
    assert!(ports.replacements().is_empty());
}

#[tokio::test]
async fn pairing_after_a_finished_attempt_starts_a_new_one() {
    let ports = Arc::new(FakePorts::new(0));
    let runtime = runtime();
    start(&runtime, &ports, StartRestore::Recurring).await;
    let ready = wait_for_phase(&runtime, RestorePhase::Ready).await;

    let paired = start(&runtime, &ports, StartRestore::Pairing).await;
    assert_ne!(paired.operation_id, ready.operation_id);
    assert!(paired.revision > ready.revision);
    wait_for(&runtime, |op| {
        op.operation_id == paired.operation_id && op.phase == RestorePhase::Ready
    })
    .await;
    assert_eq!(ports.replacements().len(), 2);
}

// Review finding: pairing joined a check that had selected its snapshot before
// the pairing recorded a newer freshness gate.
#[tokio::test]
async fn pairing_replaces_a_check_awaiting_consent() {
    let ports = Arc::new(FakePorts::new(5));
    let runtime = runtime();
    let recurring = start(&runtime, &ports, StartRestore::Recurring).await;
    wait_for_phase(&runtime, RestorePhase::AwaitingConsent).await;

    ports.add_snapshot("snap-2", 50);
    let pairing = start(&runtime, &ports, StartRestore::Pairing).await;
    assert_ne!(pairing.operation_id, recurring.operation_id);
    let consent = wait_for(&runtime, |op| {
        op.operation_id == pairing.operation_id && op.phase == RestorePhase::AwaitingConsent
    })
    .await;
    assert_eq!(consent.snapshot.unwrap().snapshot_id, "snap-2");
    assert!(runtime
        .approve_restore(Arc::clone(&ports), &recurring.operation_id, false)
        .is_err());
}

// Nothing restarts underneath a replacement that is under way.
#[tokio::test]
async fn pairing_during_a_replacement_joins_it() {
    let ports = Arc::new(FakePorts::new(5).gated_backups());
    let runtime = runtime();
    let op = start(&runtime, &ports, StartRestore::Recurring).await;
    wait_for_phase(&runtime, RestorePhase::AwaitingConsent).await;
    runtime
        .approve_restore(Arc::clone(&ports), &op.operation_id, true)
        .unwrap();

    let joined = start(&runtime, &ports, StartRestore::Pairing).await;
    assert_eq!(joined.operation_id, op.operation_id);
    assert_eq!(joined.phase, RestorePhase::BackingUp);

    ports.backup_gate.as_ref().unwrap().add_permits(1);
    wait_for_phase(&runtime, RestorePhase::Ready).await;
    assert_eq!(ports.downloads().len(), 1);
    assert_eq!(ports.replacements().len(), 1);
}

// Review finding: "Check again" after a finished restore returned the old
// operation, so the user could never ask for another attempt.
#[tokio::test]
async fn user_request_starts_a_new_attempt_after_a_finished_one() {
    let ports = Arc::new(FakePorts::new(0));
    let runtime = runtime();
    start(&runtime, &ports, StartRestore::Pairing).await;
    let ready = wait_for_phase(&runtime, RestorePhase::Ready).await;

    // The server asks for a snapshot again, but the committed state does not.
    *ports.last_cycle_status.lock().unwrap() = Some("wait_snapshot".to_string());
    *ports.reconcile_action.lock().unwrap() = "WAIT_SNAPSHOT".to_string();
    let next = start(&runtime, &ports, StartRestore::NewAttempt).await;
    assert_ne!(next.operation_id, ready.operation_id);
    wait_for(&runtime, |op| {
        op.operation_id == next.operation_id && op.phase == RestorePhase::Ready
    })
    .await;
    assert_eq!(ports.replacements().len(), 2);
}

// Review finding: the decrypted image waited in scratch storage while the user
// decided, instead of existing only during replacement.
#[tokio::test]
async fn downloaded_copy_stays_encrypted_until_replacement() {
    let ports = Arc::new(FakePorts::new(5));
    let runtime = runtime();
    let op = start(&runtime, &ports, StartRestore::Recurring).await;
    wait_for_phase(&runtime, RestorePhase::AwaitingConsent).await;
    assert_eq!(std::fs::read_dir(&ports.scratch).unwrap().count(), 0);

    runtime
        .approve_restore(Arc::clone(&ports), &op.operation_id, false)
        .unwrap();
    wait_for_phase(&runtime, RestorePhase::Ready).await;
    // The fake reads and checks the image, so replacement saw a readable file.
    assert_eq!(ports.replacements(), vec![("snap-1".to_string(), 42)]);
    assert_eq!(std::fs::read_dir(&ports.scratch).unwrap().count(), 0);
}

// Regression: after a restore finished, a transient wait_snapshot cycle made
// the recurring check start a no-op attempt that popped up "Ready" again.
#[tokio::test]
async fn finished_restore_is_not_restarted_by_a_transient_cycle_status() {
    let ports = Arc::new(FakePorts::new(0));
    let runtime = runtime();
    start(&runtime, &ports, StartRestore::Pairing).await;
    let ready = wait_for_phase(&runtime, RestorePhase::Ready).await;
    assert!(ready.replaced);

    *ports.last_cycle_status.lock().unwrap() = Some("wait_snapshot".to_string());
    let recurring = start(&runtime, &ports, StartRestore::Recurring).await;
    assert_eq!(recurring.operation_id, ready.operation_id);
    assert_eq!(recurring.phase, RestorePhase::Ready);
    assert_eq!(ports.downloads().len(), 1);

    // A committed state that needs bootstrap again is a distinct requirement.
    ports.needs_bootstrap.store(true, Ordering::SeqCst);
    let next = start(&runtime, &ports, StartRestore::Recurring).await;
    assert_ne!(next.operation_id, ready.operation_id);
}
