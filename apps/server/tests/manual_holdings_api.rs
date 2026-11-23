#![allow(clippy::unwrap_used, clippy::panic, reason = "test code")]
//! The holdings form's save (`POST /api/v1/snapshots`): what it stores, and
//! the status and error code of each refusal.
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

fn holding(quantity: &str, average_cost: &str) -> serde_json::Value {
    // A hand-priced custom asset, so saving never calls a market data provider.
    serde_json::json!({
        "symbol": "PRIVCO", "name": "Private Co", "quantity": quantity,
        "currency": "USD", "averageCost": average_cost,
        "dataSource": "MANUAL", "assetKind": "OTHER"
    })
}

#[tokio::test]
async fn manual_holdings_save_stores_the_snapshot_and_refuses_bad_text() {
    let temp_dir = tempdir().unwrap();
    let path = |name: &str| temp_dir.path().join(name).to_string_lossy().into_owned();
    let config = test_config(path("app.db"), path("addons"));
    let state = build_state(&config).await.unwrap();
    let app = app_router(state, &config).unwrap();

    let (status, account) = send(
        &app,
        "POST",
        "/api/v1/accounts",
        Some(serde_json::json!({
            "name": "Manual holdings", "accountType": "SECURITIES", "currency": "USD",
            "isDefault": false, "isActive": true, "trackingMode": "HOLDINGS"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{account}");
    let account_id = account["id"].as_str().unwrap().to_string();
    let save = |holdings: serde_json::Value, cash: serde_json::Value, date: &str| {
        serde_json::json!({
            "accountId": account_id, "holdings": holdings,
            "cashBalances": cash, "snapshotDate": date
        })
    };

    let (status, body) = send(
        &app,
        "POST",
        "/api/v1/snapshots",
        Some(save(
            serde_json::json!([holding("10", "12.5")]),
            serde_json::json!({ "USD": "250.5", "EUR": "0" }),
            "2026-01-15",
        )),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let (status, snapshots) = send(
        &app,
        "GET",
        &format!("/api/v1/snapshots?accountId={account_id}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{snapshots}");
    let snapshot = snapshots
        .as_array()
        .unwrap()
        .iter()
        .find(|snapshot| snapshot["snapshotDate"] == "2026-01-15")
        .unwrap_or_else(|| panic!("no snapshot on 2026-01-15: {snapshots}"));
    assert_eq!(snapshot["source"], "MANUAL_ENTRY");
    assert_eq!(snapshot["positionCount"], 1);
    // The zero EUR balance is left out.
    assert_eq!(snapshot["cashCurrencyCount"], 1);

    // Each refusal answers as a server failure with the public internal
    // error, never the parse detail (the core tests pin those texts).
    for (holdings, cash, date) in [
        (
            serde_json::json!([holding("ten", "")]),
            serde_json::json!({}),
            "2026-01-16",
        ),
        (
            serde_json::json!([holding("1", "x")]),
            serde_json::json!({}),
            "2026-01-16",
        ),
        (
            serde_json::json!([]),
            serde_json::json!({ "USD": "lots" }),
            "2026-01-16",
        ),
        (serde_json::json!([]), serde_json::json!({}), "16/01/2026"),
        (
            serde_json::json!([holding("1", "")]),
            serde_json::json!({}),
            "2999-01-01",
        ),
    ] {
        let (status, body) = send(
            &app,
            "POST",
            "/api/v1/snapshots",
            Some(save(holdings, cash, date)),
        )
        .await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
        assert_eq!(body["errorCode"], "internal_error", "{date}: {body}");
        assert_eq!(
            body["message"], "The operation could not be completed.",
            "{date}: {body}"
        );
    }
    let (_, after) = send(
        &app,
        "GET",
        &format!("/api/v1/snapshots?accountId={account_id}"),
        None,
    )
    .await;
    assert_eq!(after, snapshots, "a refused save stores nothing");
}
