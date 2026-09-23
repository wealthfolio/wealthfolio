//! Tauri adapter for the profile's restore operation.
//!
//! The shared runtime owns the operation; these ports only map its needs to the
//! existing repository, backup, portfolio and Connect services.

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use log::{info, warn};
use tauri::AppHandle;
use wealthfolio_core::quotes::MarketSyncMode;
use wealthfolio_device_sync::engine::{
    RestoreFile, RestoreOperation, RestorePorts, StartRestore, TransportError,
};
use wealthfolio_device_sync::{SnapshotDownloadHeaders, SnapshotLatestResponse};
use wealthfolio_storage_sqlite::db;

use super::engine::{
    ensure_background_engine_started, run_sync_cycle, transport_err_from_sync,
    transport_err_permanent, RestoreHost, TauriEnginePorts,
};
use super::{
    clear_min_snapshot_created_at_from_store, create_client, get_access_token,
    get_device_id_from_store, get_min_snapshot_created_at_from_store,
    is_pairing_already_confirmed_error, set_min_snapshot_created_at_in_store,
};
use crate::context::ServiceContext;
use crate::events::{emit_portfolio_trigger_recalculate, PortfolioRequestPayload};
use crate::profiles::ConnectAccess;

const DEVICE_SYNC_RESTORE_EVENT: &str = "device-sync:restore-operation";

impl TauriEnginePorts {
    fn host(&self) -> Result<&RestoreHost, String> {
        self.restore_host
            .as_ref()
            .ok_or_else(|| "Restore services are unavailable.".to_string())
    }
}

#[async_trait]
impl RestorePorts for TauriEnginePorts {
    async fn get_latest_snapshot(
        &self,
        token: &str,
        device_id: &str,
    ) -> Result<Option<SnapshotLatestResponse>, TransportError> {
        match create_client()
            .map_err(transport_err_permanent)?
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
    ) -> Result<Option<(SnapshotDownloadHeaders, Vec<u8>)>, TransportError> {
        match create_client()
            .map_err(transport_err_permanent)?
            .download_snapshot(token, device_id, snapshot_id)
            .await
        {
            Ok(snapshot) => Ok(Some(snapshot)),
            Err(err) if err.status_code() == Some(404) => Ok(None),
            Err(err) => Err(transport_err_from_sync(err)),
        }
    }

    fn needs_bootstrap(&self, device_id: &str) -> Result<bool, String> {
        self.context
            .app_sync_repository()
            .needs_bootstrap(device_id)
            .map_err(|e| e.to_string())
    }

    fn last_cycle_status(&self) -> Result<Option<String>, String> {
        self.context
            .app_sync_repository()
            .get_engine_status()
            .map(|status| status.last_cycle_status)
            .map_err(|e| e.to_string())
    }

    fn freshness_gate(&self, device_id: &str) -> Option<String> {
        // In memory first, then SQLite, which survives restarts.
        get_min_snapshot_created_at_from_store(&self.context, device_id).or_else(|| {
            self.context
                .app_sync_repository()
                .get_min_snapshot_created_at(device_id)
                .ok()
                .flatten()
        })
    }

    async fn clear_freshness_gate(&self, device_id: &str) {
        clear_min_snapshot_created_at_from_store(&self.context);
        if let Err(err) = self
            .context
            .app_sync_repository()
            .clear_min_snapshot_created_at(device_id.to_string())
            .await
        {
            warn!("[DeviceSync] Failed to clear freshness gate: {}", err);
        }
    }

    fn local_rows(&self) -> Result<i64, String> {
        self.context
            .app_sync_repository()
            .get_local_sync_overwrite_risk_summary()
            .map(|summary| summary.total_rows)
            .map_err(|e| e.to_string())
    }

    async fn mark_restore_not_needed(
        &self,
        device_id: &str,
        key_version: Option<i32>,
    ) -> Result<(), String> {
        self.context
            .app_sync_repository()
            .reset_and_mark_bootstrap_complete(device_id.to_string(), key_version)
            .await
            .map_err(|e| e.to_string())
    }

