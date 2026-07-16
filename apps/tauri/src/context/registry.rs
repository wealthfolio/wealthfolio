use std::sync::{atomic::AtomicBool, Arc, RwLock};
use wealthfolio_ai::{AiProviderServiceTrait, ChatService};
use wealthfolio_connect::BrokerSyncServiceTrait;
use wealthfolio_core::{
    self, accounts, activities,
    addons::AddonStorageRepositoryTrait,
    assets::{self, AlternativeAssetServiceTrait},
    events::DomainEventSink,
    fx, goals, health, limits,
    lots::LotRepositoryTrait,
    portfolio, portfolios, quotes, settings, taxonomies,
};
use wealthfolio_device_sync::{engine::DeviceSyncRuntimeState, DeviceEnrollService};
use wealthfolio_spending::analytics::AnalyticsService;
use wealthfolio_spending::budget::BudgetService;
use wealthfolio_spending::cash_activities::CashActivityService;
use wealthfolio_spending::categorization_rules::CategorizationRulesService;
use wealthfolio_spending::events::EventsService;
use wealthfolio_spending::insight::InsightService;
use wealthfolio_spending::settings::SpendingSettingsService;
use wealthfolio_storage_sqlite::{
    agent::{McpAuditRepository, PatRepository},
    portfolio::snapshot::SnapshotRepository,
    sync::AppSyncRepository,
};

use super::TauriAiEnvironment;
use crate::services::ConnectService;

pub struct ServiceContext {
    pub base_currency: Arc<RwLock<String>>,
    pub timezone: Arc<RwLock<String>>,
    pub rating_instance_id: Arc<String>,

    /// Domain event sink for emitting events after mutations.
    /// Runtime bridges (Tauri/Web) implement this to trigger portfolio recalculation,
    /// asset enrichment, and broker sync based on domain events.
    /// Note: The sink is used by services injected at construction time; this field
    /// is kept for documentation and possible future access patterns.
    #[allow(dead_code)]
    pub domain_event_sink: Arc<dyn DomainEventSink>,

    // Services
    pub settings_service: Arc<dyn settings::SettingsServiceTrait>,
    pub activity_service: Arc<dyn activities::ActivityServiceTrait>,
    pub account_service: Arc<dyn accounts::AccountServiceTrait>,
    pub goal_service: Arc<dyn goals::GoalServiceTrait>,
    pub asset_service: Arc<dyn assets::AssetServiceTrait>,
    pub quote_service: Arc<dyn quotes::QuoteServiceTrait>,
    pub limits_service: Arc<dyn limits::ContributionLimitServiceTrait>,
    pub fx_service: Arc<dyn fx::FxServiceTrait>,
    pub performance_service: Arc<dyn portfolio::performance::PerformanceServiceTrait>,
    pub income_service: Arc<dyn portfolio::income::IncomeServiceTrait>,
    pub snapshot_service: Arc<dyn portfolio::snapshot::SnapshotServiceTrait>,
    pub snapshot_repository: Arc<SnapshotRepository>,
    pub lots_repository: Arc<dyn LotRepositoryTrait>,
    pub app_sync_repository: Arc<AppSyncRepository>,
    pub holdings_service: Arc<dyn portfolio::holdings::HoldingsServiceTrait>,
    pub allocation_service: Arc<dyn portfolio::allocation::AllocationServiceTrait>,
    pub allocation_target_service:
        Arc<dyn portfolio::allocation_targets::AllocationTargetServiceTrait>,
    pub drift_service: Arc<dyn portfolio::allocation_targets::DriftServiceTrait>,
    pub rebalance_service: Arc<dyn portfolio::allocation_targets::RebalanceServiceTrait>,
    pub valuation_service: Arc<dyn portfolio::valuation::ValuationServiceTrait>,
    pub net_worth_service: Arc<dyn portfolio::net_worth::NetWorthServiceTrait>,
    pub sync_service: Arc<dyn BrokerSyncServiceTrait>,
    pub alternative_asset_service: Arc<dyn AlternativeAssetServiceTrait>,
    pub taxonomy_service: Arc<dyn taxonomies::TaxonomyServiceTrait>,
    pub connect_service: Arc<ConnectService>,
    pub ai_provider_service: Arc<dyn AiProviderServiceTrait>,
    pub ai_chat_service: Arc<ChatService<TauriAiEnvironment>>,
    pub agent_environment: Arc<dyn wealthfolio_agent_tools::AgentEnvironment>,
    pub mcp_audit_repository: Arc<McpAuditRepository>,
    pub pat_repository: Arc<PatRepository>,
    pub addon_storage_repository: Arc<dyn AddonStorageRepositoryTrait>,
    pub device_enroll_service: Arc<DeviceEnrollService>,
    pub device_sync_runtime: Arc<DeviceSyncRuntimeState>,
    pub broker_sync_running: Arc<AtomicBool>,
    pub health_service: Arc<health::HealthService>,
    pub custom_provider_service: Arc<wealthfolio_core::custom_provider::CustomProviderService>,
    pub portfolio_service: Arc<dyn portfolios::PortfolioServiceTrait>,
    pub spending_settings_service: Arc<SpendingSettingsService>,
    pub cash_activity_service: Arc<CashActivityService>,
    pub categorization_rules_service: Arc<CategorizationRulesService>,
    pub events_service: Arc<EventsService>,
    pub budget_service: Arc<BudgetService>,
    pub spending_analytics_service: Arc<AnalyticsService>,
    pub spending_insight_service: Arc<InsightService>,
}

