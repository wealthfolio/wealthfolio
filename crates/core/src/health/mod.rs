//! Health Center module.
//!
//! This module provides the diagnostic system for Wealthfolio that inspects
//! portfolio data integrity, detects stale market data, identifies missing
//! classifications, and surfaces actionable issues to users.
//!
//! # Architecture
//!
//! The health center follows a check-based architecture:
//!
//! ```text
//! HealthService → [Check Registry] → Individual Checks
//!      ↓                                    ↓
//! HealthStatus                    HealthIssue[]
//!      ↓
//! DismissalStore (persistence)
//! ```
//!
//! - **Models** (`model.rs`) - Domain types: Severity, HealthIssue, HealthStatus, etc.
//! - **Traits** (`traits.rs`) - Abstract interfaces for checks and storage
//! - **Errors** (`errors.rs`) - Health-specific error types
//! - **Checks** (`checks/`) - Individual check implementations
//! - **Service** (`service.rs`) - Orchestrates checks and manages state
//!
//! # Health Categories
//!
//! - **Price Staleness** - Detects assets with outdated market prices
//! - **FX Integrity** - Detects missing or stale currency exchange rates
//! - **Classification** - Detects assets lacking taxonomy assignments
//! - **Data Consistency** - Detects orphan records and invariant violations
//!
//! # Severity Levels
//!
//! Issues are categorized by severity:
//! - **Info** - Informational, no action required
//! - **Warning** - Should be addressed but not urgent
//! - **Error** - Significant issue affecting data quality
//! - **Critical** - Urgent issue affecting >30% of portfolio value
//!
//! # Resolution Paths
//!
//! Each issue includes either:
//! - **Fix Action** - Automated resolution (e.g., "Sync Prices")
//! - **Navigate Action** - Link to manual resolution page
//! - **Instructions** - Text instructions when neither applies

pub mod errors;
pub mod model;
pub mod traits;

pub mod checks;
pub mod fixes;
pub mod service;

#[cfg(test)]
mod tests;

// Re-export commonly used types
pub use errors::HealthError;
pub use model::{
    AffectedItem, DiagnosticAction, DiagnosticDomain, DiagnosticLevel, Evidence, FixAction,
    HealthCategory, HealthConfig, HealthDateRange, HealthDiagnostic, HealthEntityRef, HealthImpact,
    HealthIssue, HealthIssueBuilder, HealthStatus, IssueDismissal, NavigateAction, Severity,
};
pub use traits::{HealthCheck, HealthContext, HealthDismissalStore, HealthServiceTrait};

// Re-export service
pub use service::HealthService;

// Re-export fix types
pub use fixes::{
    get_migration_status, migrate_legacy_classifications, MigrationResult, MigrationStatus,
};

// Re-export data gathering functions from checks
pub use checks::{
    gather_legacy_migration_status, gather_quote_sync_errors, gather_unclassified_assets,
};
