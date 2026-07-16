//! Resolver chain - composite resolver that tries resolvers in order.
//!
//! The resolver chain is the main entry point for symbol resolution. It
//! combines multiple resolvers and tries them in order until one succeeds.

use crate::errors::MarketDataError;
use crate::models::{Currency, InstrumentId, ProviderId, QuoteContext};

use super::asset_resolver::AssetResolver;
use super::exchange_suffixes::ExchangeMap;
use super::rules_resolver::RulesResolver;
use super::traits::{ResolvedInstrument, Resolver, SymbolResolver};

/// Composite resolver that tries multiple resolvers in order.
///
/// The resolution order is:
/// 1. Asset overrides (from `Asset.provider_overrides`)
/// 2. Deterministic rules (MIC->suffix mappings)
///
/// The chain stops at the first resolver that returns a result.
/// A resolver returning `None` means it cannot handle the request,
/// and the next resolver is tried.
///
/// # Example
///
/// ```ignore
/// let chain = ResolverChain::new();
///
/// let context = QuoteContext {
///     instrument: InstrumentId::Equity { ticker: "SHOP".into(), mic: Some("XTSE".into()) },
///     overrides: None,
///     currency_hint: Some("CAD".into()),
///     preferred_provider: None,
///     bond_metadata: None, custom_provider_code: None,
/// };
///
/// let resolved = chain.resolve(&"YAHOO".into(), &context)?;
/// // resolved.instrument = EquitySymbol { symbol: "SHOP.TO" }
/// // resolved.source = ResolutionSource::Rules
/// ```
pub struct ResolverChain {
    resolvers: Vec<Box<dyn Resolver>>,
    rules_resolver: RulesResolver,
}

impl ResolverChain {
    /// Create a new ResolverChain with the default resolver order.
    ///
    /// Default order:
    /// 1. AssetResolver (provider overrides)
    /// 2. RulesResolver (MIC->suffix rules)
    pub fn new() -> Self {
        Self::with_exchange_map(ExchangeMap::new())
    }

    /// Create a ResolverChain with a custom exchange map.
    pub fn with_exchange_map(exchange_map: ExchangeMap) -> Self {
        let rules_resolver = RulesResolver::with_exchange_map(exchange_map);

        Self {
            resolvers: vec![Box::new(AssetResolver::new())],
            rules_resolver,
        }
    }

    /// Add a custom resolver to the chain.
    ///
    /// The resolver is added before the rules resolver (which is always last).
    pub fn add_resolver(&mut self, resolver: Box<dyn Resolver>) {
        self.resolvers.push(resolver);
    }
}

impl Default for ResolverChain {
    fn default() -> Self {
        Self::new()
    }
}

impl SymbolResolver for ResolverChain {
    fn resolve(
        &self,
        provider: &ProviderId,
        context: &QuoteContext,
    ) -> Result<ResolvedInstrument, MarketDataError> {
        // Try each resolver in order
        for resolver in &self.resolvers {
            if let Some(result) = resolver.resolve(provider, context) {
                return result;
            }
        }

        // Finally try the rules resolver (always last)
        if let Some(result) = self.rules_resolver.resolve(provider, context) {
            return result;
        }

        // No resolver could handle this
        Err(MarketDataError::ResolutionFailed {
            provider: provider.to_string(),
        })
    }

