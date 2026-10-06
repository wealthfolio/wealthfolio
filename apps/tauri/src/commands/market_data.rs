use crate::profiles::ProfileAccess;
use std::collections::HashMap;
use wealthfolio_core::events::DomainEvent;

use crate::events::{
    emit_portfolio_trigger_recalculate, emit_portfolio_trigger_update, PortfolioRequestPayload,
};

use log::{debug, error, warn};
use tauri::AppHandle;
use wealthfolio_core::quotes::{
    service::ProviderInfo, FetchDividendsParams, LatestQuoteSnapshot, MarketSyncMode, Quote,
    QuoteImport, SymbolSearchResult,
};
use wealthfolio_market_data::{DividendEvent, ExchangeInfo};

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetProviderHistoryError {
    message: String,
    outcome_unknown: bool,
}

impl ResetProviderHistoryError {
    fn rejected(error: impl std::fmt::Display) -> Self {
        Self {
            message: error.to_string(),
            outcome_unknown: false,
        }
    }

    fn completion_unknown() -> Self {
        Self {
            message: "Reset completion could not be confirmed. Reload quotes before retrying."
                .into(),
            outcome_unknown: true,
        }
    }
}

#[tauri::command]
pub async fn reset_provider_history(
    asset_id: String,
    state: ProfileAccess,
) -> Result<wealthfolio_core::quotes::ResetProviderHistoryResult, ResetProviderHistoryError> {
    let context = state
        .context()
        .map_err(ResetProviderHistoryError::rejected)?;
    // The owned task finishes commit and event delivery even if its caller disconnects.
    tauri::async_runtime::spawn(async move {
        let result = context
            .quote_service()
            .reset_provider_history(&asset_id)
            .await;
        if result.is_ok() {
            context
                .domain_event_sink
                .emit(DomainEvent::PriceHistoryChanged);
        }
        result.map_err(ResetProviderHistoryError::rejected)
    })
    .await
    .map_err(|_| ResetProviderHistoryError::completion_unknown())?
}

#[tauri::command]
pub async fn reset_all_provider_history(
    state: ProfileAccess,
) -> Result<wealthfolio_core::quotes::ResetAllProviderHistoryResult, ResetProviderHistoryError> {
    let context = state
        .context()
        .map_err(ResetProviderHistoryError::rejected)?;
    tauri::async_runtime::spawn(async move {
        let result = context.quote_service().reset_all_provider_history().await;
        if result
            .as_ref()
            .is_ok_and(|result| !result.results.is_empty())
        {
            context
                .domain_event_sink
                .emit(DomainEvent::PriceHistoryChanged);
        }
        result.map_err(ResetProviderHistoryError::rejected)
    })
    .await
    .map_err(|_| ResetProviderHistoryError::completion_unknown())?
}

#[tauri::command]
pub async fn search_symbol(
    query: String,
    state: ProfileAccess,
) -> Result<Vec<SymbolSearchResult>, String> {
    let context = state.context()?;
    context
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
    state: ProfileAccess,
) -> Result<(), String> {
    let context = state.context()?;
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
    emit_portfolio_trigger_update(&handle, payload, &context);
    Ok(())
}

#[tauri::command]
pub async fn synch_quotes(state: ProfileAccess) -> Result<(), String> {
    let context = state.context()?;
    let result = tauri::async_runtime::spawn(async move {
        let result = context.quote_service().resync(None).await;
        if result.as_ref().is_ok_and(|result| result.synced > 0) {
            context
                .domain_event_sink
                .emit(DomainEvent::PriceHistoryChanged);
        }
        result.map_err(|error| error.to_string())
    })
    .await
    .map_err(|_| "Refresh completion could not be confirmed.".to_string())??;
    if result.failed > 0 {
        warn!("resync reported {} failures", result.failed);
    }
    Ok(())
}

