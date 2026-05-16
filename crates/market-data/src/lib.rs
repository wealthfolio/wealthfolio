//! Wealthfolio Market Data Crate
//!
//! This crate provides provider-agnostic market data fetching capabilities
//! for the Wealthfolio application.
//!
//! # Overview
//!
//! The market data crate supports:
//! - Multiple asset types: equities, crypto, FX, precious metals
//! - Multiple providers: Yahoo Finance, Alpha Vantage, etc.
//! - Provider-agnostic instrument resolution
//! - Rate limiting and circuit breaking
//!
//! # Architecture
//!
//! ```text
//! +------------------+     +------------------+
//! |   Domain Layer   | --> |  InstrumentId    |  (canonical identity)
//! +------------------+     +------------------+
//!                                  |
//!                                  v
//!                          +------------------+
//!                          |    Resolver      |  (chain of responsibility)
//!                          +------------------+
//!                                  |
//!                                  v
//!                         +-------------------+
//!                         | ProviderInstrument|  (provider-specific)
//!                         +-------------------+
//!                                  |
//!                                  v
//!                          +------------------+
//!                          |    Provider      |  (Yahoo, AlphaVantage, etc.)
//!                          +------------------+
//!                                  |
//!                                  v
//!                          +------------------+
//!                          |     Quote        |  (market data)
//!                          +------------------+
//! ```
//!
//! # Core Types
//!
//! - [`InstrumentId`] - Provider-agnostic instrument identifier
//! - [`ProviderInstrument`] - Provider-specific lookup parameters
//! - [`Quote`] - Market data quote with OHLCV data
//! - [`QuoteContext`] - Request context including overrides and preferences
//! - [`AssetProfile`] - Provider-sourced profile data (sector, industry, etc.)
//! - [`AssetKind`] - Classification of asset types
//!
//! # Type Aliases
//!
//! - [`ProviderId`] - Provider identifier (e.g., "YAHOO", "ALPHA_VANTAGE")
//! - [`Mic`] - Market Identifier Code (ISO 10383)
//! - [`Currency`] - Currency code (ISO 4217)
//! - [`ProviderSymbol`] - Provider-specific symbol string

pub mod errors;
pub mod models;
pub mod provider;
pub mod registry;
pub mod resolver;

// Re-export all public types from models
pub use models::{
    AssetKind, AssetProfile, BondQuoteMetadata, Coverage, Currency, InstrumentId, InstrumentKind,
    Mic, ProviderId, ProviderInstrument, ProviderOverrides, ProviderSymbol, Quote, QuoteContext,
    SearchResult, SplitEvent,
};

// Re-export resolver types
pub use resolver::{
    exchanges_for_currency, get_exchange_list, mic_to_currency, mic_to_exchange_name,
    strip_yahoo_suffix, yahoo_equity_base_to_provider, yahoo_equity_provider_symbol_to_canonical,
    yahoo_equity_search_queries, yahoo_exchange_suffixes, yahoo_exchange_to_mic,
    yahoo_suffix_to_mic, AssetResolver, ExchangeInfo, ExchangeMap, ExchangeSuffix,
    ResolutionSource, ResolvedInstrument, Resolver, ResolverChain, RulesResolver, SymbolResolver,
};

// Re-export provider types
pub use provider::alpha_vantage::AlphaVantageProvider;
pub use provider::boerse_frankfurt::BoerseFrankfurtProvider;
pub use provider::finnhub::FinnhubProvider;
pub use provider::fixture::FixtureProvider;
pub use provider::marketdata_app::MarketDataAppProvider;
pub use provider::metal_price_api::MetalPriceApiProvider;
pub use provider::openfigi::OpenFigiProvider;
pub use provider::us_treasury_calc::{TreasuryBondDetails, UsTreasuryCalcProvider};
pub use provider::yahoo::{YahooDividend, YahooProvider};
pub use provider::{MarketDataProvider, ProviderCapabilities, RateLimit};

// Re-export registry types
pub use registry::{
    CircuitBreaker, CircuitState, FetchDiagnostics, ProviderAttempt, ProviderRegistry,
    QuoteValidator, RateLimiter, SkipReason, ValidationSeverity,
};
