//! Integration test for OIDC-only mode.
//!
//! Spins up a minimal mock OIDC issuer (just enough metadata for discovery) so
//! `build_state` can construct the `OidcManager`, then asserts the public
//! surface: `/auth/status` advertises OIDC, the login route redirects to the IdP
//! with a transaction cookie, and protected routes still require a session.
//!
//! All assertions live in one test to avoid races on the process-global env vars.

use std::net::SocketAddr;

use axum::{
    body::{to_bytes, Body},
    extract::ConnectInfo,
    http::{header, Request},
    routing::get,
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use rand::{rngs::OsRng, RngCore};
use serde_json::json;
use tempfile::tempdir;
use tokio::net::TcpListener;
use tower::ServiceExt;
use wealthfolio_server::{api::app_router, build_state, config::Config};

/// Serves a minimal OIDC discovery document + empty JWKS on a random port.
/// Returns the issuer base URL (e.g. `http://127.0.0.1:54321`).
async fn spawn_mock_idp() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let issuer = format!("http://{addr}");

    let metadata_issuer = issuer.clone();
    let app = Router::new()
        .route(
            "/.well-known/openid-configuration",
            get(move || {
                let issuer = metadata_issuer.clone();
                async move {
                    Json(json!({
                        "issuer": issuer,
                        "authorization_endpoint": format!("{issuer}/authorize"),
                        "token_endpoint": format!("{issuer}/token"),
                        "jwks_uri": format!("{issuer}/jwks"),
                        "end_session_endpoint": format!("{issuer}/logout"),
                        "response_types_supported": ["code"],
                        "subject_types_supported": ["public"],
                        "id_token_signing_alg_values_supported": ["RS256"],
                    }))
                }
            }),
        )
        .route("/jwks", get(|| async { Json(json!({ "keys": [] })) }));

    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    issuer
}

fn set_oidc_env(issuer: &str, db_path: std::path::PathBuf) {
    std::env::set_var("WF_DB_PATH", db_path);
    std::env::remove_var("WF_AUTH_PASSWORD_HASH");

    let mut secret = [0u8; 32];
    OsRng.fill_bytes(&mut secret);
    std::env::set_var("WF_SECRET_KEY", BASE64.encode(secret));
    std::env::set_var("WF_CORS_ALLOW_ORIGINS", "http://localhost:3000");

    std::env::set_var("WF_OIDC_ISSUER_URL", issuer);
    std::env::set_var("WF_OIDC_CLIENT_ID", "test-client");
    std::env::set_var(
        "WF_OIDC_REDIRECT_URL",
        "http://localhost:8088/api/v1/auth/oidc/callback",
    );
    std::env::set_var("WF_OIDC_SCOPES", "openid email");
    // No allowlist is configured here, so explicitly opt into open access;
    // otherwise `Config::from_env` fails closed (see WF_OIDC_ALLOW_ANY).
    std::env::set_var("WF_OIDC_ALLOW_ANY", "true");
}

fn cleanup_env() {
    for key in [
        "WF_DB_PATH",
        "WF_SECRET_KEY",
        "WF_CORS_ALLOW_ORIGINS",
        "WF_OIDC_ISSUER_URL",
        "WF_OIDC_CLIENT_ID",
        "WF_OIDC_REDIRECT_URL",
        "WF_OIDC_SCOPES",
        "WF_OIDC_ALLOW_ANY",
    ] {
        std::env::remove_var(key);
    }
}

