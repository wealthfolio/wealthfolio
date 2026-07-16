use async_trait::async_trait;
use log::debug;
use std::collections::HashSet;
use std::sync::Arc;
use uuid::Uuid;

use crate::errors::{Error as CoreError, Result as CoreResult, ValidationError};
use crate::taxonomies::{Category, TaxonomyServiceTrait};

use super::model::{
    AllocationTarget, AllocationTargetConstraint, AllocationTargetWeight, BandType,
    ConstraintAction, ConstraintEffect, ConstraintSubjectType, NewAllocationTarget,
    NewAllocationTargetWeight, RebalanceGoal, SaveAllocationTargetResult,
};
use super::validation::{validate_new_target, validate_weights_sum};

// ── Repository trait ─────────────────────────────────────────────────────────

#[async_trait]
pub trait AllocationTargetRepositoryTrait: Send + Sync {
    fn get_target(&self, id: &str) -> CoreResult<Option<AllocationTarget>>;
    fn list_targets(&self) -> CoreResult<Vec<AllocationTarget>>;
    fn list_weights_for_target(&self, target_id: &str) -> CoreResult<Vec<AllocationTargetWeight>>;

    async fn create_target(&self, target: AllocationTarget) -> CoreResult<AllocationTarget>;
    async fn update_target(&self, target: AllocationTarget) -> CoreResult<AllocationTarget>;
    async fn delete_target(&self, id: &str) -> CoreResult<usize>;
    async fn save_weights(
        &self,
        target_id: &str,
        weights: Vec<AllocationTargetWeight>,
    ) -> CoreResult<Vec<AllocationTargetWeight>>;
    async fn save_target_with_weights(
        &self,
        target: AllocationTarget,
        weights: Vec<AllocationTargetWeight>,
    ) -> CoreResult<SaveAllocationTargetResult>;

    fn list_target_constraints(
        &self,
        target_id: &str,
    ) -> CoreResult<Vec<AllocationTargetConstraint>>;
    async fn save_target_constraints(
        &self,
        target_id: &str,
        constraints: Vec<AllocationTargetConstraint>,
    ) -> CoreResult<Vec<AllocationTargetConstraint>>;
}

// ── Service trait ─────────────────────────────────────────────────────────────

#[async_trait]
pub trait AllocationTargetServiceTrait: Send + Sync {
    fn get_target(&self, id: &str) -> CoreResult<Option<AllocationTarget>>;
    fn list_targets(&self) -> CoreResult<Vec<AllocationTarget>>;
    fn list_weights_for_target(&self, target_id: &str) -> CoreResult<Vec<AllocationTargetWeight>>;

    async fn create_target(&self, input: NewAllocationTarget) -> CoreResult<AllocationTarget>;
    async fn update_target(
        &self,
        id: &str,
        input: NewAllocationTarget,
    ) -> CoreResult<AllocationTarget>;
    async fn archive_target(&self, id: &str) -> CoreResult<AllocationTarget>;
    async fn delete_target(&self, id: &str) -> CoreResult<()>;
    async fn save_weights(
        &self,
        target_id: &str,
        weights: Vec<NewAllocationTargetWeight>,
    ) -> CoreResult<Vec<AllocationTargetWeight>>;
    async fn save_target_with_weights(
        &self,
        id: Option<String>,
        input: NewAllocationTarget,
        weights: Vec<NewAllocationTargetWeight>,
    ) -> CoreResult<SaveAllocationTargetResult>;

    fn list_target_constraints(
        &self,
        target_id: &str,
    ) -> CoreResult<Vec<AllocationTargetConstraint>>;
    async fn save_target_constraints(
        &self,
        target_id: &str,
        constraints: Vec<AllocationTargetConstraint>,
    ) -> CoreResult<Vec<AllocationTargetConstraint>>;
}

// ── Implementation ────────────────────────────────────────────────────────────

pub struct AllocationTargetService {
    repository: Arc<dyn AllocationTargetRepositoryTrait>,
    taxonomy_service: Arc<dyn TaxonomyServiceTrait>,
}

impl AllocationTargetService {
    pub fn new(
        repository: Arc<dyn AllocationTargetRepositoryTrait>,
        taxonomy_service: Arc<dyn TaxonomyServiceTrait>,
    ) -> Self {
        Self {
            repository,
            taxonomy_service,
        }
    }

