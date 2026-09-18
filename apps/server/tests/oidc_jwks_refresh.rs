//! Integration test for the JWKS-refresh-on-rotation path in the OIDC callback.
//!
//! Reproduces a real incident: the IdP rotates its signing key after the
//! server's startup discovery, so the cached JWKS can no longer verify freshly
//! issued ID tokens and every login fails until a restart. The callback must
//! re-discover and retry once — succeeding when the IdP publishes the new key,
//! and still failing closed when the token's key is genuinely unknown.
//!
//! Kept in its own file on purpose: each integration-test file is a separate
//! process, which isolates the process-global env vars from `tests/oidc.rs`.

use std::net::SocketAddr;
use std::sync::{Arc, RwLock};

use axum::{
    body::Body,
    extract::ConnectInfo,
    http::{header, Request},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::Utc;
use openidconnect::{
    core::{CoreIdToken, CoreIdTokenClaims, CoreJwsSigningAlgorithm, CoreRsaPrivateSigningKey},
    Audience, EmptyAdditionalClaims, IssuerUrl, JsonWebKeyId, Nonce, PrivateSigningKey,
    StandardClaims, SubjectIdentifier,
};
use rand::{rngs::OsRng, RngCore};
use serde_json::json;
use tempfile::tempdir;
use tokio::net::TcpListener;
use tower::ServiceExt;
use wealthfolio_server::{api::app_router, build_state, config::Config};

/// Test-only RSA key (generated for this test; signs nothing outside it).
/// PKCS#1 on purpose: `CoreRsaPrivateSigningKey::from_pem` accepts only the
/// `RSA PRIVATE KEY` label.
const TEST_RSA_PEM: &str = "-----BEGIN RSA PRIVATE KEY-----
MIIEogIBAAKCAQEAuf1UvV5yq9MN1QCDXRwe7ID5MJ0r++AADLTDRd1MJllztV7b
aCLNLj99q3dLizOZT9lSs+2uI/3QvS9Sj7gnae0f/olwL5vWj0mXZ4HPCcGE5/Oa
DqAmHaEY1M1Eyy6aE2wsmNKaZlLSrUUODNdI+ITfmdq2pFDEsuhCQo8kY5f5nR9W
JuWAdfK0rPO02YbLmPnsaq4xMfGSfKFUPeIxohG70FlSvkuVoDIFH3pCN0qQyzqn
RBNVTOSLtHxu4vRQUgZw6dX39X2dDX+O08aFiUYUjbfxN4Ebt+mTA8YBzmOc2NZW
zgsnth5yDHoLYAg1qkbzZ3YW5cyoSiYMh7kS9QIDAQABAoIBABdwy/IM+gdZU3w1
sxi0T1pv29gqau10+xSe4KCIxkzsB7cDZEQw5KqwQlKut5Ts9STY50E5krHDDsCV
OwLVixQg2GAwarT5X1aSSBR5ygH5A5rnOxKeUQd5cwN49nNkJXOOteUx39dHF3nS
gvWP2YjG2FaP9+ZoLo480wMH/uZVPPVcvoinzBMDzvCSr3hEagV7WQzYigAd/ZrH
xzeafwgNZRpmM5VlZTLwUUlCgDqSzAcfYUrWUNyd85nYYFjIm7MhH7p7Lp80FiQK
XeRLTjkBKKn9C5+OKqePk62iCypd3yM7ncVqoBJytyKL83T+BPzREjfMkuuSIef9
LDx6xxECgYEA9VPM0ygaRFay7XBZref2zoy48yYOIonVPfo747yinhdbnuOmHZOo
sV0TF8oQcucNhbsjRVvQEIF8iauir1qScmDNktQOUNYyWpdBZNppbLaao979ChWf
R5eVzaN8bNz6rpFgbvFX9nM1yaNNLqm8yvifXOJAiGbbH4KslfXMYPECgYEAwhSw
UzTGTLuVuaJZmv59i8jiprXdl5rqVpPZbPWzUWpTRPOaKFcDG8rhXd6JMvKy4MZE
azzFe4QWft4uRQxsqzS9VMWoAU1IOiDe2k6+v/BfgBziA28n6BRDdf6seS7mcoCu
uYiGPIh1HGGMUpM14nFvFd6f6ZD48UdCSZXyEkUCgYBxDIS+aSRxiWI6eCNbOCFL
XR19LnQlBk71mHIwp6RoJWta9Jx/1KNP2AwMUljyGfbpQSsnsv9WG9U/u4/kLmB9
xI32szFFnu7lP/4qc1tRdXQdP4xrMTuMyhWGBWg44jvCZcuCVESslLqciFvwvNb6
0UbejoQeVwdypczR7cqYgQKBgDIzl8huBj0i6H+z9umYmnDl7Xqh4Eeu0p7Cb6M3
isKsdg2H1YBJwYwW1mSpg2OiU5LAtkHm3k4sxITcg6too1NFuROMbQCpNN2UUxC0
/bI4QvuofO3WesQVOb3zujk+YG2Ny6RCJDbUNTa6JMnXOkDwhoNpqoOH9Fy0yfiu
yIbhAoGAVm01olc50HotQPJnNfPShoyABBg5yQ2SHWVmO/9YBnD8DZLyJ477xAYe
RVplwSk6gIJfEfXYDkWZSss5DATI/9Xb5hQe0EHG5XBspnnjmvVreQfbHb/E9wpY
+0tXhZRMZxmjBVMhDWijrr3KY3ryhHVelDL8vqF8T4uAn68RYt4=
-----END RSA PRIVATE KEY-----";

struct MockIdp {
    issuer: String,
    /// Served by `/jwks`; the test mutates this to simulate a key rotation.
    jwks: Arc<RwLock<serde_json::Value>>,
    /// The ID token `/token` returns; staged by the test before each exchange.
    id_token: Arc<RwLock<Option<String>>>,
}

/// Serves discovery + mutable JWKS + a token endpoint on a random port.
async fn spawn_mock_idp() -> MockIdp {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let issuer = format!("http://{addr}");

    let jwks = Arc::new(RwLock::new(json!({ "keys": [] })));
    let id_token: Arc<RwLock<Option<String>>> = Arc::new(RwLock::new(None));

    let metadata_issuer = issuer.clone();
    let jwks_state = jwks.clone();
    let token_state = id_token.clone();
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
                        "response_types_supported": ["code"],
                        "subject_types_supported": ["public"],
                        "id_token_signing_alg_values_supported": ["RS256"],
                    }))
                }
            }),
        )
        .route(
            "/jwks",
            get(move || {
                let jwks = jwks_state.read().unwrap().clone();
                async move { Json(jwks) }
            }),
        )
        .route(
            "/token",
            post(move || {
                let id_token = token_state
                    .read()
                    .unwrap()
                    .clone()
                    .expect("test must stage an id_token before the code exchange");
                async move {
                    Json(json!({
                        "access_token": "test-access-token",
                        "token_type": "bearer",
                        "expires_in": 3600,
                        "id_token": id_token,
                    }))
                }
            }),
        );

    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    MockIdp {
        issuer,
        jwks,
        id_token,
    }
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
    // No allowlist: opt into open access, mirroring `tests/oidc.rs`.
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

