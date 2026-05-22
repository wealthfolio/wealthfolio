use super::ai_environment::TauriAiEnvironment;
use super::registry::ServiceContext;
use crate::domain_events::TauriDomainEventSink;
use crate::secret_store::shared_secret_store;
use crate::services::ConnectService;
use log::{error, warn};
use std::sync::{Arc, RwLock};
use tokio::sync::mpsc;
use wealthfolio_ai::{AiProviderService, ChatConfig, ChatService};
use wealthfolio_connect::{
    BrokerSyncService, CoreImportRunRepositoryAdapter, ImportRunRepositoryTrait,
};
use wealthfolio_core::{
    accounts::AccountService,
    activities::ActivityService,
    assets::{AlternativeAssetService, AssetClassificationService, AssetService},
    events::DomainEvent,
    fx::{FxService, FxServiceTrait},
    goals::GoalService,
    health::HealthService,
    limits::ContributionLimitService,
    portfolio::{
        allocation::AllocationService,
        holdings::{HoldingsService, HoldingsValuationService},
        income::IncomeService,
        net_worth::NetWorthService,
        performance::PerformanceService,
        snapshot::SnapshotService,
        valuation::ValuationService,
    },
    portfolios::PortfolioService,
    quotes::{QuoteService, QuoteServiceTrait},
    settings::{SettingsRepositoryTrait, SettingsService, SettingsServiceTrait},
    taxonomies::TaxonomyService,
};
use wealthfolio_device_sync::{engine::DeviceSyncRuntimeState, DeviceEnrollService};
use wealthfolio_storage_sqlite::{
    accounts::AccountRepository,
    activities::ActivityRepository,
    ai_chat::AiChatRepository,
    assets::{AlternativeAssetRepository, AssetRepository},
    db::{self, write_actor},
    fx::FxRepository,
    goals::GoalRepository,
    health::HealthDismissalRepository,
    limits::ContributionLimitRepository,
    market_data::{MarketDataRepository, QuoteSyncStateRepository},
    portfolio::{snapshot::SnapshotRepository, valuation::ValuationRepository},
    portfolios::PortfolioRepository,
    settings::SettingsRepository,
    sync::{AppSyncRepository, BrokerSyncStateRepository, ImportRunRepository, PlatformRepository},
    taxonomies::TaxonomyRepository,
};

/// Result of context initialization, including the receiver for domain events.
pub struct ContextInitResult {
    pub context: ServiceContext,
    pub event_receiver: mpsc::UnboundedReceiver<DomainEvent>,
    pub sync_outbox_wake_receiver: mpsc::Receiver<()>,
}

