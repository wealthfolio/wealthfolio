use std::sync::Arc;
use tauri::Manager;
use tauri::{AppHandle, State};

// Import addon modules
use crate::context::ServiceContext;
use wealthfolio_core::addons::{
    self, AddonManifest, AddonService, AddonServiceTrait, AddonUpdateCheckResult, AddonUpdateInfo,
    ExtractedAddon, InstalledAddon,
};

fn addon_service(app_handle: &AppHandle, state: &ServiceContext) -> Result<AddonService, String> {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    Ok(AddonService::new(
        app_data_dir,
        state.rating_instance_id.as_str(),
        state.addon_storage_repository.clone(),
    ))
}

#[tauri::command]
pub async fn install_addon_zip(
    app_handle: AppHandle,
    zip_data: Vec<u8>,
    enable_after_install: Option<bool>,
    approved_network_hosts: Option<Vec<String>>,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<AddonManifest, String> {
    addon_service(&app_handle, &state)?
        .install_addon_zip(
            zip_data,
            enable_after_install.unwrap_or(true),
            approved_network_hosts.unwrap_or_default(),
        )
        .await
}

#[tauri::command]
pub async fn list_installed_addons(
    app_handle: AppHandle,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Vec<InstalledAddon>, String> {
    addon_service(&app_handle, &state)?.list_installed_addons()
}

#[tauri::command]
pub async fn toggle_addon(
    app_handle: AppHandle,
    addon_id: String,
    enabled: bool,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<(), String> {
    addon_service(&app_handle, &state)?.toggle_addon(&addon_id, enabled)
}

#[tauri::command]
pub async fn uninstall_addon(
    app_handle: AppHandle,
    addon_id: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<(), String> {
    addon_service(&app_handle, &state)?
        .uninstall_addon(&addon_id)
        .await
}

#[tauri::command]
pub async fn load_addon_for_runtime(
    app_handle: AppHandle,
    addon_id: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<ExtractedAddon, String> {
    addon_service(&app_handle, &state)?.load_addon_for_runtime(&addon_id)
}

#[tauri::command]
pub async fn get_enabled_addons_on_startup(
    app_handle: AppHandle,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Vec<ExtractedAddon>, String> {
    addon_service(&app_handle, &state)?.get_enabled_addons_on_startup()
}

// Legacy function for backward compatibility
#[tauri::command]
pub async fn extract_addon_zip(
    _app_handle: AppHandle,
    zip_data: Vec<u8>,
) -> Result<ExtractedAddon, String> {
    addons::extract_addon_zip_internal(zip_data)
}

/// Check for updates for a specific addon from the addon store
#[tauri::command]
pub async fn check_addon_update(
    addon_id: String,
    current_version: String,
) -> Result<AddonUpdateCheckResult, String> {
    // Check for updates from addon store
    match addons::check_addon_update_from_api(&addon_id, &current_version).await {
        Ok(update_check_result) => {
            // The API already provides the complete result, just return it
            Ok(update_check_result)
        }
        Err(error) => {
            log::error!(
                "Failed to fetch addon store info for {}: {}",
                addon_id,
                error
            );
            Ok(AddonUpdateCheckResult {
                addon_id,
                update_info: AddonUpdateInfo {
                    current_version,
                    latest_version: "unknown".to_string(),
                    update_available: false,
                    download_url: None,
                    sha256: None,
                    release_notes: None,
                    release_date: None,
                    changelog_url: None,
                    is_critical: None,
                    has_breaking_changes: None,
                    min_wealthfolio_version: None,
                },
                error: Some(error),
            })
        }
    }
}

/// Check for updates for all installed addons
#[tauri::command]
pub async fn check_all_addon_updates(
    app_handle: AppHandle,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Vec<AddonUpdateCheckResult>, String> {
    let mut results = Vec::new();
    let installed_addons = addon_service(&app_handle, &state)?.list_installed_addons()?;

    for addon in installed_addons {
        match addons::check_addon_update_from_api(&addon.metadata.id, &addon.metadata.version).await
        {
            Ok(result) => results.push(result),
            Err(error) => {
                log::error!(
                    "Failed to check update for addon {}: {}",
                    addon.metadata.id,
                    error
                );
                // Create a fallback result with error
                results.push(AddonUpdateCheckResult {
                    addon_id: addon.metadata.id,
                    update_info: AddonUpdateInfo {
                        current_version: addon.metadata.version,
                        latest_version: "unknown".to_string(),
                        update_available: false,
                        download_url: None,
                        sha256: None,
                        release_notes: None,
                        release_date: None,
                        changelog_url: None,
                        is_critical: None,
                        has_breaking_changes: None,
                        min_wealthfolio_version: None,
                    },
                    error: Some(error),
                });
            }
        }
    }

    Ok(results)
}

/// Download and update an addon from the store by ID
#[tauri::command]
pub async fn update_addon_from_store_by_id(
    app_handle: AppHandle,
    addon_id: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<AddonManifest, String> {
    addon_service(&app_handle, &state)?
        .update_addon_from_store(&addon_id)
        .await
}

/// Fetch available addons from the store
#[tauri::command]
pub async fn fetch_addon_store_listings(
    _state: State<'_, Arc<ServiceContext>>,
) -> Result<Vec<serde_json::Value>, String> {
    addons::fetch_addon_store_listings().await
}

/// Download addon to staging directory for permission review
#[tauri::command]
pub async fn download_addon_to_staging(
    app_handle: AppHandle,
    addon_id: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<ExtractedAddon, String> {
    addon_service(&app_handle, &state)?
        .download_addon_to_staging(&addon_id)
        .await
}

/// Install addon from staging directory after permission approval
#[tauri::command]
pub async fn install_addon_from_staging(
    app_handle: AppHandle,
    addon_id: String,
    enable_after_install: Option<bool>,
    approved_network_hosts: Option<Vec<String>>,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<AddonManifest, String> {
    addon_service(&app_handle, &state)?
        .install_addon_from_staging(
            &addon_id,
            enable_after_install.unwrap_or(true),
            approved_network_hosts.unwrap_or_default(),
        )
        .await
}

#[tauri::command]
pub async fn update_addon_network_approvals(
    app_handle: AppHandle,
    addon_id: String,
    approved_network_hosts: Vec<String>,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<AddonManifest, String> {
    addon_service(&app_handle, &state)?
        .update_addon_network_approvals(&addon_id, approved_network_hosts)
}

/// Clear specific addon from staging or entire staging directory
#[tauri::command]
pub async fn clear_addon_staging(
    app_handle: AppHandle,
    addon_id: Option<String>,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<(), String> {
    addon_service(&app_handle, &state)?.clear_staging(addon_id.as_deref())
}

/// Submit or update a rating for an addon
#[tauri::command]
pub async fn submit_addon_rating(
    addon_id: String,
    rating: u8,
    review: Option<String>,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<serde_json::Value, String> {
    let rating_instance_id = state.rating_instance_id.as_str();
    addons::submit_addon_rating(&addon_id, rating, review, rating_instance_id).await
}

/// Get a value from the addon's persistent key-value storage
#[tauri::command]
pub async fn get_addon_storage_item(
    app_handle: AppHandle,
    addon_id: String,
    key: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Option<String>, String> {
    addon_service(&app_handle, &state)?
        .get_addon_storage_item(&addon_id, &key)
        .await
}

/// Set a value in the addon's persistent key-value storage
#[tauri::command]
pub async fn set_addon_storage_item(
    app_handle: AppHandle,
    addon_id: String,
    key: String,
    value: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<(), String> {
    addon_service(&app_handle, &state)?
        .set_addon_storage_item(&addon_id, &key, &value)
        .await
}

/// Delete a value from the addon's persistent key-value storage
#[tauri::command]
pub async fn delete_addon_storage_item(
    app_handle: AppHandle,
    addon_id: String,
    key: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<(), String> {
    addon_service(&app_handle, &state)?
        .delete_addon_storage_item(&addon_id, &key)
        .await
}
