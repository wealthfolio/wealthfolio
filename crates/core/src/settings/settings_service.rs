use super::SettingsRepositoryTrait;
use crate::errors::{DatabaseError, Error, Result};
use crate::fx::currency::get_normalization_rule;
use crate::fx::FxServiceTrait;
use crate::settings::{Settings, SettingsUpdate};
use crate::utils::time_utils::canonicalize_timezone;
use async_trait::async_trait;
use log::{debug, error};
use std::collections::BTreeMap;
use std::sync::Arc;

const SUPPORTED_FORMATTING_REGIONS: &[&str] = &[
    "system", "CA", "US", "GB", "IN", "FR", "DE", "AT", "CH", "ES", "MX", "BR", "PT", "CN", "TW",
    "JP", "KR", "IT", "RO", "BG",
];
const SUPPORTED_UI_LANGUAGES: &[&str] = &[
    "en", "fr", "de", "es", "pt", "zh", "zh-Hant", "ja", "ko", "it", "ar",
];

/// Traditional Chinese is written in Taiwan, Hong Kong and Macau. Match the
/// script subtag (`Hant`) or any of those regions, so a bare `zh-HK` resolves
/// the same way an explicit `zh-Hant-HK` already does.
fn is_traditional_chinese_alias(language: &str) -> bool {
    let mut parts = language.split(['-', '_']);
    if !matches!(parts.next(), Some(part) if part.eq_ignore_ascii_case("zh")) {
        return false;
    }

    let subtags: Vec<&str> = parts.collect();
    // An explicit `Hans` script wins over a Traditional region, so `zh-Hans-TW`
    // stays Simplified.
    if subtags.iter().any(|part| part.eq_ignore_ascii_case("hans")) {
        return false;
    }

    subtags.iter().any(|part| {
        ["hant", "tw", "hk", "mo"]
            .iter()
            .any(|alias| part.eq_ignore_ascii_case(alias))
    })
}

fn normalize_ui_language(language: &str) -> String {
    if is_traditional_chinese_alias(language) {
        return "zh-Hant".to_string();
    }

    if SUPPORTED_UI_LANGUAGES.contains(&language) {
        return language.to_string();
    }

    let base = language.split(['-', '_']).next().unwrap_or(language);
    if SUPPORTED_UI_LANGUAGES.contains(&base) {
        base.to_string()
    } else {
        "en".to_string()
    }
}

