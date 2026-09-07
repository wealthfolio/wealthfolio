//! Provider-specific symbol resolution.
//!
//! This module provides mappings from canonical (ticker, MIC) pairs to
//! provider-specific symbols. Each provider (Yahoo, Alpha Vantage, etc.)
//! uses different suffixes to identify exchanges.

use std::borrow::Cow;
use std::collections::HashMap;

use crate::models::{Mic, ProviderId};

use super::exchange_registry::REGISTRY;

/// Provider-specific exchange suffix and currency.
#[derive(Clone, Debug)]
pub struct ExchangeSuffix {
    /// The suffix to append to the ticker (e.g., ".TO" for Yahoo TSX).
    pub suffix: Cow<'static, str>,
    /// The trading currency for this exchange (e.g., "CAD" for TSX).
    pub currency: Cow<'static, str>,
}

/// MIC to provider suffix mapping database.
///
/// Maps ISO 10383 Market Identifier Codes to provider-specific suffixes
/// for each supported provider.
pub struct ExchangeMap {
    mappings: HashMap<Mic, HashMap<ProviderId, ExchangeSuffix>>,
}

impl Default for ExchangeMap {
    fn default() -> Self {
        Self::new()
    }
}

impl ExchangeMap {
    /// Create a new ExchangeMap with default mappings.
    pub fn new() -> Self {
        let mut map = Self {
            mappings: HashMap::new(),
        };
        map.load_defaults();
        map
    }

    /// Load all default exchange mappings from the JSON registry.
    fn load_defaults(&mut self) {
        for entry in &REGISTRY.catalog.exchanges {
            let mut provider_map: HashMap<ProviderId, ExchangeSuffix> = HashMap::new();

            if let Some(ref yahoo) = entry.yahoo {
                let currency = yahoo
                    .currency
                    .as_deref()
                    .or(entry.currency.as_deref())
                    .unwrap_or("USD");
                provider_map.insert(
                    Cow::Owned("YAHOO".to_string()),
                    ExchangeSuffix {
                        suffix: Cow::Owned(yahoo.suffix.clone()),
                        currency: Cow::Owned(currency.to_string()),
                    },
                );
            }

            if let Some(ref av) = entry.alpha_vantage {
                let currency = av
                    .currency
                    .as_deref()
                    .or(entry.currency.as_deref())
                    .unwrap_or("USD");
                provider_map.insert(
                    Cow::Owned("ALPHA_VANTAGE".to_string()),
                    ExchangeSuffix {
                        suffix: Cow::Owned(av.suffix.clone()),
                        currency: Cow::Owned(currency.to_string()),
                    },
                );
            }

            if !provider_map.is_empty() {
                self.mappings
                    .insert(Cow::Owned(entry.mic.clone()), provider_map);
            }
        }
    }

    /// Get the suffix for a MIC and provider.
    pub fn get_suffix(&self, mic: &Mic, provider: &ProviderId) -> Option<&str> {
        self.mappings
            .get(mic)?
            .get(provider)
            .map(|s| s.suffix.as_ref())
    }

    /// Get the currency for a MIC and provider.
    pub fn get_currency(&self, mic: &Mic, provider: &ProviderId) -> Option<&str> {
        self.mappings
            .get(mic)?
            .get(provider)
            .map(|s| s.currency.as_ref())
    }

    /// Whether an empty suffix for this venue is the provider's convention
    /// rather than a hole in the registry.
    ///
    /// Yahoo and Alpha Vantage both write US tickers bare, so an empty suffix
    /// is a real answer on a US venue — `AAPL` addresses exactly one listing.
    /// Anywhere else it appends nothing to a ticker the provider then resolves
    /// against its own default namespace, which *is* the US market, so the
    /// symbol silently addresses a different instrument while looking like a
    /// resolution.
    ///
    /// Currency is the discriminator because it is the only signal the catalog
    /// carries, and it is exact for all 75 venues: the six that write bare
    /// tickers (`XNYS`, `XNAS`, `XASE`, `ARCX`, `BATS`, `OTCM`) are precisely
    /// the six the registry prices in USD.
    fn empty_suffix_is_conventional(&self, mic: &Mic, provider: &ProviderId) -> bool {
        self.get_currency(mic, provider) == Some("USD")
    }

