//! Web-only base-currency transitions.
//!
//! The coordinator serializes portfolio jobs, but it cannot stop an HTTP read
//! that started before a currency rebuild. This small per-profile transition
//! state keeps those reads from exposing mixed-currency results.

use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};

use axum::{
    extract::Request,
    http::{header, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Extension, Json,
};
use wealthfolio_core::{
    accounts::AccountServiceTrait,
    portfolio::coordinator::{AccountFailure, JobObserver, RetryPolicy},
    portfolio::projection::{MarkerScope, ProjectionStoreTrait},
    quotes::{MarketSyncMode, SyncResult},
    settings::{Settings, SettingsUpdate},
};

use crate::{
    api::shared::{PortfolioJobConfig, ServerJobObserver},
    error::{ApiError, ApiResult},
    events::{ServerEvent, PORTFOLIO_UPDATE_COMPLETE},
    main_lib::AppState,
};

#[derive(Default)]
pub(crate) struct CurrencyTransition {
    settings: tokio::sync::Mutex<()>,
    blocked: AtomicBool,
    revision: AtomicU64,
}

/// Reuse the ordinary startup job after an interrupted or partial rebuild.
/// Existing `@all` markers are authoritative; the row check covers a failure
/// that consumed the marker before all historical windows were rewritten.
pub(crate) async fn spawn_startup_update(
    state: Arc<AppState>,
    projections: Arc<dyn ProjectionStoreTrait>,
) -> ApiResult<()> {
    let pending = projections
        .pending_markers()?
        .iter()
        .any(|marker| marker.scope == MarkerScope::All);
    let base = state.base_currency()?;
    let accounts: Vec<_> = state
        .account_service
        .get_non_archived_accounts()?
        .into_iter()
        .map(|account| account.id)
        .collect();

    if accounts.is_empty() {
        crate::api::shared::spawn_portfolio_update(state);
        return Ok(());
    }

    let valuations = state.valuation_service.clone();
    let mismatched =
        tokio::task::spawn_blocking(move || -> wealthfolio_core::errors::Result<bool> {
            for account in accounts {
                let rows = valuations.get_historical_valuations(&account, None, None)?;
                if rows.iter().any(|row| row.base_currency != base) {
                    return Ok(true);
                }
            }
            Ok(false)
        })
        .await
        .map_err(|_| {
            ApiError::Internal("Could not check historical currencies at startup.".into())
        })??;

    if !pending && !mismatched {
        crate::api::shared::spawn_portfolio_update(state);
        return Ok(());
    }

    state.currency_transition.begin();
    tokio::spawn(async move {
        let _settings = state.currency_transition.settings.lock().await;
        state.currency_transition.begin();
        let result = rebuild(&state).await;
        state.currency_transition.finish(result.is_ok());
        if result.is_ok() {
            publish_completion(&state).await;
        }
    });
    Ok(())
}

async fn publish_completion(state: &AppState) {
    state.health_service.clear_cache().await;
    state.event_bus.publish(ServerEvent::with_payload(
        PORTFOLIO_UPDATE_COMPLETE,
        serde_json::json!({ "baseCurrencyChanged": true }),
    ));
}

/// Do not let the ordinary observer publish completion while the transition is
/// still blocked. The final event is emitted after the guard is released.
struct CurrencyObserver(ServerJobObserver);

impl JobObserver for CurrencyObserver {
    fn market_sync_started(&self) {
        self.0.market_sync_started();
    }

    fn market_sync_completed(&self, result: &SyncResult) {
        self.0.market_sync_completed(result);
    }

    fn market_sync_failed(&self, message: &str) {
        self.0.market_sync_failed(message);
    }

    fn update_started(&self) {
        self.0.update_started();
    }

    fn update_failed(&self, failure: &AccountFailure) {
        self.0.update_failed(failure);
    }
}

fn rebuild_config() -> PortfolioJobConfig {
    PortfolioJobConfig {
        account_ids: None,
        market_sync_mode: MarketSyncMode::BackfillHistory {
            asset_ids: None,
            days: wealthfolio_core::quotes::DEFAULT_HISTORY_DAYS,
        },
        // The coordinator's existing force-full path invalidates @all from
        // genesis, ensuring all historical rows use the new currency.
        force_full: true,
    }
}

pub(super) async fn rebuild(state: &Arc<AppState>) -> ApiResult<()> {
    let report = state
        .portfolio_coordinator
        .run_job_with_retry(
            rebuild_config().into_request(),
            &CurrencyObserver(ServerJobObserver::new(state)),
            RetryPolicy::default(),
        )
        .await?;
    if !report.failures.is_empty() {
        return Err(ApiError::Internal(
            "Currency history rebuild failed. Review data issues, then save the base currency again to retry."
                .to_string(),
        ));
    }
    Ok(())
}

/// Keep the rebuild alive if the browser disconnects or the request times out.
/// The success response is produced only after the complete history is ready.
pub(super) async fn update_settings(
    Extension(state): Extension<Arc<AppState>>,
    Json(payload): Json<SettingsUpdate>,
) -> ApiResult<Json<Settings>> {
    let task = tokio::spawn(async move {
        let _settings = state.currency_transition.settings.lock().await;
        let previous = state.base_currency()?;
        let blocked = state.currency_transition.blocked.load(Ordering::SeqCst);
        let changed = payload
            .base_currency
            .as_ref()
            .is_some_and(|currency| currency != &previous);
        let transition = changed || (blocked && payload.base_currency.is_some());
        if transition {
            state.currency_transition.begin();
        }

        let result = super::update_settings(Extension(state.clone()), Json(payload)).await;
        let result = match result {
            Ok(settings) if transition && !changed => rebuild(&state).await.map(|()| settings),
            result => result,
        };

        if transition {
            // A validation error before persistence leaves the old history
            // valid and readable. A failed persisted change remains blocked.
            let unchanged = !blocked && state.base_currency().is_ok_and(|base| base == previous);
            state
                .currency_transition
                .finish(result.is_ok() || unchanged);
            if result.is_ok() {
                publish_completion(&state).await;
            }
        }
        result
    });

    task.await.map_err(|_| {
        ApiError::Internal("Settings update interrupted; retry the base currency change.".into())
    })?
}

fn financial_path(path: &str) -> bool {
    let path = path.strip_prefix("/api/v1").unwrap_or(path);
    [
        "/holdings",
        "/valuations",
        "/performance",
        "/allocations",
        "/net-worth",
        "/income",
        "/goals",
        "/limits",
        "/spending",
        "/snapshots/holdings",
        "/utilities/export",
    ]
    .iter()
    .any(|prefix| {
        path == *prefix
            || path
                .strip_prefix(prefix)
                .is_some_and(|rest| rest.starts_with('/'))
    })
}

fn unavailable() -> Response {
    (
        StatusCode::CONFLICT,
        [(header::RETRY_AFTER, "2")],
        Json(serde_json::json!({
            "code": 409,
            "message": "Base currency history is rebuilding or needs repair. Retry after completion; if rebuilding failed, review data issues and save the base currency again to retry."
        })),
    )
        .into_response()
}

pub(crate) async fn guard_reads(
    Extension(state): Extension<Arc<AppState>>,
    request: Request,
    next: Next,
) -> Response {
    guard_transition(&state.currency_transition, request, next).await
}

async fn guard_transition(
    transition: &CurrencyTransition,
    request: Request,
    next: Next,
) -> Response {
    let path = request
        .uri()
        .path()
        .strip_prefix("/api/v1")
        .unwrap_or(request.uri().path());
    let settings_read = path == "/settings" && request.method() == axum::http::Method::GET;
    if !settings_read && !financial_path(path) {
        return next.run(request).await;
    }

    let revision = transition.revision.load(Ordering::SeqCst);
    if !transition.accepts(revision) {
        return unavailable();
    }
    let response = next.run(request).await;
    if transition.accepts(revision) {
        response
    } else {
        unavailable()
    }
}

impl CurrencyTransition {
    fn begin(&self) {
        self.blocked.store(true, Ordering::SeqCst);
        self.revision.fetch_add(1, Ordering::SeqCst);
    }

    fn finish(&self, success: bool) {
        self.blocked.store(!success, Ordering::SeqCst);
    }

    fn accepts(&self, revision: u64) -> bool {
        !self.blocked.load(Ordering::SeqCst) && self.revision.load(Ordering::SeqCst) == revision
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, middleware, routing::get, Router};
    use tower::ServiceExt;

    #[test]
    fn currency_rebuild_covers_every_account_from_genesis() {
        let request = rebuild_config().into_request();
        assert!(request.force_full);
        assert!(request.account_ids.is_none());
        assert!(matches!(
            request.market_sync,
            MarketSyncMode::BackfillHistory {
                asset_ids: None,
                ..
            }
        ));
    }

    fn test_router(transition: Arc<CurrencyTransition>) -> Router {
        Router::new()
            .route(
                "/valuations/history/query",
                get(|| async { "old-currency amounts" }),
            )
            .route(
                "/settings",
                get(|| async { "settings" }).put(|| async { "retry accepted" }),
            )
            .layer(middleware::from_fn(move |request, next| {
                let transition = transition.clone();
                async move { guard_transition(&transition, request, next).await }
            }))
    }

    #[tokio::test]
    async fn reads_block_during_rebuild_but_settings_retry_stays_available() {
        let transition = Arc::new(CurrencyTransition::default());
        let router = test_router(transition.clone());
        transition.begin();
        for path in ["/valuations/history/query", "/settings"] {
            let response = router
                .clone()
                .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::CONFLICT);
            assert_eq!(response.headers()[header::RETRY_AFTER], "2");
        }
        let retry = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/settings")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(retry.status(), StatusCode::OK);
        transition.finish(true);
    }

    #[test]
    fn responses_spanning_a_transition_are_rejected() {
        let transition = CurrencyTransition::default();
        let revision = transition.revision.load(Ordering::SeqCst);
        assert!(transition.accepts(revision));
        transition.begin();
        assert!(!transition.accepts(revision));
        transition.finish(true);
        assert!(!transition.accepts(revision));
        assert!(transition.accepts(transition.revision.load(Ordering::SeqCst)));
    }

    #[tokio::test]
    async fn an_in_flight_read_cannot_return_its_old_currency_after_rebuild() {
        let transition = Arc::new(CurrencyTransition::default());
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let app = Router::new()
            .route(
                "/valuations/history/query",
                get({
                    let entered = entered.clone();
                    let release = release.clone();
                    move || async move {
                        entered.notify_one();
                        release.notified().await;
                        "old currency"
                    }
                }),
            )
            .layer(middleware::from_fn({
                let transition = transition.clone();
                move |request, next| {
                    let transition = transition.clone();
                    async move { guard_transition(&transition, request, next).await }
                }
            }));
        let read = tokio::spawn(
            app.oneshot(
                Request::builder()
                    .uri("/valuations/history/query")
                    .body(Body::empty())
                    .unwrap(),
            ),
        );
        entered.notified().await;
        transition.begin();
        transition.finish(true);
        release.notify_one();
        assert_eq!(read.await.unwrap().unwrap().status(), StatusCode::CONFLICT);
    }
}
