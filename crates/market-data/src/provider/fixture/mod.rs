//! Synthetic market data provider for deterministic e2e tests.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, Datelike, Days, NaiveDate, TimeZone, Utc, Weekday};
use log::debug;
use rust_decimal::Decimal;
use serde::Deserialize;

use crate::errors::MarketDataError;
use crate::models::{
    AssetProfile, Coverage, InstrumentKind, ProviderInstrument, Quote, QuoteContext, SearchResult,
    SplitEvent,
};
use crate::provider::{MarketDataProvider, ProviderCapabilities, RateLimit};

const DEFAULT_AS_OF: &str = "2026-05-12";

/// Market data provider backed by small synthetic fixture metadata.
///
/// In e2e mode this reports itself as the provider it replaces so provider
/// settings, provider overrides, and quote source behavior remain identical to
/// production.
pub struct FixtureProvider {
    fixture_dir: PathBuf,
    provider_id: &'static str,
    catalog: OnceLock<Result<FixtureCatalog, String>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureCatalog {
    #[serde(default)]
    default_as_of: Option<NaiveDate>,
    instruments: Vec<FixtureInstrument>,
    #[serde(default)]
    splits: Vec<FixtureSplit>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureInstrument {
    symbol: String,
    #[serde(default)]
    aliases: Vec<String>,
    name: String,
    provider: String,
    asset_type: String,
    currency: String,
    #[serde(default)]
    exchange: Option<String>,
    #[serde(default)]
    exchange_mic: Option<String>,
    #[serde(default)]
    exchange_name: Option<String>,
    base_price: f64,
    #[serde(default = "default_volume")]
    base_volume: u64,
    seed: u64,
    #[serde(default)]
    sector: Option<String>,
    #[serde(default)]
    industry: Option<String>,
    #[serde(default)]
    website: Option<String>,
    #[serde(default)]
    country: Option<String>,
    #[serde(default)]
    asset_allocation: Vec<FixtureWeight>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureSplit {
    symbol: String,
    date: NaiveDate,
    ratio: Decimal,
}

#[derive(Clone, Debug, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FixtureWeight {
    name: String,
    weight: f64,
}

impl FixtureProvider {
    pub fn new(fixture_dir: impl Into<PathBuf>) -> Self {
        Self::new_for_provider(fixture_dir, "YAHOO")
    }

    pub fn new_for_provider(fixture_dir: impl Into<PathBuf>, provider_id: &'static str) -> Self {
        Self {
            fixture_dir: fixture_dir.into(),
            provider_id,
            catalog: OnceLock::new(),
        }
    }

    fn load_catalog(&self) -> Result<&FixtureCatalog, MarketDataError> {
        let path = self.fixture_dir.join("instruments.json");
        match self.catalog.get_or_init(|| read_catalog_file(&path)) {
            Ok(catalog) => Ok(catalog),
            Err(message) => Err(MarketDataError::ProviderError {
                provider: self.provider_id.to_string(),
                message: message.clone(),
            }),
        }
    }

    fn as_of_date(&self, catalog: &FixtureCatalog) -> Result<NaiveDate, MarketDataError> {
        match std::env::var("WEALTHFOLIO_FIXTURE_AS_OF") {
            Ok(value) if value.eq_ignore_ascii_case("today") => Ok(Utc::now().date_naive()),
            Ok(value) if !value.trim().is_empty() => {
                NaiveDate::parse_from_str(value.trim(), "%Y-%m-%d").map_err(|error| {
                    MarketDataError::ProviderError {
                        provider: self.provider_id.to_string(),
                        message: format!("Invalid WEALTHFOLIO_FIXTURE_AS_OF: {error}"),
                    }
                })
            }
            _ => Ok(catalog.default_as_of.unwrap_or_else(default_as_of_date)),
        }
    }

    fn find_instrument(&self, symbol: &str) -> Result<FixtureInstrument, MarketDataError> {
        let catalog = self.load_catalog()?;
        self.find_instrument_from_catalog(catalog, symbol)
    }

    fn find_instrument_from_catalog(
        &self,
        catalog: &FixtureCatalog,
        symbol: &str,
    ) -> Result<FixtureInstrument, MarketDataError> {
        catalog
            .instruments
            .iter()
            .find(|instrument| {
                instrument.provider == self.provider_id && instrument.matches_symbol(symbol)
            })
            .cloned()
            .or_else(|| self.synthetic_fx_instrument(symbol))
            .ok_or_else(|| MarketDataError::SymbolNotFound(symbol.to_string()))
    }

    fn synthetic_fx_instrument(&self, symbol: &str) -> Option<FixtureInstrument> {
        if self.provider_id != "YAHOO" {
            return None;
        }

        let (base, quote) = parse_fx_pair_symbol(symbol)?;
        Some(FixtureInstrument {
            symbol: format!("{base}{quote}=X"),
            aliases: vec![format!("{base}/{quote}"), format!("{base}{quote}")],
            name: format!("{base}/{quote}"),
            provider: self.provider_id.to_string(),
            asset_type: "FX".to_string(),
            currency: quote.clone(),
            exchange: None,
            exchange_mic: None,
            exchange_name: None,
            base_price: fx_base_price(&base, &quote),
            base_volume: 0,
            seed: fx_seed(&base, &quote),
            sector: None,
            industry: None,
            website: None,
            country: None,
            asset_allocation: Vec::new(),
        })
    }

    fn quote_for_date(&self, instrument: &FixtureInstrument, date: NaiveDate) -> Quote {
        let day_index = date
            .signed_duration_since(NaiveDate::from_ymd_opt(2019, 1, 1).unwrap())
            .num_days();
        let seed = instrument.seed.wrapping_add(day_index.max(0) as u64);
        let drift = day_index as f64 * 0.00012;
        let wave = (day_index as f64 / 19.0).sin() * 0.045;
        let noise = deterministic_unit(seed) * 0.018;
        let close = positive_price(instrument.base_price * (1.0 + drift + wave + noise));
        let open_noise = deterministic_unit(seed.wrapping_add(11)) * 0.006;
        let open = positive_price(close * (1.0 + open_noise));
        let spread = 0.006 + deterministic_unit(seed.wrapping_add(29)).abs() * 0.012;
        let high = open.max(close) * (1.0 + spread);
        let low = open.min(close) * (1.0 - spread);
        let volume = if instrument.asset_type == "FX" {
            None
        } else {
            Some(Decimal::from(
                instrument.base_volume + (seed.wrapping_mul(7919) % 1_000_000),
            ))
        };

        Quote {
            timestamp: quote_timestamp(date, &instrument.asset_type),
            open: Some(decimal(open)),
            high: Some(decimal(high)),
            low: Some(decimal(low)),
            close: decimal(close),
            volume,
            currency: instrument.currency.clone(),
            source: instrument.provider.clone(),
        }
    }

    fn generated_history(
        &self,
        instrument: &FixtureInstrument,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Vec<Quote> {
        let mut date = start.date_naive();
        let end_date = end.date_naive();
        let mut quotes = Vec::new();

        while date <= end_date {
            if should_emit_quote(instrument, date) {
                let quote = self.quote_for_date(instrument, date);
                if quote.timestamp >= start && quote.timestamp <= end {
                    quotes.push(quote);
                }
            }
            let Some(next) = date.checked_add_days(Days::new(1)) else {
                break;
            };
            date = next;
        }

        quotes
    }
}

impl FixtureInstrument {
    fn matches_symbol(&self, symbol: &str) -> bool {
        self.matches_symbol_value(symbol)
            || symbol
                .rsplit_once(':')
                .is_some_and(|(_, bare_symbol)| self.matches_symbol_value(bare_symbol))
    }

    fn matches_symbol_value(&self, symbol: &str) -> bool {
        self.symbol.eq_ignore_ascii_case(symbol)
            || normalized_key(&self.symbol) == normalized_key(symbol)
            || self.aliases.iter().any(|alias| {
                alias.eq_ignore_ascii_case(symbol)
                    || normalized_key(alias) == normalized_key(symbol)
            })
    }

    fn search_score(&self, query: &str) -> Option<f64> {
        let normalized_query = normalized_key(query);
        if normalized_query.is_empty() {
            return None;
        }

        let query = query.trim().to_lowercase();
        let mut best = score_search_candidate(&self.symbol, &query, &normalized_query);

        for alias in &self.aliases {
            best = max_score(
                best,
                score_search_candidate(alias, &query, &normalized_query),
            );
        }

        best = max_score(
            best,
            score_search_candidate(&self.name, &query, &normalized_query),
        );

        if let Some(exchange_name) = &self.exchange_name {
            best = max_score(
                best,
                score_search_candidate(exchange_name, &query, &normalized_query),
            );
        }

        best
    }

    fn search_result(&self, score: f64) -> SearchResult {
        let mut result = SearchResult::new(
            self.symbol.clone(),
            self.name.clone(),
            self.exchange.clone().unwrap_or_default(),
            self.asset_type.clone(),
        )
        .with_currency(self.currency.clone())
        .with_score(score)
        .with_data_source(self.provider.clone());

        if let Some(exchange_mic) = &self.exchange_mic {
            result = result.with_exchange_mic(exchange_mic.clone());
        }
        if let Some(exchange_name) = &self.exchange_name {
            result = result.with_exchange_name(exchange_name.clone());
        }

        result
    }

    fn profile(&self) -> AssetProfile {
        AssetProfile {
            source: Some(self.provider.clone()),
            name: Some(self.name.clone()),
            quote_type: Some(self.asset_type.clone()),
            sector: self.sector.clone(),
            sectors: self
                .sector
                .as_ref()
                .map(|sector| format!("[{{\"name\":\"{}\",\"weight\":1}}]", sector)),
            asset_allocation: (!self.asset_allocation.is_empty())
                .then(|| serde_json::to_string(&self.asset_allocation).ok())
                .flatten(),
            industry: self.industry.clone(),
            website: self.website.clone(),
            country: self.country.clone(),
            description: Some(format!("Synthetic e2e profile for {}", self.name)),
            ..Default::default()
        }
    }
}

fn read_catalog_file(path: &Path) -> Result<FixtureCatalog, String> {
    let contents = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read fixture {}: {}", path.display(), error))?;

    serde_json::from_str(&contents)
        .map_err(|error| format!("Failed to parse fixture {}: {}", path.display(), error))
}

fn instrument_symbol(instrument: &ProviderInstrument) -> String {
    instrument.to_symbol_string()
}

fn default_as_of_date() -> NaiveDate {
    NaiveDate::parse_from_str(DEFAULT_AS_OF, "%Y-%m-%d").unwrap()
}

fn default_volume() -> u64 {
    1_000_000
}

fn normalized_key(value: &str) -> String {
    let lower = value.trim().to_lowercase();
    let without_prefix = lower.strip_prefix("fx:").unwrap_or(&lower);
    let without_suffix = without_prefix.strip_suffix("=x").unwrap_or(without_prefix);
    without_suffix
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect()
}

fn score_search_candidate(candidate: &str, query: &str, normalized_query: &str) -> Option<f64> {
    let candidate_lower = candidate.trim().to_lowercase();
    let normalized_candidate = normalized_key(candidate);

    if candidate_lower == query || normalized_candidate == normalized_query {
        return Some(100.0);
    }

    if candidate_lower.starts_with(query) || normalized_candidate.starts_with(normalized_query) {
        return Some(90.0);
    }

    if candidate_lower.contains(query) || normalized_candidate.contains(normalized_query) {
        return Some(75.0);
    }

    if normalized_query.len() >= 3
        && edit_distance_at_most_one(&normalized_candidate, normalized_query)
    {
        return Some(60.0);
    }

    None
}

fn max_score(left: Option<f64>, right: Option<f64>) -> Option<f64> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.max(right)),
        (Some(score), None) | (None, Some(score)) => Some(score),
        (None, None) => None,
    }
}

