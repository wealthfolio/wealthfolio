//! Startup sync for broker data.
//!
//! Syncs broker data once on app startup. After that, user manually triggers sync.

#[cfg(feature = "connect-sync")]
use std::sync::Arc;

#[cfg(feature = "connect-sync")]
use log::{debug, info, warn};
#[cfg(not(feature = "connect-sync"))]
use tauri::AppHandle;
#[cfg(feature = "connect-sync")]
use tauri::AppHandle;

#[cfg(feature = "connect-sync")]
use wealthfolio_core::quotes::MarketSyncMode;

#[cfg(feature = "connect-sync")]
use crate::commands::brokers_sync::perform_broker_sync;
use crate::context::ServiceContext;

/// Runs broker sync once on startup (async, non-blocking).
///
/// This function:
/// - Checks if user's plan includes broker sync
/// - Performs the sync silently (no toast - user didn't request it)
/// - Triggers portfolio update if activities were synced
#[cfg(feature = "connect-sync")]
pub async fn run_startup_sync(handle: &AppHandle, context: &Arc<ServiceContext>) {
    info!("Running startup broker sync...");

    // Check if user's plan includes broker sync
    match context.connect_service().has_broker_sync().await {
        Ok(true) => {
            // User has broker sync, proceed
        }
        Ok(false) => {
            debug!("Startup sync skipped: plan does not include broker sync");
            return;
        }
        Err(e) => {
            // If we can't check (no token, network error, etc.), skip silently
            debug!(
                "Startup sync skipped: could not verify broker sync access ({})",
                e
            );
            return;
        }
    }

    // Perform sync (orchestrator emits broker:sync-start and broker:sync-complete events)
    match perform_broker_sync(context, Some(handle)).await {
        Ok(result) => {
            info!(
                "Startup sync completed: success={}, message={}",
                result.success, result.message
            );

            // Note: broker:sync-complete event is emitted by the orchestrator via TauriProgressReporter

            // Trigger portfolio update if sync was successful
            // Note: Asset enrichment is handled automatically via domain events (AssetsCreated)
            if result.success {
                if let Some(ref activities) = result.activities_synced {
                    if activities.activities_upserted > 0 {
                        info!(
                            "Triggering portfolio update after startup sync ({} activities synced)",
                            activities.activities_upserted
                        );
                        crate::events::emit_portfolio_trigger_recalculate(
                            handle,
                            crate::events::PortfolioRequestPayload::builder()
                                .market_sync_mode(MarketSyncMode::Incremental { asset_ids: None })
                                .build(),
                        );
                    }
                }

                if let Some(ref holdings) = result.holdings_synced {
                    if holdings.positions_upserted > 0 {
                        info!(
                            "Triggering portfolio update after holdings sync ({} positions synced)",
                            holdings.positions_upserted
                        );
                        crate::events::emit_portfolio_trigger_recalculate(
                            handle,
                            crate::events::PortfolioRequestPayload::builder()
                                .market_sync_mode(MarketSyncMode::Incremental { asset_ids: None })
                                .build(),
                        );
                    }
                }
            }
        }
        Err(e) => {
            // Check if this is an auth error (user not logged in)
            if e.contains("No access token") || e.contains("not authenticated") {
                debug!("Startup sync skipped: user not authenticated");
            } else {
                warn!("Startup sync failed: {}", e);
                // Note: broker:sync-error event is emitted by the orchestrator via TauriProgressReporter
            }
        }
    }
}

#[cfg(not(feature = "connect-sync"))]
pub async fn run_startup_sync(_handle: &AppHandle, _context: &std::sync::Arc<ServiceContext>) {}

/// Backfills the lots table on first launch after it was introduced.
///
/// If the lots table is empty but holdings snapshots exist, a full holdings
/// recalculation is triggered so every existing account gets its lot rows
/// written. This runs once; subsequent launches skip it because the table is
/// no longer empty.
pub async fn backfill_lots_if_needed(context: &std::sync::Arc<ServiceContext>) {
    use wealthfolio_core::portfolio::snapshot::SnapshotRecalcMode;

    let count = match context.lots_repository.count_lots() {
        Ok(n) => n,
        Err(e) => {
            warn!("Lot backfill skipped: could not count lots ({})", e);
            return;
        }
    };

    if count > 0 {
        return;
    }

    info!("Lots table is empty — running full holdings recalculation to populate it");
    if let Err(e) = context
        .snapshot_service
        .recalculate_holdings_snapshots(None, SnapshotRecalcMode::Full)
        .await
    {
        warn!("Lot backfill recalculation failed: {}", e);
    }

    // HOLDINGS-mode accounts are skipped by recalculate_holdings_snapshots.
    // Backfill them separately from their latest snapshots.
    if let Err(e) = context
        .snapshot_service
        .backfill_lots_for_holdings_accounts()
        .await
    {
        warn!("HOLDINGS lot backfill failed: {}", e);
    }
}
