//! Rules resolver - deterministic MIC->suffix resolution.
//!
//! This resolver applies deterministic rules to convert canonical instruments
//! to provider-specific symbols. It uses the exchange map for securities
//! and provider-specific format rules for FX, crypto, and metals.

use std::sync::Arc;

use crate::errors::MarketDataError;
use crate::models::{Currency, InstrumentId, ProviderId, ProviderInstrument, QuoteContext};

use super::exchange_suffixes::ExchangeMap;
use super::traits::{ResolutionSource, ResolvedInstrument, Resolver};
use super::yahoo_equity_base_to_provider;

/// Resolves provider instruments from deterministic MIC->suffix rules.
///
/// This resolver handles:
/// - Securities: Uses exchange map to add provider-specific suffixes
/// - FX: Formats currency pairs according to provider conventions
/// - Crypto: Formats crypto pairs according to provider conventions
/// - Metals: Maps metal codes to provider-specific symbols
///
/// # Supported Providers
///
/// - `YAHOO`: Yahoo Finance format (SHOP.TO, BTC-USD, EURUSD=X)
/// - `ALPHA_VANTAGE`: AlphaVantage format (SHOP.TRT, CryptoPair, FxPair)
/// - `METAL_PRICE_API`: Metal Price API format
pub struct RulesResolver {
    exchange_map: ExchangeMap,
}

impl RulesResolver {
    /// Create a new RulesResolver with the default exchange map.
    pub fn new() -> Self {
        Self {
            exchange_map: ExchangeMap::new(),
        }
    }

    /// Create a RulesResolver with a custom exchange map.
    pub fn with_exchange_map(exchange_map: ExchangeMap) -> Self {
        Self { exchange_map }
    }

    /// Get the expected currency for an equity on a provider.
    pub fn get_equity_currency(
        &self,
        mic: &Option<std::borrow::Cow<'static, str>>,
        provider: &ProviderId,
    ) -> Option<Currency> {
        let mic = mic.as_ref()?;
        self.exchange_map
            .get_currency(mic, provider)
            .map(|s| Currency::from(s.to_string()))
    }

    /// Resolve an equity instrument.
    fn resolve_equity(
        &self,
        ticker: &Arc<str>,
        mic: &Option<std::borrow::Cow<'static, str>>,
        provider: &ProviderId,
    ) -> Option<ProviderInstrument> {
        if provider.as_ref() == "BOERSE_FRANKFURT" {
            let mic = mic.as_deref().unwrap_or("XETR");
            return Some(ProviderInstrument::EquitySymbol {
                symbol: Arc::from(format!("{}:{}", mic, ticker)),
            });
        }

        let provider_ticker = if provider.as_ref() == "YAHOO" {
            yahoo_equity_base_to_provider(ticker)
        } else {
            ticker.to_string()
        };

        let symbol = match mic {
            Some(mic) => {
                // Look up suffix for this MIC and provider, fallback to ticker only if not found
                match self.exchange_map.get_suffix(mic, provider) {
                    Some(suffix) => Arc::from(format!("{}{}", provider_ticker, suffix)),
                    None => {
                        // No mapping found - try ticker only (works for many US/global symbols)
                        Arc::from(provider_ticker)
                    }
                }
            }
            None => {
                // No MIC = assume US market, no suffix needed
                Arc::from(provider_ticker)
            }
        };

        Some(ProviderInstrument::EquitySymbol { symbol })
    }

    /// Resolve a crypto instrument.
    fn resolve_crypto(
        &self,
        base: &Arc<str>,
        quote: &Currency,
        provider: &ProviderId,
    ) -> Option<ProviderInstrument> {
        match provider.as_ref() {
            "YAHOO" => {
                // Yahoo uses "BTC-USD" format
                Some(ProviderInstrument::CryptoSymbol {
                    symbol: Arc::from(format!("{}-{}", base, quote)),
                })
            }
            "ALPHA_VANTAGE" => {
                // AlphaVantage uses separate symbol and market
                Some(ProviderInstrument::CryptoPair {
                    symbol: Arc::from(base.as_ref()),
                    market: quote.clone(),
                })
            }
            _ => None,
        }
    }

