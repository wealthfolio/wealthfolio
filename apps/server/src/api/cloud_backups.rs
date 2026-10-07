//! Personal backups use profile and Connect admission; full restore stays offline.
use crate::{
    error::{ApiError, ApiResult},
    main_lib::AppState,
};
use axum::{
    body::Body,
    extract::Path,
    http::{header, StatusCode},
    response::Response,
    routing::{get, post},
    Extension, Json, Router,
};
use std::sync::Arc;
use wealthfolio_device_sync::backups::client::{
    BackupClient, BackupOperation, BackupPoint, BackupSource,
};
use wealthfolio_storage_sqlite::db;
fn client() -> ApiResult<BackupClient> {
    BackupClient::new(
        &crate::features::cloud_api_base_url()
            .ok_or_else(|| ApiError::NotImplemented("Connect unavailable".into()))?,
    )
    .map_err(|e| ApiError::BadRequest(e.to_string()))
}
#[derive(serde::Deserialize)]
struct OperationRequest {
    operation: BackupOperation,
}
async fn action(
    Extension(state): Extension<Arc<AppState>>,
    Json(input): Json<OperationRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    let _guard = crate::profiles::connect_guard(&state).map_err(ApiError::Forbidden)?;
    if matches!(input.operation, BackupOperation::RuntimeStatus) {
        return Ok(Json(
            serde_json::to_value(state.backup_scheduler.status())
                .map_err(|_| ApiError::Internal("Backup status unavailable".into()))?,
        ));
    }
    let cancels_capture = matches!(
        input.operation,
        BackupOperation::Enable { .. }
            | BackupOperation::Disable
            | BackupOperation::Delete { backup_id: None }
    );
    if cancels_capture {
        state.backup_scheduler.wake();
    }
    let _lifecycle = state.profile_lifecycle.lock().await;
    let token = super::connect::mint_access_token(&state).await?;
    let result = client()?
        .management(&token, state.secret_store.as_ref(), &input.operation)
        .await
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;
    if cancels_capture {
        state.backup_scheduler.wake();
    } else if !matches!(input.operation, BackupOperation::Status) {
        state.backup_scheduler.request_check();
    }
    Ok(Json(result))
}
// Account admission is held by each API phase; shared logic gates the refresh result.
async fn capture_token(
    state: &Arc<AppState>,
    generation: u64,
) -> wealthfolio_device_sync::Result<String> {
    BackupClient::capture_token(&state.backup_scheduler, generation, || async {
        super::connect::mint_access_token(state)
            .await
            .map_err(|e| wealthfolio_device_sync::DeviceSyncError::Auth(e.to_string()))
    })
    .await
}

