use wealthfolio_core::goals::{
    Goal, GoalFundingRule, GoalFundingRuleInput, GoalPlan, GoalRepositoryTrait, GoalSummaryUpdate,
    NewGoal, SaveGoalPlan,
};
use wealthfolio_core::Result;

use super::model::{
    GoalDB, GoalPlanDB, GoalsAllocationDB, NewGoalDB, NewGoalPlanDB, NewGoalsAllocationDB,
};
use crate::db::{get_connection, WriteHandle};
use crate::errors::StorageError;
use crate::schema::{goal_plans, goals, goals_allocation};
use async_trait::async_trait;
use diesel::prelude::*;
use diesel::r2d2::{self, Pool};
use diesel::SqliteConnection;

use std::collections::HashMap;
use std::sync::Arc;
use uuid::Uuid;
use wealthfolio_core::errors::ValidationError;

fn validate_goal_funding_capacity(
    conn: &mut SqliteConnection,
    goal_id: &str,
    rules: &[GoalFundingRuleInput],
) -> Result<()> {
    let participating = goals_allocation::table
        .inner_join(goals::table.on(goals::id.eq(goals_allocation::goal_id)))
        .filter(goals::status_lifecycle.eq("active"))
        .filter(goals_allocation::goal_id.ne(goal_id))
        .select(GoalsAllocationDB::as_select())
        .load::<GoalsAllocationDB>(conn)
        .map_err(StorageError::from)?;

    let mut account_totals: HashMap<String, f64> = HashMap::new();
    for existing in participating {
        *account_totals.entry(existing.account_id).or_default() += existing.share_percent;
    }

    for rule in rules {
        if !rule.share_percent.is_finite() || !(0.0..=100.0).contains(&rule.share_percent) {
            return Err(ValidationError::InvalidInput(
                "share_percent must be between 0 and 100".to_string(),
            )
            .into());
        }

        let used_elsewhere = account_totals.get(&rule.account_id).copied().unwrap_or(0.0);
        let combined = used_elsewhere + rule.share_percent;
        if combined > 100.0 {
            let max_available = (100.0 - used_elsewhere).max(0.0);
            return Err(ValidationError::InvalidInput(format!(
                "Account '{}' is overallocated: requested {:.1}%, used elsewhere {:.1}%, max available {:.1}%",
                rule.account_id, rule.share_percent, used_elsewhere, max_available
            ))
            .into());
        }
        *account_totals.entry(rule.account_id.clone()).or_default() = combined;
    }

    Ok(())
}

fn load_goal_funding_inputs(
    conn: &mut SqliteConnection,
    goal_id: &str,
) -> Result<Vec<GoalFundingRuleInput>> {
    let rules = goals_allocation::table
        .filter(goals_allocation::goal_id.eq(goal_id))
        .select(GoalsAllocationDB::as_select())
        .load::<GoalsAllocationDB>(conn)
        .map_err(StorageError::from)?;

    Ok(rules
        .into_iter()
        .map(|rule| GoalFundingRuleInput {
            account_id: rule.account_id,
            share_percent: rule.share_percent,
            tax_bucket: rule.tax_bucket,
        })
        .collect())
}

pub struct GoalRepository {
    pool: Arc<Pool<r2d2::ConnectionManager<SqliteConnection>>>,
    writer: WriteHandle,
}

impl GoalRepository {
    pub fn new(
        pool: Arc<Pool<r2d2::ConnectionManager<SqliteConnection>>>,
        writer: WriteHandle,
    ) -> Self {
        GoalRepository { pool, writer }
    }
}

#[async_trait]
impl GoalRepositoryTrait for GoalRepository {
    fn load_goals(&self) -> Result<Vec<Goal>> {
        let mut conn = get_connection(&self.pool)?;
        let goals_db = goals::table
            .order(goals::priority.desc())
            .load::<GoalDB>(&mut conn)
            .map_err(StorageError::from)?;
        Ok(goals_db.into_iter().map(Goal::from).collect())
    }

