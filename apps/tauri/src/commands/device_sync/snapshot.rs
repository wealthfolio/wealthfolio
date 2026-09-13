//! Snapshot generation, upload, and bootstrap flows.

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
use chrono::{Duration, Utc};
use log::{debug, info};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::context::ServiceContext;
use crate::events::{emit_portfolio_trigger_recalculate, PortfolioRequestPayload};
use wealthfolio_core::quotes::MarketSyncMode;
use wealthfolio_core::sync::{
    snapshot_covers_cursor_and_schema, APP_SYNC_TABLES, SNAPSHOT_SCHEMA_VERSION,
};
use wealthfolio_device_sync::SyncState;

use super::{
    clear_min_snapshot_created_at_from_store, create_client, encrypt_sync_payload,
    get_access_token, get_min_snapshot_created_at_from_store, get_sync_identity_from_store,
    is_sqlite_image, persist_device_config_from_identity,
    remove_min_snapshot_created_at_from_store, sha256_checksum, SyncBootstrapResult, SyncIdentity,
    SyncPairingSourceStatusResult, SyncSnapshotUploadResult, SYNC_SOURCE_RESTORE_REQUIRED_CODE,
};

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotUploadProgressEvent {
    stage: String,
    progress: u8,
    message: String,
}

const DEVICE_SYNC_SNAPSHOT_UPLOAD_PROGRESS_EVENT: &str = "device-sync:snapshot-upload-progress";
const SNAPSHOT_FRESHNESS_CLOCK_SKEW_LEEWAY_SECS: i64 = 120;

fn is_snapshot_index_conflict(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    message.contains("sync_transaction_failed") && message.contains("snapshot index conflict")
}

fn sync_source_restore_required_error() -> String {
    format!(
        "{SYNC_SOURCE_RESTORE_REQUIRED_CODE}: This device needs to set up sync again before you add another device."
    )
}

pub async fn get_pairing_source_status_internal(
    context: Arc<ServiceContext>,
) -> Result<SyncPairingSourceStatusResult, String> {
    let identity = get_sync_identity_from_store()
        .ok_or_else(|| "No sync identity configured. Please enable sync first.".to_string())?;
    let device_id = identity
        .device_id
        .clone()
        .ok_or_else(|| "No device ID configured".to_string())?;
    let token = get_access_token(&context).await?;
    let client = create_client()?;
    let sync_state = client
        .get_device(&token, &device_id)
        .await
        .map_err(|e| e.to_string())?;
    if sync_state.trust_state != wealthfolio_device_sync::TrustState::Trusted {
        return Err("Current device is not ready to connect another device yet.".to_string());
    }

    let local_cursor = context
        .app_sync_repository()
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

async fn snapshot_satisfies_freshness_gate(
    client: &wealthfolio_device_sync::DeviceSyncClient,
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
            info!(
                "[DeviceSync] Accepting snapshot {} older than freshness gate because oplog_seq {} already covers remote cursor {}",
                latest.snapshot_id,
                latest.oplog_seq,
                cursor.cursor
            );
            Ok(true)
        }
        Ok(cursor) => {
            debug!(
                "[DeviceSync] Snapshot {} is older than freshness gate and oplog_seq {} does not cover remote cursor {}",
                latest.snapshot_id,
                latest.oplog_seq,
                cursor.cursor
            );
            Ok(false)
        }
        Err(err) => {
            debug!(
                "[DeviceSync] Failed to verify remote cursor for freshness gate on snapshot {}: {}",
                latest.snapshot_id, err
            );
            Ok(false)
        }
    }
}

enum MissingSnapshotDisposition {
    CompleteNoBootstrap { message: String },
    WaitForSnapshot { message: String },
}

