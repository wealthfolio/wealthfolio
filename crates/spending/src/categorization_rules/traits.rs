use anyhow::Result;
use async_trait::async_trait;

use super::model::{CategorizationRule, NewCategorizationRule, UpdateCategorizationRule};
use super::service::CategorizationRulesService;

/// Surface of `CategorizationRulesService` consumed by agent tools.
/// Mirrors the inherent method signatures exactly.
#[async_trait]
pub trait CategorizationRulesServiceTrait: Send + Sync {
    async fn list(&self) -> Result<Vec<CategorizationRule>>;
    async fn create(&self, new_rule: NewCategorizationRule) -> Result<CategorizationRule>;
    async fn rerun_all(&self, account_ids: &[String], only_uncategorized: bool) -> Result<usize>;
    async fn rerun_detailed(
        &self,
        account_ids: &[String],
        only_uncategorized: bool,
    ) -> Result<super::model::CategorizationRunSummary> {
        Ok(super::model::CategorizationRunSummary {
            matched: self.rerun_all(account_ids, only_uncategorized).await?,
            ..Default::default()
        })
    }
    async fn preview_rerun(
        &self,
        _account_ids: &[String],
        _only_uncategorized: bool,
    ) -> Result<super::model::CategorizationRunSummary> {
        Err(anyhow::anyhow!("Rule preview unavailable"))
    }

    async fn update_reviewed(
        &self,
        expected: CategorizationRule,
        proposed: NewCategorizationRule,
    ) -> Result<CategorizationRule>;
    async fn delete_reviewed(&self, expected: CategorizationRule) -> Result<()>;
    async fn list_presets(&self) -> Result<Vec<super::presets::RulePresetSummary>>;
    async fn import_preset(
        &self,
        preset_id: &str,
        category_resolver: &std::collections::HashMap<String, (String, String)>,
    ) -> Result<super::presets::ImportPresetResult>;
    async fn remove_preset(&self, preset_id: &str) -> Result<super::presets::RemovePresetResult>;
}

#[async_trait]
impl CategorizationRulesServiceTrait for CategorizationRulesService {
    async fn rerun_detailed(
        &self,
        account_ids: &[String],
        only_uncategorized: bool,
    ) -> Result<super::model::CategorizationRunSummary> {
        CategorizationRulesService::rerun_detailed(self, account_ids, only_uncategorized).await
    }
    async fn preview_rerun(
        &self,
        account_ids: &[String],
        only_uncategorized: bool,
    ) -> Result<super::model::CategorizationRunSummary> {
        CategorizationRulesService::preview_rerun(self, account_ids, only_uncategorized).await
    }

    async fn update_reviewed(
        &self,
        expected: CategorizationRule,
        proposed: NewCategorizationRule,
    ) -> Result<CategorizationRule> {
        CategorizationRulesService::update_reviewed(self, expected, proposed).await
    }
    async fn delete_reviewed(&self, expected: CategorizationRule) -> Result<()> {
        CategorizationRulesService::delete_reviewed(self, expected).await
    }
    async fn list_presets(&self) -> Result<Vec<super::presets::RulePresetSummary>> {
        CategorizationRulesService::list_presets(self).await
    }
    async fn import_preset(
        &self,
        preset_id: &str,
        category_resolver: &std::collections::HashMap<String, (String, String)>,
    ) -> Result<super::presets::ImportPresetResult> {
        CategorizationRulesService::import_preset(self, preset_id, category_resolver).await
    }
    async fn remove_preset(&self, preset_id: &str) -> Result<super::presets::RemovePresetResult> {
        CategorizationRulesService::remove_preset(self, preset_id).await
    }

    async fn list(&self) -> Result<Vec<CategorizationRule>> {
        CategorizationRulesService::list(self).await
    }

    async fn create(&self, new_rule: NewCategorizationRule) -> Result<CategorizationRule> {
        CategorizationRulesService::create(self, new_rule).await
    }

    async fn rerun_all(&self, account_ids: &[String], only_uncategorized: bool) -> Result<usize> {
        CategorizationRulesService::rerun_all(self, account_ids, only_uncategorized).await
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PresetImportCounts {
    pub added: usize,
    pub updated: usize,
    pub skipped_existing: usize,
}

#[async_trait]
pub trait CategorizationRulesRepositoryTrait: Send + Sync {
    async fn list(&self) -> Result<Vec<CategorizationRule>>;
    async fn get(&self, id: &str) -> Result<Option<CategorizationRule>>;
    async fn create(&self, new_rule: NewCategorizationRule) -> Result<CategorizationRule>;
    async fn update(&self, id: &str, patch: UpdateCategorizationRule)
        -> Result<CategorizationRule>;
    async fn update_reviewed(
        &self,
        expected: CategorizationRule,
        patch: UpdateCategorizationRule,
    ) -> Result<CategorizationRule>;
    async fn delete_reviewed(&self, expected: CategorizationRule) -> Result<()>;
    /// Atomically create-or-update the rule identified by `new_rule.id` (required).
    /// Runs the existence check and the write in the same transaction, so two
    /// concurrent upserts of the same id can't both take the create branch.
    async fn upsert(&self, new_rule: NewCategorizationRule) -> Result<CategorizationRule>;
    /// Import or upgrade preset rules atomically.
    async fn import_preset_rules(
        &self,
        preset_id: &str,
        preset_version: &str,
        rules: Vec<NewCategorizationRule>,
    ) -> Result<PresetImportCounts>;
    async fn delete(&self, id: &str) -> Result<()>;
    /// Remove all rules originating from `preset_id`. Unmodified rules are
    /// deleted; user-modified rules are detached (preset metadata cleared) so
    /// they survive as standalone user rules. Returns `(removed, kept_modified)`.
    async fn remove_preset(&self, preset_id: &str) -> Result<(usize, usize)>;
}
