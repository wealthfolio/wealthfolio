use std::sync::{Arc, OnceLock};

use keyring_core::{api::CredentialStore, Entry};

use wealthfolio_core::{
    errors::Error,
    secrets::{format_service_id, SecretStore},
    Result,
};

const USERNAME: &str = "default";

#[derive(Debug, Default)]
pub struct KeyringSecretStore;

impl SecretStore for KeyringSecretStore {
    fn set_secret(&self, service: &str, secret: &str) -> Result<()> {
        let entry = entry_for(service)?;
        entry
            .set_password(secret)
            .map_err(|err| Error::Secret(err.to_string()))
    }

    fn get_secret(&self, service: &str) -> Result<Option<String>> {
        let entry = entry_for(service)?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring_core::Error::NoEntry) => Ok(None),
            Err(err) => Err(Error::Secret(err.to_string())),
        }
    }

    fn delete_secret(&self, service: &str) -> Result<()> {
        let entry = entry_for(service)?;
        match entry.delete_credential() {
            Ok(_) | Err(keyring_core::Error::NoEntry) => Ok(()),
            Err(err) => Err(Error::Secret(err.to_string())),
        }
    }
}

fn entry_for(service: &str) -> Result<Entry> {
    let service_id = format_service_id(service);
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
        .build(&service_id, USERNAME, modifiers.as_ref())
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

pub fn shared_secret_store() -> Arc<dyn SecretStore> {
    Arc::new(KeyringSecretStore)
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
