use std::sync::Arc;

use crate::{
    auth,
    config::Config,
    main_lib::AppState,
    models::{Account, AccountUpdate, NewAccount},
};
use axum::middleware;
use axum::{
    body::Body,
    http::{
        header::{HeaderName, HeaderValue},
        Request,
    },
    middleware::Next,
    response::Response,
    routing::get,
    Json, Router,
};
use tower_http::{
    cors::{Any, CorsLayer},
    request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer},
    trace::{DefaultOnRequest, DefaultOnResponse, TraceLayer},
};
use tracing::Level;
use utoipa::OpenApi;

mod accounts;
mod activities;
mod addon_network;
mod addons;
mod agent_access;
mod ai_chat;
mod ai_providers;
mod allocation_targets;
mod alternative_assets;
mod assets;
#[cfg(any(feature = "connect-sync", feature = "device-sync"))]
pub(crate) mod cloud_backups;
#[cfg(any(feature = "connect-sync", feature = "device-sync"))]
pub mod connect;
mod custom_providers;
mod data_exports;
mod database_backups;
#[cfg(feature = "device-sync")]
mod device_sync;
#[cfg(feature = "device-sync")]
pub(crate) mod device_sync_engine;
mod exchange_rates;
mod goals;
mod health;
mod holdings;
mod limits;
mod market_data;
mod net_worth;
mod performance;
pub(crate) mod portable_backups;
mod portfolio;
mod portfolios;
mod secrets;
mod settings;
pub mod shared;
mod spending;
#[cfg(feature = "device-sync")]
mod sync_crypto;
mod taxonomies;

#[utoipa::path(get, path = "/api/v1/healthz", responses((status = 200, description = "Health")))]
pub async fn healthz() -> &'static str {
    "ok"
}

#[utoipa::path(get, path = "/api/v1/readyz", responses((status = 200, description = "Ready")))]
pub async fn readyz() -> &'static str {
    "ok"
}

#[derive(OpenApi)]
#[openapi(
    paths(healthz, readyz, accounts::list_accounts, accounts::create_account, accounts::update_account, accounts::delete_account),
    components(schemas(Account, NewAccount, AccountUpdate)),
    tags((name="wealthfolio"))
)]
pub struct ApiDoc;

// Keep the addon bootstrap hash as well as the application's inline theme script.
const SERVER_CSP: &str = "default-src 'self'; script-src 'self' 'sha256-OUUXM+aKkYdqwM38Z84FhgHpIYOk/e5Dz9UaAnwYXk8=' 'sha256-s/UhdlprnzFxx+iXOtDj2n/Jk+MSRz1g/1lyBtFatVw=' 'wasm-unsafe-eval' blob:; style-src 'self' 'unsafe-inline' blob:; img-src 'self' data: blob: https:; font-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self' https://wealthfolio.app https://auth.wealthfolio.app https://connect.wealthfolio.app https://connect-staging.wealthfolio.app; frame-src 'none'; child-src 'self' blob: about:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; worker-src 'self' blob:";
const ADDON_SANDBOX_CSP: &str = "default-src 'none'; script-src 'sha256-s/UhdlprnzFxx+iXOtDj2n/Jk+MSRz1g/1lyBtFatVw=' 'wasm-unsafe-eval' blob:; style-src 'unsafe-inline' blob:; img-src data: blob:; font-src data: blob:; media-src data: blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

// Match the configured Connect issuer without granting access to arbitrary HTTPS hosts.
fn application_csp(auth_url: Option<&str>) -> HeaderValue {
    let Some(origin) = auth_url
        .and_then(|value| reqwest::Url::parse(value).ok())
        .filter(|url| {
            url.scheme() == "https"
                && url.host_str().is_some_and(|host| {
                    host.bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b".-:[]".contains(&byte))
                })
                && url.username().is_empty()
                && url.password().is_none()
        })
        .map(|url| url.origin().ascii_serialization())
    else {
        return HeaderValue::from_static(SERVER_CSP);
    };
    let policy = SERVER_CSP.replacen(
        "connect-src 'self'",
        &format!("connect-src 'self' {origin}"),
        1,
    );
    HeaderValue::from_str(&policy).unwrap_or_else(|_| HeaderValue::from_static(SERVER_CSP))
}

