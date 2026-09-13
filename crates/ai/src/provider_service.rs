//! AI provider service - merges catalog with user settings.

use async_trait::async_trait;
use std::collections::HashSet;
use std::sync::Arc;

use wealthfolio_core::errors::{Result, ValidationError};
use wealthfolio_core::secrets::SecretStore;
use wealthfolio_core::settings::SettingsRepositoryTrait;

use crate::provider_model::{
    default_priority, AiProviderCatalog, AiProviderSettings, AiProvidersResponse, FetchedModel,
    ListModelsResponse, MergedModel, MergedProvider, ModelCapabilities, ModelCapabilityOverrides,
    ProviderApiError, ProviderConfig, ProviderTuning, ProviderUserSettings,
    SetDefaultProviderRequest, UpdateProviderSettingsRequest, AI_PROVIDER_SETTINGS_KEY,
    AI_PROVIDER_SETTINGS_SCHEMA_VERSION,
};
use crate::provider_urls::openai_compatible_models_url;
use crate::types::normalize_tools_allowlist;

/// Service trait for AI provider operations.
#[async_trait]
pub trait AiProviderServiceTrait: Send + Sync {
    /// Get all providers merged with user settings.
    fn get_ai_providers(&self) -> Result<AiProvidersResponse>;

    /// Update settings for a specific provider.
    async fn update_provider_settings(&self, request: UpdateProviderSettingsRequest) -> Result<()>;

    /// Set or clear the default provider.
    async fn set_default_provider(&self, request: SetDefaultProviderRequest) -> Result<()>;

    /// Get provider configuration for backend-only use (chat, model listing).
    /// This retrieves the API key from the secret store - never exposed to frontend.
    /// Returns ProviderApiError::MissingApiKey if API key is required but not configured.
    fn get_provider_config(
        &self,
        provider_id: &str,
    ) -> std::result::Result<ProviderConfig, ProviderApiError>;

    /// Get the title model ID for a provider (fast model for generating thread titles).
    /// Falls back to the default model if not configured.
    fn get_title_model(&self, provider_id: &str) -> Option<String>;

    /// Resolve the effective tuning for a provider by merging catalog defaults
    /// with any user-supplied overrides. Returns a default-empty `ProviderTuning`
    /// when the provider has no catalog tuning and the user hasn't customized.
    fn resolve_tuning(&self, provider_id: &str) -> ProviderTuning;

    /// List available models from a provider.
    /// Fetches models from the provider's API using backend-stored secrets.
    /// For providers without model listing (e.g., Anthropic), returns catalog models.
    async fn list_models(
        &self,
        provider_id: &str,
    ) -> std::result::Result<ListModelsResponse, ProviderApiError>;
}

/// AI provider service implementation.
pub struct AiProviderService {
    settings_repo: Arc<dyn SettingsRepositoryTrait>,
    secret_store: Arc<dyn SecretStore>,
    catalog: AiProviderCatalog,
}

impl AiProviderService {
    /// Create a new AI provider service.
    pub fn new(
        settings_repo: Arc<dyn SettingsRepositoryTrait>,
        secret_store: Arc<dyn SecretStore>,
        catalog_json: &str,
    ) -> Result<Self> {
        let catalog: AiProviderCatalog = serde_json::from_str(catalog_json)?;

        Ok(Self {
            settings_repo,
            secret_store,
            catalog,
        })
    }

    /// Load user settings from app_settings, falling back to defaults if missing/corrupt.
    fn load_user_settings(&self) -> AiProviderSettings {
        match self.settings_repo.get_setting(AI_PROVIDER_SETTINGS_KEY) {
            Ok(json) => {
                serde_json::from_str(&json).unwrap_or_else(|_| self.create_default_settings())
            }
            Err(_) => self.create_default_settings(),
        }
    }

