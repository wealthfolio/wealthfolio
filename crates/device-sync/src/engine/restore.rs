//! One owner for snapshot restoration per profile.
//!
//! Pairing, recurring sync checks and manual retries all go through the
//! profile's [`DeviceSyncRuntimeState`]. None of them restores data or decides
//! that restoration succeeded on its own; they read and drive this operation.
//!
//! The operation lives in memory only. After a restart, the committed bootstrap
//! state decides whether a new attempt (with fresh consent) is required, so a
//! committed restore is never repeated just because its operation disappeared.

use std::path::{Path, PathBuf};
use std::sync::{Arc, MutexGuard};
use std::time::Duration;

use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
use log::{debug, info, warn};
use serde::{Deserialize, Serialize};
use tokio::task::JoinHandle;
use wealthfolio_core::sync::{APP_SYNC_TABLES, SNAPSHOT_SCHEMA_VERSION};

use super::{CredentialStore, DeviceSyncRuntimeState, SyncIdentity, SyncTransport, TransportError};
use crate::{SnapshotDownloadHeaders, SnapshotLatestResponse, SyncState};

/// Snapshots created this close to the freshness gate still satisfy it.
const SNAPSHOT_FRESHNESS_CLOCK_SKEW_LEEWAY_SECS: i64 = 120;
/// How long a new device waits for its source to finish uploading.
const SNAPSHOT_WAIT_LIMIT: Duration = Duration::from_secs(10 * 60);
const SNAPSHOT_WAIT_INITIAL_DELAY: Duration = Duration::from_secs(2);
const SNAPSHOT_WAIT_MAX_DELAY: Duration = Duration::from_secs(15);

// ─────────────────────────────────────────────────────────────────────────────
// Operation state
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RestorePhase {
    /// Selecting, downloading and validating the snapshot.
    Transferring,
    /// The other device has not finished uploading a usable snapshot yet.
    WaitingForSnapshot,
    /// Local data exists; nothing is replaced until the user approves.
    AwaitingConsent,
    BackingUp,
    Replacing,
    /// Restored data is committed and sync resumed. The portfolio is then
    /// recalculated by the app's usual pipeline, like after any sync.
    Ready,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RestoreErrorCode {
    SubscriptionRequired,
    DeviceNotReady,
    SnapshotWaitTimedOut,
    SnapshotUnavailable,
    SnapshotSchemaNewer,
    SnapshotInvalid,
    TransferFailed,
    BackupFailed,
    RestoreFailed,
}

/// What retrying a failed operation does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RestoreRetry {
    /// Select and download the latest snapshot again.
    Transfer,
    /// Ask for approval again; the earlier approval covered one attempt only.
    Consent,
    /// The selected snapshot cannot be used; start a new attempt.
    NewAttempt,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreError {
    pub code: RestoreErrorCode,
    pub message: String,
    pub retry: RestoreRetry,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreSnapshotRef {
    pub snapshot_id: String,
    pub oplog_seq: i64,
    pub created_at: String,
}

/// Authoritative state of the profile's restore operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreOperation {
    pub operation_id: String,
    /// Increases with every change so observers can drop stale updates.
    pub revision: u64,
    pub phase: RestorePhase,
    pub snapshot: Option<RestoreSnapshotRef>,
    pub error: Option<RestoreError>,
    /// The restore transaction committed.
    pub replaced: bool,
}

/// Who asks for a restore, which decides what happens to an existing one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartRestore {
    /// A recurring sync check. Reports an existing operation, including a failed
    /// or cancelled one, instead of prompting again.
    Recurring,
    /// The user asked to finish setup: joins a running attempt, replaces a
    /// finished, failed or cancelled one.
    NewAttempt,
    /// Pairing was confirmed on this (receiving) device. It brings a new
    /// freshness gate and possibly new keys, so it replaces any attempt that
    /// has not started replacing data.
    Pairing,
}

/// A validated snapshot image ready to replace local synced tables.
pub struct RestoreFile<'a> {
    pub path: &'a Path,
    pub tables: Vec<String>,
    pub oplog_seq: i64,
    pub device_id: String,
    pub key_version: Option<i32>,
}

