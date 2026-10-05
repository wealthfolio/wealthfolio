//! Thin, profile-admitted personal backup commands. No sync enrollment is required.
use crate::{
    profiles::{ConnectAccess, ProfileAccess},
    services::cloud_api_base_url,
};
use std::{path::Path, sync::Arc};
use tauri::Manager;
use wealthfolio_device_sync::backups::client::{
    BackupClient, BackupOperation, BackupPoint, BackupSource,
};
use wealthfolio_storage_sqlite::db;

fn client() -> Result<BackupClient, String> {
    BackupClient::new(&cloud_api_base_url().ok_or("Connect unavailable")?)
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn cloud_backup_action(
    runtime: ConnectAccess,
    operation: BackupOperation,
) -> Result<serde_json::Value, String> {
    if matches!(operation, BackupOperation::RuntimeStatus) {
        return serde_json::to_value(runtime.backup_scheduler.status()).map_err(|e| e.to_string());
    }
    if !matches!(operation, BackupOperation::Status) {
        runtime.backup_scheduler.wake();
    }
    let context = runtime.context()?;
    let _lifecycle = context.sync_lifecycle.lock().await;
    let token = context.connect_service().get_valid_access_token().await?;
    let result = client()?
        .management(&token, runtime.secret_store.as_ref(), &operation)
        .await
        .map_err(|e| e.to_string())?;
    if !matches!(operation, BackupOperation::Status) {
        runtime.backup_scheduler.wake();
    }
    Ok(result)
}
#[tauri::command]
pub async fn cloud_backup_capture(runtime: ProfileAccess) -> Result<Option<BackupPoint>, String> {
    let result = check_and_capture(&runtime.0).await?;
    if result.0.is_some() {
        runtime.backup_scheduler.wake();
    }
    Ok(result.0)
}

async fn check_and_capture(
    runtime: &Arc<crate::database::DatabaseRuntime>,
) -> Result<(Option<BackupPoint>, Option<std::time::Duration>), String> {
    // Single-flight admission is distinct from lifecycle locks. A competing
    // automatic/manual check observes the active capture instead of failing it.
    let Ok(_permit) = runtime.backup_export_slot.clone().try_acquire_owned() else {
        return Ok((None, Some(std::time::Duration::from_secs(30 * 60))));
    };
    let generation = runtime.backup_scheduler.generation();
    let result = runtime
        .backup_scheduler
        .until_changed(generation, capture_in_phases(runtime, generation))
        .await
        .unwrap_or(Ok((None, None)));
    runtime
        .backup_scheduler
        .finished(generation, result.is_err());
    result
}

async fn capture_in_phases(
    runtime: &Arc<crate::database::DatabaseRuntime>,
    generation: u64,
) -> Result<(Option<BackupPoint>, Option<std::time::Duration>), String> {
    if runtime.backup_scheduler.is_paused() {
        return Ok((None, None));
    }
    // Local consent is checked before token refresh or any cloud network request.
    if runtime
        .secret_store
        .get_secret(wealthfolio_core::secrets::CLOUD_BACKUP_CONSENT_KEY)
        .map_err(|_| "Backup consent unavailable")?
        .is_none()
    {
        return Ok((None, None));
    }
    let _connect = runtime
        .connect_transition
        .clone()
        .try_read_owned()
        .map_err(|_| "Connect account change in progress")?;
    let context = runtime.context()?;
    let _lifecycle = context.sync_lifecycle.lock().await;
    let token = context.connect_service().get_valid_access_token().await?;
    let client = client()?;
    let source = client
        .source_policy(&token, runtime.secret_store.as_ref())
        .await
        .map_err(|e| e.to_string())?;
    let policy = match source {
        BackupSource::Ready(policy) => policy,
        wait => return Ok((None, wait.wait_delay())),
    };
    let delay = policy.delay_until_due().map_err(|e| e.to_string())?;
    if !delay.is_zero() {
        return Ok((None, Some(delay)));
    }
    if runtime.backup_scheduler.is_paused() {
        return Ok((None, None));
    }
    let material = client
        .capture_material(&token, runtime.secret_store.as_ref(), &policy)
        .await
        .map_err(|e| e.to_string())?;
    drop(_lifecycle);
    drop(_connect);
    if !runtime.backup_scheduler.is_current(generation) {
        return Ok((None, None));
    }
    runtime.backup_scheduler.started(generation);
    let access = runtime.access()?;
    let scratch = db::profile_scratch_dir(runtime.app_data_dir()).map_err(|e| e.to_string())?;
    let image = tauri::async_runtime::spawn_blocking(move || {
        db::cloud_backups::portable_image(&access, &scratch)
    })
    .await
    .map_err(|_| "Backup export task failed")?
    .map_err(|e| e.to_string())?;
    let encoded = BackupClient::encode_capture(
        material,
        image,
        if policy.last_backup_at.is_some() {
            "scheduled"
        } else {
            "setup"
        },
        wealthfolio_device_sync::backups::client::BackupMetadata {
            device_name: Some(crate::context::get_device_display_name()),
            profile_name: runtime
                .profile_registry
                .as_ref()
                .and_then(|r| r.profile(runtime.profile_id).ok())
                .map(|p| p.name),
            app_version: Some(env!("CARGO_PKG_VERSION").into()),
        },
    )
    .await
    .map_err(|e| e.to_string())?;
    let upload = {
        let _connect = runtime
            .connect_transition
            .clone()
            .try_read_owned()
            .map_err(|_| "Connect account change in progress")?;
        runtime.context()?;
        if !runtime.backup_scheduler.is_current(generation) {
            return Ok((None, None));
        }
        client
            .prepare_capture(&token, encoded)
            .await
            .map_err(|e| e.to_string())?
    };
    let completion = client.upload_capture(upload).await;
    let _connect = runtime
        .connect_transition
        .clone()
        .try_read_owned()
        .map_err(|_| "Connect account change in progress")?;
    runtime.context()?;
    if !runtime.backup_scheduler.is_current(generation) {
        return Ok((None, None));
    }
    let point = client
        .complete_capture(&token, completion)
        .await
        .map_err(|e| e.to_string())?;
    runtime.backup_scheduler.published(generation);
    let next = point.delay_until_next().map_err(|e| e.to_string())?;
    Ok((Some(point), Some(next)))
}

pub(crate) fn start_scheduler(
    handle: tauri::AppHandle,
    profile_id: uuid::Uuid,
    scheduler: Arc<wealthfolio_device_sync::backups::scheduler::BackupScheduler>,
) -> tauri::async_runtime::JoinHandle<()> {
    #[cfg(mobile)]
    scheduler.set_paused(
        handle
            .state::<crate::profile_startup::ProfileStartup>()
            .backup_suspended
            .load(std::sync::atomic::Ordering::SeqCst),
    );
    tauri::async_runtime::spawn(async move {
        scheduler.run(|| {
            let handle = handle.clone();
            async move {
                let runtime = handle.state::<crate::profiles::NativeProfiles>().active()?;
                let Some(runtime) = runtime.filter(|runtime| runtime.profile_id == profile_id) else {
                    return Ok(None);
                };
                let result = check_and_capture(&runtime).await.map(|(_, next)| next);
                if result.is_err() {
                    log::warn!("Cloud backup attempt failed; check the last successful backup in settings");
                }
                result
            }
        }).await;
    })
}
#[tauri::command]
pub async fn cloud_backup_download(
    runtime: ConnectAccess,
    backup_id: String,
) -> Result<super::utilities::PendingExport, String> {
    let _permit = runtime
        .backup_export_slot
        .clone()
        .try_acquire_owned()
        .map_err(|_| "Another backup export is running")?;
    let _access = runtime.access()?;
    super::utilities::check_pending_backup_capacity(Path::new(runtime.app_data_dir()))?;
    let context = runtime.context()?;
    let token = context.connect_service().get_valid_access_token().await?;
    let package = client()?
        .package(&token, &backup_id)
        .await
        .map_err(|e| e.to_string())?;
    let filename = format!("wealthfolio-{backup_id}.wfrec");
    let (relative_path, path) = super::utilities::prepare_pending_export_path(
        Path::new(runtime.app_data_dir()),
        &filename,
    )?;
    std::fs::write(path, package).map_err(|_| "Cannot save recovery package")?;
    Ok(super::utilities::PendingExport {
        relative_path,
        filename,
    })
}
#[tauri::command]
pub async fn cloud_backup_restore_preview(
    runtime: ConnectAccess,
    backup_id: String,
    code: Option<String>,
) -> Result<db::imports::ImportPreview, String> {
    if cfg!(mobile) {
        return Err("Cloud backup replacement is not yet available on mobile".into());
    }
    let code = code.map(zeroize::Zeroizing::new);
    let context = runtime.context()?;
    let token = context.connect_service().get_valid_access_token().await?;
    client()?
        .share_access_best_effort(&token, runtime.secret_store.as_ref(), None)
        .await;
    let package = client()?
        .package(&token, &backup_id)
        .await
        .map_err(|e| e.to_string())?;
    let access = runtime.import_lease()?;
    let reservation = runtime
        .backup_imports
        .reserve()
        .map_err(|e| e.to_string())?;
    let key = runtime.retained_key()?;
    let store = runtime.secret_store.clone();
    let scratch = db::profile_scratch_dir(runtime.app_data_dir()).map_err(|e| e.to_string())?;
    let candidate = tauri::async_runtime::spawn_blocking(move || {
        let _access = access;
        let file = db::cloud_backups::decoded_package(
            package.as_slice(),
            store.as_ref(),
            code.as_deref().map(String::as_str),
            &scratch,
        )?;
        reservation.prepare(file.path(), &scratch, None, key)
    })
    .await
    .map_err(|_| "Cloud recovery inspection failed")?
    .map_err(|e| e.to_string())?;
    runtime
        .backup_imports
        .publish(candidate, "native".into())
        .map_err(|e| e.to_string())
}
