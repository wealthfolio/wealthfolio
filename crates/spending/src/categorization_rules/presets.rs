//! Rule presets — country-specific JSON bundles of categorization rules that
//! the user can seed into their DB on first run. Files live in
//! `crates/spending/seeds/presets/{country}.json` and are embedded at compile
//! time via `include_str!`.
//!
//! Each preset has:
//!   - a stable `presetId` (e.g. "us", "ca", "gb")
//!   - a `presetVersion` (used by future diff/update flows)
//!   - rules with their own stable `key` so we can identify them across versions
//!   - a `categoryKey` that resolves to a seeded category at import time

use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// Shape of a `*.json` preset file on disk.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RulePreset {
    pub preset_id: String,
    pub preset_version: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub language: Option<String>,
    pub rules: Vec<PresetRule>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetRule {
    pub key: String,
    pub name: String,
    pub pattern: String,
    pub match_type: String,
    /// Seeded category key (e.g. "food_groceries"). Resolved to (taxonomy_id, category_id) at import time.
    pub category_key: String,
    #[serde(default)]
    pub priority: i32,
}

/// Light-weight summary returned to the UI for picker rendering.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RulePresetSummary {
    pub preset_id: String,
    pub preset_version: String,
    pub name: String,
    pub description: Option<String>,
    pub language: Option<String>,
    pub rule_count: usize,
    /// True iff the user already has at least one rule from this preset installed.
    pub installed: bool,
    /// The version of the user's installed copy (NULL if `installed=false`).
    pub installed_version: Option<String>,
}

/// Result returned from `import_preset`.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPresetResult {
    pub preset_id: String,
    pub preset_version: String,
    pub added: usize,
    /// Existing unmodified preset rules upgraded to this preset version.
    pub updated: usize,
    /// Already-installed rules (matched by `preset_id` + `preset_rule_key`).
    pub skipped_existing: usize,
    /// Rules whose `categoryKey` could not be resolved to a seeded category.
    pub skipped_unknown_category: usize,
    pub total: usize,
}

/// Result returned from `remove_preset`.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovePresetResult {
    pub preset_id: String,
    /// Number of preset rules deleted (unmodified rules).
    pub removed: usize,
    /// Number of preset rules detached (user-modified — kept as standalone rules).
    pub kept_modified: usize,
}

/// Compile-embedded preset JSONs. Add new countries by dropping a JSON file
/// in `crates/spending/seeds/presets/` and adding an entry here.
const PRESET_JSONS: &[(&str, &str)] = &[
    ("us", include_str!("../../seeds/presets/us.json")),
    ("ca", include_str!("../../seeds/presets/ca.json")),
    ("gb", include_str!("../../seeds/presets/gb.json")),
    ("es", include_str!("../../seeds/presets/es.json")),
];

/// Parse all bundled presets. Bad JSON (or schema-mismatched files) is logged
/// and skipped — never panics so a single broken preset can't take down the app.
pub fn load_all_presets() -> Vec<RulePreset> {
    PRESET_JSONS
        .iter()
        .filter_map(
            |(id, json)| match serde_json::from_str::<RulePreset>(json) {
                Ok(p) => Some(p),
                Err(e) => {
                    log::warn!("Failed to parse rule preset '{id}': {e}");
                    None
                }
            },
        )
        .collect()
}

pub fn load_preset(preset_id: &str) -> Option<RulePreset> {
    PRESET_JSONS
        .iter()
        .find(|(id, _)| *id == preset_id)
        .and_then(|(_, json)| serde_json::from_str(json).ok())
}

/// Build a "preset_id" → max(installed_version) lookup so the picker can mark
/// installed presets and surface the version users have.
pub fn installed_versions<'a>(
    rules: impl Iterator<Item = (&'a Option<String>, &'a Option<String>)>,
) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::<String, String>::new();
    for (preset_id, preset_version) in rules {
        if let (Some(id), Some(version)) = (preset_id, preset_version) {
            // Last-write wins; presets are typically uniform per preset_id so this is fine.
            out.insert(id.clone(), version.clone());
        }
    }
    out
}

/// Set of (preset_id, preset_rule_key) pairs the user already has installed.
pub fn installed_rule_keys<'a>(
    rules: impl Iterator<Item = (&'a Option<String>, &'a Option<String>)>,
) -> HashSet<(String, String)> {
    rules
        .filter_map(|(p, k)| match (p, k) {
            (Some(p), Some(k)) => Some((p.clone(), k.clone())),
            _ => None,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::categorization_rules::RuleMatchType;
    use regex::Regex;

    #[test]
    fn bundled_presets_have_unique_keys_and_valid_regexes() {
        for preset_id in ["us", "ca", "gb", "es"] {
            let preset = load_preset(preset_id).expect("preset should load");
            assert_eq!(preset.preset_id, preset_id);
            assert!(!preset.rules.is_empty(), "preset {preset_id} has no rules");

            let mut keys = HashSet::new();
            for rule in &preset.rules {
                assert!(
                    keys.insert(rule.key.as_str()),
                    "duplicate preset rule key {} in {}",
                    rule.key,
                    preset.preset_id
                );
                assert!(
                    !rule.category_key.trim().is_empty(),
                    "rule {} has an empty categoryKey",
                    rule.key
                );
                assert!(
                    RuleMatchType::try_parse(&rule.match_type).is_some(),
                    "unknown matchType {} in preset {} rule {}",
                    rule.match_type,
                    preset.preset_id,
                    rule.key
                );
                if rule.match_type == "regex" {
                    Regex::new(&rule.pattern).unwrap_or_else(|err| {
                        panic!(
                            "invalid regex in preset {} rule {}: {}",
                            preset.preset_id, rule.key, err
                        )
                    });
                }
            }
        }
    }
}
