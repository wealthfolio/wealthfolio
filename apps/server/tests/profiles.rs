#![allow(clippy::unwrap_used, clippy::panic, reason = "test code")]
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    middleware,
    routing::get,
    Extension, Json, Router,
};
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use tower::ServiceExt;
use wealthfolio_core::settings::SettingsServiceTrait;
use wealthfolio_server::{
    build_state,
    config::Config,
    profiles::{self, WebProfiles},
    AppState,
};

async fn send(
    router: &Router,
    path: &str,
    body: Value,
    cookie: Option<&str>,
    scope: Option<&str>,
) -> (StatusCode, Value, Option<String>) {
    let mut request = Request::builder()
        .uri(path)
        .method(if path == "/data" { "GET" } else { "POST" })
        .header("content-type", "application/json");
    if let Some(cookie) = cookie {
        request = request.header("cookie", cookie);
    }
    if let Some(scope) = scope {
        request = request.header("x-wf-profile-scope", scope);
    }
    let response = router
        .clone()
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let cookie = response
        .headers()
        .get("set-cookie")
        .map(|v| v.to_str().unwrap().split(';').next().unwrap().to_string());
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    let body =
        serde_json::from_slice(&bytes).unwrap_or_else(|_| json!(String::from_utf8_lossy(&bytes)));
    (status, body, cookie)
}

fn test_config(path: &std::path::Path) -> Config {
    Config {
        listen_addr: "127.0.0.1:0".parse().unwrap(),
        db_path: path.join("app.db").to_string_lossy().into_owned(),
        cors_allow: vec!["*".into()],
        request_timeout: Duration::from_secs(30),
        static_dir: "dist".into(),
        addons_root: path.to_string_lossy().into_owned(),
        raw_secret_key: vec![7; 32],
        secrets_encryption_key: [7; 32],
        database_key: [9; 32],
        db_encryption_required: false,
        auth: None,
        oidc: None,
        mcp_enabled: false,
        mcp_audit_enabled: false,
        mcp_allowed_hosts: None,
    }
}

