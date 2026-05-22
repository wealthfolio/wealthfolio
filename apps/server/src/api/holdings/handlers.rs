use std::sync::Arc;

use axum::{
    extract::{Query, State},
    Json,
};
use chrono::{NaiveDate, Utc};
use rust_decimal::Decimal;
use wealthfolio_core::portfolios::{AccountScope, ResolvedAccountScope};
use wealthfolio_core::{
    accounts::AccountServiceTrait,
    lots::AssetLotView,
    portfolio::{
        allocation::{AllocationHoldings, PortfolioAllocations},
        holdings::Holding,
        snapshot::{
            reconcile_quote_sync_from_latest_total_snapshot, CashBalanceInput, ManualHoldingInput,
            ManualSnapshotRequest, ManualSnapshotService, SnapshotRecalcMode, SnapshotSource,
        },
        valuation::{DailyAccountValuation, ValuationRecalcMode},
    },
};

use crate::{error::ApiResult, main_lib::AppState};

use super::dto::{
    AccountIdQuery, AllocationFilterBody, AllocationHoldingsQuery, AssetHoldingsQuery,
    AssetLotsQuery, CheckHoldingsImportRequest, CheckHoldingsImportResult, DeleteSnapshotQuery,
    FilterBody, HistoryQuery, HoldingItemQuery, HoldingsSnapshotInput, ImportHoldingsCsvRequest,
    ImportHoldingsCsvResult, SaveManualHoldingsRequest, SnapshotDateQuery, SnapshotInfo,
    SnapshotsQuery, SymbolCheckResult,
};
use super::mappers::{parse_date, parse_date_optional, snapshot_source_to_string};

fn resolve_scope(
    filter: &AccountScope,
    state: &AppState,
) -> Result<ResolvedAccountScope, crate::error::ApiError> {
    state
        .portfolio_service
        .resolve_account_scope(filter)
        .map_err(crate::error::ApiError::from)
}

fn aggregated_id(_filter: &AccountScope) -> String {
    String::new()
}

pub async fn get_holdings(
    State(state): State<Arc<AppState>>,
    Json(body): Json<FilterBody>,
) -> ApiResult<Json<Vec<Holding>>> {
    let base = state.base_currency.read().unwrap().clone();
    let holdings = match resolve_scope(&body.filter, &state)? {
        ResolvedAccountScope::TotalSnapshot => {
            state.holdings_service.get_holdings("TOTAL", &base).await?
        }
        ResolvedAccountScope::Account(id) => {
            state.holdings_service.get_holdings(&id, &base).await?
        }
        ResolvedAccountScope::Accounts(ids) => {
            state
                .holdings_service
                .get_holdings_for_accounts(&ids, &base, &aggregated_id(&body.filter))
                .await?
        }
    };
    Ok(Json(holdings))
}

/// GET /holdings?accountId=... — simple single-account scope
pub async fn get_holdings_for_account(
    State(state): State<Arc<AppState>>,
    Query(q): Query<AccountIdQuery>,
) -> ApiResult<Json<Vec<Holding>>> {
    let base = state.base_currency.read().unwrap().clone();
    let holdings = state
        .holdings_service
        .get_holdings(&q.account_id, &base)
        .await?;
    Ok(Json(holdings))
}

/// GET /allocations?accountId=... — simple single-account scope
pub async fn get_allocations_for_account(
    State(state): State<Arc<AppState>>,
    Query(q): Query<AccountIdQuery>,
) -> ApiResult<Json<PortfolioAllocations>> {
    let base = state.base_currency.read().unwrap().clone();
    let allocations = state
        .allocation_service
        .get_portfolio_allocations(&q.account_id, &base)
        .await?;
    Ok(Json(allocations))
}

