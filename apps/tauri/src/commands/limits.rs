use std::sync::Arc;

use crate::context::ServiceContext;
use log::debug;
use tauri::State;
use wealthfolio_core::{
    accounts::{account_supports_purpose, AccountPurpose},
    limits::{ContributionLimit, DepositsCalculation, NewContributionLimit},
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
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Vec<ContributionLimit>, String> {
    debug!("Fetching contribution limits...");
    state
        .limits_service()
        .get_contribution_limits()
        .map_err(|e| format!("Failed to load contribution limits: {}", e))
}

#[tauri::command]
pub async fn create_contribution_limit(
    new_limit: NewContributionLimit,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<ContributionLimit, String> {
    debug!("Creating new contribution limit...");
    validate_contribution_limit_accounts(&state, &new_limit)?;
    state
        .limits_service()
        .create_contribution_limit(new_limit)
        .await
        .map_err(|e| format!("Failed to create contribution limit: {}", e))
}

#[tauri::command]
pub async fn update_contribution_limit(
    id: String,
    updated_limit: NewContributionLimit,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<ContributionLimit, String> {
    debug!("Updating contribution limit...");
    validate_contribution_limit_accounts(&state, &updated_limit)?;
    state
        .limits_service()
        .update_contribution_limit(&id, updated_limit)
        .await
        .map_err(|e| format!("Failed to update contribution limit: {}", e))
}

#[tauri::command]
pub async fn delete_contribution_limit(
    id: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<(), String> {
    debug!("Deleting contribution limit...");
    state
        .limits_service()
        .delete_contribution_limit(&id)
        .await
        .map_err(|e| format!("Failed to delete contribution limit: {}", e))
}

#[tauri::command]
pub async fn calculate_deposits_for_contribution_limit(
    limit_id: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<DepositsCalculation, String> {
    debug!("Calculating deposits for contribution limit...");
    let base_currency = state.base_currency.read().unwrap();
    state
        .limits_service()
        .calculate_deposits_for_contribution_limit(&limit_id, &base_currency)
        .map_err(|e| format!("Failed to calculate deposits for contribution limit: {}", e))
}
