//! Storage adapter for spending::categorization_rules.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use anyhow::Result;
use async_trait::async_trait;
use chrono::NaiveDateTime;
use diesel::prelude::*;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::db::{get_connection, DbPool, WriteHandle};
use crate::errors::StorageError;
use crate::schema::{spending_categorization_rules, spending_preset_rule_deletions};
use crate::spending::deterministic_ids::{preset_categorization_rule_id, preset_rule_deletion_id};
use crate::sync::OutboxWriteRequest;
use wealthfolio_core::sync::{SyncEntity, SyncOperation};
use wealthfolio_spending::categorization_rules::{
    CategorizationRule, CategorizationRulesRepositoryTrait, NewCategorizationRule,
    PresetImportCounts, RuleMatchType, UpdateCategorizationRule,
};

#[derive(Queryable, Identifiable, Selectable, Serialize, Deserialize, Debug, Clone)]
#[diesel(table_name = crate::schema::spending_categorization_rules)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
#[serde(rename_all = "camelCase")]
pub struct CategorizationRuleDB {
    pub id: String,
    pub name: String,
    pub pattern: String,
    pub match_type: String,
    pub taxonomy_id: Option<String>,
    pub category_id: Option<String>,
    pub activity_type: Option<String>,
    pub priority: i32,
    pub is_global: i32,
    pub account_id: Option<String>,
    pub preset_id: Option<String>,
    pub preset_rule_key: Option<String>,
    pub preset_version: Option<String>,
    pub preset_modified: i32,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Insertable, AsChangeset, Serialize, Deserialize, Debug, Clone)]
#[diesel(table_name = crate::schema::spending_categorization_rules)]
pub struct NewCategorizationRuleDB {
    pub id: String,
    pub name: String,
    pub pattern: String,
    pub match_type: String,
    pub taxonomy_id: Option<String>,
    pub category_id: Option<String>,
    pub activity_type: Option<String>,
    pub priority: i32,
    pub is_global: i32,
    pub account_id: Option<String>,
    pub preset_id: Option<String>,
    pub preset_rule_key: Option<String>,
    pub preset_version: Option<String>,
    pub preset_modified: i32,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Queryable, Selectable, Insertable, Serialize, Deserialize, Debug, Clone)]
#[diesel(table_name = crate::schema::spending_preset_rule_deletions)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
#[serde(rename_all = "camelCase")]
struct PresetRuleDeletionDB {
    preset_id: String,
    preset_rule_key: String,
    rule_id: String,
    deleted_at: String,
}

impl crate::sync::SyncOutboxModel for CategorizationRuleDB {
    const ENTITY: SyncEntity = SyncEntity::SpendingCategorizationRule;
    fn sync_entity_id(&self) -> &str {
        &self.id
    }
}

impl crate::sync::SyncOutboxModel for PresetRuleDeletionDB {
    const ENTITY: SyncEntity = SyncEntity::SpendingPresetRuleDeletion;

    // `rule_id` is the deleted categorization rule row. The sync entity ID is
    // the deterministic composite key returned by `sync_entity_id_owned()`.
    fn sync_entity_id(&self) -> &str {
        &self.rule_id
    }

    fn sync_entity_id_owned(&self) -> String {
        preset_rule_deletion_id(&self.preset_id, &self.preset_rule_key)
    }
}

fn upsert_preset_rule_deletion(
    conn: &mut diesel::sqlite::SqliteConnection,
    preset_id: &str,
    preset_rule_key: &str,
    rule_id: &str,
    deleted_at: &str,
) -> std::result::Result<PresetRuleDeletionDB, StorageError> {
    let row = PresetRuleDeletionDB {
        preset_id: preset_id.to_string(),
        preset_rule_key: preset_rule_key.to_string(),
        rule_id: rule_id.to_string(),
        deleted_at: deleted_at.to_string(),
    };

    diesel::insert_into(spending_preset_rule_deletions::table)
        .values(&row)
        .on_conflict((
            spending_preset_rule_deletions::preset_id,
            spending_preset_rule_deletions::preset_rule_key,
        ))
        .do_update()
        .set((
            spending_preset_rule_deletions::rule_id.eq(&row.rule_id),
            spending_preset_rule_deletions::deleted_at.eq(&row.deleted_at),
        ))
        .execute(conn)
        .map_err(StorageError::from)?;
    Ok(row)
}

