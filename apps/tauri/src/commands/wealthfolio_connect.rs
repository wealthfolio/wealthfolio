#[cfg(feature = "connect-sync")]
use crate::commands::brokers_sync::{
    perform_broker_sync_with_guard, try_acquire_broker_sync_guard,
};
#[cfg(feature = "device-sync")]
use crate::commands::device_sync::{
    clear_min_snapshot_created_at_from_store, ensure_background_engine_started,
    get_sync_identity_from_store, sync_identity_can_run_background,
};
use crate::context::ServiceContext;
use crate::secret_store::KeyringSecretStore;
use log::{debug, error};
use serde::Serialize;
use std::future::Future;
use std::sync::Arc;
use tauri::{AppHandle, State};
#[cfg(feature = "connect-sync")]
use wealthfolio_connect::{
    prepare_post_login_broker_bootstrap, BrokerApiClient, PostLoginBrokerBootstrapDecision,
};
use wealthfolio_connect::{
    PostLoginBootstrapReason, PostLoginBootstrapResult, PostLoginBootstrapSyncResult,
};
use wealthfolio_core::secrets::SecretStore;
#[cfg(feature = "device-sync")]
use wealthfolio_device_sync::SyncState;

// Storage keys (without prefix - the SecretStore adds "wealthfolio_" prefix)
const SYNC_ACCESS_TOKEN_KEY: &str = "sync_access_token";
const SYNC_REFRESH_TOKEN_KEY: &str = "sync_refresh_token";

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

#[tauri::command]
pub async fn store_sync_session(
    refresh_token: Option<String>,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<(), String> {
    match refresh_token.as_deref().map(str::trim) {
        Some(token) if !token.is_empty() => {
            if let Err(e) = KeyringSecretStore.set_secret(SYNC_REFRESH_TOKEN_KEY, token) {
                error!("Failed to store refresh token in keyring: {}", e);
                return Err(format!("Failed to store refresh token: {}", e));
            }
            // Best-effort cleanup for legacy versions that stored access tokens at rest.
            let _ = KeyringSecretStore.delete_secret(SYNC_ACCESS_TOKEN_KEY);
            debug!("Refresh token stored successfully");
        }
        _ => {
            if let Err(e) = KeyringSecretStore.delete_secret(SYNC_REFRESH_TOKEN_KEY) {
                error!("Failed to delete refresh token from keyring: {}", e);
                // Don't fail the whole operation if we can't delete
            }
        }
    }

    state.connect_service().clear_cached_token().await;
    Ok(())
}

#[tauri::command]
pub async fn post_login_bootstrap(
    app: AppHandle,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<PostLoginBootstrapResult, String> {
    let context = state.inner().clone();
    let broker_sync = run_post_login_broker_bootstrap(app, Arc::clone(&context)).await;
    let device_sync = run_post_login_device_bootstrap(context).await;

    Ok(PostLoginBootstrapResult {
        broker_sync,
        device_sync,
    })
}

#[cfg(feature = "connect-sync")]
async fn run_post_login_broker_bootstrap(
    app: AppHandle,
    context: Arc<ServiceContext>,
) -> PostLoginBootstrapSyncResult {
    let entitlement_context = Arc::clone(&context);
    let connections_context = Arc::clone(&context);
    let guard_context = Arc::clone(&context);

    let decision = prepare_post_login_broker_bootstrap(
        true,
        move || async move {
            entitlement_context
                .connect_service()
                .has_broker_sync()
                .await
        },
        move || async move {
            let client = connections_context
                .connect_service()
                .get_api_client()
                .await?;
            client.list_connections().await.map_err(|e| e.to_string())
        },
        move || try_acquire_broker_sync_guard(guard_context.as_ref()),
    )
    .await;

    let guard = match decision {
        PostLoginBrokerBootstrapDecision::Start(guard) => guard,
        PostLoginBrokerBootstrapDecision::Skip(reason) => {
            return PostLoginBootstrapSyncResult::skipped(reason);
        }
    };

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        match perform_broker_sync_with_guard(&context, Some(&app_handle), guard).await {
            Ok(_result) => {
                debug!("[Connect] Post-login broker sync completed successfully");
            }
            Err(err) => {
                error!("[Connect] Post-login broker sync failed: {}", err);
            }
        }
    });

    PostLoginBootstrapSyncResult::started()
}

