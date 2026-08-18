use std::sync::Arc;

use axum::{
    extract::{Query, State},
    Json,
};
use chrono::NaiveDate;
use rust_decimal::Decimal;
use wealthfolio_core::portfolios::{AccountScope, ResolvedAccountScope};
use wealthfolio_core::utils::time_utils::{parse_user_timezone_or_default, user_today};
use wealthfolio_core::{
    accounts::{account_supports_purpose, AccountPurpose, AccountServiceTrait, TrackingMode},
    lots::AssetLotView,
    portfolio::{
        allocation::{AllocationHoldings, PortfolioAllocations},
        holdings::{Holding, HoldingListItem},
        snapshot::{
            check_holdings_import as validate_holdings_import, holdings_import_data_source,
            reconcile_quote_sync_from_latest_account_snapshots, snapshot_date_requires_remediation,
            snapshot_recalculation_start_after_delete, validate_holdings_import_snapshot,
            CashBalanceInput, HoldingsImportPositionValidationInput,
            HoldingsImportSnapshotValidationInput, ManualHoldingInput, ManualSnapshotRequest,
            ManualSnapshotService, SnapshotSource,
        },
        valuation::{
            CurrentAccountValuationService, CurrentValuationResponse, DailyAccountValuation,
            ValuationRecalcMode,
        },
    },
};

use crate::{api::shared::holdings_account_ids, error::ApiResult, main_lib::AppState};

use super::dto::{
    AccountIdQuery, AllocationFilterBody, AllocationHoldingsQuery, AssetHoldingsQuery,
    AssetLotsQuery, CheckHoldingsImportRequest, CheckHoldingsImportResult, CurrentValuationBody,
    DeleteSnapshotQuery, FilterBody, HistoryFilterBody, HistoryQuery, HoldingItemQuery,
    HoldingsSnapshotInput, ImportHoldingsCsvRequest, ImportHoldingsCsvResult,
    SaveManualHoldingsRequest, SnapshotDateQuery, SnapshotInfo, SnapshotsQuery, SymbolCheckResult,
};
use super::mappers::{parse_date, parse_date_optional};

fn resolve_scope(
    filter: &AccountScope,
    state: &AppState,
) -> Result<ResolvedAccountScope, crate::error::ApiError> {
    let base = state.base_currency.read().unwrap().clone();
    state
        .portfolio_service
        .resolve_account_scope(filter, &base)
        .map_err(crate::error::ApiError::from)
}

fn unique_preserving_order(account_ids: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    account_ids
        .into_iter()
        .filter(|account_id| seen.insert(account_id.clone()))
        .collect()
}

fn resolve_current_valuation_scope(
    filter: &AccountScope,
    state: &AppState,
) -> Result<ResolvedAccountScope, crate::error::ApiError> {
    let base = state.base_currency.read().unwrap().clone();
    let resolved = state
        .portfolio_service
        .resolve_account_scope(filter, &base)
        .map_err(crate::error::ApiError::from)?;

    let account_ids = match filter {
        AccountScope::Account { account_id } => vec![account_id.clone()],
        AccountScope::Accounts { account_ids } => unique_preserving_order(account_ids.clone()),
        AccountScope::Portfolio { portfolio_id } => {
            state
                .portfolio_service
                .get_portfolio(portfolio_id)
                .map_err(crate::error::ApiError::from)?
                .account_ids
        }
        AccountScope::All => resolved.account_ids.clone(),
    };

    Ok(ResolvedAccountScope {
        account_ids,
        ..resolved
    })
}

pub async fn get_holdings(
    State(state): State<Arc<AppState>>,
    Json(body): Json<FilterBody>,
) -> ApiResult<Json<Vec<Holding>>> {
    let holdings =
        load_holdings_for_filter(state.as_ref(), &body.filter, body.include_closed).await?;
    Ok(Json(holdings))
}

