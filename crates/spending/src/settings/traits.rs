use anyhow::Result;
use async_trait::async_trait;

/// Repository trait for spending settings — backed by the existing `app_settings`
/// k/v table. Storage layer (storage-sqlite) provides the impl.
#[async_trait]
pub trait SpendingSettingsRepositoryTrait: Send + Sync {
    /// Read a single setting value by key. Returns None if absent.
    async fn get_setting(&self, key: &str) -> Result<Option<String>>;

    /// Upsert a setting value.
    async fn set_setting(&self, key: &str, value: &str) -> Result<()>;

    /// Upsert multiple setting values in one storage transaction.
    async fn set_settings(&self, values: Vec<(String, String)>) -> Result<()>;
}
