use crate::{context::ServiceContext, secret_store::KeyringSecretStore};
use std::sync::Arc;
use tauri::{AppHandle, State};
use wealthfolio_core::secrets::{
    addon_secret_service_id, legacy_addon_secret_service_id, validate_unscoped_secret_service_id,
    SecretStore,
};

#[tauri::command]
pub async fn set_secret(
    secret_key: String,
    secret: String,
    _state: State<'_, Arc<ServiceContext>>, // keep signature consistent
) -> Result<(), String> {
    validate_unscoped_secret_service_id(&secret_key)?;
    KeyringSecretStore
        .set_secret(&secret_key, &secret)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_secret(
    secret_key: String,
    _state: State<'_, Arc<ServiceContext>>,
) -> Result<Option<String>, String> {
    validate_unscoped_secret_service_id(&secret_key)?;
    KeyringSecretStore
        .get_secret(&secret_key)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_secret(
    secret_key: String,
    _state: State<'_, Arc<ServiceContext>>,
) -> Result<(), String> {
    validate_unscoped_secret_service_id(&secret_key)?;
    KeyringSecretStore
        .delete_secret(&secret_key)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_addon_secret(
    addon_id: String,
    key: String,
    secret: String,
    _app: AppHandle,
    _state: State<'_, Arc<ServiceContext>>,
) -> Result<(), String> {
    let service_id = addon_secret_service_id(&addon_id, &key)?;
    let legacy_service_id = legacy_addon_secret_service_id(&addon_id, &key)?;
    KeyringSecretStore
        .set_secret(&service_id, &secret)
        .map_err(|e| e.to_string())?;
    KeyringSecretStore
        .delete_secret(&legacy_service_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_addon_secret(
    addon_id: String,
    key: String,
    _app: AppHandle,
    _state: State<'_, Arc<ServiceContext>>,
) -> Result<Option<String>, String> {
    let service_id = addon_secret_service_id(&addon_id, &key)?;
    if let Some(secret) = KeyringSecretStore
        .get_secret(&service_id)
        .map_err(|e| e.to_string())?
    {
        return Ok(Some(secret));
    }

    let legacy_service_id = legacy_addon_secret_service_id(&addon_id, &key)?;
    let legacy_secret = KeyringSecretStore
        .get_secret(&legacy_service_id)
        .map_err(|e| e.to_string())?;
    if let Some(secret) = legacy_secret.as_deref() {
        KeyringSecretStore
            .set_secret(&service_id, secret)
            .map_err(|e| e.to_string())?;
        KeyringSecretStore
            .delete_secret(&legacy_service_id)
            .map_err(|e| e.to_string())?;
    }
    Ok(legacy_secret)
}

#[tauri::command]
pub async fn delete_addon_secret(
    addon_id: String,
    key: String,
    _app: AppHandle,
    _state: State<'_, Arc<ServiceContext>>,
) -> Result<(), String> {
    let service_id = addon_secret_service_id(&addon_id, &key)?;
    let legacy_service_id = legacy_addon_secret_service_id(&addon_id, &key)?;
    KeyringSecretStore
        .delete_secret(&service_id)
        .map_err(|e| e.to_string())?;
    KeyringSecretStore
        .delete_secret(&legacy_service_id)
        .map_err(|e| e.to_string())
}