pub async fn get_holdings_list(
    State(state): State<Arc<AppState>>,
    Json(body): Json<FilterBody>,
) -> ApiResult<Json<Vec<HoldingListItem>>> {
    let holdings =
        load_holdings_for_filter(state.as_ref(), &body.filter, body.include_closed).await?;
    Ok(Json(
        holdings.into_iter().map(HoldingListItem::from).collect(),
    ))
}

async fn load_holdings_for_filter(
    state: &AppState,
    filter: &AccountScope,
    include_closed: bool,
) -> ApiResult<Vec<Holding>> {
    let base = state.base_currency.read().unwrap().clone();
    let resolved = resolve_scope(filter, state)?;
    let account_ids = holdings_account_ids(state, &resolved.account_ids)?;
    let holdings = if account_ids.is_empty() {
        Vec::new()
    } else if account_ids.len() == 1 {
        state
            .holdings_service
            .get_holdings_with_options(&account_ids[0], &base, include_closed)
            .await?
    } else {
        state
            .holdings_service
            .get_holdings_for_accounts_with_options(
                &account_ids,
                &base,
                &resolved.scope_id,
                include_closed,
            )
            .await?
    };
    Ok(holdings)
}

/// GET /holdings?accountId=... — simple single-account scope
pub async fn get_holdings_for_account(
    State(state): State<Arc<AppState>>,
    Query(q): Query<AccountIdQuery>,
) -> ApiResult<Json<Vec<Holding>>> {
    let base = state.base_currency.read().unwrap().clone();
    let account_ids = holdings_account_ids(&state, std::slice::from_ref(&q.account_id))?;
    if account_ids.is_empty() {
        return Ok(Json(Vec::new()));
    }
    let holdings = state
        .holdings_service
        .get_holdings_with_options(&account_ids[0], &base, q.include_closed)
        .await?;
    Ok(Json(holdings))
}

/// GET /holdings/list?accountId=... — single-account lightweight list scope
pub async fn get_holdings_list_for_account(
    State(state): State<Arc<AppState>>,
    Query(q): Query<AccountIdQuery>,
) -> ApiResult<Json<Vec<HoldingListItem>>> {
    let base = state.base_currency.read().unwrap().clone();
    let account_ids = holdings_account_ids(&state, std::slice::from_ref(&q.account_id))?;
    if account_ids.is_empty() {
        return Ok(Json(Vec::new()));
    }
    let holdings = state
        .holdings_service
        .get_holdings_with_options(&account_ids[0], &base, q.include_closed)
        .await?;
    Ok(Json(
        holdings.into_iter().map(HoldingListItem::from).collect(),
    ))
}

/// GET /allocations?accountId=... — simple single-account scope
pub async fn get_allocations_for_account(
    State(state): State<Arc<AppState>>,
    Query(q): Query<AccountIdQuery>,
) -> ApiResult<Json<PortfolioAllocations>> {
    let base = state.base_currency.read().unwrap().clone();
    let account_ids = holdings_account_ids(&state, std::slice::from_ref(&q.account_id))?;
    let allocations = if account_ids.len() == 1 {
        state
            .allocation_service
            .get_portfolio_allocations(&account_ids[0], &base)
            .await?
    } else {
        PortfolioAllocations::default()
    };
    Ok(Json(allocations))
}

/// GET /allocations/holdings?accountId=...&taxonomyId=...&categoryId=... — simple single-account scope
pub async fn get_holdings_by_allocation_for_account(
    State(state): State<Arc<AppState>>,
    Query(q): Query<AllocationHoldingsQuery>,
) -> ApiResult<Json<AllocationHoldings>> {
    let base = state.base_currency.read().unwrap().clone();
    let account_ids = holdings_account_ids(&state, std::slice::from_ref(&q.account_id))?;
    let result = if account_ids.len() == 1 {
        state
            .allocation_service
            .get_holdings_by_allocation(&account_ids[0], &base, &q.taxonomy_id, &q.category_id)
            .await?
    } else {
        state
            .allocation_service
            .get_holdings_by_allocation_for_accounts(
                &[],
                &base,
                &q.taxonomy_id,
                &q.category_id,
                "empty",
            )
            .await?
    };
    Ok(Json(result))
}

