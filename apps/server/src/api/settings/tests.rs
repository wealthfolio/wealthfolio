use super::*;
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use tower::ServiceExt;
use wealthfolio_core::portfolio::coordinator::JobObserver;
use wealthfolio_core::settings::SettingsRepositoryTrait;

use crate::{
    config::Config,
    events::{
        GOAL_SUMMARIES_UPDATED, PORTFOLIO_UPDATE_COMPLETE, PORTFOLIO_UPDATE_ERROR,
        PORTFOLIO_UPDATE_START,
    },
};

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

async fn pause_portfolio_job(
    state: &Arc<AppState>,
) -> (Arc<PausedJob>, tokio::task::JoinHandle<()>) {
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

    (pause, running)
}

/// Pause only the test's settings write, after the real SQLite transaction has
/// invalidated history and before the handler publishes the in-memory currency.
struct PausedSettingsRepository {
    inner: Arc<dyn SettingsRepositoryTrait>,
    persisted: tokio::sync::Notify,
    release: tokio::sync::Notify,
}

#[async_trait::async_trait]
impl SettingsRepositoryTrait for PausedSettingsRepository {
    fn get_settings(&self) -> wealthfolio_core::errors::Result<Settings> {
        self.inner.get_settings()
    }

    async fn update_settings(
        &self,
        update: &SettingsUpdate,
    ) -> wealthfolio_core::errors::Result<()> {
        self.inner.update_settings(update).await?;
        self.persisted.notify_one();
        self.release.notified().await;
        Ok(())
    }

    fn get_setting(&self, key: &str) -> wealthfolio_core::errors::Result<String> {
        self.inner.get_setting(key)
    }

    async fn update_setting(&self, key: &str, value: &str) -> wealthfolio_core::errors::Result<()> {
        self.inner.update_setting(key, value).await
    }

    fn get_distinct_currencies_excluding_base(
        &self,
        base: &str,
    ) -> wealthfolio_core::errors::Result<Vec<String>> {
        self.inner.get_distinct_currencies_excluding_base(base)
    }
}

