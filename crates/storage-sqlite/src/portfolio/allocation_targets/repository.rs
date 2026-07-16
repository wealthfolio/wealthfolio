use async_trait::async_trait;
use diesel::prelude::*;
use diesel::r2d2::{ConnectionManager, Pool};
use diesel::sqlite::SqliteConnection;
use std::collections::HashSet;
use std::sync::Arc;

use super::model::{AllocationTargetConstraintDB, AllocationTargetDB, AllocationTargetWeightDB};
use crate::db::{get_connection, WriteHandle};
use crate::errors::StorageError;
use crate::schema::{allocation_target_weights, allocation_targets};
use wealthfolio_core::errors::Result;
use wealthfolio_core::portfolio::allocation_targets::{
    AllocationTarget, AllocationTargetRepositoryTrait, AllocationTargetWeight,
    SaveAllocationTargetResult,
};

pub struct AllocationTargetRepository {
    pool: Arc<Pool<ConnectionManager<SqliteConnection>>>,
    writer: WriteHandle,
}

impl AllocationTargetRepository {
    pub fn new(pool: Arc<Pool<ConnectionManager<SqliteConnection>>>, writer: WriteHandle) -> Self {
        Self { pool, writer }
    }

    fn map_targets(rows: Vec<AllocationTargetDB>) -> Result<Vec<AllocationTarget>> {
        rows.into_iter()
            .map(|db| {
                AllocationTarget::try_from(db).map_err(|e| {
                    wealthfolio_core::errors::Error::Validation(
                        wealthfolio_core::errors::ValidationError::InvalidInput(e),
                    )
                })
            })
            .collect()
    }
}

#[async_trait]
impl AllocationTargetRepositoryTrait for AllocationTargetRepository {
    fn get_target(&self, id: &str) -> Result<Option<AllocationTarget>> {
        let conn = &mut get_connection(&self.pool)?;
        let row = allocation_targets::table
            .filter(allocation_targets::id.eq(id))
            .first::<AllocationTargetDB>(conn)
            .optional()
            .map_err(StorageError::from)?;
        row.map(AllocationTarget::try_from)
            .transpose()
            .map_err(|e| {
                wealthfolio_core::errors::Error::Validation(
                    wealthfolio_core::errors::ValidationError::InvalidInput(e),
                )
            })
    }

    fn list_targets(&self) -> Result<Vec<AllocationTarget>> {
        let conn = &mut get_connection(&self.pool)?;
        let rows = allocation_targets::table
            .order(allocation_targets::created_at.asc())
            .load::<AllocationTargetDB>(conn)
            .map_err(StorageError::from)?;
        Self::map_targets(rows)
    }

    fn list_weights_for_target(&self, target_id: &str) -> Result<Vec<AllocationTargetWeight>> {
        let conn = &mut get_connection(&self.pool)?;
        let rows = allocation_target_weights::table
            .filter(allocation_target_weights::target_id.eq(target_id))
            .order(allocation_target_weights::created_at.asc())
            .load::<AllocationTargetWeightDB>(conn)
            .map_err(StorageError::from)?;
        Ok(rows.into_iter().map(AllocationTargetWeight::from).collect())
    }

    async fn create_target(&self, target: AllocationTarget) -> Result<AllocationTarget> {
        let db = AllocationTargetDB::from(target);
        let id = db.id.clone();
        self.writer
            .exec_tx(move |tx| {
                diesel::insert_into(allocation_targets::table)
                    .values(&db)
                    .execute(tx.conn())
                    .map_err(StorageError::from)?;
                tx.insert(&db)?;
                Ok(())
            })
            .await?;
        self.get_target(&id)?.ok_or_else(|| {
            wealthfolio_core::errors::Error::Database(
                wealthfolio_core::errors::DatabaseError::NotFound(format!(
                    "AllocationTarget {} not found",
                    id
                )),
            )
        })
    }

    async fn update_target(&self, target: AllocationTarget) -> Result<AllocationTarget> {
        let id = target.id.clone();
        let db = AllocationTargetDB::from(target);
        self.writer
            .exec_tx(move |tx| {
                let affected = diesel::update(
                    allocation_targets::table.filter(allocation_targets::id.eq(&db.id)),
                )
                .set(&db)
                .execute(tx.conn())
                .map_err(StorageError::from)?;
                if affected > 0 {
                    tx.update(&db)?;
                }
                Ok(())
            })
            .await?;
        self.get_target(&id)?.ok_or_else(|| {
            wealthfolio_core::errors::Error::Database(
                wealthfolio_core::errors::DatabaseError::NotFound(format!(
                    "AllocationTarget {} not found",
                    id
                )),
            )
        })
    }

