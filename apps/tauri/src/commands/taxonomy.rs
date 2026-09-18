use crate::database::DatabaseRuntime;
use std::sync::Arc;

use log::debug;
use tauri::State;
use wealthfolio_core::health::{MigrationResult, MigrationStatus};
use wealthfolio_core::taxonomies::{
    AssetTaxonomyAssignment, Category, NewAssetTaxonomyAssignment, NewCategory, NewTaxonomy,
    Taxonomy, TaxonomyWithCategories,
};

use crate::context::ServiceContext;

#[tauri::command]
pub async fn get_taxonomies(state: State<'_, DatabaseRuntime>) -> Result<Vec<Taxonomy>, String> {
    let context = state.context()?;
    debug!("Fetching all taxonomies...");
    context
        .taxonomy_service()
        .get_taxonomies()
        .map_err(|e| format!("Failed to load taxonomies: {}", e))
}

#[tauri::command]
pub async fn get_taxonomy(
    id: String,
    state: State<'_, DatabaseRuntime>,
) -> Result<Option<TaxonomyWithCategories>, String> {
    let context = state.context()?;
    debug!("Fetching taxonomy {}...", id);
    context
        .taxonomy_service()
        .get_taxonomy(&id)
        .map_err(|e| format!("Failed to load taxonomy: {}", e))
}

#[tauri::command]
pub async fn create_taxonomy(
    taxonomy: NewTaxonomy,
    state: State<'_, DatabaseRuntime>,
) -> Result<Taxonomy, String> {
    let context = state.context()?;
    debug!("Creating taxonomy {}...", taxonomy.name);
    context
        .taxonomy_service()
        .create_taxonomy(taxonomy)
        .await
        .map_err(|e| format!("Failed to create taxonomy: {}", e))
}

#[tauri::command]
pub async fn update_taxonomy(
    taxonomy: Taxonomy,
    state: State<'_, DatabaseRuntime>,
) -> Result<Taxonomy, String> {
    let context = state.context()?;
    debug!("Updating taxonomy {}...", taxonomy.id);
    context
        .taxonomy_service()
        .update_taxonomy(taxonomy)
        .await
        .map_err(|e| format!("Failed to update taxonomy: {}", e))
}

#[tauri::command]
pub async fn delete_taxonomy(
    id: String,
    state: State<'_, DatabaseRuntime>,
) -> Result<usize, String> {
    let context = state.context()?;
    debug!("Deleting taxonomy {}...", id);
    context
        .taxonomy_service()
        .delete_taxonomy(&id)
        .await
        .map_err(|e| format!("Failed to delete taxonomy: {}", e))
}

#[tauri::command]
pub async fn create_category(
    category: NewCategory,
    state: State<'_, DatabaseRuntime>,
) -> Result<Category, String> {
    let context = state.context()?;
    debug!("Creating category {}...", category.name);
    context
        .taxonomy_service()
        .create_category(category)
        .await
        .map_err(|e| format!("Failed to create category: {}", e))
}

#[tauri::command]
pub async fn update_category(
    category: Category,
    state: State<'_, DatabaseRuntime>,
) -> Result<Category, String> {
    let context = state.context()?;
    debug!("Updating category {}...", category.id);
    context
        .taxonomy_service()
        .update_category(category)
        .await
        .map_err(|e| format!("Failed to update category: {}", e))
}

#[tauri::command]
pub async fn delete_category(
    taxonomy_id: String,
    category_id: String,
    state: State<'_, DatabaseRuntime>,
) -> Result<usize, String> {
    let context = state.context()?;
    debug!("Deleting category {}...", category_id);
    context
        .taxonomy_service()
        .delete_category(&taxonomy_id, &category_id)
        .await
        .map_err(|e| format!("Failed to delete category: {}", e))
}

#[tauri::command]
pub async fn move_category(
    taxonomy_id: String,
    category_id: String,
    new_parent_id: Option<String>,
    position: i32,
    state: State<'_, DatabaseRuntime>,
) -> Result<Category, String> {
    let context = state.context()?;
    debug!(
        "Moving category {} to position {}...",
        category_id, position
    );
    context
        .taxonomy_service()
        .move_category(&taxonomy_id, &category_id, new_parent_id, position)
        .await
        .map_err(|e| format!("Failed to move category: {}", e))
}

