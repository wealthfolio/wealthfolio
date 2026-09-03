use std::sync::Arc;

use crate::{
    error::{ApiError, ApiResult},
    events::{
        EventBus, MarketSyncResult, ServerEvent, MARKET_SYNC_COMPLETE, MARKET_SYNC_ERROR,
        MARKET_SYNC_START, PORTFOLIO_UPDATE_COMPLETE, PORTFOLIO_UPDATE_ERROR,
        PORTFOLIO_UPDATE_START,
    },
    main_lib::AppState,
};
use anyhow::anyhow;
use chrono::NaiveDate;
use serde_json::json;
use wealthfolio_core::{
    accounts::{account_supports_portfolio_scope, AccountPurpose, AccountServiceTrait},
    health::HealthServiceTrait,
    portfolio::coordinator::{
        run_periodic_consistency, AccountFailure, JobObserver, PortfolioJobRequest, RetryPolicy,
    },
    quotes::{MarketSyncMode, SyncResult},
};

// ============================================================================
// Date Parsing Utilities
// ============================================================================

/// Parse a required date string in YYYY-MM-DD format.
pub fn parse_date(date_str: &str, field_name: &str) -> Result<NaiveDate, ApiError> {
    NaiveDate::parse_from_str(date_str, "%Y-%m-%d")
        .map_err(|e| ApiError::BadRequest(format!("Invalid {}: {}", field_name, e)))
}

/// Parse an optional date string in YYYY-MM-DD format.
pub fn parse_date_optional(
    date_str: Option<String>,
    field_name: &str,
) -> Result<Option<NaiveDate>, ApiError> {
    date_str.map(|s| parse_date(&s, field_name)).transpose()
}

