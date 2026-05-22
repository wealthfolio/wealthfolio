use std::sync::Arc;

use crate::{error::ApiResult, main_lib::AppState};
use axum::{
    extract::{Query, State},
    routing::{get, post},
    Json, Router,
};
use wealthfolio_core::{
    accounts::{AccountServiceTrait, TrackingMode},
    portfolio::{
        income::IncomeSummary,
        performance::{PerformanceMetrics, SimplePerformanceMetrics},
    },
};

use super::shared::parse_date_optional;

#[derive(serde::Deserialize)]
struct AccountsSimplePerfBody {
    #[serde(rename = "accountIds")]
    account_ids: Option<Vec<String>>,
}

async fn calculate_accounts_simple_performance(
    State(state): State<Arc<AppState>>,
    Json(body): Json<AccountsSimplePerfBody>,
) -> ApiResult<Json<Vec<SimplePerformanceMetrics>>> {
    let ids = if let Some(ids) = body.account_ids {
        ids
    } else {
        state
            .account_service
            .get_active_accounts()?
            .into_iter()
            .map(|a| a.id)
            .collect()
    };
    if ids.is_empty() {
        return Ok(Json(Vec::new()));
    }
    let metrics = state
        .performance_service
        .calculate_accounts_simple_performance(&ids)?;
    Ok(Json(metrics))
}

#[derive(serde::Deserialize)]
struct PerfBody {
    #[serde(rename = "itemType")]
    item_type: String,
    #[serde(rename = "itemId")]
    item_id: String,
    #[serde(rename = "startDate")]
    start_date: Option<String>,
    #[serde(rename = "endDate")]
    end_date: Option<String>,
    #[serde(rename = "trackingMode")]
    tracking_mode: Option<String>,
}

fn parse_tracking_mode(mode: Option<String>) -> Option<TrackingMode> {
    mode.and_then(|m| match m.as_str() {
        "HOLDINGS" => Some(TrackingMode::Holdings),
        "TRANSACTIONS" => Some(TrackingMode::Transactions),
        _ => None,
    })
}

async fn calculate_performance_history(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PerfBody>,
) -> ApiResult<Json<PerformanceMetrics>> {
    let start = parse_date_optional(body.start_date, "startDate")?;
    let end = parse_date_optional(body.end_date, "endDate")?;
    let tracking_mode = parse_tracking_mode(body.tracking_mode);
    let metrics = state
        .performance_service
        .calculate_performance_history(&body.item_type, &body.item_id, start, end, tracking_mode)
        .await?;
    Ok(Json(metrics))
}

async fn calculate_performance_summary(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PerfBody>,
) -> ApiResult<Json<PerformanceMetrics>> {
    let start = parse_date_optional(body.start_date, "startDate")?;
    let end = parse_date_optional(body.end_date, "endDate")?;
    let tracking_mode = parse_tracking_mode(body.tracking_mode);
    let metrics = state
        .performance_service
        .calculate_performance_summary(&body.item_type, &body.item_id, start, end, tracking_mode)
        .await?;
    Ok(Json(metrics))
}

#[derive(serde::Deserialize)]
struct IncomeSummaryAccountQuery {
    #[serde(rename = "accountId")]
    account_id: Option<String>,
}

/// GET /income/summary?accountId=... — single-account or all-accounts scope
async fn get_income_summary_for_account(
    State(state): State<Arc<AppState>>,
    Query(q): Query<IncomeSummaryAccountQuery>,
) -> ApiResult<Json<Vec<IncomeSummary>>> {
    let account_ids: Option<Vec<String>> = q.account_id.map(|id| vec![id]);
    let items = state
        .income_service
        .get_income_summary(account_ids.as_deref())?;
    Ok(Json(items))
}

#[derive(serde::Deserialize)]
struct IncomeSummaryBody {
    filter: Option<wealthfolio_core::portfolios::AccountScope>,
}

/// POST /income/summary/query — typed scope query (all, portfolio, multi-account)
async fn get_income_summary(
    State(state): State<Arc<AppState>>,
    Json(body): Json<IncomeSummaryBody>,
) -> ApiResult<Json<Vec<IncomeSummary>>> {
    use wealthfolio_core::portfolios::ResolvedAccountScope;

    let account_ids: Option<Vec<String>> = match &body.filter {
        None => None,
        Some(filter) => match state
            .portfolio_service
            .resolve_account_scope(filter)
            .map_err(crate::error::ApiError::from)?
        {
            ResolvedAccountScope::TotalSnapshot => None,
            ResolvedAccountScope::Account(id) => Some(vec![id]),
            ResolvedAccountScope::Accounts(ids) => Some(ids),
        },
    };
    let items = state
        .income_service
        .get_income_summary(account_ids.as_deref())?;
    Ok(Json(items))
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route(
            "/performance/accounts/simple",
            post(calculate_accounts_simple_performance),
        )
        .route("/performance/history", post(calculate_performance_history))
        .route("/performance/summary", post(calculate_performance_summary))
        .route("/income/summary", get(get_income_summary_for_account))
        .route("/income/summary/query", post(get_income_summary))
}