#[tokio::test]
async fn oidc_only_mode_status_and_login_redirect() {
    let issuer = spawn_mock_idp().await;

    let tmp = tempdir().unwrap();
    set_oidc_env(&issuer, tmp.path().join("test.db"));

    let config = Config::from_env();
    let state = build_state(&config).await.unwrap();
    let app = app_router(state, &config);

    // 1. Status advertises OIDC, and password is not required.
    let status = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/auth/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(status.status(), 200);
    let body = to_bytes(status.into_body(), usize::MAX).await.unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["requiresPassword"], false);
    assert_eq!(json["oidcEnabled"], true);

    // 2. Protected routes still require a session in OIDC-only mode.
    let unauth = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/accounts")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(unauth.status(), 401);

    // 3. The login route redirects to the IdP and sets the encrypted tx cookie.
    let mut login_req = Request::builder()
        .uri("/api/v1/auth/oidc/login")
        .body(Body::empty())
        .unwrap();
    // The login governor needs the peer IP via ConnectInfo.
    login_req
        .extensions_mut()
        .insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 0))));
    let login = app.clone().oneshot(login_req).await.unwrap();
    assert!(
        login.status().is_redirection(),
        "login should redirect, got {}",
        login.status()
    );
    let location = login
        .headers()
        .get(header::LOCATION)
        .expect("redirect should have a Location header")
        .to_str()
        .unwrap();
    assert!(
        location.starts_with(&format!("{issuer}/authorize")),
        "should redirect to the IdP authorize endpoint, got {location}"
    );
    assert!(
        location.contains("code_challenge="),
        "PKCE challenge present"
    );
    assert!(
        location.contains("code_challenge_method=S256"),
        "PKCE must use S256, not plain, got {location}"
    );
    assert!(location.contains("state="), "CSRF state present");
    assert!(location.contains("nonce="), "nonce present");
    assert!(
        location.contains("response_type=code"),
        "authorization code flow"
    );
    // Configured scopes (WF_OIDC_SCOPES=openid email) are requested.
    assert!(location.contains("scope=openid"), "openid scope present");

    let set_cookie = login
        .headers()
        .get(header::SET_COOKIE)
        .expect("login should set the transaction cookie")
        .to_str()
        .unwrap();
    assert!(set_cookie.contains("wf_oidc_tx="), "tx cookie present");
    assert!(set_cookie.contains("HttpOnly"), "tx cookie is HttpOnly");
    assert!(
        set_cookie.contains("SameSite=Lax"),
        "tx cookie must be SameSite=Lax so it survives the IdP redirect"
    );
    assert!(
        set_cookie.contains("Path=/api/v1/auth/oidc"),
        "tx cookie is path-scoped"
    );

    // 4. Callback error paths return a generic ?oidc_error redirect (no panic,
    //    no leakage). Both go through the rate-limited route, so set ConnectInfo.
    let mut no_params = Request::builder()
        .uri("/api/v1/auth/oidc/callback")
        .body(Body::empty())
        .unwrap();
    no_params
        .extensions_mut()
        .insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 0))));
    let no_params_resp = app.clone().oneshot(no_params).await.unwrap();
    assert_eq!(
        no_params_resp.headers().get(header::LOCATION).unwrap(),
        "/?oidc_error=oidc_missing_params",
    );

    // code+state present but no transaction cookie -> treated as expired.
    let mut no_tx = Request::builder()
        .uri("/api/v1/auth/oidc/callback?code=abc&state=xyz")
        .body(Body::empty())
        .unwrap();
    no_tx
        .extensions_mut()
        .insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 0))));
    let no_tx_resp = app.clone().oneshot(no_tx).await.unwrap();
    assert_eq!(
        no_tx_resp.headers().get(header::LOCATION).unwrap(),
        "/?oidc_error=oidc_expired",
    );

    // 5. Logout with no OIDC session cookie falls back to a local logout
    //    (redirect to "/") and clears the session cookie.
    let logout = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/auth/oidc/logout")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(
        logout.status().is_redirection(),
        "logout should redirect, got {}",
        logout.status()
    );
    assert_eq!(
        logout.headers().get(header::LOCATION).unwrap(),
        "/",
        "no OIDC session -> local logout to /"
    );
    let logout_cookies: Vec<String> = logout
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .map(|v| v.to_str().unwrap().to_string())
        .collect();
    assert!(
        logout_cookies
            .iter()
            .any(|c| c.contains("wf_session=") && c.contains("Max-Age=0")),
        "logout should clear wf_session"
    );

    cleanup_env();
}
