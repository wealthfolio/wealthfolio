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
