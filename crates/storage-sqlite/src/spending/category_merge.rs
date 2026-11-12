//! One reviewed writer transaction for category merges, including projection.

use std::sync::Arc;

use async_trait::async_trait;
use diesel::prelude::*;
use sha2::{Digest, Sha256};
use wealthfolio_core::{errors::ValidationError, Result};
use wealthfolio_spending::{
    category_merge::{
        merge_block_reason, merged_category_targets, CategoryMergeCommit,
        CategoryMergeRepositoryTrait, CategoryMergeRequest, CategoryMergeReview,
        CategoryMergeState, MergeDestination,
    },
    settings::SETTING_KEY_EXCLUDED_CATEGORY_IDS,
};

use super::{
    activity_assignments::ActivityTaxonomyAssignmentDB,
    activity_splits::ActivitySplitDB,
    budget::{budget_state, BudgetGroupAssignmentDB},
    categorization_rules::CategorizationRuleDB,
};
use crate::{
    db::{DbPool, WriteHandle},
    errors::StorageError,
    schema::{
        activity_taxonomy_assignments as assignments, app_settings, budget_group_assignments,
        spending_activity_splits as splits, spending_categorization_rules as rules,
        taxonomy_categories as categories,
    },
    settings::model::AppSettingDB,
    taxonomies::{
        category_references,
        sync::{self, CategoryMergeRedirect},
        CategoryDB,
    },
};

pub struct CategoryMergeRepository {
    pool: Arc<DbPool>,
    writer: WriteHandle,
}
impl CategoryMergeRepository {
    pub fn new(pool: Arc<DbPool>, writer: WriteHandle) -> Self {
        Self { pool, writer }
    }
}

fn invalid(message: impl Into<String>) -> wealthfolio_core::Error {
    ValidationError::InvalidInput(message.into()).into()
}

struct MergeSnapshot {
    state: CategoryMergeState,
    revision: String,
}

fn snapshot(conn: &mut SqliteConnection, request: &CategoryMergeRequest) -> Result<MergeSnapshot> {
    let category_rows = categories::table
        .filter(categories::taxonomy_id.eq(&request.taxonomy_id))
        .order(categories::id)
        .load::<CategoryDB>(conn)
        .map_err(StorageError::from)?;
    let references = category_references(conn, &request.taxonomy_id, &request.category_id)?;
    let mut budget = budget_state(conn)?;
    budget.groups.sort_by(|a, b| a.id.cmp(&b.id));
    budget.group_assignments.sort_by(|a, b| a.id.cmp(&b.id));
    budget.targets.sort_by(|a, b| a.id.cmp(&b.id));
    budget.rollover_settings.sort_by(|a, b| a.id.cmp(&b.id));
    let exclusion_value = app_settings::table
        .find(SETTING_KEY_EXCLUDED_CATEGORY_IDS)
        .select(app_settings::setting_value)
        .first::<String>(conn)
        .optional()
        .map_err(StorageError::from)?;
    let excluded_category_ids = exclusion_value
        .as_deref()
        .map(serde_json::from_str::<Vec<String>>)
        .transpose()
        .map_err(|_| invalid("Invalid category exclusions; repair settings before merging"))?
        .unwrap_or_default();
    // Include all taxonomy references, independent of filters, account activity,
    // or month. Content comparisons catch same-ID edits and new references.
    let assignment_rows = assignments::table
        .filter(assignments::taxonomy_id.eq(&request.taxonomy_id))
        .order(assignments::id)
        .load::<ActivityTaxonomyAssignmentDB>(conn)
        .map_err(StorageError::from)?;
    let split_rows = splits::table
        .filter(splits::taxonomy_id.eq(&request.taxonomy_id))
        .order(splits::id)
        .load::<ActivitySplitDB>(conn)
        .map_err(StorageError::from)?;
    let rule_rows = rules::table
        .filter(rules::taxonomy_id.eq(&request.taxonomy_id))
        .order(rules::id)
        .load::<CategorizationRuleDB>(conn)
        .map_err(StorageError::from)?;
    let redirects = sync::category_merge_redirects(conn)?;
    let bytes = serde_json::to_vec(&(
        &category_rows,
        &references,
        &budget,
        &exclusion_value,
        &assignment_rows,
        &split_rows,
        &rule_rows,
        redirects,
    ))
    .map_err(|e| invalid(e.to_string()))?;
    Ok(MergeSnapshot {
        state: CategoryMergeState {
            categories: category_rows.into_iter().map(Into::into).collect(),
            references,
            budget,
            excluded_category_ids,
        },
        revision: hex::encode(Sha256::digest(bytes)),
    })
}

