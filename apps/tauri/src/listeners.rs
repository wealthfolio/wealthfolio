use futures::future::join_all;
use log::{error, info, warn};
use std::sync::Arc;
use std::time::Instant;
use tauri::{async_runtime::spawn, AppHandle, Emitter, Listener, Manager};
use wealthfolio_core::health::HealthServiceTrait;
use wealthfolio_core::portfolio::snapshot::{
    reconcile_quote_sync_from_latest_account_snapshots, SnapshotRecalcMode,
};
use wealthfolio_core::portfolio::valuation::ValuationRecalcMode;
use wealthfolio_core::quotes::MarketSyncMode;

use crate::context::ServiceContext;
use crate::events::{
    emit_portfolio_trigger_recalculate, emit_portfolio_trigger_update, MarketSyncResult,
    PortfolioRequestPayload, MARKET_SYNC_COMPLETE, MARKET_SYNC_ERROR, MARKET_SYNC_START,
    PORTFOLIO_TRIGGER_RECALCULATE, PORTFOLIO_TRIGGER_UPDATE, PORTFOLIO_UPDATE_COMPLETE,
    PORTFOLIO_UPDATE_ERROR, PORTFOLIO_UPDATE_START,
};

/// Sets up the global event listeners for the application.
pub fn setup_event_listeners(handle: AppHandle) {
    // Listener for consolidated portfolio update requests
    let update_handle = handle.clone();
    handle.listen(PORTFOLIO_TRIGGER_UPDATE, move |event| {
        handle_portfolio_request(update_handle.clone(), event.payload(), false);
    });

    // Listener for full portfolio recalculation requests
    let recalc_handle = handle.clone();
    handle.listen(PORTFOLIO_TRIGGER_RECALCULATE, move |event| {
        handle_portfolio_request(recalc_handle.clone(), event.payload(), true);
    });
}

fn resolve_listener_account_ids(
    context: &Arc<ServiceContext>,
    account_ids: Option<&Vec<String>>,
) -> Result<Vec<String>, wealthfolio_core::Error> {
    if let Some(target_ids) = account_ids {
        return Ok(target_ids.clone());
    }

    Ok(context
        .account_service()
        .get_non_archived_accounts()?
        .into_iter()
        .map(|account| account.id)
        .collect())
}

