use std::sync::Arc;

use crate::{
    error::{ApiError, ApiResult},
    main_lib::AppState,
};
use axum::{
    extract::{Path, Query, State},
    routing::{get, post, put},
    Json, Router,
};
use serde::Deserialize;
use wealthfolio_core::private_assets::{
    FundManager, NewFundManager, NewPrivateAsset, NewPrivateSnapshot, NewPrivateSubAsset,
    PrivateAsset, PrivateAssetCurrentTotals, PrivateAssetDetail, PrivateAssetHistoricalPoint,
    PrivateAssetListRow, PrivateSnapshot, PrivateSubAsset, UpdateFundManager, UpdatePrivateAsset,
    UpdatePrivateSnapshot, UpdatePrivateSubAsset,
};

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct IncludeArchivedQuery {
    include_archived: Option<bool>,
}

fn include_archived(query: IncludeArchivedQuery) -> bool {
    query.include_archived.unwrap_or(false)
}

fn ensure_private_assets_enabled(state: &AppState) -> ApiResult<()> {
    if *state.private_assets_enabled.read().unwrap() {
        Ok(())
    } else {
        Err(ApiError::Forbidden(
            "Private assets are disabled in settings.".to_string(),
        ))
    }
}

async fn list_private_asset_rows(
    State(state): State<Arc<AppState>>,
    Query(query): Query<IncludeArchivedQuery>,
) -> ApiResult<Json<Vec<PrivateAssetListRow>>> {
    ensure_private_assets_enabled(&state)?;
    let rows = state
        .private_asset_projection_service
        .list_private_asset_rows(include_archived(query))?;
    Ok(Json(rows))
}

async fn get_private_asset_detail(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<Option<PrivateAssetDetail>>> {
    ensure_private_assets_enabled(&state)?;
    let detail = state
        .private_asset_projection_service
        .get_private_asset_detail(&id)?;
    Ok(Json(detail))
}

async fn get_private_asset_current_totals(
    State(state): State<Arc<AppState>>,
    Query(query): Query<IncludeArchivedQuery>,
) -> ApiResult<Json<PrivateAssetCurrentTotals>> {
    ensure_private_assets_enabled(&state)?;
    let totals = state
        .private_asset_projection_service
        .get_private_asset_current_totals(include_archived(query))?;
    Ok(Json(totals))
}

async fn get_private_asset_historical_series(
    State(state): State<Arc<AppState>>,
    Query(query): Query<IncludeArchivedQuery>,
) -> ApiResult<Json<Vec<PrivateAssetHistoricalPoint>>> {
    ensure_private_assets_enabled(&state)?;
    let series = state
        .private_asset_projection_service
        .get_private_asset_historical_series(include_archived(query))?;
    Ok(Json(series))
}

async fn create_fund_manager(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<NewFundManager>,
) -> ApiResult<Json<FundManager>> {
    ensure_private_assets_enabled(&state)?;
    let manager = state
        .private_assets_service
        .create_fund_manager(payload)
        .await?;
    Ok(Json(manager))
}

async fn list_fund_managers(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<Vec<FundManager>>> {
    ensure_private_assets_enabled(&state)?;
    let managers = state.private_assets_service.list_fund_managers()?;
    Ok(Json(managers))
}

async fn update_fund_manager(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<UpdateFundManager>,
) -> ApiResult<Json<FundManager>> {
    ensure_private_assets_enabled(&state)?;
    let manager = state
        .private_assets_service
        .update_fund_manager(&id, payload)
        .await?;
    Ok(Json(manager))
}

async fn create_private_asset(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<NewPrivateAsset>,
) -> ApiResult<Json<PrivateAsset>> {
    ensure_private_assets_enabled(&state)?;
    let asset = state
        .private_assets_service
        .create_private_asset(payload)
        .await?;
    Ok(Json(asset))
}

async fn update_private_asset(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<UpdatePrivateAsset>,
) -> ApiResult<Json<PrivateAsset>> {
    ensure_private_assets_enabled(&state)?;
    let asset = state
        .private_assets_service
        .update_private_asset(&id, payload)
        .await?;
    Ok(Json(asset))
}

async fn list_private_sub_assets(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<Vec<PrivateSubAsset>>> {
    ensure_private_assets_enabled(&state)?;
    let sub_assets = state.private_assets_service.list_private_sub_assets(&id)?;
    Ok(Json(sub_assets))
}

async fn create_private_sub_asset(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<NewPrivateSubAsset>,
) -> ApiResult<Json<PrivateSubAsset>> {
    ensure_private_assets_enabled(&state)?;
    let sub_asset = state
        .private_assets_service
        .create_private_sub_asset(payload)
        .await?;
    Ok(Json(sub_asset))
}

async fn update_private_sub_asset(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<UpdatePrivateSubAsset>,
) -> ApiResult<Json<PrivateSubAsset>> {
    ensure_private_assets_enabled(&state)?;
    let sub_asset = state
        .private_assets_service
        .update_private_sub_asset(&id, payload)
        .await?;
    Ok(Json(sub_asset))
}

async fn list_private_snapshots(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<Vec<PrivateSnapshot>>> {
    ensure_private_assets_enabled(&state)?;
    let snapshots = state.private_assets_service.list_private_snapshots(&id)?;
    Ok(Json(snapshots))
}

async fn get_latest_private_snapshot(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<Option<PrivateSnapshot>>> {
    ensure_private_assets_enabled(&state)?;
    let snapshot = state
        .private_assets_service
        .get_latest_private_snapshot(&id)?;
    Ok(Json(snapshot))
}

async fn create_private_snapshot(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<NewPrivateSnapshot>,
) -> ApiResult<Json<PrivateSnapshot>> {
    ensure_private_assets_enabled(&state)?;
    let snapshot = state
        .private_assets_service
        .create_private_snapshot(payload)
        .await?;
    Ok(Json(snapshot))
}

async fn update_private_snapshot(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<UpdatePrivateSnapshot>,
) -> ApiResult<Json<PrivateSnapshot>> {
    ensure_private_assets_enabled(&state)?;
    let snapshot = state
        .private_assets_service
        .update_private_snapshot(&id, payload)
        .await?;
    Ok(Json(snapshot))
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route(
            "/private-assets",
            get(list_private_asset_rows).post(create_private_asset),
        )
        .route(
            "/private-assets/totals",
            get(get_private_asset_current_totals),
        )
        .route(
            "/private-assets/history",
            get(get_private_asset_historical_series),
        )
        .route(
            "/private-assets/{id}",
            get(get_private_asset_detail).put(update_private_asset),
        )
        .route(
            "/private-assets/{id}/sub-assets",
            get(list_private_sub_assets),
        )
        .route(
            "/private-assets/{id}/snapshots",
            get(list_private_snapshots),
        )
        .route(
            "/private-assets/{id}/snapshots/latest",
            get(get_latest_private_snapshot),
        )
        .route(
            "/fund-managers",
            get(list_fund_managers).post(create_fund_manager),
        )
        .route("/fund-managers/{id}", put(update_fund_manager))
        .route("/private-sub-assets", post(create_private_sub_asset))
        .route("/private-sub-assets/{id}", put(update_private_sub_asset))
        .route("/private-snapshots", post(create_private_snapshot))
        .route("/private-snapshots/{id}", put(update_private_snapshot))
}
