//! Repository implementation for taxonomies.

use async_trait::async_trait;
use diesel::prelude::*;
use diesel::r2d2::{self, Pool};
use diesel::sql_types::{BigInt, Text};
use diesel::SqliteConnection;
use std::sync::Arc;
use uuid::Uuid;

use wealthfolio_core::taxonomies::{
    AssetTaxonomyAssignment, Category, CategoryReferences, NewAssetTaxonomyAssignment, NewCategory,
    NewTaxonomy, Taxonomy, TaxonomyRepositoryTrait, TaxonomyWithCategories,
    TRANSACTION_CATEGORY_TAXONOMY_IDS,
};
use wealthfolio_core::Result;

use super::model::{
    AssetTaxonomyAssignmentDB, CategoryDB, NewAssetTaxonomyAssignmentDB, NewCategoryDB,
    NewTaxonomyDB, TaxonomyDB,
};
use super::sync;
use crate::db::{get_connection, WriteHandle};
use crate::errors::StorageError;
use crate::schema::{
    allocation_target_weights, asset_taxonomy_assignments, taxonomies, taxonomy_categories,
};

pub struct TaxonomyRepository {
    pool: Arc<Pool<r2d2::ConnectionManager<SqliteConnection>>>,
    writer: WriteHandle,
}

#[derive(QueryableByName)]
struct CategoryReferencesDB {
    #[diesel(sql_type = BigInt)]
    children: i64,
    #[diesel(sql_type = BigInt)]
    asset_assignments: i64,
    #[diesel(sql_type = BigInt)]
    spending_assignments: i64,
    #[diesel(sql_type = BigInt)]
    splits: i64,
    #[diesel(sql_type = BigInt)]
    rules: i64,
    #[diesel(sql_type = BigInt)]
    budget_targets: i64,
    #[diesel(sql_type = BigInt)]
    budget_rollovers: i64,
    #[diesel(sql_type = BigInt)]
    budget_group_assignments: i64,
    #[diesel(sql_type = BigInt)]
    allocation_targets: i64,
    #[diesel(sql_type = BigInt)]
    automatic_budget_links: i64,
}

fn category_references(
    conn: &mut SqliteConnection,
    taxonomy_id: &str,
    category_id: &str,
) -> Result<CategoryReferences> {
    let row = diesel::sql_query(
        "SELECT
            (SELECT COUNT(*) FROM taxonomy_categories WHERE taxonomy_id = ?1 AND parent_id = ?2) AS children,
            (SELECT COUNT(*) FROM asset_taxonomy_assignments WHERE taxonomy_id = ?1 AND category_id = ?2) AS asset_assignments,
            (SELECT COUNT(*) FROM activity_taxonomy_assignments WHERE taxonomy_id = ?1 AND category_id = ?2) AS spending_assignments,
            (SELECT COUNT(*) FROM spending_activity_splits WHERE taxonomy_id = ?1 AND category_id = ?2) AS splits,
            (SELECT COUNT(*) FROM spending_categorization_rules WHERE taxonomy_id = ?1 AND category_id = ?2) AS rules,
            (SELECT COUNT(*) FROM budget_targets WHERE taxonomy_id = ?1 AND category_id = ?2) AS budget_targets,
            (SELECT COUNT(*) FROM budget_rollover_settings WHERE taxonomy_id = ?1 AND category_id = ?2) AS budget_rollovers,
            (SELECT COUNT(*) FROM budget_group_assignments WHERE taxonomy_id = ?1 AND category_id = ?2 AND (is_system = 0 OR updated_at != created_at)) AS budget_group_assignments,
            (SELECT COUNT(*) FROM allocation_target_weights WHERE taxonomy_id = ?1 AND category_id = ?2) AS allocation_targets,
            (SELECT COUNT(*) FROM budget_group_assignments WHERE taxonomy_id = ?1 AND category_id = ?2 AND is_system = 1 AND updated_at = created_at) AS automatic_budget_links"
    ).bind::<Text,_>(taxonomy_id).bind::<Text,_>(category_id).get_result::<CategoryReferencesDB>(conn).map_err(StorageError::from)?;
    Ok(CategoryReferences {
        children: row.children.max(0) as usize,
        asset_assignments: row.asset_assignments.max(0) as usize,
        spending_assignments: row.spending_assignments.max(0) as usize,
        splits: row.splits.max(0) as usize,
        rules: row.rules.max(0) as usize,
        budget_targets: row.budget_targets.max(0) as usize,
        budget_rollovers: row.budget_rollovers.max(0) as usize,
        budget_group_assignments: row.budget_group_assignments.max(0) as usize,
        allocation_targets: row.allocation_targets.max(0) as usize,
        automatic_budget_links: row.automatic_budget_links.max(0) as usize,
    })
}

