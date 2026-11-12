#![allow(clippy::unwrap_used, clippy::panic, reason = "test code")]
//! Saving a contribution limit (`POST`/`PUT /api/v1/limits`): which accounts
//! it may list.
use std::{net::SocketAddr, time::Duration};

use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use tempfile::tempdir;
use tower::ServiceExt;
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

async fn send(
    app: &Router,
    method: &str,
    uri: &str,
    body: Option<serde_json::Value>,
) -> (StatusCode, serde_json::Value) {
    let request = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json")
        .body(body.map_or_else(Body::empty, |body| Body::from(body.to_string())))
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let value = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
    (status, value)
}

async fn create_account(app: &Router, name: &str, account_type: &str) -> String {
    let (status, account) = send(
        app,
        "POST",
        "/api/v1/accounts",
        Some(serde_json::json!({
            "name": name, "accountType": account_type, "currency": "USD",
            "isDefault": false, "isActive": true, "trackingMode": "TRANSACTIONS"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{account}");
    account["id"].as_str().unwrap().to_string()
}

fn limit(account_ids: &str) -> serde_json::Value {
    serde_json::json!({
        "groupName": "TFSA 2026", "contributionYear": 2026, "limitAmount": 7000.0,
        "accountIds": account_ids,
        "startDate": "2026-01-01T05:00:00.000Z", "endDate": "2026-12-31T05:00:00.000Z",
        "isRecurring": false
    })
}

#[tokio::test]
async fn a_limit_listing_a_deleted_account_still_saves_without_it() {
    let temp_dir = tempdir().unwrap();
    let path = |name: &str| temp_dir.path().join(name).to_string_lossy().into_owned();
    let config = test_config(path("app.db"), path("addons"));
    let state = build_state(&config).await.unwrap();
    let app = app_router(state, &config).unwrap();

    let tfsa = create_account(&app, "TFSA", "SECURITIES").await;
    let (status, created) = send(&app, "POST", "/api/v1/limits", Some(limit(&tfsa))).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let id = created["id"].as_str().unwrap();

    // Limits saved before 3.12 can still list an account deleted since; the
    // edit dialog sends that id back with the rest.
    let deleted = "df46a71d-af46-47e0-b99e-78376742851d";
    let (status, updated) = send(
        &app,
        "PUT",
        &format!("/api/v1/limits/{id}"),
        Some(limit(&format!("{tfsa},{deleted}"))),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert_eq!(updated["accountIds"], tfsa.as_str());

    // "Add this year" copies the same list into a new limit.
    let (status, added) = send(
        &app,
        "POST",
        "/api/v1/limits",
        Some(limit(&format!("{deleted},{tfsa}"))),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{added}");
    assert_eq!(added["accountIds"], tfsa.as_str());

    // An existing account of a type limits don't count is still refused.
    let card = create_account(&app, "Visa", "CREDIT_CARD").await;
    let (status, refused) = send(
        &app,
        "PUT",
        &format!("/api/v1/limits/{id}"),
        Some(limit(&format!("{tfsa},{card}"))),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
    assert_eq!(refused["errorCode"], "invalid_input");
}
