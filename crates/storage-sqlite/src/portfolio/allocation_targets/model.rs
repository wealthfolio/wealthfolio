use diesel::prelude::*;
use serde::{Deserialize, Serialize};
use wealthfolio_core::portfolio::allocation_targets::{
    AllocationTarget, AllocationTargetWeight, BandType, RebalanceGoal, ScopeType, TriggerType,
};

#[derive(Debug, Clone, Queryable, Insertable, AsChangeset, Serialize, Deserialize)]
#[diesel(table_name = crate::schema::allocation_targets)]
pub struct AllocationTargetDB {
    pub id: String,
    pub name: String,
    pub scope_type: String,
    pub scope_id: Option<String>,
    pub taxonomy_id: String,
    pub trigger_type: String,
    pub drift_band_bps: i32,
    pub band_type: String,
    pub relative_factor_bps: i32,
    pub rebalance_goal: String,
    pub min_trade_amount: String,
    pub whole_shares_only: i32,
    pub allow_sells: i32,
    pub created_at: String,
    pub updated_at: String,
    pub archived_at: Option<String>,
    pub max_turnover_bps: Option<i32>,
}

impl From<AllocationTarget> for AllocationTargetDB {
    fn from(target: AllocationTarget) -> Self {
        Self {
            id: target.id,
            name: target.name,
            scope_type: target.scope_type.as_str().to_string(),
            scope_id: target.scope_id,
            taxonomy_id: target.taxonomy_id,
            trigger_type: target.trigger_type.as_str().to_string(),
            drift_band_bps: target.drift_band_bps,
            band_type: target.band_type.as_str().to_string(),
            relative_factor_bps: target.relative_factor_bps,
            rebalance_goal: target.rebalance_goal.as_str().to_string(),
            min_trade_amount: target.min_trade_amount,
            whole_shares_only: target.whole_shares_only as i32,
            allow_sells: target.allow_sells as i32,
            max_turnover_bps: target.max_turnover_bps,
            created_at: target.created_at,
            updated_at: target.updated_at,
            archived_at: target.archived_at,
        }
    }
}

impl TryFrom<AllocationTargetDB> for AllocationTarget {
    type Error = String;
    fn try_from(db: AllocationTargetDB) -> Result<Self, Self::Error> {
        Ok(AllocationTarget {
            id: db.id,
            name: db.name,
            scope_type: ScopeType::try_from(db.scope_type.as_str())?,
            scope_id: db.scope_id,
            taxonomy_id: db.taxonomy_id,
            trigger_type: TriggerType::try_from(db.trigger_type.as_str())?,
            drift_band_bps: db.drift_band_bps,
            band_type: BandType::try_from(db.band_type.as_str())?,
            relative_factor_bps: db.relative_factor_bps,
            rebalance_goal: RebalanceGoal::try_from(db.rebalance_goal.as_str())?,
            min_trade_amount: db.min_trade_amount,
            whole_shares_only: db.whole_shares_only != 0,
            allow_sells: db.allow_sells != 0,
            max_turnover_bps: db.max_turnover_bps,
            created_at: db.created_at,
            updated_at: db.updated_at,
            archived_at: db.archived_at,
        })
    }
}

#[derive(Debug, Clone, Queryable, Insertable, AsChangeset, Serialize, Deserialize)]
#[diesel(table_name = crate::schema::allocation_target_weights)]
pub struct AllocationTargetWeightDB {
    pub id: String,
    pub target_id: String,
    pub taxonomy_id: String,
    pub category_id: String,
    pub target_bps: i32,
    pub is_locked: i32,
    pub is_required: i32,
    pub created_at: String,
    pub updated_at: String,
}

impl From<AllocationTargetWeight> for AllocationTargetWeightDB {
    fn from(n: AllocationTargetWeight) -> Self {
        Self {
            id: n.id,
            target_id: n.target_id,
            taxonomy_id: n.taxonomy_id,
            category_id: n.category_id,
            target_bps: n.target_bps,
            is_locked: n.is_locked as i32,
            is_required: n.is_required as i32,
            created_at: n.created_at,
            updated_at: n.updated_at,
        }
    }
}

impl From<AllocationTargetWeightDB> for AllocationTargetWeight {
    fn from(db: AllocationTargetWeightDB) -> Self {
        Self {
            id: db.id,
            target_id: db.target_id,
            taxonomy_id: db.taxonomy_id,
            category_id: db.category_id,
            target_bps: db.target_bps,
            is_locked: db.is_locked != 0,
            is_required: db.is_required != 0,
            created_at: db.created_at,
            updated_at: db.updated_at,
        }
    }
}

#[derive(Debug, Clone, Queryable, Insertable, AsChangeset, Serialize, Deserialize)]
#[diesel(table_name = crate::schema::allocation_target_constraints)]
pub struct AllocationTargetConstraintDB {
    pub id: String,
    pub target_id: String,
    pub subject_type: String,
    pub subject_id: String,
    pub action: String,
    pub effect: String,
    pub reason: Option<String>,
    pub metadata_json: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}