pub async fn security_headers(request: Request<Body>, next: Next) -> Response {
    let path = request.uri().path().to_string();
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    #[cfg(any(feature = "connect-sync", feature = "device-sync"))]
    let auth_url = connect::connect_auth_url();
    #[cfg(not(any(feature = "connect-sync", feature = "device-sync")))]
    let auth_url: Option<String> = None;
    let csp = if path.ends_with("/addon-sandbox.html") {
        HeaderValue::from_static(ADDON_SANDBOX_CSP)
    } else {
        application_csp(auth_url.as_deref())
    };
    headers.insert(HeaderName::from_static("content-security-policy"), csp);
    if !path.starts_with("/api/") && !path.starts_with("/mcp") {
        headers.insert(
            HeaderName::from_static("access-control-allow-origin"),
            HeaderValue::from_static("*"),
        );
    }
    headers.insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        HeaderName::from_static("referrer-policy"),
        HeaderValue::from_static("no-referrer"),
    );
    response
}

pub(crate) fn cors_layer(config: &Config) -> anyhow::Result<CorsLayer> {
    if config.cors_allow.iter().any(|o| o == "*") {
        Ok(CorsLayer::new().allow_origin(Any))
    } else {
        let origins = config
            .cors_allow
            .iter()
            .map(|origin| origin.parse::<HeaderValue>())
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| anyhow::anyhow!("Invalid header value in WF_CORS_ALLOW_ORIGINS"))?;
        Ok(CorsLayer::new()
            .allow_origin(origins)
            .allow_credentials(true))
    }
}

#[allow(deprecated)]
pub fn app_router(state: Arc<AppState>, config: &Config) -> anyhow::Result<Router> {
    let profiles = crate::profiles::WebProfiles::new(state.clone(), config)?;
    app_router_with_profiles(
        profiles,
        auth::AuthState {
            auth: state.auth.clone(),
            oidc: state.oidc.clone(),
        },
        config,
    )
}

pub async fn app_router_from_config(config: &Config) -> anyhow::Result<Router> {
    let profiles = crate::profiles::WebProfiles::open(config).await?;
    let auth = profiles.auth_state();
    app_router_with_profiles(profiles, auth, config)
}

