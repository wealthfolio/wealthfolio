//! Storage adapter for spending::budget.

use std::sync::Arc;

use anyhow::Result;
use async_trait::async_trait;
use chrono::NaiveDateTime;
use diesel::prelude::*;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::db::{get_connection, write_actor::DbWriteTx, DbPool, WriteHandle};
use crate::errors::StorageError;
use crate::schema::{
    budget_group_assignments, budget_groups, budget_rollover_settings, budget_targets,
};
use crate::spending::deterministic_ids::{
    budget_group_assignment_id, budget_rollover_setting_id, budget_target_id,
};
use wealthfolio_core::sync::{SyncEntity, SyncOperation};
use wealthfolio_spending::budget::{
    BudgetGroup, BudgetGroupAssignment, BudgetRepositoryTrait, BudgetRolloverSetting,
    BudgetRolloverTargetType, BudgetTarget, BudgetTargetType, NewBudgetGroup,
    NewBudgetGroupAssignment, NewBudgetRolloverSetting, NewBudgetTarget, UpdateBudgetGroup,
};

#[derive(Queryable, Identifiable, Selectable, Serialize, Deserialize, Debug, Clone)]
#[diesel(table_name = crate::schema::budget_groups)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct BudgetGroupDB {
    pub id: String,
    pub name: String,
    pub key: String,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub sort_order: i32,
    pub is_system: i32,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Insertable, Serialize, Deserialize, Debug, Clone)]
#[diesel(table_name = crate::schema::budget_groups)]
pub struct NewBudgetGroupDB {
    pub id: String,
    pub name: String,
    pub key: String,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub sort_order: i32,
    pub is_system: i32,
    pub created_at: String,
    pub updated_at: String,
}

impl crate::sync::SyncOutboxModel for BudgetGroupDB {
    const ENTITY: SyncEntity = SyncEntity::BudgetGroup;
    fn sync_entity_id(&self) -> &str {
        &self.id
    }

    fn should_sync_outbox(&self, _op: SyncOperation) -> bool {
        self.is_system == 0 || self.updated_at != self.created_at
    }
}

#[derive(Queryable, Identifiable, Selectable, Serialize, Deserialize, Debug, Clone)]
#[diesel(table_name = crate::schema::budget_group_assignments)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct BudgetGroupAssignmentDB {
    pub id: String,
    pub group_id: String,
    pub taxonomy_id: String,
    pub category_id: String,
    pub is_system: i32,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Insertable, Serialize, Deserialize, Debug, Clone)]
#[diesel(table_name = crate::schema::budget_group_assignments)]
pub struct NewBudgetGroupAssignmentDB {
    pub id: String,
    pub group_id: String,
    pub taxonomy_id: String,
    pub category_id: String,
    pub is_system: i32,
    pub created_at: String,
    pub updated_at: String,
}

impl crate::sync::SyncOutboxModel for BudgetGroupAssignmentDB {
    const ENTITY: SyncEntity = SyncEntity::BudgetGroupAssignment;
    fn sync_entity_id(&self) -> &str {
        &self.id
    }

    fn should_sync_outbox(&self, _op: SyncOperation) -> bool {
        self.is_system == 0 || self.updated_at != self.created_at
    }
}

#[derive(Queryable, Identifiable, Selectable, Serialize, Deserialize, Debug, Clone)]
#[diesel(table_name = crate::schema::budget_targets)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct BudgetTargetDB {
    pub id: String,
    pub period_key: String,
    pub target_type: String,
    pub taxonomy_id: Option<String>,
    pub category_id: Option<String>,
    pub group_id: Option<String>,
    pub amount: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Insertable, Serialize, Deserialize, Debug, Clone)]
#[diesel(table_name = crate::schema::budget_targets)]
pub struct NewBudgetTargetDB {
    pub id: String,
    pub period_key: String,
    pub target_type: String,
    pub taxonomy_id: Option<String>,
    pub category_id: Option<String>,
    pub group_id: Option<String>,
    pub amount: String,
    pub created_at: String,
    pub updated_at: String,
}

impl crate::sync::SyncOutboxModel for BudgetTargetDB {
    const ENTITY: SyncEntity = SyncEntity::BudgetTarget;
    fn sync_entity_id(&self) -> &str {
        &self.id
    }
}

#[derive(Queryable, Identifiable, Selectable, Serialize, Deserialize, Debug, Clone)]
#[diesel(table_name = crate::schema::budget_rollover_settings)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct BudgetRolloverSettingDB {
    pub id: String,
    pub target_type: String,
    pub taxonomy_id: Option<String>,
    pub category_id: Option<String>,
    pub group_id: Option<String>,
    pub enabled: i32,
    pub start_month: String,
    pub starting_balance: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Insertable, Serialize, Deserialize, Debug, Clone)]
#[diesel(table_name = crate::schema::budget_rollover_settings)]
pub struct NewBudgetRolloverSettingDB {
    pub id: String,
    pub target_type: String,
    pub taxonomy_id: Option<String>,
    pub category_id: Option<String>,
    pub group_id: Option<String>,
    pub enabled: i32,
    pub start_month: String,
    pub starting_balance: String,
    pub created_at: String,
    pub updated_at: String,
}