    /// Resolve an FX instrument.
    fn resolve_fx(
        &self,
        base: &Currency,
        quote: &Currency,
        provider: &ProviderId,
    ) -> Option<ProviderInstrument> {
        match provider.as_ref() {
            "YAHOO" => {
                // Yahoo uses "EURUSD=X" format
                Some(ProviderInstrument::FxSymbol {
                    symbol: Arc::from(format!("{}{}=X", base, quote)),
                })
            }
            "ALPHA_VANTAGE" => {
                // AlphaVantage uses from/to pair
                Some(ProviderInstrument::FxPair {
                    from: base.clone(),
                    to: quote.clone(),
                })
            }
            _ => None,
        }
    }

    /// Resolve a bond instrument by ISIN.
    ///
    /// Bonds use ISIN directly — no provider-specific symbol transformation needed.
    /// Provider-specific ISIN filtering ensures bonds are routed to the correct provider:
    /// - US_TREASURY_CALC: only US Treasury ISINs (US912*)
    /// - BOERSE_FRANKFURT and others: all ISINs
    fn resolve_bond(&self, isin: &Arc<str>, provider: &ProviderId) -> Option<ProviderInstrument> {
        if provider.as_ref() == "US_TREASURY_CALC" && !isin.starts_with("US912") {
            return None;
        }
        Some(ProviderInstrument::BondIsin { isin: isin.clone() })
    }

    /// Resolve an option instrument.
    /// Yahoo and Alpha Vantage accept OCC symbols as equity-like symbols.
    /// Alpha Vantage internally routes to the REALTIME_OPTIONS endpoint.
    fn resolve_option(
        &self,
        occ_symbol: &Arc<str>,
        provider: &ProviderId,
    ) -> Option<ProviderInstrument> {
        match provider.as_ref() {
            "YAHOO" | "ALPHA_VANTAGE" => Some(ProviderInstrument::EquitySymbol {
                symbol: occ_symbol.clone(),
            }),
            _ => None,
        }
    }

    /// Resolve a metal instrument.
    fn resolve_metal(
        &self,
        code: &Arc<str>,
        quote: &Currency,
        provider: &ProviderId,
    ) -> Option<ProviderInstrument> {
        match provider.as_ref() {
            "METAL_PRICE_API" => Some(ProviderInstrument::MetalSymbol {
                symbol: Arc::from(code.as_ref()),
                quote: quote.clone(),
            }),
            "YAHOO" => {
                // Yahoo uses futures symbols for metals
                let futures = match code.as_ref() {
                    "XAU" => "GC=F", // Gold
                    "XAG" => "SI=F", // Silver
                    "XPT" => "PL=F", // Platinum
                    "XPD" => "PA=F", // Palladium
                    _ => return None,
                };
                Some(ProviderInstrument::EquitySymbol {
                    symbol: Arc::from(futures),
                })
            }
            _ => None,
        }
    }
}

impl Default for RulesResolver {
    fn default() -> Self {
        Self::new()
    }
}

