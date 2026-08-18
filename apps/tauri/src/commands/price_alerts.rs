use std::sync::Arc;

use tauri::State;
use wealthfolio_core::price_alerts::{NewPriceAlert, PriceAlert, PriceAlertEvent};

use crate::context::ServiceContext;

#[tauri::command]
pub async fn get_price_alerts(
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Vec<PriceAlert>, String> {
    state
        .price_alert_service()
        .get_alerts()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_price_alert_events(
    unacknowledged_only: bool,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Vec<PriceAlertEvent>, String> {
    state
        .price_alert_service()
        .get_events(unacknowledged_only)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_unacknowledged_price_alert_count(
    state: State<'_, Arc<ServiceContext>>,
) -> Result<i64, String> {
    state
        .price_alert_service()
        .count_unacknowledged_events()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_price_alert(
    input: NewPriceAlert,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<PriceAlert, String> {
    state
        .price_alert_service()
        .create_alert(input)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pause_price_alert(
    id: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<PriceAlert, String> {
    state
        .price_alert_service()
        .pause_alert(&id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn rearm_price_alert(
    id: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<PriceAlert, String> {
    state
        .price_alert_service()
        .rearm_alert(&id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_price_alert(
    id: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<(), String> {
    state
        .price_alert_service()
        .delete_alert(&id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn acknowledge_price_alert_events(
    event_ids: Option<Vec<String>>,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<usize, String> {
    state
        .price_alert_service()
        .acknowledge_events(event_ids)
        .await
        .map_err(|e| e.to_string())
}
