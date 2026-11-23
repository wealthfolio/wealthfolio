use crate::profiles::ProfileAccess;

use log::debug;
use wealthfolio_core::limits::{
    check_contribution_limit_accounts, ContributionLimit, ContributionLimitDetails,
    DepositsCalculation, NewContributionLimit,
};

#[tauri::command]
pub async fn get_contribution_limits(
    state: ProfileAccess,
) -> Result<Vec<ContributionLimit>, String> {
    let context = state.context()?;
    debug!("Fetching contribution limits...");
    context
        .limits_service()
        .get_contribution_limits()
        .map_err(|e| format!("Failed to load contribution limits: {}", e))
}

#[tauri::command]
pub async fn create_contribution_limit(
    mut new_limit: NewContributionLimit,
    state: ProfileAccess,
) -> Result<ContributionLimit, String> {
    let context = state.context()?;
    debug!("Creating new contribution limit...");
    check_contribution_limit_accounts(context.account_service().as_ref(), &mut new_limit)?;
    context
        .limits_service()
        .create_contribution_limit(new_limit)
        .await
        .map_err(|e| format!("Failed to create contribution limit: {}", e))
}

#[tauri::command]
pub async fn update_contribution_limit(
    id: String,
    mut updated_limit: NewContributionLimit,
    state: ProfileAccess,
) -> Result<ContributionLimit, String> {
    let context = state.context()?;
    debug!("Updating contribution limit...");
    check_contribution_limit_accounts(context.account_service().as_ref(), &mut updated_limit)?;
    context
        .limits_service()
        .update_contribution_limit(&id, updated_limit)
        .await
        .map_err(|e| format!("Failed to update contribution limit: {}", e))
}

#[tauri::command]
pub async fn delete_contribution_limit(id: String, state: ProfileAccess) -> Result<(), String> {
    let context = state.context()?;
    debug!("Deleting contribution limit...");
    context
        .limits_service()
        .delete_contribution_limit(&id)
        .await
        .map_err(|e| format!("Failed to delete contribution limit: {}", e))
}

#[tauri::command]
pub async fn calculate_deposits_for_contribution_limit(
    limit_id: String,
    state: ProfileAccess,
) -> Result<DepositsCalculation, String> {
    let context = state.context()?;
    debug!("Calculating deposits for contribution limit...");
    let base_currency = context
        .base_currency
        .read()
        .map_err(|_| {
            "Base currency state is unavailable. Restart the application before continuing."
                .to_string()
        })?
        .clone();
    context
        .limits_service()
        .calculate_deposits_for_contribution_limit(&limit_id, &base_currency)
        .map_err(|e| format!("Failed to calculate deposits for contribution limit: {}", e))
}

#[tauri::command]
pub async fn get_contribution_limit_details(
    limit_id: String,
    state: ProfileAccess,
) -> Result<ContributionLimitDetails, String> {
    let context = state.context()?;
    let base_currency = context
        .base_currency
        .read()
        .map_err(|_| "Base currency state is unavailable".to_string())?
        .clone();
    context
        .limits_service()
        .get_contribution_limit_details(&limit_id, &base_currency)
        .map_err(|e| format!("Failed to load contribution limit details: {}", e))
}

#[tauri::command]
pub async fn set_contribution_activity_excluded(
    limit_id: String,
    activity_id: String,
    excluded: bool,
    state: ProfileAccess,
) -> Result<(), String> {
    state
        .context()?
        .limits_service()
        .set_contribution_activity_excluded(&limit_id, &activity_id, excluded)
        .await
        .map_err(|e| format!("Failed to save contribution treatment: {}", e))
}