/// Platform services used by the restore owner. Implementations map each call
/// to an existing repository, service or client call.
#[async_trait]
pub trait RestorePorts: CredentialStore + SyncTransport + Send + Sync + 'static {
    async fn get_latest_snapshot(
        &self,
        token: &str,
        device_id: &str,
    ) -> Result<Option<SnapshotLatestResponse>, TransportError>;
    /// `Ok(None)` when the snapshot no longer exists.
    async fn download_snapshot(
        &self,
        token: &str,
        device_id: &str,
        snapshot_id: &str,
    ) -> Result<Option<(SnapshotDownloadHeaders, Vec<u8>)>, TransportError>;
    fn needs_bootstrap(&self, device_id: &str) -> Result<bool, String>;
    fn last_cycle_status(&self) -> Result<Option<String>, String>;
    fn freshness_gate(&self, device_id: &str) -> Option<String>;
    async fn clear_freshness_gate(&self, device_id: &str);
    /// Rows in the synced tables that a replacement would overwrite.
    fn local_rows(&self) -> Result<i64, String>;
    /// Record that no snapshot is required for this device.
    async fn mark_restore_not_needed(
        &self,
        device_id: &str,
        key_version: Option<i32>,
    ) -> Result<(), String>;
    /// App-private directory for the plaintext snapshot image during replacement.
    fn scratch_dir(&self) -> Result<PathBuf, String>;
    async fn backup_before_restore(&self) -> Result<(), String>;
    /// Replaces the synced tables in one writer transaction.
    async fn replace_local_data(&self, snapshot: RestoreFile<'_>) -> Result<(), String>;
    /// Keep the background engine running. After a replacement, first pull the
    /// events that follow the restored snapshot.
    async fn resume_sync(&self, restored: bool) -> Result<(), String>;
    /// Start the app's usual portfolio update for the restored data; not awaited.
    /// Its progress and errors surface like after any sync.
    fn refresh_portfolio(&self);
    fn publish_restore(&self, operation: &RestoreOperation);
}

// ─────────────────────────────────────────────────────────────────────────────
// Owner
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Default)]
pub(super) struct RestoreSlot {
    entry: Option<RestoreEntry>,
    revision: u64,
}

impl std::fmt::Debug for RestoreSlot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RestoreSlot")
            .field("operation", &self.entry.as_ref().map(|e| &e.operation))
            .finish()
    }
}

struct RestoreEntry {
    operation: RestoreOperation,
    prepared: Option<Arc<PreparedSnapshot>>,
    device_id: Option<String>,
    key_version: Option<i32>,
    task: Option<JoinHandle<()>>,
}

/// A downloaded and validated snapshot, still encrypted. It stays in memory
/// while the user decides; a readable copy exists only during replacement.
struct PreparedSnapshot {
    ciphertext: Vec<u8>,
    tables: Vec<String>,
    oplog_seq: i64,
}

/// The decrypted image in scratch storage, removed when replacement ends.
struct ScratchImage(PathBuf);

impl Drop for ScratchImage {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

struct Failure {
    code: RestoreErrorCode,
    retry: RestoreRetry,
    message: String,
}

fn failure(code: RestoreErrorCode, retry: RestoreRetry, message: impl Into<String>) -> Failure {
    Failure {
        code,
        retry,
        message: message.into(),
    }
}

enum StepError {
    Failed(Failure),
    /// Local data appeared after consent was skipped; ask before replacing.
    NeedsConsent,
    /// The operation was replaced or cancelled; this step's result is ignored.
    Stale,
}

impl From<Failure> for StepError {
    fn from(value: Failure) -> Self {
        Self::Failed(value)
    }
}

/// Why replacement may proceed.
#[derive(Clone, Copy)]
enum ReplaceStart {
    /// The user approved this attempt.
    Approved { backup: bool },
    /// The profile had no local data, so no approval was needed.
    NoLocalData,
}

enum Selection {
    Snapshot(SnapshotLatestResponse),
    Wait,
    NotRequired { reset: bool },
}

struct Session {
    token: String,
    device_id: String,
    identity: SyncIdentity,
}

const STALE_OPERATION: &str = "This setup step is no longer current. Refresh and try again.";

/// Marks the current entry as changed and returns what observers should see.
fn bump(slot: &mut RestoreSlot) -> Option<RestoreOperation> {
    slot.revision += 1;
    let revision = slot.revision;
    let entry = slot.entry.as_mut()?;
    entry.operation.revision = revision;
    Some(entry.operation.clone())
}

impl DeviceSyncRuntimeState {
    fn restore_slot(&self) -> Result<MutexGuard<'_, RestoreSlot>, String> {
        self.restore.lock().map_err(|_| {
            "Setup state is unavailable. Restart the application before continuing.".to_string()
        })
    }

    /// Current operation, if any. Read-only: polling never starts or advances work.
    pub fn restore_operation(&self) -> Result<Option<RestoreOperation>, String> {
        Ok(self
            .restore_slot()?
            .entry
            .as_ref()
            .map(|entry| entry.operation.clone()))
    }

