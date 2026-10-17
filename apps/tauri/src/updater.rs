use std::sync::OnceLock;

use chrono::DateTime;
use log::{error, info, warn};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

// Helper function to detect if this is an App Store build
fn is_app_store_build() -> bool {
    cfg!(feature = "appstore")
}

/// How this install gets updates when the in-app updater must leave them alone.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ExternalUpdateSource {
    /// `WEALTHFOLIO_UPDATE_EXPLANATION` was set when building or launching the app.
    Packager { explanation: String },
    /// The app runs inside Flatpak.
    Flatpak,
    /// A .deb/.rpm build that dpkg/rpm didn't install, such as one repackaged
    /// for another distribution. Installing the update would add a second copy.
    PackageManager,
}

impl ExternalUpdateSource {
    /// English text for native dialogs and errors; the frontend shows its own translations.
    pub fn message(&self) -> &str {
        match self {
            Self::Packager { explanation } => explanation,
            Self::Flatpak => {
                "This copy of Wealthfolio was installed with Flatpak. Update it with Flatpak or your software center."
            }
            Self::PackageManager => {
                "This installation can't be updated from within Wealthfolio. Update it the same way you installed it."
            }
        }
    }
}

/// Returns how updates arrive when the in-app updater must not install them, or
/// `None` when it does. Detected once per launch; on Linux .deb/.rpm builds this
/// asks dpkg or rpm, so it runs on a blocking thread.
pub async fn external_update_source() -> Result<Option<ExternalUpdateSource>, String> {
    static SOURCE: OnceLock<Option<ExternalUpdateSource>> = OnceLock::new();
    tauri::async_runtime::spawn_blocking(|| {
        SOURCE.get_or_init(detect_external_update_source).clone()
    })
    .await
    .map_err(|e| format!("Failed to detect how updates are installed: {}", e))
}

fn detect_external_update_source() -> Option<ExternalUpdateSource> {
    if let Some(explanation) = packager_explanation(
        option_env!("WEALTHFOLIO_UPDATE_EXPLANATION"),
        std::env::var("WEALTHFOLIO_UPDATE_EXPLANATION").ok(),
    ) {
        return Some(ExternalUpdateSource::Packager { explanation });
    }

    if std::env::var_os("FLATPAK_ID").is_some() {
        return Some(ExternalUpdateSource::Flatpak);
    }
    if !package_manager_owns_binary() {
        return Some(ExternalUpdateSource::PackageManager);
    }

    None
}

/// A value set at build time wins over one set at launch. Blank values count as unset.
fn packager_explanation(build_time: Option<&str>, run_time: Option<String>) -> Option<String> {
    build_time
        .map(str::to_owned)
        .into_iter()
        .chain(run_time)
        .map(|value| value.trim().to_owned())
        .find(|value| !value.is_empty())
}

/// The updater installs .deb and .rpm updates with `dpkg -i` / `rpm -U`. That is
/// only safe when dpkg/rpm installed the running binary; other bundles pass.
fn package_manager_owns_binary() -> bool {
    use tauri::utils::config::BundleType;
    use tauri::utils::platform::{bundle_type, current_exe};

    let (program, flag) = match bundle_type() {
        Some(BundleType::Deb) => ("dpkg-query", "-S"),
        Some(BundleType::Rpm) => ("rpm", "-qf"),
        _ => return true,
    };
    current_exe().is_ok_and(|exe| package_owns_file(program, flag, &exe))
}

/// A query that fails, including one whose tool isn't installed, means no.
fn package_owns_file(program: &str, flag: &str, path: &std::path::Path) -> bool {
    use std::process::{Command, Stdio};

    Command::new(program)
        .arg(flag)
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

// Helper function to retrieve platform-specific store URLs
fn app_store_url() -> Option<&'static str> {
    #[cfg(target_os = "macos")]
    {
        Some("macappstore://apps.apple.com/app/6732888445")
    }

    #[cfg(target_os = "windows")]
    {
        Some("ms-windows-store://pdp/?productid=YOUR_PRODUCT_ID")
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        None
    }
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub notes: Option<String>,
    pub pub_date: Option<String>,
    pub is_app_store_build: bool,
    pub store_url: Option<String>,
    pub changelog_url: Option<String>,
    pub screenshots: Option<Vec<String>>,
}

