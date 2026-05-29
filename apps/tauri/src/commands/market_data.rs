use std::collections::HashMap;
use std::sync::Arc;

use crate::{
    context::ServiceContext,
    events::{
        emit_portfolio_trigger_recalculate, emit_portfolio_trigger_update, PortfolioRequestPayload,
    },
};

use log::{debug, error, warn};
use tauri::{AppHandle, State};
use wealthfolio_core::quotes::{
    service::ProviderInfo, FetchDividendsParams, LatestQuoteSnapshot, MarketSyncMode, Quote,
    QuoteImport, SymbolSearchResult,
};
use wealthfolio_market_data::{DividendEvent, ExchangeInfo};

#[tauri::command]
pub async fn search_symbol(
    query: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Vec<SymbolSearchResult>, String> {
    state
        .quote_service()
        .search_symbol(&query)
        .await
        .map_err(|e| format!("Failed to search ticker: {}", e))
}

#[tauri::command]
pub async fn sync_market_data(
    asset_ids: Option<Vec<String>>,
    refetch_all: bool,
    refetch_recent_days: Option<i64>,
    handle: AppHandle,
) -> Result<(), String> {
    // Determine the appropriate market sync mode based on refetch_all flag
    let market_sync_mode = if let Some(days) = refetch_recent_days {
        MarketSyncMode::RefetchRecent { asset_ids, days }
    } else if refetch_all {
        MarketSyncMode::BackfillHistory {
            asset_ids,
            days: 365 * 5, // 5 years of history as fallback
        }
    } else {
        MarketSyncMode::Incremental { asset_ids }
    };

    let payload = PortfolioRequestPayload::builder()
        .account_ids(None)
        .market_sync_mode(market_sync_mode)
        .build();
    emit_portfolio_trigger_update(&handle, payload);
    Ok(())
}

#[tauri::command]
pub async fn synch_quotes(state: State<'_, Arc<ServiceContext>>) -> Result<(), String> {
    let result = state
        .quote_service()
        .resync(None)
        .await
        .map_err(|e| e.to_string())?;
    if result.failed > 0 {
        warn!("resync reported {} failures", result.failed);
    }
    Ok(())
}

#[tauri::command]
pub async fn update_quote(
    quote: Quote,
    state: State<'_, Arc<ServiceContext>>,
    handle: AppHandle,
) -> Result<(), String> {
    debug!("Updating quote: {:?}", quote);
    state
        .quote_service()
        .update_quote(quote.clone())
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())?;

    // Manual quote update - no market sync needed, but force full recalculation
    // so historical valuations are recomputed with the updated quotes
    let handle = handle.clone();
    tauri::async_runtime::spawn(async move {
        let payload = PortfolioRequestPayload::builder()
            .account_ids(None)
            .market_sync_mode(MarketSyncMode::None)
            .build();
        emit_portfolio_trigger_recalculate(&handle, payload);
    });
    Ok(())
}

#[tauri::command]
pub async fn delete_quote(
    id: String,
    state: State<'_, Arc<ServiceContext>>,
    handle: AppHandle,
) -> Result<(), String> {
    debug!("Deleting quote: {}", id);
    state
        .quote_service()
        .delete_quote(&id)
        .await
        .map_err(|e| e.to_string())?;

    // Manual quote deletion - no market sync needed, but force full recalculation
    // so historical valuations are recomputed without the deleted quotes
    let handle = handle.clone();
    tauri::async_runtime::spawn(async move {
        let payload = PortfolioRequestPayload::builder()
            .account_ids(None)
            .market_sync_mode(MarketSyncMode::None)
            .build();
        emit_portfolio_trigger_recalculate(&handle, payload);
    });
    Ok(())
}

