//! Quote management module.
//!
//! This module provides the core types and traits for working with market quotes:
//!
//! - [`model`] - Domain models for quotes, quote summaries, and data sources
//! - [`store`] - Storage traits for persisting and querying quote data
//! - [`sync_state`] - Quote sync state tracking and planning
//! - [`sync`] - Quote synchronization service
//! - [`service`] - Unified quote service combining all operations
//! - [`import`] - Quote import and validation utilities
//! - [`client`] - Market data client facade for the market-data crate
//! - [`provider_settings`] - Provider settings models
//! - [`constants`] - Configuration constants
//!
//! # Architecture
//!
//! The quotes module follows a clean architecture pattern:
//!
//! ```text
//! QuoteSyncService → MarketDataClient → market-data crate (providers)
//!       ↓                                       ↓
//! QuoteStore (DB)                        ProviderRegistry
//! ```
//!
//! 1. **Models** (`model.rs`) - Pure data structures with no dependencies on infrastructure
//! 2. **Store Traits** (`store.rs`) - Abstract interfaces for data persistence
//! 3. **Client** (`client.rs`) - Facade for the market-data crate providers
//! 4. **Sync State** (`sync_state.rs`) - Tracking sync status for symbols
//! 5. **Sync Service** (`sync.rs`) - Orchestrates quote fetching and storage
//! 6. **Unified Service** (`service.rs`) - Combines CRUD, sync, and provider operations
//! 7. **Import** (`import.rs`) - Import validation and conversion utilities
//! 8. **Provider Settings** (`provider_settings.rs`) - Settings management for providers
//!
//! This separation allows:
//! - Easy testing with mock implementations
//! - Swapping storage backends without changing business logic
//! - Clear boundaries between domain and infrastructure concerns

pub mod client;
pub mod constants;
pub mod custom_scraper_provider;
pub mod errors;
pub mod import;
pub mod model;
pub mod provider_settings;
pub mod scheduler;
pub mod service;
pub mod store;
pub mod sync;
pub mod sync_state;
pub mod types;

#[cfg(test)]
mod service_tests;

// Re-export commonly used types for convenience
pub use model::{LatestQuotePair, Quote, ResolvedQuote, SymbolSearchResult};
pub use store::{ProviderSettingsStore, QuoteStore};

// Re-export strong types
pub use types::{quote_id, AssetId, Currency, Day, ProviderId, QuoteSource};

// Re-export sync state types
pub use sync_state::{
    MarketSyncMode, ProviderSyncStats, QuoteSyncState, QuoteSyncStateUpdate, SymbolSyncPlan,
    SyncCategory, SyncMode, SyncStateStore,
};

// Re-export sync service types
pub use sync::{
    AssetSkipReason, AssetSyncResult, QuoteSyncService, QuoteSyncServiceTrait, SyncError,
    SyncResult, SyncStatus,
};

// Re-export unified service types
pub use service::{
    FetchDividendsParams, LatestQuoteSnapshot, ProviderInfo, QuoteService, QuoteServiceTrait,
};

// Re-export import types
pub use import::{
    ImportResult, ImportValidation, ImportValidationStatus, QuoteConverter, QuoteExport,
    QuoteImport, QuoteImportService, QuoteValidator, ValidationStatus,
};

// Re-export constants
pub use constants::*;

// Re-export client
pub use client::{MarketDataClient, ProviderConfig};

// Re-export provider settings types
pub use provider_settings::{
    MarketDataProviderInfo, MarketDataProviderSetting, ProviderCapabilities,
    UpdateMarketDataProviderSetting,
};

// Re-export error types
pub use errors::MarketDataError;
