use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityTaxonomyAssignment {
    pub id: String,
    pub activity_id: String,
    pub taxonomy_id: String,
    pub category_id: String,
    /// Basis points: 10000 = 100%. Single-select activity-scope taxonomies use 10000.
    pub weight: i32,
    /// "manual" | "rule" | "import"
    pub source: String,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewActivityTaxonomyAssignment {
    pub id: Option<String>,
    pub activity_id: String,
    pub taxonomy_id: String,
    pub category_id: String,
    #[serde(default = "default_weight")]
    pub weight: i32,
    #[serde(default = "default_source")]
    pub source: String,
}

fn default_weight() -> i32 {
    10_000
}

fn default_source() -> String {
    "manual".to_string()
}
