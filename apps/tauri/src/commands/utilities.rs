use crate::profiles::ProfileAccess;
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use chrono;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use tauri::async_runtime::spawn_blocking;
use tauri::Manager;
use tauri::{AppHandle, Emitter};
#[cfg(not(any(target_os = "ios", target_os = "android")))]
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_shell::ShellExt;
use uuid::Uuid;
use wealthfolio_core::{
    activities::Sort,
    exports::{
        export_file_name, format_holding_list_records, format_records, ExportDataType,
        ExportFileFormat,
    },
    portfolio::holdings::HoldingListItem,
    portfolios::AccountScope,
};
use wealthfolio_storage_sqlite::db;

use crate::commands::portfolio::holdings_account_ids;
use crate::context::ServiceContext;
#[cfg(desktop)]
use crate::updater::{check_for_update, install_update};

const PENDING_EXPORTS_DIR: &str = "pending-exports";
const PENDING_EXPORT_TTL: Duration = Duration::from_secs(60 * 60);
const EXPORT_ACTIVITY_PAGE_SIZE: i64 = 9_007_199_254_740_991;

/// Normalize file path by removing file:// URI prefix if present (iOS/Android compatibility)
fn normalize_file_path(path: &str) -> String {
    if path.starts_with("file://") {
        path.strip_prefix("file://").unwrap_or(path).to_string()
    } else {
        path.to_string()
    }
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
fn file_extension(file_name: &str) -> Option<&str> {
    Path::new(file_name)
        .extension()
        .and_then(|extension| extension.to_str())
        .filter(|extension| !extension.is_empty())
}

fn pending_export_filename(file_name: &str) -> Result<String, String> {
    let name = Path::new(file_name)
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Export filename is invalid".to_string())?;

    if name.is_empty() || name.contains('/') || name.contains('\\') {
        return Err("Export filename is invalid".to_string());
    }

    Ok(name.to_string())
}

fn prepare_pending_export_path(
    app_data_dir_path: &Path,
    filename: &str,
) -> Result<(String, PathBuf), String> {
    cleanup_stale_pending_exports(app_data_dir_path);

    let export_id = Uuid::new_v4().to_string();
    let export_dir = app_data_dir_path.join(PENDING_EXPORTS_DIR).join(&export_id);
    fs::create_dir_all(&export_dir)
        .map_err(|e| format!("Failed to create pending export directory: {}", e))?;

    Ok((
        format!("{}/{}/{}", PENDING_EXPORTS_DIR, export_id, filename),
        export_dir.join(filename),
    ))
}

fn cleanup_stale_pending_exports(app_data_dir_path: &Path) {
    let pending_exports_dir = app_data_dir_path.join(PENDING_EXPORTS_DIR);
    let Ok(entries) = fs::read_dir(&pending_exports_dir) else {
        return;
    };

    let now = SystemTime::now();
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        let Ok(age) = now.duration_since(modified) else {
            continue;
        };

        if age <= PENDING_EXPORT_TTL {
            continue;
        }

        let result = if metadata.is_dir() {
            fs::remove_dir_all(&path)
        } else {
            fs::remove_file(&path)
        };

        if let Err(error) = result {
            log::warn!(
                "Failed to clean stale pending export {}: {}",
                path.display(),
                error
            );
        }
    }
}

