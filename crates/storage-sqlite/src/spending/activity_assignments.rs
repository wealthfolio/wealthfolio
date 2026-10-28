//! Storage adapter for spending::activity_assignments — Diesel impl over the
//! `activity_taxonomy_assignments` table.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use wealthfolio_spending::activity_splits::ActivitySplit;

use anyhow::Result;
use async_trait::async_trait;
use chrono::NaiveDateTime;
use diesel::prelude::*;
use serde::{Deserialize, Serialize};

use crate::db::{get_connection, write_actor::DbWriteTx, DbPool, WriteHandle};
use crate::errors::StorageError;
use crate::schema::{activity_taxonomy_assignments, spending_activity_splits};
use crate::spending::activity_splits::ActivitySplitDB;
use crate::spending::activity_sync::should_sync_activity_local_id_outbox;
use crate::spending::deterministic_ids::activity_taxonomy_assignment_id;
use wealthfolio_core::sync::SyncEntity;
use wealthfolio_spending::activity_assignments::{
    ActivityTaxonomyAssignment, ActivityTaxonomyAssignmentRepositoryTrait,
    CategoryAssignmentConflicts, NewActivityTaxonomyAssignment, SplitAssignmentConflict,
    SplitAssignmentConflictReason,
};

#[derive(
    Queryable, Identifiable, AsChangeset, Selectable, Serialize, Deserialize, Debug, Clone,
)]
#[diesel(table_name = crate::schema::activity_taxonomy_assignments)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
#[serde(rename_all = "camelCase")]
pub struct ActivityTaxonomyAssignmentDB {
    pub id: String,
    pub activity_id: String,
    pub taxonomy_id: String,
    pub category_id: String,
    pub weight: i32,
    pub source: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Insertable, Serialize, Deserialize, Debug, Clone)]
#[diesel(table_name = crate::schema::activity_taxonomy_assignments)]
pub struct NewActivityTaxonomyAssignmentDB {
    pub id: String,
    pub activity_id: String,
    pub taxonomy_id: String,
    pub category_id: String,
    pub weight: i32,
    pub source: String,
    pub created_at: String,
    pub updated_at: String,
}

impl crate::sync::SyncOutboxModel for ActivityTaxonomyAssignmentDB {
    const ENTITY: SyncEntity = SyncEntity::ActivityTaxonomyAssignment;
    fn sync_entity_id(&self) -> &str {
        &self.id
    }
}

fn parse_dt(s: &str) -> NaiveDateTime {
    chrono::DateTime::parse_from_rfc3339(s)
        .map(|dt| dt.naive_utc())
        .unwrap_or_else(|_| chrono::Utc::now().naive_utc())
}

impl From<ActivityTaxonomyAssignmentDB> for ActivityTaxonomyAssignment {
    fn from(db: ActivityTaxonomyAssignmentDB) -> Self {
        Self {
            id: db.id,
            activity_id: db.activity_id,
            taxonomy_id: db.taxonomy_id,
            category_id: db.category_id,
            weight: db.weight,
            source: db.source,
            created_at: parse_dt(&db.created_at),
            updated_at: parse_dt(&db.updated_at),
        }
    }
}

pub struct ActivityTaxonomyAssignmentRepository {
    pool: Arc<DbPool>,
    writer: WriteHandle,
}

impl ActivityTaxonomyAssignmentRepository {
    pub fn new(pool: Arc<DbPool>, writer: WriteHandle) -> Self {
        Self { pool, writer }
    }
}

fn clear_splits_for_activities_tx(
    tx: &mut DbWriteTx<'_>,
    activity_ids: &[String],
) -> wealthfolio_core::Result<()> {
    if activity_ids.is_empty() {
        return Ok(());
    }

    const CHUNK: usize = 500;
    for chunk in activity_ids.chunks(CHUNK) {
        let existing: Vec<(String, String)> = spending_activity_splits::table
            .filter(spending_activity_splits::activity_id.eq_any(chunk))
            .select((
                spending_activity_splits::id,
                spending_activity_splits::activity_id,
            ))
            .load(tx.conn())
            .map_err(StorageError::from)?;
        if existing.is_empty() {
            continue;
        }

        let mut sync_activity_ids = HashSet::new();
        for activity_id in existing
            .iter()
            .map(|(_, activity_id)| activity_id.as_str())
            .collect::<HashSet<_>>()
        {
            if should_sync_activity_local_id_outbox(tx.conn(), activity_id)? {
                sync_activity_ids.insert(activity_id.to_string());
            }
        }

        diesel::delete(
            spending_activity_splits::table
                .filter(spending_activity_splits::activity_id.eq_any(chunk)),
        )
        .execute(tx.conn())
        .map_err(StorageError::from)?;

        for (split_id, activity_id) in existing {
            if sync_activity_ids.contains(&activity_id) {
                tx.delete::<ActivitySplitDB>(split_id);
            }
        }
    }

    Ok(())
}