impl crate::sync::SyncOutboxModel for BudgetRolloverSettingDB {
    const ENTITY: SyncEntity = SyncEntity::BudgetRolloverSetting;
    fn sync_entity_id(&self) -> &str {
        &self.id
    }
}

pub struct BudgetRepository {
    pool: Arc<DbPool>,
    writer: WriteHandle,
}

impl BudgetRepository {
    pub fn new(pool: Arc<DbPool>, writer: WriteHandle) -> Self {
        Self { pool, writer }
    }

    async fn upsert_group_assignments_with_system_flag(
        &self,
        assignments: Vec<NewBudgetGroupAssignment>,
        is_system: i32,
    ) -> Result<Vec<BudgetGroupAssignment>> {
        self.writer
            .exec_tx(move |tx| {
                upsert_group_assignments_with_system_flag_tx(tx, assignments, is_system)
            })
            .await
            .map_err(|e| anyhow::anyhow!(e))
    }
}

fn parse_dt(s: &str) -> NaiveDateTime {
    chrono::DateTime::parse_from_rfc3339(s)
        .map(|dt| dt.naive_utc())
        .unwrap_or_else(|_| chrono::Utc::now().naive_utc())
}

fn target_type_from_str(value: &str) -> BudgetTargetType {
    match value {
        "group_buffer" => BudgetTargetType::GroupBuffer,
        _ => BudgetTargetType::Category,
    }
}

fn rollover_target_type_from_str(value: &str) -> BudgetRolloverTargetType {
    match value {
        "group" => BudgetRolloverTargetType::Group,
        _ => BudgetRolloverTargetType::Category,
    }
}

fn sum_amount_strings(left: &str, right: &str) -> String {
    let left = left.parse::<Decimal>().unwrap_or(Decimal::ZERO);
    let right = right.parse::<Decimal>().unwrap_or(Decimal::ZERO);
    (left + right).normalize().to_string()
}

impl From<BudgetGroupDB> for BudgetGroup {
    fn from(db: BudgetGroupDB) -> Self {
        Self {
            id: db.id,
            name: db.name,
            key: db.key,
            color: db.color,
            icon: db.icon,
            sort_order: db.sort_order,
            is_system: db.is_system != 0,
            created_at: parse_dt(&db.created_at),
            updated_at: parse_dt(&db.updated_at),
        }
    }
}

impl From<BudgetGroupAssignmentDB> for BudgetGroupAssignment {
    fn from(db: BudgetGroupAssignmentDB) -> Self {
        Self {
            id: db.id,
            group_id: db.group_id,
            taxonomy_id: db.taxonomy_id,
            category_id: db.category_id,
            created_at: parse_dt(&db.created_at),
            updated_at: parse_dt(&db.updated_at),
        }
    }
}

impl From<BudgetTargetDB> for BudgetTarget {
    fn from(db: BudgetTargetDB) -> Self {
        Self {
            id: db.id,
            period_key: db.period_key,
            target_type: target_type_from_str(&db.target_type),
            taxonomy_id: db.taxonomy_id,
            category_id: db.category_id,
            group_id: db.group_id,
            amount: db.amount,
            created_at: parse_dt(&db.created_at),
            updated_at: parse_dt(&db.updated_at),
        }
    }
}

impl From<BudgetRolloverSettingDB> for BudgetRolloverSetting {
    fn from(db: BudgetRolloverSettingDB) -> Self {
        Self {
            id: db.id,
            target_type: rollover_target_type_from_str(&db.target_type),
            taxonomy_id: db.taxonomy_id,
            category_id: db.category_id,
            group_id: db.group_id,
            enabled: db.enabled != 0,
            start_month: db.start_month,
            starting_balance: db.starting_balance,
            created_at: parse_dt(&db.created_at),
            updated_at: parse_dt(&db.updated_at),
        }
    }
}

