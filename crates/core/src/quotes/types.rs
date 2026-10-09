//! Strong types for the quote system.
//!
//! These types enforce clear boundaries and prevent mixing of concepts:
//! - `AssetId` - Our internal database identity
//! - `Day` - UTC date bucket for daily quotes
//! - `ProviderId` - Identifies a market data provider
//! - `QuoteSource` - Manual entry or provider-fetched

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use std::fmt;

// =============================================================================
// AssetId
// =============================================================================

/// Database identity - our internal ID.
///
/// Examples: "AAPL:XNAS", "USD/CAD", "PROP-abc123"
///
/// This is the canonical identifier for an asset within our system.
/// It should NOT contain provider-specific symbols.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
pub struct AssetId(pub String);

impl AssetId {
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for AssetId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl From<String> for AssetId {
    fn from(s: String) -> Self {
        Self(s)
    }
}

impl From<&str> for AssetId {
    fn from(s: &str) -> Self {
        Self(s.to_string())
    }
}

impl AsRef<str> for AssetId {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

// =============================================================================
// ProviderId
// =============================================================================

/// Provider identifier.
///
/// Examples: "YAHOO", "ALPHA_VANTAGE", "MARKETDATA_APP"
///
/// Identifies a market data provider. Used to track where quote data came from.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ProviderId(pub String);

impl ProviderId {
    pub const YAHOO: &'static str = "YAHOO";
    pub const ALPHA_VANTAGE: &'static str = "ALPHA_VANTAGE";
    pub const MARKETDATA_APP: &'static str = "MARKETDATA_APP";
    pub const METAL_PRICE_API: &'static str = "METAL_PRICE_API";
    pub const FINNHUB: &'static str = "FINNHUB";
    pub const US_TREASURY_CALC: &'static str = "US_TREASURY_CALC";
    pub const BOERSE_FRANKFURT: &'static str = "BOERSE_FRANKFURT";
    pub const MOEX: &'static str = "MOEX";
    pub const OPENFIGI: &'static str = "OPENFIGI";
    pub const BROKER: &'static str = "BROKER";
    pub const CUSTOM_SCRAPER: &'static str = "CUSTOM_SCRAPER";

    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }

    pub fn yahoo() -> Self {
        Self(Self::YAHOO.to_string())
    }

    pub fn alpha_vantage() -> Self {
        Self(Self::ALPHA_VANTAGE.to_string())
    }

    pub fn marketdata_app() -> Self {
        Self(Self::MARKETDATA_APP.to_string())
    }

    pub fn metal_price_api() -> Self {
        Self(Self::METAL_PRICE_API.to_string())
    }

    pub fn finnhub() -> Self {
        Self(Self::FINNHUB.to_string())
    }

    pub fn us_treasury_calc() -> Self {
        Self(Self::US_TREASURY_CALC.to_string())
    }

    pub fn boerse_frankfurt() -> Self {
        Self(Self::BOERSE_FRANKFURT.to_string())
    }

    pub fn moex() -> Self {
        Self(Self::MOEX.to_string())
    }

    pub fn openfigi() -> Self {
        Self(Self::OPENFIGI.to_string())
    }

    pub fn broker() -> Self {
        Self(Self::BROKER.to_string())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ProviderId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl From<String> for ProviderId {
    fn from(s: String) -> Self {
        Self(s)
    }
}

impl From<&str> for ProviderId {
    fn from(s: &str) -> Self {
        Self(s.to_string())
    }
}

impl AsRef<str> for ProviderId {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

// =============================================================================
// Day
// =============================================================================

/// UTC date bucket for daily quotes.
///
/// Wraps `NaiveDate` to represent a single trading day.
/// All quotes are normalized to daily granularity using UTC.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, PartialOrd, Ord)]
pub struct Day(pub NaiveDate);

impl Day {
    pub fn new(date: NaiveDate) -> Self {
        Self(date)
    }

    /// Creates a Day from year, month, day components.
    /// Returns None if the date is invalid.
    pub fn from_ymd(year: i32, month: u32, day: u32) -> Option<Self> {
        NaiveDate::from_ymd_opt(year, month, day).map(Self)
    }

    /// Returns the underlying NaiveDate.
    pub fn date(&self) -> NaiveDate {
        self.0
    }

    /// Parses a day from "YYYY-MM-DD" format.
    pub fn parse(s: &str) -> Option<Self> {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").ok().map(Self)
    }

    /// Returns today's date in UTC.
    pub fn today() -> Self {
        Self(chrono::Utc::now().date_naive())
    }
}

impl fmt::Display for Day {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0.format("%Y-%m-%d"))
    }
}

impl From<NaiveDate> for Day {
    fn from(date: NaiveDate) -> Self {
        Self(date)
    }
}

impl From<Day> for NaiveDate {
    fn from(day: Day) -> Self {
        day.0
    }
}

// =============================================================================
// QuoteSource
// =============================================================================

/// Quote data source - either manual entry or from a provider.
///
/// This replaces the old `DataSource` enum with a cleaner design:
/// - `Manual` - User entered the quote manually
/// - `Provider(ProviderId)` - Quote was fetched from a market data provider
///
/// Invariant: Manual quotes are never overwritten by provider sync.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "provider")]
#[derive(Default)]
pub enum QuoteSource {
    #[default]
    Manual,
    Provider(ProviderId),
}

impl QuoteSource {
    pub const MANUAL_STR: &'static str = "MANUAL";