fn check_expected_category(
    conn: &mut SqliteConnection,
    taxonomy_id: &str,
    category_id: &str,
    expected: Option<&Category>,
) -> Result<()> {
    if let Some(expected) = expected {
        let current = taxonomy_categories::table
            .filter(taxonomy_categories::taxonomy_id.eq(taxonomy_id))
            .filter(taxonomy_categories::id.eq(category_id))
            .first::<CategoryDB>(conn)
            .optional()
            .map_err(StorageError::from)?
            .map(Category::from);
        if current.as_ref() != Some(expected) {
            return Err(wealthfolio_core::errors::ValidationError::InvalidInput(
                "Category changed since review; refresh and review again".to_string(),
            )
            .into());
        }
    }
    Ok(())
}

fn validate_transaction_category_tree(
    conn: &mut SqliteConnection,
    taxonomy_id: &str,
    category_id: &str,
    key: &str,
    parent_id: Option<&str>,
) -> Result<()> {
    if !TRANSACTION_CATEGORY_TAXONOMY_IDS.contains(&taxonomy_id) {
        return Ok(());
    }
    // Legacy imports may contain duplicate keys. Cosmetic edits must not force
    // an unrelated cleanup; only creation or a changed key can add a collision.
    let stored_key = taxonomy_categories::table
        .filter(taxonomy_categories::taxonomy_id.eq(taxonomy_id))
        .filter(taxonomy_categories::id.eq(category_id))
        .select(taxonomy_categories::key)
        .first::<String>(conn)
        .optional()
        .map_err(StorageError::from)?;
    if stored_key.as_deref() != Some(key) {
        let duplicate = diesel::select(diesel::dsl::exists(
            taxonomy_categories::table
                .filter(taxonomy_categories::taxonomy_id.eq(taxonomy_id))
                .filter(taxonomy_categories::key.eq(key))
                .filter(taxonomy_categories::id.ne(category_id)),
        ))
        .get_result::<bool>(conn)
        .map_err(StorageError::from)?;
        if duplicate {
            return Err(wealthfolio_core::errors::DatabaseError::UniqueViolation(
                "A category with this key already exists in the taxonomy".into(),
            )
            .into());
        }
    }
    let mut visited = std::collections::HashSet::from([category_id.to_string()]);
    let mut parent_id = parent_id.map(str::to_string);
    while let Some(parent) = parent_id {
        if !visited.insert(parent.clone()) {
            return Err(wealthfolio_core::errors::ValidationError::InvalidInput(
                "Category hierarchy cannot contain a cycle".into(),
            )
            .into());
        }
        let row = taxonomy_categories::table
            .filter(taxonomy_categories::taxonomy_id.eq(taxonomy_id))
            .filter(taxonomy_categories::id.eq(&parent))
            .first::<CategoryDB>(conn)
            .optional()
            .map_err(StorageError::from)?
            .ok_or_else(|| {
                wealthfolio_core::errors::ValidationError::InvalidInput(
                    "Parent must belong to the same taxonomy".into(),
                )
            })?;
        parent_id = row.parent_id;
    }
    Ok(())
}

