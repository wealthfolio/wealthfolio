//! Quote storage traits.
//!
//! This module defines the storage interface for quote data and provider settings.
//! These traits abstract the persistence layer, allowing different storage backends
//! (e.g., SQLite, PostgreSQL) to be used interchangeably.
//!
//! # Strong Types
//!
//! This module uses strong types from `super::types` to enforce clear boundaries:
//! - `AssetId` - Canonical asset identifier (e.g., "SEC:AAPL:XNAS")
//! - `Day` - UTC date bucket for daily quotes
//! - `QuoteSource` - Manual or Provider(ProviderId)
//!
//! The `Quote` struct uses `asset_id: String` which stores the canonical asset identifier.

use async_trait::async_trait;
use chrono::NaiveDate;
use std::collections::HashMap;

use super::model::{LatestQuotePair, Quote};
use super::types::{AssetId, Day, QuoteSource};
use crate::errors::Result;

// =============================================================================
// Quote Store
// =============================================================================

/// Storage interface for quote data.
///
/// This trait defines all operations for persisting and retrieving market quotes.
/// Implementations handle the actual database operations.
///
/// # Design Notes
///
/// - Async methods are used for operations that may involve I/O
/// - Sync methods are used for simple queries that are typically fast
/// - Batch operations (upsert_quotes) are provided for efficiency
/// - Strong types (`AssetId`, `Day`) are used for cleaner APIs
/// - The `Quote` struct uses `asset_id: String` for canonical asset identifiers
///
/// # Method Naming Convention
///
/// - `latest_*` - Get most recent quote(s)
/// - `range_*` - Get quotes within a date range
/// - `*_batch` - Operate on multiple assets efficiently
#[async_trait]
pub trait QuoteStore: Send + Sync {
    // =========================================================================
    // Mutations
    // =========================================================================

    /// Saves a single quote to the store.
    ///
    /// If a quote with the same ID already exists, it will be updated.
    ///
    /// # Arguments
    ///
    /// * `quote` - The quote to save
    ///
    /// # Returns
    ///
    /// The saved quote (may include generated fields like timestamps)
    async fn save_quote(&self, quote: &Quote) -> Result<Quote>;

    /// Deletes a quote by its ID.
    ///
    /// # Arguments
    ///
    /// * `quote_id` - The unique identifier of the quote to delete
    async fn delete_quote(&self, quote_id: &str) -> Result<()>;

    /// Upserts multiple quotes in a single batch operation.
    ///
    /// This is the preferred method for bulk imports and sync operations.
    /// Quotes are matched by their ID; existing quotes are updated, new ones are inserted.
    ///
    /// # Arguments
    ///
    /// * `quotes` - The quotes to upsert
    ///
    /// # Returns
    ///
    /// The number of quotes that were inserted or updated
    async fn upsert_quotes(&self, quotes: &[Quote]) -> Result<usize>;

    /// Deletes all quotes for a specific asset.
    ///
    /// This is useful when an asset is deleted and all its quote history
    /// should be removed.
    ///
    /// # Arguments
    ///
    /// * `asset_id` - The asset whose quotes should be deleted
    ///
    /// # Returns
    ///
    /// The number of quotes that were deleted
    async fn delete_quotes_for_asset(&self, asset_id: &AssetId) -> Result<usize>;

    /// Deletes all non-manual (provider) quotes for a specific asset.
    ///
    /// Manual quotes (source = "MANUAL") are preserved. This is used before
    /// re-inserting fresh provider data to remove stale/wrong dates.
    ///
    /// # Arguments
    ///
    /// * `asset_id` - The asset whose provider quotes should be deleted
    ///
    /// # Returns
    ///
    /// The number of quotes that were deleted
    async fn delete_provider_quotes_for_asset(&self, asset_id: &AssetId) -> Result<usize>;

    // =========================================================================
    // Single Asset Queries (Strong Types)
    // =========================================================================

    /// Gets the most recent quote for an asset.
    ///
    /// Optionally filter by source (manual vs provider).
    ///
    /// # Arguments
    ///
    /// * `asset_id` - The asset identifier
    /// * `source` - Optional source filter
    ///
    /// # Returns
    ///
    /// The latest quote, or None if no quotes exist
    fn latest(&self, asset_id: &AssetId, source: Option<&QuoteSource>) -> Result<Option<Quote>>;

