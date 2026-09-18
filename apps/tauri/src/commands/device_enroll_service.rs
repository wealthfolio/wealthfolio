//! Device Enroll Service Commands
//!
//! Tauri command wrappers for the DeviceEnrollService.
//! These commands delegate to the shared service in the context.

use crate::database::DatabaseRuntime;
use std::sync::Arc;
use tauri::State;

use crate::commands::device_sync::{
    clear_min_snapshot_created_at_from_store, ensure_background_engine_started,
    ensure_background_engine_stopped,
};

// Re-export types for use in other modules
pub use wealthfolio_device_sync::{EnableSyncResult, SyncState, SyncStateResult};

/// Get the current device sync state.
/// Returns the state machine status: FRESH, REGISTERED, READY, STALE, or RECOVERY.
#[tauri::command]
pub async fn get_device_sync_state(
    context: State<'_, DatabaseRuntime>,
) -> Result<SyncStateResult, String> {
    let context = context.context()?;
    let token = context.connect_service().get_valid_access_token().await?;
    context
        .device_enroll_service()
        .get_sync_state(&token)
        .await
        .map_err(|e| e.message)
}

/// Enable device sync - enrolls the device and initializes E2EE if first device.
/// Call this when user clicks "Enable Sync" button.
#[tauri::command]
pub async fn enable_device_sync(
    context: State<'_, DatabaseRuntime>,
) -> Result<EnableSyncResult, String> {
    let context = context.context()?;
    let token = context.connect_service().get_valid_access_token().await?;
    let result = context
        .device_enroll_service()
        .enable_sync(&token)
        .await
        .map_err(|e| e.message)?;
    clear_min_snapshot_created_at_from_store();
    let _ = context
        .app_sync_repository()
        .clear_all_min_snapshot_created_at()
        .await;

    if result.state == SyncState::Ready {
        // Clear stale outbox/metadata from any previous sync session before
        // the bg engine starts pushing events.
        let _ = context
            .app_sync_repository()
            .reset_and_mark_bootstrap_complete(result.device_id.clone(), result.key_version)
            .await;

        let engine_context = Arc::clone(&context);
        tauri::async_runtime::spawn(async move {
            if let Err(err) = ensure_background_engine_started(engine_context).await {
                log::warn!(
                    "[DeviceSync] Post-enable background engine start failed: {}",
                    err
                );
            }
        });
    }

    Ok(result)
}

/// Clear all device sync data and return to FRESH state.
/// Use for troubleshooting or when user wants to reset sync.
#[tauri::command]
pub async fn clear_device_sync_data(context: State<'_, DatabaseRuntime>) -> Result<(), String> {
    let context = context.context()?;
    ensure_background_engine_stopped(Arc::clone(&context)).await?;
    let result = context
        .device_enroll_service()
        .clear_sync_data()
        .map_err(|e| e.message);
    if result.is_ok() {
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
    result
}

/// Reinitialize device sync - resets server data and enables sync in one operation.
/// Used when sync is in orphaned state (keys exist but no devices).
#[tauri::command]
pub async fn reinitialize_device_sync(
    context: State<'_, DatabaseRuntime>,
) -> Result<EnableSyncResult, String> {
    let context = context.context()?;
    let token = context.connect_service().get_valid_access_token().await?;
    let result = context
        .device_enroll_service()
        .reinitialize_sync(&token)
        .await
        .map_err(|e| e.message)?;
    clear_min_snapshot_created_at_from_store();
    let _ = context
        .app_sync_repository()
        .clear_all_min_snapshot_created_at()
        .await;

    if result.state == SyncState::Ready {
        let _ = context
            .app_sync_repository()
            .reset_and_mark_bootstrap_complete(result.device_id.clone(), result.key_version)
            .await;

        let engine_context = Arc::clone(&context);
        tauri::async_runtime::spawn(async move {
            if let Err(err) = ensure_background_engine_started(engine_context).await {
                log::warn!(
                    "[DeviceSync] Post-reinitialize background engine start failed: {}",
                    err
                );
            }
        });
    }

    Ok(result)
}