impl TaxonomyRepository {
    pub fn new(
        pool: Arc<Pool<r2d2::ConnectionManager<SqliteConnection>>>,
        writer: WriteHandle,
    ) -> Self {
        Self { pool, writer }
    }
    async fn update_with_expectation(
        &self,
        category: Category,
        expected: Option<Category>,
    ) -> Result<Category> {
        let taxonomy_id = category.taxonomy_id.clone();
        let id = category.id.clone();
        self.writer
            .exec_projected(move |conn, projection| -> Result<Category> {
                check_expected_category(conn, &taxonomy_id, &id, expected.as_ref())?;
                validate_transaction_category_tree(
                    conn,
                    &taxonomy_id,
                    &id,
                    &category.key,
                    category.parent_id.as_deref(),
                )?;
                let db = CategoryDB {
                    id: category.id,
                    taxonomy_id: category.taxonomy_id,
                    parent_id: category.parent_id,
                    name: category.name,
                    key: category.key,
                    color: category.color,
                    description: category.description,
                    sort_order: category.sort_order,
                    created_at: category
                        .created_at
                        .format("%Y-%m-%dT%H:%M:%S%.fZ")
                        .to_string(),
                    updated_at: chrono::Utc::now().to_rfc3339(),
                    icon: category.icon,
                };

                diesel::update(
                    taxonomy_categories::table
                        .filter(taxonomy_categories::taxonomy_id.eq(&taxonomy_id))
                        .filter(taxonomy_categories::id.eq(&id)),
                )
                .set(&db)
                .execute(conn)
                .map_err(StorageError::from)?;

                let result = taxonomy_categories::table
                    .filter(taxonomy_categories::taxonomy_id.eq(&taxonomy_id))
                    .filter(taxonomy_categories::id.eq(&id))
                    .first::<CategoryDB>(conn)
                    .map_err(StorageError::from)?;

                // Emit taxonomy.update bundle (category modified)
                sync::queue_custom_taxonomy_bundle(
                    conn,
                    projection,
                    &taxonomy_id,
                    wealthfolio_core::sync::SyncOperation::Update,
                )
                .map_err(StorageError::from)?;

                Ok(Category::from(result))
            })
            .await
    }

    async fn delete_with_expectation(
        &self,
        taxonomy_id: &str,
        category_id: &str,
        expected: Option<Category>,
    ) -> Result<usize> {
        let taxonomy_id = taxonomy_id.to_string();
        let category_id = category_id.to_string();
        self.writer
            .exec_projected(move |conn, projection| -> Result<usize> {
                check_expected_category(conn, &taxonomy_id, &category_id, expected.as_ref())?;
                // Recheck inside the existing writer transaction: read-side
                // service checks cannot protect against a newly inserted reference.
                let refs = category_references(conn, &taxonomy_id, &category_id)?;
                if refs.blocking_count() > 0 {
                    return Err(wealthfolio_core::errors::ValidationError::InvalidInput(
                        "Cannot delete category while user data still references it".to_string(),
                    )
                    .into());
                }
                // Untouched automatic group links have no user data/outbox and
                // their existing FK cascade removes them atomically with the category.
                // Check eligibility before the delete
                let is_custom = sync::is_syncable_taxonomy(conn, &taxonomy_id);

                let affected = diesel::delete(
                    taxonomy_categories::table
                        .filter(taxonomy_categories::taxonomy_id.eq(&taxonomy_id))
                        .filter(taxonomy_categories::id.eq(&category_id)),
                )
                .execute(conn)
                .map_err(StorageError::from)?;

                if affected > 0 && is_custom {
                    // Emit taxonomy.update bundle (category removed)
                    sync::queue_custom_taxonomy_bundle(
                        conn,
                        projection,
                        &taxonomy_id,
                        wealthfolio_core::sync::SyncOperation::Update,
                    )
                    .map_err(StorageError::from)?;
                }

                Ok(affected)
            })
            .await
    }
}

#[async_trait]
impl TaxonomyRepositoryTrait for TaxonomyRepository {
    fn get_category_references(
        &self,
        taxonomy_id: &str,
        category_id: &str,
    ) -> Result<CategoryReferences> {
        let mut conn = get_connection(&self.pool)?;
        category_references(&mut conn, taxonomy_id, category_id)
    }

    fn get_taxonomies(&self) -> Result<Vec<Taxonomy>> {
        let mut conn = get_connection(&self.pool)?;
        let results = taxonomies::table
            .order(taxonomies::sort_order.asc())
            .load::<TaxonomyDB>(&mut conn)
            .map_err(StorageError::from)?;
        Ok(results.into_iter().map(Taxonomy::from).collect())
    }

    fn get_taxonomy(&self, id: &str) -> Result<Option<Taxonomy>> {
        let mut conn = get_connection(&self.pool)?;
        let result = taxonomies::table
            .find(id)
            .first::<TaxonomyDB>(&mut conn)
            .optional()
            .map_err(StorageError::from)?;
        Ok(result.map(Taxonomy::from))
    }