#[async_trait]
impl BudgetRepositoryTrait for BudgetRepository {
    async fn apply_reviewed(
        &self,
        expected: wealthfolio_spending::budget::BudgetSnapshotState,
        operation: wealthfolio_spending::budget::BudgetOperation,
    ) -> Result<()> {
        self.writer
            .exec_tx(move |tx| {
                use wealthfolio_spending::budget::{
                    service::{
                        canonical_review_state, default_assignment_inputs, default_group_inputs,
                    },
                    BudgetOperation::*,
                };
                let current = budget_state_tx(tx)?;
                if serde_json::to_value(canonical_review_state(current.clone()))?
                    != serde_json::to_value(canonical_review_state(expected))?
                {
                    return Err(wealthfolio_core::errors::ValidationError::InvalidInput(
                        "Budget configuration changed since review; refresh and review again"
                            .into(),
                    )
                    .into());
                }
                // Pure reads may have synthesized missing groups. Materialize only
                // absent defaults during this explicit budget write, never on preview.
                let missing = default_group_inputs()
                    .into_iter()
                    .filter(|g| {
                        !current.groups.iter().any(|existing| {
                            Some(existing.id.as_str()) == g.id.as_deref()
                                || Some(existing.key.as_str()) == g.key.as_deref()
                        })
                    })
                    .collect();
                upsert_system_groups_tx(tx, missing)?;
                match operation {
                    SetTarget { target } => {
                        upsert_target_tx(tx, target)?;
                    }
                    RemoveTarget { id } => delete_target_tx(tx, &id)?,
                    CopyTargets {
                        source_period_key,
                        target_period_key,
                        overwrite,
                    } => {
                        copy_period_targets_tx(
                            tx,
                            &source_period_key,
                            &target_period_key,
                            overwrite,
                        )?;
                    }
                    CreateGroup { group } => {
                        create_group_tx(tx, group)?;
                    }
                    UpdateGroup { id, changes } => {
                        update_group_tx(tx, &id, changes)?;
                    }
                    DeleteGroup {
                        id,
                        reassign_to_group_id,
                    } => {
                        let reassignments = current
                            .group_assignments
                            .into_iter()
                            .filter(|a| a.group_id == id)
                            .map(|a| NewBudgetGroupAssignment {
                                id: Some(a.id),
                                group_id: reassign_to_group_id.clone(),
                                taxonomy_id: a.taxonomy_id,
                                category_id: a.category_id,
                            })
                            .collect();
                        delete_group_and_reassign_tx(
                            tx,
                            &id,
                            &reassign_to_group_id,
                            reassignments,
                        )?;
                    }
                    AssignCategory {
                        category_id,
                        group_id,
                    } => {
                        upsert_group_assignments_with_system_flag_tx(
                            tx,
                            vec![NewBudgetGroupAssignment {
                                id: None,
                                group_id,
                                taxonomy_id: "spending_categories".into(),
                                category_id,
                            }],
                            0,
                        )?;
                    }
                    SetRollover { setting } => {
                        if setting.enabled
                            && matches!(setting.target_type, BudgetRolloverTargetType::Group)
                        {
                            let group = setting.group_id.as_deref().unwrap_or("");
                            let other = wealthfolio_spending::budget::service::effective_groups(
                                current.groups,
                            )
                            .into_iter()
                            .find(|g| g.key == "other")
                            .map(|g| g.id)
                            .unwrap_or_default();
                            let roots = crate::schema::taxonomy_categories::table
                                .filter(
                                    crate::schema::taxonomy_categories::taxonomy_id
                                        .eq("spending_categories"),
                                )
                                .filter(crate::schema::taxonomy_categories::parent_id.is_null())
                                .select(crate::schema::taxonomy_categories::id)
                                .load::<String>(tx.conn())
                                .map_err(StorageError::from)?;
                            let categories = roots
                                .into_iter()
                                .filter(|category| {
                                    current
                                        .group_assignments
                                        .iter()
                                        .find(|a| {
                                            a.taxonomy_id == "spending_categories"
                                                && a.category_id == *category
                                        })
                                        .map(|a| a.group_id.as_str())
                                        .unwrap_or(&other)
                                        == group
                                })
                                .collect::<Vec<_>>();
                            disable_category_rollovers_tx(tx, "spending_categories", &categories)?;
                        }
                        upsert_rollover_setting_tx(tx, setting)?;
                    }
                    RemoveRollover { id } => delete_rollover_setting_tx(tx, &id)?,
                    ResetGroups => {
                        let groups = upsert_system_groups_tx(tx, default_group_inputs())?;
                        let map = groups.into_iter().map(|g| (g.key, g.id)).collect();
                        upsert_group_assignments_with_system_flag_tx(
                            tx,
                            default_assignment_inputs(&map),
                            1,
                        )?;
                    }
                }
                Ok(())
            })
            .await
            .map_err(|e| anyhow::anyhow!(e))
    }