    fn load_goal(&self, goal_id: &str) -> Result<Goal> {
        let mut conn = get_connection(&self.pool)?;
        let goal_db = goals::table
            .find(goal_id)
            .first::<GoalDB>(&mut conn)
            .map_err(StorageError::from)?;
        Ok(Goal::from(goal_db))
    }

    async fn insert_new_goal(&self, new_goal: NewGoal) -> Result<Goal> {
        self.writer
            .exec_tx(move |tx| -> Result<Goal> {
                let mut new_goal_db: NewGoalDB = new_goal.into();
                new_goal_db.id = Some(Uuid::new_v4().to_string());

                let result_db = diesel::insert_into(goals::table)
                    .values(&new_goal_db)
                    .returning(GoalDB::as_returning())
                    .get_result(tx.conn())
                    .map_err(StorageError::from)?;
                let payload_db = result_db.clone();
                let goal = Goal::from(result_db);
                tx.insert(&payload_db)?;
                Ok(goal)
            })
            .await
    }

    async fn insert_goal_with_funding(
        &self,
        new_goal: NewGoal,
        funding_rules: Vec<GoalFundingRuleInput>,
    ) -> Result<Goal> {
        self.writer
            .exec_tx(move |tx| -> Result<Goal> {
                let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();

                let mut new_goal_db: NewGoalDB = new_goal.into();
                new_goal_db.id = Some(Uuid::new_v4().to_string());

                let result_db = diesel::insert_into(goals::table)
                    .values(&new_goal_db)
                    .returning(GoalDB::as_returning())
                    .get_result(tx.conn())
                    .map_err(StorageError::from)?;
                let payload_db = result_db.clone();
                let goal = Goal::from(result_db);
                tx.insert(&payload_db)?;

                if goal.status_lifecycle == "active" {
                    validate_goal_funding_capacity(tx.conn(), &goal.id, &funding_rules)?;
                }

                for rule in funding_rules {
                    let db = NewGoalsAllocationDB {
                        id: Uuid::new_v4().to_string(),
                        goal_id: goal.id.clone(),
                        account_id: rule.account_id,
                        share_percent: rule.share_percent,
                        tax_bucket: rule.tax_bucket,
                        created_at: now.clone(),
                        updated_at: now.clone(),
                    };
                    diesel::insert_into(goals_allocation::table)
                        .values(&db)
                        .execute(tx.conn())
                        .map_err(StorageError::from)?;
                    let payload_db = GoalsAllocationDB::from(db);
                    tx.insert(&payload_db)?;
                }

                Ok(goal)
            })
            .await
    }

    async fn update_goal(&self, goal_update: Goal) -> Result<Goal> {
        let goal_id_owned = goal_update.id.clone();
        let next_status_lifecycle = goal_update.status_lifecycle.clone();
        let goal_db = GoalDB {
            id: goal_update.id,
            goal_type: goal_update.goal_type,
            title: goal_update.title,
            description: goal_update.description,
            target_amount: goal_update.target_amount.unwrap_or(0.0),
            status_lifecycle: goal_update.status_lifecycle,
            status_health: goal_update.status_health,
            priority: goal_update.priority,
            cover_image_key: goal_update.cover_image_key,
            currency: goal_update.currency,
            start_date: goal_update.start_date,
            target_date: goal_update.target_date,
            summary_current_value: goal_update.summary_current_value,
            summary_progress: goal_update.summary_progress,
            projected_completion_date: goal_update.projected_completion_date,
            projected_value_at_target_date: goal_update.projected_value_at_target_date,
            created_at: goal_update.created_at,
            updated_at: chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(),
            summary_target_amount: goal_update.summary_target_amount,
            cover_image_path: goal_update.cover_image_path,
        };

        self.writer
            .exec_tx(move |tx| -> Result<Goal> {
                let current_status_lifecycle = goals::table
                    .find(&goal_id_owned)
                    .select(goals::status_lifecycle)
                    .first::<String>(tx.conn())
                    .map_err(StorageError::from)?;

                if current_status_lifecycle != "active" && next_status_lifecycle == "active" {
                    let rules = load_goal_funding_inputs(tx.conn(), &goal_id_owned)?;
                    validate_goal_funding_capacity(tx.conn(), &goal_id_owned, &rules)?;
                }

                diesel::update(goals::table.find(goal_id_owned.clone()))
                    .set(&goal_db)
                    .execute(tx.conn())
                    .map_err(StorageError::from)?;
                let result_db = goals::table
                    .find(goal_id_owned)
                    .first::<GoalDB>(tx.conn())
                    .map_err(StorageError::from)?;
                let payload_db = result_db.clone();
                let goal = Goal::from(result_db);
                tx.update(&payload_db)?;
                Ok(goal)
            })
            .await
    }