pub async fn get_holding(
    State(state): State<Arc<AppState>>,
    Query(q): Query<HoldingItemQuery>,
) -> ApiResult<Json<Option<Holding>>> {
    let base = state.base_currency.read().unwrap().clone();
    let holding = state
        .holdings_service
        .get_holding(&q.account_id, &q.asset_id, &base)
        .await?;
    Ok(Json(holding))
}

pub async fn get_asset_holdings(
    State(state): State<Arc<AppState>>,
    Query(q): Query<AssetHoldingsQuery>,
) -> ApiResult<Json<Vec<Holding>>> {
    let base = state.base_currency.read().unwrap().clone();
    let accounts = state.account_service.get_active_accounts()?;

    let mut result = Vec::new();
    for account in accounts {
        if !account_supports_purpose(&account.account_type, AccountPurpose::Holdings) {
            continue;
        }
        if let Ok(Some(holding)) = state
            .holdings_service
            .get_holding(&account.id, &q.asset_id, &base)
            .await
        {
            result.push(holding);
        }
    }
    Ok(Json(result))
}

pub async fn get_asset_lots(
    State(state): State<Arc<AppState>>,
    Query(q): Query<AssetLotsQuery>,
) -> ApiResult<Json<Vec<AssetLotView>>> {
    let rows = state
        .lots_repository
        .get_asset_lot_view(&q.asset_id, q.include_snapshot_positions)
        .await?;
    Ok(Json(rows))
}

pub async fn get_historical_valuations(
    State(state): State<Arc<AppState>>,
    Query(q): Query<HistoryQuery>,
) -> ApiResult<Json<Vec<DailyAccountValuation>>> {
    let start = q
        .start_date
        .map(|s| {
            chrono::NaiveDate::parse_from_str(&s, "%Y-%m-%d")
                .map_err(|e| anyhow::anyhow!("Invalid startDate: {}", e))
        })
        .transpose()?;
    let end = q
        .end_date
        .map(|s| {
            chrono::NaiveDate::parse_from_str(&s, "%Y-%m-%d")
                .map_err(|e| anyhow::anyhow!("Invalid endDate: {}", e))
        })
        .transpose()?;
    let account_ids = holdings_account_ids(&state, std::slice::from_ref(&q.account_id))?;
    if account_ids.is_empty() {
        return Ok(Json(Vec::new()));
    }
    let vals = state
        .valuation_service
        .get_historical_valuations(&account_ids[0], start, end)?;
    Ok(Json(vals))
}

pub async fn get_historical_valuations_for_scope(
    State(state): State<Arc<AppState>>,
    Json(body): Json<HistoryFilterBody>,
) -> ApiResult<Json<Vec<DailyAccountValuation>>> {
    let start = body
        .start_date
        .map(|s| {
            chrono::NaiveDate::parse_from_str(&s, "%Y-%m-%d")
                .map_err(|e| anyhow::anyhow!("Invalid startDate: {}", e))
        })
        .transpose()?;
    let end = body
        .end_date
        .map(|s| {
            chrono::NaiveDate::parse_from_str(&s, "%Y-%m-%d")
                .map_err(|e| anyhow::anyhow!("Invalid endDate: {}", e))
        })
        .transpose()?;
    let resolved = resolve_scope(&body.filter, &state)?;
    let account_ids = holdings_account_ids(&state, &resolved.account_ids)?;
    let vals = if account_ids.is_empty() {
        Vec::new()
    } else if account_ids.len() == 1 {
        state
            .valuation_service
            .get_historical_valuations(&account_ids[0], start, end)?
    } else {
        state
            .valuation_service
            .get_historical_valuation_totals_for_accounts(
                &resolved.scope_id,
                &account_ids,
                &resolved.base_currency,
                start,
                end,
            )?
    };
    Ok(Json(vals))
}