impl ServiceContext {
    pub fn get_base_currency(&self) -> String {
        self.base_currency.read().unwrap().clone()
    }

    pub fn get_timezone(&self) -> String {
        self.timezone.read().unwrap().clone()
    }

    pub fn update_base_currency(&self, new_currency: String) {
        *self.base_currency.write().unwrap() = new_currency;
    }

    pub fn update_timezone(&self, new_timezone: String) {
        *self.timezone.write().unwrap() = new_timezone;
    }

    pub fn settings_service(&self) -> Arc<dyn settings::SettingsServiceTrait> {
        Arc::clone(&self.settings_service)
    }

    pub fn spending_settings_service(&self) -> Arc<SpendingSettingsService> {
        Arc::clone(&self.spending_settings_service)
    }

    pub fn cash_activity_service(&self) -> Arc<CashActivityService> {
        Arc::clone(&self.cash_activity_service)
    }

    pub fn categorization_rules_service(&self) -> Arc<CategorizationRulesService> {
        Arc::clone(&self.categorization_rules_service)
    }

    pub fn events_service(&self) -> Arc<EventsService> {
        Arc::clone(&self.events_service)
    }

    pub fn budget_service(&self) -> Arc<BudgetService> {
        Arc::clone(&self.budget_service)
    }

    pub fn spending_analytics_service(&self) -> Arc<AnalyticsService> {
        Arc::clone(&self.spending_analytics_service)
    }

    pub fn spending_insight_service(&self) -> Arc<InsightService> {
        Arc::clone(&self.spending_insight_service)
    }

    pub fn account_service(&self) -> Arc<dyn accounts::AccountServiceTrait> {
        Arc::clone(&self.account_service)
    }

    pub fn activity_service(&self) -> Arc<dyn activities::ActivityServiceTrait> {
        Arc::clone(&self.activity_service)
    }

    pub fn asset_service(&self) -> Arc<dyn assets::AssetServiceTrait> {
        Arc::clone(&self.asset_service)
    }

    pub fn goal_service(&self) -> Arc<dyn goals::GoalServiceTrait> {
        Arc::clone(&self.goal_service)
    }

    pub fn quote_service(&self) -> Arc<dyn quotes::QuoteServiceTrait> {
        Arc::clone(&self.quote_service)
    }

    pub fn limits_service(&self) -> Arc<dyn limits::ContributionLimitServiceTrait> {
        Arc::clone(&self.limits_service)
    }

    pub fn fx_service(&self) -> Arc<dyn fx::FxServiceTrait> {
        Arc::clone(&self.fx_service)
    }

