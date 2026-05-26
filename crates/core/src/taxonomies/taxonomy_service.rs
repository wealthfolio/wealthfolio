//! Taxonomy service implementation.

use async_trait::async_trait;
use std::sync::Arc;
use uuid::Uuid;

use crate::errors::{DatabaseError, ValidationError};
use crate::Result;

use super::{
    AssetTaxonomyAssignment, Category, CategoryJson, NewAssetTaxonomyAssignment, NewCategory,
    NewTaxonomy, Taxonomy, TaxonomyJson, TaxonomyRepositoryTrait, TaxonomyServiceTrait,
    TaxonomyWithCategories,
};

pub struct TaxonomyService {
    repository: Arc<dyn TaxonomyRepositoryTrait>,
}

impl TaxonomyService {
    pub fn new(repository: Arc<dyn TaxonomyRepositoryTrait>) -> Self {
        Self { repository }
    }

    /// Recursively flatten category JSON into NewCategory records
    #[allow(clippy::only_used_in_recursion)]
    fn flatten_categories(
        &self,
        taxonomy_id: &str,
        categories: &[CategoryJson],
        parent_id: Option<String>,
        sort_start: &mut i32,
    ) -> Vec<NewCategory> {
        let mut result = Vec::new();

        for cat in categories {
            let id = Uuid::new_v4().to_string();
            let current_sort = *sort_start;
            *sort_start += 1;

            result.push(NewCategory {
                id: Some(id.clone()),
                taxonomy_id: taxonomy_id.to_string(),
                parent_id: parent_id.clone(),
                name: cat.name.clone(),
                key: cat.key.clone(),
                color: cat.color.clone(),
                description: cat.description.clone(),
                sort_order: current_sort,
                icon: None,
            });

            // Recurse for children
            if !cat.children.is_empty() {
                let children =
                    self.flatten_categories(taxonomy_id, &cat.children, Some(id), sort_start);
                result.extend(children);
            }
        }

        result
    }

    /// Convert categories to JSON tree structure
    fn categories_to_json(&self, categories: &[Category]) -> Vec<CategoryJson> {
        // Build a map of parent_id -> children
        let mut children_map: std::collections::HashMap<Option<String>, Vec<&Category>> =
            std::collections::HashMap::new();

        for cat in categories {
            children_map
                .entry(cat.parent_id.clone())
                .or_default()
                .push(cat);
        }

        // Sort children by sort_order
        for children in children_map.values_mut() {
            children.sort_by_key(|c| c.sort_order);
        }

        // Recursively build JSON tree
        self.build_category_tree(&children_map, None)
    }

    #[allow(clippy::only_used_in_recursion)]
    fn build_category_tree(
        &self,
        children_map: &std::collections::HashMap<Option<String>, Vec<&Category>>,
        parent_id: Option<String>,
    ) -> Vec<CategoryJson> {
        let Some(children) = children_map.get(&parent_id) else {
            return Vec::new();
        };

        children
            .iter()
            .map(|cat| CategoryJson {
                name: cat.name.clone(),
                key: cat.key.clone(),
                color: cat.color.clone(),
                description: cat.description.clone(),
                children: self.build_category_tree(children_map, Some(cat.id.clone())),
            })
            .collect()
    }
}

#[async_trait]
impl TaxonomyServiceTrait for TaxonomyService {
    fn get_taxonomies(&self) -> Result<Vec<Taxonomy>> {
        self.repository.get_taxonomies()
    }

    fn get_taxonomy(&self, id: &str) -> Result<Option<TaxonomyWithCategories>> {
        self.repository.get_taxonomy_with_categories(id)
    }

    fn get_taxonomies_with_categories(&self) -> Result<Vec<TaxonomyWithCategories>> {
        self.repository.get_all_taxonomies_with_categories()
    }

    async fn create_taxonomy(&self, taxonomy: NewTaxonomy) -> Result<Taxonomy> {
        self.repository.create_taxonomy(taxonomy).await
    }

    async fn update_taxonomy(&self, taxonomy: Taxonomy) -> Result<Taxonomy> {
        self.repository.update_taxonomy(taxonomy).await
    }

    async fn delete_taxonomy(&self, id: &str) -> Result<usize> {
        // Check if taxonomy is a system taxonomy
        if let Some(taxonomy) = self.repository.get_taxonomy(id)? {
            if taxonomy.is_system {
                return Err(ValidationError::InvalidInput(
                    "Cannot delete system taxonomy".to_string(),
                )
                .into());
            }
        }
        self.repository.delete_taxonomy(id).await
    }

    async fn create_category(&self, category: NewCategory) -> Result<Category> {
        self.repository.create_category(category).await
    }