pub async fn get_latest_valuations(
    State(state): State<Arc<AppState>>,
    raw: axum::extract::RawQuery,
) -> ApiResult<Json<Vec<DailyAccountValuation>>> {
    use wealthfolio_core::accounts::AccountServiceTrait;

    // Parse query manually for robustness (supports accountIds and accountIds[])
    let mut ids: Vec<String> = Vec::new();
    if let Some(qs) = raw.0 {
        // Collect all values for both keys
        if let Ok(pairs) = serde_urlencoded::from_str::<Vec<(String, String)>>(&qs) {
            for (k, v) in pairs {
                if k == "accountIds" || k == "accountIds[]" {
                    ids.push(v);
                }
            }
        }
    }
    if ids.is_empty() {
        ids = state
            .account_service
            .get_active_accounts()?
            .into_iter()
            .map(|a| a.id)
            .collect();
    }
    ids = holdings_account_ids(&state, &ids)?;
    if ids.is_empty() {
        return Ok(Json(vec![]));
    }
    let vals = state.valuation_service.get_latest_valuations(&ids)?;
    Ok(Json(vals))
}

pub async fn get_current_valuation(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CurrentValuationBody>,
) -> ApiResult<Json<CurrentValuationResponse>> {
    let base_currency = state.base_currency.read().unwrap().clone();
    let timezone = state.timezone.read().unwrap().clone();
    let latest_snapshot_cutoff = user_today(parse_user_timezone_or_default(&timezone));
    let resolved = resolve_current_valuation_scope(&body.filter, &state)?;
    let service = CurrentAccountValuationService::new(
        state.account_service.as_ref(),
        state.snapshot_repository.as_ref(),
        state.asset_service.as_ref(),
        state.quote_service.as_ref(),
        state.fx_service.as_ref(),
    );
    let valuation = service
        .get_current_valuation_for_scope(
            &resolved.scope_id,
            &resolved.account_ids,
            &base_currency,
            latest_snapshot_cutoff,
            body.include_accounts,
        )
        .await?;
    Ok(Json(valuation))
}

pub async fn get_portfolio_allocations(
    State(state): State<Arc<AppState>>,
    Json(body): Json<FilterBody>,
) -> ApiResult<Json<PortfolioAllocations>> {
    let base = state.base_currency.read().unwrap().clone();
    let resolved = resolve_scope(&body.filter, &state)?;
    let account_ids = holdings_account_ids(&state, &resolved.account_ids)?;
    let allocations = if account_ids.len() == 1 {
        state
            .allocation_service
            .get_portfolio_allocations(&account_ids[0], &base)
            .await?
    } else {
        state
            .allocation_service
            .get_portfolio_allocations_for_accounts(&account_ids, &base, &resolved.scope_id)
            .await?
    };
    Ok(Json(allocations))
}

pub async fn get_holdings_by_allocation(
    State(state): State<Arc<AppState>>,
    Json(body): Json<AllocationFilterBody>,
) -> ApiResult<Json<AllocationHoldings>> {
    let base = state.base_currency.read().unwrap().clone();
    let resolved = resolve_scope(&body.filter, &state)?;
    let account_ids = holdings_account_ids(&state, &resolved.account_ids)?;
    let result = if account_ids.len() == 1 {
        state
            .allocation_service
            .get_holdings_by_allocation(
                &account_ids[0],
                &base,
                &body.taxonomy_id,
                &body.category_id,
            )
            .await?
    } else {
        state
            .allocation_service
            .get_holdings_by_allocation_for_accounts(
                &account_ids,
                &base,
                &body.taxonomy_id,
                &body.category_id,
                &resolved.scope_id,
            )
            .await?
    };
    Ok(Json(result))
}

