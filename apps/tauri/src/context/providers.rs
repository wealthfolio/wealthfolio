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
        allocation_targets::{AllocationTargetService, DriftService, RebalanceService},
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
    addons::AddonStorageRepository,
    agent::{McpAuditRepository, PatRepository},
    ai_chat::AiChatRepository,
    assets::{AlternativeAssetRepository, AssetRepository},
    db::{self, write_actor},
    fx::FxRepository,
    goals::GoalRepository,
    health::HealthDismissalRepository,
    limits::ContributionLimitRepository,
    market_data::{MarketDataRepository, QuoteSyncStateRepository},
    portfolio::{
        allocation_targets::AllocationTargetRepository, snapshot::SnapshotRepository,
        valuation::ValuationRepository,
    },
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

    // Spending settings service (uses the same app_settings k/v store)
    let spending_settings_repo: Arc<
        dyn wealthfolio_spending::settings::SpendingSettingsRepositoryTrait,
    > = Arc::new(
        wealthfolio_storage_sqlite::spending::settings::SpendingSettingsRepository::new(
            pool.clone(),
            writer.clone(),
        ),
    );
    let spending_settings_service = Arc::new(
        wealthfolio_spending::settings::SpendingSettingsService::new(spending_settings_repo),
    );

    // Spending: activity_taxonomy_assignments adapter (built before activity_service so we can pass
    // both into the cash_activity service after activity_repository is created)
    let activity_assignments_repo: Arc<
        dyn wealthfolio_spending::activity_assignments::ActivityTaxonomyAssignmentRepositoryTrait,
    > = Arc::new(
        wealthfolio_storage_sqlite::spending::activity_assignments::ActivityTaxonomyAssignmentRepository::new(
            pool.clone(),
            writer.clone(),
        ),
    );
    // Activity ↔ event tag join table (sidecar to activities; see
    // crates/spending/src/activity_events for the design rationale).
    let activity_events_repo: Arc<
        dyn wealthfolio_spending::activity_events::ActivityEventsRepositoryTrait,
    > = Arc::new(
        wealthfolio_storage_sqlite::spending::activity_events::ActivityEventsRepository::new(
            pool.clone(),
            writer.clone(),
        ),
    );
    let activity_splits_repo: Arc<
        dyn wealthfolio_spending::activity_splits::ActivitySplitRepositoryTrait,
    > = Arc::new(
        wealthfolio_storage_sqlite::spending::activity_splits::ActivitySplitRepository::new(
            pool.clone(),
            writer.clone(),
        ),
    );
    let activity_taxonomy_assignment_service = Arc::new(
        wealthfolio_spending::activity_assignments::ActivityTaxonomyAssignmentService::new(
            activity_assignments_repo.clone(),
        ),
    );
    let settings = settings_service.get_settings()?;
    let base_currency_string = settings.base_currency.clone();
    let base_currency = Arc::new(RwLock::new(base_currency_string.clone()));
    let timezone = Arc::new(RwLock::new(settings.timezone.clone()));
    let rating_instance_id = Arc::new(
        settings_service
            .get_setting_value("instance_id")?
            .ok_or_else(|| std::io::Error::other("Missing internal instance ID"))?,
    );

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
    let taxonomy_service = Arc::new(
        TaxonomyService::new(taxonomy_repository).with_event_sink(domain_event_sink.clone()),
    );

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

    // Spending: events + event_types
    let event_types_repo: Arc<dyn wealthfolio_spending::events::EventTypesRepositoryTrait> =
        Arc::new(
            wealthfolio_storage_sqlite::spending::events::EventTypesRepository::new(
                pool.clone(),
                writer.clone(),
            ),
        );
    let events_repo: Arc<dyn wealthfolio_spending::events::EventsRepositoryTrait> = Arc::new(
        wealthfolio_storage_sqlite::spending::events::EventsRepository::new(
            pool.clone(),
            writer.clone(),
        ),
    );
    let events_service = Arc::new(wealthfolio_spending::events::EventsService::new(
        event_types_repo,
        events_repo,
        activity_repository.clone(),
        activity_events_repo.clone(),
    ));

    // Spending: cash_activity_service depends on the activity_repository + spending settings
    //          + the assignments service (so search() can batch-fetch assignments and apply
    //          status/category filters server-side).
    let cash_activity_service = Arc::new(
        wealthfolio_spending::cash_activities::CashActivityService::new(
            activity_repository.clone(),
            account_repository.clone(),
            spending_settings_service.clone(),
            activity_taxonomy_assignment_service.clone(),
            activity_splits_repo.clone(),
            activity_events_repo.clone(),
            events_service.clone(),
        ),
    );

    // Spending: categorization_rules
    let categorization_rules_repo: Arc<
        dyn wealthfolio_spending::categorization_rules::CategorizationRulesRepositoryTrait,
    > = Arc::new(
        wealthfolio_storage_sqlite::spending::categorization_rules::CategorizationRulesRepository::new(
            pool.clone(),
            writer.clone(),
        ),
    );
    let categorization_rules_service = Arc::new(
        wealthfolio_spending::categorization_rules::CategorizationRulesService::new(
            categorization_rules_repo,
            activity_repository.clone(),
            activity_taxonomy_assignment_service.clone(),
        ),
    );

    // Spending: budget
    let budget_repo: Arc<dyn wealthfolio_spending::budget::BudgetRepositoryTrait> = Arc::new(
        wealthfolio_storage_sqlite::spending::budget::BudgetRepository::new(
            pool.clone(),
            writer.clone(),
        ),
    );
    let budget_service = Arc::new(wealthfolio_spending::budget::BudgetService::new(
        budget_repo,
        activity_repository.clone(),
        account_repository.clone(),
        activity_assignments_repo.clone(),
        activity_splits_repo.clone(),
        spending_settings_service.clone(),
        taxonomy_service.clone(),
        fx_service.clone(),
    ));

    // Spending: analytics — needs activity repo + assignment repo (re-built since the
    // assignment service doesn't expose the trait). Cheap.
    let analytics_assignment_repo: Arc<
        dyn wealthfolio_spending::activity_assignments::ActivityTaxonomyAssignmentRepositoryTrait,
    > = Arc::new(
        wealthfolio_storage_sqlite::spending::activity_assignments::ActivityTaxonomyAssignmentRepository::new(
            pool.clone(),
            writer.clone(),
        ),
    );
    let spending_analytics_service =
        Arc::new(wealthfolio_spending::analytics::AnalyticsService::new(
            activity_repository.clone(),
            account_repository.clone(),
            analytics_assignment_repo.clone(),
            activity_splits_repo.clone(),
            spending_settings_service.clone(),
            taxonomy_service.clone(),
            events_service.clone(),
            fx_service.clone(),
            activity_events_repo.clone(),
        ));

    // Spending: reconciled period insight (powers the Spending Insight dashboard).
    let spending_insight_repo: Arc<dyn wealthfolio_spending::budget::BudgetRepositoryTrait> =
        Arc::new(
            wealthfolio_storage_sqlite::spending::budget::BudgetRepository::new(
                pool.clone(),
                writer.clone(),
            ),
        );
    let spending_insight_service = Arc::new(wealthfolio_spending::insight::InsightService::new(
        spending_insight_repo,
        activity_repository.clone(),
        account_repository.clone(),
        analytics_assignment_repo,
        activity_splits_repo,
        spending_settings_service.clone(),
        taxonomy_service.clone(),
        fx_service.clone(),
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

    let valuation_service = Arc::new(
        ValuationService::new(
            base_currency.clone(),
            valuation_repository.clone(),
            snapshot_service.clone(),
            quote_service.clone(),
            fx_service.clone(),
        )
        .with_activity_repository(activity_repository.clone(), timezone.clone())
        .with_lot_repository(lots_repository.clone()),
    );

    let performance_service = Arc::new(
        PerformanceService::new_with_timezone(
            valuation_service.clone(),
            quote_service.clone(),
            timezone.clone(),
        )
        .with_activity_repository(activity_repository.clone(), fx_service.clone())
        .with_lot_repository(lots_repository.clone()),
    );

    let classification_service =
        Arc::new(AssetClassificationService::new(taxonomy_service.clone()));
    let holdings_service = Arc::new(
        HoldingsService::new_with_timezone(
            asset_service.clone(),
            snapshot_service.clone(),
            holdings_valuation_service.clone(),
            classification_service.clone(),
            timezone.clone(),
        )
        .with_income_dependencies(activity_repository.clone(), fx_service.clone())
        .with_lot_repository(lots_repository.clone()),
    );

    let allocation_service = Arc::new(
        AllocationService::new(holdings_service.clone(), taxonomy_service.clone())
            .with_account_service(account_service.clone()),
    );

    let allocation_target_repository = Arc::new(AllocationTargetRepository::new(
        pool.clone(),
        writer.clone(),
    ));
    let allocation_target_service = Arc::new(AllocationTargetService::new(
        allocation_target_repository,
        taxonomy_service.clone(),
    ));
    let drift_service = Arc::new(
        DriftService::new(
            allocation_target_service.clone(),
            allocation_service.clone(),
        )
        .with_holdings_service(holdings_service.clone())
        .with_taxonomy_service(taxonomy_service.clone()),
    );
    let rebalance_service = Arc::new(RebalanceService::new(
        allocation_target_service.clone(),
        drift_service.clone(),
        allocation_service.clone(),
        holdings_service.clone(),
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
        asset_service.clone(),
        allocation_service.clone(),
        performance_service.clone(),
        income_service.clone(),
        health_service.clone(),
        taxonomy_service.clone(),
        portfolio_service.clone(),
        net_worth_service.clone(),
        limits_service.clone(),
        cash_activity_service.clone(),
        activity_taxonomy_assignment_service.clone(),
        categorization_rules_service.clone(),
    ));
    let agent_environment: Arc<dyn wealthfolio_agent_tools::AgentEnvironment> =
        ai_environment.clone();
    let ai_chat_service = Arc::new(ChatService::new(ai_environment, ChatConfig::default()));

    // MCP audit log repository (agent access audit trail)
    let mcp_audit_repository = Arc::new(McpAuditRepository::new(pool.clone(), writer.clone()));

    // Personal Access Token repository (per-client scoped MCP auth)
    let pat_repository = Arc::new(PatRepository::new(pool.clone(), writer.clone()));

    // Durable per-addon key-value storage repository
    let addon_storage_repository: Arc<dyn wealthfolio_core::addons::AddonStorageRepositoryTrait> =
        Arc::new(AddonStorageRepository::new(pool.clone(), writer.clone()));

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
    let broker_sync_running = Arc::new(std::sync::atomic::AtomicBool::new(false));
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
            rating_instance_id,
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
            allocation_target_service,
            drift_service,
            rebalance_service,
            valuation_service,
            net_worth_service,
            sync_service,
            alternative_asset_service,
            taxonomy_service,
            connect_service,
            ai_provider_service,
            ai_chat_service,
            agent_environment,
            mcp_audit_repository,
            pat_repository,
            addon_storage_repository,
            device_enroll_service,
            device_sync_runtime,
            broker_sync_running,
            health_service,
            custom_provider_service,
            portfolio_service,
            spending_settings_service,
            cash_activity_service,
            categorization_rules_service,
            events_service,
            budget_service,
            spending_analytics_service,
            spending_insight_service,
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