    /// Create default settings based on catalog defaults.
    fn create_default_settings(&self) -> AiProviderSettings {
        let mut settings = AiProviderSettings::default();

        // Find first provider marked as enabled by default in catalog
        // and set recommended providers as favorites
        let mut first_enabled_provider: Option<String> = None;

        for (id, provider) in &self.catalog.providers {
            if provider.default_config.enabled {
                let user_settings = ProviderUserSettings {
                    enabled: true,
                    favorite: true, // Recommended providers are favorites
                    custom_url: provider.default_config.url.clone(),
                    ..Default::default()
                };
                settings.providers.insert(id.clone(), user_settings);

                if first_enabled_provider.is_none() {
                    first_enabled_provider = Some(id.clone());
                }
            }
        }

        // Set first enabled provider as default
        settings.default_provider = first_enabled_provider;

        settings
    }

    /// Save user settings to app_settings.
    async fn save_user_settings(&self, settings: &AiProviderSettings) -> Result<()> {
        let json = serde_json::to_string(settings)?;
        self.settings_repo
            .update_setting(AI_PROVIDER_SETTINGS_KEY, &json)
            .await
    }

    /// Build the secret key for a provider (format: ai_<provider_id>).
    fn secret_key_for_provider(provider_id: &str) -> String {
        format!("ai_{}", provider_id)
    }

    /// Check if a provider has an API key stored.
    fn has_api_key(&self, provider_id: &str) -> bool {
        let secret_key = Self::secret_key_for_provider(provider_id);
        self.secret_store
            .get_secret(&secret_key)
            .ok()
            .flatten()
            .map(|s| !s.is_empty())
            .unwrap_or(false)
    }

    /// Get the API key for a provider (internal use only).
    fn get_api_key(&self, provider_id: &str) -> Option<String> {
        let secret_key = Self::secret_key_for_provider(provider_id);
        self.secret_store
            .get_secret(&secret_key)
            .ok()
            .flatten()
            .filter(|s| !s.is_empty())
    }

    /// Check if provider requires an API key based on catalog.
    fn provider_requires_api_key(&self, provider_id: &str) -> bool {
        self.catalog
            .providers
            .get(provider_id)
            .map(|p| {
                // Local providers (like Ollama) don't require API keys
                // API providers require keys
                p.provider_type == "api"
            })
            .unwrap_or(true) // Default to requiring API key for unknown providers
    }

    /// Get the custom URL for a provider from user settings.
    fn get_custom_url(&self, provider_id: &str) -> Option<String> {
        let user_settings = self.load_user_settings();
        user_settings
            .providers
            .get(provider_id)
            .and_then(|s| s.custom_url.clone())
            .or_else(|| {
                // Fall back to catalog default URL
                self.catalog
                    .providers
                    .get(provider_id)
                    .and_then(|p| p.default_config.url.clone())
            })
    }

    /// Check if a provider supports dynamic model listing via API.
    fn provider_supports_model_listing(_provider_id: &str) -> bool {
        true
    }

    /// Apply capability overrides to base capabilities.
    fn apply_capability_overrides(
        base: &ModelCapabilities,
        overrides: &ModelCapabilityOverrides,
    ) -> ModelCapabilities {
        ModelCapabilities {
            tools: overrides.tools.unwrap_or(base.tools),
            thinking: overrides.thinking.unwrap_or(base.thinking),
            vision: overrides.vision.unwrap_or(base.vision),
            streaming: overrides.streaming.unwrap_or(base.streaming),
        }
    }
}