    async fn delete_goal(&self, goal_id_to_delete: String) -> Result<usize> {
        let goal_id_for_event = goal_id_to_delete.clone();
        self.writer
            .exec_tx(move |tx| -> Result<usize> {
                let affected = diesel::delete(goals::table.find(goal_id_to_delete))
                    .execute(tx.conn())
                    .map_err(StorageError::from)?;

                if affected > 0 {
                    tx.delete::<GoalDB>(goal_id_for_event.clone());
                }

                Ok(affected)
            })
            .await
    }

    // --- Funding rules ---

    fn load_funding_rules(&self, goal_id: &str) -> Result<Vec<GoalFundingRule>> {
        let mut conn = get_connection(&self.pool)?;
        let rules = goals_allocation::table
            .filter(goals_allocation::goal_id.eq(goal_id))
            .select(GoalsAllocationDB::as_select())
            .load::<GoalsAllocationDB>(&mut conn)
            .map_err(StorageError::from)?;
        Ok(rules.into_iter().map(GoalFundingRule::from).collect())
    }

    fn load_participating_funding_rules(&self) -> Result<Vec<GoalFundingRule>> {
        let mut conn = get_connection(&self.pool)?;
        let rules = goals_allocation::table
            .inner_join(goals::table.on(goals::id.eq(goals_allocation::goal_id)))
            .filter(goals::status_lifecycle.eq("active"))
            .select(GoalsAllocationDB::as_select())
            .load::<GoalsAllocationDB>(&mut conn)
            .map_err(StorageError::from)?;
        Ok(rules.into_iter().map(GoalFundingRule::from).collect())
    }

    async fn save_goal_funding(
        &self,
        goal_id: &str,
        rules: Vec<GoalFundingRuleInput>,
    ) -> Result<Vec<GoalFundingRule>> {
        let goal_id_owned = goal_id.to_string();
        self.writer
            .exec_tx(move |tx| -> Result<Vec<GoalFundingRule>> {
                let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();

                validate_goal_funding_capacity(tx.conn(), &goal_id_owned, &rules)?;

                // Load existing rules to track deletes for sync
                let existing = goals_allocation::table
                    .filter(goals_allocation::goal_id.eq(&goal_id_owned))
                    .select(GoalsAllocationDB::as_select())
                    .load::<GoalsAllocationDB>(tx.conn())
                    .map_err(StorageError::from)?;

                // Delete all existing rules for this goal
                diesel::delete(
                    goals_allocation::table.filter(goals_allocation::goal_id.eq(&goal_id_owned)),
                )
                .execute(tx.conn())
                .map_err(StorageError::from)?;

                // Track deletes in sync outbox
                for old in &existing {
                    tx.delete::<GoalsAllocationDB>(old.id.clone());
                }

                // Insert new rules
                let mut result = Vec::new();
                for rule in rules {
                    let db = NewGoalsAllocationDB {
                        id: Uuid::new_v4().to_string(),
                        goal_id: goal_id_owned.clone(),
                        account_id: rule.account_id,
                        share_percent: rule.share_percent,
                        tax_bucket: rule.tax_bucket.clone(),
                        created_at: now.clone(),
                        updated_at: now.clone(),
                    };
                    diesel::insert_into(goals_allocation::table)
                        .values(&db)
                        .execute(tx.conn())
                        .map_err(StorageError::from)?;
                    let payload_db = GoalsAllocationDB::from(db);
                    tx.insert(&payload_db)?;
                    result.push(GoalFundingRule::from(payload_db));
                }

                Ok(result)
            })
            .await
    }