    /// Returns the operation that owns restoration, starting one when needed.
    ///
    /// Repeated requests return the existing operation. `None` means a recurring
    /// check found nothing to restore.
    pub async fn start_restore<P: RestorePorts>(
        self: &Arc<Self>,
        ports: Arc<P>,
        request: StartRestore,
    ) -> Result<Option<RestoreOperation>, String> {
        let device_id = ports
            .get_sync_identity()
            .and_then(|identity| identity.device_id)
            .ok_or_else(|| "No sync identity configured. Please enable sync first.".to_string())?;
        let needs_bootstrap = ports.needs_bootstrap(&device_id)?;
        let required = needs_bootstrap
            || matches!(
                ports.last_cycle_status()?.as_deref(),
                Some("wait_snapshot" | "stale_cursor")
            );

        let operation = {
            let mut slot = self.restore_slot()?;
            let revision = slot.revision + 1;
            if let Some(entry) = slot.entry.as_ref() {
                let keep = match entry.operation.phase {
                    // Replacement started or finished: never restart underneath it.
                    RestorePhase::BackingUp | RestorePhase::Replacing => true,
                    // Pairing brings a new freshness gate and possibly new keys, so
                    // a snapshot selected before it is out of date.
                    RestorePhase::Transferring
                    | RestorePhase::WaitingForSnapshot
                    | RestorePhase::AwaitingConsent => request != StartRestore::Pairing,
                    // Only the committed bootstrap state, not a transient cycle
                    // status, makes a recurring check replace a finished attempt.
                    RestorePhase::Ready => request == StartRestore::Recurring && !needs_bootstrap,
                    RestorePhase::Failed | RestorePhase::Cancelled => {
                        request == StartRestore::Recurring
                    }
                };
                if keep {
                    return Ok(Some(entry.operation.clone()));
                }
            } else if !required && request == StartRestore::Recurring {
                return Ok(None);
            }

            let operation = RestoreOperation {
                operation_id: uuid::Uuid::new_v4().to_string(),
                revision,
                phase: RestorePhase::Transferring,
                snapshot: None,
                error: None,
                replaced: false,
            };
            info!(
                "[DeviceSync] Restore {} started ({:?})",
                operation.operation_id, request
            );
            // The previous attempt has not started replacing data; stop its work
            // so it cannot download or report after it was superseded.
            if let Some(previous) = slot.entry.take() {
                if let Some(task) = previous.task {
                    task.abort();
                }
            }
            let task = self.spawn_transfer(&ports, &operation.operation_id);
            slot.entry = Some(RestoreEntry {
                operation: operation.clone(),
                prepared: None,
                device_id: None,
                key_version: None,
                task: Some(task),
            });
            slot.revision = revision;
            operation
        };
        ports.publish_restore(&operation);
        Ok(Some(operation))
    }

    /// Approves replacement for this attempt only.
    pub fn approve_restore<P: RestorePorts>(
        self: &Arc<Self>,
        ports: Arc<P>,
        operation_id: &str,
        backup: bool,
    ) -> Result<RestoreOperation, String> {
        let mut slot = self.restore_slot()?;
        let entry = slot
            .entry
            .as_mut()
            .filter(|entry| entry.operation.operation_id == operation_id)
            .ok_or_else(|| STALE_OPERATION.to_string())?;
        match entry.operation.phase {
            RestorePhase::AwaitingConsent => {}
            RestorePhase::BackingUp | RestorePhase::Replacing | RestorePhase::Ready => {
                return Ok(entry.operation.clone())
            }
            _ => return Err("Replacement is not waiting for approval.".to_string()),
        }
        entry.operation.phase = if backup {
            RestorePhase::BackingUp
        } else {
            RestorePhase::Replacing
        };
        entry.operation.error = None;
        // Spawned under the lock, so the task observes this phase first.
        entry.task =
            Some(self.spawn_replace(&ports, operation_id, ReplaceStart::Approved { backup }));
        let operation = bump(&mut slot).ok_or_else(|| STALE_OPERATION.to_string())?;
        drop(slot);
        info!(
            "[DeviceSync] Restore {} approved (backup={})",
            operation_id, backup
        );
        ports.publish_restore(&operation);
        Ok(operation)
    }

    /// Retries the failed step. Replacement always needs fresh approval.
    pub fn retry_restore<P: RestorePorts>(
        self: &Arc<Self>,
        ports: Arc<P>,
        operation_id: &str,
    ) -> Result<RestoreOperation, String> {
        let mut slot = self.restore_slot()?;
        let entry = slot
            .entry
            .as_mut()
            .filter(|entry| entry.operation.operation_id == operation_id)
            .ok_or_else(|| STALE_OPERATION.to_string())?;
        if entry.operation.phase != RestorePhase::Failed {
            return Ok(entry.operation.clone());
        }
        let retry = entry.operation.error.as_ref().map(|error| error.retry);
        // Spawned under the lock, so the task observes the new phase first.
        let (phase, task) = match retry {
            // The downloaded copy is still here; only the approval must be new.
            Some(RestoreRetry::Consent) if entry.prepared.is_some() => {
                if ports.local_rows()? > 0 {
                    (RestorePhase::AwaitingConsent, None)
                } else {
                    let task = self.spawn_replace(&ports, operation_id, ReplaceStart::NoLocalData);
                    (RestorePhase::Replacing, Some(task))
                }
            }
            Some(RestoreRetry::Transfer | RestoreRetry::Consent) => (
                RestorePhase::Transferring,
                Some(self.spawn_transfer(&ports, operation_id)),
            ),
            _ => return Ok(entry.operation.clone()),
        };
        entry.operation.phase = phase.clone();
        entry.operation.error = None;
        entry.task = task;
        let operation = bump(&mut slot).ok_or_else(|| STALE_OPERATION.to_string())?;
        drop(slot);
        info!(
            "[DeviceSync] Restore {} retry (phase={:?})",
            operation_id, phase
        );
        ports.publish_restore(&operation);
        Ok(operation)
    }

