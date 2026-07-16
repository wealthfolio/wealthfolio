use std::sync::Arc;

use crate::{
    api::shared::{process_portfolio_job, PortfolioJobConfig},
    error::{ApiError, ApiResult},
    events::{
        MarketSyncResult, ServerEvent, MARKET_SYNC_COMPLETE, MARKET_SYNC_ERROR, MARKET_SYNC_START,
    },
    main_lib::AppState,
};
use axum::{
    extract::State,
    http::HeaderMap,
    routing::{get, post},
    Json, Router,
};
use serde_json::json;
use wealthfolio_core::{
    health::{FixAction, HealthConfig, HealthStatus},
    portfolio::{snapshot::SnapshotRecalcMode, valuation::ValuationRecalcMode},
    quotes::MarketSyncMode,
};

/// Get current health status (cached or fresh check).
async fn get_health_status(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> ApiResult<Json<HealthStatus>> {
    // Try to get cached status first
    if let Some(status) = state.health_service.get_cached_status().await {
        if !status.is_stale {
            return Ok(Json(status));
        }
    }

    // Run fresh checks
    let base_currency = state.base_currency.read().unwrap().clone();
    let client_timezone = extract_client_timezone(&headers);
    let status =
        run_health_checks_internal(&state, &base_currency, client_timezone.as_deref()).await?;
    Ok(Json(status))
}

/// Run health checks and return fresh status.
async fn run_health_checks(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> ApiResult<Json<HealthStatus>> {
    let base_currency = state.base_currency.read().unwrap().clone();
    let client_timezone = extract_client_timezone(&headers);
    let status =
        run_health_checks_internal(&state, &base_currency, client_timezone.as_deref()).await?;
    Ok(Json(status))
}

/// Internal function to run health checks.
async fn run_health_checks_internal(
    state: &Arc<AppState>,
    base_currency: &str,
    client_timezone: Option<&str>,
) -> Result<HealthStatus, anyhow::Error> {
    let configured_timezone = state.timezone.read().unwrap().clone();
    state
        .health_service
        .run_full_checks(
            base_currency,
            state.account_service.clone(),
            state.holdings_service.clone(),
            state.quote_service.clone(),
            state.asset_service.clone(),
            state.taxonomy_service.clone(),
            state.valuation_service.clone(),
            state.snapshot_service.clone(),
            state.activity_service.clone(),
            state.lots_repository.clone(),
            Some(configured_timezone.as_str()),
            client_timezone,
        )
        .await
        .map_err(|e| anyhow::anyhow!(e.to_string()))
}

fn extract_client_timezone(headers: &HeaderMap) -> Option<String> {
    headers
        .get("X-Client-Timezone")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|tz| !tz.is_empty())
        .map(ToString::to_string)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DismissRequest {
    issue_id: String,
    data_hash: String,
}

/// Dismiss a health issue.
async fn dismiss_health_issue(
    State(state): State<Arc<AppState>>,
    Json(body): Json<DismissRequest>,
) -> ApiResult<()> {
    state
        .health_service
        .dismiss_issue(&body.issue_id, &body.data_hash)
        .await?;
    Ok(())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RestoreRequest {
    issue_id: String,
}

/// Restore a dismissed health issue.
async fn restore_health_issue(
    State(state): State<Arc<AppState>>,
    Json(body): Json<RestoreRequest>,
) -> ApiResult<()> {
    state.health_service.restore_issue(&body.issue_id).await?;
    Ok(())
}

/// Get list of dismissed issue IDs.
async fn get_dismissed_health_issues(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<Vec<String>>> {
    let ids = state.health_service.get_dismissed_ids().await?;
    Ok(Json(ids))
}

/// Execute a fix action.
async fn execute_health_fix(
    State(state): State<Arc<AppState>>,
    Json(action): Json<FixAction>,
) -> ApiResult<()> {
    // Handle migrate_legacy_classifications action specially
    if action.id == "migrate_legacy_classifications" {
        wealthfolio_core::health::migrate_legacy_classifications(
            state.asset_service.as_ref(),
            state.taxonomy_service.as_ref(),
        )
        .await?;
        return Ok(());
    }

    // Handle sync_prices / retry_sync by triggering an actual market data sync
    if action.id == "sync_prices" || action.id == "retry_sync" {
        let asset_ids: Vec<String> = serde_json::from_value(action.payload.clone())
            .map_err(|e| anyhow::anyhow!("Invalid payload for {}: {}", action.id, e))?;
        if asset_ids.is_empty() {
            return Err(ApiError::BadRequest(
                "No assets selected for price sync".to_string(),
            ));
        }

        state.event_bus.publish(ServerEvent::new(MARKET_SYNC_START));

        match state
            .quote_service
            .sync(
                wealthfolio_core::quotes::SyncMode::Incremental,
                Some(asset_ids),
            )
            .await
        {
            Ok(result) => {
                let skipped_reasons: Vec<(String, String)> = result
                    .skipped_reasons
                    .into_iter()
                    .map(|(asset_id, reason)| (asset_id, reason.to_string()))
                    .collect();
                state.event_bus.publish(ServerEvent::with_payload(
                    MARKET_SYNC_COMPLETE,
                    json!(MarketSyncResult {
                        failed_syncs: result.failures,
                        skipped_reasons,
                        show_skipped_reasons: true,
                    }),
                ));
            }
            Err(error) => {
                let message = format!("Market data sync failed: {}", error);
                state
                    .event_bus
                    .publish(ServerEvent::with_payload(MARKET_SYNC_ERROR, json!(message)));
                return Err(anyhow::anyhow!(message).into());
            }
        }

        state.health_service.clear_cache().await;
        return Ok(());
    }

    // Handle rebuild_account_history by running an account-scoped full snapshot
    // + valuation recalculation via the shared portfolio job pipeline.
    if action.id == "rebuild_account_history" {
        let account_ids: Vec<String> = serde_json::from_value(action.payload.clone())
            .map_err(|e| anyhow::anyhow!("Invalid payload for {}: {}", action.id, e))?;
        if account_ids.is_empty() {
            return Err(ApiError::BadRequest(
                "No accounts selected for history rebuild".to_string(),
            ));
        }

        let job_config = PortfolioJobConfig {
            account_ids: Some(account_ids),
            // Prices/valuations were already fixed by the user; just rebuild.
            market_sync_mode: MarketSyncMode::Incremental { asset_ids: None },
            snapshot_mode: SnapshotRecalcMode::Full,
            valuation_mode: ValuationRecalcMode::Full,
            since_date: None,
        };

        process_portfolio_job(state.clone(), job_config)
            .await
            .map_err(|e| anyhow::anyhow!("Account history rebuild failed: {}", e))?;

        state.health_service.clear_cache().await;
        return Ok(());
    }

    state.health_service.execute_fix(&action).await?;
    Ok(())
}

/// Get health configuration.
async fn get_health_config(State(state): State<Arc<AppState>>) -> ApiResult<Json<HealthConfig>> {
    let config = state.health_service.get_config().await;
    Ok(Json(config))
}

/// Update health configuration.
async fn update_health_config(
    State(state): State<Arc<AppState>>,
    Json(config): Json<HealthConfig>,
) -> ApiResult<()> {
    state.health_service.update_config(config).await?;
    Ok(())
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/health/status", get(get_health_status))
        .route("/health/check", post(run_health_checks))
        .route("/health/dismiss", post(dismiss_health_issue))
        .route("/health/restore", post(restore_health_issue))
        .route("/health/dismissed", get(get_dismissed_health_issues))
        .route("/health/fix", post(execute_health_fix))
        .route(
            "/health/config",
            get(get_health_config).put(update_health_config),
        )
}
