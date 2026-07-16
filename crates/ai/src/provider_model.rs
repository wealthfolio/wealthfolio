//! AI provider domain models.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Preserve the distinction between an omitted update field and an explicit
/// `null`, which clears the stored value.
fn deserialize_nullable_update<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

/// Current schema version for AI provider settings.
/// Increment when making breaking changes to the settings structure.
///
/// History:
/// - v1: initial (enabled/favorite/model/url/priority/capability_overrides/tools_allowlist)
/// - v2: adds ProviderUserSettings.tuning_overrides (purely additive, safe migration)
pub const AI_PROVIDER_SETTINGS_SCHEMA_VERSION: u32 = 2;

/// The app_settings key used to store AI provider settings.
pub const AI_PROVIDER_SETTINGS_KEY: &str = "ai_provider_settings";

// ============================================================================
// Catalog Types (read from JSON, immutable)
// ============================================================================

/// Model capabilities from the catalog.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModelCapabilities {
    pub tools: bool,
    pub thinking: bool,
    pub vision: bool,
    /// Whether the model supports streaming responses.
    #[serde(default = "default_streaming")]
    pub streaming: bool,
}

fn default_streaming() -> bool {
    true // Most models support streaming by default
}

/// A single model definition from the catalog.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogModel {
    pub capabilities: ModelCapabilities,
}

/// Connection field definition for provider configuration UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionField {
    pub key: String,
    pub label: String,
    #[serde(rename = "type")]
    pub field_type: String,
    pub placeholder: String,
    pub required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub help_url: Option<String>,
}

/// Default configuration from the catalog.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProviderDefaultConfig {
    pub enabled: bool,
    #[serde(default = "default_priority")]
    pub priority: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

/// Per-provider generation tuning defaults (catalog-defined).
///
/// These are sensible sampling defaults per provider that can be partially
/// overridden by the user via `ProviderTuningOverrides`. Fields left as `None`
/// fall through to the provider's own defaults.
///
/// Validation bounds (enforced when user-supplied overrides are persisted):
/// - `temperature`: 0.0 ..= 2.0
/// - `max_tokens` / `max_tokens_thinking`: 256 ..= 131_072
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTuning {
    /// Sampling temperature. Lower values = more deterministic output.
    /// Typical range for tool-calling workloads: 0.0–0.3.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    /// Maximum output tokens per response. Safety cap — model generates up to
    /// this many tokens, then stops. Pay for actual tokens generated.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u64>,
    /// Max tokens when the model's thinking/reasoning mode is enabled. Thinking
    /// tokens count against max_tokens on most APIs, so this should be larger.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens_thinking: Option<u64>,
    /// Provider-specific raw JSON merged into the additional_params blob sent
    /// to the underlying API (e.g. Ollama's `num_ctx`/`repeat_penalty`,
    /// Gemini's `safetySettings`). Catalog-only — users cannot override these
    /// via the UI to avoid exposing too much surface area.
    #[serde(default, skip_serializing_if = "value_is_null_or_empty_object")]
    pub extra_options: serde_json::Value,
}

fn value_is_null_or_empty_object(v: &serde_json::Value) -> bool {
    match v {
        serde_json::Value::Null => true,
        serde_json::Value::Object(m) => m.is_empty(),
        _ => false,
    }
}

/// User-provided overrides of provider tuning. Any field left `None`/empty
/// uses the catalog default.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTuningOverrides {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens_thinking: Option<u64>,
    /// Per-key overrides of the catalog's `extra_options`. The UI only
    /// exposes keys that exist in the catalog and are primitive (number,
    /// boolean, string). Complex shapes (arrays, objects — e.g. Gemini's
    /// `safetySettings`) remain catalog-only.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub extra_option_overrides: HashMap<String, serde_json::Value>,
}