fn review(snapshot: &MergeSnapshot, request: &CategoryMergeRequest) -> Result<CategoryMergeReview> {
    let state = &snapshot.state;
    let source = state
        .categories
        .iter()
        .find(|c| c.id == request.category_id)
        .ok_or_else(|| invalid("Category no longer exists; refresh and review again"))?;
    if !wealthfolio_core::taxonomies::TRANSACTION_CATEGORY_TAXONOMY_IDS
        .contains(&source.taxonomy_id.as_str())
    {
        return Err(invalid("Only activity categories can be merged"));
    }
    let destinations = state
        .categories
        .iter()
        .filter(|c| c.id != source.id)
        .map(|c| MergeDestination {
            category: c.clone(),
            blocked: merge_block_reason(state, source, c),
        })
        .collect();
    let targets = if let Some(id) = &request.destination_id {
        let destination = state
            .categories
            .iter()
            .find(|c| &c.id == id)
            .ok_or_else(|| invalid("Destination must belong to the same taxonomy"))?;
        merged_category_targets(state, source, destination).map_err(|e| invalid(e.to_string()))?
    } else {
        Vec::new()
    };
    Ok(CategoryMergeReview {
        source: source.clone(),
        references: state.references.clone(),
        destinations,
        destination_id: request.destination_id.clone(),
        revision: snapshot.revision.clone(),
        budget_changes: wealthfolio_spending::category_merge::category_budget_changes(
            state, source, &targets,
        ),
        targets,
    })
}

#[async_trait]
impl CategoryMergeRepositoryTrait for CategoryMergeRepository {
    async fn review(&self, request: CategoryMergeRequest) -> anyhow::Result<CategoryMergeReview> {
        let pool = self.pool.clone();
        // These can be history-sized reads. Keep them off async runtime workers.
        tokio::task::spawn_blocking(move || {
            let mut conn = crate::db::get_connection(&pool)?;
            conn.transaction::<_, anyhow::Error, _>(|conn| {
                Ok(review(&snapshot(conn, &request)?, &request)?)
            })
        })
        .await?
    }

    async fn commit(&self, request: CategoryMergeCommit) -> anyhow::Result<()> {
        self.writer
            .exec_tx(move |tx| {
                let query = CategoryMergeRequest {
                    taxonomy_id: request.taxonomy_id.clone(),
                    category_id: request.category_id.clone(),
                    destination_id: Some(request.destination_id.clone()),
                };
                let current = snapshot(tx.conn(), &query)?;
                if current.revision != request.revision {
                    return Err(invalid(
                        "Category merge state changed; refresh and review again",
                    ));
                }
                review(&current, &query)?;
                let existing = sync::category_merge_redirects(tx.conn())?;
                let mut origins = origins_for_category(
                    &current.state,
                    &existing,
                    &request.taxonomy_id,
                    &request.category_id,
                )?;
                origins.extend(origins_for_category(
                    &current.state,
                    &existing,
                    &request.taxonomy_id,
                    &request.destination_id,
                )?);
                origins.sort_by(|a, b| a.id.cmp(&b.id));
                origins.dedup_by(|a, b| a.id == b.id);
                let known = all_origins(&existing, &request.taxonomy_id)
                    .into_iter()
                    .map(|o| o.id)
                    .collect::<std::collections::HashSet<_>>();
                origins.retain(|o| !known.contains(&o.id));
                let receipt = CategoryMergeRedirect {
                    taxonomy_id: request.taxonomy_id.clone(),
                    source_id: request.category_id,
                    destination_id: request.destination_id,
                    budget_origins: origins,
                };
                let event_id = uuid::Uuid::now_v7().to_string();
                let now = chrono::Utc::now().to_rfc3339();
                apply_merge_receipts(
                    tx.conn(),
                    &request.taxonomy_id,
                    &[receipt],
                    &event_id,
                    &now,
                    0,
                )?;
                let mut payload =
                    sync::build_custom_taxonomy_payload(tx.conn(), &request.taxonomy_id)
                        .map_err(StorageError::from)?
                        .ok_or_else(|| invalid("Missing merge taxonomy"))?;
                payload.merge_operation = true;
                let mut event = crate::sync::OutboxWriteRequest::new(
                    wealthfolio_core::sync::SyncEntity::CustomTaxonomy,
                    request.taxonomy_id,
                    wealthfolio_core::sync::SyncOperation::Update,
                    serde_json::to_value(payload).map_err(|e| invalid(e.to_string()))?,
                );
                event.event_id = Some(event_id);
                event.client_timestamp = now;
                tx.queue_outbox(event);
                Ok(())
            })
            .await
            .map_err(Into::into)
    }
}