    async fn list_groups(&self) -> Result<Vec<BudgetGroup>> {
        let mut conn = get_connection(&self.pool).map_err(|e| anyhow::anyhow!(e))?;
        let rows = budget_groups::table
            .order((budget_groups::sort_order.asc(), budget_groups::name.asc()))
            .load::<BudgetGroupDB>(&mut conn)
            .map_err(StorageError::from)
            .map_err(|e| anyhow::anyhow!(e))?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    async fn create_group(&self, new_group: NewBudgetGroup) -> Result<BudgetGroup> {
        self.writer
            .exec_tx(move |tx| create_group_tx(tx, new_group))
            .await
            .map_err(|e| anyhow::anyhow!(e))
    }

    async fn update_group(&self, id: &str, patch: UpdateBudgetGroup) -> Result<BudgetGroup> {
        let id = id.to_string();
        self.writer
            .exec_tx(move |tx| update_group_tx(tx, &id, patch))
            .await
            .map_err(|e| anyhow::anyhow!(e))
    }

    async fn delete_group(&self, id: &str) -> Result<()> {
        let id = id.to_string();
        self.writer
            .exec_tx(move |tx| {
                let affected = diesel::delete(budget_groups::table.find(&id))
                    .execute(tx.conn())
                    .map_err(StorageError::from)?;
                if affected > 0 {
                    tx.delete::<BudgetGroupDB>(id.clone());
                }
                Ok(())
            })
            .await
            .map_err(|e| anyhow::anyhow!(e))
    }

    async fn delete_group_and_reassign(
        &self,
        id: &str,
        reassign_to_group_id: &str,
        reassignments: Vec<NewBudgetGroupAssignment>,
    ) -> Result<()> {
        let id = id.to_string();
        let reassign_to_group_id = reassign_to_group_id.to_string();
        self.writer
            .exec_tx(move |tx| {
                delete_group_and_reassign_tx(tx, &id, &reassign_to_group_id, reassignments)
            })
            .await
            .map_err(|e| anyhow::anyhow!(e))
    }

    async fn upsert_system_groups(&self, groups: Vec<NewBudgetGroup>) -> Result<Vec<BudgetGroup>> {
        self.writer
            .exec_tx(move |tx| upsert_system_groups_tx(tx, groups))
            .await
            .map_err(|e| anyhow::anyhow!(e))
    }

    async fn list_group_assignments(&self) -> Result<Vec<BudgetGroupAssignment>> {
        let mut conn = get_connection(&self.pool).map_err(|e| anyhow::anyhow!(e))?;
        let rows = budget_group_assignments::table
            .load::<BudgetGroupAssignmentDB>(&mut conn)
            .map_err(StorageError::from)
            .map_err(|e| anyhow::anyhow!(e))?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    async fn upsert_group_assignment(
        &self,
        assignment: NewBudgetGroupAssignment,
    ) -> Result<BudgetGroupAssignment> {
        let rows = self.upsert_group_assignments(vec![assignment]).await?;
        rows.into_iter()
            .next()
            .ok_or_else(|| anyhow::anyhow!("Failed to save budget group assignment"))
    }

    async fn upsert_group_assignments(
        &self,
        assignments: Vec<NewBudgetGroupAssignment>,
    ) -> Result<Vec<BudgetGroupAssignment>> {
        self.upsert_group_assignments_with_system_flag(assignments, 0)
            .await
    }

    async fn upsert_system_group_assignments(
        &self,
        assignments: Vec<NewBudgetGroupAssignment>,
    ) -> Result<Vec<BudgetGroupAssignment>> {
        self.upsert_group_assignments_with_system_flag(assignments, 1)
            .await
    }

    async fn list_targets(&self) -> Result<Vec<BudgetTarget>> {
        let mut conn = get_connection(&self.pool).map_err(|e| anyhow::anyhow!(e))?;
        let rows = budget_targets::table
            .load::<BudgetTargetDB>(&mut conn)
            .map_err(StorageError::from)
            .map_err(|e| anyhow::anyhow!(e))?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    async fn upsert_target(&self, target: NewBudgetTarget) -> Result<BudgetTarget> {
        self.writer
            .exec_tx(move |tx| upsert_target_tx(tx, target))
            .await
            .map_err(|e| anyhow::anyhow!(e))
    }

    async fn delete_target(&self, id: &str) -> Result<()> {
        let id = id.to_string();
        self.writer
            .exec_tx(move |tx| delete_target_tx(tx, &id))
            .await
            .map_err(|e| anyhow::anyhow!(e))
    }

    async fn list_rollover_settings(&self) -> Result<Vec<BudgetRolloverSetting>> {
        let mut conn = get_connection(&self.pool).map_err(|e| anyhow::anyhow!(e))?;
        let rows = budget_rollover_settings::table
            .load::<BudgetRolloverSettingDB>(&mut conn)
            .map_err(StorageError::from)
            .map_err(|e| anyhow::anyhow!(e))?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    async fn upsert_rollover_setting(
        &self,
        setting: NewBudgetRolloverSetting,
    ) -> Result<BudgetRolloverSetting> {
        self.writer
            .exec_tx(move |tx| upsert_rollover_setting_tx(tx, setting))
            .await
            .map_err(|e| anyhow::anyhow!(e))
    }

    async fn delete_rollover_setting(&self, id: &str) -> Result<()> {
        let id = id.to_string();
        self.writer
            .exec_tx(move |tx| delete_rollover_setting_tx(tx, &id))
            .await
            .map_err(|e| anyhow::anyhow!(e))
    }

    async fn disable_category_rollovers(
        &self,
        taxonomy_id: &str,
        category_ids: &[String],
    ) -> Result<Vec<BudgetRolloverSetting>> {
        let taxonomy_id = taxonomy_id.to_string();
        let category_ids = category_ids.to_vec();
        self.writer
            .exec_tx(move |tx| disable_category_rollovers_tx(tx, &taxonomy_id, &category_ids))
            .await
            .map_err(|e| anyhow::anyhow!(e))
    }

    async fn copy_period_targets(
        &self,
        source_period_key: &str,
        target_period_key: &str,
        overwrite: bool,
    ) -> Result<Vec<BudgetTarget>> {
        let source_period_key = source_period_key.to_string();
        let target_period_key = target_period_key.to_string();
        self.writer
            .exec_tx(move |tx| {
                copy_period_targets_tx(tx, &source_period_key, &target_period_key, overwrite)
            })
            .await
            .map_err(|e| anyhow::anyhow!(e))
    }
}

// Shared transaction operations; native calls and reviewed agent commits use
// identical mutations and outbox projection.
fn upsert_group_assignments_with_system_flag_tx(
    tx: &mut DbWriteTx<'_>,
    assignments: Vec<NewBudgetGroupAssignment>,
    is_system: i32,
) -> wealthfolio_core::Result<Vec<BudgetGroupAssignment>> {
    let now = chrono::Utc::now().to_rfc3339();
    {
        let mut out = Vec::with_capacity(assignments.len());
        for assignment in assignments {
            if is_system == 1 {
                let exists = diesel::select(diesel::dsl::exists(
                    crate::schema::taxonomy_categories::table
                        .filter(
                            crate::schema::taxonomy_categories::taxonomy_id
                                .eq(&assignment.taxonomy_id),
                        )
                        .filter(crate::schema::taxonomy_categories::id.eq(&assignment.category_id)),
                ))
                .get_result::<bool>(tx.conn())
                .map_err(StorageError::from)?;
                if !exists {
                    continue;
                }
            }
            let NewBudgetGroupAssignment {
                id,
                group_id,
                taxonomy_id,
                category_id,
            } = assignment;
            let id = id.unwrap_or_else(|| budget_group_assignment_id(&taxonomy_id, &category_id));
            let existing = budget_group_assignments::table
                .filter(budget_group_assignments::taxonomy_id.eq(&taxonomy_id))
                .filter(budget_group_assignments::category_id.eq(&category_id))
                .first::<BudgetGroupAssignmentDB>(tx.conn())
                .optional()
                .map_err(StorageError::from)?;
            if let Some(existing) = existing {
                if existing.group_id == group_id && existing.is_system == is_system {
                    out.push(existing);
                    continue;
                }
                diesel::update(budget_group_assignments::table.find(&existing.id))
                    .set((
                        budget_group_assignments::group_id.eq(&group_id),
                        budget_group_assignments::is_system.eq(is_system),
                        budget_group_assignments::updated_at.eq(&now),
                    ))
                    .execute(tx.conn())
                    .map_err(StorageError::from)?;
                let updated = budget_group_assignments::table
                    .find(&existing.id)
                    .first::<BudgetGroupAssignmentDB>(tx.conn())
                    .map_err(StorageError::from)?;
                tx.update(&updated)?;
                out.push(updated);
                continue;
            }

            let row = NewBudgetGroupAssignmentDB {
                id,
                group_id,
                taxonomy_id,
                category_id,
                is_system,
                created_at: now.clone(),
                updated_at: now.clone(),
            };
            let inserted = diesel::insert_into(budget_group_assignments::table)
                .values(&row)
                .returning(BudgetGroupAssignmentDB::as_returning())
                .get_result(tx.conn())
                .map_err(StorageError::from)?;
            tx.update(&inserted)?;
            out.push(inserted);
        }
        Ok(out)
    }
    .map(|rows| rows.into_iter().map(Into::into).collect())
}
fn create_group_tx(
    tx: &mut DbWriteTx<'_>,
    new_group: NewBudgetGroup,
) -> wealthfolio_core::Result<BudgetGroup> {
    let now = chrono::Utc::now().to_rfc3339();
    let row = NewBudgetGroupDB {
        id: new_group.id.unwrap_or_else(|| Uuid::new_v4().to_string()),
        key: new_group.key.unwrap_or_else(|| Uuid::new_v4().to_string()),
        name: new_group.name,
        color: new_group.color,
        icon: new_group.icon,
        sort_order: new_group.sort_order.unwrap_or(0),
        is_system: if new_group.is_system { 1 } else { 0 },
        created_at: now.clone(),
        updated_at: now,
    };
    {
        let inserted = diesel::insert_into(budget_groups::table)
            .values(&row)
            .returning(BudgetGroupDB::as_returning())
            .get_result(tx.conn())
            .map_err(StorageError::from)?;
        tx.insert(&inserted)?;
        Ok(inserted)
    }
    .map(Into::into)
}
fn update_group_tx(
    tx: &mut DbWriteTx<'_>,
    id: &str,
    patch: UpdateBudgetGroup,
) -> wealthfolio_core::Result<BudgetGroup> {
    let id = id.to_string();
    {
        let mut existing = budget_groups::table
            .find(&id)
            .first::<BudgetGroupDB>(tx.conn())
            .map_err(StorageError::from)?;
        if let Some(name) = patch.name {
            existing.name = name;
        }
        if let Some(color) = patch.color {
            existing.color = color;
        }
        if let Some(icon) = patch.icon {
            existing.icon = icon;
        }
        if let Some(sort_order) = patch.sort_order {
            existing.sort_order = sort_order;
        }
        existing.updated_at = chrono::Utc::now().to_rfc3339();
        diesel::update(budget_groups::table.find(&id))
            .set((
                budget_groups::name.eq(&existing.name),
                budget_groups::color.eq(&existing.color),
                budget_groups::icon.eq(&existing.icon),
                budget_groups::sort_order.eq(existing.sort_order),
                budget_groups::updated_at.eq(&existing.updated_at),
            ))
            .execute(tx.conn())
            .map_err(StorageError::from)?;
        tx.update(&existing)?;
        Ok(existing)
    }
    .map(Into::into)
}
fn delete_group_and_reassign_tx(
    tx: &mut DbWriteTx<'_>,
    id: &str,
    reassign_to_group_id: &str,
    reassignments: Vec<NewBudgetGroupAssignment>,
) -> wealthfolio_core::Result<()> {
    let id = id.to_string();
    let reassign_to_group_id = reassign_to_group_id.to_string();
    let now = chrono::Utc::now().to_rfc3339();
    {
        for assignment in reassignments {
            let NewBudgetGroupAssignment {
                id,
                group_id,
                taxonomy_id,
                category_id,
            } = assignment;
            let id = id.unwrap_or_else(|| budget_group_assignment_id(&taxonomy_id, &category_id));
            let row = NewBudgetGroupAssignmentDB {
                id,
                group_id,
                taxonomy_id,
                category_id,
                is_system: 0,
                created_at: now.clone(),
                updated_at: now.clone(),
            };
            let inserted = diesel::insert_into(budget_group_assignments::table)
                .values(&row)
                .on_conflict((
                    budget_group_assignments::taxonomy_id,
                    budget_group_assignments::category_id,
                ))
                .do_update()
                .set((
                    budget_group_assignments::group_id.eq(&row.group_id),
                    budget_group_assignments::updated_at.eq(&row.updated_at),
                ))
                .returning(BudgetGroupAssignmentDB::as_returning())
                .get_result(tx.conn())
                .map_err(StorageError::from)?;
            tx.update(&inserted)?;
        }

        let source_buffers = budget_targets::table
            .filter(budget_targets::target_type.eq("group_buffer"))
            .filter(budget_targets::group_id.eq(&id))
            .load::<BudgetTargetDB>(tx.conn())
            .map_err(StorageError::from)?;

        for source in source_buffers {
            let destination = budget_targets::table
                .filter(budget_targets::target_type.eq("group_buffer"))
                .filter(budget_targets::period_key.eq(&source.period_key))
                .filter(budget_targets::group_id.eq(&reassign_to_group_id))
                .first::<BudgetTargetDB>(tx.conn())
                .optional()
                .map_err(StorageError::from)?;

            if let Some(mut destination) = destination {
                destination.amount = sum_amount_strings(&destination.amount, &source.amount);
                destination.updated_at = now.clone();
                diesel::update(budget_targets::table.find(&destination.id))
                    .set((
                        budget_targets::amount.eq(&destination.amount),
                        budget_targets::updated_at.eq(&destination.updated_at),
                    ))
                    .execute(tx.conn())
                    .map_err(StorageError::from)?;
                tx.update(&destination)?;

                diesel::delete(budget_targets::table.find(&source.id))
                    .execute(tx.conn())
                    .map_err(StorageError::from)?;
                tx.delete::<BudgetTargetDB>(source.id);
            } else {
                let mut moved = source;
                moved.group_id = Some(reassign_to_group_id.clone());
                moved.updated_at = now.clone();
                diesel::update(budget_targets::table.find(&moved.id))
                    .set((
                        budget_targets::group_id.eq(&moved.group_id),
                        budget_targets::updated_at.eq(&moved.updated_at),
                    ))
                    .execute(tx.conn())
                    .map_err(StorageError::from)?;
                tx.update(&moved)?;
            }
        }

        let affected = diesel::delete(budget_groups::table.find(&id))
            .execute(tx.conn())
            .map_err(StorageError::from)?;
        if affected > 0 {
            tx.delete::<BudgetGroupDB>(id.clone());
        }
        Ok(())
    }
}
fn upsert_system_groups_tx(
    tx: &mut DbWriteTx<'_>,
    groups: Vec<NewBudgetGroup>,
) -> wealthfolio_core::Result<Vec<BudgetGroup>> {
    let now = chrono::Utc::now().to_rfc3339();
    {
        let mut out = Vec::with_capacity(groups.len());
        for group in groups {
            let row = NewBudgetGroupDB {
                id: group.id.unwrap_or_else(|| Uuid::new_v4().to_string()),
                key: group.key.unwrap_or_else(|| Uuid::new_v4().to_string()),
                name: group.name,
                color: group.color,
                icon: group.icon,
                sort_order: group.sort_order.unwrap_or(0),
                is_system: 1,
                created_at: now.clone(),
                updated_at: now.clone(),
            };
            let existing = budget_groups::table
                .filter(budget_groups::key.eq(&row.key))
                .first::<BudgetGroupDB>(tx.conn())
                .optional()
                .map_err(StorageError::from)?;
            if let Some(existing) = existing {
                if existing.name == row.name
                    && existing.color == row.color
                    && existing.icon == row.icon
                    && existing.sort_order == row.sort_order
                    && existing.is_system == 1
                {
                    out.push(existing);
                    continue;
                }
            }
            let inserted = diesel::insert_into(budget_groups::table)
                .values(&row)
                .on_conflict(budget_groups::key)
                .do_update()
                .set((
                    budget_groups::name.eq(&row.name),
                    budget_groups::color.eq(&row.color),
                    budget_groups::icon.eq(&row.icon),
                    budget_groups::sort_order.eq(row.sort_order),
                    budget_groups::is_system.eq(1),
                    budget_groups::updated_at.eq(&row.updated_at),
                ))
                .returning(BudgetGroupDB::as_returning())
                .get_result(tx.conn())
                .map_err(StorageError::from)?;
            tx.update(&inserted)?;
            out.push(inserted);
        }
        Ok(out)
    }
    .map(|rows| rows.into_iter().map(Into::into).collect())
}
fn upsert_target_tx(
    tx: &mut DbWriteTx<'_>,
    target: NewBudgetTarget,
) -> wealthfolio_core::Result<BudgetTarget> {
    let now = chrono::Utc::now().to_rfc3339();
    let NewBudgetTarget {
        id,
        period_key,
        target_type,
        taxonomy_id,
        category_id,
        group_id,
        amount,
    } = target;
    let target_type = target_type.as_str().to_string();
    let id = id.unwrap_or_else(|| {
        budget_target_id(
            &period_key,
            &target_type,
            taxonomy_id.as_deref(),
            category_id.as_deref(),
            group_id.as_deref(),
        )
    });
    let row = NewBudgetTargetDB {
        id,
        period_key,
        target_type,
        taxonomy_id,
        category_id,
        group_id,
        amount,
        created_at: now.clone(),
        updated_at: now,
    };
    {
        let existing_id = if row.target_type == "category" {
            budget_targets::table
                .filter(budget_targets::target_type.eq("category"))
                .filter(budget_targets::period_key.eq(&row.period_key))
                .filter(budget_targets::taxonomy_id.eq(&row.taxonomy_id))
                .filter(budget_targets::category_id.eq(&row.category_id))
                .select(budget_targets::id)
                .first::<String>(tx.conn())
                .optional()
                .map_err(StorageError::from)?
        } else {
            budget_targets::table
                .filter(budget_targets::target_type.eq("group_buffer"))
                .filter(budget_targets::period_key.eq(&row.period_key))
                .filter(budget_targets::group_id.eq(&row.group_id))
                .select(budget_targets::id)
                .first::<String>(tx.conn())
                .optional()
                .map_err(StorageError::from)?
        };
        let result = if let Some(existing_id) = existing_id {
            diesel::update(budget_targets::table.find(&existing_id))
                .set((
                    budget_targets::amount.eq(&row.amount),
                    budget_targets::updated_at.eq(&row.updated_at),
                ))
                .execute(tx.conn())
                .map_err(StorageError::from)?;
            budget_targets::table
                .find(&existing_id)
                .first::<BudgetTargetDB>(tx.conn())
                .map_err(StorageError::from)?
        } else {
            diesel::insert_into(budget_targets::table)
                .values(&row)
                .returning(BudgetTargetDB::as_returning())
                .get_result(tx.conn())
                .map_err(StorageError::from)?
        };
        tx.update(&result)?;
        Ok(result)
    }
    .map(Into::into)
}
fn delete_target_tx(tx: &mut DbWriteTx<'_>, id: &str) -> wealthfolio_core::Result<()> {
    let id = id.to_string();
    {
        let affected = diesel::delete(budget_targets::table.find(&id))
            .execute(tx.conn())
            .map_err(StorageError::from)?;
        if affected > 0 {
            tx.delete::<BudgetTargetDB>(id.clone());
        }
        Ok(())
    }
}
fn upsert_rollover_setting_tx(
    tx: &mut DbWriteTx<'_>,
    setting: NewBudgetRolloverSetting,
) -> wealthfolio_core::Result<BudgetRolloverSetting> {
    let now = chrono::Utc::now().to_rfc3339();
    let NewBudgetRolloverSetting {
        id,
        target_type,
        taxonomy_id,
        category_id,
        group_id,
        enabled,
        start_month,
        starting_balance,
    } = setting;
    let target_type = target_type.as_str().to_string();
    let id = id.unwrap_or_else(|| {
        budget_rollover_setting_id(
            &target_type,
            taxonomy_id.as_deref(),
            category_id.as_deref(),
            group_id.as_deref(),
        )
    });
    let row = NewBudgetRolloverSettingDB {
        id,
        target_type,
        taxonomy_id,
        category_id,
        group_id,
        enabled: if enabled { 1 } else { 0 },
        start_month,
        starting_balance,
        created_at: now.clone(),
        updated_at: now,
    };
    {
        let existing_id = if row.target_type == "category" {
            budget_rollover_settings::table
                .filter(budget_rollover_settings::target_type.eq("category"))
                .filter(budget_rollover_settings::taxonomy_id.eq(&row.taxonomy_id))
                .filter(budget_rollover_settings::category_id.eq(&row.category_id))
                .select(budget_rollover_settings::id)
                .first::<String>(tx.conn())
                .optional()
                .map_err(StorageError::from)?
        } else {
            budget_rollover_settings::table
                .filter(budget_rollover_settings::target_type.eq("group"))
                .filter(budget_rollover_settings::group_id.eq(&row.group_id))
                .select(budget_rollover_settings::id)
                .first::<String>(tx.conn())
                .optional()
                .map_err(StorageError::from)?
        };
        let result = if let Some(existing_id) = existing_id {
            diesel::update(budget_rollover_settings::table.find(&existing_id))
                .set((
                    budget_rollover_settings::enabled.eq(row.enabled),
                    budget_rollover_settings::start_month.eq(&row.start_month),
                    budget_rollover_settings::starting_balance.eq(&row.starting_balance),
                    budget_rollover_settings::updated_at.eq(&row.updated_at),
                ))
                .execute(tx.conn())
                .map_err(StorageError::from)?;
            budget_rollover_settings::table
                .find(&existing_id)
                .first::<BudgetRolloverSettingDB>(tx.conn())
                .map_err(StorageError::from)?
        } else {
            diesel::insert_into(budget_rollover_settings::table)
                .values(&row)
                .returning(BudgetRolloverSettingDB::as_returning())
                .get_result(tx.conn())
                .map_err(StorageError::from)?
        };
        tx.update(&result)?;
        Ok(result)
    }
    .map(Into::into)
}
fn delete_rollover_setting_tx(tx: &mut DbWriteTx<'_>, id: &str) -> wealthfolio_core::Result<()> {
    let id = id.to_string();
    {
        let affected = diesel::delete(budget_rollover_settings::table.find(&id))
            .execute(tx.conn())
            .map_err(StorageError::from)?;
        if affected > 0 {
            tx.delete::<BudgetRolloverSettingDB>(id.clone());
        }
        Ok(())
    }
}
fn disable_category_rollovers_tx(
    tx: &mut DbWriteTx<'_>,
    taxonomy_id: &str,
    category_ids: &[String],
) -> wealthfolio_core::Result<Vec<BudgetRolloverSetting>> {
    if category_ids.is_empty() {
        return Ok(Vec::new());
    }
    let taxonomy_id = taxonomy_id.to_string();
    let category_ids = category_ids.to_vec();
    {
        let now = chrono::Utc::now().to_rfc3339();
        diesel::update(
            budget_rollover_settings::table
                .filter(budget_rollover_settings::target_type.eq("category"))
                .filter(budget_rollover_settings::taxonomy_id.eq(&taxonomy_id))
                .filter(budget_rollover_settings::category_id.eq_any(&category_ids)),
        )
        .set((
            budget_rollover_settings::enabled.eq(0),
            budget_rollover_settings::updated_at.eq(&now),
        ))
        .execute(tx.conn())
        .map_err(StorageError::from)?;

        let rows = budget_rollover_settings::table
            .filter(budget_rollover_settings::target_type.eq("category"))
            .filter(budget_rollover_settings::taxonomy_id.eq(&taxonomy_id))
            .filter(budget_rollover_settings::category_id.eq_any(&category_ids))
            .load::<BudgetRolloverSettingDB>(tx.conn())
            .map_err(StorageError::from)?;
        for row in &rows {
            tx.update(row)?;
        }
        Ok(rows)
    }
    .map(|rows| rows.into_iter().map(Into::into).collect())
}
fn copy_period_targets_tx(
    tx: &mut DbWriteTx<'_>,
    source_period_key: &str,
    target_period_key: &str,
    overwrite: bool,
) -> wealthfolio_core::Result<Vec<BudgetTarget>> {
    let source = source_period_key.to_string();
    let target = target_period_key.to_string();
    {
        let source_rows = budget_targets::table
            .filter(budget_targets::period_key.eq(&source))
            .load::<BudgetTargetDB>(tx.conn())
            .map_err(StorageError::from)?;

        if overwrite {
            let to_delete = budget_targets::table
                .filter(budget_targets::period_key.eq(&target))
                .load::<BudgetTargetDB>(tx.conn())
                .map_err(StorageError::from)?;
            diesel::delete(budget_targets::table.filter(budget_targets::period_key.eq(&target)))
                .execute(tx.conn())
                .map_err(StorageError::from)?;
            for row in &to_delete {
                tx.delete::<BudgetTargetDB>(row.id.clone());
            }
        }

        let now = chrono::Utc::now().to_rfc3339();
        for source_row in source_rows {
            let id = budget_target_id(
                &target,
                &source_row.target_type,
                source_row.taxonomy_id.as_deref(),
                source_row.category_id.as_deref(),
                source_row.group_id.as_deref(),
            );
            let new_row = NewBudgetTargetDB {
                id,
                period_key: target.clone(),
                target_type: source_row.target_type.clone(),
                taxonomy_id: source_row.taxonomy_id.clone(),
                category_id: source_row.category_id.clone(),
                group_id: source_row.group_id.clone(),
                amount: source_row.amount.clone(),
                created_at: now.clone(),
                updated_at: now.clone(),
            };
            let inserted = diesel::insert_into(budget_targets::table)
                .values(&new_row)
                .on_conflict_do_nothing()
                .returning(BudgetTargetDB::as_returning())
                .get_result(tx.conn())
                .optional()
                .map_err(StorageError::from)?;
            if let Some(row) = inserted {
                tx.update(&row)?;
            }
        }

        let all_target_rows = budget_targets::table
            .filter(budget_targets::period_key.eq(&target))
            .load::<BudgetTargetDB>(tx.conn())
            .map_err(StorageError::from)?;
        Ok(all_target_rows)
    }
    .map(|rows| rows.into_iter().map(Into::into).collect())
}

fn budget_state_tx(
    tx: &mut DbWriteTx<'_>,
) -> wealthfolio_core::Result<wealthfolio_spending::budget::BudgetSnapshotState> {
    Ok(wealthfolio_spending::budget::BudgetSnapshotState {
        groups: budget_groups::table
            .load::<BudgetGroupDB>(tx.conn())
            .map_err(StorageError::from)?
            .into_iter()
            .map(Into::into)
            .collect(),
        group_assignments: budget_group_assignments::table
            .load::<BudgetGroupAssignmentDB>(tx.conn())
            .map_err(StorageError::from)?
            .into_iter()
            .map(Into::into)
            .collect(),
        targets: budget_targets::table
            .load::<BudgetTargetDB>(tx.conn())
            .map_err(StorageError::from)?
            .into_iter()
            .map(Into::into)
            .collect(),
        rollover_settings: budget_rollover_settings::table
            .load::<BudgetRolloverSettingDB>(tx.conn())
            .map_err(StorageError::from)?
            .into_iter()
            .map(Into::into)
            .collect(),
    })
}
