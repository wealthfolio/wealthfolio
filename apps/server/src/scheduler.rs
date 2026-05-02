//! Background scheduler for periodic broker sync.
//!
//! Runs a fixed 4-hour interval sync for the Docker/Web server.

use std::sync::Arc;

#[cfg(feature = "connect-sync")]
use tokio::time::{interval, Duration};
#[cfg(not(feature = "connect-sync"))]
use tracing::info;
use tracing::warn;
#[cfg(feature = "connect-sync")]
use tracing::{debug, info};

#[cfg(feature = "connect-sync")]
use crate::api::connect::{has_broker_sync, perform_broker_sync};
use crate::main_lib::AppState;

/// Sync interval: 4 hours (not user-configurable to prevent API abuse)
#[cfg(feature = "connect-sync")]
const SYNC_INTERVAL_SECS: u64 = 4 * 60 * 60;

/// Initial delay before first sync (60 seconds to let server fully start)
#[cfg(feature = "connect-sync")]
const INITIAL_DELAY_SECS: u64 = 60;

/// Starts the background broker sync scheduler.
#[cfg(feature = "connect-sync")]
pub fn start_broker_sync_scheduler(state: Arc<AppState>) {
    tokio::spawn(async move {
        info!("Broker sync scheduler started (4-hour interval)");

        // Initial delay before first sync
        tokio::time::sleep(Duration::from_secs(INITIAL_DELAY_SECS)).await;

        // Set up periodic sync - first tick is immediate, subsequent ticks are 4h apart
        let mut sync_interval = interval(Duration::from_secs(SYNC_INTERVAL_SECS));

        loop {
            sync_interval.tick().await;
            run_scheduled_sync(&state).await;
        }
    });
}

/// Starts the background broker sync scheduler.
#[cfg(not(feature = "connect-sync"))]
pub fn start_broker_sync_scheduler(_state: Arc<AppState>) {
    info!("Broker sync scheduler disabled: connect-sync feature is not compiled");
}

/// Checks whether the lots table is empty and, if so, runs a full holdings
/// recalculation to populate it. Mirrors the Tauri `backfill_lots_if_needed`.
pub async fn backfill_lots_if_needed(state: &Arc<AppState>) {
    use wealthfolio_core::portfolio::snapshot::SnapshotRecalcMode;

    let count = match state.lots_repository.count_lots() {
        Ok(n) => n,
        Err(e) => {
            warn!("Lot backfill skipped: could not count lots ({})", e);
            return;
        }
    };

    if count > 0 {
        return;
    }

    tracing::info!("Lots table is empty — running full holdings recalculation to populate it");
    if let Err(e) = state
        .snapshot_service
        .recalculate_holdings_snapshots(None, SnapshotRecalcMode::Full)
        .await
    {
        warn!("Lot backfill recalculation failed: {}", e);
    }

    // HOLDINGS-mode accounts are skipped by recalculate_holdings_snapshots.
    // Backfill them separately from their latest snapshots.
    if let Err(e) = state
        .snapshot_service
        .backfill_lots_for_holdings_accounts()
        .await
    {
        warn!("HOLDINGS lot backfill failed: {}", e);
    }
}

/// Runs a single scheduled sync operation.
#[cfg(feature = "connect-sync")]
async fn run_scheduled_sync(state: &Arc<AppState>) {
    info!("Running scheduled broker sync...");

    // Check if user has a refresh token configured (indicates they've logged in)
    let has_token = state
        .secret_store
        .get_secret("sync_refresh_token")
        .map(|t| t.is_some())
        .unwrap_or(false);

    if !has_token {
        debug!("Scheduled sync skipped: no refresh token configured");
        return;
    }

    // Check if user's plan includes broker sync
    match has_broker_sync(state).await {
        Ok(true) => {}
        Ok(false) => {
            debug!("Scheduled sync skipped: plan does not include broker sync");
            return;
        }
        Err(e) => {
            debug!(
                "Scheduled sync skipped: could not verify broker sync access ({})",
                e
            );
            return;
        }
    }

    // Perform the sync using the shared perform_broker_sync from api::connect
    // This uses SyncOrchestrator which:
    // - Emits broker:sync-start, broker:sync-complete, broker:sync-error events via SSE
    // - Handles subscription validation internally
    // - Syncs connections, accounts, activities, and holdings
    match perform_broker_sync(state).await {
        Ok(result) => {
            let activities_count = result
                .activities_synced
                .as_ref()
                .map(|a| a.activities_upserted)
                .unwrap_or(0);
            info!(
                "Scheduled broker sync completed: {} activities synced",
                activities_count
            );
        }
        Err(e) => {
            // Check if this is an auth error (expected when user isn't logged in)
            if e.contains("No refresh token")
                || e.contains("not authenticated")
                || e.contains("Session expired")
            {
                debug!("Scheduled sync skipped: user not authenticated");
            } else {
                warn!("Scheduled broker sync failed: {}", e);
            }
        }
    }
}
