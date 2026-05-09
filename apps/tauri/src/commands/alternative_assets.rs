//! Tauri commands for alternative assets (properties, vehicles, collectibles, precious metals, liabilities).
//!
//! These commands are thin wrappers that delegate to the core AlternativeAssetService.
//! All business logic lives in the core service - these commands only handle:
//! - String ↔ typed value conversion
//! - Error formatting for the frontend

use std::sync::Arc;

use chrono::{NaiveDate, Utc};
use log::error;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use crate::context::ServiceContext;

use wealthfolio_core::assets::{
    AssetKind, CreateAlternativeAssetRequest as CoreCreateRequest,
    LinkLiabilityRequest as CoreLinkRequest, UpdateAssetDetailsRequest as CoreUpdateDetailsRequest,
    UpdateValuationRequest as CoreValuationRequest,
};

// ─────────────────────────────────────────────────────────────────────────────
// Request/Response DTOs (string-based for frontend serialization)
// ─────────────────────────────────────────────────────────────────────────────

/// Alternative asset kinds supported by the API
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

// ─────────────────────────────────────────────────────────────────────────────
// Net Worth Response DTOs (used by get_net_worth command)
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BreakdownItem {
    pub category: String,
    pub name: String,
    pub value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AssetsSection {
    pub total: String,
    pub breakdown: Vec<BreakdownItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LiabilitiesSection {
    pub total: String,
    pub breakdown: Vec<BreakdownItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StaleAssetInfo {
    pub asset_id: String,
    pub name: Option<String>,
    pub valuation_date: String,
    pub days_stale: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetWorthResponse {
    pub date: String,
    pub assets: AssetsSection,
    pub liabilities: LiabilitiesSection,
    pub net_worth: String,
    pub currency: String,
    pub oldest_valuation_date: Option<String>,
    pub stale_assets: Vec<StaleAssetInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetWorthHistoryPoint {
    pub date: String,
    pub portfolio_value: String,
    pub alternative_assets_value: String,
    pub total_liabilities: String,
    pub total_assets: String,
    pub net_worth: String,
    pub net_contribution: String,
    pub currency: String,
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri Commands - Thin wrappers delegating to core service
// ─────────────────────────────────────────────────────────────────────────────

/// Creates a new alternative asset with initial valuation.
#[tauri::command]
pub async fn create_alternative_asset(
    request: CreateAlternativeAssetRequest,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<CreateAlternativeAssetResponse, String> {
    // Parse string values to typed values
    let current_value: Decimal = request
        .current_value
        .parse()
        .map_err(|e| format!("Invalid current value: {}", e))?;
    let value_date = NaiveDate::parse_from_str(&request.value_date, "%Y-%m-%d")
        .map_err(|e| format!("Invalid value date: {}", e))?;
    let purchase_price = request
        .purchase_price
        .as_ref()
        .map(|s| s.parse::<Decimal>())
        .transpose()
        .map_err(|e| format!("Invalid purchase price: {}", e))?;
    let purchase_date = request
        .purchase_date
        .as_ref()
        .map(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d"))
        .transpose()
        .map_err(|e| format!("Invalid purchase date: {}", e))?;

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
        .alternative_asset_service()
        .create_alternative_asset(core_request)
        .await
        .map_err(|e| {
            error!("Failed to create alternative asset: {}", e);
            format!("Failed to create asset: {}", e)
        })?;

    Ok(CreateAlternativeAssetResponse {
        asset_id: response.asset_id,
        quote_id: response.quote_id,
    })
}

/// Updates the valuation of an alternative asset.
#[tauri::command]
pub async fn update_alternative_asset_valuation(
    asset_id: String,
    request: UpdateValuationRequest,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<UpdateValuationResponse, String> {
    // Parse string values
    let value: Decimal = request
        .value
        .parse()
        .map_err(|e| format!("Invalid value: {}", e))?;
    let date = NaiveDate::parse_from_str(&request.date, "%Y-%m-%d")
        .map_err(|e| format!("Invalid date: {}", e))?;

    // Build core request
    let core_request = CoreValuationRequest {
        asset_id,
        value,
        date,
        notes: request.notes,
    };

    // Delegate to core service
    let response = state
        .alternative_asset_service()
        .update_valuation(core_request)
        .await
        .map_err(|e| {
            error!("Failed to update valuation: {}", e);
            format!("Failed to update valuation: {}", e)
        })?;

    Ok(UpdateValuationResponse {
        quote_id: response.quote_id,
        valuation_date: response.valuation_date.to_string(),
        value: response.value.to_string(),
    })
}

/// Updates an alternative asset's details (name, notes, and/or metadata).
/// If purchase_price or purchase_date changes, the purchase quote is also updated.
#[tauri::command]
pub async fn update_alternative_asset_metadata(
    asset_id: String,
    name: Option<String>,
    metadata: std::collections::HashMap<String, String>,
    notes: Option<String>,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<(), String> {
    // Convert HashMap<String, String> to HashMap<String, Option<String>>
    // Empty strings mean "remove this key"
    let metadata_map: std::collections::HashMap<String, Option<String>> = metadata
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
        name,
        notes,
        metadata: Some(metadata_map),
    };

    // Delegate to core service
    state
        .alternative_asset_service()
        .update_asset_details(core_request)
        .await
        .map_err(|e| {
            error!("Failed to update asset details: {}", e);
            format!("Failed to update details: {}", e)
        })?;

    Ok(())
}

/// Deletes an alternative asset and related data.
#[tauri::command]
pub async fn delete_alternative_asset(
    asset_id: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<(), String> {
    state
        .alternative_asset_service()
        .delete_alternative_asset(&asset_id)
        .await
        .map_err(|e| {
            error!("Failed to delete alternative asset: {}", e);
            format!("Failed to delete asset: {}", e)
        })
}

/// Links a liability to a target asset.
#[tauri::command]
pub async fn link_liability(
    liability_id: String,
    request: LinkLiabilityRequest,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<(), String> {
    let core_request = CoreLinkRequest {
        liability_id,
        target_asset_id: request.target_asset_id,
    };

    state
        .alternative_asset_service()
        .link_liability(core_request)
        .await
        .map_err(|e| {
            error!("Failed to link liability: {}", e);
            format!("Failed to link liability: {}", e)
        })?;

    Ok(())
}

/// Unlinks a liability from its linked asset.
#[tauri::command]
pub async fn unlink_liability(
    liability_id: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<(), String> {
    state
        .alternative_asset_service()
        .unlink_liability(&liability_id)
        .await
        .map_err(|e| {
            error!("Failed to unlink liability: {}", e);
            format!("Failed to unlink liability: {}", e)
        })?;

    Ok(())
}

/// Gets all alternative holdings (assets with their latest valuations).
#[tauri::command]
pub async fn get_alternative_holdings(
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Vec<AlternativeHoldingResponse>, String> {
    let holdings = state
        .alternative_asset_service()
        .get_alternative_holdings()
        .map_err(|e| format!("Failed to get holdings: {}", e))?;

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

    Ok(response)
}

/// Calculates net worth as of a specific date.
#[tauri::command]
pub async fn get_net_worth(
    date: Option<String>,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<NetWorthResponse, String> {
    let as_of_date = match date {
        Some(d) => {
            NaiveDate::parse_from_str(&d, "%Y-%m-%d").map_err(|e| format!("Invalid date: {}", e))?
        }
        None => Utc::now().date_naive(),
    };

    let core_response = state
        .net_worth_service()
        .get_net_worth(as_of_date)
        .await
        .map_err(|e| format!("Failed to calculate net worth: {}", e))?;

    Ok(NetWorthResponse {
        date: core_response.date.to_string(),
        assets: AssetsSection {
            total: core_response.assets.total.to_string(),
            breakdown: core_response
                .assets
                .breakdown
                .into_iter()
                .map(|item| BreakdownItem {
                    category: item.category,
                    name: item.name,
                    value: item.value.to_string(),
                    asset_id: item.asset_id,
                })
                .collect(),
        },
        liabilities: LiabilitiesSection {
            total: core_response.liabilities.total.to_string(),
            breakdown: core_response
                .liabilities
                .breakdown
                .into_iter()
                .map(|item| BreakdownItem {
                    category: item.category,
                    name: item.name,
                    value: item.value.to_string(),
                    asset_id: item.asset_id,
                })
                .collect(),
        },
        net_worth: core_response.net_worth.to_string(),
        currency: core_response.currency,
        oldest_valuation_date: core_response.oldest_valuation_date.map(|d| d.to_string()),
        stale_assets: core_response
            .stale_assets
            .into_iter()
            .map(|s| StaleAssetInfo {
                asset_id: s.asset_id,
                name: s.name,
                valuation_date: s.valuation_date.to_string(),
                days_stale: s.days_stale,
            })
            .collect(),
    })
}

/// Gets net worth history over a date range.
#[tauri::command]
pub fn get_net_worth_history(
    start_date: String,
    end_date: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Vec<NetWorthHistoryPoint>, String> {
    let start = NaiveDate::parse_from_str(&start_date, "%Y-%m-%d")
        .map_err(|e| format!("Invalid start date: {}", e))?;
    let end = NaiveDate::parse_from_str(&end_date, "%Y-%m-%d")
        .map_err(|e| format!("Invalid end date: {}", e))?;

    let history = state
        .net_worth_service()
        .get_net_worth_history(start, end)
        .map_err(|e| format!("Failed to get net worth history: {}", e))?;

    let response: Vec<NetWorthHistoryPoint> = history
        .into_iter()
        .map(|point| NetWorthHistoryPoint {
            date: point.date.to_string(),
            portfolio_value: point.portfolio_value.to_string(),
            alternative_assets_value: point.alternative_assets_value.to_string(),
            total_liabilities: point.total_liabilities.to_string(),
            total_assets: point.total_assets.to_string(),
            net_worth: point.net_worth.to_string(),
            net_contribution: point.net_contribution.to_string(),
            currency: point.currency,
        })
        .collect();

    Ok(response)
}