    /// Stops an attempt before it is approved. Once approved, the backup and
    /// the replacement (one writer transaction) run to the end.
    pub fn cancel_restore<P: RestorePorts>(
        &self,
        ports: &P,
        operation_id: &str,
    ) -> Result<RestoreOperation, String> {
        let (operation, prepared, task) = {
            let mut slot = self.restore_slot()?;
            let entry = slot
                .entry
                .as_mut()
                .filter(|entry| entry.operation.operation_id == operation_id)
                .ok_or_else(|| STALE_OPERATION.to_string())?;
            match entry.operation.phase {
                RestorePhase::Transferring
                | RestorePhase::WaitingForSnapshot
                | RestorePhase::AwaitingConsent
                | RestorePhase::Failed => {}
                _ => return Ok(entry.operation.clone()),
            }
            entry.operation.phase = RestorePhase::Cancelled;
            let prepared = entry.prepared.take();
            let task = entry.task.take();
            let operation = bump(&mut slot).ok_or_else(|| STALE_OPERATION.to_string())?;
            (operation, prepared, task)
        };
        if let Some(task) = task {
            task.abort();
        }
        drop(prepared);
        info!("[DeviceSync] Restore {} cancelled", operation_id);
        ports.publish_restore(&operation);
        Ok(operation)
    }

    /// Forgets the operation when the profile closes (lock, switch, deletion)
    /// or its sync identity changes (Connect rebind, logout, reset). Work in
    /// progress stops; a replacement already handed to the writer still commits
    /// there, and after a restart the committed bootstrap state decides what
    /// happens next.
    pub async fn clear_restore(&self) {
        let Some(entry) = self
            .restore
            .lock()
            .ok()
            .and_then(|mut slot| slot.entry.take())
        else {
            return;
        };
        if let Some(task) = entry.task {
            task.abort();
            let _ = task.await;
        }
        info!(
            "[DeviceSync] Restore {} cleared",
            entry.operation.operation_id
        );
    }

    // ─── Steps ───────────────────────────────────────────────────────────

    fn spawn_transfer<P: RestorePorts>(
        self: &Arc<Self>,
        ports: &Arc<P>,
        operation_id: &str,
    ) -> JoinHandle<()> {
        let runtime = Arc::clone(self);
        let ports = Arc::clone(ports);
        let operation_id = operation_id.to_string();
        tokio::spawn(async move {
            match runtime.transfer(&*ports, &operation_id).await {
                Ok(true) => runtime.after_transfer(&ports, &operation_id).await,
                Ok(false) => {
                    runtime
                        .finish_without_replacement(&*ports, &operation_id)
                        .await
                }
                Err(error) => runtime.record(&*ports, &operation_id, error),
            }
        })
    }

    fn spawn_replace<P: RestorePorts>(
        self: &Arc<Self>,
        ports: &Arc<P>,
        operation_id: &str,
        start: ReplaceStart,
    ) -> JoinHandle<()> {
        let runtime = Arc::clone(self);
        let ports = Arc::clone(ports);
        let operation_id = operation_id.to_string();
        tokio::spawn(async move {
            runtime
                .replace_then_finish(&*ports, &operation_id, start)
                .await;
        })
    }

    /// `Ok(true)` when a validated snapshot is ready to replace local data.
    async fn transfer<P: RestorePorts>(
        &self,
        ports: &P,
        operation_id: &str,
    ) -> Result<bool, StepError> {
        let session = open_session(ports).await?;
        self.with_entry(operation_id, |entry| {
            entry.device_id = Some(session.device_id.clone());
            entry.key_version = session.identity.key_version;
        })
        .ok_or(StepError::Stale)?;

        // Every transfer, including a retry, uses the latest usable snapshot.
        let Some(selected) = self.select_snapshot(ports, &session, operation_id).await? else {
            return Ok(false);
        };

        let prepared = download_snapshot(ports, &session, &selected).await?;
        self.with_entry(operation_id, |entry| {
            entry.prepared = Some(Arc::new(prepared));
        })
        .ok_or(StepError::Stale)?;
        Ok(true)
    }

