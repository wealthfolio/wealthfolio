#![allow(clippy::unwrap_used, clippy::panic, reason = "test code")]
use std::{net::SocketAddr, time::Duration};

use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use tempfile::tempdir;
use tower::ServiceExt;
use wealthfolio_core::addons::MAX_ADDON_ARCHIVE_COMPRESSED_SIZE;
use wealthfolio_server::{api::app_router, build_state, config::Config};

fn test_config(db_path: String, addons_root: String) -> Config {
    Config {
        listen_addr: "127.0.0.1:0".parse::<SocketAddr>().unwrap(),
        db_path,
        cors_allow: vec!["*".to_string()],
        request_timeout: Duration::from_secs(30),
        static_dir: "dist".to_string(),
        addons_root,
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

async fn post_json(app: &Router, uri: &str, body: String) -> (StatusCode, String) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(uri)
                .header("content-type", "application/json")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, String::from_utf8_lossy(&body).into_owned())
}

/// The web app sends an add-on zip as base64 in a JSON body. axum's 2 MB
/// default body limit rejected zips over about 1.5 MiB before the add-on
/// service saw them. A zip just over the service's own limit must reach the
/// service and get its error.
#[tokio::test]
async fn addon_zip_routes_accept_zips_up_to_the_service_limit() {
    let temp_dir = tempdir().unwrap();
    let path = |name: &str| temp_dir.path().join(name).to_string_lossy().into_owned();
    let config = test_config(path("app.db"), path("addons"));
    let state = build_state(&config).await.unwrap();
    let app = app_router(state, &config).unwrap();

    let zip_data_b64 = BASE64.encode(vec![0u8; MAX_ADDON_ARCHIVE_COMPRESSED_SIZE + 1]);
    let body = format!(r#"{{"zipDataB64":"{zip_data_b64}"}}"#);

    for uri in ["/api/v1/addons/extract", "/api/v1/addons/install-zip"] {
        let (status, message) = post_json(&app, uri, body.clone()).await;
        assert!(
            message.contains("ZIP addon is too large"),
            "{uri} returned {status}: {message}"
        );
    }
}

/// Only the zip routes get the larger limit.
#[tokio::test]
async fn other_addon_routes_keep_the_default_body_limit() {
    let temp_dir = tempdir().unwrap();
    let path = |name: &str| temp_dir.path().join(name).to_string_lossy().into_owned();
    let config = test_config(path("app.db"), path("addons"));
    let state = build_state(&config).await.unwrap();
    let app = app_router(state, &config).unwrap();

    let addon_id = "x".repeat(3 * 1024 * 1024);
    let body = format!(r#"{{"addonId":"{addon_id}","enabled":true}}"#);

    let (status, _) = post_json(&app, "/api/v1/addons/toggle", body).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
}
