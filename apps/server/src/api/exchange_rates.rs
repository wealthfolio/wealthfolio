use std::sync::Arc;

use crate::{
    api::shared::{trigger_full_portfolio_recalc, trigger_portfolio_recalc_with_asset_sync},
    error::ApiResult,
    main_lib::AppState,
};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{delete, get, put},
    Json, Router,
};
use wealthfolio_core::fx::{ExchangeRate, NewExchangeRate};
use wealthfolio_core::quotes::DATA_SOURCE_MANUAL;

async fn get_latest_exchange_rates(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<Vec<ExchangeRate>>> {
    let rates = state.fx_service.get_latest_exchange_rates()?;
    Ok(Json(rates))
}

async fn update_exchange_rate(
    State(state): State<Arc<AppState>>,
    Json(rate): Json<ExchangeRate>,
) -> ApiResult<Json<ExchangeRate>> {
    let updated = state
        .fx_service
        .update_exchange_rate(&rate.from_currency, &rate.to_currency, rate.rate)
        .await?;
    trigger_full_portfolio_recalc(state.clone());
    Ok(Json(updated))
}

async fn add_exchange_rate(
    State(state): State<Arc<AppState>>,
    Json(new_rate): Json<NewExchangeRate>,
) -> ApiResult<Json<ExchangeRate>> {
    let added = state.fx_service.add_exchange_rate(new_rate).await?;
    // Manual rates are saved as-is and need no market sync. Provider-backed
    // pairs store no quote on add (#1143); sync their real rate now so the pair
    // populates immediately instead of waiting for the next periodic sync.
    if added.source == DATA_SOURCE_MANUAL {
        trigger_full_portfolio_recalc(state.clone());
    } else {
        trigger_portfolio_recalc_with_asset_sync(state.clone(), vec![added.id.clone()]);
    }
    Ok(Json(added))
}

async fn delete_exchange_rate(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> ApiResult<StatusCode> {
    state.fx_service.delete_exchange_rate(&id).await?;
    trigger_full_portfolio_recalc(state);
    Ok(StatusCode::NO_CONTENT)
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/exchange-rates/latest", get(get_latest_exchange_rates))
        .route(
            "/exchange-rates",
            put(update_exchange_rate).post(add_exchange_rate),
        )
        .route("/exchange-rates/{id}", delete(delete_exchange_rate))
}