    /// Picks the snapshot for this attempt, waiting for the source upload when
    /// needed. `None` means no snapshot is required for this device.
    async fn select_snapshot<P: RestorePorts>(
        &self,
        ports: &P,
        session: &Session,
        operation_id: &str,
    ) -> Result<Option<SnapshotLatestResponse>, StepError> {
        let started = tokio::time::Instant::now();
        let mut delay = SNAPSHOT_WAIT_INITIAL_DELAY;
        loop {
            match find_snapshot(ports, session).await? {
                Selection::Snapshot(snapshot) => {
                    let reference = RestoreSnapshotRef {
                        snapshot_id: snapshot.snapshot_id.clone(),
                        oplog_seq: snapshot.oplog_seq,
                        created_at: snapshot.created_at.clone(),
                    };
                    info!(
                        "[DeviceSync] Restore {} selected snapshot {} (oplog_seq={})",
                        operation_id, reference.snapshot_id, reference.oplog_seq
                    );
                    self.update(ports, operation_id, |entry| {
                        entry.operation.snapshot = Some(reference);
                        entry.operation.phase = RestorePhase::Transferring;
                    })
                    .ok_or(StepError::Stale)?;
                    return Ok(Some(snapshot));
                }
                Selection::NotRequired { reset } => {
                    if reset {
                        ports
                            .mark_restore_not_needed(
                                &session.device_id,
                                session.identity.key_version,
                            )
                            .await
                            .map_err(|message| {
                                failure(
                                    RestoreErrorCode::TransferFailed,
                                    RestoreRetry::Transfer,
                                    message,
                                )
                            })?;
                    }
                    ports.clear_freshness_gate(&session.device_id).await;
                    return Ok(None);
                }
                Selection::Wait => {
                    if started.elapsed() >= SNAPSHOT_WAIT_LIMIT {
                        return Err(failure(
                            RestoreErrorCode::SnapshotWaitTimedOut,
                            RestoreRetry::Transfer,
                            "The other device has not finished uploading its data.",
                        )
                        .into());
                    }
                    self.update(ports, operation_id, |entry| {
                        entry.operation.phase = RestorePhase::WaitingForSnapshot;
                    })
                    .ok_or(StepError::Stale)?;
                    tokio::time::sleep(delay).await;
                    delay = (delay * 2).min(SNAPSHOT_WAIT_MAX_DELAY);
                }
            }
        }
    }

    async fn after_transfer<P: RestorePorts>(&self, ports: &Arc<P>, operation_id: &str) {
        let local_rows = match ports.local_rows() {
            Ok(local_rows) => local_rows,
            Err(message) => {
                return self.record(
                    &**ports,
                    operation_id,
                    failure(
                        RestoreErrorCode::RestoreFailed,
                        RestoreRetry::Consent,
                        message,
                    )
                    .into(),
                )
            }
        };
        if local_rows > 0 {
            self.update(&**ports, operation_id, |entry| {
                entry.operation.phase = RestorePhase::AwaitingConsent;
                entry.task = None;
            });
            return;
        }
        // An empty profile has nothing to lose, so it needs no approval.
        self.update(&**ports, operation_id, |entry| {
            entry.operation.phase = RestorePhase::Replacing;
        });
        self.replace_then_finish(&**ports, operation_id, ReplaceStart::NoLocalData)
            .await;
    }

    async fn finish_without_replacement<P: RestorePorts>(&self, ports: &P, operation_id: &str) {
        info!(
            "[DeviceSync] Restore {} not required for this device",
            operation_id
        );
        if let Err(error) = ports.resume_sync(false).await {
            warn!(
                "[DeviceSync] Restore {} could not resume sync: {}",
                operation_id, error
            );
        }
        self.update(ports, operation_id, |entry| {
            entry.operation.phase = RestorePhase::Ready;
            entry.task = None;
        });
    }

    async fn replace_then_finish<P: RestorePorts>(
        &self,
        ports: &P,
        operation_id: &str,
        start: ReplaceStart,
    ) {
        if let Err(error) = self.replace(ports, operation_id, start).await {
            return self.record(ports, operation_id, error);
        }
        // The data is in place and syncing. Recalculating the portfolio is the
        // app's usual follow-up to new data, with its own progress and errors.
        if self
            .update(ports, operation_id, |entry| {
                entry.operation.phase = RestorePhase::Ready;
                entry.task = None;
            })
            .is_some()
        {
            info!("[DeviceSync] Restore {} ready", operation_id);
            ports.refresh_portfolio();
        }
    }

