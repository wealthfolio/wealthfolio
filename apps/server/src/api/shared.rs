use std::sync::Arc;

use crate::{
    error::{ApiError, ApiResult},
    events::{
        MarketSyncResult, ServerEvent, MARKET_SYNC_COMPLETE, MARKET_SYNC_ERROR, MARKET_SYNC_START,
        PORTFOLIO_UPDATE_COMPLETE, PORTFOLIO_UPDATE_ERROR, PORTFOLIO_UPDATE_START,
    },
    main_lib::AppState,
};
use anyhow::anyhow;
use chrono::NaiveDate;
use serde_json::json;
use wealthfolio_core::{
    accounts::{account_supports_portfolio_scope, AccountPurpose, AccountServiceTrait},
    portfolio::{
        snapshot::{reconcile_quote_sync_from_latest_account_snapshots, SnapshotRecalcMode},
        valuation::ValuationRecalcMode,
    },
    quotes::MarketSyncMode,
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
}

impl PortfolioRequestBody {
    pub fn into_config(self, force_full_recalculation: bool) -> PortfolioJobConfig {
        let (snapshot_mode, valuation_mode) = if force_full_recalculation {
            (SnapshotRecalcMode::Full, ValuationRecalcMode::Full)
        } else {
            (
                SnapshotRecalcMode::IncrementalFromLast,
                ValuationRecalcMode::IncrementalFromLast,
            )
        };
        PortfolioJobConfig {
            account_ids: self.account_ids,
            market_sync_mode: self.market_sync_mode,
            snapshot_mode,
            valuation_mode,
            since_date: None,
        }
    }
}

pub struct PortfolioJobConfig {
    pub account_ids: Option<Vec<String>>,
    pub market_sync_mode: MarketSyncMode,
    pub snapshot_mode: SnapshotRecalcMode,
    pub valuation_mode: ValuationRecalcMode,
    pub since_date: Option<NaiveDate>,
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
            snapshot_mode: SnapshotRecalcMode::IncrementalFromLast,
            valuation_mode: ValuationRecalcMode::IncrementalFromLast,
            since_date: None,
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
            snapshot_mode: SnapshotRecalcMode::Full,
            valuation_mode: ValuationRecalcMode::Full,
            since_date: None,
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
            snapshot_mode: SnapshotRecalcMode::Full,
            valuation_mode: ValuationRecalcMode::Full,
            since_date: None,
        },
    );
}

pub async fn process_portfolio_job(
    state: Arc<AppState>,
    config: PortfolioJobConfig,
) -> ApiResult<()> {
    let event_bus = state.event_bus.clone();
    let snapshot_mode = config
        .since_date
        .map(SnapshotRecalcMode::SinceDate)
        .unwrap_or_else(|| config.snapshot_mode.clone());
    let valuation_mode = config
        .since_date
        .map(ValuationRecalcMode::SinceDate)
        .unwrap_or_else(|| config.valuation_mode.clone());

    let accounts_for_scope = state
        .account_service
        .get_non_archived_accounts()
        .map_err(|err| {
            let err_msg = format!("Failed to list non-archived accounts: {}", err);
            event_bus.publish(ServerEvent::with_payload(
                PORTFOLIO_UPDATE_ERROR,
                json!(err_msg),
            ));
            crate::error::ApiError::Anyhow(anyhow!(err_msg))
        })?;

    let account_ids: Vec<String> = if let Some(ref target_ids) = config.account_ids {
        target_ids.clone()
    } else {
        accounts_for_scope.iter().map(|a| a.id.clone()).collect()
    };
    let quote_reconciliation_account_ids: Vec<String> =
        accounts_for_scope.iter().map(|a| a.id.clone()).collect();

    // Only perform market sync if the mode requires it
    if config.market_sync_mode.requires_sync() {
        if let Err(e) = reconcile_quote_sync_from_latest_account_snapshots(
            state.snapshot_service.as_ref(),
            state.quote_service.as_ref(),
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

        // Convert MarketSyncMode to SyncMode for the quote service
        let sync_result = match config.market_sync_mode.to_sync_mode() {
            Some(sync_mode) => state.quote_service.sync(sync_mode, asset_ids).await,
            None => {
                // This shouldn't happen since we checked requires_sync(), but handle gracefully
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
                state.health_service.clear_cache().await;
                if let Err(err) = state.fx_service.initialize() {
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
                return Err(crate::error::ApiError::Anyhow(anyhow!(err_msg)));
            }
        }
    } else {
        tracing::debug!("Skipping market sync (MarketSyncMode::None)");
    }

    event_bus.publish(ServerEvent::new(PORTFOLIO_UPDATE_START));

    if !account_ids.is_empty() {
        let ids_slice = account_ids.as_slice();
        if let Err(err) = state
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
        state.snapshot_service.as_ref(),
        state.quote_service.as_ref(),
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
        if let Err(err) = state
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
    Ok(())
}
