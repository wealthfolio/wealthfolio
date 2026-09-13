//! JSON-driven exchange metadata registry.
//!
//! Loads `exchanges.json` at compile time via `include_str!` and builds
//! reverse-lookup indexes once via `lazy_static`.

use std::collections::{HashMap, HashSet};

use lazy_static::lazy_static;
use serde::Deserialize;

// ── JSON schema ──────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub(crate) struct ExchangeCatalog {
    pub exchanges: Vec<ExchangeEntry>,
    pub currency_priority: HashMap<String, Vec<String>>,
}

#[derive(Debug, Clone, Deserialize, serde::Serialize)]
pub struct ExchangeEntry {
    pub mic: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub long_name: Option<String>,
    #[serde(default)]
    pub currency: Option<String>,
    #[serde(default)]
    pub timezone: Option<String>,
    #[serde(default)]
    pub close: Option<[u8; 2]>,
    #[serde(default)]
    pub yahoo: Option<YahooInfo>,
    #[serde(default)]
    pub alpha_vantage: Option<ProviderInfo>,
}

#[derive(Debug, Clone, Deserialize, serde::Serialize)]
pub struct YahooInfo {
    pub suffix: String,
    #[serde(default)]
    pub currency: Option<String>,
    #[serde(default)]
    pub codes: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, serde::Serialize)]
pub struct ProviderInfo {
    pub suffix: String,
    #[serde(default)]
    pub currency: Option<String>,
}

// ── Public API type for frontend consumption ─────────────────────────────────

/// Simplified exchange info exposed to callers (API endpoints, frontend).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExchangeInfo {
    pub mic: String,
    pub name: String,
    pub long_name: String,
    pub currency: String,
}

/// Return the list of "real" exchanges (those with a name).
pub fn get_exchange_list() -> Vec<ExchangeInfo> {
    REGISTRY
        .catalog
        .exchanges
        .iter()
        .filter_map(|e| {
            let name = e.name.as_ref()?;
            Some(ExchangeInfo {
                mic: e.mic.clone(),
                long_name: e.long_name.as_ref().unwrap_or(name).clone(),
                name: name.clone(),
                currency: e.currency.as_ref()?.clone(),
            })
        })
        .collect()
}

// ── Registry with pre-built indexes ──────────────────────────────────────────

fn leak_str(s: String) -> &'static str {
    Box::leak(s.into_boxed_str())
}

pub(crate) struct ExchangeRegistry {
    pub catalog: ExchangeCatalog,
    /// mic → leaked &'static str for exchange name
    pub name_by_mic: HashMap<String, &'static str>,
    /// mic → leaked &'static str for currency
    pub currency_by_mic: HashMap<String, &'static str>,
    /// mic → leaked &'static str for timezone
    pub timezone_by_mic: HashMap<String, &'static str>,
    /// mic → market close time
    pub close_by_mic: HashMap<String, (u8, u8)>,
    /// Leaked static slices for `exchanges_for_currency`
    pub currency_priority_slices: HashMap<&'static str, &'static [&'static str]>,
    /// Yahoo exchange code (e.g. "NMS") → MIC
    pub yahoo_code_to_mic: HashMap<String, String>,
    /// Yahoo suffix without dot (upper, e.g. "TO") → leaked MIC
    pub yahoo_suffix_to_mic: HashMap<String, &'static str>,
    /// All known Yahoo suffixes (e.g. ".TO", ".L") – leaked for 'static lifetime
    pub yahoo_suffixes: &'static [&'static str],
}

lazy_static! {
    pub(crate) static ref REGISTRY: ExchangeRegistry = ExchangeRegistry::load();
}