    /// Gets quotes in date range for a single asset.
    ///
    /// # Arguments
    ///
    /// * `asset_id` - The asset identifier
    /// * `start` - Start day (inclusive)
    /// * `end` - End day (inclusive)
    /// * `source` - Optional source filter
    ///
    /// # Returns
    ///
    /// Quotes within the specified date range
    fn range(
        &self,
        asset_id: &AssetId,
        start: Day,
        end: Day,
        source: Option<&QuoteSource>,
    ) -> Result<Vec<Quote>>;

    // =========================================================================
    // Batch Queries (Strong Types)
    // =========================================================================

    /// Gets latest quotes for multiple assets.
    ///
    /// This is more efficient than calling `latest` in a loop.
    ///
    /// # Arguments
    ///
    /// * `asset_ids` - The asset identifiers to query
    /// * `source` - Optional source filter
    ///
    /// # Returns
    ///
    /// A map from asset_id to its latest quote. Assets without quotes are omitted.
    fn latest_batch(
        &self,
        asset_ids: &[AssetId],
        source: Option<&QuoteSource>,
    ) -> Result<HashMap<AssetId, Quote>>;

    /// Gets latest + previous quote for multiple assets.
    ///
    /// This is useful for calculating daily price changes.
    ///
    /// # Arguments
    ///
    /// * `asset_ids` - The asset identifiers to query
    ///
    /// # Returns
    ///
    /// A map from asset_id to its quote pair (latest + previous).
    /// Assets without quotes are omitted.
    fn latest_with_previous(
        &self,
        asset_ids: &[AssetId],
    ) -> Result<HashMap<AssetId, LatestQuotePair>>;

    /// Gets quote date bounds (earliest, latest) for multiple assets.
    ///
    /// This is used by sync planning to determine which date ranges need quotes.
    /// Bounds are filtered by source to ensure we only consider quotes from
    /// the intended provider (e.g., YAHOO), not MANUAL or other sources.
    ///
    /// # Arguments
    ///
    /// * `asset_ids` - The asset identifiers to query
    /// * `source` - The quote source to filter by (e.g., "YAHOO")
    ///
    /// # Returns
    ///
    /// A map from asset_id to (earliest_date, latest_date).
    /// Assets without quotes for the specified source are omitted.
    fn get_quote_bounds_for_assets(
        &self,
        asset_ids: &[String],
        source: &str,
    ) -> Result<HashMap<String, (NaiveDate, NaiveDate)>>;

    // =========================================================================
    // Legacy Methods (String-based, for backward compatibility)
    // =========================================================================

    /// Gets the most recent quote for a symbol.
    ///
    /// # Deprecated
    ///
    /// Prefer using `latest(&AssetId::new(symbol), None)` instead.
    ///
    /// # Arguments
    ///
    /// * `symbol` - The ticker symbol
    ///
    /// # Returns
    ///
    /// The latest quote, or an error if no quotes exist for the symbol
    fn get_latest_quote(&self, symbol: &str) -> Result<Quote>;

    /// Gets the most recent quotes for multiple symbols.
    ///
    /// # Deprecated
    ///
    /// Prefer using `latest_batch` with `AssetId` instead.
    ///
    /// # Arguments
    ///
    /// * `symbols` - The ticker symbols to query
    ///
    /// # Returns
    ///
    /// A map from symbol to its latest quote. Symbols without quotes are omitted.
    fn get_latest_quotes(&self, symbols: &[String]) -> Result<HashMap<String, Quote>>;

    /// Gets the most recent quote per symbol whose `day` is on or before `as_of`.
    ///
    /// Future-dated quotes (e.g. scheduled liability payoff balances) are
    /// excluded. A symbol with no qualifying row is omitted from the result.
    ///
    /// # Arguments
    ///
    /// * `symbols` - The ticker symbols to query
    /// * `as_of` - Inclusive upper bound on the quote's `day`
    ///
    /// # Returns
    ///
    /// A map from symbol to its latest qualifying quote.
    fn get_latest_quotes_as_of(
        &self,
        symbols: &[String],
        as_of: NaiveDate,
    ) -> Result<HashMap<String, Quote>>;

