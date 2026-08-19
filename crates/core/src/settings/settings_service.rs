use super::SettingsRepositoryTrait;
use crate::errors::{DatabaseError, Error, Result};
use crate::fx::FxServiceTrait;
use crate::settings::{Settings, SettingsUpdate};
use crate::utils::time_utils::canonicalize_timezone;
use async_trait::async_trait;
use log::{debug, error};
use std::sync::Arc;

const SUPPORTED_FORMATTING_REGIONS: &[&str] = &[
    "system", "CA", "US", "GB", "FR", "DE", "ES", "MX", "CN", "JP", "KR",
];
const SUPPORTED_UI_LANGUAGES: &[&str] = &["en", "fr", "de", "es", "zh", "ja", "ko"];

fn normalize_ui_language(language: &str) -> String {
    let base = language.split(['-', '_']).next().unwrap_or(language);
    if SUPPORTED_UI_LANGUAGES.contains(&base) {
        base.to_string()
    } else {
        "en".to_string()
    }
}

fn validate_ui_language(language: &str) -> Result<String> {
    let base = language.split(['-', '_']).next().unwrap_or(language);
    if SUPPORTED_UI_LANGUAGES.contains(&base) {
        Ok(base.to_string())
    } else {
        Err(Error::InvalidConfigValue(format!(
            "Unsupported UI language: {language}"
        )))
    }
}

fn normalize_formatting_region(_language: &str, formatting_region: &str) -> String {
    if formatting_region == "system" {
        return "system".to_string();
    }
    let candidate = formatting_region
        .split(['-', '_'])
        .rev()
        .find(|part| part.len() == 2)
        .unwrap_or(formatting_region)
        .to_ascii_uppercase();
    if SUPPORTED_FORMATTING_REGIONS.contains(&candidate.as_str()) {
        candidate
    } else {
        "system".to_string()
    }
}

fn validate_formatting_region(region: &str) -> Result<()> {
    if SUPPORTED_FORMATTING_REGIONS.contains(&region) {
        Ok(())
    } else {
        Err(Error::InvalidConfigValue(format!(
            "Unsupported formatting region: {region}"
        )))
    }
}

// Define the trait for SettingsService
#[async_trait]
pub trait SettingsServiceTrait: Send + Sync {
    fn get_settings(&self) -> Result<Settings>;

    async fn update_settings(&self, new_settings: &SettingsUpdate) -> Result<()>;

    fn get_base_currency(&self) -> Result<Option<String>>;

    async fn update_base_currency(&self, new_base_currency: &str) -> Result<()>;

    fn is_auto_update_check_enabled(&self) -> Result<bool>;

    fn is_sync_enabled(&self) -> Result<bool>;

    /// Get a single setting value by key. Returns None if not found.
    fn get_setting_value(&self, key: &str) -> Result<Option<String>>;

    /// Set a single setting value by key.
    async fn set_setting_value(&self, key: &str, value: &str) -> Result<()>;
}

pub struct SettingsService {
    settings_repository: Arc<dyn SettingsRepositoryTrait>,
    fx_service: Arc<dyn FxServiceTrait>,
}

// Implement the trait for SettingsService
#[async_trait]
impl SettingsServiceTrait for SettingsService {
    fn get_settings(&self) -> Result<Settings> {
        let mut settings = self.settings_repository.get_settings()?;
        settings.formatting_region =
            normalize_formatting_region(&settings.language, &settings.formatting_region);
        settings.language = normalize_ui_language(&settings.language);
        Ok(settings)
    }

    async fn update_settings(&self, new_settings: &SettingsUpdate) -> Result<()> {
        let current_base_currency = self.get_base_currency()?;
        let mut normalized_settings = new_settings.clone();

        if let Some(ref new_base_currency_val) = normalized_settings.base_currency {
            if current_base_currency.as_deref() != Some(new_base_currency_val.as_str()) {
                self.update_base_currency(new_base_currency_val.as_str())
                    .await?;
            }
        }

        if let Some(ref timezone_raw) = normalized_settings.timezone {
            normalized_settings.timezone = Some(canonicalize_timezone(timezone_raw)?);
        }

        if let Some(ref region) = normalized_settings.formatting_region {
            validate_formatting_region(region)?;
        }
        if let Some(ref language) = normalized_settings.language {
            normalized_settings.language = Some(validate_ui_language(language)?);
        }

        self.settings_repository
            .update_settings(&normalized_settings)
            .await?;
        Ok(())
    }

