//! Storage adapter for spending::categorization_rules.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use anyhow::Result;
use async_trait::async_trait;
use chrono::NaiveDateTime;
use diesel::prelude::*;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use std::str::FromStr;
use uuid::Uuid;

use crate::db::{get_connection, DbPool, WriteHandle};
use crate::errors::StorageError;
use crate::schema::{spending_categorization_rules, spending_preset_rule_deletions};
use crate::spending::deterministic_ids::{preset_categorization_rule_id, preset_rule_deletion_id};
use crate::sync::OutboxWriteRequest;
use wealthfolio_core::sync::{SyncEntity, SyncOperation};
use wealthfolio_spending::categorization_rules::{
    CategorizationRule, CategorizationRulesRepositoryTrait, NewCategorizationRule,
    PresetImportCounts, RuleAmountOp, RuleMatchType, UpdateCategorizationRule,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount_op: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount_value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount_value2: Option<String>,
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
    pub amount_op: Option<String>,
    pub amount_value: Option<String>,
    pub amount_value2: Option<String>,
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

fn parse_db_decimal(value: &Option<String>, rule_id: &str, column: &str) -> Option<Decimal> {
    value.as_deref().and_then(|s| match Decimal::from_str(s) {
        Ok(d) => Some(d),
        Err(err) => {
            log::warn!("Categorization rule {rule_id} has invalid {column} '{s}': {err}");
            None
        }
    })
}

fn parse_dt(s: &str) -> NaiveDateTime {
    chrono::DateTime::parse_from_rfc3339(s)
        .map(|dt| dt.naive_utc())
        .unwrap_or_else(|_| chrono::Utc::now().naive_utc())
}

impl From<CategorizationRuleDB> for CategorizationRule {
    fn from(db: CategorizationRuleDB) -> Self {
        let amount_op = db.amount_op.as_deref().and_then(|s| {
            let op = RuleAmountOp::try_parse(s);
            if op.is_none() {
                log::warn!("Categorization rule {} has unknown amount_op '{s}'", db.id);
            }
            op
        });
        Self {
            amount_op,
            amount_value: parse_db_decimal(&db.amount_value, &db.id, "amount_value"),
            amount_value2: parse_db_decimal(&db.amount_value2, &db.id, "amount_value2"),
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
        amount_op,
        amount_value,
        amount_value2,
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
        amount_op: amount_op.map(|op| op.as_str().to_string()),
        amount_value: amount_value.map(|d| d.to_string()),
        amount_value2: amount_value2.map(|d| d.to_string()),
    }
}

fn outbox_request_with_explicit_amount_fields(
    rule: &CategorizationRuleDB,
    op: SyncOperation,
) -> wealthfolio_core::errors::Result<OutboxWriteRequest> {
    let mut request = crate::sync::outbox_request_for_model(rule, op)?;
    if let Some(payload) = request.payload.as_object_mut() {
        payload.insert(
            "amountOp".to_string(),
            serde_json::to_value(&rule.amount_op)?,
        );
        payload.insert(
            "amountValue".to_string(),
            serde_json::to_value(&rule.amount_value)?,
        );
        payload.insert(
            "amountValue2".to_string(),
            serde_json::to_value(&rule.amount_value2)?,
        );
    }
    Ok(request)
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
        let amount_fields_changed = patch.amount_op.is_some()
            || patch.amount_value.is_some()
            || patch.amount_value2.is_some();
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
                if let Some(v) = patch.amount_op {
                    existing.amount_op = v.map(|op| op.as_str().to_string());
                }
                if let Some(v) = patch.amount_value {
                    existing.amount_value = v.map(|d| d.to_string());
                }
                if let Some(v) = patch.amount_value2 {
                    existing.amount_value2 = v.map(|d| d.to_string());
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
                        spending_categorization_rules::amount_op.eq(&existing.amount_op),
                        spending_categorization_rules::amount_value.eq(&existing.amount_value),
                        spending_categorization_rules::amount_value2.eq(&existing.amount_value2),
                        spending_categorization_rules::priority.eq(existing.priority),
                        spending_categorization_rules::is_global.eq(existing.is_global),
                        spending_categorization_rules::account_id.eq(&existing.account_id),
                        spending_categorization_rules::preset_modified.eq(existing.preset_modified),
                        spending_categorization_rules::updated_at.eq(&existing.updated_at),
                    ))
                    .execute(tx.conn())
                    .map_err(StorageError::from)?;

                if amount_fields_changed {
                    tx.queue_outbox(outbox_request_with_explicit_amount_fields(
                        &existing,
                        SyncOperation::Update,
                    )?);
                } else {
                    tx.update(&existing)?;
                }
                Ok(existing)
            })
            .await
            .map(CategorizationRule::from)
            .map_err(|e| anyhow::anyhow!(e))
    }

    async fn upsert(&self, new_rule: NewCategorizationRule) -> Result<CategorizationRule> {
        let id = new_rule
            .id
            .clone()
            .ok_or_else(|| anyhow::anyhow!("upsert requires an explicit rule id"))?;
        let now = chrono::Utc::now().to_rfc3339();
        self.writer
            .exec_tx(move |tx| {
                let existing: Option<CategorizationRuleDB> = spending_categorization_rules::table
                    .find(&id)
                    .first::<CategorizationRuleDB>(tx.conn())
                    .optional()
                    .map_err(StorageError::from)?;

                match existing {
                    None => {
                        let row = new_rule_db(new_rule, &now);
                        let inserted = diesel::insert_into(spending_categorization_rules::table)
                            .values(&row)
                            .returning(CategorizationRuleDB::as_returning())
                            .get_result(tx.conn())
                            .map_err(StorageError::from)?;
                        tx.insert(&inserted)?;
                        Ok(inserted)
                    }
                    Some(mut existing) => {
                        let previous_amount_fields = (
                            existing.amount_op.clone(),
                            existing.amount_value.clone(),
                            existing.amount_value2.clone(),
                        );

                        existing.name = new_rule.name;
                        existing.pattern = new_rule.pattern;
                        existing.match_type = new_rule.match_type.as_str().to_string();
                        existing.taxonomy_id = new_rule.taxonomy_id;
                        existing.category_id = new_rule.category_id;
                        existing.activity_type = new_rule.activity_type;
                        existing.amount_op = new_rule.amount_op.map(|op| op.as_str().to_string());
                        existing.amount_value = new_rule.amount_value.map(|d| d.to_string());
                        existing.amount_value2 = new_rule.amount_value2.map(|d| d.to_string());
                        existing.priority = new_rule.priority;
                        existing.is_global = if new_rule.is_global { 1 } else { 0 };
                        existing.account_id = new_rule.account_id;
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
                                spending_categorization_rules::amount_op.eq(&existing.amount_op),
                                spending_categorization_rules::amount_value
                                    .eq(&existing.amount_value),
                                spending_categorization_rules::amount_value2
                                    .eq(&existing.amount_value2),
                                spending_categorization_rules::priority.eq(existing.priority),
                                spending_categorization_rules::is_global.eq(existing.is_global),
                                spending_categorization_rules::account_id.eq(&existing.account_id),
                                spending_categorization_rules::updated_at.eq(&existing.updated_at),
                            ))
                            .execute(tx.conn())
                            .map_err(StorageError::from)?;

                        let amount_fields_changed = previous_amount_fields
                            != (
                                existing.amount_op.clone(),
                                existing.amount_value.clone(),
                                existing.amount_value2.clone(),
                            );
                        if amount_fields_changed {
                            tx.queue_outbox(outbox_request_with_explicit_amount_fields(
                                &existing,
                                SyncOperation::Update,
                            )?);
                        } else {
                            tx.update(&existing)?;
                        }
                        Ok(existing)
                    }
                }
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

                        let previous_amount_fields = (
                            existing.amount_op.clone(),
                            existing.amount_value.clone(),
                            existing.amount_value2.clone(),
                        );

                        existing.name = rule.name;
                        existing.pattern = rule.pattern;
                        existing.match_type = rule.match_type.as_str().to_string();
                        existing.taxonomy_id = rule.taxonomy_id;
                        existing.category_id = rule.category_id;
                        existing.activity_type = rule.activity_type;
                        existing.amount_op = rule.amount_op.map(|op| op.as_str().to_string());
                        existing.amount_value = rule.amount_value.map(|d| d.to_string());
                        existing.amount_value2 = rule.amount_value2.map(|d| d.to_string());
                        existing.priority = rule.priority;
                        existing.is_global = if rule.is_global { 1 } else { 0 };
                        existing.account_id = rule.account_id;
                        existing.preset_id = rule.preset_id;
                        existing.preset_rule_key = rule.preset_rule_key;
                        existing.preset_version = rule.preset_version;
                        existing.preset_modified = 0;
                        existing.updated_at = now.clone();
                        let amount_fields_changed = previous_amount_fields
                            != (
                                existing.amount_op.clone(),
                                existing.amount_value.clone(),
                                existing.amount_value2.clone(),
                            );

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
                                spending_categorization_rules::amount_op.eq(&existing.amount_op),
                                spending_categorization_rules::amount_value
                                    .eq(&existing.amount_value),
                                spending_categorization_rules::amount_value2
                                    .eq(&existing.amount_value2),
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
                        if amount_fields_changed {
                            tx.queue_outbox(outbox_request_with_explicit_amount_fields(
                                &existing,
                                SyncOperation::Update,
                            )?);
                        } else {
                            tx.update(&existing)?;
                        }
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

    fn setup_repo() -> (CategorizationRulesRepository, tempfile::TempDir) {
        let dir = tempdir().expect("tempdir");
        let app_data = dir.path().to_string_lossy().to_string();
        let db_path = init(&app_data).expect("init db");
        run_migrations(&db_path).expect("migrate db");
        let pool = create_pool(&db_path).expect("create pool");
        let writer = spawn_writer(pool.as_ref().clone()).expect("writer");
        (CategorizationRulesRepository::new(pool, writer), dir)
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
            amount_op: None,
            amount_value: None,
            amount_value2: None,
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

    fn rule_outbox_payloads(
        repo: &CategorizationRulesRepository,
        rule_id: &str,
    ) -> Vec<serde_json::Value> {
        let conn = &mut get_connection(&repo.pool).expect("conn");
        sync_outbox::table
            .filter(sync_outbox::entity.eq("spending_categorization_rule"))
            .filter(sync_outbox::entity_id.eq(rule_id))
            .select(sync_outbox::payload)
            .load::<String>(conn)
            .expect("load rule outbox payloads")
            .into_iter()
            .map(|payload| serde_json::from_str(&payload).expect("parse rule outbox payload"))
            .collect()
    }

    #[tokio::test]
    async fn preset_rule_deletion_lifecycle_writes_sync_outbox() {
        let (repo, _dir) = setup_repo();
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

    #[tokio::test]
    async fn amount_condition_round_trips_and_updates() {
        use wealthfolio_spending::categorization_rules::RuleAmountOp;

        let (repo, _dir) = setup_repo();
        let mut new_rule = preset_rule();
        new_rule.id = Some("rule-amount".to_string());
        new_rule.preset_id = None;
        new_rule.preset_rule_key = None;
        new_rule.preset_version = None;
        new_rule.amount_op = Some(RuleAmountOp::Between);
        new_rule.amount_value = Some("45.50".parse().unwrap());
        new_rule.amount_value2 = Some("55".parse().unwrap());

        let created = repo.create(new_rule).await.expect("create rule");
        assert_eq!(created.amount_op, Some(RuleAmountOp::Between));
        assert_eq!(created.amount_value, Some("45.50".parse().unwrap()));
        assert_eq!(created.amount_value2, Some("55".parse().unwrap()));

        let fetched = repo.get("rule-amount").await.expect("get").expect("some");
        assert_eq!(fetched.amount_op, Some(RuleAmountOp::Between));
        assert_eq!(fetched.amount_value, Some("45.50".parse().unwrap()));
        assert_eq!(fetched.amount_value2, Some("55".parse().unwrap()));

        // Patch to a single-value operator: upper value cleared explicitly.
        let updated = repo
            .update(
                "rule-amount",
                UpdateCategorizationRule {
                    amount_op: Some(Some(RuleAmountOp::Gte)),
                    amount_value: Some(Some("100".parse().unwrap())),
                    amount_value2: Some(None),
                    ..Default::default()
                },
            )
            .await
            .expect("update rule");
        assert_eq!(updated.amount_op, Some(RuleAmountOp::Gte));
        assert_eq!(updated.amount_value, Some("100".parse().unwrap()));
        assert_eq!(updated.amount_value2, None);

        // Patch that omits the amount fields leaves the condition untouched.
        let untouched = repo
            .update(
                "rule-amount",
                UpdateCategorizationRule {
                    name: Some("renamed".to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("update rule");
        assert_eq!(untouched.name, "renamed");
        assert_eq!(untouched.amount_op, Some(RuleAmountOp::Gte));
        assert_eq!(untouched.amount_value, Some("100".parse().unwrap()));

        // Clearing the whole condition round-trips to NULLs.
        let cleared = repo
            .update(
                "rule-amount",
                UpdateCategorizationRule {
                    amount_op: Some(None),
                    amount_value: Some(None),
                    amount_value2: Some(None),
                    ..Default::default()
                },
            )
            .await
            .expect("update rule");
        assert_eq!(cleared.amount_op, None);
        assert_eq!(cleared.amount_value, None);
        assert_eq!(cleared.amount_value2, None);

        let payloads = rule_outbox_payloads(&repo, "rule-amount");
        assert!(payloads.iter().any(|payload| {
            payload.get("amount_op") == Some(&serde_json::Value::Null)
                && payload.get("amount_value") == Some(&serde_json::Value::Null)
                && payload.get("amount_value2") == Some(&serde_json::Value::Null)
        }));
        assert!(payloads.iter().any(|payload| {
            payload.get("amount_op").and_then(serde_json::Value::as_str) == Some("gte")
                && payload.get("amount_value2") == Some(&serde_json::Value::Null)
        }));
    }

    #[tokio::test]
    async fn rule_without_amount_condition_omits_amount_fields_from_outbox() {
        let (repo, _dir) = setup_repo();
        let created = repo.create(preset_rule()).await.expect("create rule");
        assert_eq!(created.amount_op, None);
        assert_eq!(created.amount_value, None);
        assert_eq!(created.amount_value2, None);

        repo.update(
            "rule-ca-groceries",
            UpdateCategorizationRule {
                name: Some("Renamed groceries".to_string()),
                ..Default::default()
            },
        )
        .await
        .expect("update rule");

        let payloads = rule_outbox_payloads(&repo, "rule-ca-groceries");
        assert_eq!(payloads.len(), 2);
        for payload in payloads {
            assert!(payload.get("amount_op").is_none());
            assert!(payload.get("amount_value").is_none());
            assert!(payload.get("amount_value2").is_none());
        }
    }

    #[tokio::test]
    async fn upsert_creates_then_updates_the_same_row_without_duplicating() {
        let (repo, _dir) = setup_repo();
        let rule_id = "addon:test-addon:abc123".to_string();
        let new_rule = |name: &str| NewCategorizationRule {
            id: Some(rule_id.clone()),
            name: name.to_string(),
            pattern: "SUPERMARKET".to_string(),
            match_type: RuleMatchType::Contains,
            taxonomy_id: None,
            category_id: None,
            activity_type: Some("WITHDRAWAL".to_string()),
            amount_op: None,
            amount_value: None,
            amount_value2: None,
            priority: 0,
            is_global: true,
            account_id: None,
            preset_id: None,
            preset_rule_key: None,
            preset_version: None,
        };

        let created = repo
            .upsert(new_rule("Groceries"))
            .await
            .expect("first upsert creates");
        assert_eq!(created.id, rule_id);
        assert_eq!(created.name, "Groceries");

        // A second upsert with the same id must update the existing row in
        // place, not collide on the primary key (the bug this replaces) or
        // create a duplicate row.
        let updated = repo
            .upsert(new_rule("Groceries (renamed)"))
            .await
            .expect("second upsert updates in place");
        assert_eq!(updated.id, rule_id);
        assert_eq!(updated.name, "Groceries (renamed)");

        let all = repo.list().await.expect("list rules");
        assert_eq!(all.iter().filter(|r| r.id == rule_id).count(), 1);
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