#[async_trait]
impl AiProviderServiceTrait for AiProviderService {
    fn get_ai_providers(&self) -> Result<AiProvidersResponse> {
        let user_settings = self.load_user_settings();

        let mut providers: Vec<MergedProvider> = self
            .catalog
            .providers
            .iter()
            .map(|(id, catalog_provider)| {
                // Get user settings for this provider, or use defaults
                let user = user_settings.providers.get(id).cloned().unwrap_or_else(|| {
                    // Use catalog defaults for providers not in user settings
                    ProviderUserSettings {
                        enabled: catalog_provider.default_config.enabled,
                        favorite: catalog_provider.default_config.enabled, // Recommended = favorite
                        selected_model: None,
                        custom_url: catalog_provider.default_config.url.clone(),
                        priority: catalog_provider.default_config.priority,
                        ..Default::default()
                    }
                });

                // Convert catalog models to sorted vec, applying capability overrides
                let mut models: Vec<MergedModel> = catalog_provider
                    .models
                    .iter()
                    .map(|(model_id, model)| {
                        let has_overrides = user.model_capability_overrides.contains_key(model_id);
                        let capabilities = if let Some(overrides) =
                            user.model_capability_overrides.get(model_id)
                        {
                            Self::apply_capability_overrides(&model.capabilities, overrides)
                        } else {
                            model.capabilities.clone()
                        };
                        MergedModel {
                            id: model_id.clone(),
                            name: None, // Catalog models don't have separate display names
                            capabilities,
                            is_catalog: true,
                            is_favorite: user.favorite_models.contains(model_id),
                            has_capability_overrides: has_overrides,
                        }
                    })
                    .collect();

                // Add non-catalog models referenced by user settings (selected/favorites/overrides).
                // This ensures overrides are represented and applied even for models fetched at runtime.
                let mut non_catalog_model_ids: HashSet<String> = HashSet::new();
                if let Some(selected_model) = &user.selected_model {
                    if !catalog_provider.models.contains_key(selected_model) {
                        non_catalog_model_ids.insert(selected_model.clone());
                    }
                }
                for favorite_model in &user.favorite_models {
                    if !catalog_provider.models.contains_key(favorite_model) {
                        non_catalog_model_ids.insert(favorite_model.clone());
                    }
                }
                for model_id in user.model_capability_overrides.keys() {
                    if !catalog_provider.models.contains_key(model_id) {
                        non_catalog_model_ids.insert(model_id.clone());
                    }
                }

                for model_id in non_catalog_model_ids {
                    let has_overrides = user.model_capability_overrides.contains_key(&model_id);
                    let base_capabilities = ModelCapabilities {
                        tools: false,
                        thinking: false,
                        vision: false,
                        streaming: true,
                    };
                    let capabilities =
                        if let Some(overrides) = user.model_capability_overrides.get(&model_id) {
                            Self::apply_capability_overrides(&base_capabilities, overrides)
                        } else {
                            base_capabilities
                        };

                    models.push(MergedModel {
                        id: model_id.clone(),
                        name: Some(model_id.clone()),
                        capabilities,
                        is_catalog: false,
                        is_favorite: user.favorite_models.contains(&model_id),
                        has_capability_overrides: has_overrides,
                    });
                }

                // Sort models alphabetically for consistent ordering
                models.sort_by_key(|a| a.id.clone());

                // Check if provider supports dynamic model listing
                let supports_model_listing = Self::provider_supports_model_listing(id);

                // Resolve the three tuning views for the UI: catalog-only,
                // user-only, and the effective merged value the runtime uses.
                let catalog_tuning = catalog_provider.tuning.clone();
                let tuning_overrides = user.tuning_overrides.clone();
                let sanitized_overrides = tuning_overrides
                    .clone()
                    .map(|ovr| ovr.sanitized_for_provider(id));
                let resolved_tuning = match (&catalog_tuning, &sanitized_overrides) {
                    (Some(cat), Some(ovr)) => Some(cat.apply_overrides(ovr)),
                    (Some(cat), None) => Some(cat.clone()),
                    (None, Some(ovr)) => Some(ProviderTuning::default().apply_overrides(ovr)),
                    (None, None) => None,
                };

                MergedProvider {
                    id: id.clone(),
                    name: catalog_provider.name.clone(),
                    provider_type: catalog_provider.provider_type.clone(),
                    icon: catalog_provider.icon.clone(),
                    description: catalog_provider.description.clone(),
                    env_key: catalog_provider.env_key.clone(),
                    connection_fields: catalog_provider.connection_fields.clone(),
                    models,
                    default_model: catalog_provider.default_model.clone(),
                    documentation_url: catalog_provider.documentation_url.clone(),
                    enabled: user.enabled,
                    favorite: user.favorite,
                    selected_model: user.selected_model.clone(),
                    custom_url: user.custom_url,
                    // Use catalog priority if user hasn't explicitly set one
                    priority: if user.priority == 0 || user.priority == default_priority() {
                        catalog_provider.default_config.priority
                    } else {
                        user.priority
                    },
                    favorite_models: user.favorite_models.clone(),
                    model_capability_overrides: user.model_capability_overrides.clone(),
                    tools_allowlist: normalize_tools_allowlist(user.tools_allowlist.clone()),
                    has_api_key: self.has_api_key(id),
                    is_default: user_settings.default_provider.as_ref() == Some(id),
                    supports_model_listing,
                    catalog_tuning,
                    tuning_overrides,
                    resolved_tuning,
                }
            })
            .collect();

        // Sort by priority (lower first), then by provider ID for stable tiebreaker
        providers.sort_by(|a, b| a.priority.cmp(&b.priority).then_with(|| a.id.cmp(&b.id)));

        Ok(AiProvidersResponse {
            providers,
            capabilities: self.catalog.capabilities.clone(),
            default_provider: user_settings.default_provider,
        })
    }

