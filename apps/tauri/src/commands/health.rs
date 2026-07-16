use std::sync::Arc;

use crate::context::ServiceContext;
use crate::events::{
    emit_portfolio_trigger_recalculate, MarketSyncResult, PortfolioRequestPayload,
    MARKET_SYNC_COMPLETE, MARKET_SYNC_ERROR, MARKET_SYNC_START,
};
use log::{debug, error, info, warn};
use tauri::{AppHandle, Emitter, State};
use wealthfolio_core::health::{FixAction, HealthConfig, HealthServiceTrait, HealthStatus};
use wealthfolio_core::quotes::{MarketSyncMode, SyncMode};

/// Get current health status (cached or fresh check).
#[tauri::command]
pub async fn get_health_status(
    client_timezone: Option<String>,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<HealthStatus, String> {
    debug!("Getting health status...");

    let health_service = state.health_service();

    // Try to get cached status first
    if let Some(status) = health_service.get_cached_status().await {
        if !status.is_stale {
            return Ok(status);
        }
    }

    // Run fresh checks
    let base_currency = state.get_base_currency();
    run_health_checks_internal(&state, &base_currency, client_timezone.as_deref()).await
}

/// Run health checks and return fresh status.
#[tauri::command]
pub async fn run_health_checks(
    client_timezone: Option<String>,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<HealthStatus, String> {
    debug!("Running health checks...");
    let base_currency = state.get_base_currency();
    run_health_checks_internal(&state, &base_currency, client_timezone.as_deref()).await
}

/// Internal function to run health checks.
async fn run_health_checks_internal(
    state: &State<'_, Arc<ServiceContext>>,
    base_currency: &str,
    client_timezone: Option<&str>,
) -> Result<HealthStatus, String> {
    let configured_timezone = state.get_timezone();
    state
        .health_service()
        .run_full_checks(
            base_currency,
            state.account_service(),
            state.holdings_service(),
            state.quote_service(),
            state.asset_service(),
            state.taxonomy_service(),
            state.valuation_service(),
            state.snapshot_service(),
            state.activity_service(),
            state.lots_repository.clone(),
            Some(configured_timezone.as_str()),
            client_timezone,
        )
        .await
        .map_err(|e| e.to_string())
}

/// Dismiss a health issue.
#[tauri::command]
pub async fn dismiss_health_issue(
    issue_id: String,
    data_hash: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<(), String> {
    debug!("Dismissing health issue: {}", issue_id);
    state
        .health_service()
        .dismiss_issue(&issue_id, &data_hash)
        .await
        .map_err(|e| e.to_string())
}

/// Restore a dismissed health issue.
#[tauri::command]
pub async fn restore_health_issue(
    issue_id: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<(), String> {
    debug!("Restoring health issue: {}", issue_id);
    state
        .health_service()
        .restore_issue(&issue_id)
        .await
        .map_err(|e| e.to_string())
}

/// Get list of dismissed issue IDs.
#[tauri::command]
pub async fn get_dismissed_health_issues(
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Vec<String>, String> {
    debug!("Getting dismissed health issues...");
    state
        .health_service()
        .get_dismissed_ids()
        .await
        .map_err(|e| e.to_string())
}

/// Execute a fix action.
#[tauri::command]
pub async fn execute_health_fix(
    action: FixAction,
    app_handle: AppHandle,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<(), String> {
    debug!("Executing health fix: {} ({})", action.label, action.id);

    // Handle migrate_legacy_classifications action specially since it needs taxonomy service
    if action.id == "migrate_legacy_classifications" {
        // Use the shared migration function from taxonomy module
        crate::commands::taxonomy::run_legacy_migration(&state).await?;
        return Ok(());
    }

    // Handle sync_prices and retry_sync actions - emit market sync events
    if action.id == "sync_prices" || action.id == "retry_sync" {
        let asset_ids: Vec<String> = serde_json::from_value(action.payload.clone())
            .map_err(|e| format!("Failed to parse asset IDs: {}", e))?;
        if asset_ids.is_empty() {
            return Err("No assets selected for price sync".to_string());
        }

        info!(
            "Syncing market data for {} assets: {:?}",
            asset_ids.len(),
            asset_ids
        );

        if let Err(e) = app_handle.emit(MARKET_SYNC_START, &()) {
            error!("Failed to emit market:sync-start event: {}", e);
        }

        let quote_service = state.quote_service();
        match quote_service
            .sync(SyncMode::Incremental, Some(asset_ids))
            .await
        {
            Ok(result) => {
                if !result.failures.is_empty() {
                    let failed_symbols: Vec<_> =
                        result.failures.iter().map(|(s, _)| s.as_str()).collect();
                    warn!("Some assets failed to sync: {:?}", failed_symbols);
                }
                let skipped_reasons = result
                    .skipped_reasons
                    .into_iter()
                    .map(|(asset_id, reason)| (asset_id, reason.to_string()))
                    .collect();
                let result_payload = MarketSyncResult {
                    failed_syncs: result.failures,
                    skipped_reasons,
                    show_skipped_reasons: true,
                };
                if let Err(e) = app_handle.emit(MARKET_SYNC_COMPLETE, &result_payload) {
                    error!("Failed to emit market:sync-complete event: {}", e);
                }
            }
            Err(e) => {
                if let Err(e_emit) = app_handle.emit(MARKET_SYNC_ERROR, &e.to_string()) {
                    error!("Failed to emit market:sync-error event: {}", e_emit);
                }
                return Err(format!("Failed to sync market data: {}", e));
            }
        }

        // Clear health cache so next check reflects the sync results
        state.health_service().clear_cache().await;

        return Ok(());
    }

    // Handle rebuild_account_history - trigger an account-scoped full recalculation
    // by reusing the existing portfolio recalculation pipeline (which maps the
    // recalculate trigger to SnapshotRecalcMode::Full for the given accounts).
    if action.id == "rebuild_account_history" {
        let account_ids: Vec<String> = serde_json::from_value(action.payload.clone())
            .map_err(|e| format!("Failed to parse account IDs: {}", e))?;
        if account_ids.is_empty() {
            return Err("No accounts selected for history rebuild".to_string());
        }

        info!(
            "Rebuilding account history for {} account(s): {:?}",
            account_ids.len(),
            account_ids
        );

        // Incremental market sync (prices/valuations were already fixed by the
        // user); the recalculate trigger performs the full snapshot rebuild.
        let payload = PortfolioRequestPayload::builder()
            .account_ids(Some(account_ids))
            .market_sync_mode(MarketSyncMode::Incremental { asset_ids: None })
            .build();
        emit_portfolio_trigger_recalculate(&app_handle, payload);

        return Ok(());
    }

    state
        .health_service()
        .execute_fix(&action)
        .await
        .map_err(|e| e.to_string())
}

/// Get health configuration.
#[tauri::command]
pub async fn get_health_config(
    state: State<'_, Arc<ServiceContext>>,
) -> Result<HealthConfig, String> {
    debug!("Getting health config...");
    Ok(state.health_service().get_config().await)
}

/// Update health configuration.
#[tauri::command]
pub async fn update_health_config(
    config: HealthConfig,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<(), String> {
    debug!("Updating health config...");
    state
        .health_service()
        .update_config(config)
        .await
        .map_err(|e| e.to_string())
}
