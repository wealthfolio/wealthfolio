use crate::profiles::{ConnectAccess, ProfileAccess};
use tauri::AppHandle;
use wealthfolio_core::secrets::{
    addon_secret_service_id, legacy_addon_secret_service_id, validate_unscoped_secret_service_id,
};

#[tauri::command]
pub async fn set_secret(
    secret_key: String,
    secret: String,
    profile: ProfileAccess,
) -> Result<(), String> {
    validate_unscoped_secret_service_id(&secret_key)?;
    profile
        .secret_store
        .set_secret(&secret_key, &secret)
        .map_err(|e| e.public_error().error_code)
}

#[tauri::command]
pub async fn get_secret(
    secret_key: String,
    profile: ProfileAccess,
) -> Result<Option<String>, String> {
    validate_unscoped_secret_service_id(&secret_key)?;
    profile
        .secret_store
        .get_secret(&secret_key)
        .map_err(|e| e.public_error().error_code)
}

#[tauri::command]
pub async fn delete_secret(secret_key: String, profile: ProfileAccess) -> Result<(), String> {
    validate_unscoped_secret_service_id(&secret_key)?;
    profile
        .secret_store
        .delete_secret(&secret_key)
        .map_err(|e| e.public_error().error_code)
}

#[tauri::command]
pub async fn set_addon_secret(
    addon_id: String,
    key: String,
    secret: String,
    _app: AppHandle,
    profile: ProfileAccess,
) -> Result<(), String> {
    let service_id = addon_secret_service_id(&addon_id, &key)?;
    let legacy_service_id = legacy_addon_secret_service_id(&addon_id, &key)?;
    profile
        .secret_store
        .set_secret(&service_id, &secret)
        .map_err(|e| e.public_error().error_code)?;
    profile
        .secret_store
        .delete_secret(&legacy_service_id)
        .map_err(|e| e.public_error().error_code)
}

#[tauri::command]
pub async fn get_addon_secret(
    addon_id: String,
    key: String,
    _app: AppHandle,
    profile: ProfileAccess,
) -> Result<Option<String>, String> {
    let service_id = addon_secret_service_id(&addon_id, &key)?;
    if let Some(secret) = profile
        .secret_store
        .get_secret(&service_id)
        .map_err(|e| e.public_error().error_code)?
    {
        return Ok(Some(secret));
    }

    let legacy_service_id = legacy_addon_secret_service_id(&addon_id, &key)?;
    let legacy_secret = profile
        .secret_store
        .get_secret(&legacy_service_id)
        .map_err(|e| e.public_error().error_code)?;
    if let Some(secret) = legacy_secret.as_deref() {
        profile
            .secret_store
            .set_secret(&service_id, secret)
            .map_err(|e| e.public_error().error_code)?;
        profile
            .secret_store
            .delete_secret(&legacy_service_id)
            .map_err(|e| e.public_error().error_code)?;
    }
    Ok(legacy_secret)
}

#[tauri::command]
pub async fn delete_addon_secret(
    addon_id: String,
    key: String,
    _app: AppHandle,
    profile: ProfileAccess,
) -> Result<(), String> {
    let service_id = addon_secret_service_id(&addon_id, &key)?;
    let legacy_service_id = legacy_addon_secret_service_id(&addon_id, &key)?;
    profile
        .secret_store
        .delete_secret(&service_id)
        .map_err(|e| e.public_error().error_code)?;
    profile
        .secret_store
        .delete_secret(&legacy_service_id)
        .map_err(|e| e.public_error().error_code)
}

// These read the keyring, which can wait on a slow Secret Service or an unlock
// prompt. `async` keeps that off the UI thread, where sync commands run.
#[tauri::command]
pub async fn get_profile_sync_identity(profile: ConnectAccess) -> Result<Option<String>, String> {
    profile
        .secret_store
        .get_secret(wealthfolio_core::secrets::SYNC_IDENTITY_KEY)
        .map_err(|e| e.public_error().error_code)
}
#[tauri::command]
pub async fn update_profile_sync_identity(
    profile: ConnectAccess,
    identity: Option<String>,
) -> Result<(), String> {
    let identity = identity.ok_or("Use device sync reset to remove enrollment.")?;
    wealthfolio_core::secrets::update_existing_sync_identity(
        profile.secret_store.as_ref(),
        &identity,
    )
}
