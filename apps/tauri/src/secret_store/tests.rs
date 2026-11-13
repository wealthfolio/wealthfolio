use super::*;
use wealthfolio_core::secrets::format_service_id;

const DEV_IDENTIFIER: &str = "com.teymz.wealthfolio.dev";

#[test]
fn native_failures_keep_safe_codes_without_private_diagnostics() {
    const PRIVATE: &str = "FAKE-SECRET credential-name /private/portfolio.db";
    for (native, code) in [
        (
            keyring_core::Error::TooLong("password encoded as UTF-16".into(), 2560),
            wealthfolio_core::secrets::SECRET_TOO_LARGE,
        ),
        (
            keyring_core::Error::NoStorageAccess(PRIVATE.into()),
            wealthfolio_core::secrets::SECRET_STORE_UNAVAILABLE,
        ),
        (
            keyring_core::Error::Invalid(PRIVATE.into(), PRIVATE.into()),
            "internal_error",
        ),
        (
            keyring_core::Error::TooLong(PRIVATE.into(), 50),
            "internal_error",
        ),
    ] {
        let diagnostic = format!("{:?}", native_diagnostic(&native));
        let error = native_error("set", native);
        assert_eq!(error.public_error().error_code, code);
        for text in [
            diagnostic,
            error.to_string(),
            serde_json::to_string(&error.public_error()).unwrap(),
        ] {
            for private in PRIVATE.split_whitespace() {
                assert!(!text.contains(private));
            }
        }
    }
}

#[test]
fn native_diagnostics_keep_numeric_os_errors_and_limits() {
    let error =
        keyring_core::Error::NoStorageAccess(std::io::Error::from_raw_os_error(1312).into());
    assert_eq!(
        native_diagnostic(&error),
        NativeDiagnostic {
            kind: "no_storage_access",
            os_code: Some(1312),
            limit: None,
        }
    );
    assert_eq!(
        native_diagnostic(&keyring_core::Error::TooLong("secret bytes".into(), 1024)).limit,
        Some(1024)
    );
}

#[cfg(target_os = "windows")]
#[test]
fn windows_platform_diagnostics_accept_only_fixed_symbols_or_numeric_codes() {
    for (text, expected) in [
        ("Windows ERROR_NO_SUCH_LOGON_SESSION", Some(1312)),
        ("Windows error code 87", Some(87)),
        ("Windows error code FAKE-SECRET", None),
        ("Windows ERROR_NO_SUCH_LOGON_SESSION FAKE-SECRET", None),
    ] {
        let source: keyring_core::error::PlatformError = text.into();
        assert_eq!(safe_os_code(source.as_ref()), expected);
    }
    for (status, code) in [
        (8, wealthfolio_core::secrets::SECRET_STORE_UNAVAILABLE),
        (87, "internal_error"),
    ] {
        let error =
            keyring_core::Error::PlatformFailure(format!("Windows error code {status}").into());
        assert_eq!(native_error("set", error).public_error().error_code, code);
    }
}

fn production_store() -> KeyringSecretStore {
    KeyringSecretStore::new(crate::data_dir::PRODUCTION_APP_IDENTIFIER)
}

#[test]
fn namespaces_preserve_production_and_round_trip_only_their_own_keys() {
    let production = production_store();
    let development = KeyringSecretStore::new(DEV_IDENTIFIER);
    for key in [
        "sync_refresh_token",
        "sync_identity",
        "database_encryption_key",
        "addon:example:api_key",
        "profile:11111111-1111-1111-1111-111111111111:database_encryption_key",
        "profile:11111111-1111-1111-1111-111111111111:addon:example:api_key",
    ] {
        let prod_id = production.service_id(key);
        let dev_id = development.service_id(key);
        assert_eq!(prod_id, format_service_id(key));
        assert_eq!(production.logical_key(&prod_id), Some(key));
        assert_eq!(development.logical_key(&dev_id), Some(key));
        assert_eq!(production.logical_key(&dev_id), None);
        assert_eq!(development.logical_key(&prod_id), None);
        // Older production releases also enumerate only this prefix.
        assert!(!dev_id.starts_with(SERVICE_PREFIX));
    }
    assert_eq!(
        development.service_id("API_KEY"),
        format!("{DEV_IDENTIFIER}:api_key")
    );
}

// Exercise the real profile deletion flow against a shared inventory using the
// native store's key encoding/decoding, without reading or modifying the OS vault.
struct MemoryKeyring {
    namespace: KeyringSecretStore,
    entries: Arc<std::sync::Mutex<std::collections::BTreeMap<String, String>>>,
}

