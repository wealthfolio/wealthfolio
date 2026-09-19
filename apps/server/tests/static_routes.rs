use axum::{body::to_bytes, body::Body, http::Request};
use tempfile::tempdir;
use tower::ServiceExt;
use wealthfolio_server::{
    api::{app_router, security_headers},
    build_state,
    config::Config,
    static_files,
};

fn cleanup_env() {
    for key in [
        "WF_DB_PATH",
        "WF_SECRET_KEY",
        "WF_STATIC_DIR",
        "WF_LISTEN_ADDR",
    ] {
        std::env::remove_var(key);
    }
}

#[tokio::test]
async fn serves_index_html_for_navigation() {
    let db_dir = tempdir().unwrap();
    let static_dir = tempdir().unwrap();
    let index_path = static_dir.path().join("index.html");
    std::fs::write(&index_path, "<html>SPA</html>").unwrap();

    std::env::set_var("WF_DB_PATH", db_dir.path().join("test.db"));
    std::env::set_var("WF_SECRET_KEY", "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    std::env::set_var("WF_STATIC_DIR", static_dir.path());
    std::env::set_var("WF_LISTEN_ADDR", "127.0.0.1:0");

    let config = Config::from_env().unwrap();
    let state = build_state(&config).await.unwrap();
    let app = app_router(state, &config)
        .unwrap()
        .fallback_service(static_files::router(static_dir.path()))
        .layer(axum::middleware::from_fn(security_headers));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/dashboard")
                .header("accept", "text/html")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), axum::http::StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "no-cache");
    assert!(response.headers().contains_key("content-security-policy"));
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    assert_eq!(body, "<html>SPA</html>".as_bytes());

    cleanup_env();
}
