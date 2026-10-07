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

/// Known bond metadata supplied to quote providers.
/// Missing pricing fields must not discard a known Treasury type.
#[derive(Clone, Debug)]
pub struct BondQuoteMetadata {
    /// Verified TreasuryDirect type, required by the Treasury calculator.
    pub treasury_type: Option<String>,
    /// Annual coupon rate as a decimal (0.05 = 5%)
    pub coupon_rate: Option<Decimal>,
    /// Maturity date of the bond
    pub maturity_date: Option<NaiveDate>,
    /// Face/par value of the bond
    pub face_value: Decimal,
    /// Coupon payment frequency: "SEMI_ANNUAL", "ANNUAL", "QUARTERLY", "ZERO"
    pub coupon_frequency: Option<String>,
}

impl BondQuoteMetadata {
    pub fn has_valid_treasury_terms(&self) -> bool {
        let valid_coupon = match self.treasury_type.as_deref() {
            Some("Bill") => {
                self.coupon_rate == Some(Decimal::ZERO)
                    && self.coupon_frequency.as_deref() == Some("ZERO")
            }
            Some("Note" | "Bond") => {
                self.coupon_rate.is_some_and(|rate| rate > Decimal::ZERO)
                    && self.coupon_frequency.as_deref() == Some("SEMI_ANNUAL")
            }
            _ => false,
        };
        valid_coupon && self.maturity_date.is_some() && self.face_value > Decimal::ZERO
    }
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

impl QuoteContext {
    /// The custom provider this security is assigned to. The code counts only while the
    /// custom scraper is the chosen provider, so a code left behind under another
    /// provider can't route requests to an assigned-only source.
    pub fn assigned_custom_provider(&self) -> Option<&str> {
        if self.preferred_provider.as_deref() == Some(crate::provider::DATA_SOURCE_CUSTOM_SCRAPER) {
            self.custom_provider_code.as_deref()
        } else {
            None
        }
    }
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
