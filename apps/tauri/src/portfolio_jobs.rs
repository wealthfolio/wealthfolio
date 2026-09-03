//! Tauri side of portfolio jobs: the coordinator does the work, this module
//! turns its callbacks into the window events the frontend listens to.

use std::sync::Arc;
use std::time::Duration;

use log::error;
use tauri::{AppHandle, Emitter};
use wealthfolio_core::health::HealthServiceTrait;
use wealthfolio_core::portfolio::coordinator::{
    run_periodic_consistency, AccountFailure, JobObserver, PortfolioJobReport, PortfolioJobRequest,
    RetryPolicy,
};
use wealthfolio_core::quotes::{MarketSyncMode, SyncResult};

use crate::context::ServiceContext;
use crate::events::{
    MarketSyncResult, PortfolioRequestPayload, MARKET_SYNC_COMPLETE, MARKET_SYNC_ERROR,
    MARKET_SYNC_START, PORTFOLIO_UPDATE_COMPLETE, PORTFOLIO_UPDATE_ERROR, PORTFOLIO_UPDATE_START,
};

pub struct TauriJobObserver {
    app_handle: AppHandle,
    context: Arc<ServiceContext>,
}

impl TauriJobObserver {
    pub fn new(app_handle: AppHandle, context: Arc<ServiceContext>) -> Self {
        Self {
            app_handle,
            context,
        }
    }

    fn emit<P: serde::Serialize>(&self, event: &str, payload: &P) {
        if let Err(e) = self.app_handle.emit(event, payload) {
            error!("Failed to emit {} event: {}", event, e);
        }
    }

    fn clear_health_cache(&self) {
        let health_service = self.context.health_service();
        tauri::async_runtime::spawn(async move {
            health_service.clear_cache().await;
        });
    }
}

impl JobObserver for TauriJobObserver {
    fn market_sync_started(&self) {
        self.emit(MARKET_SYNC_START, &());
    }

    fn market_sync_completed(&self, result: &SyncResult) {
        self.clear_health_cache();
        self.emit(
            MARKET_SYNC_COMPLETE,
            &MarketSyncResult {
                failed_syncs: result.failures.clone(),
                skipped_reasons: result
                    .skipped_reasons
                    .iter()
                    .map(|(asset_id, reason)| (asset_id.clone(), reason.to_string()))
                    .collect(),
                show_skipped_reasons: false,
            },
        );
    }

    fn market_sync_failed(&self, message: &str) {
        self.emit(MARKET_SYNC_ERROR, &message.to_string());
    }

    fn update_started(&self) {
        self.emit(PORTFOLIO_UPDATE_START, &());
    }

    fn update_failed(&self, failure: &AccountFailure) {
        if failure.code == "INVALID_SNAPSHOT_DATE" {
            self.clear_health_cache();
        }
        if failure.account_id.is_empty() {
            self.emit(PORTFOLIO_UPDATE_ERROR, &failure.message);
        } else {
            self.emit(PORTFOLIO_UPDATE_ERROR, failure);
        }
    }

    fn update_completed(&self) {
        // Freshness verdicts and stale-projection issues are cached.
        self.clear_health_cache();
        self.emit(PORTFOLIO_UPDATE_COMPLETE, &());
    }
}

/// One portfolio job from a frontend/planner payload.
pub async fn run_portfolio_request(
    app_handle: &AppHandle,
    context: &Arc<ServiceContext>,
    payload: PortfolioRequestPayload,
) -> Option<PortfolioJobReport> {
    let request = PortfolioJobRequest {
        account_ids: payload.account_ids,
        market_sync: payload.market_sync_mode,
        force_full: payload.force_full,
        earliest_change_at: payload.earliest_change_at,
    };
    let observer = TauriJobObserver::new(app_handle.clone(), Arc::clone(context));
    match context
        .portfolio_coordinator()
        .run_job_with_retry(request, &observer, RetryPolicy::default())
        .await
    {
        Ok(report) => Some(report),
        Err(err) => {
            error!("Portfolio job failed: {}", err);
            None
        }
    }
}

/// One consistency pass (architecture §3.3): sync market data, then rebuild whatever
/// the check finds stale. The frontend requests it once its event listeners
/// are live (so no progress event is lost), and the periodic scheduler
/// repeats it.
pub async fn ensure_consistent(app_handle: AppHandle, context: Arc<ServiceContext>) {
    let observer = TauriJobObserver::new(app_handle, Arc::clone(&context));
    context
        .portfolio_coordinator()
        .ensure_consistent_or_report(MarketSyncMode::Incremental { asset_ids: None }, &observer)
        .await;
}

/// Periodic market sync plus consistency pass (6h, after a 2min delay).
pub fn spawn_periodic_consistency(app_handle: AppHandle, context: Arc<ServiceContext>) {
    let observer: Arc<dyn JobObserver> =
        Arc::new(TauriJobObserver::new(app_handle, Arc::clone(&context)));
    tauri::async_runtime::spawn(run_periodic_consistency(
        context.portfolio_coordinator(),
        observer,
        Duration::from_secs(120),
        Duration::from_secs(6 * 3600),
    ));
}