/// Follow permanent identities, including a later merge of the destination.
pub(crate) fn redirected_category<'a>(
    redirects: &'a [CategoryMergeRedirect],
    taxonomy: &str,
    category: &'a str,
) -> Result<&'a str> {
    let mut current = category;
    let mut visited = std::collections::HashSet::new();
    while let Some(next) = redirects
        .iter()
        .find(|r| r.taxonomy_id == taxonomy && r.source_id == current)
    {
        if !visited.insert(current) {
            return Err(invalid("Category merge redirects contain a cycle"));
        }
        current = &next.destination_id;
    }
    Ok(current)
}

fn origin_id(
    taxonomy: &str,
    origin: &wealthfolio_spending::category_merge::MergeBudgetOrigin,
) -> Result<String> {
    let content =
        serde_json::to_string(&(&origin.category_ids, &origin.amounts, &origin.supersedes))
            .map_err(|e| invalid(e.to_string()))?;
    Ok(crate::utils::stable_id(
        "category_merge_budget_origin",
        &[taxonomy, &content],
    ))
}

fn all_origins(
    redirects: &[CategoryMergeRedirect],
    taxonomy: &str,
) -> Vec<wealthfolio_spending::category_merge::MergeBudgetOrigin> {
    redirects
        .iter()
        .filter(|r| r.taxonomy_id == taxonomy)
        .flat_map(|r| r.budget_origins.iter().cloned())
        .collect()
}

fn origins_for_category(
    state: &CategoryMergeState,
    redirects: &[CategoryMergeRedirect],
    taxonomy: &str,
    category: &str,
) -> Result<Vec<wealthfolio_spending::category_merge::MergeBudgetOrigin>> {
    use wealthfolio_spending::category_merge::{
        active_budget_origins, category_budget_amounts, summed_budget_origins, MergeBudgetOrigin,
    };
    let mut origins = Vec::new();
    let known = all_origins(redirects, taxonomy);
    active_budget_origins(&known).map_err(|e| invalid(e.to_string()))?;
    for origin in known {
        if redirected_category(redirects, taxonomy, &origin.category_ids[0])? == category {
            origins.push(origin);
        }
    }
    let actual =
        category_budget_amounts(state, taxonomy, category).map_err(|e| invalid(e.to_string()))?;
    let mut replacement = if origins.is_empty() {
        Some(MergeBudgetOrigin {
            id: String::new(),
            category_ids: vec![category.to_string()],
            amounts: actual.clone(),
            supersedes: Vec::new(),
        })
    } else if summed_budget_origins(&origins).map_err(|e| invalid(e.to_string()))? != actual {
        let active = active_budget_origins(&origins).map_err(|e| invalid(e.to_string()))?;
        let mut covered = active
            .iter()
            .flat_map(|o| o.category_ids.iter().cloned())
            .collect::<Vec<_>>();
        covered.sort();
        covered.dedup();
        let mut supersedes = active.iter().map(|o| o.id.clone()).collect::<Vec<_>>();
        supersedes.sort();
        Some(MergeBudgetOrigin {
            id: String::new(),
            category_ids: covered,
            amounts: actual,
            supersedes,
        })
    } else {
        None
    };
    if let Some(ref mut origin) = replacement {
        origin.id = origin_id(taxonomy, origin)?;
        origins.push(origin.clone());
    }
    Ok(origins)
}