async fn check_and_capture(
    state: &Arc<AppState>,
) -> ApiResult<(Option<BackupPoint>, Option<std::time::Duration>)> {
    // Single-flight admission is distinct from lifecycle locks. A competing
    // automatic/manual check observes the active capture instead of failing it.
    let Ok(_permit) = state.backup_exports.slot.clone().try_acquire_owned() else {
        return Ok((None, Some(std::time::Duration::from_secs(30 * 60))));
    };
    let generation = state.backup_scheduler.generation();
    state.backup_scheduler.checking(generation);
    let result = state
        .backup_scheduler
        .until_changed(generation, capture_in_phases(state, generation))
        .await
        .unwrap_or(Ok((None, None)));
    state.backup_scheduler.finished(generation, result.is_err());
    result
}
async fn capture_in_phases(
    state: &Arc<AppState>,
    generation: u64,
) -> ApiResult<(Option<BackupPoint>, Option<std::time::Duration>)> {
    if state.backup_scheduler.is_paused() {
        return Ok((None, None));
    }
    if state
        .secret_store
        .get_secret(wealthfolio_core::secrets::CLOUD_BACKUP_CONSENT_KEY)?
        .is_none()
    {
        return Ok((None, None));
    }
    let _guard = crate::profiles::connect_guard(state).map_err(ApiError::Forbidden)?;
    let _lifecycle = state.profile_lifecycle.lock().await;
    let token = super::connect::mint_access_token(state).await?;
    let client = client()?;
    let source = client
        .source_policy(&token, state.secret_store.as_ref())
        .await
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;
    let policy = match source {
        BackupSource::Ready(policy) => policy,
        wait => return Ok((None, wait.wait_delay())),
    };
    let delay = policy
        .delay_until_due()
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;
    if !delay.is_zero() {
        return Ok((None, Some(delay)));
    }
    let material = client
        .capture_material(&token, state.secret_store.as_ref(), &policy)
        .await
        .map_err(|e| {
            state.backup_scheduler.capture_error(generation, &e);
            ApiError::BadRequest(e.to_string())
        })?;
    drop(_lifecycle);
    drop(_guard);
    if !state.backup_scheduler.is_current(generation) {
        return Ok((None, None));
    }
    state.backup_scheduler.started(generation);
    super::device_sync_engine::share_backup_access(state)
        .await
        .map_err(|error| {
            state.backup_scheduler.blocked(generation);
            ApiError::BadRequest(error)
        })?;
    if !state.backup_scheduler.is_current(generation) {
        return Ok((None, None));
    }
    let owner = state._database_owner.clone();
    let access = state.db_access.clone();
    let scratch = db::profile_scratch_dir(&state.data_root)?;
    let image = tokio::task::spawn_blocking(move || {
        let _owner = owner;
        db::cloud_backups::portable_reader(&access, &scratch)
    })
    .await
    .map_err(|_| ApiError::Internal("Backup export task failed".into()))?
    .map_err(|e| {
        if matches!(
            e.downcast_ref::<wealthfolio_device_sync::backups::BackupError>(),
            Some(wealthfolio_device_sync::backups::BackupError::SizeLimit)
        ) {
            state.backup_scheduler.blocked(generation);
        }
        ApiError::from(e)
    })?;
    let encoded = BackupClient::encode_capture(
        material,
        image,
        if policy.last_backup_at.is_some() {
            "scheduled"
        } else {
            "setup"
        },
        wealthfolio_device_sync::backups::client::BackupMetadata {
            device_name: Some("Wealthfolio Server".into()),
            profile_name: state
                .profile_binding
                .get()
                .and_then(|(r, id)| r.profile(*id).ok())
                .map(|p| p.name),
            app_version: Some(env!("CARGO_PKG_VERSION").into()),
        },
    )
    .await
    .map_err(|e| {
        state.backup_scheduler.capture_error(generation, &e);
        ApiError::BadRequest(e.to_string())
    })?;
    let upload = {
        let _guard = crate::profiles::connect_guard(state).map_err(ApiError::Forbidden)?;
        if !state.backup_scheduler.is_current(generation) {
            return Ok((None, None));
        }
        client
            .prepare_capture(|| capture_token(state, generation), encoded)
            .await
            .map_err(|e| ApiError::BadRequest(e.to_string()))?
    };
    let completion = client.upload_capture(upload).await.map_err(|e| {
        state.backup_scheduler.capture_error(generation, &e);
        ApiError::BadRequest(e.to_string())
    })?;
    let _guard = crate::profiles::connect_guard(state).map_err(ApiError::Forbidden)?;
    if !state.backup_scheduler.is_current(generation) {
        return Ok((None, None));
    }
    let point = client
        .complete_capture(|| capture_token(state, generation), completion)
        .await
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;
    state.backup_scheduler.published(generation);
    let next = point
        .delay_until_next()
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;
    Ok((Some(point), Some(next)))
}
pub(crate) fn start_scheduler(state: Arc<AppState>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        state.backup_scheduler.run(|| {
            let state = state.clone();
            async move {
                let result = check_and_capture(&state).await.map(|(_, next)| next);
                if result.is_err() {
                    tracing::warn!("Cloud backup attempt failed; check the last successful backup in settings");
                }
                result
            }
        }).await;
    })
}
async fn capture_route(
    Extension(state): Extension<Arc<AppState>>,
) -> ApiResult<Json<Option<BackupPoint>>> {
    let result = check_and_capture(&state).await?;
    if result.0.is_some() {
        state.backup_scheduler.request_check();
    }
    Ok(Json(result.0))
}
async fn download(
    Extension(state): Extension<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    let _guard = crate::profiles::connect_guard(&state).map_err(ApiError::Forbidden)?;
    let token = super::connect::mint_access_token(&state).await?;
    let package = client()?
        .package(&token, &id)
        .await
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"wealthfolio-{id}.wfrec\""),
        )
        .body(Body::from(package))
        .map_err(|e| ApiError::Internal(e.to_string()))
}
pub fn router() -> Router {
    Router::new()
        .route("/cloud-backups/action", post(action))
        .route("/cloud-backups/capture", post(capture_route))
        .route("/cloud-backups/{id}/package", get(download))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use std::time::Duration;
    use wealthfolio_device_sync::backups::scheduler::CaptureState;

    #[tokio::test]
    async fn runtime_health_is_local_and_competing_checks_do_not_fail_an_active_capture() {
        let root = tempfile::tempdir().unwrap();
        let config = Config {
            listen_addr: "127.0.0.1:0".parse().unwrap(),
            db_path: root.path().join("app.db").to_string_lossy().into_owned(),
            addons_root: root.path().join("addons").to_string_lossy().into_owned(),
            static_dir: root.path().join("static").to_string_lossy().into_owned(),
            cors_allow: vec![],
            request_timeout: Duration::from_secs(10),
            raw_secret_key: vec![7; 32],
            secrets_encryption_key: [8; 32],
            database_key: [9; 32],
            db_encryption_required: false,
            auth: None,
            oidc: None,
            mcp_enabled: false,
            mcp_audit_enabled: false,
            mcp_allowed_hosts: None,
        };
        let state = crate::build_state(&config).await.unwrap();
        let stale_generation = state.backup_scheduler.generation();
        state.backup_scheduler.wake();
        assert!(
            capture_token(&state, stale_generation)
                .await
                .unwrap_err()
                .to_string()
                .contains("cancelled"),
            "revoked captures must not refresh credentials"
        );
        let generation = state.backup_scheduler.generation();
        state.backup_scheduler.finished(generation, true);
        let _lifecycle = state.profile_lifecycle.lock().await;
        // No Connect credentials exist. A status read must bypass both the
        // lifecycle lock and token refresh/cloud requests, even after a failure.
        let Json(status) = tokio::time::timeout(
            Duration::from_millis(250),
            action(
                Extension(state.clone()),
                Json(OperationRequest {
                    operation: BackupOperation::RuntimeStatus,
                }),
            ),
        )
        .await
        .expect("local status must not wait for profile work")
        .unwrap();
        assert_eq!(status["state"], "failed");
        assert!(status["retryAt"].is_string());
        let _export = state
            .backup_exports
            .slot
            .clone()
            .acquire_owned()
            .await
            .unwrap();
        state.backup_scheduler.started(generation);
        let competing = check_and_capture(&state).await.unwrap();
        assert!(competing.0.is_none());
        let Json(competing_manual) = capture_route(Extension(state.clone())).await.unwrap();
        assert!(competing_manual.is_none());
        assert!(
            state.backup_scheduler.is_current(generation),
            "a competing retry must not cancel the active capture"
        );
        assert_eq!(state.backup_scheduler.status().state, CaptureState::Running);
        // Pairing/access sharing wakes the due timer without revoking a web capture.
        state.backup_scheduler.request_check();
        assert!(state.backup_scheduler.is_current(generation));
        assert_eq!(state.backup_scheduler.status().state, CaptureState::Running);
        drop(_lifecycle);
        // Cancellation is decided locally before authentication; no cloud
        // credentials are needed to exercise the actual handler's admission.
        assert!(action(
            Extension(state.clone()),
            Json(OperationRequest {
                operation: BackupOperation::Delete {
                    backup_id: Some(uuid::Uuid::new_v4().to_string())
                }
            })
        )
        .await
        .is_err());
        assert!(state.backup_scheduler.is_current(generation));
        assert_eq!(state.backup_scheduler.status().state, CaptureState::Running);
        for operation in [
            BackupOperation::Delete { backup_id: None },
            BackupOperation::Disable,
        ] {
            let previous = state.backup_scheduler.generation();
            state.backup_scheduler.started(previous);
            assert!(action(
                Extension(state.clone()),
                Json(OperationRequest { operation })
            )
            .await
            .is_err());
            assert!(!state.backup_scheduler.is_current(previous));
        }
    }
}
