use std::sync::Arc;

use crate::{
    api::shared::{enqueue_portfolio_job, PortfolioJobConfig},
    error::ApiResult,
    main_lib::AppState,
};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    routing::{delete, get, post, put},
    Json, Router,
};
use wealthfolio_core::assets::InstrumentType;
use wealthfolio_core::portfolio::{snapshot::SnapshotRecalcMode, valuation::ValuationRecalcMode};
use wealthfolio_core::quotes::{
    FetchDividendsParams, LatestQuoteSnapshot, MarketSyncMode, ProviderInfo, Quote, QuoteImport,
    SymbolSearchResult,
};
use wealthfolio_market_data::{DividendEvent, ExchangeInfo};

async fn get_market_data_providers(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<Vec<ProviderInfo>>> {
    let infos = state.quote_service.get_providers_info().await?;
    Ok(Json(infos))
}

async fn get_market_data_provider_settings(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<Vec<ProviderInfo>>> {
    let infos = state.quote_service.get_providers_info().await?;
    Ok(Json(infos))
}

#[derive(serde::Deserialize)]
struct ProviderUpdateBody {
    #[serde(rename = "providerId")]
    provider_id: String,
    priority: i32,
    enabled: bool,
}

async fn update_market_data_provider_settings(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ProviderUpdateBody>,
) -> ApiResult<StatusCode> {
    state
        .quote_service
        .update_provider_settings(&body.provider_id, body.priority, body.enabled)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(serde::Deserialize)]
struct SearchQuery {
    query: String,
}

async fn search_symbol(
    State(state): State<Arc<AppState>>,
    Query(q): Query<SearchQuery>,
) -> ApiResult<Json<Vec<SymbolSearchResult>>> {
    let res = state.quote_service.search_symbol(&q.query).await?;
    Ok(Json(res))
}

#[derive(serde::Deserialize)]
struct QuoteHistoryQuery {
    symbol: String,
}

async fn get_quote_history(
    State(state): State<Arc<AppState>>,
    Query(q): Query<QuoteHistoryQuery>,
) -> ApiResult<Json<Vec<Quote>>> {
    let res = state.quote_service.get_historical_quotes(&q.symbol)?;
    Ok(Json(res))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DividendsQuery {
    symbol: String,
    exchange_mic: Option<String>,
    instrument_type: Option<String>,
    quote_ccy: Option<String>,
    provider_id: Option<String>,
    start_date: Option<chrono::NaiveDate>,
    end_date: Option<chrono::NaiveDate>,
}

async fn fetch_dividends(
    State(state): State<Arc<AppState>>,
    Query(q): Query<DividendsQuery>,
) -> ApiResult<Json<Vec<DividendEvent>>> {
    let inst_type = q
        .instrument_type
        .as_deref()
        .and_then(InstrumentType::from_external_str);
    let dividends = state
        .quote_service
        .fetch_dividends(FetchDividendsParams {
            symbol: q.symbol,
            exchange_mic: q.exchange_mic,
            instrument_type: inst_type,
            quote_ccy: q.quote_ccy,
            preferred_provider: q.provider_id,
            start: q.start_date,
            end: q.end_date,
        })
        .await?;
    Ok(Json(dividends))
}

async fn update_quote(
    Path(symbol): Path<String>,
    State(state): State<Arc<AppState>>,
    Json(mut quote): Json<Quote>,
) -> ApiResult<StatusCode> {
    // Ensure asset_id matches path parameter
    quote.asset_id = symbol;
    state.quote_service.update_quote(quote).await?;
    // Manual quote update - no market sync needed, but force full recalculation
    // so historical valuations are recomputed with the updated quotes
    enqueue_portfolio_job(
        state.clone(),
        PortfolioJobConfig {
            account_ids: None,
            market_sync_mode: MarketSyncMode::None,
            snapshot_mode: SnapshotRecalcMode::Full,
            valuation_mode: ValuationRecalcMode::Full,
            since_date: None,
        },
    );
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_quote(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> ApiResult<StatusCode> {
    state.quote_service.delete_quote(&id).await?;
    // Manual quote deletion - no market sync needed, but force full recalculation
    // so historical valuations are recomputed without the deleted quotes
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
    Ok(StatusCode::NO_CONTENT)
}

async fn sync_history_quotes(State(state): State<Arc<AppState>>) -> ApiResult<StatusCode> {
    let result = state.quote_service.resync(None).await?;
    if result.failed > 0 {
        tracing::warn!("resync reported {} failures", result.failed);
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(serde::Deserialize)]
struct CheckQuotesBody {
    content: Vec<u8>,
    #[serde(rename = "hasHeaderRow")]
    has_header_row: bool,
}

async fn check_quotes_import(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CheckQuotesBody>,
) -> ApiResult<Json<Vec<QuoteImport>>> {
    let result = state
        .quote_service
        .check_quotes_import(&body.content, body.has_header_row)
        .await?;
    Ok(Json(result))
}

#[derive(serde::Deserialize)]
struct ImportQuotesBody {
    quotes: Vec<QuoteImport>,
    #[serde(rename = "overwriteExisting")]
    overwrite_existing: bool,
}

async fn import_quotes_csv(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ImportQuotesBody>,
) -> ApiResult<Json<Vec<QuoteImport>>> {
    let result = state
        .quote_service
        .import_quotes(body.quotes, body.overwrite_existing)
        .await?;

    // Quote import - no market sync needed, but force full recalculation
    // so historical valuations are recomputed with the imported quotes
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

    Ok(Json(result))
}

#[derive(serde::Deserialize)]
struct SyncBody {
    #[serde(rename = "assetIds")]
    asset_ids: Option<Vec<String>>,
    #[serde(rename = "refetchAll")]
    refetch_all: bool,
    #[serde(rename = "refetchRecentDays")]
    refetch_recent_days: Option<i64>,
}

async fn sync_market_data(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SyncBody>,
) -> ApiResult<StatusCode> {
    // Determine the appropriate market sync mode based on refetch flags
    let market_sync_mode = if let Some(days) = body.refetch_recent_days {
        MarketSyncMode::RefetchRecent {
            asset_ids: body.asset_ids,
            days,
        }
    } else if body.refetch_all {
        MarketSyncMode::BackfillHistory {
            asset_ids: body.asset_ids,
            days: 365 * 5, // 5 years of history as fallback
        }
    } else {
        MarketSyncMode::Incremental {
            asset_ids: body.asset_ids,
        }
    };

    enqueue_portfolio_job(
        state,
        PortfolioJobConfig {
            account_ids: None,
            market_sync_mode,
            snapshot_mode: SnapshotRecalcMode::IncrementalFromLast,
            valuation_mode: ValuationRecalcMode::IncrementalFromLast,
            since_date: None,
        },
    );
    Ok(StatusCode::NO_CONTENT)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LatestQuotesBody {
    asset_ids: Vec<String>,
}

async fn get_latest_quotes(
    State(state): State<Arc<AppState>>,
    Json(body): Json<LatestQuotesBody>,
) -> ApiResult<Json<std::collections::HashMap<String, LatestQuoteSnapshot>>> {
    let quotes = state
        .quote_service
        .get_latest_quotes_snapshot(&body.asset_ids)?;
    Ok(Json(quotes))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveSymbolQuoteQuery {
    symbol: String,
    exchange_mic: Option<String>,
    instrument_type: Option<String>,
    quote_ccy: Option<String>,
    provider_id: Option<String>,
}

async fn resolve_symbol_quote(
    State(state): State<Arc<AppState>>,
    Query(q): Query<ResolveSymbolQuoteQuery>,
) -> ApiResult<Json<wealthfolio_core::quotes::ResolvedQuote>> {
    let inst_type = q
        .instrument_type
        .as_deref()
        .and_then(wealthfolio_core::assets::InstrumentType::from_external_str);
    let res = state
        .quote_service
        .resolve_symbol_quote(
            &q.symbol,
            q.exchange_mic.as_deref(),
            inst_type.as_ref(),
            q.quote_ccy.as_deref(),
            q.provider_id.as_deref(),
        )
        .await?;
    Ok(Json(res))
}

async fn get_exchanges() -> Json<Vec<ExchangeInfo>> {
    Json(wealthfolio_market_data::get_exchange_list())
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/exchanges", get(get_exchanges))
        .route("/providers", get(get_market_data_providers))
        .route(
            "/providers/settings",
            get(get_market_data_provider_settings).put(update_market_data_provider_settings),
        )
        .route("/market-data/search", get(search_symbol))
        .route("/market-data/resolve-currency", get(resolve_symbol_quote))
        .route("/market-data/quotes/history", get(get_quote_history))
        .route("/market-data/dividends", get(fetch_dividends))
        .route("/market-data/quotes/latest", post(get_latest_quotes))
        .route("/market-data/quotes/{symbol}", put(update_quote))
        .route("/market-data/quotes/id/{id}", delete(delete_quote))
        .route("/market-data/quotes/check", post(check_quotes_import))
        .route("/market-data/quotes/import", post(import_quotes_csv))
        .route("/market-data/sync/history", post(sync_history_quotes))
        .route("/market-data/sync", post(sync_market_data))
}
