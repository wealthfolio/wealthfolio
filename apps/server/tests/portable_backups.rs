use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use std::time::Duration;
use tower::ServiceExt;
use wealthfolio_connect::{CLOUD_ACCESS_TOKEN_KEY, CLOUD_REFRESH_TOKEN_KEY};
use wealthfolio_core::secrets::SYNC_IDENTITY_KEY;
use wealthfolio_server::{api::app_router, build_state, config::Config};
use wealthfolio_storage_sqlite::db;

async fn export(
    app: &Router,
    filename: &str,
    token: Option<&str>,
    origin: &str,
    marker: bool,
) -> axum::response::Response {
    let mut request = Request::builder()
        .method("POST")
        .uri(format!(
            "/api/v1/utilities/database/backups/{filename}/export"
        ))
        .header("host", "localhost")
        .header("origin", origin)
        .header("content-type", "application/json");
    if marker {
        request = request.header("x-wealthfolio-backup", "1");
    }
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    app.clone()
        .oneshot(
            request
                .body(Body::from(
                    r#"{"password":"portable test password","unencrypted":false}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap()
}

async fn download(app: &Router, id: &str, token: Option<&str>) -> axum::response::Response {
    let mut request = Request::builder().uri(format!("/api/v1/utilities/database/exports/{id}"));
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    app.clone()
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap()
}

async fn export_id(response: axum::response::Response) -> String {
    let status = response.status();
    let body = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
    serde_json::from_slice::<serde_json::Value>(&body).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string()
}

#[tokio::test]
async fn portable_exports_preserve_selected_data_and_bound_download_lifetimes() {
    std::env::set_var("WF_AUTH_REQUIRED", "false");
    std::env::set_var(
        "WF_SECRET_KEY",
        "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
    );
    for authenticated in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let mut config = Config::from_env().unwrap();
        config.db_path = root.path().join("app.db").to_string_lossy().into_owned();
        config.addons_root = root.path().to_string_lossy().into_owned();
        config.oidc = None;
        config.auth = if authenticated {
            Some(wealthfolio_server::auth::AuthConfig {
                password_hash: None,
                jwt_secret: vec![13; 32],
                access_token_ttl: Duration::from_secs(3600),
                cookie_secure: wealthfolio_server::auth::CookieSecurePolicy::Never,
            })
        } else {
            None
        };
        config.db_encryption_required = authenticated;
        // Password export reliably takes longer than this ordinary route limit.
        config.request_timeout = Duration::from_millis(100);
        let state = build_state(&config).await.unwrap();
        let token = state.auth.as_ref().map(|auth| auth.issue_token().unwrap());
        let other = state.auth.as_ref().map(|auth| auth.issue_token().unwrap());
        state.db_access.connect_rusqlite().unwrap().execute_batch(
            "INSERT INTO app_settings(setting_key,setting_value) VALUES('theme','dark') ON CONFLICT(setting_key) DO UPDATE SET setting_value='dark';"
        ).unwrap();
        let snapshot = db::snapshots::create(
            &state.db_access,
            &state.data_root,
            db::snapshots::SnapshotReason::Manual,
        )
        .unwrap();
        let filename = snapshot.file_name().unwrap().to_str().unwrap();
        state
            .db_access
            .connect_rusqlite()
            .unwrap()
            .execute_batch(
                "UPDATE app_settings SET setting_value='light' WHERE setting_key='theme'",
            )
            .unwrap();
        let app = app_router(state.clone(), &config).unwrap();
        for (method, path) in [
            ("GET", "/api/v1/utilities/database/maintenance"),
            ("POST", "/api/v1/utilities/database/maintenance/retry"),
            ("POST", "/api/v1/utilities/database/imports"),
            (
                "POST",
                "/api/v1/utilities/database/imports/00000000-0000-0000-0000-000000000000/restore",
            ),
            (
                "POST",
                "/api/v1/utilities/database/backups/example.db/inspect",
            ),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri(path)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{method} {path}");
        }

        assert_eq!(
            export(
                &app,
                filename,
                token.as_deref(),
                "http://evil.example",
                true
            )
            .await
            .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            export(&app, filename, token.as_deref(), "http://localhost", false)
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
        if authenticated {
            assert_eq!(
                export(&app, filename, None, "http://localhost", true)
                    .await
                    .status(),
                StatusCode::UNAUTHORIZED
            );
        }
        let id =
            export_id(export(&app, filename, token.as_deref(), "http://localhost", true).await)
                .await;
        if authenticated {
            assert_eq!(
                download(&app, &id, other.as_deref()).await.status(),
                StatusCode::NOT_FOUND
            );
        }
        let response = download(&app, &id, token.as_deref()).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["cache-control"], "no-store");
        let bytes = to_bytes(response.into_body(), 16 * 1024 * 1024)
            .await
            .unwrap();
        let live_theme: String = state
            .db_access
            .connect_rusqlite()
            .unwrap()
            .query_row(
                "SELECT setting_value FROM app_settings WHERE setting_key='theme'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(live_theme, "light", "export must not modify the source");
        let file = root.path().join("download.wfbackup");
        std::fs::write(&file, &bytes).unwrap();
        let prepared =
            db::portable::prepare_import(&file, root.path(), Some("portable test password"), None)
                .unwrap();
        let theme: String = prepared
            .access
            .connect_rusqlite()
            .unwrap()
            .query_row(
                "SELECT setting_value FROM app_settings WHERE setting_key='theme'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            theme, "dark",
            "must export selected snapshot, not live database"
        );
        assert_eq!(
            download(&app, &id, token.as_deref()).await.status(),
            StatusCode::NOT_FOUND
        );

        let first =
            export_id(export(&app, filename, token.as_deref(), "http://localhost", true).await)
                .await;
        let _second =
            export_id(export(&app, filename, token.as_deref(), "http://localhost", true).await)
                .await;
        let held = download(&app, &first, token.as_deref()).await;
        assert_eq!(held.status(), StatusCode::OK);
        assert_eq!(
            export(&app, filename, token.as_deref(), "http://localhost", true)
                .await
                .status(),
            StatusCode::BAD_REQUEST,
            "a paused download must still count against staging quota"
        );
        drop(held);
        export_id(export(&app, filename, token.as_deref(), "http://localhost", true).await).await;

        // A restored database must neither reveal nor reuse retained credentials.
        state.db_access.connect_rusqlite().unwrap().execute_batch(
            "INSERT INTO app_settings(setting_key,setting_value) VALUES('restore_reconnect_required','true') ON CONFLICT(setting_key) DO UPDATE SET setting_value='true';"
        ).unwrap();
        for key in [
            CLOUD_ACCESS_TOKEN_KEY,
            CLOUD_REFRESH_TOKEN_KEY,
            SYNC_IDENTITY_KEY,
        ] {
            state
                .secret_store
                .set_secret(key, "old synthetic identity")
                .unwrap();
        }
        for (path, expected) in [
            ("status", StatusCode::OK),
            ("restore", StatusCode::FORBIDDEN),
        ] {
            let mut request = Request::builder().uri(format!("/api/v1/connect/session/{path}"));
            if let Some(token) = &token {
                request = request.header("authorization", format!("Bearer {token}"));
            }
            let response = app
                .clone()
                .oneshot(request.body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), expected);
            if path == "status" {
                let body = to_bytes(response.into_body(), 1024).await.unwrap();
                let status: serde_json::Value = serde_json::from_slice(&body).unwrap();
                assert_eq!(status["isConfigured"], false);
            }
        }
        let mut request = Request::builder()
            .method("POST")
            .uri("/api/v1/connect/session")
            .header("content-type", "application/json");
        if let Some(token) = &token {
            request = request.header("authorization", format!("Bearer {token}"));
        }
        let response = app
            .clone()
            .oneshot(
                request
                    .body(Body::from(r#"{"refreshToken":"new synthetic login"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(state
            .secret_store
            .get_secret(SYNC_IDENTITY_KEY)
            .unwrap()
            .is_none());
        assert!(state
            .secret_store
            .get_secret(CLOUD_ACCESS_TOKEN_KEY)
            .unwrap()
            .is_none());
        assert_eq!(
            state
                .secret_store
                .get_secret(CLOUD_REFRESH_TOKEN_KEY)
                .unwrap()
                .as_deref(),
            Some("new synthetic login")
        );
        let gate: String = state.db_access.connect_rusqlite().unwrap().query_row(
            "SELECT setting_value FROM app_settings WHERE setting_key='restore_reconnect_required'", [], |r| r.get(0)).unwrap();
        assert_eq!(gate, "false");
    }
}
