use log::error;
use std::sync::Arc;
use tauri::{async_runtime::spawn, AppHandle, Listener, Manager};
use wealthfolio_core::quotes::MarketSyncMode;

use crate::context::ServiceContext;
use crate::events::{
    emit_portfolio_trigger_recalculate, emit_portfolio_trigger_update, PortfolioRequestPayload,
    PORTFOLIO_TRIGGER_RECALCULATE, PORTFOLIO_TRIGGER_UPDATE,
};

/// Sets up the global event listeners for the application.
pub fn setup_event_listeners(handle: AppHandle) {
    // Listener for consolidated portfolio update requests
    let update_handle = handle.clone();
    handle.listen(PORTFOLIO_TRIGGER_UPDATE, move |event| {
        handle_portfolio_request(update_handle.clone(), event.payload(), false);
    });

    // Listener for full portfolio recalculation requests
    let recalc_handle = handle.clone();
    handle.listen(PORTFOLIO_TRIGGER_RECALCULATE, move |event| {
        handle_portfolio_request(recalc_handle.clone(), event.payload(), true);
    });
}

fn handle_portfolio_request(handle: AppHandle, payload_str: &str, force_recalc: bool) {
    let event_name = if force_recalc {
        PORTFOLIO_TRIGGER_RECALCULATE
    } else {
        PORTFOLIO_TRIGGER_UPDATE
    };

    match serde_json::from_str::<PortfolioRequestPayload>(payload_str) {
        Ok(payload) => {
            spawn(async move {
                let Some(context) = handle.try_state::<Arc<ServiceContext>>() else {
                    error!(
                        "ServiceContext not found in state for {} request.",
                        event_name
                    );
                    return;
                };
                let context = Arc::clone(&context);
                crate::portfolio_jobs::run_portfolio_request(&handle, &context, payload).await;
            });
        }
        Err(e) => {
            error!(
                "Failed to parse payload for {}: {}. Triggering default action.",
                event_name, e
            );
            // Trigger a default action if payload parsing fails - use MarketSyncMode::None
            let fallback_payload = PortfolioRequestPayload::builder()
                .account_ids(None)
                .market_sync_mode(MarketSyncMode::None)
                .build();
            if force_recalc {
                emit_portfolio_trigger_recalculate(&handle, fallback_payload);
            } else {
                emit_portfolio_trigger_update(&handle, fallback_payload);
            }
        }
    }
}
