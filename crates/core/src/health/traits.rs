//! Health Center traits.
//!
//! This module defines the abstract interfaces for health checks and storage:
//! - `HealthCheck` - Trait for implementing diagnostic checks
//! - `HealthDismissalStore` - Trait for persisting issue dismissals
//! - `HealthContext` - Context provided to health checks

use async_trait::async_trait;
use chrono::{DateTime, Utc};

use super::model::{HealthCategory, HealthConfig, HealthIssue, IssueDismissal};
use crate::errors::Result;
use crate::portfolio::snapshot::SnapshotServiceTrait;

// =============================================================================
// Health Context
// =============================================================================

/// Context provided to health checks during execution.
///
/// Contains configuration, environment info, and the current timestamp
/// to ensure consistent check behavior.
#[derive(Debug, Clone)]
pub struct HealthContext {
    /// Health check configuration (thresholds, etc.)
    pub config: HealthConfig,

    /// The user's base currency for portfolio valuation
    pub base_currency: String,

    /// Current timestamp for staleness calculations
    pub now: DateTime<Utc>,

    /// Total portfolio market value in base currency (for MV% calculations)
    pub total_portfolio_value: f64,
}

impl HealthContext {
    /// Creates a new health context.
    pub fn new(
        config: HealthConfig,
        base_currency: impl Into<String>,
        total_portfolio_value: f64,
    ) -> Self {
        Self {
            config,
            base_currency: base_currency.into(),
            now: Utc::now(),
            total_portfolio_value,
        }
    }

    /// Creates a context with a specific timestamp (for testing).
    pub fn with_timestamp(
        config: HealthConfig,
        base_currency: impl Into<String>,
        total_portfolio_value: f64,
        now: DateTime<Utc>,
    ) -> Self {
        Self {
            config,
            base_currency: base_currency.into(),
            now,
            total_portfolio_value,
        }
    }
}

// =============================================================================
// Health Check Trait
// =============================================================================

/// Trait for implementing health diagnostic checks.
///
/// Each check is responsible for inspecting a specific aspect of portfolio
/// data and emitting zero or more health issues.
///
/// # Implementation Notes
///
/// - Checks should be idempotent and have no side effects
/// - Each check should focus on one category of issues
/// - Use the provided `HealthContext` for configuration and timestamps
/// - Generate user-friendly titles and messages (see messaging guidelines)
///
/// # Example
///
/// ```ignore
/// pub struct PriceStalenessCheck {
///     quote_store: Arc<dyn QuoteStore>,
/// }
///
/// #[async_trait]
/// impl HealthCheck for PriceStalenessCheck {
///     fn id(&self) -> &'static str {
///         "price_staleness"
///     }
///
///     fn category(&self) -> HealthCategory {
///         HealthCategory::PriceStaleness
///     }
///
///     async fn run(&self, ctx: &HealthContext) -> Result<Vec<HealthIssue>> {
///         // Check for stale quotes and emit issues
///     }
/// }
/// ```
#[async_trait]
pub trait HealthCheck: Send + Sync {
    /// Returns the unique identifier for this check.
    ///
    /// Used for logging and error reporting.
    fn id(&self) -> &'static str;

    /// Returns the category this check belongs to.
    ///
    /// All issues emitted by this check should have this category.
    fn category(&self) -> HealthCategory;

    /// Runs the check and returns any detected issues.
    ///
    /// # Arguments
    ///
    /// * `ctx` - The health context containing configuration and environment info
    ///
    /// # Returns
    ///
    /// A vector of health issues found by this check. Returns an empty vector
    /// if no issues are detected.
    async fn run(&self, ctx: &HealthContext) -> Result<Vec<HealthIssue>>;
}

// =============================================================================
// Health Dismissal Store Trait
// =============================================================================

/// Storage interface for health issue dismissals.
///
/// This trait abstracts the persistence layer for tracking which issues
/// have been dismissed by the user.
#[async_trait]
pub trait HealthDismissalStore: Send + Sync {
    /// Saves a dismissal record.
    ///
    /// If a dismissal for the same issue_id exists, it will be updated.
    ///
    /// # Arguments
    ///
    /// * `dismissal` - The dismissal record to save
    async fn save_dismissal(&self, dismissal: &IssueDismissal) -> Result<()>;