fn edit_distance_at_most_one(left: &str, right: &str) -> bool {
    let left_chars: Vec<char> = left.chars().collect();
    let right_chars: Vec<char> = right.chars().collect();
    let left_len = left_chars.len();
    let right_len = right_chars.len();

    if left_len.abs_diff(right_len) > 1 {
        return false;
    }

    let mut i = 0;
    let mut j = 0;
    let mut edits = 0;

    while i < left_len && j < right_len {
        if left_chars[i] == right_chars[j] {
            i += 1;
            j += 1;
            continue;
        }

        edits += 1;
        if edits > 1 {
            return false;
        }

        match left_len.cmp(&right_len) {
            std::cmp::Ordering::Greater => i += 1,
            std::cmp::Ordering::Less => j += 1,
            std::cmp::Ordering::Equal => {
                i += 1;
                j += 1;
            }
        }
    }

    edits + usize::from(i < left_len || j < right_len) <= 1
}

fn parse_fx_pair_symbol(symbol: &str) -> Option<(String, String)> {
    let upper = symbol.trim().to_uppercase();
    let has_fx_marker = upper.starts_with("FX:") || upper.ends_with("=X") || upper.contains('/');
    if !has_fx_marker {
        return None;
    }

    let without_prefix = upper.strip_prefix("FX:").unwrap_or(&upper);
    let without_suffix = without_prefix.strip_suffix("=X").unwrap_or(without_prefix);
    let compact = without_suffix
        .chars()
        .filter(|c| c.is_ascii_alphabetic())
        .collect::<String>();

    if compact.len() != 6 {
        return None;
    }

    Some((compact[..3].to_string(), compact[3..].to_string()))
}

