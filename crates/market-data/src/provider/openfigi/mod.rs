//! OpenFIGI provider for bond search and name enrichment.
//!
//! Uses the free OpenFIGI API:
//! - `/v3/search` — free-text search (e.g. "JPMORGAN", "US Treasury")
//! - `/v3/mapping` — exact identifier lookup (ISIN, FIGI)
//! - Profile lookup via mapping for bond name enrichment
//!
//! No pricing support.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use reqwest::Client;
use serde::Deserialize;
use std::time::Duration;

use crate::errors::MarketDataError;
use crate::models::{
    AssetProfile, Coverage, InstrumentKind, ProviderInstrument, Quote, QuoteContext, SearchResult,
};
use crate::provider::{MarketDataProvider, ProviderCapabilities, RateLimit};

const PROVIDER_ID: &str = "OPENFIGI";
const MAPPING_URL: &str = "https://api.openfigi.com/v3/mapping";
const SEARCH_URL: &str = "https://api.openfigi.com/v3/search";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Bond-related market sectors in OpenFIGI responses.
const BOND_MARKET_SECTORS: &[&str] = &["Corp", "Govt", "Mtge", "Muni", "Pfd"];

// ---------------------------------------------------------------------------
// Response models
// ---------------------------------------------------------------------------

/// A single instrument record returned by the mapping API.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct FigiRecord {
    name: Option<String>,
    ticker: Option<String>,
    exch_code: Option<String>,
    security_type: Option<String>,
    market_sector: Option<String>,
}

/// Wrapper for `/v3/mapping` responses (one per request item).
#[derive(Debug, Deserialize)]
struct MappingResult {
    data: Option<Vec<FigiRecord>>,
}

/// Response from `/v3/search`.
#[derive(Debug, Deserialize)]
struct SearchResponse {
    data: Option<Vec<FigiRecord>>,
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

pub struct OpenFigiProvider {
    client: Client,
}

impl Default for OpenFigiProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl OpenFigiProvider {
    pub fn new() -> Self {
        let client = Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .unwrap_or_else(|_| Client::new());
        Self { client }
    }

    // -- /v3/mapping helpers ------------------------------------------------

    /// Call the v3/mapping API with a given idType/idValue pair.
    async fn fetch_mapping(
        &self,
        id_type: &str,
        id_value: &str,
    ) -> Result<Vec<FigiRecord>, MarketDataError> {
        let body = serde_json::json!([{"idType": id_type, "idValue": id_value}]);

        let resp = self
            .client
            .post(MAPPING_URL)
            .json(&body)
            .send()
            .await
            .map_err(|e| MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: format!("HTTP request failed: {}", e),
            })?;

        let status = resp.status();
        if !status.is_success() {
            return Err(MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: format!("HTTP {}", status),
            });
        }

        let results: Vec<MappingResult> =
            resp.json()
                .await
                .map_err(|e| MarketDataError::ProviderError {
                    provider: PROVIDER_ID.to_string(),
                    message: format!("JSON parse error: {}", e),
                })?;

        let data = results
            .into_iter()
            .next()
            .and_then(|r| r.data)
            .unwrap_or_default();