/// GET /allocations/holdings?accountId=...&taxonomyId=...&categoryId=... — simple single-account scope
pub async fn get_holdings_by_allocation_for_account(
    State(state): State<Arc<AppState>>,
    Query(q): Query<AllocationHoldingsQuery>,
) -> ApiResult<Json<AllocationHoldings>> {
    let base = state.base_currency.read().unwrap().clone();
    let result = state
        .allocation_service
        .get_holdings_by_allocation(&q.account_id, &base, &q.taxonomy_id, &q.category_id)
        .await?;
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
    let vals = state
        .valuation_service
        .get_historical_valuations(&q.account_id, start, end)?;
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
    if ids.is_empty() {
        return Ok(Json(vec![]));
    }
    let vals = state.valuation_service.get_latest_valuations(&ids)?;
    Ok(Json(vals))
}

pub async fn get_portfolio_allocations(
    State(state): State<Arc<AppState>>,
    Json(body): Json<FilterBody>,
) -> ApiResult<Json<PortfolioAllocations>> {
    let base = state.base_currency.read().unwrap().clone();
    let allocations = match resolve_scope(&body.filter, &state)? {
        ResolvedAccountScope::TotalSnapshot => {
            state
                .allocation_service
                .get_portfolio_allocations("TOTAL", &base)
                .await?
        }
        ResolvedAccountScope::Account(id) => {
            state
                .allocation_service
                .get_portfolio_allocations(&id, &base)
                .await?
        }
        ResolvedAccountScope::Accounts(ids) => {
            state
                .allocation_service
                .get_portfolio_allocations_for_accounts(&ids, &base, &aggregated_id(&body.filter))
                .await?
        }
    };
    Ok(Json(allocations))
}

