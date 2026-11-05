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
    events::{
        ServerEvent, PORTFOLIO_UPDATE_COMPLETE, PORTFOLIO_UPDATE_ERROR, PORTFOLIO_UPDATE_START,
    },
    main_lib::AppState,
};

#[derive(Default)]
pub(crate) struct CurrencyTransition {
    settings: Arc<tokio::sync::Mutex<()>>,
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

    let settings = state
        .currency_transition
        .settings
        .clone()
        .lock_owned()
        .await;
    state.currency_transition.begin();
    publish_start(&state);
    tokio::spawn(async move {
        let _settings = settings;
        let result = rebuild(&state).await;
        state.currency_transition.finish(result.is_ok());
        if result.is_ok() {
            publish_completion(&state).await;
        } else if let Err(error) = result {
            publish_error(&state, &error);
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

fn publish_start(state: &AppState) {
    state.event_bus.publish(ServerEvent::with_payload(
        PORTFOLIO_UPDATE_START,
        serde_json::json!({ "baseCurrencyChanged": true }),
    ));
}

fn publish_error(state: &AppState, error: &ApiError) {
    state.event_bus.publish(ServerEvent::with_payload(
        PORTFOLIO_UPDATE_ERROR,
        serde_json::json!(error.to_string()),
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

    // The transition publishes a tagged start event when it begins blocking
    // reads, before the coordinator starts its backfill.
    fn update_started(&self) {}

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

/// Save settings synchronously, then keep the currency rebuild alive in the
/// background if the browser disconnects or the request times out. The owned
/// settings guard serializes base-currency writes until the rebuild finishes.
pub(super) async fn update_settings(
    Extension(state): Extension<Arc<AppState>>,
    Json(payload): Json<SettingsUpdate>,
) -> ApiResult<Json<Settings>> {
    let task = tokio::spawn(async move {
        let settings = state
            .currency_transition
            .settings
            .clone()
            .lock_owned()
            .await;
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
        match result {
            Ok(settings_response) if transition => {
                publish_start(&state);
                let state_for_rebuild = state.clone();
                tokio::spawn(async move {
                    let _settings = settings;
                    let result = rebuild(&state_for_rebuild).await;
                    state_for_rebuild.currency_transition.finish(result.is_ok());
                    match result {
                        Ok(()) => publish_completion(&state_for_rebuild).await,
                        Err(error) => publish_error(&state_for_rebuild, &error),
                    }
                });
                Ok(settings_response)
            }
            result => {
                if transition {
                    // A validation error before persistence leaves the old history
                    // valid and readable. A failed persisted change remains blocked.
                    let unchanged =
                        !blocked && state.base_currency().is_ok_and(|base| base == previous);
                    state
                        .currency_transition
                        .finish(result.is_ok() || unchanged);
                }
                result
            }
        }
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
    if !guarded_read(path, request.method()) {
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

fn guarded_read(path: &str, method: &axum::http::Method) -> bool {
    let settings_read = path == "/settings";
    let safe_method = matches!(*method, axum::http::Method::GET | axum::http::Method::HEAD);
    if settings_read {
        return safe_method;
    }
    if !financial_path(path) {
        return false;
    }
    safe_method || (*method == axum::http::Method::POST && post_read_path(path))
}

fn post_read_path(path: &str) -> bool {
    matches!(
        path,
        "/holdings/query"
            | "/holdings/list/query"
            | "/valuations/history/query"
            | "/valuations/current/query"
            | "/allocations/query"
            | "/allocations/holdings/query"
            | "/performance/accounts/simple"
            | "/performance/history"
            | "/performance/summary"
            | "/performance/summaries"
            | "/income/summary/query"
            | "/spending/cash-activities/search"
            | "/spending/report"
            | "/spending/insight"
            | "/spending/event-spending-summaries"
    )
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
    use crate::config::Config;
    use axum::{
        body::Body,
        middleware,
        routing::{get, post},
        Router,
    };
    use std::time::Duration;
    use tower::ServiceExt;
    use wealthfolio_core::settings::SettingsUpdate;

    fn test_config(root: &std::path::Path) -> Config {
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

    #[test]
    fn transition_guard_only_covers_read_routes() {
        assert!(guarded_read("/settings", &axum::http::Method::GET));
        assert!(guarded_read("/settings", &axum::http::Method::HEAD));
        assert!(!guarded_read("/settings", &axum::http::Method::PUT));
        assert!(guarded_read("/holdings/query", &axum::http::Method::POST));
        assert!(guarded_read(
            "/performance/summary",
            &axum::http::Method::POST
        ));
        assert!(!guarded_read("/holdings", &axum::http::Method::POST));
        assert!(!guarded_read(
            "/spending/rules/upsert",
            &axum::http::Method::POST
        ));
    }

    struct PausedJob {
        entered: tokio::sync::Notify,
        release: tokio::sync::Notify,
    }

    #[async_trait::async_trait]
    impl JobObserver for PausedJob {
        async fn update_completed(&self) {
            self.entered.notify_one();
            self.release.notified().await;
        }
    }

    #[tokio::test]
    async fn changed_currency_returns_after_scheduling_background_rebuild() {
        let root = tempfile::tempdir().unwrap();
        let state = crate::build_state(&test_config(root.path())).await.unwrap();
        let pause = Arc::new(PausedJob {
            entered: tokio::sync::Notify::new(),
            release: tokio::sync::Notify::new(),
        });
        let running = tokio::spawn({
            let state = state.clone();
            let pause = pause.clone();
            async move {
                state
                    .portfolio_coordinator
                    .run_job(PortfolioJobConfig::default().into_request(), pause.as_ref())
                    .await
                    .unwrap();
            }
        });
        tokio::time::timeout(Duration::from_secs(10), pause.entered.notified())
            .await
            .unwrap();
        let mut events = state.event_bus.subscribe();

        let response = tokio::time::timeout(
            Duration::from_secs(2),
            update_settings(
                Extension(state.clone()),
                Json(SettingsUpdate {
                    theme_id: None,
                    gain_colors: None,
                    theme: None,
                    font: None,
                    text_size: None,
                    language: None,
                    formatting_region: None,
                    currency_formatting_regions: None,
                    base_currency: Some("EUR".to_string()),
                    timezone: None,
                    onboarding_completed: None,
                    auto_update_check_enabled: None,
                    menu_bar_visible: None,
                    sync_enabled: None,
                    default_return_metric: None,
                    insights_overview_layout: None,
                }),
            ),
        )
        .await
        .expect("saving must not wait for the busy coordinator")
        .unwrap();
        assert_eq!(response.0.base_currency, "EUR");
        assert!(state.currency_transition.blocked.load(Ordering::SeqCst));
        assert!(state.currency_transition.settings.try_lock().is_err());
        pause.release.notify_one();
        running.await.unwrap();

        let start = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let event = events.recv().await.unwrap();
                if event.name == PORTFOLIO_UPDATE_START
                    && event.payload.as_ref().is_some_and(|payload| {
                        payload["baseCurrencyChanged"] == serde_json::Value::Bool(true)
                    })
                {
                    break event;
                }
            }
        })
        .await
        .expect("currency rebuild should be scheduled after the save");
        assert_eq!(start.name, PORTFOLIO_UPDATE_START);

        let completion = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let event = events.recv().await.unwrap();
                if event.name == PORTFOLIO_UPDATE_COMPLETE
                    && event.payload.as_ref().is_some_and(|payload| {
                        payload["baseCurrencyChanged"] == serde_json::Value::Bool(true)
                    })
                {
                    break event;
                }
            }
        })
        .await
        .expect("background currency rebuild should complete");
        assert_eq!(completion.name, PORTFOLIO_UPDATE_COMPLETE);
        assert!(!state.currency_transition.blocked.load(Ordering::SeqCst));
    }

    fn test_router(transition: Arc<CurrencyTransition>) -> Router {
        Router::new()
            .route(
                "/valuations/history/query",
                get(|| async { "old-currency amounts" }),
            )
            .route("/holdings/query", post(|| async { "old-currency amounts" }))
            .route("/holdings", post(|| async { "write accepted" }))
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
        for (method, path) in [
            ("GET", "/valuations/history/query"),
            ("POST", "/holdings/query"),
            ("GET", "/settings"),
        ] {
            let response = router
                .clone()
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri(path)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::CONFLICT);
            assert_eq!(response.headers()[header::RETRY_AFTER], "2");
        }
        let write = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/holdings")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(write.status(), StatusCode::OK);
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

    #[tokio::test]
    async fn committed_write_response_survives_a_transition() {
        let transition = Arc::new(CurrencyTransition::default());
        let app = Router::new()
            .route(
                "/holdings",
                post({
                    let transition = transition.clone();
                    move || async move {
                        transition.begin();
                        transition.finish(true);
                        StatusCode::CREATED
                    }
                }),
            )
            .layer(middleware::from_fn(move |request, next| {
                let transition = transition.clone();
                async move { guard_transition(&transition, request, next).await }
            }));
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/holdings")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
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
