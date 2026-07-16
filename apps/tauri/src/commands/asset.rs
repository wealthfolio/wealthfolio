use std::sync::Arc;

use crate::context::ServiceContext;
use tauri::State;
use wealthfolio_core::assets::{Asset, AssetProfile, NewAsset, UpdateAssetProfile};

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
