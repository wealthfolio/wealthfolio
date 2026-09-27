//! Provider-specific symbol resolution.
//!
//! This module provides mappings from canonical (ticker, MIC) pairs to
//! provider-specific symbols. Each provider (Yahoo, Alpha Vantage, etc.)
//! uses different suffixes to identify exchanges.

use std::borrow::Cow;
use std::collections::HashMap;

use crate::models::{Mic, ProviderId};

use super::exchange_registry::{canonicalize_exchange_mic, REGISTRY};

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
        for entry in REGISTRY
            .catalog
            .exchanges
            .iter()
            .chain(REGISTRY.catalog.legacy_exchanges.iter())
        {
            let mut provider_map: HashMap<ProviderId, ExchangeSuffix> = HashMap::new();

            for (provider_id, rule) in &entry.providers {
                let currency = rule
                    .currency
                    .as_deref()
                    .or(entry.currency.as_deref())
                    .unwrap_or("USD");
                let suffix = explicit_symbol_suffix(rule.suffix.as_deref(), rule.bare);
                if let Some(suffix) = suffix {
                    provider_map.insert(
                        Cow::Owned(provider_id.to_ascii_uppercase()),
                        ExchangeSuffix {
                            suffix: Cow::Owned(suffix),
                            currency: Cow::Owned(currency.to_string()),
                        },
                    );
                }
            }

            if !provider_map.is_empty() {
                self.mappings
                    .insert(Cow::Owned(entry.mic.clone()), provider_map);
            }
        }
    }

    /// Get the suffix for a MIC and provider.
    pub fn get_suffix(&self, mic: &Mic, provider: &ProviderId) -> Option<&str> {
        let canonical = canonicalize_exchange_mic(mic);
        let provider = provider.to_ascii_uppercase();
        self.mappings
            .get(canonical.as_str())?
            .get(provider.as_str())
            .map(|s| s.suffix.as_ref())
    }

    /// Get the currency for a MIC and provider.
    pub fn get_currency(&self, mic: &Mic, provider: &ProviderId) -> Option<&str> {
        let canonical = canonicalize_exchange_mic(mic);
        let provider = provider.to_ascii_uppercase();
        self.mappings
            .get(canonical.as_str())?
            .get(provider.as_str())
            .map(|s| s.currency.as_ref())
    }

    /// Resolve a MIC to a provider suffix, saying whether the result can be
    /// trusted to address the venue that was asked for.
    ///
    /// `None` means the registry has no verified rule. A returned empty suffix
    /// is trusted because bare-symbol conventions are explicit catalog data.
    pub fn get_suffix_checked(&self, mic: &Mic, provider: &ProviderId) -> Option<(&str, bool)> {
        let suffix = self.get_suffix(mic, provider)?;
        Some((suffix, true))
    }

    /// Check if a MIC is supported.
    pub fn has_mic(&self, mic: &Mic) -> bool {
        self.mappings
            .contains_key(canonicalize_exchange_mic(mic).as_str())
    }

    /// Check if a MIC/provider combination is supported.
    pub fn has_mapping(&self, mic: &Mic, provider: &ProviderId) -> bool {
        let canonical = canonicalize_exchange_mic(mic);
        let provider = provider.to_ascii_uppercase();
        self.mappings
            .get(canonical.as_str())
            .map(|p| p.contains_key(provider.as_str()))
            .unwrap_or(false)
    }
}