fn fx_base_price(base: &str, quote: &str) -> f64 {
    fx_usd_value(base) / fx_usd_value(quote)
}

fn fx_usd_value(currency: &str) -> f64 {
    match currency {
        "CAD" => 0.74,
        "EUR" => 1.09,
        "GBP" => 1.27,
        "CHF" => 1.11,
        "JPY" => 0.0065,
        "AUD" => 0.66,
        "NZD" => 0.61,
        "USD" => 1.0,
        _ => 1.0,
    }
}

fn fx_seed(base: &str, quote: &str) -> u64 {
    format!("{base}{quote}")
        .bytes()
        .fold(20_000_u64, |seed, byte| {
            seed.wrapping_mul(131).wrapping_add(byte as u64)
        })
}

fn should_emit_quote(instrument: &FixtureInstrument, date: NaiveDate) -> bool {
    matches!(instrument.asset_type.as_str(), "CRYPTOCURRENCY" | "FX")
        || !matches!(date.weekday(), Weekday::Sat | Weekday::Sun)
}

fn latest_trading_date(instrument: &FixtureInstrument, as_of: NaiveDate) -> NaiveDate {
    let mut date = as_of;
    while !should_emit_quote(instrument, date) {
        date = date.pred_opt().unwrap_or(date);
    }
    date
}

