use std::sync::Arc;

use crate::{error::ApiResult, main_lib::AppState};
use axum::{
    extract::{Path, Query},
    http::StatusCode,
    routing::{delete, get, put},
    Json, Router,
};
use wealthfolio_core::assets::{
    Asset as CoreAsset, AssetLogo, AssetLogoSummary, AssetProfile, NewAsset, UpdateAssetProfile,
    UpsertAssetLogo,
};

#[derive(serde::Deserialize)]
struct AssetQuery {
    #[serde(rename = "assetId")]
    asset_id: String,
}

async fn get_asset_profile(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Query(q): Query<AssetQuery>,
) -> ApiResult<Json<AssetProfile>> {
    Ok(Json(state.asset_service.get_asset_profile(&q.asset_id)?))
}

async fn enrich_asset_profile(
    Path(id): Path<String>,
    axum::Extension(state): axum::Extension<Arc<AppState>>,
) -> ApiResult<Json<CoreAsset>> {
    Ok(Json(state.asset_service.enrich_asset_profile(&id).await?))
}

async fn list_assets(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
) -> ApiResult<Json<Vec<CoreAsset>>> {
    let assets = state.asset_service.get_assets()?;
    Ok(Json(assets))
}

async fn update_asset_profile(
    Path(id): Path<String>,
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Json(payload): Json<UpdateAssetProfile>,
) -> ApiResult<Json<CoreAsset>> {
    let asset = state
        .asset_service
        .update_asset_profile(&id, payload)
        .await?;

    Ok(Json(asset))
}

#[derive(serde::Deserialize)]
struct QuoteModeBody {
    #[serde(alias = "pricingMode", alias = "quoteMode")]
    quote_mode: String,
}

async fn update_quote_mode(
    Path(id): Path<String>,
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Json(body): Json<QuoteModeBody>,
) -> ApiResult<Json<CoreAsset>> {
    let asset = state
        .asset_service
        .update_quote_mode(&id, &body.quote_mode)
        .await?;
    Ok(Json(asset))
}

async fn create_asset(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Json(payload): Json<NewAsset>,
) -> ApiResult<Json<CoreAsset>> {
    let asset = state.asset_service.create_asset(payload).await?;
    Ok(Json(asset))
}

async fn delete_asset(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    state.asset_service.delete_asset(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn list_asset_logos(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
) -> ApiResult<Json<Vec<AssetLogoSummary>>> {
    Ok(Json(state.asset_logo_service.list_asset_logos()?))
}

async fn get_asset_logo(
    Path(id): Path<String>,
    axum::Extension(state): axum::Extension<Arc<AppState>>,
) -> ApiResult<Json<Option<AssetLogo>>> {
    Ok(Json(state.asset_logo_service.get_asset_logo(&id)?))
}

async fn upsert_asset_logo(
    Path(id): Path<String>,
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Json(payload): Json<UpsertAssetLogo>,
) -> ApiResult<Json<AssetLogo>> {
    let logo = state
        .asset_logo_service
        .upsert_asset_logo(&id, payload)
        .await?;
    Ok(Json(logo))
}

async fn delete_asset_logo(
    Path(id): Path<String>,
    axum::Extension(state): axum::Extension<Arc<AppState>>,
) -> ApiResult<StatusCode> {
    state.asset_logo_service.delete_asset_logo(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub fn router<S: Clone + Send + Sync + 'static>() -> Router<S> {
    Router::new()
        .route("/assets", get(list_assets).post(create_asset))
        .route("/assets/{id}", delete(delete_asset))
        .route("/assets/profile", get(get_asset_profile))
        .route("/assets/profile/{id}/enrich", put(enrich_asset_profile))
        .route("/assets/profile/{id}", put(update_asset_profile))
        .route("/assets/pricing-mode/{id}", put(update_quote_mode))
        .route("/assets/logos", get(list_asset_logos))
        .route(
            "/assets/logo/{id}",
            get(get_asset_logo)
                .put(upsert_asset_logo)
                .delete(delete_asset_logo),
        )
}
