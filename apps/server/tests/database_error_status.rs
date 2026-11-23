#![allow(clippy::unwrap_used, clippy::panic, reason = "test code")]
use std::{net::SocketAddr, path::Path, time::Duration};

use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use tempfile::tempdir;
use tower::ServiceExt;
use wealthfolio_server::{api::app_router, build_state, config::Config};

fn test_config(root: &Path) -> Config {
    Config {
        listen_addr: "127.0.0.1:0".parse::<SocketAddr>().unwrap(),
        db_path: root.join("app.db").to_string_lossy().into_owned(),
        cors_allow: vec!["*".to_string()],
        request_timeout: Duration::from_secs(30),
        static_dir: "dist".to_string(),
        addons_root: root.join("addons").to_string_lossy().into_owned(),
        raw_secret_key: vec![7; 32],
        secrets_encryption_key: [7; 32],
        database_key: [9; 32],
        db_encryption_required: false,
        auth: None,
        oidc: None,
        mcp_enabled: false,
        mcp_audit_enabled: true,
        mcp_allowed_hosts: None,
    }
}

#[tokio::test]
async fn a_failed_database_read_is_a_server_error() {
    let root = tempdir().unwrap();
    let config = test_config(root.path());
    let state = build_state(&config).await.unwrap();
    state
        .db_access
        .connect_rusqlite()
        .unwrap()
        .execute_batch("ALTER TABLE app_settings RENAME TO unreadable_settings;")
        .unwrap();
    let app = app_router(state, &config).unwrap();

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/settings")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(body["code"], 500);
}

#[tokio::test]
async fn an_invalid_quote_mode_is_a_client_error() {
    let root = tempdir().unwrap();
    let config = test_config(root.path());
    let state = build_state(&config).await.unwrap();
    state
        .db_access
        .connect_rusqlite()
        .unwrap()
        .execute_batch(
            "INSERT INTO assets (id, kind, quote_mode, quote_ccy)
             VALUES ('test-asset', 'PROPERTY', 'MANUAL', 'USD');",
        )
        .unwrap();
    let app = app_router(state, &config).unwrap();

    let response = app
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/api/v1/assets/pricing-mode/test-asset")
                .header("Content-Type", "application/json")
                .body(Body::from(r#"{"quoteMode":"INVALID"}"#))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(body["code"], 400);
}
