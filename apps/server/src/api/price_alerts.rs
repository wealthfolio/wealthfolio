use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    routing::{delete, get, post},
    Json, Router,
};
use serde::Deserialize;
use wealthfolio_core::price_alerts::{NewPriceAlert, PriceAlert, PriceAlertEvent};

use crate::{error::ApiResult, main_lib::AppState};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventQuery {
    #[serde(default)]
    unacknowledged_only: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AcknowledgeBody {
    event_ids: Option<Vec<String>>,
}

async fn list_alerts(State(state): State<Arc<AppState>>) -> ApiResult<Json<Vec<PriceAlert>>> {
    Ok(Json(state.price_alert_service.get_alerts()?))
}

async fn create_alert(
    State(state): State<Arc<AppState>>,
    Json(input): Json<NewPriceAlert>,
) -> ApiResult<Json<PriceAlert>> {
    Ok(Json(state.price_alert_service.create_alert(input).await?))
}

async fn pause_alert(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<PriceAlert>> {
    Ok(Json(state.price_alert_service.pause_alert(&id).await?))
}

async fn rearm_alert(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<PriceAlert>> {
    Ok(Json(state.price_alert_service.rearm_alert(&id).await?))
}

async fn delete_alert(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> ApiResult<StatusCode> {
    state.price_alert_service.delete_alert(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn list_events(
    Query(query): Query<EventQuery>,
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<Vec<PriceAlertEvent>>> {
    Ok(Json(
        state
            .price_alert_service
            .get_events(query.unacknowledged_only)?,
    ))
}

async fn unread_count(State(state): State<Arc<AppState>>) -> ApiResult<Json<i64>> {
    Ok(Json(
        state.price_alert_service.count_unacknowledged_events()?,
    ))
}

async fn acknowledge_events(
    State(state): State<Arc<AppState>>,
    Json(body): Json<AcknowledgeBody>,
) -> ApiResult<Json<usize>> {
    Ok(Json(
        state
            .price_alert_service
            .acknowledge_events(body.event_ids)
            .await?,
    ))
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/price-alerts", get(list_alerts).post(create_alert))
        .route("/price-alerts/{id}", delete(delete_alert))
        .route("/price-alerts/{id}/pause", post(pause_alert))
        .route("/price-alerts/{id}/rearm", post(rearm_alert))
        .route("/price-alert-events", get(list_events))
        .route("/price-alert-events/unread-count", get(unread_count))
        .route("/price-alert-events/acknowledge", post(acknowledge_events))
}
