#![allow(clippy::unwrap_used, clippy::panic, reason = "test code")]
//! Refusals the user can act on keep their own code and fixed message, so the
//! app can say what to change; their internal text still stays out of the body.
use std::{net::SocketAddr, time::Duration};

use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use tempfile::tempdir;
use tower::ServiceExt;
use wealthfolio_server::{api::app_router, build_state, config::Config};

/// Only `dist/private-addon.js`, no manifest.json.
const NO_MANIFEST_ZIP: &str = "UEsDBBQAAAAAAAAAIVx/qj7tEgAAABIAAAAVAAAAZGlzdC9wcml2YXRlLWFkZG9uLmpzZXhwb3J0IGRlZmF1bHQge30KUEsBAhQDFAAAAAAAAAAhXH+qPu0SAAAAEgAAABUAAAAAAAAAAAAAAIABAAAAAGRpc3QvcHJpdmF0ZS1hZGRvbi5qc1BLBQYAAAAAAQABAEMAAABFAAAAAAA=";
/// A manifest whose main is `dist/addon.js`, and only `dist/private-other.js`.
const NO_MAIN_ZIP: &str = "UEsDBBQAAAAAAAAAIVyOKQvpSAAAAEgAAAANAAAAbWFuaWZlc3QuanNvbnsiaWQiOiJxYS1uby1tYWluIiwibmFtZSI6IlFBIiwidmVyc2lvbiI6IjEuMC4wIiwibWFpbiI6ImRpc3QvYWRkb24uanMifVBLAwQUAAAAAAAAACFcf6o+7RIAAAASAAAAFQAAAGRpc3QvcHJpdmF0ZS1vdGhlci5qc2V4cG9ydCBkZWZhdWx0IHt9ClBLAQIUAxQAAAAAAAAAIVyOKQvpSAAAAEgAAAANAAAAAAAAAAAAAACAAQAAAABtYW5pZmVzdC5qc29uUEsBAhQDFAAAAAAAAAAhXH+qPu0SAAAAEgAAABUAAAAAAAAAAAAAAIABcwAAAGRpc3QvcHJpdmF0ZS1vdGhlci5qc1BLBQYAAAAAAgACAH4AAAC4AAAAAAA=";
/// A complete add-on whose manifest asks for Wealthfolio 99.0.0.
const NEWER_HOST_ZIP: &str = "UEsDBBQAAAAAAAAAIVxp5nkpZwAAAGcAAAANAAAAbWFuaWZlc3QuanNvbnsiaWQiOiJxYS1uZXdlciIsIm5hbWUiOiJRQSIsInZlcnNpb24iOiIxLjAuMCIsIm1haW4iOiJkaXN0L2FkZG9uLmpzIiwibWluV2VhbHRoZm9saW9WZXJzaW9uIjoiOTkuMC4wIn1QSwMEFAAAAAAAAAAhXH+qPu0SAAAAEgAAAA0AAABkaXN0L2FkZG9uLmpzZXhwb3J0IGRlZmF1bHQge30KUEsBAhQDFAAAAAAAAAAhXGnmeSlnAAAAZwAAAA0AAAAAAAAAAAAAAIABAAAAAG1hbmlmZXN0Lmpzb25QSwECFAMUAAAAAAAAACFcf6o+7RIAAAASAAAADQAAAAAAAAAAAAAAgAGSAAAAZGlzdC9hZGRvbi5qc1BLBQYAAAAAAgACAHYAAADPAAAAAAA=";

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

async fn post(app: &Router, uri: &str, body: serde_json::Value) -> (StatusCode, String) {
    let request = Request::builder()
        .method("POST")
        .uri(uri)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

fn error_code(body: &str) -> String {
    let json: serde_json::Value = serde_json::from_str(body).unwrap();
    json["errorCode"].as_str().unwrap_or_default().to_string()
}

#[tokio::test]
async fn addon_package_refusals_keep_their_codes() {
    let temp_dir = tempdir().unwrap();
    let path = |name: &str| temp_dir.path().join(name).to_string_lossy().into_owned();
    let config = test_config(path("app.db"), path("addons"));
    let state = build_state(&config).await.unwrap();
    let app = app_router(state, &config).unwrap();

    for (zip, code) in [
        (NO_MANIFEST_ZIP, "ADDON_MANIFEST_MISSING"),
        (NO_MAIN_ZIP, "ADDON_MAIN_FILE_MISSING"),
    ] {
        let (status, body) = post(
            &app,
            "/api/v1/addons/extract",
            serde_json::json!({ "zipDataB64": zip }),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(error_code(&body), code, "{body}");
        assert!(!body.contains("private-"), "{body}");
    }

    let (status, body) = post(
        &app,
        "/api/v1/addons/install-zip",
        serde_json::json!({ "zipDataB64": NEWER_HOST_ZIP, "enableAfterInstall": true }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(error_code(&body), "ADDON_NEEDS_NEWER_VERSION", "{body}");
    assert!(!body.contains("99.0.0"), "{body}");
}

#[tokio::test]
async fn a_trade_without_a_quote_currency_names_the_missing_currency() {
    let temp_dir = tempdir().unwrap();
    let path = |name: &str| temp_dir.path().join(name).to_string_lossy().into_owned();
    let config = test_config(path("app.db"), path("addons"));
    let state = build_state(&config).await.unwrap();
    let app = app_router(state, &config).unwrap();

    let (status, account) = post(
        &app,
        "/api/v1/accounts",
        serde_json::json!({
            "name": "Brokerage", "accountType": "SECURITIES", "currency": "USD",
            "isDefault": false, "isActive": true, "trackingMode": "TRANSACTIONS"
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{account}");
    let account: serde_json::Value = serde_json::from_str(&account).unwrap();

    // A symbol typed without picking a search result carries no quote currency.
    let (status, body) = post(
        &app,
        "/api/v1/activities",
        serde_json::json!({
            "accountId": account["id"], "activityType": "BUY", "activityDate": "2026-11-02",
            "asset": { "symbol": "ZZQX", "exchangeMic": "XNAS" },
            "quantity": "1", "unitPrice": "10", "currency": "USD", "fee": "0"
        }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(error_code(&body), "QUOTE_CURRENCY_REQUIRED", "{body}");
}
