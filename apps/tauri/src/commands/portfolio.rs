use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use crate::{
    context::ServiceContext,
    events::{
        emit_portfolio_trigger_recalculate, emit_portfolio_trigger_update, PortfolioRequestPayload,
    },
};

use chrono::{NaiveDate, Utc};
use log::{debug, info, warn};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use wealthfolio_core::{
    accounts::{
        account_supports_portfolio_scope, account_supports_purpose, Account, AccountPurpose,
        TrackingMode,
    },
    allocation::{AllocationHoldings, PortfolioAllocations},
    holdings::{Holding, HoldingListItem},
    income::IncomeSummary,
    lots::AssetLotView,
    performance::{
        calculate_performance_summary_batch_for_accounts, empty_performance_metrics,
        performance_account_ids_from_map, performance_account_tracking_modes_from_map,
        performance_account_types_from_map, performance_tracking_composition,
        sync_performance_summary_quality, unique_account_ids, DataQualityStatus, PerformanceResult,
        PerformanceSummaryBatchScope, PerformanceSummaryProfile, SimplePerformanceMetrics,
        PERFORMANCE_SUMMARY_BATCH_PARALLELISM,
    },
    portfolio::snapshot::{
        CashBalanceInput, ManualHoldingInput, ManualSnapshotRequest, ManualSnapshotService,
        SnapshotSource,
    },
    portfolios::{AccountScope, ResolvedAccountScope},
    quotes::MarketSyncMode,
    utils::time_utils::{parse_user_timezone_or_default, user_today},
    valuation::{CurrentAccountValuationService, CurrentValuationResponse, DailyAccountValuation},
};

// ============================================================================
// AccountScope IPC boundary struct
// ============================================================================

/// Flat struct that mirrors the TypeScript `AccountScope` discriminated union.
/// Used only at the Tauri IPC boundary because serde internally-tagged enums
/// fail deserialization in Tauri v2 (all variant fields are required simultaneously).
/// The frontend sends `{ type: "account", accountId: "X" }` unchanged — this struct
/// deserializes that format and converts to the internal `AccountScope` enum.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountScopeInput {
    #[serde(rename = "type")]
    pub kind: String,
    pub account_id: Option<String>,
    pub portfolio_id: Option<String>,
    pub account_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceSummaryScopeInput {
    pub account_ids: Vec<String>,
}

impl AccountScopeInput {
    pub fn into_account_filter(self) -> Result<AccountScope, String> {
        match self.kind.as_str() {
            "all" => Ok(AccountScope::All),
            "account" => {
                let id = self
                    .account_id
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| "accountId required for filter type 'account'".to_string())?;
                Ok(AccountScope::Account { account_id: id })
            }
            "portfolio" => {
                let id = self.portfolio_id.filter(|s| !s.is_empty()).ok_or_else(|| {
                    "portfolioId required for filter type 'portfolio'".to_string()
                })?;
                Ok(AccountScope::Portfolio { portfolio_id: id })
            }
            "adHoc" | "accounts" => {
                let ids = self.account_ids.filter(|v| !v.is_empty()).ok_or_else(|| {
                    "accountIds required and must be non-empty for filter type 'accounts'"
                        .to_string()
                })?;
                Ok(AccountScope::Accounts { account_ids: ids })
            }
            other => Err(format!("unknown filter type: '{other}'")),
        }
    }
}

pub(super) fn holdings_account_ids(
    state: &ServiceContext,
    account_ids: &[String],
) -> Result<Vec<String>, String> {
    Ok(state
        .account_service()
        .get_accounts_by_ids(account_ids)
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|account| account_supports_portfolio_scope(account, AccountPurpose::Holdings))
        .map(|account| account.id)
        .collect())
}

fn performance_accounts_by_id(
    state: &ServiceContext,
    account_ids: &[String],
) -> Result<HashMap<String, Account>, String> {
    Ok(state
        .account_service()
        .get_accounts_by_ids(account_ids)
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|account| (account.id.clone(), account))
        .collect())
}

fn income_account_ids(
    state: &ServiceContext,
    account_ids: &[String],
) -> Result<Vec<String>, String> {
    Ok(state
        .account_service()
        .get_accounts_by_ids(account_ids)
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|account| account_supports_purpose(&account.account_type, AccountPurpose::Income))
        .map(|account| account.id)
        .collect())
}

// ============================================================================
// Snapshot Info Types
// ============================================================================

/// Information about a manual/imported snapshot for UI display
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInfo {
    pub id: String,
    pub snapshot_date: String,
    pub source: String,
    pub position_count: usize,
    pub cash_currency_count: usize,
    pub cash_total_account_currency: String,
}

#[tauri::command]
pub async fn recalculate_portfolio(handle: AppHandle) -> Result<(), String> {
    debug!("Emitting PORTFOLIO_TRIGGER_RECALCULATE event...");
    // Full recalculation uses BackfillHistory to rebuild quote history from activity start.
    // This ensures all historical valuations have proper quote coverage.
    // - Fetches quotes from first_activity_date (or 5 years fallback) to today
    // - Then performs a full portfolio recalculation
    let payload = PortfolioRequestPayload::builder()
        .account_ids(None) // None signifies all accounts
        .market_sync_mode(MarketSyncMode::BackfillHistory {
            asset_ids: None,
            days: 365 * 5, // 5 years fallback if no activity dates
        })
        .build();
    emit_portfolio_trigger_recalculate(&handle, payload);
    Ok(())
}

#[tauri::command]
pub async fn update_portfolio(handle: AppHandle) -> Result<(), String> {
    debug!("Emitting PORTFOLIO_TRIGGER_UPDATE event...");
    // Manual update uses Incremental sync for all assets
    let payload = PortfolioRequestPayload::builder()
        .account_ids(None) // None signifies all accounts
        .market_sync_mode(MarketSyncMode::Incremental { asset_ids: None })
        .build();
    emit_portfolio_trigger_update(&handle, payload);
    Ok(())
}

async fn resolve_scope(
    filter: &AccountScope,
    state: &ServiceContext,
) -> Result<ResolvedAccountScope, String> {
    let base_currency = state.get_base_currency();
    state
        .portfolio_service()
        .resolve_account_scope(filter, &base_currency)
        .map_err(|e| e.to_string())
}

async fn resolve_current_valuation_scope(
    filter: &AccountScope,
    state: &ServiceContext,
) -> Result<ResolvedAccountScope, String> {
    let base_currency = state.get_base_currency();
    let resolved = state
        .portfolio_service()
        .resolve_account_scope(filter, &base_currency)
        .map_err(|e| e.to_string())?;

    let account_ids = match filter {
        AccountScope::Account { account_id } => vec![account_id.clone()],
        AccountScope::Accounts { account_ids } => unique_account_ids(account_ids.clone()),
        AccountScope::Portfolio { portfolio_id } => {
            state
                .portfolio_service()
                .get_portfolio(portfolio_id)
                .map_err(|e| e.to_string())?
                .account_ids
        }
        AccountScope::All => resolved.account_ids.clone(),
    };

    Ok(ResolvedAccountScope {
        account_ids,
        ..resolved
    })
}

#[tauri::command]
pub async fn get_holdings(
    state: State<'_, Arc<ServiceContext>>,
    filter: AccountScopeInput,
) -> Result<Vec<Holding>, String> {
    debug!("Get holdings...");
    let filter = filter.into_account_filter()?;
    get_holdings_for_filter(state.inner().as_ref(), filter).await
}

#[tauri::command]
pub async fn get_holdings_list(
    state: State<'_, Arc<ServiceContext>>,
    filter: AccountScopeInput,
) -> Result<Vec<HoldingListItem>, String> {
    debug!("Get holdings list...");
    let filter = filter.into_account_filter()?;
    let holdings = get_holdings_for_filter(state.inner().as_ref(), filter).await?;
    Ok(holdings.into_iter().map(HoldingListItem::from).collect())
}

