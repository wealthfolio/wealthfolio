use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[derive(Default)]
pub struct SpendingSettings {
    pub enabled: bool,
    pub account_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpendingSettingsUpdate {
    pub enabled: Option<bool>,
    pub account_ids: Option<Vec<String>>,
}