fn validate_ui_language(language: &str) -> Result<String> {
    if is_traditional_chinese_alias(language) {
        return Ok("zh-Hant".to_string());
    }

    if SUPPORTED_UI_LANGUAGES.contains(&language) {
        return Ok(language.to_string());
    }

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

/// Theme IDs are the frontend's definition file names: lowercase words joined by
/// hyphens. The frontend resolves an ID it doesn't know to Classic.
fn validate_theme_id(theme_id: &str) -> Result<()> {
    let valid = theme_id.len() <= 48
        && theme_id.starts_with(|c: char| c.is_ascii_lowercase())
        && theme_id.split('-').all(|word| {
            !word.is_empty()
                && word
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        });
    if valid {
        Ok(())
    } else {
        Err(Error::InvalidConfigValue(format!(
            "Invalid theme ID: {theme_id}"
        )))
    }
}

/// Quote units such as GBX follow their major currency's override, so they
/// cannot have one of their own.
fn is_currency_code(code: &str) -> bool {
    code.len() == 3
        && code.bytes().all(|byte| byte.is_ascii_uppercase())
        && get_normalization_rule(code).is_none()
}

/// A quote unit such as GBp is priced in its major currency, so it cannot be the
/// base either.
fn validate_base_currency(code: &str) -> Result<()> {
    if is_currency_code(code) {
        Ok(())
    } else {
        Err(Error::InvalidConfigValue(format!(
            "Unsupported base currency: {code}"
        )))
    }
}

/// A currency override names a concrete region; following the system locale is
/// what `formatting_region` is for.
fn is_currency_formatting_region(region: &str) -> bool {
    region != "system" && SUPPORTED_FORMATTING_REGIONS.contains(&region)
}

fn normalize_currency_formatting_regions(regions: &mut BTreeMap<String, String>) {
    regions.retain(|currency, region| {
        is_currency_code(currency) && is_currency_formatting_region(region)
    });
}

fn validate_currency_formatting_regions(regions: &BTreeMap<String, String>) -> Result<()> {
    for (currency, region) in regions {
        if !is_currency_code(currency) {
            return Err(Error::InvalidConfigValue(format!(
                "Unsupported currency code: {currency}"
            )));
        }
        if !is_currency_formatting_region(region) {
            return Err(Error::InvalidConfigValue(format!(
                "Unsupported formatting region for {currency}: {region}"
            )));
        }
    }
    Ok(())
}

// Define the trait for SettingsService
#[async_trait]
pub trait SettingsServiceTrait: Send + Sync {
    fn get_settings(&self) -> Result<Settings>;

    async fn update_settings(&self, new_settings: &SettingsUpdate) -> Result<()>;

    fn get_base_currency(&self) -> Result<Option<String>>;

    fn is_auto_update_check_enabled(&self) -> Result<bool>;

    fn is_sync_enabled(&self) -> Result<bool>;

    /// A restored portfolio must not reuse this installation's cloud identity.
    fn requires_cloud_reconnect(&self) -> Result<bool> {
        Ok(self
            .get_setting_value("restore_reconnect_required")?
            .as_deref()
            == Some("true"))
    }

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
        normalize_currency_formatting_regions(&mut settings.currency_formatting_regions);
        settings.language = normalize_ui_language(&settings.language);
        Ok(settings)
    }

    async fn update_settings(&self, new_settings: &SettingsUpdate) -> Result<()> {
        let current_base_currency = self.get_base_currency()?;
        let mut normalized_settings = new_settings.clone();

        if let Some(ref timezone_raw) = normalized_settings.timezone {
            normalized_settings.timezone = Some(canonicalize_timezone(timezone_raw)?);
        }

        if let Some(ref theme_id) = normalized_settings.theme_id {
            validate_theme_id(theme_id)?;
        }
        if let Some(ref region) = normalized_settings.formatting_region {
            validate_formatting_region(region)?;
        }
        if let Some(ref regions) = normalized_settings.currency_formatting_regions {
            validate_currency_formatting_regions(regions)?;
        }
        if let Some(ref language) = normalized_settings.language {
            normalized_settings.language = Some(validate_ui_language(language)?);
        }
        if let Some(ref base_currency) = normalized_settings.base_currency {
            validate_base_currency(base_currency)?;
        }

        // Validate the whole update first: a rejected update must not change the
        // base currency, which the repository writes in the same transaction as
        // the other settings.
        if let Some(ref new_base_currency_val) = normalized_settings.base_currency {
            if current_base_currency.as_deref() != Some(new_base_currency_val.as_str()) {
                self.register_base_currency_pairs(new_base_currency_val.as_str())
                    .await?;
            }
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

    async fn register_base_currency_pairs(&self, new_base_currency: &str) -> Result<()> {
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
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        normalize_currency_formatting_regions, normalize_formatting_region, normalize_ui_language,
        validate_currency_formatting_regions, validate_formatting_region, validate_theme_id,
        validate_ui_language,
    };
    use crate::settings::Settings;
    use std::collections::BTreeMap;

    fn regions(entries: &[(&str, &str)]) -> BTreeMap<String, String> {
        entries
            .iter()
            .map(|(currency, region)| (currency.to_string(), region.to_string()))
            .collect()
    }

    #[test]
    fn accepts_theme_file_names_and_rejects_anything_else() {
        for id in ["classic", "ember", "high-contrast", "theme2", "a-1"] {
            assert!(validate_theme_id(id).is_ok(), "{id}");
        }
        let too_long = "a".repeat(49);
        for id in [
            "",
            "Classic",
            "1st",
            "-ember",
            "ember-",
            "two--hyphens",
            "under_score",
            "quote\"",
            too_long.as_str(),
        ] {
            assert!(validate_theme_id(id).is_err(), "{id}");
        }
    }

    #[test]
    fn settings_saved_before_themes_read_as_classic() {
        let mut value = serde_json::to_value(Settings::default()).unwrap();
        value.as_object_mut().unwrap().remove("themeId");
        value["theme"] = serde_json::json!("system");
        let settings: Settings = serde_json::from_value(value).unwrap();
        assert_eq!(settings.theme_id, "classic");
        assert_eq!(settings.theme, "system");
    }

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
        assert_eq!(normalize_ui_language("ar-SA"), "ar");
    }

    #[test]
    fn preserves_script_qualified_ui_language() {
        assert_eq!(normalize_ui_language("zh-Hant"), "zh-Hant");
        assert_eq!(validate_ui_language("zh-Hant").unwrap(), "zh-Hant");
    }

    #[test]
    fn normalizes_traditional_chinese_aliases() {
        // Taiwan, Hong Kong and Macau all write Traditional, with or without an
        // explicit `Hant` subtag.
        for language in [
            "zh-Hant-TW",
            "zh_TW",
            "zh-Hant",
            "ZH_hant_tw",
            "zh-HK",
            "zh-MO",
            "zh_Hant_HK",
        ] {
            assert_eq!(normalize_ui_language(language), "zh-Hant", "{language}");
            assert_eq!(
                validate_ui_language(language).unwrap(),
                "zh-Hant",
                "{language}"
            );
        }
    }

    #[test]
    fn keeps_simplified_chinese_on_the_base_code() {
        // An explicit `Hans` script wins over a Traditional region.
        for language in [
            "zh",
            "zh-CN",
            "zh_Hans_CN",
            "zh-SG",
            "zh-Hans",
            "zh-Hans-TW",
            "zh-Hans-HK",
        ] {
            assert_eq!(normalize_ui_language(language), "zh", "{language}");
        }
    }

    #[test]
    fn does_not_treat_a_traditional_region_on_another_language_as_chinese() {
        assert_eq!(normalize_ui_language("en-HK"), "en");
        assert_eq!(normalize_ui_language("pt-MO"), "pt");
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
        // Swiss German shares its language with Germany but formats differently.
        assert_eq!(normalize_formatting_region("de", "de-CH"), "CH");
        assert_eq!(normalize_formatting_region("en", "en-IN"), "IN");
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
        assert!(validate_formatting_region("TW").is_ok());
        assert!(validate_formatting_region("IT").is_ok());
        assert!(validate_formatting_region("CH").is_ok());
        assert!(validate_formatting_region("IN").is_ok());
        assert!(validate_formatting_region("AT").is_ok());
        assert!(validate_formatting_region("RO").is_ok());
        assert!(validate_formatting_region("BG").is_ok());
        assert!(validate_formatting_region("de-DE").is_err());
    }

    #[test]
    fn accepts_currency_formatting_regions_for_supported_regions() {
        assert!(validate_currency_formatting_regions(&regions(&[])).is_ok());
        assert!(
            validate_currency_formatting_regions(&regions(&[("INR", "IN"), ("USD", "US")])).is_ok()
        );
    }

    #[test]
    fn rejects_invalid_currency_formatting_region_updates() {
        for entries in [
            [("inr", "IN")],
            [("GBp", "GB")],
            [("RUPEE", "IN")],
            [("GBX", "DE")],
            [("ZAC", "GB")],
            [("INR", "system")],
            [("INR", "en-IN")],
            [("INR", "ZZ")],
        ] {
            assert!(
                validate_currency_formatting_regions(&regions(&entries)).is_err(),
                "{entries:?}"
            );
        }
    }

    #[test]
    fn drops_invalid_persisted_currency_formatting_regions() {
        let mut persisted = regions(&[
            ("INR", "IN"),
            ("USD", "US"),
            ("usd", "US"),
            ("GBX", "DE"),
            ("EUR", "system"),
            ("JPY", "unknown"),
        ]);
        normalize_currency_formatting_regions(&mut persisted);
        assert_eq!(persisted, regions(&[("INR", "IN"), ("USD", "US")]));
    }
}