/// Registry keys that are not ISO 10383 MICs, each with what blocks fixing it.
///
/// The catalog is keyed by MIC, and that key reaches the database: `assets`
/// stores it as `instrument_exchange_mic` and embeds it in the generated
/// `instrument_key`. A key that is not a MIC therefore cannot match what a
/// broker or a provider reports for the same venue, and correcting one later
/// costs a migration — which is how `XNEO` came to leave a stale asset row
/// beside its live twin for five instruments.
///
/// This list exists so the cost is paid knowingly. It should shrink, never grow.
#[cfg(test)]
const NON_ISO_MIC_KEYS: &[(&str, &str)] = &[
    (
        "XAQE",
        "Aquis operates two venues under separate MICs - AQSE, the recognised \
         investment exchange securities list on, and AQXE, the MTF - and which \
         one Yahoo's `.AQ` addresses has not been established",
    ),
    (
        "XLON_IL",
        "the International Order Book has no MIC of its own; it trades under \
         XLON, so `.IL` needs the suffix index to prefer a primary venue rather \
         than drop an ambiguous pair (see the `.AE` case)",
    ),
];

/// Whether a string has the shape ISO 10383 gives a MIC: four uppercase
/// alphanumerics.
///
/// A shape check cannot tell a real MIC from an invented four-character one -
/// `XAQE` passes it and is still not a MIC - but it does catch the failure mode
/// the catalog has actually had, which is a key made up to a local convention
/// (`CXE`, `XTAI_OTC`, `XLON_IL`, `XNEO`).
#[cfg(test)]
fn is_iso_10383_shaped(mic: &str) -> bool {
    mic.len() == 4
        && mic
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
}

impl ExchangeRegistry {
    fn load() -> Self {
        let json = include_str!("exchanges.json");
        let catalog: ExchangeCatalog =
            serde_json::from_str(json).expect("exchanges.json must be valid");

        // Leaked metadata maps
        let mut name_by_mic = HashMap::new();
        let mut currency_by_mic = HashMap::new();
        let mut timezone_by_mic = HashMap::new();
        let mut close_by_mic = HashMap::new();

        for entry in &catalog.exchanges {
            if let Some(ref name) = entry.name {
                name_by_mic.insert(entry.mic.clone(), leak_str(name.clone()));
            }
            if let Some(ref ccy) = entry.currency {
                currency_by_mic.insert(entry.mic.clone(), leak_str(ccy.clone()));
            }
            if let Some(ref tz) = entry.timezone {
                timezone_by_mic.insert(entry.mic.clone(), leak_str(tz.clone()));
            }
            if let Some(close) = entry.close {
                close_by_mic.insert(entry.mic.clone(), (close[0], close[1]));
            }
        }

        // yahoo_code_to_mic: codes → mic
        let mut yahoo_code_to_mic = HashMap::new();
        for entry in &catalog.exchanges {
            yahoo_code_to_mic
                .entry(entry.mic.trim().to_uppercase())
                .or_insert_with(|| entry.mic.clone());
            if let Some(ref yahoo) = entry.yahoo {
                for code in &yahoo.codes {
                    let key = code.trim().to_uppercase();
                    if !key.is_empty() {
                        yahoo_code_to_mic.insert(key, entry.mic.clone());
                    }
                }
            }
        }

        // yahoo_suffix_to_mic: suffix (without dot, uppercased) → leaked mic.
        // Ambiguous suffixes (same suffix used by multiple MICs) are excluded.
        // Also collect suffixes for the whitelist
        let mut suffix_to_mic: HashMap<String, &'static str> = HashMap::new();
        let mut ambiguous_suffixes: HashSet<String> = HashSet::new();
        let mut suffix_set = Vec::new();
        for entry in &catalog.exchanges {
            if let Some(ref yahoo) = entry.yahoo {
                if !yahoo.suffix.is_empty() {
                    let without_dot = yahoo.suffix.trim_start_matches('.');
                    let suffix_key = without_dot.to_uppercase();
                    if !ambiguous_suffixes.contains(&suffix_key) {
                        if let Some(existing_mic) = suffix_to_mic.get(&suffix_key) {
                            if !existing_mic.eq_ignore_ascii_case(&entry.mic) {
                                suffix_to_mic.remove(&suffix_key);
                                ambiguous_suffixes.insert(suffix_key.clone());
                            }
                        } else {
                            suffix_to_mic.insert(suffix_key.clone(), leak_str(entry.mic.clone()));
                        }
                    }
                    suffix_set.push(yahoo.suffix.clone());
                }
            }
        }

        // Deduplicate suffixes (e.g. ".AE" appears for both XDFM and XADS)
        suffix_set.sort();
        suffix_set.dedup();

        // Leak suffix strings for 'static lifetime
        let leaked_suffixes: Vec<&'static str> = suffix_set.into_iter().map(leak_str).collect();
        let yahoo_suffixes: &'static [&'static str] = Box::leak(leaked_suffixes.into_boxed_slice());

