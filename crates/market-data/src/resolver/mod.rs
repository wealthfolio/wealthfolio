//! Symbol resolution for market data providers.
//!
//! This module provides the resolver chain that converts canonical instruments
//! (e.g., ticker + MIC) to provider-specific symbols (e.g., "SHOP.TO" for Yahoo).
//!
//! # Architecture
//!
//! The resolver uses a chain of responsibility pattern:
//!
//! ```text
//! ┌─────────────────────────────────────────────────────────────────────────────┐
//! │                      ResolverChain                                           │
//! │                                                                              │
//! │  ┌────────────────────────────────────────────────────────────────────────┐ │
//! │  │ 1. Asset Resolver (provider_overrides)                                  │ │
//! │  │    - Checks Asset.provider_overrides[provider_id]                       │ │
//! │  │    - User can set explicit overrides per provider                       │ │
//! │  └────────────────────────────────────────────────────────────────────────┘ │
//! │                           │ miss                                             │
//! │                           ▼                                                  │
//! │  ┌────────────────────────────────────────────────────────────────────────┐ │
//! │  │ 2. Rules Resolver (deterministic)                                       │ │
//! │  │    - MIC → suffix mappings for equities                                 │ │
//! │  │    - FX/Crypto format rules per provider                                │ │
//! │  └────────────────────────────────────────────────────────────────────────┘ │
//! └─────────────────────────────────────────────────────────────────────────────┘
//! ```
//!
//! # Resolution Precedence
//!
//! Given `(asset, provider_id)`, resolve provider instrument as:
//!
//! 1. **If `provider_overrides[provider_id]` exists** -> use it directly
//! 2. **Else derive from canonical identity:**
//!    - Security: `symbol + suffix(exchange_mic, provider_id)`
//!    - FX: Provider format from `(base=symbol, quote=currency)`
//!    - Crypto: Provider format from `(base=symbol, quote=currency)`
//! 3. **If cannot resolve** -> return `ResolutionFailed`
//!
//! # Example
//!
//! ```ignore
//! use wealthfolio_market_data::resolver::{ResolverChain, SymbolResolver};
//! use wealthfolio_market_data::models::{InstrumentId, QuoteContext};
//!
//! let chain = ResolverChain::new();
//!
//! // Canadian equity
//! let context = QuoteContext {
//!     instrument: InstrumentId::Equity {
//!         ticker: "SHOP".into(),
//!         mic: Some("XTSE".into()),
//!     },
//!     overrides: None,
//!     currency_hint: Some("CAD".into()),
//!     preferred_provider: None,
//!     bond_metadata: None, custom_provider_code: None,
//! };
//!
//! let resolved = chain.resolve(&"YAHOO".into(), &context)?;
//! // resolved.instrument = EquitySymbol { symbol: "SHOP.TO" }
//! // resolved.source = ResolutionSource::Rules
//!
//! // FX pair
//! let fx_context = QuoteContext {
//!     instrument: InstrumentId::Fx {
//!         base: "EUR".into(),
//!         quote: "USD".into(),
//!     },
//!     overrides: None,
//!     currency_hint: None,
//!     preferred_provider: None,
//!     bond_metadata: None, custom_provider_code: None,
//! };
//!
//! let resolved = chain.resolve(&"YAHOO".into(), &fx_context)?;
//! // resolved.instrument = FxSymbol { symbol: "EURUSD=X" }
//! ```

mod asset_resolver;
mod chain;
pub mod exchange_metadata;
pub(crate) mod exchange_registry;
mod exchange_suffixes;
mod rules_resolver;
mod traits;

// Re-export main types
pub use asset_resolver::AssetResolver;
pub use chain::ResolverChain;
pub use exchange_metadata::{
    exchanges_for_currency, mic_to_currency, mic_to_exchange_name, mic_to_market_close,
    mic_to_timezone,
};
pub use exchange_registry::{get_exchange_list, ExchangeInfo};
pub use exchange_suffixes::{
    strip_yahoo_suffix, yahoo_equity_base_to_provider, yahoo_equity_provider_symbol_to_canonical,
    yahoo_equity_search_queries, yahoo_exchange_suffixes, yahoo_exchange_to_mic,
    yahoo_suffix_to_mic, ExchangeMap, ExchangeSuffix,
};
pub use rules_resolver::RulesResolver;
pub use traits::{ResolutionSource, ResolvedInstrument, Resolver, SymbolResolver};