pub async fn initialize_context(
    app_data_dir: &str,
) -> Result<ContextInitResult, Box<dyn std::error::Error>> {
    let db_path = db::init(app_data_dir)?;
    db::run_migrations(&db_path)?;

    let pool = db::create_pool(&db_path)?;
    let (sync_outbox_wake_sender, sync_outbox_wake_receiver) = mpsc::channel(128);
    let writer = write_actor::spawn_writer_with_outbox_observer(
        pool.as_ref().clone(),
        Arc::new(move || {
            let _ = sync_outbox_wake_sender.try_send(());
        }),
    )
    .map_err(|e| {
        error!("Failed to initialize writer actor: {}", e);
        e
    })?;

    // Instantiate Repositories
    let settings_repository = Arc::new(SettingsRepository::new(pool.clone(), writer.clone()));
    let account_repository = Arc::new(AccountRepository::new(pool.clone(), writer.clone()));
    let activity_repository = Arc::new(ActivityRepository::new(pool.clone(), writer.clone()));
    let asset_repository = Arc::new(AssetRepository::new(pool.clone(), writer.clone()));
    let goal_repo = Arc::new(GoalRepository::new(pool.clone(), writer.clone()));
    let market_data_repo = Arc::new(MarketDataRepository::new(pool.clone(), writer.clone()));
    let limit_repository = Arc::new(ContributionLimitRepository::new(
        pool.clone(),
        writer.clone(),
    ));
    let fx_repository = Arc::new(FxRepository::new(pool.clone(), writer.clone()));
    let snapshot_repository = Arc::new(SnapshotRepository::new(pool.clone(), writer.clone()));
    let lots_repository = Arc::new(wealthfolio_storage_sqlite::lots::LotsRepository::new(
        pool.clone(),
        writer.clone(),
    ));
    let app_sync_repository = Arc::new(AppSyncRepository::new(pool.clone(), writer.clone()));
    let valuation_repository = Arc::new(ValuationRepository::new(pool.clone(), writer.clone()));
    let platform_repository = Arc::new(PlatformRepository::new(pool.clone(), writer.clone()));
    let broker_sync_state_repository =
        Arc::new(BrokerSyncStateRepository::new(pool.clone(), writer.clone()));

    // Domain event sink - TauriDomainEventSink sends events to a channel
    // The worker will be started by the caller after the context is managed
    // Must be created before services that emit events
    let (domain_event_sink, event_receiver) = TauriDomainEventSink::new();
    let domain_event_sink: Arc<dyn wealthfolio_core::events::DomainEventSink> =
        Arc::new(domain_event_sink);

    let fx_service =
        Arc::new(FxService::new(fx_repository.clone()).with_event_sink(domain_event_sink.clone()));
    fx_service.initialize()?;

    let settings_service = Arc::new(SettingsService::new(
        settings_repository.clone(),
        fx_service.clone(),
    ));
    let settings = settings_service.get_settings()?;
    let base_currency_string = settings.base_currency.clone();
    let base_currency = Arc::new(RwLock::new(base_currency_string.clone()));
    let timezone = Arc::new(RwLock::new(settings.timezone.clone()));
    let instance_id = Arc::new(settings.instance_id.clone());

    let secret_store = shared_secret_store();

    // Custom provider repository
    let custom_provider_repository = Arc::new(
        wealthfolio_storage_sqlite::custom_provider::CustomProviderSqliteRepository::new(
            pool.clone(),
            writer.clone(),
        ),
    );

    // Quote sync state repository for optimized quote syncing
    let quote_sync_state_repository =
        Arc::new(QuoteSyncStateRepository::new(pool.clone(), writer.clone()));

    // QuoteService provides all quote operations via QuoteServiceTrait
    let quote_service: Arc<dyn QuoteServiceTrait> = Arc::new(
        QuoteService::new_with_custom_provider(
            market_data_repo.clone(),            // QuoteStore
            quote_sync_state_repository.clone(), // SyncStateStore
            market_data_repo.clone(),            // ProviderSettingsStore
            asset_repository.clone(),            // AssetRepositoryTrait
            activity_repository.clone(),         // ActivityRepositoryTrait
            secret_store.clone(),
            Some(custom_provider_repository.clone()),
        )
        .await?,
    );

    // Portfolio service
    let portfolio_repository = Arc::new(PortfolioRepository::new(pool.clone(), writer.clone()));
    let portfolio_service = Arc::new(PortfolioService::new(
        portfolio_repository,
        account_repository.clone(),
    ));

    // Custom provider service
    let custom_provider_service = Arc::new(
        wealthfolio_core::custom_provider::CustomProviderService::new(
            custom_provider_repository.clone(),
            secret_store.clone(),
        ),
    );

    // Create taxonomy service before asset service (needed for auto-classification)
    let taxonomy_repository = Arc::new(TaxonomyRepository::new(pool.clone(), writer.clone()));
    let taxonomy_service = Arc::new(TaxonomyService::new(taxonomy_repository));

    let asset_service = Arc::new(
        AssetService::with_taxonomy_service(
            asset_repository.clone(),
            quote_service.clone(),
            taxonomy_service.clone(),
        )?
        .with_event_sink(domain_event_sink.clone()),
    );

    let account_service = Arc::new(AccountService::new(
        account_repository.clone(),
        fx_service.clone(),
        base_currency.clone(),
        domain_event_sink.clone(),
        asset_repository.clone(),
        quote_sync_state_repository.clone(),
    ));

    // Import run repository for tracking CSV imports
    let import_run_repository: Arc<dyn ImportRunRepositoryTrait> =
        Arc::new(ImportRunRepository::new(pool.clone(), writer.clone()));
    let core_import_run_repository = Arc::new(CoreImportRunRepositoryAdapter::new(
        import_run_repository.clone(),
    ));

    let activity_service = Arc::new(
        ActivityService::with_import_run_repository(
            activity_repository.clone(),
            account_service.clone(),
            asset_service.clone(),
            fx_service.clone(),
            quote_service.clone(),
            core_import_run_repository,
        )
        .with_event_sink(domain_event_sink.clone()),
    );
    let goal_service = Arc::new(GoalService::new(goal_repo.clone(), account_service.clone()));
    let limits_service = Arc::new(ContributionLimitService::new_with_timezone(
        fx_service.clone(),
        limit_repository.clone(),
        activity_repository.clone(),
        timezone.clone(),
    ));

    let income_service = Arc::new(IncomeService::new_with_timezone(
        fx_service.clone(),
        activity_repository.clone(),
        base_currency.clone(),
        timezone.clone(),
    ));

    let snapshot_service = Arc::new(
        SnapshotService::new_with_timezone(
            base_currency.clone(),
            timezone.clone(),
            account_repository.clone(),
            activity_repository.clone(),
            snapshot_repository.clone(),
            asset_repository.clone(),
            fx_service.clone(),
        )
        .with_event_sink(domain_event_sink.clone())
        .with_lot_repository(lots_repository.clone()),
    );

    let holdings_valuation_service = Arc::new(HoldingsValuationService::new_with_timezone(
        fx_service.clone(),
        quote_service.clone(),
        timezone.clone(),
    ));

    let valuation_service = Arc::new(ValuationService::new(
        base_currency.clone(),
        valuation_repository.clone(),
        snapshot_service.clone(),
        quote_service.clone(),
        fx_service.clone(),
    ));

    let performance_service = Arc::new(PerformanceService::new_with_timezone(
        valuation_service.clone(),
        quote_service.clone(),
        timezone.clone(),
    ));

    let classification_service =
        Arc::new(AssetClassificationService::new(taxonomy_service.clone()));
    let holdings_service = Arc::new(HoldingsService::new_with_timezone(
        asset_service.clone(),
        snapshot_service.clone(),
        holdings_valuation_service.clone(),
        classification_service.clone(),
        timezone.clone(),
    ));

    let allocation_service = Arc::new(AllocationService::new(
        holdings_service.clone(),
        taxonomy_service.clone(),
    ));

    let net_worth_service = Arc::new(NetWorthService::new(
        base_currency.clone(),
        account_repository.clone(),
        asset_repository.clone(),
        snapshot_repository.clone(),
        quote_service.clone(),
        valuation_repository.clone(),
        fx_service.clone(),
    ));

    let alternative_asset_repository = Arc::new(AlternativeAssetRepository::new(
        pool.clone(),
        writer.clone(),
    ));

    let alternative_asset_service = Arc::new(
        AlternativeAssetService::new(
            alternative_asset_repository.clone(),
            asset_repository.clone(),
            quote_service.clone(),
        )
        .with_event_sink(domain_event_sink.clone()),
    );

    let sync_service = Arc::new(
        BrokerSyncService::new(
            account_service.clone(),
            asset_service.clone(),
            activity_service.clone(),
            activity_repository.clone(),
            platform_repository.clone(),
            broker_sync_state_repository.clone(),
            import_run_repository.clone(),
            snapshot_repository.clone(),
        )
        .with_event_sink(domain_event_sink.clone())
        .with_snapshot_service(snapshot_service.clone())
        .with_quote_store(market_data_repo.clone()),
    );

    let connect_service = Arc::new(ConnectService::new(secret_store.clone()));

    // AI provider service - catalog is embedded at compile time
    let ai_catalog_json = include_str!("../../../../crates/ai/src/ai_providers.json");
    let ai_provider_service = Arc::new(AiProviderService::new(
        settings_repository.clone() as Arc<dyn SettingsRepositoryTrait>,
        secret_store.clone(),
        ai_catalog_json,
    )?);

    // AI chat repository for thread/message persistence
    let ai_chat_repository = Arc::new(AiChatRepository::new(pool.clone(), writer.clone()));

    // Health service for portfolio health diagnostics
    let health_dismissal_repository =
        Arc::new(HealthDismissalRepository::new(pool.clone(), writer.clone()));
    let health_service = Arc::new(HealthService::new(health_dismissal_repository));

    // Create AI environment and chat service
    let ai_environment = Arc::new(TauriAiEnvironment::new(
        base_currency.clone(),
        account_service.clone(),
        activity_service.clone(),
        holdings_service.clone(),
        valuation_service.clone(),
        goal_service.clone(),
        settings_service.clone(),
        secret_store.clone(),
        ai_chat_repository,
        quote_service.clone(),
        allocation_service.clone(),
        performance_service.clone(),
        income_service.clone(),
        health_service.clone(),
    ));
    let ai_chat_service = Arc::new(ChatService::new(ai_environment, ChatConfig::default()));

    // Device enroll service for E2EE sync
    let cloud_api_url = crate::services::cloud_api_base_url().unwrap_or_default();
    let device_display_name = get_device_display_name();
    let app_version = Some(env!("CARGO_PKG_VERSION").to_string());
    let device_enroll_service = Arc::new(DeviceEnrollService::new(
        secret_store.clone(),
        &cloud_api_url,
        device_display_name,
        app_version,
    ));
    let device_sync_runtime = Arc::new(DeviceSyncRuntimeState::new());
    let now = chrono::Utc::now();
    if let Err(err) = app_sync_repository
        .prune_sync_outbox(
            now - chrono::Duration::days(7),
            now - chrono::Duration::days(30),
        )
        .await
    {
        warn!("Failed to prune local sync outbox: {}", err);
    }

    Ok(ContextInitResult {
        context: ServiceContext {
            base_currency,
            timezone,
            instance_id,
            domain_event_sink,
            settings_service,
            account_service,
            activity_service,
            asset_service,
            goal_service,
            quote_service,
            limits_service,
            fx_service,
            performance_service,
            income_service,
            snapshot_service,
            snapshot_repository,
            lots_repository,
            app_sync_repository,
            holdings_service,
            allocation_service,
            valuation_service,
            net_worth_service,
            sync_service,
            alternative_asset_service,
            taxonomy_service,
            connect_service,
            ai_provider_service,
            ai_chat_service,
            device_enroll_service,
            device_sync_runtime,
            health_service,
            custom_provider_service,
            portfolio_service,
        },
        event_receiver,
        sync_outbox_wake_receiver,
    })
}

/// Get a friendly display name for this device based on platform.
fn get_device_display_name() -> String {
    #[cfg(target_os = "macos")]
    return "My Mac".to_string();
    #[cfg(target_os = "windows")]
    return "My Windows PC".to_string();
    #[cfg(target_os = "linux")]
    return "My Linux".to_string();
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    return "My Device".to_string();
}
