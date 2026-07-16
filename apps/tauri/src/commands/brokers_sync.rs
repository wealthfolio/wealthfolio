//! Commands for syncing broker data from the cloud API.

use log::{debug, error, info};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

use crate::context::ServiceContext;
use crate::events::{BROKER_SYNC_COMPLETE, BROKER_SYNC_ERROR, BROKER_SYNC_START};
use wealthfolio_connect::{
    acquire_broker_sync_guard, broker::BrokerApiClient, fetch_subscription_plans_public,
    BrokerAccount, BrokerConnection, BrokerSyncRunGuard, PlansResponse, Platform, SyncConfig,
    SyncOrchestrator, SyncProgressPayload, SyncProgressReporter, SyncResult, UserInfo,
};

pub(crate) fn try_acquire_broker_sync_guard(
    context: &ServiceContext,
) -> Option<BrokerSyncRunGuard> {
    acquire_broker_sync_guard(&context.broker_sync_running())
}

pub(crate) fn emit_broker_sync_error(app_handle: &AppHandle, error_message: &str) {
    app_handle
        .emit(
            BROKER_SYNC_ERROR,
            serde_json::json!({ "error": error_message }),
        )
        .unwrap_or_else(|e| {
            error!("Failed to emit broker:sync-error event: {}", e);
        });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri Progress Reporter
// ─────────────────────────────────────────────────────────────────────────────

/// Progress reporter that emits Tauri events.
struct TauriProgressReporter {
    app_handle: AppHandle,
}

impl TauriProgressReporter {
    fn new(app_handle: AppHandle) -> Self {
        Self { app_handle }
    }
}

impl SyncProgressReporter for TauriProgressReporter {
    fn report_progress(&self, payload: SyncProgressPayload) {
        if let Err(e) = self.app_handle.emit("sync-progress", &payload) {
            debug!("Failed to emit sync-progress event: {}", e);
        }
    }

    fn report_sync_start(&self) {
        self.app_handle
            .emit(BROKER_SYNC_START, ())
            .unwrap_or_else(|e| {
                error!("Failed to emit broker:sync-start event: {}", e);
            });
    }

    fn report_sync_complete(&self, result: &SyncResult) {
        if result.success {
            self.app_handle
                .emit(BROKER_SYNC_COMPLETE, result)
                .unwrap_or_else(|e| {
                    error!("Failed to emit broker:sync-complete event: {}", e);
                });
        } else {
            emit_broker_sync_error(&self.app_handle, &result.message);
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Broker Sync Commands
// ─────────────────────────────────────────────────────────────────────────────

/// Sync broker data from the cloud API (non-blocking with SSE events).
/// Returns immediately after triggering the sync. Results are delivered via events:
/// - `broker:sync-start` - emitted when sync begins
/// - `broker:sync-complete` - emitted with SyncResult payload on success
/// - `broker:sync-error` - emitted with error message on failure
#[tauri::command]
pub async fn sync_broker_data(
    app: AppHandle,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<(), String> {
    // Check plan entitlement before starting sync
    match state.connect_service().has_broker_sync().await {
        Ok(true) => {}
        Ok(false) => {
            info!("[Connect] Broker sync skipped: plan does not include broker sync");
            return Err("Plan does not include broker sync".to_string());
        }
        Err(e) => {
            return Err(format!("Could not verify broker sync entitlement: {}", e));
        }
    }

    let Some(guard) = try_acquire_broker_sync_guard(state.inner().as_ref()) else {
        info!("[Connect] Broker sync skipped: sync already running");
        return Err("Broker sync already running".to_string());
    };

    info!("[Connect] Starting broker data sync ...");

    // Clone what we need for the spawned task
    let context = state.inner().clone();
    let app_handle = app.clone();

    // Spawn background task
    tauri::async_runtime::spawn(async move {
        match perform_broker_sync_with_guard(&context, Some(&app_handle), guard).await {
            Ok(_result) => {
                info!("[Connect] Broker sync completed successfully");
                // Events are emitted by the orchestrator via TauriProgressReporter
            }
            Err(err) => {
                error!("[Connect] Broker sync failed: {}", err);
                // Error event also emitted by orchestrator
            }
        }
    });

    Ok(())
}

/// Alias for `sync_broker_data` using explicit broker-ingest vocabulary.
#[tauri::command]
pub async fn broker_ingest_run(
    app: AppHandle,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<(), String> {
    sync_broker_data(app, state).await
}

/// Core broker sync logic that can be called from Tauri command or scheduler.
///
/// This function is public so the scheduler can call it directly.
/// FX rate registration is handled automatically by AccountService during account creation.
///
/// # Arguments
///
/// * `context` - Service context
/// * `app` - Optional AppHandle for progress reporting. If None, progress events are not emitted.
pub async fn perform_broker_sync(
    context: &Arc<ServiceContext>,
    app: Option<&AppHandle>,
) -> Result<SyncResult, String> {
    let guard = try_acquire_broker_sync_guard(context)
        .ok_or_else(|| "Broker sync already running".to_string())?;
    perform_broker_sync_with_guard(context, app, guard).await
}

pub(crate) async fn perform_broker_sync_with_guard(
    context: &Arc<ServiceContext>,
    app: Option<&AppHandle>,
    _guard: BrokerSyncRunGuard,
) -> Result<SyncResult, String> {
    info!("Starting broker data sync...");

    let client = match context.connect_service().get_api_client().await {
        Ok(client) => client,
        Err(err) => {
            if let Some(app_handle) = app {
                emit_broker_sync_error(app_handle, &err);
            }
            return Err(err);
        }
    };

    // Create progress reporter and orchestrator
    // Use TauriProgressReporter if we have an AppHandle, otherwise use NoOp
    if let Some(app_handle) = app {
        let reporter = Arc::new(TauriProgressReporter::new(app_handle.clone()));
        let orchestrator =
            SyncOrchestrator::new(context.sync_service(), reporter, SyncConfig::default());
        orchestrator.sync_all(&client).await
    } else {
        let reporter = Arc::new(wealthfolio_connect::NoOpProgressReporter);
        let orchestrator =
            SyncOrchestrator::new(context.sync_service(), reporter, SyncConfig::default());
        orchestrator.sync_all(&client).await
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Account and Platform Queries
// ─────────────────────────────────────────────────────────────────────────────

/// Get all synced accounts
#[tauri::command]
pub async fn get_synced_accounts(
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Vec<wealthfolio_core::accounts::Account>, String> {
    state
        .sync_service()
        .get_synced_accounts()
        .map_err(|e| format!("Failed to get synced accounts: {}", e))
}

/// Get all platforms
#[tauri::command]
pub async fn get_platforms(state: State<'_, Arc<ServiceContext>>) -> Result<Vec<Platform>, String> {
    state
        .sync_service()
        .get_platforms()
        .map_err(|e| format!("Failed to get platforms: {}", e))
}

// ─────────────────────────────────────────────────────────────────────────────
// Broker Connection Management Commands
// ─────────────────────────────────────────────────────────────────────────────

/// List broker connections from the cloud API
#[tauri::command]
pub async fn list_broker_connections(
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Vec<BrokerConnection>, String> {
    debug!("Fetching broker connections from cloud API...");

    let client = state.connect_service().get_api_client().await?;
    let connections = client.list_connections().await.map_err(|e| e.to_string())?;

    Ok(connections)
}

/// List broker accounts from the cloud API
/// Returns the live account data including sync_enabled and owner info
#[tauri::command]
pub async fn list_broker_accounts(
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Vec<BrokerAccount>, String> {
    debug!("Fetching broker accounts from cloud API...");

    let client = state.connect_service().get_api_client().await?;
    let accounts = client
        .list_accounts(None)
        .await
        .map_err(|e| e.to_string())?;

    Ok(accounts)
}

// ─────────────────────────────────────────────────────────────────────────────
// User & Subscription Commands
// ─────────────────────────────────────────────────────────────────────────────

/// Get subscription plans from the cloud API (requires authentication)
#[tauri::command]
pub async fn get_subscription_plans(
    state: State<'_, Arc<ServiceContext>>,
) -> Result<PlansResponse, String> {
    debug!("Fetching subscription plans from cloud API...");

    let client = state.connect_service().get_api_client().await?;
    match client.get_subscription_plans().await {
        Ok(response) => Ok(response),
        Err(e) => {
            error!("Failed to get subscription plans: {}", e);
            Err(e.to_string())
        }
    }
}

/// Get subscription plans from the cloud API (public, no authentication required)
#[tauri::command]
pub async fn get_subscription_plans_public() -> Result<PlansResponse, String> {
    debug!("Fetching subscription plans from cloud API (public)...");

    let base_url = crate::services::cloud_api_base_url().ok_or_else(|| {
        "Cloud API base URL is unavailable. Connect API operations are disabled.".to_string()
    })?;

    match fetch_subscription_plans_public(&base_url).await {
        Ok(response) => {
            debug!("Found {} subscription plans (public)", response.plans.len());
            Ok(response)
        }
        Err(e) => {
            error!("Failed to get subscription plans (public): {}", e);
            Err(e.to_string())
        }
    }
}

/// Get current user info from the cloud API
#[tauri::command]
pub async fn get_user_info(state: State<'_, Arc<ServiceContext>>) -> Result<UserInfo, String> {
    debug!("Fetching user info from cloud API...");

    let client = state.connect_service().get_api_client().await?;
    match client.get_user_info().await {
        Ok(user_info) => Ok(user_info),
        Err(e) => {
            error!("Failed to get user info: {}", e);
            Err(e.to_string())
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sync State and Import Run Commands
// ─────────────────────────────────────────────────────────────────────────────

/// Get all broker sync states
#[tauri::command]
pub async fn get_broker_sync_states(
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Vec<wealthfolio_connect::BrokerSyncState>, String> {
    debug!("Fetching all broker sync states...");
    state
        .sync_service()
        .get_all_sync_states()
        .map_err(|e| format!("Failed to get broker sync states: {}", e))
}

/// Alias for `get_broker_sync_states` using explicit broker-ingest vocabulary.
#[tauri::command]
pub async fn get_broker_ingest_states(
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Vec<wealthfolio_connect::BrokerSyncState>, String> {
    get_broker_sync_states(state).await
}

/// Get import runs with optional type filter and pagination
#[tauri::command]
pub async fn get_import_runs(
    run_type: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Vec<wealthfolio_connect::ImportRun>, String> {
    let limit = limit.unwrap_or(50);
    let offset = offset.unwrap_or(0);
    debug!(
        "Fetching import runs (type={:?}, limit={}, offset={})...",
        run_type, limit, offset
    );
    state
        .sync_service()
        .get_import_runs(run_type.as_deref(), limit, offset)
        .map_err(|e| format!("Failed to get import runs: {}", e))
}

/// Alias for `get_import_runs` using neutral terminology, because runs include
/// both broker ingest and manual CSV import operations.
#[tauri::command]
pub async fn get_data_import_runs(
    run_type: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Vec<wealthfolio_connect::ImportRun>, String> {
    get_import_runs(run_type, limit, offset, state).await
}

// ─────────────────────────────────────────────────────────────────────────────
// Broker Sync Profile Commands
// ─────────────────────────────────────────────────────────────────────────────

/// Get broker sync profile (rules learned from sync)
#[tauri::command]
pub async fn get_broker_sync_profile(
    account_id: String,
    source_system: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<wealthfolio_core::activities::BrokerSyncProfileData, String> {
    log::debug!(
        "Getting broker sync profile for account: {}, source: {}",
        account_id,
        source_system
    );
    state
        .activity_service()
        .get_broker_sync_profile(account_id, source_system)
        .map_err(|e| e.to_string())
}

/// Save broker sync profile rules (learned corrections)
#[tauri::command]
pub async fn save_broker_sync_profile_rules(
    request: wealthfolio_core::activities::SaveBrokerSyncProfileRulesRequest,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<wealthfolio_core::activities::BrokerSyncProfileData, String> {
    log::debug!(
        "Saving broker sync profile rules for account: {}, source: {}",
        request.account_id,
        request.source_system
    );
    state
        .activity_service()
        .save_broker_sync_profile_rules(request)
        .await
        .map_err(|e| e.to_string())
}

// ─────────────────────────────────────────────────────────────────────────────
// Foreground Sync Command
// ─────────────────────────────────────────────────────────────────────────────
