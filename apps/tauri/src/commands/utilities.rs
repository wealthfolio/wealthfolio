use chrono;
use serde::Serialize;
use std::fs;
use std::path::Path;
use tauri::Manager;
use tauri::{AppHandle, Emitter};
use wealthfolio_storage_sqlite::db;

use crate::context::ServiceContext;
#[cfg(desktop)]
use crate::updater::{check_for_update, install_update};

const PENDING_EXPORTS_DIR: &str = "pending-exports";

/// Normalize file path by removing file:// URI prefix if present (iOS/Android compatibility)
fn normalize_file_path(path: &str) -> String {
    if path.starts_with("file://") {
        path.strip_prefix("file://").unwrap_or(path).to_string()
    } else {
        path.to_string()
    }
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
pub struct BackupExport {
    relative_path: String,
    filename: String,
}

#[tauri::command]
pub async fn get_app_info(app_handle: AppHandle) -> Result<AppInfo, String> {
    let version = app_handle.package_info().version.to_string();

    let app_data_dir_path = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?
        .to_path_buf();

    let app_data_dir = app_data_dir_path
        .to_str()
        .ok_or_else(|| "Failed to convert app data dir path to string".to_string())?
        .to_string();

    let db_path = db::get_db_path(&app_data_dir);
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
        let instance_id = app_handle
            .try_state::<std::sync::Arc<ServiceContext>>()
            .map(|state| state.instance_id.clone())
            .ok_or_else(|| "Failed to access service context".to_string())?;

        let result = check_for_update(app_handle, &instance_id).await?;
        Ok(result.map(|info| serde_json::to_value(info).unwrap()))
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

#[tauri::command]
pub async fn backup_database(app_handle: AppHandle) -> Result<String, String> {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .expect("failed to get app data dir")
        .to_str()
        .expect("failed to convert path to string")
        .to_string();

    let backup_path = db::backup_database(&app_data_dir).map_err(|e| e.to_string())?;

    Ok(Path::new(&backup_path)
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Failed to get backup filename".to_string())?
        .to_string())
}

#[tauri::command]
pub async fn backup_database_to_pending_export(
    app_handle: AppHandle,
) -> Result<BackupExport, String> {
    let app_data_dir_path = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    let app_data_dir = app_data_dir_path
        .to_str()
        .ok_or_else(|| "Failed to convert app data dir to string".to_string())?
        .to_string();

    let filename = format!(
        "wealthfolio_backup_{}.db",
        chrono::Local::now().format("%Y%m%d_%H%M%S_%3f")
    );
    let export_dir = app_data_dir_path.join(PENDING_EXPORTS_DIR);
    if export_dir.exists() {
        fs::remove_dir_all(&export_dir)
            .map_err(|e| format!("Failed to clean pending export directory: {}", e))?;
    }
    fs::create_dir_all(&export_dir)
        .map_err(|e| format!("Failed to create pending export directory: {}", e))?;

    let backup_path = export_dir.join(&filename);
    let backup_path_str = backup_path
        .to_str()
        .ok_or_else(|| "Failed to convert backup export path to string".to_string())?
        .to_string();

    db::backup_database_to_file(&app_data_dir, &backup_path_str)
        .map_err(|e| format!("Failed to create backup export: {}", e))?;

    Ok(BackupExport {
        relative_path: format!("{}/{}", PENDING_EXPORTS_DIR, filename),
        filename,
    })
}

#[tauri::command]
pub async fn backup_database_to_path(
    app_handle: AppHandle,
    backup_dir: String,
) -> Result<String, String> {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .expect("failed to get app data dir")
        .to_str()
        .expect("failed to convert path to string")
        .to_string();

    // Normalize the backup directory path (remove file:// prefix if present on iOS/Android)
    let normalized_backup_dir = normalize_file_path(&backup_dir);

    // Create a custom backup path in the specified directory
    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
    let backup_filename = format!("wealthfolio_backup_{}.db", timestamp);
    let backup_path = Path::new(&normalized_backup_dir).join(&backup_filename);

    let backup_path_str = backup_path.to_string_lossy().to_string();

    db::backup_database_to_file(&app_data_dir, &backup_path_str)
        .map_err(|e| format!("Failed to backup database: {}", e))?;

    Ok(backup_path_str)
}

#[tauri::command]
pub async fn restore_database(
    app_handle: AppHandle,
    backup_file_path: String,
) -> Result<(), String> {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .expect("failed to get app data dir")
        .to_str()
        .expect("failed to convert path to string")
        .to_string();

    // Normalize the backup file path (remove file:// prefix if present on iOS/Android)
    let normalized_backup_path = normalize_file_path(&backup_file_path);

    // Try to get the ServiceContext to perform graceful operations before restore
    if app_handle
        .try_state::<std::sync::Arc<crate::context::ServiceContext>>()
        .is_some()
    {
        // Give some time for any pending operations to complete
        tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;
    }

    // Use the safe restore function that handles Windows file locking issues
    db::restore_database_safe(&app_data_dir, &normalized_backup_path).map_err(|e| e.to_string())?;

    // After successful restore, emit event and show restart dialog
    app_handle
        .emit("database-restored", ())
        .map_err(|e| format!("Failed to emit database-restored event: {}", e))?;

    // On desktop builds prompt for restart, but skip showing dialogs on iOS/Android
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

        let should_restart = app_handle
            .dialog()
            .message(
                "Database restored successfully!\n\n\
                 For the best experience, it's recommended to restart the application \
                 to ensure all data is properly refreshed.\n\n\
                 Would you like to restart now?",
            )
            .title("Database Restored - Restart Required")
            .buttons(MessageDialogButtons::OkCancel)
            .kind(MessageDialogKind::Info)
            .blocking_show();

        if should_restart {
            app_handle.restart();
        }
    }

    Ok(())
}