fn app_router_with_profiles(
    profiles: Arc<crate::profiles::WebProfiles>,
    auth_state: auth::AuthState,
    config: &Config,
) -> anyhow::Result<Router> {
    let cors = cors_layer(config)?;
    profiles.start_connected_profiles();

    let openapi = ApiDoc::openapi();

    // Compose all protected routes from individual modules
    #[allow(unused_mut)]
    let mut protected_api = Router::new()
        .merge(accounts::router())
        .merge(portfolios::router())
        .merge(settings::router())
        .merge(data_exports::router())
        .merge(database_backups::router())
        .merge(portfolio::router())
        .merge(holdings::router())
        .merge(performance::router())
        .merge(activities::router())
        .merge(goals::router())
        .merge(exchange_rates::router())
        .merge(market_data::router())
        .merge(assets::router())
        .merge(secrets::router())
        .merge(addon_network::router())
        .merge(limits::router())
        .merge(addons::router())
        .merge(taxonomies::router())
        .merge(net_worth::router())
        .merge(alternative_assets::router())
        .merge(ai_providers::router())
        .merge(ai_chat::router())
        .merge(health::router())
        .merge(custom_providers::router())
        .merge(spending::router())
        .merge(allocation_targets::router())
        .merge(agent_access::router());

    #[cfg(feature = "device-sync")]
    {
        protected_api = protected_api
            .merge(device_sync::router())
            .merge(sync_crypto::router());
    }

    #[cfg(any(feature = "connect-sync", feature = "device-sync"))]
    {
        protected_api = protected_api
            .merge(connect::router())
            .merge(cloud_backups::router());
    }

    let protected_api = protected_api.route(
        "/openapi.json",
        get({
            let openapi = openapi.clone();
            move || async { Json(openapi) }
        }),
    );

    let protected_api = protected_api
        .layer(middleware::from_fn_with_state(
            profiles.clone(),
            crate::profiles::admit,
        ))
        .merge(crate::profiles::router(profiles.clone()))
        .layer(middleware::from_fn_with_state(
            auth_state.auth.clone(),
            auth::require_backup_session,
        ));

    let api = Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .merge(auth::router(auth_state))
        .merge(protected_api)
        .with_state(());

    // Timeout wraps only the /api/v1 subtree: /mcp serves long-lived SSE
    // streams that a request timeout would sever.
    let mut router = Router::new()
        .nest("/api/v1", api)
        .layer(middleware::from_fn_with_state(
            profiles.clone(),
            crate::profiles::instance_logout,
        ))
        .with_state(())
        .layer(middleware::from_fn({
            let ordinary_timeout = config.request_timeout;
            move |request: axum::extract::Request, next: middleware::Next| async move {
                use axum::response::IntoResponse;
                let timeout = request_timeout(request.uri().path(), ordinary_timeout);
                tokio::time::timeout(timeout, next.run(request))
                    .await
                    .unwrap_or_else(|_| axum::http::StatusCode::REQUEST_TIMEOUT.into_response())
            }
        }));

    if config.mcp_enabled {
        router = router.route(
            "/mcp",
            axum::routing::any(crate::profiles::mcp).with_state(profiles),
        );
    }

    Ok(router
        .layer(cors)
        .layer(SetRequestIdLayer::x_request_id(MakeRequestUuid))
        .layer(PropagateRequestIdLayer::x_request_id())
        .layer(
            TraceLayer::new_for_http()
                .make_span_with(|request: &axum::http::Request<_>| {
                    tracing::info_span!(
                        "http_request",
                        method = %request.method(),
                        path = %request.uri().path(),
                    )
                })
                .on_request(DefaultOnRequest::new().level(Level::INFO))
                .on_response(DefaultOnResponse::new().level(Level::INFO)),
        ))
}

fn request_timeout(path: &str, ordinary: std::time::Duration) -> std::time::Duration {
    // Accept either the outer URI or Axum's prefix-stripped nested route URI.
    let path = path.strip_prefix("/api/v1").unwrap_or(path);
    if matches!(
        path,
        "/cloud-backups/capture"
            | "/connect/device/generate-snapshot"
            | "/sync/pairing/complete-with-transfer"
    ) || (path.starts_with("/cloud-backups/") && path.ends_with("/package"))
        || (path.starts_with("/utilities/database/backups/") && path.ends_with("/export"))
    {
        std::time::Duration::from_secs(
            wealthfolio_device_sync::limits::BACKUP_CAPTURE_TIMEOUT_SECONDS,
        )
    } else {
        ordinary
    }
}

#[cfg(test)]
mod request_timeout_tests {
    use super::*;
    #[test]
    fn transfer_routes_include_preparation_time_without_changing_ordinary_routes() {
        let ordinary = std::time::Duration::from_secs(300);
        let transfer = std::time::Duration::from_secs(
            wealthfolio_device_sync::limits::BACKUP_TRANSFER_TIMEOUT_SECONDS,
        );
        for path in [
            "/cloud-backups/capture",
            "/cloud-backups/id/package",
            "/connect/device/generate-snapshot",
            "/sync/pairing/complete-with-transfer",
        ] {
            assert!(request_timeout(path, ordinary) > transfer);
            assert_eq!(
                request_timeout(path, ordinary),
                request_timeout(&format!("/api/v1{path}"), ordinary)
            );
        }
        for path in [
            "/api/v1/accounts",
            "/api/v1/cloud-backups/action",
            "/api/v1/connect/device/status",
        ] {
            assert_eq!(request_timeout(path, ordinary), ordinary);
        }
    }
}

#[cfg(test)]
mod security_header_tests {
    use super::*;
    use axum::{routing::get, Router};
    use tower::ServiceExt;

