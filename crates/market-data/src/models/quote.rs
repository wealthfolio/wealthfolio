use std::borrow::Cow;

use chrono::{DateTime, NaiveDate, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

use super::instrument::InstrumentId;
use super::provider_params::ProviderOverrides;
use super::types::{Currency, ProviderId};

/// Security identifiers carried alongside quote requests.
#[derive(Clone, Debug, Default)]
pub struct QuoteIdentifiers {
    pub isin: Option<Cow<'static, str>>,
}

/// Bond metadata needed for yield-curve-based price calculation.
#[derive(Clone, Debug)]
pub struct BondQuoteMetadata {
    /// Annual coupon rate as a decimal (0.05 = 5%)
    pub coupon_rate: Decimal,
    /// Maturity date of the bond
    pub maturity_date: NaiveDate,
    /// Face/par value of the bond
    pub face_value: Decimal,
    /// Coupon payment frequency: "SEMI_ANNUAL", "ANNUAL", "QUARTERLY", "ZERO"
    pub coupon_frequency: String,
}

/// Request context for quote fetching
#[derive(Clone, Debug)]
pub struct QuoteContext {
    /// Canonical instrument
    pub instrument: InstrumentId,

    /// Security identifiers that do not define the quote instrument by themselves
    pub identifiers: QuoteIdentifiers,

    /// Pre-resolved provider overrides (from Asset.provider_overrides)
    pub overrides: Option<ProviderOverrides>,

    /// Currency hint
    pub currency_hint: Option<Currency>,

    /// Preferred provider (from Asset.preferred_provider)
    pub preferred_provider: Option<ProviderId>,

    /// Bond metadata for yield-curve-based pricing (coupon, maturity, face value)
    pub bond_metadata: Option<BondQuoteMetadata>,

    /// Custom provider code (e.g., "coingecko") — used by CUSTOM_SCRAPER to find source config
    pub custom_provider_code: Option<String>,
}

/// Market data quote
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Quote {
    /// Timestamp of the quote
    pub timestamp: DateTime<Utc>,

    /// Opening price (optional for intraday)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open: Option<Decimal>,

    /// High price (optional for intraday)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub high: Option<Decimal>,

    /// Low price (optional for intraday)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub low: Option<Decimal>,

    /// Closing/current price (required)
    pub close: Decimal,

    /// Trading volume (optional)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub volume: Option<Decimal>,

    /// Quote currency
    pub currency: String,

    /// Source of the quote (MANUAL, YAHOO, ALPHA_VANTAGE, etc.)
    pub source: String,
}

impl Quote {
    /// Create a new quote with minimal required fields
    pub fn new(timestamp: DateTime<Utc>, close: Decimal, currency: String, source: String) -> Self {
        Self {
            timestamp,
            open: None,
            high: None,
            low: None,
            close,
            volume: None,
            currency,
            source,
        }
    }

    /// Create a full OHLCV quote
    #[allow(clippy::too_many_arguments)]
    pub fn ohlcv(
        timestamp: DateTime<Utc>,
        open: Decimal,
        high: Decimal,
        low: Decimal,
        close: Decimal,
        volume: Decimal,
        currency: String,
        source: String,
    ) -> Self {
        Self {
            timestamp,
            open: Some(open),
            high: Some(high),
            low: Some(low),
            close,
            volume: Some(volume),
            currency,
            source,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    #[test]
    fn test_quote_new() {
        let quote = Quote::new(
            Utc::now(),
            dec!(150.25),
            "USD".to_string(),
            "YAHOO".to_string(),
        );
        assert_eq!(quote.close, dec!(150.25));
        assert_eq!(quote.currency, "USD");
        assert!(quote.open.is_none());
    }

    #[test]
    fn test_quote_ohlcv() {
        let quote = Quote::ohlcv(
            Utc::now(),
            dec!(148.00),
            dec!(152.00),
            dec!(147.50),
            dec!(150.25),
            dec!(1000000),
            "USD".to_string(),
            "YAHOO".to_string(),
        );
        assert_eq!(quote.open, Some(dec!(148.00)));
        assert_eq!(quote.high, Some(dec!(152.00)));
        assert_eq!(quote.low, Some(dec!(147.50)));
        assert_eq!(quote.close, dec!(150.25));
        assert_eq!(quote.volume, Some(dec!(1000000)));
    }
}
