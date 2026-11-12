//! Reviewed leaf-category merging. Storage supplies a consistent snapshot and
//! rechecks it in the writer transaction; this module owns spending policy.

use std::{collections::HashMap, sync::Arc};

use anyhow::{anyhow, Result};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use wealthfolio_core::taxonomies::{
    Category, CategoryReferences, TRANSACTION_CATEGORY_TAXONOMY_IDS,
};

use crate::{
    budget::{BudgetSnapshotState, BudgetTargetType, NewBudgetTarget},
    category_exclusions::ExclusionIndex,
};

/// Internal, append-only identity redirects. Carried by taxonomy bundles rather
/// than ordinary settings events so replay retargets local sidecars before delete.
pub const SETTING_KEY_CATEGORY_MERGES: &str = "spending.category_merges";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeBudgetAmount {
    pub period_key: String,
    pub amount: String,
}

/// A budget function counted once, even when independent merges overlap.
/// An explicit later edit of a combined budget replaces its observed origins.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeBudgetOrigin {
    pub id: String,
    pub category_ids: Vec<String>,
    pub amounts: Vec<MergeBudgetAmount>,
    pub supersedes: Vec<String>,
}

pub fn category_is_excluded(raw: &[String], categories: &[Category], id: &str) -> bool {
    let meta = categories
        .iter()
        .map(|c| (c.id.clone(), c.clone()))
        .collect();
    ExclusionIndex::new(raw, &meta).is_excluded(id)
}

