use std::sync::{Arc, OnceLock};

use keyring_core::api::CredentialStore;
#[cfg(not(target_os = "windows"))]
use keyring_core::Entry;

use wealthfolio_core::{
    errors::Error,
    secrets::{SecretStore, SERVICE_PREFIX},
    Result,
};

const USERNAME: &str = "default";

#[cfg(any(target_os = "windows", test))]
mod chunking;

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

    #[cfg(not(target_os = "windows"))]
    fn entry_for(&self, service: &str) -> Result<Entry> {
        entry_for(&self.service_id(service))
    }
}

impl SecretStore for KeyringSecretStore {
    fn list_secrets(&self) -> Result<Vec<String>> {
        #[cfg(target_os = "windows")]
        {
            Ok(
                chunking::list_services(native_store()?.as_ref(), &self.service_prefix)
                    .map_err(|err| native_error("list", err))?
                    .into_iter()
                    .filter_map(|service| self.logical_key(&service).map(str::to_owned))
                    .collect(),
            )
        }

        #[cfg(not(target_os = "windows"))]
        {
            let entries = native_store()?
                .search(&std::collections::HashMap::new())
                .map_err(|err| native_error("list", err))?;
            Ok(entries
                .into_iter()
                .filter_map(|entry| entry.get_specifiers())
                .filter(|(_, user)| user == USERNAME)
                .filter_map(|(service, _)| self.logical_key(&service).map(str::to_owned))
                .collect())
        }
    }
    fn set_secret(&self, service: &str, secret: &str) -> Result<()> {
        #[cfg(target_os = "windows")]
        {
            chunking::ChunkedCredential::new(native_store()?.as_ref(), &self.service_id(service))
                .set(secret)
                .map_err(|err| native_error("set", err))
        }

        #[cfg(not(target_os = "windows"))]
        {
            let entry = self.entry_for(service)?;
            entry
                .set_password(secret)
                .map_err(|err| native_error("set", err))
        }
    }

    fn get_secret(&self, service: &str) -> Result<Option<String>> {
        #[cfg(target_os = "windows")]
        {
            chunking::ChunkedCredential::new(native_store()?.as_ref(), &self.service_id(service))
                .get()
                .map_err(|err| native_error("get", err))
        }

        #[cfg(not(target_os = "windows"))]
        {
            let entry = self.entry_for(service)?;
            match entry.get_password() {
                Ok(value) => Ok(Some(value)),
                Err(keyring_core::Error::NoEntry) => Ok(None),
                Err(err) => Err(native_error("get", err)),
            }
        }
    }

    fn delete_secret(&self, service: &str) -> Result<()> {
        #[cfg(target_os = "windows")]
        {
            chunking::ChunkedCredential::new(native_store()?.as_ref(), &self.service_id(service))
                .delete()
                .map_err(|err| native_error("delete", err))
        }

        #[cfg(not(target_os = "windows"))]
        {
            let entry = self.entry_for(service)?;
            match entry.delete_credential() {
                Ok(_) | Err(keyring_core::Error::NoEntry) => Ok(()),
                Err(err) => Err(native_error("delete", err)),
            }
        }
    }
}

#[cfg(not(target_os = "windows"))]
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
        .map_err(|err| native_error("build", err))
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
    // tao initializes ndk-context with the application context in the
    // activity's onCreate, before the app starts. Initializing it again aborts.
    #[cfg(target_os = "android")]
    let store = android_native_keyring_store::Store::new();
    #[cfg(target_os = "windows")]
    let store = windows_native_keyring_store::Store::new();
    #[cfg(all(
        unix,
        not(any(target_os = "macos", target_os = "ios", target_os = "android"))
    ))]
    let store = zbus_secret_service_keyring_store::Store::new();

    let store: Arc<CredentialStore> = store.map_err(|err| native_error("initialize", err))?;
    Ok(STORE.get_or_init(|| store))
}