impl Resolver for RulesResolver {
    fn resolve(
        &self,
        provider: &ProviderId,
        context: &QuoteContext,
    ) -> Option<Result<ResolvedInstrument, MarketDataError>> {
        // CUSTOM_SCRAPER: extract symbol from any instrument variant
        if provider.as_ref() == "CUSTOM_SCRAPER" {
            let symbol = match &context.instrument {
                InstrumentId::Equity { ticker, .. } => ticker.clone(),
                InstrumentId::Crypto { base, .. } => base.clone(),
                InstrumentId::Fx { base, quote } => {
                    Arc::from(format!("{}{}", base, quote).as_str())
                }
                InstrumentId::Metal { code, .. } => code.clone(),
                InstrumentId::Bond { isin } => isin.clone(),
                InstrumentId::Option { occ_symbol } => occ_symbol.clone(),
            };
            return Some(Ok(ResolvedInstrument {
                instrument: ProviderInstrument::EquitySymbol { symbol },
                source: ResolutionSource::Rules,
            }));
        }

        let instrument = match &context.instrument {
            InstrumentId::Equity { ticker, mic } => self.resolve_equity(ticker, mic, provider)?,

            InstrumentId::Crypto { base, quote } => self.resolve_crypto(base, quote, provider)?,

            InstrumentId::Fx { base, quote } => self.resolve_fx(base, quote, provider)?,

            InstrumentId::Metal { code, quote } => self.resolve_metal(code, quote, provider)?,

            InstrumentId::Option { occ_symbol } => self.resolve_option(occ_symbol, provider)?,

            InstrumentId::Bond { isin } => self.resolve_bond(isin, provider)?,
        };

        Some(Ok(ResolvedInstrument {
            instrument,
            source: ResolutionSource::Rules,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_equity_context(ticker: &str, mic: Option<&'static str>) -> QuoteContext {
        QuoteContext {
            instrument: InstrumentId::Equity {
                ticker: Arc::from(ticker),
                mic: mic.map(|m| m.into()),
            },
            overrides: None,
            currency_hint: None,
            preferred_provider: None,
            bond_metadata: None,
            custom_provider_code: None,
        }
    }

    fn make_fx_context(base: &'static str, quote: &'static str) -> QuoteContext {
        QuoteContext {
            instrument: InstrumentId::Fx {
                base: base.into(),
                quote: quote.into(),
            },
            overrides: None,
            currency_hint: None,
            preferred_provider: None,
            bond_metadata: None,
            custom_provider_code: None,
        }
    }

    fn make_crypto_context(base: &str, quote: &'static str) -> QuoteContext {
        QuoteContext {
            instrument: InstrumentId::Crypto {
                base: Arc::from(base),
                quote: quote.into(),
            },
            overrides: None,
            currency_hint: None,
            preferred_provider: None,
            bond_metadata: None,
            custom_provider_code: None,
        }
    }

    fn make_metal_context(code: &str, quote: &'static str) -> QuoteContext {
        QuoteContext {
            instrument: InstrumentId::Metal {
                code: Arc::from(code),
                quote: quote.into(),
            },
            overrides: None,
            currency_hint: None,
            preferred_provider: None,
            bond_metadata: None,
            custom_provider_code: None,
        }
    }

    #[test]
    fn test_resolve_us_equity_yahoo() {
        let resolver = RulesResolver::new();
        let context = make_equity_context("AAPL", None);

        let result = resolver.resolve(&"YAHOO".into(), &context);

        assert!(result.is_some());
        let resolved = result.unwrap().unwrap();
        assert_eq!(resolved.source, ResolutionSource::Rules);

        match resolved.instrument {
            ProviderInstrument::EquitySymbol { symbol } => {
                assert_eq!(symbol.as_ref(), "AAPL");
            }
            _ => panic!("Expected EquitySymbol"),
        }
    }

    #[test]
    fn test_resolve_canadian_equity_yahoo() {
        let resolver = RulesResolver::new();
        let context = make_equity_context("SHOP", Some("XTSE"));

        let result = resolver.resolve(&"YAHOO".into(), &context);

        assert!(result.is_some());
        let resolved = result.unwrap().unwrap();

        match resolved.instrument {
            ProviderInstrument::EquitySymbol { symbol } => {
                assert_eq!(symbol.as_ref(), "SHOP.TO");
            }
            _ => panic!("Expected EquitySymbol"),
        }
    }

    #[test]
    fn test_resolve_yahoo_share_class_uses_provider_hyphen() {
        let resolver = RulesResolver::new();
        let context = make_equity_context("BRK.B", None);

        let result = resolver.resolve(&"YAHOO".into(), &context);

        assert!(result.is_some());
        let resolved = result.unwrap().unwrap();

        match resolved.instrument {
            ProviderInstrument::EquitySymbol { symbol } => {
                assert_eq!(symbol.as_ref(), "BRK-B");
            }
            _ => panic!("Expected EquitySymbol"),
        }
    }

    #[test]
    fn test_resolve_yahoo_known_exchange_suffix_keeps_dot() {
        let resolver = RulesResolver::new();
        let context = make_equity_context("VOD", Some("XLON"));

        let result = resolver.resolve(&"YAHOO".into(), &context);

        assert!(result.is_some());
        let resolved = result.unwrap().unwrap();

        match resolved.instrument {
            ProviderInstrument::EquitySymbol { symbol } => {
                assert_eq!(symbol.as_ref(), "VOD.L");
            }
            _ => panic!("Expected EquitySymbol"),
        }
    }

    #[test]
    fn test_resolve_yahoo_share_class_with_exchange_suffix_formats_base_then_suffix() {
        let resolver = RulesResolver::new();
        let context = make_equity_context("BRK.B", Some("XTSE"));

        let result = resolver.resolve(&"YAHOO".into(), &context);

        assert!(result.is_some());
        let resolved = result.unwrap().unwrap();

        match resolved.instrument {
            ProviderInstrument::EquitySymbol { symbol } => {
                assert_eq!(symbol.as_ref(), "BRK-B.TO");
            }
            _ => panic!("Expected EquitySymbol"),
        }
    }

    #[test]
    fn test_resolve_alphavantage_share_class_keeps_dot() {
        let resolver = RulesResolver::new();
        let context = make_equity_context("BRK.B", None);

        let result = resolver.resolve(&"ALPHA_VANTAGE".into(), &context);

        assert!(result.is_some());
        let resolved = result.unwrap().unwrap();

        match resolved.instrument {
            ProviderInstrument::EquitySymbol { symbol } => {
                assert_eq!(symbol.as_ref(), "BRK.B");
            }
            _ => panic!("Expected EquitySymbol"),
        }
    }

    #[test]
    fn test_resolve_canadian_equity_alphavantage() {
        let resolver = RulesResolver::new();
        let context = make_equity_context("SHOP", Some("XTSE"));

        let result = resolver.resolve(&"ALPHA_VANTAGE".into(), &context);

        assert!(result.is_some());
        let resolved = result.unwrap().unwrap();

        match resolved.instrument {
            ProviderInstrument::EquitySymbol { symbol } => {
                assert_eq!(symbol.as_ref(), "SHOP.TRT");
            }
            _ => panic!("Expected EquitySymbol"),
        }
    }

    #[test]
    fn test_resolve_fx_yahoo() {
        let resolver = RulesResolver::new();
        let context = make_fx_context("EUR", "USD");

        let result = resolver.resolve(&"YAHOO".into(), &context);

        assert!(result.is_some());
        let resolved = result.unwrap().unwrap();

        match resolved.instrument {
            ProviderInstrument::FxSymbol { symbol } => {
                assert_eq!(symbol.as_ref(), "EURUSD=X");
            }
            _ => panic!("Expected FxSymbol"),
        }
    }

    #[test]
    fn test_resolve_fx_alphavantage() {
        let resolver = RulesResolver::new();
        let context = make_fx_context("EUR", "USD");

        let result = resolver.resolve(&"ALPHA_VANTAGE".into(), &context);

        assert!(result.is_some());
        let resolved = result.unwrap().unwrap();

        match resolved.instrument {
            ProviderInstrument::FxPair { from, to } => {
                assert_eq!(from.as_ref(), "EUR");
                assert_eq!(to.as_ref(), "USD");
            }
            _ => panic!("Expected FxPair"),
        }
    }

    #[test]
    fn test_resolve_crypto_yahoo() {
        let resolver = RulesResolver::new();
        let context = make_crypto_context("BTC", "USD");

        let result = resolver.resolve(&"YAHOO".into(), &context);

        assert!(result.is_some());
        let resolved = result.unwrap().unwrap();

        match resolved.instrument {
            ProviderInstrument::CryptoSymbol { symbol } => {
                assert_eq!(symbol.as_ref(), "BTC-USD");
            }
            _ => panic!("Expected CryptoSymbol"),
        }
    }

    #[test]
    fn test_resolve_crypto_alphavantage() {
        let resolver = RulesResolver::new();
        let context = make_crypto_context("BTC", "USD");

        let result = resolver.resolve(&"ALPHA_VANTAGE".into(), &context);

        assert!(result.is_some());
        let resolved = result.unwrap().unwrap();

        match resolved.instrument {
            ProviderInstrument::CryptoPair { symbol, market } => {
                assert_eq!(symbol.as_ref(), "BTC");
                assert_eq!(market.as_ref(), "USD");
            }
            _ => panic!("Expected CryptoPair"),
        }
    }

    #[test]
    fn test_resolve_metal_yahoo() {
        let resolver = RulesResolver::new();
        let context = make_metal_context("XAU", "USD");

        let result = resolver.resolve(&"YAHOO".into(), &context);

        assert!(result.is_some());
        let resolved = result.unwrap().unwrap();

        match resolved.instrument {
            ProviderInstrument::EquitySymbol { symbol } => {
                assert_eq!(symbol.as_ref(), "GC=F");
            }
            _ => panic!("Expected EquitySymbol for metal futures"),
        }
    }

    #[test]
    fn test_resolve_metal_api() {
        let resolver = RulesResolver::new();
        let context = make_metal_context("XAU", "USD");

        let result = resolver.resolve(&"METAL_PRICE_API".into(), &context);

        assert!(result.is_some());
        let resolved = result.unwrap().unwrap();

        match resolved.instrument {
            ProviderInstrument::MetalSymbol { symbol, quote } => {
                assert_eq!(symbol.as_ref(), "XAU");
                assert_eq!(quote.as_ref(), "USD");
            }
            _ => panic!("Expected MetalSymbol"),
        }
    }

    #[test]
    fn test_resolve_unknown_provider() {
        let resolver = RulesResolver::new();
        let context = make_fx_context("EUR", "USD");

        let result = resolver.resolve(&"UNKNOWN_PROVIDER".into(), &context);

        // Should return None for unknown providers
        assert!(result.is_none());
    }

    #[test]
    fn test_resolve_unknown_mic() {
        let resolver = RulesResolver::new();
        let context = make_equity_context("TEST", Some("UNKNOWN_MIC"));

        let result = resolver.resolve(&"YAHOO".into(), &context);

        // Unknown MICs fall back to bare ticker
        assert!(result.is_some());
    }

    #[test]
    fn test_get_equity_currency() {
        let resolver = RulesResolver::new();

        // Toronto
        let currency = resolver.get_equity_currency(&Some("XTSE".into()), &"YAHOO".into());
        assert_eq!(currency.as_deref(), Some("CAD"));

        // London (Yahoo returns prices in pence, so currency is GBp)
        let currency = resolver.get_equity_currency(&Some("XLON".into()), &"YAHOO".into());
        assert_eq!(currency.as_deref(), Some("GBp"));

        // Tel Aviv fallback quote unit for listed securities.
        let currency = resolver.get_equity_currency(&Some("XTAE".into()), &"YAHOO".into());
        assert_eq!(currency.as_deref(), Some("ILA"));

        // No MIC
        let currency = resolver.get_equity_currency(&None, &"YAHOO".into());
        assert!(currency.is_none());
    }

    #[test]
    fn test_resolve_equity_boerse_frankfurt_bare_ticker() {
        // BF needs the MIC to distinguish Xetra vs Frankfurt for both quotes and profiles.
        let resolver = RulesResolver::new();
        let context = make_equity_context("XDWD", Some("XETR"));

        let result = resolver.resolve(&"BOERSE_FRANKFURT".into(), &context);

        assert!(result.is_some());
        let resolved = result.unwrap().unwrap();

        match resolved.instrument {
            ProviderInstrument::EquitySymbol { symbol } => {
                assert_eq!(symbol.as_ref(), "XETR:XDWD");
            }
            _ => panic!("Expected EquitySymbol"),
        }
    }

    #[test]
    fn test_get_equity_currency_ignores_wrong_hint() {
        // Simulates BATS@XLON: asset.quote_ccy="GBP" but Yahoo returns pence.
        // The resolver should return "GBp" based on exchange metadata,
        // regardless of what currency_hint says.
        let resolver = RulesResolver::new();
        let currency = resolver.get_equity_currency(&Some("XLON".into()), &"YAHOO".into());
        assert_eq!(currency.as_deref(), Some("GBp"));

        // Alpha Vantage correctly returns GBP (not pence) for XLON
        let currency = resolver.get_equity_currency(&Some("XLON".into()), &"ALPHA_VANTAGE".into());
        assert_eq!(currency.as_deref(), Some("GBP"));
    }
}