impl ProviderTuningOverrides {
    /// Remove provider-specific overrides that should not reach runtime params.
    pub fn sanitized_for_provider(mut self, provider_id: &str) -> Self {
        if provider_id == "anthropic" {
            // Claude rejects top_k/top_p on current Anthropic models. Users may
            // still have these as orphaned overrides from older catalogs, so
            // drop them before merging to avoid rebuilding unsupported params.
            self.extra_option_overrides.remove("top_k");
            self.extra_option_overrides.remove("top_p");
        }
        self
    }

    /// Whether every field is empty — in which case this override is a no-op
    /// and should be cleared from the user settings to keep things tidy.
    pub fn is_empty(&self) -> bool {
        self.temperature.is_none()
            && self.max_tokens.is_none()
            && self.max_tokens_thinking.is_none()
            && self.extra_option_overrides.is_empty()
    }

    /// Validate user-supplied values against safe bounds. Returns the offending
    /// field name + reason on the first failure so the error can be surfaced
    /// in the UI toast.
    pub fn validate(&self) -> Result<(), String> {
        if let Some(t) = self.temperature {
            if !(0.0..=2.0).contains(&t) || t.is_nan() {
                return Err(format!(
                    "temperature must be between 0.0 and 2.0 (got {})",
                    t
                ));
            }
        }
        if let Some(m) = self.max_tokens {
            if !(256..=131_072).contains(&m) {
                return Err(format!(
                    "maxTokens must be between 256 and 131072 (got {})",
                    m
                ));
            }
        }
        if let Some(m) = self.max_tokens_thinking {
            if !(256..=131_072).contains(&m) {
                return Err(format!(
                    "maxTokensThinking must be between 256 and 131072 (got {})",
                    m
                ));
            }
        }
        // extra_option_overrides must be primitive values only (JSON number,
        // bool, or string). Nested shapes are catalog-only to keep the UI/API
        // surface narrow and prevent users from clobbering structured options
        // like Gemini's `safetySettings`.
        for (key, value) in &self.extra_option_overrides {
            match value {
                serde_json::Value::Number(_)
                | serde_json::Value::Bool(_)
                | serde_json::Value::String(_)
                | serde_json::Value::Null => {}
                serde_json::Value::Array(_) | serde_json::Value::Object(_) => {
                    return Err(format!(
                        "extraOptionOverrides.{}: arrays and objects are not user-editable \
                         (catalog-only)",
                        key
                    ));
                }
            }
        }
        Ok(())
    }
}

impl ProviderTuning {
    /// Merge user overrides on top of catalog defaults. Scalar fields fall
    /// through to the catalog value when the override is `None`.
    /// `extra_options` is merged per-key: user overrides replace catalog
    /// values for keys they set, but unsupplied keys keep the catalog value.
    /// Complex catalog shapes (arrays, objects) are preserved untouched —
    /// user overrides must be primitives (enforced at `validate()`).
    pub fn apply_overrides(&self, overrides: &ProviderTuningOverrides) -> Self {
        let mut extra_options = self.extra_options.clone();
        if !overrides.extra_option_overrides.is_empty() {
            if !matches!(extra_options, serde_json::Value::Object(_)) {
                extra_options = serde_json::Value::Object(serde_json::Map::new());
            }
            if let serde_json::Value::Object(map) = &mut extra_options {
                for (key, value) in &overrides.extra_option_overrides {
                    map.insert(key.clone(), value.clone());
                }
            }
        }
        Self {
            temperature: overrides.temperature.or(self.temperature),
            max_tokens: overrides.max_tokens.or(self.max_tokens),
            max_tokens_thinking: overrides.max_tokens_thinking.or(self.max_tokens_thinking),
            extra_options,
        }
    }

    /// Return the appropriate max_tokens for the current mode — uses the
    /// thinking-specific value when thinking is enabled and set, else falls
    /// back to the generic max_tokens.
    pub fn max_tokens_for_mode(&self, thinking: bool) -> Option<u64> {
        if thinking {
            self.max_tokens_thinking.or(self.max_tokens)
        } else {
            self.max_tokens
        }
    }
}