pub fn category_budget_amounts(
    state: &CategoryMergeState,
    taxonomy: &str,
    category: &str,
) -> Result<Vec<MergeBudgetAmount>> {
    let mut amounts = state
        .budget
        .targets
        .iter()
        .filter(|t| {
            matches!(t.target_type, BudgetTargetType::Category)
                && t.taxonomy_id.as_deref() == Some(taxonomy)
                && t.category_id.as_deref() == Some(category)
        })
        .map(|t| {
            Ok(MergeBudgetAmount {
                period_key: t.period_key.clone(),
                amount: rust_decimal::Decimal::from_str_exact(&t.amount)?
                    .normalize()
                    .to_string(),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    amounts.sort_by(|a, b| a.period_key.cmp(&b.period_key));
    Ok(amounts)
}

pub fn active_budget_origins(origins: &[MergeBudgetOrigin]) -> Result<Vec<MergeBudgetOrigin>> {
    use std::collections::{BTreeMap, BTreeSet};
    let mut unique = BTreeMap::new();
    for origin in origins {
        if origin.category_ids.is_empty()
            || origin
                .category_ids
                .windows(2)
                .any(|pair| pair[0] >= pair[1])
            || origin
                .amounts
                .windows(2)
                .any(|pair| pair[0].period_key >= pair[1].period_key)
            || origin.supersedes.windows(2).any(|pair| pair[0] >= pair[1])
        {
            return Err(anyhow!("Invalid category merge budget origin"));
        }
        for amount in &origin.amounts {
            crate::budget::service::validate_period_key(&amount.period_key)?;
            if rust_decimal::Decimal::from_str_exact(&amount.amount)?
                .normalize()
                .to_string()
                != amount.amount
            {
                return Err(anyhow!("Noncanonical category merge budget amount"));
            }
        }
        if unique
            .insert(origin.id.as_str(), origin)
            .is_some_and(|old| old != origin)
        {
            return Err(anyhow!("Conflicting category merge budget origins"));
        }
    }
    let mut superseded = BTreeSet::new();
    for origin in unique.values() {
        let mut covered = BTreeSet::new();
        for id in &origin.supersedes {
            let previous = unique
                .get(id.as_str())
                .ok_or_else(|| anyhow!("Missing category merge budget origin"))?;
            if id == &origin.id {
                return Err(anyhow!("Cyclic category merge budget origin"));
            }
            covered.extend(previous.category_ids.iter().cloned());
            superseded.insert(id.as_str());
        }
        if !origin.supersedes.is_empty()
            && covered.into_iter().collect::<Vec<_>>() != origin.category_ids
        {
            return Err(anyhow!(
                "Category merge budget replacement changes its coverage"
            ));
        }
        if origin.supersedes.is_empty() && origin.category_ids.len() != 1 {
            return Err(anyhow!(
                "Category merge budget origin must identify one original category"
            ));
        }
    }
    let all_categories = unique
        .values()
        .flat_map(|o| o.category_ids.iter().cloned())
        .collect::<BTreeSet<_>>();
    let mut covered = BTreeSet::new();
    let active = unique
        .into_iter()
        .filter(|(id, _)| !superseded.contains(id))
        .map(|(_, origin)| {
            for category in &origin.category_ids {
                if !covered.insert(category.clone()) {
                    return Err(anyhow!(
                        "Concurrent category budget edits conflict; review the merge again"
                    ));
                }
            }
            Ok(origin.clone())
        })
        .collect::<Result<Vec<_>>>()?;
    if covered != all_categories {
        return Err(anyhow!("Category merge budget origins contain a cycle"));
    }
    Ok(active)
}

pub fn summed_budget_origins(origins: &[MergeBudgetOrigin]) -> Result<Vec<MergeBudgetAmount>> {
    let mut amounts: Vec<MergeBudgetAmount> = Vec::new();
    for origin in active_budget_origins(origins)? {
        amounts = crate::budget::service::merge_effective_amounts(
            amounts
                .iter()
                .map(|a| ("sum", a.period_key.as_str(), a.amount.as_str()))
                .chain(
                    origin
                        .amounts
                        .iter()
                        .map(|a| ("next", a.period_key.as_str(), a.amount.as_str())),
                ),
            "sum",
            "next",
        )?
        .into_iter()
        .map(|(period_key, amount)| MergeBudgetAmount { period_key, amount })
        .collect();
    }
    Ok(amounts)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryMergeRequest {
    pub taxonomy_id: String,
    pub category_id: String,
    pub destination_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryMergeCommit {
    pub taxonomy_id: String,
    pub category_id: String,
    pub destination_id: String,
    pub revision: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MergeBlockReason {
    InvalidDestination,
    Children,
    AssetReferences,
    CategoryRollover,
    GroupRollover,
    Exclusions,
    BudgetDestination,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeDestination {
    pub category: Category,
    pub blocked: Option<MergeBlockReason>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryMergeReview {
    pub source: Category,
    pub references: CategoryReferences,
    pub destinations: Vec<MergeDestination>,
    pub destination_id: Option<String>,
    pub revision: String,
    pub targets: Vec<NewBudgetTarget>,
    pub budget_changes: Vec<CategoryMergeBudgetChange>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryMergeBudgetChange {
    pub period_key: String,
    pub current_amount: String,
    pub moved_amount: String,
    pub new_amount: String,
}

/// Show the same effective inputs used by the merge, including inherited
/// monthly defaults and explicit zero overrides, from the reviewed snapshot.
pub fn category_budget_changes(
    state: &CategoryMergeState,
    source: &Category,
    targets: &[NewBudgetTarget],
) -> Vec<CategoryMergeBudgetChange> {
    let effective = |category: Option<&str>, period: &str| {
        let matching = |key: &str| {
            state.budget.targets.iter().find(|t| {
                matches!(t.target_type, BudgetTargetType::Category)
                    && t.taxonomy_id.as_deref() == Some(&source.taxonomy_id)
                    && t.category_id.as_deref() == category
                    && t.period_key == key
            })
        };
        matching(period)
            .or_else(|| matching("default"))
            .map(|t| t.amount.clone())
            .unwrap_or_else(|| "0".into())
    };
    targets
        .iter()
        .map(|t| CategoryMergeBudgetChange {
            period_key: t.period_key.clone(),
            current_amount: effective(t.category_id.as_deref(), &t.period_key),
            moved_amount: effective(Some(&source.id), &t.period_key),
            new_amount: t.amount.clone(),
        })
        .collect()
}

pub struct CategoryMergeState {
    pub categories: Vec<Category>,
    pub references: CategoryReferences,
    pub budget: BudgetSnapshotState,
    pub excluded_category_ids: Vec<String>,
}

pub fn merge_block_reason(
    state: &CategoryMergeState,
    source: &Category,
    destination: &Category,
) -> Option<MergeBlockReason> {
    if !TRANSACTION_CATEGORY_TAXONOMY_IDS.contains(&source.taxonomy_id.as_str()) {
        return Some(MergeBlockReason::InvalidDestination);
    }
    if let Err(reason) = state.references.validate_merge(source, destination) {
        return Some(match reason {
            "children" => MergeBlockReason::Children,
            "asset_references" => MergeBlockReason::AssetReferences,
            _ => MergeBlockReason::InvalidDestination,
        });
    }
    let meta: HashMap<_, _> = state
        .categories
        .iter()
        .map(|c| (c.id.clone(), c.clone()))
        .collect();
    let source_top = crate::budget::service::top_category_id(&source.id, &meta);
    let destination_top = crate::budget::service::top_category_id(&destination.id, &meta);
    if state.budget.rollover_settings.iter().any(|r| {
        r.taxonomy_id.as_deref() == Some(&source.taxonomy_id)
            && matches!(r.category_id.as_deref(), Some(id) if id == source.id || id == destination.id
                || id == source_top || id == destination_top)
    }) {
        return Some(MergeBlockReason::CategoryRollover);
    }
    let has_targets = state.budget.targets.iter().any(|t| {
        t.taxonomy_id.as_deref() == Some(&source.taxonomy_id)
            && t.category_id.as_deref() == Some(&source.id)
    });
    if has_targets && (source.parent_id.is_some() || destination.parent_id.is_some()) {
        return Some(MergeBlockReason::BudgetDestination);
    }
    if source.taxonomy_id == "spending_categories" {
        let exclusions = ExclusionIndex::new(&state.excluded_category_ids, &meta);
        if exclusions.is_excluded(&source.id) != exclusions.is_excluded(&destination.id) {
            return Some(MergeBlockReason::Exclusions);
        }
        // Same-group regrouping preserves its total actuals/targets and carry.
        // Savings goals never participate in expense-group rollover.
        let group_of = crate::budget::service::group_assignment_map(
            &state.budget.group_assignments,
            &source.taxonomy_id,
        );
        let other = state
            .budget
            .groups
            .iter()
            .find(|g| g.key == crate::budget::service::OTHER_GROUP_KEY)
            .map(|g| g.id.as_str())
            .unwrap_or_default();
        let source_group = crate::budget::service::resolve_group_for_category(
            &source_top,
            &group_of,
            &meta,
            other,
        );
        let destination_group = crate::budget::service::resolve_group_for_category(
            &destination_top,
            &group_of,
            &meta,
            other,
        );
        if source_group != destination_group
            && state.budget.rollover_settings.iter().any(|r| {
                r.enabled
                    && r.group_id.is_some()
                    && (r.group_id.as_deref() == Some(&source_group)
                        || r.group_id.as_deref() == Some(&destination_group))
            })
        {
            return Some(MergeBlockReason::GroupRollover);
        }
    }
    None
}

pub fn merged_category_targets(
    state: &CategoryMergeState,
    source: &Category,
    destination: &Category,
) -> Result<Vec<NewBudgetTarget>> {
    if let Some(reason) = merge_block_reason(state, source, destination) {
        return Err(anyhow!(
            "category_merge:{}",
            serde_json::to_value(reason)?
                .as_str()
                .unwrap_or("invalid_destination")
        ));
    }
    let targets = state.budget.targets.iter().filter(|t| {
        matches!(t.target_type, BudgetTargetType::Category)
            && t.taxonomy_id.as_deref() == Some(&source.taxonomy_id)
            && matches!(t.category_id.as_deref(), Some(id) if id == source.id || id == destination.id)
    }).collect::<Vec<_>>();
    if !targets
        .iter()
        .any(|t| t.category_id.as_deref() == Some(&source.id))
    {
        return Ok(Vec::new());
    }
    crate::budget::service::merge_effective_amounts(
        targets.into_iter().map(|t| {
            (
                t.category_id.as_deref().unwrap_or_default(),
                t.period_key.as_str(),
                t.amount.as_str(),
            )
        }),
        &source.id,
        &destination.id,
    )?
    .into_iter()
    .map(|(period_key, amount)| {
        Ok(NewBudgetTarget {
            id: None,
            period_key,
            target_type: BudgetTargetType::Category,
            taxonomy_id: Some(source.taxonomy_id.clone()),
            category_id: Some(destination.id.clone()),
            group_id: None,
            amount,
        })
    })
    .collect()
}

#[async_trait]
pub trait CategoryMergeRepositoryTrait: Send + Sync {
    async fn review(&self, request: CategoryMergeRequest) -> Result<CategoryMergeReview>;
    async fn commit(&self, request: CategoryMergeCommit) -> Result<()>;
}

pub struct CategoryMergeService {
    repo: Arc<dyn CategoryMergeRepositoryTrait>,
}
impl CategoryMergeService {
    pub fn new(repo: Arc<dyn CategoryMergeRepositoryTrait>) -> Self {
        Self { repo }
    }
    pub async fn review(&self, request: CategoryMergeRequest) -> Result<CategoryMergeReview> {
        self.repo.review(request).await
    }
    pub async fn commit(&self, request: CategoryMergeCommit) -> Result<()> {
        self.repo.commit(request).await
    }
}