/// Validate the complete operation on this peer before any mutation. Budget
/// origins are unioned by identity, so overlapping compatible chains count each
/// original category once. An edited aggregate requires a new explicit review.
pub(crate) fn apply_merge_receipts(
    conn: &mut SqliteConnection,
    taxonomy: &str,
    incoming: &[CategoryMergeRedirect],
    event_id: &str,
    now: &str,
    seq: i64,
) -> Result<bool> {
    use std::collections::{BTreeMap, BTreeSet};
    use wealthfolio_spending::{
        budget::{BudgetTargetType, NewBudgetTarget},
        category_merge::{active_budget_origins, summed_budget_origins},
    };
    if incoming.is_empty() {
        return Ok(false);
    }
    if !wealthfolio_core::taxonomies::TRANSACTION_CATEGORY_TAXONOMY_IDS.contains(&taxonomy) {
        return Err(invalid("Only activity categories can be merged"));
    }
    let existing = sync::category_merge_redirects(conn)?;
    let mut candidate = existing.clone();
    let mut changed_sources = BTreeSet::new();
    for item in incoming {
        if item.taxonomy_id != taxonomy || item.source_id == item.destination_id {
            return Err(invalid("Invalid category merge receipt"));
        }
        for origin in &item.budget_origins {
            if origin.id != origin_id(taxonomy, origin)? {
                return Err(invalid("Invalid category merge budget origin identity"));
            }
        }
        if let Some(record) = candidate
            .iter_mut()
            .find(|r| r.taxonomy_id == taxonomy && r.source_id == item.source_id)
        {
            if record.destination_id != item.destination_id {
                return Err(invalid(
                    "Conflicting category merges; review category destinations on both devices",
                ));
            }
            for origin in &item.budget_origins {
                if !record.budget_origins.contains(origin) {
                    record.budget_origins.push(origin.clone());
                    changed_sources.insert(item.source_id.clone());
                }
            }
            record.budget_origins.sort_by(|a, b| a.id.cmp(&b.id));
        } else {
            candidate.push(item.clone());
            changed_sources.insert(item.source_id.clone());
        }
    }
    if changed_sources.is_empty() {
        return Ok(false);
    }
    candidate.sort_by(|a, b| (&a.taxonomy_id, &a.source_id).cmp(&(&b.taxonomy_id, &b.source_id)));
    for record in candidate.iter().filter(|r| r.taxonomy_id == taxonomy) {
        redirected_category(&candidate, taxonomy, &record.source_id)?;
    }
    let query = CategoryMergeRequest {
        taxonomy_id: taxonomy.into(),
        category_id: String::new(),
        destination_id: None,
    };
    let state = snapshot(conn, &query)?.state;
    let mut affected_roots = BTreeSet::new();
    for source in &changed_sources {
        affected_roots.insert(redirected_category(&candidate, taxonomy, source)?.to_string());
    }
    // Current materializations must still match their recorded origins. Add
    // unmerged current category functions to detect conflicting input snapshots.
    let origins = all_origins(&candidate, taxonomy);
    active_budget_origins(&origins).map_err(|e| invalid(e.to_string()))?;
    let candidate_ids = origins
        .iter()
        .map(|o| o.id.clone())
        .collect::<BTreeSet<_>>();
    for category in &state.categories {
        if affected_roots.contains(redirected_category(&candidate, taxonomy, &category.id)?) {
            let current = origins_for_category(&state, &existing, taxonomy, &category.id)?;
            if current.iter().any(|o| !candidate_ids.contains(&o.id)) {
                return Err(invalid("Category budgets changed after an earlier merge; review the category merge on this device before retrying sync"));
            }
        }
    }
    let mut by_root: BTreeMap<String, Vec<_>> = BTreeMap::new();
    // Keep superseded blocks with each component: replacement validation and
    // summation need their lineage, even though only active amounts are counted.
    for origin in origins {
        let root = redirected_category(&candidate, taxonomy, &origin.category_ids[0])?.to_string();
        if origin
            .category_ids
            .iter()
            .any(|id| redirected_category(&candidate, taxonomy, id).ok() != Some(root.as_str()))
        {
            return Err(invalid("Category merge budget origin crosses destinations"));
        }
        by_root.entry(root).or_default().push(origin);
    }
    for source in &changed_sources {
        if existing
            .iter()
            .any(|r| r.taxonomy_id == taxonomy && r.source_id == *source)
        {
            continue;
        }
        let root = redirected_category(&candidate, taxonomy, source)?;
        let source_category=state.categories.iter().find(|c|c.id==*source).ok_or_else(||invalid("Category merge source is missing on this device; review the conflict before retrying sync"))?;
        let destination = state
            .categories
            .iter()
            .find(|c| c.id == root)
            .ok_or_else(|| invalid("Category merge destination is missing on this device"))?;
        let mut validation = CategoryMergeState {
            categories: state.categories.clone(),
            references: category_references(conn, taxonomy, source)?,
            budget: state.budget.clone(),
            excluded_category_ids: state.excluded_category_ids.clone(),
        };
        // Policy belongs to spending; run the same source/destination checks as
        // the native reviewed write while all source references still exist.
        validation.references.merged_categories = 0;
        if let Some(reason) = merge_block_reason(&validation, source_category, destination) {
            return Err(invalid(format!("Category merge conflicts with peer configuration ({reason:?}); match exclusions or remove saved rollover settings, then retry sync")));
        }
    }
    // All validation above is read-only. From here through the receipt write,
    // row mutations, metadata and the outbox share the caller's transaction.
    for source in &changed_sources {
        let root = redirected_category(&candidate, taxonomy, source)?;
        retarget_source(conn, taxonomy, source, root, event_id, now, seq)?;
    }
    for root in affected_roots {
        let values =
            summed_budget_origins(by_root.get(&root).map(Vec::as_slice).unwrap_or_default())
                .map_err(|e| invalid(e.to_string()))?;
        let periods = values
            .iter()
            .map(|v| v.period_key.as_str())
            .collect::<BTreeSet<_>>();
        for target in state.budget.targets.iter().filter(|t| {
            t.taxonomy_id.as_deref() == Some(taxonomy) && t.category_id.as_deref() == Some(&root)
        }) {
            if !periods.contains(target.period_key.as_str()) {
                delete_merge_target(conn, &target.id, event_id, now, seq)?;
            }
        }
        for value in values {
            let row = super::budget::upsert_target_row(
                conn,
                NewBudgetTarget {
                    id: None,
                    period_key: value.period_key,
                    target_type: BudgetTargetType::Category,
                    taxonomy_id: Some(taxonomy.into()),
                    category_id: Some(root.clone()),
                    group_id: None,
                    amount: value.amount,
                },
                now,
            )?;
            stamp(
                conn,
                wealthfolio_core::sync::SyncEntity::BudgetTarget,
                &row.id,
                event_id,
                now,
                seq,
                wealthfolio_core::sync::SyncOperation::Update,
            )?;
        }
    }
    sync::save_category_merge_redirects(conn, &candidate)?;
    Ok(true)
}

