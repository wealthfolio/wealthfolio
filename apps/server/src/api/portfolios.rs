use std::sync::Arc;

use crate::{error::ApiResult, main_lib::AppState};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::get,
    Json, Router,
};
use wealthfolio_core::portfolios::{NewPortfolio, PortfolioUpdate, PortfolioWithAccounts};

async fn list_portfolios(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<Vec<PortfolioWithAccounts>>> {
    let portfolios = state.portfolio_service.list_portfolios()?;
    Ok(Json(portfolios))
}

async fn get_portfolio(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<PortfolioWithAccounts>> {
    let portfolio = state.portfolio_service.get_portfolio(&id)?;
    Ok(Json(portfolio))
}

async fn create_portfolio(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<NewPortfolio>,
) -> ApiResult<Json<PortfolioWithAccounts>> {
    let created = state.portfolio_service.create_portfolio(payload).await?;
    Ok(Json(created))
}

async fn update_portfolio(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
    Json(mut payload): Json<PortfolioUpdate>,
) -> ApiResult<Json<PortfolioWithAccounts>> {
    payload.id = id;
    let updated = state.portfolio_service.update_portfolio(payload).await?;
    Ok(Json(updated))
}

async fn delete_portfolio(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> ApiResult<StatusCode> {
    state.portfolio_service.delete_portfolio(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/portfolios", get(list_portfolios).post(create_portfolio))
        .route(
            "/portfolios/{id}",
            get(get_portfolio)
                .put(update_portfolio)
                .delete(delete_portfolio),
        )
}