fn parse_dt(s: &str) -> NaiveDateTime {
    chrono::DateTime::parse_from_rfc3339(s)
        .map(|dt| dt.naive_utc())
        .unwrap_or_else(|_| chrono::Utc::now().naive_utc())
}

impl From<CategorizationRuleDB> for CategorizationRule {
    fn from(db: CategorizationRuleDB) -> Self {
        Self {
            id: db.id,
            name: db.name,
            pattern: db.pattern,
            match_type: RuleMatchType::parse(&db.match_type),
            taxonomy_id: db.taxonomy_id,
            category_id: db.category_id,
            activity_type: db.activity_type,
            priority: db.priority,
            is_global: db.is_global != 0,
            account_id: db.account_id,
            preset_id: db.preset_id,
            preset_rule_key: db.preset_rule_key,
            preset_version: db.preset_version,
            preset_modified: db.preset_modified != 0,
            created_at: parse_dt(&db.created_at),
            updated_at: parse_dt(&db.updated_at),
        }
    }
}

pub struct CategorizationRulesRepository {
    pool: Arc<DbPool>,
    writer: WriteHandle,
}

impl CategorizationRulesRepository {
    pub fn new(pool: Arc<DbPool>, writer: WriteHandle) -> Self {
        Self { pool, writer }
    }
}

fn new_rule_db(new_rule: NewCategorizationRule, now: &str) -> NewCategorizationRuleDB {
    let NewCategorizationRule {
        id,
        name,
        pattern,
        match_type,
        taxonomy_id,
        category_id,
        activity_type,
        priority,
        is_global,
        account_id,
        preset_id,
        preset_rule_key,
        preset_version,
    } = new_rule;
    let id = id.unwrap_or_else(
        || match (preset_id.as_deref(), preset_rule_key.as_deref()) {
            (Some(preset_id), Some(rule_key)) if !preset_id.is_empty() && !rule_key.is_empty() => {
                preset_categorization_rule_id(preset_id, rule_key)
            }
            _ => Uuid::new_v4().to_string(),
        },
    );

    NewCategorizationRuleDB {
        id,
        name,
        pattern,
        match_type: match_type.as_str().to_string(),
        taxonomy_id,
        category_id,
        activity_type,
        priority,
        is_global: if is_global { 1 } else { 0 },
        account_id,
        preset_id,
        preset_rule_key,
        preset_version,
        preset_modified: 0,
        created_at: now.to_string(),
        updated_at: now.to_string(),
    }
}

