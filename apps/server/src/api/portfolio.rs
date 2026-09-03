use std::{convert::Infallible, sync::Arc, time::Duration};

use crate::{
    api::shared::{enqueue_consistency_pass, enqueue_portfolio_job, PortfolioRequestBody},
    error::ApiResult,
    main_lib::AppState,
};
use axum::{
    extract::State,
    http::StatusCode,
    response::sse::{Event as SseEvent, KeepAlive, Sse},
    routing::{get, post},
    Json, Router,
};
use futures_core::stream::Stream;
use tokio_stream::wrappers::{errors::BroadcastStreamRecvError, BroadcastStream};
use wealthfolio_core::quotes::{MarketSyncMode, DEFAULT_HISTORY_DAYS};

async fn update_portfolio(
    State(state): State<Arc<AppState>>,
    body: Option<Json<PortfolioRequestBody>>,
) -> ApiResult<StatusCode> {
    // Web-mode callers typically omit the body; preserve desktop behavior by defaulting
    // to an explicit market sync policy (the job runner performs no implicit sync).
    let mut request = body.map(|Json(inner)| inner).unwrap_or_default();
    if matches!(request.market_sync_mode, MarketSyncMode::None) {
        request.market_sync_mode = MarketSyncMode::Incremental { asset_ids: None };
    }
    let cfg = request.into_config();
    enqueue_portfolio_job(state, cfg);
    Ok(StatusCode::ACCEPTED)
}

/// Cold-start consistency pass for a web client whose event stream is live.
async fn ensure_consistent(State(state): State<Arc<AppState>>) -> ApiResult<StatusCode> {
    enqueue_consistency_pass(state);
    Ok(StatusCode::ACCEPTED)
}

async fn recalculate_portfolio(
    State(state): State<Arc<AppState>>,
    body: Option<Json<PortfolioRequestBody>>,
) -> ApiResult<StatusCode> {
    // In the UI, "recalculate portfolio" is used as "rebuild history", so default to a
    // BackfillHistory sync when the client doesn't provide a mode.
    let mut request = body.map(|Json(inner)| inner).unwrap_or_default();
    if matches!(request.market_sync_mode, MarketSyncMode::None) {
        request.market_sync_mode = MarketSyncMode::BackfillHistory {
            asset_ids: None,
            days: DEFAULT_HISTORY_DAYS,
        };
    }
    request.force_full = true;
    let cfg = request.into_config();
    enqueue_portfolio_job(state, cfg);
    Ok(StatusCode::ACCEPTED)
}

async fn stream_events(
    State(state): State<Arc<AppState>>,
) -> Sse<impl Stream<Item = Result<SseEvent, Infallible>>> {
    let receiver = BroadcastStream::new(state.event_bus.subscribe());
    let stream = tokio_stream::StreamExt::filter_map(receiver, |event| match event {
        Ok(evt) => {
            let sse_event = SseEvent::default().event(evt.name);
            let sse_event = if let Some(payload) = evt.payload {
                match sse_event.json_data(payload) {
                    Ok(ev) => ev,
                    Err(err) => {
                        tracing::error!(
                            "Failed to serialize SSE payload for {}: {}",
                            evt.name,
                            err
                        );
                        return None;
                    }
                }
            } else {
                sse_event.data("null")
            };
            Some(Ok(sse_event))
        }
        Err(BroadcastStreamRecvError::Lagged(_)) => None,
    });

    Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keep-alive"),
    )
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/portfolio/update", post(update_portfolio))
        .route("/portfolio/ensure-consistent", post(ensure_consistent))
        .route("/portfolio/recalculate", post(recalculate_portfolio))
        .route("/events/stream", get(stream_events))
}