    /// Resolve a MIC to a provider suffix, saying whether the result can be
    /// trusted to address the venue that was asked for.
    ///
    /// `None` means the registry has no entry at all. `Some((suffix, false))`
    /// means it has one that resolves to a bare ticker on a venue where bare
    /// tickers are not the convention — which is a gap wearing a resolution's
    /// clothes, and the caller must treat it as a fallback.
    pub fn get_suffix_checked(&self, mic: &Mic, provider: &ProviderId) -> Option<(&str, bool)> {
        let suffix = self.get_suffix(mic, provider)?;
        let trusted = !suffix.is_empty() || self.empty_suffix_is_conventional(mic, provider);
        Some((suffix, trusted))
    }

    /// Check if a MIC is supported.
    pub fn has_mic(&self, mic: &Mic) -> bool {
        self.mappings.contains_key(mic)
    }

    /// Check if a MIC/provider combination is supported.
    pub fn has_mapping(&self, mic: &Mic, provider: &ProviderId) -> bool {
        self.mappings
            .get(mic)
            .map(|p| p.contains_key(provider))
            .unwrap_or(false)
    }
}

/// Map Yahoo exchange code to MIC.
pub fn yahoo_exchange_to_mic(code: &str) -> Option<Mic> {
    let normalized = code.trim().to_uppercase();
    REGISTRY
        .yahoo_code_to_mic
        .get(&normalized)
        .map(|mic| Cow::Owned(mic.clone()))
}

/// Known Yahoo exchange suffixes.
///
/// Returns the whitelist used by `strip_yahoo_suffix` to safely extract
/// the canonical ticker from a Yahoo symbol.
pub fn yahoo_exchange_suffixes() -> &'static [&'static str] {
    REGISTRY.yahoo_suffixes
}

/// Map Yahoo Finance symbol suffix to canonical MIC.
pub fn yahoo_suffix_to_mic(suffix: &str) -> Option<&'static str> {
    REGISTRY
        .yahoo_suffix_to_mic
        .get(&suffix.to_uppercase())
        .copied()
}

fn strip_ascii_suffix_ignore_case<'a>(value: &'a str, suffix: &str) -> Option<&'a str> {
    let start = value.len().checked_sub(suffix.len())?;
    let candidate = value.get(start..)?;
    if candidate.eq_ignore_ascii_case(suffix) {
        value.get(..start)
    } else {
        None
    }
}

fn split_known_yahoo_suffix(symbol: &str) -> (&str, Option<&'static str>, Option<&'static str>) {
    let trimmed = symbol.trim();
    for suffix in yahoo_exchange_suffixes() {
        if let Some(base) = strip_ascii_suffix_ignore_case(trimmed, suffix) {
            let suffix_code = suffix.strip_prefix('.').unwrap_or(suffix);
            return (base, yahoo_suffix_to_mic(suffix_code), Some(*suffix));
        }
    }
    (trimmed, None, None)
}

/// Format an equity ticker base for Yahoo.
///
/// Yahoo uses dotted suffixes for exchanges (`SHOP.TO`, `VOD.L`) but hyphens
/// for share-class separators in the base ticker (`BRK-B`). Callers must strip
/// known exchange suffixes before formatting the base.
pub fn yahoo_equity_base_to_provider(base: &str) -> String {
    base.trim().replace('.', "-")
}

/// Convert a Yahoo equity provider symbol into the app's canonical ticker form.
///
/// Known exchange suffixes are preserved for the canonicalizer to strip into MIC.
/// For unsuffixed Yahoo equity symbols, a trailing one-letter hyphen class maps
/// back to the app's dotted share-class notation.
pub fn yahoo_equity_provider_symbol_to_canonical(symbol: &str) -> String {
    let trimmed = symbol.trim();
    let (base, _suffix_mic, known_suffix) = split_known_yahoo_suffix(trimmed);
    if known_suffix.is_some() {
        let suffix = trimmed.get(base.len()..).unwrap_or_default();
        return format!(
            "{}{}",
            yahoo_equity_provider_base_to_canonical(base),
            suffix
        );
    }

    yahoo_equity_provider_base_to_canonical(trimmed)
}

fn yahoo_equity_provider_base_to_canonical(base: &str) -> String {
    let trimmed = base.trim();
    let Some((base, class)) = trimmed.rsplit_once('-') else {
        return trimmed.to_string();
    };
    if base.is_empty() || class.len() != 1 || !class.chars().all(|c| c.is_ascii_alphabetic()) {
        return trimmed.to_string();
    }

    format!("{}.{}", base, class)
}

