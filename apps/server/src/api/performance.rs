use std::{collections::HashMap, sync::Arc};

use crate::{error::ApiResult, main_lib::AppState};
use axum::{
    extract::{Query, State},
    routing::{get, post},
    Json, Router,
};
use rust_decimal::Decimal;
use wealthfolio_core::{
    accounts::{account_supports_purpose, AccountPurpose, AccountServiceTrait, TrackingMode},
    portfolio::{
        income::IncomeSummary,
        performance::{PerformanceMetrics, ReturnMethod, SimplePerformanceMetrics},
    },
    portfolios::AccountScope,
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
    let ids: Vec<String> = if let Some(ids) = body.account_ids {
        state
            .account_service
            .get_accounts_by_ids(&ids)?
            .into_iter()
            .filter(|account| {
                account_supports_purpose(&account.account_type, AccountPurpose::Performance)
            })
            .map(|account| account.id)
            .collect()
    } else {
        state
            .account_service
            .get_active_accounts()?
            .into_iter()
            .filter(|account| {
                account_supports_purpose(&account.account_type, AccountPurpose::Performance)
            })
            .map(|account| account.id)
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
    filter: Option<AccountScope>,
}

fn parse_tracking_mode(mode: Option<String>) -> Option<TrackingMode> {
    mode.and_then(|m| match m.as_str() {
        "HOLDINGS" => Some(TrackingMode::Holdings),
        "TRANSACTIONS" => Some(TrackingMode::Transactions),
        _ => None,
    })
}

fn account_ids_for_purpose(
    state: &AppState,
    account_ids: &[String],
    purpose: AccountPurpose,
) -> ApiResult<Vec<String>> {
    Ok(state
        .account_service
        .get_accounts_by_ids(account_ids)?
        .into_iter()
        .filter(|account| account_supports_purpose(&account.account_type, purpose))
        .map(|account| account.id)
        .collect())
}

fn empty_performance_metrics(
    id: &str,
    currency: String,
    start_date: Option<chrono::NaiveDate>,
    end_date: Option<chrono::NaiveDate>,
) -> PerformanceMetrics {
    PerformanceMetrics {
        id: id.to_string(),
        returns: Vec::new(),
        period_start_date: start_date,
        period_end_date: end_date,
        currency,
        period_gain: Decimal::ZERO,
        period_return: Some(Decimal::ZERO),
        cumulative_twr: Some(Decimal::ZERO),
        gain_loss_amount: None,
        annualized_twr: Some(Decimal::ZERO),
        simple_return: Decimal::ZERO,
        annualized_simple_return: Decimal::ZERO,
        cumulative_modified_dietz: Some(Decimal::ZERO),
        annualized_modified_dietz: Some(Decimal::ZERO),
        cumulative_mwr: Some(Decimal::ZERO),
        annualized_mwr: Some(Decimal::ZERO),
        volatility: Decimal::ZERO,
        max_drawdown: Decimal::ZERO,
        is_holdings_mode: false,
        return_method: ReturnMethod::NotApplicable,
        is_mixed_tracking_mode: false,
        warnings: Vec::new(),
    }
}

fn account_tracking_modes(
    state: &AppState,
    account_ids: &[String],
) -> Result<HashMap<String, TrackingMode>, crate::error::ApiError> {
    Ok(state
        .account_service
        .get_accounts_by_ids(account_ids)?
        .into_iter()
        .map(|account| (account.id, account.tracking_mode))
        .collect())
}

fn performance_account_ids(
    state: &AppState,
    account_ids: &[String],
) -> Result<Vec<String>, crate::error::ApiError> {
    Ok(state
        .account_service
        .get_accounts_by_ids(account_ids)?
        .into_iter()
        .filter(|account| {
            account_supports_purpose(&account.account_type, AccountPurpose::Performance)
        })
        .map(|account| account.id)
        .collect())
}

async fn calculate_performance_history(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PerfBody>,
) -> ApiResult<Json<PerformanceMetrics>> {
    let start = parse_date_optional(body.start_date, "startDate")?;
    let end = parse_date_optional(body.end_date, "endDate")?;
    let tracking_mode = parse_tracking_mode(body.tracking_mode);
    let metrics = if let (true, Some(filter)) = (body.item_type == "account", body.filter.as_ref())
    {
        let base = state.base_currency.read().unwrap().clone();
        let resolved = state
            .portfolio_service
            .resolve_account_scope(filter, &base)
            .map_err(crate::error::ApiError::from)?;
        let account_ids = performance_account_ids(&state, &resolved.account_ids)?;
        if account_ids.is_empty() {
            return Ok(Json(empty_performance_metrics(
                &resolved.scope_id,
                resolved.base_currency.clone(),
                start,
                end,
            )));
        }
        let tracking_modes = account_tracking_modes(&state, &account_ids)?;
        state
            .performance_service
            .calculate_performance_history_for_accounts(
                &resolved.scope_id,
                &account_ids,
                &resolved.base_currency,
                &tracking_modes,
                start,
                end,
            )
            .await?
    } else {
        if body.item_type == "account" {
            let account = state.account_service.get_account(&body.item_id)?;
            if !account_supports_purpose(&account.account_type, AccountPurpose::Performance) {
                return Ok(Json(empty_performance_metrics(
                    &body.item_id,
                    account.currency,
                    start,
                    end,
                )));
            }
        }
        state
            .performance_service
            .calculate_performance_history(
                &body.item_type,
                &body.item_id,
                start,
                end,
                tracking_mode,
            )
            .await?
    };
    Ok(Json(metrics))
}

async fn calculate_performance_summary(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PerfBody>,
) -> ApiResult<Json<PerformanceMetrics>> {
    let start = parse_date_optional(body.start_date, "startDate")?;
    let end = parse_date_optional(body.end_date, "endDate")?;
    let tracking_mode = parse_tracking_mode(body.tracking_mode);
    let metrics = if let (true, Some(filter)) = (body.item_type == "account", body.filter.as_ref())
    {
        let base = state.base_currency.read().unwrap().clone();
        let resolved = state
            .portfolio_service
            .resolve_account_scope(filter, &base)
            .map_err(crate::error::ApiError::from)?;
        let account_ids = performance_account_ids(&state, &resolved.account_ids)?;
        if account_ids.is_empty() {
            return Ok(Json(empty_performance_metrics(
                &resolved.scope_id,
                resolved.base_currency.clone(),
                start,
                end,
            )));
        }
        let tracking_modes = account_tracking_modes(&state, &account_ids)?;
        state
            .performance_service
            .calculate_performance_summary_for_accounts(
                &resolved.scope_id,
                &account_ids,
                &resolved.base_currency,
                &tracking_modes,
                start,
                end,
            )
            .await?
    } else {
        if body.item_type == "account" {
            let account = state.account_service.get_account(&body.item_id)?;
            if !account_supports_purpose(&account.account_type, AccountPurpose::Performance) {
                return Ok(Json(empty_performance_metrics(
                    &body.item_id,
                    account.currency,
                    start,
                    end,
                )));
            }
        }
        state
            .performance_service
            .calculate_performance_summary(
                &body.item_type,
                &body.item_id,
                start,
                end,
                tracking_mode,
            )
            .await?
    };
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
    let account_ids: Vec<String> = if let Some(id) = q.account_id {
        account_ids_for_purpose(&state, &[id], AccountPurpose::Income)?
    } else {
        state
            .account_service
            .get_active_accounts()?
            .into_iter()
            .filter(|account| {
                account_supports_purpose(&account.account_type, AccountPurpose::Income)
            })
            .map(|account| account.id)
            .collect()
    };
    if account_ids.is_empty() {
        return Ok(Json(Vec::new()));
    }
    let items = state
        .income_service
        .get_income_summary(Some(&account_ids))?;
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
    let account_ids: Vec<String> = match &body.filter {
        None => state
            .account_service
            .get_active_accounts()?
            .into_iter()
            .filter(|account| {
                account_supports_purpose(&account.account_type, AccountPurpose::Income)
            })
            .map(|account| account.id)
            .collect(),
        Some(filter) => {
            let base = state.base_currency.read().unwrap().clone();
            let resolved = state
                .portfolio_service
                .resolve_account_scope(filter, &base)
                .map_err(crate::error::ApiError::from)?;
            account_ids_for_purpose(&state, &resolved.account_ids, AccountPurpose::Income)?
        }
    };
    if account_ids.is_empty() {
        return Ok(Json(Vec::new()));
    }
    let items = state
        .income_service
        .get_income_summary(Some(&account_ids))?;
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