        Ok(data)
    }

    async fn fetch_name(&self, isin: &str) -> Result<String, MarketDataError> {
        let data_vec = self.fetch_mapping("ID_ISIN", isin).await?;

        let data = data_vec
            .into_iter()
            .next()
            .ok_or_else(|| MarketDataError::SymbolNotFound(isin.to_string()))?;

        let name =
            data.name
                .filter(|n| !n.is_empty())
                .ok_or_else(|| MarketDataError::ProviderError {
                    provider: PROVIDER_ID.to_string(),
                    message: format!("No name found for {}", isin),
                })?;

        match data.ticker.filter(|t| !t.is_empty()) {
            Some(ticker) => Ok(format!("{} - {}", name, ticker)),
            None => Ok(name),
        }
    }

    // -- /v3/search helpers -------------------------------------------------

    /// Call the v3/search API with a free-text query.
    async fn fetch_search(&self, query: &str) -> Result<Vec<FigiRecord>, MarketDataError> {
        let body = serde_json::json!({"query": query});

        let resp = self
            .client
            .post(SEARCH_URL)
            .json(&body)
            .send()
            .await
            .map_err(|e| MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: format!("HTTP request failed: {}", e),
            })?;

        let status = resp.status();
        if !status.is_success() {
            return Err(MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: format!("HTTP {}", status),
            });
        }

        let result: SearchResponse =
            resp.json()
                .await
                .map_err(|e| MarketDataError::ProviderError {
                    provider: PROVIDER_ID.to_string(),
                    message: format!("JSON parse error: {}", e),
                })?;

        Ok(result.data.unwrap_or_default())
    }

    // -- shared helpers -----------------------------------------------------

    /// Detect identifier types from query string.
    /// Returns idType values to try (in order) for the mapping API, or None if free-text.
    /// BBG codes are tried as both COMPOSITE_FIGI and ID_BB_GLOBAL since users
    /// may have either form.
    fn detect_id_types(query: &str) -> Option<Vec<&'static str>> {
        let q = query.trim();
        // FIGI: 12 chars starting with BBG — try composite first, then individual
        if q.len() == 12 && q.starts_with("BBG") && q.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Some(vec!["COMPOSITE_FIGI", "ID_BB_GLOBAL"]);
        }
        // ISIN: 2 letter country code + 10 alphanumeric
        if q.len() == 12
            && q[..2].chars().all(|c| c.is_ascii_alphabetic())
            && q[2..].chars().all(|c| c.is_ascii_alphanumeric())
        {
            return Some(vec!["ID_ISIN"]);
        }
        // CUSIP: 9 alphanumeric characters (digits + uppercase letters)
        if q.len() == 9 && q.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Some(vec!["ID_CUSIP"]);
        }
        None
    }

    /// Check if a record looks like a bond based on its marketSector.
    fn is_bond_sector(record: &FigiRecord) -> bool {
        record
            .market_sector
            .as_deref()
            .is_some_and(|s| BOND_MARKET_SECTORS.contains(&s))
    }

    /// Convert FigiRecords to SearchResults, using `symbol` as the display symbol.
    fn records_to_search_results(records: Vec<FigiRecord>, symbol: &str) -> Vec<SearchResult> {
        let mut seen = std::collections::HashSet::new();
        records
            .into_iter()
            .filter_map(|d| {
                let name = d.name.filter(|n| !n.is_empty())?;
                let display_name = match d.ticker.filter(|t| !t.is_empty()) {
                    Some(ticker) => format!("{} - {}", name, ticker),
                    None => name,
                };
                let exchange = d.exch_code.clone().unwrap_or_default();
                // Deduplicate by (name, exchange)
                if !seen.insert((display_name.clone(), exchange.clone())) {
                    return None;
                }
                Some(
                    SearchResult::new(symbol, &display_name, &exchange, "BOND")
                        .with_data_source(PROVIDER_ID),
                )
            })
            .collect()
    }
}

