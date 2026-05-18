//! Market data provider abstractions and implementations.
//!
//! This module contains:
//! - The `MarketDataProvider` trait that all providers implement
//! - Provider capabilities and rate limiting configuration
//! - Concrete provider implementations (Yahoo, Alpha Vantage, etc.)
//!
//! # Architecture
//!
//! The provider system is designed to be:
//! - **Provider-agnostic**: The core system doesn't know about specific providers
//! - **Extensible**: New providers can be added by implementing `MarketDataProvider`
//! - **Resilient**: Rate limiting and circuit breakers protect against provider failures
//!
//! # Provider Resolution
//!
//! Providers receive pre-resolved `ProviderInstrument` parameters. The resolution
//! from canonical `InstrumentId` to provider-specific parameters happens in the
//! resolver module, not in the providers themselves.

mod capabilities;
mod traits;

// Provider implementations
pub mod alpha_vantage;
pub mod boerse_frankfurt;
pub mod finnhub;
pub mod fixture;
pub mod marketdata_app;
pub mod metal_price_api;
pub mod openfigi;
pub mod us_treasury_calc;
pub mod yahoo;

// Re-exports
pub use capabilities::{ProviderCapabilities, RateLimit};
pub use traits::MarketDataProvider;