fn query_param(url: &str, name: &str) -> String {
    let query = url.split_once('?').expect("URL should have a query").1;
    serde_urlencoded::from_str::<Vec<(String, String)>>(query)
        .unwrap()
        .into_iter()
        .find(|(k, _)| k == name)
        .unwrap_or_else(|| panic!("missing query param {name} in {url}"))
        .1
}

/// Requests go through rate-limited routes, so each scenario uses its own peer
/// IP (the governor keys on the client IP) via `ConnectInfo`.
fn peer_req(uri: &str, cookie: Option<&str>, peer: [u8; 4]) -> Request<Body> {
    let mut builder = Request::builder().uri(uri);
    if let Some(cookie) = cookie {
        builder = builder.header(header::COOKIE, cookie);
    }
    let mut req = builder.body(Body::empty()).unwrap();
    req.extensions_mut()
        .insert(ConnectInfo(SocketAddr::from((peer, 0))));
    req
}

/// Starts a login and returns the tx cookie pair plus the `state` and `nonce`
/// the server put in the authorize URL.
async fn start_login(app: &Router, peer: [u8; 4]) -> (String, String, String) {
    let resp = app
        .clone()
        .oneshot(peer_req("/api/v1/auth/oidc/login", None, peer))
        .await
        .unwrap();
    assert!(
        resp.status().is_redirection(),
        "login should redirect, got {}",
        resp.status()
    );
    let location = resp
        .headers()
        .get(header::LOCATION)
        .expect("login redirect should have a Location header")
        .to_str()
        .unwrap()
        .to_string();
    let tx_cookie = resp
        .headers()
        .get(header::SET_COOKIE)
        .expect("login should set the transaction cookie")
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string();
    let state = query_param(&location, "state");
    let nonce = query_param(&location, "nonce");
    (tx_cookie, state, nonce)
}