    async fn create_taxonomy(&self, taxonomy: NewTaxonomy) -> Result<Taxonomy> {
        self.writer
            .exec_projected(move |conn, projection| -> Result<Taxonomy> {
                let mut db: NewTaxonomyDB = taxonomy.into();
                db.id = Some(db.id.unwrap_or_else(|| Uuid::new_v4().to_string()));

                let result = diesel::insert_into(taxonomies::table)
                    .values(&db)
                    .returning(TaxonomyDB::as_returning())
                    .get_result(conn)
                    .map_err(StorageError::from)?;

                // Queue sync event (no-op for system taxonomies)
                sync::queue_custom_taxonomy_bundle(
                    conn,
                    projection,
                    &result.id,
                    wealthfolio_core::sync::SyncOperation::Create,
                )
                .map_err(StorageError::from)?;

                Ok(Taxonomy::from(result))
            })
            .await
    }

    async fn update_taxonomy(&self, taxonomy: Taxonomy) -> Result<Taxonomy> {
        let id = taxonomy.id.clone();
        self.writer
            .exec_projected(move |conn, projection| -> Result<Taxonomy> {
                let db = TaxonomyDB {
                    id: taxonomy.id,
                    name: taxonomy.name,
                    color: taxonomy.color,
                    description: taxonomy.description,
                    is_system: if taxonomy.is_system { 1 } else { 0 },
                    is_single_select: if taxonomy.is_single_select { 1 } else { 0 },
                    sort_order: taxonomy.sort_order,
                    created_at: taxonomy
                        .created_at
                        .format("%Y-%m-%dT%H:%M:%S%.fZ")
                        .to_string(),
                    updated_at: chrono::Utc::now().to_rfc3339(),
                    scope: taxonomy.scope,
                };

                diesel::update(taxonomies::table.find(&id))
                    .set(&db)
                    .execute(conn)
                    .map_err(StorageError::from)?;

                let result = taxonomies::table
                    .find(&id)
                    .first::<TaxonomyDB>(conn)
                    .map_err(StorageError::from)?;

                sync::queue_custom_taxonomy_bundle(
                    conn,
                    projection,
                    &id,
                    wealthfolio_core::sync::SyncOperation::Update,
                )
                .map_err(StorageError::from)?;

                Ok(Taxonomy::from(result))
            })
            .await
    }

    async fn delete_taxonomy(&self, id: &str) -> Result<usize> {
        let id = id.to_string();
        self.writer
            .exec_projected(move |conn, projection| -> Result<usize> {
                // Check if custom before deleting (need the row to inspect)
                let is_custom = sync::is_syncable_taxonomy(conn, &id);

                let affected = diesel::delete(taxonomies::table.find(&id))
                    .execute(conn)
                    .map_err(StorageError::from)?;

                if affected > 0 && is_custom {
                    sync::queue_custom_taxonomy_delete(projection, &id);
                }

                Ok(affected)
            })
            .await
    }

    fn get_categories(&self, taxonomy_id: &str) -> Result<Vec<Category>> {
        let mut conn = get_connection(&self.pool)?;
        let results = taxonomy_categories::table
            .filter(taxonomy_categories::taxonomy_id.eq(taxonomy_id))
            .order(taxonomy_categories::sort_order.asc())
            .load::<CategoryDB>(&mut conn)
            .map_err(StorageError::from)?;
        Ok(results.into_iter().map(Category::from).collect())
    }

    fn get_category(&self, taxonomy_id: &str, category_id: &str) -> Result<Option<Category>> {
        let mut conn = get_connection(&self.pool)?;
        let result = taxonomy_categories::table
            .filter(taxonomy_categories::taxonomy_id.eq(taxonomy_id))
            .filter(taxonomy_categories::id.eq(category_id))
            .first::<CategoryDB>(&mut conn)
            .optional()
            .map_err(StorageError::from)?;
        Ok(result.map(Category::from))
    }

    fn get_category_spending_reference_count(
        &self,
        taxonomy_id: &str,
        category_id: &str,
    ) -> Result<usize> {
        let refs = self.get_category_references(taxonomy_id, category_id)?;
        Ok(refs.spending_assignments
            + refs.splits
            + refs.rules
            + refs.budget_targets
            + refs.budget_rollovers
            + refs.budget_group_assignments)
    }

