use std::collections::HashMap;
use std::sync::Arc;

use anyhow::Result;
use tokio::sync::Mutex;
use wealthfolio_core::activities::ActivityRepositoryTrait;

use super::matcher::{compile_regex_pattern, compile_rules, match_compiled, MAX_REGEX_PATTERN_LEN};
use super::model::{
    CategorizationRule, NewCategorizationRule, RuleMatchType, UpdateCategorizationRule,
};
use super::presets::{self, ImportPresetResult, RemovePresetResult, RulePresetSummary};
use super::traits::CategorizationRulesRepositoryTrait;
use crate::activity_assignments::{
    ActivityTaxonomyAssignmentService, NewActivityTaxonomyAssignment,
};
use crate::error::SpendingError;

pub struct CategorizationRulesService {
    repo: Arc<dyn CategorizationRulesRepositoryTrait>,
    activity_repo: Arc<dyn ActivityRepositoryTrait>,
    assignment_service: Arc<ActivityTaxonomyAssignmentService>,
    /// Serializes `rerun_all` against itself and against in-progress user
    /// assignments. Without this, a background rerun's pre-built skip-set
    /// can become stale relative to a concurrent manual assign, causing the
    /// rerun's bulk_apply to clobber the manual write (race tracked in #28).
    /// User-initiated `assign_*` calls are atomic at the DB layer for a
    /// single (activity, taxonomy) pair and do NOT take this lock — the lock
    /// only forces reruns to complete-or-wait, so a manual write that lands
    /// during a rerun is sequenced after the rerun's transaction.
    rerun_lock: Arc<Mutex<()>>,
}

impl CategorizationRulesService {
    pub fn new(
        repo: Arc<dyn CategorizationRulesRepositoryTrait>,
        activity_repo: Arc<dyn ActivityRepositoryTrait>,
        assignment_service: Arc<ActivityTaxonomyAssignmentService>,
    ) -> Self {
        Self {
            repo,
            activity_repo,
            assignment_service,
            rerun_lock: Arc::new(Mutex::new(())),
        }
    }

    pub async fn list(&self) -> Result<Vec<CategorizationRule>> {
        self.repo.list().await
    }
    pub async fn get(&self, id: &str) -> Result<Option<CategorizationRule>> {
        self.repo.get(id).await
    }
    pub async fn create(&self, new_rule: NewCategorizationRule) -> Result<CategorizationRule> {
        validate_rule_scope(new_rule.is_global, new_rule.account_id.as_deref())?;
        validate_rule_pattern(&new_rule.match_type, &new_rule.pattern)?;
        self.repo.create(new_rule).await
    }
    pub async fn update(
        &self,
        id: &str,
        patch: UpdateCategorizationRule,
    ) -> Result<CategorizationRule> {
        // Resolve the post-patch (is_global, account_id) and reject contradictions.
        let existing = self
            .repo
            .get(id)
            .await?
            .ok_or_else(|| SpendingError::NotFound {
                entity: "Rule",
                id: id.to_string(),
            })?;
        let new_global = patch.is_global.unwrap_or(existing.is_global);
        let new_account = match &patch.account_id {
            Some(opt) => opt.clone(),
            None => existing.account_id.clone(),
        };
        validate_rule_scope(new_global, new_account.as_deref())?;
        let new_match_type = patch.match_type.unwrap_or(existing.match_type);
        let new_pattern = patch
            .pattern
            .as_deref()
            .unwrap_or(existing.pattern.as_str());
        validate_rule_pattern(&new_match_type, new_pattern)?;
        self.repo.update(id, patch).await
    }
    pub async fn delete(&self, id: &str) -> Result<()> {
        self.repo.delete(id).await
    }