/// Handles the common logic for both portfolio update and recalculation requests.
fn handle_portfolio_request(handle: AppHandle, payload_str: &str, force_recalc: bool) {
    let event_name = if force_recalc {
        PORTFOLIO_TRIGGER_RECALCULATE
    } else {
        PORTFOLIO_TRIGGER_UPDATE
    };

    match serde_json::from_str::<PortfolioRequestPayload>(payload_str) {
        Ok(payload) => {
            let handle_clone = handle.clone(); // Clone handle for async block

            // Spawn a task to handle the update/recalculate steps
            spawn(async move {
                let market_sync_mode = payload.market_sync_mode.clone();
                let accounts_to_recalc = payload.account_ids.clone();
                let context_result = handle_clone.try_state::<Arc<ServiceContext>>();

                if let Some(context) = context_result {
                    // Only perform market sync if the mode requires it
                    if market_sync_mode.requires_sync() {
                        let market_data_service = context.quote_service();
                        let snapshot_service = context.snapshot_service();
                        let account_ids_for_sync = resolve_listener_account_ids(&context, None)
                            .unwrap_or_else(|err| {
                                warn!(
                                    "Failed to resolve accounts for quote sync reconciliation: {}",
                                    err
                                );
                                Vec::new()
                            });

                        if let Err(e) = reconcile_quote_sync_from_latest_account_snapshots(
                            snapshot_service.as_ref(),
                            market_data_service.as_ref(),
                            &account_ids_for_sync,
                        )
                        .await
                        {
                            warn!(
                                "Failed to reconcile quote sync state from latest holdings: {}. Quote sync planning may be affected.",
                                e
                            );
                        }

                        // Emit sync start event
                        if let Err(e) = handle_clone.emit(MARKET_SYNC_START, &()) {
                            error!("Failed to emit market:sync-start event: {}", e);
                        }

                        let sync_start = Instant::now();
                        let asset_ids = market_sync_mode.asset_ids().cloned();

                        // Convert MarketSyncMode to SyncMode for the quote service
                        let sync_result = match market_sync_mode.to_sync_mode() {
                            Some(sync_mode) => market_data_service.sync(sync_mode, asset_ids).await,
                            None => {
                                // This shouldn't happen since we checked requires_sync()
                                warn!(
                                    "MarketSyncMode requires sync but returned None for SyncMode"
                                );
                                Ok(wealthfolio_core::quotes::SyncResult::default())
                            }
                        };

                        let sync_duration = sync_start.elapsed();
                        info!("Market data sync completed in: {:?}", sync_duration);

                        match sync_result {
                            Ok(result) => {
                                // Convert SyncResult to legacy format for backwards compatibility
                                let failed_syncs = result.failures;
                                let skipped_reasons = result
                                    .skipped_reasons
                                    .into_iter()
                                    .map(|(asset_id, reason)| (asset_id, reason.to_string()))
                                    .collect();

                                let health_service = context.health_service();
                                let health_clone = health_service.clone();
                                spawn(async move {
                                    health_clone.clear_cache().await;
                                });

                                let result_payload = MarketSyncResult {
                                    failed_syncs,
                                    skipped_reasons,
                                    show_skipped_reasons: false,
                                };
                                if let Err(e) =
                                    handle_clone.emit(MARKET_SYNC_COMPLETE, &result_payload)
                                {
                                    error!("Failed to emit market:sync-complete event: {}", e);
                                }
                                // Initialize the FxService after successful sync
                                let fx_service = context.fx_service();
                                if let Err(e) = fx_service.initialize() {
                                    error!(
                                        "Failed to initialize FxService after market data sync: {}",
                                        e
                                    );
                                }

                                // Trigger calculation after successful sync
                                let snap_mode = if force_recalc {
                                    SnapshotRecalcMode::Full
                                } else {
                                    SnapshotRecalcMode::IncrementalFromLast
                                };
                                let val_mode = if force_recalc {
                                    ValuationRecalcMode::Full
                                } else {
                                    ValuationRecalcMode::IncrementalFromLast
                                };
                                handle_portfolio_calculation(
                                    handle_clone.clone(),
                                    accounts_to_recalc,
                                    snap_mode,
                                    val_mode,
                                );
                            }
                            Err(e) => {
                                if let Err(e_emit) =
                                    handle_clone.emit(MARKET_SYNC_ERROR, &e.to_string())
                                {
                                    error!("Failed to emit market:sync-error event: {}", e_emit);
                                }
                                error!("Market data sync failed: {}. Skipping portfolio calculation for this request.", e);
                            }
                        }
                    } else {
                        // MarketSyncMode::None - skip market sync, just recalculate
                        info!("Skipping market sync (MarketSyncMode::None)");
                        let snap_mode = if force_recalc {
                            SnapshotRecalcMode::Full
                        } else {
                            SnapshotRecalcMode::IncrementalFromLast
                        };
                        let val_mode = if force_recalc {
                            ValuationRecalcMode::Full
                        } else {
                            ValuationRecalcMode::IncrementalFromLast
                        };
                        handle_portfolio_calculation(
                            handle_clone.clone(),
                            accounts_to_recalc,
                            snap_mode,
                            val_mode,
                        );
                    }
                } else {
                    error!(
                        "ServiceContext not found in state during market data sync for {} request.",
                        event_name
                    );
                }
            });
        }
        Err(e) => {
            error!(
                "Failed to parse payload for {}: {}. Triggering default action.",
                event_name, e
            );
            // Trigger a default action if payload parsing fails - use MarketSyncMode::None
            let fallback_payload = PortfolioRequestPayload::builder()
                .account_ids(None)
                .market_sync_mode(MarketSyncMode::None)
                .build();
            if force_recalc {
                emit_portfolio_trigger_recalculate(&handle, fallback_payload);
            } else {
                emit_portfolio_trigger_update(&handle, fallback_payload);
            }
        }
    }
}