#[tauri::command]
pub async fn update_quote(
    quote: Quote,
    state: ProfileAccess,
    handle: AppHandle,
) -> Result<(), String> {
    let context = state.context()?;
    debug!("Updating quote: {:?}", quote);
    context
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
        emit_portfolio_trigger_recalculate(&handle, payload, &context);
    });
    Ok(())
}

#[tauri::command]
pub async fn delete_quote(
    id: String,
    state: ProfileAccess,
    handle: AppHandle,
) -> Result<(), String> {
    let context = state.context()?;
    debug!("Deleting quote: {}", id);
    context
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
        emit_portfolio_trigger_recalculate(&handle, payload, &context);
    });
    Ok(())
}

#[tauri::command]
pub async fn get_quote_history(symbol: String, state: ProfileAccess) -> Result<Vec<Quote>, String> {
    let context = state.context()?;
    debug!("Fetching quote history for symbol: {}", symbol);
    context
        .quote_service()
        .get_historical_quotes(&symbol)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_latest_quotes(
    asset_ids: Vec<String>,
    state: ProfileAccess,
) -> Result<HashMap<String, LatestQuoteSnapshot>, String> {
    let context = state.context()?;
    context
        .quote_service()
        .get_latest_quotes_snapshot(&asset_ids)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_market_data_providers(state: ProfileAccess) -> Result<Vec<ProviderInfo>, String> {
    let context = state.context()?;
    debug!("Received request to get market data providers");
    context
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
    state: ProfileAccess,
) -> Result<Vec<QuoteImport>, String> {
    let context = state.context()?;
    debug!(
        "Checking quotes import from {} bytes CSV (has_header={})",
        content.len(),
        has_header_row
    );
    context
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
    state: ProfileAccess,
) -> Result<Vec<QuoteImport>, String> {
    let context = state.context()?;
    debug!(
        "Importing {} quotes from CSV (overwrite_existing={})",
        quotes.len(),
        overwrite_existing
    );
    // The quote service emits PriceHistoryChanged when the batch saves quotes.
    context
        .quote_service()
        .import_quotes(quotes, overwrite_existing)
        .await
        .map_err(|e| {
            error!("TAURI COMMAND: import_quotes_csv failed: {}", e);
            format!("Failed to import CSV quotes: {}", e)
        })
}

#[tauri::command]
pub async fn resolve_symbol_quote(
    symbol: String,
    exchange_mic: Option<String>,
    instrument_type: Option<String>,
    quote_ccy: Option<String>,
    provider_id: Option<String>,
    provider_symbol: Option<String>,
    state: ProfileAccess,
) -> Result<wealthfolio_core::quotes::ResolvedQuote, String> {
    let context = state.context()?;
    let inst_type = instrument_type
        .as_deref()
        .and_then(wealthfolio_core::assets::InstrumentType::from_external_str);
    context
        .quote_service()
        .resolve_symbol_quote(
            &symbol,
            exchange_mic.as_deref(),
            inst_type.as_ref(),
            quote_ccy.as_deref(),
            provider_id.as_deref(),
            provider_symbol.as_deref(),
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
    state: ProfileAccess,
) -> Result<Vec<DividendEvent>, String> {
    let context = state.context()?;
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

    context
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

#[cfg(test)]
mod tests {
    use super::ResetProviderHistoryError;

    #[test]
    fn reset_errors_distinguish_rejection_from_unknown_completion() {
        let rejected = serde_json::to_value(ResetProviderHistoryError::rejected(
            "Asset or provider settings changed during fetching; history was not replaced",
        ))
        .unwrap();
        assert_eq!(rejected["outcomeUnknown"], false);
        assert!(rejected["message"]
            .as_str()
            .unwrap()
            .contains("history was not replaced"));
        let unknown =
            serde_json::to_value(ResetProviderHistoryError::completion_unknown()).unwrap();
        assert_eq!(unknown["outcomeUnknown"], true);
    }
}