#[tokio::test]
async fn browsers_databases_credentials_and_stale_scopes_are_isolated() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_config(dir.path());
    let a = build_state(&config).await.unwrap();
    let root = WebProfiles::new(a.clone(), &config).unwrap();
    let b = root
        .registry
        .create("Second", "clay-fluff-animated")
        .unwrap();
    let b_state = root.runtime(b.id).await.unwrap();
    a.settings_service
        .set_setting_value("profile-test", "A")
        .await
        .unwrap();
    b_state
        .settings_service
        .set_setting_value("profile-test", "B")
        .await
        .unwrap();
    a.secret_store.set_secret("provider", "A secret").unwrap();
    b_state
        .secret_store
        .set_secret("provider", "B secret")
        .unwrap();
    assert_ne!(a.db_path, b_state.db_path);
    assert_eq!(
        a.secret_store.get_secret("provider").unwrap().as_deref(),
        Some("A secret")
    );
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    #[cfg(any(feature = "connect-sync", feature = "device-sync"))]
    let cloud_routes = wealthfolio_server::api::connect::router();
    #[cfg(not(any(feature = "connect-sync", feature = "device-sync")))]
    let cloud_routes = Router::new();
    let router = Router::new()
        .merge(cloud_routes)
        .route(
            "/data",
            get(|Extension(state): Extension<Arc<AppState>>| async move {
                Json(json!(state
                    .settings_service
                    .get_setting_value("profile-test")
                    .unwrap()))
            }),
        )
        .route(
            "/delayed",
            axum::routing::post({
                let entered = entered.clone();
                let release = release.clone();
                move |Extension(state): Extension<Arc<AppState>>| {
                    let entered = entered.clone();
                    let release = release.clone();
                    async move {
                        entered.notify_one();
                        release.notified().await;
                        state
                            .settings_service
                            .set_setting_value("profile-test", "A completed")
                            .await
                            .unwrap();
                        Json(json!("private A response"))
                    }
                }
            })
            .layer(middleware::from_fn(profiles::admit_connect)),
        )
        .layer(middleware::from_fn_with_state(
            root.clone(),
            profiles::admit,
        ))
        .merge(profiles::router(root.clone()))
        .layer(middleware::from_fn_with_state(
            a.clone(),
            wealthfolio_server::auth::require_jwt,
        ))
        .with_state(a);
    let (_, _, cookie_a) = send(
        &router,
        "/profiles/get_profile_state",
        json!({}),
        None,
        None,
    )
    .await;
    let (_, _, cookie_b) = send(
        &router,
        "/profiles/get_profile_state",
        json!({}),
        None,
        None,
    )
    .await;
    assert_ne!(cookie_a, cookie_b);
    let a_id = root.registry.default_id().unwrap();
    let (_, grant_a, _) = send(
        &router,
        "/profiles/unlock_profile",
        json!({"profileId":a_id}),
        cookie_a.as_deref(),
        None,
    )
    .await;
    let (_, grant_b, _) = send(
        &router,
        "/profiles/unlock_profile",
        json!({"profileId":b.id}),
        cookie_b.as_deref(),
        None,
    )
    .await;
    let scope_a = grant_a["scopeId"].as_str().unwrap();
    let scope_b = grant_b["scopeId"].as_str().unwrap();
    assert_eq!(
        send(
            &router,
            "/data",
            Value::Null,
            cookie_a.as_deref(),
            Some(scope_a)
        )
        .await
        .1,
        json!("A")
    );
    assert_eq!(
        send(
            &router,
            "/data",
            Value::Null,
            cookie_b.as_deref(),
            Some(scope_b)
        )
        .await
        .1,
        json!("B")
    );
    assert_eq!(
        send(
            &router,
            "/data",
            Value::Null,
            cookie_b.as_deref(),
            Some(scope_a)
        )
        .await
        .0,
        StatusCode::LOCKED
    );
    let delayed = tokio::spawn({
        let router = router.clone();
        let cookie = cookie_a.clone();
        let scope = scope_a.to_string();
        async move {
            send(
                &router,
                "/delayed",
                json!({}),
                cookie.as_deref(),
                Some(&scope),
            )
            .await
        }
    });
    entered.notified().await;
    #[cfg(any(feature = "connect-sync", feature = "device-sync"))]
    {
        // The real login handler must not replace an account while an admitted
        // request can still write using the previous connection.
        let (status, body, _) = send(
            &router,
            "/connect/session",
            json!({ "refreshToken": "candidate", "confirmRebind": true }),
            cookie_a.as_deref(),
            Some(scope_a),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(
            body.to_string().contains("Profile operations are running"),
            "{body}"
        );
    }
    send(
        &router,
        "/profiles/lock_profile",
        json!({}),
        cookie_a.as_deref(),
        None,
    )
    .await;
    release.notify_one();
    assert_eq!(delayed.await.unwrap().0, StatusCode::LOCKED);
    assert_eq!(
        root.runtime(a_id)
            .await
            .unwrap()
            .settings_service
            .get_setting_value("profile-test")
            .unwrap()
            .as_deref(),
        Some("A completed")
    );
    assert_eq!(
        b_state
            .settings_service
            .get_setting_value("profile-test")
            .unwrap()
            .as_deref(),
        Some("B")
    );
    assert_eq!(
        send(
            &router,
            "/data",
            Value::Null,
            cookie_a.as_deref(),
            Some(scope_a)
        )
        .await
        .0,
        StatusCode::LOCKED
    );
    assert_eq!(
        send(
            &router,
            "/data",
            Value::Null,
            cookie_b.as_deref(),
            Some(scope_b)
        )
        .await
        .0,
        StatusCode::OK
    );
    root.registry
        .set_password(b.id, None, Some("correct passphrase"))
        .unwrap();
    assert_eq!(
        send(
            &router,
            "/data",
            Value::Null,
            cookie_b.as_deref(),
            Some(scope_b)
        )
        .await
        .0,
        StatusCode::LOCKED
    );
    // MCP selects a database before validating its PAT and owns a separate
    // protocol session manager. A browser password lock does not revoke a PAT.
    use wealthfolio_server::mcp::auth::{generate_token, hash_token, token_prefix};
    use wealthfolio_storage_sqlite::agent::NewPersonalAccessToken;
    let a_state = root.runtime(a_id).await.unwrap();
    let mut tokens = Vec::new();
    for state in [&a_state, &b_state] {
        let token = generate_token();
        state
            .pat_repository
            .create(NewPersonalAccessToken {
                name: "test".into(),
                token_prefix: token_prefix(&token).unwrap().into(),
                token_hash: hash_token(&token),
                scopes_json: "[\"accounts:read\"]".into(),
                expires_at: None,
            })
            .await
            .unwrap();
        tokens.push(token);
    }
    let mcp = Router::new()
        .route("/mcp", axum::routing::any(profiles::mcp))
        .with_state(root.clone());
    let request = |token: &str, profile: Option<uuid::Uuid>, session: Option<&str>| {
        let mut request = Request::builder()
            .uri("/mcp")
            .header("host", "localhost")
            .method("POST")
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .header("authorization", format!("Bearer {token}"));
        if let Some(profile) = profile {
            request = request.header("x-wf-profile-id", profile.to_string());
        }
        if let Some(session) = session {
            request = request.header("mcp-session-id", session);
        }
        request.body(Body::from(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}).to_string())).unwrap()
    };
    assert_eq!(
        mcp.clone()
            .oneshot(request(&tokens[0], Some(b.id), None))
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        mcp.clone()
            .oneshot(request(&tokens[1], None, None))
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let response = mcp
        .clone()
        .oneshot(request(&tokens[0], None, None))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let mcp_session = response
        .headers()
        .get("mcp-session-id")
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();
    drop(response);
    assert_eq!(
        mcp.clone()
            .oneshot(request(&tokens[1], Some(b.id), Some(&mcp_session)))
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        mcp.oneshot(request(&tokens[1], Some(b.id), None))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
}

#[tokio::test]
async fn legacy_automatic_access_cannot_bypass_explicit_lock_or_malformed_scope() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_config(dir.path());
    let state = build_state(&config).await.unwrap();
    let root = WebProfiles::new(state.clone(), &config).unwrap();
    let router = Router::new()
        .route("/data", get(|| async { Json(json!("data")) }))
        .layer(middleware::from_fn_with_state(
            root.clone(),
            profiles::admit,
        ))
        .merge(profiles::router(root.clone()))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            wealthfolio_server::auth::require_jwt,
        ))
        .with_state(state);
    let (status, _, cookie) = send(&router, "/data", Value::Null, None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        send(
            &router,
            "/data",
            Value::Null,
            cookie.as_deref(),
            Some("malformed")
        )
        .await
        .0,
        StatusCode::LOCKED
    );
    send(
        &router,
        "/profiles/lock_profile",
        json!({}),
        cookie.as_deref(),
        None,
    )
    .await;
    assert_eq!(
        send(&router, "/data", Value::Null, cookie.as_deref(), None)
            .await
            .0,
        StatusCode::LOCKED
    );
    assert!(send(
        &router,
        "/profiles/get_profile_state",
        json!({}),
        cookie.as_deref(),
        None
    )
    .await
    .1["session"]
        .is_null());
}