#[async_trait]
impl CategorizationRulesRepositoryTrait for CategorizationRulesRepository {
    async fn list(&self) -> Result<Vec<CategorizationRule>> {
        let mut conn = get_connection(&self.pool).map_err(|e| anyhow::anyhow!(e))?;
        let rows = spending_categorization_rules::table
            .order((
                spending_categorization_rules::priority.desc(),
                spending_categorization_rules::created_at.asc(),
                spending_categorization_rules::id.asc(),
            ))
            .load::<CategorizationRuleDB>(&mut conn)
            .map_err(StorageError::from)
            .map_err(|e| anyhow::anyhow!(e))?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    async fn get(&self, id: &str) -> Result<Option<CategorizationRule>> {
        let mut conn = get_connection(&self.pool).map_err(|e| anyhow::anyhow!(e))?;
        let row = spending_categorization_rules::table
            .find(id)
            .first::<CategorizationRuleDB>(&mut conn)
            .optional()
            .map_err(StorageError::from)
            .map_err(|e| anyhow::anyhow!(e))?;
        Ok(row.map(Into::into))
    }

    async fn create(&self, new_rule: NewCategorizationRule) -> Result<CategorizationRule> {
        let now = chrono::Utc::now().to_rfc3339();
        let row = new_rule_db(new_rule, &now);
        self.writer
            .exec_tx(move |tx| {
                let inserted = diesel::insert_into(spending_categorization_rules::table)
                    .values(&row)
                    .returning(CategorizationRuleDB::as_returning())
                    .get_result(tx.conn())
                    .map_err(StorageError::from)?;
                tx.insert(&inserted)?;
                Ok(inserted)
            })
            .await
            .map(CategorizationRule::from)
            .map_err(|e| anyhow::anyhow!(e))
    }

    async fn update(
        &self,
        id: &str,
        patch: UpdateCategorizationRule,
    ) -> Result<CategorizationRule> {
        let id = id.to_string();
        self.writer
            .exec_tx(move |tx| {
                let mut existing: CategorizationRuleDB = spending_categorization_rules::table
                    .find(&id)
                    .first::<CategorizationRuleDB>(tx.conn())
                    .map_err(StorageError::from)?;
                if let Some(v) = patch.name {
                    existing.name = v;
                }
                if let Some(v) = patch.pattern {
                    existing.pattern = v;
                }
                if let Some(v) = patch.match_type {
                    existing.match_type = v.as_str().to_string();
                }
                if let Some(v) = patch.taxonomy_id {
                    existing.taxonomy_id = v;
                }
                if let Some(v) = patch.category_id {
                    existing.category_id = v;
                }
                if let Some(v) = patch.activity_type {
                    existing.activity_type = v;
                }
                if let Some(v) = patch.priority {
                    existing.priority = v;
                }
                if let Some(v) = patch.is_global {
                    existing.is_global = if v { 1 } else { 0 };
                }
                if let Some(v) = patch.account_id {
                    existing.account_id = v;
                }
                // If this rule came from a preset, mark it as user-modified so
                // future preset updates can ask before overwriting.
                if existing.preset_id.is_some() {
                    existing.preset_modified = 1;
                }
                existing.updated_at = chrono::Utc::now().to_rfc3339();

                diesel::update(spending_categorization_rules::table.find(&id))
                    .set((
                        spending_categorization_rules::name.eq(&existing.name),
                        spending_categorization_rules::pattern.eq(&existing.pattern),
                        spending_categorization_rules::match_type.eq(&existing.match_type),
                        spending_categorization_rules::taxonomy_id.eq(&existing.taxonomy_id),
                        spending_categorization_rules::category_id.eq(&existing.category_id),
                        spending_categorization_rules::activity_type.eq(&existing.activity_type),
                        spending_categorization_rules::priority.eq(existing.priority),
                        spending_categorization_rules::is_global.eq(existing.is_global),
                        spending_categorization_rules::account_id.eq(&existing.account_id),
                        spending_categorization_rules::preset_modified.eq(existing.preset_modified),
                        spending_categorization_rules::updated_at.eq(&existing.updated_at),
                    ))
                    .execute(tx.conn())
                    .map_err(StorageError::from)?;

                tx.update(&existing)?;
                Ok(existing)
            })
            .await
            .map(CategorizationRule::from)
            .map_err(|e| anyhow::anyhow!(e))
    }

    async fn import_preset_rules(
        &self,
        preset_id: &str,
        preset_version: &str,
        rules: Vec<NewCategorizationRule>,
    ) -> Result<PresetImportCounts> {
        let preset_id = preset_id.to_string();
        let preset_version = preset_version.to_string();
        self.writer
            .exec_tx(move |tx| {
                let existing_rows: Vec<CategorizationRuleDB> = spending_categorization_rules::table
                    .filter(spending_categorization_rules::preset_id.eq(&preset_id))
                    .load::<CategorizationRuleDB>(tx.conn())
                    .map_err(StorageError::from)?;
                let mut existing_by_key: HashMap<String, CategorizationRuleDB> = existing_rows
                    .into_iter()
                    .filter_map(|row| row.preset_rule_key.clone().map(|key| (key, row)))
                    .collect();
                let deleted_rule_keys: HashSet<String> = spending_preset_rule_deletions::table
                    .filter(spending_preset_rule_deletions::preset_id.eq(&preset_id))
                    .select(spending_preset_rule_deletions::preset_rule_key)
                    .load::<String>(tx.conn())
                    .map_err(StorageError::from)?
                    .into_iter()
                    .collect();

                let now = chrono::Utc::now().to_rfc3339();
                let mut counts = PresetImportCounts::default();

                for rule in rules {
                    let Some(rule_key) = rule.preset_rule_key.clone() else {
                        continue;
                    };
                    if deleted_rule_keys.contains(&rule_key) {
                        existing_by_key.remove(&rule_key);
                        counts.skipped_existing += 1;
                        continue;
                    }
                    if let Some(mut existing) = existing_by_key.remove(&rule_key) {
                        if existing.preset_modified != 0
                            || existing.preset_version.as_deref() == Some(preset_version.as_str())
                        {
                            counts.skipped_existing += 1;
                            continue;
                        }

                        existing.name = rule.name;
                        existing.pattern = rule.pattern;
                        existing.match_type = rule.match_type.as_str().to_string();
                        existing.taxonomy_id = rule.taxonomy_id;
                        existing.category_id = rule.category_id;
                        existing.activity_type = rule.activity_type;
                        existing.priority = rule.priority;
                        existing.is_global = if rule.is_global { 1 } else { 0 };
                        existing.account_id = rule.account_id;
                        existing.preset_id = rule.preset_id;
                        existing.preset_rule_key = rule.preset_rule_key;
                        existing.preset_version = rule.preset_version;
                        existing.preset_modified = 0;
                        existing.updated_at = now.clone();

                        diesel::update(spending_categorization_rules::table.find(&existing.id))
                            .set((
                                spending_categorization_rules::name.eq(&existing.name),
                                spending_categorization_rules::pattern.eq(&existing.pattern),
                                spending_categorization_rules::match_type.eq(&existing.match_type),
                                spending_categorization_rules::taxonomy_id
                                    .eq(&existing.taxonomy_id),
                                spending_categorization_rules::category_id
                                    .eq(&existing.category_id),
                                spending_categorization_rules::activity_type
                                    .eq(&existing.activity_type),
                                spending_categorization_rules::priority.eq(existing.priority),
                                spending_categorization_rules::is_global.eq(existing.is_global),
                                spending_categorization_rules::account_id.eq(&existing.account_id),
                                spending_categorization_rules::preset_id.eq(&existing.preset_id),
                                spending_categorization_rules::preset_rule_key
                                    .eq(&existing.preset_rule_key),
                                spending_categorization_rules::preset_version
                                    .eq(&existing.preset_version),
                                spending_categorization_rules::preset_modified.eq(0),
                                spending_categorization_rules::updated_at.eq(&existing.updated_at),
                            ))
                            .execute(tx.conn())
                            .map_err(StorageError::from)?;
                        tx.update(&existing)?;
                        counts.updated += 1;
                        continue;
                    }

                    let row = new_rule_db(rule, &now);
                    let inserted = diesel::insert_into(spending_categorization_rules::table)
                        .values(&row)
                        .returning(CategorizationRuleDB::as_returning())
                        .get_result(tx.conn())
                        .map_err(StorageError::from)?;
                    tx.insert(&inserted)?;
                    counts.added += 1;
                }

                for (_, row) in existing_by_key {
                    if row.preset_modified != 0 {
                        diesel::update(spending_categorization_rules::table.find(&row.id))
                            .set((
                                spending_categorization_rules::preset_id.eq::<Option<String>>(None),
                                spending_categorization_rules::preset_rule_key
                                    .eq::<Option<String>>(None),
                                spending_categorization_rules::preset_version
                                    .eq::<Option<String>>(None),
                                spending_categorization_rules::preset_modified.eq(0),
                                spending_categorization_rules::updated_at.eq(&now),
                            ))
                            .execute(tx.conn())
                            .map_err(StorageError::from)?;
                        let mut detached = row.clone();
                        detached.preset_id = None;
                        detached.preset_rule_key = None;
                        detached.preset_version = None;
                        detached.preset_modified = 0;
                        detached.updated_at = now.clone();
                        tx.update(&detached)?;
                    } else {
                        diesel::delete(spending_categorization_rules::table.find(&row.id))
                            .execute(tx.conn())
                            .map_err(StorageError::from)?;
                        tx.queue_outbox(OutboxWriteRequest::new(
                            SyncEntity::SpendingCategorizationRule,
                            row.id.clone(),
                            SyncOperation::Delete,
                            serde_json::json!({
                                "id": row.id,
                                "presetId": preset_id,
                                "presetRuleKey": row.preset_rule_key,
                                "presetDeleteKind": "preset_upgrade_removed",
                            }),
                        ));
                    }
                }

                Ok(counts)
            })
            .await
            .map_err(|e| anyhow::anyhow!(e))
    }

    async fn delete(&self, id: &str) -> Result<()> {
        let id = id.to_string();
        self.writer
            .exec_tx(move |tx| {
                let existing = spending_categorization_rules::table
                    .find(&id)
                    .first::<CategorizationRuleDB>(tx.conn())
                    .optional()
                    .map_err(StorageError::from)?;
                if let Some(existing) = existing {
                    if let (Some(preset_id), Some(rule_key)) = (
                        existing.preset_id.as_deref(),
                        existing.preset_rule_key.as_deref(),
                    ) {
                        let now = chrono::Utc::now().to_rfc3339();
                        let deletion = upsert_preset_rule_deletion(
                            tx.conn(),
                            preset_id,
                            rule_key,
                            &existing.id,
                            &now,
                        )?;
                        tx.update(&deletion)?;
                    }
                    diesel::delete(spending_categorization_rules::table.find(&id))
                        .execute(tx.conn())
                        .map_err(StorageError::from)?;
                    tx.queue_outbox(OutboxWriteRequest::new(
                        SyncEntity::SpendingCategorizationRule,
                        id.clone(),
                        SyncOperation::Delete,
                        serde_json::json!({
                            "id": id,
                            "presetId": existing.preset_id,
                            "presetRuleKey": existing.preset_rule_key,
                            "presetDeleteKind": "rule",
                        }),
                    ));
                }
                Ok(())
            })
            .await
            .map_err(|e| anyhow::anyhow!(e))
    }

    async fn remove_preset(&self, preset_id: &str) -> Result<(usize, usize)> {
        let preset_id = preset_id.to_string();
        self.writer
            .exec_tx(move |tx| {
                let rows: Vec<CategorizationRuleDB> = spending_categorization_rules::table
                    .filter(spending_categorization_rules::preset_id.eq(&preset_id))
                    .load::<CategorizationRuleDB>(tx.conn())
                    .map_err(StorageError::from)?;

                let mut removed = 0usize;
                let mut kept = 0usize;
                let now = chrono::Utc::now().to_rfc3339();

                let deletion_rows = spending_preset_rule_deletions::table
                    .filter(spending_preset_rule_deletions::preset_id.eq(&preset_id))
                    .load::<PresetRuleDeletionDB>(tx.conn())
                    .map_err(StorageError::from)?;

                diesel::delete(
                    spending_preset_rule_deletions::table
                        .filter(spending_preset_rule_deletions::preset_id.eq(&preset_id)),
                )
                .execute(tx.conn())
                .map_err(StorageError::from)?;
                for deletion in deletion_rows {
                    tx.queue_outbox(OutboxWriteRequest::new(
                        SyncEntity::SpendingPresetRuleDeletion,
                        preset_rule_deletion_id(&deletion.preset_id, &deletion.preset_rule_key),
                        SyncOperation::Delete,
                        serde_json::to_value(&deletion)?,
                    ));
                }

                for row in rows {
                    if row.preset_modified != 0 {
                        // Detach: clear preset metadata, keep the rule as user-owned.
                        diesel::update(spending_categorization_rules::table.find(&row.id))
                            .set((
                                spending_categorization_rules::preset_id.eq::<Option<String>>(None),
                                spending_categorization_rules::preset_rule_key
                                    .eq::<Option<String>>(None),
                                spending_categorization_rules::preset_version
                                    .eq::<Option<String>>(None),
                                spending_categorization_rules::preset_modified.eq(0),
                                spending_categorization_rules::updated_at.eq(&now),
                            ))
                            .execute(tx.conn())
                            .map_err(StorageError::from)?;
                        let mut detached = row.clone();
                        detached.preset_id = None;
                        detached.preset_rule_key = None;
                        detached.preset_version = None;
                        detached.preset_modified = 0;
                        detached.updated_at = now.clone();
                        tx.update(&detached)?;
                        kept += 1;
                    } else {
                        diesel::delete(spending_categorization_rules::table.find(&row.id))
                            .execute(tx.conn())
                            .map_err(StorageError::from)?;
                        tx.queue_outbox(OutboxWriteRequest::new(
                            SyncEntity::SpendingCategorizationRule,
                            row.id.clone(),
                            SyncOperation::Delete,
                            serde_json::json!({
                                "id": row.id,
                                "presetId": row.preset_id,
                                "presetRuleKey": row.preset_rule_key,
                                "presetDeleteKind": "preset_uninstall",
                            }),
                        ));
                        removed += 1;
                    }
                }
                Ok((removed, kept))
            })
            .await
            .map_err(|e| anyhow::anyhow!(e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{create_pool, get_connection, init, run_migrations, write_actor::spawn_writer};
    use crate::schema::{spending_preset_rule_deletions, sync_outbox};
    use tempfile::tempdir;

    fn setup_repo() -> CategorizationRulesRepository {
        let app_data = tempdir()
            .expect("tempdir")
            .keep()
            .to_string_lossy()
            .to_string();
        let db_path = init(&app_data).expect("init db");
        run_migrations(&db_path).expect("migrate db");
        let pool = create_pool(&db_path).expect("create pool");
        let writer = spawn_writer(pool.as_ref().clone()).expect("writer");
        CategorizationRulesRepository::new(pool, writer)
    }

    fn preset_rule() -> NewCategorizationRule {
        NewCategorizationRule {
            id: Some("rule-ca-groceries".to_string()),
            name: "Groceries".to_string(),
            pattern: "grocery".to_string(),
            match_type: RuleMatchType::Contains,
            taxonomy_id: None,
            category_id: None,
            activity_type: None,
            priority: 0,
            is_global: true,
            account_id: None,
            preset_id: Some("ca".to_string()),
            preset_rule_key: Some("groceries".to_string()),
            preset_version: Some("1".to_string()),
        }
    }

    fn outbox_rows(repo: &CategorizationRulesRepository) -> Vec<(String, String, String)> {
        let conn = &mut get_connection(&repo.pool).expect("conn");
        sync_outbox::table
            .select((sync_outbox::entity, sync_outbox::entity_id, sync_outbox::op))
            .order(sync_outbox::created_at.asc())
            .load::<(String, String, String)>(conn)
            .expect("load outbox")
    }

    #[tokio::test]
    async fn preset_rule_deletion_lifecycle_writes_sync_outbox() {
        let repo = setup_repo();
        repo.create(preset_rule()).await.expect("create rule");
        repo.delete("rule-ca-groceries").await.expect("delete rule");

        let rows = outbox_rows(&repo);
        assert!(rows.iter().any(|(entity, _subject_id, op)| {
            entity == "spending_preset_rule_deletion" && op == "update"
        }));
        assert!(rows.iter().any(|(entity, _subject_id, op)| {
            entity == "spending_categorization_rule" && op == "delete"
        }));

        let tombstone_count: i64 = {
            let conn = &mut get_connection(&repo.pool).expect("conn");
            spending_preset_rule_deletions::table
                .count()
                .get_result(conn)
                .expect("count tombstones")
        };
        assert_eq!(tombstone_count, 1);

        repo.remove_preset("ca").await.expect("remove preset");
        let rows = outbox_rows(&repo);
        assert!(rows.iter().any(|(entity, _subject_id, op)| {
            entity == "spending_preset_rule_deletion" && op == "delete"
        }));

        let tombstone_count: i64 = {
            let conn = &mut get_connection(&repo.pool).expect("conn");
            spending_preset_rule_deletions::table
                .count()
                .get_result(conn)
                .expect("count tombstones")
        };
        assert_eq!(tombstone_count, 0);
    }

    #[test]
    fn preset_rule_deletion_outbox_helper_uses_composite_subject_id() {
        let deletion = PresetRuleDeletionDB {
            preset_id: "ca".to_string(),
            preset_rule_key: "groceries".to_string(),
            rule_id: "rule-ca-groceries".to_string(),
            deleted_at: "2026-02-15T00:00:00Z".to_string(),
        };

        let request = crate::sync::outbox_request_for_model(&deletion, SyncOperation::Update)
            .expect("outbox");

        assert_eq!(
            request.entity_id,
            preset_rule_deletion_id("ca", "groceries")
        );
        assert_ne!(request.entity_id, deletion.rule_id);
    }
}
