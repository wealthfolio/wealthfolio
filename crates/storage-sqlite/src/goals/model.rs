//! Database models for goals.

use diesel::prelude::*;
use serde::{Deserialize, Serialize};

use crate::accounts::AccountDB;

/// Database model for goals
#[derive(
    Queryable,
    Identifiable,
    AsChangeset,
    Selectable,
    PartialEq,
    Serialize,
    Deserialize,
    Debug,
    Clone,
)]
#[diesel(table_name = crate::schema::goals)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
#[serde(rename_all = "camelCase")]
pub struct GoalDB {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub target_amount: f64,
    pub goal_type: String,
    pub status_lifecycle: String,
    pub status_health: String,
    pub priority: i32,
    pub cover_image_key: Option<String>,
    pub currency: Option<String>,
    pub start_date: Option<String>,
    pub target_date: Option<String>,
    pub summary_current_value: Option<f64>,
    pub summary_progress: Option<f64>,
    pub projected_completion_date: Option<String>,
    pub projected_value_at_target_date: Option<f64>,
    pub created_at: String,
    pub updated_at: String,
    pub summary_target_amount: Option<f64>,
    pub cover_image_path: Option<String>,
}

/// Database model for creating a new goal
#[derive(Insertable, Serialize, Deserialize, Debug, Clone)]
#[diesel(table_name = crate::schema::goals)]
#[serde(rename_all = "camelCase")]
pub struct NewGoalDB {
    pub id: Option<String>,
    pub goal_type: String,
    pub title: String,
    pub description: Option<String>,
    pub target_amount: f64,
    pub status_lifecycle: String,
    pub status_health: String,
    pub priority: i32,
    pub cover_image_key: Option<String>,
    pub currency: Option<String>,
    pub start_date: Option<String>,
    pub target_date: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// Database model for goal funding rules (physical table: goals_allocation)
#[derive(
    Queryable,
    Identifiable,
    Associations,
    Selectable,
    PartialEq,
    Serialize,
    Deserialize,
    Debug,
    Clone,
)]
#[diesel(belongs_to(GoalDB, foreign_key = goal_id))]
#[diesel(belongs_to(AccountDB, foreign_key = account_id))]
#[diesel(table_name = crate::schema::goals_allocation)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
#[serde(rename_all = "camelCase")]
pub struct GoalsAllocationDB {
    pub id: String,
    pub goal_id: String,
    pub account_id: String,
    pub share_percent: f64,
    pub tax_bucket: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// Database write model for goal funding rules.
#[derive(Insertable, Debug, Clone)]
#[diesel(table_name = crate::schema::goals_allocation)]
pub struct NewGoalsAllocationDB {
    pub id: String,
    pub goal_id: String,
    pub account_id: String,
    pub share_percent: f64,
    pub tax_bucket: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// Database model for goal plans
#[derive(Queryable, Identifiable, Selectable, PartialEq, Serialize, Deserialize, Debug, Clone)]
#[diesel(table_name = crate::schema::goal_plans)]
#[diesel(primary_key(goal_id))]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
#[serde(rename_all = "camelCase")]
pub struct GoalPlanDB {
    pub goal_id: String,
    pub plan_kind: String,
    pub planner_mode: Option<String>,
    pub settings_json: String,
    pub summary_json: String,
    pub version: i32,
    pub created_at: String,
    pub updated_at: String,
}

/// Database write model for goal plans.
#[derive(Insertable, AsChangeset, Debug, Clone)]
#[diesel(table_name = crate::schema::goal_plans)]
pub struct NewGoalPlanDB {
    pub goal_id: String,
    pub plan_kind: String,
    pub planner_mode: Option<String>,
    pub settings_json: String,
    pub summary_json: String,
    pub version: i32,
    pub created_at: String,
    pub updated_at: String,
}

// --- Conversions ---

impl From<NewGoalsAllocationDB> for GoalsAllocationDB {
    fn from(db: NewGoalsAllocationDB) -> Self {
        Self {
            id: db.id,
            goal_id: db.goal_id,
            account_id: db.account_id,
            share_percent: db.share_percent,
            tax_bucket: db.tax_bucket,
            created_at: db.created_at,
            updated_at: db.updated_at,
        }
    }
}

impl From<NewGoalPlanDB> for GoalPlanDB {
    fn from(db: NewGoalPlanDB) -> Self {
        Self {
            goal_id: db.goal_id,
            plan_kind: db.plan_kind,
            planner_mode: db.planner_mode,
            settings_json: db.settings_json,
            summary_json: db.summary_json,
            version: db.version,
            created_at: db.created_at,
            updated_at: db.updated_at,
        }
    }
}

impl From<GoalDB> for wealthfolio_core::goals::Goal {
    fn from(db: GoalDB) -> Self {
        let target = if db.target_amount == 0.0 {
            None
        } else {
            Some(db.target_amount)
        };
        Self {
            id: db.id,
            goal_type: db.goal_type,
            title: db.title,
            description: db.description,
            target_amount: target,
            status_lifecycle: db.status_lifecycle,
            status_health: db.status_health,
            priority: db.priority,
            cover_image_key: db.cover_image_key,
            currency: db.currency,
            start_date: db.start_date,
            target_date: db.target_date,
            summary_current_value: db.summary_current_value,
            summary_progress: db.summary_progress,
            projected_completion_date: db.projected_completion_date,
            projected_value_at_target_date: db.projected_value_at_target_date,
            created_at: db.created_at,
            updated_at: db.updated_at,
            summary_target_amount: db.summary_target_amount,
            cover_image_path: db.cover_image_path,
        }
    }
}

impl From<GoalsAllocationDB> for wealthfolio_core::goals::GoalFundingRule {
    fn from(db: GoalsAllocationDB) -> Self {
        Self {
            id: db.id,
            goal_id: db.goal_id,
            account_id: db.account_id,
            share_percent: db.share_percent,
            tax_bucket: db.tax_bucket,
            created_at: db.created_at,
            updated_at: db.updated_at,
        }
    }
}

impl From<GoalPlanDB> for wealthfolio_core::goals::GoalPlan {
    fn from(db: GoalPlanDB) -> Self {
        Self {
            goal_id: db.goal_id,
            plan_kind: db.plan_kind,
            planner_mode: db.planner_mode,
            settings_json: db.settings_json,
            summary_json: db.summary_json,
            version: db.version,
            created_at: db.created_at,
            updated_at: db.updated_at,
        }
    }
}

impl From<wealthfolio_core::goals::NewGoal> for NewGoalDB {
    fn from(domain: wealthfolio_core::goals::NewGoal) -> Self {
        let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
        Self {
            id: domain.id,
            goal_type: domain.goal_type,
            title: domain.title,
            description: domain.description,
            target_amount: domain.target_amount.unwrap_or(0.0),
            status_lifecycle: domain
                .status_lifecycle
                .unwrap_or_else(|| "active".to_string()),
            status_health: domain
                .status_health
                .unwrap_or_else(|| "not_applicable".to_string()),
            priority: domain.priority.unwrap_or(0),
            cover_image_key: domain.cover_image_key,
            currency: domain.currency,
            start_date: domain.start_date,
            target_date: domain.target_date,
            created_at: domain.created_at.unwrap_or_else(|| now.clone()),
            updated_at: domain.updated_at.unwrap_or(now),
        }
    }
}