    pub fn performance_service(&self) -> Arc<dyn portfolio::performance::PerformanceServiceTrait> {
        Arc::clone(&self.performance_service)
    }

    pub fn income_service(&self) -> Arc<dyn portfolio::income::IncomeServiceTrait> {
        Arc::clone(&self.income_service)
    }

    pub fn snapshot_service(&self) -> Arc<dyn portfolio::snapshot::SnapshotServiceTrait> {
        Arc::clone(&self.snapshot_service)
    }

    pub fn snapshot_repository(&self) -> Arc<SnapshotRepository> {
        Arc::clone(&self.snapshot_repository)
    }

    pub fn holdings_service(&self) -> Arc<dyn portfolio::holdings::HoldingsServiceTrait> {
        Arc::clone(&self.holdings_service)
    }

    pub fn app_sync_repository(&self) -> Arc<AppSyncRepository> {
        Arc::clone(&self.app_sync_repository)
    }

    pub fn allocation_service(&self) -> Arc<dyn portfolio::allocation::AllocationServiceTrait> {
        Arc::clone(&self.allocation_service)
    }

    pub fn allocation_target_service(
        &self,
    ) -> Arc<dyn portfolio::allocation_targets::AllocationTargetServiceTrait> {
        Arc::clone(&self.allocation_target_service)
    }

    pub fn drift_service(&self) -> Arc<dyn portfolio::allocation_targets::DriftServiceTrait> {
        Arc::clone(&self.drift_service)
    }

    pub fn rebalance_service(
        &self,
    ) -> Arc<dyn portfolio::allocation_targets::RebalanceServiceTrait> {
        Arc::clone(&self.rebalance_service)
    }

    pub fn valuation_service(&self) -> Arc<dyn portfolio::valuation::ValuationServiceTrait> {
        Arc::clone(&self.valuation_service)
    }

    pub fn sync_service(&self) -> Arc<dyn BrokerSyncServiceTrait> {
        Arc::clone(&self.sync_service)
    }

    pub fn net_worth_service(&self) -> Arc<dyn portfolio::net_worth::NetWorthServiceTrait> {
        Arc::clone(&self.net_worth_service)
    }

    pub fn alternative_asset_service(&self) -> Arc<dyn AlternativeAssetServiceTrait> {
        Arc::clone(&self.alternative_asset_service)
    }

    pub fn taxonomy_service(&self) -> Arc<dyn taxonomies::TaxonomyServiceTrait> {
        Arc::clone(&self.taxonomy_service)
    }

    pub fn connect_service(&self) -> Arc<ConnectService> {
        Arc::clone(&self.connect_service)
    }

    pub fn ai_provider_service(&self) -> Arc<dyn AiProviderServiceTrait> {
        Arc::clone(&self.ai_provider_service)
    }

    pub fn ai_chat_service(&self) -> Arc<ChatService<TauriAiEnvironment>> {
        Arc::clone(&self.ai_chat_service)
    }

    pub fn agent_environment(&self) -> Arc<dyn wealthfolio_agent_tools::AgentEnvironment> {
        Arc::clone(&self.agent_environment)
    }

    pub fn mcp_audit_repository(&self) -> Arc<McpAuditRepository> {
        Arc::clone(&self.mcp_audit_repository)
    }

    pub fn pat_repository(&self) -> Arc<PatRepository> {
        Arc::clone(&self.pat_repository)
    }

    pub fn portfolio_service(&self) -> Arc<dyn portfolios::PortfolioServiceTrait> {
        Arc::clone(&self.portfolio_service)
    }

    pub fn device_enroll_service(&self) -> Arc<DeviceEnrollService> {
        Arc::clone(&self.device_enroll_service)
    }

    pub fn device_sync_runtime(&self) -> Arc<DeviceSyncRuntimeState> {
        Arc::clone(&self.device_sync_runtime)
    }

    pub fn broker_sync_running(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.broker_sync_running)
    }

    pub fn health_service(&self) -> Arc<health::HealthService> {
        Arc::clone(&self.health_service)
    }
}