fn is_allowed_external_url(url: &str) -> bool {
    if url.is_empty() || url.chars().any(char::is_whitespace) || url.chars().any(char::is_control) {
        return false;
    }

    let lowercase_url = url.to_ascii_lowercase();
    ["https://", "http://", "mailto:", "tel:"]
        .iter()
        .any(|scheme| lowercase_url.starts_with(scheme) && lowercase_url.len() > scheme.len())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: String,
    db_path: String,
    logs_dir: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingExport {
    relative_path: String,
    filename: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataExportResult {
    status: DataExportStatus,
    relative_path: Option<String>,
    filename: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DataExportStatus {
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    Saved,
    #[cfg(any(target_os = "ios", target_os = "android"))]
    Pending,
    Empty,
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    Canceled,
}

impl DataExportResult {
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    fn saved(filename: String) -> Self {
        Self {
            status: DataExportStatus::Saved,
            relative_path: None,
            filename: Some(filename),
        }
    }

    #[cfg(any(target_os = "ios", target_os = "android"))]
    fn pending(pending_export: PendingExport) -> Self {
        Self {
            status: DataExportStatus::Pending,
            relative_path: Some(pending_export.relative_path),
            filename: Some(pending_export.filename),
        }
    }

    fn empty() -> Self {
        Self {
            status: DataExportStatus::Empty,
            relative_path: None,
            filename: None,
        }
    }

    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    fn canceled() -> Self {
        Self {
            status: DataExportStatus::Canceled,
            relative_path: None,
            filename: None,
        }
    }
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
fn save_content_with_dialog(
    app_handle: &AppHandle,
    file_name: &str,
    content: &[u8],
) -> Result<bool, String> {
    let mut dialog = app_handle.dialog().file().set_file_name(file_name);

    if let Some(extension) = file_extension(file_name) {
        let filter_name = extension.to_ascii_uppercase();
        dialog = dialog.add_filter(filter_name, &[extension]);
    }

    let Some(file_path) = dialog.blocking_save_file() else {
        return Ok(false);
    };

    let path = file_path
        .into_path()
        .map_err(|e| format!("Failed to resolve selected file path: {}", e))?;

    fs::write(&path, content)
        .map_err(|e| format!("Failed to save export to {}: {}", path.display(), e))?;

    Ok(true)
}

fn write_pending_export_content(
    profile_root: &Path,
    file_name: &str,
    content: &[u8],
) -> Result<PendingExport, String> {
    let filename = pending_export_filename(file_name)?;
    let (relative_path, export_path) = prepare_pending_export_path(profile_root, &filename)?;
    fs::write(&export_path, content).map_err(|e| {
        format!(
            "Failed to write pending export {}: {}",
            export_path.display(),
            e
        )
    })?;

    Ok(PendingExport {
        relative_path,
        filename,
    })
}

async fn build_data_export_content(
    state: &ServiceContext,
    data_type: ExportDataType,
    format: ExportFileFormat,
) -> Result<Option<Vec<u8>>, String> {
    match data_type {
        ExportDataType::Accounts => {
            let records = state
                .account_service()
                .get_non_archived_accounts()
                .map_err(|e| format!("Failed to load accounts for export: {}", e))?;
            format_records(&records, format).map_err(|e| e.to_string())
        }
        ExportDataType::Activities => {
            let records = state
                .activity_service()
                .search_activities(
                    0,
                    EXPORT_ACTIVITY_PAGE_SIZE,
                    None,
                    None,
                    None,
                    Some(Sort {
                        id: "date".to_string(),
                        desc: true,
                    }),
                    None,
                    None,
                    None,
                    None,
                    None,
                )
                .map_err(|e| format!("Failed to load activities for export: {}", e))?
                .data;
            format_records(&records, format).map_err(|e| e.to_string())
        }
        ExportDataType::Holdings => {
            let base_currency = state.get_base_currency();
            let resolved = state
                .portfolio_service()
                .resolve_account_scope(&AccountScope::All, &base_currency)
                .map_err(|e| format!("Failed to resolve portfolio scope: {}", e))?;
            let account_ids = holdings_account_ids(state, &resolved.account_ids)?;
            if account_ids.is_empty() {
                return Ok(None);
            }

            let holdings = if account_ids.len() == 1 {
                state
                    .holdings_service()
                    .get_holdings(&account_ids[0], &base_currency)
                    .await
                    .map_err(|e| format!("Failed to load holdings for export: {}", e))?
            } else {
                state
                    .holdings_service()
                    .get_holdings_for_accounts(&account_ids, &base_currency, &resolved.scope_id)
                    .await
                    .map_err(|e| format!("Failed to load holdings for export: {}", e))?
            };
            let records = holdings
                .into_iter()
                .map(HoldingListItem::from)
                .collect::<Vec<_>>();
            format_holding_list_records(&records, format).map_err(|e| e.to_string())
        }
        ExportDataType::Goals => {
            let records = state
                .goal_service()
                .get_goals()
                .map_err(|e| format!("Failed to load goals for export: {}", e))?;
            format_records(&records, format).map_err(|e| e.to_string())
        }
        ExportDataType::PortfolioHistory => {
            let base_currency = state.get_base_currency();
            let resolved = state
                .portfolio_service()
                .resolve_account_scope(&AccountScope::All, &base_currency)
                .map_err(|e| format!("Failed to resolve portfolio scope: {}", e))?;
            let records = state
                .valuation_service()
                .get_historical_valuations_for_accounts(
                    &resolved.scope_id,
                    &resolved.account_ids,
                    &resolved.base_currency,
                    None,
                    None,
                )
                .map_err(|e| format!("Failed to load portfolio history for export: {}", e))?;
            format_records(&records, format).map_err(|e| e.to_string())
        }
    }
}

#[tauri::command]
pub async fn save_text_file_with_dialog(
    _state: ProfileAccess,
    app_handle: AppHandle,
    file_name: String,
    content: String,
) -> Result<bool, String> {
    #[cfg(any(target_os = "ios", target_os = "android"))]
    {
        let _ = (&app_handle, &file_name, &content);
        return Err("Direct file saving is only supported on desktop".to_string());
    }

    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    save_content_with_dialog(&app_handle, &file_name, content.as_bytes())
}

#[tauri::command]
pub async fn save_file_with_dialog(
    _state: ProfileAccess,
    app_handle: AppHandle,
    file_name: String,
    content_base64: String,
) -> Result<bool, String> {
    #[cfg(any(target_os = "ios", target_os = "android"))]
    {
        let _ = (&app_handle, &file_name, &content_base64);
        return Err("Direct file saving is only supported on desktop".to_string());
    }

    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        let content = BASE64_STANDARD
            .decode(content_base64)
            .map_err(|e| format!("Failed to decode export content: {}", e))?;

        save_content_with_dialog(&app_handle, &file_name, &content)
    }
}

#[tauri::command]
pub async fn write_pending_export_text_file(
    profile: ProfileAccess,
    _app_handle: AppHandle,
    file_name: String,
    content: String,
) -> Result<PendingExport, String> {
    write_pending_export_content(
        Path::new(profile.app_data_dir()),
        &file_name,
        content.as_bytes(),
    )
}

#[tauri::command]
pub async fn write_pending_export_file(
    profile: ProfileAccess,
    _app_handle: AppHandle,
    file_name: String,
    content_base64: String,
) -> Result<PendingExport, String> {
    let content = BASE64_STANDARD
        .decode(content_base64)
        .map_err(|e| format!("Failed to decode export content: {}", e))?;

    write_pending_export_content(Path::new(profile.app_data_dir()), &file_name, &content)
}

#[tauri::command]
pub async fn export_data_file(
    app_handle: AppHandle,
    profile: ProfileAccess,
    data_type: String,
    format: String,
) -> Result<DataExportResult, String> {
    let context = profile.context()?;
    let data_type = ExportDataType::parse(&data_type).map_err(|e| e.to_string())?;
    let format = ExportFileFormat::parse(&format).map_err(|e| e.to_string())?;
    let Some(content) = build_data_export_content(context.as_ref(), data_type, format).await?
    else {
        return Ok(DataExportResult::empty());
    };

    let filename = export_file_name(data_type, format, chrono::Local::now().date_naive());

    #[cfg(any(target_os = "ios", target_os = "android"))]
    {
        let pending_export =
            write_pending_export_content(Path::new(profile.app_data_dir()), &filename, &content)?;
        Ok(DataExportResult::pending(pending_export))
    }

    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        if save_content_with_dialog(&app_handle, &filename, &content)? {
            Ok(DataExportResult::saved(filename))
        } else {
            Ok(DataExportResult::canceled())
        }
    }
}

#[tauri::command]
pub async fn open_external_url(app_handle: AppHandle, url: String) -> Result<(), String> {
    let url = url.trim();
    if !is_allowed_external_url(url) {
        return Err("Unsupported external URL".to_string());
    }

    open_external_link(&app_handle, url)
}

#[allow(deprecated)]
fn open_external_link(app_handle: &AppHandle, url: &str) -> Result<(), String> {
    app_handle
        .shell()
        .open(url, None)
        .map_err(|e| format!("Failed to open external link: {}", e))
}

#[tauri::command]
pub async fn get_app_info(app_handle: AppHandle, state: ProfileAccess) -> Result<AppInfo, String> {
    let version = app_handle.package_info().version.to_string();

    let db_path = state.database_path().to_string();
    let logs_dir = app_handle
        .path()
        .app_log_dir()
        .map_err(|e| format!("Failed to get app log dir: {}", e))?
        .to_str()
        .ok_or_else(|| "Failed to convert app log dir path to string".to_string())?
        .to_string();

    Ok(AppInfo {
        version,
        db_path,
        logs_dir,
    })
}

/// Check for updates and return update info if available.
#[tauri::command]
pub async fn check_for_updates(app_handle: AppHandle) -> Result<Option<serde_json::Value>, String> {
    #[cfg(desktop)]
    {
        let result = check_for_update(app_handle).await?;
        result
            .map(serde_json::to_value)
            .transpose()
            .map_err(|error| error.to_string())
    }
    #[cfg(not(desktop))]
    {
        Ok(None)
    }
}

/// Download and install an available update. Emits progress events and restarts the app.
#[tauri::command]
pub async fn install_app_update(app_handle: AppHandle) -> Result<(), String> {
    #[cfg(desktop)]
    install_update(app_handle).await?;
    Ok(())
}

/// Internal backup, listed in the app's backup manager and used by restore.
///
/// A faithful copy: it inherits the live database's encryption, so on an
/// encrypted device only this device's retained key opens it.
#[tauri::command]
pub async fn backup_database(runtime: ProfileAccess) -> Result<String, String> {
    let access = runtime.access()?;
    let app_data_dir = runtime.app_data_dir().to_string();

    // Copying the whole database is blocking work, and on an encrypted database
    // every page is decrypted and re-encrypted on the way out.
    let backup_path = spawn_blocking(move || db::backup_database(&access, &app_data_dir))
        .await
        .map_err(|e| format!("Backup task failed: {e}"))?
        .map_err(|e| e.to_string())?;

    Ok(Path::new(&backup_path)
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Failed to get backup filename".to_string())?
        .to_string())
}

#[tauri::command]
pub async fn open_database_backup_folder(
    app_handle: AppHandle,
    runtime: ProfileAccess,
) -> Result<(), String> {
    #[cfg(desktop)]
    {
        let _access = runtime.access()?;
        let folder = Path::new(runtime.app_data_dir()).join("backups");
        fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
        open_external_link(&app_handle, &folder.to_string_lossy())
    }
    #[cfg(mobile)]
    {
        let _ = (app_handle, runtime);
        Err("Backup folders can only be opened on desktop".into())
    }
}

#[tauri::command]
pub async fn list_database_backups(
    runtime: ProfileAccess,
) -> Result<Vec<db::snapshots::Snapshot>, String> {
    let access = runtime.access()?;
    let root = runtime.app_data_dir().to_string();
    let key = runtime.retained_key()?;
    spawn_blocking(move || {
        let _access = access;
        db::snapshots::list(&root, key)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn delete_database_backup(
    runtime: ProfileAccess,
    filename: String,
) -> Result<(), String> {
    let access = runtime.access()?;
    let root = runtime.app_data_dir().to_string();
    spawn_blocking(move || {
        let _access = access;
        db::snapshots::delete(&root, &filename)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

fn check_pending_backup_capacity(root: &Path) -> Result<(), String> {
    cleanup_stale_pending_exports(root);
    let directory = root.join(PENDING_EXPORTS_DIR);
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    let mut count = 0;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        if !entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            continue;
        }
        for file in fs::read_dir(entry.path()).map_err(|error| error.to_string())? {
            let path = file.map_err(|error| error.to_string())?.path();
            if matches!(
                path.extension().and_then(|ext| ext.to_str()),
                Some("db" | "wfbackup")
            ) {
                count += 1;
            }
        }
    }
    if count >= 2 {
        return Err("Finish or discard pending backup exports before creating another".into());
    }
    Ok(())
}

#[cfg(test)]
mod backup_export_tests {
    use super::*;
    #[test]
    fn pending_backup_capacity_is_released_by_picker_cleanup() {
        let root = tempfile::tempdir().unwrap();
        assert!(check_pending_backup_capacity(root.path()).is_ok());
        for index in 0..2 {
            let folder = root
                .path()
                .join(PENDING_EXPORTS_DIR)
                .join(index.to_string());
            fs::create_dir_all(&folder).unwrap();
            fs::write(folder.join("wealthfolio-test.wfbackup"), b"test").unwrap();
        }
        assert!(check_pending_backup_capacity(root.path()).is_err());
        fs::remove_dir_all(root.path().join(PENDING_EXPORTS_DIR).join("0")).unwrap();
        assert!(check_pending_backup_capacity(root.path()).is_ok());
    }
}

/// Export the selected saved snapshot; never silently substitute live data.
#[tauri::command]
pub async fn export_database_backup(
    runtime: ProfileAccess,
    filename: String,
    password: Option<String>,
    unencrypted: bool,
) -> Result<PendingExport, String> {
    let password = password.map(zeroize::Zeroizing::new);
    if unencrypted == password.is_some() {
        return Err("Choose password protection or explicitly choose an unencrypted export".into());
    }
    let permit = runtime
        .backup_export_slot
        .clone()
        .try_acquire_owned()
        .map_err(|_| "Another backup export is running".to_string())?;
    let access = runtime.access()?;
    let root = runtime.app_data_dir().to_string();
    let key = runtime.retained_key()?;
    spawn_blocking(move || {
        // These leases survive caller cancellation until all blocking work ends.
        let _permit = permit;
        let _access = access;
        check_pending_backup_capacity(Path::new(&root))?;
        let lease = db::snapshots::acquire(&root, &filename).map_err(|e| e.to_string())?;
        let source = lease.access(key).map_err(|e| e.to_string())?;
        let scratch = db::profile_scratch_dir(&root).map_err(|e| e.to_string())?;
        let output =
            db::portable::export(&source, &scratch, password.as_deref().map(String::as_str))
                .map_err(|e| e.to_string())?;
        let (relative_path, path) =
            prepare_pending_export_path(Path::new(&root), &output.filename)?;
        let directory = path.parent().ok_or("Missing export directory")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(directory, fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
        if let Err(error) = fs::copy(&output.path, &path) {
            let _ = fs::remove_dir_all(directory);
            return Err(error.to_string());
        }
        Ok(PendingExport {
            relative_path,
            filename: output.filename.clone(),
        })
    })
    .await
    .map_err(|error| {
        log::error!(
            "Backup export task failed (panic={})",
            matches!(error, tauri::Error::JoinError(ref join) if join.is_panic())
        );
        "Backup export task failed".to_string()
    })?
}

/// Inspect a private immutable candidate without changing the live database.
#[tauri::command]
pub async fn inspect_database_backup(
    runtime: ProfileAccess,
    backup_file_path: String,
    password: Option<String>,
) -> Result<db::imports::ImportPreview, String> {
    let password = password.map(zeroize::Zeroizing::new);
    let access = runtime.import_lease()?;
    let reservation = runtime
        .backup_imports
        .reserve()
        .map_err(|e| e.to_string())?;
    let key = runtime.retained_key()?;
    let scratch = db::profile_scratch_dir(runtime.app_data_dir()).map_err(|e| e.to_string())?;
    let path = PathBuf::from(normalize_file_path(&backup_file_path));
    if let Some(registry) = &runtime.profile_registry {
        registry
            .validate_import_path(runtime.profile_id, &path)
            .map_err(|e| e.to_string())?;
    }
    let candidate = spawn_blocking(move || {
        let _access = access;
        reservation.prepare(
            &path,
            &scratch,
            password.as_deref().map(String::as_str),
            key,
        )
    })
    .await
    .map_err(|_| "Backup inspection task failed".to_string())?
    .map_err(|e| e.to_string())?;
    runtime
        .backup_imports
        .publish(candidate, "native".into())
        .map_err(|error| error.to_string())
}

/// Inspect a managed snapshot while its catalogue lease prevents deletion.
#[tauri::command]
pub async fn inspect_saved_database_backup(
    runtime: ProfileAccess,
    filename: String,
) -> Result<db::imports::ImportPreview, String> {
    let access = runtime.import_lease()?;
    let reservation = runtime
        .backup_imports
        .reserve()
        .map_err(|e| e.to_string())?;
    let key = runtime.retained_key()?;
    let root = runtime.app_data_dir().to_string();
    let candidate = spawn_blocking(move || {
        let _access = access;
        let lease = db::snapshots::acquire(&root, &filename)?;
        let scratch = db::profile_scratch_dir(&root)?;
        reservation.prepare(&lease.path, &scratch, None, key)
    })
    .await
    .map_err(|_| "Backup inspection task failed".to_string())?
    .map_err(|error: anyhow::Error| error.to_string())?;
    runtime
        .backup_imports
        .publish(candidate, "native".into())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn discard_database_backup_import(
    runtime: ProfileAccess,
    id: String,
) -> Result<(), String> {
    let id = uuid::Uuid::parse_str(&id).map_err(|_| "Invalid backup preview".to_string())?;
    drop(
        runtime
            .backup_imports
            .take(id, "native")
            .map_err(|e| e.to_string())?,
    );
    Ok(())
}

#[tauri::command]
pub async fn restore_database_backup_import(
    app_handle: AppHandle,
    runtime: ProfileAccess,
    id: String,
) -> Result<(), String> {
    let id = uuid::Uuid::parse_str(&id).map_err(|_| "Invalid backup preview".to_string())?;
    runtime.restore_validated_import(&app_handle, id).await
}

#[tauri::command]
pub async fn recover_database_from_import(
    app_handle: AppHandle,
    runtime: ProfileAccess,
    id: String,
) -> Result<(), String> {
    let id = uuid::Uuid::parse_str(&id).map_err(|_| "Invalid backup preview".to_string())?;
    runtime.recover_validated_import(&app_handle, id).await
}

#[tauri::command]
pub async fn get_database_startup_status(
    runtime: ProfileAccess,
) -> Result<crate::database::DatabaseStartupStatus, String> {
    Ok(runtime.startup_status())
}

#[tauri::command]
pub async fn retry_database_startup(
    app_handle: AppHandle,
    runtime: ProfileAccess,
) -> Result<(), String> {
    runtime.retry_startup(&app_handle).await
}

/// Announces a completed maintenance operation and continues safely.
///
/// Desktop restarts unconditionally: continuing on services built over the
/// replaced file is never correct, and a restart the user can decline is not a
/// guarantee. Mobile continues over the rebuilt runtime and tells the frontend
/// to refetch everything.
pub(crate) fn finish_database_maintenance(
    app_handle: &AppHandle,
    event: &str,
) -> Result<(), String> {
    app_handle
        .emit(event, ())
        .map_err(|e| format!("Failed to emit {} event: {}", event, e))?;

    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    app_handle.restart();

    #[cfg(any(target_os = "ios", target_os = "android"))]
    Ok(())
}

fn profile_transfer_path(
    profile_root: &Path,
    relative_path: &str,
) -> Result<std::path::PathBuf, String> {
    let parts: Vec<_> = relative_path.split('/').collect();
    if !(parts.len() == 2 || parts.len() == 3) {
        return Err("Invalid transfer path".into());
    }
    let id = if parts[0] == "pending-exports" {
        parts[1]
    } else if parts[0] == "scratch" {
        parts[1]
            .strip_prefix("portable-picked-")
            .ok_or("Invalid transfer path")?
    } else {
        return Err("Invalid transfer path".into());
    };
    uuid::Uuid::parse_str(id).map_err(|_| "Invalid transfer ID")?;
    if parts.len() == 3
        && (parts[2].is_empty()
            || parts[2].contains(['\\', ':'])
            || parts[2] == "."
            || parts[2] == "..")
    {
        return Err("Invalid transfer filename".into());
    }
    let path = profile_root.join(relative_path);
    let mut current = profile_root.to_path_buf();
    for part in &parts {
        current.push(part);
        if std::fs::symlink_metadata(&current).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err("Transfer symlinks are not allowed".into());
        }
    }
    Ok(path)
}

#[tauri::command]
pub fn profile_transfer_file(
    profile: ProfileAccess,
    relative_path: String,
    operation: String,
    offset: Option<u64>,
    content: Option<String>,
) -> Result<serde_json::Value, String> {
    use std::io::{Read, Seek, SeekFrom, Write};
    let path = profile_transfer_path(Path::new(profile.app_data_dir()), &relative_path)?;
    let offset = offset.unwrap_or(0);
    match operation.as_str() {
        "path" => Ok(serde_json::json!(path)),
        "remove" => {
            if path.is_dir() {
                fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
            } else if path.exists() {
                fs::remove_file(&path).map_err(|e| e.to_string())?;
            }
            Ok(serde_json::Value::Null)
        }
        "read" if relative_path.starts_with("pending-exports/") => {
            let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
            file.seek(SeekFrom::Start(offset))
                .map_err(|e| e.to_string())?;
            let mut bytes = vec![0; 1024 * 1024];
            let read = file.read(&mut bytes).map_err(|e| e.to_string())?;
            Ok(serde_json::json!(BASE64_STANDARD.encode(&bytes[..read])))
        }
        "write"
            if relative_path.starts_with("scratch/portable-picked-")
                && relative_path.ends_with("/restore.db") =>
        {
            let bytes = BASE64_STANDARD
                .decode(content.ok_or("Missing content")?)
                .map_err(|_| "Invalid transfer content")?;
            if bytes.len() > 1024 * 1024 || offset > 2 * 1024 * 1024 * 1024 - bytes.len() as u64 {
                return Err("Transfer limit exceeded".into());
            }
            fs::create_dir_all(path.parent().ok_or("Invalid transfer path")?)
                .map_err(|e| e.to_string())?;
            let mut file = if offset == 0 {
                fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(path)
            } else {
                fs::OpenOptions::new().append(true).open(path)
            }
            .map_err(|e| e.to_string())?;
            if file.metadata().map_err(|e| e.to_string())?.len() != offset {
                return Err("Invalid transfer offset".into());
            }
            file.write_all(&bytes).map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        _ => Err("Unsupported transfer operation".into()),
    }
}

#[cfg(test)]
mod profile_transfer_tests {
    use super::*;
    #[test]
    fn pending_exports_stay_in_the_supplied_profile_root() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let first = write_pending_export_content(a.path(), "report.csv", b"profile a").unwrap();
        let second = write_pending_export_content(b.path(), "report.csv", b"profile b").unwrap();
        assert_eq!(
            fs::read(a.path().join(&first.relative_path)).unwrap(),
            b"profile a"
        );
        assert_eq!(
            fs::read(b.path().join(&second.relative_path)).unwrap(),
            b"profile b"
        );
        assert!(!b.path().join(&first.relative_path).exists());
        assert!(!a.path().join(&second.relative_path).exists());
    }

    #[test]
    fn internal_transfers_reject_other_roots_traversal_and_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let id = uuid::Uuid::new_v4();
        for path in [
            format!("profiles/{id}/app.db"),
            format!("pending-exports/{id}/../app.db"),
            format!("pending-exports/{id}/.."),
            "app.db".into(),
        ] {
            assert!(profile_transfer_path(dir.path(), &path).is_err());
        }
        let relative = format!("pending-exports/{id}/report.csv");
        assert_eq!(
            profile_transfer_path(dir.path(), &relative).unwrap(),
            dir.path().join(&relative)
        );
        #[cfg(unix)]
        {
            fs::create_dir(dir.path().join("pending-exports")).unwrap();
            std::os::unix::fs::symlink(
                dir.path(),
                dir.path().join(format!("pending-exports/{id}")),
            )
            .unwrap();
            assert!(profile_transfer_path(dir.path(), &relative).is_err());
        }
    }
}
