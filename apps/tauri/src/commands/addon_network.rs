use std::sync::Arc;

use crate::secret_store::KeyringSecretStore;
use tauri::{AppHandle, Manager, State};
use wealthfolio_core::addons::network::{
    resolve_addon_network_auth_header, AddonNetworkRequest, AddonNetworkResponse,
};
use wealthfolio_core::addons::{AddonService, AddonServiceTrait};

use crate::context::ServiceContext;

#[tauri::command]
pub async fn addon_network_request(
    app_handle: AppHandle,
    state: State<'_, Arc<ServiceContext>>,
    addon_id: String,
    mut request: AddonNetworkRequest,
) -> Result<AddonNetworkResponse, String> {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let injected_authorization =
        resolve_addon_network_auth_header(&addon_id, request.auth.as_ref(), &KeyringSecretStore)?;
    request.injected_authorization = injected_authorization;
    AddonService::new(
        app_data_dir,
        state.rating_instance_id.as_str(),
        state.addon_storage_repository.clone(),
    )
    .addon_network_request(&addon_id, request)
    .await
}
