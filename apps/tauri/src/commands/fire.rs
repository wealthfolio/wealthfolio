use std::sync::Arc;

use rust_decimal::prelude::ToPrimitive;
use tauri::State;

use crate::context::ServiceContext;
use wealthfolio_core::goals::validate_retirement_plan;
use wealthfolio_core::planning::retirement::{
    normalize_retirement_plan_ages, RetirementPlan, RetirementTimingMode,
};
use wealthfolio_core::portfolio::fire::{
    project_retirement_with_mode, run_decision_sensitivity_matrix_with_mode,
    run_monte_carlo_with_mode_and_seed, run_scenario_analysis_with_mode, run_sorr,
    run_stress_tests_with_mode,
};
use wealthfolio_core::portfolio::fire::{
    DecisionSensitivityMap, DecisionSensitivityMatrix, FireProjection, MonteCarloResult,
    ScenarioResult, SorrScenario, StressTestResult,
};
use wealthfolio_core::portfolio::valuation::CurrentAccountValuationService;
use wealthfolio_core::utils::time_utils::{parse_user_timezone_or_default, user_today};

const MAX_SIMS: u32 = 500_000;
const DEFAULT_SIMS: u32 = 10_000;

fn normalize_sim_count(n_sims: Option<u32>) -> u32 {
    n_sims.unwrap_or(DEFAULT_SIMS).clamp(1, MAX_SIMS)
}

fn normalize_and_validate_plan(mut plan: RetirementPlan) -> Result<RetirementPlan, String> {
    normalize_retirement_plan_ages(&mut plan);
    validate_retirement_plan(&plan).map_err(|e| e.to_string())?;
    Ok(plan)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simulation_count_is_clamped_at_the_command_boundary() {
        assert_eq!(normalize_sim_count(Some(0)), 1);
        assert_eq!(normalize_sim_count(Some(42)), 42);
        assert_eq!(normalize_sim_count(Some(MAX_SIMS + 1)), MAX_SIMS);
        assert_eq!(normalize_sim_count(None), DEFAULT_SIMS);
    }
}

async fn build_valuation_map(
    state: &State<'_, Arc<ServiceContext>>,
) -> Result<std::collections::HashMap<String, f64>, String> {
    let accounts = state
        .account_service()
        .get_active_non_archived_accounts()
        .map_err(|e| e.to_string())?;
    let account_ids: Vec<String> = accounts.into_iter().map(|a| a.id).collect();
    let base_currency = state.get_base_currency();
    let timezone = state.get_timezone();
    let latest_snapshot_cutoff = user_today(parse_user_timezone_or_default(&timezone));
    let account_service = state.account_service();
    let snapshot_repository = state.snapshot_repository();
    let asset_service = state.asset_service();
    let quote_service = state.quote_service();
    let fx_service = state.fx_service();
    let service = CurrentAccountValuationService::new(
        account_service.as_ref(),
        snapshot_repository.as_ref(),
        asset_service.as_ref(),
        quote_service.as_ref(),
        fx_service.as_ref(),
    );
    let response = service
        .get_current_valuation_for_scope(
            "all",
            &account_ids,
            &base_currency,
            latest_snapshot_cutoff,
            true,
        )
        .await
        .map_err(|e| e.to_string())?;

    let mut map = std::collections::HashMap::new();
    for v in &response.accounts {
        let value_in_base = v
            .total_value_base
            .to_f64()
            .ok_or_else(|| format!("Invalid base valuation total for account {}", v.account_id))?;
        map.insert(v.account_id.clone(), value_in_base);
    }
    Ok(map)
}

async fn resolve_retirement_inputs(
    state: &State<'_, Arc<ServiceContext>>,
    goal_id: &Option<String>,
    planner_mode: Option<RetirementTimingMode>,
    plan: RetirementPlan,
    current_portfolio: f64,
) -> Result<(RetirementPlan, f64, RetirementTimingMode), String> {
    if let Some(goal_id) = goal_id {
        let valuation_map = build_valuation_map(state).await?;
        let prepared = state
            .goal_service()
            .prepare_retirement_simulation_input(goal_id, &valuation_map)
            .await
            .map_err(|e| e.to_string())?;
        Ok((
            prepared.plan,
            prepared.current_portfolio,
            prepared.planner_mode,
        ))
    } else {
        let plan = normalize_and_validate_plan(plan)?;
        Ok((
            plan,
            current_portfolio,
            planner_mode.unwrap_or(RetirementTimingMode::Fire),
        ))
    }
}

