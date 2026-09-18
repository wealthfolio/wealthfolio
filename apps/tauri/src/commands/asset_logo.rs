use crate::database::DatabaseRuntime;
use tauri::State;
use wealthfolio_core::assets::{AssetLogo, AssetLogoSummary, UpsertAssetLogo};

#[tauri::command]
pub async fn get_asset_logo(
    asset_id: String,
    state: State<'_, DatabaseRuntime>,
) -> Result<Option<AssetLogo>, String> {
    let context = state.context()?;
    context
        .asset_logo_service()
        .get_asset_logo(&asset_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_asset_logos(
    state: State<'_, DatabaseRuntime>,
) -> Result<Vec<AssetLogoSummary>, String> {
    let context = state.context()?;
    context
        .asset_logo_service()
        .list_asset_logos()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn upsert_asset_logo(
    asset_id: String,
    payload: UpsertAssetLogo,
    state: State<'_, DatabaseRuntime>,
) -> Result<AssetLogo, String> {
    let context = state.context()?;
    context
        .asset_logo_service()
        .upsert_asset_logo(&asset_id, payload)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_asset_logo(
    asset_id: String,
    state: State<'_, DatabaseRuntime>,
) -> Result<(), String> {
    let context = state.context()?;
    context
        .asset_logo_service()
        .delete_asset_logo(&asset_id)
        .await
        .map_err(|e| e.to_string())
}