        // currency_priority_slices: leak for 'static
        let mut currency_priority_slices = HashMap::new();
        for (currency, mics) in &catalog.currency_priority {
            let leaked_mics: Vec<&'static str> = mics.iter().map(|s| leak_str(s.clone())).collect();
            let slice: &'static [&'static str] = Box::leak(leaked_mics.into_boxed_slice());
            currency_priority_slices.insert(leak_str(currency.clone()), slice);
        }

        ExchangeRegistry {
            catalog,
            name_by_mic,
            currency_by_mic,
            timezone_by_mic,
            close_by_mic,
            currency_priority_slices,
            yahoo_code_to_mic,
            yahoo_suffix_to_mic: suffix_to_mic,
            yahoo_suffixes,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The catalog's key is a MIC, and everything downstream - the database
    /// column, the generated `instrument_key`, what a broker reports, what a
    /// provider search returns - assumes it. Anything else has to be reconciled
    /// by hand, so a new one must be a deliberate act rather than a typo.
    #[test]
    fn registry_keys_are_iso_10383_mics() {
        for entry in &REGISTRY.catalog.exchanges {
            if NON_ISO_MIC_KEYS.iter().any(|(mic, _)| *mic == entry.mic) {
                continue;
            }

            assert!(
                is_iso_10383_shaped(&entry.mic),
                "registry key '{}' is not shaped like an ISO 10383 MIC. Use the \
                 venue's real MIC, and add a migration for the old spelling; if \
                 there genuinely is not one, add it to NON_ISO_MIC_KEYS with the \
                 reason.",
                entry.mic
            );
        }
    }

    /// A stale exception is worse than none: it reads as a live constraint while
    /// excusing a key that no longer exists. Fail when one is left behind so the
    /// list is pruned with the entry it covers.
    #[test]
    fn non_iso_mic_exceptions_all_still_exist() {
        for (mic, _reason) in NON_ISO_MIC_KEYS {
            assert!(
                REGISTRY.catalog.exchanges.iter().any(|e| e.mic == *mic),
                "NON_ISO_MIC_KEYS names '{}', which is no longer in the catalog - \
                 remove the exception",
                mic
            );
        }
    }

    /// Pin the three this change re-spelled, so a revert is loud.
    #[test]
    fn cboe_europe_and_taipei_use_their_iso_mics() {
        let mics: Vec<&str> = REGISTRY
            .catalog
            .exchanges
            .iter()
            .map(|e| e.mic.as_str())
            .collect();

        for mic in ["BCXE", "CCXE", "ROCO"] {
            assert!(mics.contains(&mic), "expected the catalog to key on {mic}");
        }
        for mic in ["CXE", "DXE", "XTAI_OTC"] {
            assert!(
                !mics.contains(&mic),
                "{mic} is not an ISO 10383 MIC and should no longer be a key"
            );
        }
    }

    #[test]
    fn iso_mic_shape_accepts_digits_and_rejects_local_spellings() {
        assert!(is_iso_10383_shaped("XLON"));
        assert!(is_iso_10383_shaped("A24X"));
        assert!(!is_iso_10383_shaped("CXE"));
        assert!(!is_iso_10383_shaped("XTAI_OTC"));
        assert!(!is_iso_10383_shaped("xlon"));
    }
}