    async fn delete_target(&self, id: &str) -> Result<usize> {
        let id_owned = id.to_string();
        self.writer
            .exec_tx(move |tx| {
                let existing_target = allocation_targets::table
                    .filter(allocation_targets::id.eq(&id_owned))
                    .first::<AllocationTargetDB>(tx.conn())
                    .optional()
                    .map_err(StorageError::from)?;
                let existing_weight_ids = allocation_target_weights::table
                    .filter(allocation_target_weights::target_id.eq(&id_owned))
                    .select(allocation_target_weights::id)
                    .load::<String>(tx.conn())
                    .map_err(StorageError::from)?;

                let n = diesel::delete(
                    allocation_targets::table.filter(allocation_targets::id.eq(&id_owned)),
                )
                .execute(tx.conn())
                .map_err(StorageError::from)?;
                if n > 0 {
                    for weight_id in existing_weight_ids {
                        tx.delete::<AllocationTargetWeightDB>(weight_id);
                    }
                    if let Some(target) = existing_target {
                        tx.delete_model(&target);
                    }
                }
                Ok(n)
            })
            .await
    }

    async fn save_weights(
        &self,
        target_id: &str,
        weights: Vec<AllocationTargetWeight>,
    ) -> Result<Vec<AllocationTargetWeight>> {
        let target_id_owned = target_id.to_string();
        let db_weights: Vec<AllocationTargetWeightDB> = weights
            .into_iter()
            .map(AllocationTargetWeightDB::from)
            .collect();

        self.writer
            .exec_tx(move |tx| {
                let existing_ids = allocation_target_weights::table
                    .filter(allocation_target_weights::target_id.eq(&target_id_owned))
                    .select(allocation_target_weights::id)
                    .load::<String>(tx.conn())
                    .map_err(StorageError::from)?
                    .into_iter()
                    .collect::<HashSet<_>>();
                let incoming_ids = db_weights
                    .iter()
                    .map(|weight| weight.id.clone())
                    .collect::<HashSet<_>>();

                // Replace all weights for this target atomically.
                diesel::delete(
                    allocation_target_weights::table
                        .filter(allocation_target_weights::target_id.eq(&target_id_owned)),
                )
                .execute(tx.conn())
                .map_err(StorageError::from)?;

                if !db_weights.is_empty() {
                    diesel::insert_into(allocation_target_weights::table)
                        .values(&db_weights)
                        .execute(tx.conn())
                        .map_err(StorageError::from)?;
                }

                for old_id in existing_ids.difference(&incoming_ids) {
                    tx.delete::<AllocationTargetWeightDB>(old_id.clone());
                }
                for weight in &db_weights {
                    if existing_ids.contains(&weight.id) {
                        tx.update(weight)?;
                    } else {
                        tx.insert(weight)?;
                    }
                }
                Ok(())
            })
            .await?;

        self.list_weights_for_target(target_id)
    }

    async fn save_target_with_weights(
        &self,
        target: AllocationTarget,
        weights: Vec<AllocationTargetWeight>,
    ) -> Result<SaveAllocationTargetResult> {
        let target_db = AllocationTargetDB::from(target);
        let target_id = target_db.id.clone();
        let db_weights: Vec<AllocationTargetWeightDB> = weights
            .into_iter()
            .map(AllocationTargetWeightDB::from)
            .collect();

        self.writer
            .exec_tx({
                let target_id = target_id.clone();
                move |tx| {
                    let existing_weight_ids = allocation_target_weights::table
                        .filter(allocation_target_weights::target_id.eq(&target_id))
                        .select(allocation_target_weights::id)
                        .load::<String>(tx.conn())
                        .map_err(StorageError::from)?
                        .into_iter()
                        .collect::<HashSet<_>>();
                    let incoming_weight_ids = db_weights
                        .iter()
                        .map(|weight| weight.id.clone())
                        .collect::<HashSet<_>>();

                    diesel::delete(
                        allocation_target_weights::table
                            .filter(allocation_target_weights::target_id.eq(&target_id)),
                    )
                    .execute(tx.conn())
                    .map_err(StorageError::from)?;

                    for old_id in existing_weight_ids.difference(&incoming_weight_ids) {
                        tx.delete::<AllocationTargetWeightDB>(old_id.clone());
                    }

                    let updated = diesel::update(
                        allocation_targets::table.filter(allocation_targets::id.eq(&target_id)),
                    )
                    .set(&target_db)
                    .execute(tx.conn())
                    .map_err(StorageError::from)?;

                    if updated == 0 {
                        diesel::insert_into(allocation_targets::table)
                            .values(&target_db)
                            .execute(tx.conn())
                            .map_err(StorageError::from)?;
                        tx.insert(&target_db)?;
                    } else {
                        tx.update(&target_db)?;
                    }

                    if !db_weights.is_empty() {
                        diesel::insert_into(allocation_target_weights::table)
                            .values(&db_weights)
                            .execute(tx.conn())
                            .map_err(StorageError::from)?;
                    }

                    for weight in &db_weights {
                        if existing_weight_ids.contains(&weight.id) {
                            tx.update(weight)?;
                        } else {
                            tx.insert(weight)?;
                        }
                    }
                    Ok(())
                }
            })
            .await?;

        let target = self.get_target(&target_id)?.ok_or_else(|| {
            wealthfolio_core::errors::Error::Database(
                wealthfolio_core::errors::DatabaseError::NotFound(format!(
                    "AllocationTarget {} not found",
                    target_id
                )),
            )
        })?;
        let weights = self.list_weights_for_target(&target_id)?;
        Ok(SaveAllocationTargetResult { target, weights })
    }