    fn now() -> String {
        chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
    }

    fn taxonomy_not_found(taxonomy_id: &str) -> CoreError {
        CoreError::Validation(ValidationError::InvalidInput(format!(
            "taxonomy_id '{}' does not exist",
            taxonomy_id
        )))
    }

    fn target_not_found(id: &str) -> CoreError {
        CoreError::Database(crate::errors::DatabaseError::NotFound(format!(
            "AllocationTarget {} not found",
            id
        )))
    }

    fn validate_v1_sell_protection_constraint(
        constraint: &AllocationTargetConstraint,
    ) -> CoreResult<()> {
        if constraint.subject_id.trim().is_empty() {
            return Err(CoreError::Validation(ValidationError::InvalidInput(
                "sell protection subject_id is required".to_string(),
            )));
        }
        if !matches!(
            constraint.subject_type,
            ConstraintSubjectType::Asset | ConstraintSubjectType::Account
        ) {
            return Err(CoreError::Validation(ValidationError::InvalidInput(
                "sell protection supports asset and account subjects only".to_string(),
            )));
        }
        if !matches!(constraint.action, ConstraintAction::Sell) {
            return Err(CoreError::Validation(ValidationError::InvalidInput(
                "sell protection supports sell action only".to_string(),
            )));
        }
        if !matches!(constraint.effect, ConstraintEffect::Block) {
            return Err(CoreError::Validation(ValidationError::InvalidInput(
                "sell protection supports block effect only".to_string(),
            )));
        }
        Ok(())
    }

    fn validate_target_taxonomy(&self, taxonomy_id: &str) -> CoreResult<()> {
        let taxonomy = self
            .taxonomy_service
            .get_taxonomy(taxonomy_id)?
            .ok_or_else(|| Self::taxonomy_not_found(taxonomy_id))?;

        if taxonomy.taxonomy.scope != "asset" {
            return Err(CoreError::Validation(ValidationError::InvalidInput(
                format!("taxonomy_id '{}' is not an asset taxonomy", taxonomy_id),
            )));
        }

        Ok(())
    }

    fn validate_weight_categories_for_taxonomy(
        &self,
        taxonomy_id: &str,
        weights: &[NewAllocationTargetWeight],
    ) -> CoreResult<()> {
        let taxonomy = self
            .taxonomy_service
            .get_taxonomy(taxonomy_id)?
            .ok_or_else(|| Self::taxonomy_not_found(taxonomy_id))?;
        if taxonomy.taxonomy.scope != "asset" {
            return Err(CoreError::Validation(ValidationError::InvalidInput(
                format!("taxonomy_id '{}' is not an asset taxonomy", taxonomy_id),
            )));
        }

        let valid_ids = Self::targetable_category_ids(taxonomy_id, &taxonomy.categories);
        for weight in weights {
            if !valid_ids.contains(weight.category_id.as_str()) {
                return Err(CoreError::Validation(ValidationError::InvalidInput(
                    if Self::requires_top_level_target_weights(taxonomy_id) {
                        format!(
                            "category_id '{}' is not a top-level category in taxonomy '{}'",
                            weight.category_id, taxonomy_id
                        )
                    } else {
                        format!(
                            "category_id '{}' does not belong to taxonomy '{}'",
                            weight.category_id, taxonomy_id
                        )
                    },
                )));
            }
        }

        Ok(())
    }

    fn requires_top_level_target_weights(taxonomy_id: &str) -> bool {
        matches!(
            taxonomy_id,
            "asset_classes" | "industries_gics" | "regions" | "instrument_type"
        )
    }