    async fn replace<P: RestorePorts>(
        &self,
        ports: &P,
        operation_id: &str,
        start: ReplaceStart,
    ) -> Result<(), StepError> {
        let (prepared, device_id, key_version) = self
            .with_entry(operation_id, |entry| {
                (
                    entry.prepared.clone(),
                    entry.device_id.clone(),
                    entry.key_version,
                )
            })
            .ok_or(StepError::Stale)?;
        let (Some(prepared), Some(device_id)) = (prepared, device_id) else {
            return Err(failure(
                RestoreErrorCode::RestoreFailed,
                RestoreRetry::Transfer,
                "The downloaded data is no longer available.",
            )
            .into());
        };
        // The downloaded copy belongs to the identity it was validated with.
        let identity = ports
            .get_sync_identity()
            .filter(|identity| {
                identity.device_id.as_deref() == Some(device_id.as_str())
                    && identity.key_version == key_version
            })
            .ok_or_else(|| {
                failure(
                    RestoreErrorCode::DeviceNotReady,
                    RestoreRetry::NewAttempt,
                    "This device's sync identity changed during setup.",
                )
            })?;
        let image = write_scratch_image(ports, &prepared, &identity)?;

        // Keep sync cycles from pulling into the tables being replaced.
        let _cycle = self.cycle_mutex.lock().await;
        match start {
            // Consent was skipped for an empty profile; recheck right before
            // replacing, in case data was added while the snapshot downloaded.
            ReplaceStart::NoLocalData => {
                let local_rows = ports.local_rows().map_err(|message| {
                    failure(
                        RestoreErrorCode::RestoreFailed,
                        RestoreRetry::Consent,
                        message,
                    )
                })?;
                if local_rows > 0 {
                    return Err(StepError::NeedsConsent);
                }
            }
            ReplaceStart::Approved { backup: false } => {}
            ReplaceStart::Approved { backup: true } => {
                ports.backup_before_restore().await.map_err(|message| {
                    failure(
                        RestoreErrorCode::BackupFailed,
                        RestoreRetry::Consent,
                        message,
                    )
                })?
            }
        }

        self.update(ports, operation_id, |entry| {
            entry.operation.phase = RestorePhase::Replacing;
        })
        .ok_or(StepError::Stale)?;

        info!(
            "[DeviceSync] Restore {} replacing local data from snapshot (oplog_seq={})",
            operation_id, prepared.oplog_seq
        );
        let result = ports
            .replace_local_data(RestoreFile {
                path: &image.0,
                tables: prepared.tables.clone(),
                oplog_seq: prepared.oplog_seq,
                device_id: device_id.clone(),
                key_version,
            })
            .await;
        drop(_cycle);
        drop(image);
        if let Err(message) = result {
            return Err(failure(
                RestoreErrorCode::RestoreFailed,
                RestoreRetry::Consent,
                message,
            )
            .into());
        }

        ports.clear_freshness_gate(&device_id).await;
        self.update(ports, operation_id, |entry| {
            entry.operation.replaced = true;
            entry.prepared = None;
        })
        .ok_or(StepError::Stale)?;
        if let Err(error) = ports.resume_sync(true).await {
            warn!(
                "[DeviceSync] Restore {} could not resume sync after replacement: {}",
                operation_id, error
            );
        }
        Ok(())
    }

    fn record<P: RestorePorts>(&self, ports: &P, operation_id: &str, error: StepError) {
        match error {
            StepError::Stale => {}
            StepError::NeedsConsent => {
                info!(
                    "[DeviceSync] Restore {} found new local data; asking for consent",
                    operation_id
                );
                self.update(ports, operation_id, |entry| {
                    entry.operation.phase = RestorePhase::AwaitingConsent;
                    entry.task = None;
                });
            }
            StepError::Failed(failure) => {
                warn!(
                    "[DeviceSync] Restore {} failed (code={:?}, retry={:?})",
                    operation_id, failure.code, failure.retry
                );
                debug!(
                    "[DeviceSync] Restore {} failure detail: {}",
                    operation_id, failure.message
                );
                self.update(ports, operation_id, |entry| {
                    if failure.retry == RestoreRetry::NewAttempt {
                        entry.prepared = None;
                    }
                    entry.operation.phase = RestorePhase::Failed;
                    entry.operation.error = Some(RestoreError {
                        code: failure.code,
                        message: failure.message,
                        retry: failure.retry,
                    });
                    entry.task = None;
                });
            }
        }
    }

    // ─── Slot access ─────────────────────────────────────────────────────

    fn with_entry<T>(
        &self,
        operation_id: &str,
        read: impl FnOnce(&mut RestoreEntry) -> T,
    ) -> Option<T> {
        let mut slot = self.restore.lock().ok()?;
        let entry = slot
            .entry
            .as_mut()
            .filter(|entry| entry.operation.operation_id == operation_id)?;
        Some(read(entry))
    }