#[tauri::command]
pub async fn get_quote_history(
    symbol: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Vec<Quote>, String> {
    debug!("Fetching quote history for symbol: {}", symbol);
    state
        .quote_service()
        .get_historical_quotes(&symbol)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_latest_quotes(
    asset_ids: Vec<String>,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<HashMap<String, LatestQuoteSnapshot>, String> {
    state
        .quote_service()
        .get_latest_quotes_snapshot(&asset_ids)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_market_data_providers(
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Vec<ProviderInfo>, String> {
    debug!("Received request to get market data providers");
    state
        .quote_service()
        .get_providers_info()
        .await
        .map_err(|e| {
            error!("Failed to get market data providers: {}", e);
            e.to_string()
        })
}

#[tauri::command]
pub async fn check_quotes_import(
    content: Vec<u8>,
    has_header_row: bool,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Vec<QuoteImport>, String> {
    debug!(
        "Checking quotes import from {} bytes CSV (has_header={})",
        content.len(),
        has_header_row
    );
    state
        .quote_service()
        .check_quotes_import(&content, has_header_row)
        .await
        .map_err(|e| {
            error!("Failed to check quotes import: {}", e);
            format!("Failed to check quotes import: {}", e)
        })
}

#[tauri::command]
pub async fn import_quotes_csv(
    quotes: Vec<QuoteImport>,
    overwrite_existing: bool,
    state: State<'_, Arc<ServiceContext>>,
    handle: AppHandle,
) -> Result<Vec<QuoteImport>, String> {
    debug!(
        "Importing {} quotes from CSV (overwrite_existing={})",
        quotes.len(),
        overwrite_existing
    );
    let result = state
        .quote_service()
        .import_quotes(quotes, overwrite_existing)
        .await
        .map_err(|e| {
            error!("TAURI COMMAND: import_quotes_csv failed: {}", e);
            format!("Failed to import CSV quotes: {}", e)
        })?;

    // Quote import - no market sync needed, just recalculate
    let handle = handle.clone();
    tauri::async_runtime::spawn(async move {
        debug!("Triggering portfolio recalculation after quote import");
        let payload = PortfolioRequestPayload::builder()
            .account_ids(None)
            .market_sync_mode(MarketSyncMode::None)
            .build();
        emit_portfolio_trigger_recalculate(&handle, payload);
    });

    Ok(result)
}

#[tauri::command]
pub async fn resolve_symbol_quote(
    symbol: String,
    exchange_mic: Option<String>,
    instrument_type: Option<String>,
    quote_ccy: Option<String>,
    provider_id: Option<String>,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<wealthfolio_core::quotes::ResolvedQuote, String> {
    let inst_type = instrument_type
        .as_deref()
        .and_then(wealthfolio_core::assets::InstrumentType::from_external_str);
    state
        .quote_service()
        .resolve_symbol_quote(
            &symbol,
            exchange_mic.as_deref(),
            inst_type.as_ref(),
            quote_ccy.as_deref(),
            provider_id.as_deref(),
        )
        .await
        .map_err(|e| format!("Failed to resolve symbol quote: {}", e))
}

#[tauri::command]
pub fn get_exchanges() -> Vec<ExchangeInfo> {
    wealthfolio_market_data::get_exchange_list()
}

/// Fetch dividend events for a symbol through configured market data providers.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn fetch_dividends(
    symbol: String,
    exchange_mic: Option<String>,
    instrument_type: Option<String>,
    quote_ccy: Option<String>,
    provider_id: Option<String>,
    start_date: Option<String>,
    end_date: Option<String>,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Vec<DividendEvent>, String> {
    let inst_type = instrument_type
        .as_deref()
        .and_then(wealthfolio_core::assets::InstrumentType::from_external_str);
    let start = start_date
        .as_deref()
        .map(|date| chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d"))
        .transpose()
        .map_err(|e| format!("Invalid startDate: {}", e))?;
    let end = end_date
        .as_deref()
        .map(|date| chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d"))
        .transpose()
        .map_err(|e| format!("Invalid endDate: {}", e))?;

    state
        .quote_service()
        .fetch_dividends(FetchDividendsParams {
            symbol,
            exchange_mic,
            instrument_type: inst_type,
            quote_ccy,
            preferred_provider: provider_id,
            start,
            end,
        })
        .await
        .map_err(|e| e.to_string())
}
