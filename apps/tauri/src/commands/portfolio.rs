use std::collections::HashMap;
use std::sync::Arc;

use crate::{
    context::ServiceContext,
    events::{
        emit_portfolio_trigger_recalculate, emit_portfolio_trigger_update, PortfolioRequestPayload,
    },
};

use chrono::{NaiveDate, Utc};
use log::{debug, info};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use wealthfolio_core::{
    accounts::TrackingMode,
    allocation::{AllocationHoldings, PortfolioAllocations},
    holdings::{Holding, LotView},
    income::IncomeSummary,
    performance::{PerformanceMetrics, SimplePerformanceMetrics},
    portfolio::snapshot::{
        CashBalanceInput, ManualHoldingInput, ManualSnapshotRequest, ManualSnapshotService,
        SnapshotSource,
    },
    quotes::MarketSyncMode,
    valuation::DailyAccountValuation,
};

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

#[tauri::command]
pub async fn get_holdings(
    state: State<'_, Arc<ServiceContext>>,
    account_id: String,
) -> Result<Vec<Holding>, String> {
    debug!("Get holdings...");
    let base_currency = state.get_base_currency();
    state
        .holdings_service()
        .get_holdings(&account_id, &base_currency)
        .await
        .map_err(|e| e.to_string())
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
pub async fn get_asset_lots(
    state: State<'_, Arc<ServiceContext>>,
    asset_id: String,
) -> Result<Vec<LotView>, String> {
    debug!("Get lots for asset {} across all accounts", asset_id);
    let lots = state
        .lots_repository
        .get_lots_for_asset(&asset_id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(lots.iter().filter_map(LotView::from_record).collect())
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
pub async fn get_portfolio_allocations(
    state: State<'_, Arc<ServiceContext>>,
    account_id: String,
) -> Result<PortfolioAllocations, String> {
    debug!("Get portfolio allocations for account: {}", account_id);
    let base_currency = state.get_base_currency();
    state
        .allocation_service()
        .get_portfolio_allocations(&account_id, &base_currency)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_holdings_by_allocation(
    state: State<'_, Arc<ServiceContext>>,
    account_id: String,
    taxonomy_id: String,
    category_id: String,
) -> Result<AllocationHoldings, String> {
    debug!(
        "Get holdings for category {} in taxonomy {} for account {}",
        category_id, taxonomy_id, account_id
    );
    let base_currency = state.get_base_currency();
    state
        .allocation_service()
        .get_holdings_by_allocation(&account_id, &base_currency, &taxonomy_id, &category_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_historical_valuations(
    state: State<'_, Arc<ServiceContext>>,
    account_id: String,
    start_date: Option<String>,
    end_date: Option<String>,
) -> Result<Vec<DailyAccountValuation>, String> {
    debug!("Get historical valuations for account: {}", account_id);
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

    state
        .valuation_service()
        .get_historical_valuations(&account_id, from_date_opt, to_date_opt)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_latest_valuations(
    state: State<'_, Arc<ServiceContext>>,
    account_ids: Vec<String>,
) -> Result<Vec<DailyAccountValuation>, String> {
    debug!("Get latest valuations for accounts: {:?}", account_ids);

    let ids_to_process = if account_ids.is_empty() {
        debug!("Input account_ids is empty, fetching active accounts for latest valuations.");
        state
            .account_service()
            .get_active_accounts()
            .map_err(|e| format!("Failed to fetch active accounts: {}", e))?
            .into_iter()
            .map(|acc| acc.id)
            .collect()
    } else {
        account_ids
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
pub async fn get_income_summary(
    state: State<'_, Arc<ServiceContext>>,
    account_id: Option<String>,
) -> Result<Vec<IncomeSummary>, String> {
    debug!("Fetching income summary...");
    state
        .income_service()
        .get_income_summary(account_id.as_deref())
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

    let ids_to_process = if account_ids.is_empty() {
        debug!("Input account_ids is empty, fetching active accounts.");
        state
            .account_service()
            .get_active_accounts()
            .map_err(|e| format!("Failed to fetch active accounts: {}", e))?
            .into_iter()
            .map(|acc| acc.id)
            .collect()
    } else {
        account_ids
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
) -> Result<PerformanceMetrics, String> {
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

    state
        .performance_service()
        .calculate_performance_history(
            &item_type,
            &item_id,
            start_date_opt,
            end_date_opt,
            tracking_mode_opt,
        )
        .await
        .map_err(|e| format!("Failed to calculate performance: {}", e))
}

/// Calculates performance summary for a given item (account or symbol) over a given date range.
/// return performance metrics for the item.
/// tracking_mode: Optional tracking mode for the account ("HOLDINGS" or "TRANSACTIONS")
#[tauri::command]
pub async fn calculate_performance_summary(
    state: State<'_, Arc<ServiceContext>>,
    item_type: String,
    item_id: String,
    start_date: Option<String>,
    end_date: Option<String>,
    tracking_mode: Option<String>,
) -> Result<PerformanceMetrics, String> {
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

    state
        .performance_service()
        .calculate_performance_summary(
            &item_type,
            &item_id,
            start_date_opt,
            end_date_opt,
            tracking_mode_opt,
        )
        .await
        .map_err(|e| format!("Failed to calculate performance: {}", e))
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

    let all_lots = state
        .lots_repository
        .get_all_lots_for_account(&account_id)
        .await
        .unwrap_or_default();

    let result: Vec<SnapshotInfo> = snapshots
        .into_iter()
        .map(|s| {
            let date_str = s.snapshot_date.format("%Y-%m-%d").to_string();
            let position_count = all_lots
                .iter()
                .filter(|l| {
                    l.open_date.as_str() <= date_str.as_str()
                        && (!l.is_closed
                            || l.close_date
                                .as_deref()
                                .is_some_and(|cd| cd > date_str.as_str()))
                })
                .map(|l| &l.asset_id)
                .collect::<std::collections::HashSet<_>>()
                .len();
            SnapshotInfo {
                id: s.id,
                snapshot_date: date_str,
                source: snapshot_source_to_string(s.source),
                position_count,
                cash_currency_count: s.cash_balances.len(),
            }
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

    let base_currency = state.get_base_currency();

    // Security positions come from lots table; cash from snapshot (if any).
    let holdings = state
        .holdings_service()
        .holdings_from_snapshot(&account_id, target_date, &base_currency)
        .await
        .map_err(|e| format!("Failed to get holdings: {}", e))?;
    if holdings.is_empty() {
        return Err(format!("No snapshot found for date {}", date));
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

    // Delete the snapshot
    state
        .snapshot_repository()
        .delete_snapshots_for_account_and_dates(&account_id, &[target_date])
        .await
        .map_err(|e| format!("Failed to delete snapshot: {}", e))?;

    info!(
        "Deleted {:?} snapshot for account {} on date {}",
        snapshot.source, account_id, date
    );

    // If no user-created snapshots remain, clean up orphan SYNTHETIC snapshots
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
                .snapshot_repository()
                .delete_snapshots_for_account_and_dates(&account_id, &synthetic_dates)
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
