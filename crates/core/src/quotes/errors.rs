//! Quote-related error types.

use thiserror::Error;

use crate::errors::DatabaseError;
use wealthfolio_market_data::errors::MarketDataError as ExternalMarketDataError;

/// Errors that can occur during market data/quote operations.
///
/// This error type bridges between the market-data crate's detailed error types
/// and the core domain's error handling needs.
#[derive(Error, Debug)]
pub enum MarketDataError {
    #[error("Database error: {0}")]
    DatabaseError(#[from] diesel::result::Error),

    #[error("Database error: {0}")]
    DatabaseConnectionError(#[from] DatabaseError),

    #[error("Provider error: {0}")]
    ProviderError(String),

    #[error("Network error: {0}")]
    NetworkError(#[from] reqwest::Error),

    #[error("Parsing error: {0}")]
    ParsingError(String),

    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Unauthorized: {0}")]
    Unauthorized(String),

    #[error("Rate limit exceeded: {0}")]
    RateLimitExceeded(String),

    #[error("Invalid data: {0}")]
    InvalidData(String),

    #[error("Provider exhausted: {0}")]
    ProviderExhausted(String),

    #[error("No data found")]
    NoData,

    #[error("No providers available")]
    NoProvidersAvailable,

    #[error("Unsupported asset type: {0}")]
    UnsupportedAssetType(String),

    #[error("Circuit breaker open: {0}")]
    CircuitOpen(String),

    #[error("Timeout: {0}")]
    Timeout(String),

    #[error("Unknown error: {0}")]
    Unknown(String),
}

impl MarketDataError {
    /// Returns true if this error is terminal (retrying won't help).
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            MarketDataError::NotFound(_)
                | MarketDataError::UnsupportedAssetType(_)
                | MarketDataError::NoProvidersAvailable
                | MarketDataError::ProviderExhausted(_)
        )
    }

    /// Returns true if this error suggests trying another provider.
    pub fn should_try_next_provider(&self) -> bool {
        matches!(
            self,
            MarketDataError::ProviderError(_)
                | MarketDataError::NoData
                | MarketDataError::Timeout(_)
        )
    }

    /// Returns true if this error is transient and should be retried.
    pub fn is_transient(&self) -> bool {
        matches!(
            self,
            MarketDataError::RateLimitExceeded(_)
                | MarketDataError::NetworkError(_)
                | MarketDataError::Timeout(_)
        )
    }
}

impl From<ExternalMarketDataError> for MarketDataError {
    fn from(error: ExternalMarketDataError) -> Self {
        match error {
            ExternalMarketDataError::SymbolNotFound(symbol) => {
                MarketDataError::NotFound(format!("Symbol not found: {}", symbol))
            }
            ExternalMarketDataError::UnsupportedAssetType(asset_type) => {
                MarketDataError::UnsupportedAssetType(asset_type)
            }
            ExternalMarketDataError::NoDataForRange => MarketDataError::NoData,
            ExternalMarketDataError::RateLimited { provider } => {
                MarketDataError::RateLimitExceeded(provider)
            }
            ExternalMarketDataError::Timeout { provider } => MarketDataError::Timeout(provider),
            ExternalMarketDataError::ProviderError { provider, message } => {
                MarketDataError::ProviderError(format!("{}: {}", provider, message))
            }
            ExternalMarketDataError::ResolutionFailed { provider } => {
                MarketDataError::ProviderError(format!("Resolution failed for {}", provider))
            }
            ExternalMarketDataError::CircuitOpen { provider } => {
                MarketDataError::CircuitOpen(provider)
            }
            ExternalMarketDataError::ValidationFailed { message } => {
                MarketDataError::InvalidData(message)
            }
            ExternalMarketDataError::NoProvidersAvailable => MarketDataError::NoProvidersAvailable,
            ExternalMarketDataError::AllProvidersFailed => {
                MarketDataError::ProviderExhausted("All providers failed".to_string())
            }
            ExternalMarketDataError::NotSupported {
                operation,
                provider,
            } => MarketDataError::ProviderError(format!(
                "{} does not support '{}'",
                provider, operation
            )),
            ExternalMarketDataError::Network(e) => MarketDataError::Unknown(e.to_string()),
        }
    }
}
