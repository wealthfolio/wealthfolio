//! Event queue worker that processes domain events with debouncing.
//!
//! Receives events via an mpsc channel, debounces them within a 500ms window,
//! and then processes the batch to trigger platform-specific actions.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use log::{debug, error, info, warn};
use rust_decimal::prelude::ToPrimitive;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use wealthfolio_core::events::DomainEvent;
use wealthfolio_core::health::HealthServiceTrait;
use wealthfolio_core::portfolio::snapshot::{
    reconcile_quote_sync_from_latest_account_snapshots, SnapshotRecalcMode,
};
use wealthfolio_core::portfolio::valuation::{CurrentAccountValuationService, ValuationRecalcMode};
use wealthfolio_core::utils::time_utils::{parse_user_timezone_or_default, user_today};

#[cfg(feature = "connect-sync")]
use super::planner::plan_broker_sync;
use super::planner::{
    plan_asset_classification_change, plan_asset_enrichment, plan_categorization_job,
    plan_portfolio_job,
};
#[cfg(feature = "connect-sync")]
use crate::commands::brokers_sync::perform_broker_sync;
use crate::context::ServiceContext;
use crate::events::{
    MarketSyncResult, PortfolioRequestPayload, ASSET_CLASSIFICATIONS_CHANGED,
    ASSET_ENRICHMENT_COMPLETE, ASSET_ENRICHMENT_PROGRESS, ASSET_ENRICHMENT_START,
    MARKET_SYNC_COMPLETE, MARKET_SYNC_ERROR, MARKET_SYNC_START, PORTFOLIO_UPDATE_COMPLETE,
    PORTFOLIO_UPDATE_ERROR, PORTFOLIO_UPDATE_START,
};

/// Debounce window duration in milliseconds.
const DEBOUNCE_MS: u64 = 1000;