    async fn update_provider_settings(&self, request: UpdateProviderSettingsRequest) -> Result<()> {
        // Verify provider exists in catalog
        if !self.catalog.providers.contains_key(&request.provider_id) {
            return Err(wealthfolio_core::errors::Error::Validation(
                ValidationError::InvalidInput(format!("Unknown provider: {}", request.provider_id)),
            ));
        }

        let mut settings = self.load_user_settings();

        // Get or create provider settings
        let provider_settings = settings
            .providers
            .entry(request.provider_id.clone())
            .or_default();

        // Apply updates
        if let Some(enabled) = request.enabled {
            provider_settings.enabled = enabled;
        }
        if let Some(favorite) = request.favorite {
            provider_settings.favorite = favorite;
        }
        if let Some(model) = request.selected_model {
            provider_settings.selected_model = Some(model);
        }
        if let Some(url) = request.custom_url {
            provider_settings.custom_url = if url.trim().is_empty() {
                None
            } else {
                Some(url)
            };
        }
        if let Some(priority) = request.priority {
            provider_settings.priority = priority;
        }

        // Handle capability override update for a specific model
        if let Some(override_update) = request.model_capability_override {
            if let Some(overrides) = override_update.overrides {
                // Set or update overrides for this model
                provider_settings
                    .model_capability_overrides
                    .insert(override_update.model_id, overrides);
            } else {
                // Remove overrides for this model (None means clear)
                provider_settings
                    .model_capability_overrides
                    .remove(&override_update.model_id);
            }
        }

        // Handle favorite models update (replaces entire list)
        if let Some(favorite_models) = request.favorite_models {
            provider_settings.favorite_models = favorite_models;
        }

        // Handle tools allowlist update
        // Some(Some([...])) = set specific tools, Some(None) = all tools enabled
        if let Some(tools_allowlist) = request.tools_allowlist {
            provider_settings.tools_allowlist = normalize_tools_allowlist(tools_allowlist);
        }

        // Handle tuning overrides update
        // Some(Some(overrides)) = set/update overrides, Some(None) = reset to catalog defaults.
        // Empty overrides (every field None) are also treated as a reset to keep storage tidy.
        if let Some(tuning_update) = request.tuning_overrides {
            match tuning_update {
                Some(overrides) => {
                    overrides.validate().map_err(|msg| {
                        wealthfolio_core::errors::Error::Validation(ValidationError::InvalidInput(
                            format!("tuning_overrides: {}", msg),
                        ))
                    })?;
                    if overrides.is_empty() {
                        provider_settings.tuning_overrides = None;
                    } else {
                        provider_settings.tuning_overrides = Some(overrides);
                    }
                }
                None => {
                    provider_settings.tuning_overrides = None;
                }
            }
        }

        // Update schema version
        settings.schema_version = AI_PROVIDER_SETTINGS_SCHEMA_VERSION;

        self.save_user_settings(&settings).await
    }