/// Extract changelog_url from raw_json
fn extract_changelog_url(raw_json: &serde_json::Value) -> Option<String> {
    raw_json
        .get("changelog_url")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Extract screenshots from raw_json
fn extract_screenshots(raw_json: &serde_json::Value) -> Option<Vec<String>> {
    raw_json.get("screenshots").and_then(|v| {
        v.as_array().map(|arr| {
            arr.iter()
                .filter_map(|item| item.as_str().map(|s| s.to_string()))
                .collect()
        })
    })
}

/// Check for updates and return update info if available.
/// Returns `Ok(Some(UpdateInfo))` if an update is available,
/// `Ok(None)` if already up-to-date.
pub async fn check_for_update(app_handle: AppHandle) -> Result<Option<UpdateInfo>, String> {
    if let Some(source) = external_update_source().await? {
        return Err(source.message().to_string());
    }

    let is_appstore = is_app_store_build();

    let update = app_handle
        .updater_builder()
        .build()
        .map_err(|e| format!("Failed to build updater: {}", e))?
        .check()
        .await
        .map_err(|e| {
            warn!("Update check failed: {}", e);
            format!("Failed to check for updates: {}", e)
        })?;

    match update {
        Some(update) => {
            let current_version = app_handle.package_info().version.to_string();
            if update.version != current_version {
                let pub_date = update.date.and_then(|d| {
                    let seconds = d.unix_timestamp();
                    let nanos = d.nanosecond();
                    DateTime::from_timestamp(seconds, nanos).map(|dt| dt.to_rfc3339())
                });

                let changelog_url = extract_changelog_url(&update.raw_json);
                let screenshots = extract_screenshots(&update.raw_json);

                Ok(Some(UpdateInfo {
                    current_version,
                    latest_version: update.version.to_string(),
                    notes: update.body.clone(),
                    pub_date,
                    is_app_store_build: is_appstore,
                    store_url: app_store_url().map(|url| url.to_string()),
                    changelog_url,
                    screenshots,
                }))
            } else {
                Ok(None)
            }
        }
        None => Ok(None),
    }
}

/// Progress payload emitted during update download/install.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct UpdateDownloadProgress {
    downloaded: u64,
    total: Option<u64>,
    /// "downloading" or "installing"
    phase: String,
}

/// Download and install an available update, then restart the app.
/// Emits `app:update-download-progress` events so the frontend can show progress.
/// Returns `Err` on failure so the frontend can display the error inline.
pub async fn install_update(app_handle: AppHandle) -> Result<(), String> {
    if let Some(source) = external_update_source().await? {
        return Err(source.message().to_string());
    }

    info!("Starting update download and installation");

    let update = match app_handle.updater_builder().build() {
        Ok(updater) => match updater.check().await {
            Ok(Some(update)) => update,
            Ok(None) => return Err("No update available.".to_string()),
            Err(e) => {
                error!("Failed to check for updates: {}", e);
                return Err(format!("Failed to check for updates: {}", e));
            }
        },
        Err(e) => {
            error!("Failed to build updater: {}", e);
            return Err(format!("Failed to initialize updater: {}", e));
        }
    };

    info!(
        "Downloading update from version {} to {}",
        update.current_version, update.version
    );

    let handle_chunk = app_handle.clone();
    let handle_finish = app_handle.clone();
    let mut downloaded: u64 = 0;

    match update
        .download_and_install(
            move |chunk_len, content_len| {
                downloaded += chunk_len as u64;
                let _ = handle_chunk.emit(
                    "app:update-download-progress",
                    UpdateDownloadProgress {
                        downloaded,
                        total: content_len,
                        phase: "downloading".to_string(),
                    },
                );
            },
            move || {
                let _ = handle_finish.emit(
                    "app:update-download-progress",
                    UpdateDownloadProgress {
                        downloaded: 0,
                        total: None,
                        phase: "installing".to_string(),
                    },
                );
            },
        )
        .await
    {
        Ok(_) => {
            info!("Update installed successfully, restarting");
            // `restart` would park this async worker; see finish_database_maintenance.
            app_handle.request_restart();
            Ok(())
        }
        Err(e) => {
            error!("Failed to download and install update: {}", e);
            Err(format!("Failed to install update: {}", e))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packager_explanation_prefers_build_time_value() {
        assert_eq!(
            packager_explanation(Some("Use pacman."), Some("Use apt.".to_string())),
            Some("Use pacman.".to_string())
        );
    }

    #[test]
    fn packager_explanation_falls_back_to_run_time_value() {
        assert_eq!(
            packager_explanation(None, Some("  Use apt.\n".to_string())),
            Some("Use apt.".to_string())
        );
        assert_eq!(
            packager_explanation(Some(" "), Some("Use apt.".to_string())),
            Some("Use apt.".to_string())
        );
    }

    #[test]
    fn packager_explanation_ignores_blank_values() {
        assert_eq!(packager_explanation(None, None), None);
        assert_eq!(packager_explanation(Some(""), Some("\t".to_string())), None);
    }

    #[test]
    fn external_update_source_serializes_for_the_frontend() {
        assert_eq!(
            serde_json::to_value(ExternalUpdateSource::Packager {
                explanation: "Use pacman.".to_string()
            })
            .expect("serializes"),
            serde_json::json!({ "kind": "packager", "explanation": "Use pacman." })
        );
        assert_eq!(
            serde_json::to_value(ExternalUpdateSource::Flatpak).expect("serializes"),
            serde_json::json!({ "kind": "flatpak" })
        );
        assert_eq!(
            serde_json::to_value(ExternalUpdateSource::PackageManager).expect("serializes"),
            serde_json::json!({ "kind": "packageManager" })
        );
    }

    #[cfg(unix)]
    #[test]
    fn package_owns_file_needs_a_successful_query() {
        let path = std::path::Path::new("/usr/bin/wealthfolio");
        assert!(package_owns_file("true", "-S", path));
        assert!(!package_owns_file("false", "-S", path));
        assert!(!package_owns_file(
            "wealthfolio-missing-package-tool",
            "-S",
            path
        ));
    }
}
