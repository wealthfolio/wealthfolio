use std::sync::Arc;

use axum::{
    extract::Path,
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use wealthfolio_core::{
    accounts::AccountPurpose,
    portfolio::allocation_targets::{
        AllocationRule, AllocationTarget, AllocationTargetConstraint, AllocationTargetWeight,
        AllocationWorksheetLineInput, AllocationWorksheetResult, CalculateAllocationWorksheetInput,
        CalculatedAdjustments, DriftReport, GenerateCalculatedAdjustmentsInput,
        NewAllocationTarget, NewAllocationTargetWeight, SaveAllocationTargetResult, ScopeType,
        WorksheetCashInput, WorksheetMode,
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
    axum::Extension(state): axum::Extension<Arc<AppState>>,
) -> ApiResult<Json<Vec<AllocationTarget>>> {
    let targets = state.allocation_target_service.list_targets()?;
    Ok(Json(targets))
}

async fn get_target(
    Path(id): Path<String>,
    axum::Extension(state): axum::Extension<Arc<AppState>>,
) -> ApiResult<Json<Option<AllocationTarget>>> {
    let target = state.allocation_target_service.get_target(&id)?;
    Ok(Json(target))
}

async fn create_target(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
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
    axum::Extension(state): axum::Extension<Arc<AppState>>,
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
    axum::Extension(state): axum::Extension<Arc<AppState>>,
) -> ApiResult<Json<AllocationTarget>> {
    let target = state.allocation_target_service.archive_target(&id).await?;
    Ok(Json(target))
}

async fn delete_target(
    Path(id): Path<String>,
    axum::Extension(state): axum::Extension<Arc<AppState>>,
) -> ApiResult<StatusCode> {
    state.allocation_target_service.delete_target(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

// ── Weights ─────────────────────────────────────────────────────────────────────

async fn list_weights(
    Path(target_id): Path<String>,
    axum::Extension(state): axum::Extension<Arc<AppState>>,
) -> ApiResult<Json<Vec<AllocationTargetWeight>>> {
    let weights = state
        .allocation_target_service
        .list_weights_for_target(&target_id)?;
    Ok(Json(weights))
}

async fn save_weights(
    Path(target_id): Path<String>,
    axum::Extension(state): axum::Extension<Arc<AppState>>,
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
    axum::Extension(state): axum::Extension<Arc<AppState>>,
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
    axum::Extension(state): axum::Extension<Arc<AppState>>,
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

// ── Allocation worksheet ──────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GenerateAdjustmentsBody {
    target_id: String,
    mode: WorksheetMode,
    rule: AllocationRule,
    cash: WorksheetCashInput,
    #[serde(default)]
    eligible_asset_ids: Option<Vec<String>>,
    selected_account_ids: Vec<String>,
    filter: AccountScope,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CalculateWorksheetBody {
    target_id: String,
    cash: WorksheetCashInput,
    lines: Vec<AllocationWorksheetLineInput>,
    selected_account_ids: Vec<String>,
    filter: AccountScope,
}

/// The accounts a worksheet runs on, resolved from the target itself.
struct WorksheetScope {
    account_ids: Vec<String>,
    base_currency: String,
    aggregated_account_id: String,
}

/// A worksheet is built against the page's accounts and calculated against the
/// target's. The two must agree, or the adjustments on screen would be
/// validated against accounts the user never saw.
fn resolve_worksheet_scope(
    state: &Arc<AppState>,
    target_id: &str,
    filter: &AccountScope,
) -> ApiResult<WorksheetScope> {
    let base_currency = state.base_currency.read().unwrap().clone();
    let requested = state
        .portfolio_service
        .resolve_account_scope_for_purpose(filter, &base_currency, AccountPurpose::Holdings)
        .map_err(ApiError::from)?;
    let target = state
        .allocation_target_service
        .get_target(target_id)?
        .ok_or(ApiError::NotFound)?;
    let resolved = state
        .portfolio_service
        .resolve_account_scope_for_purpose(
            &account_scope_for_target(&target)?,
            &base_currency,
            AccountPurpose::Holdings,
        )
        .map_err(ApiError::from)?;

    let mut requested_ids = requested.account_ids;
    let mut target_ids = resolved.account_ids.clone();
    requested_ids.sort();
    target_ids.sort();
    if requested_ids != target_ids {
        return Err(ApiError::BadRequest(
            "Worksheet page scope does not match the selected target scope".to_string(),
        ));
    }

    Ok(WorksheetScope {
        account_ids: resolved.account_ids,
        base_currency,
        aggregated_account_id: resolved.scope_id,
    })
}

async fn generate_adjustments(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Json(body): Json<GenerateAdjustmentsBody>,
) -> ApiResult<Json<CalculatedAdjustments>> {
    let scope = resolve_worksheet_scope(&state, &body.target_id, &body.filter)?;
    let adjustments = state
        .allocation_worksheet_service
        .generate_adjustments(GenerateCalculatedAdjustmentsInput {
            target_id: body.target_id,
            account_ids: scope.account_ids,
            base_currency: scope.base_currency,
            aggregated_account_id: scope.aggregated_account_id,
            selected_account_ids: body.selected_account_ids,
            mode: body.mode,
            rule: body.rule,
            cash: body.cash,
            eligible_asset_ids: body.eligible_asset_ids,
        })
        .await?;
    Ok(Json(adjustments))
}

async fn calculate_worksheet(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Json(body): Json<CalculateWorksheetBody>,
) -> ApiResult<Json<AllocationWorksheetResult>> {
    let scope = resolve_worksheet_scope(&state, &body.target_id, &body.filter)?;
    let result = state
        .allocation_worksheet_service
        .calculate_worksheet(CalculateAllocationWorksheetInput {
            target_id: body.target_id,
            cash: body.cash,
            lines: body.lines,
            account_ids: scope.account_ids,
            base_currency: scope.base_currency,
            aggregated_account_id: scope.aggregated_account_id,
            selected_account_ids: body.selected_account_ids,
        })
        .await?;
    Ok(Json(result))
}

// ── Sell constraints ─────────────────────────────────────────────────────────

async fn list_target_constraints_handler(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Path(target_id): Path<String>,
) -> ApiResult<Json<Vec<AllocationTargetConstraint>>> {
    let constraints = state
        .allocation_target_service
        .list_target_constraints(&target_id)?;
    Ok(Json(constraints))
}

async fn save_target_constraints_handler(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
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

pub fn router<S: Clone + Send + Sync + 'static>() -> Router<S> {
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
            "/allocation-targets/worksheet/generate",
            post(generate_adjustments),
        )
        .route(
            "/allocation-targets/worksheet/calculate",
            post(calculate_worksheet),
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal::Decimal;

    #[test]
    fn generate_body_reads_external_cash_keyed_by_account() {
        let body: GenerateAdjustmentsBody = serde_json::from_value(serde_json::json!({
            "targetId": "target-1",
            "mode": "rebalance",
            "rule": "current_holding_proportions",
            "cash": {
                "trackedCashToUse": 250.5,
                "externalContribution": { "acc-1": 1000, "acc-2": 500.25 }
            },
            "eligibleAssetIds": [],
            "selectedAccountIds": ["acc-1"],
            "filter": { "type": "all" }
        }))
        .unwrap();

        assert_eq!(body.mode, WorksheetMode::Rebalance);
        assert_eq!(body.cash.tracked_cash_to_use, Decimal::new(2505, 1));
        assert_eq!(
            body.cash.external_contribution["acc-2"],
            Decimal::new(50025, 2)
        );
        assert_eq!(body.cash.external_total(), Decimal::new(150025, 2));
        assert_eq!(body.eligible_asset_ids, Some(vec![]));
    }

    #[test]
    fn generate_body_without_an_allowlist_means_every_recorded_security() {
        let body: GenerateAdjustmentsBody = serde_json::from_value(serde_json::json!({
            "targetId": "target-1",
            "mode": "invest_cash",
            "rule": "current_holding_proportions",
            "cash": { "trackedCashToUse": 0 },
            "selectedAccountIds": ["acc-1"],
            "filter": { "type": "all" }
        }))
        .unwrap();

        assert_eq!(body.eligible_asset_ids, None);
        assert!(body.cash.external_contribution.is_empty());
    }

    #[test]
    fn calculate_body_reads_lines_as_the_user_entered_them() {
        let body: CalculateWorksheetBody = serde_json::from_value(serde_json::json!({
            "targetId": "target-1",
            "cash": { "trackedCashToUse": 100, "externalContribution": {} },
            "lines": [{
                "lineId": "line-1",
                "direction": "reduce",
                "assetId": "asset-1",
                "accountId": "acc-1",
                "inputMode": "quantity",
                "value": 3
            }],
            "selectedAccountIds": ["acc-1"],
            "filter": { "type": "account", "accountId": "acc-1" }
        }))
        .unwrap();

        assert_eq!(body.lines.len(), 1);
        assert_eq!(body.lines[0].value, Decimal::from(3));
    }
}
