use std::sync::Arc;

use crate::{error::ApiResult, main_lib::AppState};
use axum::{
    extract::{Query, State},
    routing::get,
    Json, Router,
};
use wealthfolio_core::portfolio::net_worth::{NetWorthHistoryPoint, NetWorthResponse};
use wealthfolio_core::utils::time_utils::{parse_user_timezone_or_default, user_today};

use super::shared::{parse_date, parse_date_optional};

#[derive(serde::Deserialize)]
struct NetWorthQuery {
    /// Optional date in ISO format (YYYY-MM-DD). Defaults to today.
    date: Option<String>,
}

async fn get_net_worth(
    State(state): State<Arc<AppState>>,
    Query(q): Query<NetWorthQuery>,
) -> ApiResult<Json<NetWorthResponse>> {
    let as_of_date = parse_date_optional(q.date, "date")?.unwrap_or_else(|| {
        user_today(parse_user_timezone_or_default(
            &state.timezone.read().unwrap(),
        ))
    });
    let response = state.net_worth_service.get_net_worth(as_of_date).await?;
    Ok(Json(response))
}

#[derive(serde::Deserialize)]
struct NetWorthHistoryQuery {
    /// Start date in ISO format (YYYY-MM-DD)
    #[serde(rename = "startDate")]
    start_date: String,
    /// End date in ISO format (YYYY-MM-DD)
    #[serde(rename = "endDate")]
    end_date: String,
}

async fn get_net_worth_history(
    State(state): State<Arc<AppState>>,
    Query(q): Query<NetWorthHistoryQuery>,
) -> ApiResult<Json<Vec<NetWorthHistoryPoint>>> {
    let start = parse_date(&q.start_date, "startDate")?;
    let end = parse_date(&q.end_date, "endDate")?;

    let history = state.net_worth_service.get_net_worth_history(start, end)?;
    Ok(Json(history))
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/net-worth", get(get_net_worth))
        .route("/net-worth/history", get(get_net_worth_history))
}
