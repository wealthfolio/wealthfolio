use std::sync::Arc;

use crate::{
    api::shared::trigger_lightweight_portfolio_update, error::ApiResult, main_lib::AppState,
};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{get, put},
    Json, Router,
};
use wealthfolio_core::{
    accounts::{account_supports_purpose, AccountPurpose, AccountServiceTrait},
    limits::{ContributionLimit, DepositsCalculation, NewContributionLimit},
};

fn validate_contribution_limit_accounts(
    state: &AppState,
    limit: &NewContributionLimit,
) -> ApiResult<()> {
    let Some(account_ids) = limit.account_ids.as_deref() else {
        return Ok(());
    };
    let ids: Vec<String> = account_ids
        .split(',')
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .collect();
    if ids.is_empty() {
        return Ok(());
    }

    let accounts = state.account_service.get_accounts_by_ids(&ids)?;
    let allowed: std::collections::HashSet<String> = accounts
        .into_iter()
        .filter(|account| {
            account_supports_purpose(&account.account_type, AccountPurpose::ContributionLimits)
        })
        .map(|account| account.id)
        .collect();
    let invalid: Vec<String> = ids.into_iter().filter(|id| !allowed.contains(id)).collect();
    if invalid.is_empty() {
        Ok(())
    } else {
        Err(crate::error::ApiError::BadRequest(format!(
            "Contribution limits do not support account(s): {}",
            invalid.join(", ")
        )))
    }
}

async fn get_contribution_limits(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<Vec<ContributionLimit>>> {
    let limits = state.limits_service.get_contribution_limits()?;
    Ok(Json(limits))
}

async fn create_contribution_limit(
    State(state): State<Arc<AppState>>,
    Json(new_limit): Json<NewContributionLimit>,
) -> ApiResult<Json<ContributionLimit>> {
    validate_contribution_limit_accounts(&state, &new_limit)?;
    let created = state
        .limits_service
        .create_contribution_limit(new_limit)
        .await?;
    trigger_lightweight_portfolio_update(state.clone());
    Ok(Json(created))
}

async fn update_contribution_limit(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
    Json(updated): Json<NewContributionLimit>,
) -> ApiResult<Json<ContributionLimit>> {
    validate_contribution_limit_accounts(&state, &updated)?;
    let updated = state
        .limits_service
        .update_contribution_limit(&id, updated)
        .await?;
    trigger_lightweight_portfolio_update(state.clone());
    Ok(Json(updated))
}

async fn delete_contribution_limit(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> ApiResult<StatusCode> {
    state.limits_service.delete_contribution_limit(&id).await?;
    trigger_lightweight_portfolio_update(state);
    Ok(StatusCode::NO_CONTENT)
}

async fn calculate_deposits_for_contribution_limit(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<DepositsCalculation>> {
    let base = state.base_currency.read().unwrap().clone();
    let calc = state
        .limits_service
        .calculate_deposits_for_contribution_limit(&id, &base)?;
    Ok(Json(calc))
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route(
            "/limits",
            get(get_contribution_limits).post(create_contribution_limit),
        )
        .route(
            "/limits/{id}",
            put(update_contribution_limit).delete(delete_contribution_limit),
        )
        .route(
            "/limits/{id}/deposits",
            get(calculate_deposits_for_contribution_limit),
        )
}
