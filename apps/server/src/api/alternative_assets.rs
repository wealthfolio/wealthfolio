//! REST API endpoints for alternative assets (properties, vehicles, collectibles, precious metals, liabilities).
//!
//! These endpoints are thin wrappers that delegate to the core AlternativeAssetService.
//! All business logic lives in the core service - these handlers only handle:
//! - String ↔ typed value conversion
//! - HTTP status code mapping
//! - Portfolio job triggering (server-specific)

use std::sync::Arc;

use crate::{
    api::shared::{enqueue_portfolio_job, PortfolioJobConfig},
    error::ApiResult,
    main_lib::AppState,
};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{delete, get, post, put},
    Json, Router,
};
use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use wealthfolio_core::{
    assets::{
        AssetKind, CreateAlternativeAssetRequest as CoreCreateRequest,
        LinkLiabilityRequest as CoreLinkRequest,
        UpdateAssetDetailsRequest as CoreUpdateDetailsRequest,
        UpdateValuationRequest as CoreValuationRequest,
    },
    portfolio::{snapshot::SnapshotRecalcMode, valuation::ValuationRecalcMode},
    quotes::MarketSyncMode,
};

// ─────────────────────────────────────────────────────────────────────────────
// Request/Response DTOs (string-based for API serialization)
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AlternativeAssetKind {
    Property,
    Vehicle,
    Collectible,
    Precious,
    Liability,
    Other,
}

