//! Resolution traits for the market data crate.
//!
//! Defines the core abstractions for resolving canonical instruments to
//! provider-specific symbols.

use crate::errors::MarketDataError;
use crate::models::{Currency, ProviderId, QuoteContext};

// Re-export ProviderInstrument for convenience
pub use crate::models::ProviderInstrument;

/// Resolution result containing the resolved instrument and its source.
#[derive(Clone, Debug)]
pub struct ResolvedInstrument {
    /// The provider-specific instrument parameters.
    pub instrument: ProviderInstrument,
    /// Where this resolution came from.
    pub source: ResolutionSource,
}

/// Indicates how an instrument was resolved.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResolutionSource {
    /// From Asset.provider_overrides - user-specified override.
    Override,
    /// From deterministic MIC->suffix rules.
    Rules,
    /// A venue was requested but the registry has no suffix for it on this
    /// provider, so the bare ticker was used.
    ///
    /// The symbol carries no venue, so the provider is free to answer with a
    /// different listing under the same ticker. Callers must confirm what came
    /// back before trusting it - see [`check_profile`](super::check_profile).
    RulesFallback,
}

/// Individual resolver in the resolution chain.
///
/// Resolvers are tried in order until one returns a result.
/// Returning `None` means this resolver cannot handle the request,
/// and the chain should try the next resolver.
pub trait Resolver: Send + Sync {
    /// Attempt to resolve a provider-specific instrument.
    ///
    /// # Arguments
    /// * `provider` - The provider ID to resolve for (e.g., "YAHOO", "ALPHA_VANTAGE")
    /// * `context` - The quote context containing the canonical instrument and overrides
    ///
    /// # Returns
    /// * `Some(Ok(resolved))` - Successfully resolved
    /// * `Some(Err(error))` - Error during resolution (stops the chain)
    /// * `None` - This resolver cannot handle the request (try next)
    fn resolve(
        &self,
        provider: &ProviderId,
        context: &QuoteContext,
    ) -> Option<Result<ResolvedInstrument, MarketDataError>>;
}

/// Main symbol resolver interface.
///
/// Combines multiple resolvers and provides a unified resolution interface.
pub trait SymbolResolver: Send + Sync {
    /// Resolve a provider-specific instrument.
    ///
    /// Unlike `Resolver::resolve`, this always returns a result (not Option).
    /// If resolution fails, returns an error.
    ///
    /// # Arguments
    /// * `provider` - The provider ID to resolve for
    /// * `context` - The quote context containing the canonical instrument
    ///
    /// # Returns
    /// * `Ok(resolved)` - Successfully resolved instrument
    /// * `Err(error)` - Resolution failed
    fn resolve(
        &self,
        provider: &ProviderId,
        context: &QuoteContext,
    ) -> Result<ResolvedInstrument, MarketDataError>;

    /// Get the expected currency for an instrument with a provider.
    ///
    /// Returns the trading currency based on the exchange mapping.
    fn get_currency(&self, provider: &ProviderId, context: &QuoteContext) -> Option<Currency>;
}