impl SecretStore for MemoryKeyring {
    fn list_secrets(&self) -> Result<Vec<String>> {
        Ok(self
            .entries
            .lock()
            .unwrap()
            .keys()
            .filter_map(|key| self.namespace.logical_key(key).map(str::to_owned))
            .collect())
    }
    fn get_secret(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .entries
            .lock()
            .unwrap()
            .get(&self.namespace.service_id(key))
            .cloned())
    }
    fn set_secret(&self, key: &str, value: &str) -> Result<()> {
        self.entries
            .lock()
            .unwrap()
            .insert(self.namespace.service_id(key), value.into());
        Ok(())
    }
    fn delete_secret(&self, key: &str) -> Result<()> {
        self.entries
            .lock()
            .unwrap()
            .remove(&self.namespace.service_id(key));
        Ok(())
    }
}

#[test]
fn deleting_profiles_removes_only_credentials_in_their_environment() {
    use wealthfolio_core::profiles::ProfileRegistry;

    for delete_production in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let prod_root = directory.path().join("production");
        let dev_root = directory.path().join("development");
        std::fs::create_dir_all(&prod_root).unwrap();
        // Model an adopted legacy production profile and a fresh dev profile.
        std::fs::write(prod_root.join("app.db"), b"legacy fixture").unwrap();
        let entries = Arc::default();
        let production = ProfileRegistry::open(
            prod_root.clone(),
            prod_root.join("app.db"),
            Arc::new(MemoryKeyring {
                namespace: production_store(),
                entries: Arc::clone(&entries),
            }),
        )
        .unwrap();
        let development = ProfileRegistry::open(
            dev_root.clone(),
            dev_root.join("app.db"),
            Arc::new(MemoryKeyring {
                namespace: KeyringSecretStore::new(DEV_IDENTIFIER),
                entries: Arc::clone(&entries),
            }),
        )
        .unwrap();
        let prod_id = production.default_id().unwrap();
        let dev_id = development.default_id().unwrap();
        let prod_store = production.secret_store(&production.profile(prod_id).unwrap());
        let dev_store = development.secret_store(&development.profile(dev_id).unwrap());
        let keys = [
            "database_encryption_key",
            "sync_identity",
            "addon:example:api_key",
        ];
        for store in [&prod_store, &dev_store] {
            for key in keys {
                store.set_secret(key, "fixture").unwrap();
            }
        }
        let (deleted, id, retained) = if delete_production {
            (&production, prod_id, &dev_store)
        } else {
            (&development, dev_id, &prod_store)
        };
        deleted.begin_delete(id, "Personal", None).unwrap();
        deleted.finish_delete(id).unwrap();
        assert_eq!(entries.lock().unwrap().len(), keys.len());
        for key in keys {
            assert_eq!(
                retained.get_secret(key).unwrap().as_deref(),
                Some("fixture")
            );
        }
    }
}

struct TestSecret(String);

impl TestSecret {
    fn new() -> Self {
        Self(format!("native-store-test-{}", uuid::Uuid::new_v4()))
    }
}

impl Drop for TestSecret {
    fn drop(&mut self) {
        // A keyring panic can poison its internal mutex. Preserve the original
        // test failure instead of aborting on a second panic during cleanup.
        if !std::thread::panicking() {
            let _ = production_store().delete_secret(&self.0);
        }
    }
}

// These touch the OS credential store with unique, non-sensitive fixtures.
// Run explicitly on an unlocked desktop, or in the native-secret-store CI job.
#[test]
#[ignore = "requires an unlocked native credential store"]
fn native_store_round_trip() {
    let fixture = TestSecret::new();
    assert_native_store_round_trip(&fixture.0);
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "requires an unlocked native credential store"]
fn native_store_round_trip_on_tokio_worker() {
    // Keep cleanup outside the runtime so a regression cannot panic a second
    // time in TestSecret::drop while unwinding the original keyring panic.
    let fixture = TestSecret::new();
    let key = fixture.0.clone();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    runtime
        .block_on(async move {
            // Match desktop startup and async commands: call the synchronous
            // store directly on a worker, without spawn_blocking.
            tokio::spawn(async move { assert_native_store_round_trip(&key) }).await
        })
        .expect("native credential operations must not panic on a Tokio worker");
}

fn assert_native_store_round_trip(key: &str) {
    let store = production_store();
    assert!(store.get_secret(key).unwrap().is_none());
    store.delete_secret(key).unwrap();

    store.set_secret(key, "fixture-α-🔑").unwrap();
    // Every operation constructs a new entry, catching Android's old mock fallback.
    assert!(store.get_secret(key).unwrap().as_deref() == Some("fixture-α-🔑"));
    assert!(store
        .list_secrets()
        .unwrap()
        .iter()
        .any(|entry| entry == key));
    store.set_secret(key, "updated-fixture").unwrap();
    assert!(store.get_secret(key).unwrap().as_deref() == Some("updated-fixture"));

    store.delete_secret(key).unwrap();
    assert!(store.get_secret(key).unwrap().is_none());
    assert!(!store
        .list_secrets()
        .unwrap()
        .iter()
        .any(|entry| entry == key));
    store.delete_secret(key).unwrap();
}

