use super::*;
use wealthfolio_core::secrets::format_service_id;

const DEV_IDENTIFIER: &str = "com.teymz.wealthfolio.dev";

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
        let _ = production_store().delete_secret(&self.0);
    }
}

// These touch the OS credential store with unique, non-sensitive fixtures.
// Run explicitly on an unlocked desktop, or in the native-secret-store CI job.
#[test]
#[ignore = "requires an unlocked native credential store"]
fn native_store_round_trip() {
    let fixture = TestSecret::new();
    let store = production_store();
    assert!(store.get_secret(&fixture.0).unwrap().is_none());
    store.delete_secret(&fixture.0).unwrap();

    store.set_secret(&fixture.0, "fixture-α-🔑").unwrap();
    // Every operation constructs a new entry, catching Android's old mock fallback.
    assert!(store.get_secret(&fixture.0).unwrap().as_deref() == Some("fixture-α-🔑"));
    store.set_secret(&fixture.0, "updated-fixture").unwrap();
    assert!(store.get_secret(&fixture.0).unwrap().as_deref() == Some("updated-fixture"));

    store.delete_secret(&fixture.0).unwrap();
    assert!(store.get_secret(&fixture.0).unwrap().is_none());
    store.delete_secret(&fixture.0).unwrap();
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
