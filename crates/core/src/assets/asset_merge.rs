//! Types for merging one instrument that is split across two asset rows.
//!
//! The exchange-registry MIC migrations re-keyed stored assets to their ISO
//! MIC, except where the canonical twin already existed. Those databases hold
//! one instrument under two asset rows: the legacy-MIC duplicate and the
//! canonical survivor. A merge moves everything that references the duplicate
//! onto the survivor and deactivates the duplicate.

use serde::{Deserialize, Serialize};

/// A user-entered holdings snapshot that lists both the survivor and the
/// duplicate. Merging would leave the snapshot with two positions for one
/// asset, so the merge refuses until the user corrects the snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedSourceSnapshot {
    pub account_id: String,
    pub account_name: String,
    /// YYYY-MM-DD
    pub snapshot_date: String,
}

/// Read-only description of what a merge would do with price history.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetMergePreview {
    /// Days on which both rows have at least one quote.
    pub overlapping_quote_days: u32,
    /// Overlapping days whose effective price after the merge comes from the survivor.
    pub overlap_days_kept_from_survivor: u32,
    /// Overlapping days whose effective price after the merge comes from the duplicate.
    pub overlap_days_kept_from_duplicate: u32,
    /// Duplicate quotes dropped because the survivor has one for the same day and source.
    pub duplicate_quotes_dropped: u32,
    /// Duplicate quotes that will move to the survivor.
    pub duplicate_quotes_moved: u32,
    /// Source snapshots that block the merge.
    pub shared_source_snapshots: Vec<SharedSourceSnapshot>,
}

/// What a completed merge changed, per table.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetMergeReport {
    pub survivor_id: String,
    pub duplicate_id: String,
    pub activities_moved: u32,
    pub quotes_moved: u32,
    pub quotes_dropped: u32,
    pub taxonomy_assignments_moved: u32,
    pub taxonomy_assignments_dropped: u32,
    pub logo_moved: bool,
    pub snapshots_rewritten: u32,
    pub snapshot_positions_moved: u32,
    pub snapshot_positions_dropped: u32,
    pub lots_moved: u32,
    pub lot_disposals_moved: u32,
    pub allocation_constraints_moved: u32,
    pub allocation_constraints_dropped: u32,
    /// Accounts whose history must be rebuilt.
    pub affected_account_ids: Vec<String>,
    /// Currencies of the moved activities (for FX sync planning).
    pub currencies: Vec<String>,
    /// Taxonomies whose assignments on the survivor changed.
    pub changed_taxonomy_ids: Vec<String>,
}
