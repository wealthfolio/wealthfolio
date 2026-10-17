use std::sync::Arc;
use wealthfolio_agent_tools::AgentEnvironment;

pub struct TaxonomyEnv {
    pub taxonomies: Arc<dyn wealthfolio_core::taxonomies::TaxonomyServiceTrait>,
}

impl AgentEnvironment for TaxonomyEnv {
    fn base_currency(&self) -> String {
        "USD".to_string()
    }
    fn account_service(&self) -> Arc<dyn wealthfolio_core::accounts::AccountServiceTrait> {
        unimplemented!("TaxonomyEnv")
    }
    fn activity_service(&self) -> Arc<dyn wealthfolio_core::activities::ActivityServiceTrait> {
        unimplemented!("TaxonomyEnv")
    }
    fn holdings_service(
        &self,
    ) -> Arc<dyn wealthfolio_core::portfolio::holdings::HoldingsServiceTrait> {
        unimplemented!("TaxonomyEnv")
    }
    fn valuation_service(
        &self,
    ) -> Arc<dyn wealthfolio_core::portfolio::valuation::ValuationServiceTrait> {
        unimplemented!("TaxonomyEnv")
    }
    fn goal_service(&self) -> Arc<dyn wealthfolio_core::goals::GoalServiceTrait> {
        unimplemented!("TaxonomyEnv")
    }
    fn settings_service(&self) -> Arc<dyn wealthfolio_core::settings::SettingsServiceTrait> {
        unimplemented!("TaxonomyEnv")
    }
    fn quote_service(&self) -> Arc<dyn wealthfolio_core::quotes::QuoteServiceTrait> {
        unimplemented!("TaxonomyEnv")
    }
    fn asset_service(&self) -> Arc<dyn wealthfolio_core::assets::AssetServiceTrait> {
        unimplemented!("TaxonomyEnv")
    }
    fn allocation_service(
        &self,
    ) -> Arc<dyn wealthfolio_core::portfolio::allocation::AllocationServiceTrait> {
        unimplemented!("TaxonomyEnv")
    }
    fn performance_service(
        &self,
    ) -> Arc<dyn wealthfolio_core::portfolio::performance::PerformanceServiceTrait> {
        unimplemented!("TaxonomyEnv")
    }
    fn income_service(&self) -> Arc<dyn wealthfolio_core::portfolio::income::IncomeServiceTrait> {
        unimplemented!("TaxonomyEnv")
    }
    fn health_service(&self) -> Arc<dyn wealthfolio_core::health::HealthServiceTrait> {
        unimplemented!("TaxonomyEnv")
    }
    fn taxonomy_service(&self) -> Arc<dyn wealthfolio_core::taxonomies::TaxonomyServiceTrait> {
        self.taxonomies.clone()
    }
    fn portfolio_service(&self) -> Arc<dyn wealthfolio_core::portfolios::PortfolioServiceTrait> {
        unimplemented!("TaxonomyEnv")
    }
    fn net_worth_service(
        &self,
    ) -> Arc<dyn wealthfolio_core::portfolio::net_worth::NetWorthServiceTrait> {
        unimplemented!("TaxonomyEnv")
    }
    fn contribution_limit_service(
        &self,
    ) -> Arc<dyn wealthfolio_core::limits::ContributionLimitServiceTrait> {
        unimplemented!("TaxonomyEnv")
    }
    fn cash_activity_service(
        &self,
    ) -> Arc<dyn wealthfolio_spending::cash_activities::CashActivityServiceTrait> {
        unimplemented!("TaxonomyEnv")
    }
    fn categorization_rules_service(
        &self,
    ) -> Arc<dyn wealthfolio_spending::categorization_rules::CategorizationRulesServiceTrait> {
        unimplemented!("TaxonomyEnv")
    }
}
