use std::sync::Arc;

use crate::{error::ApiResult, main_lib::AppState};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    routing::{delete, get, post, put},
    Json, Router,
};
use wealthfolio_core::assets::{Asset as CoreAsset, NewAsset, UpdateAssetProfile};

#[derive(serde::Deserialize)]
struct AssetQuery {
    #[serde(rename = "assetId")]
    asset_id: String,
}

async fn get_asset_profile(
    State(state): State<Arc<AppState>>,
    Query(q): Query<AssetQuery>,
) -> ApiResult<Json<CoreAsset>> {
    let asset = state.asset_service.get_asset_by_id(&q.asset_id)?;
    Ok(Json(asset))
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

#[derive(Default, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct EnrichRequest {
    /// Specific asset IDs to enrich. When empty, the server enriches every
    /// active investment asset whose name is missing.
    asset_ids: Vec<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct EnrichResponse {
    enriched: usize,
    skipped: usize,
    failed: usize,
}

/// Enriches asset profiles (company name, sectors, market cap, etc.) by
/// fetching from configured market-data providers. Used to back-fill assets
/// that were created via activity/snapshot import without ever running
/// profile enrichment.
async fn enrich_assets_handler(
    State(state): State<Arc<AppState>>,
    body: Option<Json<EnrichRequest>>,
) -> ApiResult<Json<EnrichResponse>> {
    let mut ids = body.map(|Json(b)| b.asset_ids).unwrap_or_default();

    if ids.is_empty() {
        ids = state
            .asset_service
            .get_assets()?
            .into_iter()
            .filter(|a| a.is_active && a.name.as_deref().unwrap_or("").trim().is_empty())
            .map(|a| a.id)
            .collect();
    }

    let (enriched, skipped, failed) = state.asset_service.enrich_assets(ids).await?;
    Ok(Json(EnrichResponse {
        enriched,
        skipped,
        failed,
    }))
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/assets", get(list_assets).post(create_asset))
        .route("/assets/{id}", delete(delete_asset))
        .route("/assets/profile", get(get_asset_profile))
        .route("/assets/profile/{id}", put(update_asset_profile))
        .route("/assets/pricing-mode/{id}", put(update_quote_mode))
        .route("/assets/enrich", post(enrich_assets_handler))
}
