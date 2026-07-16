//! Event queue worker for processing domain events.
//!
//! Receives events from an mpsc channel, debounces them with a 500ms window,
//! then processes the batch to trigger portfolio recalculation, asset enrichment,
//! and broker sync.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use tokio::sync::mpsc;
use wealthfolio_connect::{
    acquire_broker_sync_guard, ensure_valid_access_token, BrokerSyncServiceTrait,
    TokenLifecycleConfig, TokenLifecycleState,
};
use wealthfolio_core::{
    assets::AssetServiceTrait,
    events::DomainEvent,
    goals::GoalServiceTrait,
    portfolio::valuation::CurrentAccountValuationService,
    secrets::SecretStore,
    utils::time_utils::{parse_user_timezone_or_default, user_today},
};

use super::planner::{
    plan_asset_classification_change, plan_asset_enrichment, plan_broker_sync,
    plan_categorization_job, plan_portfolio_job,
};
use crate::events::EventBus;

/// Debounce window for collecting events before processing.
const DEBOUNCE_DURATION: Duration = Duration::from_millis(1000);

/// Dependencies needed by the queue worker for processing events.
pub struct QueueWorkerDeps {
    pub asset_service: Arc<dyn AssetServiceTrait + Send + Sync>,
    pub connect_sync_service: Arc<dyn BrokerSyncServiceTrait + Send + Sync>,
    pub event_bus: EventBus,
    pub broker_sync_running: Arc<AtomicBool>,
    pub health_service: Arc<dyn wealthfolio_core::health::HealthServiceTrait + Send + Sync>,
    // We need a way to enqueue portfolio jobs. Since AppState is not easily cloneable,
    // we pass what we need for enqueue_portfolio_job (which spawns its own async task).
    // The shared.rs enqueue_portfolio_job needs Arc<AppState>, so we'll need to pass
    // a callback or restructure slightly. For now, we'll store what we need.
    pub snapshot_service:
        Arc<dyn wealthfolio_core::portfolio::snapshot::SnapshotServiceTrait + Send + Sync>,
    pub snapshot_repository:
        Arc<dyn wealthfolio_core::portfolio::snapshot::SnapshotRepositoryTrait + Send + Sync>,
    pub quote_service: Arc<dyn wealthfolio_core::quotes::QuoteServiceTrait + Send + Sync>,
    pub valuation_service:
        Arc<dyn wealthfolio_core::portfolio::valuation::ValuationServiceTrait + Send + Sync>,
    pub account_service: Arc<wealthfolio_core::accounts::AccountService>,
    pub goal_service: Arc<dyn GoalServiceTrait + Send + Sync>,
    pub fx_service: Arc<dyn wealthfolio_core::fx::FxServiceTrait + Send + Sync>,
    pub base_currency: Arc<RwLock<String>>,
    pub timezone: Arc<RwLock<String>>,
    /// Secret store for accessing credentials (e.g., refresh tokens for broker sync)
    pub secret_store: Arc<dyn SecretStore>,
    /// Shared token lifecycle state; must be the same instance used by API handlers.
    pub token_lifecycle: Arc<TokenLifecycleState>,
    /// Spending settings — used to filter ActivitiesChanged events to opted-in accounts.
    pub spending_settings_service: Arc<wealthfolio_spending::settings::SpendingSettingsService>,
    /// Categorization rules service — auto-runs rules against newly-changed activities.
    pub categorization_rules_service:
        Arc<wealthfolio_spending::categorization_rules::CategorizationRulesService>,
}

