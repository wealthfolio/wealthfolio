use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AddonFile {
    pub name: String,
    pub content: String,
    pub is_main: bool,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FunctionPermission {
    /// Function name
    pub name: String,
    /// Whether this function was declared by the developer in manifest
    pub is_declared: bool,
    /// Whether this function was detected by static analysis during installation
    pub is_detected: bool,
    /// ISO timestamp when this function was detected (if is_detected is true)
    pub detected_at: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AddonPermission {
    pub category: String,
    pub functions: Vec<FunctionPermission>,
    pub purpose: String,
}

/// A durable addon page declared via `contributes.routes`. Ingested at boot
/// without executing addon code — the lazy-activation surface.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AddonContributedRoute {
    pub id: String,
    /// Optional suffix below the host-owned `/addons/<addon-id>` mount.
    /// `None` represents the addon root.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

/// A placement in a host slot (e.g. `"sidebar"`) declared via
/// `contributes.links`, pointing at a declared route of the same addon.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AddonContributedLink {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub route: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub order: Option<i32>,
}

/// Declarative contributions an addon makes to the host: durable routes plus
/// links placed in host slots (map keyed by slot id; BTreeMap keeps
/// serialization deterministic). Unknown slot keys round-trip untouched —
/// they're future host surfaces.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AddonContributes {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub routes: Vec<AddonContributedRoute>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub links: BTreeMap<String, Vec<AddonContributedLink>>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AddonNetworkAccess {
    pub allowed_hosts: Vec<String>,
    #[serde(default)]
    pub approved_hosts: Vec<String>,
}

/// Unified addon manifest structure that handles both development and runtime scenarios
/// This represents both what developers write in their manifest.json and installed addon metadata
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AddonManifest {
    // Core manifest fields (always present)
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: Option<String>,
    pub author: Option<String>,
    #[serde(rename = "sdkVersion")]
    pub sdk_version: Option<String>,
    pub main: Option<String>, // Optional in development, required after installation
    pub enabled: Option<bool>, // Optional in development, required after installation
    pub permissions: Option<Vec<AddonPermission>>,
    pub homepage: Option<String>,
    pub repository: Option<String>,
    pub license: Option<String>,
    #[serde(rename = "minWealthfolioVersion")]
    pub min_wealthfolio_version: Option<String>,
    pub keywords: Option<Vec<String>>,
    pub icon: Option<String>,
    pub network: Option<AddonNetworkAccess>,
    #[serde(rename = "hostDependencies")]
    pub host_dependencies: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contributes: Option<AddonContributes>,

    // Runtime fields (only present after installation)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>, // 'local' | 'store' | 'sideload'
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

impl AddonManifest {
    /// Convert to installed manifest by adding runtime fields
    pub fn to_installed(mut self, enable_after_install: bool) -> Result<Self, String> {
        // Validate required fields for installation
        if self.main.is_none() {
            return Err("Missing 'main' field in manifest.json".to_string());
        }

        // Set runtime fields
        self.enabled = Some(enable_after_install);
        self.installed_at = Some(chrono::Utc::now().to_rfc3339());
        self.source = Some("local".to_string());

        Ok(self)
    }

    /// Get the main file path, returning an error if not set
    pub fn get_main(&self) -> Result<&str, String> {
        self.main
            .as_deref()
            .ok_or("Main file not specified".to_string())
    }

    /// Get the enabled status, defaulting to true if not set
    pub fn is_enabled(&self) -> bool {
        self.enabled.unwrap_or(true)
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedAddon {
    pub metadata: AddonManifest,
    pub files: Vec<AddonFile>,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledAddon {
    pub metadata: AddonManifest,
    pub file_path: String,
    pub is_zip_addon: bool,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AddonStoreListing {
    pub metadata: AddonManifest,
    pub download_url: String,
    pub sha256: Option<String>,
    pub downloads: Option<u32>,
    pub rating: Option<f32>,
    pub review_count: Option<u32>,
    pub verified: Option<bool>,
    pub last_updated: Option<String>,
    pub images: Option<Vec<String>>,
    pub release_notes: Option<String>,
    pub changelog_url: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AddonUpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub update_available: bool,
    pub download_url: Option<String>,
    pub sha256: Option<String>,
    pub release_notes: Option<String>,
    pub release_date: Option<String>,
    pub changelog_url: Option<String>,
    pub is_critical: Option<bool>,
    pub has_breaking_changes: Option<bool>,
    pub min_wealthfolio_version: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AddonUpdateCheckResult {
    pub addon_id: String,
    pub update_info: AddonUpdateInfo,
    pub error: Option<String>,
}

/// Helper functions for working with function-level permissions
/// Get all declared functions from a permission
#[allow(dead_code)]
pub fn get_declared_functions(permission: &AddonPermission) -> Vec<String> {
    permission
        .functions
        .iter()
        .filter(|func| func.is_declared)
        .map(|func| func.name.clone())
        .collect()
}

/// Get all detected functions from a permission
#[allow(dead_code)]
pub fn get_detected_functions(permission: &AddonPermission) -> Vec<String> {
    permission
        .functions
        .iter()
        .filter(|func| func.is_detected)
        .map(|func| func.name.clone())
        .collect()
}

/// Get functions that were detected but not declared (potential security concern)
#[allow(dead_code)]
pub fn get_undeclared_detected_functions(permission: &AddonPermission) -> Vec<String> {
    permission
        .functions
        .iter()
        .filter(|func| func.is_detected && !func.is_declared)
        .map(|func| func.name.clone())
        .collect()
}

/// Check if a permission has any undeclared detected functions
#[allow(dead_code)]
pub fn has_undeclared_detected_functions(permission: &AddonPermission) -> bool {
    permission
        .functions
        .iter()
        .any(|func| func.is_detected && !func.is_declared)
}
