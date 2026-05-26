//! Activity ↔ taxonomy_category assignments.
//! Mirrors `wealthfolio_core::taxonomies::AssetTaxonomyAssignment` shape.

pub mod model;
pub mod service;
pub mod traits;

pub use model::{ActivityTaxonomyAssignment, NewActivityTaxonomyAssignment};
pub use service::{ActivityTaxonomyAssignmentService, BulkCategoryAssignment};
pub use traits::ActivityTaxonomyAssignmentRepositoryTrait;