/// Runs the event queue worker.
///
/// Receives events from the channel, debounces with a 500ms window,
/// and processes batches to trigger appropriate actions.
///
/// Uses an `is_processing` guard to prevent new batches from being processed
/// while a previous batch (e.g., broker sync or portfolio recalc) is still running.
pub async fn event_queue_worker(
    mut rx: mpsc::UnboundedReceiver<DomainEvent>,
    deps: Arc<QueueWorkerDeps>,
) {
    tracing::info!("Domain event queue worker started");

    let mut pending_events: Vec<DomainEvent> = Vec::new();
    let is_processing = Arc::new(AtomicBool::new(false));

    loop {
        // If we have pending events, wait for more events or timeout
        if !pending_events.is_empty() {
            tokio::select! {
                // Wait for more events
                event = rx.recv() => {
                    match event {
                        Some(e) => {
                            pending_events.push(e);
                            // Continue collecting more events
                        }
                        None => {
                            // Channel closed, process remaining and exit
                            // Wait for any in-progress processing to complete before final batch
                            while is_processing.load(Ordering::SeqCst) {
                                tokio::time::sleep(Duration::from_millis(50)).await;
                            }
                            if !pending_events.is_empty() {
                                is_processing.store(true, Ordering::SeqCst);
                                process_event_batch(&pending_events, deps.clone()).await;
                                is_processing.store(false, Ordering::SeqCst);
                            }
                            tracing::info!("Domain event queue worker shutting down");
                            return;
                        }
                    }
                }
                // Debounce timeout expired
                _ = tokio::time::sleep(DEBOUNCE_DURATION) => {
                    // Check if we're still processing a previous batch
                    if is_processing.load(Ordering::SeqCst) {
                        // Still processing, keep collecting events
                        tracing::debug!("Debounce expired but previous batch still processing, continuing to collect events");
                        continue;
                    }

                    if !pending_events.is_empty() {
                        let batch = std::mem::take(&mut pending_events);
                        is_processing.store(true, Ordering::SeqCst);
                        process_event_batch(&batch, deps.clone()).await;
                        is_processing.store(false, Ordering::SeqCst);
                    }
                }
            }
        } else {
            // No pending events, wait for the first event
            match rx.recv().await {
                Some(e) => {
                    pending_events.push(e);
                }
                None => {
                    // Channel closed
                    tracing::info!("Domain event queue worker shutting down");
                    return;
                }
            }
        }
    }
}

/// Processes a batch of domain events.
async fn process_event_batch(events: &[DomainEvent], deps: Arc<QueueWorkerDeps>) {
    tracing::info!("Processing batch of {} domain event(s)", events.len());

    if let Some(plan) = plan_asset_classification_change(events) {
        deps.event_bus
            .publish(crate::events::ServerEvent::with_payload(
                crate::events::ASSET_CLASSIFICATIONS_CHANGED,
                serde_json::json!({
                    "assetIds": plan.asset_ids,
                    "taxonomyIds": plan.taxonomy_ids,
                }),
            ));
    }

    // 1. Plan and run asset enrichment FIRST so that bond metadata (coupon rate,
    //    maturity date, etc.) is available before the portfolio job tries to
    //    sync quotes and calculate snapshots.
    let enrichment_assets = plan_asset_enrichment(events);
    if !enrichment_assets.is_empty() {
        tracing::info!(
            "Triggering asset enrichment for {} asset(s)",
            enrichment_assets.len()
        );

        let total = enrichment_assets.len();
        deps.event_bus
            .publish(crate::events::ServerEvent::with_payload(
                crate::events::ASSET_ENRICHMENT_START,
                serde_json::json!({ "total": total }),
            ));

        let mut total_enriched: usize = 0;
        let mut total_skipped: usize = 0;
        let mut total_failed: usize = 0;

        let chunk_size = 5;

        for chunk in enrichment_assets.chunks(chunk_size) {
            match tokio::time::timeout(
                Duration::from_secs(30),
                deps.asset_service.enrich_assets(chunk.to_vec()),
            )
            .await
            {
                Ok(Ok((enriched, skipped, failed))) => {
                    total_enriched += enriched;
                    total_skipped += skipped;
                    total_failed += failed;
                }
                Ok(Err(e)) => {
                    tracing::warn!("Asset enrichment chunk failed: {}", e);
                    total_failed += chunk.len();
                }
                Err(_) => {
                    tracing::warn!(
                        "Asset enrichment chunk timed out ({} asset(s))",
                        chunk.len()
                    );
                    total_failed += chunk.len();
                }
            }

            let completed = total_enriched + total_skipped + total_failed;
            deps.event_bus
                .publish(crate::events::ServerEvent::with_payload(
                    crate::events::ASSET_ENRICHMENT_PROGRESS,
                    serde_json::json!({
                        "completed": completed,
                        "total": total,
                    }),
                ));
        }

        deps.event_bus
            .publish(crate::events::ServerEvent::with_payload(
                crate::events::ASSET_ENRICHMENT_COMPLETE,
                serde_json::json!({
                    "enriched": total_enriched,
                    "skipped": total_skipped,
                    "failed": total_failed,
                }),
            ));
    }

    // 2. Plan and trigger portfolio job
    let timezone = deps.timezone.read().unwrap().clone();
    if let Some(config) = plan_portfolio_job(events, &timezone) {
        tracing::info!(
            "Triggering portfolio job for accounts: {:?}, market_sync: {:?}",
            config.account_ids,
            config.market_sync_mode
        );

        // Run the portfolio job directly (not spawned) so that is_processing
        // guard properly tracks completion and prevents concurrent jobs
        run_portfolio_job(deps.clone(), config).await;

        // Keep goal cards current after valuation changes, matching the Tauri worker.
        refresh_all_goal_summaries(deps.clone()).await;
    }

    // 2b. Auto-categorize newly-changed activities on opted-in spending accounts.
    spawn_auto_categorize_for_batch(events, deps.clone()).await;

    // 3. Plan and trigger broker sync
    let sync_accounts = plan_broker_sync(events);
    if !sync_accounts.is_empty() {
        tracing::info!(
            "Broker sync needed for {} account(s): {:?}",
            sync_accounts.len(),
            sync_accounts
        );

        // Spawn broker sync as a background task
        let connect_sync_service = deps.connect_sync_service.clone();
        let event_bus = deps.event_bus.clone();
        let secret_store = deps.secret_store.clone();
        let token_lifecycle = deps.token_lifecycle.clone();
        let broker_sync_running = deps.broker_sync_running.clone();

        tokio::spawn(async move {
            let Some(_guard) = acquire_broker_sync_guard(&broker_sync_running) else {
                tracing::info!(
                    "Broker sync skipped after tracking mode change: sync already running"
                );
                return;
            };

            match perform_broker_sync(
                connect_sync_service,
                event_bus,
                secret_store,
                token_lifecycle,
            )
            .await
            {
                Ok(result) => {
                    tracing::info!(
                        "Broker sync completed after tracking mode change: success={}, message={}",
                        result.success,
                        result.message
                    );
                }
                Err(e) => {
                    tracing::warn!("Broker sync failed after tracking mode change: {}", e);
                }
            }
        });
    }
}