    /// Re-run all rules against existing activities. Returns count of activities
    /// matched by a rule (a rule that fires counts toward the total even when it
    /// has no category target to write — matches the prior count semantics).
    /// Filters to the provided account ids when non-empty (typically the spending accounts).
    ///
    /// `only_uncategorized=true` skips activities that already have any activity-scope
    /// assignment (spending_categories or income_sources). Default safe behavior.
    /// `only_uncategorized=false` overwrites existing rule/ai/history/import-sourced
    /// assignments with the new rule target.
    ///
    /// **Manual categorizations (`source = "manual"`) are always preserved**, in
    /// both modes. A user's explicit choice should never be wiped by a rule re-run.
    pub async fn rerun_all(
        &self,
        account_ids: &[String],
        only_uncategorized: bool,
    ) -> Result<usize> {
        if account_ids.is_empty() {
            return Ok(0);
        }
        // Hold for the entire read-skip-set + write phase so two reruns can't
        // interleave (each computes its own skip-set, then both writes fire).
        let _guard = self.rerun_lock.lock().await;
        let activities = self
            .activity_repo
            .get_activities_by_account_ids(account_ids)
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;

        let ids: Vec<String> = activities.iter().map(|a| a.id.clone()).collect();
        let assignments = self.assignment_service.list_for_activities(&ids).await?;

        // Skip-key is (activity_id, taxonomy_id) — never `activity_id` alone.
        // That preserves cross-taxonomy independence: a manual `income_sources`
        // assignment must not block a `spending_categories` rule for the same
        // activity. We also no longer hardcode the taxonomy ids — we trust the
        // assignment row's own `source` field.
        //
        // - `manual_keys`: pairs that must never be overwritten (manual wins).
        // - `any_keys`:    pairs with any existing assignment — used only when
        //   `only_uncategorized=true` to block rule-overwrites of rule/import/ai
        //   assignments.
        let mut manual_keys: std::collections::HashSet<(String, String)> =
            std::collections::HashSet::new();
        let mut any_keys: std::collections::HashSet<(String, String)> =
            std::collections::HashSet::new();
        for a in &assignments {
            let key = (a.activity_id.clone(), a.taxonomy_id.clone());
            if a.source == "manual" {
                manual_keys.insert(key.clone());
            }
            any_keys.insert(key);
        }

        let rules = self.repo.list().await?;
        let compiled = compile_rules(&rules);

        let mut matched_count = 0usize;
        let mut writes: Vec<NewActivityTaxonomyAssignment> = Vec::with_capacity(activities.len());
        for a in &activities {
            let notes_raw = a.notes.as_deref().unwrap_or("");
            let notes_upper = notes_raw.to_uppercase();
            let Some(m) = match_compiled(
                &compiled,
                &notes_upper,
                notes_raw,
                a.effective_type(),
                &a.account_id,
            ) else {
                continue;
            };
            matched_count += 1;
            if let (Some(tax_id), Some(cat_id)) =
                (m.rule.taxonomy_id.clone(), m.rule.category_id.clone())
            {
                let key = (a.id.clone(), tax_id.clone());
                if manual_keys.contains(&key) {
                    continue;
                }
                if only_uncategorized && any_keys.contains(&key) {
                    continue;
                }
                writes.push(NewActivityTaxonomyAssignment {
                    id: None,
                    activity_id: a.id.clone(),
                    taxonomy_id: tax_id,
                    category_id: cat_id,
                    weight: 10_000,
                    source: "rule".to_string(),
                });
            }
        }

        self.assignment_service
            .bulk_apply_rule_assignments(writes, only_uncategorized)
            .await?;
        Ok(matched_count)
    }

    /// List the bundled presets, marking which ones the user already has installed
    /// and at what version. Used by the picker UI on the rules page.
    pub async fn list_presets(&self) -> Result<Vec<RulePresetSummary>> {
        let installed_rules = self.repo.list().await?;
        let installed_versions = presets::installed_versions(
            installed_rules
                .iter()
                .map(|r| (&r.preset_id, &r.preset_version)),
        );
        Ok(presets::load_all_presets()
            .into_iter()
            .map(|p| {
                let installed_version = installed_versions.get(&p.preset_id).cloned();
                RulePresetSummary {
                    installed: installed_version.is_some(),
                    installed_version,
                    rule_count: p.rules.len(),
                    preset_id: p.preset_id,
                    preset_version: p.preset_version,
                    name: p.name,
                    description: p.description,
                    language: p.language,
                }
            })
            .collect())
    }

    /// Import a preset's rules into the user's DB. Skips rules already installed
    /// (by `(preset_id, preset_rule_key)`) and rules whose `categoryKey` doesn't
    /// resolve to a seeded category. Idempotent — safe to call repeatedly.
    ///
    /// `category_resolver` maps a category `key` (e.g. "food_groceries") to the
    /// pair `(taxonomy_id, category_id)`. Caller (typically the IPC layer)
    /// builds it from the taxonomy service.
    pub async fn import_preset(
        &self,
        preset_id: &str,
        category_resolver: &HashMap<String, (String, String)>,
    ) -> Result<ImportPresetResult> {
        let preset =
            presets::load_preset(preset_id).ok_or_else(|| SpendingError::InvalidInput {
                message: format!("Unknown preset: {preset_id}"),
            })?;

        let mut result = ImportPresetResult {
            preset_id: preset.preset_id.clone(),
            preset_version: preset.preset_version.clone(),
            total: preset.rules.len(),
            ..Default::default()
        };
        let mut rules_to_import = Vec::new();

        for rule in preset.rules {
            let Some((tax_id, cat_id)) = category_resolver.get(&rule.category_key).cloned() else {
                log::warn!(
                    "Preset '{}' rule '{}' references unknown categoryKey '{}' — skipped",
                    preset.preset_id,
                    rule.key,
                    rule.category_key,
                );
                result.skipped_unknown_category += 1;
                continue;
            };
            let match_type = RuleMatchType::try_parse(&rule.match_type).ok_or_else(|| {
                SpendingError::InvalidInput {
                    message: format!(
                        "Unknown matchType '{}' in preset '{}' rule '{}'",
                        rule.match_type, preset.preset_id, rule.key
                    ),
                }
            })?;

            let new_rule = NewCategorizationRule {
                id: None,
                name: rule.name,
                pattern: rule.pattern,
                match_type,
                taxonomy_id: Some(tax_id),
                category_id: Some(cat_id),
                activity_type: None,
                priority: rule.priority,
                is_global: true,
                account_id: None,
                preset_id: Some(preset.preset_id.clone()),
                preset_rule_key: Some(rule.key.clone()),
                preset_version: Some(preset.preset_version.clone()),
            };
            validate_rule_pattern(&new_rule.match_type, &new_rule.pattern)?;
            rules_to_import.push(new_rule);
        }

        let counts = self
            .repo
            .import_preset_rules(&preset.preset_id, &preset.preset_version, rules_to_import)
            .await?;
        result.added = counts.added;
        result.updated = counts.updated;
        result.skipped_existing = counts.skipped_existing;
        Ok(result)
    }