impl AlternativeAssetKind {
    fn to_asset_kind(&self) -> AssetKind {
        match self {
            AlternativeAssetKind::Property => AssetKind::Property,
            AlternativeAssetKind::Vehicle => AssetKind::Vehicle,
            AlternativeAssetKind::Collectible => AssetKind::Collectible,
            AlternativeAssetKind::Precious => AssetKind::PreciousMetal,
            AlternativeAssetKind::Liability => AssetKind::Liability,
            AlternativeAssetKind::Other => AssetKind::Other,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAlternativeAssetRequest {
    pub kind: AlternativeAssetKind,
    pub name: String,
    pub currency: String,
    pub current_value: String,
    pub value_date: String,
    pub purchase_price: Option<String>,
    pub purchase_date: Option<String>,
    pub metadata: Option<Value>,
    pub linked_asset_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAlternativeAssetResponse {
    pub asset_id: String,
    pub quote_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateValuationRequest {
    pub value: String,
    pub date: String,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateValuationResponse {
    pub quote_id: String,
    pub valuation_date: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkLiabilityRequest {
    pub target_asset_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlternativeHoldingResponse {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub symbol: String,
    pub currency: String,
    pub market_value: String,
    pub purchase_price: Option<String>,
    pub purchase_date: Option<String>,
    pub unrealized_gain: Option<String>,
    pub unrealized_gain_pct: Option<String>,
    pub valuation_date: String,
    pub metadata: Option<Value>,
    pub linked_asset_id: Option<String>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAssetDetailsRequest {
    pub name: Option<String>,
    pub metadata: std::collections::HashMap<String, String>,
    pub notes: Option<String>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Handlers - Thin wrappers delegating to core service
// ─────────────────────────────────────────────────────────────────────────────

/// POST /alternative-assets - Creates a new alternative asset with initial valuation
async fn create_alternative_asset(
    State(state): State<Arc<AppState>>,
    Json(request): Json<CreateAlternativeAssetRequest>,
) -> ApiResult<Json<CreateAlternativeAssetResponse>> {
    // Parse string values to typed values
    let current_value: Decimal = request
        .current_value
        .parse()
        .map_err(|e| anyhow::anyhow!("Invalid current value: {}", e))?;
    let value_date = NaiveDate::parse_from_str(&request.value_date, "%Y-%m-%d")
        .map_err(|e| anyhow::anyhow!("Invalid value date: {}", e))?;
    let purchase_price = request
        .purchase_price
        .as_ref()
        .map(|s| s.parse::<Decimal>())
        .transpose()
        .map_err(|e| anyhow::anyhow!("Invalid purchase price: {}", e))?;
    let purchase_date = request
        .purchase_date
        .as_ref()
        .map(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d"))
        .transpose()
        .map_err(|e| anyhow::anyhow!("Invalid purchase date: {}", e))?;

    // Build core request
    let core_request = CoreCreateRequest {
        kind: request.kind.to_asset_kind(),
        name: request.name,
        currency: request.currency,
        current_value,
        value_date,
        purchase_price,
        purchase_date,
        metadata: request.metadata,
        linked_asset_id: request.linked_asset_id,
    };

    // Delegate to core service
    let response = state
        .alternative_asset_service
        .create_alternative_asset(core_request)
        .await?;

    // Trigger portfolio recalculation
    enqueue_portfolio_job(
        state.clone(),
        PortfolioJobConfig {
            account_ids: None,
            market_sync_mode: MarketSyncMode::None,
            snapshot_mode: SnapshotRecalcMode::IncrementalFromLast,
            valuation_mode: ValuationRecalcMode::IncrementalFromLast,
            since_date: None,
        },
    );

    Ok(Json(CreateAlternativeAssetResponse {
        asset_id: response.asset_id,
        quote_id: response.quote_id,
    }))
}

/// PUT /alternative-assets/:id/valuation - Updates the valuation of an alternative asset
async fn update_alternative_asset_valuation(
    Path(asset_id): Path<String>,
    State(state): State<Arc<AppState>>,
    Json(request): Json<UpdateValuationRequest>,
) -> ApiResult<Json<UpdateValuationResponse>> {
    // Parse string values
    let value: Decimal = request
        .value
        .parse()
        .map_err(|e| anyhow::anyhow!("Invalid value: {}", e))?;
    let date = NaiveDate::parse_from_str(&request.date, "%Y-%m-%d")
        .map_err(|e| anyhow::anyhow!("Invalid date: {}", e))?;

    // Build core request
    let core_request = CoreValuationRequest {
        asset_id,
        value,
        date,
        notes: request.notes,
    };

    // Delegate to core service
    let response = state
        .alternative_asset_service
        .update_valuation(core_request)
        .await?;

    // Trigger portfolio recalculation
    enqueue_portfolio_job(
        state.clone(),
        PortfolioJobConfig {
            account_ids: None,
            market_sync_mode: MarketSyncMode::None,
            snapshot_mode: SnapshotRecalcMode::IncrementalFromLast,
            valuation_mode: ValuationRecalcMode::IncrementalFromLast,
            since_date: None,
        },
    );

    Ok(Json(UpdateValuationResponse {
        quote_id: response.quote_id,
        valuation_date: response.valuation_date.to_string(),
        value: response.value.to_string(),
    }))
}

/// PUT /alternative-assets/:id/metadata - Updates an alternative asset's details (name, notes, and/or metadata)
async fn update_alternative_asset_metadata(
    Path(asset_id): Path<String>,
    State(state): State<Arc<AppState>>,
    Json(request): Json<UpdateAssetDetailsRequest>,
) -> ApiResult<StatusCode> {
    // Convert HashMap<String, String> to HashMap<String, Option<String>>
    // Empty strings mean "remove this key"
    let metadata_map: std::collections::HashMap<String, Option<String>> = request
        .metadata
        .into_iter()
        .map(|(k, v)| {
            if v.is_empty() {
                (k, None)
            } else {
                (k, Some(v))
            }
        })
        .collect();

    // Build core request
    let core_request = CoreUpdateDetailsRequest {
        asset_id,
        name: request.name,
        notes: request.notes,
        metadata: Some(metadata_map),
    };

    // Delegate to core service
    state
        .alternative_asset_service
        .update_asset_details(core_request)
        .await?;

    Ok(StatusCode::NO_CONTENT)
}

/// DELETE /alternative-assets/:id - Deletes an alternative asset and related data
async fn delete_alternative_asset(
    Path(asset_id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> ApiResult<StatusCode> {
    state
        .alternative_asset_service
        .delete_alternative_asset(&asset_id)
        .await?;

    // Trigger portfolio recalculation
    enqueue_portfolio_job(
        state.clone(),
        PortfolioJobConfig {
            account_ids: None,
            market_sync_mode: MarketSyncMode::None,
            snapshot_mode: SnapshotRecalcMode::IncrementalFromLast,
            valuation_mode: ValuationRecalcMode::IncrementalFromLast,
            since_date: None,
        },
    );

    Ok(StatusCode::NO_CONTENT)
}

/// POST /alternative-assets/:id/link-liability - Links a liability to a target asset
async fn link_liability(
    Path(liability_id): Path<String>,
    State(state): State<Arc<AppState>>,
    Json(request): Json<LinkLiabilityRequest>,
) -> ApiResult<StatusCode> {
    let core_request = CoreLinkRequest {
        liability_id,
        target_asset_id: request.target_asset_id,
    };

    state
        .alternative_asset_service
        .link_liability(core_request)
        .await?;

    Ok(StatusCode::NO_CONTENT)
}

/// DELETE /alternative-assets/:id/link-liability - Unlinks a liability from its linked asset
async fn unlink_liability(
    Path(liability_id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> ApiResult<StatusCode> {
    state
        .alternative_asset_service
        .unlink_liability(&liability_id)
        .await?;

    Ok(StatusCode::NO_CONTENT)
}

/// GET /alternative-holdings - Gets all alternative holdings (assets with their latest valuations)
async fn get_alternative_holdings(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<Vec<AlternativeHoldingResponse>>> {
    let holdings = state.alternative_asset_service.get_alternative_holdings()?;

    // Convert core holdings to response format
    let response: Vec<AlternativeHoldingResponse> = holdings
        .into_iter()
        .map(|h| {
            let kind_str = match h.kind {
                AssetKind::Property => "property",
                AssetKind::Vehicle => "vehicle",
                AssetKind::Collectible => "collectible",
                AssetKind::PreciousMetal => "precious",
                AssetKind::Liability => "liability",
                AssetKind::Other => "other",
                _ => "other",
            };

            AlternativeHoldingResponse {
                id: h.id,
                kind: kind_str.to_string(),
                name: h.name,
                symbol: h.symbol,
                currency: h.currency,
                market_value: h.market_value.to_string(),
                purchase_price: h.purchase_price.map(|p| p.to_string()),
                purchase_date: h.purchase_date.map(|d| d.to_string()),
                unrealized_gain: h.unrealized_gain.map(|g| g.to_string()),
                unrealized_gain_pct: h.unrealized_gain_pct.map(|p| p.to_string()),
                valuation_date: h.valuation_date.to_rfc3339(),
                metadata: h.metadata,
                linked_asset_id: h.linked_asset_id,
                notes: h.notes,
            }
        })
        .collect();

    Ok(Json(response))
}

// ─────────────────────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────────────────────

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/alternative-assets", post(create_alternative_asset))
        .route(
            "/alternative-assets/{id}/valuation",
            put(update_alternative_asset_valuation),
        )
        .route("/alternative-assets/{id}", delete(delete_alternative_asset))
        .route(
            "/alternative-assets/{id}/link-liability",
            post(link_liability),
        )
        .route(
            "/alternative-assets/{id}/link-liability",
            delete(unlink_liability),
        )
        .route(
            "/alternative-assets/{id}/metadata",
            put(update_alternative_asset_metadata),
        )
        .route("/alternative-holdings", get(get_alternative_holdings))
}
