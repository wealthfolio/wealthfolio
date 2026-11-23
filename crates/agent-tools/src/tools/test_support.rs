//! Test helpers for tool tests that must not reach a service.

/// Implements every service accessor of `AgentEnvironment` as a failure, so
/// a test env only writes the methods it expects a tool to call.
macro_rules! unreachable_services {
    () => {
        fn base_currency(&self) -> String {
            "USD".to_string()
        }
        $crate::tools::test_support::unreachable_services!(@each
            account_service: dyn wealthfolio_core::accounts::AccountServiceTrait,
            activity_service: dyn wealthfolio_core::activities::ActivityServiceTrait,
            holdings_service: dyn wealthfolio_core::portfolio::holdings::HoldingsServiceTrait,
            valuation_service: dyn wealthfolio_core::portfolio::valuation::ValuationServiceTrait,
            goal_service: dyn wealthfolio_core::goals::GoalServiceTrait,
            settings_service: dyn wealthfolio_core::settings::SettingsServiceTrait,
            quote_service: dyn wealthfolio_core::quotes::QuoteServiceTrait,
            asset_service: dyn wealthfolio_core::assets::AssetServiceTrait,
            allocation_service: dyn wealthfolio_core::portfolio::allocation::AllocationServiceTrait,
            performance_service: dyn wealthfolio_core::portfolio::performance::PerformanceServiceTrait,
            income_service: dyn wealthfolio_core::portfolio::income::IncomeServiceTrait,
            health_service: dyn wealthfolio_core::health::HealthServiceTrait,
            taxonomy_service: dyn wealthfolio_core::taxonomies::TaxonomyServiceTrait,
            portfolio_service: dyn wealthfolio_core::portfolios::PortfolioServiceTrait,
            net_worth_service: dyn wealthfolio_core::portfolio::net_worth::NetWorthServiceTrait,
            contribution_limit_service: dyn wealthfolio_core::limits::ContributionLimitServiceTrait,
            cash_activity_service: dyn wealthfolio_spending::cash_activities::CashActivityServiceTrait,
            categorization_rules_service: dyn wealthfolio_spending::categorization_rules::CategorizationRulesServiceTrait,
            budget_service: dyn wealthfolio_spending::budget::BudgetServiceTrait,
            spending_events_service: dyn wealthfolio_spending::events::EventsServiceTrait,
            spending_analytics_service: dyn wealthfolio_spending::analytics::AnalyticsServiceTrait,
            spending_insight_service: dyn wealthfolio_spending::insight::InsightServiceTrait,
        );
    };
    (@each $($name:ident: $ty:ty),* $(,)?) => {
        $(fn $name(&self) -> std::sync::Arc<$ty> {
            unreachable!(concat!(stringify!($name), " accessed"))
        })*
    };
}
pub(crate) use unreachable_services;