#[cfg(not(feature = "connect-sync"))]
async fn run_post_login_broker_bootstrap(
    _app: AppHandle,
    _context: Arc<ServiceContext>,
) -> PostLoginBootstrapSyncResult {
    PostLoginBootstrapSyncResult::skipped(PostLoginBootstrapReason::FeatureDisabled)
}

#[cfg(feature = "device-sync")]
async fn run_post_login_device_bootstrap(
    context: Arc<ServiceContext>,
) -> PostLoginBootstrapSyncResult {
    let Some(identity) = get_sync_identity_from_store() else {
        return PostLoginBootstrapSyncResult::skipped(PostLoginBootstrapReason::NotEnrolled);
    };

    let background_context = Arc::clone(&context);
    let sync_state_context = Arc::clone(&context);
    let decision = prepare_post_login_device_bootstrap(
        sync_identity_can_run_background(&identity),
        move || async move {
            background_context
                .device_sync_runtime()
                .is_background_running()
                .await
        },
        move || async move {
            let token = sync_state_context
                .connect_service()
                .get_valid_access_token()
                .await
                .map_err(|err| format!("failed to mint token ({})", err))?;
            sync_state_context
                .device_enroll_service()
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

    match ensure_background_engine_started(Arc::clone(&context)).await {
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
async fn run_post_login_device_bootstrap(
    _context: Arc<ServiceContext>,
) -> PostLoginBootstrapSyncResult {
    PostLoginBootstrapSyncResult::skipped(PostLoginBootstrapReason::FeatureDisabled)
}

#[tauri::command]
pub async fn clear_sync_session(state: State<'_, Arc<ServiceContext>>) -> Result<(), String> {
    // Best-effort cleanup for legacy installs that persisted the access token.
    let _ = KeyringSecretStore.delete_secret(SYNC_ACCESS_TOKEN_KEY);
    let refresh_result = KeyringSecretStore.delete_secret(SYNC_REFRESH_TOKEN_KEY);

    // Report refresh-token errors but don't fail on legacy access-token cleanup.
    let mut errors = Vec::new();
    if let Err(e) = refresh_result {
        error!("Failed to delete refresh token from keyring: {}", e);
        errors.push(format!("refresh_token: {}", e));
    }

    state.connect_service().clear_cached_token().await;
    #[cfg(feature = "device-sync")]
    clear_min_snapshot_created_at_from_store();
    let _ = state
        .app_sync_repository()
        .clear_all_min_snapshot_created_at()
        .await;

    if errors.is_empty() {
        debug!("Sync session cleared from keyring");
        Ok(())
    } else {
        Err(format!(
            "Failed to clear some tokens: {}",
            errors.join(", ")
        ))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreSyncSessionResponse {
    pub access_token: String,
    pub refresh_token: String,
}

#[tauri::command]
pub async fn restore_sync_session(
    state: State<'_, Arc<ServiceContext>>,
) -> Result<RestoreSyncSessionResponse, String> {
    let access_token = state.connect_service().get_valid_access_token().await?;

    let refresh_token = KeyringSecretStore
        .get_secret(SYNC_REFRESH_TOKEN_KEY)
        .map_err(|e| format!("Failed to read refresh token: {}", e))?
        .ok_or_else(|| "No sync session configured".to_string())?;

    Ok(RestoreSyncSessionResponse {
        access_token,
        refresh_token,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    #[cfg(feature = "connect-sync")]
    use wealthfolio_connect::BrokerConnection;

    #[cfg(feature = "connect-sync")]
    fn broker_connection(status: Option<&str>, disabled: bool) -> BrokerConnection {
        BrokerConnection {
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

    #[cfg(feature = "connect-sync")]
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

    #[cfg(feature = "connect-sync")]
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

    #[cfg(feature = "connect-sync")]
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

    #[cfg(feature = "connect-sync")]
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

    #[cfg(feature = "connect-sync")]
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
}
