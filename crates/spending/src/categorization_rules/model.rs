use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuleMatchType {
    Contains,
    StartsWith,
    Exact,
    Regex,
}

impl RuleMatchType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Contains => "contains",
            Self::StartsWith => "starts_with",
            Self::Exact => "exact",
            Self::Regex => "regex",
        }
    }
    pub fn try_parse(s: &str) -> Option<Self> {
        match s {
            "contains" => Some(Self::Contains),
            "starts_with" => Some(Self::StartsWith),
            "exact" => Some(Self::Exact),
            "regex" => Some(Self::Regex),
            _ => None,
        }
    }
    pub fn parse(s: &str) -> Self {
        Self::try_parse(s).unwrap_or(Self::Contains)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategorizationRule {
    pub id: String,
    pub name: String,
    pub pattern: String,
    pub match_type: RuleMatchType,
    pub taxonomy_id: Option<String>,
    pub category_id: Option<String>,
    pub activity_type: Option<String>,
    pub priority: i32,
    pub is_global: bool,
    pub account_id: Option<String>,
    /// Preset provenance (NULL for user-created rules).
    pub preset_id: Option<String>,
    pub preset_rule_key: Option<String>,
    pub preset_version: Option<String>,
    /// True iff the user has edited a preset-sourced rule (drives the
    /// "keep yours / use new" prompt during preset updates).
    pub preset_modified: bool,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewCategorizationRule {
    pub id: Option<String>,
    pub name: String,
    pub pattern: String,
    #[serde(default = "default_match_type")]
    pub match_type: RuleMatchType,
    pub taxonomy_id: Option<String>,
    pub category_id: Option<String>,
    pub activity_type: Option<String>,
    #[serde(default)]
    pub priority: i32,
    #[serde(default = "default_true")]
    pub is_global: bool,
    pub account_id: Option<String>,
    /// Set by the preset import path; user-facing rule creation leaves these None.
    pub preset_id: Option<String>,
    pub preset_rule_key: Option<String>,
    pub preset_version: Option<String>,
}

fn default_match_type() -> RuleMatchType {
    RuleMatchType::Contains
}
fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCategorizationRule {
    pub name: Option<String>,
    pub pattern: Option<String>,
    pub match_type: Option<RuleMatchType>,
    #[serde(default, deserialize_with = "deserialize_optional_string")]
    pub taxonomy_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_optional_string")]
    pub category_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_optional_string")]
    pub activity_type: Option<Option<String>>,
    pub priority: Option<i32>,
    pub is_global: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_optional_string")]
    pub account_id: Option<Option<String>>,
}

fn deserialize_optional_string<'de, D>(deserializer: D) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn try_parse_rejects_unknown_match_type() {
        assert_eq!(
            RuleMatchType::try_parse("contains"),
            Some(RuleMatchType::Contains)
        );
        assert_eq!(
            RuleMatchType::try_parse("regex"),
            Some(RuleMatchType::Regex)
        );
        assert_eq!(RuleMatchType::try_parse("glob"), None);
    }

    #[test]
    fn update_rule_preserves_explicit_null_nullable_fields() {
        let patch: UpdateCategorizationRule = serde_json::from_value(serde_json::json!({
            "taxonomyId": null,
            "categoryId": null,
            "activityType": null,
            "accountId": null
        }))
        .expect("deserialize patch");

        assert_eq!(patch.taxonomy_id, Some(None));
        assert_eq!(patch.category_id, Some(None));
        assert_eq!(patch.activity_type, Some(None));
        assert_eq!(patch.account_id, Some(None));
    }

    #[test]
    fn update_rule_keeps_omitted_nullable_fields_as_none() {
        let patch: UpdateCategorizationRule =
            serde_json::from_value(serde_json::json!({})).expect("deserialize patch");

        assert_eq!(patch.taxonomy_id, None);
        assert_eq!(patch.category_id, None);
        assert_eq!(patch.activity_type, None);
        assert_eq!(patch.account_id, None);
    }
}