    /// Returns true if this is a manual quote.
    pub fn is_manual(&self) -> bool {
        matches!(self, QuoteSource::Manual)
    }

    /// Returns true if this is from a provider.
    pub fn is_provider(&self) -> bool {
        matches!(self, QuoteSource::Provider(_))
    }

    /// Returns the provider ID if this is a provider source.
    pub fn provider(&self) -> Option<&ProviderId> {
        match self {
            QuoteSource::Provider(id) => Some(id),
            QuoteSource::Manual => None,
        }
    }

    /// Converts to the string representation for storage.
    pub fn to_storage_string(&self) -> String {
        match self {
            QuoteSource::Manual => Self::MANUAL_STR.to_string(),
            QuoteSource::Provider(id) => id.0.clone(),
        }
    }

    /// Parses from the storage string representation.
    pub fn from_storage_string(s: &str) -> Self {
        if s.eq_ignore_ascii_case(Self::MANUAL_STR) {
            QuoteSource::Manual
        } else {
            QuoteSource::Provider(ProviderId::new(s))
        }
    }
}

impl fmt::Display for QuoteSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            QuoteSource::Manual => write!(f, "MANUAL"),
            QuoteSource::Provider(id) => write!(f, "{}", id),
        }
    }
}

// =============================================================================
// Quote ID Construction
// =============================================================================

/// Constructs a deterministic quote ID from its components.
///
/// Format: `{asset_id}_{YYYY-MM-DD}_{source}`
///
/// Examples:
/// - "AAPL:XNAS_2024-01-15_YAHOO"
/// - "PROP-house1_2024-01-15_MANUAL"
pub fn quote_id(asset_id: &AssetId, day: Day, source: &QuoteSource) -> String {
    format!("{}_{}", asset_id.0, day_source_suffix(day, source))
}

/// Constructs the day+source suffix for quote IDs.
///
/// Format: `{YYYY-MM-DD}_{source}`
pub fn day_source_suffix(day: Day, source: &QuoteSource) -> String {
    format!("{}_{}", day, source.to_storage_string())
}

// =============================================================================
// Currency (wrapper for explicit typing)
// =============================================================================

/// Currency code wrapper.
///
/// Provides type safety for currency codes (e.g., "USD", "EUR", "CAD").
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
pub struct Currency(pub String);

impl Currency {
    pub fn new(code: impl Into<String>) -> Self {
        Self(code.into())
    }

    pub fn usd() -> Self {
        Self("USD".to_string())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for Currency {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl From<String> for Currency {
    fn from(s: String) -> Self {
        Self(s)
    }
}

impl From<&str> for Currency {
    fn from(s: &str) -> Self {
        Self(s.to_string())
    }
}

impl AsRef<str> for Currency {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_asset_id() {
        let id = AssetId::new("AAPL:XNAS");
        assert_eq!(id.as_str(), "AAPL:XNAS");
        assert_eq!(id.to_string(), "AAPL:XNAS");

        let id2: AssetId = "BTC-USD".into();
        assert_eq!(id2.as_str(), "BTC-USD");
    }

    #[test]
    fn test_provider_id() {
        let yahoo = ProviderId::yahoo();
        assert_eq!(yahoo.as_str(), "YAHOO");

        let custom = ProviderId::new("CUSTOM");
        assert_eq!(custom.as_str(), "CUSTOM");
    }

    #[test]
    fn test_day() {
        let day = Day::from_ymd(2024, 1, 15).unwrap();
        assert_eq!(day.to_string(), "2024-01-15");

        let parsed = Day::parse("2024-01-15").unwrap();
        assert_eq!(day, parsed);
    }

    #[test]
    fn test_quote_source() {
        let manual = QuoteSource::Manual;
        assert!(manual.is_manual());
        assert!(!manual.is_provider());
        assert_eq!(manual.to_storage_string(), "MANUAL");

        let yahoo = QuoteSource::Provider(ProviderId::yahoo());
        assert!(!yahoo.is_manual());
        assert!(yahoo.is_provider());
        assert_eq!(yahoo.to_storage_string(), "YAHOO");
    }

    #[test]
    fn test_quote_source_parsing() {
        assert_eq!(
            QuoteSource::from_storage_string("MANUAL"),
            QuoteSource::Manual
        );
        assert_eq!(
            QuoteSource::from_storage_string("manual"),
            QuoteSource::Manual
        );
        assert_eq!(
            QuoteSource::from_storage_string("YAHOO"),
            QuoteSource::Provider(ProviderId::yahoo())
        );
    }

    #[test]
    fn test_quote_id() {
        let asset_id = AssetId::new("AAPL:XNAS");
        let day = Day::from_ymd(2024, 1, 15).unwrap();
        let source = QuoteSource::Provider(ProviderId::yahoo());

        let id = quote_id(&asset_id, day, &source);
        assert_eq!(id, "AAPL:XNAS_2024-01-15_YAHOO");

        let manual_id = quote_id(&asset_id, day, &QuoteSource::Manual);
        assert_eq!(manual_id, "AAPL:XNAS_2024-01-15_MANUAL");
    }

    #[test]
    fn test_currency() {
        let usd = Currency::usd();
        assert_eq!(usd.as_str(), "USD");

        let eur: Currency = "EUR".into();
        assert_eq!(eur.as_str(), "EUR");
    }
}
