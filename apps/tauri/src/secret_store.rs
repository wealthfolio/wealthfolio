use std::sync::{Arc, OnceLock};

use keyring_core::{api::CredentialStore, Entry};

use wealthfolio_core::{
    errors::Error,
    secrets::{SecretStore, SERVICE_PREFIX},
    Result,
};

const USERNAME: &str = "default";

#[derive(Debug)]
pub struct KeyringSecretStore {
    service_prefix: String,
}

impl KeyringSecretStore {
    pub fn new(identifier: &str) -> Self {
        Self {
            // Preserve shipped production names. Other application identities must
            // not start with SERVICE_PREFIX: legacy cleanup inventories that prefix.
            service_prefix: if identifier == crate::data_dir::PRODUCTION_APP_IDENTIFIER {
                SERVICE_PREFIX.to_owned()
            } else {
                format!("{identifier}:")
            },
        }
    }

    fn service_id(&self, service: &str) -> String {
        format!("{}{}", self.service_prefix, service.to_lowercase())
    }

    fn logical_key<'a>(&self, service: &'a str) -> Option<&'a str> {
        service.strip_prefix(&self.service_prefix)
    }

    fn entry_for(&self, service: &str) -> Result<Entry> {
        entry_for(&self.service_id(service))
    }
}

impl SecretStore for KeyringSecretStore {
    fn list_secrets(&self) -> Result<Vec<String>> {
        let entries = native_store()?
            .search(&std::collections::HashMap::new())
            .map_err(|err| Error::Secret(err.to_string()))?;
        Ok(entries
            .into_iter()
            .filter_map(|entry| entry.get_specifiers())
            .filter(|(_, user)| user == USERNAME)
            .filter_map(|(service, _)| self.logical_key(&service).map(str::to_owned))
            .collect())
    }
    fn set_secret(&self, service: &str, secret: &str) -> Result<()> {
        let entry = self.entry_for(service)?;
        entry
            .set_password(secret)
            .map_err(|err| Error::Secret(err.to_string()))
    }

    fn get_secret(&self, service: &str) -> Result<Option<String>> {
        let entry = self.entry_for(service)?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring_core::Error::NoEntry) => Ok(None),
            Err(err) => Err(Error::Secret(err.to_string())),
        }
    }

    fn delete_secret(&self, service: &str) -> Result<()> {
        let entry = self.entry_for(service)?;
        match entry.delete_credential() {
            Ok(_) | Err(keyring_core::Error::NoEntry) => Ok(()),
            Err(err) => Err(Error::Secret(err.to_string())),
        }
    }
}

fn entry_for(service_id: &str) -> Result<Entry> {
    // Keep the same Linux collection selector used by keyring 2, so another
    // collection with the same service/user cannot make an existing entry ambiguous.
    #[cfg(all(
        unix,
        not(any(target_os = "macos", target_os = "ios", target_os = "android"))
    ))]
    let modifiers = Some(std::collections::HashMap::from([("target", "default")]));
    #[cfg(not(all(
        unix,
        not(any(target_os = "macos", target_os = "ios", target_os = "android"))
    )))]
    let modifiers = None;
    native_store()?
        .build(service_id, USERNAME, modifiers.as_ref())
        .map_err(|err| Error::Secret(err.to_string()))
}

fn native_store() -> Result<&'static Arc<CredentialStore>> {
    static STORE: OnceLock<Arc<CredentialStore>> = OnceLock::new();
    if let Some(store) = STORE.get() {
        return Ok(store);
    }

    // Initialize on first use, and cache successes only. A missing Linux secret
    // service must not prevent local app startup or make a later retry impossible.
    #[cfg(target_os = "macos")]
    let store = apple_native_keyring_store::keychain::Store::new();
    #[cfg(target_os = "ios")]
    let store = apple_native_keyring_store::protected::Store::new();
    #[cfg(target_os = "android")]
    let store = android_native_keyring_store::Store::new();
    #[cfg(target_os = "windows")]
    let store = windows_native_keyring_store::Store::new();
    #[cfg(all(
        unix,
        not(any(target_os = "macos", target_os = "ios", target_os = "android"))
    ))]
    let store = zbus_secret_service_keyring_store::Store::new();

    let store: Arc<CredentialStore> = store.map_err(|err| Error::Secret(err.to_string()))?;
    Ok(STORE.get_or_init(|| store))
}

pub fn shared_secret_store(identifier: &str) -> Arc<dyn SecretStore> {
    Arc::new(KeyringSecretStore::new(identifier))
}

// MainActivity supplies the application context before Tauri starts using secrets.
#[cfg(target_os = "android")]
#[allow(non_snake_case)]
#[no_mangle]
pub extern "system" fn Java_com_teymz_wealthfolio_MainActivity_initializeSecretStoreContext(
    env: jni::JNIEnv,
    activity: jni::objects::JObject,
    context: jni::objects::JObject,
) {
    android_native_keyring_store::Java_io_crates_keyring_Keyring_00024Companion_initializeNdkContext(
        env, activity, context,
    );
}

#[cfg(test)]
mod tests;