#[cfg(not(target_os = "android"))]
#[test]
#[ignore = "requires an unlocked native credential store"]
fn reads_updates_and_deletes_keyring_v2_credentials() {
    let fixture = TestSecret::new();
    let legacy =
        legacy_keyring::Entry::new(&production_store().service_id(&fixture.0), USERNAME).unwrap();
    legacy.set_password("legacy-fixture-α-🔑").unwrap();

    let store = production_store();
    assert!(store.get_secret(&fixture.0).unwrap().as_deref() == Some("legacy-fixture-α-🔑"));
    store
        .set_secret(&fixture.0, "updated-fixture-α-🔑")
        .unwrap();
    assert!(legacy.get_password().unwrap() == "updated-fixture-α-🔑");

    store.delete_secret(&fixture.0).unwrap();
    assert!(matches!(
        legacy.get_password(),
        Err(legacy_keyring::Error::NoEntry)
    ));
}

#[cfg(target_os = "windows")]
#[test]
#[ignore = "requires an unlocked native credential store"]
fn windows_chunked_credentials_preserve_legacy_and_clean_up() {
    let mut fixture = TestSecret::new();
    // Include a dot to exercise Windows inventory's service/user decoding.
    fixture.0.push_str(".api_key");
    let key = fixture.0.clone();
    let store = production_store();
    let legacy = legacy_keyring::Entry::new(&store.service_id(&key), USERNAME).unwrap();
    legacy.set_password("legacy-native-fixture").unwrap();
    assert_eq!(
        store.get_secret(&key).unwrap().as_deref(),
        Some("legacy-native-fixture")
    );

    for value in ["x".repeat(1280), "x".repeat(1281), "α🔑".repeat(4000)] {
        store.set_secret(&key, &value).unwrap();
        // Recreate the store to ensure no process-local value supplies the read.
        assert_eq!(production_store().get_secret(&key).unwrap(), Some(value));
        assert_eq!(
            store
                .list_secrets()
                .unwrap()
                .iter()
                .filter(|entry| **entry == key)
                .count(),
            1
        );
    }
    let previous = "preserved-before-capacity-check".repeat(100);
    store.set_secret(&key, &previous).unwrap();
    let maximum = "x".repeat(1024 * 1024);
    match store.set_secret(&key, &maximum) {
        Ok(()) => assert_eq!(store.get_secret(&key).unwrap(), Some(maximum)),
        Err(Error::SecretStoreUnavailable) => {
            assert_eq!(store.get_secret(&key).unwrap(), Some(previous));
        }
        Err(error) => panic!("unexpected credential capacity failure: {error}"),
    }
    store.set_secret(&key, "small-again").unwrap();
    assert_eq!(legacy.get_password().unwrap(), "small-again");
    store.set_secret(&key, &"large-again".repeat(1000)).unwrap();
    store.delete_secret(&key).unwrap();
    assert!(store.get_secret(&key).unwrap().is_none());
    assert!(!store.list_secrets().unwrap().contains(&key));
    store.delete_secret(&key).unwrap();
}

#[cfg(target_os = "windows")]
#[test]
#[ignore = "requires an unlocked native credential store"]
fn windows_profile_deletion_removes_chunks_only_in_the_deleted_profile() {
    use wealthfolio_core::profiles::ProfileRegistry;

    let directory = tempfile::tempdir().unwrap();
    let registry = ProfileRegistry::open(
        directory.path().to_path_buf(),
        directory.path().join("app.db"),
        Arc::new(production_store()),
    )
    .unwrap();
    let first_id = registry.default_id().unwrap();
    let first_profile = registry.profile(first_id).unwrap();
    let second = registry
        .create(
            "Retained",
            wealthfolio_core::profiles::DEFAULT_PROFILE_AVATAR,
        )
        .unwrap();
    let first = registry.secret_store(&first_profile);
    let retained = registry.secret_store(&registry.profile(second.id).unwrap());
    let key = "addon:chunk-test:api.key";
    let value = "profile-fixture-α-🔑".repeat(400);
    first.set_secret(key, &value).unwrap();
    retained.set_secret(key, &value).unwrap();
    registry
        .begin_delete(first_id, &first_profile.name, None)
        .unwrap();
    registry.finish_delete(first_id).unwrap();
    assert!(!production_store()
        .list_secrets()
        .unwrap()
        .iter()
        .any(|entry| entry.starts_with(&format!("profile:{first_id}:"))));
    assert_eq!(retained.get_secret(key).unwrap(), Some(value));
    registry.begin_delete(second.id, "Retained", None).unwrap();
    registry.finish_delete(second.id).unwrap();
}
