//! REST API endpoints for alternative assets (properties, vehicles, collectibles, precious metals, liabilities).
//!
//! These endpoints are thin wrappers that delegate to the core AlternativeAssetService.
//! All business logic lives in the core service - these handlers only handle:
//! - String ↔ typed value conversion
//! - HTTP status code mapping
//! - Health Center cache clearing
//!
//! No write here starts a portfolio job: stored account values leave
//! alternative assets out, and net worth reads their values directly.

use std::sync::Arc;

use crate::{error::ApiResult, main_lib::AppState};
use axum::{
    extract::Path,
    http::StatusCode,
    routing::{delete, get, post, put},
    Json, Router,
};
use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use wealthfolio_core::assets::{
    AssetKind, CreateAlternativeAssetRequest as CoreCreateRequest,
    LinkLiabilityRequest as CoreLinkRequest, UpdateAssetDetailsRequest as CoreUpdateDetailsRequest,
    UpdateValuationRequest as CoreValuationRequest,
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
    #[serde(default)]
    pub loan: Option<wealthfolio_core::assets::loan::LoanSetup>,
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
    /// For liabilities: what the card shows, from the calculation that values it.
    pub loan: Option<wealthfolio_core::assets::loan::LoanSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAssetDetailsRequest {
    pub name: Option<String>,
    pub metadata: std::collections::HashMap<String, String>,
    pub notes: Option<String>,
    /// A liability's loan section, saved with the other details.
    #[serde(default)]
    pub loan: Option<wealthfolio_core::assets::loan::LoanSetup>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Handlers - Thin wrappers delegating to core service
// ─────────────────────────────────────────────────────────────────────────────

/// POST /alternative-assets - Creates a new alternative asset with initial valuation
async fn create_alternative_asset(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
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
        loan: request.loan,
    };

    // Delegate to core service
    let response = state
        .alternative_asset_service
        .create_alternative_asset(core_request)
        .await?;
    // A value dated long ago shows as stale in Health Center.
    state.health_service.clear_cache().await;

    Ok(Json(CreateAlternativeAssetResponse {
        asset_id: response.asset_id,
        quote_id: response.quote_id,
    }))
}

/// PUT /alternative-assets/:id/valuation - Updates the valuation of an alternative asset
async fn update_alternative_asset_valuation(
    Path(asset_id): Path<String>,
    axum::Extension(state): axum::Extension<Arc<AppState>>,
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
    // A new value can end a stale valuation in Health Center.
    state.health_service.clear_cache().await;

    Ok(Json(UpdateValuationResponse {
        quote_id: response.quote_id,
        valuation_date: response.valuation_date.to_string(),
        value: response.value.to_string(),
    }))
}

/// PUT /alternative-assets/:id/metadata - Updates an alternative asset's details (name, notes, and/or metadata)
async fn update_alternative_asset_metadata(
    Path(asset_id): Path<String>,
    axum::Extension(state): axum::Extension<Arc<AppState>>,
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
        loan: request.loan,
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
    axum::Extension(state): axum::Extension<Arc<AppState>>,
) -> ApiResult<StatusCode> {
    state
        .alternative_asset_service
        .delete_alternative_asset(&asset_id)
        .await?;
    // The asset's issues in Health Center go with it.
    state.health_service.clear_cache().await;

    Ok(StatusCode::NO_CONTENT)
}

/// POST /alternative-assets/:id/link-liability - Links a liability to a target asset
async fn link_liability(
    Path(liability_id): Path<String>,
    axum::Extension(state): axum::Extension<Arc<AppState>>,
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
    axum::Extension(state): axum::Extension<Arc<AppState>>,
) -> ApiResult<StatusCode> {
    state
        .alternative_asset_service
        .unlink_liability(&liability_id)
        .await?;

    Ok(StatusCode::NO_CONTENT)
}

/// GET /alternative-holdings - Gets all alternative holdings (assets with their latest valuations)
async fn get_alternative_holdings(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
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
                loan: h.loan,
            }
        })
        .collect();

    Ok(Json(response))
}

// ─────────────────────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────────────────────

pub fn router<S: Clone + Send + Sync + 'static>() -> Router<S> {
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
        .route("/loans/calculate", post(calculate_loan))
        .route("/loans/recalculate", post(recalculate_loan))
        .route("/loans/preview", post(preview_loan_terms))
        .route("/loans/{id}/actions", post(apply_loan_action))
        .route("/loans/{id}/payments", get(get_loan_payments))
        .route("/loans/payments/{activity_id}", post(link_loan_payment))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreviewLoanTermsRequest {
    #[serde(default)]
    asset_id: Option<String>,
    setup: wealthfolio_core::assets::loan::LoanSetup,
}

async fn preview_loan_terms(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Json(request): Json<PreviewLoanTermsRequest>,
) -> ApiResult<Json<Option<wealthfolio_core::assets::loan::LoanSchedulePreview>>> {
    Ok(Json(state.alternative_asset_service.preview_loan_terms(
        request.asset_id.as_deref(),
        &request.setup,
    )?))
}

async fn get_loan_payments(
    Path(asset_id): Path<String>,
    axum::Extension(state): axum::Extension<Arc<AppState>>,
) -> ApiResult<Json<Vec<wealthfolio_core::assets::loan::LoanPayment>>> {
    Ok(Json(
        state
            .alternative_asset_service
            .get_loan_payments(&asset_id)?,
    ))
}