    /// Applies a step's change and publishes it. Ignored once the operation was
    /// replaced or cancelled, so late results cannot revive it.
    fn update<P: RestorePorts>(
        &self,
        ports: &P,
        operation_id: &str,
        change: impl FnOnce(&mut RestoreEntry),
    ) -> Option<RestoreOperation> {
        let operation = {
            let mut slot = self.restore.lock().ok()?;
            let revision = slot.revision + 1;
            let entry = slot.entry.as_mut().filter(|entry| {
                entry.operation.operation_id == operation_id
                    && entry.operation.phase != RestorePhase::Cancelled
            })?;
            let before = entry.operation.phase.clone();
            change(entry);
            entry.operation.revision = revision;
            if entry.operation.phase != before {
                debug!(
                    "[DeviceSync] Restore {} phase {:?} -> {:?}",
                    operation_id, before, entry.operation.phase
                );
            }
            let operation = entry.operation.clone();
            slot.revision = revision;
            operation
        };
        ports.publish_restore(&operation);
        Some(operation)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot selection and validation
// ─────────────────────────────────────────────────────────────────────────────

async fn open_session<P: RestorePorts>(ports: &P) -> Result<Session, Failure> {
    let not_ready = |message: String| {
        failure(
            RestoreErrorCode::DeviceNotReady,
            RestoreRetry::Transfer,
            message,
        )
    };
    match ports.is_sync_allowed().await {
        Ok(true) => {}
        Ok(false) => {
            return Err(failure(
                RestoreErrorCode::SubscriptionRequired,
                RestoreRetry::Transfer,
                "Device sync requires an active subscription.",
            ))
        }
        Err(error) => return Err(not_ready(error)),
    }
    let identity = ports
        .get_sync_identity()
        .ok_or_else(|| not_ready("No sync identity configured.".to_string()))?;
    let device_id = identity
        .device_id
        .clone()
        .ok_or_else(|| not_ready("No device ID configured.".to_string()))?;
    if identity.root_key.is_none() || identity.key_version.unwrap_or(0) <= 0 {
        return Err(not_ready(
            "This device has not received its sync keys.".to_string(),
        ));
    }
    let state = ports.get_sync_state().await.map_err(not_ready)?;
    if state != SyncState::Ready {
        return Err(not_ready(
            "This device is not ready to sync yet.".to_string(),
        ));
    }
    ports.persist_device_config(&identity, "trusted").await;
    let token = ports.get_access_token().await.map_err(not_ready)?;
    Ok(Session {
        token,
        device_id,
        identity,
    })
}

fn transfer_failed(error: TransportError) -> Failure {
    failure(
        RestoreErrorCode::TransferFailed,
        RestoreRetry::Transfer,
        error.message,
    )
}

async fn find_snapshot<P: RestorePorts>(
    ports: &P,
    session: &Session,
) -> Result<Selection, Failure> {
    let device_id = session.device_id.as_str();
    let gate = match ports.freshness_gate(device_id) {
        Some(value) => match crate::normalize_sync_datetime(&value) {
            Ok(normalized) => Some(normalized),
            Err(_) => {
                warn!("[DeviceSync] Dropping invalid snapshot freshness gate");
                ports.clear_freshness_gate(device_id).await;
                None
            }
        },
        None => None,
    };
    let action = ports
        .get_reconcile_ready_state(&session.token, device_id)
        .await
        .ok()
        .map(|reconcile| reconcile.action);
    let reconcile_requires_snapshot = matches!(
        action.as_deref(),
        Some("WAIT_SNAPSHOT") | Some("BOOTSTRAP_SNAPSHOT")
    );
    let needs_bootstrap = ports.needs_bootstrap(device_id).map_err(|message| {
        failure(
            RestoreErrorCode::TransferFailed,
            RestoreRetry::Transfer,
            message,
        )
    })?;
    if !needs_bootstrap && gate.is_none() && !reconcile_requires_snapshot {
        return Ok(Selection::NotRequired { reset: false });
    }

    let Some(latest) = ports
        .get_latest_snapshot(&session.token, device_id)
        .await
        .map_err(transfer_failed)?
    else {
        if gate.is_none() && matches!(action.as_deref(), Some("NOOP") | Some("PULL_TAIL")) {
            return Ok(Selection::NotRequired { reset: true });
        }
        return Ok(Selection::Wait);
    };
    if latest.snapshot_id.trim().is_empty() {
        return Ok(Selection::Wait);
    }
    if let Some(gate) = gate.as_deref() {
        if !satisfies_freshness_gate(ports, session, &latest, gate).await? {
            debug!(
                "[DeviceSync] Snapshot {} predates this pairing; waiting for a newer upload",
                latest.snapshot_id
            );
            return Ok(Selection::Wait);
        }
    }
    if latest.schema_version > SNAPSHOT_SCHEMA_VERSION {
        return Err(schema_newer(latest.schema_version));
    }
    Ok(Selection::Snapshot(latest))
}

fn schema_newer(schema_version: i32) -> Failure {
    failure(
        RestoreErrorCode::SnapshotSchemaNewer,
        RestoreRetry::NewAttempt,
        format!(
            "Snapshot schema version {} is newer than local version {}. Update the app.",
            schema_version, SNAPSHOT_SCHEMA_VERSION
        ),
    )
}

async fn satisfies_freshness_gate<P: RestorePorts>(
    ports: &P,
    session: &Session,
    latest: &SnapshotLatestResponse,
    gate: &str,
) -> Result<bool, Failure> {
    let invalid = |message: String| {
        failure(
            RestoreErrorCode::SnapshotInvalid,
            RestoreRetry::Transfer,
            message,
        )
    };
    let created_at = crate::parse_sync_datetime_to_utc(&latest.created_at)
        .map_err(|error| invalid(format!("Invalid snapshot created_at: {error}")))?;
    let gate = crate::parse_sync_datetime_to_utc(gate)
        .map_err(|error| invalid(format!("Invalid snapshot freshness gate: {error}")))?;
    if created_at + chrono::Duration::seconds(SNAPSHOT_FRESHNESS_CLOCK_SKEW_LEEWAY_SECS) > gate {
        return Ok(true);
    }
    // An older snapshot is still usable when it already covers every event.
    Ok(matches!(
        ports.get_events_cursor(&session.token, &session.device_id).await,
        Ok(cursor) if latest.oplog_seq >= cursor.cursor
    ))
}

async fn download_snapshot<P: RestorePorts>(
    ports: &P,
    session: &Session,
    selected: &SnapshotLatestResponse,
) -> Result<PreparedSnapshot, Failure> {
    let snapshot_id = selected.snapshot_id.trim();
    let (headers, blob) = ports
        .download_snapshot(&session.token, &session.device_id, snapshot_id)
        .await
        .map_err(transfer_failed)?
        .ok_or_else(|| {
            failure(
                RestoreErrorCode::SnapshotUnavailable,
                RestoreRetry::Transfer,
                format!("Snapshot {snapshot_id} is no longer available."),
            )
        })?;

    let checksum = crate::crypto::sha256_checksum(&blob);
    let metadata_checksum = selected.checksum.trim();
    if headers.checksum != checksum
        || (!metadata_checksum.is_empty() && metadata_checksum != checksum)
    {
        return Err(failure(
            RestoreErrorCode::SnapshotInvalid,
            RestoreRetry::Transfer,
            format!("Snapshot {snapshot_id} failed its checksum."),
        ));
    }
    if headers.schema_version > SNAPSHOT_SCHEMA_VERSION {
        return Err(schema_newer(headers.schema_version));
    }

    // Validate before asking for consent; the readable image is discarded.
    decode_snapshot_image(&blob, &session.identity).map_err(|message| {
        failure(
            RestoreErrorCode::SnapshotInvalid,
            RestoreRetry::NewAttempt,
            message,
        )
    })?;

    let mut tables: Vec<String> = selected
        .covers_tables
        .iter()
        .filter(|table| APP_SYNC_TABLES.contains(&table.as_str()))
        .cloned()
        .collect();
    if tables.is_empty() {
        tables = APP_SYNC_TABLES
            .iter()
            .map(|table| table.to_string())
            .collect();
    }
    Ok(PreparedSnapshot {
        ciphertext: blob,
        tables,
        oplog_seq: selected.oplog_seq,
    })
}

/// Decrypts the approved snapshot into app-private scratch storage, not the
/// shared temp directory: the image is a plaintext copy of synced financial rows.
fn write_scratch_image<P: RestorePorts>(
    ports: &P,
    prepared: &PreparedSnapshot,
    identity: &SyncIdentity,
) -> Result<ScratchImage, Failure> {
    let image = decode_snapshot_image(&prepared.ciphertext, identity).map_err(|message| {
        failure(
            RestoreErrorCode::SnapshotInvalid,
            RestoreRetry::NewAttempt,
            message,
        )
    })?;
    let stored = |message: String| {
        failure(
            RestoreErrorCode::RestoreFailed,
            RestoreRetry::Consent,
            message,
        )
    };
    let image_file = ScratchImage(
        ports
            .scratch_dir()
            .map_err(stored)?
            .join(format!("wf_snapshot_{}.db", uuid::Uuid::new_v4())),
    );
    std::fs::write(&image_file.0, image)
        .map_err(|error| stored(format!("Failed to store the snapshot image: {error}")))?;
    Ok(image_file)
}

fn decode_snapshot_image(blob: &[u8], identity: &SyncIdentity) -> Result<Vec<u8>, String> {
    let root_key = identity
        .root_key
        .as_deref()
        .ok_or("Missing root_key in sync identity")?;
    let key_version = identity
        .key_version
        .filter(|version| *version > 0)
        .ok_or("Invalid key version in sync identity")?;
    let ciphertext = std::str::from_utf8(blob)
        .map_err(|_| "Snapshot payload is not valid UTF-8 (expected encrypted ciphertext)")?;
    let dek = crate::crypto::derive_dek(root_key, key_version as u32)
        .map_err(|e| format!("Failed to derive snapshot DEK: {e}"))?;
    let decrypted = crate::crypto::decrypt(&dek, ciphertext.trim())
        .map_err(|e| format!("Failed to decrypt snapshot payload: {e}"))?;
    let image = BASE64_STANDARD
        .decode(decrypted.trim())
        .map_err(|e| format!("Failed to base64-decode decrypted snapshot: {e}"))?;
    if !image.starts_with(b"SQLite format 3\0") {
        return Err("Decrypted snapshot is not a valid SQLite image".to_string());
    }
    Ok(image)
}