    async fn set_default_provider(&self, request: SetDefaultProviderRequest) -> Result<()> {
        // Verify provider exists if setting a default
        if let Some(ref provider_id) = request.provider_id {
            if !self.catalog.providers.contains_key(provider_id) {
                return Err(wealthfolio_core::errors::Error::Validation(
                    ValidationError::InvalidInput(format!("Unknown provider: {}", provider_id)),
                ));
            }
        }

        let mut settings = self.load_user_settings();
        settings.default_provider = request.provider_id;
        settings.schema_version = AI_PROVIDER_SETTINGS_SCHEMA_VERSION;

        self.save_user_settings(&settings).await
    }

    fn get_provider_config(
        &self,
        provider_id: &str,
    ) -> std::result::Result<ProviderConfig, ProviderApiError> {
        // Verify provider exists in catalog
        if !self.catalog.providers.contains_key(provider_id) {
            return Err(ProviderApiError::UnknownProvider {
                provider_id: provider_id.to_string(),
            });
        }

        let requires_api_key = self.provider_requires_api_key(provider_id);
        let api_key = self.get_api_key(provider_id);
        let base_url = self.get_custom_url(provider_id);

        // Check if API key is required but missing
        if requires_api_key && api_key.is_none() {
            return Err(ProviderApiError::MissingApiKey {
                provider_id: provider_id.to_string(),
            });
        }

        Ok(ProviderConfig {
            provider_id: provider_id.to_string(),
            api_key,
            base_url,
            requires_api_key,
        })
    }

    fn get_title_model(&self, provider_id: &str) -> Option<String> {
        self.catalog.providers.get(provider_id).map(|p| {
            // Use title_model_id if set, otherwise fall back to default_model
            p.title_model_id
                .clone()
                .unwrap_or_else(|| p.default_model.clone())
        })
    }

    fn resolve_tuning(&self, provider_id: &str) -> ProviderTuning {
        let catalog_tuning = self
            .catalog
            .providers
            .get(provider_id)
            .and_then(|p| p.tuning.clone())
            .unwrap_or_default();
        let user_overrides = self
            .load_user_settings()
            .providers
            .get(provider_id)
            .and_then(|s| s.tuning_overrides.clone());
        match user_overrides {
            Some(ovr) => {
                let sanitized = ovr.sanitized_for_provider(provider_id);
                catalog_tuning.apply_overrides(&sanitized)
            }
            None => catalog_tuning,
        }
    }

    async fn list_models(
        &self,
        provider_id: &str,
    ) -> std::result::Result<ListModelsResponse, ProviderApiError> {
        // Get provider config (validates provider exists and has API key if needed)
        let config = self.get_provider_config(provider_id)?;

        // Build the model list URL based on provider
        let base_url = config.base_url.as_deref().unwrap_or(match provider_id {
            "anthropic" => "https://api.anthropic.com",
            "openai" => "https://api.openai.com",
            "groq" => "https://api.groq.com/openai",
            "openrouter" => "https://openrouter.ai/api",
            "google" => "https://generativelanguage.googleapis.com",
            "ollama" => "http://localhost:11434",
            _ => "https://api.openai.com",
        });

        let models_url = match provider_id {
            "ollama" => format!("{}/api/tags", base_url.trim_end_matches('/')),
            "google" => format!("{}/v1beta/models", base_url.trim_end_matches('/')),
            // OpenAI-compatible: OpenAI, Groq, OpenRouter.
            _ => openai_compatible_models_url(base_url),
        };

        // Build HTTP client and request
        let client = wealthfolio_http::client();
        let mut request = client.get(&models_url);

        // Add authorization header based on provider
        if let Some(ref api_key) = config.api_key {
            request = match provider_id {
                "anthropic" => request
                    .header("x-api-key", api_key.as_str())
                    .header("anthropic-version", "2023-06-01"),
                "google" => request.query(&[("key", api_key.as_str())]),
                _ => request.header("Authorization", format!("Bearer {}", api_key)),
            };
        }

        // Make the request
        let response = request
            .send()
            .await
            .map_err(|e| ProviderApiError::ProviderError {
                message: format!("Failed to connect to provider: {}", e),
            })?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(ProviderApiError::ProviderError {
                message: format!("Provider returned error {}: {}", status, body),
            });
        }