async fn get_holdings_for_filter(
    state: &ServiceContext,
    filter: AccountScope,
) -> Result<Vec<Holding>, String> {
    let base_currency = state.get_base_currency();
    let resolved = resolve_scope(&filter, state).await?;
    let account_ids = holdings_account_ids(state, &resolved.account_ids)?;
    if account_ids.is_empty() {
        return Ok(Vec::new());
    }
    if account_ids.len() == 1 {
        state
            .holdings_service()
            .get_holdings(&account_ids[0], &base_currency)
            .await
            .map_err(|e| e.to_string())
    } else {
        state
            .holdings_service()
            .get_holdings_for_accounts(&account_ids, &base_currency, &resolved.scope_id)
            .await
            .map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn get_holding(
    state: State<'_, Arc<ServiceContext>>,
    account_id: String,
    asset_id: String,
) -> Result<Option<Holding>, String> {
    debug!(
        "Get specific holding for asset {} in account {}",
        asset_id, account_id
    );
    let base_currency = state.get_base_currency();
    state
        .holdings_service()
        .get_holding(&account_id, &asset_id, &base_currency)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_asset_holdings(
    state: State<'_, Arc<ServiceContext>>,
    asset_id: String,
) -> Result<Vec<Holding>, String> {
    debug!("Get holdings for asset {} across all accounts", asset_id);
    let base_currency = state.get_base_currency();
    let accounts = state
        .account_service()
        .get_active_accounts()
        .map_err(|e| format!("Failed to get accounts: {}", e))?;

    let mut result = Vec::new();
    for account in accounts {
        if !account_supports_purpose(&account.account_type, AccountPurpose::Holdings) {
            continue;
        }
        if let Ok(Some(holding)) = state
            .holdings_service()
            .get_holding(&account.id, &asset_id, &base_currency)
            .await
        {
            result.push(holding);
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn get_asset_lots(
    state: State<'_, Arc<ServiceContext>>,
    asset_id: String,
    include_snapshot_positions: bool,
) -> Result<Vec<AssetLotView>, String> {
    debug!("Get lot view rows for asset {}", asset_id);
    state
        .lots_repository
        .get_asset_lot_view(&asset_id, include_snapshot_positions)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_portfolio_allocations(
    state: State<'_, Arc<ServiceContext>>,
    filter: AccountScopeInput,
) -> Result<PortfolioAllocations, String> {
    let base_currency = state.get_base_currency();
    let filter = filter.into_account_filter()?;
    let resolved = resolve_scope(&filter, &state).await?;
    let account_ids = holdings_account_ids(&state, &resolved.account_ids)?;
    if account_ids.len() == 1 {
        state
            .allocation_service()
            .get_portfolio_allocations(&account_ids[0], &base_currency)
            .await
            .map_err(|e| e.to_string())
    } else {
        state
            .allocation_service()
            .get_portfolio_allocations_for_accounts(
                &account_ids,
                &base_currency,
                &resolved.scope_id,
            )
            .await
            .map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn get_holdings_by_allocation(
    state: State<'_, Arc<ServiceContext>>,
    filter: AccountScopeInput,
    taxonomy_id: String,
    category_id: String,
) -> Result<AllocationHoldings, String> {
    let base_currency = state.get_base_currency();
    let filter = filter.into_account_filter()?;
    let resolved = resolve_scope(&filter, &state).await?;
    let account_ids = holdings_account_ids(&state, &resolved.account_ids)?;
    if account_ids.len() == 1 {
        state
            .allocation_service()
            .get_holdings_by_allocation(&account_ids[0], &base_currency, &taxonomy_id, &category_id)
            .await
            .map_err(|e| e.to_string())
    } else {
        state
            .allocation_service()
            .get_holdings_by_allocation_for_accounts(
                &account_ids,
                &base_currency,
                &taxonomy_id,
                &category_id,
                &resolved.scope_id,
            )
            .await
            .map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn get_historical_valuations(
    state: State<'_, Arc<ServiceContext>>,
    account_id: Option<String>,
    filter: Option<AccountScopeInput>,
    start_date: Option<String>,
    end_date: Option<String>,
) -> Result<Vec<DailyAccountValuation>, String> {
    let started_at = Instant::now();
    let debug_scope = log::log_enabled!(log::Level::Debug)
        .then(|| (format!("{:?}", account_id), format!("{:?}", filter)));
    debug!(
        "Get historical valuations for account: {:?}, filter: {:?}",
        account_id, filter
    );
    //     // Parse optional dates into Option<NaiveDate>
    let from_date_opt: Option<chrono::NaiveDate> = start_date
        .map(|date_str| {
            chrono::NaiveDate::parse_from_str(&date_str, "%Y-%m-%d")
                .map_err(|e| format!("Invalid start date: {}", e))
        })
        .transpose()?;

    let to_date_opt: Option<chrono::NaiveDate> = end_date
        .map(|date_str| {
            chrono::NaiveDate::parse_from_str(&date_str, "%Y-%m-%d")
                .map_err(|e| format!("Invalid end date: {}", e))
        })
        .transpose()?;

    let result = if let Some(input) = filter {
        let base_currency = state.get_base_currency();
        let account_filter = input.into_account_filter()?;
        let resolved = state
            .portfolio_service()
            .resolve_account_scope(&account_filter, &base_currency)
            .map_err(|e| e.to_string())?;
        let account_ids = holdings_account_ids(state.inner().as_ref(), &resolved.account_ids)?;
        if account_ids.is_empty() {
            Ok(Vec::new())
        } else if account_ids.len() == 1 {
            state
                .valuation_service()
                .get_historical_valuations(&account_ids[0], from_date_opt, to_date_opt)
                .map_err(|e| e.to_string())
        } else {
            state
                .valuation_service()
                .get_historical_valuation_totals_for_accounts(
                    &resolved.scope_id,
                    &account_ids,
                    &resolved.base_currency,
                    from_date_opt,
                    to_date_opt,
                )
                .map_err(|e| e.to_string())
        }
    } else if let Some(account_id) = account_id {
        let account_ids =
            holdings_account_ids(state.inner().as_ref(), std::slice::from_ref(&account_id))?;
        if account_ids.is_empty() {
            return Ok(Vec::new());
        }
        state
            .valuation_service()
            .get_historical_valuations(&account_id, from_date_opt, to_date_opt)
            .map_err(|e| e.to_string())
    } else {
        let base_currency = state.get_base_currency();
        let resolved = state
            .portfolio_service()
            .resolve_account_scope(&AccountScope::All, &base_currency)
            .map_err(|e| e.to_string())?;
        let account_ids = holdings_account_ids(state.inner().as_ref(), &resolved.account_ids)?;
        if account_ids.is_empty() {
            return Ok(Vec::new());
        }
        state
            .valuation_service()
            .get_historical_valuation_totals_for_accounts(
                &resolved.scope_id,
                &account_ids,
                &resolved.base_currency,
                from_date_opt,
                to_date_opt,
            )
            .map_err(|e| e.to_string())
    };

    if let Some((account_debug, filter_debug)) = debug_scope {
        debug!(
            "Historical valuations timing: account={}, filter={}, rows={}, elapsed_ms={:.1}",
            account_debug,
            filter_debug,
            result.as_ref().map(Vec::len).unwrap_or_default(),
            started_at.elapsed().as_secs_f64() * 1000.0,
        );
    }
    result
}

#[tauri::command]
pub async fn get_latest_valuations(
    state: State<'_, Arc<ServiceContext>>,
    account_ids: Vec<String>,
) -> Result<Vec<DailyAccountValuation>, String> {
    debug!("Get latest valuations for accounts: {:?}", account_ids);

    let ids_to_process: Vec<String> = if account_ids.is_empty() {
        debug!("Input account_ids is empty, fetching active accounts for latest valuations.");
        let active_ids = state
            .account_service()
            .get_active_accounts()
            .map_err(|e| format!("Failed to fetch active accounts: {}", e))?
            .into_iter()
            .map(|acc| acc.id)
            .collect::<Vec<_>>();
        holdings_account_ids(state.inner().as_ref(), &active_ids)?
    } else {
        holdings_account_ids(state.inner().as_ref(), &account_ids)?
    };

    if ids_to_process.is_empty() {
        return Ok(Vec::new());
    }

    state
        .valuation_service()
        .get_latest_valuations(&ids_to_process)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_current_valuation(
    state: State<'_, Arc<ServiceContext>>,
    filter: AccountScopeInput,
    include_accounts: Option<bool>,
) -> Result<CurrentValuationResponse, String> {
    debug!("Get scoped current valuation...");

    let base_currency = state.get_base_currency();
    let timezone = state.get_timezone();
    let latest_snapshot_cutoff = user_today(parse_user_timezone_or_default(&timezone));
    let account_filter = filter.into_account_filter()?;
    let resolved = resolve_current_valuation_scope(&account_filter, &state).await?;
    let account_service = state.account_service();
    let snapshot_repository = state.snapshot_repository();
    let asset_service = state.asset_service();
    let quote_service = state.quote_service();
    let fx_service = state.fx_service();
    let service = CurrentAccountValuationService::new(
        account_service.as_ref(),
        snapshot_repository.as_ref(),
        asset_service.as_ref(),
        quote_service.as_ref(),
        fx_service.as_ref(),
    );

    service
        .get_current_valuation_for_scope(
            &resolved.scope_id,
            &resolved.account_ids,
            &base_currency,
            latest_snapshot_cutoff,
            include_accounts.unwrap_or(false),
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_income_summary(
    state: State<'_, Arc<ServiceContext>>,
    filter: Option<AccountScopeInput>,
) -> Result<Vec<IncomeSummary>, String> {
    debug!("Fetching income summary...");
    let account_ids: Vec<String> = if let Some(input) = filter {
        let af = input.into_account_filter()?;
        let resolved = resolve_scope(&af, &state).await?;
        income_account_ids(&state, &resolved.account_ids)?
    } else {
        state
            .account_service()
            .get_active_accounts()
            .map_err(|e| format!("Failed to fetch active accounts: {}", e))?
            .into_iter()
            .filter(|account| {
                account_supports_purpose(&account.account_type, AccountPurpose::Income)
            })
            .map(|account| account.id)
            .collect()
    };
    if account_ids.is_empty() {
        return Ok(Vec::new());
    }
    state
        .income_service()
        .get_income_summary(Some(&account_ids))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn calculate_accounts_simple_performance(
    state: State<'_, Arc<ServiceContext>>,
    account_ids: Vec<String>,
) -> Result<Vec<SimplePerformanceMetrics>, String> {
    debug!(
        "Calculate simple performance for accounts: {:?}",
        account_ids
    );

    let ids_to_process: Vec<String> = if account_ids.is_empty() {
        Vec::new()
    } else {
        let requested = state
            .account_service()
            .get_accounts_by_ids(&account_ids)
            .map_err(|e| format!("Failed to fetch accounts: {}", e))?;
        requested
            .into_iter()
            .filter(|account| {
                account_supports_portfolio_scope(account, AccountPurpose::Performance)
            })
            .map(|acc| acc.id)
            .collect()
    };

    if ids_to_process.is_empty() {
        return Ok(Vec::new());
    }

    state
        .performance_service()
        .calculate_accounts_simple_performance(&ids_to_process) // Pass the potentially modified list
        .map_err(|e| e.to_string())
}

/// Calculates performance history for a given item (account or symbol) over a given date range.
/// return performance metrics for the item and also the cumulative performance metrics for all days.
/// tracking_mode: Optional tracking mode for the account ("HOLDINGS" or "TRANSACTIONS")
#[tauri::command]
pub async fn calculate_performance_history(
    state: State<'_, Arc<ServiceContext>>,
    item_type: String,
    item_id: String,
    start_date: Option<String>,
    end_date: Option<String>,
    tracking_mode: Option<String>,
    filter: Option<AccountScopeInput>,
) -> Result<PerformanceResult, String> {
    debug!(
        "Calculating performance for type: {}, id: {}, start: {:?}, end: {:?}, tracking_mode: {:?}",
        item_type, item_id, start_date, end_date, tracking_mode
    );

    // Parse optional dates into Option<NaiveDate>
    let start_date_opt: Option<chrono::NaiveDate> = start_date
        .map(|date_str| {
            chrono::NaiveDate::parse_from_str(&date_str, "%Y-%m-%d")
                .map_err(|e| format!("Invalid start date format '{}': {}", date_str, e))
        })
        .transpose()?;

    let end_date_opt: Option<chrono::NaiveDate> = end_date
        .map(|date_str| {
            chrono::NaiveDate::parse_from_str(&date_str, "%Y-%m-%d")
                .map_err(|e| format!("Invalid end date format '{}': {}", date_str, e))
        })
        .transpose()?;

    // Parse tracking mode
    let tracking_mode_opt = tracking_mode.and_then(|mode| match mode.as_str() {
        "HOLDINGS" => Some(TrackingMode::Holdings),
        "TRANSACTIONS" => Some(TrackingMode::Transactions),
        _ => None,
    });
    if let (true, Some(filter)) = (item_type == "account", filter) {
        let base_currency = state.get_base_currency();
        let account_filter = filter.into_account_filter()?;
        let resolved = state
            .portfolio_service()
            .resolve_account_scope(&account_filter, &base_currency)
            .map_err(|e| e.to_string())?;
        let accounts_by_id =
            performance_accounts_by_id(state.inner().as_ref(), &resolved.account_ids)?;
        let account_ids = performance_account_ids_from_map(&accounts_by_id, &resolved.account_ids);
        if account_ids.is_empty() {
            let mut result = empty_performance_metrics(
                &resolved.scope_id,
                resolved.base_currency.clone(),
                start_date_opt,
                end_date_opt,
            );
            if !resolved.account_ids.is_empty() {
                result.data_quality.warnings.push(
                    "Requested accounts were excluded because they are archived or not eligible for performance."
                        .to_string(),
                );
                sync_performance_summary_quality(&mut result);
            }
            return Ok(result);
        }
        let tracking_modes =
            performance_account_tracking_modes_from_map(&accounts_by_id, &account_ids);
        let account_types = performance_account_types_from_map(&accounts_by_id, &account_ids);
        let mut result = state
            .performance_service()
            .calculate_performance_history_for_accounts(
                &resolved.scope_id,
                &account_ids,
                &resolved.base_currency,
                &tracking_modes,
                &account_types,
                start_date_opt,
                end_date_opt,
            )
            .await
            .map_err(|e| format!("Failed to calculate performance: {}", e))?;
        if account_ids.len() != resolved.account_ids.len() {
            result.data_quality.warnings.push(
                "Some requested accounts were excluded because they are archived or not eligible for performance."
                    .to_string(),
            );
            result.data_quality.status = DataQualityStatus::Partial;
            sync_performance_summary_quality(&mut result);
        }
        Ok(result)
    } else {
        let (authoritative_tracking_mode, authoritative_account_type) = if item_type == "account" {
            let account = state
                .account_service()
                .get_account(&item_id)
                .map_err(|e| format!("Failed to fetch account: {}", e))?;
            if !account_supports_portfolio_scope(&account, AccountPurpose::Performance) {
                return Ok(empty_performance_metrics(
                    &item_id,
                    account.currency,
                    start_date_opt,
                    end_date_opt,
                ));
            }
            (Some(account.tracking_mode), Some(account.account_type))
        } else {
            (tracking_mode_opt, None)
        };

        state
            .performance_service()
            .calculate_performance_history(
                &item_type,
                &item_id,
                start_date_opt,
                end_date_opt,
                authoritative_tracking_mode,
                authoritative_account_type.as_deref(),
            )
            .await
            .map_err(|e| format!("Failed to calculate performance: {}", e))
    }
}

/// Calculates performance summary for a given item (account or symbol) over a given date range.
/// return performance metrics for the item.
/// tracking_mode: Optional tracking mode for the account ("HOLDINGS" or "TRANSACTIONS")
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn calculate_performance_summary(
    state: State<'_, Arc<ServiceContext>>,
    item_type: String,
    item_id: String,
    start_date: Option<String>,
    end_date: Option<String>,
    tracking_mode: Option<String>,
    filter: Option<AccountScopeInput>,
    profile: Option<PerformanceSummaryProfile>,
) -> Result<PerformanceResult, String> {
    debug!(
        "Calculating performance summary for type: {}, id: {}, start: {:?}, end: {:?}, tracking_mode: {:?}",
        item_type, item_id, start_date, end_date, tracking_mode
    );

    // Parse optional dates into Option<NaiveDate>
    let start_date_opt: Option<chrono::NaiveDate> = start_date
        .map(|date_str| {
            chrono::NaiveDate::parse_from_str(&date_str, "%Y-%m-%d")
                .map_err(|e| format!("Invalid start date format '{}': {}", date_str, e))
        })
        .transpose()?;

    let end_date_opt: Option<chrono::NaiveDate> = end_date
        .map(|date_str| {
            chrono::NaiveDate::parse_from_str(&date_str, "%Y-%m-%d")
                .map_err(|e| format!("Invalid end date format '{}': {}", date_str, e))
        })
        .transpose()?;

    // Parse tracking mode
    let tracking_mode_opt = tracking_mode.and_then(|mode| match mode.as_str() {
        "HOLDINGS" => Some(TrackingMode::Holdings),
        "TRANSACTIONS" => Some(TrackingMode::Transactions),
        _ => None,
    });
    let profile = profile.unwrap_or_default();
    let summary_start = Instant::now();

    if let (true, Some(filter)) = (item_type == "account", filter) {
        let base_currency = state.get_base_currency();
        let account_filter = filter.into_account_filter()?;
        let resolved = state
            .portfolio_service()
            .resolve_account_scope(&account_filter, &base_currency)
            .map_err(|e| e.to_string())?;
        let accounts_by_id =
            performance_accounts_by_id(state.inner().as_ref(), &resolved.account_ids)?;
        let account_ids = performance_account_ids_from_map(&accounts_by_id, &resolved.account_ids);
        if account_ids.is_empty() {
            let mut result = empty_performance_metrics(
                &resolved.scope_id,
                resolved.base_currency.clone(),
                start_date_opt,
                end_date_opt,
            );
            if !resolved.account_ids.is_empty() {
                result.data_quality.warnings.push(
                    "Requested accounts were excluded because they are archived or not eligible for performance."
                        .to_string(),
                );
                sync_performance_summary_quality(&mut result);
            }
            return Ok(result);
        }
        let tracking_modes =
            performance_account_tracking_modes_from_map(&accounts_by_id, &account_ids);
        let account_types = performance_account_types_from_map(&accounts_by_id, &account_ids);
        let tracking_composition = performance_tracking_composition(&tracking_modes, &account_ids);
        let performance_service = state.performance_service();
        let handle = tokio::runtime::Handle::current();
        let scope_id_for_task = resolved.scope_id.clone();
        let base_currency_for_task = resolved.base_currency.clone();
        let account_ids_for_task = account_ids.clone();
        let tracking_modes_for_task = tracking_modes.clone();
        let account_types_for_task = account_types.clone();
        let mut result = tokio::task::spawn_blocking(move || {
            handle.block_on(async move {
                performance_service
                    .calculate_performance_summary_for_accounts(
                        &scope_id_for_task,
                        &account_ids_for_task,
                        &base_currency_for_task,
                        &tracking_modes_for_task,
                        &account_types_for_task,
                        start_date_opt,
                        end_date_opt,
                        profile,
                    )
                    .await
            })
        })
        .await
        .map_err(|e| {
            format!(
                "Failed to join performance summary calculation for {}: {}",
                resolved.scope_id, e
            )
        })?
        .map_err(|e| format!("Failed to calculate performance: {}", e))?;
        debug!(
            "Performance summary timing: item_type={}, scope_id={}, profile={:?}, account_count={}, tracking_composition={}, start={:?}, end={:?}, elapsed_ms={:.1}",
            item_type,
            resolved.scope_id,
            profile,
            account_ids.len(),
            tracking_composition,
            start_date_opt,
            end_date_opt,
            summary_start.elapsed().as_secs_f64() * 1000.0
        );
        if account_ids.len() != resolved.account_ids.len() {
            result.data_quality.warnings.push(
                "Some requested accounts were excluded because they are archived or not eligible for performance."
                    .to_string(),
            );
            result.data_quality.status = DataQualityStatus::Partial;
            sync_performance_summary_quality(&mut result);
        }
        Ok(result)
    } else {
        let (authoritative_tracking_mode, authoritative_account_type) = if item_type == "account" {
            let account = state
                .account_service()
                .get_account(&item_id)
                .map_err(|e| format!("Failed to fetch account: {}", e))?;
            if !account_supports_portfolio_scope(&account, AccountPurpose::Performance) {
                return Ok(empty_performance_metrics(
                    &item_id,
                    account.currency,
                    start_date_opt,
                    end_date_opt,
                ));
            }
            (Some(account.tracking_mode), Some(account.account_type))
        } else {
            (tracking_mode_opt, None)
        };

        let result = state
            .performance_service()
            .calculate_performance_summary(
                &item_type,
                &item_id,
                start_date_opt,
                end_date_opt,
                authoritative_tracking_mode,
                authoritative_account_type.as_deref(),
                profile,
            )
            .await
            .map_err(|e| format!("Failed to calculate performance: {}", e))?;
        debug!(
            "Performance summary timing: item_type={}, item_id={}, profile={:?}, tracking_mode={:?}, start={:?}, end={:?}, elapsed_ms={:.1}",
            item_type,
            item_id,
            profile,
            authoritative_tracking_mode,
            start_date_opt,
            end_date_opt,
            summary_start.elapsed().as_secs_f64() * 1000.0
        );
        Ok(result)
    }
}

#[tauri::command]
pub async fn get_performance_summaries(
    state: State<'_, Arc<ServiceContext>>,
    scopes: Vec<PerformanceSummaryScopeInput>,
    start_date: Option<String>,
    end_date: Option<String>,
    profile: Option<PerformanceSummaryProfile>,
) -> Result<HashMap<String, PerformanceResult>, String> {
    let start_date_opt: Option<chrono::NaiveDate> = start_date
        .map(|date_str| {
            chrono::NaiveDate::parse_from_str(&date_str, "%Y-%m-%d")
                .map_err(|e| format!("Invalid start date format '{}': {}", date_str, e))
        })
        .transpose()?;

    let end_date_opt: Option<chrono::NaiveDate> = end_date
        .map(|date_str| {
            chrono::NaiveDate::parse_from_str(&date_str, "%Y-%m-%d")
                .map_err(|e| format!("Invalid end date format '{}': {}", date_str, e))
        })
        .transpose()?;

    let base_currency = state.get_base_currency();
    let profile = profile.unwrap_or_default();
    let requested_account_ids = unique_account_ids(
        scopes
            .iter()
            .flat_map(|scope| scope.account_ids.iter().cloned()),
    );
    let accounts_by_id =
        performance_accounts_by_id(state.inner().as_ref(), &requested_account_ids)?;
    let batch_scopes = scopes
        .into_iter()
        .map(|scope| PerformanceSummaryBatchScope {
            account_ids: scope.account_ids,
        })
        .collect();
    let performance_service = state.performance_service();
    let batch = calculate_performance_summary_batch_for_accounts(
        performance_service,
        batch_scopes,
        accounts_by_id,
        base_currency,
        start_date_opt,
        end_date_opt,
        profile,
    )
    .await;

    for timing in &batch.scope_timings {
        if timing.skipped {
            debug!(
                "Performance summaries scope timing: index={}/{}, key={}, profile={:?}, requested_accounts={}, eligible_accounts=0, tracking_composition=none, skipped=true, elapsed_ms={:.1}",
                timing.index,
                timing.total,
                timing.key,
                profile,
                timing.requested_accounts,
                timing.elapsed_ms
            );
        } else if timing.failed {
            debug!(
                "Performance summaries scope timing: index={}/{}, key={}, profile={:?}, requested_accounts={}, eligible_accounts={}, tracking_composition={}, failed=true, elapsed_ms={:.1}",
                timing.index,
                timing.total,
                timing.key,
                profile,
                timing.requested_accounts,
                timing.eligible_accounts,
                timing.tracking_composition,
                timing.elapsed_ms
            );
        } else {
            debug!(
                "Performance summaries scope timing: index={}/{}, key={}, profile={:?}, requested_accounts={}, eligible_accounts={}, tracking_composition={}, warnings={}, elapsed_ms={:.1}",
                timing.index,
                timing.total,
                timing.key,
                profile,
                timing.requested_accounts,
                timing.eligible_accounts,
                timing.tracking_composition,
                timing.warnings,
                timing.elapsed_ms
            );
        }
    }

    debug!(
        "Performance summaries batch timing: profile={:?}, scopes={}, parallelism={}, unique_requested_accounts={}, result_count={}, failed_scopes={}, start={:?}, end={:?}, elapsed_ms={:.1}",
        profile,
        batch.scope_timings.len(),
        PERFORMANCE_SUMMARY_BATCH_PARALLELISM,
        requested_account_ids.len(),
        batch.results.len(),
        batch.failed_scope_count,
        start_date_opt,
        end_date_opt,
        batch.elapsed_ms
    );

    Ok(batch.results)
}

/// Input for a single holding when saving manual holdings
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HoldingInput {
    /// For existing holdings, pass the known asset ID directly (preferred)
    pub asset_id: Option<String>,
    /// Symbol (e.g., "AAPL", "META.TO") - used when asset_id is not provided
    pub symbol: String,
    pub quantity: String,
    pub currency: String,
    pub average_cost: Option<String>,
    /// Exchange MIC code for new holdings (e.g., "XNAS", "XTSE"). Used when asset_id is not provided.
    pub exchange_mic: Option<String>,
    /// Quote currency resolved during search/review (e.g., GBp)
    pub quote_ccy: Option<String>,
    /// Instrument type resolved during search/review (e.g., EQUITY, CRYPTO)
    pub instrument_type: Option<String>,
    /// Market data provider that resolved this holding, if selected.
    pub provider_id: Option<String>,
    /// Provider-native symbol/code selected by search/import.
    pub provider_symbol: Option<String>,
    /// Asset name for new custom assets
    pub name: Option<String>,
    /// Data source (e.g., "MANUAL" for custom assets) — sets quote mode to manual
    pub data_source: Option<String>,
    /// Asset kind (e.g., "INVESTMENT", "OTHER")
    pub asset_kind: Option<String>,
}

/// Saves manual holdings for a HOLDINGS-mode account.
/// Creates or updates a snapshot for the specified date with the given holdings and cash balances.
/// Ensures assets and FX pairs are created before saving, following the same pattern as activities.
#[tauri::command]
pub async fn save_manual_holdings(
    state: State<'_, Arc<ServiceContext>>,
    handle: AppHandle,
    account_id: String,
    holdings: Vec<HoldingInput>,
    cash_balances: HashMap<String, String>,
    snapshot_date: Option<String>,
) -> Result<(), String> {
    debug!(
        "Saving manual holdings for account {}: {} holdings, {} cash balances",
        account_id,
        holdings.len(),
        cash_balances.len()
    );

    // Get the account to verify it exists and get its currency
    let account = state
        .account_service()
        .get_account(&account_id)
        .map_err(|e| format!("Failed to get account: {}", e))?;

    // Get base currency for FX pair registration
    let base_currency = state.get_base_currency();

    // Parse the snapshot date or use today
    let date = match snapshot_date {
        Some(date_str) => chrono::NaiveDate::parse_from_str(&date_str, "%Y-%m-%d")
            .map_err(|e| format!("Invalid date format: {}", e))?,
        None => Utc::now().naive_utc().date(),
    };

    let mut positions: Vec<ManualHoldingInput> = Vec::new();
    for holding in holdings {
        let quantity = holding
            .quantity
            .parse::<Decimal>()
            .map_err(|e| format!("Invalid quantity for {}: {}", holding.symbol, e))?;

        // Parse average cost if provided
        let average_cost = match &holding.average_cost {
            Some(cost_str) if !cost_str.is_empty() => cost_str
                .parse::<Decimal>()
                .map_err(|e| format!("Invalid average cost for {}: {}", holding.symbol, e))?,
            _ => Decimal::ZERO,
        };

        positions.push(ManualHoldingInput {
            asset_id: holding.asset_id,
            symbol: holding.symbol,
            exchange_mic: holding.exchange_mic,
            quantity,
            currency: holding.currency,
            average_cost,
            name: holding.name,
            data_source: holding.data_source,
            asset_kind: holding.asset_kind,
            quote_ccy: holding.quote_ccy,
            instrument_type: holding.instrument_type,
            provider_id: holding.provider_id,
            provider_symbol: holding.provider_symbol,
        });
    }

    let mut cash_balances_input: Vec<CashBalanceInput> = Vec::new();
    for (currency, amount_str) in cash_balances {
        let amount = amount_str
            .parse::<Decimal>()
            .map_err(|e| format!("Invalid cash amount for {}: {}", currency, e))?;
        cash_balances_input.push(CashBalanceInput { currency, amount });
    }

    let manual_snapshot_service = ManualSnapshotService::new(
        state.asset_service(),
        state.fx_service(),
        state.snapshot_service(),
        state.quote_service(),
    );

    let asset_ids = manual_snapshot_service
        .save_manual_snapshot(ManualSnapshotRequest {
            account_id: account_id.clone(),
            account_currency: account.currency.clone(),
            snapshot_date: date,
            positions,
            cash_balances: cash_balances_input,
            base_currency: Some(base_currency.clone()),
            source: SnapshotSource::ManualEntry,
        })
        .await
        .map_err(|e| format!("Failed to save manual snapshot: {}", e))?;

    info!(
        "Saved manual holdings for account {} on date {} with {} assets",
        account_id,
        date,
        asset_ids.len()
    );

    // Trigger portfolio update to recalculate valuations from the new snapshot
    // Pass specific asset IDs to ensure quotes are fetched for the new holdings
    let payload = PortfolioRequestPayload::builder()
        .account_ids(Some(vec![account_id.clone()]))
        .market_sync_mode(MarketSyncMode::Incremental {
            asset_ids: if asset_ids.is_empty() {
                None
            } else {
                Some(asset_ids)
            },
        })
        .build();
    emit_portfolio_trigger_recalculate(&handle, payload);

    Ok(())
}

// ============================================================================
// Holdings Import Check Types and Command
// ============================================================================

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolCheckResult {
    pub symbol: String,
    pub found: bool,
    pub asset_name: Option<String>,
    pub asset_id: Option<String>,
    pub currency: Option<String>,
    pub exchange_mic: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckHoldingsImportResult {
    pub existing_dates: Vec<String>,
    pub symbols: Vec<SymbolCheckResult>,
    pub validation_errors: Vec<String>,
}

#[tauri::command]
pub async fn check_holdings_import(
    state: State<'_, Arc<ServiceContext>>,
    account_id: String,
    snapshots: Vec<HoldingsSnapshotInput>,
) -> Result<CheckHoldingsImportResult, String> {
    debug!(
        "Checking {} holdings snapshots for account {}",
        snapshots.len(),
        account_id
    );

    // Verify account exists
    state
        .account_service()
        .get_account(&account_id)
        .map_err(|e| format!("Failed to get account: {}", e))?;

    let mut validation_errors: Vec<String> = Vec::new();
    let mut valid_dates: Vec<NaiveDate> = Vec::new();
    let mut unique_symbols: std::collections::HashSet<String> = std::collections::HashSet::new();

    for snapshot in &snapshots {
        // Validate date
        match NaiveDate::parse_from_str(&snapshot.date, "%Y-%m-%d") {
            Ok(d) => valid_dates.push(d),
            Err(_) => {
                validation_errors.push(format!("Invalid date format: '{}'", snapshot.date));
                continue;
            }
        }

        // Validate positions
        for pos in &snapshot.positions {
            if pos.symbol.trim().is_empty() {
                validation_errors.push(format!("Date {}: empty symbol found", snapshot.date));
            }
            if pos.quantity.parse::<Decimal>().is_err() {
                validation_errors.push(format!(
                    "Date {}: invalid quantity '{}' for {}",
                    snapshot.date, pos.quantity, pos.symbol
                ));
            }
            if let Some(ref c) = pos.avg_cost {
                if !c.is_empty() && c.parse::<Decimal>().is_err() {
                    validation_errors.push(format!(
                        "Date {}: invalid avg cost '{}' for {}",
                        snapshot.date, c, pos.symbol
                    ));
                }
            }
            unique_symbols.insert(pos.symbol.to_uppercase());
        }
    }

    // Check existing snapshots
    let existing_dates = if !valid_dates.is_empty() {
        let min_date = *valid_dates.iter().min().unwrap();
        let max_date = *valid_dates.iter().max().unwrap();
        let existing = state
            .snapshot_service()
            .get_holdings_keyframes(&account_id, Some(min_date), Some(max_date))
            .map_err(|e| format!("Failed to query snapshots: {}", e))?;

        let import_dates: std::collections::HashSet<NaiveDate> = valid_dates.into_iter().collect();
        existing
            .into_iter()
            .filter(|s| import_dates.contains(&s.snapshot_date))
            .map(|s| s.snapshot_date.format("%Y-%m-%d").to_string())
            .collect()
    } else {
        Vec::new()
    };

    // Symbol lookup: search DB first, then market data providers (like activity import)
    let mut symbols: Vec<SymbolCheckResult> = Vec::new();
    for sym in unique_symbols {
        let results = state
            .quote_service()
            .search_symbol_with_currency(&sym, None)
            .await
            .unwrap_or_default();

        if let Some(hit) = results.first() {
            symbols.push(SymbolCheckResult {
                symbol: sym,
                found: true,
                asset_name: Some(hit.long_name.clone()),
                asset_id: hit.existing_asset_id.clone(),
                currency: hit.currency.clone(),
                exchange_mic: hit.exchange_mic.clone(),
            });
        } else {
            symbols.push(SymbolCheckResult {
                symbol: sym,
                found: false,
                asset_name: None,
                asset_id: None,
                currency: None,
                exchange_mic: None,
            });
        }
    }

    Ok(CheckHoldingsImportResult {
        existing_dates,
        symbols,
        validation_errors,
    })
}

// ============================================================================
// Holdings CSV Import Types and Command
// ============================================================================

/// A single position in a holdings snapshot for CSV import
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HoldingsPositionInput {
    /// Symbol from CSV (e.g., "AAPL", "GOOGL")
    pub symbol: String,
    /// Quantity held
    pub quantity: String,
    /// Optional average cost per unit
    pub avg_cost: Option<String>,
    /// Currency for this position
    pub currency: String,
    /// Exchange MIC code (e.g., "XNAS", "XTSE") resolved during check step
    pub exchange_mic: Option<String>,
    /// Quote currency resolved during asset review/search
    pub quote_ccy: Option<String>,
    /// Instrument type resolved during asset review/search
    pub instrument_type: Option<String>,
    /// Market data provider that resolved this position, if selected.
    pub provider_id: Option<String>,
    /// Provider-native symbol/code selected by search/import.
    pub provider_symbol: Option<String>,
    /// Resolved asset ID from asset review step
    pub asset_id: Option<String>,
}

/// A single snapshot from CSV import (one date's worth of holdings)
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HoldingsSnapshotInput {
    /// The date of this snapshot (YYYY-MM-DD)
    pub date: String,
    /// Securities held on this date
    pub positions: Vec<HoldingsPositionInput>,
    /// Cash balances by currency (e.g., {"USD": "10000", "EUR": "5000"})
    pub cash_balances: HashMap<String, String>,
}

/// Result of importing holdings CSV
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportHoldingsCsvResult {
    /// Number of snapshots successfully imported
    pub snapshots_imported: usize,
    /// Number of snapshots that failed to import
    pub snapshots_failed: usize,
    /// Error messages for failed snapshots (date -> error)
    pub errors: Vec<String>,
}

/// Imports holdings snapshots from CSV data for a HOLDINGS-mode account.
/// Each snapshot represents the holdings state at a specific date.
/// Ensures assets and FX pairs are created before saving, following the same pattern as activities.
///
/// CSV format:
/// ```csv
/// date,symbol,quantity,price,currency
/// 2024-01-15,AAPL,100,185.50,USD
/// 2024-01-15,GOOGL,50,142.30,USD
/// 2024-01-15,$CASH,10000,,USD
/// ```
///
/// - `$CASH` is a reserved symbol for cash balances (price is ignored)
/// - Rows with the same date form one snapshot
/// - Multiple dates create multiple snapshots
#[tauri::command]
pub async fn import_holdings_csv(
    state: State<'_, Arc<ServiceContext>>,
    handle: AppHandle,
    account_id: String,
    snapshots: Vec<HoldingsSnapshotInput>,
) -> Result<ImportHoldingsCsvResult, String> {
    info!(
        "Importing {} holdings snapshots for account {}",
        snapshots.len(),
        account_id
    );

    // Get the account to verify it exists and get its currency
    let account = state
        .account_service()
        .get_account(&account_id)
        .map_err(|e| format!("Failed to get account: {}", e))?;

    // Get base currency for FX pair registration
    let base_currency = state.get_base_currency();

    let mut snapshots_imported = 0;
    let mut snapshots_failed = 0;
    let mut errors: Vec<String> = Vec::new();
    let mut all_asset_ids: Vec<String> = Vec::new();

    for snapshot_input in snapshots {
        match import_single_snapshot(
            &state,
            &account_id,
            &account.currency,
            &base_currency,
            &snapshot_input,
        )
        .await
        {
            Ok(asset_ids) => {
                snapshots_imported += 1;
                all_asset_ids.extend(asset_ids);
                debug!(
                    "Successfully imported snapshot for date {}",
                    snapshot_input.date
                );
            }
            Err(e) => {
                snapshots_failed += 1;
                let error_msg = format!("Date {}: {}", snapshot_input.date, e);
                errors.push(error_msg);
            }
        }
    }

    // Deduplicate asset IDs
    all_asset_ids.sort();
    all_asset_ids.dedup();

    info!(
        "Holdings CSV import complete for account {}: {} imported, {} failed, {} assets",
        account_id,
        snapshots_imported,
        snapshots_failed,
        all_asset_ids.len()
    );

    // Trigger portfolio update to sync quotes and recalculate valuations
    let payload = PortfolioRequestPayload::builder()
        .account_ids(Some(vec![account_id.clone()]))
        .market_sync_mode(MarketSyncMode::Incremental {
            asset_ids: if all_asset_ids.is_empty() {
                None
            } else {
                Some(all_asset_ids)
            },
        })
        .build();
    emit_portfolio_trigger_recalculate(&handle, payload);

    Ok(ImportHoldingsCsvResult {
        snapshots_imported,
        snapshots_failed,
        errors,
    })
}

/// Helper function to import a single holdings snapshot
/// Returns the list of asset IDs that were created/used
async fn import_single_snapshot(
    state: &State<'_, Arc<ServiceContext>>,
    account_id: &str,
    account_currency: &str,
    base_currency: &str,
    snapshot_input: &HoldingsSnapshotInput,
) -> Result<Vec<String>, String> {
    // Parse the date
    let date = NaiveDate::parse_from_str(&snapshot_input.date, "%Y-%m-%d")
        .map_err(|e| format!("Invalid date format: {}", e))?;

    let mut positions: Vec<ManualHoldingInput> = Vec::new();

    for pos_input in &snapshot_input.positions {
        let quantity = pos_input
            .quantity
            .parse::<Decimal>()
            .map_err(|e| format!("Invalid quantity for {}: {}", pos_input.symbol, e))?;

        // Parse average cost from CSV if provided, use for cost basis calculation
        let average_cost = pos_input
            .avg_cost
            .as_ref()
            .and_then(|p| p.parse::<Decimal>().ok())
            .unwrap_or(Decimal::ZERO);

        positions.push(ManualHoldingInput {
            asset_id: pos_input.asset_id.clone(),
            symbol: pos_input.symbol.clone(),
            exchange_mic: pos_input.exchange_mic.clone(),
            quantity,
            currency: pos_input.currency.clone(),
            average_cost,
            name: None,
            data_source: None,
            asset_kind: None,
            quote_ccy: pos_input.quote_ccy.clone(),
            instrument_type: pos_input.instrument_type.clone(),
            provider_id: pos_input.provider_id.clone(),
            provider_symbol: pos_input.provider_symbol.clone(),
        });
    }

    let mut cash_balances_input: Vec<CashBalanceInput> = Vec::new();
    for (currency, amount_str) in &snapshot_input.cash_balances {
        let amount = amount_str
            .parse::<Decimal>()
            .map_err(|e| format!("Invalid cash amount for {}: {}", currency, e))?;
        cash_balances_input.push(CashBalanceInput {
            currency: currency.clone(),
            amount,
        });
    }

    let manual_snapshot_service = ManualSnapshotService::new(
        state.asset_service(),
        state.fx_service(),
        state.snapshot_service(),
        state.quote_service(),
    );

    manual_snapshot_service
        .save_manual_snapshot(ManualSnapshotRequest {
            account_id: account_id.to_string(),
            account_currency: account_currency.to_string(),
            snapshot_date: date,
            positions,
            cash_balances: cash_balances_input,
            base_currency: Some(base_currency.to_string()),
            source: SnapshotSource::CsvImport,
        })
        .await
        .map_err(|e| format!("Failed to save snapshot: {}", e))
}

// ============================================================================
// Manual Snapshot Management Commands
// ============================================================================

/// Gets snapshots for an account (all sources: CALCULATED, MANUAL_ENTRY, etc.)
/// Optionally filtered by date range. Returns snapshot metadata without full position details.
#[tauri::command]
pub async fn get_snapshots(
    state: State<'_, Arc<ServiceContext>>,
    account_id: String,
    date_from: Option<String>, // YYYY-MM-DD, inclusive
    date_to: Option<String>,   // YYYY-MM-DD, inclusive
) -> Result<Vec<SnapshotInfo>, String> {
    debug!(
        "Getting snapshots for account: {} (from: {:?}, to: {:?})",
        account_id, date_from, date_to
    );

    // Parse date strings to NaiveDate
    let start_date = date_from
        .map(|s| chrono::NaiveDate::parse_from_str(&s, "%Y-%m-%d"))
        .transpose()
        .map_err(|e| format!("Invalid date_from format: {}", e))?;
    let end_date = date_to
        .map(|s| chrono::NaiveDate::parse_from_str(&s, "%Y-%m-%d"))
        .transpose()
        .map_err(|e| format!("Invalid date_to format: {}", e))?;

    let snapshots = state
        .snapshot_service()
        .get_holdings_keyframes(&account_id, start_date, end_date)
        .map_err(|e| format!("Failed to get snapshots: {}", e))?;

    let result: Vec<SnapshotInfo> = snapshots
        .into_iter()
        .map(|s| SnapshotInfo {
            id: s.id,
            snapshot_date: s.snapshot_date.format("%Y-%m-%d").to_string(),
            source: snapshot_source_to_string(s.source),
            position_count: s.positions.len(),
            cash_currency_count: s.cash_balances.len(),
            cash_total_account_currency: s.cash_total_account_currency.to_string(),
        })
        .collect();

    debug!(
        "Found {} snapshots for account {}",
        result.len(),
        account_id
    );

    Ok(result)
}

fn snapshot_source_to_string(source: SnapshotSource) -> String {
    serde_json::to_string(&source)
        .unwrap_or_else(|_| "\"CALCULATED\"".to_string())
        .trim_matches('"')
        .to_string()
}

/// Gets the full snapshot data for a specific date.
/// Returns holdings in the same format as get_holdings (without live valuation).
#[tauri::command]
pub async fn get_snapshot_by_date(
    state: State<'_, Arc<ServiceContext>>,
    account_id: String,
    date: String,
) -> Result<Vec<Holding>, String> {
    debug!(
        "Getting snapshot holdings for account {} on date {}",
        account_id, date
    );

    let target_date = NaiveDate::parse_from_str(&date, "%Y-%m-%d")
        .map_err(|e| format!("Invalid date format: {}", e))?;

    // Get keyframes for this specific date
    let snapshots = state
        .snapshot_service()
        .get_holdings_keyframes(&account_id, Some(target_date), Some(target_date))
        .map_err(|e| format!("Failed to get snapshot: {}", e))?;

    let snapshot = snapshots
        .into_iter()
        .find(|s| s.snapshot_date == target_date)
        .ok_or_else(|| format!("No snapshot found for date {}", date))?;

    // Convert snapshot to holdings format directly
    let base_currency = state.get_base_currency();
    let mut holdings: Vec<Holding> = Vec::new();

    // Get all asset IDs from positions
    let asset_ids: Vec<String> = snapshot
        .positions
        .values()
        .map(|p| p.asset_id.clone())
        .collect();

    // Fetch asset details if we have positions
    let assets_map: HashMap<String, wealthfolio_core::assets::Asset> = if !asset_ids.is_empty() {
        state
            .asset_service()
            .get_assets_by_asset_ids(&asset_ids)
            .await
            .map_err(|e| format!("Failed to get asset details: {}", e))?
            .into_iter()
            .map(|a| (a.id.clone(), a))
            .collect()
    } else {
        HashMap::new()
    };

    // Convert positions to holdings
    for position in snapshot.positions.values() {
        if position.quantity == Decimal::ZERO {
            continue;
        }

        let asset = assets_map.get(&position.asset_id);
        if asset.is_none() {
            warn!(
                "Asset {} not found for position in snapshot",
                position.asset_id
            );
            continue;
        }
        let asset = asset.unwrap();

        let (holding_type, id_prefix) = if asset.kind.is_alternative() {
            (
                wealthfolio_core::holdings::HoldingType::AlternativeAsset,
                "ALT",
            )
        } else {
            (wealthfolio_core::holdings::HoldingType::Security, "SEC")
        };

        // Extract purchase_price from metadata for alternative assets
        let purchase_price: Option<Decimal> = asset.metadata.as_ref().and_then(|m| {
            m.get("purchase_price").and_then(|v| {
                if let Some(s) = v.as_str() {
                    s.parse::<Decimal>().ok()
                } else if let Some(n) = v.as_f64() {
                    Decimal::try_from(n).ok()
                } else {
                    None
                }
            })
        });

        let instrument = wealthfolio_core::holdings::Instrument {
            id: asset.id.clone(),
            symbol: asset.display_code.clone().unwrap_or_default(),
            name: asset.name.clone(),
            currency: asset.quote_ccy.clone(),
            notes: asset.notes.clone(),
            pricing_mode: asset.quote_mode.as_db_str().to_string(),
            preferred_provider: asset.preferred_provider(),
            exchange_mic: asset.instrument_exchange_mic.clone(),
            classifications: None,
        };

        let holding = Holding {
            id: format!("{}-{}-{}", id_prefix, account_id, position.asset_id),
            account_id: account_id.clone(),
            holding_type,
            instrument: Some(instrument),
            asset_kind: Some(asset.kind.clone()),
            quantity: position.quantity,
            open_date: Some(position.inception_date),
            lots: None,
            contract_multiplier: position.contract_multiplier,
            local_currency: position.currency.clone(),
            base_currency: base_currency.clone(),
            fx_rate: None,
            market_value: wealthfolio_core::holdings::MonetaryValue::zero(),
            cost_basis: Some(wealthfolio_core::holdings::MonetaryValue {
                local: position.total_cost_basis,
                base: Decimal::ZERO,
            }),
            price: None,
            purchase_price,
            unrealized_gain: None,
            unrealized_gain_pct: None,
            realized_gain: None,
            realized_gain_pct: None,
            total_gain: None,
            total_gain_pct: None,
            income: None,
            total_return: None,
            total_return_pct: None,
            return_basis: None,
            day_change: None,
            day_change_pct: None,
            prev_close_value: None,
            weight: Decimal::ZERO,
            as_of_date: target_date,
            metadata: asset.metadata.clone(),
            source_account_ids: Vec::new(),
        };
        holdings.push(holding);
    }

    // Convert cash balances to holdings
    for (currency, &amount) in &snapshot.cash_balances {
        if amount == Decimal::ZERO {
            continue;
        }

        let holding = Holding {
            id: format!("CASH-{}-{}", account_id, currency),
            account_id: account_id.clone(),
            holding_type: wealthfolio_core::holdings::HoldingType::Cash,
            instrument: None,
            asset_kind: None, // Cash holdings have no asset
            quantity: amount,
            open_date: None,
            lots: None,
            contract_multiplier: Decimal::ONE,
            local_currency: currency.clone(),
            base_currency: base_currency.clone(),
            fx_rate: None,
            market_value: wealthfolio_core::holdings::MonetaryValue {
                local: amount,
                base: Decimal::ZERO,
            },
            cost_basis: Some(wealthfolio_core::holdings::MonetaryValue {
                local: amount,
                base: Decimal::ZERO,
            }),
            price: Some(Decimal::ONE),
            purchase_price: None,
            unrealized_gain: None,
            unrealized_gain_pct: None,
            realized_gain: None,
            realized_gain_pct: None,
            total_gain: None,
            total_gain_pct: None,
            income: None,
            total_return: None,
            total_return_pct: None,
            return_basis: None,
            day_change: None,
            day_change_pct: None,
            prev_close_value: None,
            weight: Decimal::ZERO,
            as_of_date: target_date,
            metadata: None,
            source_account_ids: Vec::new(),
        };
        holdings.push(holding);
    }

    Ok(holdings)
}

/// Deletes a manual/imported snapshot for a specific date.
/// Only non-CALCULATED snapshots can be deleted.
#[tauri::command]
pub async fn delete_snapshot(
    state: State<'_, Arc<ServiceContext>>,
    handle: AppHandle,
    account_id: String,
    date: String,
) -> Result<(), String> {
    debug!(
        "Deleting snapshot for account {} on date {}",
        account_id, date
    );

    let target_date = NaiveDate::parse_from_str(&date, "%Y-%m-%d")
        .map_err(|e| format!("Invalid date format: {}", e))?;

    // First verify the snapshot exists and is not CALCULATED
    let snapshots = state
        .snapshot_service()
        .get_holdings_keyframes(&account_id, Some(target_date), Some(target_date))
        .map_err(|e| format!("Failed to get snapshot: {}", e))?;

    let snapshot = snapshots
        .into_iter()
        .find(|s| s.snapshot_date == target_date)
        .ok_or_else(|| format!("No snapshot found for date {}", date))?;

    if snapshot.source == SnapshotSource::Calculated {
        return Err(
            "Cannot delete calculated snapshots. Only manual or imported snapshots can be deleted."
                .to_string(),
        );
    }

    // Delete via the service so snapshot deletion stays behind one entry point.
    state
        .snapshot_service()
        .delete_snapshot_for_account(&account_id, &[target_date])
        .await
        .map_err(|e| format!("Failed to delete snapshot: {}", e))?;

    info!(
        "Deleted {:?} snapshot for account {} on date {}",
        snapshot.source, account_id, date
    );

    // If no user-created snapshots remain, clean up orphan SYNTHETIC snapshots.
    let remaining = state
        .snapshot_repository()
        .get_snapshots_by_account(&account_id, None, None)
        .map_err(|e| format!("Failed to check remaining snapshots: {}", e))?;

    let has_user_snapshots = remaining
        .iter()
        .any(|s| s.source != SnapshotSource::Calculated && s.source != SnapshotSource::Synthetic);

    if !has_user_snapshots {
        let synthetic_dates: Vec<NaiveDate> = remaining
            .iter()
            .filter(|s| s.source == SnapshotSource::Synthetic)
            .map(|s| s.snapshot_date)
            .collect();
        if !synthetic_dates.is_empty() {
            state
                .snapshot_service()
                .delete_snapshot_for_account(&account_id, &synthetic_dates)
                .await
                .map_err(|e| format!("Failed to clean up synthetic snapshots: {}", e))?;
            info!(
                "Cleaned up {} orphan SYNTHETIC snapshots for account {}",
                synthetic_dates.len(),
                account_id
            );
        }
    }

    // Trigger portfolio update to recalculate valuations
    let payload = PortfolioRequestPayload::builder()
        .account_ids(Some(vec![account_id.clone()]))
        .market_sync_mode(MarketSyncMode::Incremental { asset_ids: None })
        .build();
    emit_portfolio_trigger_recalculate(&handle, payload);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDateTime;
    use wealthfolio_core::accounts::account_types;

    fn account(id: &str, account_type: &str) -> Account {
        Account {
            id: id.to_string(),
            name: id.to_string(),
            account_type: account_type.to_string(),
            group: None,
            currency: "USD".to_string(),
            is_default: false,
            is_active: true,
            created_at: NaiveDateTime::default(),
            updated_at: NaiveDateTime::default(),
            platform_id: None,
            account_number: None,
            meta: None,
            provider: None,
            provider_account_id: None,
            is_archived: false,
            tracking_mode: TrackingMode::Transactions,
        }
    }

    #[test]
    fn performance_account_ids_keep_hidden_and_exclude_archived_accounts() {
        let mut hidden = account("hidden", account_types::SECURITIES);
        hidden.is_active = false;
        let mut archived = account("archived", account_types::SECURITIES);
        archived.is_archived = true;
        let accounts_by_id = HashMap::from([
            (
                "active".to_string(),
                account("active", account_types::SECURITIES),
            ),
            ("hidden".to_string(), hidden),
            ("archived".to_string(), archived),
            (
                "card".to_string(),
                account("card", account_types::CREDIT_CARD),
            ),
        ]);

        let ids = performance_account_ids_from_map(
            &accounts_by_id,
            &[
                "hidden".to_string(),
                "archived".to_string(),
                "active".to_string(),
                "card".to_string(),
                "hidden".to_string(),
            ],
        );

        assert_eq!(ids, vec!["hidden", "active"]);
    }
}