/// A provider definition from the catalog (immutable source of truth).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogProvider {
    pub name: String,
    #[serde(rename = "type")]
    pub provider_type: String,
    pub icon: String,
    pub description: String,
    pub env_key: String,
    pub default_config: ProviderDefaultConfig,
    pub connection_fields: Vec<ConnectionField>,
    pub models: HashMap<String, CatalogModel>,
    pub default_model: String,
    /// Fast model for title generation (falls back to default_model if not set).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title_model_id: Option<String>,
    pub documentation_url: String,
    /// Sampling/output defaults for this provider. May be absent for providers
    /// where the model's own defaults are preferred (e.g. Anthropic, which
    /// handles temperature natively).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tuning: Option<ProviderTuning>,
}

/// Capability metadata from the catalog.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapabilityInfo {
    pub name: String,
    pub description: String,
    pub icon: String,
}

/// The full catalog structure loaded from JSON.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiProviderCatalog {
    pub providers: HashMap<String, CatalogProvider>,
    pub capabilities: HashMap<String, CapabilityInfo>,
}

// ============================================================================
// User Settings Types (stored in app_settings)
// ============================================================================

/// Capability overrides for a specific model (tools/thinking/vision).
/// User can set these for fetched/unknown models that aren't in the catalog.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModelCapabilityOverrides {
    /// Override for tools capability.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<bool>,
    /// Override for thinking capability.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<bool>,
    /// Override for vision capability.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vision: Option<bool>,
    /// Override for streaming capability.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub streaming: Option<bool>,
}

pub fn default_priority() -> i32 {
    100
}

/// Per-provider user settings (stored in app_settings).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUserSettings {
    /// Whether this provider is enabled by the user.
    #[serde(default)]
    pub enabled: bool,
    /// Whether this provider is marked as favorite.
    #[serde(default)]
    pub favorite: bool,
    /// User-selected model (overrides catalog default).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_model: Option<String>,
    /// Custom URL for local providers like Ollama.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_url: Option<String>,
    /// Priority for sorting (lower = higher priority).
    #[serde(default = "default_priority")]
    pub priority: i32,
    /// Capability overrides keyed by model ID. Only needed for fetched/unknown models.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub model_capability_overrides: HashMap<String, ModelCapabilityOverrides>,
    /// List of fetched model IDs that user has marked as favorites.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub favorite_models: Vec<String>,
    /// Allowlist of tool IDs that this provider can use.
    /// None = all tools enabled (default), Some([]) = no tools, Some([...]) = only specified tools.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools_allowlist: Option<Vec<String>>,
    /// User overrides for the catalog tuning defaults (temperature, max_tokens).
    /// None = use catalog defaults entirely.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tuning_overrides: Option<ProviderTuningOverrides>,
}

impl Default for ProviderUserSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            favorite: false,
            selected_model: None,
            custom_url: None,
            priority: default_priority(),
            model_capability_overrides: HashMap::new(),
            favorite_models: Vec::new(),
            tools_allowlist: None,
            tuning_overrides: None,
        }
    }
}

/// The complete AI provider settings blob stored in app_settings.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderSettings {
    /// Schema version for migration support.
    pub schema_version: u32,
    /// Default provider ID to use.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_provider: Option<String>,
    /// Per-provider user settings keyed by provider ID.
    #[serde(default)]
    pub providers: HashMap<String, ProviderUserSettings>,
}

impl Default for AiProviderSettings {
    fn default() -> Self {
        Self {
            schema_version: AI_PROVIDER_SETTINGS_SCHEMA_VERSION,
            default_provider: None,
            providers: HashMap::new(),
        }
    }
}

// ============================================================================
// Merged View Types (returned to UI)
// ============================================================================

/// A model in the merged view returned to the UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergedModel {
    pub id: String,
    /// Display name (may differ from id for fetched models).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub capabilities: ModelCapabilities,
    /// Whether this model is from the catalog (true) or dynamically fetched (false).
    pub is_catalog: bool,
    /// Whether this model is marked as a user favorite.
    pub is_favorite: bool,
    /// Whether capabilities have user overrides applied.
    pub has_capability_overrides: bool,
}