fn stamp(
    conn: &mut SqliteConnection,
    entity: wealthfolio_core::sync::SyncEntity,
    id: &str,
    event: &str,
    now: &str,
    seq: i64,
    op: wealthfolio_core::sync::SyncOperation,
) -> Result<()> {
    crate::sync::app_sync::stamp_category_merge_write(conn, entity, id, event, now, seq, op)
}

fn delete_merge_target(
    conn: &mut SqliteConnection,
    id: &str,
    event: &str,
    now: &str,
    seq: i64,
) -> Result<()> {
    diesel::delete(crate::schema::budget_targets::table.find(id))
        .execute(conn)
        .map_err(StorageError::from)?;
    stamp(
        conn,
        wealthfolio_core::sync::SyncEntity::BudgetTarget,
        id,
        event,
        now,
        seq,
        wealthfolio_core::sync::SyncOperation::Delete,
    )
}

fn retarget_source(
    conn: &mut SqliteConnection,
    taxonomy: &str,
    source: &str,
    destination: &str,
    event: &str,
    now: &str,
    seq: i64,
) -> Result<()> {
    use wealthfolio_core::sync::{SyncEntity, SyncOperation};
    // Identity normalization does not compete with independent edits to a row's
    // category, note, or amount. Keep those rows' existing LWW clocks; delayed
    // references to this removed identity are normalized on ordinary replay.
    for row in assignments::table
        .filter(assignments::taxonomy_id.eq(taxonomy))
        .filter(assignments::category_id.eq(source))
        .load::<ActivityTaxonomyAssignmentDB>(conn)
        .map_err(StorageError::from)?
    {
        diesel::update(assignments::table.find(&row.id))
            .set((
                assignments::category_id.eq(destination),
                assignments::source.eq("manual"),
                assignments::updated_at.eq(now),
            ))
            .execute(conn)
            .map_err(StorageError::from)?;
    }
    for row in splits::table
        .filter(splits::taxonomy_id.eq(taxonomy))
        .filter(splits::category_id.eq(source))
        .load::<ActivitySplitDB>(conn)
        .map_err(StorageError::from)?
    {
        diesel::update(splits::table.find(&row.id))
            .set((
                splits::category_id.eq(destination),
                splits::updated_at.eq(now),
            ))
            .execute(conn)
            .map_err(StorageError::from)?;
    }
    for row in rules::table
        .filter(rules::taxonomy_id.eq(taxonomy))
        .filter(rules::category_id.eq(source))
        .load::<CategorizationRuleDB>(conn)
        .map_err(StorageError::from)?
    {
        diesel::update(rules::table.find(&row.id))
            .set((
                rules::category_id.eq(destination),
                rules::preset_modified.eq(if row.preset_id.is_some() {
                    1
                } else {
                    row.preset_modified
                }),
                rules::updated_at.eq(now),
            ))
            .execute(conn)
            .map_err(StorageError::from)?;
    }
    for target in crate::schema::budget_targets::table
        .filter(crate::schema::budget_targets::taxonomy_id.eq(taxonomy))
        .filter(crate::schema::budget_targets::category_id.eq(source))
        .load::<super::budget::BudgetTargetDB>(conn)
        .map_err(StorageError::from)?
    {
        delete_merge_target(conn, &target.id, event, now, seq)?;
    }
    for row in budget_group_assignments::table
        .filter(budget_group_assignments::taxonomy_id.eq(taxonomy))
        .filter(budget_group_assignments::category_id.eq(source))
        .load::<BudgetGroupAssignmentDB>(conn)
        .map_err(StorageError::from)?
    {
        diesel::delete(budget_group_assignments::table.find(&row.id))
            .execute(conn)
            .map_err(StorageError::from)?;
        stamp(
            conn,
            SyncEntity::BudgetGroupAssignment,
            &row.id,
            event,
            now,
            seq,
            SyncOperation::Delete,
        )?;
    }
    if taxonomy == "spending_categories" {
        if let Some(raw) = app_settings::table
            .find(SETTING_KEY_EXCLUDED_CATEGORY_IDS)
            .select(app_settings::setting_value)
            .first::<String>(conn)
            .optional()
            .map_err(StorageError::from)?
        {
            let mut ids: Vec<String> =
                serde_json::from_str(&raw).map_err(|e| invalid(e.to_string()))?;
            if ids.iter().any(|id| id == source) {
                ids.retain(|id| id != source);
                let row = AppSettingDB {
                    setting_key: SETTING_KEY_EXCLUDED_CATEGORY_IDS.into(),
                    setting_value: serde_json::to_string(&ids)
                        .map_err(|e| invalid(e.to_string()))?,
                };
                diesel::replace_into(app_settings::table)
                    .values(&row)
                    .execute(conn)
                    .map_err(StorageError::from)?;
                // Preserve the setting's own LWW clock: this is identity cleanup,
                // not a new exclusion choice that can overwrite a later edit.
            }
        }
    }
    diesel::delete(
        categories::table
            .filter(categories::taxonomy_id.eq(taxonomy))
            .filter(categories::id.eq(source)),
    )
    .execute(conn)
    .map_err(StorageError::from)?;
    Ok(())
}