    /// Uninstall a preset. Unmodified rules are deleted; user-modified rules
    /// are detached (preset metadata cleared) so the user's edits survive as
    /// standalone rules.
    pub async fn remove_preset(&self, preset_id: &str) -> Result<RemovePresetResult> {
        let (removed, kept_modified) = self.repo.remove_preset(preset_id).await?;
        Ok(RemovePresetResult {
            preset_id: preset_id.to_string(),
            removed,
            kept_modified,
        })
    }
}

fn validate_rule_pattern(match_type: &RuleMatchType, pattern: &str) -> Result<()> {
    if !matches!(match_type, RuleMatchType::Regex) {
        return Ok(());
    }
    if pattern.len() > MAX_REGEX_PATTERN_LEN {
        return Err(SpendingError::InvalidInput {
            message: format!("Regex pattern must be {MAX_REGEX_PATTERN_LEN} characters or fewer"),
        }
        .into());
    }
    compile_regex_pattern(pattern).map_err(|err| SpendingError::InvalidInput {
        message: format!("Invalid regex pattern: {err}"),
    })?;
    Ok(())
}

fn validate_rule_scope(is_global: bool, account_id: Option<&str>) -> Result<()> {
    if is_global && account_id.is_some() {
        return Err(SpendingError::GlobalRuleHasAccount.into());
    }
    if !is_global && account_id.unwrap_or_default().is_empty() {
        return Err(SpendingError::InvalidInput {
            message: "Account-scoped rules require accountId".to_string(),
        }
        .into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::activity_assignments::{
        ActivityTaxonomyAssignment, ActivityTaxonomyAssignmentRepositoryTrait,
    };
    use async_trait::async_trait;
    use chrono::{DateTime, NaiveDate, Utc};
    use std::sync::Mutex;
    use wealthfolio_core::activities::{
        Activity, ActivityBulkMutationResult, ActivitySearchResponse, ActivityStatus,
        ActivityUpdate, ActivityUpsert, BulkUpsertResult, ImportMapping, ImportTemplate,
        IncomeData, NewActivity, Sort,
    };
    use wealthfolio_core::limits::ContributionActivity;

    struct MockRulesRepo {
        rules: Mutex<Vec<CategorizationRule>>,
    }

    #[async_trait]
    impl CategorizationRulesRepositoryTrait for MockRulesRepo {
        async fn list(&self) -> Result<Vec<CategorizationRule>> {
            Ok(self.rules.lock().unwrap().clone())
        }
        async fn get(&self, id: &str) -> Result<Option<CategorizationRule>> {
            Ok(self
                .rules
                .lock()
                .unwrap()
                .iter()
                .find(|rule| rule.id == id)
                .cloned())
        }
        async fn create(&self, n: NewCategorizationRule) -> Result<CategorizationRule> {
            let now = Utc::now().naive_utc();
            let rule = CategorizationRule {
                id: n.id.unwrap_or_else(|| {
                    format!("rule-{}", now.and_utc().timestamp_nanos_opt().unwrap())
                }),
                name: n.name,
                pattern: n.pattern,
                match_type: n.match_type,
                taxonomy_id: n.taxonomy_id,
                category_id: n.category_id,
                activity_type: n.activity_type,
                priority: n.priority,
                is_global: n.is_global,
                account_id: n.account_id,
                preset_id: n.preset_id,
                preset_rule_key: n.preset_rule_key,
                preset_version: n.preset_version,
                preset_modified: false,
                created_at: now,
                updated_at: now,
            };
            self.rules.lock().unwrap().push(rule.clone());
            Ok(rule)
        }
        async fn update(
            &self,
            _id: &str,
            _p: UpdateCategorizationRule,
        ) -> Result<CategorizationRule> {
            unimplemented!()
        }
        async fn import_preset_rules(
            &self,
            preset_id: &str,
            preset_version: &str,
            new_rules: Vec<NewCategorizationRule>,
        ) -> Result<crate::categorization_rules::PresetImportCounts> {
            let mut rules = self.rules.lock().unwrap();
            let mut counts = crate::categorization_rules::PresetImportCounts::default();
            for n in new_rules {
                let Some(rule_key) = n.preset_rule_key.clone() else {
                    continue;
                };
                let existing = rules.iter_mut().find(|rule| {
                    rule.preset_id.as_deref() == Some(preset_id)
                        && rule.preset_rule_key.as_deref() == Some(rule_key.as_str())
                });
                if let Some(existing) = existing {
                    if existing.preset_modified
                        || existing.preset_version.as_deref() == Some(preset_version)
                    {
                        counts.skipped_existing += 1;
                        continue;
                    }
                    existing.name = n.name;
                    existing.pattern = n.pattern;
                    existing.match_type = n.match_type;
                    existing.taxonomy_id = n.taxonomy_id;
                    existing.category_id = n.category_id;
                    existing.activity_type = n.activity_type;
                    existing.priority = n.priority;
                    existing.is_global = n.is_global;
                    existing.account_id = n.account_id;
                    existing.preset_id = n.preset_id;
                    existing.preset_rule_key = n.preset_rule_key;
                    existing.preset_version = n.preset_version;
                    existing.preset_modified = false;
                    existing.updated_at = Utc::now().naive_utc();
                    counts.updated += 1;
                    continue;
                }

                let now = Utc::now().naive_utc();
                rules.push(CategorizationRule {
                    id: n.id.unwrap_or_else(|| {
                        format!("rule-{}", now.and_utc().timestamp_nanos_opt().unwrap())
                    }),
                    name: n.name,
                    pattern: n.pattern,
                    match_type: n.match_type,
                    taxonomy_id: n.taxonomy_id,
                    category_id: n.category_id,
                    activity_type: n.activity_type,
                    priority: n.priority,
                    is_global: n.is_global,
                    account_id: n.account_id,
                    preset_id: n.preset_id,
                    preset_rule_key: n.preset_rule_key,
                    preset_version: n.preset_version,
                    preset_modified: false,
                    created_at: now,
                    updated_at: now,
                });
                counts.added += 1;
            }
            Ok(counts)
        }
        async fn delete(&self, _id: &str) -> Result<()> {
            unimplemented!()
        }
        async fn remove_preset(&self, _id: &str) -> Result<(usize, usize)> {
            unimplemented!()
        }
    }

    #[derive(Default)]
    struct MockAssignmentRepo {
        existing: Mutex<Vec<ActivityTaxonomyAssignment>>,
        writes: Mutex<Vec<NewActivityTaxonomyAssignment>>,
    }

    #[async_trait]
    impl ActivityTaxonomyAssignmentRepositoryTrait for MockAssignmentRepo {
        async fn list_for_activity(&self, _: &str) -> Result<Vec<ActivityTaxonomyAssignment>> {
            unimplemented!()
        }
        async fn list_for_activities(
            &self,
            ids: &[String],
        ) -> Result<Vec<ActivityTaxonomyAssignment>> {
            let id_set: std::collections::HashSet<&str> = ids.iter().map(String::as_str).collect();
            Ok(self
                .existing
                .lock()
                .unwrap()
                .iter()
                .filter(|a| id_set.contains(a.activity_id.as_str()))
                .cloned()
                .collect())
        }
        async fn upsert(
            &self,
            _: NewActivityTaxonomyAssignment,
        ) -> Result<ActivityTaxonomyAssignment> {
            unimplemented!()
        }
        async fn assign_many_single_select(
            &self,
            items: Vec<NewActivityTaxonomyAssignment>,
        ) -> Result<Vec<ActivityTaxonomyAssignment>> {
            self.writes.lock().unwrap().extend(items.iter().cloned());
            // Mirror real DB: a successful write becomes visible to subsequent
            // `list_for_activities` calls. Replaces any prior row with the
            // same (activity_id, taxonomy_id) pair to match the storage layer's
            // single-select delete-then-insert semantics.
            let rows: Vec<ActivityTaxonomyAssignment> = items
                .into_iter()
                .map(|n| ActivityTaxonomyAssignment {
                    id: format!("row-{}-{}", n.activity_id, n.taxonomy_id),
                    activity_id: n.activity_id,
                    taxonomy_id: n.taxonomy_id,
                    category_id: n.category_id,
                    weight: n.weight,
                    source: n.source,
                    created_at: Utc::now().naive_utc(),
                    updated_at: Utc::now().naive_utc(),
                })
                .collect();
            {
                let mut existing = self.existing.lock().unwrap();
                for row in &rows {
                    existing.retain(|a| {
                        !(a.activity_id == row.activity_id && a.taxonomy_id == row.taxonomy_id)
                    });
                    existing.push(row.clone());
                }
            }
            Ok(rows)
        }

        async fn assign_many_single_select_clearing_splits(
            &self,
            items: Vec<NewActivityTaxonomyAssignment>,
        ) -> Result<Vec<ActivityTaxonomyAssignment>> {
            self.assign_many_single_select(items).await
        }
        async fn assign_rule_many_single_select(
            &self,
            items: Vec<NewActivityTaxonomyAssignment>,
            only_uncategorized: bool,
        ) -> Result<Vec<ActivityTaxonomyAssignment>> {
            let mut rows = Vec::new();
            let mut existing = self.existing.lock().unwrap();
            for item in items {
                let current: Vec<ActivityTaxonomyAssignment> = existing
                    .iter()
                    .filter(|a| {
                        a.activity_id == item.activity_id && a.taxonomy_id == item.taxonomy_id
                    })
                    .cloned()
                    .collect();
                if current
                    .iter()
                    .any(|a| a.source.eq_ignore_ascii_case("manual"))
                {
                    continue;
                }
                if only_uncategorized && !current.is_empty() {
                    continue;
                }
                self.writes.lock().unwrap().push(item.clone());
                let row = ActivityTaxonomyAssignment {
                    id: format!("row-{}-{}", item.activity_id, item.taxonomy_id),
                    activity_id: item.activity_id,
                    taxonomy_id: item.taxonomy_id,
                    category_id: item.category_id,
                    weight: item.weight,
                    source: item.source,
                    created_at: Utc::now().naive_utc(),
                    updated_at: Utc::now().naive_utc(),
                };
                existing.retain(|a| {
                    !(a.activity_id == row.activity_id && a.taxonomy_id == row.taxonomy_id)
                });
                existing.push(row.clone());
                rows.push(row);
            }
            Ok(rows)
        }
        async fn delete(&self, _id: &str) -> Result<()> {
            unimplemented!()
        }
        async fn clear_for_taxonomy(&self, _: &str, _: &str) -> Result<()> {
            unimplemented!()
        }
    }

    struct MockActivityRepo {
        activities: Vec<Activity>,
    }

    fn mk_activity(id: &str, account: &str, notes: &str) -> Activity {
        Activity {
            id: id.to_string(),
            account_id: account.to_string(),
            asset_id: None,
            activity_type: "WITHDRAWAL".to_string(),
            activity_type_override: None,
            source_type: None,
            subtype: None,
            status: ActivityStatus::Posted,
            activity_date: Utc::now(),
            settlement_date: None,
            quantity: None,
            unit_price: None,
            amount: None,
            fee: None,
            tax: None,
            currency: "USD".to_string(),
            fx_rate: None,
            notes: Some(notes.to_string()),
            metadata: None,
            source_system: None,
            source_record_id: None,
            source_group_id: None,
            idempotency_key: None,
            import_run_id: None,
            is_user_modified: false,
            needs_review: false,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    #[async_trait]
    impl ActivityRepositoryTrait for MockActivityRepo {
        fn get_activity(&self, _: &str) -> wealthfolio_core::Result<Activity> {
            unimplemented!()
        }
        fn find_transfer_counterpart(
            &self,
            _group_id: &str,
            _exclude_id: &str,
        ) -> wealthfolio_core::Result<Option<Activity>> {
            Ok(None)
        }
        fn get_activities(&self) -> wealthfolio_core::Result<Vec<Activity>> {
            Ok(self.activities.clone())
        }
        fn get_activities_by_account_id(&self, _: &str) -> wealthfolio_core::Result<Vec<Activity>> {
            unimplemented!()
        }
        fn get_activities_by_account_ids(
            &self,
            ids: &[String],
        ) -> wealthfolio_core::Result<Vec<Activity>> {
            let set: std::collections::HashSet<&str> = ids.iter().map(String::as_str).collect();
            Ok(self
                .activities
                .iter()
                .filter(|a| set.contains(a.account_id.as_str()))
                .cloned()
                .collect())
        }
        fn get_trading_activities(&self) -> wealthfolio_core::Result<Vec<Activity>> {
            unimplemented!()
        }
        fn get_income_activities(&self) -> wealthfolio_core::Result<Vec<Activity>> {
            unimplemented!()
        }
        fn get_contribution_activities(
            &self,
            _: &[String],
            _: DateTime<Utc>,
            _: DateTime<Utc>,
        ) -> wealthfolio_core::Result<Vec<ContributionActivity>> {
            unimplemented!()
        }
        fn search_activities(
            &self,
            _: i64,
            _: i64,
            _: Option<Vec<String>>,
            _: Option<Vec<String>>,
            _: Option<String>,
            _: Option<Sort>,
            _: Option<bool>,
            _: Option<NaiveDate>,
            _: Option<NaiveDate>,
            _: Option<Vec<String>>,
            _: Option<Vec<String>>,
        ) -> wealthfolio_core::Result<ActivitySearchResponse> {
            unimplemented!()
        }
        async fn create_activity(&self, _: NewActivity) -> wealthfolio_core::Result<Activity> {
            unimplemented!()
        }
        async fn update_activity(&self, _: ActivityUpdate) -> wealthfolio_core::Result<Activity> {
            unimplemented!()
        }
        async fn delete_activity(&self, _: String) -> wealthfolio_core::Result<Activity> {
            unimplemented!()
        }
        async fn link_transfer_activities(
            &self,
            _: String,
            _: String,
        ) -> wealthfolio_core::Result<(Activity, Activity)> {
            unimplemented!()
        }
        async fn unlink_transfer_activities(
            &self,
            _: String,
            _: String,
        ) -> wealthfolio_core::Result<(Activity, Activity)> {
            unimplemented!()
        }
        async fn bulk_mutate_activities(
            &self,
            _: Vec<NewActivity>,
            _: Vec<ActivityUpdate>,
            _: Vec<String>,
        ) -> wealthfolio_core::Result<ActivityBulkMutationResult> {
            unimplemented!()
        }
        async fn create_activities(&self, _: Vec<NewActivity>) -> wealthfolio_core::Result<usize> {
            unimplemented!()
        }
        fn get_first_activity_date(
            &self,
            _: Option<&[String]>,
        ) -> wealthfolio_core::Result<Option<DateTime<Utc>>> {
            unimplemented!()
        }
        fn get_import_mapping(
            &self,
            _: &str,
            _: &str,
        ) -> wealthfolio_core::Result<Option<ImportMapping>> {
            unimplemented!()
        }
        async fn save_import_mapping(&self, _: &ImportMapping) -> wealthfolio_core::Result<()> {
            unimplemented!()
        }
        async fn link_account_template(
            &self,
            _: &str,
            _: &str,
            _: &str,
        ) -> wealthfolio_core::Result<()> {
            unimplemented!()
        }
        fn list_import_templates(&self) -> wealthfolio_core::Result<Vec<ImportTemplate>> {
            unimplemented!()
        }
        fn get_import_template(&self, _: &str) -> wealthfolio_core::Result<Option<ImportTemplate>> {
            unimplemented!()
        }
        async fn save_import_template(&self, _: &ImportTemplate) -> wealthfolio_core::Result<()> {
            unimplemented!()
        }
        async fn delete_import_template(&self, _: &str) -> wealthfolio_core::Result<()> {
            unimplemented!()
        }
        fn get_broker_sync_profile(
            &self,
            _: &str,
            _: &str,
        ) -> wealthfolio_core::Result<Option<ImportTemplate>> {
            unimplemented!()
        }
        async fn save_broker_sync_profile(
            &self,
            _: &ImportTemplate,
        ) -> wealthfolio_core::Result<()> {
            unimplemented!()
        }
        async fn link_broker_sync_profile(
            &self,
            _: &str,
            _: &str,
            _: &str,
        ) -> wealthfolio_core::Result<()> {
            unimplemented!()
        }
        fn calculate_average_cost(
            &self,
            _: &str,
            _: &str,
        ) -> wealthfolio_core::Result<rust_decimal::Decimal> {
            unimplemented!()
        }
        fn get_income_activities_data(
            &self,
            _: Option<&[String]>,
        ) -> wealthfolio_core::Result<Vec<IncomeData>> {
            unimplemented!()
        }
        fn get_first_activity_date_overall(&self) -> wealthfolio_core::Result<DateTime<Utc>> {
            unimplemented!()
        }
        fn get_activity_bounds_for_assets(
            &self,
            _: &[String],
        ) -> wealthfolio_core::Result<HashMap<String, (Option<NaiveDate>, Option<NaiveDate>)>>
        {
            unimplemented!()
        }
        fn get_holdings_snapshot_bounds_for_assets(
            &self,
            _: &[String],
        ) -> wealthfolio_core::Result<HashMap<String, (Option<NaiveDate>, Option<NaiveDate>)>>
        {
            unimplemented!()
        }
        fn check_existing_duplicates(
            &self,
            _: &[String],
        ) -> wealthfolio_core::Result<HashMap<String, String>> {
            unimplemented!()
        }
        async fn bulk_upsert(
            &self,
            _: Vec<ActivityUpsert>,
        ) -> wealthfolio_core::Result<BulkUpsertResult> {
            unimplemented!()
        }
        async fn reassign_asset(&self, _: &str, _: &str) -> wealthfolio_core::Result<u32> {
            unimplemented!()
        }
        async fn get_activity_accounts_and_currencies_by_asset_id(
            &self,
            _: &str,
        ) -> wealthfolio_core::Result<(Vec<String>, Vec<String>)> {
            unimplemented!()
        }
    }

    fn mk_rule(id: &str, pattern: &str, tax: &str, cat: &str, priority: i32) -> CategorizationRule {
        CategorizationRule {
            id: id.to_string(),
            name: id.to_string(),
            pattern: pattern.to_string(),
            match_type: RuleMatchType::Contains,
            taxonomy_id: Some(tax.to_string()),
            category_id: Some(cat.to_string()),
            activity_type: None,
            priority,
            is_global: true,
            account_id: None,
            preset_id: None,
            preset_rule_key: None,
            preset_version: None,
            preset_modified: false,
            created_at: Utc::now().naive_utc(),
            updated_at: Utc::now().naive_utc(),
        }
    }

    fn mk_assignment(
        activity_id: &str,
        tax: &str,
        cat: &str,
        source: &str,
    ) -> ActivityTaxonomyAssignment {
        ActivityTaxonomyAssignment {
            id: format!("a-{activity_id}-{tax}"),
            activity_id: activity_id.to_string(),
            taxonomy_id: tax.to_string(),
            category_id: cat.to_string(),
            weight: 10_000,
            source: source.to_string(),
            created_at: Utc::now().naive_utc(),
            updated_at: Utc::now().naive_utc(),
        }
    }

    #[tokio::test]
    async fn rerun_does_not_skip_cross_taxonomy_for_manual_income() {
        // Activity has a manual income_sources assignment and NO spending_categories
        // assignment. A rule targeting spending_categories should still apply.
        let rule = mk_rule("r1", "AMAZON", "spending_categories", "cat_food", 10);
        let rules_repo = Arc::new(MockRulesRepo {
            rules: Mutex::new(vec![rule]),
        });
        let assignment_repo = Arc::new(MockAssignmentRepo {
            existing: Mutex::new(vec![mk_assignment(
                "act1",
                "income_sources",
                "src_paycheck",
                "manual",
            )]),
            writes: Mutex::new(vec![]),
        });
        let activity_repo = Arc::new(MockActivityRepo {
            activities: vec![mk_activity("act1", "acct1", "AMAZON ORDER #123")],
        });
        let assignment_service = Arc::new(ActivityTaxonomyAssignmentService::new(
            assignment_repo.clone() as Arc<dyn ActivityTaxonomyAssignmentRepositoryTrait>,
        ));
        let svc = CategorizationRulesService::new(
            rules_repo as Arc<dyn CategorizationRulesRepositoryTrait>,
            activity_repo as Arc<dyn ActivityRepositoryTrait>,
            assignment_service,
        );

        let matched = svc
            .rerun_all(&["acct1".to_string()], /* only_uncategorized */ false)
            .await
            .unwrap();
        assert_eq!(matched, 1, "rule should have matched");

        let writes = assignment_repo.writes.lock().unwrap();
        assert_eq!(
            writes.len(),
            1,
            "spending_categories assignment should be written"
        );
        assert_eq!(writes[0].activity_id, "act1");
        assert_eq!(writes[0].taxonomy_id, "spending_categories");
        assert_eq!(writes[0].category_id, "cat_food");

        // The existing manual income_sources row is untouched — nothing was
        // written targeting (act1, income_sources).
        assert!(!writes.iter().any(|w| w.taxonomy_id == "income_sources"));
        let still_there = assignment_repo
            .existing
            .lock()
            .unwrap()
            .iter()
            .any(|a| a.taxonomy_id == "income_sources" && a.source == "manual");
        assert!(still_there);
    }

    #[tokio::test]
    async fn rerun_preserves_manual_same_taxonomy() {
        let rule = mk_rule("r1", "AMAZON", "spending_categories", "cat_food", 10);
        let rules_repo = Arc::new(MockRulesRepo {
            rules: Mutex::new(vec![rule]),
        });
        let assignment_repo = Arc::new(MockAssignmentRepo {
            existing: Mutex::new(vec![mk_assignment(
                "act1",
                "spending_categories",
                "cat_other",
                "manual",
            )]),
            writes: Mutex::new(vec![]),
        });
        let activity_repo = Arc::new(MockActivityRepo {
            activities: vec![mk_activity("act1", "acct1", "AMAZON ORDER #123")],
        });
        let assignment_service = Arc::new(ActivityTaxonomyAssignmentService::new(
            assignment_repo.clone() as Arc<dyn ActivityTaxonomyAssignmentRepositoryTrait>,
        ));
        let svc = CategorizationRulesService::new(
            rules_repo as Arc<dyn CategorizationRulesRepositoryTrait>,
            activity_repo as Arc<dyn ActivityRepositoryTrait>,
            assignment_service,
        );

        let _ = svc.rerun_all(&["acct1".to_string()], false).await.unwrap();
        let writes = assignment_repo.writes.lock().unwrap();
        assert!(
            writes.is_empty(),
            "manual same-taxonomy must block the rule"
        );
    }

    #[tokio::test]
    async fn concurrent_rerun_all_do_not_interleave() {
        // Two reruns are spawned concurrently against the same single matching
        // activity with `only_uncategorized=true`. With the rerun_lock in place,
        // the first rerun's write becomes visible to the second's skip-set
        // (the mock now mirrors writes into `existing`), so the second rerun
        // writes nothing. Without the lock, both skip-sets are built before
        // either write fires and the activity is written twice.
        let rule = mk_rule("r1", "AMAZON", "spending_categories", "cat_food", 10);
        let rules_repo = Arc::new(MockRulesRepo {
            rules: Mutex::new(vec![rule]),
        });
        let assignment_repo = Arc::new(MockAssignmentRepo::default());
        let activity_repo = Arc::new(MockActivityRepo {
            activities: vec![mk_activity("act1", "acct1", "AMAZON ORDER #123")],
        });
        let assignment_service = Arc::new(ActivityTaxonomyAssignmentService::new(
            assignment_repo.clone() as Arc<dyn ActivityTaxonomyAssignmentRepositoryTrait>,
        ));
        let svc = Arc::new(CategorizationRulesService::new(
            rules_repo as Arc<dyn CategorizationRulesRepositoryTrait>,
            activity_repo as Arc<dyn ActivityRepositoryTrait>,
            assignment_service,
        ));

        let svc_a = svc.clone();
        let svc_b = svc.clone();
        let (a, b) = tokio::join!(
            tokio::spawn(async move {
                svc_a
                    .rerun_all(&["acct1".to_string()], /* only_uncategorized */ true)
                    .await
            }),
            tokio::spawn(async move {
                svc_b
                    .rerun_all(&["acct1".to_string()], /* only_uncategorized */ true)
                    .await
            }),
        );
        a.unwrap().unwrap();
        b.unwrap().unwrap();

        let writes = assignment_repo.writes.lock().unwrap();
        assert_eq!(
            writes.len(),
            1,
            "with serialized reruns, the second rerun's skip-set must see the first's write and skip — got {} writes ({:?})",
            writes.len(),
            writes
                .iter()
                .map(|w| (w.activity_id.clone(), w.taxonomy_id.clone()))
                .collect::<Vec<_>>()
        );
    }

    #[tokio::test]
    async fn create_rejects_global_with_account_id() {
        let rules_repo = Arc::new(MockRulesRepo {
            rules: Mutex::new(vec![]),
        });
        let assignment_repo = Arc::new(MockAssignmentRepo::default());
        let assignment_service = Arc::new(ActivityTaxonomyAssignmentService::new(
            assignment_repo as Arc<dyn ActivityTaxonomyAssignmentRepositoryTrait>,
        ));
        let activity_repo = Arc::new(MockActivityRepo { activities: vec![] });
        let svc = CategorizationRulesService::new(
            rules_repo as Arc<dyn CategorizationRulesRepositoryTrait>,
            activity_repo as Arc<dyn ActivityRepositoryTrait>,
            assignment_service,
        );

        let err = svc
            .create(NewCategorizationRule {
                id: None,
                name: "x".to_string(),
                pattern: "AMAZON".to_string(),
                match_type: RuleMatchType::Contains,
                taxonomy_id: Some("spending_categories".to_string()),
                category_id: Some("cat_food".to_string()),
                activity_type: None,
                priority: 1,
                is_global: true,
                account_id: Some("acct1".to_string()),
                preset_id: None,
                preset_rule_key: None,
                preset_version: None,
            })
            .await
            .unwrap_err();
        assert!(err
            .to_string()
            .contains("global rule cannot also have an account_id"));
    }

    #[tokio::test]
    async fn create_rejects_account_scope_without_account_id() {
        let rules_repo = Arc::new(MockRulesRepo {
            rules: Mutex::new(vec![]),
        });
        let assignment_repo = Arc::new(MockAssignmentRepo::default());
        let assignment_service = Arc::new(ActivityTaxonomyAssignmentService::new(
            assignment_repo as Arc<dyn ActivityTaxonomyAssignmentRepositoryTrait>,
        ));
        let activity_repo = Arc::new(MockActivityRepo { activities: vec![] });
        let svc = CategorizationRulesService::new(
            rules_repo as Arc<dyn CategorizationRulesRepositoryTrait>,
            activity_repo as Arc<dyn ActivityRepositoryTrait>,
            assignment_service,
        );

        let err = svc
            .create(NewCategorizationRule {
                id: None,
                name: "x".to_string(),
                pattern: "AMAZON".to_string(),
                match_type: RuleMatchType::Contains,
                taxonomy_id: Some("spending_categories".to_string()),
                category_id: Some("cat_food".to_string()),
                activity_type: None,
                priority: 1,
                is_global: false,
                account_id: None,
                preset_id: None,
                preset_rule_key: None,
                preset_version: None,
            })
            .await
            .unwrap_err();
        assert!(err
            .to_string()
            .contains("Account-scoped rules require accountId"));
    }

    #[tokio::test]
    async fn create_rejects_invalid_regex_pattern() {
        let rules_repo = Arc::new(MockRulesRepo {
            rules: Mutex::new(vec![]),
        });
        let assignment_repo = Arc::new(MockAssignmentRepo::default());
        let assignment_service = Arc::new(ActivityTaxonomyAssignmentService::new(
            assignment_repo as Arc<dyn ActivityTaxonomyAssignmentRepositoryTrait>,
        ));
        let activity_repo = Arc::new(MockActivityRepo { activities: vec![] });
        let svc = CategorizationRulesService::new(
            rules_repo as Arc<dyn CategorizationRulesRepositoryTrait>,
            activity_repo as Arc<dyn ActivityRepositoryTrait>,
            assignment_service,
        );

        let err = svc
            .create(NewCategorizationRule {
                id: None,
                name: "bad regex".to_string(),
                pattern: "(unclosed".to_string(),
                match_type: RuleMatchType::Regex,
                taxonomy_id: Some("spending_categories".to_string()),
                category_id: Some("cat_food".to_string()),
                activity_type: None,
                priority: 1,
                is_global: true,
                account_id: None,
                preset_id: None,
                preset_rule_key: None,
                preset_version: None,
            })
            .await
            .unwrap_err();
        assert!(err.to_string().contains("Invalid regex pattern"));
    }

    #[tokio::test]
    async fn update_rejects_invalid_regex_pattern() {
        let rules_repo = Arc::new(MockRulesRepo {
            rules: Mutex::new(vec![mk_rule(
                "rule-1",
                "AMAZON",
                "spending_categories",
                "cat_food",
                1,
            )]),
        });
        let assignment_repo = Arc::new(MockAssignmentRepo::default());
        let assignment_service = Arc::new(ActivityTaxonomyAssignmentService::new(
            assignment_repo as Arc<dyn ActivityTaxonomyAssignmentRepositoryTrait>,
        ));
        let activity_repo = Arc::new(MockActivityRepo { activities: vec![] });
        let svc = CategorizationRulesService::new(
            rules_repo as Arc<dyn CategorizationRulesRepositoryTrait>,
            activity_repo as Arc<dyn ActivityRepositoryTrait>,
            assignment_service,
        );

        let err = svc
            .update(
                "rule-1",
                UpdateCategorizationRule {
                    pattern: Some("(unclosed".to_string()),
                    match_type: Some(RuleMatchType::Regex),
                    ..Default::default()
                },
            )
            .await
            .unwrap_err();
        assert!(err.to_string().contains("Invalid regex pattern"));
    }

    #[tokio::test]
    async fn import_preset_upgrades_unmodified_old_version_rule() {
        let preset = presets::load_preset("us").unwrap();
        let preset_rule = preset.rules.first().unwrap();
        let mut installed = mk_rule(
            "installed-rule",
            "OLD PATTERN",
            "spending_categories",
            "old_cat",
            1,
        );
        installed.preset_id = Some(preset.preset_id.clone());
        installed.preset_rule_key = Some(preset_rule.key.clone());
        installed.preset_version = Some("0.0.0".to_string());
        installed.preset_modified = false;

        let rules_repo = Arc::new(MockRulesRepo {
            rules: Mutex::new(vec![installed]),
        });
        let assignment_repo = Arc::new(MockAssignmentRepo::default());
        let assignment_service = Arc::new(ActivityTaxonomyAssignmentService::new(
            assignment_repo as Arc<dyn ActivityTaxonomyAssignmentRepositoryTrait>,
        ));
        let activity_repo = Arc::new(MockActivityRepo { activities: vec![] });
        let svc = CategorizationRulesService::new(
            rules_repo.clone() as Arc<dyn CategorizationRulesRepositoryTrait>,
            activity_repo as Arc<dyn ActivityRepositoryTrait>,
            assignment_service,
        );
        let mut resolver = HashMap::new();
        resolver.insert(
            preset_rule.category_key.clone(),
            ("spending_categories".to_string(), "new_cat".to_string()),
        );

        let result = svc.import_preset("us", &resolver).await.unwrap();

        assert_eq!(result.updated, 1);
        let rules = rules_repo.rules.lock().unwrap();
        let updated_rule = rules
            .iter()
            .find(|rule| rule.id == "installed-rule")
            .unwrap();
        assert_eq!(updated_rule.pattern, preset_rule.pattern);
        assert_eq!(updated_rule.priority, preset_rule.priority);
        assert_eq!(updated_rule.category_id.as_deref(), Some("new_cat"));
        assert_eq!(
            updated_rule.preset_version.as_deref(),
            Some(preset.preset_version.as_str())
        );
        assert!(!updated_rule.preset_modified);
    }
}
