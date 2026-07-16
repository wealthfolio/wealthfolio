use std::sync::Arc;

use crate::context::ServiceContext;
use log::{debug, warn};
use rust_decimal::prelude::ToPrimitive;
use tauri::State;
use wealthfolio_core::goals::{
    Goal, GoalFundingRule, GoalFundingRuleInput, GoalPlan, NewGoal, SaveGoalPlan,
};
use wealthfolio_core::planning::{
    compute_save_up_overview, validate_save_up_input, SaveUpInput, SaveUpOverview,
};
use wealthfolio_core::portfolio::fire::RetirementOverview;
use wealthfolio_core::portfolio::valuation::CurrentAccountValuationService;
use wealthfolio_core::utils::time_utils::{parse_user_timezone_or_default, user_today};

#[tauri::command]
pub async fn get_goals(state: State<'_, Arc<ServiceContext>>) -> Result<Vec<Goal>, String> {
    debug!("Fetching goals...");
    state.goal_service().get_goals().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_goal(
    goal_id: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Goal, String> {
    debug!("Fetching goal {}...", goal_id);
    state
        .goal_service()
        .get_goal(&goal_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_goal(
    mut goal: NewGoal,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Goal, String> {
    debug!("Creating new goal...");
    goal.currency = Some(state.get_base_currency());
    state
        .goal_service()
        .create_goal(goal)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_goal(
    mut goal: Goal,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Goal, String> {
    debug!("Updating goal...");
    goal.currency = Some(state.get_base_currency());
    state
        .goal_service()
        .update_goal(goal)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_goal(
    goal_id: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<usize, String> {
    debug!("Deleting goal...");
    state
        .goal_service()
        .delete_goal(goal_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_goal_funding(
    goal_id: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Vec<GoalFundingRule>, String> {
    debug!("Fetching funding rules for goal {}...", goal_id);
    state
        .goal_service()
        .get_goal_funding(&goal_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_goal_funding(
    goal_id: String,
    rules: Vec<GoalFundingRuleInput>,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Vec<GoalFundingRule>, String> {
    debug!("Saving funding rules for goal {}...", goal_id);
    let result = state
        .goal_service()
        .save_goal_funding(&goal_id, rules)
        .await
        .map_err(|e| e.to_string())?;

    // Auto-refresh summary after funding change
    refresh_summary_after_save(&state, &goal_id).await;

    Ok(result)
}

#[tauri::command]
pub async fn get_goal_plan(
    goal_id: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Option<GoalPlan>, String> {
    debug!("Fetching goal plan for {}...", goal_id);
    state
        .goal_service()
        .get_goal_plan(&goal_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_goal_plan(
    mut plan: SaveGoalPlan,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<GoalPlan, String> {
    debug!("Saving goal plan for {}...", plan.goal_id);
    let goal_id = plan.goal_id.clone();
    normalize_plan_currency_to_base(&mut plan, &state.get_base_currency());
    let result = state
        .goal_service()
        .save_goal_plan(plan)
        .await
        .map_err(|e| e.to_string())?;

    // Auto-refresh summary after plan change
    refresh_summary_after_save(&state, &goal_id).await;

    Ok(result)
}

async fn refresh_summary_after_save(state: &State<'_, Arc<ServiceContext>>, goal_id: &str) {
    if let Err(err) = refresh_summary_internal(state, goal_id).await {
        warn!("Failed to refresh goal summary after save for {goal_id}: {err}");
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

#[tauri::command]
pub async fn delete_goal_plan(
    goal_id: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<usize, String> {
    debug!("Deleting goal plan for {}...", goal_id);
    state
        .goal_service()
        .delete_goal_plan(&goal_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn refresh_goal_summary(
    goal_id: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Goal, String> {
    debug!("Refreshing goal summary for {}...", goal_id);
    refresh_summary_internal(&state, &goal_id).await
}

#[tauri::command]
pub async fn refresh_all_goal_summaries(
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Vec<Goal>, String> {
    debug!("Refreshing all goal summaries...");
    let goals = state
        .goal_service()
        .get_goals()
        .map_err(|e| e.to_string())?;

    let valuation_map = build_valuation_map(&state).await?;

    let mut results = Vec::new();
    for goal in &goals {
        if goal.status_lifecycle != "active" {
            continue;
        }
        match state
            .goal_service()
            .refresh_goal_summary(&goal.id, &valuation_map)
            .await
        {
            Ok(g) => results.push(g),
            Err(e) => debug!("Failed to refresh goal {}: {}", goal.id, e),
        }
    }
    Ok(results)
}

#[tauri::command]
pub async fn get_retirement_overview(
    goal_id: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<RetirementOverview, String> {
    debug!("Computing retirement overview for goal {}...", goal_id);
    let valuation_map = build_valuation_map(&state).await?;
    state
        .goal_service()
        .compute_retirement_overview(&goal_id, &valuation_map)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_save_up_overview(
    goal_id: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<SaveUpOverview, String> {
    debug!("Computing save-up overview for goal {}...", goal_id);
    let valuation_map = build_valuation_map(&state).await?;
    state
        .goal_service()
        .compute_save_up_overview(&goal_id, &valuation_map)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn preview_save_up_overview(input: SaveUpInput) -> Result<SaveUpOverview, String> {
    validate_save_up_input(&input).map_err(|e| e.to_string())?;
    Ok(compute_save_up_overview(&input))
}

/// Internal helper: fetch valuations and refresh goal summary.
async fn refresh_summary_internal(
    state: &State<'_, Arc<ServiceContext>>,
    goal_id: &str,
) -> Result<Goal, String> {
    let valuation_map = build_valuation_map(state).await?;
    state
        .goal_service()
        .refresh_goal_summary(goal_id, &valuation_map)
        .await
        .map_err(|e| e.to_string())
}

/// Build account_id → base-currency value map from live current valuations.
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