enum RuleDecision {
    Eligible(bool),
    Split,
    Manual,
    Existing,
    Unchanged,
}
fn rule_decision(
    conn: &mut SqliteConnection,
    item: &NewActivityTaxonomyAssignment,
    only_uncategorized: bool,
) -> wealthfolio_core::Result<RuleDecision> {
    if diesel::select(diesel::dsl::exists(
        spending_activity_splits::table
            .filter(spending_activity_splits::activity_id.eq(&item.activity_id)),
    ))
    .get_result::<bool>(conn)
    .map_err(StorageError::from)?
    {
        return Ok(RuleDecision::Split);
    }
    let existing = activity_taxonomy_assignments::table
        .filter(activity_taxonomy_assignments::activity_id.eq(&item.activity_id))
        .filter(activity_taxonomy_assignments::taxonomy_id.eq(&item.taxonomy_id))
        .load::<ActivityTaxonomyAssignmentDB>(conn)
        .map_err(StorageError::from)?;
    if existing
        .iter()
        .any(|a| a.source.eq_ignore_ascii_case("manual"))
    {
        return Ok(RuleDecision::Manual);
    }
    if only_uncategorized && !existing.is_empty() {
        return Ok(RuleDecision::Existing);
    }
    if existing.len() == 1
        && existing[0].category_id == item.category_id
        && existing[0].weight == item.weight
        && existing[0].source == item.source
    {
        return Ok(RuleDecision::Unchanged);
    }
    Ok(RuleDecision::Eligible(!existing.is_empty()))
}
fn count_rule_decision(
    summary: &mut wealthfolio_spending::activity_assignments::RuleAssignmentResult,
    decision: &RuleDecision,
) {
    match decision {
        RuleDecision::Eligible(_) => summary.eligible += 1,
        RuleDecision::Split => summary.protected_splits += 1,
        RuleDecision::Manual => summary.protected_manual += 1,
        RuleDecision::Existing => summary.skipped_existing += 1,
        RuleDecision::Unchanged => summary.unchanged += 1,
    }
}