fn sign_id_token(issuer: &str, nonce: &str, signing_key: &CoreRsaPrivateSigningKey) -> String {
    let claims = CoreIdTokenClaims::new(
        IssuerUrl::new(issuer.to_string()).unwrap(),
        vec![Audience::new("test-client".to_string())],
        Utc::now() + chrono::Duration::minutes(5),
        Utc::now(),
        StandardClaims::new(SubjectIdentifier::new("user-1".to_string())),
        EmptyAdditionalClaims {},
    )
    .set_nonce(Some(Nonce::new(nonce.to_string())));
    CoreIdToken::new(
        claims,
        signing_key,
        CoreJwsSigningAlgorithm::RsaSsaPkcs1V15Sha256,
        None,
        None,
    )
    .unwrap()
    .to_string()
}

/// One test to keep the process-global env-var setup race-free within the file.
#[tokio::test]
async fn callback_refreshes_jwks_after_key_rotation() {
    let idp = spawn_mock_idp().await;

    let tmp = tempdir().unwrap();
    set_oidc_env(&idp.issuer, tmp.path().join("test.db"));

    // Discovery runs here, caching the (still empty) JWKS.
    let config = Config::from_env().unwrap();
    let state = build_state(&config).await.unwrap();
    let app = app_router(state, &config).unwrap();

    let signing_key = CoreRsaPrivateSigningKey::from_pem(
        TEST_RSA_PEM,
        Some(JsonWebKeyId::new("oidc-rsa-rotated".to_string())),
    )
    .unwrap();

    // Scenario 1 — the token's signing key is unknown and STAYS unknown: the
    // refreshed JWKS has no matching key either, so the login must fail closed.
    let (tx_cookie, csrf_state, nonce) = start_login(&app, [127, 0, 0, 10]).await;
    *idp.id_token.write().unwrap() = Some(sign_id_token(&idp.issuer, &nonce, &signing_key));
    let resp = app
        .clone()
        .oneshot(peer_req(
            &format!("/api/v1/auth/oidc/callback?code=test-code&state={csrf_state}"),
            Some(&tx_cookie),
            [127, 0, 0, 10],
        ))
        .await
        .unwrap();
    assert_eq!(
        resp.headers().get(header::LOCATION).unwrap(),
        "/?oidc_error=oidc_invalid_token",
        "an unknown signing key must still fail the login"
    );
    assert!(
        !resp
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .any(|v| v.to_str().is_ok_and(|c| c.starts_with("wf_session="))),
        "a failed verification must not mint a session cookie"
    );

    // Scenario 2 — the IdP rotated: it now publishes the new key, but the
    // server's cached JWKS predates it. The first verification fails, the
    // handler re-discovers, and the retry must complete the login.
    *idp.jwks.write().unwrap() = json!({
        "keys": [serde_json::to_value(signing_key.as_verification_key()).unwrap()]
    });
    let (tx_cookie, csrf_state, nonce) = start_login(&app, [127, 0, 0, 11]).await;
    *idp.id_token.write().unwrap() = Some(sign_id_token(&idp.issuer, &nonce, &signing_key));
    let resp = app
        .clone()
        .oneshot(peer_req(
            &format!("/api/v1/auth/oidc/callback?code=test-code&state={csrf_state}"),
            Some(&tx_cookie),
            [127, 0, 0, 11],
        ))
        .await
        .unwrap();
    assert_eq!(
        resp.headers().get(header::LOCATION).unwrap(),
        "/",
        "login with a rotated key should succeed after the JWKS refresh"
    );
    let cookies: Vec<String> = resp
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .map(|v| v.to_str().unwrap().to_string())
        .collect();
    assert!(
        cookies
            .iter()
            .any(|c| c.starts_with("wf_session=") && !c.contains("Max-Age=0")),
        "successful callback must mint wf_session, got {cookies:?}"
    );

    cleanup_env();
}
