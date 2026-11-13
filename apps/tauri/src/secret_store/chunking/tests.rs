use super::*;
use std::any::Any;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use keyring_core::api::{CredentialApi, CredentialPersistence, CredentialStoreApi};
use keyring_core::Credential;

#[derive(Default)]
struct State {
    values: BTreeMap<(String, String), String>,
    fail_set_after: Option<usize>,
    fail_delete_user: Option<String>,
}

#[derive(Default)]
struct Store(Arc<Mutex<State>>);

struct TestCredential {
    state: Arc<Mutex<State>>,
    service: String,
    user: String,
}

impl CredentialStoreApi for Store {
    fn vendor(&self) -> String {
        "test".into()
    }
    fn id(&self) -> String {
        "test".into()
    }
    fn build(&self, service: &str, user: &str, _: Option<&HashMap<&str, &str>>) -> Result<Entry> {
        Ok(Entry::new_with_credential(Arc::new(TestCredential {
            state: self.0.clone(),
            service: service.into(),
            user: user.into(),
        })))
    }
    fn search(&self, spec: &HashMap<&str, &str>) -> Result<Vec<Entry>> {
        let pattern = regex::Regex::new(spec.get("pattern").unwrap_or(&".*")).unwrap();
        self.0
            .lock()
            .unwrap()
            .values
            .keys()
            .filter(|(service, user)| pattern.is_match(&format!("{user}.{service}")))
            .map(|(service, user)| self.build(service, user, None))
            .collect()
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
    fn persistence(&self) -> CredentialPersistence {
        CredentialPersistence::ProcessOnly
    }
}

impl CredentialApi for TestCredential {
    fn set_secret(&self, bytes: &[u8]) -> Result<()> {
        let value = std::str::from_utf8(bytes).unwrap();
        if value.encode_utf16().count() > CHUNK_UTF16_UNITS {
            return Err(Error::TooLong("password encoded as UTF-16".into(), 2560));
        }
        let mut state = self.state.lock().unwrap();
        if let Some(remaining) = state.fail_set_after.as_mut() {
            if *remaining == 0 {
                state.fail_set_after = None;
                return Err(Error::NoStorageAccess("test failure".into()));
            }
            *remaining -= 1;
        }
        state
            .values
            .insert((self.service.clone(), self.user.clone()), value.into());
        Ok(())
    }
    fn get_secret(&self) -> Result<Vec<u8>> {
        self.state
            .lock()
            .unwrap()
            .values
            .get(&(self.service.clone(), self.user.clone()))
            .map(|value| value.as_bytes().to_vec())
            .ok_or(Error::NoEntry)
    }
    fn delete_credential(&self) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        if state.fail_delete_user.as_deref() == Some(&self.user) {
            return Err(Error::NoStorageAccess("test failure".into()));
        }
        state
            .values
            .remove(&(self.service.clone(), self.user.clone()))
            .map(|_| ())
            .ok_or(Error::NoEntry)
    }
    fn get_attributes(&self) -> Result<HashMap<String, String>> {
        Ok(HashMap::from([(
            "target_name".into(),
            format!("{}.{}", self.user, self.service),
        )]))
    }
    fn get_credential(&self) -> Result<Option<Arc<Credential>>> {
        self.get_secret().map(|_| None)
    }
    fn get_specifiers(&self) -> Option<(String, String)> {
        Some((self.service.clone(), self.user.clone()))
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
}

const SERVICE: &str = "wealthfolio_profile:one:addon:example:api.key";

#[test]
fn existing_values_and_single_credential_writes_keep_their_format() {
    let store = Store::default();
    let raw = store.build(SERVICE, USERNAME, None).unwrap();
    // Values are never sniffed for a header, including existing marker-like text.
    for value in ["legacy-α-🔑", "", "{\"version\":1,\"parts\":2}"] {
        raw.set_password(value).unwrap();
        let entry = ChunkedCredential::new(&store, SERVICE);
        assert_eq!(entry.get().unwrap().as_deref(), Some(value));
        entry.set("updated").unwrap();
        assert_eq!(raw.get_password().unwrap(), "updated");
        assert_eq!(store.0.lock().unwrap().values.len(), 1);
    }
}

#[test]
fn unicode_boundaries_and_large_values_round_trip_across_new_entries() {
    let store = Store::default();
    for value in [
        "x".repeat(1280),
        "🔑".repeat(640),
        "x".repeat(1281),
        format!("{}🔑{}", "x".repeat(1279), "α🔑".repeat(2000)),
    ] {
        ChunkedCredential::new(&store, SERVICE).set(&value).unwrap();
        assert_eq!(
            ChunkedCredential::new(&store, SERVICE).get().unwrap(),
            Some(value)
        );
        assert_eq!(list_services(&store, "wealthfolio_").unwrap(), [SERVICE]);
        assert!(store
            .0
            .lock()
            .unwrap()
            .values
            .values()
            .all(|value| value.encode_utf16().count() <= CHUNK_UTF16_UNITS));
    }
}

#[test]
fn large_updates_shrink_and_delete_remove_all_physical_credentials() {
    let store = Store::default();
    let entry = ChunkedCredential::new(&store, SERVICE);
    entry.set("legacy").unwrap();
    entry.set(&"x".repeat(3000)).unwrap();
    entry.set(&"y".repeat(7000)).unwrap();
    assert_eq!(store.0.lock().unwrap().values.len(), 7); // metadata + 6 chunks
    entry.set("short").unwrap();
    assert_eq!(store.0.lock().unwrap().values.len(), 1);
    entry.set(&"z".repeat(4000)).unwrap();
    entry.delete().unwrap();
    assert!(entry.get().unwrap().is_none());
    assert!(store.0.lock().unwrap().values.is_empty());
    entry.delete().unwrap();
}

#[test]
fn every_precommit_failure_preserves_old_values_and_cleans_new_chunks() {
    let value = "x".repeat(4000);
    for old in ["legacy".into(), "old-🔑".repeat(1000)] {
        for failure in 0..=split(&value).len() {
            let store = Store::default();
            let entry = ChunkedCredential::new(&store, SERVICE);
            entry.set(&old).unwrap();
            let before = store.0.lock().unwrap().values.clone();
            store.0.lock().unwrap().fail_set_after = Some(failure);
            assert!(entry.set(&value).is_err());
            assert_eq!(entry.get().unwrap().as_deref(), Some(old.as_str()));
            assert_eq!(store.0.lock().unwrap().values, before);
        }
    }
}

#[test]
fn failed_shrink_keeps_old_chunks_authoritative_until_metadata_is_removed() {
    let store = Store::default();
    let entry = ChunkedCredential::new(&store, SERVICE);
    let old = "x".repeat(3000);
    entry.set(&old).unwrap();
    store.0.lock().unwrap().fail_delete_user = Some(METADATA_USER.into());
    assert!(entry.set("small").is_err());
    assert_eq!(entry.get().unwrap().as_deref(), Some(old.as_str()));
    store.0.lock().unwrap().fail_delete_user = None;
    entry.set("small").unwrap();
    assert_eq!(entry.get().unwrap().as_deref(), Some("small"));
    assert_eq!(store.0.lock().unwrap().values.len(), 1);
}

#[test]
fn missing_chunks_fail_closed_instead_of_exposing_stale_plain_values() {
    let store = Store::default();
    let entry = ChunkedCredential::new(&store, SERVICE);
    entry.set(&"x".repeat(4000)).unwrap();
    let metadata = entry.metadata().unwrap().unwrap();
    delete(&entry.entry(&chunk_user(metadata.generation, 1)).unwrap()).unwrap();
    entry
        .entry(USERNAME)
        .unwrap()
        .set_password("stale")
        .unwrap();
    assert!(entry.get().is_err());
    entry.delete().unwrap();
    assert!(store.0.lock().unwrap().values.is_empty());
}

#[test]
fn invalid_metadata_is_bounded_and_still_deletable() {
    let store = Store::default();
    let entry = ChunkedCredential::new(&store, SERVICE);
    for raw in [
        "invalid".to_owned(),
        format!(
            r#"{{"version":1,"generation":"{}","parts":999999999,"bytes":999999999}}"#,
            Uuid::new_v4()
        ),
        format!(
            r#"{{"version":2,"generation":"{}","parts":1,"bytes":1}}"#,
            Uuid::new_v4()
        ),
    ] {
        entry
            .entry(METADATA_USER)
            .unwrap()
            .set_password(&raw)
            .unwrap();
        assert!(entry.get().is_err());
        assert!(entry.set("new").is_err());
        entry.delete().unwrap();
        assert!(store.0.lock().unwrap().values.is_empty());
    }
    assert!(entry.set(&"x".repeat(MAX_SECRET_BYTES + 1)).is_err());
    assert!(store.0.lock().unwrap().values.is_empty());
}

#[test]
fn maximum_value_round_trips_and_larger_writes_preserve_it() {
    let store = Store::default();
    let entry = ChunkedCredential::new(&store, SERVICE);
    let value = "x".repeat(MAX_SECRET_BYTES);
    entry.set(&value).unwrap();
    assert!(entry.get().unwrap().as_deref() == Some(value.as_str()));
    assert!(entry.set(&"y".repeat(MAX_SECRET_BYTES + 1)).is_err());
    assert!(entry.get().unwrap().as_deref() == Some(value.as_str()));
    entry.delete().unwrap();
    assert!(store.0.lock().unwrap().values.is_empty());
}

#[test]
fn cleanup_errors_do_not_undo_committed_writes_and_delete_finds_orphans() {
    let store = Store::default();
    let entry = ChunkedCredential::new(&store, SERVICE);
    entry.set(&"x".repeat(3000)).unwrap();
    let old = entry.metadata().unwrap().unwrap();
    store.0.lock().unwrap().fail_delete_user = Some(chunk_user(old.generation, 0));
    let new = "new".repeat(2000);
    entry.set(&new).unwrap();
    assert_eq!(entry.get().unwrap().as_deref(), Some(new.as_str()));
    assert!(entry.delete().is_err());
    store.0.lock().unwrap().fail_delete_user = None;
    entry.delete().unwrap();
    assert!(store.0.lock().unwrap().values.is_empty());

    entry
        .entry(&chunk_user(Uuid::new_v4(), 0))
        .unwrap()
        .set_password("orphan")
        .unwrap();
    assert_eq!(list_services(&store, "wealthfolio_").unwrap(), [SERVICE]);
    entry.delete().unwrap();
    assert!(store.0.lock().unwrap().values.is_empty());
}

#[test]
fn committed_chunks_take_precedence_when_legacy_cleanup_fails() {
    let store = Store::default();
    let entry = ChunkedCredential::new(&store, SERVICE);
    entry.set("legacy").unwrap();
    store.0.lock().unwrap().fail_delete_user = Some(USERNAME.into());
    let new = "x".repeat(3000);
    entry.set(&new).unwrap();
    assert_eq!(entry.get().unwrap().as_deref(), Some(new.as_str()));
    assert!(entry.delete().is_err());
    store.0.lock().unwrap().fail_delete_user = None;
    entry.delete().unwrap();
    assert!(store.0.lock().unwrap().values.is_empty());
}

#[test]
fn inventory_and_delete_preserve_other_profiles_apps_and_neighboring_keys() {
    let store = Store::default();
    let neighbors = [
        "wealthfolio_profile:one:addon:example:api_key",
        "wealthfolio_profile:two:addon:example:api.key",
        "com.teymz.wealthfolio.dev:profile:one:addon:example:api.key",
    ];
    for service in neighbors.iter().copied().chain([SERVICE]) {
        ChunkedCredential::new(&store, service)
            .set(&"α🔑".repeat(2000))
            .unwrap();
    }
    assert_eq!(list_services(&store, "wealthfolio_").unwrap().len(), 3);
    ChunkedCredential::new(&store, SERVICE).delete().unwrap();
    for service in neighbors {
        assert_eq!(
            ChunkedCredential::new(&store, service).get().unwrap(),
            Some("α🔑".repeat(2000))
        );
    }
    assert_eq!(
        list_services(&store, "wealthfolio_profile:one:").unwrap(),
        [neighbors[0]]
    );
}