    // --- Plans ---

    fn load_goal_plan(&self, goal_id: &str) -> Result<Option<GoalPlan>> {
        let mut conn = get_connection(&self.pool)?;
        let result = goal_plans::table
            .find(goal_id)
            .first::<GoalPlanDB>(&mut conn)
            .optional()
            .map_err(StorageError::from)?;
        Ok(result.map(GoalPlan::from))
    }

    async fn save_goal_plan(&self, plan: SaveGoalPlan) -> Result<GoalPlan> {
        let goal_id = plan.goal_id.clone();
        self.writer
            .exec_tx(move |tx| -> Result<GoalPlan> {
                let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();

                let existing = goal_plans::table
                    .find(&plan.goal_id)
                    .first::<GoalPlanDB>(tx.conn())
                    .optional()
                    .map_err(StorageError::from)?;

                let new_version = existing.as_ref().map_or(1, |e| e.version + 1);
                let created = existing
                    .as_ref()
                    .map_or_else(|| now.clone(), |e| e.created_at.clone());

                let plan_db = NewGoalPlanDB {
                    goal_id: plan.goal_id,
                    plan_kind: plan.plan_kind,
                    planner_mode: plan.planner_mode,
                    settings_json: plan.settings_json,
                    summary_json: plan.summary_json.unwrap_or_else(|| "{}".to_string()),
                    version: new_version,
                    created_at: created,
                    updated_at: now,
                };

                diesel::insert_into(goal_plans::table)
                    .values(&plan_db)
                    .on_conflict(goal_plans::goal_id)
                    .do_update()
                    .set(&plan_db)
                    .execute(tx.conn())
                    .map_err(StorageError::from)?;

                let result_db = goal_plans::table
                    .find(&goal_id)
                    .first::<GoalPlanDB>(tx.conn())
                    .map_err(StorageError::from)?;

                let payload_db = result_db.clone();
                let goal_plan = GoalPlan::from(result_db);
                if existing.is_some() {
                    tx.update(&payload_db)?;
                } else {
                    tx.insert(&payload_db)?;
                }
                Ok(goal_plan)
            })
            .await
    }

    async fn delete_goal_plan(&self, goal_id: &str) -> Result<usize> {
        let goal_id_owned = goal_id.to_string();
        let goal_id_for_event = goal_id_owned.clone();
        self.writer
            .exec_tx(move |tx| -> Result<usize> {
                let affected = diesel::delete(goal_plans::table.find(&goal_id_owned))
                    .execute(tx.conn())
                    .map_err(StorageError::from)?;
                if affected > 0 {
                    tx.delete::<GoalPlanDB>(goal_id_for_event);
                }
                Ok(affected)
            })
            .await
    }

    // --- Goal summary ---

    async fn update_goal_summary_fields(
        &self,
        goal_id: &str,
        update: GoalSummaryUpdate,
    ) -> Result<()> {
        let goal_id_owned = goal_id.to_string();
        self.writer
            .exec(move |conn| -> Result<()> {
                diesel::update(goals::table.find(&goal_id_owned))
                    .set((
                        goals::summary_target_amount.eq(update.summary_target_amount),
                        goals::summary_current_value.eq(update.summary_current_value),
                        goals::summary_progress.eq(update.summary_progress),
                        goals::projected_completion_date.eq(update.projected_completion_date),
                        goals::projected_value_at_target_date
                            .eq(update.projected_value_at_target_date),
                        goals::status_health.eq(update.status_health),
                    ))
                    .execute(conn)
                    .map_err(StorageError::from)?;
                Ok(())
            })
            .await
    }
}
