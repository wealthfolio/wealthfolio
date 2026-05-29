//! Tauri-side implementation of AiEnvironment.
//!
//! Provides the wealthfolio-ai crate with access to Tauri services
//! for tool execution and settings management.

use std::sync::{Arc, RwLock};

use wealthfolio_ai::{AiEnvironment, ChatRepositoryTrait};
use wealthfolio_core::{
    accounts::AccountServiceTrait, activities::ActivityServiceTrait,
    allocation::AllocationServiceTrait, goals::GoalServiceTrait, health::HealthServiceTrait,
    holdings::HoldingsServiceTrait, income::IncomeServiceTrait,
    performance::PerformanceServiceTrait, quotes::QuoteServiceTrait, secrets::SecretStore,
    settings::SettingsServiceTrait, taxonomies::TaxonomyServiceTrait,
    valuation::ValuationServiceTrait,
};
use wealthfolio_spending::activity_assignments::ActivityTaxonomyAssignmentService;
use wealthfolio_spending::cash_activities::CashActivityService;
use wealthfolio_spending::categorization_rules::CategorizationRulesService;

/// Tauri-side implementation of AiEnvironment.
///
/// Wraps existing services from ServiceContext to provide access
/// to the AI crate for tool execution.
pub struct TauriAiEnvironment {
    base_currency: Arc<RwLock<String>>,
    account_service: Arc<dyn AccountServiceTrait + Send + Sync>,
    activity_service: Arc<dyn ActivityServiceTrait + Send + Sync>,
    holdings_service: Arc<dyn HoldingsServiceTrait + Send + Sync>,
    valuation_service: Arc<dyn ValuationServiceTrait + Send + Sync>,
    goal_service: Arc<dyn GoalServiceTrait + Send + Sync>,
    settings_service: Arc<dyn SettingsServiceTrait + Send + Sync>,
    secret_store: Arc<dyn SecretStore>,
    chat_repository: Arc<dyn ChatRepositoryTrait + Send + Sync>,
    quote_service: Arc<dyn QuoteServiceTrait + Send + Sync>,
    allocation_service: Arc<dyn AllocationServiceTrait + Send + Sync>,
    performance_service: Arc<dyn PerformanceServiceTrait + Send + Sync>,
    income_service: Arc<dyn IncomeServiceTrait + Send + Sync>,
    health_service: Arc<dyn HealthServiceTrait + Send + Sync>,
    taxonomy_service: Arc<dyn TaxonomyServiceTrait + Send + Sync>,
    cash_activity_service: Arc<CashActivityService>,
    activity_taxonomy_assignment_service: Arc<ActivityTaxonomyAssignmentService>,
    categorization_rules_service: Arc<CategorizationRulesService>,
}

impl TauriAiEnvironment {
    /// Create a new Tauri AI environment.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        base_currency: Arc<RwLock<String>>,
        account_service: Arc<dyn AccountServiceTrait + Send + Sync>,
        activity_service: Arc<dyn ActivityServiceTrait + Send + Sync>,
        holdings_service: Arc<dyn HoldingsServiceTrait + Send + Sync>,
        valuation_service: Arc<dyn ValuationServiceTrait + Send + Sync>,
        goal_service: Arc<dyn GoalServiceTrait + Send + Sync>,
        settings_service: Arc<dyn SettingsServiceTrait + Send + Sync>,
        secret_store: Arc<dyn SecretStore>,
        chat_repository: Arc<dyn ChatRepositoryTrait + Send + Sync>,
        quote_service: Arc<dyn QuoteServiceTrait + Send + Sync>,
        allocation_service: Arc<dyn AllocationServiceTrait + Send + Sync>,
        performance_service: Arc<dyn PerformanceServiceTrait + Send + Sync>,
        income_service: Arc<dyn IncomeServiceTrait + Send + Sync>,
        health_service: Arc<dyn HealthServiceTrait + Send + Sync>,
        taxonomy_service: Arc<dyn TaxonomyServiceTrait + Send + Sync>,
        cash_activity_service: Arc<CashActivityService>,
        activity_taxonomy_assignment_service: Arc<ActivityTaxonomyAssignmentService>,
        categorization_rules_service: Arc<CategorizationRulesService>,
    ) -> Self {
        Self {
            base_currency,
            account_service,
            activity_service,
            holdings_service,
            valuation_service,
            goal_service,
            settings_service,
            secret_store,
            chat_repository,
            quote_service,
            allocation_service,
            performance_service,
            income_service,
            health_service,
            taxonomy_service,
            cash_activity_service,
            activity_taxonomy_assignment_service,
            categorization_rules_service,
        }
    }
}

impl AiEnvironment for TauriAiEnvironment {
    fn base_currency(&self) -> String {
        self.base_currency.read().unwrap().clone()
    }

    fn account_service(&self) -> Arc<dyn AccountServiceTrait> {
        self.account_service.clone()
    }

    fn activity_service(&self) -> Arc<dyn ActivityServiceTrait> {
        self.activity_service.clone()
    }

    fn holdings_service(&self) -> Arc<dyn HoldingsServiceTrait> {
        self.holdings_service.clone()
    }

    fn valuation_service(&self) -> Arc<dyn ValuationServiceTrait> {
        self.valuation_service.clone()
    }

    fn goal_service(&self) -> Arc<dyn GoalServiceTrait> {
        self.goal_service.clone()
    }

    fn settings_service(&self) -> Arc<dyn SettingsServiceTrait> {
        self.settings_service.clone()
    }

    fn secret_store(&self) -> Arc<dyn SecretStore> {
        self.secret_store.clone()
    }

    fn chat_repository(&self) -> Arc<dyn ChatRepositoryTrait> {
        self.chat_repository.clone()
    }

    fn quote_service(&self) -> Arc<dyn QuoteServiceTrait> {
        self.quote_service.clone()
    }

    fn allocation_service(&self) -> Arc<dyn AllocationServiceTrait> {
        self.allocation_service.clone()
    }

    fn performance_service(&self) -> Arc<dyn PerformanceServiceTrait> {
        self.performance_service.clone()
    }

    fn income_service(&self) -> Arc<dyn IncomeServiceTrait> {
        self.income_service.clone()
    }

    fn health_service(&self) -> Arc<dyn HealthServiceTrait> {
        self.health_service.clone()
    }

    fn taxonomy_service(&self) -> Arc<dyn TaxonomyServiceTrait> {
        self.taxonomy_service.clone()
    }

    fn cash_activity_service(&self) -> Arc<CashActivityService> {
        self.cash_activity_service.clone()
    }

    fn activity_taxonomy_assignment_service(&self) -> Arc<ActivityTaxonomyAssignmentService> {
        self.activity_taxonomy_assignment_service.clone()
    }

    fn categorization_rules_service(&self) -> Arc<CategorizationRulesService> {
        self.categorization_rules_service.clone()
    }
}