// This function handles the portfolio snapshot and history calculation logic
fn handle_portfolio_calculation(
    app_handle: AppHandle,
    account_ids_input: Option<Vec<String>>,
    snapshot_mode: SnapshotRecalcMode,
    valuation_mode: ValuationRecalcMode,
) {
    if let Err(e) = app_handle.emit(PORTFOLIO_UPDATE_START, ()) {
        error!("Failed to emit {} event: {}", PORTFOLIO_UPDATE_START, e);
    }

    spawn(async move {
        let context = match app_handle.try_state::<Arc<ServiceContext>>() {
            Some(ctx) => ctx,
            None => {
                let err_msg =
                    "ServiceContext not found in state when triggering portfolio calculation.";
                error!("{}", err_msg);
                if let Err(e_emit) = app_handle.emit(PORTFOLIO_UPDATE_ERROR, err_msg) {
                    error!(
                        "Failed to emit {} event: {}",
                        PORTFOLIO_UPDATE_ERROR, e_emit
                    );
                }
                return;
            }
        };

        let account_service = context.account_service();
        let snapshot_service = context.snapshot_service();
        let valuation_service = context.valuation_service();

        // Step 0: Resolve account scope. Specific requests are processed as-is;
        // full recalculations rebuild every non-archived account, including closed accounts.
        let account_ids: Vec<String> = if let Some(target_ids) = account_ids_input {
            target_ids
        } else {
            match account_service.get_non_archived_accounts() {
                Ok(accounts) => accounts.into_iter().map(|a| a.id).collect(),
                Err(e) => {
                    let err_msg = format!("Failed to list non-archived accounts: {}", e);
                    error!("{}", err_msg);
                    if let Err(e_emit) = app_handle.emit(PORTFOLIO_UPDATE_ERROR, &err_msg) {
                        error!(
                            "Failed to emit {} event: {}",
                            PORTFOLIO_UPDATE_ERROR, e_emit
                        );
                    }
                    return;
                }
            }
        };

        // --- Step 1: Calculate Account-Specific Snapshots ---
        if !account_ids.is_empty() {
            let account_snapshot_result = snapshot_service
                .recalculate_holdings_snapshots(Some(account_ids.as_slice()), snapshot_mode.clone())
                .await;

            if let Err(e) = account_snapshot_result {
                let err_msg = format!(
                    "calculate_holdings_snapshots for targeted accounts failed: {}",
                    e
                );
                error!("{}", err_msg);
                if let Err(e_emit) = app_handle.emit(PORTFOLIO_UPDATE_ERROR, &err_msg) {
                    error!(
                        "Failed to emit {} event: {}",
                        PORTFOLIO_UPDATE_ERROR, e_emit
                    );
                }
            }
        }

        // --- Step 2: Update position status from latest real-account snapshots ---
        let quote_service = context.quote_service();
        let quote_reconciliation_account_ids = resolve_listener_account_ids(&context, None)
            .unwrap_or_else(|err| {
                warn!(
                    "Failed to resolve accounts for quote sync reconciliation: {}",
                    err
                );
                Vec::new()
            });
        if let Err(e) = reconcile_quote_sync_from_latest_account_snapshots(
            snapshot_service.as_ref(),
            quote_service.as_ref(),
            &quote_reconciliation_account_ids,
        )
        .await
        {
            warn!(
                "Failed to update position status from holdings: {}. Quote sync planning may be affected.",
                e
            );
        }

        // --- Step 3: Calculate Valuation History ---
        let accounts_for_valuation = account_ids;

        if !accounts_for_valuation.is_empty() {
            let history_futures = accounts_for_valuation.iter().map(|account_id| {
                let valuation_service_clone = valuation_service.clone();
                let account_id_clone = account_id.clone();
                let valuation_mode_clone = valuation_mode.clone();
                async move {
                    let result = valuation_service_clone
                        .calculate_valuation_history(&account_id_clone, valuation_mode_clone)
                        .await;
                    (account_id_clone, result)
                }
            });

            let history_results = join_all(history_futures).await;

            let mut history_errors: Vec<String> = Vec::new();
            for (account_id, result) in history_results {
                if let Err(e) = result {
                    let err_detail = format!("Account '{}': {}", account_id, e);
                    error!("Failed to calculate valuation history: {}", err_detail);
                    history_errors.push(err_detail);
                }
            }

            if !history_errors.is_empty() {
                error!(
                    "Valuation history calculation completed with errors: {}",
                    history_errors.join("; ")
                );
            }
        }

        context.health_service().clear_cache().await;

        if let Err(e) = app_handle.emit(PORTFOLIO_UPDATE_COMPLETE, ()) {
            error!("Failed to emit {} event: {}", PORTFOLIO_UPDATE_COMPLETE, e);
        }
    });
}