    fn targetable_category_ids<'a>(
        taxonomy_id: &str,
        categories: &'a [Category],
    ) -> HashSet<&'a str> {
        categories
            .iter()
            .filter(|category| {
                !Self::requires_top_level_target_weights(taxonomy_id)
                    || category.parent_id.is_none()
            })
            .map(|category| category.id.as_str())
            .collect()
    }

    fn build_target_from_input(
        id: String,
        input: NewAllocationTarget,
        existing: Option<AllocationTarget>,
        now: &str,
    ) -> AllocationTarget {
        AllocationTarget {
            id,
            name: input.name.trim().to_string(),
            scope_type: input.scope_type,
            scope_id: input.scope_id,
            taxonomy_id: input.taxonomy_id,
            trigger_type: input.trigger_type,
            drift_band_bps: input.drift_band_bps,
            band_type: input
                .band_type
                .or_else(|| existing.as_ref().map(|target| target.band_type.clone()))
                .unwrap_or(BandType::Hybrid),
            relative_factor_bps: input
                .relative_factor_bps
                .or_else(|| existing.as_ref().map(|target| target.relative_factor_bps))
                .unwrap_or(2000),
            rebalance_goal: input
                .rebalance_goal
                .or_else(|| {
                    existing
                        .as_ref()
                        .map(|target| target.rebalance_goal.clone())
                })
                .unwrap_or(RebalanceGoal::NearestBand),
            min_trade_amount: input
                .min_trade_amount
                .or_else(|| {
                    existing
                        .as_ref()
                        .map(|target| target.min_trade_amount.clone())
                })
                .unwrap_or_else(|| "0".to_string()),
            whole_shares_only: input
                .whole_shares_only
                .or_else(|| existing.as_ref().map(|target| target.whole_shares_only))
                .unwrap_or(false),
            allow_sells: input
                .allow_sells
                .or_else(|| existing.as_ref().map(|target| target.allow_sells))
                .unwrap_or(false),
            max_turnover_bps: input.max_turnover_bps,
            created_at: existing
                .as_ref()
                .map(|target| target.created_at.clone())
                .unwrap_or_else(|| now.to_string()),
            updated_at: now.to_string(),
            archived_at: existing.and_then(|target| target.archived_at),
        }
    }

    fn build_domain_weights(
        target_id: &str,
        taxonomy_id: &str,
        weights: Vec<NewAllocationTargetWeight>,
        now: &str,
    ) -> Vec<AllocationTargetWeight> {
        weights
            .into_iter()
            .map(|n| AllocationTargetWeight {
                id: Uuid::new_v4().to_string(),
                target_id: target_id.to_string(),
                taxonomy_id: taxonomy_id.to_string(),
                category_id: n.category_id,
                target_bps: n.target_bps,
                is_locked: n.is_locked,
                is_required: n.is_required,
                created_at: now.to_string(),
                updated_at: now.to_string(),
            })
            .collect()
    }
}

#[async_trait]
impl AllocationTargetServiceTrait for AllocationTargetService {
    fn get_target(&self, id: &str) -> CoreResult<Option<AllocationTarget>> {
        self.repository.get_target(id)
    }

    fn list_targets(&self) -> CoreResult<Vec<AllocationTarget>> {
        self.repository.list_targets()
    }

    fn list_weights_for_target(&self, target_id: &str) -> CoreResult<Vec<AllocationTargetWeight>> {
        self.repository.list_weights_for_target(target_id)
    }

    async fn create_target(&self, input: NewAllocationTarget) -> CoreResult<AllocationTarget> {
        validate_new_target(&input)?;
        self.validate_target_taxonomy(&input.taxonomy_id)?;
        debug!("Creating allocation target: {}", input.name);
        let now = Self::now();
        let target = AllocationTarget {
            id: Uuid::new_v4().to_string(),
            name: input.name.trim().to_string(),
            scope_type: input.scope_type,
            scope_id: input.scope_id,
            taxonomy_id: input.taxonomy_id,
            trigger_type: input.trigger_type,
            drift_band_bps: input.drift_band_bps,
            // New targets default to Hybrid (#1070). Existing DB rows
            // keep Absolute via migration; updates preserve the saved value.
            band_type: input.band_type.unwrap_or(BandType::Hybrid),
            relative_factor_bps: input.relative_factor_bps.unwrap_or(2000),
            rebalance_goal: input.rebalance_goal.unwrap_or(RebalanceGoal::NearestBand),
            min_trade_amount: input.min_trade_amount.unwrap_or_else(|| "0".to_string()),
            whole_shares_only: input.whole_shares_only.unwrap_or(false),
            allow_sells: input.allow_sells.unwrap_or(false),
            max_turnover_bps: input.max_turnover_bps,
            created_at: now.clone(),
            updated_at: now,
            archived_at: None,
        };
        self.repository.create_target(target).await
    }

