use crate::addons::validate_addon_id;
use crate::errors::Result;

/// Prefix applied to all secret identifiers to avoid collisions with other
/// applications that may share the same underlying credential store.
pub const SERVICE_PREFIX: &str = "wealthfolio_";

/// Device enrollment identity and E2EE credentials.
pub const CLOUD_REFRESH_TOKEN_KEY: &str = "sync_refresh_token";
pub const CLOUD_ACCESS_TOKEN_KEY: &str = "sync_access_token";

pub const SYNC_IDENTITY_KEY: &str = "sync_identity";

/// Retired device ID entry; used only to clean up older installations.
pub const LEGACY_SYNC_DEVICE_ID_KEY: &str = "sync_device_id";

/// Web Push VAPID signing key (RFC 8292) for the self-hosted server.
pub const WEB_PUSH_VAPID_KEY: &str = "web_push_vapid_key";
/// Web Push subscriptions registered by browsers on the self-hosted server.
/// Each holds the per-browser `auth` secret used to encrypt payloads.
pub const WEB_PUSH_SUBSCRIPTIONS_KEY: &str = "web_push_subscriptions";

/// UI pairing updates may add keys only to the enrollment they originally read.
/// Never recreate an identity removed by a Connect account change.
pub fn update_existing_sync_identity(
    store: &dyn SecretStore,
    identity: &str,
) -> std::result::Result<(), String> {
    let candidate: serde_json::Value =
        serde_json::from_str(identity).map_err(|_| "Invalid sync identity")?;
    if identity.len() > 16384 || !candidate.is_object() {
        return Err("Invalid sync identity".into());
    }
    let current = store
        .get_secret(SYNC_IDENTITY_KEY)
        .map_err(|e| e.to_string())?
        .ok_or("SYNC_IDENTITY_CHANGED: Restart device sync setup.")?;
    let current: serde_json::Value =
        serde_json::from_str(&current).map_err(|_| "Invalid stored sync identity")?;
    if current
        .get("deviceId")
        .and_then(serde_json::Value::as_str)
        .is_none()
        || current.get("deviceId") != candidate.get("deviceId")
        || current.get("deviceNonce") != candidate.get("deviceNonce")
    {
        return Err("SYNC_IDENTITY_CHANGED: Restart device sync setup.".into());
    }
    store
        .set_secret(SYNC_IDENTITY_KEY, identity)
        .map_err(|e| e.to_string())
}

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

    // Match format_service_id exactly: Unicode aliases (e.g. Kelvin sign → k)
    // must not reach a reserved credential after passing ASCII-only validation.
    let normalized = service.to_lowercase();
    if normalized.starts_with("addon:") {
        return Err("Addon-scoped secrets must use the addon secret API".to_string());
    }

    if normalized.starts_with("profile:")
        || [
            crate::profiles::PROFILE_LOCK_KEY,
            crate::profiles::DATABASE_KEY_SECRET,
            CLOUD_REFRESH_TOKEN_KEY,
            CLOUD_ACCESS_TOKEN_KEY,
            SYNC_IDENTITY_KEY,
            LEGACY_SYNC_DEVICE_ID_KEY,
            WEB_PUSH_VAPID_KEY,
            WEB_PUSH_SUBSCRIPTIONS_KEY,
        ]
        .contains(&normalized.as_str())
    {
        return Err("Internal credentials require their dedicated API".into());
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
    /// Logical key names only; secret values must never leave the store for cleanup.
    fn list_secrets(&self) -> Result<Vec<String>> {
        Err(crate::Error::Secret(
            "Credential enumeration is unavailable.".into(),
        ))
    }
    fn set_secret(&self, service: &str, secret: &str) -> Result<()>;
    fn get_secret(&self, service: &str) -> Result<Option<String>>;
    fn delete_secret(&self, service: &str) -> Result<()>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unicode_aliases_cannot_reach_reserved_credentials() {
        for (canonical, alias) in [
            ("profile_lock", "profile_locK"),
            ("database_encryption_key", "database_encryption_Key"),
            (CLOUD_REFRESH_TOKEN_KEY, "sync_refresh_toKen"),
            (CLOUD_ACCESS_TOKEN_KEY, "sync_access_toKen"),
        ] {
            assert_eq!(format_service_id(alias), format_service_id(canonical));
            assert!(validate_unscoped_secret_service_id(alias).is_err());
        }
    }

    #[test]
    fn stale_pairing_cannot_recreate_or_overwrite_another_enrollment() {
        #[derive(Default)]
        struct Store(std::sync::Mutex<Option<String>>);
        impl SecretStore for Store {
            fn get_secret(&self, _: &str) -> Result<Option<String>> {
                Ok(self.0.lock().unwrap().clone())
            }
            fn set_secret(&self, _: &str, value: &str) -> Result<()> {
                *self.0.lock().unwrap() = Some(value.into());
                Ok(())
            }
            fn delete_secret(&self, _: &str) -> Result<()> {
                *self.0.lock().unwrap() = None;
                Ok(())
            }
        }
        let store = Store::default();
        let old = r#"{"deviceId":"a","deviceNonce":"nonce-a","rootKey":"old"}"#;
        assert!(update_existing_sync_identity(&store, old).is_err());
        store
            .set_secret(
                SYNC_IDENTITY_KEY,
                r#"{"deviceId":"b","deviceNonce":"nonce-b"}"#,
            )
            .unwrap();
        assert!(update_existing_sync_identity(&store, old).is_err());
        let update = r#"{"deviceId":"b","deviceNonce":"nonce-b","rootKey":"new"}"#;
        update_existing_sync_identity(&store, update).unwrap();
        assert_eq!(
            store.get_secret(SYNC_IDENTITY_KEY).unwrap().as_deref(),
            Some(update)
        );
        assert!(
            update_existing_sync_identity(&store, r#"{"deviceId":"b","deviceNonce":"other"}"#)
                .is_err()
        );
    }

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
        for key in [
            "profile:other:sync_identity",
            "PROFILE:other:profile_lock",
            "profile_lock",
            "database_encryption_key",
            CLOUD_REFRESH_TOKEN_KEY,
            SYNC_IDENTITY_KEY,
            WEB_PUSH_VAPID_KEY,
            WEB_PUSH_SUBSCRIPTIONS_KEY,
        ] {
            assert!(validate_unscoped_secret_service_id(key).is_err(), "{key}");
        }
        assert!(validate_unscoped_secret_service_id("addon:example-addon:api_key").is_err());
        assert!(validate_unscoped_secret_service_id("ADDON:example-addon:api_key").is_err());
    }
}