/// Runs a portfolio job with the given configuration.
///
/// This is a local implementation that mirrors the behavior of
/// `enqueue_portfolio_job` from `api/shared.rs` but uses the
/// worker's dependencies instead of requiring full AppState.
///
/// Note: This runs the job directly (not spawned) so that the caller
/// can properly track completion via the `is_processing` guard.
async fn run_portfolio_job(
    deps: Arc<QueueWorkerDeps>,
    config: crate::api::shared::PortfolioJobConfig,
) {
    use crate::events::{
        MarketSyncResult, ServerEvent, MARKET_SYNC_COMPLETE, MARKET_SYNC_ERROR, MARKET_SYNC_START,
        PORTFOLIO_UPDATE_COMPLETE, PORTFOLIO_UPDATE_ERROR, PORTFOLIO_UPDATE_START,
    };
    use serde_json::json;
    use wealthfolio_core::accounts::AccountServiceTrait;
    use wealthfolio_core::portfolio::snapshot::reconcile_quote_sync_from_latest_account_snapshots;

    let event_bus = deps.event_bus.clone();
    let snapshot_mode = config
        .since_date
        .map(wealthfolio_core::portfolio::snapshot::SnapshotRecalcMode::SinceDate)
        .unwrap_or_else(|| config.snapshot_mode.clone());
    let valuation_mode = config
        .since_date
        .map(wealthfolio_core::portfolio::valuation::ValuationRecalcMode::SinceDate)
        .unwrap_or_else(|| config.valuation_mode.clone());

    let accounts_for_scope = match deps.account_service.get_non_archived_accounts() {
        Ok(accounts) => accounts,
        Err(err) => {
            let err_msg = format!("Failed to list non-archived accounts: {}", err);
            tracing::error!("{}", err_msg);
            event_bus.publish(ServerEvent::with_payload(
                PORTFOLIO_UPDATE_ERROR,
                json!(err_msg),
            ));
            return;
        }
    };

    // Determine which accounts to calculate individual snapshots for:
    // - If specific account_ids provided: process those accounts (even if archived)
    // - Otherwise: process all non-archived accounts
    let account_ids: Vec<String> = if let Some(ref target_ids) = config.account_ids {
        // Process the specific requested accounts (even if archived, for their own snapshots)
        target_ids.clone()
    } else {
        // No specific accounts requested - use non-archived accounts
        accounts_for_scope.iter().map(|a| a.id.clone()).collect()
    };
    let quote_reconciliation_account_ids: Vec<String> =
        accounts_for_scope.iter().map(|a| a.id.clone()).collect();

    // Only perform market sync if the mode requires it
    if config.market_sync_mode.requires_sync() {
        if let Err(e) = reconcile_quote_sync_from_latest_account_snapshots(
            deps.snapshot_service.as_ref(),
            deps.quote_service.as_ref(),
            &quote_reconciliation_account_ids,
        )
        .await
        {
            tracing::warn!(
                "Failed to reconcile quote sync state from latest holdings: {}. Quote sync planning may be affected.",
                e
            );
        }

        event_bus.publish(ServerEvent::new(MARKET_SYNC_START));

        let sync_start = std::time::Instant::now();
        let asset_ids = config.market_sync_mode.asset_ids().cloned();

        let sync_result = match config.market_sync_mode.to_sync_mode() {
            Some(sync_mode) => deps.quote_service.sync(sync_mode, asset_ids).await,
            None => {
                tracing::warn!("MarketSyncMode requires sync but returned None for SyncMode");
                Ok(wealthfolio_core::quotes::SyncResult::default())
            }
        };

        match sync_result {
            Ok(result) => {
                let skipped_reasons: Vec<(String, String)> = result
                    .skipped_reasons
                    .into_iter()
                    .map(|(asset_id, reason)| (asset_id, reason.to_string()))
                    .collect();
                event_bus.publish(ServerEvent::with_payload(
                    MARKET_SYNC_COMPLETE,
                    json!(MarketSyncResult {
                        failed_syncs: result.failures,
                        skipped_reasons,
                        show_skipped_reasons: false,
                    }),
                ));
                tracing::info!("Market data sync completed in {:?}", sync_start.elapsed());
                deps.health_service.clear_cache().await;
                if let Err(err) = deps.fx_service.initialize() {
                    tracing::warn!(
                        "Failed to initialize FxService after market data sync: {}",
                        err
                    );
                }
            }
            Err(err) => {
                let err_msg = err.to_string();
                tracing::error!("Market data sync failed: {}", err_msg);
                event_bus.publish(ServerEvent::with_payload(MARKET_SYNC_ERROR, json!(err_msg)));
                return;
            }
        }
    } else {
        tracing::debug!("Skipping market sync (MarketSyncMode::None)");
    }

    event_bus.publish(ServerEvent::new(PORTFOLIO_UPDATE_START));

    if !account_ids.is_empty() {
        let ids_slice = account_ids.as_slice();
        if let Err(err) = deps
            .snapshot_service
            .recalculate_holdings_snapshots(Some(ids_slice), snapshot_mode.clone())
            .await
        {
            let err_msg = format!(
                "Holdings snapshot calculation failed for targeted accounts: {}",
                err
            );
            tracing::warn!("{}", err_msg);
            event_bus.publish(ServerEvent::with_payload(
                PORTFOLIO_UPDATE_ERROR,
                json!(err_msg),
            ));
        }
    }

    // Update position status from latest real-account snapshots for quote sync planning.
    if let Err(e) = reconcile_quote_sync_from_latest_account_snapshots(
        deps.snapshot_service.as_ref(),
        deps.quote_service.as_ref(),
        &quote_reconciliation_account_ids,
    )
    .await
    {
        tracing::warn!(
            "Failed to update position status from holdings: {}. Quote sync planning may be affected.",
            e
        );
    }

    for account_id in account_ids {
        if let Err(err) = deps
            .valuation_service
            .calculate_valuation_history(&account_id, valuation_mode.clone())
            .await
        {
            let err_msg = format!(
                "Valuation history calculation failed for {}: {}",
                account_id, err
            );
            tracing::warn!("{}", err_msg);
            event_bus.publish(ServerEvent::with_payload(
                PORTFOLIO_UPDATE_ERROR,
                json!(err_msg),
            ));
        }
    }

    event_bus.publish(ServerEvent::new(PORTFOLIO_UPDATE_COMPLETE));
}