/// A provider in the merged view returned to the UI.
/// Combines catalog data with user settings and computed fields.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergedProvider {
    // From catalog (immutable)
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub provider_type: String,
    pub icon: String,
    pub description: String,
    pub env_key: String,
    pub connection_fields: Vec<ConnectionField>,
    pub models: Vec<MergedModel>,
    pub default_model: String,
    pub documentation_url: String,

    // From user settings (mutable)
    pub enabled: bool,
    pub favorite: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_url: Option<String>,
    pub priority: i32,
    /// User's favorite model IDs (including fetched models not in catalog).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub favorite_models: Vec<String>,
    /// Capability overrides for specific models.
    /// Note: Always serialized (no skip_serializing_if) because frontend expects this field.
    #[serde(default)]
    pub model_capability_overrides: HashMap<String, ModelCapabilityOverrides>,
    /// Allowlist of tool IDs that this provider can use.
    /// None = all tools enabled (default), Some([]) = no tools, Some([...]) = only specified tools.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools_allowlist: Option<Vec<String>>,

    // Computed
    pub has_api_key: bool,
    pub is_default: bool,
    /// Whether this provider supports dynamic model listing via API.
    pub supports_model_listing: bool,

    // Tuning — three views for the UI:
    //   catalogTuning   : immutable defaults (what the ship-default is)
    //   tuningOverrides : user-supplied deltas (what the user chose)
    //   resolvedTuning  : effective values (catalog ⊕ overrides), what runtime uses
    /// Catalog tuning defaults for this provider.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub catalog_tuning: Option<ProviderTuning>,
    /// User-supplied overrides (None when user hasn't customized anything).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tuning_overrides: Option<ProviderTuningOverrides>,
    /// Effective tuning values the runtime will use (catalog merged with overrides).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_tuning: Option<ProviderTuning>,
}

/// The complete merged response returned to the UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProvidersResponse {
    pub providers: Vec<MergedProvider>,
    pub capabilities: HashMap<String, CapabilityInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_provider: Option<String>,
}

// ============================================================================
// Update Types (for modifying settings)
// ============================================================================

/// Request to update a single provider's settings.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProviderSettingsRequest {
    pub provider_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub favorite: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<i32>,
    /// Set capability overrides for a specific model.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_capability_override: Option<ModelCapabilityOverrideUpdate>,
    /// Update the list of favorite models (replaces the entire list).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub favorite_models: Option<Vec<String>>,
    /// Update tools allowlist.
    /// Use Some(None) to clear (all tools enabled), Some(Some([])) to set specific tools.
    #[serde(
        default,
        deserialize_with = "deserialize_nullable_update",
        skip_serializing_if = "Option::is_none"
    )]
    pub tools_allowlist: Option<Option<Vec<String>>>,
    /// Update user tuning overrides.
    /// Use Some(None) to reset to catalog defaults, Some(Some(...)) to set overrides.
    #[serde(
        default,
        deserialize_with = "deserialize_nullable_update",
        skip_serializing_if = "Option::is_none"
    )]
    pub tuning_overrides: Option<Option<ProviderTuningOverrides>>,
}

/// Update for a single model's capability overrides.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCapabilityOverrideUpdate {
    /// The model ID to update.
    pub model_id: String,
    /// The capability overrides to set. Use None to remove overrides for this model.
    pub overrides: Option<ModelCapabilityOverrides>,
}

/// Request to set the default provider.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetDefaultProviderRequest {
    /// Provider ID to set as default, or None to clear.
    pub provider_id: Option<String>,
}

// ============================================================================
// Provider API Error Types
// ============================================================================

/// Provider-specific API errors (for frontend consumption).
/// Different from the main AiError which is used internally.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ProviderApiError {
    /// API key is required but not configured for the provider.
    #[serde(rename_all = "camelCase")]
    MissingApiKey { provider_id: String },
    /// Provider is not found in the catalog.
    #[serde(rename_all = "camelCase")]
    UnknownProvider { provider_id: String },
    /// Provider API returned an error.
    #[serde(rename_all = "camelCase")]
    ProviderError { message: String },
    /// Invalid input provided.
    #[serde(rename_all = "camelCase")]
    InvalidInput { message: String },
}