/// Gets snapshots for an account (all sources: CALCULATED, MANUAL_ENTRY, etc.)
/// Optionally filtered by date range.
pub async fn get_snapshots(
    State(state): State<Arc<AppState>>,
    Query(q): Query<SnapshotsQuery>,
) -> ApiResult<Json<Vec<SnapshotInfo>>> {
    let start_date = parse_date_optional(q.date_from, "dateFrom")?;
    let end_date = parse_date_optional(q.date_to, "dateTo")?;

    let snapshots =
        state
            .snapshot_service
            .get_snapshot_metadata(&q.account_id, start_date, end_date)?;

    let result: Vec<SnapshotInfo> = snapshots
        .into_iter()
        .map(|s| SnapshotInfo {
            id: s.id,
            is_date_valid: NaiveDate::parse_from_str(&s.snapshot_date, "%Y-%m-%d").is_ok(),
            snapshot_date: s.snapshot_date,
            source: s.source,
            position_count: s.position_count,
            cash_currency_count: s.cash_currency_count,
            cash_total_account_currency: s.cash_total_account_currency,
        })
        .collect();

    Ok(Json(result))
}

pub async fn get_snapshot_by_date(
    State(state): State<Arc<AppState>>,
    Query(q): Query<SnapshotDateQuery>,
) -> ApiResult<Json<Vec<Holding>>> {
    let target_date = parse_date(&q.date, "date")?;

    // Get keyframes for this specific date
    let snapshots = state.snapshot_service.get_holdings_keyframes(
        &q.account_id,
        Some(target_date),
        Some(target_date),
    )?;

    let snapshot = snapshots
        .into_iter()
        .find(|s| s.snapshot_date == target_date)
        .ok_or_else(|| anyhow::anyhow!("No snapshot found for date {}", q.date))?;

    // Convert snapshot to holdings using core service
    let base_currency = state.base_currency.read().unwrap().clone();
    let holdings = state
        .holdings_service
        .holdings_from_snapshot(&snapshot, &base_currency)
        .await?;

    Ok(Json(holdings))
}

pub async fn delete_snapshot_handler(
    State(state): State<Arc<AppState>>,
    Query(q): Query<DeleteSnapshotQuery>,
) -> ApiResult<axum::http::StatusCode> {
    // Read raw metadata so a malformed stored date remains deletable by ID.
    let snapshots = state
        .snapshot_service
        .get_snapshot_metadata(&q.account_id, None, None)?;
    let snapshot = snapshots
        .into_iter()
        .find(|snapshot| {
            q.snapshot_id
                .as_deref()
                .map(|snapshot_id| snapshot.id == snapshot_id)
                .unwrap_or(snapshot.snapshot_date == q.date)
        })
        .ok_or_else(|| anyhow::anyhow!("No snapshot found for date {}", q.date))?;

    let target_date = NaiveDate::parse_from_str(&snapshot.snapshot_date, "%Y-%m-%d").ok();
    let account = state.account_service.get_account(&q.account_id)?;
    let timezone = state.timezone.read().unwrap().clone();
    let today = user_today(parse_user_timezone_or_default(&timezone));
    let requires_remediation = target_date
        .map(|date| snapshot_date_requires_remediation(date, today))
        .unwrap_or(true);
    let recalculation_start =
        target_date.and_then(|date| snapshot_recalculation_start_after_delete(date, today));
    if snapshot.source == SnapshotSource::Calculated.as_str() && !requires_remediation {
        return Err(anyhow::anyhow!("This entry comes from account activity and can't be deleted here. Update or delete the related activity instead.").into());
    }
    let standard_delete_allowed =
        account.tracking_mode == TrackingMode::Holdings && account.provider_account_id.is_none();
    if !standard_delete_allowed && !requires_remediation {
        return Err(anyhow::anyhow!(
            "This entry can only be deleted here when Health Center identifies its date as invalid."
        )
        .into());
    }

    // Delete via the service so snapshot deletion stays behind one entry point.
    if let Some(snapshot_id) = q.snapshot_id.as_deref() {
        state
            .snapshot_service
            .delete_snapshot_for_account_by_id(&q.account_id, snapshot_id)
            .await?;
    } else if let Some(target_date) = target_date {
        state
            .snapshot_service
            .delete_snapshot_for_account(&q.account_id, &[target_date])
            .await?;
    } else {
        return Err(
            anyhow::anyhow!("snapshotId is required to delete a malformed snapshot").into(),
        );
    }

    tracing::info!(
        "Deleted {:?} snapshot for account {} on date {}",
        snapshot.source,
        q.account_id,
        q.date
    );

    let recalculation_mode = recalculation_start
        .map(ValuationRecalcMode::SinceDate)
        .unwrap_or(ValuationRecalcMode::Full);
    if let Err(e) = state
        .valuation_service
        .calculate_valuation_history(&q.account_id, recalculation_mode)
        .await
    {
        tracing::warn!(
            "Failed to recalculate valuations after snapshot delete: {}",
            e
        );
    }
    state.health_service.clear_cache().await;

    // Quote sync lifecycle is global; a single-account snapshot change must not
    // make holdings in other accounts look closed.
    let account_ids: Vec<String> = state
        .account_service
        .get_non_archived_accounts()?
        .into_iter()
        .map(|account| account.id)
        .collect();
    if let Err(e) = reconcile_quote_sync_from_latest_account_snapshots(
        state.snapshot_service.as_ref(),
        state.quote_service.as_ref(),
        &account_ids,
    )
    .await
    {
        tracing::warn!(
            "Failed to update position status from holdings after delete: {}",
            e
        );
    }

    Ok(axum::http::StatusCode::NO_CONTENT)
}