        // Parse response based on provider format
        let models = match provider_id {
            "anthropic" => {
                // Anthropic format: { "data": [{ "id": "claude-...", "display_name": "Claude ..." }] }
                #[derive(serde::Deserialize)]
                struct AnthropicResponse {
                    data: Vec<AnthropicModel>,
                }
                #[derive(serde::Deserialize)]
                struct AnthropicModel {
                    id: String,
                    display_name: Option<String>,
                }

                let resp: AnthropicResponse =
                    response
                        .json()
                        .await
                        .map_err(|e| ProviderApiError::ProviderError {
                            message: format!("Failed to parse Anthropic response: {}", e),
                        })?;

                resp.data
                    .into_iter()
                    .map(|m| FetchedModel {
                        id: m.id,
                        name: m.display_name,
                    })
                    .collect()
            }
            "ollama" => {
                // Ollama format: { "models": [{ "name": "llama3.2", ... }] }
                #[derive(serde::Deserialize)]
                struct OllamaResponse {
                    models: Vec<OllamaModel>,
                }
                #[derive(serde::Deserialize)]
                struct OllamaModel {
                    name: String,
                }

                let resp: OllamaResponse =
                    response
                        .json()
                        .await
                        .map_err(|e| ProviderApiError::ProviderError {
                            message: format!("Failed to parse Ollama response: {}", e),
                        })?;

                resp.models
                    .into_iter()
                    .map(|m| FetchedModel {
                        id: m.name.clone(),
                        name: Some(m.name),
                    })
                    .collect()
            }
            "google" => {
                // Google format: { "models": [{ "name": "models/gemini-pro", ... }] }
                #[derive(serde::Deserialize)]
                struct GoogleResponse {
                    models: Vec<GoogleModel>,
                }
                #[derive(serde::Deserialize)]
                #[serde(rename_all = "camelCase")]
                struct GoogleModel {
                    name: String,
                    display_name: Option<String>,
                }

                let resp: GoogleResponse =
                    response
                        .json()
                        .await
                        .map_err(|e| ProviderApiError::ProviderError {
                            message: format!("Failed to parse Google response: {}", e),
                        })?;

                resp.models
                    .into_iter()
                    .filter(|m| m.name.contains("gemini"))
                    .map(|m| {
                        // Google returns "models/gemini-pro", we want just "gemini-pro"
                        let id = m
                            .name
                            .strip_prefix("models/")
                            .unwrap_or(&m.name)
                            .to_string();
                        FetchedModel {
                            id,
                            name: m.display_name,
                        }
                    })
                    .collect()
            }
            // OpenAI-compatible format: OpenAI, Groq, OpenRouter
            _ => {
                // OpenAI format: { "data": [{ "id": "gpt-4", ... }] }
                #[derive(serde::Deserialize)]
                struct OpenAIResponse {
                    data: Vec<OpenAIModel>,
                }
                #[derive(serde::Deserialize)]
                struct OpenAIModel {
                    id: String,
                }

                let resp: OpenAIResponse =
                    response
                        .json()
                        .await
                        .map_err(|e| ProviderApiError::ProviderError {
                            message: format!("Failed to parse provider response: {}", e),
                        })?;

                resp.data
                    .into_iter()
                    .map(|m| FetchedModel {
                        id: m.id.clone(),
                        name: Some(m.id),
                    })
                    .collect()
            }
        };

        Ok(ListModelsResponse {
            models,
            supports_listing: true,
        })
    }
}