    /// Removes a dismissal record, restoring the issue to active status.
    ///
    /// # Arguments
    ///
    /// * `issue_id` - The issue ID to restore
    async fn remove_dismissal(&self, issue_id: &str) -> Result<()>;

    /// Gets all dismissal records.
    ///
    /// # Returns
    ///
    /// All stored dismissals
    async fn get_dismissals(&self) -> Result<Vec<IssueDismissal>>;

    /// Gets a specific dismissal record.
    ///
    /// # Arguments
    ///
    /// * `issue_id` - The issue ID to look up
    ///
    /// # Returns
    ///
    /// The dismissal record if found, None otherwise
    async fn get_dismissal(&self, issue_id: &str) -> Result<Option<IssueDismissal>>;

    /// Clears all dismissals (for testing or reset purposes).
    async fn clear_all(&self) -> Result<()>;
}

// =============================================================================
// Health Service Trait
// =============================================================================

use super::checks::{
    AssetHoldingInfo, ConsistencyIssueInfo, FxPairInfo, InvalidExchangeGroupInfo,
    InvalidTransferGroupInfo, LegacyMigrationInfo, QuoteSyncErrorInfo, UnclassifiedAssetInfo,
    UnconfiguredAccountInfo,
};
use super::model::{FixAction, HealthStatus};
use crate::accounts::AccountServiceTrait;
use crate::activities::ActivityServiceTrait;
use crate::assets::AssetServiceTrait;
use crate::lots::LotRepositoryTrait;
use crate::portfolio::holdings::HoldingsServiceTrait;
use crate::portfolio::valuation::ValuationServiceTrait;
use crate::quotes::QuoteServiceTrait;
use crate::taxonomies::TaxonomyServiceTrait;
use std::collections::HashMap;
use std::sync::Arc;

/// Service interface for health center operations.
///
/// This trait defines the high-level operations for running health checks,
/// managing dismissals, and executing fix actions.
#[async_trait]
pub trait HealthServiceTrait: Send + Sync {
    /// Runs all registered health checks and returns aggregated status.
    ///
    /// # Arguments
    ///
    /// * `base_currency` - The user's base currency
    ///
    /// # Returns
    ///
    /// The aggregated health status with all detected issues
    async fn run_checks(&self, base_currency: &str) -> Result<HealthStatus>;

    /// Runs all health checks with the provided data.
    ///
    /// This method allows the caller to gather data separately and pass it in,
    /// which is useful when the caller already has access to the required data.
    ///
    /// # Arguments
    ///
    /// * `base_currency` - The user's base currency
    /// * `total_portfolio_value` - Total market value of the portfolio
    /// * `holdings` - Information about held assets
    /// * `latest_quote_times` - Latest quote timestamps by asset ID
    /// * `quote_sync_errors` - Assets with quote sync failures
    /// * `fx_pairs` - FX pair information for currency checks
    /// * `unclassified_assets` - Assets missing classification
    /// * `consistency_issues` - Pre-detected data consistency issues
    /// * `legacy_migration_info` - Info about legacy classification data needing migration
    /// * `unconfigured_accounts` - Accounts without tracking mode set
    /// * `configured_timezone` - App-configured timezone from settings (if available)
    /// * `client_timezone` - Client/browser timezone from request context (if available)
    ///
    /// # Returns
    ///
    /// The aggregated health status with all detected issues
    #[allow(clippy::too_many_arguments)]
    async fn run_checks_with_data(
        &self,
        base_currency: &str,
        total_portfolio_value: f64,
        holdings: &[AssetHoldingInfo],
        latest_quote_times: &HashMap<String, DateTime<Utc>>,
        quote_sync_errors: &[QuoteSyncErrorInfo],
        fx_pairs: &[FxPairInfo],
        unclassified_assets: &[UnclassifiedAssetInfo],
        consistency_issues: &[ConsistencyIssueInfo],
        legacy_migration_info: &Option<LegacyMigrationInfo>,
        unconfigured_accounts: &[UnconfiguredAccountInfo],
        configured_timezone: Option<&str>,
        client_timezone: Option<&str>,
        invalid_transfer_groups: &[InvalidTransferGroupInfo],
        invalid_exchange_groups: &[InvalidExchangeGroupInfo],
    ) -> Result<HealthStatus>;