fn explicit_symbol_suffix(suffix: Option<&str>, bare: bool) -> Option<String> {
    assert!(
        !(bare && suffix.is_some_and(|value| !value.is_empty())),
        "a provider rule cannot be both bare and suffixed"
    );
    if bare {
        Some(String::new())
    } else {
        suffix.filter(|value| !value.is_empty()).map(str::to_string)
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

/// Strip a Yahoo suffix only when the supplied MIC has that exact provider
/// rule. This lets an explicit venue disambiguate suffixes such as `.AE`, which
/// is shared by XDFM and XADS and therefore cannot infer a MIC on its own.
pub fn strip_yahoo_suffix_for_mic<'a>(symbol: &'a str, mic: &str) -> Option<&'a str> {
    let canonical = canonicalize_exchange_mic(mic);
    let entry = REGISTRY
        .catalog
        .exchanges
        .iter()
        .chain(REGISTRY.catalog.legacy_exchanges.iter())
        .find(|entry| entry.mic.eq_ignore_ascii_case(&canonical))?;
    let suffix = entry.providers.get("YAHOO")?.suffix.as_deref()?;
    if suffix.is_empty() {
        return None;
    }
    strip_ascii_suffix_ignore_case(symbol.trim(), suffix)
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

/// Whether a dotted symbol ends in an exchange-like suffix that cannot identify
/// one Yahoo venue without an explicit MIC.
///
/// A one-letter tail remains the established share-class convention
/// (`BRK.B`). Longer alphanumeric tails must be preserved until an exact
/// provider result confirms them; rewriting one as a Yahoo share class can
/// silently select a different security (`BAC.PB` -> `BAC-PB`).
pub fn has_unrecognized_dotted_suffix(symbol: &str) -> bool {
    let trimmed = symbol.trim();
    let (_, suffix_mic, _) = split_known_yahoo_suffix(trimmed);
    suffix_mic.is_none()
        && trimmed.rsplit_once('.').is_some_and(|(base, suffix)| {
            !base.is_empty()
                && suffix.len() > 1
                && suffix
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric())
        })
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

    if has_unrecognized_dotted_suffix(trimmed) {
        return vec![trimmed.to_string()];
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

    // Only a suffix with one unambiguous reverse MIC can infer an exchange.
    // Shared provider suffixes remain part of the symbol until a caller supplies
    // a MIC and uses `strip_yahoo_suffix_for_mic` to disambiguate them.
    for suffix in yahoo_exchange_suffixes() {
        let suffix_code = suffix.strip_prefix('.').unwrap_or(suffix);
        if yahoo_suffix_to_mic(suffix_code).is_none() {
            continue;
        }
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
        for provider in ["FINNHUB", "MARKETDATA_APP"] {
            assert_eq!(
                map.get_suffix_checked(&Cow::Borrowed("XNAS"), &Cow::Owned(provider.to_string())),
                Some(("", true))
            );
        }

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
        assert_eq!(
            map.get_suffix(&Cow::Borrowed("XAQE"), &Cow::Borrowed("YAHOO")),
            Some(".AQ")
        );

        // XETRA
        assert_eq!(
            map.get_suffix(&Cow::Borrowed("XETR"), &Cow::Borrowed("YAHOO")),
            Some(".DE")
        );
    }

    /// Bare symbols are an explicit provider rule. A blank or missing suffix is
    /// never inferred from the venue's currency.
    #[test]
    fn test_bare_symbol_rules_are_explicit() {
        let map = ExchangeMap::new();

        // NASDAQ writes tickers bare, so an empty suffix is the real answer.
        assert_eq!(
            map.get_suffix_checked(&Cow::Borrowed("XNAS"), &Cow::Borrowed("YAHOO")),
            Some(("", true))
        );

        // Amsterdam has no verified Alpha Vantage rule.
        assert_eq!(
            map.get_suffix_checked(&Cow::Borrowed("XAMS"), &Cow::Borrowed("ALPHA_VANTAGE")),
            None
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
        assert_eq!(
            yahoo_exchange_to_mic("AQS"),
            Some(Cow::Owned("AQSE".to_string()))
        );

        // Toronto
        assert_eq!(
            yahoo_exchange_to_mic("TOR"),
            Some(Cow::Owned("XTSE".to_string()))
        );

        // Cboe UK Yahoo exchange code resolves to dedicated Cboe UK MIC.
        assert_eq!(
            yahoo_exchange_to_mic("CXE"),
            Some(Cow::Owned("BCXE".to_string()))
        );
        assert_eq!(
            yahoo_exchange_to_mic(" cxe "),
            Some(Cow::Owned("BCXE".to_string()))
        );
        // Cboe Europe EUR (DXE) — used by SXLPM.XD and similar instruments
        assert_eq!(
            yahoo_exchange_to_mic("DXE"),
            Some(Cow::Owned("CCXE".to_string()))
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

        // `.AE` is used by both XDFM and XADS, so the symbol alone is not
        // enough evidence to strip it.
        assert_eq!(strip_yahoo_suffix("FOO.AE"), "FOO.AE");
        assert_eq!(strip_yahoo_suffix_for_mic("FOO.AE", "XDFM"), Some("FOO"));
        assert_eq!(strip_yahoo_suffix_for_mic("FOO.AE", "XADS"), Some("FOO"));

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
        assert_eq!(yahoo_equity_search_queries("BAC.PB"), vec!["BAC.PB"]);
        assert!(has_unrecognized_dotted_suffix("BAC.PB"));
        assert!(has_unrecognized_dotted_suffix("FOO.AE"));
        assert_eq!(yahoo_equity_search_queries("FOO.AE"), vec!["FOO.AE"]);
        assert!(!has_unrecognized_dotted_suffix("BRK.B"));
        assert!(!has_unrecognized_dotted_suffix("SHOP.TO"));
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
        assert_eq!(yahoo_suffix_to_mic("XC"), Some("BCXE"));
        assert_eq!(yahoo_suffix_to_mic("xc"), Some("BCXE"));
        assert_eq!(yahoo_suffix_to_mic("XD"), Some("CCXE")); // Cboe Europe EUR
        assert_eq!(yahoo_suffix_to_mic("AQ"), Some("AQSE")); // Yahoo lists .AQ as AQSE
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
