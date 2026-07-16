//! Traits for addon service operations.

use async_trait::async_trait;

use super::network::{AddonNetworkRequest, AddonNetworkResponse};
use super::{AddonManifest, AddonUpdateCheckResult, ExtractedAddon, InstalledAddon};

/// Service trait for addon business logic operations.
#[async_trait]
pub trait AddonServiceTrait: Send + Sync {
    // Installation operations
    async fn install_addon_zip(
        &self,
        zip_data: Vec<u8>,
        enable_after_install: bool,
        approved_network_hosts: Vec<String>,
    ) -> Result<AddonManifest, String>;

    async fn install_addon_from_staging(
        &self,
        addon_id: &str,
        enable_after_install: bool,
        approved_network_hosts: Vec<String>,
    ) -> Result<AddonManifest, String>;

    async fn uninstall_addon(&self, addon_id: &str) -> Result<(), String>;

    // Query operations
    fn list_installed_addons(&self) -> Result<Vec<InstalledAddon>, String>;

    fn load_addon_for_runtime(&self, addon_id: &str) -> Result<ExtractedAddon, String>;

    fn get_enabled_addons_on_startup(&self) -> Result<Vec<ExtractedAddon>, String>;

    // Update operations
    async fn check_addon_update(&self, addon_id: &str) -> Result<AddonUpdateCheckResult, String>;

    async fn check_all_addon_updates(&self) -> Result<Vec<AddonUpdateCheckResult>, String>;

    async fn update_addon_from_store(&self, addon_id: &str) -> Result<AddonManifest, String>;

    // Brokered network operations
    async fn addon_network_request(
        &self,
        addon_id: &str,
        request: AddonNetworkRequest,
    ) -> Result<AddonNetworkResponse, String>;

    fn update_addon_network_approvals(
        &self,
        addon_id: &str,
        approved_network_hosts: Vec<String>,
    ) -> Result<AddonManifest, String>;

    // Toggle operation
    fn toggle_addon(&self, addon_id: &str, enabled: bool) -> Result<(), String>;

    // Persistent per-addon key-value storage (survives addon updates,
    // removed on uninstall). Values are opaque strings owned by the addon.
    async fn get_addon_storage_item(
        &self,
        addon_id: &str,
        key: &str,
    ) -> Result<Option<String>, String>;

    async fn set_addon_storage_item(
        &self,
        addon_id: &str,
        key: &str,
        value: &str,
    ) -> Result<(), String>;

    async fn delete_addon_storage_item(&self, addon_id: &str, key: &str) -> Result<(), String>;

    async fn clear_addon_storage(&self, addon_id: &str) -> Result<(), String>;

    // Staging operations
    async fn download_addon_to_staging(&self, addon_id: &str) -> Result<ExtractedAddon, String>;

    fn clear_staging(&self, addon_id: Option<&str>) -> Result<(), String>;

    // Store operations
    async fn fetch_store_listings(&self) -> Result<Vec<serde_json::Value>, String>;

    async fn submit_rating(
        &self,
        addon_id: &str,
        rating: u8,
        review: Option<String>,
    ) -> Result<serde_json::Value, String>;

    // Utility operations
    fn extract_addon_zip(&self, zip_data: Vec<u8>) -> Result<ExtractedAddon, String>;
}