pub fn holdings_account_ids(state: &AppState, account_ids: &[String]) -> ApiResult<Vec<String>> {
    Ok(state
        .account_service
        .get_accounts_by_ids(account_ids)?
        .into_iter()
        .filter(|account| account_supports_portfolio_scope(account, AccountPurpose::Holdings))
        .map(|account| account.id)
        .collect())
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortfolioRequestBody {
    pub account_ids: Option<Vec<String>>,
    #[serde(default)]
    pub market_sync_mode: MarketSyncMode,
    /// Rebuild from the first activity even when the accounts are fresh.
    #[serde(default)]
    pub force_full: bool,
    /// Earliest instant a fact changed, when known.
    #[serde(default)]
    pub earliest_change_at: Option<chrono::DateTime<chrono::Utc>>,
}

impl PortfolioRequestBody {
    pub fn into_config(self) -> PortfolioJobConfig {
        PortfolioJobConfig {
            account_ids: self.account_ids,
            market_sync_mode: self.market_sync_mode,
            force_full: self.force_full,
            earliest_change_at: self.earliest_change_at,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct PortfolioJobConfig {
    pub account_ids: Option<Vec<String>>,
    pub market_sync_mode: MarketSyncMode,
    pub force_full: bool,
    pub earliest_change_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// Enqueue a background portfolio job that will publish SSE events as it runs.
pub fn enqueue_portfolio_job(state: Arc<AppState>, config: PortfolioJobConfig) {
    tokio::spawn(async move {
        if let Err(err) = process_portfolio_job(state, config).await {
            tracing::error!("Portfolio job failed: {}", err);
        }
    });
}

/// Trigger a lightweight portfolio update (no full recalculation) similar to Tauri defaults.
/// Uses MarketSyncMode::None - no market sync, just recalculation.
pub fn trigger_lightweight_portfolio_update(state: Arc<AppState>) {
    enqueue_portfolio_job(
        state,
        PortfolioJobConfig {
            account_ids: None,
            market_sync_mode: MarketSyncMode::None,
            force_full: false,
            earliest_change_at: None,
        },
    );
}

/// Trigger a full portfolio recalculation impacting every account.
/// Uses MarketSyncMode::None - no market sync, just recalculation.
pub fn trigger_full_portfolio_recalc(state: Arc<AppState>) {
    enqueue_portfolio_job(
        state,
        PortfolioJobConfig {
            account_ids: None,
            market_sync_mode: MarketSyncMode::None,
            force_full: false,
            earliest_change_at: None,
        },
    );
}

/// Trigger a full portfolio recalculation that also syncs the given assets'
/// market data. Used when a provider-backed FX pair is added so its real rate
/// is fetched immediately instead of waiting for the periodic sync (#1143).
pub fn trigger_portfolio_recalc_with_asset_sync(state: Arc<AppState>, asset_ids: Vec<String>) {
    enqueue_portfolio_job(
        state,
        PortfolioJobConfig {
            account_ids: None,
            market_sync_mode: MarketSyncMode::Incremental {
                asset_ids: Some(asset_ids),
            },
            ..PortfolioJobConfig::default()
        },
    );
}

/// Server side of a portfolio job: the coordinator does the work, the
/// observer turns its callbacks into SSE events.
pub struct ServerJobObserver {
    event_bus: EventBus,
    health_service: Arc<dyn HealthServiceTrait + Send + Sync>,
}

impl ServerJobObserver {
    pub fn new(state: &AppState) -> Self {
        Self {
            event_bus: state.event_bus.clone(),
            health_service: state.health_service.clone(),
        }
    }

    pub fn with_parts(
        event_bus: EventBus,
        health_service: Arc<dyn HealthServiceTrait + Send + Sync>,
    ) -> Self {
        Self {
            event_bus,
            health_service,
        }
    }

    fn clear_health_cache(&self) {
        let health_service = self.health_service.clone();
        tokio::spawn(async move {
            health_service.clear_cache().await;
        });
    }
}

impl JobObserver for ServerJobObserver {
    fn market_sync_started(&self) {
        self.event_bus.publish(ServerEvent::new(MARKET_SYNC_START));
    }

    fn market_sync_completed(&self, result: &SyncResult) {
        self.clear_health_cache();
        let skipped_reasons: Vec<(String, String)> = result
            .skipped_reasons
            .iter()
            .map(|(asset_id, reason)| (asset_id.clone(), reason.to_string()))
            .collect();
        self.event_bus.publish(ServerEvent::with_payload(
            MARKET_SYNC_COMPLETE,
            json!(MarketSyncResult {
                failed_syncs: result.failures.clone(),
                skipped_reasons,
                show_skipped_reasons: false,
            }),
        ));
    }

    fn market_sync_failed(&self, message: &str) {
        self.event_bus
            .publish(ServerEvent::with_payload(MARKET_SYNC_ERROR, json!(message)));
    }

    fn update_started(&self) {
        self.event_bus
            .publish(ServerEvent::new(PORTFOLIO_UPDATE_START));
    }

    fn update_failed(&self, failure: &AccountFailure) {
        if failure.code == "INVALID_SNAPSHOT_DATE" {
            self.clear_health_cache();
        }
        let payload = if failure.account_id.is_empty() {
            json!(failure.message)
        } else {
            json!(failure)
        };
        self.event_bus
            .publish(ServerEvent::with_payload(PORTFOLIO_UPDATE_ERROR, payload));
    }

    fn update_completed(&self) {
        // Freshness verdicts and stale-projection issues are cached.
        self.clear_health_cache();
        self.event_bus
            .publish(ServerEvent::new(PORTFOLIO_UPDATE_COMPLETE));
    }
}

impl PortfolioJobConfig {
    /// The coordinator request this config describes.
    pub fn into_request(self) -> PortfolioJobRequest {
        PortfolioJobRequest {
            account_ids: self.account_ids,
            market_sync: self.market_sync_mode,
            force_full: self.force_full,
            earliest_change_at: self.earliest_change_at,
        }
    }
}

pub async fn process_portfolio_job(
    state: Arc<AppState>,
    config: PortfolioJobConfig,
) -> ApiResult<()> {
    let observer = ServerJobObserver::new(&state);
    let report = state
        .portfolio_coordinator
        .run_job_with_retry(config.into_request(), &observer, RetryPolicy::default())
        .await
        .map_err(|err| crate::error::ApiError::Anyhow(anyhow!(err.to_string())))?;
    if let Some(Err(message)) = &report.market_sync {
        tracing::error!("Market data sync failed before the rebuild: {message}");
    }
    Ok(())
}

/// One consistency pass (architecture §3.3): sync market data, then rebuild whatever
/// the check finds stale. Requested at server start, by each web client
/// once its event stream is live, and by the periodic scheduler.
pub fn enqueue_consistency_pass(state: Arc<AppState>) {
    tokio::spawn(async move {
        let observer = ServerJobObserver::new(&state);
        state
            .portfolio_coordinator
            .ensure_consistent_or_report(MarketSyncMode::Incremental { asset_ids: None }, &observer)
            .await;
    });
}

/// Periodic market sync plus consistency pass (6h, after a 2min delay).
pub fn spawn_periodic_consistency(state: Arc<AppState>) {
    let observer: Arc<dyn JobObserver> = Arc::new(ServerJobObserver::new(&state));
    tokio::spawn(run_periodic_consistency(
        state.portfolio_coordinator.clone(),
        observer,
        std::time::Duration::from_secs(120),
        std::time::Duration::from_secs(6 * 3600),
    ));
}