#[tokio::test]
async fn delete_profile_closes_runtime_and_supports_empty_installation() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_config(dir.path());
    let router = wealthfolio_server::api::app_router_from_config(&config)
        .await
        .unwrap();
    let (_, initial, cookie) = send(
        &router,
        "/api/v1/profiles/get_profile_state",
        json!({}),
        None,
        None,
    )
    .await;
    let id = initial["profiles"][0]["id"].as_str().unwrap();
    let name = initial["profiles"][0]["name"].as_str().unwrap();
    let scope = initial["session"]["scopeId"].as_str().unwrap();
    let (status, backup, _) = send(
        &router,
        "/api/v1/utilities/database/backup",
        json!({}),
        cookie.as_deref(),
        Some(scope),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{backup}");
    let db_path = dir.path().join("profiles").join(id).join("app.db");
    let (status, _, _) = send(
        &router,
        "/api/v1/profiles/delete_profile",
        json!({"profileId":id,"confirmation":"wrong"}),
        cookie.as_deref(),
        Some(scope),
    )
    .await;
    assert_eq!(status, StatusCode::LOCKED);
    assert!(db_path.exists());
    let (status, body, _) = send(
        &router,
        "/api/v1/profiles/delete_profile",
        json!({"profileId":id,"confirmation":name}),
        cookie.as_deref(),
        Some(scope),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(!db_path.exists());
    let (_, state, _) = send(
        &router,
        "/api/v1/profiles/get_profile_state",
        json!({}),
        cookie.as_deref(),
        None,
    )
    .await;
    assert_eq!(state["profiles"], json!([]));
    assert!(state["session"].is_null());
    drop(router);
    let reopened = WebProfiles::open(&config).await.unwrap();
    assert!(reopened.registry.list().unwrap().is_empty());
    assert!(reopened.registry.default_id().is_err());
    let new = reopened
        .registry
        .create("New", wealthfolio_core::profiles::PROFILE_AVATARS[0])
        .unwrap();
    assert!(reopened.runtime(new.id).await.is_ok());
}

#[tokio::test]
async fn missing_adopted_legacy_database_is_not_recreated_with_retained_credentials() {
    use wealthfolio_core::secrets::CLOUD_REFRESH_TOKEN_KEY;
    let dir = tempfile::tempdir().unwrap();
    let config = test_config(dir.path());
    let database = std::path::PathBuf::from(&config.db_path);
    // Registry adoption depends only on existence; runtime must fail before opening SQLite.
    std::fs::write(&database, b"legacy database").unwrap();
    let root = WebProfiles::open(&config).await.unwrap();
    let id = root.registry.default_id().unwrap();
    let profile = root.registry.profile(id).unwrap();
    assert!(profile.legacy_database.is_some());
    root.registry
        .secret_store(&profile)
        .set_secret(CLOUD_REFRESH_TOKEN_KEY, "preserved-token")
        .unwrap();
    drop(root);
    std::fs::remove_file(&database).unwrap();
    let reopened = WebProfiles::open(&config).await.unwrap();
    let error = reopened
        .runtime(id)
        .await
        .err()
        .expect("missing legacy DB must fail");
    assert!(error.1.contains("legacy profile database is missing"));
    assert!(!database.exists());
    assert_eq!(
        reopened
            .registry
            .secret_store(&profile)
            .get_secret(CLOUD_REFRESH_TOKEN_KEY)
            .unwrap()
            .as_deref(),
        Some("preserved-token")
    );
}

#[tokio::test]
async fn quote_resets_use_the_admitted_profile_runtime() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_config(dir.path());
    let state = build_state(&config).await.unwrap();
    let router = wealthfolio_server::api::app_router(state, &config).unwrap();
    let (_, profiles, cookie_a) = send(
        &router,
        "/api/v1/profiles/get_profile_state",
        json!({}),
        None,
        None,
    )
    .await;
    let first = profiles["profiles"][0]["id"].clone();
    let (status, second, _) = send(
        &router,
        "/api/v1/profiles/create_profile",
        json!({"name": "Second", "avatarId": "default"}),
        cookie_a.as_deref(),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{second}");
    let (_, _, cookie_b) = send(
        &router,
        "/api/v1/profiles/get_profile_state",
        json!({}),
        None,
        None,
    )
    .await;
    let mut scopes = Vec::new();
    for (cookie, id) in [
        (cookie_a.as_deref(), first),
        (cookie_b.as_deref(), second["id"].clone()),
    ] {
        let (status, grant, _) = send(
            &router,
            "/api/v1/profiles/unlock_profile",
            json!({"profileId": id}),
            cookie,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{grant}");
        let scope = grant["scopeId"].as_str().unwrap().to_owned();
        // Empty profiles exercise the real handler without any provider network I/O.
        let (status, body, _) = send(
            &router,
            "/api/v1/market-data/quotes/reset",
            json!({}),
            cookie,
            Some(&scope),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["results"], json!([]));
        scopes.push(scope);
    }
    assert_eq!(
        send(
            &router,
            "/api/v1/market-data/quotes/reset",
            json!({}),
            cookie_b.as_deref(),
            Some(&scopes[0]),
        )
        .await
        .0,
        StatusCode::LOCKED
    );
}

#[tokio::test]
async fn proxy_origin_configuration_allows_startup_but_rejects_untrusted_mutations() {
    let dir = tempfile::tempdir().unwrap();
    let mut config = test_config(dir.path());
    config.cors_allow = vec!["https://portfolio.example.com:8443".into()];
    let state = build_state(&config).await.unwrap();
    let root = WebProfiles::new(state.clone(), &config).unwrap();
    let router = profiles::router(root.clone())
        .layer(middleware::from_fn_with_state(
            state.clone(),
            wealthfolio_server::auth::require_jwt,
        ))
        .with_state(state);
    let request = |command: &str, origin: &str, body: Value| {
        Request::builder()
            .uri(format!("/profiles/{command}"))
            .method("POST")
            .header("content-type", "application/json")
            .header("host", "wealthfolio:8088")
            .header("origin", origin)
            .header("sec-fetch-site", "same-origin")
            .body(Body::from(body.to_string()))
            .unwrap()
    };
    let response = router
        .clone()
        .oneshot(request(
            "get_profile_state",
            "https://portfolio.example.com:8443",
            json!({}),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap())
            .unwrap();
    assert!(body["session"]["scopeId"].is_string());
    let before = root.registry.list().unwrap().len();
    for origin in [
        "https://evil.test",
        "https://portfolio.example.com",
        "http://portfolio.example.com:8443",
    ] {
        let response = router
            .clone()
            .oneshot(request(
                "create_profile",
                origin,
                json!({"name":"Untrusted", "avatarId":"clay-fluff-animated"}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::LOCKED);
        let body = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        assert!(String::from_utf8_lossy(&body).contains("PROFILE_ORIGIN_REJECTED"));
        assert_eq!(root.registry.list().unwrap().len(), before);
    }
}

#[tokio::test]
async fn admitted_ndjson_stream_delivers_incrementally_and_closes_on_lock() {
    use futures::StreamExt;
    let dir = tempfile::tempdir().unwrap();
    let config = test_config(dir.path());
    let state = build_state(&config).await.unwrap();
    let root = WebProfiles::new(state.clone(), &config).unwrap();
    let (chunks, receiver) =
        tokio::sync::mpsc::channel::<Result<String, std::convert::Infallible>>(4);
    let receiver = Arc::new(tokio::sync::Mutex::new(Some(receiver)));
    // Exercise the same admitted response-body path as AI NDJSON, without an
    // external AI provider or a completed response masking buffering regressions.
    let router = Router::new()
        .route(
            "/stream",
            get(move || {
                let receiver = receiver.clone();
                async move {
                    let stream = tokio_stream::wrappers::ReceiverStream::new(
                        receiver.lock().await.take().unwrap(),
                    );
                    (
                        [("content-type", "application/x-ndjson")],
                        Body::from_stream(stream),
                    )
                }
            }),
        )
        .layer(middleware::from_fn_with_state(
            root.clone(),
            profiles::admit,
        ))
        .merge(profiles::router(root))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            wealthfolio_server::auth::require_jwt,
        ))
        .with_state(state);
    let (_, initial, cookie) = send(
        &router,
        "/profiles/get_profile_state",
        json!({}),
        None,
        None,
    )
    .await;
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/stream")
                .header("cookie", cookie.as_deref().unwrap())
                .header(
                    "x-wf-profile-scope",
                    initial["session"]["scopeId"].as_str().unwrap(),
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let mut body = response.into_body().into_data_stream();
    for text in [
        "{\"type\":\"system\"}\n",
        "{\"type\":\"textDelta\",\"text\":\"test\"}\n",
    ] {
        chunks.send(Ok(text.into())).await.unwrap();
        let chunk = tokio::time::timeout(Duration::from_secs(2), body.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(chunk.as_ref(), text.as_bytes());
    }
    let next = body.next();
    tokio::pin!(next);
    assert!(tokio::time::timeout(Duration::from_millis(20), &mut next)
        .await
        .is_err());
    let (status, _, _) = send(
        &router,
        "/profiles/lock_profile",
        json!({}),
        cookie.as_deref(),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    // The producer is still open; revocation must end even an idle stream.
    assert!(tokio::time::timeout(Duration::from_secs(2), next)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn runtime_startup_failure_is_retryable_without_revoking_the_profile() {
    use wealthfolio_storage_sqlite::db::DbAccess;
    let dir = tempfile::tempdir().unwrap();
    let config = test_config(dir.path());
    let database = DbAccess::plaintext(&config.db_path);
    database.prepare().unwrap();
    database.run_migrations().unwrap();
    // A deterministic failure after opening SQLite, independent of locking.
    database
        .connect_rusqlite()
        .unwrap()
        .execute(
            "DELETE FROM app_settings WHERE setting_key = 'instance_id'",
            [],
        )
        .unwrap();
    let router = wealthfolio_server::api::app_router_from_config(&config)
        .await
        .unwrap();
    let (status, error, cookie) = send(
        &router,
        "/api/v1/profiles/get_profile_state",
        json!({}),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{error}");
    assert!(error.as_str().unwrap().contains("PROFILE_STARTUP_FAILED"));
    assert!(error
        .as_str()
        .unwrap()
        .contains("Missing internal instance ID"));
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/accounts")
                .header("cookie", cookie.as_deref().unwrap())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/healthz")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    database.connect_rusqlite().unwrap().execute(
        "INSERT INTO app_settings (setting_key, setting_value) VALUES ('instance_id', 'repaired-test-instance')", [],
    ).unwrap();
    let (status, state, _) = send(
        &router,
        "/api/v1/profiles/get_profile_state",
        json!({}),
        cookie.as_deref(),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{state}");
    assert_eq!(state["profiles"][0]["lockEnabled"], false);
    let scope = state["session"]["scopeId"].as_str().unwrap();
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/accounts")
                .header("cookie", cookie.as_deref().unwrap())
                .header("x-wf-profile-scope", scope)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    send(
        &router,
        "/api/v1/profiles/lock_profile",
        json!({}),
        cookie.as_deref(),
        None,
    )
    .await;
    let response = router
        .oneshot(
            Request::builder()
                .uri("/api/v1/accounts")
                .header("cookie", cookie.as_deref().unwrap())
                .header("x-wf-profile-scope", scope)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::LOCKED);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cold_profile_startup_does_not_block_cached_runtime_or_initialize_twice() {
    use wealthfolio_storage_sqlite::db::DbAccess;
    let dir = tempfile::tempdir().unwrap();
    let config = test_config(dir.path());
    let state = build_state(&config).await.unwrap();
    let root = WebProfiles::new(state.clone(), &config).unwrap();
    let warm_id = root.registry.default_id().unwrap();
    let cold = root.registry.create("Cold", "clay-fluff-animated").unwrap();
    let path = root
        .registry
        .paths(&root.registry.profile(cold.id).unwrap())
        .database;
    let database = DbAccess::plaintext(path.to_str().unwrap());
    database.prepare().unwrap();
    database.run_migrations().unwrap();
    let connection = database.connect_rusqlite().unwrap();
    connection
        .execute_batch("PRAGMA journal_mode = DELETE; BEGIN EXCLUSIVE;")
        .unwrap();

    let first = tokio::spawn({
        let root = root.clone();
        async move { root.runtime(cold.id).await }
    });
    // Ownership is acquired inside initialization, before the blocked SQLite read.
    tokio::time::timeout(Duration::from_secs(5), async {
        let owner_path = path.with_file_name("app.db.lock");
        while !owner_path.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let second = root.runtime(cold.id);
    tokio::pin!(second);
    let second_waiting = tokio::time::timeout(Duration::from_millis(50), &mut second).await;
    let warm = tokio::time::timeout(Duration::from_millis(500), root.runtime(warm_id)).await;
    connection.execute_batch("ROLLBACK;").unwrap();
    let first = tokio::time::timeout(Duration::from_secs(5), first)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let second = tokio::time::timeout(Duration::from_secs(5), second)
        .await
        .unwrap()
        .unwrap();
    assert!(
        second_waiting.is_err(),
        "The second open must wait for startup"
    );
    assert!(
        Arc::ptr_eq(&first, &second),
        "Concurrent opens must share one runtime"
    );
    assert!(Arc::ptr_eq(
        &state,
        &warm
            .expect("Cached profile waited for cold initialization")
            .unwrap()
    ));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn deleting_a_starting_profile_waits_for_startup_and_rejects_queued_opens() {
    use wealthfolio_storage_sqlite::db::DbAccess;
    let dir = tempfile::tempdir().unwrap();
    let config = test_config(dir.path());
    let state = build_state(&config).await.unwrap();
    let root = WebProfiles::new(state.clone(), &config).unwrap();
    let cold = root.registry.create("Cold", "clay-fluff-animated").unwrap();
    let path = root
        .registry
        .paths(&root.registry.profile(cold.id).unwrap())
        .database;
    let database = DbAccess::plaintext(path.to_str().unwrap());
    database.prepare().unwrap();
    database.run_migrations().unwrap();
    let connection = database.connect_rusqlite().unwrap();
    connection
        .execute_batch("PRAGMA journal_mode = DELETE; BEGIN EXCLUSIVE;")
        .unwrap();
    let startup = tokio::spawn({
        let root = root.clone();
        async move { root.runtime(cold.id).await }
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        while !path.with_file_name("app.db.lock").exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let waiting = root.runtime(cold.id);
    tokio::pin!(waiting);
    assert!(
        tokio::time::timeout(Duration::from_millis(50), &mut waiting)
            .await
            .is_err()
    );

    let owner = uuid::Uuid::new_v4().to_string();
    let session = root
        .registry
        .sessions
        .issue(&owner, cold.id, false, None)
        .unwrap();
    let router = profiles::router(root.clone())
        .layer(middleware::from_fn_with_state(
            state.clone(),
            wealthfolio_server::auth::require_jwt,
        ))
        .with_state(state);
    let deletion = tokio::spawn(async move {
        send(
            &router,
            "/profiles/delete_profile",
            json!({"profileId": cold.id, "confirmation": "Cold"}),
            Some(&format!("wf_browser={owner}")),
            Some(&session.scope_id.to_string()),
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        while !root.registry.is_deleting(cold.id) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(!deletion.is_finished());
    connection.execute_batch("ROLLBACK;").unwrap();
    drop(connection);
    drop(
        tokio::time::timeout(Duration::from_secs(5), startup)
            .await
            .unwrap()
            .unwrap()
            .unwrap(),
    );
    assert!(tokio::time::timeout(Duration::from_secs(5), waiting)
        .await
        .unwrap()
        .is_err());
    let (status, body, _) = tokio::time::timeout(Duration::from_secs(5), deletion)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(!path.exists());
    assert!(root.runtime(cold.id).await.is_err());
    assert!(
        !path.exists(),
        "A queued open recreated the deleted database"
    );
}
