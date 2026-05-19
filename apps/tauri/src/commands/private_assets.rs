use std::sync::Arc;

use crate::context::ServiceContext;
use tauri::State;
use wealthfolio_core::private_assets::{
    FundManager, NewFundManager, NewPrivateAsset, NewPrivateSnapshot, NewPrivateSubAsset,
    PrivateAsset, PrivateAssetCurrentTotals, PrivateAssetDetail, PrivateAssetHistoricalPoint,
    PrivateAssetListRow, PrivateSnapshot, PrivateSubAsset, UpdateFundManager, UpdatePrivateAsset,
    UpdatePrivateSnapshot, UpdatePrivateSubAsset,
};

fn ensure_private_assets_enabled(state: &ServiceContext) -> Result<(), String> {
    if state.get_private_assets_enabled() {
        Ok(())
    } else {
        Err("Private assets are disabled in settings.".to_string())
    }
}

#[tauri::command]
pub async fn list_private_asset_rows(
    include_archived: Option<bool>,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Vec<PrivateAssetListRow>, String> {
    ensure_private_assets_enabled(&state)?;
    state
        .private_asset_projection_service()
        .list_private_asset_rows(include_archived.unwrap_or(false))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_fund_managers(
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Vec<FundManager>, String> {
    ensure_private_assets_enabled(&state)?;
    state
        .private_assets_service()
        .list_fund_managers()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_private_asset_detail(
    private_asset_id: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Option<PrivateAssetDetail>, String> {
    ensure_private_assets_enabled(&state)?;
    state
        .private_asset_projection_service()
        .get_private_asset_detail(&private_asset_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_private_asset_current_totals(
    include_archived: Option<bool>,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<PrivateAssetCurrentTotals, String> {
    ensure_private_assets_enabled(&state)?;
    state
        .private_asset_projection_service()
        .get_private_asset_current_totals(include_archived.unwrap_or(false))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_private_asset_historical_series(
    include_archived: Option<bool>,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Vec<PrivateAssetHistoricalPoint>, String> {
    ensure_private_assets_enabled(&state)?;
    state
        .private_asset_projection_service()
        .get_private_asset_historical_series(include_archived.unwrap_or(false))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_fund_manager(
    payload: NewFundManager,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<FundManager, String> {
    ensure_private_assets_enabled(&state)?;
    state
        .private_assets_service()
        .create_fund_manager(payload)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_fund_manager(
    fund_manager_id: String,
    payload: UpdateFundManager,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<FundManager, String> {
    ensure_private_assets_enabled(&state)?;
    state
        .private_assets_service()
        .update_fund_manager(&fund_manager_id, payload)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_private_asset(
    payload: NewPrivateAsset,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<PrivateAsset, String> {
    ensure_private_assets_enabled(&state)?;
    state
        .private_assets_service()
        .create_private_asset(payload)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_private_asset(
    private_asset_id: String,
    payload: UpdatePrivateAsset,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<PrivateAsset, String> {
    ensure_private_assets_enabled(&state)?;
    state
        .private_assets_service()
        .update_private_asset(&private_asset_id, payload)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_private_sub_assets(
    private_asset_id: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Vec<PrivateSubAsset>, String> {
    ensure_private_assets_enabled(&state)?;
    state
        .private_assets_service()
        .list_private_sub_assets(&private_asset_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_private_sub_asset(
    payload: NewPrivateSubAsset,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<PrivateSubAsset, String> {
    ensure_private_assets_enabled(&state)?;
    state
        .private_assets_service()
        .create_private_sub_asset(payload)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_private_sub_asset(
    private_sub_asset_id: String,
    payload: UpdatePrivateSubAsset,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<PrivateSubAsset, String> {
    ensure_private_assets_enabled(&state)?;
    state
        .private_assets_service()
        .update_private_sub_asset(&private_sub_asset_id, payload)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_private_snapshots(
    private_asset_id: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Vec<PrivateSnapshot>, String> {
    ensure_private_assets_enabled(&state)?;
    state
        .private_assets_service()
        .list_private_snapshots(&private_asset_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_latest_private_snapshot(
    private_asset_id: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Option<PrivateSnapshot>, String> {
    ensure_private_assets_enabled(&state)?;
    state
        .private_assets_service()
        .get_latest_private_snapshot(&private_asset_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_private_snapshot(
    payload: NewPrivateSnapshot,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<PrivateSnapshot, String> {
    ensure_private_assets_enabled(&state)?;
    state
        .private_assets_service()
        .create_private_snapshot(payload)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_private_snapshot(
    private_snapshot_id: String,
    payload: UpdatePrivateSnapshot,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<PrivateSnapshot, String> {
    ensure_private_assets_enabled(&state)?;
    state
        .private_assets_service()
        .update_private_snapshot(&private_snapshot_id, payload)
        .await
        .map_err(|e| e.to_string())
}
