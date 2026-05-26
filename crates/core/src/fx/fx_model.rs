use crate::quotes::Quote;
use crate::utils::decimal_serde;
use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FxContext {
    ValuationDate,
    AcquisitionDate,
    FlowDate,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExchangeRate {
    pub id: String,
    pub from_currency: String,
    pub to_currency: String,
    #[serde(serialize_with = "decimal_serde::serialize")]
    pub rate: Decimal,
    pub source: String,
    pub timestamp: DateTime<Utc>,
}

impl ExchangeRate {
    /// Converts this exchange rate into a Quote for database storage.
    /// `self.id` must be the asset UUID.
    pub fn to_quote(&self) -> Quote {
        let day = self.timestamp.format("%Y-%m-%d").to_string();
        Quote {
            id: format!("{}_{}_{}", self.id, day, self.source),
            asset_id: self.id.clone(),
            timestamp: self.timestamp,
            open: self.rate,
            high: self.rate,
            low: self.rate,
            close: self.rate,
            adjclose: self.rate,
            volume: Decimal::ZERO,
            data_source: self.source.clone(),
            created_at: self.timestamp,
            currency: self.from_currency.clone(),
            notes: None,
        }
    }

    /// Creates an instrument_key for FX pair lookup.
    /// Returns format: "FX:EUR/USD"
    pub fn make_instrument_key(from: &str, to: &str) -> String {
        format!("FX:{}/{}", from, to)
    }

    /// Parses an instrument_key or legacy symbol into (from_currency, to_currency).
    /// Supports:
    /// - Instrument key: "FX:EUR/USD" -> ("EUR", "USD")
    /// - Legacy colon: "EUR:USD" -> ("EUR", "USD")
    /// - Legacy slash: "EUR/USD" -> ("EUR", "USD")
    /// - Legacy concatenated: "EURUSD" -> ("EUR", "USD")
    /// - Legacy Yahoo: "EURUSD=X" -> ("EUR", "USD")
    pub fn parse_fx_pair(key: &str) -> (String, String) {
        // Handle instrument_key format: "FX:EUR/USD"
        if let Some(pair) = key.strip_prefix("FX:") {
            if let Some((base, quote)) = pair.split_once('/') {
                return (base.to_string(), quote.to_string());
            }
        }
        // Handle legacy colon format: "EUR:USD"
        if let Some((base, quote)) = key.split_once(':') {
            return (base.to_string(), quote.to_string());
        }
        // Handle legacy slash format: "EUR/USD"
        if let Some((base, quote)) = key.split_once('/') {
            return (base.to_string(), quote.to_string());
        }
        // Handle legacy Yahoo format: "EURUSD=X" or "EURUSD"
        let base_symbol = key.strip_suffix("=X").unwrap_or(key);
        if base_symbol.len() >= 6 {
            (base_symbol[..3].to_string(), base_symbol[3..6].to_string())
        } else {
            (base_symbol.to_string(), String::new())
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NewExchangeRate {
    pub from_currency: String,
    pub to_currency: String,
    #[serde(serialize_with = "decimal_serde::serialize")]
    pub rate: Decimal,
    pub source: String,
}
