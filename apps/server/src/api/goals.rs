use std::collections::HashMap;
use std::sync::Arc;

use crate::{
    error::{ApiError, ApiResult},
    main_lib::AppState,
};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use rust_decimal::prelude::ToPrimitive;
use serde::Deserialize;
use wealthfolio_core::{
    accounts::AccountServiceTrait,
    goals::{
        validate_retirement_plan, Goal, GoalFundingRule, GoalFundingRuleInput, GoalPlan, NewGoal,
        SaveGoalPlan,
    },
    planning::retirement::{normalize_retirement_plan_ages, RetirementPlan, RetirementTimingMode},
    planning::{compute_save_up_overview, validate_save_up_input, SaveUpInput, SaveUpOverview},
    portfolio::fire::{
        self, DecisionSensitivityMap, DecisionSensitivityMatrix, MonteCarloResult,
        RetirementOverview, ScenarioResult, SorrScenario, StressTestResult,
    },
    portfolio::valuation::CurrentAccountValuationService,
    utils::time_utils::{parse_user_timezone_or_default, user_today},
};

async fn get_goals(State(state): State<Arc<AppState>>) -> ApiResult<Json<Vec<Goal>>> {
    let goals = state.goal_service.get_goals()?;
    Ok(Json(goals))
}

async fn get_goal(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<Goal>> {
    let goal = state.goal_service.get_goal(&id)?;
    Ok(Json(goal))
}

async fn create_goal(
    State(state): State<Arc<AppState>>,
    Json(mut goal): Json<NewGoal>,
) -> ApiResult<Json<Goal>> {
    goal.currency = Some(state.base_currency.read().unwrap().clone());
    let g = state.goal_service.create_goal(goal).await?;
    Ok(Json(g))
}

async fn update_goal(
    State(state): State<Arc<AppState>>,
    Json(mut goal): Json<Goal>,
) -> ApiResult<Json<Goal>> {
    goal.currency = Some(state.base_currency.read().unwrap().clone());
    let g = state.goal_service.update_goal(goal).await?;
    Ok(Json(g))
}

async fn delete_goal(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> ApiResult<StatusCode> {
    let _ = state.goal_service.delete_goal(id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn get_goal_funding(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<Vec<GoalFundingRule>>> {
    let rules = state.goal_service.get_goal_funding(&id)?;
    Ok(Json(rules))
}

async fn save_goal_funding(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
    Json(rules): Json<Vec<GoalFundingRuleInput>>,
) -> ApiResult<Json<Vec<GoalFundingRule>>> {
    let result = state.goal_service.save_goal_funding(&id, rules).await?;
    refresh_goal_summary_after_save(&state, &id).await;
    Ok(Json(result))
}

async fn get_goal_plan(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<Option<GoalPlan>>> {
    let plan = state.goal_service.get_goal_plan(&id)?;
    Ok(Json(plan))
}

async fn save_goal_plan(
    State(state): State<Arc<AppState>>,
    Json(mut plan): Json<SaveGoalPlan>,
) -> ApiResult<Json<GoalPlan>> {
    let goal_id = plan.goal_id.clone();
    let base_currency = state.base_currency.read().unwrap().clone();
    normalize_plan_currency_to_base(&mut plan, &base_currency);
    let result = state.goal_service.save_goal_plan(plan).await?;
    refresh_goal_summary_after_save(&state, &goal_id).await;
    Ok(Json(result))
}

async fn refresh_goal_summary_after_save(state: &Arc<AppState>, goal_id: &str) {
    match build_valuation_map(state).await {
        Ok(valuation_map) => {
            if let Err(err) = state
                .goal_service
                .refresh_goal_summary(goal_id, &valuation_map)
                .await
            {
                tracing::warn!("Failed to refresh goal summary after save for {goal_id}: {err}");
            }
        }
        Err(err) => {
            tracing::warn!("Failed to build valuation map after saving goal {goal_id}: {err}");
        }
    }
}

fn normalize_plan_currency_to_base(plan: &mut SaveGoalPlan, base_currency: &str) {
    if plan.plan_kind != "retirement" {
        return;
    }
    if let Ok(mut settings) = serde_json::from_str::<serde_json::Value>(&plan.settings_json) {
        if let Some(object) = settings.as_object_mut() {
            object.insert(
                "currency".to_string(),
                serde_json::Value::String(base_currency.to_string()),
            );
        }
        if let Ok(settings_json) = serde_json::to_string(&settings) {
            plan.settings_json = settings_json;
        }
    }
}

async fn delete_goal_plan(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> ApiResult<StatusCode> {
    let _ = state.goal_service.delete_goal_plan(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn refresh_goal_summary(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<Goal>> {
    let valuation_map = build_valuation_map(&state).await?;
    let goal = state
        .goal_service
        .refresh_goal_summary(&id, &valuation_map)
        .await?;
    Ok(Json(goal))
}

async fn refresh_all_goal_summaries(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<Vec<Goal>>> {
    let goals = state.goal_service.get_goals()?;
    let valuation_map = build_valuation_map(&state).await?;
    let mut refreshed = Vec::new();

    for goal in goals.iter().filter(|g| g.status_lifecycle == "active") {
        match state
            .goal_service
            .refresh_goal_summary(&goal.id, &valuation_map)
            .await
        {
            Ok(updated) => refreshed.push(updated),
            Err(err) => tracing::debug!("Failed to refresh goal {}: {}", goal.id, err),
        }
    }

    Ok(Json(refreshed))
}

/// Build account_id → base-currency value map from latest valuations.
async fn build_valuation_map(state: &AppState) -> ApiResult<HashMap<String, f64>> {
    let accounts = state.account_service.get_active_non_archived_accounts()?;
    let account_ids: Vec<String> = accounts.into_iter().map(|a| a.id).collect();
    let base_currency = state.base_currency.read().unwrap().clone();
    let timezone = state.timezone.read().unwrap().clone();
    let latest_snapshot_cutoff = user_today(parse_user_timezone_or_default(&timezone));
    let service = CurrentAccountValuationService::new(
        state.account_service.as_ref(),
        state.snapshot_repository.as_ref(),
        state.asset_service.as_ref(),
        state.quote_service.as_ref(),
        state.fx_service.as_ref(),
    );
    let response = service
        .get_current_valuation_for_scope(
            "all",
            &account_ids,
            &base_currency,
            latest_snapshot_cutoff,
            true,
        )
        .await?;

    let mut map = HashMap::new();
    for v in &response.accounts {
        let value_in_base = v.total_value_base.to_f64().ok_or_else(|| {
            ApiError::Internal(format!(
                "Invalid base valuation total for account {}",
                v.account_id
            ))
        })?;
        map.insert(v.account_id.clone(), value_in_base);
    }
    Ok(map)
}

async fn get_retirement_overview(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<RetirementOverview>> {
    let valuation_map = build_valuation_map(&state).await?;
    let overview = state
        .goal_service
        .compute_retirement_overview(&id, &valuation_map)
        .await?;
    Ok(Json(overview))
}

async fn get_save_up_overview(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<SaveUpOverview>> {
    let valuation_map = build_valuation_map(&state).await?;
    let overview = state
        .goal_service
        .compute_save_up_overview(&id, &valuation_map)
        .await?;
    Ok(Json(overview))
}

async fn preview_save_up_overview(
    Json(input): Json<SaveUpInput>,
) -> ApiResult<Json<SaveUpOverview>> {
    validate_save_up_input(&input)?;
    Ok(Json(compute_save_up_overview(&input)))
}

// ─── RetirementPlan-based Simulation Endpoints ───────────────────────────────

const MAX_SIMS: u32 = 500_000;
const DEFAULT_SIMS: u32 = 10_000;

fn normalize_sim_count(n_sims: Option<u32>) -> u32 {
    n_sims.unwrap_or(DEFAULT_SIMS).clamp(1, MAX_SIMS)
}

#[cfg(test)]
mod retirement_simulation_tests {
    use super::*;

    #[test]
    fn simulation_count_is_clamped_at_the_http_boundary() {
        assert_eq!(normalize_sim_count(Some(0)), 1);
        assert_eq!(normalize_sim_count(Some(42)), 42);
        assert_eq!(normalize_sim_count(Some(MAX_SIMS + 1)), MAX_SIMS);
        assert_eq!(normalize_sim_count(None), DEFAULT_SIMS);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RetirementSimulationRequest {
    plan: RetirementPlan,
    current_portfolio: f64,
    goal_id: Option<String>,
    planner_mode: Option<RetirementTimingMode>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RetirementDecisionSensitivityMapRequest {
    plan: RetirementPlan,
    current_portfolio: f64,
    map: DecisionSensitivityMap,
    goal_id: Option<String>,
    planner_mode: Option<RetirementTimingMode>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RetirementMonteCarloRequest {
    plan: RetirementPlan,
    current_portfolio: f64,
    n_sims: Option<u32>,
    seed: Option<u64>,
    goal_id: Option<String>,
    planner_mode: Option<RetirementTimingMode>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RetirementSorrRequest {
    plan: RetirementPlan,
    portfolio_at_fire: f64,
    retirement_start_age: u32,
    goal_id: Option<String>,
}

async fn resolve_retirement_inputs(
    state: &Arc<AppState>,
    goal_id: &Option<String>,
    planner_mode: Option<RetirementTimingMode>,
    plan: RetirementPlan,
    current_portfolio: f64,
) -> ApiResult<(RetirementPlan, f64, RetirementTimingMode)> {
    if let Some(goal_id) = goal_id {
        let valuation_map = build_valuation_map(state).await?;
        let prepared = state
            .goal_service
            .prepare_retirement_simulation_input(goal_id, &valuation_map)
            .await?;
        Ok((
            prepared.plan,
            prepared.current_portfolio,
            prepared.planner_mode,
        ))
    } else {
        let mut plan = plan;
        normalize_retirement_plan_ages(&mut plan);
        validate_retirement_plan(&plan)?;
        Ok((
            plan,
            current_portfolio,
            planner_mode.unwrap_or(RetirementTimingMode::Fire),
        ))
    }
}

async fn run_retirement_blocking<T, F>(task: F) -> ApiResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    tokio::task::spawn_blocking(task).await.map_err(|err| {
        tracing::error!("Retirement calculation task failed: {err}");
        ApiError::Internal(format!("Retirement calculation task failed: {err}"))
    })
}

async fn retirement_projection(
    State(state): State<Arc<AppState>>,
    Json(req): Json<RetirementSimulationRequest>,
) -> ApiResult<Json<fire::FireProjection>> {
    let (plan, current_portfolio, planner_mode) = resolve_retirement_inputs(
        &state,
        &req.goal_id,
        req.planner_mode,
        req.plan,
        req.current_portfolio,
    )
    .await?;
    let result = fire::project_retirement_with_mode(&plan, current_portfolio, planner_mode);
    Ok(Json(result))
}

async fn retirement_monte_carlo(
    State(state): State<Arc<AppState>>,
    Json(req): Json<RetirementMonteCarloRequest>,
) -> ApiResult<Json<MonteCarloResult>> {
    let n = normalize_sim_count(req.n_sims);
    let (plan, current_portfolio, planner_mode) = resolve_retirement_inputs(
        &state,
        &req.goal_id,
        req.planner_mode,
        req.plan,
        req.current_portfolio,
    )
    .await?;
    let result = run_retirement_blocking(move || {
        fire::run_monte_carlo_with_mode_and_seed(
            &plan,
            current_portfolio,
            n,
            planner_mode,
            req.seed,
        )
    })
    .await?;
    Ok(Json(result))
}

async fn retirement_stress_tests(
    State(state): State<Arc<AppState>>,
    Json(req): Json<RetirementSimulationRequest>,
) -> ApiResult<Json<Vec<StressTestResult>>> {
    let (plan, current_portfolio, planner_mode) = resolve_retirement_inputs(
        &state,
        &req.goal_id,
        req.planner_mode,
        req.plan,
        req.current_portfolio,
    )
    .await?;
    let result = run_retirement_blocking(move || {
        fire::run_stress_tests_with_mode(&plan, current_portfolio, planner_mode)
    })
    .await?;
    Ok(Json(result))
}

async fn retirement_scenario_analysis(
    State(state): State<Arc<AppState>>,
    Json(req): Json<RetirementSimulationRequest>,
) -> ApiResult<Json<Vec<ScenarioResult>>> {
    let (plan, current_portfolio, planner_mode) = resolve_retirement_inputs(
        &state,
        &req.goal_id,
        req.planner_mode,
        req.plan,
        req.current_portfolio,
    )
    .await?;
    let result = run_retirement_blocking(move || {
        fire::run_scenario_analysis_with_mode(&plan, current_portfolio, planner_mode)
    })
    .await?;
    Ok(Json(result))
}

async fn retirement_decision_sensitivity_map(
    State(state): State<Arc<AppState>>,
    Json(req): Json<RetirementDecisionSensitivityMapRequest>,
) -> ApiResult<Json<DecisionSensitivityMatrix>> {
    let (plan, current_portfolio, planner_mode) = resolve_retirement_inputs(
        &state,
        &req.goal_id,
        req.planner_mode,
        req.plan,
        req.current_portfolio,
    )
    .await?;
    let result = run_retirement_blocking(move || {
        fire::run_decision_sensitivity_matrix_with_mode(
            &plan,
            current_portfolio,
            planner_mode,
            req.map,
        )
    })
    .await?;
    Ok(Json(result))
}

async fn retirement_sequence_of_returns(
    State(state): State<Arc<AppState>>,
    Json(req): Json<RetirementSorrRequest>,
) -> ApiResult<Json<Vec<SorrScenario>>> {
    let plan = if let Some(goal_id) = &req.goal_id {
        let valuation_map = build_valuation_map(&state).await?;
        state
            .goal_service
            .prepare_retirement_simulation_input(goal_id, &valuation_map)
            .await?
            .plan
    } else {
        let mut plan = req.plan;
        normalize_retirement_plan_ages(&mut plan);
        validate_retirement_plan(&plan)?;
        plan
    };
    let result = run_retirement_blocking(move || {
        fire::run_sorr(&plan, req.portfolio_at_fire, req.retirement_start_age)
    })
    .await?;
    Ok(Json(result))
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/goals", get(get_goals).post(create_goal).put(update_goal))
        .route("/goals/{id}", get(get_goal).delete(delete_goal))
        .route(
            "/goals/{id}/funding",
            get(get_goal_funding).put(save_goal_funding),
        )
        .route(
            "/goals/{id}/plan",
            get(get_goal_plan).delete(delete_goal_plan),
        )
        .route("/goals/{id}/refresh-summary", post(refresh_goal_summary))
        .route("/goals/refresh-summaries", post(refresh_all_goal_summaries))
        .route(
            "/goals/{id}/retirement/overview",
            get(get_retirement_overview),
        )
        .route("/goals/{id}/save-up/overview", get(get_save_up_overview))
        .route("/goals/save-up/preview", post(preview_save_up_overview))
        .route("/goals/plan", post(save_goal_plan))
        // RetirementPlan-based simulation endpoints
        .route(
            "/goals/retirement/projection",
            axum::routing::post(retirement_projection),
        )
        .route(
            "/goals/retirement/monte-carlo",
            axum::routing::post(retirement_monte_carlo),
        )
        .route(
            "/goals/retirement/stress-tests",
            axum::routing::post(retirement_stress_tests),
        )
        .route(
            "/goals/retirement/scenario-analysis",
            axum::routing::post(retirement_scenario_analysis),
        )
        .route(
            "/goals/retirement/decision-sensitivity-map",
            axum::routing::post(retirement_decision_sensitivity_map),
        )
        .route(
            "/goals/retirement/sequence-of-returns",
            axum::routing::post(retirement_sequence_of_returns),
        )
}