    fn get_base_currency(&self) -> Result<Option<String>> {
        match self.settings_repository.get_setting("base_currency") {
            Ok(value) => Ok(Some(value)),
            Err(Error::Database(DatabaseError::NotFound(_))) => Ok(None),
            Err(e) => Err(e),
        }
    }

    async fn update_base_currency(&self, new_base_currency: &str) -> Result<()> {
        let all_currencies = self
            .settings_repository
            .get_distinct_currencies_excluding_base(new_base_currency)?;

        debug!(
            "Registering currency pairs for currencies: {:?}",
            all_currencies
        );

        for currency_code in all_currencies {
            let registration_result = self
                .fx_service
                .register_currency_pair(currency_code.as_str(), new_base_currency)
                .await;

            if let Err(e) = registration_result {
                error!(
                    "Failed to register currency pair {}{}: {}. Skipping.",
                    new_base_currency, currency_code, e
                );
            }
        }

        self.settings_repository
            .update_setting("base_currency", new_base_currency)
            .await?;
        Ok(())
    }

    fn is_auto_update_check_enabled(&self) -> Result<bool> {
        match self
            .settings_repository
            .get_setting("auto_update_check_enabled")
        {
            Ok(value) => Ok(value.parse().unwrap_or(true)),
            Err(Error::Database(DatabaseError::NotFound(_))) => Ok(true),
            Err(e) => Err(e),
        }
    }

    fn is_sync_enabled(&self) -> Result<bool> {
        match self.settings_repository.get_setting("sync_enabled") {
            Ok(value) => Ok(value.parse().unwrap_or(false)),
            Err(Error::Database(DatabaseError::NotFound(_))) => Ok(false),
            Err(e) => Err(e),
        }
    }

    fn get_setting_value(&self, key: &str) -> Result<Option<String>> {
        match self.settings_repository.get_setting(key) {
            Ok(value) => Ok(Some(value)),
            Err(Error::Database(DatabaseError::NotFound(_))) => Ok(None),
            Err(e) => Err(e),
        }
    }

    async fn set_setting_value(&self, key: &str, value: &str) -> Result<()> {
        self.settings_repository.update_setting(key, value).await
    }
}

impl SettingsService {
    pub fn new(
        settings_repository: Arc<dyn SettingsRepositoryTrait>,
        fx_service: Arc<dyn FxServiceTrait>,
    ) -> Self {
        SettingsService {
            settings_repository,
            fx_service,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        normalize_formatting_region, normalize_ui_language, validate_formatting_region,
        validate_ui_language,
    };

    #[test]
    fn preserves_explicit_system_formatting_preference() {
        for language in ["en-US", "fr-FR", "zh-Hans-CN", "ja-JP", "ko-KR"] {
            assert_eq!(normalize_formatting_region(language, "system"), "system");
        }
    }

    #[test]
    fn normalizes_legacy_full_locale_to_supported_ui_language() {
        assert_eq!(normalize_ui_language("en-US"), "en");
        assert_eq!(normalize_ui_language("fr_CA"), "fr");
        assert_eq!(normalize_ui_language("ja-JP"), "ja");
        assert_eq!(normalize_ui_language("ko_KR"), "ko");
    }

    #[test]
    fn falls_back_when_a_persisted_ui_language_is_invalid() {
        assert_eq!(normalize_ui_language("foo_bar"), "en");
    }

    #[test]
    fn rejects_unknown_ui_language_updates() {
        assert_eq!(validate_ui_language("ja-JP").unwrap(), "ja");
        assert!(validate_ui_language("foo_bar").is_err());
    }

    #[test]
    fn keeps_explicit_formatting_region_separate_from_ui_language() {
        assert_eq!(normalize_formatting_region("en", "de-DE"), "DE");
    }

    #[test]
    fn rejects_unknown_persisted_formatting_region() {
        assert_eq!(normalize_formatting_region("en", "unknown"), "system");
    }

    #[test]
    fn rejects_unknown_formatting_region_updates() {
        assert!(validate_formatting_region("DE").is_ok());
        assert!(validate_formatting_region("JP").is_ok());
        assert!(validate_formatting_region("KR").is_ok());
        assert!(validate_formatting_region("de-DE").is_err());
    }
}
