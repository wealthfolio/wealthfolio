use super::*;
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use tower::ServiceExt;
use wealthfolio_core::portfolio::coordinator::JobObserver;

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