    fn list_target_constraints(
        &self,
        target_id: &str,
    ) -> Result<Vec<wealthfolio_core::portfolio::allocation_targets::AllocationTargetConstraint>>
    {
        use crate::schema::allocation_target_constraints;
        let conn = &mut get_connection(&self.pool)?;
        let rows = allocation_target_constraints::table
            .filter(allocation_target_constraints::target_id.eq(target_id))
            .order(allocation_target_constraints::created_at.asc())
            .load::<AllocationTargetConstraintDB>(conn)
            .map_err(StorageError::from)?;
        rows.into_iter()
            .map(|db| {
                let subject_type =
                    wealthfolio_core::portfolio::allocation_targets::ConstraintSubjectType::try_from(
                        db.subject_type.as_str(),
                    )
                    .map_err(|e| {
                        wealthfolio_core::errors::Error::Validation(
                            wealthfolio_core::errors::ValidationError::InvalidInput(e),
                        )
                    })?;
                let action =
                    wealthfolio_core::portfolio::allocation_targets::ConstraintAction::try_from(
                        db.action.as_str(),
                    )
                    .map_err(|e| {
                        wealthfolio_core::errors::Error::Validation(
                            wealthfolio_core::errors::ValidationError::InvalidInput(e),
                        )
                    })?;
                let effect =
                    wealthfolio_core::portfolio::allocation_targets::ConstraintEffect::try_from(
                        db.effect.as_str(),
                    )
                    .map_err(|e| {
                        wealthfolio_core::errors::Error::Validation(
                            wealthfolio_core::errors::ValidationError::InvalidInput(e),
                        )
                    })?;
                Ok(
                    wealthfolio_core::portfolio::allocation_targets::AllocationTargetConstraint {
                        id: db.id,
                        target_id: db.target_id,
                        subject_type,
                        subject_id: db.subject_id,
                        action,
                        effect,
                        reason: db.reason,
                        metadata_json: db.metadata_json,
                        created_at: db.created_at,
                        updated_at: db.updated_at,
                    },
                )
            })
            .collect()
    }

