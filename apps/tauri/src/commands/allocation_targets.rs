use crate::database::DatabaseRuntime;
use std::sync::Arc;

use tauri::State;

use rust_decimal::Decimal;
use wealthfolio_core::{
    accounts::AccountPurpose,
    portfolio::allocation_targets::{
        AllocationTarget, AllocationTargetConstraint, AllocationTargetWeight,
        CalculateRebalancePlanInput, DriftReport, NewAllocationTarget, NewAllocationTargetWeight,
        RebalancePlan, SaveAllocationTargetResult, ScenarioMode, ScopeType,
    },
    portfolios::AccountScope,
};

use crate::context::ServiceContext;

use super::portfolio::AccountScopeInput;

fn scope_id_for_target(target: &AllocationTarget) -> Result<String, String> {
    target
        .scope_id
        .clone()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| {
            format!(
                "Allocation target {} is missing scope_id for scoped drift",
                target.id
            )
        })
}

fn account_scope_for_target(target: &AllocationTarget) -> Result<AccountScope, String> {
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

#[tauri::command]
pub async fn list_allocation_targets(
    state: State<'_, DatabaseRuntime>,
) -> Result<Vec<AllocationTarget>, String> {
    let context = state.context()?;
    context
        .allocation_target_service()
        .list_targets()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_allocation_target(
    state: State<'_, DatabaseRuntime>,
    id: String,
) -> Result<Option<AllocationTarget>, String> {
    let context = state.context()?;
    context
        .allocation_target_service()
        .get_target(&id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_allocation_target(
    state: State<'_, DatabaseRuntime>,
    input: NewAllocationTarget,
) -> Result<AllocationTarget, String> {
    let context = state.context()?;
    context
        .allocation_target_service()
        .create_target(input)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_allocation_target(
    state: State<'_, DatabaseRuntime>,
    id: String,
    input: NewAllocationTarget,
) -> Result<AllocationTarget, String> {
    let context = state.context()?;
    context
        .allocation_target_service()
        .update_target(&id, input)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn archive_allocation_target(
    state: State<'_, DatabaseRuntime>,
    id: String,
) -> Result<AllocationTarget, String> {
    let context = state.context()?;
    context
        .allocation_target_service()
        .archive_target(&id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_allocation_target(
    state: State<'_, DatabaseRuntime>,
    id: String,
) -> Result<(), String> {
    let context = state.context()?;
    context
        .allocation_target_service()
        .delete_target(&id)
        .await
        .map_err(|e| e.to_string())
}

// ── Weights ─────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_allocation_target_weights(
    state: State<'_, DatabaseRuntime>,
    target_id: String,
) -> Result<Vec<AllocationTargetWeight>, String> {
    let context = state.context()?;
    context
        .allocation_target_service()
        .list_weights_for_target(&target_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_allocation_target_weights(
    state: State<'_, DatabaseRuntime>,
    target_id: String,
    weights: Vec<NewAllocationTargetWeight>,
) -> Result<Vec<AllocationTargetWeight>, String> {
    let context = state.context()?;
    context
        .allocation_target_service()
        .save_weights(&target_id, weights)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_allocation_target_with_weights(
    state: State<'_, DatabaseRuntime>,
    id: Option<String>,
    input: NewAllocationTarget,
    weights: Vec<NewAllocationTargetWeight>,
) -> Result<SaveAllocationTargetResult, String> {
    let context = state.context()?;
    context
        .allocation_target_service()
        .save_target_with_weights(id, input, weights)
        .await
        .map_err(|e| e.to_string())
}

// ── Sell constraints ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_target_constraints(
    state: State<'_, DatabaseRuntime>,
    target_id: String,
) -> Result<Vec<AllocationTargetConstraint>, String> {
    let context = state.context()?;
    context
        .allocation_target_service()
        .list_target_constraints(&target_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_target_constraints(
    state: State<'_, DatabaseRuntime>,
    target_id: String,
    constraints: Vec<AllocationTargetConstraint>,
) -> Result<Vec<AllocationTargetConstraint>, String> {
    let context = state.context()?;
    context
        .allocation_target_service()
        .save_target_constraints(&target_id, constraints)
        .await
        .map_err(|e| e.to_string())
}

// ── Drift ─────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_allocation_target_drift(
    state: State<'_, DatabaseRuntime>,
    target_id: String,
    filter: AccountScopeInput,
    include_holdings: Option<bool>,
) -> Result<DriftReport, String> {
    let context = state.context()?;
    let _ = filter;
    let base_currency = context.get_base_currency();
    let target = context
        .allocation_target_service()
        .get_target(&target_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("AllocationTarget {} not found", target_id))?;
    let filter = account_scope_for_target(&target)?;

    let resolved =
        wealthfolio_core::portfolios::PortfolioServiceTrait::resolve_account_scope_for_purpose(
            context.portfolio_service.as_ref(),
            &filter,
            &base_currency,
            AccountPurpose::Holdings,
        )
        .map_err(|e| e.to_string())?;

    if include_holdings.unwrap_or(false) {
        context
            .drift_service()
            .get_drift_report_with_holdings_for_target(
                &target_id,
                &resolved.account_ids,
                &base_currency,
                &resolved.scope_id,
            )
            .await
            .map_err(|e| e.to_string())
    } else {
        context
            .drift_service()
            .get_drift_report_for_target(
                &target_id,
                &resolved.account_ids,
                &base_currency,
                &resolved.scope_id,
            )
            .await
            .map_err(|e| e.to_string())
    }
}

// ── Rebalance ─────────────────────────────────────────────────────────────────

fn resolve_rebalance_input(
    state: &Arc<ServiceContext>,
    target_id: String,
    available_cash: Decimal,
    scenario_mode: ScenarioMode,
    filter: AccountScopeInput,
    eligible_asset_ids: Option<Vec<String>>,
) -> Result<CalculateRebalancePlanInput, String> {
    let filter = filter.into_account_filter()?;
    let base_currency = state.get_base_currency();
    let resolved =
        wealthfolio_core::portfolios::PortfolioServiceTrait::resolve_account_scope_for_purpose(
            state.portfolio_service.as_ref(),
            &filter,
            &base_currency,
            AccountPurpose::Holdings,
        )
        .map_err(|e| e.to_string())?;
    Ok(CalculateRebalancePlanInput {
        target_id,
        available_cash,
        account_ids: resolved.account_ids,
        base_currency,
        aggregated_account_id: resolved.scope_id,
        scenario_mode,
        eligible_asset_ids,
    })
}

#[tauri::command]
pub async fn calculate_rebalance_plan(
    state: State<'_, DatabaseRuntime>,
    target_id: String,
    available_cash: Decimal,
    scenario_mode: Option<ScenarioMode>,
    filter: AccountScopeInput,
    eligible_asset_ids: Option<Vec<String>>,
) -> Result<RebalancePlan, String> {
    let context = state.context()?;
    let input = resolve_rebalance_input(
        &context,
        target_id,
        available_cash,
        scenario_mode.unwrap_or_default(),
        filter,
        eligible_asset_ids,
    )?;
    context
        .rebalance_service()
        .calculate_plan(input)
        .await
        .map_err(|e| e.to_string())
}
