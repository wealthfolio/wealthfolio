use crate::addons::validate_addon_id;
use crate::errors::Result;

/// Prefix applied to all secret identifiers to avoid collisions with other
/// applications that may share the same underlying credential store.
pub const SERVICE_PREFIX: &str = "wealthfolio_";

/// Format a service identifier into the canonical form expected by the
/// platform-specific secret stores.
pub fn format_service_id(service: &str) -> String {
    format!("{}{}", SERVICE_PREFIX, service.to_lowercase())
}

pub fn normalize_addon_secret_key(key: &str) -> std::result::Result<String, String> {
    if key.is_empty() {
        return Err("Addon secret key cannot be empty".to_string());
    }

    if key.len() > 128 {
        return Err("Addon secret key cannot exceed 128 characters".to_string());
    }

    if !key
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        return Err(
            "Addon secret key may only contain ASCII letters, digits, '.', '_' and '-'".to_string(),
        );
    }

    Ok(key.to_ascii_lowercase())
}

pub fn validate_addon_secret_key(key: &str) -> std::result::Result<(), String> {
    normalize_addon_secret_key(key).map(|_| ())
}

fn normalize_addon_secret_addon_id(addon_id: &str) -> std::result::Result<String, String> {
    let addon_id = addon_id.to_ascii_lowercase();
    validate_addon_id(&addon_id)?;
    Ok(addon_id)
}

pub fn validate_unscoped_secret_service_id(service: &str) -> std::result::Result<(), String> {
    if service.trim().is_empty() {
        return Err("Secret service id cannot be empty".to_string());
    }

    if service.to_ascii_lowercase().starts_with("addon:") {
        return Err("Addon-scoped secrets must use the addon secret API".to_string());
    }

    Ok(())
}

pub fn addon_secret_service_id(addon_id: &str, key: &str) -> std::result::Result<String, String> {
    let addon_id = normalize_addon_secret_addon_id(addon_id)?;
    let key = normalize_addon_secret_key(key)?;
    Ok(format!("addon:{}:{}", addon_id, key))
}

pub fn legacy_addon_secret_service_id(
    addon_id: &str,
    key: &str,
) -> std::result::Result<String, String> {
    let addon_id = normalize_addon_secret_addon_id(addon_id)?;
    let key = normalize_addon_secret_key(key)?;
    Ok(format!("addon_{}_{}", addon_id, key))
}

/// Platform-agnostic contract for storing provider secrets. Concrete
/// implementations live in the platform crates (e.g. the Tauri desktop app or
/// the self-hosted web server) so the core crate remains focused on business
/// logic.
pub trait SecretStore: Send + Sync {
    fn set_secret(&self, service: &str, secret: &str) -> Result<()>;
    fn get_secret(&self, service: &str) -> Result<Option<String>>;
    fn delete_secret(&self, service: &str) -> Result<()>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addon_secret_service_id_scopes_and_validates_keys() {
        assert_eq!(
            addon_secret_service_id("example-addon", "api_key").unwrap(),
            "addon:example-addon:api_key"
        );
        assert_eq!(
            addon_secret_service_id("example-addon", "ApiKey").unwrap(),
            "addon:example-addon:apikey"
        );
        assert_eq!(
            legacy_addon_secret_service_id("example-addon", "ApiKey").unwrap(),
            "addon_example-addon_apikey"
        );
        assert_eq!(
            addon_secret_service_id("Example-Addon", "ApiKey").unwrap(),
            "addon:example-addon:apikey"
        );

        assert!(addon_secret_service_id("../bad", "api_key").is_err());
        assert!(addon_secret_service_id("example-addon", "../token").is_err());
    }

    #[test]
    fn validate_unscoped_secret_service_id_rejects_addon_namespace() {
        assert!(validate_unscoped_secret_service_id("market-data-provider").is_ok());
        assert!(validate_unscoped_secret_service_id("").is_err());
        assert!(validate_unscoped_secret_service_id("addon:example-addon:api_key").is_err());
        assert!(validate_unscoped_secret_service_id("ADDON:example-addon:api_key").is_err());
    }
}