    async fn update_target(
        &self,
        id: &str,
        input: NewAllocationTarget,
    ) -> CoreResult<AllocationTarget> {
        validate_new_target(&input)?;
        self.validate_target_taxonomy(&input.taxonomy_id)?;
        let existing = self.repository.get_target(id)?.ok_or_else(|| {
            crate::errors::Error::Database(crate::errors::DatabaseError::NotFound(format!(
                "AllocationTarget {} not found",
                id
            )))
        })?;
        if existing.taxonomy_id != input.taxonomy_id
            && !self.repository.list_weights_for_target(id)?.is_empty()
        {
            return Err(CoreError::Validation(ValidationError::InvalidInput(
                "Cannot change taxonomy_id while allocation target weights exist".to_string(),
            )));
        }
        debug!("Updating allocation target: {}", id);
        let updated = AllocationTarget {
            id: existing.id,
            name: input.name.trim().to_string(),
            scope_type: input.scope_type,
            scope_id: input.scope_id,
            taxonomy_id: input.taxonomy_id,
            trigger_type: input.trigger_type,
            drift_band_bps: input.drift_band_bps,
            band_type: input.band_type.unwrap_or(existing.band_type),
            relative_factor_bps: input
                .relative_factor_bps
                .unwrap_or(existing.relative_factor_bps),
            rebalance_goal: input.rebalance_goal.unwrap_or(existing.rebalance_goal),
            min_trade_amount: input.min_trade_amount.unwrap_or(existing.min_trade_amount),
            whole_shares_only: input
                .whole_shares_only
                .unwrap_or(existing.whole_shares_only),
            allow_sells: input.allow_sells.unwrap_or(existing.allow_sells),
            max_turnover_bps: input.max_turnover_bps,
            created_at: existing.created_at,
            updated_at: Self::now(),
            archived_at: existing.archived_at,
        };
        self.repository.update_target(updated).await
    }

    async fn archive_target(&self, id: &str) -> CoreResult<AllocationTarget> {
        let existing = self
            .repository
            .get_target(id)?
            .ok_or_else(|| Self::target_not_found(id))?;
        debug!("Archiving allocation target: {}", id);
        let now = Self::now();
        let updated = AllocationTarget {
            updated_at: now.clone(),
            archived_at: Some(now),
            ..existing
        };
        self.repository.update_target(updated).await
    }

    async fn delete_target(&self, id: &str) -> CoreResult<()> {
        debug!("Deleting allocation target: {}", id);
        self.repository.delete_target(id).await?;
        Ok(())
    }

    async fn save_weights(
        &self,
        target_id: &str,
        weights: Vec<NewAllocationTargetWeight>,
    ) -> CoreResult<Vec<AllocationTargetWeight>> {
        validate_weights_sum(&weights)?;

        let target = self
            .repository
            .get_target(target_id)?
            .ok_or_else(|| Self::target_not_found(target_id))?;
        self.validate_weight_categories_for_taxonomy(&target.taxonomy_id, &weights)?;

        debug!(
            "Saving {} weights for allocation target {}",
            weights.len(),
            target_id
        );
        let now = Self::now();
        let domain_weights =
            Self::build_domain_weights(target_id, &target.taxonomy_id, weights, &now);
        self.repository
            .save_weights(target_id, domain_weights)
            .await
    }

    async fn save_target_with_weights(
        &self,
        id: Option<String>,
        input: NewAllocationTarget,
        weights: Vec<NewAllocationTargetWeight>,
    ) -> CoreResult<SaveAllocationTargetResult> {
        validate_new_target(&input)?;
        validate_weights_sum(&weights)?;
        self.validate_weight_categories_for_taxonomy(&input.taxonomy_id, &weights)?;

        let existing = if let Some(target_id) = id.as_deref() {
            Some(
                self.repository
                    .get_target(target_id)?
                    .ok_or_else(|| Self::target_not_found(target_id))?,
            )
        } else {
            None
        };

        let now = Self::now();
        let target_id = id.unwrap_or_else(|| Uuid::new_v4().to_string());
        debug!(
            "Saving allocation target {} with {} weights",
            target_id,
            weights.len()
        );

        let target = Self::build_target_from_input(target_id.clone(), input, existing, &now);
        let domain_weights =
            Self::build_domain_weights(&target_id, &target.taxonomy_id, weights, &now);
        self.repository
            .save_target_with_weights(target, domain_weights)
            .await
    }