    fn scratch_dir(&self) -> Result<PathBuf, String> {
        db::profile_scratch_dir(&self.context.data_root.to_string_lossy())
            .map_err(|e| format!("Failed to prepare snapshot scratch directory: {e}"))
    }

    async fn backup_before_restore(&self) -> Result<(), String> {
        let runtime = &self.host()?.runtime;
        let access = runtime.access()?;
        let app_data_dir = runtime.app_data_dir().to_string();
        tokio::task::spawn_blocking(move || db::backup_database(&access, &app_data_dir))
            .await
            .map_err(|e| format!("Backup task failed: {e}"))?
            .map_err(|e| e.to_string())?;
        info!("[DeviceSync] Backup saved before restore");
        Ok(())
    }

    async fn replace_local_data(&self, snapshot: RestoreFile<'_>) -> Result<(), String> {
        self.context
            .app_sync_repository()
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
            if let Err(error) = run_sync_cycle(Arc::clone(&self.context), true).await {
                warn!("[DeviceSync] Post-restore sync cycle failed: {}", error);
            }
        }
        ensure_background_engine_started(Arc::clone(&self.context)).await
    }

    fn refresh_portfolio(&self) {
        if let Ok(host) = self.host() {
            emit_portfolio_trigger_recalculate(
                &host.handle,
                PortfolioRequestPayload::builder()
                    .account_ids(None)
                    .market_sync_mode(MarketSyncMode::Incremental { asset_ids: None })
                    .build(),
                &self.context,
            );
        }
    }

    fn publish_restore(&self, operation: &RestoreOperation) {
        if let Ok(host) = self.host() {
            if let Err(err) = crate::events::emit_for_profile(
                &host.handle,
                &self.context,
                DEVICE_SYNC_RESTORE_EVENT,
                operation.clone(),
            ) {
                warn!("[DeviceSync] Failed to publish restore state: {}", err);
            }
        }
    }
}

pub(super) fn restore_ports(
    context: &Arc<ServiceContext>,
    handle: AppHandle,
    state: &ConnectAccess,
) -> Arc<TauriEnginePorts> {
    Arc::new(TauriEnginePorts::for_restore(
        Arc::clone(context),
        handle,
        Arc::clone(&state.0),
    ))
}

/// Receiving device: confirm pairing, record the freshness gate, then hand
/// restoration to the profile's restore operation.
pub(super) async fn begin_pairing_restore(
    pairing_id: String,
    proof: String,
    min_snapshot_created_at: Option<String>,
    handle: AppHandle,
    state: ConnectAccess,
) -> Result<RestoreOperation, String> {
    let context = state.context()?;
    let device_id =
        get_device_id_from_store(&context).ok_or_else(|| "No device ID configured".to_string())?;
    let token = get_access_token(&context).await?;
    match create_client()?
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
            info!("[DeviceSync] Pairing already confirmed, continuing");
        }
        Err(err) => return Err(err.to_string()),
    }

    if let Some(min_created_at) = min_snapshot_created_at.as_deref() {
        let within_limit = wealthfolio_device_sync::parse_sync_datetime_to_utc(min_created_at)
            .is_ok_and(|parsed| parsed <= chrono::Utc::now() + chrono::Duration::minutes(10));
        match wealthfolio_device_sync::normalize_sync_datetime(min_created_at) {
            Ok(normalized) if within_limit => {
                set_min_snapshot_created_at_in_store(&context, &device_id, &normalized);
                if let Err(err) = context
                    .app_sync_repository()
                    .set_min_snapshot_created_at(device_id.clone(), normalized)
                    .await
                {
                    warn!("[DeviceSync] Failed to persist freshness gate: {}", err);
                }
            }
            _ => warn!("[DeviceSync] Ignoring invalid pairing freshness gate"),
        }
    }

    let ports = restore_ports(&context, handle, &state);
    context
        .device_sync_runtime()
        .start_restore(ports, StartRestore::Pairing)
        .await?
        .ok_or_else(|| "Setup could not start.".to_string())
}