#[tokio::test]
async fn currency_rebuild_rewrites_history_after_another_job_consumes_settings_invalidation() {
    use rust_decimal::Decimal;
    use wealthfolio_core::{
        fx::NewExchangeRate,
        portfolio::{
            coordinator::SilentObserver,
            projection::{MarkerScope, ProjectionStoreTrait},
        },
        quotes::DATA_SOURCE_MANUAL,
        settings::SettingsService,
    };
    use wealthfolio_storage_sqlite::{
        portfolio::projection::ProjectionStore, settings::SettingsRepository,
    };

    let root = tempfile::tempdir().unwrap();
    let config = test_config(root.path());
    let mut state = crate::build_state(&config).await.unwrap();
    let (pause, running) = pause_portfolio_job(&state).await;
    pause.release.notify_one();
    running.await.unwrap();

    // Stop unrelated fixture workers before substituting its settings repository.
    // The real coordinator, writer, SQLite triggers, and HTTP handler stay in use.
    let workers = std::mem::take(&mut *state.workers.lock().unwrap());
    for worker in workers {
        worker.abort();
        let _ = worker.await;
    }
    for provider in state.quote_service.get_providers_info().await.unwrap() {
        state
            .quote_service
            .update_provider_settings(&provider.id, provider.priority, false)
            .await
            .unwrap();
    }
    assert!(state
        .quote_service
        .get_providers_info()
        .await
        .unwrap()
        .iter()
        .all(|provider| !provider.enabled));

    let first_day = chrono::Utc::now().date_naive() - chrono::Duration::days(2);
    let last_day = first_day + chrono::Duration::days(2);
    let first_instant = format!("{first_day}T12:00:00Z");
    let rate = state
        .fx_service
        .add_exchange_rate(NewExchangeRate {
            from_currency: "USD".into(),
            to_currency: "EUR".into(),
            rate: Decimal::from(2),
            source: DATA_SOURCE_MANUAL.into(),
        })
        .await
        .unwrap();
    {
        let conn = state.db_access.connect_rusqlite().unwrap();
        conn.execute_batch(
            "INSERT OR REPLACE INTO app_settings(setting_key, setting_value)
             VALUES ('base_currency', 'USD');
             INSERT INTO accounts(id, name, account_type, currency, tracking_mode)
             VALUES ('currency-race', 'Currency race fixture', 'SECURITIES', 'USD', 'TRANSACTIONS');",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO activities(id, account_id, activity_type, status, activity_date,
             amount, currency, created_at, updated_at)
             VALUES ('currency-deposit', 'currency-race', 'DEPOSIT', 'POSTED', ?1,
             '100', 'USD', ?1, ?1)",
            [&first_instant],
        )
        .unwrap();
        conn.execute(
            "UPDATE quotes SET day = ?1, timestamp = ?2 WHERE asset_id = ?3",
            (first_day.to_string(), &first_instant, &rate.id),
        )
        .unwrap();
    }
    *state.base_currency.write().unwrap() = "USD".into();
    state.fx_service.initialize().unwrap();
    let initial = state
        .portfolio_coordinator
        .run_job(
            PortfolioJobConfig::default().into_request(),
            &SilentObserver,
        )
        .await
        .unwrap();
    assert!(initial.failures.is_empty(), "{:?}", initial.failures);
    let before = state
        .valuation_service
        .get_historical_valuations("currency-race", Some(first_day), Some(last_day))
        .unwrap();
    assert_eq!(before.len(), 3);
    assert!(before
        .iter()
        .all(|row| row.base_currency == "USD" && row.total_value_base == Decimal::from(100)));

    let pool = state.db_access.create_pool().unwrap();
    let projections = ProjectionStore::new(pool.clone(), state.writer.clone());
    assert!(projections.pending_markers().unwrap().is_empty());
    let repository = Arc::new(PausedSettingsRepository {
        inner: Arc::new(SettingsRepository::new(pool, state.writer.clone())),
        persisted: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
    });
    let settings = Arc::new(SettingsService::new(
        repository.clone(),
        state.fx_service.clone(),
    ));
    Arc::get_mut(&mut state)
        .expect("fixture workers and startup jobs have stopped")
        .settings_service = settings;

    let app = crate::api::app_router(state.clone(), &config).unwrap();
    let mut events = state.event_bus.subscribe();
    let save = tokio::spawn(
        app.oneshot(
            Request::builder()
                .method("PUT")
                .uri("/api/v1/settings")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"baseCurrency":"EUR"}"#))
                .unwrap(),
        ),
    );
    tokio::time::timeout(Duration::from_secs(10), repository.persisted.notified())
        .await
        .unwrap();
    assert_eq!(
        state.settings_service.get_settings().unwrap().base_currency,
        "EUR"
    );
    assert_eq!(state.base_currency().unwrap(), "USD");
    assert!(projections
        .pending_markers()
        .unwrap()
        .iter()
        .any(|marker| marker.scope == MarkerScope::All));

    // A normal job can consume the real trigger's marker using the old runtime
    // currency while the settings request is paused after its database commit.
    let competing = state
        .portfolio_coordinator
        .run_job(
            PortfolioJobConfig::default().into_request(),
            &SilentObserver,
        )
        .await
        .unwrap();
    assert!(competing.failures.is_empty(), "{:?}", competing.failures);
    assert!(projections.pending_markers().unwrap().is_empty());
    assert!(state
        .valuation_service
        .get_historical_valuations("currency-race", Some(first_day), Some(last_day))
        .unwrap()
        .iter()
        .all(|row| row.base_currency == "USD"));

    repository.release.notify_one();
    let response = tokio::time::timeout(Duration::from_secs(10), save)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let event = events.recv().await.unwrap();
            assert_ne!(event.name, PORTFOLIO_UPDATE_ERROR, "{:?}", event.payload);
            if event.name == PORTFOLIO_UPDATE_COMPLETE {
                break;
            }
        }
    })
    .await
    .unwrap();
    let after = state
        .valuation_service
        .get_historical_valuations("currency-race", Some(first_day), Some(last_day))
        .unwrap();
    assert_eq!(
        after
            .iter()
            .map(|row| row.valuation_date)
            .collect::<Vec<_>>(),
        before
            .iter()
            .map(|row| row.valuation_date)
            .collect::<Vec<_>>()
    );
    for row in after {
        assert_eq!(row.base_currency, "EUR", "date: {}", row.valuation_date);
        assert_eq!(row.total_value_base, Decimal::from(200));
        assert_eq!(row.net_contribution_base, Decimal::from(200));
    }
    assert!(projections.pending_markers().unwrap().is_empty());
}