/// Snapshots already contain materialized targets and receipts. Only seeded
/// source identities can be left behind by the taxonomy snapshot filter.
pub(crate) fn replay_redirects(conn: &mut SqliteConnection, taxonomy: &str) -> Result<()> {
    for record in sync::category_merge_redirects(conn)?
        .iter()
        .filter(|r| r.taxonomy_id == taxonomy)
    {
        let refs = category_references(conn, taxonomy, &record.source_id)?;
        if refs.children
            + refs.asset_assignments
            + refs.allocation_targets
            + refs.spending_assignments
            + refs.splits
            + refs.rules
            + refs.budget_targets
            + refs.budget_rollovers
            + refs.budget_group_assignments
            > 0
        {
            return Err(invalid(
                "Snapshot conflicts with saved category merge references",
            ));
        }
        diesel::delete(
            categories::table
                .filter(categories::taxonomy_id.eq(taxonomy))
                .filter(categories::id.eq(&record.source_id)),
        )
        .execute(conn)
        .map_err(StorageError::from)?;
    }
    Ok(())
}

/// Normalize delayed references to removed identities. Budget configuration is
/// explicitly replaced/deleted by the merge; replay must not add it a second time.
pub(crate) fn normalize_synced_reference(
    conn: &mut SqliteConnection,
    entity: wealthfolio_core::sync::SyncEntity,
    fields: &mut [(String, serde_json::Value)],
) -> Result<bool> {
    use wealthfolio_core::sync::SyncEntity;
    if entity == SyncEntity::SpendingSetting {
        let key = fields
            .iter()
            .find(|(k, _)| k == "setting_key")
            .and_then(|(_, v)| v.as_str());
        if key == Some(SETTING_KEY_EXCLUDED_CATEGORY_IDS) {
            if let Some((_, value)) = fields.iter_mut().find(|(k, _)| k == "setting_value") {
                let raw = value
                    .as_str()
                    .ok_or_else(|| invalid("Invalid category exclusions"))?;
                let Some(normalized) = normalized_exclusions(conn, raw)? else {
                    // The author still has the source identity. Its pending
                    // semantic merge will fail policy validation until the
                    // exclusion is explicitly resolved there. Do not turn an
                    // exclusion of only one original category into an exclusion
                    // of every category now combined at the destination.
                    return Ok(false);
                };
                *value = normalized.into();
            }
        }
        return Ok(true);
    }
    if !matches!(
        entity,
        SyncEntity::ActivityTaxonomyAssignment
            | SyncEntity::SpendingActivitySplit
            | SyncEntity::SpendingCategorizationRule
            | SyncEntity::BudgetGroupAssignment
            | SyncEntity::BudgetTarget
            | SyncEntity::BudgetRolloverSetting
    ) {
        return Ok(true);
    }
    let value = |name: &str| {
        fields
            .iter()
            .find(|(k, _)| k == name)
            .and_then(|(_, v)| v.as_str())
    };
    let (Some(taxonomy), Some(category)) = (value("taxonomy_id"), value("category_id")) else {
        return Ok(true);
    };
    let redirects = sync::category_merge_redirects(conn)?;
    let destination = redirected_category(&redirects, taxonomy, category)?;
    if destination == category {
        return Ok(true);
    }
    if matches!(
        entity,
        SyncEntity::BudgetGroupAssignment
            | SyncEntity::BudgetTarget
            | SyncEntity::BudgetRolloverSetting
    ) {
        return Ok(false);
    }
    let destination = destination.to_string();
    let is_preset = fields
        .iter()
        .any(|(k, v)| k == "preset_id" && v.as_str().is_some());
    for (key, value) in fields.iter_mut() {
        if key == "category_id" {
            *value = destination.clone().into();
        }
        if entity == SyncEntity::ActivityTaxonomyAssignment && key == "source" {
            *value = "manual".into();
        }
        if entity == SyncEntity::SpendingCategorizationRule && is_preset && key == "preset_modified"
        {
            *value = 1.into();
        }
    }
    Ok(true)
}

