use crate::database::DatabaseRuntime;

use log::{debug, error};
use tauri::State;

use wealthfolio_core::accounts::{Account, AccountUpdate, NewAccount};

#[tauri::command]
pub async fn get_accounts(
    include_archived: Option<bool>,
    state: State<'_, DatabaseRuntime>,
) -> Result<Vec<Account>, String> {
    let context = state.context()?;
    debug!("Fetching accounts...");
    let include = include_archived.unwrap_or(false);
    if include {
        context
            .account_service()
            .get_all_accounts()
            .map_err(|e| format!("Failed to load accounts: {}", e))
    } else {
        context
            .account_service()
            .get_non_archived_accounts()
            .map_err(|e| format!("Failed to load accounts: {}", e))
    }
}

#[tauri::command]
pub async fn create_account(
    account: NewAccount,
    state: State<'_, DatabaseRuntime>,
) -> Result<Account, String> {
    let context = state.context()?;
    debug!("Adding new account...");
    // Domain events handle recalculation automatically
    context
        .account_service()
        .create_account(account)
        .await
        .map_err(|e| {
            error!("Failed to add new account: {}", e);
            format!("Failed to add new account: {}", e)
        })
}

#[tauri::command]
pub async fn update_account(
    account_update: AccountUpdate,
    state: State<'_, DatabaseRuntime>,
) -> Result<Account, String> {
    let context = state.context()?;
    debug!("Updating account {:?}...", account_update.id);

    // Domain events handle recalculation automatically
    context
        .account_service()
        .update_account(account_update.clone())
        .await
        .map_err(|e| format!("Failed to update account {:?}: {}", account_update.id, e))
}

#[tauri::command]
pub async fn delete_account(
    account_id: String,
    state: State<'_, DatabaseRuntime>,
) -> Result<(), String> {
    let context = state.context()?;
    debug!("Deleting account {}...", account_id);
    // Domain events handle recalculation automatically
    context
        .account_service()
        .delete_account(&account_id)
        .await
        .map_err(|e| {
            error!("Failed to delete account {}: {}", account_id, e);
            e.to_string()
        })
}
