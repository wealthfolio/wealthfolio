//! Activity ↔ taxonomy_category assignments.
//! Mirrors `wealthfolio_core::taxonomies::AssetTaxonomyAssignment` shape.

pub mod model;
pub mod service;
pub mod traits;

pub use model::{
    ActivityTaxonomyAssignment, CategoryAssignmentConflicts, NewActivityTaxonomyAssignment,
    RuleAssignmentResult, SplitAssignmentConflict, SplitAssignmentConflictReason,
};
pub use service::{ActivityTaxonomyAssignmentService, BulkCategoryAssignment};
pub use traits::ActivityTaxonomyAssignmentRepositoryTrait;

/// Who an activity was with. Unlike the spending, income and savings
/// taxonomies it labels no cash-flow bucket, so an activity of any bucket, or
/// of none, can be filed under one, alongside its category.
pub const PAYEES_TAXONOMY: &str = "payees";

/// Whether the taxonomy holds the categories of a cash-flow bucket: spending,
/// income or savings. An activity has one such category, or splits in its
/// place. Any other activity taxonomy, like payees, labels the activity beside
/// its category, so code about "the category" must not count it.
pub fn is_category_taxonomy(taxonomy_id: &str) -> bool {
    wealthfolio_core::taxonomies::TRANSACTION_CATEGORY_TAXONOMY_IDS.contains(&taxonomy_id)
}