pub async fn save_manual_holdings_handler(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SaveManualHoldingsRequest>,
) -> ApiResult<axum::http::StatusCode> {
    tracing::debug!(
        "Saving manual holdings for account {}: {} holdings, {} cash balances",
        req.account_id,
        req.holdings.len(),
        req.cash_balances.len()
    );

    // Get the account to verify it exists and get its currency
    let account = state.account_service.get_account(&req.account_id)?;

    // Get base currency for FX pair registration
    let base_currency = state.base_currency.read().unwrap().clone();

    // Parse the snapshot date or use today in the configured user timezone.
    let timezone = state.timezone.read().unwrap().clone();
    let date = match req.snapshot_date {
        Some(date_str) => NaiveDate::parse_from_str(&date_str, "%Y-%m-%d")
            .map_err(|e| anyhow::anyhow!("Invalid date format: {}", e))?,
        None => user_today(parse_user_timezone_or_default(&timezone)),
    };

    let mut positions: Vec<ManualHoldingInput> = Vec::new();
    for holding in req.holdings {
        let quantity = holding
            .quantity
            .parse::<Decimal>()
            .map_err(|e| anyhow::anyhow!("Invalid quantity for {}: {}", holding.symbol, e))?;

        // Parse average cost if provided
        let average_cost = match &holding.average_cost {
            Some(cost_str) if !cost_str.is_empty() => cost_str.parse::<Decimal>().map_err(|e| {
                anyhow::anyhow!("Invalid average cost for {}: {}", holding.symbol, e)
            })?,
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

    let mut cash_balances: Vec<CashBalanceInput> = Vec::new();
    for (currency, amount_str) in req.cash_balances {
        let amount = amount_str
            .parse::<Decimal>()
            .map_err(|e| anyhow::anyhow!("Invalid cash amount for {}: {}", currency, e))?;
        cash_balances.push(CashBalanceInput { currency, amount });
    }

    let manual_snapshot_service = ManualSnapshotService::new(
        state.asset_service.clone(),
        state.fx_service.clone(),
        state.snapshot_service.clone(),
        state.quote_service.clone(),
    )
    .with_timezone(timezone);

    manual_snapshot_service
        .save_manual_snapshot(ManualSnapshotRequest {
            account_id: req.account_id.clone(),
            account_currency: account.currency.clone(),
            snapshot_date: date,
            positions,
            cash_balances,
            base_currency: Some(base_currency.clone()),
            source: SnapshotSource::ManualEntry,
        })
        .await
        .map_err(|e| anyhow::anyhow!("Failed to save manual snapshot: {}", e))?;

    // SnapshotService emits the dated HoldingsChanged event after persistence.

    tracing::info!(
        "Saved manual holdings for account {} on date {}",
        req.account_id,
        date
    );

    Ok(axum::http::StatusCode::OK)
}

pub async fn check_holdings_import_handler(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CheckHoldingsImportRequest>,
) -> ApiResult<Json<CheckHoldingsImportResult>> {
    tracing::debug!(
        "Checking {} holdings snapshots for account {}",
        req.snapshots.len(),
        req.account_id
    );

    // Verify account exists
    let account = state.account_service.get_account(&req.account_id)?;
    let timezone = state.timezone.read().unwrap().clone();
    let today = user_today(parse_user_timezone_or_default(&timezone));

    let validation_snapshots: Vec<_> = req
        .snapshots
        .iter()
        .map(|snapshot| HoldingsImportSnapshotValidationInput {
            date: snapshot.date.clone(),
            cash_balances: snapshot
                .cash_balances
                .iter()
                .map(|(currency, amount)| (currency.clone(), amount.clone()))
                .collect(),
            positions: snapshot
                .positions
                .iter()
                .map(|position| HoldingsImportPositionValidationInput {
                    symbol: position.symbol.clone(),
                    quantity: position.quantity.clone(),
                    avg_cost: position.avg_cost.clone(),
                    currency: position.currency.clone(),
                    exchange_mic: position.exchange_mic.clone(),
                    quote_ccy: position.quote_ccy.clone(),
                    instrument_type: position.instrument_type.clone(),
                    quote_mode: position.quote_mode.clone(),
                    provider_id: position.provider_id.clone(),
                    provider_symbol: position.provider_symbol.clone(),
                    asset_id: position.asset_id.clone(),
                })
                .collect(),
        })
        .collect();
    let result = validate_holdings_import(
        state.asset_service.as_ref(),
        state.snapshot_service.as_ref(),
        &req.account_id,
        &account.currency,
        today,
        &validation_snapshots,
    )
    .await?;
    let symbols = result
        .symbols
        .into_iter()
        .map(|symbol| SymbolCheckResult {
            symbol: symbol.symbol,
            found: symbol.found,
            asset_name: symbol.asset_name,
            asset_id: symbol.asset_id,
            currency: symbol.currency,
            exchange_mic: symbol.exchange_mic,
        })
        .collect();

    Ok(Json(CheckHoldingsImportResult {
        existing_dates: result.existing_dates,
        symbols,
        validation_errors: result.validation_errors,
        valid_snapshot_dates: result.valid_snapshot_dates,
        invalid_snapshot_dates: result.invalid_snapshot_dates,
    }))
}

pub async fn import_holdings_csv_handler(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ImportHoldingsCsvRequest>,
) -> ApiResult<Json<ImportHoldingsCsvResult>> {
    tracing::info!(
        "Importing {} holdings snapshots for account {}",
        req.snapshots.len(),
        req.account_id
    );

    // Get the account to verify it exists and get its currency
    let account = state.account_service.get_account(&req.account_id)?;

    // Get base currency for FX pair registration
    let base_currency = state.base_currency.read().unwrap().clone();

    let mut snapshots_imported = 0;
    let mut snapshots_failed = 0;
    let mut errors: Vec<String> = Vec::new();

    for snapshot_input in req.snapshots {
        match import_single_snapshot_impl(
            &state,
            &req.account_id,
            &account.currency,
            &base_currency,
            &snapshot_input,
        )
        .await
        {
            Ok(_) => {
                snapshots_imported += 1;
                tracing::debug!(
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

    // SnapshotService emits dated HoldingsChanged events; the queue coalesces import batches.

    tracing::info!(
        "Holdings CSV import complete for account {}: {} imported, {} failed",
        req.account_id,
        snapshots_imported,
        snapshots_failed
    );

    Ok(Json(ImportHoldingsCsvResult {
        snapshots_imported,
        snapshots_failed,
        errors,
    }))
}

/// Helper function to import a single holdings snapshot
async fn import_single_snapshot_impl(
    state: &Arc<AppState>,
    account_id: &str,
    account_currency: &str,
    base_currency: &str,
    snapshot_input: &HoldingsSnapshotInput,
) -> Result<(), anyhow::Error> {
    let validation_input = HoldingsImportSnapshotValidationInput {
        date: snapshot_input.date.clone(),
        cash_balances: snapshot_input
            .cash_balances
            .iter()
            .map(|(currency, amount)| (currency.clone(), amount.clone()))
            .collect(),
        positions: snapshot_input
            .positions
            .iter()
            .map(|position| HoldingsImportPositionValidationInput {
                symbol: position.symbol.clone(),
                quantity: position.quantity.clone(),
                avg_cost: position.avg_cost.clone(),
                currency: position.currency.clone(),
                exchange_mic: position.exchange_mic.clone(),
                quote_ccy: position.quote_ccy.clone(),
                instrument_type: position.instrument_type.clone(),
                quote_mode: position.quote_mode.clone(),
                provider_id: position.provider_id.clone(),
                provider_symbol: position.provider_symbol.clone(),
                asset_id: position.asset_id.clone(),
            })
            .collect(),
    };
    let timezone = state.timezone.read().unwrap().clone();
    let today = user_today(parse_user_timezone_or_default(&timezone));
    let date = validate_holdings_import_snapshot(account_id, today, &validation_input)
        .map_err(|errors| anyhow::anyhow!(errors.join(" ")))?;

    let mut positions: Vec<ManualHoldingInput> = Vec::new();
    for pos_input in &snapshot_input.positions {
        let quantity = pos_input
            .quantity
            .parse::<Decimal>()
            .map_err(|e| anyhow::anyhow!("Invalid quantity for {}: {}", pos_input.symbol, e))?;

        // Parse average cost from CSV if provided, use for cost basis calculation
        let average_cost = match pos_input
            .avg_cost
            .as_deref()
            .filter(|value| !value.is_empty())
        {
            Some(value) => value.parse::<Decimal>().map_err(|e| {
                anyhow::anyhow!("Invalid average cost for {}: {}", pos_input.symbol, e)
            })?,
            None => Decimal::ZERO,
        };

        positions.push(ManualHoldingInput {
            asset_id: pos_input.asset_id.clone(),
            symbol: pos_input.symbol.clone(),
            exchange_mic: pos_input.exchange_mic.clone(),
            quantity,
            currency: pos_input.currency.clone(),
            average_cost,
            name: None,
            data_source: holdings_import_data_source(pos_input.quote_mode.as_deref()),
            asset_kind: None,
            quote_ccy: pos_input.quote_ccy.clone(),
            instrument_type: pos_input.instrument_type.clone(),
            provider_id: pos_input.provider_id.clone(),
            provider_symbol: pos_input.provider_symbol.clone(),
        });
    }

    let mut cash_balances: Vec<CashBalanceInput> = Vec::new();
    for (currency, amount_str) in &snapshot_input.cash_balances {
        let amount = amount_str
            .parse::<Decimal>()
            .map_err(|e| anyhow::anyhow!("Invalid cash amount for {}: {}", currency, e))?;
        cash_balances.push(CashBalanceInput {
            currency: currency.clone(),
            amount,
        });
    }

    let manual_snapshot_service = ManualSnapshotService::new(
        state.asset_service.clone(),
        state.fx_service.clone(),
        state.snapshot_service.clone(),
        state.quote_service.clone(),
    )
    .with_timezone(timezone);

    manual_snapshot_service
        .save_manual_snapshot(ManualSnapshotRequest {
            account_id: account_id.to_string(),
            account_currency: account_currency.to_string(),
            snapshot_date: date,
            positions,
            cash_balances,
            base_currency: Some(base_currency.to_string()),
            source: SnapshotSource::CsvImport,
        })
        .await
        .map_err(|e| anyhow::anyhow!("Failed to save snapshot: {}", e))?;

    Ok(())
}
