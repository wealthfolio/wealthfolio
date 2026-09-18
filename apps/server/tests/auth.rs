use std::net::SocketAddr;

use argon2::{password_hash::SaltString, Argon2, PasswordHasher};
use axum::{
    body::{to_bytes, Body},
    extract::ConnectInfo,
    http::{header, Method, Request},
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use rand::{rngs::OsRng, RngCore};
use tempfile::tempdir;
use tower::ServiceExt;
use wealthfolio_server::{api::app_router, build_state, config::Config};

async fn build_test_router(password: &str) -> axum::Router {
    let tmp = tempdir().unwrap();
    std::env::set_var("WF_DB_PATH", tmp.path().join("test.db"));

    let salt = SaltString::generate(&mut OsRng);
    let password_hash = Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .unwrap()
        .to_string();
    std::env::set_var("WF_AUTH_PASSWORD_HASH", password_hash);

    let mut secret_bytes = [0u8; 32];
    OsRng.fill_bytes(&mut secret_bytes);
    let secret_b64 = BASE64.encode(secret_bytes);
    std::env::set_var("WF_SECRET_KEY", secret_b64);
    std::env::set_var("WF_CORS_ALLOW_ORIGINS", "http://localhost:3000");

    let config = Config::from_env().unwrap();
    let state = build_state(&config).await.unwrap();
    app_router(state, &config).unwrap()
}

fn cleanup_env() {
    for key in [
        "WF_DB_PATH",
        "WF_AUTH_PASSWORD_HASH",
        "WF_SECRET_KEY",
        "WF_CORS_ALLOW_ORIGINS",
    ] {
        std::env::remove_var(key);
    }
}

#[tokio::test]
async fn login_and_access_protected_route() {
    let password = "super-secret";
    let app = build_test_router(password).await;

    // Unauthorized request should fail
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/accounts")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 401);

    // Auth status reflects requirement
    let status_response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/auth/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(status_response.status(), 200);
    let status_body = to_bytes(status_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let status_json: serde_json::Value = serde_json::from_slice(&status_body).unwrap();
    assert_eq!(status_json["requiresPassword"], true);

    // Login with correct password
    let login_body = serde_json::json!({ "password": password });
    let mut login_req = Request::builder()
        .method(Method::POST)
        .uri("/api/v1/auth/login")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(login_body.to_string()))
        .unwrap();
    // Governor rate-limiter needs peer IP via ConnectInfo
    login_req
        .extensions_mut()
        .insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 0))));
    let login_response = app.clone().oneshot(login_req).await.unwrap();
    assert_eq!(login_response.status(), 200);
    // Verify Set-Cookie header is present with HttpOnly session cookie
    let set_cookie = login_response
        .headers()
        .get(header::SET_COOKIE)
        .expect("login should set a cookie")
        .to_str()
        .unwrap()
        .to_owned();
    assert!(
        set_cookie.contains("wf_session="),
        "cookie should contain wf_session"
    );
    assert!(set_cookie.contains("HttpOnly"), "cookie should be HttpOnly");
    let login_bytes = to_bytes(login_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let login_json: serde_json::Value = serde_json::from_slice(&login_bytes).unwrap();
    assert_eq!(login_json["authenticated"], true);
    assert!(login_json["expiresIn"].as_u64().unwrap() > 0);
    assert!(
        login_json.get("accessToken").is_none(),
        "login should not expose accessToken"
    );

    // Extract session cookie from Set-Cookie header
    let cookie_token = set_cookie
        .split(';')
        .next()
        .unwrap()
        .trim_start_matches("wf_session=");

    // Access with cookie succeeds
    let authed_response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/accounts")
                .header(header::COOKIE, format!("wf_session={cookie_token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(authed_response.status(), 200);

    cleanup_env();
}