/// Runs the event queue worker that processes domain events with debouncing.
///
/// This function:
/// 1. Receives events from the mpsc channel
/// 2. Collects events until a 500ms debounce window expires
/// 3. Processes the batch of events by calling planner functions
/// 4. Triggers appropriate actions (portfolio recalc, enrichment, broker sync)
///
/// Uses an `is_processing` guard to prevent new batches from being processed
/// while a previous batch (e.g., broker sync or portfolio recalc) is still running.
pub async fn event_queue_worker(
    mut receiver: mpsc::UnboundedReceiver<DomainEvent>,
    app_handle: AppHandle,
    context: Arc<ServiceContext>,
) {
    let debounce_duration = Duration::from_millis(DEBOUNCE_MS);
    let mut event_buffer: Vec<DomainEvent> = Vec::new();
    let is_processing = Arc::new(AtomicBool::new(false));

    loop {
        // If buffer is empty, wait indefinitely for the first event
        // If buffer has events, wait with a timeout for more events
        let maybe_event = if event_buffer.is_empty() {
            // Wait indefinitely for the first event
            receiver.recv().await
        } else {
            // Wait for more events or timeout
            tokio::select! {
                event = receiver.recv() => event,
                _ = tokio::time::sleep(debounce_duration) => None,
            }
        };

        match maybe_event {
            Some(event) => {
                // Add event to buffer and continue collecting
                event_buffer.push(event);
            }
            None if !event_buffer.is_empty() => {
                // Timeout expired or channel closed with events in buffer
                // Check if we're still processing a previous batch
                if is_processing.load(Ordering::SeqCst) {
                    // Still processing, keep collecting events
                    debug!("Debounce expired but previous batch still processing, continuing to collect events");
                    continue;
                }

                // Process the batch
                let events = std::mem::take(&mut event_buffer);
                is_processing.store(true, Ordering::SeqCst);
                process_event_batch(&events, &app_handle, &context).await;
                is_processing.store(false, Ordering::SeqCst);
            }
            None => {
                // Channel closed and buffer is empty - exit the worker
                // Wait for any in-progress processing to complete
                while is_processing.load(Ordering::SeqCst) {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                info!("Domain event queue worker shutting down");
                break;
            }
        }
    }
}

/// Processes a batch of domain events by planning and triggering actions.
///
/// Enrichment runs FIRST (awaited) so that bond metadata, instrument type, etc.
/// are available before the portfolio job tries to sync quotes and calculate
/// snapshots. This matches the server queue_worker ordering.
async fn process_event_batch(
    events: &[DomainEvent],
    app_handle: &AppHandle,
    context: &Arc<ServiceContext>,
) {
    if events.is_empty() {
        return;
    }

    info!("Processing batch of {} domain events", events.len());

    if let Some(plan) = plan_asset_classification_change(events) {
        let _ = app_handle.emit(
            ASSET_CLASSIFICATIONS_CHANGED,
            serde_json::json!({
                "assetIds": plan.asset_ids,
                "taxonomyIds": plan.taxonomy_ids,
            }),
        );
    }

    // 1. Plan and run asset enrichment FIRST so that bond metadata (coupon rate,
    //    maturity date, etc.) is available before the portfolio job tries to
    //    sync quotes and calculate snapshots.
    let enrichment_asset_ids = plan_asset_enrichment(events);
    if !enrichment_asset_ids.is_empty() {
        info!(
            "Triggering asset enrichment for {} asset(s)",
            enrichment_asset_ids.len()
        );

        let total = enrichment_asset_ids.len();
        let _ = app_handle.emit(
            ASSET_ENRICHMENT_START,
            serde_json::json!({ "total": total }),
        );

        let asset_service = context.asset_service();
        let mut total_enriched: usize = 0;
        let mut total_skipped: usize = 0;
        let mut total_failed: usize = 0;

        let chunk_size = 5;

        for chunk in enrichment_asset_ids.chunks(chunk_size) {
            match tokio::time::timeout(
                Duration::from_secs(30),
                asset_service.enrich_assets(chunk.to_vec()),
            )
            .await
            {
                Ok(Ok((enriched, skipped, failed))) => {
                    total_enriched += enriched;
                    total_skipped += skipped;
                    total_failed += failed;
                }
                Ok(Err(e)) => {
                    warn!("Asset enrichment chunk failed: {}", e);
                    total_failed += chunk.len();
                }
                Err(_) => {
                    warn!(
                        "Asset enrichment chunk timed out ({} asset(s))",
                        chunk.len()
                    );
                    total_failed += chunk.len();
                }
            }

            let completed = total_enriched + total_skipped + total_failed;
            let _ = app_handle.emit(
                ASSET_ENRICHMENT_PROGRESS,
                serde_json::json!({
                    "completed": completed,
                    "total": total,
                }),
            );
        }

        let _ = app_handle.emit(
            ASSET_ENRICHMENT_COMPLETE,
            serde_json::json!({
                "enriched": total_enriched,
                "skipped": total_skipped,
                "failed": total_failed,
            }),
        );
    }

    // 2. Plan and run portfolio job directly (not via event emission)
    // This ensures the is_processing guard properly tracks completion
    let timezone = context.get_timezone();
    if let Some(payload) = plan_portfolio_job(events, &timezone) {
        run_portfolio_job(app_handle, context, payload).await;

        // 2b. Refresh all active goal summaries after portfolio valuations update.
        // This keeps goal cards current without client-side polling.
        refresh_all_goal_summaries(context).await;
    }

    // 3. Auto-categorize newly-changed activities on opted-in spending accounts.
    // Fire-and-forget — the activity command has already returned to the user;
    // the dashboard will pick up new assignments on its next React Query refetch.
    spawn_auto_categorize_for_batch(events, context).await;

    #[cfg(feature = "connect-sync")]
    {
        // 3. Plan and trigger broker sync for eligible tracking mode changes
        let sync_account_ids = plan_broker_sync(events);
        if !sync_account_ids.is_empty() {
            // Check plan entitlement before syncing
            match context.connect_service().has_broker_sync().await {
                Ok(true) => {}
                Ok(false) => {
                    info!("Broker sync skipped after tracking mode change: plan does not include broker sync");
                    return;
                }
                Err(e) => {
                    warn!("Broker sync skipped after tracking mode change: could not verify entitlement ({})", e);
                    return;
                }
            }

            info!(
                "Triggering broker sync for {} accounts (tracking mode changed)",
                sync_account_ids.len()
            );

            // Spawn broker sync as a background task
            let context_clone = context.clone();
            let app_handle_clone = app_handle.clone();

            tokio::spawn(async move {
                match perform_broker_sync(&context_clone, Some(&app_handle_clone)).await {
                    Ok(result) => {
                        info!(
                            "Broker sync completed after tracking mode change: success={}, message={}",
                            result.success, result.message
                        );
                    }
                    Err(e) => {
                        warn!("Broker sync failed after tracking mode change: {}", e);
                    }
                }
            });
        }
    }
}

/// Plans and spawns auto-categorization for this batch's spending-account
/// activity changes. Loads `SpendingSettings` once per batch; no-op when
/// spending tracking is disabled or no opted-in account was touched.
///
/// Fire-and-forget by design — categorization writes are idempotent and
/// the user has already been told the activity was created/updated.
async fn spawn_auto_categorize_for_batch(events: &[DomainEvent], context: &Arc<ServiceContext>) {
    let settings = match context.spending_settings_service().get().await {
        Ok(s) => s,
        Err(e) => {
            warn!(
                "Skipping auto-categorization: failed to load spending settings: {}",
                e
            );
            return;
        }
    };
    if !settings.enabled || settings.account_ids.is_empty() {
        return;
    }
    let opted_in: std::collections::HashSet<String> =
        settings.account_ids.iter().cloned().collect();
    let account_ids = plan_categorization_job(events, &opted_in);
    if account_ids.is_empty() {
        return;
    }
    info!(
        "Triggering auto-categorization for {} account(s)",
        account_ids.len()
    );
    let rules_service = context.categorization_rules_service();
    tokio::spawn(async move {
        match rules_service
            .rerun_all(&account_ids, /* only_uncategorized */ true)
            .await
        {
            Ok(count) if count > 0 => {
                info!("Auto-categorization wrote {} assignment(s)", count);
            }
            Ok(_) => {}
            Err(e) => warn!("Auto-categorization failed: {}", e),
        }
    });
}

/// Runs a portfolio job directly (not via event emission).
///
/// This ensures the is_processing guard properly tracks completion and prevents
/// concurrent portfolio jobs. The logic mirrors handle_portfolio_request in listeners.rs.
async fn run_portfolio_job(
    app_handle: &AppHandle,
    context: &Arc<ServiceContext>,
    payload: PortfolioRequestPayload,
) {
    let market_sync_mode = payload.market_sync_mode.clone();
    let accounts_to_recalc = payload.account_ids.clone();
    let snapshot_mode = match payload.since_date {
        Some(date) => SnapshotRecalcMode::SinceDate(date),
        None => SnapshotRecalcMode::Full,
    };
    let valuation_mode = match payload.since_date {
        Some(date) => ValuationRecalcMode::SinceDate(date),
        None => ValuationRecalcMode::Full,
    };

    // Only perform market sync if the mode requires it
    if market_sync_mode.requires_sync() {
        let market_data_service = context.quote_service();
        let snapshot_service = context.snapshot_service();
        let account_ids_for_sync = resolve_job_account_ids(context, None).unwrap_or_else(|err| {
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
        if let Err(e) = app_handle.emit(MARKET_SYNC_START, &()) {
            error!("Failed to emit market:sync-start event: {}", e);
        }

        let sync_start = std::time::Instant::now();
        let asset_ids = market_sync_mode.asset_ids().cloned();

        // Convert MarketSyncMode to SyncMode for the quote service
        let sync_result = match market_sync_mode.to_sync_mode() {
            Some(sync_mode) => market_data_service.sync(sync_mode, asset_ids).await,
            None => {
                warn!("MarketSyncMode requires sync but returned None for SyncMode");
                Ok(wealthfolio_core::quotes::SyncResult::default())
            }
        };

        info!("Market data sync completed in: {:?}", sync_start.elapsed());

        match sync_result {
            Ok(result) => {
                let failed_syncs = result.failures;
                let skipped_reasons = result
                    .skipped_reasons
                    .into_iter()
                    .map(|(asset_id, reason)| (asset_id, reason.to_string()))
                    .collect();

                let health_service = context.health_service();
                health_service.clear_cache().await;

                let result_payload = MarketSyncResult {
                    failed_syncs,
                    skipped_reasons,
                    show_skipped_reasons: false,
                };
                if let Err(e) = app_handle.emit(MARKET_SYNC_COMPLETE, &result_payload) {
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

                // Continue to portfolio calculation
                run_portfolio_calculation(
                    app_handle,
                    context,
                    accounts_to_recalc,
                    snapshot_mode,
                    valuation_mode,
                )
                .await;
            }
            Err(e) => {
                if let Err(e_emit) = app_handle.emit(MARKET_SYNC_ERROR, &e.to_string()) {
                    error!("Failed to emit market:sync-error event: {}", e_emit);
                }
                error!(
                    "Market data sync failed: {}. Skipping portfolio calculation.",
                    e
                );
            }
        }
    } else {
        // MarketSyncMode::None - skip market sync, just recalculate
        debug!("Skipping market sync (MarketSyncMode::None)");
        run_portfolio_calculation(
            app_handle,
            context,
            accounts_to_recalc,
            snapshot_mode,
            valuation_mode,
        )
        .await;
    }
}

fn resolve_job_account_ids(
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

/// Runs the portfolio calculation (snapshots and valuations).
async fn run_portfolio_calculation(
    app_handle: &AppHandle,
    context: &Arc<ServiceContext>,
    account_ids: Option<Vec<String>>,
    snapshot_mode: SnapshotRecalcMode,
    valuation_mode: ValuationRecalcMode,
) {
    // Emit start event
    if let Err(e) = app_handle.emit(PORTFOLIO_UPDATE_START, &()) {
        error!("Failed to emit portfolio:update-start event: {}", e);
    }

    let account_ids_vec = match resolve_job_account_ids(context, account_ids.as_ref()) {
        Ok(ids) => ids,
        Err(err) => {
            let err_msg = format!("Failed to resolve account IDs: {}", err);
            error!("{}", err_msg);
            let _ = app_handle.emit(PORTFOLIO_UPDATE_ERROR, &err_msg);
            return;
        }
    };

    // Calculate holdings snapshots
    if !account_ids_vec.is_empty() {
        let ids_slice = account_ids_vec.as_slice();
        let snapshot_service = context.snapshot_service();

        if let Err(err) = snapshot_service
            .recalculate_holdings_snapshots(Some(ids_slice), snapshot_mode.clone())
            .await
        {
            let err_msg = format!(
                "Holdings snapshot calculation failed for targeted accounts: {}",
                err
            );
            warn!("{}", err_msg);
            let _ = app_handle.emit(PORTFOLIO_UPDATE_ERROR, &err_msg);
        }
    }

    let snapshot_service = context.snapshot_service();
    // Update position status from latest real-account snapshots for quote sync planning.
    let quote_service = context.quote_service();
    let quote_reconciliation_account_ids =
        resolve_job_account_ids(context, None).unwrap_or_else(|err| {
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

    // Calculate valuation history for each account
    let valuation_service = context.valuation_service();
    for account_id in account_ids_vec {
        if let Err(err) = valuation_service
            .calculate_valuation_history(&account_id, valuation_mode.clone())
            .await
        {
            let err_msg = format!(
                "Valuation history calculation failed for {}: {}",
                account_id, err
            );
            warn!("{}", err_msg);
            let _ = app_handle.emit(PORTFOLIO_UPDATE_ERROR, &err_msg);
        }
    }

    // Emit completion event
    if let Err(e) = app_handle.emit(PORTFOLIO_UPDATE_COMPLETE, &()) {
        error!("Failed to emit portfolio:update-complete event: {}", e);
    }
}

/// Refreshes cached summary fields for all active goals.
///
/// Called after portfolio valuations are recalculated so that goal dashboard
/// cards always reflect the latest account values without client-side polling.
async fn refresh_all_goal_summaries(context: &Arc<ServiceContext>) {
    let goals = match context.goal_service().get_goals() {
        Ok(g) => g,
        Err(e) => {
            warn!("Failed to load goals for summary refresh: {}", e);
            return;
        }
    };

    let active_goals: Vec<_> = goals
        .iter()
        .filter(|g| g.status_lifecycle == "active")
        .collect();

    if active_goals.is_empty() {
        return;
    }

    let accounts = match context.account_service().get_active_non_archived_accounts() {
        Ok(a) => a,
        Err(e) => {
            warn!("Failed to load accounts for goal summary refresh: {}", e);
            return;
        }
    };
    let account_ids: Vec<String> = accounts.into_iter().map(|a| a.id).collect();
    let base_currency = context.get_base_currency();
    let timezone = context.get_timezone();
    let latest_snapshot_cutoff = user_today(parse_user_timezone_or_default(&timezone));
    let account_service = context.account_service();
    let snapshot_repository = context.snapshot_repository();
    let asset_service = context.asset_service();
    let quote_service = context.quote_service();
    let fx_service = context.fx_service();
    let service = CurrentAccountValuationService::new(
        account_service.as_ref(),
        snapshot_repository.as_ref(),
        asset_service.as_ref(),
        quote_service.as_ref(),
        fx_service.as_ref(),
    );
    let response = match service
        .get_current_valuation_for_scope(
            "all",
            &account_ids,
            &base_currency,
            latest_snapshot_cutoff,
            true,
        )
        .await
    {
        Ok(response) => response,
        Err(e) => {
            warn!(
                "Failed to load current valuations for goal summary refresh: {}",
                e
            );
            return;
        }
    };

    let mut valuation_map = std::collections::HashMap::new();
    for v in &response.accounts {
        let Some(value_in_base) = v.total_value_base.to_f64() else {
            warn!(
                "Skipping goal summary refresh: invalid base valuation total for account {}",
                v.account_id
            );
            return;
        };
        valuation_map.insert(v.account_id.clone(), value_in_base);
    }

    // Refresh each active goal
    for goal in active_goals {
        if let Err(e) = context
            .goal_service()
            .refresh_goal_summary(&goal.id, &valuation_map)
            .await
        {
            debug!("Failed to refresh summary for goal {}: {}", goal.id, e);
        }
    }

    debug!(
        "Refreshed summaries for {} active goal(s)",
        goals
            .iter()
            .filter(|g| g.status_lifecycle == "active")
            .count()
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_debounce_constant() {
        // Ensure debounce is set to 1000ms (1 second)
        assert_eq!(DEBOUNCE_MS, 1000);
    }
}
