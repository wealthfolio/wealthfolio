//! Database models for taxonomies.

use chrono::NaiveDateTime;
use diesel::prelude::*;
use log::error;
use serde::{Deserialize, Serialize};

/// Helper to parse RFC3339 string to NaiveDateTime
fn text_to_datetime(s: &str) -> NaiveDateTime {
    chrono::DateTime::parse_from_rfc3339(s)
        .map(|dt| dt.naive_utc())
        .unwrap_or_else(|e| {
            error!("Failed to parse datetime '{}': {}", s, e);
            chrono::Utc::now().naive_utc()
        })
}

/// Database model for taxonomies
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
#[diesel(table_name = crate::schema::taxonomies)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
#[serde(rename_all = "camelCase")]
pub struct TaxonomyDB {
    pub id: String,
    pub name: String,
    pub color: String,
    pub description: Option<String>,
    pub is_system: i32,        // Schema uses Integer
    pub is_single_select: i32, // Schema uses Integer
    pub sort_order: i32,
    pub created_at: String, // Schema uses Text
    pub updated_at: String, // Schema uses Text
    /// Spending module: "asset" (default for backwards compat) | "activity"
    #[serde(default = "default_taxonomy_scope")]
    pub scope: String,
}

fn default_taxonomy_scope() -> String {
    "asset".to_string()
}

/// Database model for creating a new taxonomy
#[derive(Insertable, Serialize, Deserialize, Debug, Clone)]
#[diesel(table_name = crate::schema::taxonomies)]
#[serde(rename_all = "camelCase")]
pub struct NewTaxonomyDB {
    pub id: Option<String>,
    pub name: String,
    pub color: String,
    pub description: Option<String>,
    pub is_system: i32,        // Schema uses Integer
    pub is_single_select: i32, // Schema uses Integer
    pub sort_order: i32,
    pub created_at: String, // Schema uses Text
    pub updated_at: String, // Schema uses Text
    pub scope: String,
}

/// Database model for taxonomy categories
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
#[diesel(table_name = crate::schema::taxonomy_categories)]
#[diesel(primary_key(taxonomy_id, id))]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
#[serde(rename_all = "camelCase")]
pub struct CategoryDB {
    pub id: String,
    pub taxonomy_id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub key: String,
    pub color: String,
    pub description: Option<String>,
    pub sort_order: i32,
    pub created_at: String, // Schema uses Text
    pub updated_at: String, // Schema uses Text
    /// Spending module: optional Lucide icon name for UI display.
    #[serde(default)]
    pub icon: Option<String>,
}

/// Database model for creating a new category
#[derive(Insertable, Serialize, Deserialize, Debug, Clone)]
#[diesel(table_name = crate::schema::taxonomy_categories)]
#[serde(rename_all = "camelCase")]
pub struct NewCategoryDB {
    pub id: Option<String>,
    pub taxonomy_id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub key: String,
    pub color: String,
    pub description: Option<String>,
    pub sort_order: i32,
    pub created_at: String, // Schema uses Text
    pub updated_at: String, // Schema uses Text
    pub icon: Option<String>,
}

/// Database model for asset taxonomy assignments
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
#[diesel(table_name = crate::schema::asset_taxonomy_assignments)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
#[serde(rename_all = "camelCase")]
pub struct AssetTaxonomyAssignmentDB {
    pub id: String,
    pub asset_id: String,
    pub taxonomy_id: String,
    pub category_id: String,
    pub weight: i32, // basis points: 10000 = 100%
    pub source: String,
    pub created_at: String, // Schema uses Text
    pub updated_at: String, // Schema uses Text
}

/// Database model for creating a new assignment
#[derive(Insertable, Serialize, Deserialize, Debug, Clone)]
#[diesel(table_name = crate::schema::asset_taxonomy_assignments)]
#[serde(rename_all = "camelCase")]
pub struct NewAssetTaxonomyAssignmentDB {
    pub id: Option<String>,
    pub asset_id: String,
    pub taxonomy_id: String,
    pub category_id: String,
    pub weight: i32, // basis points: 10000 = 100%
    pub source: String,
    pub created_at: String, // Schema uses Text
    pub updated_at: String, // Schema uses Text
}

// Conversion to domain models
impl From<TaxonomyDB> for wealthfolio_core::taxonomies::Taxonomy {
    fn from(db: TaxonomyDB) -> Self {
        Self {
            id: db.id,
            name: db.name,
            color: db.color,
            description: db.description,
            is_system: db.is_system != 0,
            is_single_select: db.is_single_select != 0,
            sort_order: db.sort_order,
            created_at: text_to_datetime(&db.created_at),
            updated_at: text_to_datetime(&db.updated_at),
            scope: db.scope,
        }
    }
}

impl From<CategoryDB> for wealthfolio_core::taxonomies::Category {
    fn from(db: CategoryDB) -> Self {
        Self {
            id: db.id,
            taxonomy_id: db.taxonomy_id,
            parent_id: db.parent_id,
            name: db.name,
            key: db.key,
            color: db.color,
            description: db.description,
            sort_order: db.sort_order,
            created_at: text_to_datetime(&db.created_at),
            updated_at: text_to_datetime(&db.updated_at),
            icon: db.icon,
        }
    }
}

impl From<AssetTaxonomyAssignmentDB> for wealthfolio_core::taxonomies::AssetTaxonomyAssignment {
    fn from(db: AssetTaxonomyAssignmentDB) -> Self {
        Self {
            id: db.id,
            asset_id: db.asset_id,
            taxonomy_id: db.taxonomy_id,
            category_id: db.category_id,
            weight: db.weight,
            source: db.source,
            created_at: text_to_datetime(&db.created_at),
            updated_at: text_to_datetime(&db.updated_at),
        }
    }
}

// Conversion from domain models
impl From<wealthfolio_core::taxonomies::NewTaxonomy> for NewTaxonomyDB {
    fn from(domain: wealthfolio_core::taxonomies::NewTaxonomy) -> Self {
        let now = chrono::Utc::now().to_rfc3339();
        Self {
            id: domain.id,
            name: domain.name,
            color: domain.color,
            description: domain.description,
            is_system: if domain.is_system { 1 } else { 0 },
            is_single_select: if domain.is_single_select { 1 } else { 0 },
            sort_order: domain.sort_order,
            created_at: now.clone(),
            updated_at: now,
            scope: domain.scope,
        }
    }
}

impl From<wealthfolio_core::taxonomies::NewCategory> for NewCategoryDB {
    fn from(domain: wealthfolio_core::taxonomies::NewCategory) -> Self {
        let now = chrono::Utc::now().to_rfc3339();
        Self {
            id: domain.id,
            taxonomy_id: domain.taxonomy_id,
            parent_id: domain.parent_id,
            name: domain.name,
            key: domain.key,
            color: domain.color,
            description: domain.description,
            sort_order: domain.sort_order,
            created_at: now.clone(),
            updated_at: now,
            icon: domain.icon,
        }
    }
}

impl From<wealthfolio_core::taxonomies::NewAssetTaxonomyAssignment>
    for NewAssetTaxonomyAssignmentDB
{
    fn from(domain: wealthfolio_core::taxonomies::NewAssetTaxonomyAssignment) -> Self {
        let now = chrono::Utc::now().to_rfc3339();
        Self {
            id: domain.id,
            asset_id: domain.asset_id,
            taxonomy_id: domain.taxonomy_id,
            category_id: domain.category_id,
            weight: domain.weight,
            source: domain.source,
            created_at: now.clone(),
            updated_at: now,
        }
    }
}
