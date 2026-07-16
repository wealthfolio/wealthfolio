use std::{net::SocketAddr, time::Duration};

use axum::{
    body::{to_bytes, Body},
    http::Request,
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
        auth: None,
        oidc: None,
        mcp_enabled: false,
        mcp_audit_enabled: true,
        mcp_allowed_hosts: None,
    }
}

#[tokio::test]
async fn income_summary_query_returns_empty_data_for_empty_resolved_portfolio_scope() {
    let temp_dir = tempdir().unwrap();
    let db_path = temp_dir
        .path()
        .join("app.db")
        .to_string_lossy()
        .into_owned();
    let addons_root = temp_dir
        .path()
        .join("addons")
        .to_string_lossy()
        .into_owned();
    let config = test_config(db_path, addons_root);
    let state = build_state(&config).await.unwrap();
    let app = app_router(state, &config);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/income/summary/query")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"filter":{"type":"portfolio","portfolioId":"missing"}}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert!(response.status().is_success());
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    assert_eq!(body.as_ref(), b"[]");
}