pub(crate) fn observed_budget_merges(
    conn: &mut SqliteConnection,
    taxonomy: &str,
    category: &str,
) -> Result<Vec<String>> {
    let records = sync::category_merge_redirects(conn)?;
    let root = redirected_category(&records, taxonomy, category)?;
    let mut sources = records
        .iter()
        .filter(|r| r.taxonomy_id == taxonomy)
        .filter_map(
            |r| match redirected_category(&records, taxonomy, &r.source_id) {
                Ok(target) if target == root => Some(Ok(r.source_id.clone())),
                Ok(_) => None,
                Err(e) => Some(Err(e)),
            },
        )
        .collect::<Result<Vec<_>>>()?;
    sources.sort();
    sources.dedup();
    Ok(sources)
}

/// An absolute budget write made before a merge must not replace a combined
/// budget. The author retains its input and its pending merge reports the
/// conflict; a later explicit write made with the current merge context applies.
pub(crate) fn budget_write_context_applies(
    conn: &mut SqliteConnection,
    id: &str,
    payload: &mut serde_json::Value,
) -> Result<bool> {
    let object = payload
        .as_object_mut()
        .ok_or_else(|| invalid("Invalid budget sync payload"))?;
    let observed = object
        .remove("merge_sources")
        .map(serde_json::from_value::<Vec<String>>)
        .transpose()
        .map_err(|_| invalid("Invalid category merge budget context"))?
        .unwrap_or_default();
    let taxonomy = object
        .get("taxonomy_id")
        .or_else(|| object.get("taxonomyId"))
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let category = object
        .get("category_id")
        .or_else(|| object.get("categoryId"))
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let pair = if let (Some(tax), Some(cat)) = (taxonomy, category) {
        Some((tax, cat))
    } else {
        crate::schema::budget_targets::table
            .find(id)
            .select((
                crate::schema::budget_targets::taxonomy_id,
                crate::schema::budget_targets::category_id,
            ))
            .first::<(Option<String>, Option<String>)>(conn)
            .optional()
            .map_err(StorageError::from)?
            .and_then(|(t, c)| t.zip(c))
    };
    let Some((taxonomy, category)) = pair else {
        return Ok(true);
    };
    let records = sync::category_merge_redirects(conn)?;
    if redirected_category(&records, &taxonomy, &category)? != category {
        return Ok(false);
    }
    let expected = observed_budget_merges(conn, &taxonomy, &category)?;
    Ok(expected == observed)
}

