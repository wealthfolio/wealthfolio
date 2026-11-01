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

/// A rejected atomic category batch reports every split conflict without exposing
/// amounts, notes or category names in its error message (which may be audited).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitAssignmentConflict {
    pub activity_id: String,
    pub reason: SplitAssignmentConflictReason,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SplitAssignmentConflictReason {
    ProtectedSplits,
    SplitStateChanged,
}

#[derive(Debug, thiserror::Error)]
#[error("Split allocations are protected or changed; review the affected transactions before replacing them")]
pub struct CategoryAssignmentConflicts {
    pub conflicts: Vec<SplitAssignmentConflict>,
}

/// Decisions observed by the shared rule writer (or its read-only preview).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleAssignmentResult {
    #[serde(skip)]
    pub assignments: Vec<ActivityTaxonomyAssignment>,
    pub eligible: usize,
    pub changed: usize,
    pub protected_splits: usize,
    pub protected_manual: usize,
    pub skipped_existing: usize,
    pub unchanged: usize,
    pub incompatible: usize,
    pub without_target: usize,
}
