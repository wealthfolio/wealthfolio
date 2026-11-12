//! Environment abstraction for agent tools.
//!
//! `AgentEnvironment` is the data-service surface tools execute against.
//! It is the runtime-neutral split of the assistant's former
//! `AiEnvironment`: everything except assistant-only concerns
//! (secret store, chat persistence), which live on the `AiEnvironment`
//! extension trait in `wealthfolio-ai`. Hosts (Tauri, Axum) implement this
//! by delegating to their already-composed service graphs.

use std::sync::Arc;
use wealthfolio_core::{
    accounts::AccountServiceTrait,
    activities::ActivityServiceTrait,
    assets::{AlternativeAssetServiceTrait, AssetServiceTrait},
    fx::FxServiceTrait,
    goals::GoalServiceTrait,
    health::{HealthServiceTrait, HealthStatus},
    limits::ContributionLimitServiceTrait,
    portfolio::{
        allocation::AllocationServiceTrait, holdings::HoldingsServiceTrait,
        income::IncomeServiceTrait, net_worth::NetWorthServiceTrait,
        performance::PerformanceServiceTrait, snapshot::SnapshotServiceTrait,
        valuation::ValuationServiceTrait,
    },
    portfolios::PortfolioServiceTrait,
    quotes::QuoteServiceTrait,
    settings::SettingsServiceTrait,
    taxonomies::TaxonomyServiceTrait,
};
use wealthfolio_spending::cash_activities::CashActivityServiceTrait;
use wealthfolio_spending::categorization_rules::CategorizationRulesServiceTrait;

/// Data-service surface available to agent tools.
#[async_trait::async_trait]
pub trait AgentEnvironment: Send + Sync {
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

    /// Get the settings service for app settings reads.
    fn settings_service(&self) -> Arc<dyn SettingsServiceTrait>;

    /// Get the quote service for symbol search.
    fn quote_service(&self) -> Arc<dyn QuoteServiceTrait>;

    /// Get the asset service for resolving local active assets.
    fn asset_service(&self) -> Arc<dyn AssetServiceTrait>;

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

    /// Get the portfolio service for reading portfolios (named account groups).
    fn portfolio_service(&self) -> Arc<dyn PortfolioServiceTrait>;

    /// Get the net-worth service for assets-minus-liabilities reads.
    fn net_worth_service(&self) -> Arc<dyn NetWorthServiceTrait>;

    /// Get the contribution-limit service for contribution-room reads.
    fn contribution_limit_service(&self) -> Arc<dyn ContributionLimitServiceTrait>;

    /// Get the cash-activity service for spending reads and category assignments.
    fn cash_activity_service(&self) -> Arc<dyn CashActivityServiceTrait>;

    /// Get the categorization-rules service for the rules-first pass in category proposals.
    fn categorization_rules_service(&self) -> Arc<dyn CategorizationRulesServiceTrait>;
    fn budget_service(&self) -> Arc<dyn wealthfolio_spending::budget::BudgetServiceTrait>;
    fn spending_events_service(&self) -> Arc<dyn wealthfolio_spending::events::EventsServiceTrait>;
    fn spending_analytics_service(
        &self,
    ) -> Arc<dyn wealthfolio_spending::analytics::AnalyticsServiceTrait>;
    fn spending_insight_service(
        &self,
    ) -> Arc<dyn wealthfolio_spending::insight::InsightServiceTrait>;

    /// The user's custom price providers. Their sources hold URLs and
    /// headers that can carry API keys, so tools must never output them.
    /// The default lists none.
    fn custom_providers(
        &self,
    ) -> wealthfolio_core::Result<Vec<wealthfolio_core::custom_provider::CustomProviderWithSources>>
    {
        Ok(Vec::new())
    }

    /// Queue a portfolio job that syncs market data with `mode`, then brings
    /// valuations up to date: the job the app's price refresh buttons start,
    /// with the host's one-at-a-time lock and retries. Returns once the job
    /// is queued. The default reports that this environment cannot start one.
    async fn request_portfolio_job(
        &self,
        mode: wealthfolio_core::quotes::MarketSyncMode,
    ) -> wealthfolio_core::Result<()> {
        let _ = mode;
        Err(wealthfolio_core::Error::Unexpected(
            "Refreshing market data is not available in this environment".to_string(),
        ))
    }

    /// The snapshot service, for reading and saving holdings snapshots. The
    /// default has none, so the tools that need it report that this
    /// environment cannot run them.
    fn snapshot_service(&self) -> Option<Arc<dyn SnapshotServiceTrait>> {
        None
    }

    /// The FX service: exchange rates, and the currency pairs a holdings
    /// snapshot registers. The default has none, as for
    /// [`Self::snapshot_service`].
    fn fx_service(&self) -> Option<Arc<dyn FxServiceTrait>> {
        None
    }

    /// The alternative asset service, for creating alternative assets and
    /// liabilities. The default has none, as for [`Self::snapshot_service`].
    fn alternative_asset_service(&self) -> Option<Arc<dyn AlternativeAssetServiceTrait>> {
        None
    }

    /// Run the Health Center's full checks, as its "run checks" does, and
    /// cache the result. Hosts implement it with the services the checks
    /// read; the default reports that this environment cannot run them.
    async fn run_health_checks(&self) -> wealthfolio_core::Result<HealthStatus> {
        Err(wealthfolio_core::Error::Unexpected(
            "Running health checks is not available in this environment".to_string(),
        ))
    }
}
