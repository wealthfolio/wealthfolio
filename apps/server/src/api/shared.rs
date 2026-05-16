use std::sync::Arc;

use crate::{
    error::{ApiError, ApiResult},
    events::{
        ServerEvent, MARKET_SYNC_COMPLETE, MARKET_SYNC_ERROR, MARKET_SYNC_START,
        PORTFOLIO_UPDATE_COMPLETE, PORTFOLIO_UPDATE_ERROR, PORTFOLIO_UPDATE_START,
    },
    main_lib::AppState,
};
use anyhow::anyhow;
use chrono::NaiveDate;
use serde_json::json;
use wealthfolio_core::{
    accounts::AccountServiceTrait,
    constants::PORTFOLIO_TOTAL_ACCOUNT_ID,
    portfolio::{
        snapshot::{reconcile_quote_sync_from_latest_total_snapshot, SnapshotRecalcMode},
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

    // Only perform market sync if the mode requires it
    if config.market_sync_mode.requires_sync() {
        if let Err(e) = reconcile_quote_sync_from_latest_total_snapshot(
            state.snapshot_service.as_ref(),
            state.quote_service.as_ref(),
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
                    json!({
                        "failed_syncs": result.failures,
                        "skipped_reasons": skipped_reasons,
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

    // For TOTAL portfolio calculation, use non-archived accounts (ignores is_active)
    let accounts_for_total = state
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

    // Determine which accounts to calculate individual snapshots for:
    // - If specific account_ids provided: process those accounts (even if archived)
    // - Otherwise: process all non-archived accounts
    let mut account_ids: Vec<String> = if let Some(ref target_ids) = config.account_ids {
        // Process the specific requested accounts (even if archived, for their own snapshots)
        target_ids.clone()
    } else {
        // No specific accounts requested - use non-archived accounts
        accounts_for_total.iter().map(|a| a.id.clone()).collect()
    };

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

    if let Err(err) = state
        .snapshot_service
        .recalculate_total_portfolio_snapshots(snapshot_mode)
        .await
    {
        let err_msg = format!("Failed to calculate TOTAL portfolio snapshot: {}", err);
        tracing::error!("{}", err_msg);
        event_bus.publish(ServerEvent::with_payload(
            PORTFOLIO_UPDATE_ERROR,
            json!(err_msg),
        ));
        return Err(crate::error::ApiError::Anyhow(anyhow!(err_msg)));
    }

    // Update position status from TOTAL snapshot for quote sync planning.
    if let Err(e) = reconcile_quote_sync_from_latest_total_snapshot(
        state.snapshot_service.as_ref(),
        state.quote_service.as_ref(),
    )
    .await
    {
        tracing::warn!(
            "Failed to update position status from holdings: {}. Quote sync planning may be affected.",
            e
        );
    }

    if !account_ids
        .iter()
        .any(|id| id == PORTFOLIO_TOTAL_ACCOUNT_ID)
    {
        account_ids.push(PORTFOLIO_TOTAL_ACCOUNT_ID.to_string());
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