    async fn save_target_constraints(
        &self,
        target_id: &str,
        constraints: Vec<
            wealthfolio_core::portfolio::allocation_targets::AllocationTargetConstraint,
        >,
    ) -> Result<Vec<wealthfolio_core::portfolio::allocation_targets::AllocationTargetConstraint>>
    {
        use crate::schema::allocation_target_constraints;
        let target_id_owned = target_id.to_string();
        let row_target_id = target_id_owned.clone();
        let db_rows: Vec<AllocationTargetConstraintDB> = constraints
            .iter()
            .map(|c| AllocationTargetConstraintDB {
                id: c.id.clone(),
                target_id: row_target_id.clone(),
                subject_type: c.subject_type.as_str().to_string(),
                subject_id: c.subject_id.clone(),
                action: c.action.as_str().to_string(),
                effect: c.effect.as_str().to_string(),
                reason: c.reason.clone(),
                metadata_json: c.metadata_json.clone(),
                created_at: c.created_at.clone(),
                updated_at: c.updated_at.clone(),
            })
            .collect();

        self.writer
            .exec_tx(move |tx| {
                let existing_ids = allocation_target_constraints::table
                    .filter(allocation_target_constraints::target_id.eq(&target_id_owned))
                    .select(allocation_target_constraints::id)
                    .load::<String>(tx.conn())
                    .map_err(StorageError::from)?
                    .into_iter()
                    .collect::<HashSet<_>>();
                let incoming_ids: HashSet<String> = db_rows.iter().map(|r| r.id.clone()).collect();

                diesel::delete(
                    allocation_target_constraints::table
                        .filter(allocation_target_constraints::target_id.eq(&target_id_owned)),
                )
                .execute(tx.conn())
                .map_err(StorageError::from)?;

                if !db_rows.is_empty() {
                    diesel::insert_into(allocation_target_constraints::table)
                        .values(&db_rows)
                        .execute(tx.conn())
                        .map_err(StorageError::from)?;
                }

                for old_id in existing_ids.difference(&incoming_ids) {
                    tx.delete::<AllocationTargetConstraintDB>(old_id.clone());
                }
                for row in &db_rows {
                    if existing_ids.contains(&row.id) {
                        tx.update(row)?;
                    } else {
                        tx.insert(row)?;
                    }
                }
                Ok(())
            })
            .await?;

        self.list_target_constraints(target_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{create_pool, init, run_migrations, write_actor::spawn_writer};
    use crate::schema::sync_outbox;
    use crate::taxonomies::TaxonomyRepository;
    use diesel::dsl::count_star;
    use tempfile::tempdir;
    use wealthfolio_core::portfolio::allocation_targets::{
        AllocationTargetConstraint, BandType, ConstraintAction, ConstraintEffect,
        ConstraintSubjectType, RebalanceGoal, ScopeType, TriggerType,
    };
    use wealthfolio_core::taxonomies::TaxonomyRepositoryTrait;

    fn setup_repos() -> (AllocationTargetRepository, TaxonomyRepository) {
        std::env::set_var("CONNECT_API_URL", "http://test.local");
        let app_data = tempdir()
            .expect("tempdir")
            .keep()
            .to_string_lossy()
            .to_string();
        let db_path = init(&app_data).expect("init db");
        run_migrations(&db_path).expect("migrate db");
        let pool = create_pool(&db_path).expect("create pool");
        let writer = spawn_writer(pool.as_ref().clone()).expect("spawn writer");
        (
            AllocationTargetRepository::new(pool.clone(), writer.clone()),
            TaxonomyRepository::new(pool, writer),
        )
    }

    fn setup_repo() -> AllocationTargetRepository {
        setup_repos().0
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

    fn weight(taxonomy_id: &str, category_id: &str) -> AllocationTargetWeight {
        AllocationTargetWeight {
            id: format!("weight-{taxonomy_id}-{category_id}"),
            target_id: "target-1".to_string(),
            taxonomy_id: taxonomy_id.to_string(),
            category_id: category_id.to_string(),
            target_bps: 10000,
            is_locked: false,
            is_required: true,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
        }
    }

    fn constraint(id: &str, target_id: &str) -> AllocationTargetConstraint {
        AllocationTargetConstraint {
            id: id.to_string(),
            target_id: target_id.to_string(),
            subject_type: ConstraintSubjectType::Asset,
            subject_id: "asset-1".to_string(),
            action: ConstraintAction::Sell,
            effect: ConstraintEffect::Block,
            reason: None,
            metadata_json: None,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
        }
    }

    fn outbox_rows(repo: &AllocationTargetRepository) -> Vec<(String, String, String)> {
        let conn = &mut get_connection(&repo.pool).expect("conn");
        sync_outbox::table
            .select((sync_outbox::entity, sync_outbox::entity_id, sync_outbox::op))
            .order(sync_outbox::created_at.asc())
            .load::<(String, String, String)>(conn)
            .expect("load outbox")
    }

    fn outbox_count(repo: &AllocationTargetRepository) -> i64 {
        let conn = &mut get_connection(&repo.pool).expect("conn");
        sync_outbox::table
            .select(count_star())
            .first::<i64>(conn)
            .expect("count outbox")
    }

    #[tokio::test]
    async fn save_weights_persists_weight_taxonomy_id() {
        let repo = setup_repo();
        repo.create_target(target("asset_classes")).await.unwrap();

        let saved = repo
            .save_weights("target-1", vec![weight("asset_classes", "CASH")])
            .await
            .unwrap();

        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].taxonomy_id, "asset_classes");
        assert_eq!(saved[0].category_id, "CASH");
    }

    #[tokio::test]
    async fn save_target_constraints_uses_route_target_id() {
        let repo = setup_repo();
        repo.create_target(target("asset_classes")).await.unwrap();
        let mut other = target("asset_classes");
        other.id = "target-2".to_string();
        repo.create_target(other).await.unwrap();

        let saved = repo
            .save_target_constraints("target-1", vec![constraint("constraint-1", "target-2")])
            .await
            .unwrap();

        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].target_id, "target-1");
        assert!(repo.list_target_constraints("target-2").unwrap().is_empty());
    }

    #[tokio::test]
    async fn save_weights_rejects_category_from_another_taxonomy() {
        let repo = setup_repo();
        repo.create_target(target("asset_classes")).await.unwrap();

        let err = repo
            .save_weights("target-1", vec![weight("regions", "R10")])
            .await
            .unwrap_err();

        assert!(err
            .to_string()
            .contains("allocation_target_weights.taxonomy_id must match"));
    }

    #[tokio::test]
    async fn update_target_rejects_taxonomy_change_when_weights_exist() {
        let repo = setup_repo();
        repo.create_target(target("asset_classes")).await.unwrap();
        repo.save_weights("target-1", vec![weight("asset_classes", "CASH")])
            .await
            .unwrap();

        let err = repo.update_target(target("regions")).await.unwrap_err();

        assert!(err
            .to_string()
            .contains("allocation_targets.taxonomy_id cannot change while weights exist"));
    }

    #[tokio::test]
    async fn save_target_with_weights_allows_taxonomy_change_with_replacement_weights() {
        let repo = setup_repo();
        repo.create_target(target("asset_classes")).await.unwrap();
        repo.save_weights("target-1", vec![weight("asset_classes", "CASH")])
            .await
            .unwrap();

        let saved = repo
            .save_target_with_weights(target("regions"), vec![weight("regions", "R10")])
            .await
            .unwrap();

        assert_eq!(saved.target.taxonomy_id, "regions");
        assert_eq!(saved.weights.len(), 1);
        assert_eq!(saved.weights[0].taxonomy_id, "regions");
        assert_eq!(saved.weights[0].category_id, "R10");
    }

    #[tokio::test]
    async fn save_target_with_weights_orders_child_deletes_before_target_update() {
        let repo = setup_repo();
        repo.create_target(target("asset_classes")).await.unwrap();
        repo.save_weights("target-1", vec![weight("asset_classes", "CASH")])
            .await
            .unwrap();

        repo.save_target_with_weights(target("regions"), vec![weight("regions", "R10")])
            .await
            .unwrap();

        assert_eq!(
            outbox_rows(&repo),
            vec![
                (
                    "allocation_target".to_string(),
                    "target-1".to_string(),
                    "create".to_string()
                ),
                (
                    "allocation_target_weight".to_string(),
                    "weight-asset_classes-CASH".to_string(),
                    "create".to_string()
                ),
                (
                    "allocation_target_weight".to_string(),
                    "weight-asset_classes-CASH".to_string(),
                    "delete".to_string()
                ),
                (
                    "allocation_target".to_string(),
                    "target-1".to_string(),
                    "update".to_string()
                ),
                (
                    "allocation_target_weight".to_string(),
                    "weight-regions-R10".to_string(),
                    "create".to_string()
                ),
            ]
        );
    }

    #[tokio::test]
    async fn taxonomy_reference_count_includes_allocation_target_weights() {
        let (target_repo, taxonomy_repo) = setup_repos();
        target_repo
            .create_target(target("asset_classes"))
            .await
            .unwrap();
        target_repo
            .save_weights("target-1", vec![weight("asset_classes", "CASH")])
            .await
            .unwrap();

        let count = taxonomy_repo
            .get_category_allocation_target_weight_count("asset_classes", "CASH")
            .unwrap();

        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn create_target_writes_sync_outbox() {
        let repo = setup_repo();

        repo.create_target(target("asset_classes")).await.unwrap();

        assert_eq!(
            outbox_rows(&repo),
            vec![(
                "allocation_target".to_string(),
                "target-1".to_string(),
                "create".to_string()
            )]
        );
    }

    #[tokio::test]
    async fn save_weights_writes_create_and_delete_outbox() {
        let repo = setup_repo();
        repo.create_target(target("asset_classes")).await.unwrap();

        repo.save_weights("target-1", vec![weight("asset_classes", "CASH")])
            .await
            .unwrap();
        repo.save_weights("target-1", vec![]).await.unwrap();

        let rows = outbox_rows(&repo);
        assert!(rows.contains(&(
            "allocation_target_weight".to_string(),
            "weight-asset_classes-CASH".to_string(),
            "create".to_string()
        )));
        assert!(rows.contains(&(
            "allocation_target_weight".to_string(),
            "weight-asset_classes-CASH".to_string(),
            "delete".to_string()
        )));
        assert_eq!(outbox_count(&repo), 3);
    }
}
