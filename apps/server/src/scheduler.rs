//! Background scheduler for periodic broker sync.
//!
//! Runs a fixed 4-hour interval sync for the Docker/Web server.

use std::sync::Arc;

#[cfg(feature = "connect-sync")]
use tokio::time::{interval, Duration};
#[cfg(not(feature = "connect-sync"))]
use tracing::info;
#[cfg(all(feature = "device-sync", not(feature = "connect-sync")))]
use tracing::warn;
#[cfg(feature = "connect-sync")]
use tracing::{debug, info, warn};

#[cfg(feature = "connect-sync")]
use crate::api::connect::{has_broker_sync, perform_broker_sync};
use crate::main_lib::AppState;
#[cfg(feature = "connect-sync")]
use wealthfolio_connect::CLOUD_REFRESH_TOKEN_KEY;

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

/// Runs a single scheduled sync operation.
#[cfg(feature = "connect-sync")]
async fn run_scheduled_sync(state: &Arc<AppState>) {
    info!("Running scheduled broker sync...");

    // Check if user has a refresh token configured (indicates they've logged in)
    let has_token = state
        .secret_store
        .get_secret(CLOUD_REFRESH_TOKEN_KEY)
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
                || e.contains("Broker sync already running")
            {
                debug!("Scheduled sync skipped: {}", e);
            } else {
                warn!("Scheduled broker sync failed: {}", e);
            }
        }
    }
}

#[cfg(feature = "device-sync")]
fn is_expected_startup_token_warmup_error(err: &crate::error::ApiError) -> bool {
    match err {
        crate::error::ApiError::Unauthorized(_) | crate::error::ApiError::Forbidden(_) => true,
        crate::error::ApiError::Internal(message) => {
            message.contains("No refresh token configured")
                || message.contains("Auth refresh configuration is missing")
                || message.contains("CONNECT_AUTH_URL or CONNECT_AUTH_PUBLISHABLE_KEY")
        }
        _ => false,
    }
}

/// Start background jobs after server construction succeeds.
pub fn start_background_workers(state: Arc<AppState>) {
    #[cfg(feature = "device-sync")]
    #[allow(clippy::collapsible_if)]
    if crate::features::device_sync_enabled() {
        let startup_state = state.clone();
        tokio::spawn(async move {
            match crate::api::connect::mint_access_token(&startup_state).await {
                Ok(token) => {
                    if startup_state
                        .device_enroll_service
                        .get_sync_state(&token)
                        .await
                        .map(|sync_state| {
                            sync_state.state == wealthfolio_device_sync::SyncState::Ready
                        })
                        .unwrap_or(false)
                    {
                        if let Err(err) =
                            crate::api::device_sync_engine::ensure_background_engine_started(
                                startup_state.clone(),
                            )
                            .await
                        {
                            warn!(
                                "Failed to auto-start device sync background engine: {}",
                                err
                            );
                        }
                    }
                }
                Err(err) => {
                    if is_expected_startup_token_warmup_error(&err) {
                        info!(
                            "Skipping startup device sync token warmup (expected state): {}",
                            err
                        );
                    } else {
                        warn!("Device sync token warmup failed during startup: {}", err);
                    }
                }
            }
        });
    }

    // Start background broker sync scheduler (4-hour interval)
    start_broker_sync_scheduler(state.clone());

    // Start periodic market data sync (6h interval, 2min initial delay)
    let quote_svc = state.quote_service.clone();
    tokio::spawn(async move {
        wealthfolio_core::quotes::scheduler::run_periodic_sync(
            quote_svc,
            std::time::Duration::from_secs(120),
            std::time::Duration::from_secs(6 * 3600),
        )
        .await;
    });
}

#[cfg(all(test, feature = "device-sync"))]
mod tests {
    use super::*;
    use crate::error::ApiError;

    #[test]
    fn startup_token_warmup_treats_unauthorized_as_expected() {
        let err = ApiError::Forbidden("No refresh token configured".to_string());
        assert!(is_expected_startup_token_warmup_error(&err));
    }

    #[test]
    fn startup_token_warmup_treats_missing_config_as_expected() {
        let err = ApiError::Internal(
            "CONNECT_AUTH_URL or CONNECT_AUTH_PUBLISHABLE_KEY is not configured".to_string(),
        );
        assert!(is_expected_startup_token_warmup_error(&err));
    }

    #[test]
    fn startup_token_warmup_treats_unexpected_internal_as_warning_candidate() {
        let err = ApiError::Internal("Upstream refresh timeout".to_string());
        assert!(!is_expected_startup_token_warmup_error(&err));
    }
}
