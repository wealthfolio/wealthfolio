//! Wealthfolio Connect API endpoints for broker synchronization.
//!
//! This module provides REST endpoints for syncing broker accounts and activities
//! from the Wealthfolio Connect cloud service.

use std::future::Future;
use std::sync::Arc;

use axum::{
    extract::{Query, State},
    routing::{delete, get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use tracing::{debug, error, info};

#[cfg(feature = "device-sync")]
use super::device_sync_engine;
use crate::error::{ApiError, ApiResult};
use crate::events::{
    EventBus, ServerEvent, BROKER_SYNC_COMPLETE, BROKER_SYNC_ERROR, BROKER_SYNC_START,
};
use crate::main_lib::AppState;
use axum::http::StatusCode;
use wealthfolio_connect::prepare_post_login_broker_bootstrap;
use wealthfolio_connect::{
    acquire_broker_sync_guard,
    broker::{
        BrokerApiClient, PlansResponse, SyncAccountsResponse, SyncActivitiesResponse,
        SyncConnectionsResponse, UserInfo,
    },
    ensure_valid_access_token, fetch_subscription_plans_public, BrokerSyncRunGuard,
    ConnectApiClient, PostLoginBootstrapReason, PostLoginBootstrapResult,
    PostLoginBootstrapSyncResult, PostLoginBrokerBootstrapDecision, SyncConfig, SyncOrchestrator,
    SyncProgressPayload, SyncProgressReporter, SyncResult, TokenLifecycleConfig,
    TokenLifecycleError, CLOUD_ACCESS_TOKEN_KEY, CLOUD_REFRESH_TOKEN_KEY,
};
#[cfg(feature = "device-sync")]
use wealthfolio_device_sync::{EnableSyncResult, SyncState, SyncStateResult};

#[cfg(feature = "device-sync")]
const DEVICE_ID_KEY: &str = "sync_device_id";

#[cfg(feature = "device-sync")]
enum PostLoginDeviceBootstrapDecision {
    StartBackground,
    Skip(PostLoginBootstrapReason),
}

#[cfg(feature = "device-sync")]
async fn prepare_post_login_device_bootstrap<
    CheckBackgroundRunning,
    CheckBackgroundRunningFuture,
    LoadSyncState,
    LoadSyncStateFuture,
>(
    can_run_background: bool,
    check_background_running: CheckBackgroundRunning,
    load_sync_state: LoadSyncState,
) -> PostLoginDeviceBootstrapDecision
where
    CheckBackgroundRunning: FnOnce() -> CheckBackgroundRunningFuture,
    CheckBackgroundRunningFuture: Future<Output = bool>,
    LoadSyncState: FnOnce() -> LoadSyncStateFuture,
    LoadSyncStateFuture: Future<Output = Result<SyncState, String>>,
{
    if !can_run_background {
        return PostLoginDeviceBootstrapDecision::Skip(PostLoginBootstrapReason::NotEnrolled);
    }

    if check_background_running().await {
        return PostLoginDeviceBootstrapDecision::Skip(PostLoginBootstrapReason::AlreadyRunning);
    }

    let sync_state = match load_sync_state().await {
        Ok(sync_state) => sync_state,
        Err(err) => {
            debug!("[Connect] Post-login device sync skipped: {}", err);
            return PostLoginDeviceBootstrapDecision::Skip(PostLoginBootstrapReason::Error);
        }
    };

    if sync_state != SyncState::Ready {
        return PostLoginDeviceBootstrapDecision::Skip(PostLoginBootstrapReason::NotReady);
    }

    PostLoginDeviceBootstrapDecision::StartBackground
}

fn try_acquire_broker_sync_guard(state: &AppState) -> Option<BrokerSyncRunGuard> {
    acquire_broker_sync_guard(&state.broker_sync_running)
}

fn ensure_cloud_sync_enabled() -> ApiResult<()> {
    if crate::features::cloud_sync_enabled() {
        Ok(())
    } else {
        Err(ApiError::NotImplemented(
            "Cloud sync features are disabled in this build.".to_string(),
        ))
    }
}

fn ensure_connect_sync_enabled() -> ApiResult<()> {
    if crate::features::connect_sync_enabled() {
        Ok(())
    } else {
        Err(ApiError::NotImplemented(
            "Connect sync feature is disabled in this build.".to_string(),
        ))
    }
}

#[cfg(feature = "device-sync")]
fn ensure_device_sync_enabled() -> ApiResult<()> {
    if crate::features::device_sync_enabled() {
        Ok(())
    } else {
        Err(ApiError::NotImplemented(
            "Device sync feature is disabled in this build.".to_string(),
        ))
    }
}

fn cloud_api_base_url() -> ApiResult<String> {
    ensure_cloud_sync_enabled()?;
    crate::features::cloud_api_base_url().ok_or_else(|| {
        ApiError::NotImplemented("Cloud sync features are disabled in this build.".to_string())
    })
}

fn connect_auth_url() -> Option<String> {
    std::env::var("CONNECT_AUTH_URL")
        .ok()
        .map(|v| v.trim().trim_end_matches('/').to_string())
        .filter(|v| !v.is_empty())
        .or_else(|| option_env!("CONNECT_AUTH_URL").map(|v| v.trim_end_matches('/').to_string()))
        .or_else(|| Some("https://auth.wealthfolio.app".to_string()))
}

fn connect_auth_api_key() -> Option<String> {
    std::env::var("CONNECT_AUTH_PUBLISHABLE_KEY")
        .ok()
        .or_else(|| option_env!("CONNECT_AUTH_PUBLISHABLE_KEY").map(String::from))
        .or_else(|| Some("sb_publishable_ZSZbXNtWtnh9i2nqJ2UL4A_NV8ZVutd".to_string()))
}

fn token_lifecycle_config() -> Option<TokenLifecycleConfig> {
    let auth_url = connect_auth_url()?;
    let api_key = connect_auth_api_key()?;
    Some(TokenLifecycleConfig::new(auth_url, api_key))
}

/// Create a ConnectApiClient with a fresh access token
async fn create_connect_client(state: &AppState) -> ApiResult<ConnectApiClient> {
    ensure_cloud_sync_enabled()?;
    let token = mint_access_token(state).await?;
    let base_url = cloud_api_base_url()?;
    ConnectApiClient::new(&base_url, &token).map_err(|e| ApiError::Internal(e.to_string()))
}

// ─────────────────────────────────────────────────────────────────────────────
// Request/Response Types
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreSyncSessionRequest {
    pub refresh_token: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSessionStatus {
    pub is_configured: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreSyncSessionResponse {
    pub access_token: String,
    pub refresh_token: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg(feature = "device-sync")]
struct DeviceSyncEngineStatusResponse {
    cursor: i64,
    last_push_at: Option<String>,
    last_pull_at: Option<String>,
    last_error: Option<String>,
    consecutive_failures: i32,
    next_retry_at: Option<String>,
    last_cycle_status: Option<String>,
    last_cycle_duration_ms: Option<i64>,
    background_running: bool,
    bootstrap_required: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg(feature = "device-sync")]
struct DeviceSyncPairingSourceStatusResponse {
    status: String,
    message: String,
    local_cursor: i64,
    server_cursor: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg(feature = "device-sync")]
struct DeviceSyncBootstrapOverwriteCheckTableResponse {
    table: String,
    rows: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg(feature = "device-sync")]
struct DeviceSyncBootstrapOverwriteCheckResponse {
    bootstrap_required: bool,
    has_local_data: bool,
    local_rows: i64,
    non_empty_tables: Vec<DeviceSyncBootstrapOverwriteCheckTableResponse>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg(feature = "device-sync")]
struct DeviceSyncBootstrapResponse {
    status: String,
    message: String,
    snapshot_id: Option<String>,
    cursor: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg(feature = "device-sync")]
struct DeviceSyncCycleResponse {
    status: String,
    lock_version: i64,
    pushed_count: usize,
    pulled_count: usize,
    cursor: i64,
    needs_bootstrap: bool,
    bootstrap_snapshot_id: Option<String>,
    bootstrap_snapshot_seq: Option<i64>,
    dead_letter_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg(feature = "device-sync")]
struct DeviceSyncBackgroundResponse {
    status: String,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg(feature = "device-sync")]
struct DeviceSyncReconcileReadyResponse {
    status: String,
    message: String,
    bootstrap_action: String,
    bootstrap_status: String,
    bootstrap_message: Option<String>,
    bootstrap_snapshot_id: Option<String>,
    cycle_status: Option<String>,
    cycle_needs_bootstrap: bool,
    retry_attempted: bool,
    retry_cycle_status: Option<String>,
    background_status: String,
}

#[cfg(feature = "device-sync")]
fn to_device_sync_reconcile_ready_response(
    result: device_sync_engine::SyncReconcileReadyStateResult,
) -> DeviceSyncReconcileReadyResponse {
    DeviceSyncReconcileReadyResponse {
        status: result.status,
        message: result.message,
        bootstrap_action: result.bootstrap_action,
        bootstrap_status: result.bootstrap_status,
        bootstrap_message: result.bootstrap_message,
        bootstrap_snapshot_id: result.bootstrap_snapshot_id,
        cycle_status: result.cycle_status,
        cycle_needs_bootstrap: result.cycle_needs_bootstrap,
        retry_attempted: result.retry_attempted,
        retry_cycle_status: result.retry_cycle_status,
        background_status: result.background_status,
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg(feature = "device-sync")]
struct DeviceSyncReconcileReadyRequest {
    #[serde(default)]
    allow_overwrite: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg(feature = "device-sync")]
struct DeviceSyncSnapshotUploadResponse {
    status: String,
    snapshot_id: Option<String>,
    oplog_seq: Option<i64>,
    message: String,
}

// ─────────────────────────────────────────────────────────────────────────────
// EventBus Progress Reporter
// ─────────────────────────────────────────────────────────────────────────────

/// Progress reporter that publishes events to the EventBus for SSE delivery.
struct EventBusProgressReporter {
    event_bus: EventBus,
}

impl EventBusProgressReporter {
    fn new(event_bus: EventBus) -> Self {
        Self { event_bus }
    }
}

impl SyncProgressReporter for EventBusProgressReporter {
    fn report_progress(&self, payload: SyncProgressPayload) {
        self.event_bus.publish(ServerEvent::with_payload(
            "sync-progress",
            serde_json::to_value(&payload).unwrap_or_default(),
        ));
    }

    fn report_sync_start(&self) {
        self.event_bus.publish(ServerEvent::new(BROKER_SYNC_START));
    }

    fn report_sync_complete(&self, result: &SyncResult) {
        if result.success {
            self.event_bus.publish(ServerEvent::with_payload(
                BROKER_SYNC_COMPLETE,
                serde_json::to_value(result).unwrap_or_default(),
            ));
        } else {
            self.event_bus.publish(ServerEvent::with_payload(
                BROKER_SYNC_ERROR,
                serde_json::json!({ "error": result.message }),
            ));
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Session Management
// ─────────────────────────────────────────────────────────────────────────────

async fn store_sync_session(
    State(state): State<Arc<AppState>>,
    Json(body): Json<StoreSyncSessionRequest>,
) -> ApiResult<Json<()>> {
    ensure_cloud_sync_enabled()?;
    state
        .secret_store
        .set_secret(CLOUD_REFRESH_TOKEN_KEY, &body.refresh_token)
        .map_err(|e| ApiError::Internal(format!("Failed to store refresh token: {}", e)))?;
    // Best-effort cleanup for legacy versions that stored access tokens at rest.
    let _ = state.secret_store.delete_secret(CLOUD_ACCESS_TOKEN_KEY);
    state.token_lifecycle.clear_cache().await;

    Ok(Json(()))
}

async fn post_login_bootstrap(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<PostLoginBootstrapResult>> {
    let broker_sync = run_post_login_broker_bootstrap(Arc::clone(&state)).await;
    let device_sync = run_post_login_device_bootstrap(state).await;

    Ok(Json(PostLoginBootstrapResult {
        broker_sync,
        device_sync,
    }))
}

async fn run_post_login_broker_bootstrap(state: Arc<AppState>) -> PostLoginBootstrapSyncResult {
    let entitlement_state = Arc::clone(&state);
    let connections_state = Arc::clone(&state);
    let guard_state = Arc::clone(&state);

    let decision = prepare_post_login_broker_bootstrap(
        crate::features::connect_sync_enabled(),
        move || async move { has_broker_sync(&entitlement_state).await },
        move || async move {
            let client = create_connect_client(&connections_state)
                .await
                .map_err(|e| e.to_string())?;
            client.list_connections().await.map_err(|e| e.to_string())
        },
        move || try_acquire_broker_sync_guard(&guard_state),
    )
    .await;

    let guard = match decision {
        PostLoginBrokerBootstrapDecision::Start(guard) => guard,
        PostLoginBrokerBootstrapDecision::Skip(reason) => {
            return PostLoginBootstrapSyncResult::skipped(reason);
        }
    };

    tokio::spawn(async move {
        match perform_broker_sync_with_guard(&state, guard).await {
            Ok(_result) => {
                info!("[Connect] Post-login broker sync completed successfully");
            }
            Err(err) => {
                error!("[Connect] Post-login broker sync failed: {}", err);
            }
        }
    });

    PostLoginBootstrapSyncResult::started()
}

#[cfg(feature = "device-sync")]
async fn run_post_login_device_bootstrap(state: Arc<AppState>) -> PostLoginBootstrapSyncResult {
    let Some(identity) = device_sync_engine::get_sync_identity_from_store(&state) else {
        return PostLoginBootstrapSyncResult::skipped(PostLoginBootstrapReason::NotEnrolled);
    };

    let background_state = Arc::clone(&state);
    let sync_state_state = Arc::clone(&state);
    let decision = prepare_post_login_device_bootstrap(
        device_sync_engine::sync_identity_can_run_background(&identity),
        move || async move {
            background_state
                .device_sync_runtime
                .is_background_running()
                .await
        },
        move || async move {
            let token = mint_access_token(&sync_state_state)
                .await
                .map_err(|err| format!("failed to mint token ({})", err))?;
            sync_state_state
                .device_enroll_service
                .get_sync_state(&token)
                .await
                .map(|sync_state| sync_state.state)
                .map_err(|err| format!("failed to get sync state ({})", err.message))
        },
    )
    .await;

    match decision {
        PostLoginDeviceBootstrapDecision::StartBackground => {}
        PostLoginDeviceBootstrapDecision::Skip(reason) => {
            return PostLoginBootstrapSyncResult::skipped(reason);
        }
    }

    match device_sync_engine::ensure_background_engine_started(Arc::clone(&state)).await {
        Ok(()) => PostLoginBootstrapSyncResult::started(),
        Err(err) => {
            debug!(
                "[Connect] Post-login device sync background start failed: {}",
                err
            );
            PostLoginBootstrapSyncResult::skipped(PostLoginBootstrapReason::Error)
        }
    }
}

#[cfg(not(feature = "device-sync"))]
async fn run_post_login_device_bootstrap(_state: Arc<AppState>) -> PostLoginBootstrapSyncResult {
    PostLoginBootstrapSyncResult::skipped(PostLoginBootstrapReason::FeatureDisabled)
}

async fn clear_sync_session(State(state): State<Arc<AppState>>) -> ApiResult<Json<()>> {
    ensure_cloud_sync_enabled()?;
    info!("[Connect] Clearing sync session");

    let _ = state.secret_store.delete_secret(CLOUD_REFRESH_TOKEN_KEY);
    let _ = state.secret_store.delete_secret(CLOUD_ACCESS_TOKEN_KEY);

    state.token_lifecycle.clear_cache().await;
    #[cfg(feature = "device-sync")]
    device_sync_engine::clear_min_snapshot_created_at_from_store();
    let _ = state
        .app_sync_repository
        .clear_all_min_snapshot_created_at()
        .await;

    info!("[Connect] Sync session cleared");
    Ok(Json(()))
}

async fn get_sync_session_status(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<SyncSessionStatus>> {
    ensure_cloud_sync_enabled()?;
    let is_configured = state
        .secret_store
        .get_secret(CLOUD_REFRESH_TOKEN_KEY)
        .map(|t| t.is_some())
        .unwrap_or(false);

    Ok(Json(SyncSessionStatus { is_configured }))
}

async fn restore_sync_session(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<RestoreSyncSessionResponse>> {
    ensure_cloud_sync_enabled()?;
    let access_token = mint_access_token(&state).await?;
    let refresh_token = state
        .secret_store
        .get_secret(CLOUD_REFRESH_TOKEN_KEY)
        .map_err(|e| ApiError::Internal(format!("Failed to read refresh token: {}", e)))?
        .ok_or_else(|| ApiError::Forbidden("No sync session configured".to_string()))?;

    Ok(Json(RestoreSyncSessionResponse {
        access_token,
        refresh_token,
    }))
}

// ─────────────────────────────────────────────────────────────────────────────
// Token Management
// ─────────────────────────────────────────────────────────────────────────────

pub(crate) async fn mint_access_token(state: &AppState) -> ApiResult<String> {
    ensure_cloud_sync_enabled()?;
    let config = token_lifecycle_config();
    ensure_valid_access_token(
        state.secret_store.as_ref(),
        state.token_lifecycle.as_ref(),
        config.as_ref(),
    )
    .await
    .map_err(map_token_lifecycle_error)
}

fn map_token_lifecycle_error(err: TokenLifecycleError) -> ApiError {
    match err {
        TokenLifecycleError::Unauthorized(message) => ApiError::Forbidden(message),
        TokenLifecycleError::NotConfigured(message)
        | TokenLifecycleError::RefreshFailed(message)
        | TokenLifecycleError::Internal(message) => ApiError::Internal(message),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sync Operations
// ─────────────────────────────────────────────────────────────────────────────

async fn sync_broker_connections(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<SyncConnectionsResponse>> {
    ensure_connect_sync_enabled()?;
    info!("[Connect] Syncing broker connections...");

    let client = create_connect_client(&state).await?;

    // Fetch connections from cloud using the shared client
    let connections = client
        .list_connections()
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    info!(
        "[Connect] Fetched {} connections from cloud",
        connections.len()
    );

    // Sync to local database
    let result = state
        .connect_sync_service
        .sync_connections(connections)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    info!(
        "[Connect] Synced connections: {} platforms created, {} updated",
        result.platforms_created, result.platforms_updated
    );

    Ok(Json(result))
}

async fn sync_broker_accounts(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<SyncAccountsResponse>> {
    ensure_connect_sync_enabled()?;
    info!("[Connect] Syncing broker accounts...");

    let client = create_connect_client(&state).await?;

    // Fetch accounts from cloud using the shared client
    let accounts = client
        .list_accounts(None)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    info!("[Connect] Fetched {} accounts from cloud", accounts.len());

    // Sync to local database
    let result = state
        .connect_sync_service
        .sync_accounts(accounts)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    info!(
        "[Connect] Synced accounts: {} created, {} updated, {} skipped",
        result.created, result.updated, result.skipped
    );

    Ok(Json(result))
}

async fn sync_broker_activities(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<SyncActivitiesResponse>> {
    ensure_connect_sync_enabled()?;
    info!("[Connect] Running activities-only broker sync");
    let result = perform_broker_activities_only_sync(&state)
        .await
        .map_err(ApiError::Internal)?;

    Ok(Json(result))
}

// ─────────────────────────────────────────────────────────────────────────────
// Unified Sync Operation (non-blocking with SSE notifications)
// ─────────────────────────────────────────────────────────────────────────────

/// Trigger a full broker data sync (connections → accounts → activities).
/// Returns immediately with 202 Accepted. Sync runs in background and emits SSE events.
async fn sync_broker_data(State(state): State<Arc<AppState>>) -> StatusCode {
    if let Err(err) = ensure_connect_sync_enabled() {
        error!("[Connect] Broker sync skipped: {}", err);
        return StatusCode::NOT_IMPLEMENTED;
    }

    // Check plan entitlement before starting sync
    match has_broker_sync(&state).await {
        Ok(true) => {}
        Ok(false) => {
            info!("[Connect] Broker sync skipped: plan does not include broker sync");
            return StatusCode::FORBIDDEN;
        }
        Err(e) => {
            error!(
                "[Connect] Broker sync skipped: could not verify entitlement ({})",
                e
            );
            return StatusCode::FORBIDDEN;
        }
    }

    let Some(guard) = try_acquire_broker_sync_guard(&state) else {
        info!("[Connect] Broker sync skipped: sync already running");
        return StatusCode::CONFLICT;
    };

    info!("[Connect] Starting broker data sync (non-blocking)...");

    // Spawn background task to perform the sync
    tokio::spawn(async move {
        match perform_broker_sync_with_guard(&state, guard).await {
            Ok(_result) => {
                info!("[Connect] Broker sync completed successfully");
                // Events are emitted by the orchestrator via EventBusProgressReporter
            }
            Err(err) => {
                error!("[Connect] Broker sync failed: {}", err);
                // Error event is also emitted by the orchestrator
            }
        }
    });

    StatusCode::ACCEPTED
}

/// Check if the current user's plan includes broker sync.
/// Used by the scheduler to skip sync for basic-plan users.
pub async fn has_broker_sync(state: &AppState) -> Result<bool, String> {
    ensure_connect_sync_enabled().map_err(|e| e.to_string())?;
    let client = create_connect_client(state)
        .await
        .map_err(|e| e.to_string())?;
    client.has_broker_sync().await.map_err(|e| e.to_string())
}

/// Core broker sync logic - syncs connections, accounts, and activities from cloud to local DB.
/// Uses the centralized SyncOrchestrator for full pagination support.
/// Also used by the background scheduler for periodic syncs.
pub async fn perform_broker_sync(state: &AppState) -> Result<SyncResult, String> {
    let guard = try_acquire_broker_sync_guard(state)
        .ok_or_else(|| "Broker sync already running".to_string())?;
    perform_broker_sync_with_guard(state, guard).await
}

async fn perform_broker_sync_with_guard(
    state: &AppState,
    _guard: BrokerSyncRunGuard,
) -> Result<SyncResult, String> {
    ensure_connect_sync_enabled().map_err(|e| e.to_string())?;
    // Create API client
    let client = match create_connect_client(state).await {
        Ok(client) => client,
        Err(err) => {
            let message = err.to_string();
            state.event_bus.publish(ServerEvent::with_payload(
                BROKER_SYNC_ERROR,
                serde_json::json!({ "error": message }),
            ));
            return Err(message);
        }
    };

    // Create progress reporter and orchestrator
    let reporter = Arc::new(EventBusProgressReporter::new(state.event_bus.clone()));
    let orchestrator = SyncOrchestrator::new(
        state.connect_sync_service.clone(),
        reporter,
        SyncConfig::default(),
    );

    // Run the sync via the centralized orchestrator
    // Note: Asset enrichment is handled automatically via domain events (AssetsCreated)
    orchestrator.sync_all(&client).await
}

/// Sync only brokerage activities for existing TRANSACTIONS accounts.
/// This preserves legacy /connect/sync/activities behavior (no connections/accounts/holdings sync).
async fn perform_broker_activities_only_sync(
    state: &AppState,
) -> Result<SyncActivitiesResponse, String> {
    ensure_connect_sync_enabled().map_err(|e| e.to_string())?;
    let client = create_connect_client(state)
        .await
        .map_err(|e| e.to_string())?;
    let reporter = Arc::new(EventBusProgressReporter::new(state.event_bus.clone()));
    let orchestrator = SyncOrchestrator::new(
        state.connect_sync_service.clone(),
        reporter,
        SyncConfig::default(),
    );

    orchestrator.sync_activities_only(&client).await
}

async fn get_subscription_plans(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<PlansResponse>> {
    ensure_cloud_sync_enabled()?;
    info!("[Connect] Getting subscription plans...");

    let client = create_connect_client(&state).await?;

    let plans = client
        .get_subscription_plans()
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    Ok(Json(plans))
}

async fn get_subscription_plans_public() -> ApiResult<Json<PlansResponse>> {
    ensure_cloud_sync_enabled()?;
    info!("[Connect] Getting subscription plans (public)...");

    let base_url = cloud_api_base_url()?;

    let plans = fetch_subscription_plans_public(&base_url)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    Ok(Json(plans))
}

async fn get_user_info(State(state): State<Arc<AppState>>) -> ApiResult<Json<UserInfo>> {
    ensure_cloud_sync_enabled()?;

    let client = create_connect_client(&state).await?;

    let user_info = client
        .get_user_info()
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    Ok(Json(user_info))
}

// ─────────────────────────────────────────────────────────────────────────────
// List Operations (fetch from cloud without syncing to local)
// ─────────────────────────────────────────────────────────────────────────────

async fn list_broker_connections(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<Vec<wealthfolio_connect::broker::BrokerConnection>>> {
    ensure_connect_sync_enabled()?;
    info!("[Connect] Listing broker connections from cloud...");

    let client = create_connect_client(&state).await?;

    let connections = client
        .list_connections()
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    info!("[Connect] Found {} broker connections", connections.len());
    Ok(Json(connections))
}

async fn list_broker_accounts(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<Vec<wealthfolio_connect::broker::BrokerAccount>>> {
    ensure_connect_sync_enabled()?;
    info!("[Connect] Listing broker accounts from cloud...");

    let client = create_connect_client(&state).await?;

    let accounts = client
        .list_accounts(None)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    info!("[Connect] Found {} broker accounts", accounts.len());
    Ok(Json(accounts))
}

// ─────────────────────────────────────────────────────────────────────────────
// Local Data Queries (from local database, not cloud)
// ─────────────────────────────────────────────────────────────────────────────

/// Request params for get_import_runs
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetImportRunsQuery {
    pub run_type: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

/// Get all synced accounts (accounts with provider_account_id set)
async fn get_synced_accounts(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<Vec<wealthfolio_core::accounts::Account>>> {
    if !crate::features::connect_sync_enabled() {
        return Ok(Json(vec![]));
    }

    info!("[Connect] Getting synced accounts from local database...");

    let accounts = state
        .connect_sync_service
        .get_synced_accounts()
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    info!("[Connect] Found {} synced accounts", accounts.len());
    Ok(Json(accounts))
}

/// Get all platforms from local database
async fn get_platforms(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<Vec<wealthfolio_connect::Platform>>> {
    if !crate::features::connect_sync_enabled() {
        return Ok(Json(vec![]));
    }

    info!("[Connect] Getting platforms from local database...");

    let platforms = state
        .connect_sync_service
        .get_platforms()
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    info!("[Connect] Found {} platforms", platforms.len());
    Ok(Json(platforms))
}

/// Get all broker sync states from local database
async fn get_broker_sync_states(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<Vec<wealthfolio_connect::BrokerSyncState>>> {
    if !crate::features::connect_sync_enabled() {
        return Ok(Json(vec![]));
    }

    debug!("[Connect] Getting broker sync states from local database...");

    let states = state
        .connect_sync_service
        .get_all_sync_states()
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    Ok(Json(states))
}

/// Get import runs with optional type filter and pagination
async fn get_import_runs(
    State(state): State<Arc<AppState>>,
    Query(query): Query<GetImportRunsQuery>,
) -> ApiResult<Json<Vec<wealthfolio_connect::ImportRun>>> {
    if !crate::features::connect_sync_enabled() {
        return Ok(Json(vec![]));
    }

    let limit = query.limit.unwrap_or(50);
    let offset = query.offset.unwrap_or(0);
    debug!(
        "[Connect] Getting import runs (type={:?}, limit={}, offset={})...",
        query.run_type, limit, offset
    );

    let runs = state
        .connect_sync_service
        .get_import_runs(query.run_type.as_deref(), limit, offset)
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    Ok(Json(runs))
}

// ─────────────────────────────────────────────────────────────────────────────
// Broker Sync Profile Operations
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrokerSyncProfileQuery {
    account_id: String,
    source_system: String,
}

async fn get_broker_sync_profile(
    State(state): State<Arc<AppState>>,
    Query(q): Query<BrokerSyncProfileQuery>,
) -> ApiResult<Json<wealthfolio_core::activities::BrokerSyncProfileData>> {
    Ok(Json(
        state
            .activity_service
            .get_broker_sync_profile(q.account_id, q.source_system)?,
    ))
}

async fn save_broker_sync_profile_rules(
    State(state): State<Arc<AppState>>,
    Json(request): Json<wealthfolio_core::activities::SaveBrokerSyncProfileRulesRequest>,
) -> ApiResult<Json<wealthfolio_core::activities::BrokerSyncProfileData>> {
    Ok(Json(
        state
            .activity_service
            .save_broker_sync_profile_rules(request)
            .await?,
    ))
}

// ─────────────────────────────────────────────────────────────────────────────
// Device Enroll Operations
// ─────────────────────────────────────────────────────────────────────────────

/// Get the current device sync state (FRESH, REGISTERED, READY, STALE, RECOVERY, ORPHANED)
#[cfg(feature = "device-sync")]
async fn get_device_sync_state(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<SyncStateResult>> {
    ensure_device_sync_enabled()?;
    info!("[Connect] Getting device sync state...");
    let token = mint_access_token(&state).await?;

    let result = state
        .device_enroll_service
        .get_sync_state(&token)
        .await
        .map_err(|e| ApiError::Internal(e.message))?;

    Ok(Json(result))
}

/// Enable device sync - enrolls the device and initializes E2EE if first device
#[cfg(feature = "device-sync")]
async fn enable_device_sync(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<EnableSyncResult>> {
    ensure_device_sync_enabled()?;
    info!("[Connect] Enabling device sync...");
    let token = mint_access_token(&state).await?;

    let result = state
        .device_enroll_service
        .enable_sync(&token)
        .await
        .map_err(|e| ApiError::Internal(e.message))?;

    // Backward compatibility: keep legacy device-id key in sync.
    state
        .secret_store
        .set_secret(DEVICE_ID_KEY, &result.device_id)
        .map_err(|e| ApiError::Internal(format!("Failed to store device ID: {}", e)))?;
    device_sync_engine::clear_min_snapshot_created_at_from_store();
    let _ = state
        .app_sync_repository
        .clear_all_min_snapshot_created_at()
        .await;

    if result.state == SyncState::Ready {
        // Clear stale outbox/metadata from any previous sync session before
        // the bg engine starts pushing events.
        let _ = state
            .app_sync_repository
            .reset_and_mark_bootstrap_complete(result.device_id.clone(), result.key_version)
            .await;

        let _ = device_sync_engine::ensure_background_engine_started(Arc::clone(&state)).await;
    }

    info!("[Connect] Device sync enabled successfully");
    Ok(Json(result))
}

/// Clear all device sync data and return to FRESH state
#[cfg(feature = "device-sync")]
async fn clear_device_sync_data(State(state): State<Arc<AppState>>) -> ApiResult<Json<()>> {
    ensure_device_sync_enabled()?;
    info!("[Connect] Clearing device sync data...");

    state
        .device_enroll_service
        .clear_sync_data()
        .map_err(|e| ApiError::Internal(e.message))?;
    let _ = state.app_sync_repository.reset_local_sync_session().await;
    state
        .secret_store
        .delete_secret(DEVICE_ID_KEY)
        .map_err(|e| ApiError::Internal(format!("Failed to clear device ID: {}", e)))?;
    device_sync_engine::clear_min_snapshot_created_at_from_store();
    let _ = state
        .app_sync_repository
        .clear_all_min_snapshot_created_at()
        .await;
    let _ = device_sync_engine::ensure_background_engine_stopped(Arc::clone(&state)).await;

    info!("[Connect] Device sync data cleared");
    Ok(Json(()))
}

/// Reinitialize device sync - resets server data and enables sync in one operation
#[cfg(feature = "device-sync")]
async fn reinitialize_device_sync(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<EnableSyncResult>> {
    ensure_device_sync_enabled()?;
    info!("[Connect] Reinitializing device sync...");
    let token = mint_access_token(&state).await?;

    let result = state
        .device_enroll_service
        .reinitialize_sync(&token)
        .await
        .map_err(|e| ApiError::Internal(e.message))?;

    // Backward compatibility: keep legacy device-id key in sync.
    state
        .secret_store
        .set_secret(DEVICE_ID_KEY, &result.device_id)
        .map_err(|e| ApiError::Internal(format!("Failed to store device ID: {}", e)))?;
    device_sync_engine::clear_min_snapshot_created_at_from_store();
    let _ = state
        .app_sync_repository
        .clear_all_min_snapshot_created_at()
        .await;

    if result.state == SyncState::Ready {
        let _ = state
            .app_sync_repository
            .reset_and_mark_bootstrap_complete(result.device_id.clone(), result.key_version)
            .await;

        let _ = device_sync_engine::ensure_background_engine_started(Arc::clone(&state)).await;
    }

    info!("[Connect] Device sync reinitialized successfully");
    Ok(Json(result))
}

#[cfg(feature = "device-sync")]
async fn get_device_sync_engine_status(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<DeviceSyncEngineStatusResponse>> {
    ensure_device_sync_enabled()?;
    let status = device_sync_engine::get_engine_status(&state)
        .await
        .map_err(ApiError::Internal)?;
    Ok(Json(DeviceSyncEngineStatusResponse {
        cursor: status.cursor,
        last_push_at: status.last_push_at,
        last_pull_at: status.last_pull_at,
        last_error: status.last_error,
        consecutive_failures: status.consecutive_failures,
        next_retry_at: status.next_retry_at,
        last_cycle_status: status.last_cycle_status,
        last_cycle_duration_ms: status.last_cycle_duration_ms,
        background_running: status.background_running,
        bootstrap_required: status.bootstrap_required,
    }))
}

#[cfg(feature = "device-sync")]
async fn get_device_sync_pairing_source_status(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<DeviceSyncPairingSourceStatusResponse>> {
    ensure_device_sync_enabled()?;
    let status = device_sync_engine::get_pairing_source_status(&state)
        .await
        .map_err(ApiError::Internal)?;
    Ok(Json(DeviceSyncPairingSourceStatusResponse {
        status: status.status,
        message: status.message,
        local_cursor: status.local_cursor,
        server_cursor: status.server_cursor,
    }))
}

#[cfg(feature = "device-sync")]
async fn get_device_sync_bootstrap_overwrite_check(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<DeviceSyncBootstrapOverwriteCheckResponse>> {
    ensure_device_sync_enabled()?;
    let result = device_sync_engine::get_bootstrap_overwrite_check(&state)
        .await
        .map_err(ApiError::Internal)?;

    Ok(Json(DeviceSyncBootstrapOverwriteCheckResponse {
        bootstrap_required: result.bootstrap_required,
        has_local_data: result.has_local_data,
        local_rows: result.local_rows,
        non_empty_tables: result
            .non_empty_tables
            .into_iter()
            .map(|table| DeviceSyncBootstrapOverwriteCheckTableResponse {
                table: table.table,
                rows: table.rows,
            })
            .collect(),
    }))
}

#[cfg(feature = "device-sync")]
async fn bootstrap_device_snapshot(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<DeviceSyncBootstrapResponse>> {
    ensure_device_sync_enabled()?;
    let result = device_sync_engine::sync_bootstrap_snapshot_if_needed(Arc::clone(&state))
        .await
        .map_err(ApiError::Internal)?;

    // Start the background sync engine whenever this device is READY.
    let should_start_engine = if let Ok(token) = mint_access_token(&state).await {
        state
            .device_enroll_service
            .get_sync_state(&token)
            .await
            .map(|sync_state| sync_state.state == SyncState::Ready)
            .unwrap_or(false)
    } else {
        false
    };
    if should_start_engine {
        let _ = device_sync_engine::ensure_background_engine_started(Arc::clone(&state)).await;
    }

    Ok(Json(DeviceSyncBootstrapResponse {
        status: result.status,
        message: result.message,
        snapshot_id: result.snapshot_id,
        cursor: result.cursor,
    }))
}

#[cfg(feature = "device-sync")]
async fn trigger_device_sync_cycle(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<DeviceSyncCycleResponse>> {
    ensure_device_sync_enabled()?;
    let result = device_sync_engine::run_sync_cycle(state, false)
        .await
        .map_err(ApiError::Internal)?;
    Ok(Json(DeviceSyncCycleResponse {
        status: result.status,
        lock_version: result.lock_version,
        pushed_count: result.pushed_count,
        pulled_count: result.pulled_count,
        cursor: result.cursor,
        needs_bootstrap: result.needs_bootstrap,
        bootstrap_snapshot_id: result.bootstrap_snapshot_id,
        bootstrap_snapshot_seq: result.bootstrap_snapshot_seq,
        dead_letter_count: result.dead_letter_count,
    }))
}

#[cfg(feature = "device-sync")]
async fn start_device_sync_background_engine(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<DeviceSyncBackgroundResponse>> {
    ensure_device_sync_enabled()?;
    device_sync_engine::ensure_background_engine_started(Arc::clone(&state))
        .await
        .map_err(ApiError::Internal)?;
    let background_running = state.device_sync_runtime.is_background_running().await;
    Ok(Json(DeviceSyncBackgroundResponse {
        status: if background_running {
            "started".to_string()
        } else {
            "skipped".to_string()
        },
        message: if background_running {
            "Device sync background engine started".to_string()
        } else {
            "Background engine not started because sync identity is not configured".to_string()
        },
    }))
}

#[cfg(feature = "device-sync")]
async fn reconcile_device_sync_ready_state(
    State(state): State<Arc<AppState>>,
    Json(body): Json<DeviceSyncReconcileReadyRequest>,
) -> ApiResult<Json<DeviceSyncReconcileReadyResponse>> {
    ensure_device_sync_enabled()?;
    let result = device_sync_engine::reconcile_ready_state(state, body.allow_overwrite)
        .await
        .map_err(ApiError::Internal)?;
    Ok(Json(to_device_sync_reconcile_ready_response(result)))
}

#[cfg(feature = "device-sync")]
async fn stop_device_sync_background_engine(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<DeviceSyncBackgroundResponse>> {
    ensure_device_sync_enabled()?;
    device_sync_engine::ensure_background_engine_stopped(state)
        .await
        .map_err(ApiError::Internal)?;
    Ok(Json(DeviceSyncBackgroundResponse {
        status: "stopped".to_string(),
        message: "Device sync background engine stopped".to_string(),
    }))
}

#[cfg(feature = "device-sync")]
async fn generate_device_snapshot_now(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<DeviceSyncSnapshotUploadResponse>> {
    ensure_device_sync_enabled()?;
    let result = device_sync_engine::generate_snapshot_now(state)
        .await
        .map_err(ApiError::Internal)?;
    Ok(Json(DeviceSyncSnapshotUploadResponse {
        status: result.status,
        snapshot_id: result.snapshot_id,
        oplog_seq: result.oplog_seq,
        message: result.message,
    }))
}

#[cfg(feature = "device-sync")]
async fn cancel_device_snapshot_upload(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<DeviceSyncBackgroundResponse>> {
    ensure_device_sync_enabled()?;
    device_sync_engine::cancel_snapshot_upload(state).await;
    Ok(Json(DeviceSyncBackgroundResponse {
        status: "cancel_requested".to_string(),
        message: "Snapshot upload cancellation requested".to_string(),
    }))
}

// ─────────────────────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────────────────────

pub fn router() -> Router<Arc<AppState>> {
    let router = Router::new()
        // Session management
        .route("/connect/session", post(store_sync_session))
        .route("/connect/post-login-bootstrap", post(post_login_bootstrap))
        .route("/connect/session", delete(clear_sync_session))
        .route("/connect/session/status", get(get_sync_session_status))
        .route("/connect/session/restore", get(restore_sync_session))
        // List operations (fetch from cloud without syncing)
        .route("/connect/connections", get(list_broker_connections))
        .route("/connect/accounts", get(list_broker_accounts))
        // Unified sync (non-blocking, emits SSE events)
        .route("/connect/sync", post(sync_broker_data))
        // Individual sync operations (kept for backwards compatibility)
        .route("/connect/sync/connections", post(sync_broker_connections))
        .route("/connect/sync/accounts", post(sync_broker_accounts))
        .route("/connect/sync/activities", post(sync_broker_activities))
        // Local data queries (from local database)
        .route("/connect/synced-accounts", get(get_synced_accounts))
        .route("/connect/platforms", get(get_platforms))
        .route("/connect/sync-states", get(get_broker_sync_states))
        .route("/connect/import-runs", get(get_import_runs))
        // Broker sync profile
        .route(
            "/connect/broker-sync-profile",
            get(get_broker_sync_profile).post(save_broker_sync_profile_rules),
        )
        // User & Subscription
        .route("/connect/plans", get(get_subscription_plans))
        .route("/connect/plans/public", get(get_subscription_plans_public))
        .route("/connect/user", get(get_user_info));

    #[cfg(feature = "device-sync")]
    let router = router
        .route("/connect/device/sync-state", get(get_device_sync_state))
        .route("/connect/device/enable", post(enable_device_sync))
        .route("/connect/device/sync-data", delete(clear_device_sync_data))
        .route(
            "/connect/device/reinitialize",
            post(reinitialize_device_sync),
        )
        .route(
            "/connect/device/engine-status",
            get(get_device_sync_engine_status),
        )
        .route(
            "/connect/device/pairing-source-status",
            get(get_device_sync_pairing_source_status),
        )
        .route(
            "/connect/device/bootstrap-overwrite-check",
            get(get_device_sync_bootstrap_overwrite_check),
        )
        .route(
            "/connect/device/reconcile-ready-state",
            post(reconcile_device_sync_ready_state),
        )
        .route(
            "/connect/device/bootstrap-snapshot",
            post(bootstrap_device_snapshot),
        )
        .route(
            "/connect/device/trigger-cycle",
            post(trigger_device_sync_cycle),
        )
        .route(
            "/connect/device/start-background",
            post(start_device_sync_background_engine),
        )
        .route(
            "/connect/device/stop-background",
            post(stop_device_sync_background_engine),
        )
        .route(
            "/connect/device/generate-snapshot",
            post(generate_device_snapshot_now),
        )
        .route(
            "/connect/device/cancel-snapshot",
            post(cancel_device_snapshot_upload),
        );

    router
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    fn broker_connection(
        status: Option<&str>,
        disabled: bool,
    ) -> wealthfolio_connect::broker::BrokerConnection {
        wealthfolio_connect::broker::BrokerConnection {
            id: "connection-1".to_string(),
            brokerage: None,
            connection_type: None,
            status: status.map(str::to_string),
            disabled,
            disabled_date: None,
            updated_at: None,
            name: None,
        }
    }

    #[tokio::test]
    async fn broker_preflight_feature_disabled_skips_without_checks() {
        let entitlement_calls = Arc::new(AtomicUsize::new(0));
        let list_calls = Arc::new(AtomicUsize::new(0));

        let decision = prepare_post_login_broker_bootstrap(
            false,
            {
                let entitlement_calls = Arc::clone(&entitlement_calls);
                move || async move {
                    entitlement_calls.fetch_add(1, Ordering::SeqCst);
                    Ok(true)
                }
            },
            {
                let list_calls = Arc::clone(&list_calls);
                move || async move {
                    list_calls.fetch_add(1, Ordering::SeqCst);
                    Ok(vec![broker_connection(Some("connected"), false)])
                }
            },
            || Some(()),
        )
        .await;

        assert!(matches!(
            decision,
            PostLoginBrokerBootstrapDecision::Skip(PostLoginBootstrapReason::FeatureDisabled)
        ));
        assert_eq!(entitlement_calls.load(Ordering::SeqCst), 0);
        assert_eq!(list_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn broker_preflight_no_entitlement_skips_without_listing_connections() {
        let list_calls = Arc::new(AtomicUsize::new(0));

        let decision = prepare_post_login_broker_bootstrap(
            true,
            || async { Ok(false) },
            {
                let list_calls = Arc::clone(&list_calls);
                move || async move {
                    list_calls.fetch_add(1, Ordering::SeqCst);
                    Ok(vec![broker_connection(Some("connected"), false)])
                }
            },
            || Some(()),
        )
        .await;

        assert!(matches!(
            decision,
            PostLoginBrokerBootstrapDecision::Skip(PostLoginBootstrapReason::NotEntitled)
        ));
        assert_eq!(list_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn broker_preflight_zero_connections_skips_without_starting() {
        let start_calls = Arc::new(AtomicUsize::new(0));

        let decision = prepare_post_login_broker_bootstrap(
            true,
            || async { Ok(true) },
            || async { Ok(vec![]) },
            {
                let start_calls = Arc::clone(&start_calls);
                move || {
                    start_calls.fetch_add(1, Ordering::SeqCst);
                    Some(())
                }
            },
        )
        .await;

        assert!(matches!(
            decision,
            PostLoginBrokerBootstrapDecision::Skip(PostLoginBootstrapReason::NoConnections)
        ));
        assert_eq!(start_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn broker_preflight_requires_active_usable_connection() {
        let decision = prepare_post_login_broker_bootstrap(
            true,
            || async { Ok(true) },
            || async {
                Ok(vec![
                    broker_connection(Some("disconnected"), false),
                    broker_connection(Some("connected"), true),
                    broker_connection(None, false),
                ])
            },
            || Some(()),
        )
        .await;

        assert!(matches!(
            decision,
            PostLoginBrokerBootstrapDecision::Skip(PostLoginBootstrapReason::NoConnections)
        ));
    }

    #[tokio::test]
    async fn broker_preflight_active_connection_starts() {
        let decision = prepare_post_login_broker_bootstrap(
            true,
            || async { Ok(true) },
            || async { Ok(vec![broker_connection(Some("connected"), false)]) },
            || Some("guard"),
        )
        .await;

        assert!(matches!(
            decision,
            PostLoginBrokerBootstrapDecision::Start("guard")
        ));
    }

    #[tokio::test]
    async fn broker_preflight_already_running_skips() {
        let decision = prepare_post_login_broker_bootstrap(
            true,
            || async { Ok(true) },
            || async { Ok(vec![broker_connection(Some("connected"), false)]) },
            || None::<()>,
        )
        .await;

        assert!(matches!(
            decision,
            PostLoginBrokerBootstrapDecision::Skip(PostLoginBootstrapReason::AlreadyRunning)
        ));
    }

    #[cfg(feature = "device-sync")]
    #[tokio::test]
    async fn device_preflight_not_enrolled_skips_without_remote_state() {
        let remote_calls = Arc::new(AtomicUsize::new(0));

        let decision = prepare_post_login_device_bootstrap(false, || async { false }, {
            let remote_calls = Arc::clone(&remote_calls);
            move || async move {
                remote_calls.fetch_add(1, Ordering::SeqCst);
                Ok(SyncState::Ready)
            }
        })
        .await;

        assert!(matches!(
            decision,
            PostLoginDeviceBootstrapDecision::Skip(PostLoginBootstrapReason::NotEnrolled)
        ));
        assert_eq!(remote_calls.load(Ordering::SeqCst), 0);
    }

    #[cfg(feature = "device-sync")]
    #[tokio::test]
    async fn device_preflight_already_running_skips_without_remote_state() {
        let remote_calls = Arc::new(AtomicUsize::new(0));

        let decision = prepare_post_login_device_bootstrap(true, || async { true }, {
            let remote_calls = Arc::clone(&remote_calls);
            move || async move {
                remote_calls.fetch_add(1, Ordering::SeqCst);
                Ok(SyncState::Ready)
            }
        })
        .await;

        assert!(matches!(
            decision,
            PostLoginDeviceBootstrapDecision::Skip(PostLoginBootstrapReason::AlreadyRunning)
        ));
        assert_eq!(remote_calls.load(Ordering::SeqCst), 0);
    }

    #[cfg(feature = "device-sync")]
    #[tokio::test]
    async fn device_preflight_not_ready_skips() {
        let decision = prepare_post_login_device_bootstrap(
            true,
            || async { false },
            || async { Ok(SyncState::Registered) },
        )
        .await;

        assert!(matches!(
            decision,
            PostLoginDeviceBootstrapDecision::Skip(PostLoginBootstrapReason::NotReady)
        ));
    }

    #[cfg(feature = "device-sync")]
    #[tokio::test]
    async fn device_preflight_ready_starts_background() {
        let decision = prepare_post_login_device_bootstrap(
            true,
            || async { false },
            || async { Ok(SyncState::Ready) },
        )
        .await;

        assert!(matches!(
            decision,
            PostLoginDeviceBootstrapDecision::StartBackground
        ));
    }

    #[cfg(feature = "device-sync")]
    #[test]
    fn connect_router_includes_device_engine_routes() {
        let _router = router();
    }

    #[cfg(feature = "device-sync")]
    #[test]
    fn reconcile_response_mapping_preserves_fields() {
        let source = device_sync_engine::SyncReconcileReadyStateResult {
            status: "ok".to_string(),
            message: "done".to_string(),
            bootstrap_action: "NO_BOOTSTRAP".to_string(),
            bootstrap_status: "applied".to_string(),
            bootstrap_message: Some("bootstrap ok".to_string()),
            bootstrap_snapshot_id: Some("snap-1".to_string()),
            cycle_status: Some("ok".to_string()),
            cycle_needs_bootstrap: false,
            retry_attempted: true,
            retry_cycle_status: Some("ok".to_string()),
            background_status: "started".to_string(),
        };

        let mapped = to_device_sync_reconcile_ready_response(source.clone());
        assert_eq!(mapped.status, source.status);
        assert_eq!(mapped.message, source.message);
        assert_eq!(mapped.bootstrap_action, source.bootstrap_action);
        assert_eq!(mapped.bootstrap_status, source.bootstrap_status);
        assert_eq!(mapped.bootstrap_message, source.bootstrap_message);
        assert_eq!(mapped.bootstrap_snapshot_id, source.bootstrap_snapshot_id);
        assert_eq!(mapped.cycle_status, source.cycle_status);
        assert_eq!(mapped.cycle_needs_bootstrap, source.cycle_needs_bootstrap);
        assert_eq!(mapped.retry_attempted, source.retry_attempted);
        assert_eq!(mapped.retry_cycle_status, source.retry_cycle_status);
        assert_eq!(mapped.background_status, source.background_status);
    }
}
