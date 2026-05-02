//! Portfolio valuation domain models.

use chrono::{DateTime, NaiveDate, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

/// Details about an account that has a negative total_value in its history.
#[derive(Debug, Clone)]
pub struct NegativeBalanceInfo {
    pub account_id: String,
    /// First date the total_value went negative.
    pub first_negative_date: NaiveDate,
    /// Cash balance on that date (account currency).
    pub cash_balance: Decimal,
    /// Total value on that date (account currency).
    pub total_value: Decimal,
    /// Account currency (e.g. "EUR").
    pub account_currency: String,
}

/// Domain model for daily account valuation
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DailyAccountValuation {
    pub id: String,
    pub account_id: String,
    pub valuation_date: NaiveDate,
    pub account_currency: String,
    pub base_currency: String,
    pub fx_rate_to_base: Decimal,
    pub cash_balance: Decimal,
    pub investment_market_value: Decimal,
    pub total_value: Decimal,
    pub cost_basis: Decimal,
    pub net_contribution: Decimal,
    pub calculated_at: DateTime<Utc>,
    /// Market value of alternative (non-investment) assets in account currency.
    /// Investments tab total = total_value - alternative_market_value.
    pub alternative_market_value: Decimal,
}

