use crate::profiles::ProfileAccess;

use tauri::AppHandle;
use wealthfolio_core::addons::network::{
    resolve_addon_network_auth_header, AddonNetworkRequest, AddonNetworkResponse,
};
use wealthfolio_core::addons::{AddonManifest, AddonServiceTrait};

#[tauri::command]
pub async fn addon_network_request(
    _app_handle: AppHandle,
    state: ProfileAccess,
    addon_id: String,
    mut request: AddonNetworkRequest,
) -> Result<AddonNetworkResponse, String> {
    let context = state.context()?;
    let injected_authorization = resolve_addon_network_auth_header(
        &addon_id,
        request.auth.as_ref(),
        context.secret_store.as_ref(),
    )?;
    request.injected_authorization = injected_authorization;
    context
        .addon_service
        .addon_network_request(&addon_id, request)
        .await
}

/// Lets the addon dev loader authorize brokered network requests for an addon
/// served by a local dev server. Debug builds only: release builds require
/// the addon to be installed and its hosts approved.
#[tauri::command]
pub async fn register_dev_addon_manifest(
    state: ProfileAccess,
    manifest: AddonManifest,
) -> Result<(), String> {
    if !cfg!(debug_assertions) {
        return Err("Dev addon registration is only available in debug builds".to_string());
    }
    state
        .context()?
        .addon_service
        .register_dev_addon_manifest(manifest)
}