pub(crate) fn normalize_exclusions(conn: &mut SqliteConnection, value: &str) -> Result<String> {
    normalized_exclusions(conn,value)?.ok_or_else(||invalid("Category merge changed these exclusions; refresh and review the destination category before saving"))
}

fn normalized_exclusions(conn: &mut SqliteConnection, value: &str) -> Result<Option<String>> {
    let ids: Vec<String> =
        serde_json::from_str(value).map_err(|_| invalid("Invalid category exclusions"))?;
    let redirects = sync::category_merge_redirects(conn)?;
    let categories = categories::table
        .filter(categories::taxonomy_id.eq("spending_categories"))
        .load::<CategoryDB>(conn)
        .map_err(StorageError::from)?
        .into_iter()
        .map(Into::into)
        .collect::<Vec<_>>();
    for id in &ids {
        let destination = redirected_category(&redirects, "spending_categories", id)?;
        if destination != id
            && !wealthfolio_spending::category_merge::category_is_excluded(
                &ids,
                &categories,
                destination,
            )
        {
            return Ok(None);
        }
    }
    let mut normalized = ids
        .iter()
        .map(|id| redirected_category(&redirects, "spending_categories", id).map(str::to_string))
        .collect::<Result<Vec<_>>>()?;
    normalized.sort();
    normalized.dedup();
    serde_json::to_string(&normalized)
        .map(Some)
        .map_err(|e| invalid(e.to_string()))
}
