use crate::profiles::ProfileAccess;
use std::sync::Arc;

use crate::context::ServiceContext;
use log::{debug, warn};
use wealthfolio_core::goals::{
    Goal, GoalFundingRule, GoalFundingRuleInput, GoalPlan, GoalUpdate, NewGoal, SaveGoalPlan,
};
use wealthfolio_core::planning::{
    compute_save_up_overview, validate_save_up_input, SaveUpInput, SaveUpOverview,
};
use wealthfolio_core::portfolio::fire::RetirementOverview;
use wealthfolio_core::utils::time_utils::{parse_user_timezone_or_default, user_today};

#[tauri::command]
pub async fn get_goals(state: ProfileAccess) -> Result<Vec<Goal>, String> {
    let context = state.context()?;
    debug!("Fetching goals...");
    context
        .goal_service()
        .get_goals()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_goal(goal_id: String, state: ProfileAccess) -> Result<Goal, String> {
    let context = state.context()?;
    debug!("Fetching goal {}...", goal_id);
    context
        .goal_service()
        .get_goal(&goal_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_goal(mut goal: NewGoal, state: ProfileAccess) -> Result<Goal, String> {
    let context = state.context()?;
    debug!("Creating new goal...");
    goal.currency = Some(context.get_base_currency());
    context
        .goal_service()
        .create_goal(goal)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_goal(
    app_handle: tauri::AppHandle,
    mut goal: GoalUpdate,
    state: ProfileAccess,
) -> Result<Goal, String> {
    let context = state.context()?;
    debug!("Updating goal...");
    goal.goal.currency = Some(context.get_base_currency());
    let goal = context
        .goal_service()
        .update_goal(goal)
        .await
        .map_err(|e| e.to_string())?;
    crate::portfolio_jobs::emit_goal_summaries_updated(
        &app_handle,
        &context,
        std::slice::from_ref(&goal),
        true,
    );
    Ok(goal)
}

#[tauri::command]
pub async fn delete_goal(
    app_handle: tauri::AppHandle,
    goal_id: String,
    state: ProfileAccess,
) -> Result<usize, String> {
    let context = state.context()?;
    debug!("Deleting goal...");
    let goal = context.goal_service().get_goal(&goal_id).ok();
    let deleted = context
        .goal_service()
        .delete_goal(goal_id)
        .await
        .map_err(|e| e.to_string())?;
    // A deleted savings goal releases its shares, which changes what retirement
    // counts; other windows refresh their goal caches from this event.
    if let Some(goal) = goal.filter(|_| deleted > 0) {
        crate::portfolio_jobs::emit_goal_summaries_updated(
            &app_handle,
            &context,
            std::slice::from_ref(&goal),
            true,
        );
    }
    Ok(deleted)
}

#[tauri::command]
pub async fn get_goal_funding(
    goal_id: String,
    state: ProfileAccess,
) -> Result<Vec<GoalFundingRule>, String> {
    let context = state.context()?;
    debug!("Fetching funding rules for goal {}...", goal_id);
    context
        .goal_service()
        .get_goal_funding(&goal_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_goal_funding(
    app_handle: tauri::AppHandle,
    goal_id: String,
    rules: Vec<GoalFundingRuleInput>,
    state: ProfileAccess,
) -> Result<Vec<GoalFundingRule>, String> {
    let context = state.context()?;
    debug!("Saving funding rules for goal {}...", goal_id);
    let result = context
        .goal_service()
        .save_goal_funding(&goal_id, rules)
        .await
        .map_err(|e| e.to_string())?;

    // Auto-refresh summary after funding change
    refresh_summary_after_save(&app_handle, &context, &goal_id).await;

    Ok(result)
}

#[tauri::command]
pub async fn get_goal_plan(
    goal_id: String,
    state: ProfileAccess,
) -> Result<Option<GoalPlan>, String> {
    let context = state.context()?;
    debug!("Fetching goal plan for {}...", goal_id);
    context
        .goal_service()
        .get_goal_plan(&goal_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_goal_plan(
    app_handle: tauri::AppHandle,
    mut plan: SaveGoalPlan,
    state: ProfileAccess,
) -> Result<GoalPlan, String> {
    let context = state.context()?;
    debug!("Saving goal plan for {}...", plan.goal_id);
    let goal_id = plan.goal_id.clone();
    normalize_plan_currency_to_base(&mut plan, &context.get_base_currency());
    let result = context
        .goal_service()
        .save_goal_plan(plan)
        .await
        .map_err(|e| e.to_string())?;

    // Auto-refresh summary after plan change
    refresh_summary_after_save(&app_handle, &context, &goal_id).await;

    Ok(result)
}

async fn refresh_summary_after_save(
    app_handle: &tauri::AppHandle,
    state: &Arc<ServiceContext>,
    goal_id: &str,
) {
    if let Err(error) = refresh_summary_internal(app_handle, state, goal_id, true).await {
        warn!(
            "Failed to refresh goal summary after save for {goal_id} ({})",
            wealthfolio_core::goals::summary_refresh_error_kind(&error)
        );
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
    app_handle: tauri::AppHandle,
    goal_id: String,
    state: ProfileAccess,
) -> Result<usize, String> {
    let context = state.context()?;
    debug!("Deleting goal plan for {}...", goal_id);
    let deleted = context
        .goal_service()
        .delete_goal_plan(&goal_id)
        .await
        .map_err(|e| e.to_string())?;
    refresh_summary_after_save(&app_handle, &context, &goal_id).await;
    Ok(deleted)
}

#[tauri::command]
pub async fn refresh_goal_summary(
    app_handle: tauri::AppHandle,
    goal_id: String,
    state: ProfileAccess,
) -> Result<Goal, String> {
    let context = state.context()?;
    debug!("Refreshing goal summary for {}...", goal_id);
    refresh_summary_internal(&app_handle, &context, &goal_id, false)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn refresh_all_goal_summaries(
    app_handle: tauri::AppHandle,
    state: ProfileAccess,
) -> Result<Vec<Goal>, String> {
    let context = state.context()?;
    debug!("Refreshing all goal summaries...");
    let goals = context
        .goal_service()
        .refresh_all_goal_summaries()
        .await
        .map_err(|e| e.to_string())?;
    crate::portfolio_jobs::emit_goal_summaries_updated(&app_handle, &context, &goals, false);
    Ok(goals)
}

#[tauri::command]
pub async fn get_retirement_overview(
    goal_id: String,
    state: ProfileAccess,
) -> Result<RetirementOverview, String> {
    let context = state.context()?;
    debug!("Computing retirement overview for goal {}...", goal_id);
    let valuation_map = context
        .goal_service()
        .current_valuation_map()
        .await
        .map_err(|e| e.to_string())?;
    context
        .goal_service()
        .compute_retirement_overview(&goal_id, &valuation_map)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_save_up_overview(
    goal_id: String,
    state: ProfileAccess,
) -> Result<SaveUpOverview, String> {
    let context = state.context()?;
    debug!("Computing save-up overview for goal {}...", goal_id);
    let valuation_map = context
        .goal_service()
        .current_valuation_map()
        .await
        .map_err(|e| e.to_string())?;
    context
        .goal_service()
        .compute_save_up_overview(&goal_id, &valuation_map)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn preview_save_up_overview(
    input: SaveUpInput,
    state: ProfileAccess,
) -> Result<SaveUpOverview, String> {
    let context = state.context()?;
    let as_of = user_today(parse_user_timezone_or_default(&context.get_timezone()));
    validate_save_up_input(&input, as_of).map_err(|e| e.to_string())?;
    Ok(compute_save_up_overview(&input, as_of))
}

async fn refresh_summary_internal(
    app_handle: &tauri::AppHandle,
    state: &Arc<ServiceContext>,
    goal_id: &str,
    inputs_changed: bool,
) -> wealthfolio_core::Result<Goal> {
    let goal = state.goal_service().refresh_goal_summary(goal_id).await?;
    crate::portfolio_jobs::emit_goal_summaries_updated(
        app_handle,
        state,
        std::slice::from_ref(&goal),
        inputs_changed,
    );
    Ok(goal)
}
