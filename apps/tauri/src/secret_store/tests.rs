use super::*;

struct TestSecret(String);

impl TestSecret {
    fn new() -> Self {
        Self(format!("native-store-test-{}", uuid::Uuid::new_v4()))
    }
}

impl Drop for TestSecret {
    fn drop(&mut self) {
        let _ = KeyringSecretStore.delete_secret(&self.0);
    }
}

// These touch the OS credential store with unique, non-sensitive fixtures.
// Run explicitly on an unlocked desktop, or in the native-secret-store CI job.
#[test]
#[ignore = "requires an unlocked native credential store"]
fn native_store_round_trip() {
    let fixture = TestSecret::new();
    let store = KeyringSecretStore;
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
    let legacy = legacy_keyring::Entry::new(&format_service_id(&fixture.0), USERNAME).unwrap();
    legacy.set_password("legacy-fixture-α-🔑").unwrap();

    let store = KeyringSecretStore;
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
