use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use crate::{
    ai_environment::ServerAiEnvironment, auth::AuthManager, config::Config,
    domain_events::WebDomainEventSink, events::EventBus, secrets::build_secret_store,
};
use tracing::{error, warn};
use tracing_subscriber::prelude::*;
use tracing_subscriber::{fmt, EnvFilter};
use wealthfolio_ai::{AiProviderService, AiProviderServiceTrait, ChatConfig, ChatService};
use wealthfolio_connect::{
    BrokerSyncService, BrokerSyncServiceTrait, CoreImportRunRepositoryAdapter,
    ImportRunRepositoryTrait, TokenLifecycleState,
};
use wealthfolio_core::addons::{AddonService, AddonServiceTrait};
use wealthfolio_core::{
    accounts::AccountService,
    activities::{ActivityService as CoreActivityService, ActivityServiceTrait},
    assets::{
        AlternativeAssetRepositoryTrait, AlternativeAssetService, AlternativeAssetServiceTrait,
        AssetClassificationService, AssetService, AssetServiceTrait,
    },
    events::DomainEventSink,
    fx::{FxService, FxServiceTrait},
    goals::{GoalService, GoalServiceTrait},
    health::{HealthService, HealthServiceTrait},
    limits::{ContributionLimitService, ContributionLimitServiceTrait},
    portfolio::allocation::{AllocationService, AllocationServiceTrait},
    portfolio::income::{IncomeService, IncomeServiceTrait},
    portfolio::{
        holdings::{
            holdings_valuation_service::HoldingsValuationService, HoldingsService,
            HoldingsServiceTrait,
        },
        net_worth::{NetWorthService, NetWorthServiceTrait},
        snapshot::{SnapshotService, SnapshotServiceTrait},
        valuation::{ValuationService, ValuationServiceTrait},
    },
    portfolios::{PortfolioService, PortfolioServiceTrait},
    quotes::{QuoteService, QuoteServiceTrait},
    secrets::SecretStore,
    settings::{SettingsRepositoryTrait, SettingsService, SettingsServiceTrait},
    taxonomies::{TaxonomyService, TaxonomyServiceTrait},
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

pub struct AppState {
    /// Domain event sink for emitting events after mutations.
    /// Note: The sink is used by services injected at construction time; this field
    /// is kept for documentation and possible future access patterns.
    #[allow(dead_code)]
    pub domain_event_sink: Arc<dyn DomainEventSink>,
    pub account_service: Arc<AccountService>,
    pub settings_service: Arc<SettingsService>,
    pub holdings_service: Arc<dyn HoldingsServiceTrait + Send + Sync>,
    pub valuation_service: Arc<dyn ValuationServiceTrait + Send + Sync>,
    pub allocation_service: Arc<dyn AllocationServiceTrait + Send + Sync>,
    pub quote_service: Arc<dyn QuoteServiceTrait + Send + Sync>,
    pub base_currency: Arc<RwLock<String>>,
    pub timezone: Arc<RwLock<String>>,
    pub snapshot_service: Arc<dyn SnapshotServiceTrait + Send + Sync>,
    /// Direct repository handle. No handler reads it currently — snapshot
    /// access goes through `snapshot_service`. Retained for tests and any
    /// future maintenance path that needs raw repository access.
    #[allow(dead_code)]
    pub snapshot_repository: Arc<SnapshotRepository>,
    pub lots_repository: Arc<dyn wealthfolio_core::lots::LotRepositoryTrait + Send + Sync>,
    pub performance_service:
        Arc<dyn wealthfolio_core::portfolio::performance::PerformanceServiceTrait + Send + Sync>,
    pub income_service: Arc<dyn IncomeServiceTrait + Send + Sync>,
    pub goal_service: Arc<dyn GoalServiceTrait + Send + Sync>,
    pub limits_service: Arc<dyn ContributionLimitServiceTrait + Send + Sync>,
    pub fx_service: Arc<dyn FxServiceTrait + Send + Sync>,
    pub activity_service: Arc<dyn ActivityServiceTrait + Send + Sync>,
    pub asset_service: Arc<dyn AssetServiceTrait + Send + Sync>,
    pub taxonomy_service: Arc<dyn TaxonomyServiceTrait + Send + Sync>,
    pub net_worth_service: Arc<dyn NetWorthServiceTrait + Send + Sync>,
    pub alternative_asset_service: Arc<dyn AlternativeAssetServiceTrait + Send + Sync>,
    pub addon_service: Arc<dyn AddonServiceTrait + Send + Sync>,
    pub connect_sync_service: Arc<dyn BrokerSyncServiceTrait + Send + Sync>,
    pub ai_provider_service: Arc<dyn AiProviderServiceTrait + Send + Sync>,
    pub ai_chat_service: Arc<ChatService<ServerAiEnvironment>>,
    pub data_root: String,
    pub db_path: String,
    pub instance_id: String,
    pub secret_store: Arc<dyn SecretStore>,
    pub event_bus: EventBus,
    pub auth: Option<Arc<AuthManager>>,
    pub device_enroll_service: Arc<DeviceEnrollService>,
    pub app_sync_repository: Arc<AppSyncRepository>,
    pub device_sync_runtime: Arc<DeviceSyncRuntimeState>,
    pub health_service: Arc<dyn HealthServiceTrait + Send + Sync>,
    pub token_lifecycle: Arc<TokenLifecycleState>,
    pub custom_provider_service: Arc<wealthfolio_core::custom_provider::CustomProviderService>,
    pub portfolio_service: Arc<dyn PortfolioServiceTrait + Send + Sync>,
}

pub fn init_tracing() {
    let log_format = std::env::var("WF_LOG_FORMAT").unwrap_or_else(|_| "text".to_string());
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let registry = tracing_subscriber::registry().with(filter);

    if log_format.eq_ignore_ascii_case("json") {
        registry
            .with(fmt::layer().json().with_current_span(false))
            .init();
    } else {
        registry
            .with(fmt::layer().with_target(true).with_line_number(true))
            .init();
    }
}

#[cfg(feature = "device-sync")]
fn start_sync_outbox_wake_worker(
    mut receiver: tokio::sync::mpsc::Receiver<()>,
    state: Arc<AppState>,
) {
    tokio::spawn(async move {
        while receiver.recv().await.is_some() {
            while receiver.try_recv().is_ok() {}
            let was_running = state.device_sync_runtime.is_background_running().await;
            if let Err(err) =
                crate::api::device_sync_engine::ensure_background_engine_started(Arc::clone(&state))
                    .await
            {
                warn!(
                    "Failed to start background device sync engine after local outbox write: {}",
                    err
                );
                continue;
            }
            if was_running {
                state.device_sync_runtime.notify_sync_work_available();
            }
        }
    });
}

pub async fn build_state(config: &Config) -> anyhow::Result<Arc<AppState>> {
    // Ensure DATABASE_URL aligns with WF_DB_PATH so core picks the right file
    std::env::set_var("DATABASE_URL", &config.db_path);
    let db_path = db::init(&config.db_path)?;
    tracing::info!("Database path in use: {}", db_path);
    let data_root_path = std::path::Path::new(&db_path)
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .to_path_buf();

    let resolved_secret_path = std::env::var("WF_SECRET_FILE")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| data_root_path.join("secrets.json"));
    let file_store = build_secret_store(
        resolved_secret_path.clone(),
        Some(config.secrets_encryption_key),
        Some(&config.raw_secret_key),
    )
    .map_err(anyhow::Error::new)?;
    let secret_store: Arc<dyn SecretStore> = Arc::new(file_store);
    std::env::set_var(
        "WF_SECRET_FILE",
        resolved_secret_path.to_string_lossy().to_string(),
    );

    db::run_migrations(&db_path)?;

    let pool = db::create_pool(&db_path)?;
    let (sync_outbox_wake_sender, sync_outbox_wake_receiver) = tokio::sync::mpsc::channel(128);
    let writer = write_actor::spawn_writer_with_outbox_observer(
        (*pool).clone(),
        Arc::new(move || {
            let _ = sync_outbox_wake_sender.try_send(());
        }),
    )
    .map_err(|e| {
        error!("Failed to initialize writer actor: {}", e);
        e
    })?;

    // Domain event sink - two-phase initialization to handle circular dependencies
    // Phase 1: Create the sink (can receive events immediately, buffers until worker starts)
    let domain_event_sink = Arc::new(WebDomainEventSink::new());

    let fx_repo = Arc::new(FxRepository::new(pool.clone(), writer.clone()));
    let fx_service = Arc::new(FxService::new(fx_repo).with_event_sink(domain_event_sink.clone()));
    fx_service.initialize()?;

    let settings_repo = Arc::new(SettingsRepository::new(pool.clone(), writer.clone()));
    let settings_service = Arc::new(SettingsService::new(
        settings_repo.clone(),
        fx_service.clone(),
    ));
    let settings = settings_service.get_settings()?;
    let base_currency = Arc::new(RwLock::new(settings.base_currency));
    let timezone = Arc::new(RwLock::new(settings.timezone.clone()));

    let account_repo = Arc::new(AccountRepository::new(pool.clone(), writer.clone()));

    // Additional repositories/services for web API
    let asset_repository = Arc::new(AssetRepository::new(pool.clone(), writer.clone()));
    let market_data_repository = Arc::new(MarketDataRepository::new(pool.clone(), writer.clone()));
    let activity_repository = Arc::new(ActivityRepository::new(pool.clone(), writer.clone()));
    let snapshot_repository = Arc::new(SnapshotRepository::new(pool.clone(), writer.clone()));
    let lots_repository = Arc::new(wealthfolio_storage_sqlite::lots::LotsRepository::new(
        pool.clone(),
        writer.clone(),
    ));
    let app_sync_repository = Arc::new(AppSyncRepository::new(pool.clone(), writer.clone()));
    let quote_sync_state_repository =
        Arc::new(QuoteSyncStateRepository::new(pool.clone(), writer.clone()));

    let account_service = Arc::new(AccountService::new(
        account_repo.clone(),
        fx_service.clone(),
        base_currency.clone(),
        domain_event_sink.clone(),
        asset_repository.clone(),
        quote_sync_state_repository.clone(),
    ));
    let custom_provider_repository = Arc::new(
        wealthfolio_storage_sqlite::custom_provider::CustomProviderSqliteRepository::new(
            pool.clone(),
            writer.clone(),
        ),
    );
    let quote_service: Arc<dyn QuoteServiceTrait + Send + Sync> = Arc::new(
        QuoteService::new_with_custom_provider(
            market_data_repository.clone(),      // QuoteStore
            quote_sync_state_repository.clone(), // SyncStateStore
            market_data_repository.clone(),      // ProviderSettingsStore
            asset_repository.clone(),            // AssetRepositoryTrait
            activity_repository.clone(),         // ActivityRepositoryTrait
            secret_store.clone(),
            Some(custom_provider_repository.clone()),
        )
        .await?,
    );
    let custom_provider_service = Arc::new(
        wealthfolio_core::custom_provider::CustomProviderService::new(
            custom_provider_repository.clone(),
            secret_store.clone(),
        ),
    );

    let portfolio_repository = Arc::new(PortfolioRepository::new(pool.clone(), writer.clone()));
    let portfolio_service: Arc<dyn PortfolioServiceTrait + Send + Sync> = Arc::new(
        PortfolioService::new(portfolio_repository, account_repo.clone()),
    );

    // Create taxonomy service for auto-classification
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
    let snapshot_service = Arc::new(
        SnapshotService::new_with_timezone(
            base_currency.clone(),
            timezone.clone(),
            account_repo.clone(),
            activity_repository.clone(),
            snapshot_repository.clone(),
            asset_repository.clone(),
            fx_service.clone(),
        )
        .with_event_sink(domain_event_sink.clone())
        .with_lot_repository(lots_repository.clone()),
    );

    let valuation_repository = Arc::new(ValuationRepository::new(pool.clone(), writer.clone()));
    let valuation_service = Arc::new(ValuationService::new(
        base_currency.clone(),
        valuation_repository.clone(),
        snapshot_service.clone(),
        quote_service.clone(),
        fx_service.clone(),
    ));

    let net_worth_service: Arc<dyn NetWorthServiceTrait + Send + Sync> =
        Arc::new(NetWorthService::new(
            base_currency.clone(),
            account_repo.clone(),
            asset_repository.clone(),
            snapshot_repository.clone(),
            quote_service.clone(),
            valuation_repository.clone(),
            fx_service.clone(),
        ));

    let holdings_valuation_service = Arc::new(HoldingsValuationService::new_with_timezone(
        fx_service.clone(),
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

    let allocation_service: Arc<dyn AllocationServiceTrait + Send + Sync> = Arc::new(
        AllocationService::new(holdings_service.clone(), taxonomy_service.clone()),
    );

    let performance_service = Arc::new(
        wealthfolio_core::portfolio::performance::PerformanceService::new_with_timezone(
            valuation_service.clone(),
            quote_service.clone(),
            timezone.clone(),
        ),
    );

    let income_service = Arc::new(IncomeService::new_with_timezone(
        fx_service.clone(),
        activity_repository.clone(),
        base_currency.clone(),
        timezone.clone(),
    ));

    let goal_repository = Arc::new(GoalRepository::new(pool.clone(), writer.clone()));
    let goal_service = Arc::new(GoalService::new(goal_repository, account_service.clone()));

    let limits_repository = Arc::new(ContributionLimitRepository::new(
        pool.clone(),
        writer.clone(),
    ));
    let limits_service: Arc<dyn ContributionLimitServiceTrait + Send + Sync> =
        Arc::new(ContributionLimitService::new_with_timezone(
            fx_service.clone(),
            limits_repository.clone(),
            activity_repository.clone(),
            timezone.clone(),
        ));

    // Import run repository for tracking CSV imports
    let import_run_repository: Arc<dyn ImportRunRepositoryTrait> =
        Arc::new(ImportRunRepository::new(pool.clone(), writer.clone()));
    let core_import_run_repository = Arc::new(CoreImportRunRepositoryAdapter::new(
        import_run_repository.clone(),
    ));
    let broker_sync_state_repository =
        Arc::new(BrokerSyncStateRepository::new(pool.clone(), writer.clone()));

    let activity_service: Arc<dyn ActivityServiceTrait + Send + Sync> = Arc::new(
        CoreActivityService::with_import_run_repository(
            activity_repository.clone(),
            account_service.clone(),
            asset_service.clone(),
            fx_service.clone(),
            quote_service.clone(),
            core_import_run_repository,
        )
        .with_event_sink(domain_event_sink.clone()),
    );

    // Alternative asset repository for alternative assets operations
    let alternative_asset_repository: Arc<dyn AlternativeAssetRepositoryTrait + Send + Sync> =
        Arc::new(AlternativeAssetRepository::new(
            pool.clone(),
            writer.clone(),
        ));

    // Alternative asset service (delegates to core service)
    let alternative_asset_service: Arc<dyn AlternativeAssetServiceTrait + Send + Sync> = Arc::new(
        AlternativeAssetService::new(
            alternative_asset_repository.clone(),
            asset_repository.clone(),
            quote_service.clone(),
        )
        .with_event_sink(domain_event_sink.clone()),
    );

    // Connect sync service for broker data synchronization
    let platform_repository = Arc::new(PlatformRepository::new(pool.clone(), writer.clone()));
    let connect_sync_service: Arc<dyn BrokerSyncServiceTrait + Send + Sync> = Arc::new(
        BrokerSyncService::new(
            account_service.clone(),
            asset_service.clone(),
            activity_service.clone(),
            activity_repository.clone(),
            platform_repository,
            broker_sync_state_repository,
            import_run_repository,
            snapshot_repository.clone(),
        )
        .with_event_sink(domain_event_sink.clone())
        .with_snapshot_service(snapshot_service.clone())
        .with_quote_store(market_data_repository.clone()),
    );

    // Determine data root directory (parent of DB path)
    let data_root = data_root_path.to_string_lossy().to_string();

    // AI provider service - catalog is embedded at compile time
    let ai_catalog_json = include_str!("../../../crates/ai/src/ai_providers.json");
    let ai_provider_service: Arc<dyn AiProviderServiceTrait + Send + Sync> =
        Arc::new(AiProviderService::new(
            settings_repo.clone() as Arc<dyn SettingsRepositoryTrait>,
            secret_store.clone(),
            ai_catalog_json,
        )?);

    // Health service for portfolio health diagnostics
    let health_dismissal_repository =
        Arc::new(HealthDismissalRepository::new(pool.clone(), writer.clone()));
    let health_service: Arc<dyn HealthServiceTrait + Send + Sync> =
        Arc::new(HealthService::new(health_dismissal_repository));

    // AI chat repository for thread/message persistence
    let ai_chat_repository = Arc::new(AiChatRepository::new(pool.clone(), writer.clone()));

    // Create the AI environment and chat service using the new wealthfolio-ai crate
    let ai_environment = Arc::new(ServerAiEnvironment::new(
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
    let cloud_api_url = crate::features::cloud_api_base_url().unwrap_or_default();
    let device_display_name = "Wealthfolio Server".to_string();
    let app_version = Some(env!("CARGO_PKG_VERSION").to_string());
    let device_enroll_service = Arc::new(DeviceEnrollService::new(
        secret_store.clone(),
        &cloud_api_url,
        device_display_name,
        app_version,
    ));

    let event_bus = EventBus::new(256);
    let device_sync_runtime = Arc::new(DeviceSyncRuntimeState::new());
    let token_lifecycle = Arc::new(TokenLifecycleState::new());
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

    // Domain event sink - Phase 2: Start the worker now that all services are ready
    domain_event_sink.start_worker(
        asset_service.clone(),
        connect_sync_service.clone(),
        event_bus.clone(),
        health_service.clone(),
        snapshot_service.clone(),
        quote_service.clone(),
        valuation_service.clone(),
        account_service.clone(),
        goal_service.clone(),
        fx_service.clone(),
        timezone.clone(),
        secret_store.clone(),
        token_lifecycle.clone(),
    );

    let addon_service: Arc<dyn AddonServiceTrait + Send + Sync> = Arc::new(AddonService::new(
        &config.addons_root,
        &settings.instance_id,
    ));

    let auth_manager = config
        .auth
        .as_ref()
        .map(AuthManager::new)
        .transpose()?
        .map(Arc::new);

    let state = Arc::new(AppState {
        domain_event_sink,
        account_service,
        settings_service,
        holdings_service,
        valuation_service,
        allocation_service,
        quote_service,
        base_currency,
        timezone,
        snapshot_service,
        snapshot_repository,
        lots_repository,
        performance_service,
        income_service,
        goal_service,
        limits_service,
        fx_service: fx_service.clone(),
        activity_service,
        asset_service,
        taxonomy_service,
        net_worth_service,
        alternative_asset_service,
        addon_service,
        connect_sync_service,
        ai_provider_service,
        ai_chat_service,
        data_root,
        db_path,
        instance_id: settings.instance_id,
        secret_store,
        event_bus,
        auth: auth_manager,
        device_enroll_service,
        app_sync_repository,
        device_sync_runtime,
        health_service,
        token_lifecycle,
        custom_provider_service,
        portfolio_service,
    });

    #[cfg(feature = "device-sync")]
    start_sync_outbox_wake_worker(sync_outbox_wake_receiver, Arc::clone(&state));

    Ok(state)
}
