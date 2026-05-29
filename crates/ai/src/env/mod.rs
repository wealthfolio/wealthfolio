//! Environment abstraction for AI assistant.
//!
//! This module provides the `AiEnvironment` trait that abstracts runtime
//! dependencies like secret stores, services, and configuration. The Tauri
//! and Axum backends implement this trait with their specific service instances.

use async_trait::async_trait;
use std::sync::Arc;
use wealthfolio_core::{
    accounts::AccountServiceTrait,
    activities::ActivityServiceTrait,
    goals::GoalServiceTrait,
    health::HealthServiceTrait,
    portfolio::{
        allocation::AllocationServiceTrait, holdings::HoldingsServiceTrait,
        income::IncomeServiceTrait, performance::PerformanceServiceTrait,
        valuation::ValuationServiceTrait,
    },
    quotes::QuoteServiceTrait,
    secrets::SecretStore,
    settings::SettingsServiceTrait,
    taxonomies::TaxonomyServiceTrait,
};
use wealthfolio_spending::activity_assignments::ActivityTaxonomyAssignmentService;
use wealthfolio_spending::cash_activities::CashActivityService;
use wealthfolio_spending::categorization_rules::CategorizationRulesService;

use crate::types::ChatRepositoryTrait;

/// Environment abstraction for the AI assistant.
///
/// Implementations provide access to:
/// - Service traits for portfolio data access
/// - Secret store for API keys
/// - Configuration (base currency, etc.)
/// - Chat repository for thread/message persistence
/// - Quote service for symbol search
#[async_trait]
pub trait AiEnvironment: Send + Sync {
    /// Get the user's base currency (e.g., "USD", "EUR").
    fn base_currency(&self) -> String;

    /// Get the account service for fetching accounts.
    fn account_service(&self) -> Arc<dyn AccountServiceTrait>;

    /// Get the activity service for fetching/saving activities.
    fn activity_service(&self) -> Arc<dyn ActivityServiceTrait>;

    /// Get the holdings service for fetching holdings.
    fn holdings_service(&self) -> Arc<dyn HoldingsServiceTrait>;

    /// Get the valuation service for fetching valuations.
    fn valuation_service(&self) -> Arc<dyn ValuationServiceTrait>;

    /// Get the goal service for fetching goals.
    fn goal_service(&self) -> Arc<dyn GoalServiceTrait>;

    /// Get the settings service for storing AI settings.
    fn settings_service(&self) -> Arc<dyn SettingsServiceTrait>;

    /// Get the secret store for API keys.
    fn secret_store(&self) -> Arc<dyn SecretStore>;

    /// Get the chat repository for thread/message persistence.
    fn chat_repository(&self) -> Arc<dyn ChatRepositoryTrait>;

    /// Get the quote service for symbol search.
    fn quote_service(&self) -> Arc<dyn QuoteServiceTrait>;

    /// Get the allocation service for portfolio allocations.
    fn allocation_service(&self) -> Arc<dyn AllocationServiceTrait>;

    /// Get the performance service for portfolio performance metrics.
    fn performance_service(&self) -> Arc<dyn PerformanceServiceTrait>;

    /// Get the income service for income/dividend summaries.
    fn income_service(&self) -> Arc<dyn IncomeServiceTrait>;

    /// Get the health service for portfolio health diagnostics.
    fn health_service(&self) -> Arc<dyn HealthServiceTrait>;

    /// Get the taxonomy service for fetching taxonomies and categories.
    fn taxonomy_service(&self) -> Arc<dyn TaxonomyServiceTrait>;

    /// Get the cash-activity service for spending-tracker reads.
    fn cash_activity_service(&self) -> Arc<CashActivityService>;

    /// Get the activity-taxonomy-assignment service for category writes.
    fn activity_taxonomy_assignment_service(&self) -> Arc<ActivityTaxonomyAssignmentService>;

    /// Get the categorization-rules service for the rules-first pass in category proposals.
    fn categorization_rules_service(&self) -> Arc<CategorizationRulesService>;
}

#[cfg(any(test, feature = "test-utils"))]
pub mod test_env;
