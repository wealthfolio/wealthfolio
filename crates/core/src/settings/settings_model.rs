//! Settings domain models.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const INSIGHTS_OVERVIEW_LAYOUT_KEY: &str = "insights_overview_layout";
pub const CURRENCY_FORMATTING_REGIONS_KEY: &str = "currency_formatting_regions";
/// Selected theme (palette and shape). Device-local: sync shares only the keys it
/// lists. The frontend owns the theme list and shows Classic for an ID it does
/// not know, so an ID saved by a newer version survives an older one.
pub const THEME_ID_KEY: &str = "theme_id";
pub const DEFAULT_THEME_ID: &str = "classic";

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default = "default_theme_id")]
    pub theme_id: String,
    /// Appearance mode: light, dark or system.
    pub theme: String,
    pub font: String,
    pub language: String,
    pub formatting_region: String,
    /// Formatting regions for amounts in specific currencies, keyed by currency
    /// code. Other currencies follow `formatting_region`.
    #[serde(default)]
    pub currency_formatting_regions: BTreeMap<String, String>,
    pub base_currency: String,
    pub timezone: String,
    pub onboarding_completed: bool,
    pub auto_update_check_enabled: bool,
    pub menu_bar_visible: bool,
    pub sync_enabled: bool,
    /// Read-only restore state; clearing UI feedback must not authorize sync.
    #[serde(default)]
    pub restore_reconnect_required: bool,
    pub default_return_metric: String,
    /// Versioned dashboard preferences; the frontend validates the layout schema.
    #[serde(default)]
    pub insights_overview_layout: Option<serde_json::Map<String, serde_json::Value>>,
}

fn default_theme_id() -> String {
    DEFAULT_THEME_ID.to_string()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme_id: default_theme_id(),
            theme: "light".to_string(),
            font: "font-mono".to_string(),
            language: "en".to_string(),
            formatting_region: "system".to_string(),
            currency_formatting_regions: BTreeMap::new(),
            base_currency: "".to_string(),
            timezone: "".to_string(),
            onboarding_completed: false,
            auto_update_check_enabled: true,
            menu_bar_visible: true,
            sync_enabled: true,
            restore_reconnect_required: false,
            default_return_metric: "twr".to_string(),
            insights_overview_layout: None,
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SettingsUpdate {
    pub theme_id: Option<String>,
    pub theme: Option<String>,
    pub font: Option<String>,
    pub language: Option<String>,
    pub formatting_region: Option<String>,
    /// Replaces the whole map; an empty map removes every override.
    pub currency_formatting_regions: Option<BTreeMap<String, String>>,
    pub base_currency: Option<String>,
    pub timezone: Option<String>,
    pub onboarding_completed: Option<bool>,
    pub auto_update_check_enabled: Option<bool>,
    pub menu_bar_visible: Option<bool>,
    pub sync_enabled: Option<bool>,
    pub default_return_metric: Option<String>,
    pub insights_overview_layout: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Sort {
    pub id: String,
    pub desc: bool,
}

/// Domain model for app setting key-value pair
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppSetting {
    pub setting_key: String,
    pub setting_value: String,
}