    fn get_category_allocation_target_weight_count(
        &self,
        taxonomy_id: &str,
        category_id: &str,
    ) -> Result<usize> {
        let mut conn = get_connection(&self.pool)?;
        let count = allocation_target_weights::table
            .filter(allocation_target_weights::taxonomy_id.eq(taxonomy_id))
            .filter(allocation_target_weights::category_id.eq(category_id))
            .count()
            .get_result::<i64>(&mut conn)
            .map_err(StorageError::from)?;
        Ok(count.max(0) as usize)
    }

    async fn create_category(&self, category: NewCategory) -> Result<Category> {
        self.writer
            .exec_projected(move |conn, projection| -> Result<Category> {
                let taxonomy_id = category.taxonomy_id.clone();
                let mut db: NewCategoryDB = category.into();
                db.id = Some(db.id.unwrap_or_else(|| Uuid::new_v4().to_string()));
                validate_transaction_category_tree(
                    conn,
                    &taxonomy_id,
                    db.id.as_deref().expect("category ID assigned above"),
                    &db.key,
                    db.parent_id.as_deref(),
                )?;

                let result = diesel::insert_into(taxonomy_categories::table)
                    .values(&db)
                    .returning(CategoryDB::as_returning())
                    .get_result(conn)
                    .map_err(StorageError::from)?;

                // Emit taxonomy.update bundle (category added)
                sync::queue_custom_taxonomy_bundle(
                    conn,
                    projection,
                    &taxonomy_id,
                    wealthfolio_core::sync::SyncOperation::Update,
                )
                .map_err(StorageError::from)?;

                Ok(Category::from(result))
            })
            .await
    }

    async fn update_category(&self, category: Category) -> Result<Category> {
        self.update_with_expectation(category, None).await
    }
    async fn update_category_reviewed(
        &self,
        expected: Category,
        category: Category,
    ) -> Result<Category> {
        self.update_with_expectation(category, Some(expected)).await
    }
    async fn delete_category(&self, taxonomy_id: &str, category_id: &str) -> Result<usize> {
        self.delete_with_expectation(taxonomy_id, category_id, None)
            .await
    }
    async fn delete_category_reviewed(&self, expected: Category) -> Result<usize> {
        let taxonomy_id = expected.taxonomy_id.clone();
        let category_id = expected.id.clone();
        self.delete_with_expectation(&taxonomy_id, &category_id, Some(expected))
            .await
    }

    async fn bulk_create_categories(&self, categories: Vec<NewCategory>) -> Result<usize> {
        self.writer
            .exec_projected(move |conn, projection| -> Result<usize> {
                let mut count = 0;
                let mut taxonomy_id_for_sync: Option<String> = None;
                for cat in categories {
                    if taxonomy_id_for_sync.is_none() {
                        taxonomy_id_for_sync = Some(cat.taxonomy_id.clone());
                    }
                    let mut db: NewCategoryDB = cat.into();
                    db.id = Some(db.id.unwrap_or_else(|| Uuid::new_v4().to_string()));

                    diesel::insert_into(taxonomy_categories::table)
                        .values(&db)
                        .execute(conn)
                        .map_err(StorageError::from)?;
                    count += 1;
                }

                // Emit one taxonomy.update bundle after all categories are inserted
                if let Some(tid) = taxonomy_id_for_sync {
                    sync::queue_custom_taxonomy_bundle(
                        conn,
                        projection,
                        &tid,
                        wealthfolio_core::sync::SyncOperation::Update,
                    )
                    .map_err(StorageError::from)?;
                }

                Ok(count)
            })
            .await
    }

    fn get_asset_assignments(&self, asset_id: &str) -> Result<Vec<AssetTaxonomyAssignment>> {
        let mut conn = get_connection(&self.pool)?;
        let results = asset_taxonomy_assignments::table
            .filter(asset_taxonomy_assignments::asset_id.eq(asset_id))
            .order((
                asset_taxonomy_assignments::asset_id.asc(),
                asset_taxonomy_assignments::taxonomy_id.asc(),
                asset_taxonomy_assignments::category_id.asc(),
                asset_taxonomy_assignments::id.asc(),
            ))
            .load::<AssetTaxonomyAssignmentDB>(&mut conn)
            .map_err(StorageError::from)?;
        Ok(results
            .into_iter()
            .map(AssetTaxonomyAssignment::from)
            .collect())
    }

