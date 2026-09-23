use crate::{
    auth::BackupSession,
    config::Config,
    main_lib::AppState,
    profiles::{admit, router, WebProfiles},
};
use axum::{
    body::Body,
    http::{Request, StatusCode},
    middleware::Next,
    Extension, Router,
};
use serde_json::{json, Value};
use std::sync::Arc;
use wealthfolio_core::profiles::{ProfileSession, PROFILE_SCOPE_HEADER};

async fn connect_test_app() -> (
    tempfile::TempDir,
    Arc<WebProfiles>,
    Arc<AppState>,
    ProfileSession,
    Router,
) {
    let directory = tempfile::tempdir().unwrap();
    let config = Config {
        listen_addr: "127.0.0.1:0".parse().unwrap(),
        db_path: directory
            .path()
            .join("app.db")
            .to_string_lossy()
            .into_owned(),
        cors_allow: vec![],
        request_timeout: std::time::Duration::from_secs(30),
        static_dir: "dist".into(),
        addons_root: directory.path().to_string_lossy().into_owned(),
        raw_secret_key: vec![7; 32],
        secrets_encryption_key: [7; 32],
        database_key: [9; 32],
        db_encryption_required: false,
        auth: None,
        oidc: None,
        mcp_enabled: false,
        mcp_audit_enabled: false,
        mcp_allowed_hosts: None,
    };
    let state = crate::build_state(&config).await.unwrap();
    let root = WebProfiles::new(state.clone(), &config).unwrap();
    let grant = root
        .registry
        .sessions
        .issue("browser", root.registry.default_id().unwrap(), false, None)
        .unwrap();
    let app = Router::new()
        .merge(crate::api::holdings::router())
        .merge(crate::api::settings::router())
        .merge(crate::api::accounts::router());
    #[cfg(any(feature = "connect-sync", feature = "device-sync"))]
    let app = app.merge(crate::api::connect::router());
    #[cfg(feature = "device-sync")]
    let app = app.merge(crate::api::device_sync::router());
    let app = app
        .layer(axum::middleware::from_fn_with_state(root.clone(), admit))
        .merge(router(root.clone()))
        .layer(Extension(BackupSession("browser".into())));
    (directory, root, state, grant, app)
}

fn profile_request(grant: &ProfileSession, path: &str, method: &str, body: Value) -> Request<Body> {
    Request::builder()
        .uri(path)
        .method(method)
        .header("content-type", "application/json")
        .header(PROFILE_SCOPE_HEADER, grant.scope_id.to_string())
        .body(Body::from(body.to_string()))
        .unwrap()
}

#[tokio::test]
async fn connect_lock_blocks_connect_routes_and_mixed_writes_but_not_local_data() {
    use tower::ServiceExt;
    let (_directory, root, state, grant, app) = connect_test_app().await;
    let transition = state.connect_transition.clone().write_owned().await;
    let mut requests = vec![
        (
            "/holdings/list/query",
            "POST",
            json!({"filter": {"type": "all"}}),
            StatusCode::OK,
        ),
        ("/settings", "PUT", json!({"theme": "dark"}), StatusCode::OK),
        (
            "/settings",
            "PUT",
            json!({"syncEnabled": true}),
            StatusCode::FORBIDDEN,
        ),
        (
            "/accounts",
            "POST",
            json!({
                "name": "Linked", "accountType": "SECURITIES", "currency": "USD",
                "isDefault": false, "isActive": true, "provider": "test-broker"
            }),
            StatusCode::FORBIDDEN,
        ),
        (
            "/profiles/get_profile_sync_identity",
            "POST",
            json!({}),
            StatusCode::SERVICE_UNAVAILABLE,
        ),
        (
            "/profiles/update_profile_sync_identity",
            "POST",
            json!({}),
            StatusCode::SERVICE_UNAVAILABLE,
        ),
    ];
    #[cfg(any(feature = "connect-sync", feature = "device-sync"))]
    requests.push((
        "/connect/session/status",
        "GET",
        json!({}),
        StatusCode::SERVICE_UNAVAILABLE,
    ));
    #[cfg(feature = "device-sync")]
    requests.push((
        "/sync/restore/cancel",
        "POST",
        json!({"operationId": "test"}),
        StatusCode::SERVICE_UNAVAILABLE,
    ));
    for (path, method, body, expected) in requests {
        let response = app
            .clone()
            .oneshot(profile_request(&grant, path, method, body))
            .await
            .unwrap();
        assert_eq!(response.status(), expected, "{path}");
        assert!(root
            .registry
            .sessions
            .admit("browser", grant.scope_id)
            .is_ok());
    }
    drop(transition);
    let response = app
        .clone()
        .oneshot(profile_request(
            &grant,
            "/profiles/get_profile_sync_identity",
            "POST",
            json!({}),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    root.registry.sessions.revoke("browser").unwrap();
    let response = app
        .oneshot(profile_request(
            &grant,
            "/holdings/list/query",
            "POST",
            json!({"filter": {"type": "all"}}),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::LOCKED);
}

#[tokio::test]
async fn admitted_holdings_does_not_block_a_connect_transition() {
    use tower::ServiceExt;
    let (_directory, root, state, grant, _app) = connect_test_app().await;
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    // Pause inside the admitted holdings route, before the real handler runs.
    let app = crate::api::holdings::router()
        .route_layer(axum::middleware::from_fn({
            let entered = entered.clone();
            let release = release.clone();
            move |request: Request<Body>, next: Next| {
                let entered = entered.clone();
                let release = release.clone();
                async move {
                    entered.notify_one();
                    release.notified().await;
                    next.run(request).await
                }
            }
        }))
        .layer(axum::middleware::from_fn_with_state(root, admit))
        .layer(Extension(BackupSession("browser".into())));
    let request = tokio::spawn(app.oneshot(profile_request(
        &grant,
        "/holdings/list/query",
        "POST",
        json!({"filter": {"type": "all"}}),
    )));
    entered.notified().await;
    let transition = state
        .connect_transition
        .clone()
        .try_write_owned()
        .expect("An admitted holdings request must not hold the Connect guard");
    release.notify_one();
    assert_eq!(request.await.unwrap().unwrap().status(), StatusCode::OK);
    drop(transition);
}

#[cfg(any(feature = "connect-sync", feature = "device-sync"))]
#[tokio::test]
async fn waiting_web_login_rechecks_revoked_profile_before_changing_credentials() {
    use tower::ServiceExt;
    let (_directory, root, state, grant, _app) = connect_test_app().await;
    // Inspect the handler's own rejection: outer response revocation must not
    // hide a missing pre-mutation check after the wait.
    let app = crate::api::connect::router()
        .layer(Extension(crate::profiles::ProfileAccess {
            owner: "browser".into(),
            session: grant.clone(),
        }))
        .layer(Extension(root.clone()))
        .layer(Extension(state.clone()));
    let request = state.connect_transition.clone().read_owned().await;
    let mut login = Box::pin(app.oneshot(profile_request(
        &grant,
        "/connect/session",
        "POST",
        json!({"refreshToken": "candidate", "confirmRebind": true}),
    )));
    assert!(futures::poll!(login.as_mut()).is_pending());
    root.registry.sessions.revoke("browser").unwrap();
    drop(request);
    let response = login.await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let body = axum::body::to_bytes(response.into_body(), 4096)
        .await
        .unwrap();
    assert!(String::from_utf8_lossy(&body).contains("PROFILE_LOCKED"));
    assert!(state
        .secret_store
        .get_secret(wealthfolio_core::secrets::CLOUD_REFRESH_TOKEN_KEY)
        .unwrap()
        .is_none());
}
