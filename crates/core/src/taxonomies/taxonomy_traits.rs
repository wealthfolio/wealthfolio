//! Traits for taxonomy repository and service.

use async_trait::async_trait;

use crate::Result;

use super::{
    AssetTaxonomyAssignment, Category, NewAssetTaxonomyAssignment, NewCategory, NewTaxonomy,
    Taxonomy, TaxonomyWithCategories,
};

/// Repository trait for taxonomy persistence operations.
#[async_trait]
pub trait TaxonomyRepositoryTrait: Send + Sync {
    // Taxonomy operations
    fn get_taxonomies(&self) -> Result<Vec<Taxonomy>>;
    fn get_taxonomy(&self, id: &str) -> Result<Option<Taxonomy>>;
    async fn create_taxonomy(&self, taxonomy: NewTaxonomy) -> Result<Taxonomy>;
    async fn update_taxonomy(&self, taxonomy: Taxonomy) -> Result<Taxonomy>;
    async fn delete_taxonomy(&self, id: &str) -> Result<usize>;

    // Category operations
    fn get_categories(&self, taxonomy_id: &str) -> Result<Vec<Category>>;
    fn get_category(&self, taxonomy_id: &str, category_id: &str) -> Result<Option<Category>>;
    fn get_category_spending_reference_count(
        &self,
        taxonomy_id: &str,
        category_id: &str,
    ) -> Result<usize>;
    async fn create_category(&self, category: NewCategory) -> Result<Category>;
    async fn update_category(&self, category: Category) -> Result<Category>;
    async fn delete_category(&self, taxonomy_id: &str, category_id: &str) -> Result<usize>;
    async fn bulk_create_categories(&self, categories: Vec<NewCategory>) -> Result<usize>;

    // Assignment operations
    fn get_asset_assignments(&self, asset_id: &str) -> Result<Vec<AssetTaxonomyAssignment>>;
    fn get_category_assignments(
        &self,
        taxonomy_id: &str,
        category_id: &str,
    ) -> Result<Vec<AssetTaxonomyAssignment>>;
    async fn upsert_assignment(
        &self,
        assignment: NewAssetTaxonomyAssignment,
    ) -> Result<AssetTaxonomyAssignment>;
    async fn delete_assignment(&self, id: &str) -> Result<usize>;
    async fn delete_asset_assignments(&self, asset_id: &str, taxonomy_id: &str) -> Result<usize>;

    // Bulk operations
    fn get_taxonomy_with_categories(&self, id: &str) -> Result<Option<TaxonomyWithCategories>>;
    fn get_all_taxonomies_with_categories(&self) -> Result<Vec<TaxonomyWithCategories>>;
}

/// Service trait for taxonomy business logic.
#[async_trait]
pub trait TaxonomyServiceTrait: Send + Sync {
    // Taxonomy operations
    fn get_taxonomies(&self) -> Result<Vec<Taxonomy>>;
    fn get_taxonomy(&self, id: &str) -> Result<Option<TaxonomyWithCategories>>;
    fn get_taxonomies_with_categories(&self) -> Result<Vec<TaxonomyWithCategories>>;
    async fn create_taxonomy(&self, taxonomy: NewTaxonomy) -> Result<Taxonomy>;
    async fn update_taxonomy(&self, taxonomy: Taxonomy) -> Result<Taxonomy>;
    async fn delete_taxonomy(&self, id: &str) -> Result<usize>;

    // Category operations
    async fn create_category(&self, category: NewCategory) -> Result<Category>;
    async fn update_category(&self, category: Category) -> Result<Category>;
    async fn delete_category(&self, taxonomy_id: &str, category_id: &str) -> Result<usize>;
    async fn move_category(
        &self,
        taxonomy_id: &str,
        category_id: &str,
        new_parent_id: Option<String>,
        position: i32,
    ) -> Result<Category>;

    // Import/Export
    async fn import_taxonomy_json(&self, json_str: &str) -> Result<Taxonomy>;
    fn export_taxonomy_json(&self, id: &str) -> Result<String>;

    // Assignment operations
    fn get_asset_assignments(&self, asset_id: &str) -> Result<Vec<AssetTaxonomyAssignment>>;
    fn get_category_assignments(
        &self,
        taxonomy_id: &str,
        category_id: &str,
    ) -> Result<Vec<AssetTaxonomyAssignment>>;
    async fn assign_asset_to_category(
        &self,
        assignment: NewAssetTaxonomyAssignment,
    ) -> Result<AssetTaxonomyAssignment>;
    async fn remove_asset_assignment(&self, id: &str) -> Result<usize>;
}