    /// Gets the cached health status.
    ///
    /// Returns None if no checks have been run yet.
    /// Sets `is_stale` to true if the cached results are older than 5 minutes.
    async fn get_cached_status(&self) -> Option<HealthStatus>;

    /// Dismisses an issue.
    ///
    /// # Arguments
    ///
    /// * `issue_id` - The issue ID to dismiss
    /// * `data_hash` - The current data hash of the issue
    async fn dismiss_issue(&self, issue_id: &str, data_hash: &str) -> Result<()>;

    /// Restores a dismissed issue to active status.
    ///
    /// # Arguments
    ///
    /// * `issue_id` - The issue ID to restore
    async fn restore_issue(&self, issue_id: &str) -> Result<()>;

    /// Gets the list of dismissed issue IDs.
    ///
    /// # Returns
    ///
    /// IDs of all dismissed issues
    async fn get_dismissed_ids(&self) -> Result<Vec<String>>;

    /// Executes a fix action.
    ///
    /// # Arguments
    ///
    /// * `action` - The fix action to execute
    async fn execute_fix(&self, action: &FixAction) -> Result<()>;

    /// Gets the current health configuration.
    async fn get_config(&self) -> HealthConfig;

    /// Updates the health configuration.
    ///
    /// # Arguments
    ///
    /// * `config` - The new configuration
    async fn update_config(&self, config: HealthConfig) -> Result<()>;

    /// Clears the cached health status, forcing fresh checks on next request.
    async fn clear_cache(&self);

    /// Runs all health checks by gathering data from the provided services.
    ///
    /// This is the preferred method for running health checks as it handles all
    /// data gathering internally, keeping API handlers thin.
    ///
    /// # Arguments
    ///
    /// * `base_currency` - The user's base currency
    /// * `account_service` - Service for accessing accounts
    /// * `holdings_service` - Service for accessing holdings
    /// * `quote_service` - Service for accessing quotes
    /// * `asset_service` - Service for accessing assets
    /// * `taxonomy_service` - Service for accessing taxonomy data
    /// * `valuation_service` - Service for accessing account valuation history
    /// * `snapshot_service` - Service for accessing generated holdings snapshots
    /// * `activity_service` - Service for accessing activities
    /// * `lot_repository` - Repository for accessing lot disposal records
    /// * `configured_timezone` - App-configured timezone from settings
    /// * `client_timezone` - Client/browser timezone from request context
    #[allow(clippy::too_many_arguments)]
    async fn run_full_checks(
        &self,
        base_currency: &str,
        account_service: Arc<dyn AccountServiceTrait>,
        holdings_service: Arc<dyn HoldingsServiceTrait>,
        quote_service: Arc<dyn QuoteServiceTrait>,
        asset_service: Arc<dyn AssetServiceTrait>,
        taxonomy_service: Arc<dyn TaxonomyServiceTrait>,
        valuation_service: Arc<dyn ValuationServiceTrait>,
        snapshot_service: Arc<dyn SnapshotServiceTrait>,
        activity_service: Arc<dyn ActivityServiceTrait>,
        lot_repository: Arc<dyn LotRepositoryTrait>,
        configured_timezone: Option<&str>,
        client_timezone: Option<&str>,
    ) -> Result<HealthStatus>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_health_context_creation() {
        let config = HealthConfig::default();
        let ctx = HealthContext::new(config.clone(), "USD", 100_000.0);

        assert_eq!(ctx.base_currency, "USD");
        assert_eq!(ctx.total_portfolio_value, 100_000.0);
        assert_eq!(ctx.config, config);
    }

    #[test]
    fn test_health_context_with_timestamp() {
        let config = HealthConfig::default();
        let ts = Utc::now();
        let ctx = HealthContext::with_timestamp(config, "EUR", 50_000.0, ts);

        assert_eq!(ctx.base_currency, "EUR");
        assert_eq!(ctx.now, ts);
    }
}
