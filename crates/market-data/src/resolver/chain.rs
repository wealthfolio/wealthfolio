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

    /// The currency of prices from a provider response that does not name one.
    ///
    /// A pair is priced in its quote currency. Anything else is priced in the
    /// asset's own quote currency (`currency_hint`), which already holds the
    /// listing's currency and unit, such as USD for a dollar line on the LSE
    /// or GBp for a pence one. The venue default fills in only when the asset
    /// has none.
    pub fn quote_currency(&self, provider: &ProviderId, context: &QuoteContext) -> String {
        let pair_quote = match &context.instrument {
            InstrumentId::Fx { quote, .. }
            | InstrumentId::Crypto { quote, .. }
            | InstrumentId::Metal { quote, .. } => Some(quote.clone()),
            InstrumentId::Equity { .. }
            | InstrumentId::Option { .. }
            | InstrumentId::Bond { .. } => None,
        };
        pair_quote
            .or_else(|| {
                context
                    .currency_hint
                    .clone()
                    .filter(|hint| !hint.trim().is_empty())
            })
            .or_else(|| self.get_currency(provider, context))
            .map(|currency| currency.to_string())
            .unwrap_or_else(|| "USD".to_string())
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

    fn context_with(instrument: InstrumentId, hint: Option<&'static str>) -> QuoteContext {
        QuoteContext {
            instrument,
            identifiers: Default::default(),
            overrides: None,
            currency_hint: hint.map(Into::into),
            preferred_provider: None,
            bond_metadata: None,
            custom_provider_code: None,
        }
    }

    fn equity(ticker: &str, mic: Option<&'static str>) -> InstrumentId {
        InstrumentId::Equity {
            ticker: Arc::from(ticker),
            mic: mic.map(Into::into),
        }
    }

    /// #2141: a response without a currency is priced in the asset's own
    /// quote currency, not the venue's default, whichever provider serves it.
    #[test]
    fn quote_currency_follows_the_asset_currency() {
        let chain = ResolverChain::new();
        let cases: [(&str, InstrumentId, Option<&'static str>, &str); 7] = [
            // A dollar line and a pence line on the LSE, as Alpha Vantage
            // serves them without a currency.
            (
                "USD line on XLON",
                equity("IBTA", Some("XLON")),
                Some("USD"),
                "USD",
            ),
            (
                "pence line on XLON",
                equity("TSCO", Some("XLON")),
                Some("GBp"),
                "GBp",
            ),
            (
                "GBX alias kept",
                equity("TSCO", Some("XLON")),
                Some("GBX"),
                "GBX",
            ),
            (
                "option",
                InstrumentId::Option {
                    occ_symbol: Arc::from("AAPL240119C00150000"),
                },
                Some("USD"),
                "USD",
            ),
            // A pair is priced in its quote currency whatever the hint says.
            (
                "FX pair",
                InstrumentId::Fx {
                    base: "EUR".into(),
                    quote: "CAD".into(),
                },
                Some("TWD"),
                "CAD",
            ),
            (
                "crypto pair",
                InstrumentId::Crypto {
                    base: Arc::from("BTC"),
                    quote: "EUR".into(),
                },
                Some("USD"),
                "EUR",
            ),
            (
                "metal",
                InstrumentId::Metal {
                    code: Arc::from("XAU"),
                    quote: "USD".into(),
                },
                Some("EUR"),
                "USD",
            ),
        ];
        for (case, instrument, hint, expected) in cases {
            let context = context_with(instrument, hint);
            for provider in ["ALPHA_VANTAGE", "YAHOO", "FINNHUB", "MARKETDATA_APP"] {
                assert_eq!(
                    chain.quote_currency(&provider.into(), &context),
                    expected,
                    "{case} via {provider}"
                );
            }
        }
    }

    /// Without an asset currency the provider's venue default applies, and
    /// Alpha Vantage's London default is the pence its prices are in.
    #[test]
    fn quote_currency_falls_back_to_the_venue_without_an_asset_currency() {
        let chain = ResolverChain::new();
        let cases = [
            (
                "ALPHA_VANTAGE",
                equity("TSCO", Some("XLON")),
                Some(" "),
                "GBp",
            ),
            ("ALPHA_VANTAGE", equity("SHOP", Some("XTSE")), None, "CAD"),
            ("YAHOO", equity("TSCO", Some("XLON")), None, "GBp"),
            ("FINNHUB", equity("AAPL", Some("XNAS")), None, "USD"),
            ("ALPHA_VANTAGE", equity("AAPL", None), None, "USD"),
        ];
        for (provider, instrument, hint, expected) in cases {
            let context = context_with(instrument, hint);
            assert_eq!(
                chain.quote_currency(&provider.into(), &context),
                expected,
                "{provider} {:?}",
                context.instrument
            );
        }
    }
}
