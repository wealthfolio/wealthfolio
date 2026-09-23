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
}

#[async_trait]
impl CategorizationRulesServiceTrait for CategorizationRulesService {
    async fn list(&self) -> Result<Vec<CategorizationRule>> {
        CategorizationRulesService::list(self).await
    }

    async fn create(&self, new_rule: NewCategorizationRule) -> Result<CategorizationRule> {
        CategorizationRulesService::create(self, new_rule).await
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
