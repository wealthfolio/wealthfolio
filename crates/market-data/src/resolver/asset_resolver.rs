//! Asset resolver - resolves from Asset.provider_overrides.
//!
//! This is the first resolver in the chain. It checks if the asset has
//! an explicit override for the requested provider.

use crate::errors::MarketDataError;
use crate::models::{ProviderId, QuoteContext};

use super::traits::{ResolutionSource, ResolvedInstrument, Resolver};

/// Resolves provider instruments from Asset.provider_overrides.
///
/// When a user explicitly sets a provider-specific symbol for an asset,
/// it is stored in the `provider_overrides` field. This resolver checks
/// for those overrides first.
///
/// # Resolution Order
///
/// This resolver is typically first in the chain:
/// 1. AssetResolver (this) - check explicit overrides
/// 2. RulesResolver - apply deterministic MIC->suffix rules
pub struct AssetResolver;

impl AssetResolver {
    /// Create a new AssetResolver.
    pub fn new() -> Self {
        Self
    }
}

impl Default for AssetResolver {
    fn default() -> Self {
        Self::new()
    }
}

impl Resolver for AssetResolver {
    fn resolve(
        &self,
        provider: &ProviderId,
        context: &QuoteContext,
    ) -> Option<Result<ResolvedInstrument, MarketDataError>> {
        // Check if the context has overrides
        let overrides = context.overrides.as_ref()?;

        // Look up the override for this specific provider
        let instrument = overrides.get(provider.as_ref())?;

        // Found an override - return it
        Some(Ok(ResolvedInstrument {
            instrument: instrument.clone(),
            source: ResolutionSource::Override,
        }))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::models::{InstrumentId, ProviderInstrument, ProviderOverrides};

    #[test]
    fn test_resolve_with_override() {
        let resolver = AssetResolver::new();

        // Create context with override
        let mut overrides = ProviderOverrides::new();
        overrides.insert(
            "YAHOO".to_string(),
            ProviderInstrument::EquitySymbol {
                symbol: Arc::from("SHOP.TO"),
            },
        );

        let context = QuoteContext {
            instrument: InstrumentId::Equity {
                ticker: Arc::from("SHOP"),
                mic: Some("XTSE".into()),
            },
            identifiers: Default::default(),
            overrides: Some(overrides),
            currency_hint: Some("CAD".into()),
            preferred_provider: None,
            bond_metadata: None,
            custom_provider_code: None,
        };

        let result = resolver.resolve(&"YAHOO".into(), &context);

        assert!(result.is_some());
        let resolved = result.unwrap().unwrap();
        assert_eq!(resolved.source, ResolutionSource::Override);

        match resolved.instrument {
            ProviderInstrument::EquitySymbol { symbol } => {
                assert_eq!(symbol.as_ref(), "SHOP.TO");
            }
            _ => panic!("Expected EquitySymbol"),
        }
    }

    #[test]
    fn test_resolve_no_override() {
        let resolver = AssetResolver::new();

        // Context without overrides
        let context = QuoteContext {
            instrument: InstrumentId::Equity {
                ticker: Arc::from("AAPL"),
                mic: Some("XNAS".into()),
            },
            identifiers: Default::default(),
            overrides: None,
            currency_hint: Some("USD".into()),
            preferred_provider: None,
            bond_metadata: None,
            custom_provider_code: None,
        };

        let result = resolver.resolve(&"YAHOO".into(), &context);

        // Should return None when no override exists
        assert!(result.is_none());
    }

    #[test]
    fn test_resolve_override_for_different_provider() {
        let resolver = AssetResolver::new();

        // Create context with override for YAHOO only
        let mut overrides = ProviderOverrides::new();
        overrides.insert(
            "YAHOO".to_string(),
            ProviderInstrument::EquitySymbol {
                symbol: Arc::from("SHOP.TO"),
            },
        );

        let context = QuoteContext {
            instrument: InstrumentId::Equity {
                ticker: Arc::from("SHOP"),
                mic: Some("XTSE".into()),
            },
            identifiers: Default::default(),
            overrides: Some(overrides),
            currency_hint: Some("CAD".into()),
            preferred_provider: None,
            bond_metadata: None,
            custom_provider_code: None,
        };

        // Try to resolve for ALPHA_VANTAGE (no override)
        let result = resolver.resolve(&"ALPHA_VANTAGE".into(), &context);

        // Should return None when no override for this provider
        assert!(result.is_none());
    }
}