async fn classify_missing_snapshot_disposition(
    client: &wealthfolio_device_sync::DeviceSyncClient,
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
                debug!(
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
            debug!(
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

fn emit_snapshot_upload_progress(
    handle: Option<&AppHandle>,
    stage: &str,
    progress: u8,
    message: &str,
) {
    if let Some(handle) = handle {
        let payload = SnapshotUploadProgressEvent {
            stage: stage.to_string(),
            progress,
            message: message.to_string(),
        };
        let _ = handle.emit(DEVICE_SYNC_SNAPSHOT_UPLOAD_PROGRESS_EVENT, payload);
    }
}

fn snapshot_upload_cancelled_result(message: &str) -> SyncSnapshotUploadResult {
    SyncSnapshotUploadResult {
        status: "cancelled".to_string(),
        snapshot_id: None,
        oplog_seq: None,
        message: message.to_string(),
    }
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

/// Bootstraps local sync tables from the latest snapshot when required.
pub async fn sync_bootstrap_snapshot_if_needed(
    handle: AppHandle,
    context: &Arc<ServiceContext>,
) -> Result<SyncBootstrapResult, String> {
    context
        .connect_service()
        .ensure_device_sync_subscription()
        .await?;
    let identity = get_sync_identity_from_store()
        .ok_or_else(|| "No sync identity configured. Please enable sync first.".to_string())?;
    let device_id = identity
        .device_id
        .clone()
        .ok_or_else(|| "No device ID configured".to_string())?;
    let token = get_access_token(context).await?;
    // Check in-memory first, then fall back to SQLite (survives restart)
    let raw_freshness_gate = get_min_snapshot_created_at_from_store(&device_id).or_else(|| {
        context
            .app_sync_repository()
            .get_min_snapshot_created_at(&device_id)
            .ok()
            .flatten()
    });
    let min_snapshot_created_at = match raw_freshness_gate {
        Some(value) => match wealthfolio_device_sync::normalize_sync_datetime(&value) {
            Ok(normalized) => Some(normalized),
            Err(_) => {
                log::warn!(
                    "[DeviceSync] Dropping invalid min snapshot freshness gate: {}",
                    value
                );
                remove_min_snapshot_created_at_from_store(&device_id);
                let _ = context
                    .app_sync_repository()
                    .clear_min_snapshot_created_at(device_id.clone())
                    .await;
                None
            }
        },
        None => None,
    };

    let sync_state = context
        .device_enroll_service()
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
    persist_device_config_from_identity(context.as_ref(), &identity, "trusted").await;

    let sync_repo = context.app_sync_repository();
    let client = create_client()?;
    let reconcile_action = client
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

        debug!(
            "[DeviceSync] Local bootstrap marked complete but reconcile still requires snapshot; re-checking latest snapshot metadata"
        );
    }

    if reconcile_action.as_deref() == Some("WAIT_SNAPSHOT") {
        debug!(
            "[DeviceSync] Reconcile indicates WAIT_SNAPSHOT; checking latest snapshot metadata for race-safe bootstrap"
        );
    }

    debug!(
        "[DeviceSync] Requesting latest snapshot metadata for device {}",
        device_id
    );
    let latest = match client
        .get_latest_snapshot_with_cursor_fallback(&token, &device_id)
        .await
    {
        Ok(value) => value,
        Err(err) => {
            if err.status_code() == Some(404) {
                if min_snapshot_created_at.is_some() {
                    debug!(
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
                match classify_missing_snapshot_disposition(&client, &token, &device_id).await {
                    MissingSnapshotDisposition::CompleteNoBootstrap { message } => {
                        debug!(
                            "[DeviceSync] No snapshot found (404) and reconcile indicates no bootstrap needed"
                        );
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
                        debug!("[DeviceSync] No snapshot found (404); waiting for trusted device upload");
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
                debug!(
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
            match classify_missing_snapshot_disposition(&client, &token, &device_id).await {
                MissingSnapshotDisposition::CompleteNoBootstrap { message } => {
                    debug!(
                        "[DeviceSync] Snapshot metadata is empty and reconcile indicates no bootstrap needed"
                    );
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
                    debug!(
                        "[DeviceSync] Snapshot metadata is empty; waiting for trusted device upload"
                    );
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

    debug!(
        "[DeviceSync] Latest snapshot metadata: id='{}' schema={} oplog_seq={} size={}",
        latest.snapshot_id, latest.schema_version, latest.oplog_seq, latest.size_bytes
    );

    if let Some(min_created_at) = min_snapshot_created_at.as_deref() {
        if !snapshot_satisfies_freshness_gate(&client, &token, &device_id, &latest, min_created_at)
            .await?
        {
            debug!(
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

    const LOCAL_SCHEMA_VERSION: i32 = SNAPSHOT_SCHEMA_VERSION;
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

    let (headers, blob) = match client
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
    debug!(
        "[DeviceSync] Snapshot download response headers: schema_version={} tables={} checksum={} blob_size={}",
        headers.schema_version,
        headers.covers_tables.join(","),
        headers.checksum,
        blob.len()
    );

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
        std::env::temp_dir().join(format!("wf_snapshot_{}.db", Uuid::new_v4()));
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

    let payload = PortfolioRequestPayload::builder()
        .account_ids(None)
        .market_sync_mode(MarketSyncMode::Incremental { asset_ids: None })
        .build();
    emit_portfolio_trigger_recalculate(&handle, payload);

    // Clear freshness gate from both in-memory and SQLite
    clear_min_snapshot_created_at_from_store();
    if let Err(err) = sync_repo.clear_min_snapshot_created_at(device_id).await {
        log::warn!(
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

pub async fn generate_snapshot_now_internal(
    handle: Option<&AppHandle>,
    context: Arc<ServiceContext>,
) -> Result<SyncSnapshotUploadResult, String> {
    context
        .connect_service()
        .ensure_device_sync_subscription()
        .await?;
    context
        .device_sync_runtime()
        .snapshot_upload_cancelled
        .store(false, Ordering::Relaxed);
    emit_snapshot_upload_progress(handle, "start", 5, "Preparing snapshot export");

    let identity = get_sync_identity_from_store()
        .ok_or_else(|| "No sync identity configured. Please enable sync first.".to_string())?;
    let device_id = identity
        .device_id
        .clone()
        .ok_or_else(|| "No device ID configured".to_string())?;
    let key_version = identity.key_version.unwrap_or(1).max(1);
    let token = get_access_token(&context).await?;

    let sync_state = create_client()?
        .get_device(&token, &device_id)
        .await
        .map_err(|e| e.to_string())?;
    debug!(
        "[DeviceSync] Snapshot upload eligibility: device_id={} trust_state={:?}",
        device_id, sync_state.trust_state
    );
    if sync_state.trust_state != wealthfolio_device_sync::TrustState::Trusted {
        return Ok(SyncSnapshotUploadResult {
            status: "skipped".to_string(),
            snapshot_id: None,
            oplog_seq: None,
            message: "Current device is not trusted".to_string(),
        });
    }
    if context
        .device_sync_runtime()
        .snapshot_upload_cancelled
        .load(Ordering::Relaxed)
    {
        emit_snapshot_upload_progress(handle, "cancelled", 0, "Snapshot upload cancelled");
        return Ok(snapshot_upload_cancelled_result(
            "Snapshot upload cancelled before export",
        ));
    }

    let local_cursor = context.app_sync_repository().get_cursor().ok();
    let server_cursor = create_client()?
        .get_events_cursor(&token, &device_id)
        .await
        .map_err(|e| e.to_string())?
        .cursor;
    if local_cursor.is_some_and(|cursor| cursor > server_cursor) {
        return Err(sync_source_restore_required_error());
    }
    if let Some(cursor) = local_cursor {
        if let Ok(Some(latest_snapshot)) = create_client()?
            .get_latest_snapshot_with_cursor_fallback(&token, &device_id)
            .await
        {
            if snapshot_covers_cursor_and_schema(
                latest_snapshot.oplog_seq,
                latest_snapshot.schema_version,
                cursor,
                SNAPSHOT_SCHEMA_VERSION,
            ) {
                info!(
                    "[DeviceSync] Reusing latest remote snapshot id={} oplog_seq={} for cursor={}",
                    latest_snapshot.snapshot_id, latest_snapshot.oplog_seq, cursor
                );
                emit_snapshot_upload_progress(
                    handle,
                    "completed",
                    100,
                    "Latest remote snapshot already covers current data",
                );
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
    context
        .app_sync_repository()
        .validate_snapshot_upload_integrity(sync_tables.clone())
        .await
        .map_err(|e| format!("Cannot upload snapshot: {}", e))?;

    let sqlite_bytes = context
        .app_sync_repository()
        .export_snapshot_sqlite_image(sync_tables)
        .await
        .map_err(|e| format!("Failed to export snapshot SQLite image: {}", e))?;
    emit_snapshot_upload_progress(handle, "exported", 35, "Snapshot exported");
    if context
        .device_sync_runtime()
        .snapshot_upload_cancelled
        .load(Ordering::Relaxed)
    {
        emit_snapshot_upload_progress(handle, "cancelled", 0, "Snapshot upload cancelled");
        return Ok(snapshot_upload_cancelled_result(
            "Snapshot upload cancelled after export",
        ));
    }

    // Base64-encode the raw SQLite bytes before encryption because the crypto
    // module operates on UTF-8 strings (encrypt/decrypt take &str). Binary-mode
    // encryption would avoid this overhead but isn't supported by the current API.
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
    debug!(
        "[DeviceSync] Snapshot upload cursor anchor local_cursor={:?} server_cursor={} base_seq={:?}",
        local_cursor, server_cursor, base_seq
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
    let checksum_prefix = upload_headers
        .checksum
        .strip_prefix("sha256:")
        .unwrap_or(upload_headers.checksum.as_str());
    let checksum_prefix = &checksum_prefix[..checksum_prefix.len().min(12)];
    emit_snapshot_upload_progress(handle, "uploading", 70, "Uploading snapshot");
    info!(
        "[DeviceSync] Snapshot upload start device_id={} size_bytes={} key_version={} checksum=sha256:{}",
        device_id,
        upload_headers.size_bytes,
        upload_headers.payload_key_version,
        checksum_prefix
    );

    let runtime = context.device_sync_runtime();
    let upload_result = create_client()?
        .upload_snapshot_with_cancel_flag(
            &token,
            &device_id,
            upload_headers,
            payload,
            Some(&runtime.snapshot_upload_cancelled),
        )
        .await;
    let response = match upload_result {
        Ok(value) => value,
        Err(err) => {
            let message = err.to_string();
            if message.to_ascii_lowercase().contains("cancelled") {
                emit_snapshot_upload_progress(
                    handle,
                    "cancelled",
                    0,
                    "Snapshot upload cancelled during transfer",
                );
                return Ok(snapshot_upload_cancelled_result(
                    "Snapshot upload cancelled during transfer",
                ));
            }
            if is_snapshot_index_conflict(&message) {
                let latest = match create_client() {
                    Ok(client) => client
                        .get_latest_snapshot_with_cursor_fallback(&token, &device_id)
                        .await
                        .ok()
                        .flatten(),
                    Err(_) => None,
                };
                if let (Some(cursor), Some(snapshot)) = (local_cursor, latest) {
                    if snapshot_covers_cursor_and_schema(
                        snapshot.oplog_seq,
                        snapshot.schema_version,
                        cursor,
                        SNAPSHOT_SCHEMA_VERSION,
                    ) {
                        info!(
                            "[DeviceSync] Snapshot conflict resolved by existing remote snapshot id={} oplog_seq={} cursor={}",
                            snapshot.snapshot_id, snapshot.oplog_seq, cursor
                        );
                        emit_snapshot_upload_progress(
                            handle,
                            "complete",
                            100,
                            "Snapshot already available",
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
    info!(
        "[DeviceSync] Snapshot upload success snapshot_id={} oplog_seq={} r2_key={}",
        response.snapshot_id, response.oplog_seq, response.r2_key
    );
    emit_snapshot_upload_progress(handle, "complete", 100, "Snapshot upload complete");

    Ok(SyncSnapshotUploadResult {
        status: "uploaded".to_string(),
        snapshot_id: Some(response.snapshot_id),
        oplog_seq: Some(response.oplog_seq),
        message: "Snapshot uploaded".to_string(),
    })
}