impl std::fmt::Display for ProviderApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProviderApiError::MissingApiKey { provider_id } => {
                write!(f, "API key required for provider '{}'", provider_id)
            }
            ProviderApiError::UnknownProvider { provider_id } => {
                write!(f, "Unknown provider: {}", provider_id)
            }
            ProviderApiError::ProviderError { message } => {
                write!(f, "Provider error: {}", message)
            }
            ProviderApiError::InvalidInput { message } => {
                write!(f, "Invalid input: {}", message)
            }
        }
    }
}

impl std::error::Error for ProviderApiError {}

// ============================================================================
// Provider Configuration Types (for chat/model listing)
// ============================================================================

/// Configuration needed to connect to a provider (retrieved internally by backend).
/// This is returned only to internal callers, never exposed to frontend.
#[derive(Debug, Clone)]
pub struct ProviderConfig {
    /// The provider ID.
    pub provider_id: String,
    /// The API key (if required and available).
    pub api_key: Option<String>,
    /// The base URL (for local providers like Ollama, or custom endpoints).
    pub base_url: Option<String>,
    /// Whether API key is required for this provider.
    pub requires_api_key: bool,
}

/// Model info returned from provider API.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchedModel {
    /// Model ID as returned by provider.
    pub id: String,
    /// Optional display name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// Response from model listing.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListModelsResponse {
    /// List of models from the provider.
    pub models: Vec<FetchedModel>,
    /// Whether the provider supports dynamic model listing.
    /// If false, only catalog models are available.
    pub supports_listing: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;

    #[test]
    fn provider_update_preserves_nullable_field_intent() {
        let omitted: UpdateProviderSettingsRequest =
            serde_json::from_value(json!({ "providerId": "openai" })).unwrap();
        assert_eq!(omitted.tools_allowlist, None);
        assert_eq!(omitted.tuning_overrides, None);

        let cleared: UpdateProviderSettingsRequest = serde_json::from_value(json!({
            "providerId": "openai",
            "toolsAllowlist": null,
            "tuningOverrides": null
        }))
        .unwrap();
        assert_eq!(cleared.tools_allowlist, Some(None));
        assert_eq!(cleared.tuning_overrides, Some(None));

        let restricted: UpdateProviderSettingsRequest = serde_json::from_value(json!({
            "providerId": "openai",
            "toolsAllowlist": ["get_accounts"]
        }))
        .unwrap();
        assert_eq!(
            restricted.tools_allowlist,
            Some(Some(vec!["get_accounts".to_string()]))
        );
    }

    #[test]
    fn sanitized_for_provider_removes_unsupported_anthropic_sampling_overrides() {
        let overrides = ProviderTuningOverrides {
            extra_option_overrides: HashMap::from([
                ("top_k".to_string(), json!(0)),
                ("top_p".to_string(), json!(1.0)),
                ("seed".to_string(), json!(42)),
            ]),
            ..Default::default()
        };

        let sanitized = overrides.sanitized_for_provider("anthropic");

        assert!(!sanitized.extra_option_overrides.contains_key("top_k"));
        assert!(!sanitized.extra_option_overrides.contains_key("top_p"));
        assert_eq!(
            sanitized.extra_option_overrides.get("seed"),
            Some(&json!(42))
        );
    }

    #[test]
    fn sanitized_for_provider_preserves_other_provider_sampling_overrides() {
        let overrides = ProviderTuningOverrides {
            extra_option_overrides: HashMap::from([
                ("top_k".to_string(), json!(40)),
                ("top_p".to_string(), json!(0.9)),
            ]),
            ..Default::default()
        };

        let sanitized = overrides.sanitized_for_provider("ollama");

        assert_eq!(
            sanitized.extra_option_overrides.get("top_k"),
            Some(&json!(40))
        );
        assert_eq!(
            sanitized.extra_option_overrides.get("top_p"),
            Some(&json!(0.9))
        );
    }
}
