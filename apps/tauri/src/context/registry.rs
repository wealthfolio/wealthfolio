use std::sync::{Arc, RwLock};
use wealthfolio_ai::{AiProviderServiceTrait, ChatService};
use wealthfolio_connect::BrokerSyncServiceTrait;
use wealthfolio_core::lots::LotRepositoryTrait;
use wealthfolio_core::{
    self, accounts, activities,
    assets::{self, AlternativeAssetServiceTrait},
    events::DomainEventSink,
    fx, goals, health, limits, portfolio, quotes, settings, taxonomies,
};
use wealthfolio_device_sync::{engine::DeviceSyncRuntimeState, DeviceEnrollService};
use wealthfolio_storage_sqlite::{
    portfolio::snapshot::SnapshotRepository, sync::AppSyncRepository,
};

use super::TauriAiEnvironment;
use crate::services::ConnectService;

pub struct ServiceContext {
    pub base_currency: Arc<RwLock<String>>,
    pub timezone: Arc<RwLock<String>>,
    pub instance_id: Arc<String>,

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
    pub valuation_service: Arc<dyn portfolio::valuation::ValuationServiceTrait>,
    pub net_worth_service: Arc<dyn portfolio::net_worth::NetWorthServiceTrait>,
    pub sync_service: Arc<dyn BrokerSyncServiceTrait>,
    pub alternative_asset_service: Arc<dyn AlternativeAssetServiceTrait>,
    pub taxonomy_service: Arc<dyn taxonomies::TaxonomyServiceTrait>,
    pub connect_service: Arc<ConnectService>,
    pub ai_provider_service: Arc<dyn AiProviderServiceTrait>,
    pub ai_chat_service: Arc<ChatService<TauriAiEnvironment>>,
    pub device_enroll_service: Arc<DeviceEnrollService>,
    pub device_sync_runtime: Arc<DeviceSyncRuntimeState>,
    pub health_service: Arc<health::HealthService>,
    pub custom_provider_service: Arc<wealthfolio_core::custom_provider::CustomProviderService>,
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

    pub fn device_enroll_service(&self) -> Arc<DeviceEnrollService> {
        Arc::clone(&self.device_enroll_service)
    }

    pub fn device_sync_runtime(&self) -> Arc<DeviceSyncRuntimeState> {
        Arc::clone(&self.device_sync_runtime)
    }

    pub fn health_service(&self) -> Arc<health::HealthService> {
        Arc::clone(&self.health_service)
    }
}