async fn run_retirement_blocking<T, F>(task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    tokio::task::spawn_blocking(task).await.map_err(|err| {
        log::error!("Retirement calculation task failed: {err}");
        format!("Retirement calculation task failed: {err}")
    })
}

// ─── RetirementPlan-based commands ───────────────────────────────────────────

#[tauri::command]
pub async fn calculate_retirement_projection(
    plan: RetirementPlan,
    current_portfolio: f64,
    goal_id: Option<String>,
    planner_mode: Option<RetirementTimingMode>,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<FireProjection, String> {
    let (plan, current_portfolio, planner_mode) =
        resolve_retirement_inputs(&state, &goal_id, planner_mode, plan, current_portfolio).await?;
    Ok(project_retirement_with_mode(
        &plan,
        current_portfolio,
        planner_mode,
    ))
}

#[tauri::command]
pub async fn run_retirement_monte_carlo(
    plan: RetirementPlan,
    current_portfolio: f64,
    n_sims: Option<u32>,
    seed: Option<u64>,
    goal_id: Option<String>,
    planner_mode: Option<RetirementTimingMode>,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<MonteCarloResult, String> {
    let n = normalize_sim_count(n_sims);
    let (plan, current_portfolio, planner_mode) =
        resolve_retirement_inputs(&state, &goal_id, planner_mode, plan, current_portfolio).await?;
    run_retirement_blocking(move || {
        run_monte_carlo_with_mode_and_seed(&plan, current_portfolio, n, planner_mode, seed)
    })
    .await
}

#[tauri::command]
pub async fn run_retirement_stress_tests(
    plan: RetirementPlan,
    current_portfolio: f64,
    goal_id: Option<String>,
    planner_mode: Option<RetirementTimingMode>,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Vec<StressTestResult>, String> {
    let (plan, current_portfolio, planner_mode) =
        resolve_retirement_inputs(&state, &goal_id, planner_mode, plan, current_portfolio).await?;
    run_retirement_blocking(move || {
        run_stress_tests_with_mode(&plan, current_portfolio, planner_mode)
    })
    .await
}

#[tauri::command]
pub async fn run_retirement_scenario_analysis(
    plan: RetirementPlan,
    current_portfolio: f64,
    goal_id: Option<String>,
    planner_mode: Option<RetirementTimingMode>,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Vec<ScenarioResult>, String> {
    let (plan, current_portfolio, planner_mode) =
        resolve_retirement_inputs(&state, &goal_id, planner_mode, plan, current_portfolio).await?;
    run_retirement_blocking(move || {
        run_scenario_analysis_with_mode(&plan, current_portfolio, planner_mode)
    })
    .await
}

#[tauri::command]
pub async fn run_retirement_sorr(
    plan: RetirementPlan,
    portfolio_at_fire: f64,
    retirement_start_age: u32,
    goal_id: Option<String>,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Vec<SorrScenario>, String> {
    let plan = if let Some(goal_id) = &goal_id {
        let valuation_map = build_valuation_map(&state).await?;
        state
            .goal_service()
            .prepare_retirement_simulation_input(goal_id, &valuation_map)
            .await
            .map_err(|e| e.to_string())?
            .plan
    } else {
        normalize_and_validate_plan(plan)?
    };
    run_retirement_blocking(move || run_sorr(&plan, portfolio_at_fire, retirement_start_age)).await
}

#[tauri::command]
pub async fn run_retirement_decision_sensitivity_map(
    plan: RetirementPlan,
    current_portfolio: f64,
    map: DecisionSensitivityMap,
    goal_id: Option<String>,
    planner_mode: Option<RetirementTimingMode>,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<DecisionSensitivityMatrix, String> {
    let (plan, current_portfolio, planner_mode) =
        resolve_retirement_inputs(&state, &goal_id, planner_mode, plan, current_portfolio).await?;
    run_retirement_blocking(move || {
        run_decision_sensitivity_matrix_with_mode(&plan, current_portfolio, planner_mode, map)
    })
    .await
}
