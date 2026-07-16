//! Wealthfolio Connect - Cloud sync functionality for Wealthfolio.
//!
//! This crate provides integration with Wealthfolio Connect cloud services
//! for syncing broker accounts and activities.

#[cfg(feature = "broker")]
pub mod broker;
pub mod broker_ingest;
pub mod client;
pub mod platform;
pub mod post_login_bootstrap;
mod request_metadata;
pub mod token_lifecycle;

// Re-export commonly used types
#[cfg(feature = "broker")]
pub use broker::{
    AccountUniversalActivity, BrokerAccount, BrokerApiClient, BrokerBrokerage, BrokerConnection,
    BrokerSyncService, BrokerSyncServiceTrait, NoOpProgressReporter, PaginatedUniversalActivity,
    PlanLimitValue, PlanLimits, PlanPricing, PlansResponse, PlatformRepositoryTrait,
    SubscriptionPlan, SyncAccountsResponse, SyncActivitiesResponse, SyncConfig,
    SyncConnectionsResponse, SyncOrchestrator, SyncProgressPayload, SyncProgressReporter,
    SyncResult, SyncStatus, UserInfo, UserTeam,
};

// Re-export the HTTP client and public functions
pub use client::{fetch_subscription_plans_public, ConnectApiClient, DEFAULT_CLOUD_API_URL};
pub use post_login_bootstrap::{
    acquire_broker_sync_guard, BrokerSyncRunGuard, PostLoginBootstrapReason,
    PostLoginBootstrapResult, PostLoginBootstrapStatus, PostLoginBootstrapSyncResult,
};
pub use token_lifecycle::{
    ensure_valid_access_token, TokenLifecycleConfig, TokenLifecycleError, TokenLifecycleState,
    CLOUD_ACCESS_TOKEN_KEY, CLOUD_REFRESH_TOKEN_KEY,
};

#[cfg(feature = "broker")]
pub use post_login_bootstrap::{
    is_active_broker_connection, prepare_post_login_broker_bootstrap,
    PostLoginBrokerBootstrapDecision,
};

pub use broker_ingest::{
    BrokerSyncState, BrokerSyncStateRepositoryTrait, CoreImportRunRepositoryAdapter, ImportRun,
    ImportRunMode, ImportRunRepositoryTrait, ImportRunStatus, ImportRunSummary, ImportRunType,
    ReviewMode,
};
pub use platform::Platform;
