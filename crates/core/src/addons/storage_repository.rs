//! Repository trait for durable per-addon key-value storage.
//!
//! Core owns the async CRUD contract; the Diesel-backed implementation lives in
//! `storage-sqlite` (the only crate that has the schema/pool types — core must
//! stay database-agnostic). A test-only in-memory implementation backs core
//! unit tests without a database.

use async_trait::async_trait;

/// Durable string key-value storage scoped per addon.
///
/// Implementations are dumb CRUD: validation (key/value length limits) and
/// uninstall cleanup are owned by the `AddonService`.
#[async_trait]
pub trait AddonStorageRepositoryTrait: Send + Sync {
    async fn get(&self, addon_id: &str, key: &str) -> Result<Option<String>, String>;
    async fn set(&self, addon_id: &str, key: &str, value: &str) -> Result<(), String>;
    async fn delete(&self, addon_id: &str, key: &str) -> Result<(), String>;
    async fn delete_all(&self, addon_id: &str) -> Result<(), String>;
}

/// In-memory implementation used by core unit tests. Not compiled into
/// production builds (no feature flag needed until a second crate wants it).
#[cfg(test)]
#[derive(Default)]
pub struct InMemoryAddonStorageRepository {
    store: std::sync::Mutex<std::collections::HashMap<(String, String), String>>,
}

#[cfg(test)]
#[async_trait]
impl AddonStorageRepositoryTrait for InMemoryAddonStorageRepository {
    async fn get(&self, addon_id: &str, key: &str) -> Result<Option<String>, String> {
        let store = self
            .store
            .lock()
            .map_err(|_| "addon storage lock poisoned".to_string())?;
        Ok(store.get(&(addon_id.to_string(), key.to_string())).cloned())
    }

    async fn set(&self, addon_id: &str, key: &str, value: &str) -> Result<(), String> {
        let mut store = self
            .store
            .lock()
            .map_err(|_| "addon storage lock poisoned".to_string())?;
        store.insert((addon_id.to_string(), key.to_string()), value.to_string());
        Ok(())
    }

    async fn delete(&self, addon_id: &str, key: &str) -> Result<(), String> {
        let mut store = self
            .store
            .lock()
            .map_err(|_| "addon storage lock poisoned".to_string())?;
        store.remove(&(addon_id.to_string(), key.to_string()));
        Ok(())
    }

    async fn delete_all(&self, addon_id: &str) -> Result<(), String> {
        let mut store = self
            .store
            .lock()
            .map_err(|_| "addon storage lock poisoned".to_string())?;
        store.retain(|(id, _), _| id != addon_id);
        Ok(())
    }
}