#[async_trait]
impl ActivityTaxonomyAssignmentRepositoryTrait for ActivityTaxonomyAssignmentRepository {
    async fn list_for_activity(
        &self,
        activity_id: &str,
    ) -> Result<Vec<ActivityTaxonomyAssignment>> {
        let mut conn = get_connection(&self.pool).map_err(|e| anyhow::anyhow!(e))?;
        let rows = activity_taxonomy_assignments::table
            .filter(activity_taxonomy_assignments::activity_id.eq(activity_id))
            .load::<ActivityTaxonomyAssignmentDB>(&mut conn)
            .map_err(StorageError::from)
            .map_err(|e| anyhow::anyhow!(e))?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    async fn list_for_activities(
        &self,
        activity_ids: &[String],
    ) -> Result<Vec<ActivityTaxonomyAssignment>> {
        if activity_ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut conn = get_connection(&self.pool).map_err(|e| anyhow::anyhow!(e))?;
        // SQLite has a default 999-parameter cap; chunk to stay safely under.
        const CHUNK: usize = 500;
        let mut out = Vec::new();
        for chunk in activity_ids.chunks(CHUNK) {
            let rows = activity_taxonomy_assignments::table
                .filter(activity_taxonomy_assignments::activity_id.eq_any(chunk))
                .load::<ActivityTaxonomyAssignmentDB>(&mut conn)
                .map_err(StorageError::from)
                .map_err(|e| anyhow::anyhow!(e))?;
            out.extend(rows.into_iter().map(ActivityTaxonomyAssignment::from));
        }
        Ok(out)
    }

    async fn upsert(
        &self,
        new: NewActivityTaxonomyAssignment,
    ) -> Result<ActivityTaxonomyAssignment> {
        let now = chrono::Utc::now().to_rfc3339();
        let NewActivityTaxonomyAssignment {
            id,
            activity_id,
            taxonomy_id,
            category_id,
            weight,
            source,
        } = new;
        let id = id.unwrap_or_else(|| activity_taxonomy_assignment_id(&activity_id, &taxonomy_id));
        let row = NewActivityTaxonomyAssignmentDB {
            id,
            activity_id,
            taxonomy_id,
            category_id,
            weight,
            source,
            created_at: now.clone(),
            updated_at: now,
        };

        self.writer
            .exec_tx(move |tx| {
                let result = diesel::insert_into(activity_taxonomy_assignments::table)
                    .values(&row)
                    .on_conflict((
                        activity_taxonomy_assignments::activity_id,
                        activity_taxonomy_assignments::taxonomy_id,
                    ))
                    .do_update()
                    .set((
                        activity_taxonomy_assignments::category_id.eq(&row.category_id),
                        activity_taxonomy_assignments::weight.eq(&row.weight),
                        activity_taxonomy_assignments::source.eq(&row.source),
                        activity_taxonomy_assignments::updated_at.eq(&row.updated_at),
                    ))
                    .returning(ActivityTaxonomyAssignmentDB::as_returning())
                    .get_result(tx.conn())
                    .map_err(StorageError::from)?;

                if should_sync_activity_local_id_outbox(tx.conn(), &result.activity_id)? {
                    tx.update(&result)?;
                }
                Ok(result)
            })
            .await
            .map(ActivityTaxonomyAssignment::from)
            .map_err(|e| anyhow::anyhow!(e))
    }

    async fn assign_many_single_select(
        &self,
        items: Vec<NewActivityTaxonomyAssignment>,
    ) -> Result<Vec<ActivityTaxonomyAssignment>> {
        if items.is_empty() {
            return Ok(Vec::new());
        }
        let now = chrono::Utc::now().to_rfc3339();
        let inserted_dbs: Vec<ActivityTaxonomyAssignmentDB> = self
            .writer
            .exec_tx(move |tx| {
                let mut out = Vec::with_capacity(items.len());
                for item in items {
                    let NewActivityTaxonomyAssignment {
                        id,
                        activity_id,
                        taxonomy_id,
                        category_id,
                        weight,
                        source,
                    } = item;
                    let existing_id = activity_taxonomy_assignments::table
                        .filter(activity_taxonomy_assignments::activity_id.eq(&activity_id))
                        .filter(activity_taxonomy_assignments::taxonomy_id.eq(&taxonomy_id))
                        .select(activity_taxonomy_assignments::id)
                        .first::<String>(tx.conn())
                        .optional()
                        .map_err(StorageError::from)?;

                    let id = id.unwrap_or_else(|| {
                        activity_taxonomy_assignment_id(&activity_id, &taxonomy_id)
                    });
                    let row = NewActivityTaxonomyAssignmentDB {
                        id,
                        activity_id,
                        taxonomy_id,
                        category_id,
                        weight,
                        source,
                        created_at: now.clone(),
                        updated_at: now.clone(),
                    };

                    let inserted = diesel::insert_into(activity_taxonomy_assignments::table)
                        .values(&row)
                        .on_conflict((
                            activity_taxonomy_assignments::activity_id,
                            activity_taxonomy_assignments::taxonomy_id,
                        ))
                        .do_update()
                        .set((
                            activity_taxonomy_assignments::category_id.eq(&row.category_id),
                            activity_taxonomy_assignments::weight.eq(&row.weight),
                            activity_taxonomy_assignments::source.eq(&row.source),
                            activity_taxonomy_assignments::updated_at.eq(&row.updated_at),
                        ))
                        .returning(ActivityTaxonomyAssignmentDB::as_returning())
                        .get_result::<ActivityTaxonomyAssignmentDB>(tx.conn())
                        .map_err(StorageError::from)?;

                    if should_sync_activity_local_id_outbox(tx.conn(), &inserted.activity_id)? {
                        if existing_id.is_some() {
                            tx.update(&inserted)?;
                        } else {
                            tx.insert(&inserted)?;
                        }
                    }
                    out.push(inserted);
                }
                Ok(out)
            })
            .await
            .map_err(|e| anyhow::anyhow!(e))?;

        Ok(inserted_dbs
            .into_iter()
            .map(ActivityTaxonomyAssignment::from)
            .collect())
    }

    async fn assign_many_single_select_clearing_splits(
        &self,
        items: Vec<NewActivityTaxonomyAssignment>,
        split_replacements: HashMap<String, Vec<ActivitySplit>>,
    ) -> Result<Vec<ActivityTaxonomyAssignment>> {
        if items.is_empty() {
            return Ok(Vec::new());
        }

        let mut seen_activity_ids = HashSet::new();
        let activity_ids = items
            .iter()
            .filter_map(|item| {
                if seen_activity_ids.insert(item.activity_id.clone()) {
                    Some(item.activity_id.clone())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();

        let now = chrono::Utc::now().to_rfc3339();
        let outcome = self
            .writer
            .exec_tx(move |tx| {
                // Check every row before changing assignments or emitting outbox entries.
                // Splits may have changed since a native or MCP preview was shown.
                let mut conflicts = Vec::new();
                for activity_id in &activity_ids {
                    let mut current: Vec<ActivitySplit> = spending_activity_splits::table
                        .filter(spending_activity_splits::activity_id.eq(activity_id))
                        .load::<ActivitySplitDB>(tx.conn())
                        .map_err(StorageError::from)?
                        .into_iter()
                        .map(Into::into)
                        .collect();
                    if let Some(expected) = split_replacements.get(activity_id) {
                        let mut expected = expected.clone();
                        current.sort_by(|a, b| a.id.cmp(&b.id));
                        expected.sort_by(|a, b| a.id.cmp(&b.id));
                        if current != expected {
                            conflicts.push(SplitAssignmentConflict {
                                activity_id: activity_id.clone(),
                                reason: SplitAssignmentConflictReason::SplitStateChanged,
                            });
                        }
                    } else if !current.is_empty() {
                        conflicts.push(SplitAssignmentConflict {
                            activity_id: activity_id.clone(),
                            reason: SplitAssignmentConflictReason::ProtectedSplits,
                        });
                    }
                }
                if !conflicts.is_empty() {
                    return Ok(Err(CategoryAssignmentConflicts { conflicts }));
                }
                clear_splits_for_activities_tx(tx, &activity_ids)?;

                let mut out = Vec::with_capacity(items.len());
                for item in items {
                    let NewActivityTaxonomyAssignment {
                        id,
                        activity_id,
                        taxonomy_id,
                        category_id,
                        weight,
                        source,
                    } = item;
                    let existing_id = activity_taxonomy_assignments::table
                        .filter(activity_taxonomy_assignments::activity_id.eq(&activity_id))
                        .filter(activity_taxonomy_assignments::taxonomy_id.eq(&taxonomy_id))
                        .select(activity_taxonomy_assignments::id)
                        .first::<String>(tx.conn())
                        .optional()
                        .map_err(StorageError::from)?;

                    let id = id.unwrap_or_else(|| {
                        activity_taxonomy_assignment_id(&activity_id, &taxonomy_id)
                    });
                    let row = NewActivityTaxonomyAssignmentDB {
                        id,
                        activity_id,
                        taxonomy_id,
                        category_id,
                        weight,
                        source,
                        created_at: now.clone(),
                        updated_at: now.clone(),
                    };

                    let inserted = diesel::insert_into(activity_taxonomy_assignments::table)
                        .values(&row)
                        .on_conflict((
                            activity_taxonomy_assignments::activity_id,
                            activity_taxonomy_assignments::taxonomy_id,
                        ))
                        .do_update()
                        .set((
                            activity_taxonomy_assignments::category_id.eq(&row.category_id),
                            activity_taxonomy_assignments::weight.eq(&row.weight),
                            activity_taxonomy_assignments::source.eq(&row.source),
                            activity_taxonomy_assignments::updated_at.eq(&row.updated_at),
                        ))
                        .returning(ActivityTaxonomyAssignmentDB::as_returning())
                        .get_result::<ActivityTaxonomyAssignmentDB>(tx.conn())
                        .map_err(StorageError::from)?;

                    if should_sync_activity_local_id_outbox(tx.conn(), &inserted.activity_id)? {
                        if existing_id.is_some() {
                            tx.update(&inserted)?;
                        } else {
                            tx.insert(&inserted)?;
                        }
                    }
                    out.push(inserted);
                }
                Ok(Ok(out))
            })
            .await
            .map_err(|e| anyhow::anyhow!(e))?;

        let inserted_dbs = outcome?;
        Ok(inserted_dbs
            .into_iter()
            .map(ActivityTaxonomyAssignment::from)
            .collect())
    }

    async fn assign_rule_many_single_select(
        &self,
        items: Vec<NewActivityTaxonomyAssignment>,
        only_uncategorized: bool,
    ) -> Result<Vec<ActivityTaxonomyAssignment>> {
        Ok(self
            .assign_rules_detailed(items, only_uncategorized)
            .await?
            .assignments)
    }
    async fn preview_rules(
        &self,
        items: Vec<NewActivityTaxonomyAssignment>,
        only_uncategorized: bool,
    ) -> Result<wealthfolio_spending::activity_assignments::RuleAssignmentResult> {
        let mut conn = get_connection(&self.pool).map_err(|e| anyhow::anyhow!(e))?;
        let mut result =
            wealthfolio_spending::activity_assignments::RuleAssignmentResult::default();
        for item in items {
            let decision = rule_decision(&mut conn, &item, only_uncategorized)?;
            count_rule_decision(&mut result, &decision);
        }
        Ok(result)
    }
    async fn assign_rules_detailed(
        &self,
        items: Vec<NewActivityTaxonomyAssignment>,
        only_uncategorized: bool,
    ) -> Result<wealthfolio_spending::activity_assignments::RuleAssignmentResult> {
        if items.is_empty() {
            return Ok(Default::default());
        }
        let now = chrono::Utc::now().to_rfc3339();
        let result = self
            .writer
            .exec_tx(move |tx| {
                let mut result =
                    wealthfolio_spending::activity_assignments::RuleAssignmentResult::default();
                for item in items {
                    let decision = rule_decision(tx.conn(), &item, only_uncategorized)?;
                    count_rule_decision(&mut result, &decision);
                    let RuleDecision::Eligible(had_existing) = decision else {
                        continue;
                    };
                    let NewActivityTaxonomyAssignment {
                        id,
                        activity_id,
                        taxonomy_id,
                        category_id,
                        weight,
                        source,
                    } = item;
                    let id = id.unwrap_or_else(|| {
                        activity_taxonomy_assignment_id(&activity_id, &taxonomy_id)
                    });
                    let row = NewActivityTaxonomyAssignmentDB {
                        id,
                        activity_id,
                        taxonomy_id,
                        category_id,
                        weight,
                        source,
                        created_at: now.clone(),
                        updated_at: now.clone(),
                    };

                    let inserted = diesel::insert_into(activity_taxonomy_assignments::table)
                        .values(&row)
                        .on_conflict((
                            activity_taxonomy_assignments::activity_id,
                            activity_taxonomy_assignments::taxonomy_id,
                        ))
                        .do_update()
                        .set((
                            activity_taxonomy_assignments::category_id.eq(&row.category_id),
                            activity_taxonomy_assignments::weight.eq(&row.weight),
                            activity_taxonomy_assignments::source.eq(&row.source),
                            activity_taxonomy_assignments::updated_at.eq(&row.updated_at),
                        ))
                        .returning(ActivityTaxonomyAssignmentDB::as_returning())
                        .get_result::<ActivityTaxonomyAssignmentDB>(tx.conn())
                        .map_err(StorageError::from)?;

                    if should_sync_activity_local_id_outbox(tx.conn(), &inserted.activity_id)? {
                        if had_existing {
                            tx.update(&inserted)?;
                        } else {
                            tx.insert(&inserted)?;
                        }
                    }
                    result
                        .assignments
                        .push(ActivityTaxonomyAssignment::from(inserted));
                    result.changed += 1;
                }
                Ok(result)
            })
            .await
            .map_err(|e| anyhow::anyhow!(e))?;

        Ok(result)
    }

    async fn delete(&self, id: &str) -> Result<()> {
        let id = id.to_string();
        self.writer
            .exec_tx(move |tx| {
                let existing = activity_taxonomy_assignments::table
                    .find(&id)
                    .first::<ActivityTaxonomyAssignmentDB>(tx.conn())
                    .optional()
                    .map_err(StorageError::from)?;
                let should_sync = match &existing {
                    Some(row) => should_sync_activity_local_id_outbox(tx.conn(), &row.activity_id)?,
                    None => false,
                };
                let affected = diesel::delete(activity_taxonomy_assignments::table.find(&id))
                    .execute(tx.conn())
                    .map_err(StorageError::from)?;
                if affected > 0 && should_sync {
                    tx.delete::<ActivityTaxonomyAssignmentDB>(id.clone());
                }
                Ok(())
            })
            .await
            .map_err(|e| anyhow::anyhow!(e))
    }

    async fn clear_for_taxonomy(&self, activity_id: &str, taxonomy_id: &str) -> Result<()> {
        let activity_id = activity_id.to_string();
        let taxonomy_id = taxonomy_id.to_string();
        self.writer
            .exec_tx(move |tx| {
                let existing_ids = activity_taxonomy_assignments::table
                    .filter(activity_taxonomy_assignments::activity_id.eq(&activity_id))
                    .filter(activity_taxonomy_assignments::taxonomy_id.eq(&taxonomy_id))
                    .select(activity_taxonomy_assignments::id)
                    .load::<String>(tx.conn())
                    .map_err(StorageError::from)?;
                let should_sync = should_sync_activity_local_id_outbox(tx.conn(), &activity_id)?;

                diesel::delete(
                    activity_taxonomy_assignments::table
                        .filter(activity_taxonomy_assignments::activity_id.eq(&activity_id))
                        .filter(activity_taxonomy_assignments::taxonomy_id.eq(&taxonomy_id)),
                )
                .execute(tx.conn())
                .map_err(StorageError::from)?;

                if should_sync {
                    for assignment_id in existing_ids {
                        tx.delete::<ActivityTaxonomyAssignmentDB>(assignment_id);
                    }
                }
                Ok(())
            })
            .await
            .map_err(|e| anyhow::anyhow!(e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{create_pool, get_connection, init, run_migrations, write_actor::spawn_writer};
    use crate::schema::{
        activities, activity_taxonomy_assignments, spending_activity_splits, sync_outbox,
    };
    use diesel::r2d2::{ConnectionManager, Pool};
    use std::sync::Arc;
    use tempfile::tempdir;
    use wealthfolio_spending::activity_assignments::{
        ActivityTaxonomyAssignmentRepositoryTrait, NewActivityTaxonomyAssignment,
    };

    fn setup_db() -> (
        Arc<Pool<ConnectionManager<SqliteConnection>>>,
        WriteHandle,
        tempfile::TempDir,
    ) {
        std::env::set_var("CONNECT_API_URL", "http://test.local");
        let dir = tempdir().expect("tempdir");
        let app_data = dir.path().to_string_lossy().to_string();
        let db_path = init(&app_data).expect("init db");
        run_migrations(&db_path).expect("migrate db");
        let pool = create_pool(&db_path).expect("create pool");
        let writer = spawn_writer(pool.as_ref().clone()).expect("spawn writer");
        (pool, writer, dir)
    }

    fn insert_account_and_activity(conn: &mut SqliteConnection, id: &str, source_system: &str) {
        let account_id = format!("account-{id}");
        diesel::sql_query(format!(
            "INSERT INTO accounts \
             (id, name, account_type, `group`, currency, is_default, is_active, created_at, updated_at, \
              platform_id, account_number, meta, provider, provider_account_id, is_archived, tracking_mode) \
             VALUES ('{}', 'Account {}', 'cash', NULL, 'USD', 0, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, \
                     NULL, NULL, NULL, NULL, NULL, 0, 'portfolio')",
            account_id, id
        ))
        .execute(conn)
        .expect("insert account");

        diesel::sql_query(format!(
            "INSERT INTO activities \
             (id, account_id, asset_id, activity_type, activity_type_override, source_type, subtype, \
              status, activity_date, settlement_date, quantity, unit_price, amount, fee, currency, \
              fx_rate, notes, metadata, source_system, source_record_id, source_group_id, \
              idempotency_key, import_run_id, is_user_modified, needs_review, created_at, updated_at) \
             VALUES ('{}', '{}', NULL, 'BUY', NULL, NULL, NULL, 'POSTED', \
                     '2026-01-01T00:00:00Z', NULL, NULL, NULL, '10', NULL, 'USD', NULL, \
                     NULL, NULL, '{}', '{}-source-record', NULL, NULL, NULL, 0, 0, \
                     '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            id, account_id, source_system, id
        ))
        .execute(conn)
        .expect("insert activity");
    }

    fn outbox_count(conn: &mut SqliteConnection) -> i64 {
        sync_outbox::table
            .count()
            .get_result::<i64>(conn)
            .expect("count outbox")
    }

    fn mark_activity_user_modified(conn: &mut SqliteConnection, activity_id: &str) {
        diesel::update(activities::table.find(activity_id))
            .set(activities::is_user_modified.eq(1))
            .execute(conn)
            .expect("mark activity user modified");
    }

    fn insert_split(conn: &mut SqliteConnection, id: &str, activity_id: &str) {
        diesel::sql_query(format!(
            "INSERT INTO spending_activity_splits \
             (id, activity_id, taxonomy_id, category_id, amount, note, sort_order, created_at, updated_at) \
             VALUES ('{}', '{}', 'spending_categories', 'cat_food', '10', NULL, 0, \
                     '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            id, activity_id
        ))
        .execute(conn)
        .expect("insert split");
    }

    #[tokio::test]
    async fn rule_reruns_preserve_split_allocations_in_both_modes() {
        for only_uncategorized in [true, false] {
            let (pool, writer, _dir) = setup_db();
            {
                let mut conn = get_connection(&pool).expect("conn");
                insert_account_and_activity(&mut conn, "split-activity", "MANUAL");
                insert_split(&mut conn, "split-1", "split-activity");
            }
            let repo = ActivityTaxonomyAssignmentRepository::new(pool.clone(), writer);
            let applied = repo
                .assign_rule_many_single_select(
                    vec![NewActivityTaxonomyAssignment {
                        id: None,
                        activity_id: "split-activity".to_string(),
                        taxonomy_id: "spending_categories".to_string(),
                        category_id: "cat_groceries".to_string(),
                        weight: 10_000,
                        source: "rule".to_string(),
                    }],
                    only_uncategorized,
                )
                .await
                .expect("rerun rules");
            assert!(applied.is_empty());
            assert!(repo
                .list_for_activity("split-activity")
                .await
                .unwrap()
                .is_empty());
            let mut conn = get_connection(&pool).expect("conn");
            assert_eq!(
                spending_activity_splits::table
                    .count()
                    .get_result::<i64>(&mut conn)
                    .unwrap(),
                1
            );
        }
    }

    #[tokio::test]
    async fn ordinary_bulk_assignment_rejects_split_rows_atomically() {
        let (pool, writer, _dir) = setup_db();
        {
            let mut conn = get_connection(&pool).expect("conn");
            insert_account_and_activity(&mut conn, "ordinary", "MANUAL");
            insert_account_and_activity(&mut conn, "split-activity", "MANUAL");
            insert_split(&mut conn, "split-1", "split-activity");
        }
        let repo = ActivityTaxonomyAssignmentRepository::new(pool.clone(), writer);
        let items = ["ordinary", "split-activity"]
            .map(|id| NewActivityTaxonomyAssignment {
                id: None,
                activity_id: id.to_string(),
                taxonomy_id: "spending_categories".to_string(),
                category_id: "cat_groceries".to_string(),
                weight: 10_000,
                source: "manual".to_string(),
            })
            .to_vec();
        assert!(repo
            .assign_many_single_select_clearing_splits(items, HashMap::new())
            .await
            .is_err());
        assert!(repo.list_for_activity("ordinary").await.unwrap().is_empty());
        assert!(repo
            .list_for_activity("split-activity")
            .await
            .unwrap()
            .is_empty());
        let mut conn = get_connection(&pool).expect("conn");
        assert_eq!(
            spending_activity_splits::table
                .count()
                .get_result::<i64>(&mut conn)
                .unwrap(),
            1
        );
    }

    #[tokio::test]
    async fn stale_split_content_rejects_the_whole_replacement() {
        let (pool, writer, _dir) = setup_db();
        let expected = {
            let mut conn = get_connection(&pool).expect("conn");
            insert_account_and_activity(&mut conn, "ordinary", "MANUAL");
            insert_account_and_activity(&mut conn, "split-activity", "MANUAL");
            insert_split(&mut conn, "split-1", "split-activity");
            let expected = spending_activity_splits::table
                .load::<ActivitySplitDB>(&mut conn)
                .unwrap()
                .into_iter()
                .map(ActivitySplit::from)
                .collect::<Vec<_>>();
            // Same ID and timestamps: comparing identifiers alone loses this edit.
            diesel::update(spending_activity_splits::table.find("split-1"))
                .set(spending_activity_splits::note.eq("Changed after review"))
                .execute(&mut conn)
                .unwrap();
            expected
        };
        let repo = ActivityTaxonomyAssignmentRepository::new(pool.clone(), writer);
        let items = ["ordinary", "split-activity"]
            .map(|id| NewActivityTaxonomyAssignment {
                id: None,
                activity_id: id.to_string(),
                taxonomy_id: "spending_categories".to_string(),
                category_id: "cat_groceries".to_string(),
                weight: 10_000,
                source: "manual".to_string(),
            })
            .to_vec();
        let error = repo
            .assign_many_single_select_clearing_splits(
                items,
                HashMap::from([("split-activity".to_string(), expected)]),
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("changed"));
        assert!(repo.list_for_activity("ordinary").await.unwrap().is_empty());
        assert!(repo
            .list_for_activity("split-activity")
            .await
            .unwrap()
            .is_empty());
        let mut conn = get_connection(&pool).expect("conn");
        assert_eq!(
            spending_activity_splits::table
                .find("split-1")
                .select(spending_activity_splits::note)
                .first::<Option<String>>(&mut conn)
                .unwrap(),
            Some("Changed after review".to_string())
        );
        assert_eq!(
            crate::schema::sync_outbox::table
                .count()
                .get_result::<i64>(&mut conn)
                .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn assigning_category_clears_existing_splits_in_same_write() {
        let (pool, writer, _dir) = setup_db();
        {
            let mut conn = get_connection(&pool).expect("conn");
            insert_account_and_activity(&mut conn, "manual-activity", "MANUAL");
            insert_split(&mut conn, "split-1", "manual-activity");
        }

        let repo = ActivityTaxonomyAssignmentRepository::new(pool.clone(), writer);
        let expected = {
            let mut conn = get_connection(&pool).expect("conn");
            spending_activity_splits::table
                .load::<ActivitySplitDB>(&mut conn)
                .unwrap()
                .into_iter()
                .map(ActivitySplit::from)
                .collect::<Vec<_>>()
        };
        repo.assign_many_single_select_clearing_splits(
            vec![NewActivityTaxonomyAssignment {
                id: None,
                activity_id: "manual-activity".to_string(),
                taxonomy_id: "spending_categories".to_string(),
                category_id: "cat_groceries".to_string(),
                weight: 10_000,
                source: "manual".to_string(),
            }],
            HashMap::from([("manual-activity".to_string(), expected)]),
        )
        .await
        .expect("assign category");

        let mut conn = get_connection(&pool).expect("conn");
        assert_eq!(
            spending_activity_splits::table
                .count()
                .get_result::<i64>(&mut conn)
                .expect("count splits"),
            0
        );
        assert_eq!(
            activity_taxonomy_assignments::table
                .count()
                .get_result::<i64>(&mut conn)
                .expect("count assignments"),
            1
        );
    }

    #[tokio::test]
    async fn broker_activity_assignment_is_local_only_but_manual_assignment_still_syncs() {
        let (pool, writer, _dir) = setup_db();
        {
            let mut conn = get_connection(&pool).expect("conn");
            insert_account_and_activity(&mut conn, "broker-activity", "SNAPTRADE");
            mark_activity_user_modified(&mut conn, "broker-activity");
            insert_account_and_activity(&mut conn, "manual-activity", "MANUAL");
        }

        let repo = ActivityTaxonomyAssignmentRepository::new(pool.clone(), writer);
        repo.upsert(NewActivityTaxonomyAssignment {
            id: None,
            activity_id: "broker-activity".to_string(),
            taxonomy_id: "spending_categories".to_string(),
            category_id: "cat_food".to_string(),
            weight: 10_000,
            source: "manual".to_string(),
        })
        .await
        .expect("assign broker activity");

        let mut conn = get_connection(&pool).expect("conn");
        assert_eq!(
            activity_taxonomy_assignments::table
                .count()
                .get_result::<i64>(&mut conn)
                .expect("count assignments"),
            1
        );
        assert_eq!(outbox_count(&mut conn), 0);

        repo.upsert(NewActivityTaxonomyAssignment {
            id: None,
            activity_id: "manual-activity".to_string(),
            taxonomy_id: "spending_categories".to_string(),
            category_id: "cat_groceries".to_string(),
            weight: 10_000,
            source: "manual".to_string(),
        })
        .await
        .expect("assign manual activity");

        let entities = sync_outbox::table
            .select(sync_outbox::entity)
            .load::<String>(&mut conn)
            .expect("load outbox entities");
        assert_eq!(entities, vec!["activity_taxonomy_assignment".to_string()]);
    }
}