pub async fn get_holdings_by_allocation(
    State(state): State<Arc<AppState>>,
    Json(body): Json<AllocationFilterBody>,
) -> ApiResult<Json<AllocationHoldings>> {
    let base = state.base_currency.read().unwrap().clone();
    let result = match resolve_scope(&body.filter, &state)? {
        ResolvedAccountScope::TotalSnapshot => {
            state
                .allocation_service
                .get_holdings_by_allocation("TOTAL", &base, &body.taxonomy_id, &body.category_id)
                .await?
        }
        ResolvedAccountScope::Account(id) => {
            state
                .allocation_service
                .get_holdings_by_allocation(&id, &base, &body.taxonomy_id, &body.category_id)
                .await?
        }
        ResolvedAccountScope::Accounts(ids) => {
            state
                .allocation_service
                .get_holdings_by_allocation_for_accounts(
                    &ids,
                    &base,
                    &body.taxonomy_id,
                    &body.category_id,
                    &aggregated_id(&body.filter),
                )
                .await?
        }
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
            .get_holdings_keyframes(&q.account_id, start_date, end_date)?;

    let result: Vec<SnapshotInfo> = snapshots
        .into_iter()
        .map(|s| SnapshotInfo {
            id: s.id,
            snapshot_date: s.snapshot_date.format("%Y-%m-%d").to_string(),
            source: snapshot_source_to_string(s.source),
            position_count: s.positions.len(),
            cash_currency_count: s.cash_balances.len(),
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
    let target_date = parse_date(&q.date, "date")?;

    // First verify the snapshot exists and is not CALCULATED
    let snapshots = state.snapshot_service.get_holdings_keyframes(
        &q.account_id,
        Some(target_date),
        Some(target_date),
    )?;

    let snapshot = snapshots
        .into_iter()
        .find(|s| s.snapshot_date == target_date)
        .ok_or_else(|| anyhow::anyhow!("No snapshot found for date {}", q.date))?;

    if snapshot.source == SnapshotSource::Calculated {
        return Err(anyhow::anyhow!(
            "Cannot delete calculated snapshots. Only manual or imported snapshots can be deleted."
        )
        .into());
    }

    // Delete via the service so snapshot deletion stays behind one entry point.
    state
        .snapshot_service
        .delete_snapshot_for_account(&q.account_id, &[target_date])
        .await?;

    tracing::info!(
        "Deleted {:?} snapshot for account {} on date {}",
        snapshot.source,
        q.account_id,
        q.date
    );

    // Recalculate valuations for the affected account
    if let Err(e) = state
        .valuation_service
        .calculate_valuation_history(&q.account_id, ValuationRecalcMode::IncrementalFromLast)
        .await
    {
        tracing::warn!(
            "Failed to recalculate valuations after snapshot delete: {}",
            e
        );
    }

    // Force recalculate TOTAL portfolio snapshots (force needed because deletion invalidates existing TOTAL)
    if let Err(e) = state
        .snapshot_service
        .recalculate_total_portfolio_snapshots(SnapshotRecalcMode::Full)
        .await
    {
        tracing::warn!("Failed to recalculate TOTAL snapshots after delete: {}", e);
    }

    // Update position status from TOTAL snapshot for quote sync planning.
    if let Err(e) = reconcile_quote_sync_from_latest_total_snapshot(
        state.snapshot_service.as_ref(),
        state.quote_service.as_ref(),
    )
    .await
    {
        tracing::warn!(
            "Failed to update position status from holdings after delete: {}",
            e
        );
    }

    // Recalculate valuations for the TOTAL portfolio
    if let Err(e) = state
        .valuation_service
        .calculate_valuation_history("TOTAL", ValuationRecalcMode::IncrementalFromLast)
        .await
    {
        tracing::warn!(
            "Failed to recalculate TOTAL valuations after snapshot delete: {}",
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

    // Parse the snapshot date or use today
    let date = match req.snapshot_date {
        Some(date_str) => NaiveDate::parse_from_str(&date_str, "%Y-%m-%d")
            .map_err(|e| anyhow::anyhow!("Invalid date format: {}", e))?,
        None => Utc::now().naive_utc().date(),
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

    // Create ManualSnapshotService with event sink for automatic recalculation
    let manual_snapshot_service = ManualSnapshotService::new(
        state.asset_service.clone(),
        state.fx_service.clone(),
        state.snapshot_service.clone(),
        state.quote_service.clone(),
    )
    .with_event_sink(state.domain_event_sink.clone());

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

    // Portfolio recalculation is triggered via ManualSnapshotSaved domain event

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
    state.account_service.get_account(&req.account_id)?;

    let mut validation_errors: Vec<String> = Vec::new();
    let mut valid_dates: Vec<NaiveDate> = Vec::new();
    let mut unique_symbols: std::collections::HashSet<String> = std::collections::HashSet::new();

    for snapshot in &req.snapshots {
        match NaiveDate::parse_from_str(&snapshot.date, "%Y-%m-%d") {
            Ok(d) => valid_dates.push(d),
            Err(_) => {
                validation_errors.push(format!("Invalid date format: '{}'", snapshot.date));
                continue;
            }
        }

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
        let existing = state.snapshot_service.get_holdings_keyframes(
            &req.account_id,
            Some(min_date),
            Some(max_date),
        )?;

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
            .quote_service
            .search_symbol_with_currency(&sym, None)
            .await
            .unwrap_or_default();

        // Only mark as found if the top result is an exact symbol match
        let exact_hit = results
            .first()
            .filter(|hit| hit.symbol.eq_ignore_ascii_case(&sym));

        if let Some(hit) = exact_hit {
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

    Ok(Json(CheckHoldingsImportResult {
        existing_dates,
        symbols,
        validation_errors,
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

    // Portfolio recalculation is triggered via ManualSnapshotSaved domain events
    // (events are debounced, so multiple imports trigger a single recalculation)

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
    // Parse the date
    let date = NaiveDate::parse_from_str(&snapshot_input.date, "%Y-%m-%d")
        .map_err(|e| anyhow::anyhow!("Invalid date format: {}", e))?;

    let mut positions: Vec<ManualHoldingInput> = Vec::new();
    for pos_input in &snapshot_input.positions {
        let quantity = pos_input
            .quantity
            .parse::<Decimal>()
            .map_err(|e| anyhow::anyhow!("Invalid quantity for {}: {}", pos_input.symbol, e))?;

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
    .with_event_sink(state.domain_event_sink.clone());

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
