use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use std::str::FromStr;

use crate::errors::ValidationError;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PriceAlertCondition {
    Above,
    Below,
}

impl PriceAlertCondition {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Above => "ABOVE",
            Self::Below => "BELOW",
        }
    }
}

impl FromStr for PriceAlertCondition {
    type Err = ValidationError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "ABOVE" => Ok(Self::Above),
            "BELOW" => Ok(Self::Below),
            _ => Err(ValidationError::InvalidInput(format!(
                "Unknown price alert condition: {value}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PriceAlertStatus {
    Active,
    Triggered,
    Paused,
}

impl PriceAlertStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "ACTIVE",
            Self::Triggered => "TRIGGERED",
            Self::Paused => "PAUSED",
        }
    }
}

impl FromStr for PriceAlertStatus {
    type Err = ValidationError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "ACTIVE" => Ok(Self::Active),
            "TRIGGERED" => Ok(Self::Triggered),
            "PAUSED" => Ok(Self::Paused),
            _ => Err(ValidationError::InvalidInput(format!(
                "Unknown price alert status: {value}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PriceAlert {
    pub id: String,
    pub asset_id: String,
    pub condition: PriceAlertCondition,
    pub target_price: String,
    pub currency: String,
    pub status: PriceAlertStatus,
    pub armed_at: DateTime<Utc>,
    pub armed_market_date: NaiveDate,
    pub pause_reason: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NewPriceAlert {
    pub asset_id: String,
    pub condition: PriceAlertCondition,
    pub target_price: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PriceAlertEvent {
    pub id: String,
    pub alert_id: String,
    pub asset_id: String,
    pub quote_id: String,
    pub target_price: String,
    pub observed_close: String,
    pub observed_high: String,
    pub observed_low: String,
    pub currency: String,
    pub quote_timestamp: DateTime<Utc>,
    pub triggered_at: DateTime<Utc>,
    pub acknowledged_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone)]
pub struct NewPriceAlertEvent {
    pub id: String,
    pub alert_id: String,
    pub asset_id: String,
    pub quote_id: String,
    pub target_price: String,
    pub observed_close: String,
    pub observed_high: String,
    pub observed_low: String,
    pub currency: String,
    pub quote_timestamp: DateTime<Utc>,
    pub triggered_at: DateTime<Utc>,
}