    async fn update_category(&self, category: Category) -> Result<Category> {
        self.repository.update_category(category).await
    }

    async fn delete_category(&self, taxonomy_id: &str, category_id: &str) -> Result<usize> {
        // Check for child categories
        let categories = self.repository.get_categories(taxonomy_id)?;
        let has_children = categories
            .iter()
            .any(|c| c.parent_id.as_deref() == Some(category_id));
        if has_children {
            return Err(ValidationError::InvalidInput(
                "Cannot delete category with children".to_string(),
            )
            .into());
        }

        // Check for assignments
        let assignments = self
            .repository
            .get_category_assignments(taxonomy_id, category_id)?;
        if !assignments.is_empty() {
            return Err(ValidationError::InvalidInput(format!(
                "Cannot delete category with {} asset assignments",
                assignments.len()
            ))
            .into());
        }
        let spending_references = self
            .repository
            .get_category_spending_reference_count(taxonomy_id, category_id)?;
        if spending_references > 0 {
            return Err(ValidationError::InvalidInput(format!(
                "Cannot delete category with {} spending references",
                spending_references
            ))
            .into());
        }

        self.repository
            .delete_category(taxonomy_id, category_id)
            .await
    }

    async fn move_category(
        &self,
        taxonomy_id: &str,
        category_id: &str,
        new_parent_id: Option<String>,
        position: i32,
    ) -> Result<Category> {
        let category = self
            .repository
            .get_category(taxonomy_id, category_id)?
            .ok_or_else(|| DatabaseError::NotFound("Category not found".to_string()))?;

        let updated = Category {
            parent_id: new_parent_id,
            sort_order: position,
            ..category
        };

        self.repository.update_category(updated).await
    }

    async fn import_taxonomy_json(&self, json_str: &str) -> Result<Taxonomy> {
        let taxonomy_json: TaxonomyJson = serde_json::from_str(json_str)
            .map_err(|e| ValidationError::InvalidInput(format!("Invalid JSON: {}", e)))?;

        // Create taxonomy (user-imported taxonomies are never system taxonomies)
        let taxonomy = self
            .repository
            .create_taxonomy(NewTaxonomy {
                id: None,
                name: taxonomy_json.name,
                color: taxonomy_json.color,
                description: None,
                is_system: false,
                is_single_select: false,
                sort_order: 0,
                scope: "asset".to_string(),
            })
            .await?;

        // Flatten and create categories
        let mut sort_order = 0;
        let categories = self.flatten_categories(
            &taxonomy.id,
            &taxonomy_json.categories,
            None,
            &mut sort_order,
        );

        if !categories.is_empty() {
            self.repository.bulk_create_categories(categories).await?;
        }

        Ok(taxonomy)
    }

    fn export_taxonomy_json(&self, id: &str) -> Result<String> {
        let taxonomy_with_cats = self
            .repository
            .get_taxonomy_with_categories(id)?
            .ok_or_else(|| DatabaseError::NotFound("Taxonomy not found".to_string()))?;

        let json = TaxonomyJson {
            name: taxonomy_with_cats.taxonomy.name,
            color: taxonomy_with_cats.taxonomy.color,
            categories: self.categories_to_json(&taxonomy_with_cats.categories),
            instruments: Vec::new(),
        };

        serde_json::to_string_pretty(&json)
            .map_err(|e| ValidationError::InvalidInput(format!("Failed to serialize: {}", e)))
            .map_err(Into::into)
    }

    fn get_asset_assignments(&self, asset_id: &str) -> Result<Vec<AssetTaxonomyAssignment>> {
        self.repository.get_asset_assignments(asset_id)
    }

    fn get_category_assignments(
        &self,
        taxonomy_id: &str,
        category_id: &str,
    ) -> Result<Vec<AssetTaxonomyAssignment>> {
        self.repository
            .get_category_assignments(taxonomy_id, category_id)
    }

    async fn assign_asset_to_category(
        &self,
        assignment: NewAssetTaxonomyAssignment,
    ) -> Result<AssetTaxonomyAssignment> {
        // Check if taxonomy is single-select
        if let Some(taxonomy) = self.repository.get_taxonomy(&assignment.taxonomy_id)? {
            if taxonomy.is_single_select {
                // Delete any existing assignments for this asset+taxonomy before creating new one
                self.repository
                    .delete_asset_assignments(&assignment.asset_id, &assignment.taxonomy_id)
                    .await?;
            }
        }

        self.repository.upsert_assignment(assignment).await
    }

    async fn remove_asset_assignment(&self, id: &str) -> Result<usize> {
        self.repository.delete_assignment(id).await
    }
}
