use std::sync::Arc;

use crate::{
    auth,
    config::Config,
    main_lib::AppState,
    models::{Account, AccountUpdate, NewAccount},
    oidc,
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
use tower_governor::{governor::GovernorConfigBuilder, GovernorLayer};
use tower_http::{
    cors::{Any, CorsLayer},
    request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer},
    timeout::TimeoutLayer,
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

const SERVER_CSP: &str = "default-src 'self'; script-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https://wealthfolio.app https://auth.wealthfolio.app https://connect.wealthfolio.app https://connect-staging.wealthfolio.app; frame-src 'self' blob: about:; child-src 'self' blob: about:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; worker-src 'self' blob:";
const ADDON_SANDBOX_CSP: &str = "default-src 'none'; script-src 'self' 'unsafe-inline' blob:; style-src 'self' 'unsafe-inline'; img-src data: blob:; font-src 'self' data: blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

pub async fn security_headers(request: Request<Body>, next: Next) -> Response {
    let path = request.uri().path().to_string();
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    let csp = if path.ends_with("/addon-sandbox.html") {
        ADDON_SANDBOX_CSP
    } else {
        SERVER_CSP
    };
    headers.insert(
        HeaderName::from_static("content-security-policy"),
        HeaderValue::from_static(csp),
    );
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

#[allow(deprecated)]
pub fn app_router(state: Arc<AppState>, config: &Config) -> Router {
    let cors = if config.cors_allow.iter().any(|o| o == "*") {
        CorsLayer::new().allow_origin(Any)
    } else {
        let origins = config
            .cors_allow
            .iter()
            .map(|o| o.parse().unwrap())
            .collect::<Vec<_>>();
        CorsLayer::new()
            .allow_origin(origins)
            .allow_credentials(true)
    };

    let openapi = ApiDoc::openapi();
    let requires_auth = state.auth.is_some();

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
        protected_api = protected_api.merge(connect::router());
    }

    let protected_api = protected_api.route(
        "/openapi.json",
        get({
            let openapi = openapi.clone();
            move || async { Json(openapi) }
        }),
    );

    let protected_api = if requires_auth {
        protected_api.layer(middleware::from_fn_with_state(
            state.clone(),
            auth::require_jwt,
        ))
    } else {
        protected_api
    };

    // Rate limit login: 5 requests per 60 seconds per peer IP
    let login_governor = GovernorConfigBuilder::default()
        .per_second(12) // replenish 1 token every 12s → 5 per 60s
        .burst_size(5)
        .finish()
        .expect("valid governor config");

    // Rate limit the OIDC start + callback the same way (per peer IP).
    let oidc_login_governor = GovernorConfigBuilder::default()
        .per_second(12)
        .burst_size(5)
        .finish()
        .expect("valid governor config");
    let oidc_governor = GovernorConfigBuilder::default()
        .per_second(12)
        .burst_size(5)
        .finish()
        .expect("valid governor config");

    let api = Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .route("/auth/status", get(auth::auth_status))
        .route(
            "/auth/login",
            axum::routing::post(auth::login).layer(GovernorLayer::new(login_governor)),
        )
        .route("/auth/logout", axum::routing::post(auth::logout))
        .route("/auth/me", get(auth::auth_me))
        .route(
            "/auth/oidc/login",
            get(oidc::oidc_login).layer(GovernorLayer::new(oidc_login_governor)),
        )
        .route("/auth/oidc/logout", get(oidc::oidc_logout))
        .route(
            "/auth/oidc/callback",
            get(oidc::oidc_callback).layer(GovernorLayer::new(oidc_governor)),
        )
        .merge(protected_api)
        .with_state(state.clone());

    // Timeout wraps only the /api/v1 subtree: /mcp serves long-lived SSE
    // streams that a request timeout would sever.
    let mut router = Router::new()
        .nest("/api/v1", api)
        .with_state(state.clone())
        .layer(TimeoutLayer::new(config.request_timeout));

    if config.mcp_enabled {
        router = router.merge(crate::mcp::router(state, config));
    }

    router
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
        )
}
