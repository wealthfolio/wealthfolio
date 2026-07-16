use std::sync::Arc;

use crate::{error::ApiResult, main_lib::AppState};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    routing::{delete, get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use wealthfolio_core::addons::{
    AddonManifest, AddonUpdateCheckResult, ExtractedAddon, InstalledAddon,
};

#[derive(serde::Deserialize)]
struct InstallZipBody {
    #[serde(rename = "zipData")]
    zip_data: Option<Vec<u8>>,
    #[serde(rename = "zipDataB64")]
    zip_data_b64: Option<String>,
    #[serde(rename = "enableAfterInstall")]
    enable_after_install: Option<bool>,
    #[serde(rename = "approvedNetworkHosts")]
    approved_network_hosts: Option<Vec<String>>,
}

#[derive(serde::Deserialize)]
struct AddonIdBody {
    #[serde(rename = "addonId")]
    addon_id: String,
}

async fn install_addon_zip_web(
    State(state): State<Arc<AppState>>,
    Json(body): Json<InstallZipBody>,
) -> ApiResult<Json<AddonManifest>> {
    let zip_bytes = decode_zip_data(body.zip_data, body.zip_data_b64)?;
    let metadata = state
        .addon_service
        .install_addon_zip(
            zip_bytes,
            body.enable_after_install.unwrap_or(true),
            body.approved_network_hosts.unwrap_or_default(),
        )
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    Ok(Json(metadata))
}

async fn list_installed_addons_web(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<Vec<InstalledAddon>>> {
    let installed = state
        .addon_service
        .list_installed_addons()
        .map_err(|e| anyhow::anyhow!(e))?;
    Ok(Json(installed))
}

async fn check_addon_update_web(
    State(state): State<Arc<AppState>>,
    Json(body): Json<AddonIdBody>,
) -> ApiResult<Json<AddonUpdateCheckResult>> {
    let result = state
        .addon_service
        .check_addon_update(&body.addon_id)
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    Ok(Json(result))
}

async fn check_all_addon_updates_web(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<Vec<AddonUpdateCheckResult>>> {
    let results = state
        .addon_service
        .check_all_addon_updates()
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    Ok(Json(results))
}

#[derive(serde::Deserialize)]
struct ToggleBody {
    #[serde(rename = "addonId")]
    addon_id: String,
    enabled: bool,
}

async fn toggle_addon_web(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ToggleBody>,
) -> ApiResult<StatusCode> {
    state
        .addon_service
        .toggle_addon(&body.addon_id, body.enabled)
        .map_err(|e| anyhow::anyhow!(e))?;
    Ok(StatusCode::NO_CONTENT)
}

async fn uninstall_addon_web(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> ApiResult<StatusCode> {
    state
        .addon_service
        .uninstall_addon(&id)
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    Ok(StatusCode::NO_CONTENT)
}

async fn load_addon_for_runtime_web(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<ExtractedAddon>> {
    let extracted = state
        .addon_service
        .load_addon_for_runtime(&id)
        .map_err(|e| anyhow::anyhow!(e))?;
    Ok(Json(extracted))
}

async fn get_enabled_addons_on_startup_web(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<Vec<ExtractedAddon>>> {
    let enabled = state
        .addon_service
        .get_enabled_addons_on_startup()
        .map_err(|e| anyhow::anyhow!(e))?;
    Ok(Json(enabled))
}

#[derive(serde::Deserialize)]
struct ExtractBody {
    #[serde(rename = "zipData")]
    zip_data: Option<Vec<u8>>,
    #[serde(rename = "zipDataB64")]
    zip_data_b64: Option<String>,
}

async fn extract_addon_zip_web(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ExtractBody>,
) -> ApiResult<Json<ExtractedAddon>> {
    let zip_bytes = decode_zip_data(body.zip_data, body.zip_data_b64)?;
    let extracted = state
        .addon_service
        .extract_addon_zip(zip_bytes)
        .map_err(|e| anyhow::anyhow!(e))?;
    Ok(Json(extracted))
}

// ====== Store + staging ======

async fn fetch_addon_store_listings_web(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<Vec<serde_json::Value>>> {
    let listings = state
        .addon_service
        .fetch_store_listings()
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    Ok(Json(listings))
}

#[derive(serde::Deserialize)]
struct SubmitRatingBody {
    #[serde(rename = "addonId")]
    addon_id: String,
    rating: u8,
    review: Option<String>,
}

async fn submit_addon_rating_web(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SubmitRatingBody>,
) -> ApiResult<Json<serde_json::Value>> {
    let resp = state
        .addon_service
        .submit_rating(&body.addon_id, body.rating, body.review)
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    Ok(Json(resp))
}

#[derive(serde::Deserialize)]
struct RatingsQuery {
    #[serde(rename = "addonId")]
    addon_id: Option<String>,
}

async fn get_addon_ratings_web(_q: Query<RatingsQuery>) -> ApiResult<Json<Vec<serde_json::Value>>> {
    // Store ratings retrieval API not implemented yet; return empty list to avoid UI errors
    Ok(Json(Vec::new()))
}

#[derive(serde::Deserialize)]
struct StagingDownloadBody {
    #[serde(rename = "addonId")]
    addon_id: String,
}

async fn download_addon_to_staging_web(
    State(state): State<Arc<AppState>>,
    Json(body): Json<StagingDownloadBody>,
) -> ApiResult<Json<ExtractedAddon>> {
    let extracted = state
        .addon_service
        .download_addon_to_staging(&body.addon_id)
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    Ok(Json(extracted))
}

#[derive(serde::Deserialize)]
struct InstallFromStagingBody {
    #[serde(rename = "addonId")]
    addon_id: String,
    #[serde(rename = "enableAfterInstall")]
    enable_after_install: Option<bool>,
    #[serde(rename = "approvedNetworkHosts")]
    approved_network_hosts: Option<Vec<String>>,
}

#[derive(serde::Deserialize)]
struct UpdateNetworkApprovalsBody {
    #[serde(rename = "addonId")]
    addon_id: String,
    #[serde(rename = "approvedNetworkHosts")]
    approved_network_hosts: Vec<String>,
}

async fn update_addon_from_store_by_id_web(
    State(state): State<Arc<AppState>>,
    Json(body): Json<AddonIdBody>,
) -> ApiResult<Json<AddonManifest>> {
    let metadata = state
        .addon_service
        .update_addon_from_store(&body.addon_id)
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    Ok(Json(metadata))
}

async fn update_addon_network_approvals_web(
    State(state): State<Arc<AppState>>,
    Json(body): Json<UpdateNetworkApprovalsBody>,
) -> ApiResult<Json<AddonManifest>> {
    let metadata = state
        .addon_service
        .update_addon_network_approvals(&body.addon_id, body.approved_network_hosts)
        .map_err(|e| anyhow::anyhow!(e))?;
    Ok(Json(metadata))
}

async fn install_addon_from_staging_web(
    State(state): State<Arc<AppState>>,
    Json(body): Json<InstallFromStagingBody>,
) -> ApiResult<Json<AddonManifest>> {
    let metadata = state
        .addon_service
        .install_addon_from_staging(
            &body.addon_id,
            body.enable_after_install.unwrap_or(true),
            body.approved_network_hosts.unwrap_or_default(),
        )
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    Ok(Json(metadata))
}

async fn clear_addon_staging_web(
    State(state): State<Arc<AppState>>,
    Query(rq): Query<RatingsQuery>,
) -> ApiResult<StatusCode> {
    state
        .addon_service
        .clear_staging(rq.addon_id.as_deref())
        .map_err(|e| anyhow::anyhow!(e))?;
    Ok(StatusCode::NO_CONTENT)
}

// ====== Addon key-value storage ======

#[derive(serde::Deserialize)]
struct StorageSetBody {
    value: String,
}

async fn get_addon_storage_item_web(
    Path((addon_id, key)): Path<(String, String)>,
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<Option<String>>> {
    let value = state
        .addon_service
        .get_addon_storage_item(&addon_id, &key)
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    Ok(Json(value))
}

async fn set_addon_storage_item_web(
    Path((addon_id, key)): Path<(String, String)>,
    State(state): State<Arc<AppState>>,
    Json(body): Json<StorageSetBody>,
) -> ApiResult<StatusCode> {
    state
        .addon_service
        .set_addon_storage_item(&addon_id, &key, &body.value)
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_addon_storage_item_web(
    Path((addon_id, key)): Path<(String, String)>,
    State(state): State<Arc<AppState>>,
) -> ApiResult<StatusCode> {
    state
        .addon_service
        .delete_addon_storage_item(&addon_id, &key)
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    Ok(StatusCode::NO_CONTENT)
}

// ====== Helper functions ======

fn decode_zip_data(
    zip_data: Option<Vec<u8>>,
    zip_data_b64: Option<String>,
) -> Result<Vec<u8>, anyhow::Error> {
    if let Some(b64) = zip_data_b64 {
        BASE64
            .decode(b64)
            .map_err(|e| anyhow::anyhow!("Invalid base64 zipDataB64: {}", e))
    } else if let Some(bytes) = zip_data {
        Ok(bytes)
    } else {
        Err(anyhow::anyhow!("Missing zip data"))
    }
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/addons/installed", get(list_installed_addons_web))
        .route("/addons/install-zip", post(install_addon_zip_web))
        .route("/addons/toggle", post(toggle_addon_web))
        .route("/addons/{id}", delete(uninstall_addon_web))
        .route("/addons/runtime/{id}", get(load_addon_for_runtime_web))
        .route(
            "/addons/enabled-on-startup",
            get(get_enabled_addons_on_startup_web),
        )
        .route("/addons/extract", post(extract_addon_zip_web))
        .route(
            "/addons/store/listings",
            get(fetch_addon_store_listings_web),
        )
        .route(
            "/addons/store/ratings",
            get(get_addon_ratings_web).post(submit_addon_rating_web),
        )
        .route("/addons/store/check-update", post(check_addon_update_web))
        .route("/addons/store/check-all", post(check_all_addon_updates_web))
        .route(
            "/addons/store/update",
            post(update_addon_from_store_by_id_web),
        )
        .route(
            "/addons/store/staging/download",
            post(download_addon_to_staging_web),
        )
        .route(
            "/addons/store/install-from-staging",
            post(install_addon_from_staging_web),
        )
        .route(
            "/addons/network-approvals",
            post(update_addon_network_approvals_web),
        )
        .route("/addons/store/staging", delete(clear_addon_staging_web))
        .route(
            "/addons/storage/{addon_id}/{key}",
            get(get_addon_storage_item_web)
                .put(set_addon_storage_item_web)
                .delete(delete_addon_storage_item_web),
        )
}