async fn link_loan_payment(
    Path(activity_id): Path<String>,
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Json(link): Json<wealthfolio_core::assets::loan::PaymentLink>,
) -> ApiResult<StatusCode> {
    state
        .alternative_asset_service
        .link_loan_payment(&activity_id, link)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn apply_loan_action(
    Path(asset_id): Path<String>,
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Json(action): Json<wealthfolio_core::assets::loan::LoanAction>,
) -> ApiResult<StatusCode> {
    let result = state
        .alternative_asset_service
        .apply_loan_action(&asset_id, action)
        .await?;
    // Recorded balances are the loan's values: a new one can end a stale
    // valuation in Health Center, and removing one can start it.
    if result.balances_changed {
        state.health_service.clear_cache().await;
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn calculate_loan(
    Json(request): Json<wealthfolio_core::assets::loan::LoanCalculationRequest>,
) -> ApiResult<Json<Option<wealthfolio_core::assets::loan::LoanCalculation>>> {
    Ok(Json(wealthfolio_core::assets::loan::calculate_loan(
        &request,
    )))
}

async fn recalculate_loan(
    Json(request): Json<wealthfolio_core::assets::loan::LoanRecalculationRequest>,
) -> ApiResult<Json<Option<wealthfolio_core::assets::loan::LoanRecalculation>>> {
    Ok(Json(wealthfolio_core::assets::loan::recalculate_loan(
        &request,
    )))
}

#[cfg(test)]
mod tests {
    use std::{path::Path as StdPath, time::Duration};

    use axum::{
        body::{to_bytes, Body},
        http::Request,
    };
    use tower::ServiceExt;
    use wealthfolio_core::portfolio::coordinator::SilentObserver;

    use crate::{api::shared::PortfolioJobConfig, config::Config, events::PORTFOLIO_UPDATE_START};

    fn test_config(root: &StdPath) -> Config {
        Config {
            listen_addr: "127.0.0.1:0".parse().unwrap(),
            db_path: root.join("app.db").to_string_lossy().into_owned(),
            addons_root: root.join("addons").to_string_lossy().into_owned(),
            static_dir: root.join("static").to_string_lossy().into_owned(),
            cors_allow: vec![],
            request_timeout: Duration::from_secs(10),
            raw_secret_key: vec![7; 32],
            secrets_encryption_key: [8; 32],
            database_key: [9; 32],
            db_encryption_required: false,
            auth: None,
            oidc: None,
            mcp_enabled: false,
            mcp_audit_enabled: false,
            mcp_allowed_hosts: None,
        }
    }

    async fn send(
        app: &axum::Router,
        method: &str,
        uri: &str,
        body: Option<serde_json::Value>,
    ) -> serde_json::Value {
        let request = Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json")
            .body(body.map_or_else(Body::empty, |body| Body::from(body.to_string())))
            .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert!(status.is_success(), "{method} {uri}: {status} {bytes:?}");
        serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null)
    }

    /// Alternative assets sit outside account values, so changing one, or one
    /// of its values in the Values table, starts no portfolio job. A price the
    /// server can't place still does.
    #[tokio::test]
    async fn alternative_asset_changes_start_no_portfolio_job() {
        let root = tempfile::tempdir().unwrap();
        let config = test_config(root.path());
        let state = crate::build_state(&config).await.unwrap();
        let wait_for_queued_jobs = || async {
            // Queued jobs reach the coordinator's lock first; this one runs last.
            for _ in 0..10 {
                tokio::task::yield_now().await;
            }
            state
                .portfolio_coordinator
                .run_job(
                    PortfolioJobConfig::default().into_request(),
                    &SilentObserver,
                )
                .await
                .unwrap();
        };
        // Let the startup update finish before counting.
        wait_for_queued_jobs().await;
        let mut events = state.event_bus.subscribe();
        let app = crate::api::app_router(state.clone(), &config).unwrap();

        let created = send(
            &app,
            "POST",
            "/api/v1/alternative-assets",
            Some(serde_json::json!({
                "kind": "property", "name": "Old Barn", "currency": "USD",
                "currentValue": "400000", "valueDate": "2026-10-01"
            })),
        )
        .await;
        let asset_id = created["assetId"].as_str().unwrap().to_string();
        let first_value = created["quoteId"].as_str().unwrap().to_string();
        send(
            &app,
            "PUT",
            &format!("/api/v1/alternative-assets/{asset_id}/valuation"),
            Some(serde_json::json!({ "value": "460000", "date": "2026-11-01" })),
        )
        .await;
        // The Values table edits through the generic quote routes.
        send(
            &app,
            "PUT",
            &format!("/api/v1/market-data/quotes/{asset_id}"),
            Some(serde_json::json!({
                "id": "", "assetId": asset_id, "timestamp": "2026-11-05T12:00:00Z",
                "open": 470000, "high": 470000, "low": 470000, "close": 470000,
                "adjclose": 470000, "volume": 0, "currency": "USD",
                "dataSource": "MANUAL", "createdAt": "2026-11-05T12:00:00Z"
            })),
        )
        .await;
        send(
            &app,
            "DELETE",
            &format!("/api/v1/market-data/quotes/id/{first_value}"),
            None,
        )
        .await;
        send(
            &app,
            "DELETE",
            &format!("/api/v1/alternative-assets/{asset_id}"),
            None,
        )
        .await;
        // The control: a price the server can't place keeps its job.
        send(
            &app,
            "DELETE",
            "/api/v1/market-data/quotes/id/no-such-quote",
            None,
        )
        .await;
        wait_for_queued_jobs().await;

        let mut started = 0;
        while let Ok(event) = events.try_recv() {
            if event.name == PORTFOLIO_UPDATE_START {
                started += 1;
            }
        }
        assert_eq!(started, 1, "only the control's job should run");
    }
}
