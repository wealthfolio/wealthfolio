use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use rust_decimal::Decimal;
use serde::Deserialize;
use wealthfolio_core::{
    accounts::AccountPurpose,
    portfolio::allocation_targets::{
        AllocationTarget, AllocationTargetConstraint, AllocationTargetWeight,
        CalculateRebalancePlanInput, DriftReport, NewAllocationTarget, NewAllocationTargetWeight,
        RebalancePlan, SaveAllocationTargetResult, ScenarioMode, ScopeType,
    },
    portfolios::AccountScope,
};

use crate::{
    error::{ApiError, ApiResult},
    main_lib::AppState,
};

fn scope_id_for_target(target: &AllocationTarget) -> ApiResult<String> {
    target
        .scope_id
        .clone()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| {
            ApiError::BadRequest(format!(
                "Allocation target {} is missing scope_id for scoped drift",
                target.id
            ))
        })
}

fn account_scope_for_target(target: &AllocationTarget) -> ApiResult<AccountScope> {
    match &target.scope_type {
        ScopeType::All => Ok(AccountScope::All),
        ScopeType::Account => Ok(AccountScope::Account {
            account_id: scope_id_for_target(target)?,
        }),
        ScopeType::Portfolio => Ok(AccountScope::Portfolio {
            portfolio_id: scope_id_for_target(target)?,
        }),
    }
}

// ── Target CRUD ──────────────────────────────────────────────────────────────