#[tokio::test]
async fn currency_save_returns_while_rebuild_is_queued_then_refreshes_goals() {
    let root = tempfile::tempdir().unwrap();
    let config = test_config(root.path());
    let state = crate::build_state(&config).await.unwrap();
    let (pause, running) = pause_portfolio_job(&state).await;

    let goal = state
        .goal_service
        .create_goal(
            serde_json::from_value(serde_json::json!({
                "goalType": "custom_save_up",
                "title": "Currency regression",
                "targetAmount": 1000.0,
                "statusLifecycle": "active"
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(goal.summary_current_value, None);
    let mut events = state.event_bus.subscribe();
    let app = crate::api::app_router(state.clone(), &config).unwrap();

    let response = tokio::time::timeout(
        Duration::from_secs(2),
        app.clone().oneshot(
            Request::builder()
                .method("PUT")
                .uri("/api/v1/settings")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"baseCurrency":"EUR"}"#))
                .unwrap(),
        ),
    )
    .await
    .expect("saving must not wait for the busy portfolio coordinator")
    .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let saved: Settings = serde_json::from_slice(&body).unwrap();
    assert_eq!(saved.base_currency, "EUR");
    assert!(!running.is_finished());

    // Settings stay available to a fresh tab while the background job is queued.
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/settings")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    pause.release.notify_one();
    running.await.unwrap();
    let mut started = false;
    let mut completed = false;
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let event = events.recv().await.unwrap();
            match event.name {
                PORTFOLIO_UPDATE_START => started = true,
                PORTFOLIO_UPDATE_COMPLETE => completed = true,
                GOAL_SUMMARIES_UPDATED => {
                    let payload = event.payload.unwrap();
                    assert!(payload["goalIds"]
                        .as_array()
                        .unwrap()
                        .contains(&serde_json::json!(goal.id)));
                    break;
                }
                PORTFOLIO_UPDATE_ERROR => panic!("currency rebuild failed: {:?}", event.payload),
                _ => {}
            }
        }
    })
    .await
    .expect("the normal completion path must refresh goal summaries");
    assert!(started);
    assert!(completed);
    assert_eq!(
        state
            .goal_service
            .get_goal(&goal.id)
            .unwrap()
            .summary_current_value,
        Some(0.0)
    );
}

#[tokio::test]
async fn failed_currency_rebuild_emits_error_and_keeps_settings_available_for_retry() {
    let root = tempfile::tempdir().unwrap();
    let config = test_config(root.path());
    let state = crate::build_state(&config).await.unwrap();
    let (pause, running) = pause_portfolio_job(&state).await;
    // A persisted, unreadable accounting entry is a real per-account failure.
    // No assets or FX pairs are needed, so the fixture makes no provider requests.
    state
        .db_access
        .connect_rusqlite()
        .unwrap()
        .execute_batch(
            "INSERT INTO accounts (id, name, account_type, currency, is_default, is_active,
         created_at, updated_at, tracking_mode, is_archived, meta)
         VALUES ('currency-error-fixture', 'Currency failure', 'REGULAR', 'EUR', 0, 1,
         datetime('now'), datetime('now'), 'TRANSACTIONS', 0, '{\"accounting\":false}');",
        )
        .unwrap();
    let mut events = state.event_bus.subscribe();
    let app = crate::api::app_router(state.clone(), &config).unwrap();
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/api/v1/settings")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"baseCurrency":"EUR"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    pause.release.notify_one();
    running.await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let event = events.recv().await.unwrap();
            if event.name == PORTFOLIO_UPDATE_ERROR {
                let payload = event.payload.unwrap();
                assert_eq!(payload["account_id"], "currency-error-fixture");
                assert_eq!(payload["code"], "UNSUPPORTED_COST_BASIS");
                break;
            }
        }
        // Normal completion also runs after per-account errors. Consume this
        // job's event before asking the existing recalculation endpoint to retry.
        while events.recv().await.unwrap().name != PORTFOLIO_UPDATE_COMPLETE {}
    })
    .await
    .expect("a failed background currency job must emit the normal error event");
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/settings")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let saved: Settings = serde_json::from_slice(&body).unwrap();
    assert_eq!(saved.base_currency, "EUR");

    state
        .db_access
        .connect_rusqlite()
        .unwrap()
        .execute_batch("UPDATE accounts SET meta = '{}' WHERE id = 'currency-error-fixture';")
        .unwrap();
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/portfolio/recalculate")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let event = events.recv().await.unwrap();
            assert_ne!(
                event.name, PORTFOLIO_UPDATE_ERROR,
                "repaired account should rebuild"
            );
            if event.name == PORTFOLIO_UPDATE_COMPLETE {
                break;
            }
        }
    })
    .await
    .expect("the existing recalculation action must retry the repaired account");
}

#[tokio::test]
async fn a_failed_auto_update_setting_read_is_not_reported_as_enabled() {
    let root = tempfile::tempdir().unwrap();
    let state = crate::build_state(&Config {
        listen_addr: "127.0.0.1:0".parse().unwrap(),
        db_path: root.path().join("app.db").to_string_lossy().into_owned(),
        addons_root: root.path().join("addons").to_string_lossy().into_owned(),
        static_dir: root.path().join("static").to_string_lossy().into_owned(),
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
    })
    .await
    .unwrap();
    state
        .db_access
        .connect_rusqlite()
        .unwrap()
        .execute_batch("ALTER TABLE app_settings RENAME TO unreadable_settings;")
        .unwrap();

    // The app runs its startup update check unless this read says off or fails.
    assert!(is_auto_update_check_enabled(axum::Extension(state))
        .await
        .is_err());
}