    fn get_asset_assignments_for_assets(
        &self,
        asset_ids: &[String],
    ) -> Result<Vec<AssetTaxonomyAssignment>> {
        if asset_ids.is_empty() {
            return Ok(Vec::new());
        }

        let mut conn = get_connection(&self.pool)?;
        let results = asset_taxonomy_assignments::table
            .filter(asset_taxonomy_assignments::asset_id.eq_any(asset_ids))
            .order((
                asset_taxonomy_assignments::asset_id.asc(),
                asset_taxonomy_assignments::taxonomy_id.asc(),
                asset_taxonomy_assignments::category_id.asc(),
                asset_taxonomy_assignments::id.asc(),
            ))
            .load::<AssetTaxonomyAssignmentDB>(&mut conn)
            .map_err(StorageError::from)?;
        Ok(results
            .into_iter()
            .map(AssetTaxonomyAssignment::from)
            .collect())
    }

    fn get_category_assignments(
        &self,
        taxonomy_id: &str,
        category_id: &str,
    ) -> Result<Vec<AssetTaxonomyAssignment>> {
        let mut conn = get_connection(&self.pool)?;
        let results = asset_taxonomy_assignments::table
            .filter(asset_taxonomy_assignments::taxonomy_id.eq(taxonomy_id))
            .filter(asset_taxonomy_assignments::category_id.eq(category_id))
            .load::<AssetTaxonomyAssignmentDB>(&mut conn)
            .map_err(StorageError::from)?;
        Ok(results
            .into_iter()
            .map(AssetTaxonomyAssignment::from)
            .collect())
    }

    async fn upsert_assignment(
        &self,
        assignment: NewAssetTaxonomyAssignment,
    ) -> Result<AssetTaxonomyAssignment> {
        self.writer
            .exec_tx(move |tx| -> Result<AssetTaxonomyAssignment> {
                let mut db: NewAssetTaxonomyAssignmentDB = assignment.into();
                db.id = Some(db.id.unwrap_or_else(|| Uuid::new_v4().to_string()));

                let result = diesel::insert_into(asset_taxonomy_assignments::table)
                    .values(&db)
                    .on_conflict((
                        asset_taxonomy_assignments::asset_id,
                        asset_taxonomy_assignments::taxonomy_id,
                        asset_taxonomy_assignments::category_id,
                    ))
                    .do_update()
                    .set((
                        asset_taxonomy_assignments::weight.eq(&db.weight),
                        asset_taxonomy_assignments::source.eq(&db.source),
                    ))
                    .returning(AssetTaxonomyAssignmentDB::as_returning())
                    .get_result(tx.conn())
                    .map_err(StorageError::from)?;

                tx.update(&result)?;

                Ok(AssetTaxonomyAssignment::from(result))
            })
            .await
    }

    async fn replace_asset_assignments(
        &self,
        asset_id: &str,
        taxonomy_id: &str,
        assignments: Vec<NewAssetTaxonomyAssignment>,
    ) -> Result<Vec<AssetTaxonomyAssignment>> {
        let asset_id = asset_id.to_string();
        let taxonomy_id = taxonomy_id.to_string();
        self.writer
            .exec_tx(move |tx| -> Result<Vec<AssetTaxonomyAssignment>> {
                let existing_ids = asset_taxonomy_assignments::table
                    .filter(asset_taxonomy_assignments::asset_id.eq(&asset_id))
                    .filter(asset_taxonomy_assignments::taxonomy_id.eq(&taxonomy_id))
                    .select(asset_taxonomy_assignments::id)
                    .load::<String>(tx.conn())
                    .map_err(StorageError::from)?;

                diesel::delete(
                    asset_taxonomy_assignments::table
                        .filter(asset_taxonomy_assignments::asset_id.eq(&asset_id))
                        .filter(asset_taxonomy_assignments::taxonomy_id.eq(&taxonomy_id)),
                )
                .execute(tx.conn())
                .map_err(StorageError::from)?;

                for assignment_id in existing_ids {
                    tx.delete::<AssetTaxonomyAssignmentDB>(assignment_id);
                }

                let mut replaced = Vec::with_capacity(assignments.len());
                for assignment in assignments {
                    let mut db: NewAssetTaxonomyAssignmentDB = assignment.into();
                    db.id = Some(db.id.unwrap_or_else(|| Uuid::new_v4().to_string()));

                    let result = diesel::insert_into(asset_taxonomy_assignments::table)
                        .values(&db)
                        .returning(AssetTaxonomyAssignmentDB::as_returning())
                        .get_result(tx.conn())
                        .map_err(StorageError::from)?;

                    tx.update(&result)?;
                    replaced.push(AssetTaxonomyAssignment::from(result));
                }

                Ok(replaced)
            })
            .await
    }

