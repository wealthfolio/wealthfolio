//! Snapshot generation and upload. Restoration is owned by the restore operation.

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
use chrono::Utc;
use log::{debug, info};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::AppHandle;
use uuid::Uuid;

use crate::context::ServiceContext;
use wealthfolio_core::sync::{
    snapshot_covers_cursor_and_schema, APP_SYNC_TABLES, SNAPSHOT_SCHEMA_VERSION,
};

use super::{
    create_client, encrypt_sync_payload, get_access_token, get_sync_identity_from_store,
    sha256_checksum, SyncPairingSourceStatusResult, SyncSnapshotUploadResult,
    SYNC_SOURCE_RESTORE_REQUIRED_CODE,
};

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotUploadProgressEvent {
    stage: String,
    progress: u8,
    message: String,
}

const DEVICE_SYNC_SNAPSHOT_UPLOAD_PROGRESS_EVENT: &str = "device-sync:snapshot-upload-progress";

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
    let identity = get_sync_identity_from_store(&context)
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

fn emit_snapshot_upload_progress(
    context: &ServiceContext,
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
        let _ = crate::events::emit_for_profile(
            handle,
            context,
            DEVICE_SYNC_SNAPSHOT_UPLOAD_PROGRESS_EVENT,
            payload,
        );
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
    emit_snapshot_upload_progress(&context, handle, "start", 5, "Preparing snapshot export");

    let identity = get_sync_identity_from_store(&context)
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
        emit_snapshot_upload_progress(
            &context,
            handle,
            "cancelled",
            0,
            "Snapshot upload cancelled",
        );
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
                    &context,
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
    emit_snapshot_upload_progress(&context, handle, "exported", 35, "Snapshot exported");
    if context
        .device_sync_runtime()
        .snapshot_upload_cancelled
        .load(Ordering::Relaxed)
    {
        emit_snapshot_upload_progress(
            &context,
            handle,
            "cancelled",
            0,
            "Snapshot upload cancelled",
        );
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
    emit_snapshot_upload_progress(&context, handle, "uploading", 70, "Uploading snapshot");
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
                    &context,
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
                            &context,
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
    emit_snapshot_upload_progress(
        &context,
        handle,
        "complete",
        100,
        "Snapshot upload complete",
    );

    Ok(SyncSnapshotUploadResult {
        status: "uploaded".to_string(),
        snapshot_id: Some(response.snapshot_id),
        oplog_seq: Some(response.oplog_seq),
        message: "Snapshot uploaded".to_string(),
    })
}