    fn list_target_constraints(
        &self,
        target_id: &str,
    ) -> CoreResult<Vec<AllocationTargetConstraint>> {
        self.repository.list_target_constraints(target_id)
    }

    async fn save_target_constraints(
        &self,
        target_id: &str,
        constraints: Vec<AllocationTargetConstraint>,
    ) -> CoreResult<Vec<AllocationTargetConstraint>> {
        self.repository
            .get_target(target_id)?
            .ok_or_else(|| Self::target_not_found(target_id))?;

        let constraints = constraints
            .into_iter()
            .map(|mut constraint| {
                Self::validate_v1_sell_protection_constraint(&constraint)?;
                constraint.target_id = target_id.to_string();
                Ok(constraint)
            })
            .collect::<CoreResult<Vec<_>>>()?;

        self.repository
            .save_target_constraints(target_id, constraints)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::portfolio::allocation_targets::{
        ConstraintAction, ConstraintEffect, ConstraintSubjectType, ScopeType, TriggerType,
    };
    use crate::taxonomies::{
        AssetTaxonomyAssignment, NewAssetTaxonomyAssignment, NewCategory, NewTaxonomy, Taxonomy,
        TaxonomyWithCategories,
    };
    use async_trait::async_trait;

    fn taxonomy(id: &str) -> Taxonomy {
        let now = chrono::Utc::now().naive_utc();
        Taxonomy {
            id: id.to_string(),
            name: id.to_string(),
            color: "#808080".to_string(),
            description: None,
            is_system: true,
            is_single_select: false,
            sort_order: 0,
            created_at: now,
            updated_at: now,
            scope: "asset".to_string(),
        }
    }

    fn category(id: &str, parent_id: Option<&str>) -> Category {
        let now = chrono::Utc::now().naive_utc();
        Category {
            id: id.to_string(),
            taxonomy_id: "asset_classes".to_string(),
            parent_id: parent_id.map(str::to_string),
            name: id.to_string(),
            key: id.to_string(),
            color: "#808080".to_string(),
            description: None,
            sort_order: 0,
            created_at: now,
            updated_at: now,
            icon: None,
        }
    }

    fn target(taxonomy_id: &str) -> AllocationTarget {
        AllocationTarget {
            id: "target-1".to_string(),
            name: "Target".to_string(),
            scope_type: ScopeType::All,
            scope_id: None,
            taxonomy_id: taxonomy_id.to_string(),
            trigger_type: TriggerType::Threshold,
            drift_band_bps: 500,
            band_type: BandType::Absolute,
            relative_factor_bps: 2000,
            rebalance_goal: RebalanceGoal::NearestBand,
            min_trade_amount: "0".to_string(),
            whole_shares_only: false,
            allow_sells: false,
            max_turnover_bps: None,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
            archived_at: None,
        }
    }

    fn target_input(taxonomy_id: &str) -> NewAllocationTarget {
        NewAllocationTarget {
            name: "Updated target".to_string(),
            scope_type: ScopeType::All,
            scope_id: None,
            taxonomy_id: taxonomy_id.to_string(),
            trigger_type: TriggerType::Threshold,
            drift_band_bps: 500,
            band_type: None,
            relative_factor_bps: None,
            rebalance_goal: Some(RebalanceGoal::NearestBand),
            min_trade_amount: Some("0".to_string()),
            whole_shares_only: Some(false),
            allow_sells: None,
            max_turnover_bps: None,
        }
    }

    fn saved_weight(taxonomy_id: &str) -> AllocationTargetWeight {
        AllocationTargetWeight {
            id: "weight-1".to_string(),
            target_id: "target-1".to_string(),
            taxonomy_id: taxonomy_id.to_string(),
            category_id: "CASH".to_string(),
            target_bps: 10000,
            is_locked: false,
            is_required: true,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
        }
    }

    fn constraint(
        subject_type: ConstraintSubjectType,
        action: ConstraintAction,
        effect: ConstraintEffect,
    ) -> AllocationTargetConstraint {
        AllocationTargetConstraint {
            id: "constraint-1".to_string(),
            target_id: "client-target-id".to_string(),
            subject_type,
            subject_id: "subject-1".to_string(),
            action,
            effect,
            reason: None,
            metadata_json: None,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
        }
    }

    struct MockAllocationTargetRepository {
        target: AllocationTarget,
        weights: Vec<AllocationTargetWeight>,
    }

    #[async_trait]
    impl AllocationTargetRepositoryTrait for MockAllocationTargetRepository {
        fn get_target(&self, _id: &str) -> CoreResult<Option<AllocationTarget>> {
            Ok(Some(self.target.clone()))
        }

        fn list_targets(&self) -> CoreResult<Vec<AllocationTarget>> {
            Ok(vec![self.target.clone()])
        }

        fn list_weights_for_target(
            &self,
            _target_id: &str,
        ) -> CoreResult<Vec<AllocationTargetWeight>> {
            Ok(self.weights.clone())
        }

        async fn create_target(&self, target: AllocationTarget) -> CoreResult<AllocationTarget> {
            Ok(target)
        }

        async fn update_target(&self, target: AllocationTarget) -> CoreResult<AllocationTarget> {
            Ok(target)
        }

        async fn delete_target(&self, _id: &str) -> CoreResult<usize> {
            Ok(1)
        }

        async fn save_weights(
            &self,
            _target_id: &str,
            weights: Vec<AllocationTargetWeight>,
        ) -> CoreResult<Vec<AllocationTargetWeight>> {
            Ok(weights)
        }

        async fn save_target_with_weights(
            &self,
            target: AllocationTarget,
            weights: Vec<AllocationTargetWeight>,
        ) -> CoreResult<SaveAllocationTargetResult> {
            Ok(SaveAllocationTargetResult { target, weights })
        }

        fn list_target_constraints(
            &self,
            _target_id: &str,
        ) -> CoreResult<Vec<AllocationTargetConstraint>> {
            Ok(vec![])
        }

        async fn save_target_constraints(
            &self,
            _target_id: &str,
            constraints: Vec<AllocationTargetConstraint>,
        ) -> CoreResult<Vec<AllocationTargetConstraint>> {
            Ok(constraints)
        }
    }

    struct MockTaxonomyService;

    #[async_trait]
    impl TaxonomyServiceTrait for MockTaxonomyService {
        fn get_taxonomies(&self) -> CoreResult<Vec<Taxonomy>> {
            Ok(Vec::new())
        }

        fn get_taxonomy(&self, id: &str) -> CoreResult<Option<TaxonomyWithCategories>> {
            Ok(Some(TaxonomyWithCategories {
                taxonomy: taxonomy(id),
                categories: Vec::new(),
            }))
        }

        fn get_taxonomies_with_categories(&self) -> CoreResult<Vec<TaxonomyWithCategories>> {
            Ok(Vec::new())
        }

        async fn create_taxonomy(&self, taxonomy: NewTaxonomy) -> CoreResult<Taxonomy> {
            Ok(Taxonomy {
                id: taxonomy.id.unwrap_or_else(|| "taxonomy-1".to_string()),
                name: taxonomy.name,
                color: taxonomy.color,
                description: taxonomy.description,
                is_system: taxonomy.is_system,
                is_single_select: taxonomy.is_single_select,
                sort_order: taxonomy.sort_order,
                created_at: chrono::Utc::now().naive_utc(),
                updated_at: chrono::Utc::now().naive_utc(),
                scope: taxonomy.scope,
            })
        }

        async fn update_taxonomy(&self, taxonomy: Taxonomy) -> CoreResult<Taxonomy> {
            Ok(taxonomy)
        }

        async fn delete_taxonomy(&self, _id: &str) -> CoreResult<usize> {
            Ok(1)
        }

        async fn create_category(&self, category: NewCategory) -> CoreResult<Category> {
            Ok(Category {
                id: category.id.unwrap_or_else(|| "category-1".to_string()),
                taxonomy_id: category.taxonomy_id,
                parent_id: category.parent_id,
                name: category.name,
                key: category.key,
                color: category.color,
                description: category.description,
                sort_order: category.sort_order,
                created_at: chrono::Utc::now().naive_utc(),
                updated_at: chrono::Utc::now().naive_utc(),
                icon: category.icon,
            })
        }

        async fn update_category(&self, category: Category) -> CoreResult<Category> {
            Ok(category)
        }

        async fn delete_category(
            &self,
            _taxonomy_id: &str,
            _category_id: &str,
        ) -> CoreResult<usize> {
            Ok(1)
        }

        async fn move_category(
            &self,
            _taxonomy_id: &str,
            _category_id: &str,
            _new_parent_id: Option<String>,
            _position: i32,
        ) -> CoreResult<Category> {
            Ok(category("category-1", None))
        }

        async fn import_taxonomy_json(&self, _json_str: &str) -> CoreResult<Taxonomy> {
            Ok(taxonomy("taxonomy-1"))
        }

        fn export_taxonomy_json(&self, _id: &str) -> CoreResult<String> {
            Ok("{}".to_string())
        }

        fn get_asset_assignments(
            &self,
            _asset_id: &str,
        ) -> CoreResult<Vec<AssetTaxonomyAssignment>> {
            Ok(Vec::new())
        }

        fn get_asset_assignments_for_assets(
            &self,
            _asset_ids: &[String],
        ) -> CoreResult<Vec<AssetTaxonomyAssignment>> {
            Ok(Vec::new())
        }

        fn get_category_assignments(
            &self,
            _taxonomy_id: &str,
            _category_id: &str,
        ) -> CoreResult<Vec<AssetTaxonomyAssignment>> {
            Ok(Vec::new())
        }

        async fn assign_asset_to_category(
            &self,
            assignment: NewAssetTaxonomyAssignment,
        ) -> CoreResult<AssetTaxonomyAssignment> {
            Ok(AssetTaxonomyAssignment {
                id: assignment.id.unwrap_or_else(|| "assignment-1".to_string()),
                asset_id: assignment.asset_id,
                taxonomy_id: assignment.taxonomy_id,
                category_id: assignment.category_id,
                weight: assignment.weight,
                source: assignment.source,
                created_at: chrono::Utc::now().naive_utc(),
                updated_at: chrono::Utc::now().naive_utc(),
            })
        }

        async fn replace_asset_taxonomy_assignments(
            &self,
            _asset_id: &str,
            _taxonomy_id: &str,
            assignments: Vec<NewAssetTaxonomyAssignment>,
        ) -> CoreResult<Vec<AssetTaxonomyAssignment>> {
            let now = chrono::Utc::now().naive_utc();
            Ok(assignments
                .into_iter()
                .map(|assignment| AssetTaxonomyAssignment {
                    id: assignment.id.unwrap_or_else(|| "assignment-1".to_string()),
                    asset_id: assignment.asset_id,
                    taxonomy_id: assignment.taxonomy_id,
                    category_id: assignment.category_id,
                    weight: assignment.weight,
                    source: assignment.source,
                    created_at: now,
                    updated_at: now,
                })
                .collect())
        }

        async fn remove_asset_assignment(&self, _id: &str) -> CoreResult<usize> {
            Ok(1)
        }
    }

    #[test]
    fn rolled_up_taxonomies_target_top_level_categories_only() {
        let categories = vec![
            category("EQUITY", None),
            category("US_EQUITY", Some("EQUITY")),
        ];
        let ids = AllocationTargetService::targetable_category_ids("asset_classes", &categories);

        assert!(ids.contains("EQUITY"));
        assert!(!ids.contains("US_EQUITY"));
    }

    #[test]
    fn non_rolled_up_taxonomies_can_target_any_category() {
        let categories = vec![
            category("THEMES", None),
            category("THEME_AI", Some("THEMES")),
        ];
        let ids = AllocationTargetService::targetable_category_ids("custom_groups", &categories);

        assert!(ids.contains("THEMES"));
        assert!(ids.contains("THEME_AI"));
    }

    #[test]
    fn saved_weights_inherit_target_taxonomy() {
        let weights = AllocationTargetService::build_domain_weights(
            "target-1",
            "regions",
            vec![NewAllocationTargetWeight {
                category_id: "North_America".to_string(),
                target_bps: 10000,
                is_locked: false,
                is_required: true,
            }],
            "2026-01-01T00:00:00Z",
        );

        assert_eq!(weights.len(), 1);
        assert_eq!(weights[0].target_id, "target-1");
        assert_eq!(weights[0].taxonomy_id, "regions");
        assert_eq!(weights[0].category_id, "North_America");
    }

    #[tokio::test]
    async fn update_target_rejects_taxonomy_change_when_weights_exist() {
        let service = AllocationTargetService::new(
            Arc::new(MockAllocationTargetRepository {
                target: target("asset_classes"),
                weights: vec![saved_weight("asset_classes")],
            }),
            Arc::new(MockTaxonomyService),
        );

        let err = service
            .update_target("target-1", target_input("regions"))
            .await
            .unwrap_err();

        assert!(err
            .to_string()
            .contains("Cannot change taxonomy_id while allocation target weights exist"));
    }

    #[tokio::test]
    async fn update_target_allows_same_taxonomy_when_weights_exist() {
        let service = AllocationTargetService::new(
            Arc::new(MockAllocationTargetRepository {
                target: target("asset_classes"),
                weights: vec![saved_weight("asset_classes")],
            }),
            Arc::new(MockTaxonomyService),
        );

        let updated = service
            .update_target("target-1", target_input("asset_classes"))
            .await
            .unwrap();

        assert_eq!(updated.taxonomy_id, "asset_classes");
        assert_eq!(updated.name, "Updated target");
    }

    #[tokio::test]
    async fn create_target_defaults_band_type_to_hybrid_when_omitted() {
        let service = AllocationTargetService::new(
            Arc::new(MockAllocationTargetRepository {
                target: target("asset_classes"),
                weights: vec![saved_weight("asset_classes")],
            }),
            Arc::new(MockTaxonomyService),
        );

        let mut input = target_input("asset_classes");
        input.band_type = None;

        let created = service.create_target(input).await.unwrap();
        assert_eq!(created.band_type, BandType::Hybrid);
    }

    #[tokio::test]
    async fn save_target_constraints_rewrites_client_target_id() {
        let service = AllocationTargetService::new(
            Arc::new(MockAllocationTargetRepository {
                target: target("asset_classes"),
                weights: vec![],
            }),
            Arc::new(MockTaxonomyService),
        );

        let saved = service
            .save_target_constraints(
                "target-1",
                vec![constraint(
                    ConstraintSubjectType::Asset,
                    ConstraintAction::Sell,
                    ConstraintEffect::Block,
                )],
            )
            .await
            .unwrap();

        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].target_id, "target-1");
    }

    #[tokio::test]
    async fn save_target_constraints_rejects_non_v1_constraint_shape() {
        let service = AllocationTargetService::new(
            Arc::new(MockAllocationTargetRepository {
                target: target("asset_classes"),
                weights: vec![],
            }),
            Arc::new(MockTaxonomyService),
        );

        let cases = vec![
            constraint(
                ConstraintSubjectType::Category,
                ConstraintAction::Sell,
                ConstraintEffect::Block,
            ),
            constraint(
                ConstraintSubjectType::Asset,
                ConstraintAction::Buy,
                ConstraintEffect::Block,
            ),
            constraint(
                ConstraintSubjectType::Asset,
                ConstraintAction::Trade,
                ConstraintEffect::Block,
            ),
            constraint(
                ConstraintSubjectType::Asset,
                ConstraintAction::Sell,
                ConstraintEffect::Avoid,
            ),
        ];

        for invalid in cases {
            let err = service
                .save_target_constraints("target-1", vec![invalid])
                .await
                .unwrap_err();
            assert!(
                err.to_string().contains("sell protection"),
                "unexpected error: {err}"
            );
        }
    }

    #[tokio::test]
    async fn update_target_preserves_existing_band_type_when_omitted() {
        let mut existing = target("asset_classes");
        existing.band_type = BandType::Hybrid;

        let service = AllocationTargetService::new(
            Arc::new(MockAllocationTargetRepository {
                target: existing,
                weights: vec![saved_weight("asset_classes")],
            }),
            Arc::new(MockTaxonomyService),
        );

        let mut input = target_input("asset_classes");
        input.band_type = None;

        let updated = service.update_target("target-1", input).await.unwrap();
        assert_eq!(updated.band_type, BandType::Hybrid);
    }
}