    async fn delete_assignment(&self, id: &str) -> Result<usize> {
        let id = id.to_string();
        self.writer
            .exec_tx(move |tx| -> Result<usize> {
                let affected = diesel::delete(asset_taxonomy_assignments::table.find(&id))
                    .execute(tx.conn())
                    .map_err(StorageError::from)?;
                if affected > 0 {
                    tx.delete::<AssetTaxonomyAssignmentDB>(id.clone());
                }
                Ok(affected)
            })
            .await
    }

    async fn delete_asset_assignments(&self, asset_id: &str, taxonomy_id: &str) -> Result<usize> {
        let asset_id = asset_id.to_string();
        let taxonomy_id = taxonomy_id.to_string();
        self.writer
            .exec_tx(move |tx| -> Result<usize> {
                let existing_ids = asset_taxonomy_assignments::table
                    .filter(asset_taxonomy_assignments::asset_id.eq(&asset_id))
                    .filter(asset_taxonomy_assignments::taxonomy_id.eq(&taxonomy_id))
                    .select(asset_taxonomy_assignments::id)
                    .load::<String>(tx.conn())
                    .map_err(StorageError::from)?;

                let affected = diesel::delete(
                    asset_taxonomy_assignments::table
                        .filter(asset_taxonomy_assignments::asset_id.eq(&asset_id))
                        .filter(asset_taxonomy_assignments::taxonomy_id.eq(&taxonomy_id)),
                )
                .execute(tx.conn())
                .map_err(StorageError::from)?;

                for assignment_id in existing_ids {
                    tx.delete::<AssetTaxonomyAssignmentDB>(assignment_id.clone());
                }

                Ok(affected)
            })
            .await
    }

    fn get_taxonomy_with_categories(&self, id: &str) -> Result<Option<TaxonomyWithCategories>> {
        let taxonomy = self.get_taxonomy(id)?;
        match taxonomy {
            Some(t) => {
                let categories = self.get_categories(id)?;
                Ok(Some(TaxonomyWithCategories {
                    taxonomy: t,
                    categories,
                }))
            }
            None => Ok(None),
        }
    }

    fn get_all_taxonomies_with_categories(&self) -> Result<Vec<TaxonomyWithCategories>> {
        let taxonomies = self.get_taxonomies()?;
        let mut results = Vec::new();
        for t in taxonomies {
            let categories = self.get_categories(&t.id)?;
            results.push(TaxonomyWithCategories {
                taxonomy: t,
                categories,
            });
        }
        Ok(results)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{create_pool, init, run_migrations, write_actor::spawn_writer};
    use tempfile::tempdir;

    fn setup_repo() -> TaxonomyRepository {
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
        TaxonomyRepository::new(pool, writer)
    }

    async fn create(repo: &TaxonomyRepository, key: &str, parent_id: Option<String>) -> Category {
        repo.create_category(NewCategory {
            taxonomy_id: "spending_categories".to_string(),
            parent_id,
            name: key.to_string(),
            key: key.to_string(),
            color: "#808080".to_string(),
            ..Default::default()
        })
        .await
        .expect("create category")
    }

    #[tokio::test]
    async fn update_category_moves_a_child_to_the_top_level() {
        let repo = setup_repo();
        let parent = create(&repo, "test_parent", None).await;
        let child = create(&repo, "test_child", Some(parent.id.clone())).await;

        let updated = repo
            .update_category(Category {
                parent_id: None,
                ..child
            })
            .await
            .expect("update category");

        assert_eq!(updated.parent_id, None);
        let stored = repo
            .get_category(&updated.taxonomy_id, &updated.id)
            .expect("get category")
            .expect("category exists");
        assert_eq!(stored.parent_id, None);
    }
}