fn quote_timestamp(date: NaiveDate, asset_type: &str) -> DateTime<Utc> {
    let (hour, minute) = if asset_type == "FX" { (0, 0) } else { (13, 30) };
    Utc.with_ymd_and_hms(date.year(), date.month(), date.day(), hour, minute, 0)
        .unwrap()
}

fn deterministic_unit(seed: u64) -> f64 {
    let mut value = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15);
    value ^= value >> 33;
    value = value.wrapping_mul(0xC2B2_AE3D_27D4_EB4F);
    value ^= value >> 29;
    (value as f64 / u64::MAX as f64) * 2.0 - 1.0
}

fn positive_price(value: f64) -> f64 {
    value.max(0.01)
}

fn decimal(value: f64) -> Decimal {
    let rounded = format!("{value:.4}");
    rounded.parse().unwrap_or(Decimal::ZERO)
}

#[async_trait]
impl MarketDataProvider for FixtureProvider {
    fn id(&self) -> &'static str {
        self.provider_id
    }

    fn priority(&self) -> u8 {
        1
    }

    fn capabilities(&self) -> ProviderCapabilities {
        if self.provider_id == "BOERSE_FRANKFURT" {
            return ProviderCapabilities {
                instrument_kinds: &[InstrumentKind::Equity, InstrumentKind::Bond],
                coverage: Coverage::dach_exchanges(),
                supports_latest: true,
                supports_historical: true,
                supports_search: false,
                supports_profile: true,
                supports_dividends: false,
            };
        }

        ProviderCapabilities {
            instrument_kinds: &[
                InstrumentKind::Equity,
                InstrumentKind::Crypto,
                InstrumentKind::Fx,
                InstrumentKind::Option,
                InstrumentKind::Metal,
            ],
            coverage: Coverage::global_best_effort(),
            supports_latest: true,
            supports_historical: true,
            supports_search: true,
            supports_profile: true,
            supports_dividends: false,
        }
    }

    fn rate_limit(&self) -> RateLimit {
        RateLimit {
            requests_per_minute: 60_000,
            max_concurrency: 100,
            min_delay: Duration::from_millis(0),
        }
    }

    async fn get_latest_quote(
        &self,
        _context: &QuoteContext,
        instrument: ProviderInstrument,
    ) -> Result<Quote, MarketDataError> {
        let symbol = instrument_symbol(&instrument);
        debug!("Generating latest quote fixture for {}", symbol);
        let catalog = self.load_catalog()?;
        let as_of = self.as_of_date(catalog)?;
        let instrument = self.find_instrument_from_catalog(catalog, &symbol)?;
        Ok(self.quote_for_date(&instrument, latest_trading_date(&instrument, as_of)))
    }

    async fn get_historical_quotes(
        &self,
        _context: &QuoteContext,
        instrument: ProviderInstrument,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<Vec<Quote>, MarketDataError> {
        let symbol = instrument_symbol(&instrument);
        debug!(
            "Generating historical quote fixture for {} from {} to {}",
            symbol,
            start.format("%Y-%m-%d"),
            end.format("%Y-%m-%d")
        );

        let instrument = self.find_instrument(&symbol)?;
        let quotes = self.generated_history(&instrument, start, end);

        if quotes.is_empty() {
            return Err(MarketDataError::NoDataForRange);
        }

        Ok(quotes)
    }

    async fn search(&self, query: &str) -> Result<Vec<SearchResult>, MarketDataError> {
        if !self.capabilities().supports_search {
            return Ok(Vec::new());
        }

        let normalized = query.trim().to_lowercase();
        if normalized.is_empty() {
            return Ok(Vec::new());
        }

        let mut results: Vec<SearchResult> = self
            .load_catalog()?
            .instruments
            .iter()
            .filter_map(|instrument| {
                if instrument.provider != self.provider_id || instrument.asset_type == "FX" {
                    return None;
                }

                instrument
                    .search_score(&normalized)
                    .map(|score| instrument.search_result(score))
            })
            .collect();

        results.sort_by(|a, b| {
            let a_exact = a.symbol.eq_ignore_ascii_case(&normalized);
            let b_exact = b.symbol.eq_ignore_ascii_case(&normalized);
            b_exact.cmp(&a_exact).then_with(|| {
                b.score
                    .partial_cmp(&a.score)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
        });
        results.truncate(25);
        Ok(results)
    }

    async fn get_profile(&self, symbol: &str) -> Result<AssetProfile, MarketDataError> {
        let instrument = self.find_instrument(symbol)?;
        Ok(instrument.profile())
    }

    async fn get_splits(
        &self,
        _context: &QuoteContext,
        instrument: ProviderInstrument,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<Vec<SplitEvent>, MarketDataError> {
        let symbol = instrument_symbol(&instrument);
        let catalog = self.load_catalog()?;
        let start_date = start.date_naive();
        let end_date = end.date_naive();
        let mut seen = HashSet::new();
        Ok(catalog
            .splits
            .iter()
            .filter(|split| {
                split.date >= start_date
                    && split.date <= end_date
                    && (split.symbol.eq_ignore_ascii_case(&symbol)
                        || normalized_key(&split.symbol) == normalized_key(&symbol))
            })
            .filter(|split| seen.insert(split.date))
            .map(|split| SplitEvent {
                date: split.date,
                ratio: split.ratio,
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use std::borrow::Cow;
    use std::fs::{create_dir_all, remove_dir_all, write};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;
    use std::time::{SystemTime, UNIX_EPOCH};

    use chrono::TimeZone;

    use super::*;
    use crate::models::InstrumentId;

    static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

    fn temp_fixture_dir() -> PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let id = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("wealthfolio-fixture-provider-{timestamp}-{id}"))
    }

    fn write_catalog(dir: &Path) {
        create_dir_all(dir).unwrap();
        write(
            dir.join("instruments.json"),
            r#"{
              "defaultAsOf": "2026-05-12",
              "instruments": [
                {
                  "symbol": "AAPL",
                  "aliases": ["APPL", "APPL_ALIAS"],
                  "name": "Apple Inc.",
                  "provider": "YAHOO",
                  "assetType": "EQUITY",
                  "currency": "USD",
                  "exchange": "NMS",
                  "exchangeMic": "XNAS",
                  "exchangeName": "NASDAQ",
                  "basePrice": 180,
                  "baseVolume": 1000000,
                  "seed": 101,
                  "sector": "Technology",
                  "industry": "Consumer Electronics",
                  "country": "United States"
                },
                {
                  "symbol": "BRK-B",
                  "aliases": ["BRK.B"],
                  "name": "Berkshire Hathaway Inc.",
                  "provider": "YAHOO",
                  "assetType": "EQUITY",
                  "currency": "USD",
                  "exchange": "NYQ",
                  "exchangeMic": "XNYS",
                  "exchangeName": "NYSE",
                  "basePrice": 440,
                  "seed": 102
                },
                {
                  "symbol": "BALTEST",
                  "name": "Balanced Allocation Test ETF",
                  "provider": "YAHOO",
                  "assetType": "ETF",
                  "currency": "USD",
                  "exchange": "PCX",
                  "exchangeMic": "ARCX",
                  "exchangeName": "NYSE Arca",
                  "basePrice": 100,
                  "baseVolume": 100000,
                  "seed": 106,
                  "sector": "Global",
                  "industry": "Exchange Traded Fund",
                  "country": "United States",
                  "assetAllocation": [
                    { "name": "stock", "weight": 0.6 },
                    { "name": "bond", "weight": 0.4 }
                  ]
                },
                {
                  "symbol": "BTC-USD",
                  "aliases": ["BTC"],
                  "name": "Bitcoin USD",
                  "provider": "YAHOO",
                  "assetType": "CRYPTOCURRENCY",
                  "currency": "USD",
                  "basePrice": 95000,
                  "seed": 103
                },
                {
                  "symbol": "USDEUR=X",
                  "aliases": ["USD/EUR"],
                  "name": "USD/EUR",
                  "provider": "YAHOO",
                  "assetType": "FX",
                  "currency": "EUR",
                  "basePrice": 0.92,
                  "seed": 104
                },
                {
                  "symbol": "DE0007164600",
                  "aliases": ["SAP"],
                  "name": "SAP SE",
                  "provider": "BOERSE_FRANKFURT",
                  "assetType": "EQUITY",
                  "currency": "EUR",
                  "exchange": "XETR",
                  "exchangeMic": "XETR",
                  "exchangeName": "XETRA",
                  "basePrice": 145,
                  "seed": 105
                }
              ],
              "splits": [
                { "symbol": "AAPL", "date": "2020-08-31", "ratio": "4" }
              ]
            }"#,
        )
        .unwrap();
    }

    fn quote_context() -> QuoteContext {
        QuoteContext {
            instrument: InstrumentId::Equity {
                ticker: Arc::from("AAPL"),
                mic: Some(Cow::Borrowed("XNAS")),
            },
            identifiers: Default::default(),
            overrides: None,
            currency_hint: Some(Cow::Borrowed("USD")),
            preferred_provider: None,
            bond_metadata: None,
            custom_provider_code: None,
        }
    }

    #[tokio::test]
    async fn generates_history_and_derives_latest_quote() {
        let dir = temp_fixture_dir();
        write_catalog(&dir);

        let provider = FixtureProvider::new(&dir);
        let instrument = ProviderInstrument::EquitySymbol {
            symbol: Arc::from("AAPL"),
        };

        let latest = provider
            .get_latest_quote(&quote_context(), instrument.clone())
            .await
            .unwrap();
        assert_eq!(latest.currency, "USD");
        assert_eq!(latest.source, "YAHOO");
        assert_eq!(
            latest.timestamp.date_naive(),
            NaiveDate::from_ymd_opt(2026, 5, 12).unwrap()
        );

        let history = provider
            .get_historical_quotes(
                &quote_context(),
                instrument,
                Utc.with_ymd_and_hms(2026, 5, 11, 0, 0, 0).unwrap(),
                Utc.with_ymd_and_hms(2026, 5, 12, 23, 59, 59).unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(history.len(), 2);
        assert!(history.iter().all(|quote| quote.currency == "USD"));

        remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn boerse_frankfurt_accepts_mic_prefixed_symbol() {
        let dir = temp_fixture_dir();
        write_catalog(&dir);
        let provider = FixtureProvider::new_for_provider(&dir, "BOERSE_FRANKFURT");
        let context = QuoteContext {
            instrument: InstrumentId::Equity {
                ticker: Arc::from("DE0007164600"),
                mic: Some(Cow::Borrowed("XETR")),
            },
            identifiers: Default::default(),
            overrides: None,
            currency_hint: Some(Cow::Borrowed("EUR")),
            preferred_provider: Some(Cow::Borrowed("BOERSE_FRANKFURT")),
            bond_metadata: None,
            custom_provider_code: None,
        };

        let latest = provider
            .get_latest_quote(
                &context,
                ProviderInstrument::EquitySymbol {
                    symbol: Arc::from("XETR:DE0007164600"),
                },
            )
            .await
            .unwrap();

        assert_eq!(latest.currency, "EUR");
        assert_eq!(latest.source, "BOERSE_FRANKFURT");

        remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn fx_quote_uses_pair_quote_currency() {
        let dir = temp_fixture_dir();
        write_catalog(&dir);
        let provider = FixtureProvider::new(&dir);
        let context = QuoteContext {
            instrument: InstrumentId::Fx {
                base: Cow::Borrowed("USD"),
                quote: Cow::Borrowed("EUR"),
            },
            identifiers: Default::default(),
            overrides: None,
            currency_hint: Some(Cow::Borrowed("EUR")),
            preferred_provider: None,
            bond_metadata: None,
            custom_provider_code: None,
        };

        let latest = provider
            .get_latest_quote(
                &context,
                ProviderInstrument::FxSymbol {
                    symbol: Arc::from("USDEUR=X"),
                },
            )
            .await
            .unwrap();

        assert_eq!(latest.currency, "EUR");
        assert!(latest.volume.is_none());

        remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn fx_quote_accepts_slash_symbol_and_generates_missing_pair() {
        let dir = temp_fixture_dir();
        write_catalog(&dir);
        let provider = FixtureProvider::new(&dir);
        let context = QuoteContext {
            instrument: InstrumentId::Fx {
                base: Cow::Borrowed("USD"),
                quote: Cow::Borrowed("CAD"),
            },
            identifiers: Default::default(),
            overrides: None,
            currency_hint: Some(Cow::Borrowed("CAD")),
            preferred_provider: None,
            bond_metadata: None,
            custom_provider_code: None,
        };

        let slash = provider
            .get_latest_quote(
                &context,
                ProviderInstrument::FxSymbol {
                    symbol: Arc::from("USD/CAD"),
                },
            )
            .await
            .unwrap();
        assert_eq!(slash.currency, "CAD");
        assert_eq!(slash.source, "YAHOO");
        assert!(slash.volume.is_none());

        let reciprocal = provider
            .get_latest_quote(
                &context,
                ProviderInstrument::FxSymbol {
                    symbol: Arc::from("CADUSD=X"),
                },
            )
            .await
            .unwrap();
        assert_eq!(reciprocal.currency, "USD");
        assert!(reciprocal.volume.is_none());

        remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn search_and_profile_use_same_currency_metadata() {
        let dir = temp_fixture_dir();
        write_catalog(&dir);
        let provider = FixtureProvider::new(&dir);

        let apple_results = provider.search("appl").await.unwrap();
        assert_eq!(apple_results[0].symbol, "AAPL");
        assert_eq!(apple_results[0].currency.as_deref(), Some("USD"));

        let results = provider.search("brk.b").await.unwrap();
        assert_eq!(results[0].symbol, "BRK-B");
        assert_eq!(results[0].currency.as_deref(), Some("USD"));
        assert_eq!(results[0].exchange_mic.as_deref(), Some("XNYS"));

        let profile = provider.get_profile("BRK.B").await.unwrap();
        assert_eq!(profile.name.as_deref(), Some("Berkshire Hathaway Inc."));
        assert_eq!(profile.quote_type.as_deref(), Some("EQUITY"));

        remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn profile_includes_asset_allocation_fixture() {
        let dir = temp_fixture_dir();
        write_catalog(&dir);
        let provider = FixtureProvider::new(&dir);

        let profile = provider.get_profile("BALTEST").await.unwrap();

        assert_eq!(profile.quote_type.as_deref(), Some("ETF"));
        assert_eq!(
            profile.asset_allocation.as_deref(),
            Some(r#"[{"name":"stock","weight":0.6},{"name":"bond","weight":0.4}]"#)
        );

        remove_dir_all(dir).unwrap();
    }
}
