use crate::profiles::ProfileAccess;
use std::sync::Arc;

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
    state: ProfileAccess,
) -> Result<Vec<AllocationTarget>, String> {
    let context = state.context()?;
    context
        .allocation_target_service()
        .list_targets()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_allocation_target(
    state: ProfileAccess,
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
    state: ProfileAccess,
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
    state: ProfileAccess,
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
    state: ProfileAccess,
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
pub async fn delete_allocation_target(state: ProfileAccess, id: String) -> Result<(), String> {
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
    state: ProfileAccess,
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
    state: ProfileAccess,
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
    state: ProfileAccess,
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
    state: ProfileAccess,
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
    state: ProfileAccess,
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
    state: ProfileAccess,
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

// ── Allocation worksheet ──────────────────────────────────────────────────────

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
    state: &Arc<ServiceContext>,
    target_id: &str,
    filter: AccountScopeInput,
) -> Result<WorksheetScope, String> {
    let filter = filter.into_account_filter()?;
    let base_currency = state.get_base_currency();
    let requested =
        wealthfolio_core::portfolios::PortfolioServiceTrait::resolve_account_scope_for_purpose(
            state.portfolio_service.as_ref(),
            &filter,
            &base_currency,
            AccountPurpose::Holdings,
        )
        .map_err(|e| e.to_string())?;
    let target = state
        .allocation_target_service()
        .get_target(target_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("AllocationTarget {target_id} not found"))?;
    let resolved =
        wealthfolio_core::portfolios::PortfolioServiceTrait::resolve_account_scope_for_purpose(
            state.portfolio_service.as_ref(),
            &account_scope_for_target(&target)?,
            &base_currency,
            AccountPurpose::Holdings,
        )
        .map_err(|e| e.to_string())?;

    let mut requested_ids = requested.account_ids;
    let mut target_ids = resolved.account_ids.clone();
    requested_ids.sort();
    target_ids.sort();
    if requested_ids != target_ids {
        return Err("Worksheet page scope does not match the selected target scope".to_string());
    }

    Ok(WorksheetScope {
        account_ids: resolved.account_ids,
        base_currency,
        aggregated_account_id: resolved.scope_id,
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn generate_calculated_adjustments(
    state: ProfileAccess,
    target_id: String,
    mode: WorksheetMode,
    rule: AllocationRule,
    cash: WorksheetCashInput,
    eligible_asset_ids: Option<Vec<String>>,
    selected_account_ids: Vec<String>,
    filter: AccountScopeInput,
) -> Result<CalculatedAdjustments, String> {
    let context = state.context()?;
    let scope = resolve_worksheet_scope(&context, &target_id, filter)?;
    context
        .allocation_worksheet_service()
        .generate_adjustments(GenerateCalculatedAdjustmentsInput {
            target_id,
            account_ids: scope.account_ids,
            base_currency: scope.base_currency,
            aggregated_account_id: scope.aggregated_account_id,
            selected_account_ids,
            mode,
            rule,
            cash,
            eligible_asset_ids,
        })
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn calculate_allocation_worksheet(
    state: ProfileAccess,
    target_id: String,
    cash: WorksheetCashInput,
    lines: Vec<AllocationWorksheetLineInput>,
    selected_account_ids: Vec<String>,
    filter: AccountScopeInput,
) -> Result<AllocationWorksheetResult, String> {
    let context = state.context()?;
    let scope = resolve_worksheet_scope(&context, &target_id, filter)?;
    context
        .allocation_worksheet_service()
        .calculate_worksheet(CalculateAllocationWorksheetInput {
            target_id,
            cash,
            lines,
            account_ids: scope.account_ids,
            base_currency: scope.base_currency,
            aggregated_account_id: scope.aggregated_account_id,
            selected_account_ids,
        })
        .await
        .map_err(|e| e.to_string())
}
