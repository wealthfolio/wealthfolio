use crate::profiles::ProfileAccess;

use log::{debug, error};

use wealthfolio_core::accounts::{Account, AccountUpdate, NewAccount};

#[tauri::command]
pub async fn get_credit_card_statements(
    account_id: String,
    state: ProfileAccess,
) -> Result<Vec<wealthfolio_core::accounts::CreditCardStatement>, String> {
    let context = state.context()?;
    context
        .activity_service()
        .get_credit_card_statements(&account_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_accounts(
    include_archived: Option<bool>,
    state: ProfileAccess,
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
pub async fn create_account(account: NewAccount, state: ProfileAccess) -> Result<Account, String> {
    // A supplied broker link must not race replacement of its Connect identity.
    let _connect = (account.provider.is_some() || account.provider_account_id.is_some())
        .then(|| state.connect_guard())
        .transpose()?;
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
    state: ProfileAccess,
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
pub async fn delete_account(account_id: String, state: ProfileAccess) -> Result<(), String> {
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
