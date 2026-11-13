//! Health fix action implementations.
//!
//! This module contains the implementations for automated fix actions
//! that can be triggered from the Health Center to resolve detected issues.

pub mod classification_migration;
pub mod split_asset_merge;

pub use classification_migration::{
    get_migration_status, migrate_legacy_classifications, MigrationResult, MigrationStatus,
};
pub use split_asset_merge::merge_split_assets;
