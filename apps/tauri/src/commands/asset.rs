use std::sync::Arc;

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use crate::context::ServiceContext;
use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use wealthfolio_core::assets::{Asset, AssetProfile, NewAsset, UpdateAssetProfile};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetLogoPayload {
    content_base64: String,
    content_type: &'static str,
}

#[tauri::command]
pub async fn get_asset_profile(
    asset_id: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<AssetProfile, String> {
    state
        .asset_service()
        .get_asset_profile(&asset_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_assets(state: State<'_, Arc<ServiceContext>>) -> Result<Vec<Asset>, String> {
    state
        .asset_service()
        .get_assets()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_asset_profile(
    id: String,
    payload: UpdateAssetProfile,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Asset, String> {
    state
        .asset_service()
        .update_asset_profile(&id, payload)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_quote_mode(
    id: String,
    quote_mode: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Asset, String> {
    state
        .asset_service()
        .update_quote_mode(&id, &quote_mode)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_asset(
    payload: NewAsset,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Asset, String> {
    state
        .asset_service()
        .create_asset(payload)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_asset(id: String, state: State<'_, Arc<ServiceContext>>) -> Result<(), String> {
    // Domain events handle quote sync state cleanup automatically
    state
        .asset_service()
        .delete_asset(&id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_asset_logo(
    asset_id: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Option<AssetLogoPayload>, String> {
    let store = state.asset_logo_store();
    let asset_service = state.asset_service();
    let result = tauri::async_runtime::spawn_blocking(move || store.read(&asset_service, &asset_id))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;

    Ok(result.map(|(bytes, content_type)| AssetLogoPayload {
        content_base64: BASE64_STANDARD.encode(bytes),
        content_type,
    }))
}

/// Opens a native file picker restricted to image files and, if the user
/// selects one, uploads it as the custom logo for `asset_id`.
/// Returns `false` if the user cancelled the dialog.
#[tauri::command]
pub async fn pick_and_upload_asset_logo(
    asset_id: String,
    app_handle: AppHandle,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<bool, String> {
    #[cfg(any(target_os = "ios", target_os = "android"))]
    {
        let _ = (&asset_id, &app_handle, &state);
        return Err("Logo upload is only supported on desktop".to_string());
    }

    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        let Some(picked) = app_handle
            .dialog()
            .file()
            .add_filter("Image", &["png", "jpg", "jpeg", "webp"])
            .blocking_pick_file()
        else {
            return Ok(false);
        };

        let path = picked
            .into_path()
            .map_err(|e| format!("Failed to resolve selected file path: {}", e))?;

        let bytes = std::fs::read(&path)
            .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;

        state
            .asset_logo_store()
            .store(&state.asset_service(), &asset_id, &bytes)
            .await
            .map_err(|e| e.to_string())?;

        Ok(true)
    }
}

#[tauri::command]
pub async fn remove_asset_logo(
    asset_id: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<(), String> {
    state
        .asset_logo_store()
        .remove(&state.asset_service(), &asset_id)
        .await
        .map_err(|e| e.to_string())
}
