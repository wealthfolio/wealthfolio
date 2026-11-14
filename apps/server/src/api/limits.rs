use std::sync::Arc;

use crate::{
    api::shared::trigger_lightweight_portfolio_update, error::ApiResult, main_lib::AppState,
};
use axum::{
    extract::Path,
    http::StatusCode,
    routing::{get, put},
    Json, Router,
};
use wealthfolio_core::limits::{
    check_contribution_limit_accounts, ContributionLimit, ContributionLimitDetails,
    DepositsCalculation, NewContributionLimit,
};

async fn get_contribution_limits(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
) -> ApiResult<Json<Vec<ContributionLimit>>> {
    let limits = state.limits_service.get_contribution_limits()?;
    Ok(Json(limits))
}

async fn create_contribution_limit(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Json(mut new_limit): Json<NewContributionLimit>,
) -> ApiResult<Json<ContributionLimit>> {
    check_contribution_limit_accounts(state.account_service.as_ref(), &mut new_limit)?;
    let created = state
        .limits_service
        .create_contribution_limit(new_limit)
        .await?;
    trigger_lightweight_portfolio_update(state.clone());
    Ok(Json(created))
}

async fn update_contribution_limit(
    Path(id): Path<String>,
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Json(mut updated): Json<NewContributionLimit>,
) -> ApiResult<Json<ContributionLimit>> {
    check_contribution_limit_accounts(state.account_service.as_ref(), &mut updated)?;
    let updated = state
        .limits_service
        .update_contribution_limit(&id, updated)
        .await?;
    trigger_lightweight_portfolio_update(state.clone());
    Ok(Json(updated))
}

async fn delete_contribution_limit(
    Path(id): Path<String>,
    axum::Extension(state): axum::Extension<Arc<AppState>>,
) -> ApiResult<StatusCode> {
    state.limits_service.delete_contribution_limit(&id).await?;
    trigger_lightweight_portfolio_update(state);
    Ok(StatusCode::NO_CONTENT)
}

async fn calculate_deposits_for_contribution_limit(
    Path(id): Path<String>,
    axum::Extension(state): axum::Extension<Arc<AppState>>,
) -> ApiResult<Json<DepositsCalculation>> {
    let base = state
        .base_currency
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    let calc = state
        .limits_service
        .calculate_deposits_for_contribution_limit(&id, &base)?;
    Ok(Json(calc))
}

async fn get_contribution_limit_details(
    Path(id): Path<String>,
    axum::Extension(state): axum::Extension<Arc<AppState>>,
) -> ApiResult<Json<ContributionLimitDetails>> {
    let base = state
        .base_currency
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    Ok(Json(
        state
            .limits_service
            .get_contribution_limit_details(&id, &base)?,
    ))
}

#[derive(serde::Deserialize)]
struct ContributionActivityExclusion {
    excluded: bool,
}

async fn set_contribution_activity_excluded(
    Path((id, activity_id)): Path<(String, String)>,
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Json(request): Json<ContributionActivityExclusion>,
) -> ApiResult<StatusCode> {
    state
        .limits_service
        .set_contribution_activity_excluded(&id, &activity_id, request.excluded)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub fn router<S: Clone + Send + Sync + 'static>() -> Router<S> {
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
        .route("/limits/{id}/details", get(get_contribution_limit_details))
        .route(
            "/limits/{id}/activities/{activity_id}",
            put(set_contribution_activity_excluded),
        )
}