#[async_trait]
impl MarketDataProvider for OpenFigiProvider {
    fn id(&self) -> &'static str {
        PROVIDER_ID
    }

    fn priority(&self) -> u8 {
        5
    }

    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            instrument_kinds: &[InstrumentKind::Bond],
            coverage: Coverage::global_best_effort(),
            supports_latest: false,
            supports_historical: false,
            supports_search: true,
            supports_profile: true,
            supports_dividends: false,
        }
    }

    fn rate_limit(&self) -> RateLimit {
        RateLimit {
            requests_per_minute: 25,
            max_concurrency: 1,
            min_delay: Duration::from_secs(3),
        }
    }

    async fn get_latest_quote(
        &self,
        _context: &QuoteContext,
        _instrument: ProviderInstrument,
    ) -> Result<Quote, MarketDataError> {
        Err(MarketDataError::NotSupported {
            operation: "get_latest_quote".to_string(),
            provider: PROVIDER_ID.to_string(),
        })
    }

    async fn get_historical_quotes(
        &self,
        _context: &QuoteContext,
        _instrument: ProviderInstrument,
        _start: DateTime<Utc>,
        _end: DateTime<Utc>,
    ) -> Result<Vec<Quote>, MarketDataError> {
        Err(MarketDataError::NotSupported {
            operation: "get_historical_quotes".to_string(),
            provider: PROVIDER_ID.to_string(),
        })
    }

    async fn search(&self, query: &str) -> Result<Vec<SearchResult>, MarketDataError> {
        let trimmed = query.trim();
        let symbol = trimmed.to_uppercase();

        // Exact identifier lookup (ISIN / FIGI) → mapping API
        if let Some(id_types) = Self::detect_id_types(trimmed) {
            for id_type in &id_types {
                if let Ok(records) = self.fetch_mapping(id_type, trimmed).await {
                    if !records.is_empty() {
                        return Ok(Self::records_to_search_results(records, &symbol));
                    }
                }
            }
            // Mapping failed or returned nothing — fall through to free-text search
        }

        // Free-text search API, filtered to bond sectors
        let records = self.fetch_search(trimmed).await?;
        let bond_records: Vec<_> = records.into_iter().filter(Self::is_bond_sector).collect();
        if bond_records.is_empty() {
            return Ok(Vec::new());
        }
        Ok(Self::records_to_search_results(bond_records, &symbol))
    }

    async fn get_profile(&self, symbol: &str) -> Result<AssetProfile, MarketDataError> {
        let name = self.fetch_name(symbol).await?;
        Ok(AssetProfile::with_name(name))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_provider_id() {
        let provider = OpenFigiProvider::new();
        assert_eq!(provider.id(), "OPENFIGI");
    }

    #[test]
    fn test_provider_priority() {
        let provider = OpenFigiProvider::new();
        assert_eq!(provider.priority(), 5);
    }

    #[test]
    fn test_capabilities() {
        let provider = OpenFigiProvider::new();
        let caps = provider.capabilities();
        assert_eq!(caps.instrument_kinds, &[InstrumentKind::Bond]);
        assert!(!caps.supports_latest);
        assert!(!caps.supports_historical);
        assert!(caps.supports_search);
        assert!(caps.supports_profile);
    }

    #[test]
    fn test_rate_limit() {
        let provider = OpenFigiProvider::new();
        let rl = provider.rate_limit();
        assert_eq!(rl.requests_per_minute, 25);
        assert_eq!(rl.max_concurrency, 1);
        assert_eq!(rl.min_delay, Duration::from_secs(3));
    }

    #[test]
    fn test_detect_isin() {
        assert_eq!(
            OpenFigiProvider::detect_id_types("US912828YB43"),
            Some(vec!["ID_ISIN"])
        );
        assert_eq!(
            OpenFigiProvider::detect_id_types("XS1234567890"),
            Some(vec!["ID_ISIN"])
        );
    }

    #[test]
    fn test_detect_figi() {
        // BBG codes should try composite first, then individual
        assert_eq!(
            OpenFigiProvider::detect_id_types("BBG00GBVBK04"),
            Some(vec!["COMPOSITE_FIGI", "ID_BB_GLOBAL"])
        );
    }

    #[test]
    fn test_detect_unknown() {
        assert_eq!(OpenFigiProvider::detect_id_types("AAPL"), None);
        assert_eq!(OpenFigiProvider::detect_id_types("short"), None);
        assert_eq!(OpenFigiProvider::detect_id_types(""), None);
    }

    #[test]
    fn test_is_bond_sector() {
        let corp = FigiRecord {
            name: Some("Test".into()),
            ticker: None,
            exch_code: None,
            security_type: None,
            market_sector: Some("Corp".into()),
        };
        assert!(OpenFigiProvider::is_bond_sector(&corp));

        let govt = FigiRecord {
            market_sector: Some("Govt".into()),
            ..corp.clone()
        };
        assert!(OpenFigiProvider::is_bond_sector(&govt));

        let equity = FigiRecord {
            market_sector: Some("Equity".into()),
            ..corp.clone()
        };
        assert!(!OpenFigiProvider::is_bond_sector(&equity));

        let none = FigiRecord {
            market_sector: None,
            ..corp
        };
        assert!(!OpenFigiProvider::is_bond_sector(&none));
    }

    #[test]
    fn test_records_to_search_results() {
        let records = vec![
            FigiRecord {
                name: Some("JPMORGAN CHASE & CO".into()),
                ticker: Some("JPM 2.069 06/01/29".into()),
                exch_code: Some("US".into()),
                security_type: Some("Corp".into()),
                market_sector: Some("Corp".into()),
            },
            // Duplicate name+exchange should be deduplicated
            FigiRecord {
                name: Some("JPMORGAN CHASE & CO".into()),
                ticker: Some("JPM 2.069 06/01/29".into()),
                exch_code: Some("US".into()),
                security_type: Some("Corp".into()),
                market_sector: Some("Corp".into()),
            },
        ];
        let results = OpenFigiProvider::records_to_search_results(records, "US912828YB43");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].symbol, "US912828YB43");
        assert_eq!(results[0].name, "JPMORGAN CHASE & CO - JPM 2.069 06/01/29");
        assert_eq!(results[0].exchange, "US");
        assert_eq!(results[0].asset_type, "BOND");
    }

    #[test]
    fn test_parse_mapping_response() {
        let json = r#"[{"data":[{"figi":"BBG00GBVBK04","name":"JPMORGAN CHASE & CO","ticker":"JPM V2.069 06/01/29","exchCode":"US","securityType":"Corp","marketSector":"Corp"}]}]"#;
        let results: Vec<MappingResult> = serde_json::from_str(json).unwrap();
        assert_eq!(results.len(), 1);
        let data = results[0].data.as_ref().unwrap();
        assert_eq!(data[0].name.as_deref(), Some("JPMORGAN CHASE & CO"));
        assert_eq!(data[0].ticker.as_deref(), Some("JPM V2.069 06/01/29"));
        assert_eq!(data[0].exch_code.as_deref(), Some("US"));
    }

    #[test]
    fn test_parse_mapping_empty_response() {
        let json = r#"[{"warning":"No identifier found."}]"#;
        let results: Vec<MappingResult> = serde_json::from_str(json).unwrap();
        assert!(results[0].data.is_none());
    }

    #[test]
    fn test_parse_search_response() {
        let json = r#"{"data":[{"figi":"BBG000B9XRY4","name":"APPLE INC","ticker":"AAPL","exchCode":"US","securityType":"Common Stock","marketSector":"Equity"}]}"#;
        let result: SearchResponse = serde_json::from_str(json).unwrap();
        let data = result.data.unwrap();
        assert_eq!(data.len(), 1);
        assert_eq!(data[0].name.as_deref(), Some("APPLE INC"));
        assert_eq!(data[0].market_sector.as_deref(), Some("Equity"));
    }
}
