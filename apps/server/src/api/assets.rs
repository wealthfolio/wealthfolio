use std::sync::Arc;

use crate::{error::ApiResult, main_lib::AppState};
use axum::{
    body::Body,
    extract::{Multipart, Path, Query, State},
    http::{header, StatusCode},
    response::Response,
    routing::{delete, get, put},
    Json, Router,
};
use tower_governor::{governor::GovernorConfigBuilder, GovernorLayer};
use wealthfolio_core::assets::{Asset as CoreAsset, AssetProfile, NewAsset, UpdateAssetProfile};

use crate::error::ApiError;

#[derive(serde::Deserialize)]
struct AssetQuery {
    #[serde(rename = "assetId")]
    asset_id: String,
}

async fn get_asset_profile(
    State(state): State<Arc<AppState>>,
    Query(q): Query<AssetQuery>,
) -> ApiResult<Json<AssetProfile>> {
    Ok(Json(state.asset_service.get_asset_profile(&q.asset_id)?))
}

async fn list_assets(State(state): State<Arc<AppState>>) -> ApiResult<Json<Vec<CoreAsset>>> {
    let assets = state.asset_service.get_assets()?;
    Ok(Json(assets))
}

async fn update_asset_profile(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
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
    State(state): State<Arc<AppState>>,
    Json(body): Json<QuoteModeBody>,
) -> ApiResult<Json<CoreAsset>> {
    let asset = state
        .asset_service
        .update_quote_mode(&id, &body.quote_mode)
        .await?;
    Ok(Json(asset))
}

async fn create_asset(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<NewAsset>,
) -> ApiResult<Json<CoreAsset>> {
    let asset = state.asset_service.create_asset(payload).await?;
    Ok(Json(asset))
}

async fn delete_asset(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    state.asset_service.delete_asset(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn upload_asset_logo(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
    mut multipart: Multipart,
) -> ApiResult<StatusCode> {
    let mut file_bytes: Option<Vec<u8>> = None;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::BadRequest(format!("Failed to read multipart field: {}", e)))?
    {
        if field.name() == Some("file") {
            file_bytes = Some(
                field
                    .bytes()
                    .await
                    .map_err(|e| ApiError::BadRequest(format!("Failed to read file: {}", e)))?
                    .to_vec(),
            );
        }
    }

    let bytes = file_bytes
        .ok_or_else(|| ApiError::BadRequest("Missing file in multipart request".to_string()))?;

    let asset_service: Arc<dyn wealthfolio_core::assets::AssetServiceTrait> =
        state.asset_service.clone();
    state.asset_logo_store.store(&asset_service, &id, &bytes).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn get_asset_logo(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> ApiResult<Response> {
    let asset_service: Arc<dyn wealthfolio_core::assets::AssetServiceTrait> =
        state.asset_service.clone();
    match state.asset_logo_store.read(&asset_service, &id)? {
        Some((bytes, content_type)) => Ok(Response::builder()
            .header(header::CONTENT_TYPE, content_type)
            .header(header::CACHE_CONTROL, "no-cache")
            .body(Body::from(bytes))
            .map_err(|e| ApiError::Internal(e.to_string()))?),
        None => Err(ApiError::NotFound),
    }
}

async fn remove_asset_logo(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> ApiResult<StatusCode> {
    let asset_service: Arc<dyn wealthfolio_core::assets::AssetServiceTrait> =
        state.asset_service.clone();
    state.asset_logo_store.remove(&asset_service, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub fn router() -> Router<Arc<AppState>> {
    // Rate limit logo uploads: 5 per 60 seconds per peer IP, to bound
    // disk-fill abuse from a compromised or malicious authenticated session.
    let upload_logo_governor = GovernorConfigBuilder::default()
        .per_second(12)
        .burst_size(5)
        .finish()
        .expect("valid governor config");

    Router::new()
        .route("/assets", get(list_assets).post(create_asset))
        .route("/assets/{id}", delete(delete_asset))
        .route("/assets/profile", get(get_asset_profile))
        .route("/assets/profile/{id}", put(update_asset_profile))
        .route("/assets/pricing-mode/{id}", put(update_quote_mode))
        .route("/assets/{id}/logo", get(get_asset_logo))
        .route("/assets/{id}/logo", delete(remove_asset_logo))
        .route(
            "/assets/{id}/logo",
            axum::routing::post(upload_asset_logo)
                .layer(GovernorLayer::new(upload_logo_governor)),
        )
}