#[tauri::command]
pub async fn import_taxonomy_json(
    json_str: String,
    state: State<'_, DatabaseRuntime>,
) -> Result<Taxonomy, String> {
    let context = state.context()?;
    debug!("Importing taxonomy from JSON...");
    context
        .taxonomy_service()
        .import_taxonomy_json(&json_str)
        .await
        .map_err(|e| format!("Failed to import taxonomy: {}", e))
}

#[tauri::command]
pub async fn export_taxonomy_json(
    id: String,
    state: State<'_, DatabaseRuntime>,
) -> Result<String, String> {
    let context = state.context()?;
    debug!("Exporting taxonomy {} to JSON...", id);
    context
        .taxonomy_service()
        .export_taxonomy_json(&id)
        .map_err(|e| format!("Failed to export taxonomy: {}", e))
}

#[tauri::command]
pub async fn get_asset_taxonomy_assignments(
    asset_id: String,
    state: State<'_, DatabaseRuntime>,
) -> Result<Vec<AssetTaxonomyAssignment>, String> {
    let context = state.context()?;
    debug!("Fetching taxonomy assignments for asset {}...", asset_id);
    context
        .taxonomy_service()
        .get_asset_assignments(&asset_id)
        .map_err(|e| format!("Failed to load assignments: {}", e))
}

#[tauri::command]
pub async fn assign_asset_to_category(
    assignment: NewAssetTaxonomyAssignment,
    state: State<'_, DatabaseRuntime>,
) -> Result<AssetTaxonomyAssignment, String> {
    let context = state.context()?;
    debug!(
        "Assigning asset {} to category {}...",
        assignment.asset_id, assignment.category_id
    );
    context
        .taxonomy_service()
        .assign_asset_to_category(assignment)
        .await
        .map_err(|e| format!("Failed to create assignment: {}", e))
}

#[tauri::command]
pub async fn replace_asset_taxonomy_assignments(
    asset_id: String,
    taxonomy_id: String,
    assignments: Vec<NewAssetTaxonomyAssignment>,
    state: State<'_, DatabaseRuntime>,
) -> Result<Vec<AssetTaxonomyAssignment>, String> {
    let context = state.context()?;
    debug!(
        "Replacing taxonomy {} assignments for asset {}...",
        taxonomy_id, asset_id
    );
    context
        .taxonomy_service()
        .replace_asset_taxonomy_assignments(&asset_id, &taxonomy_id, assignments)
        .await
        .map_err(|e| format!("Failed to replace assignments: {}", e))
}

#[tauri::command]
pub async fn remove_asset_taxonomy_assignment(
    id: String,
    state: State<'_, DatabaseRuntime>,
) -> Result<usize, String> {
    let context = state.context()?;
    debug!("Removing taxonomy assignment {}...", id);
    context
        .taxonomy_service()
        .remove_asset_assignment(&id)
        .await
        .map_err(|e| format!("Failed to remove assignment: {}", e))
}

// ============================================================================
// Legacy Classification Migration Commands
// ============================================================================

/// Check if legacy classification migration is needed
#[tauri::command]
pub async fn get_migration_status(
    state: State<'_, DatabaseRuntime>,
) -> Result<MigrationStatus, String> {
    let context = state.context()?;
    debug!("Checking migration status...");
    wealthfolio_core::health::get_migration_status(
        context.asset_service().as_ref(),
        context.taxonomy_service().as_ref(),
    )
    .map_err(|e| e.to_string())
}

/// Migrate legacy sector and country classifications to taxonomy system
#[tauri::command]
pub async fn migrate_legacy_classifications(
    state: State<'_, DatabaseRuntime>,
) -> Result<MigrationResult, String> {
    let context = state.context()?;
    run_legacy_migration(&context).await
}

/// Core migration logic - can be called from Tauri command or health fix action
pub async fn run_legacy_migration(state: &Arc<ServiceContext>) -> Result<MigrationResult, String> {
    debug!("Starting legacy classification migration...");
    wealthfolio_core::health::migrate_legacy_classifications(
        state.asset_service().as_ref(),
        state.taxonomy_service().as_ref(),
    )
    .await
    .map_err(|e| e.to_string())
}