    #[test]
    fn configured_auth_issuer_is_allowed_only_as_an_exact_connect_origin() {
        let csp = application_csp(Some("https://vvalcadcvxqwligwzxaw.supabase.co/auth/v1/"));
        let csp = csp.to_str().unwrap();
        let connect = csp
            .split(';')
            .find(|d| d.trim_start().starts_with("connect-src "))
            .unwrap();
        assert!(connect
            .split_whitespace()
            .any(|s| s == "https://vvalcadcvxqwligwzxaw.supabase.co"));
        assert!(!connect
            .split_whitespace()
            .any(|s| s == "https:" || s == "*"));
        assert!(!csp.contains("/auth/v1/"));
        assert!(csp.contains("frame-src 'none'"));
        assert!(csp.contains("object-src 'none'"));
        assert!(!csp
            .split(';')
            .find(|d| d.trim_start().starts_with("script-src "))
            .unwrap()
            .contains("supabase"));
    }

    #[test]
    fn invalid_auth_issuers_cannot_inject_or_expand_the_csp() {
        for value in [
            None,
            Some("invalid"),
            Some("https://user:password@example.com"),
            Some("http://example.com"),
            Some("javascript:alert(1)"),
            Some("https://example.com; script-src *"),
            Some("https://example.com;object-src"),
            Some("https://*.example.com"),
        ] {
            assert_eq!(application_csp(value), HeaderValue::from_static(SERVER_CSP));
        }
    }

    #[tokio::test]
    async fn application_csp_allows_inline_theme_initialization() {
        use base64::{engine::general_purpose::STANDARD, Engine};
        use sha2::{Digest, Sha256};

        let html = include_str!("../../frontend/index.html");
        let app = Router::new()
            .route("/", get(move || async move { html }))
            .layer(axum::middleware::from_fn(security_headers));
        let response = app
            .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let csp = response.headers()["content-security-policy"]
            .to_str()
            .unwrap()
            .to_owned();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let html = std::str::from_utf8(&body).unwrap();
        let script = html
            .split_once("<script>")
            .expect("theme initialization script")
            .1
            .split_once("</script>")
            .unwrap()
            .0;
        let hash = STANDARD.encode(Sha256::digest(script.as_bytes()));
        let script_src = csp
            .split(';')
            .find(|directive| directive.trim_start().starts_with("script-src "))
            .unwrap();
        assert!(script_src
            .split_whitespace()
            .any(|source| source == format!("'sha256-{hash}'")));
        assert!(!script_src.contains("'unsafe-inline'"));
    }

    #[tokio::test]
    async fn addon_sandbox_response_uses_network_free_csp() {
        let app = Router::new()
            .route("/addon-sandbox.html", get(|| async { "ok" }))
            .layer(axum::middleware::from_fn(security_headers));
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/addon-sandbox.html")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let csp = response
            .headers()
            .get("content-security-policy")
            .unwrap()
            .to_str()
            .unwrap();

        assert_eq!(csp, ADDON_SANDBOX_CSP);
        for forbidden in ["'self'", "http:", "https:", "tauri:", "asset:"] {
            assert!(
                !csp.contains(forbidden),
                "unexpected CSP source: {forbidden}"
            );
        }
    }

    #[tokio::test]
    async fn application_response_blocks_frame_navigation() {
        let app = Router::new()
            .route("/", get(|| async { "ok" }))
            .layer(axum::middleware::from_fn(security_headers));
        let response = app
            .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
            .await
            .unwrap();

        let csp = response
            .headers()
            .get("content-security-policy")
            .unwrap()
            .to_str()
            .unwrap();
        assert!(csp.contains("frame-src 'none'"));
        assert!(csp.contains("'sha256-s/UhdlprnzFxx+iXOtDj2n/Jk+MSRz1g/1lyBtFatVw='"));
        assert!(csp.contains("style-src 'self' 'unsafe-inline' blob:"));
        assert!(csp.contains("font-src 'self' data: blob:"));
        assert!(csp.contains("media-src 'self' data: blob:"));
    }
}

#[cfg(test)]
mod connect_admission_tests;
