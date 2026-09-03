//! Event queue worker that processes domain events with debouncing.
//!
//! Receives events via an mpsc channel, debounces them within a 500ms window,
//! and then processes the batch to trigger platform-specific actions.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use log::{debug, info, warn};
use rust_decimal::prelude::ToPrimitive;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use wealthfolio_core::events::DomainEvent;
use wealthfolio_core::portfolio::valuation::CurrentAccountValuationService;
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
    PortfolioRequestPayload, ASSET_CLASSIFICATIONS_CHANGED, ASSET_ENRICHMENT_COMPLETE,
    ASSET_ENRICHMENT_PROGRESS, ASSET_ENRICHMENT_START,
};

/// Debounce window duration in milliseconds.
const DEBOUNCE_MS: u64 = 1000;
/// A batch is processed at most this long after its first event, however
/// many events keep arriving.
const MAX_BATCH_WAIT_MS: u64 = 5000;

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
    let max_batch_wait = Duration::from_millis(MAX_BATCH_WAIT_MS);
    let mut event_buffer: Vec<DomainEvent> = Vec::new();
    let mut batch_started: Option<Instant> = None;
    let is_processing = Arc::new(AtomicBool::new(false));

    loop {
        // If buffer is empty, wait indefinitely for the first event.
        // Otherwise debounce, but never let a sustained event stream postpone
        // the batch beyond MAX_BATCH_WAIT_MS (architecture §3.3).
        let maybe_event = if event_buffer.is_empty() {
            receiver.recv().await
        } else {
            let wait = batch_started
                .map(|started| max_batch_wait.saturating_sub(started.elapsed()))
                .unwrap_or(debounce_duration)
                .min(debounce_duration);
            tokio::select! {
                event = receiver.recv() => event,
                _ = tokio::time::sleep(wait) => None,
            }
        };

        match maybe_event {
            Some(event) => {
                event_buffer.push(event);
                let started = *batch_started.get_or_insert_with(Instant::now);
                if started.elapsed() < max_batch_wait {
                    continue;
                }
            }
            None if event_buffer.is_empty() => {
                // Channel closed and nothing buffered: exit the worker.
                while is_processing.load(Ordering::SeqCst) {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                info!("Domain event queue worker shutting down");
                break;
            }
            None => {}
        }

        // Debounce expired, the batch is overdue, or the channel closed with
        // buffered events: process them.
        if is_processing.load(Ordering::SeqCst) {
            debug!("Debounce expired but previous batch still processing, continuing to collect events");
            continue;
        }
        let events = std::mem::take(&mut event_buffer);
        batch_started = None;
        is_processing.store(true, Ordering::SeqCst);
        process_event_batch(&events, &app_handle, &context).await;
        is_processing.store(false, Ordering::SeqCst);
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
    if let Some(payload) = plan_portfolio_job(events) {
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

/// Runs a portfolio job through the coordinator.
async fn run_portfolio_job(
    app_handle: &AppHandle,
    context: &Arc<ServiceContext>,
    payload: PortfolioRequestPayload,
) {
    crate::portfolio_jobs::run_portfolio_request(app_handle, context, payload).await;
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