async fn list_targets(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<Vec<AllocationTarget>>> {
    let targets = state.allocation_target_service.list_targets()?;
    Ok(Json(targets))
}

async fn get_target(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<Option<AllocationTarget>>> {
    let target = state.allocation_target_service.get_target(&id)?;
    Ok(Json(target))
}

async fn create_target(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<NewAllocationTarget>,
) -> ApiResult<Json<AllocationTarget>> {
    let created = state
        .allocation_target_service
        .create_target(payload)
        .await?;
    Ok(Json(created))
}

async fn update_target(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<NewAllocationTarget>,
) -> ApiResult<Json<AllocationTarget>> {
    let updated = state
        .allocation_target_service
        .update_target(&id, payload)
        .await?;
    Ok(Json(updated))
}

async fn archive_target(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<AllocationTarget>> {
    let target = state.allocation_target_service.archive_target(&id).await?;
    Ok(Json(target))
}

async fn delete_target(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> ApiResult<StatusCode> {
    state.allocation_target_service.delete_target(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

// ── Weights ─────────────────────────────────────────────────────────────────────

async fn list_weights(
    Path(target_id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<Vec<AllocationTargetWeight>>> {
    let weights = state
        .allocation_target_service
        .list_weights_for_target(&target_id)?;
    Ok(Json(weights))
}

async fn save_weights(
    Path(target_id): Path<String>,
    State(state): State<Arc<AppState>>,
    Json(weights): Json<Vec<NewAllocationTargetWeight>>,
) -> ApiResult<Json<Vec<AllocationTargetWeight>>> {
    let saved = state
        .allocation_target_service
        .save_weights(&target_id, weights)
        .await?;
    Ok(Json(saved))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveTargetWithWeightsBody {
    id: Option<String>,
    input: NewAllocationTarget,
    weights: Vec<NewAllocationTargetWeight>,
}

async fn save_target_with_weights(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SaveTargetWithWeightsBody>,
) -> ApiResult<Json<SaveAllocationTargetResult>> {
    let saved = state
        .allocation_target_service
        .save_target_with_weights(body.id, body.input, body.weights)
        .await?;
    Ok(Json(saved))
}

// ── Drift ─────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DriftBody {
    filter: AccountScope,
    #[serde(default)]
    include_holdings: bool,
}

async fn get_drift_for_target(
    Path(target_id): Path<String>,
    State(state): State<Arc<AppState>>,
    Json(body): Json<DriftBody>,
) -> ApiResult<Json<DriftReport>> {
    let base_currency = state.base_currency.read().unwrap().clone();
    let _ = &body.filter;
    let target = state
        .allocation_target_service
        .get_target(&target_id)?
        .ok_or(ApiError::NotFound)?;
    let filter = account_scope_for_target(&target)?;
    let resolved = state
        .portfolio_service
        .resolve_account_scope_for_purpose(&filter, &base_currency, AccountPurpose::Holdings)
        .map_err(crate::error::ApiError::from)?;

    let report = if body.include_holdings {
        state
            .drift_service
            .get_drift_report_with_holdings_for_target(
                &target_id,
                &resolved.account_ids,
                &base_currency,
                &resolved.scope_id,
            )
            .await?
    } else {
        state
            .drift_service
            .get_drift_report_for_target(
                &target_id,
                &resolved.account_ids,
                &base_currency,
                &resolved.scope_id,
            )
            .await?
    };
    Ok(Json(report))
}

// ── Rebalance ─────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CalculatePlanBody {
    target_id: String,
    available_cash: Decimal,
    #[serde(default)]
    scenario_mode: ScenarioMode,
    filter: AccountScope,
}

fn resolve_rebalance_input(
    state: &Arc<AppState>,
    target_id: String,
    available_cash: Decimal,
    scenario_mode: ScenarioMode,
    filter: &AccountScope,
) -> ApiResult<CalculateRebalancePlanInput> {
    let base_currency = state.base_currency.read().unwrap().clone();
    let resolved = state
        .portfolio_service
        .resolve_account_scope_for_purpose(filter, &base_currency, AccountPurpose::Holdings)
        .map_err(crate::error::ApiError::from)?;
    Ok(CalculateRebalancePlanInput {
        target_id,
        available_cash,
        account_ids: resolved.account_ids,
        base_currency,
        aggregated_account_id: resolved.scope_id,
        scenario_mode,
    })
}

async fn calculate_plan(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CalculatePlanBody>,
) -> ApiResult<Json<RebalancePlan>> {
    let input = resolve_rebalance_input(
        &state,
        body.target_id,
        body.available_cash,
        body.scenario_mode,
        &body.filter,
    )?;
    let plan = state.rebalance_service.calculate_plan(input).await?;
    Ok(Json(plan))
}

// ── Sell constraints ─────────────────────────────────────────────────────────

async fn list_target_constraints_handler(
    State(state): State<Arc<AppState>>,
    Path(target_id): Path<String>,
) -> ApiResult<Json<Vec<AllocationTargetConstraint>>> {
    let constraints = state
        .allocation_target_service
        .list_target_constraints(&target_id)?;
    Ok(Json(constraints))
}

async fn save_target_constraints_handler(
    State(state): State<Arc<AppState>>,
    Path(target_id): Path<String>,
    Json(constraints): Json<Vec<AllocationTargetConstraint>>,
) -> ApiResult<Json<Vec<AllocationTargetConstraint>>> {
    let saved = state
        .allocation_target_service
        .save_target_constraints(&target_id, constraints)
        .await?;
    Ok(Json(saved))
}

// ── Router ────────────────────────────────────────────────────────────────────

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/allocation-targets", get(list_targets).post(create_target))
        .route(
            "/allocation-targets/save-with-weights",
            post(save_target_with_weights),
        )
        .route(
            "/allocation-targets/{id}",
            get(get_target).put(update_target).delete(delete_target),
        )
        .route("/allocation-targets/{id}/archive", post(archive_target))
        .route(
            "/allocation-targets/{id}/weights",
            get(list_weights).post(save_weights),
        )
        .route(
            "/allocation-targets/{id}/constraints",
            get(list_target_constraints_handler).post(save_target_constraints_handler),
        )
        .route("/allocation-targets/{id}/drift", post(get_drift_for_target))
        .route(
            "/allocation-targets/rebalance/calculate",
            post(calculate_plan),
        )
}