/// Build Yahoo search queries for an equity-like user query.
///
/// This keeps known exchange suffixes intact (`SHOP.TO` stays `SHOP.TO`) while
/// trying Yahoo's base share-class notation first (`BRK.B` -> `BRK-B`).
pub fn yahoo_equity_search_queries(query: &str) -> Vec<String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return vec![];
    }

    let (base, _suffix_mic, known_suffix) = split_known_yahoo_suffix(trimmed);
    let provider_base = yahoo_equity_base_to_provider(base);
    let provider_query = if known_suffix.is_some() {
        let suffix = trimmed.get(base.len()..).unwrap_or_default();
        format!("{provider_base}{suffix}")
    } else {
        provider_base
    };

    let mut queries = vec![provider_query];
    if !queries[0].eq_ignore_ascii_case(trimmed) {
        queries.push(trimmed.to_string());
    }
    queries
}

/// Extract canonical ticker from Yahoo provider symbol.
///
/// Uses a whitelist approach to safely strip exchange suffixes while preserving
/// share classes like BRK.B or RDS.A (since .B and .A are not in the whitelist).
pub fn strip_yahoo_suffix(symbol: &str) -> &str {
    // Handle special suffixes first
    if let Some(base) = strip_ascii_suffix_ignore_case(symbol, "=X") {
        // FX pairs like EURUSD=X
        return base;
    }
    if let Some(base) = strip_ascii_suffix_ignore_case(symbol, "=F") {
        // Futures like GC=F
        return base;
    }

    // Only strip if suffix is in our known exchange whitelist
    for suffix in yahoo_exchange_suffixes() {
        if let Some(base) = strip_ascii_suffix_ignore_case(symbol, suffix) {
            return base;
        }
    }

    // No known suffix found - return as-is (preserves BRK.B, RDS.A, etc.)
    symbol
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_exchange_map_north_america() {
        let map = ExchangeMap::new();

        // NYSE - no suffix for US exchanges
        assert_eq!(
            map.get_suffix(&Cow::Borrowed("XNYS"), &Cow::Borrowed("YAHOO")),
            Some("")
        );
        assert_eq!(
            map.get_currency(&Cow::Borrowed("XNYS"), &Cow::Borrowed("YAHOO")),
            Some("USD")
        );

        // Toronto
        assert_eq!(
            map.get_suffix(&Cow::Borrowed("XTSE"), &Cow::Borrowed("YAHOO")),
            Some(".TO")
        );
        assert_eq!(
            map.get_suffix(&Cow::Borrowed("XTSE"), &Cow::Borrowed("ALPHA_VANTAGE")),
            Some(".TRT")
        );
        assert_eq!(
            map.get_currency(&Cow::Borrowed("XTSE"), &Cow::Borrowed("YAHOO")),
            Some("CAD")
        );
    }

    #[test]
    fn test_exchange_map_europe() {
        let map = ExchangeMap::new();

        // London - Note: Yahoo returns GBp (pence)
        assert_eq!(
            map.get_suffix(&Cow::Borrowed("XLON"), &Cow::Borrowed("YAHOO")),
            Some(".L")
        );
        assert_eq!(
            map.get_currency(&Cow::Borrowed("XLON"), &Cow::Borrowed("YAHOO")),
            Some("GBp")
        );

        assert_eq!(
            map.get_currency(&Cow::Borrowed("XTAE"), &Cow::Borrowed("YAHOO")),
            Some("ILA")
        );

        // Cboe UK (Yahoo .XC) - provider reports GBP for this venue
        assert_eq!(
            map.get_suffix(&Cow::Borrowed("CXE"), &Cow::Borrowed("YAHOO")),
            Some(".XC")
        );
        assert_eq!(
            map.get_currency(&Cow::Borrowed("CXE"), &Cow::Borrowed("YAHOO")),
            Some("GBP")
        );

        // XETRA
        assert_eq!(
            map.get_suffix(&Cow::Borrowed("XETR"), &Cow::Borrowed("YAHOO")),
            Some(".DE")
        );
    }

    /// An empty suffix means "write the ticker bare", which is only an answer
    /// on the venues where that is the provider's convention. Everywhere else
    /// it is an unfilled entry, and `get_suffix` alone cannot tell the caller
    /// which it is holding.
    #[test]
    fn test_empty_suffix_is_only_trusted_on_a_bare_ticker_venue() {
        let map = ExchangeMap::new();

        // NASDAQ writes tickers bare, so an empty suffix is the real answer.
        assert_eq!(
            map.get_suffix_checked(&Cow::Borrowed("XNAS"), &Cow::Borrowed("YAHOO")),
            Some(("", true))
        );

        // Amsterdam does not, so its empty Alpha Vantage suffix is a gap.
        assert_eq!(
            map.get_suffix_checked(&Cow::Borrowed("XAMS"), &Cow::Borrowed("ALPHA_VANTAGE")),
            Some(("", false))
        );

        // A venue with a real suffix is trusted whatever its currency.
        assert_eq!(
            map.get_suffix_checked(&Cow::Borrowed("XLON"), &Cow::Borrowed("YAHOO")),
            Some((".L", true))
        );

        // No entry at all stays distinct from an empty one.
        assert_eq!(
            map.get_suffix_checked(&Cow::Borrowed("XKRX"), &Cow::Borrowed("ALPHA_VANTAGE")),
            None
        );
    }

    /// The venues that write bare tickers are the ones the catalog prices in
    /// USD, which is what makes currency a sound discriminator.
    ///
    /// One entry is knowingly not: Euronext Amsterdam carries an empty Alpha
    /// Vantage suffix and trades in EUR. The change above makes that resolve as
    /// a fallback so it is checked rather than trusted, but the real fix is to
    /// give the venue its Alpha Vantage suffix — which needs confirming against
    /// the provider, not guessing from the pattern of its Euronext siblings.
    /// Naming it here keeps it from being mistaken for an intended bare-ticker
    /// venue, and this list should shrink to empty rather than grow.
    #[test]
    fn test_only_known_venues_carry_an_empty_suffix() {
        const KNOWN_EMPTY_NON_USD: &[(&str, &str)] = &[("XAMS", "ALPHA_VANTAGE")];

        for entry in &REGISTRY.catalog.exchanges {
            let fallback = entry.currency.as_deref();

            let check = |provider: &str, suffix: &str, currency: Option<&str>| {
                if !suffix.is_empty() {
                    return;
                }
                if currency.or(fallback) == Some("USD") {
                    return;
                }
                assert!(
                    KNOWN_EMPTY_NON_USD.contains(&(entry.mic.as_str(), provider)),
                    "{} has an empty {} suffix but does not write bare tickers - \
                     give it a real suffix, or add it to KNOWN_EMPTY_NON_USD with a reason",
                    entry.mic,
                    provider
                );
            };

            if let Some(yahoo) = &entry.yahoo {
                check("YAHOO", &yahoo.suffix, yahoo.currency.as_deref());
            }
            if let Some(av) = &entry.alpha_vantage {
                check("ALPHA_VANTAGE", &av.suffix, av.currency.as_deref());
            }
        }
    }

    #[test]
    fn test_yahoo_exchange_to_mic() {
        // NASDAQ variants
        assert_eq!(
            yahoo_exchange_to_mic("NMS"),
            Some(Cow::Owned("XNAS".to_string()))
        );
        assert_eq!(
            yahoo_exchange_to_mic("NGM"),
            Some(Cow::Owned("XNAS".to_string()))
        );
        assert_eq!(
            yahoo_exchange_to_mic("NYQ"),
            Some(Cow::Owned("XNYS".to_string()))
        );

        // Yahoo uses PCX for NYSE Arca ETFs; ASE is NYSE American.
        assert_eq!(
            yahoo_exchange_to_mic("PCX"),
            Some(Cow::Owned("ARCX".to_string()))
        );
        assert_eq!(
            yahoo_exchange_to_mic("ASE"),
            Some(Cow::Owned("XASE".to_string()))
        );

        // Toronto
        assert_eq!(
            yahoo_exchange_to_mic("TOR"),
            Some(Cow::Owned("XTSE".to_string()))
        );

        // Cboe UK Yahoo exchange code resolves to dedicated Cboe UK MIC.
        assert_eq!(
            yahoo_exchange_to_mic("CXE"),
            Some(Cow::Owned("CXE".to_string()))
        );
        assert_eq!(
            yahoo_exchange_to_mic(" cxe "),
            Some(Cow::Owned("CXE".to_string()))
        );
        // Cboe Europe EUR (DXE) — used by SXLPM.XD and similar instruments
        assert_eq!(
            yahoo_exchange_to_mic("DXE"),
            Some(Cow::Owned("DXE".to_string()))
        );
        assert_eq!(
            yahoo_exchange_to_mic("xice"),
            Some(Cow::Owned("XICE".to_string()))
        );

        // Unknown
        assert_eq!(yahoo_exchange_to_mic("UNKNOWN"), None);
    }

    #[test]
    fn test_strip_yahoo_suffix() {
        // Normal exchange suffixes
        assert_eq!(strip_yahoo_suffix("SHOP.TO"), "SHOP");
        assert_eq!(strip_yahoo_suffix("shop.to"), "shop");
        assert_eq!(strip_yahoo_suffix("AAPL"), "AAPL");
        assert_eq!(strip_yahoo_suffix("VOD.L"), "VOD");
        assert_eq!(strip_yahoo_suffix("vod.l"), "vod");

        // Share classes preserved
        assert_eq!(strip_yahoo_suffix("BRK.B"), "BRK.B");
        assert_eq!(strip_yahoo_suffix("RDS.A"), "RDS.A");

        // Cboe Europe EUR suffix
        assert_eq!(strip_yahoo_suffix("SXLPM.XD"), "SXLPM");

        // Special suffixes
        assert_eq!(strip_yahoo_suffix("EURUSD=X"), "EURUSD");
        assert_eq!(strip_yahoo_suffix("eurusd=x"), "eurusd");
        assert_eq!(strip_yahoo_suffix("GC=F"), "GC");
        assert_eq!(strip_yahoo_suffix("gc=f"), "gc");
    }

    #[test]
    fn test_yahoo_suffix_helpers_handle_non_ascii_symbols() {
        for symbol in ["ÅÄÖ", "سهم", "東京", "😀"] {
            assert_eq!(strip_yahoo_suffix(symbol), symbol);
            assert_eq!(yahoo_equity_search_queries(symbol), vec![symbol]);
            assert_eq!(yahoo_equity_provider_symbol_to_canonical(symbol), symbol);

            let suffixed = format!("{symbol}.TO");
            assert_eq!(strip_yahoo_suffix(&suffixed), symbol);
            assert_eq!(
                yahoo_equity_search_queries(&suffixed),
                vec![suffixed.clone()]
            );
            assert_eq!(
                yahoo_equity_provider_symbol_to_canonical(&suffixed),
                suffixed
            );
        }
    }

    #[test]
    fn test_yahoo_share_class_aliases_are_explicit() {
        assert_eq!(yahoo_equity_base_to_provider("BRK.B"), "BRK-B");
        assert_eq!(yahoo_equity_base_to_provider("brk.a"), "brk-a");
        assert_eq!(yahoo_equity_search_queries("BRK.B"), vec!["BRK-B", "BRK.B"]);
        assert_eq!(yahoo_equity_search_queries("SHOP.TO"), vec!["SHOP.TO"]);
        assert_eq!(yahoo_equity_search_queries("VOD.L"), vec!["VOD.L"]);
        assert_eq!(yahoo_equity_provider_symbol_to_canonical("BRK-B"), "BRK.B");
        assert_eq!(
            yahoo_equity_provider_symbol_to_canonical("BRK-B.TO"),
            "BRK.B.TO"
        );
        assert_eq!(
            yahoo_equity_provider_symbol_to_canonical("SHOP.TO"),
            "SHOP.TO"
        );
    }

    #[test]
    fn test_yahoo_exchange_suffixes_are_never_share_classes() {
        for suffix in yahoo_exchange_suffixes() {
            let query = format!("ABC{}", suffix);
            assert_eq!(yahoo_equity_search_queries(&query), vec![query]);

            let provider_symbol = format!("BRK-B{}", suffix);
            let canonical_symbol = format!("BRK.B{}", suffix);
            assert_eq!(
                yahoo_equity_provider_symbol_to_canonical(&provider_symbol),
                canonical_symbol
            );
        }
    }

    #[test]
    fn test_yahoo_suffix_to_mic() {
        // North America
        assert_eq!(yahoo_suffix_to_mic("TO"), Some("XTSE"));
        assert_eq!(yahoo_suffix_to_mic("V"), Some("XTSX"));
        assert_eq!(yahoo_suffix_to_mic("to"), Some("XTSE")); // Case insensitive
        assert_eq!(yahoo_suffix_to_mic("NE"), Some("NEOE")); // Cboe Canada's ISO MIC

        // UK & Europe
        assert_eq!(yahoo_suffix_to_mic("L"), Some("XLON"));
        assert_eq!(yahoo_suffix_to_mic("XC"), Some("CXE"));
        assert_eq!(yahoo_suffix_to_mic("xc"), Some("CXE"));
        assert_eq!(yahoo_suffix_to_mic("XD"), Some("DXE")); // Cboe Europe EUR
        assert_eq!(yahoo_suffix_to_mic("DE"), Some("XETR"));
        assert_eq!(yahoo_suffix_to_mic("PA"), Some("XPAR"));
        assert_eq!(yahoo_suffix_to_mic("AE"), None); // Ambiguous between XDFM and XADS

        // Asia
        assert_eq!(yahoo_suffix_to_mic("T"), Some("XTKS"));
        assert_eq!(yahoo_suffix_to_mic("HK"), Some("XHKG"));

        // Unknown
        assert_eq!(yahoo_suffix_to_mic("UNKNOWN"), None);
        assert_eq!(yahoo_suffix_to_mic("B"), None); // Share class, not suffix
    }
}