/// Plans and spawns auto-categorization for this batch's spending-account
/// activity changes. Loads `SpendingSettings` once per batch; no-op when
/// spending tracking is disabled or no opted-in account was touched.
///
/// Fire-and-forget by design — categorization writes are idempotent and
/// the originating mutation has already returned to the API caller.
async fn spawn_auto_categorize_for_batch(events: &[DomainEvent], deps: Arc<QueueWorkerDeps>) {
    let settings = match deps.spending_settings_service.get().await {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(
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
    tracing::info!(
        "Triggering auto-categorization for {} account(s)",
        account_ids.len()
    );
    let rules_service = deps.categorization_rules_service.clone();
    tokio::spawn(async move {
        match rules_service
            .rerun_all(&account_ids, /* only_uncategorized */ true)
            .await
        {
            Ok(count) if count > 0 => {
                tracing::info!("Auto-categorization wrote {} assignment(s)", count);
            }
            Ok(_) => {}
            Err(e) => tracing::warn!("Auto-categorization failed: {}", e),
        }
    });
}

/// Refreshes cached summary fields for all active goals after valuation changes.
async fn refresh_all_goal_summaries(deps: Arc<QueueWorkerDeps>) {
    use rust_decimal::prelude::ToPrimitive;
    use wealthfolio_core::accounts::AccountServiceTrait;

    let goals = match deps.goal_service.get_goals() {
        Ok(goals) => goals,
        Err(err) => {
            tracing::warn!("Failed to load goals for summary refresh: {}", err);
            return;
        }
    };

    let active_goals: Vec<_> = goals
        .iter()
        .filter(|goal| goal.status_lifecycle == "active")
        .collect();

    if active_goals.is_empty() {
        return;
    }

    let accounts = match deps.account_service.get_active_non_archived_accounts() {
        Ok(accounts) => accounts,
        Err(err) => {
            tracing::warn!("Failed to load accounts for goal summary refresh: {}", err);
            return;
        }
    };
    let account_ids: Vec<String> = accounts.into_iter().map(|account| account.id).collect();
    let base_currency = deps.base_currency.read().unwrap().clone();
    let timezone = deps.timezone.read().unwrap().clone();
    let latest_snapshot_cutoff = user_today(parse_user_timezone_or_default(&timezone));
    let service = CurrentAccountValuationService::new(
        deps.account_service.as_ref(),
        deps.snapshot_repository.as_ref(),
        deps.asset_service.as_ref(),
        deps.quote_service.as_ref(),
        deps.fx_service.as_ref(),
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
        Err(err) => {
            tracing::warn!(
                "Failed to load current valuations for goal summary refresh: {}",
                err
            );
            return;
        }
    };

    let mut valuation_map = std::collections::HashMap::new();
    for valuation in &response.accounts {
        let Some(value_in_base) = valuation.total_value_base.to_f64() else {
            tracing::warn!(
                "Skipping goal summary refresh: invalid base valuation total for account {}",
                valuation.account_id
            );
            return;
        };
        valuation_map.insert(valuation.account_id.clone(), value_in_base);
    }

    for goal in active_goals {
        if let Err(err) = deps
            .goal_service
            .refresh_goal_summary(&goal.id, &valuation_map)
            .await
        {
            tracing::debug!("Failed to refresh summary for goal {}: {}", goal.id, err);
        }
    }

    tracing::debug!(
        "Refreshed summaries for {} active goal(s)",
        goals
            .iter()
            .filter(|goal| goal.status_lifecycle == "active")
            .count()
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Broker Sync
// ─────────────────────────────────────────────────────────────────────────────

fn cloud_api_base_url() -> String {
    crate::features::cloud_api_base_url().unwrap_or_default()
}

fn connect_auth_url() -> Option<String> {
    std::env::var("CONNECT_AUTH_URL")
        .ok()
        .map(|v| v.trim().trim_end_matches('/').to_string())
        .filter(|v| !v.is_empty())
        .or_else(|| option_env!("CONNECT_AUTH_URL").map(|v| v.trim_end_matches('/').to_string()))
}

fn connect_auth_api_key() -> Option<String> {
    std::env::var("CONNECT_AUTH_PUBLISHABLE_KEY")
        .ok()
        .or_else(|| option_env!("CONNECT_AUTH_PUBLISHABLE_KEY").map(String::from))
}

fn token_lifecycle_config() -> Option<TokenLifecycleConfig> {
    let auth_url = connect_auth_url()?;
    let api_key = connect_auth_api_key()?;
    Some(TokenLifecycleConfig::new(auth_url, api_key))
}

/// Progress reporter that publishes events to the EventBus for SSE delivery.
struct EventBusProgressReporter {
    event_bus: EventBus,
}

impl EventBusProgressReporter {
    fn new(event_bus: EventBus) -> Self {
        Self { event_bus }
    }
}

impl wealthfolio_connect::SyncProgressReporter for EventBusProgressReporter {
    fn report_progress(&self, payload: wealthfolio_connect::SyncProgressPayload) {
        use crate::events::ServerEvent;
        self.event_bus.publish(ServerEvent::with_payload(
            "sync-progress",
            serde_json::to_value(&payload).unwrap_or_default(),
        ));
    }

    fn report_sync_start(&self) {
        use crate::events::{ServerEvent, BROKER_SYNC_START};
        self.event_bus.publish(ServerEvent::new(BROKER_SYNC_START));
    }

    fn report_sync_complete(&self, result: &wealthfolio_connect::SyncResult) {
        use crate::events::{ServerEvent, BROKER_SYNC_COMPLETE, BROKER_SYNC_ERROR};
        if result.success {
            self.event_bus.publish(ServerEvent::with_payload(
                BROKER_SYNC_COMPLETE,
                serde_json::to_value(result).unwrap_or_default(),
            ));
        } else {
            self.event_bus.publish(ServerEvent::with_payload(
                BROKER_SYNC_ERROR,
                serde_json::json!({ "error": result.message }),
            ));
        }
    }
}

/// Mint a fresh access token using the stored refresh token.
async fn mint_access_token(
    secret_store: &Arc<dyn SecretStore>,
    token_lifecycle: &TokenLifecycleState,
) -> Result<String, String> {
    let config = token_lifecycle_config();
    ensure_valid_access_token(secret_store.as_ref(), token_lifecycle, config.as_ref())
        .await
        .map_err(|e| e.to_string())
}

/// Core broker sync logic - syncs connections, accounts, and activities from cloud to local DB.
/// Uses the centralized SyncOrchestrator for full pagination support.
/// Asset enrichment is handled automatically via domain events (AssetsCreated).
async fn perform_broker_sync(
    connect_sync_service: Arc<dyn BrokerSyncServiceTrait + Send + Sync>,
    event_bus: EventBus,
    secret_store: Arc<dyn SecretStore>,
    token_lifecycle: Arc<TokenLifecycleState>,
) -> Result<wealthfolio_connect::SyncResult, String> {
    use wealthfolio_connect::{ConnectApiClient, SyncConfig, SyncOrchestrator};

    if !crate::features::connect_sync_enabled() {
        return Err("Connect sync feature is disabled in this build.".to_string());
    }

    // Create API client with fresh access token
    let token = mint_access_token(&secret_store, token_lifecycle.as_ref()).await?;
    let client = ConnectApiClient::new(&cloud_api_base_url(), &token).map_err(|e| e.to_string())?;

    // Check plan entitlement before syncing
    if !client.has_broker_sync().await.map_err(|e| e.to_string())? {
        return Err("Plan does not include broker sync".to_string());
    }

    // Create progress reporter and orchestrator
    let reporter = Arc::new(EventBusProgressReporter::new(event_bus));
    let orchestrator = SyncOrchestrator::new(
        connect_sync_service.clone(),
        reporter,
        SyncConfig::default(),
    );

    // Run the sync via the centralized orchestrator
    // Note: Asset enrichment is handled automatically via domain events (AssetsCreated)
    orchestrator.sync_all(&client).await
}