    fn get_currency(&self, provider: &ProviderId, context: &QuoteContext) -> Option<Currency> {
        match &context.instrument {
            InstrumentId::Equity { mic, .. } => {
                self.rules_resolver.get_equity_currency(mic, provider)
            }
            InstrumentId::Fx { quote, .. } => Some(quote.clone()),
            InstrumentId::Crypto { quote, .. } => Some(quote.clone()),
            InstrumentId::Metal { quote, .. } => Some(quote.clone()),
            InstrumentId::Option { .. } => None,
            InstrumentId::Bond { .. } => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::models::{ProviderInstrument, ProviderOverrides};
    use crate::resolver::traits::ResolutionSource;

    #[test]
    fn test_chain_with_override() {
        let chain = ResolverChain::new();

        // Create context with override
        let mut overrides = ProviderOverrides::new();
        overrides.insert(
            "YAHOO".to_string(),
            ProviderInstrument::EquitySymbol {
                symbol: Arc::from("CUSTOM.SYMBOL"),
            },
        );

        let context = QuoteContext {
            instrument: InstrumentId::Equity {
                ticker: Arc::from("TEST"),
                mic: Some("XTSE".into()),
            },
            identifiers: Default::default(),
            overrides: Some(overrides),
            currency_hint: Some("CAD".into()),
            preferred_provider: None,
            bond_metadata: None,
            custom_provider_code: None,
        };

        let resolved = chain.resolve(&"YAHOO".into(), &context).unwrap();

        // Should use override, not rules
        assert_eq!(resolved.source, ResolutionSource::Override);
        match resolved.instrument {
            ProviderInstrument::EquitySymbol { symbol } => {
                assert_eq!(symbol.as_ref(), "CUSTOM.SYMBOL");
            }
            _ => panic!("Expected EquitySymbol"),
        }
    }

    #[test]
    fn test_chain_falls_through_to_rules() {
        let chain = ResolverChain::new();

        // Context without override - should fall through to rules
        let context = QuoteContext {
            instrument: InstrumentId::Equity {
                ticker: Arc::from("SHOP"),
                mic: Some("XTSE".into()),
            },
            identifiers: Default::default(),
            overrides: None,
            currency_hint: Some("CAD".into()),
            preferred_provider: None,
            bond_metadata: None,
            custom_provider_code: None,
        };

        let resolved = chain.resolve(&"YAHOO".into(), &context).unwrap();

        // Should use rules
        assert_eq!(resolved.source, ResolutionSource::Rules);
        match resolved.instrument {
            ProviderInstrument::EquitySymbol { symbol } => {
                assert_eq!(symbol.as_ref(), "SHOP.TO");
            }
            _ => panic!("Expected EquitySymbol"),
        }
    }

    #[test]
    fn test_chain_override_for_different_provider() {
        let chain = ResolverChain::new();

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

        // Resolve for ALPHA_VANTAGE (no override) - should use rules
        let resolved = chain.resolve(&"ALPHA_VANTAGE".into(), &context).unwrap();

        assert_eq!(resolved.source, ResolutionSource::Rules);
        match resolved.instrument {
            ProviderInstrument::EquitySymbol { symbol } => {
                assert_eq!(symbol.as_ref(), "SHOP.TRT");
            }
            _ => panic!("Expected EquitySymbol"),
        }
    }

    #[test]
    fn test_chain_fx_resolution() {
        let chain = ResolverChain::new();

        let context = QuoteContext {
            instrument: InstrumentId::Fx {
                base: "EUR".into(),
                quote: "USD".into(),
            },
            identifiers: Default::default(),
            overrides: None,
            currency_hint: None,
            preferred_provider: None,
            bond_metadata: None,
            custom_provider_code: None,
        };

        let resolved = chain.resolve(&"YAHOO".into(), &context).unwrap();

        match resolved.instrument {
            ProviderInstrument::FxSymbol { symbol } => {
                assert_eq!(symbol.as_ref(), "EURUSD=X");
            }
            _ => panic!("Expected FxSymbol"),
        }
    }

    #[test]
    fn test_chain_resolution_failed() {
        let chain = ResolverChain::new();

        let context = QuoteContext {
            instrument: InstrumentId::Crypto {
                base: Arc::from("BTC"),
                quote: "USD".into(),
            },
            identifiers: Default::default(),
            overrides: None,
            currency_hint: None,
            preferred_provider: None,
            bond_metadata: None,
            custom_provider_code: None,
        };

        let result = chain.resolve(&"UNKNOWN_PROVIDER".into(), &context);

        assert!(result.is_err());
        match result.unwrap_err() {
            MarketDataError::ResolutionFailed { provider } => {
                assert_eq!(provider, "UNKNOWN_PROVIDER");
            }
            _ => panic!("Expected ResolutionFailed error"),
        }
    }

    #[test]
    fn test_get_currency_equity() {
        let chain = ResolverChain::new();

        let context = QuoteContext {
            instrument: InstrumentId::Equity {
                ticker: Arc::from("SHOP"),
                mic: Some("XTSE".into()),
            },
            identifiers: Default::default(),
            overrides: None,
            currency_hint: None,
            preferred_provider: None,
            bond_metadata: None,
            custom_provider_code: None,
        };

        let currency = chain.get_currency(&"YAHOO".into(), &context);
        assert_eq!(currency.as_deref(), Some("CAD"));
    }

    #[test]
    fn test_get_currency_fx() {
        let chain = ResolverChain::new();

        let context = QuoteContext {
            instrument: InstrumentId::Fx {
                base: "EUR".into(),
                quote: "USD".into(),
            },
            identifiers: Default::default(),
            overrides: None,
            currency_hint: None,
            preferred_provider: None,
            bond_metadata: None,
            custom_provider_code: None,
        };

        let currency = chain.get_currency(&"YAHOO".into(), &context);
        assert_eq!(currency.as_deref(), Some("USD"));
    }
}