    /// Gets the latest and previous quotes for multiple symbols.
    ///
    /// # Deprecated
    ///
    /// Prefer using `latest_with_previous` with `AssetId` instead.
    ///
    /// # Arguments
    ///
    /// * `symbols` - The ticker symbols to query
    ///
    /// # Returns
    ///
    /// A map from symbol to its quote pair (latest + previous).
    fn get_latest_quotes_pair(
        &self,
        symbols: &[String],
    ) -> Result<HashMap<String, LatestQuotePair>>;

    /// Gets the most recent quote for a symbol strictly before the given date.
    ///
    /// Used as a seed for gap-fill when the standard lookback window misses
    /// stale manual quotes.
    ///
    /// The default implementation falls back to `get_historical_quotes` with
    /// an in-memory filter. Storage backends should override this with a
    /// targeted query for efficiency.
    fn get_latest_quote_before(&self, symbol: &str, before: NaiveDate) -> Result<Option<Quote>> {
        let quote = self
            .get_historical_quotes(symbol)?
            .into_iter()
            .filter(|q| q.timestamp.date_naive() < before)
            .max_by_key(|q| q.timestamp);
        Ok(quote)
    }

    /// Gets all historical quotes for a symbol, ordered by date.
    ///
    /// # Arguments
    ///
    /// * `symbol` - The ticker symbol
    ///
    /// # Returns
    ///
    /// All quotes for the symbol, typically ordered from oldest to newest
    fn get_historical_quotes(&self, symbol: &str) -> Result<Vec<Quote>>;

    /// Gets all historical quotes for all symbols.
    ///
    /// Use with caution on large datasets as this may return significant data.
    ///
    /// # Returns
    ///
    /// All quotes in the store
    fn get_all_historical_quotes(&self) -> Result<Vec<Quote>>;

    /// Gets quotes for a symbol within a date range.
    ///
    /// # Deprecated
    ///
    /// Prefer using `range` with `AssetId` and `Day` instead.
    ///
    /// # Arguments
    ///
    /// * `symbol` - The ticker symbol
    /// * `start` - Start date (inclusive)
    /// * `end` - End date (inclusive)
    ///
    /// # Returns
    ///
    /// Quotes within the specified date range
    fn get_quotes_in_range(
        &self,
        symbol: &str,
        start: NaiveDate,
        end: NaiveDate,
    ) -> Result<Vec<Quote>>;

    /// Finds duplicate quotes for a symbol on a specific date.
    ///
    /// This is useful for identifying and cleaning up data quality issues
    /// where multiple quotes exist for the same symbol and date.
    ///
    /// # Arguments
    ///
    /// * `symbol` - The ticker symbol
    /// * `date` - The date to check
    ///
    /// # Returns
    ///
    /// All quotes for the symbol on the given date (should normally be 0 or 1)
    fn find_duplicate_quotes(&self, symbol: &str, date: NaiveDate) -> Result<Vec<Quote>>;
}

// =============================================================================
// Provider Settings Store
// =============================================================================

use crate::quotes::{MarketDataProviderSetting, UpdateMarketDataProviderSetting};

/// Storage interface for market data provider settings.
///
/// Provider settings control which data sources are enabled, their priority order,
/// and track sync status. This is separate from `QuoteStore` as it deals with
/// configuration rather than quote data.
pub trait ProviderSettingsStore: Send + Sync {
    /// Gets all configured market data providers.
    ///
    /// # Returns
    ///
    /// All provider settings, typically ordered by priority
    fn get_all_providers(&self) -> Result<Vec<MarketDataProviderSetting>>;

    /// Gets a specific provider's settings by ID.
    ///
    /// # Arguments
    ///
    /// * `id` - The provider identifier (e.g., "YAHOO", "ALPHA_VANTAGE")
    ///
    /// # Returns
    ///
    /// The provider settings, or an error if not found
    fn get_provider(&self, id: &str) -> Result<MarketDataProviderSetting>;

    /// Updates a provider's settings.
    ///
    /// # Arguments
    ///
    /// * `id` - The provider identifier
    /// * `changes` - The fields to update
    ///
    /// # Returns
    ///
    /// The updated provider settings
    fn update_provider(
        &self,
        id: &str,
        changes: UpdateMarketDataProviderSetting,
    ) -> Result<MarketDataProviderSetting>;
}
