use std::sync::Arc;

use anyhow::Result;
use tokio::sync::Mutex;

use super::model::{SpendingSettings, SpendingSettingsUpdate};
use super::traits::SpendingSettingsRepositoryTrait;
use super::{SETTING_KEY_ACCOUNT_IDS, SETTING_KEY_ENABLED};

pub struct SpendingSettingsService {
    repo: Arc<dyn SpendingSettingsRepositoryTrait>,
    op_lock: Arc<Mutex<()>>,
}

impl SpendingSettingsService {
    pub fn new(repo: Arc<dyn SpendingSettingsRepositoryTrait>) -> Self {
        Self {
            repo,
            op_lock: Arc::new(Mutex::new(())),
        }
    }

    pub async fn get(&self) -> Result<SpendingSettings> {
        let _guard = self.op_lock.lock().await;
        self.read_settings().await
    }

    async fn read_settings(&self) -> Result<SpendingSettings> {
        let enabled = self
            .repo
            .get_setting(SETTING_KEY_ENABLED)
            .await?
            .map(|s| s == "true")
            .unwrap_or(false);

        let account_ids = self
            .repo
            .get_setting(SETTING_KEY_ACCOUNT_IDS)
            .await?
            .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
            .unwrap_or_default();

        Ok(SpendingSettings {
            enabled,
            account_ids,
        })
    }

    pub async fn update(&self, patch: SpendingSettingsUpdate) -> Result<SpendingSettings> {
        let (_, after) = self.update_with_previous(patch).await?;
        Ok(after)
    }

    pub async fn update_with_previous(
        &self,
        patch: SpendingSettingsUpdate,
    ) -> Result<(SpendingSettings, SpendingSettings)> {
        let _guard = self.op_lock.lock().await;
        let before = self.read_settings().await?;
        let mut values = Vec::new();
        if let Some(enabled) = patch.enabled {
            values.push((
                SETTING_KEY_ENABLED.to_string(),
                (if enabled { "true" } else { "false" }).to_string(),
            ));
        }
        if let Some(ids) = patch.account_ids {
            let json = serde_json::to_string(&ids)?;
            values.push((SETTING_KEY_ACCOUNT_IDS.to_string(), json));
        }
        if !values.is_empty() {
            self.repo.set_settings(values).await?;
        }
        let after = self.read_settings().await?;
        Ok((before, after))
    }

    /// Auto-include a new CASH account in the spending-tracked set when spending
    /// is enabled. No-op when disabled.
    pub async fn auto_include_account(&self, account_id: &str) -> Result<()> {
        let _guard = self.op_lock.lock().await;
        let mut current = self.read_settings().await?;
        if !current.enabled {
            return Ok(());
        }
        if !current.account_ids.iter().any(|id| id == account_id) {
            current.account_ids.push(account_id.to_string());
            let json = serde_json::to_string(&current.account_ids)?;
            self.repo
                .set_setting(SETTING_KEY_ACCOUNT_IDS, &json)
                .await?;
        }
        Ok(())
    }
}
