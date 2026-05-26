//! Domain models for taxonomies.

use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};

/// A taxonomy is a classification scheme (e.g., "Asset Classes", "Industries (GICS)")
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Taxonomy {
    pub id: String,
    pub name: String,
    pub color: String,
    pub description: Option<String>,
    pub is_system: bool,
    pub is_single_select: bool, // true = only one category per asset allowed
    pub sort_order: i32,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
    /// Scope of entities this taxonomy classifies: "asset" (default) or "activity".
    #[serde(default = "default_taxonomy_scope")]
    pub scope: String,
}

fn default_taxonomy_scope() -> String {
    "asset".to_string()
}

/// Data for creating a new taxonomy
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewTaxonomy {
    pub id: Option<String>,
    pub name: String,
    pub color: String,
    pub description: Option<String>,
    pub is_system: bool,
    pub is_single_select: bool,
    pub sort_order: i32,
    #[serde(default = "default_taxonomy_scope")]
    pub scope: String,
}

impl Default for NewTaxonomy {
    fn default() -> Self {
        Self {
            id: None,
            name: String::new(),
            color: "#8abceb".to_string(),
            description: None,
            is_system: false,
            is_single_select: false,
            sort_order: 0,
            scope: "asset".to_string(),
        }
    }
}

/// A category within a taxonomy (hierarchical via parent_id)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    pub id: String,
    pub taxonomy_id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub key: String,
    pub color: String,
    pub description: Option<String>,
    pub sort_order: i32,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
    /// Optional Lucide icon name (e.g. "Home", "ShoppingCart") for UI display.
    #[serde(default)]
    pub icon: Option<String>,
}

/// Data for creating a new category
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewCategory {
    pub id: Option<String>,
    pub taxonomy_id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub key: String,
    pub color: String,
    pub description: Option<String>,
    pub sort_order: i32,
    #[serde(default)]
    pub icon: Option<String>,
}

impl Default for NewCategory {
    fn default() -> Self {
        Self {
            id: None,
            taxonomy_id: String::new(),
            parent_id: None,
            name: String::new(),
            key: String::new(),
            color: "#808080".to_string(),
            description: None,
            sort_order: 0,
            icon: None,
        }
    }
}

/// A taxonomy with its categories (for full export/import)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaxonomyWithCategories {
    pub taxonomy: Taxonomy,
    pub categories: Vec<Category>,
}

/// Assignment of an asset to a taxonomy category
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetTaxonomyAssignment {
    pub id: String,
    pub asset_id: String,
    pub taxonomy_id: String,
    pub category_id: String,
    pub weight: i32, // basis points: 10000 = 100%
    pub source: String,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
}

/// Data for creating a new asset taxonomy assignment
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewAssetTaxonomyAssignment {
    pub id: Option<String>,
    pub asset_id: String,
    pub taxonomy_id: String,
    pub category_id: String,
    pub weight: i32, // basis points: 10000 = 100%
    pub source: String,
}

impl Default for NewAssetTaxonomyAssignment {
    fn default() -> Self {
        Self {
            id: None,
            asset_id: String::new(),
            taxonomy_id: String::new(),
            category_id: String::new(),
            weight: 10000, // 100%
            source: "manual".to_string(),
        }
    }
}

/// JSON structure for importing/exporting taxonomies (Portfolio Performance compatible)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaxonomyJson {
    pub name: String,
    pub color: String,
    pub categories: Vec<CategoryJson>,
    #[serde(default)]
    pub instruments: Vec<InstrumentMappingJson>,
}

/// JSON category structure (recursive)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CategoryJson {
    pub name: String,
    pub key: String,
    pub color: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub children: Vec<CategoryJson>,
}

/// JSON instrument mapping structure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstrumentMappingJson {
    pub identifiers: InstrumentIdentifiers,
    pub categories: Vec<CategoryAssignmentJson>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstrumentIdentifiers {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub ticker: Option<String>,
    #[serde(default)]
    pub isin: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CategoryAssignmentJson {
    pub key: String,
    pub path: Vec<String>,
    pub weight: f64,
}
