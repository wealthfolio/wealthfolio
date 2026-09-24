//! Startup recovery must remain available before a profile registry can be opened.
use crate::{context::ServiceContext, profiles::NativeProfiles};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

pub struct ProfileStartup {
    app_data_dir: String,
    identifier: String,
    error: Mutex<Option<String>>,
    initialization: tokio::sync::Mutex<()>,
}

impl ProfileStartup {
    pub fn new(app_data_dir: String, identifier: String) -> Self {
        Self {
            app_data_dir,
            identifier,
            error: Mutex::new(None),
            initialization: tokio::sync::Mutex::new(()),
        }
    }

    pub fn error(&self) -> Result<Option<String>, String> {
        self.error
            .lock()
            .map(|error| error.clone())
            .map_err(|_| "Profile startup status is unavailable.".into())
    }

    pub async fn initialize(
        &self,
        handle: &AppHandle,
    ) -> Result<Option<Arc<ServiceContext>>, String> {
        self.open(handle, false).await
    }

    async fn open(
        &self,
        handle: &AppHandle,
        start_new: bool,
    ) -> Result<Option<Arc<ServiceContext>>, String> {
        let _initialization = self.initialization.lock().await;
        if let Some(profiles) = handle.try_state::<NativeProfiles>() {
            if start_new {
                return Err("Profiles are already available. Try opening the app again.".into());
            }
            return Ok(profiles.try_context());
        }
        let root = self.app_data_dir.clone();
        let identifier = self.identifier.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            if start_new {
                NativeProfiles::start_new(root, &identifier)
            } else {
                NativeProfiles::new(root, &identifier)
            }
        })
        .await
        .map_err(|_| "Profile initialization failed.".to_string())
        .and_then(|result| result);
        *self
            .error
            .lock()
            .map_err(|_| "Profile startup status is unavailable.")? =
            result.as_ref().err().cloned();
        handle.manage(result?);
        handle.state::<NativeProfiles>().startup(handle).await
    }
}

#[tauri::command]
pub async fn start_new_profile_setup(
    handle: AppHandle,
    startup: tauri::State<'_, ProfileStartup>,
) -> Result<crate::profiles::ProfileState, String> {
    startup.open(&handle, true).await?;
    handle.state::<NativeProfiles>().state()
}

#[tauri::command]
pub async fn retry_profile_startup(
    handle: AppHandle,
    startup: tauri::State<'_, ProfileStartup>,
) -> Result<(), String> {
    let result = startup.initialize(&handle).await.map(|_| ());
    crate::events::emit_app_ready(&handle);
    result
}

#[tauri::command]
pub fn open_profile_data_folder(
    handle: AppHandle,
    startup: tauri::State<'_, ProfileStartup>,
) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;
    // Resolve the same development override as NativeProfiles::new. Never accept
    // a renderer-supplied path or require an admitted profile for recovery.
    let root = crate::data_dir::development_override(std::env::var_os("WF_DATA_DIR"))?
        .unwrap_or_else(|| std::path::PathBuf::from(&startup.app_data_dir));
    #[allow(deprecated)]
    handle
        .shell()
        .open(root.to_string_lossy(), None)
        .map_err(|_| "Could not open the data folder.".into())
}