pub fn shared_secret_store(identifier: &str) -> Arc<dyn SecretStore> {
    Arc::new(KeyringSecretStore::new(identifier))
}

#[derive(Debug, PartialEq)]
struct NativeDiagnostic {
    kind: &'static str,
    os_code: Option<i64>,
    limit: Option<u32>,
}

fn native_diagnostic(error: &keyring_core::Error) -> NativeDiagnostic {
    use keyring_core::Error as NativeError;
    let (kind, source, limit) = match error {
        NativeError::TooLong(_, limit) => ("too_long", None, Some(*limit)),
        NativeError::NoStorageAccess(source) => ("no_storage_access", Some(source.as_ref()), None),
        NativeError::PlatformFailure(source) => ("platform_failure", Some(source.as_ref()), None),
        NativeError::BadEncoding(_) => ("bad_encoding", None, None),
        NativeError::BadDataFormat(_, _) => ("bad_data_format", None, None),
        NativeError::BadStoreFormat(_) => ("bad_store_format", None, None),
        NativeError::Invalid(_, _) => ("invalid", None, None),
        NativeError::Ambiguous(_) => ("ambiguous", None, None),
        NativeError::NoEntry => ("no_entry", None, None),
        NativeError::NoDefaultStore => ("no_default_store", None, None),
        NativeError::NotSupportedByStore(_) => ("unsupported", None, None),
        _ => ("unknown", None, None),
    };
    NativeDiagnostic {
        kind,
        os_code: source.and_then(safe_os_code),
        limit,
    }
}

fn safe_os_code(error: &(dyn std::error::Error + Send + Sync + 'static)) -> Option<i64> {
    if let Some(error) = error.downcast_ref::<std::io::Error>() {
        return error.raw_os_error().map(i64::from);
    }
    // The Windows store does not expose its numeric PlatformError type. Accept
    // only its fixed symbols/numeric format; never log arbitrary source text.
    #[cfg(target_os = "windows")]
    {
        match error.to_string().as_str() {
            "Windows ERROR_NO_SUCH_LOGON_SESSION" => Some(1312),
            "Windows ERROR_NOT_FOUND" => Some(1168),
            "Windows ERROR_BAD_USERNAME" => Some(2202),
            "Windows ERROR_INVALID_FLAGS" => Some(1004),
            "Windows ERROR_INVALID_PARAMETER" => Some(87),
            other => other
                .strip_prefix("Windows error code ")
                .and_then(|code| code.parse::<u32>().ok())
                .map(i64::from),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

fn log_native_failure(operation: &'static str, error: &keyring_core::Error) {
    let diagnostic = native_diagnostic(error);
    log::error!(
        "Native secret store {operation} failed: kind={}, os_code={:?}, limit={:?}",
        diagnostic.kind,
        diagnostic.os_code,
        diagnostic.limit,
    );
}

fn native_error(operation: &'static str, error: keyring_core::Error) -> Error {
    log_native_failure(operation, &error);
    match &error {
        keyring_core::Error::TooLong(attribute, _)
            if matches!(
                attribute.as_str(),
                "password" | "password encoded as UTF-16" | "secret" | "secret bytes"
            ) =>
        {
            Error::SecretTooLarge
        }
        keyring_core::Error::NoStorageAccess(_) => Error::SecretStoreUnavailable,
        // CredWrite also reports ERROR_NOT_ENOUGH_MEMORY when the Windows
        // credential store runs out of capacity, even for a valid small value.
        keyring_core::Error::PlatformFailure(source)
            if cfg!(target_os = "windows") && safe_os_code(source.as_ref()) == Some(8) =>
        {
            Error::SecretStoreUnavailable
        }
        _ => Error::Secret(format!(
            "Native credential {operation} failed ({})",
            native_diagnostic(&error).kind,
        )),
    }
}

#[cfg(test)]
mod tests;
