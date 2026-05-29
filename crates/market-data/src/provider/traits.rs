//! Market data provider trait definitions.
//!
//! This module defines the core `MarketDataProvider` trait that all
//! market data providers must implement.

use async_trait::async_trait;
use chrono::{DateTime, Utc};

use crate::errors::MarketDataError;
use crate::models::{
    AssetProfile, DividendEvent, ProviderInstrument, Quote, QuoteContext, SearchResult, SplitEvent,
};

use super::capabilities::{ProviderCapabilities, RateLimit};

/// Trait for market data providers.
///
/// Implement this trait to add support for a new market data source.
/// The registry will use the provider's capabilities and priority
/// to determine when and how to use it.
///
/// # Example
///
/// ```ignore
/// use async_trait::async_trait;
/// use wealthfolio_market_data::provider::{MarketDataProvider, ProviderCapabilities, RateLimit};
///
/// struct MyProvider {
///     api_key: String,
/// }
///
/// #[async_trait]
/// impl MarketDataProvider for MyProvider {
///     fn id(&self) -> &'static str {
///         "MY_PROVIDER"
///     }
///
///     fn capabilities(&self) -> ProviderCapabilities {
///         ProviderCapabilities {
///             asset_kinds: &[AssetKind::Security],
///             supports_historical: true,
///             supports_search: false,
///         }
///     }
///
///     fn rate_limit(&self) -> RateLimit {
///         RateLimit::default()
///     }
///
///     // ... implement quote methods
/// }
/// ```
#[async_trait]
pub trait MarketDataProvider: Send + Sync {
    /// Unique identifier for this provider.
    ///
    /// Should be a constant string like "YAHOO", "ALPHA_VANTAGE", etc.
    /// Used for logging, circuit breaker tracking, and resolution.
    fn id(&self) -> &'static str;

    /// Provider priority for ordering.
    ///
    /// Lower values = higher priority. Default is 10.
    /// The registry uses this to order providers when multiple
    /// can handle the same asset type.
    fn priority(&self) -> u8 {
        10
    }

    /// Describes what this provider can do.
    ///
    /// Returns the asset kinds supported, whether historical data
    /// is available, and whether search is supported.
    fn capabilities(&self) -> ProviderCapabilities;

    /// Rate limiting configuration.
    ///
    /// Returns the rate limits that should be applied when
    /// calling this provider.
    fn rate_limit(&self) -> RateLimit;

    /// Fetch the latest quote for an instrument.
    ///
    /// # Arguments
    ///
    /// * `context` - The quote context containing the canonical instrument and overrides
    /// * `instrument` - The provider-specific instrument parameters (already resolved)
    ///
    /// # Returns
    ///
    /// The latest quote on success, or a `MarketDataError` on failure.
    async fn get_latest_quote(
        &self,
        context: &QuoteContext,
        instrument: ProviderInstrument,
    ) -> Result<Quote, MarketDataError>;

    /// Fetch historical quotes for an instrument.
    ///
    /// # Arguments
    ///
    /// * `context` - The quote context containing the canonical instrument and overrides
    /// * `instrument` - The provider-specific instrument parameters (already resolved)
    /// * `start` - Start of the date range (inclusive)
    /// * `end` - End of the date range (inclusive)
    ///
    /// # Returns
    ///
    /// A vector of quotes for the date range, or a `MarketDataError` on failure.
    /// The quotes should be ordered by timestamp ascending.
    async fn get_historical_quotes(
        &self,
        context: &QuoteContext,
        instrument: ProviderInstrument,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<Vec<Quote>, MarketDataError>;

    /// Search for symbols matching the query.
    ///
    /// # Arguments
    ///
    /// * `query` - The search query (e.g., "AAPL", "Apple")
    ///
    /// # Returns
    ///
    /// A vector of search results, or an error if search is not supported.
    /// Default implementation returns `NotSupported`.
    async fn search(&self, query: &str) -> Result<Vec<SearchResult>, MarketDataError> {
        let _ = query;
        Err(MarketDataError::NotSupported {
            operation: "search".to_string(),
            provider: self.id().to_string(),
        })
    }

    /// Fetch asset profile information.
    ///
    /// # Arguments
    ///
    /// * `symbol` - The symbol to fetch profile for
    ///
    /// # Returns
    ///
    /// The asset profile, or an error if profile is not supported.
    /// Default implementation returns `NotSupported`.
    async fn get_profile(&self, symbol: &str) -> Result<AssetProfile, MarketDataError> {
        let _ = symbol;
        Err(MarketDataError::NotSupported {
            operation: "profile".to_string(),
            provider: self.id().to_string(),
        })
    }

    /// Fetch split history for an instrument.
    ///
    /// # Returns
    ///
    /// A vector of split events, or `NotSupported` if the provider doesn't support splits.
    /// Default implementation returns `NotSupported`.
    async fn get_splits(
        &self,
        context: &QuoteContext,
        instrument: ProviderInstrument,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<Vec<SplitEvent>, MarketDataError> {
        let _ = (context, instrument, start, end);
        Err(MarketDataError::NotSupported {
            operation: "splits".to_string(),
            provider: self.id().to_string(),
        })
    }

    /// Fetch cash dividend history for an instrument.
    ///
    /// A vector of dividend events, or `NotSupported` if the provider doesn't support dividends.
    /// Default implementation returns `NotSupported`.
    async fn get_dividends(
        &self,
        context: &QuoteContext,
        instrument: ProviderInstrument,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<Vec<DividendEvent>, MarketDataError> {
        let _ = (context, instrument, start, end);
        Err(MarketDataError::NotSupported {
            operation: "dividends".to_string(),
            provider: self.id().to_string(),
        })
    }
}
