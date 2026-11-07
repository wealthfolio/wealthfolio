use crate::profiles::ProfileAccess;

use crate::context::ServiceContext;
use log::debug;
use wealthfolio_core::{
    accounts::{account_supports_purpose, AccountPurpose},
    limits::{
        ContributionLimit, ContributionLimitDetails, DepositsCalculation, NewContributionLimit,
    },
};

fn validate_contribution_limit_accounts(
    state: &ServiceContext,
    limit: &NewContributionLimit,
) -> Result<(), String> {
    let Some(account_ids) = limit.account_ids.as_deref() else {
        return Ok(());
    };
    let ids: Vec<String> = account_ids
        .split(',')
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .collect();
    if ids.is_empty() {
        return Ok(());
    }

    let accounts = state
        .account_service()
        .get_accounts_by_ids(&ids)
        .map_err(|e| format!("Failed to validate contribution limit accounts: {}", e))?;
    let allowed: std::collections::HashSet<String> = accounts
        .into_iter()
        .filter(|account| {
            account_supports_purpose(&account.account_type, AccountPurpose::ContributionLimits)
        })
        .map(|account| account.id)
        .collect();
    let invalid: Vec<String> = ids.into_iter().filter(|id| !allowed.contains(id)).collect();
    if invalid.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Contribution limits do not support account(s): {}",
            invalid.join(", ")
        ))
    }
}

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
    new_limit: NewContributionLimit,
    state: ProfileAccess,
) -> Result<ContributionLimit, String> {
    let context = state.context()?;
    debug!("Creating new contribution limit...");
    validate_contribution_limit_accounts(&context, &new_limit)?;
    context
        .limits_service()
        .create_contribution_limit(new_limit)
        .await
        .map_err(|e| format!("Failed to create contribution limit: {}", e))
}

#[tauri::command]
pub async fn update_contribution_limit(
    id: String,
    updated_limit: NewContributionLimit,
    state: ProfileAccess,
) -> Result<ContributionLimit, String> {
    let context = state.context()?;
    debug!("Updating contribution limit...");
    validate_contribution_limit_accounts(&context, &updated_limit)?;
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
