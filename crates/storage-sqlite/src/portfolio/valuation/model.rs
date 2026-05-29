//! Database model for daily account valuations.

use chrono::{DateTime, NaiveDate, Utc};
use diesel::prelude::*;
use log::error;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use std::str::FromStr;

use wealthfolio_core::constants::DECIMAL_PRECISION;
use wealthfolio_core::portfolio::valuation::DailyAccountValuation;

/// Database model for daily account valuations
#[derive(
    Debug, Clone, Serialize, Deserialize, PartialEq, Queryable, QueryableByName, Insertable,
)]
#[serde(rename_all = "camelCase")]
#[diesel(table_name = crate::schema::daily_account_valuation)]
pub struct DailyAccountValuationDB {
    pub id: String,
    pub account_id: String,
    pub valuation_date: NaiveDate,
    pub account_currency: String,
    pub base_currency: String,
    pub fx_rate_to_base: String,
    pub cash_balance: String,
    pub investment_market_value: String,
    pub total_value: String,
    pub cost_basis: String,
    pub net_contribution: String,
    pub cash_balance_base: String,
    pub investment_market_value_base: String,
    pub total_value_base: String,
    pub cost_basis_base: String,
    pub net_contribution_base: String,
    pub external_inflow_base: String,
    pub external_outflow_base: String,
    pub performance_eligible_value_base: String,
    pub calculated_at: String,
}

impl From<DailyAccountValuation> for DailyAccountValuationDB {
    fn from(value: DailyAccountValuation) -> Self {
        DailyAccountValuationDB {
            id: value.id,
            account_id: value.account_id,
            valuation_date: value.valuation_date,
            account_currency: value.account_currency,
            base_currency: value.base_currency,
            fx_rate_to_base: value.fx_rate_to_base.to_string(),
            cash_balance: value.cash_balance.round_dp(DECIMAL_PRECISION).to_string(),
            investment_market_value: value
                .investment_market_value
                .round_dp(DECIMAL_PRECISION)
                .to_string(),
            total_value: value.total_value.round_dp(DECIMAL_PRECISION).to_string(),
            cost_basis: value.cost_basis.round_dp(DECIMAL_PRECISION).to_string(),
            net_contribution: value
                .net_contribution
                .round_dp(DECIMAL_PRECISION)
                .to_string(),
            cash_balance_base: value
                .cash_balance_base
                .round_dp(DECIMAL_PRECISION)
                .to_string(),
            investment_market_value_base: value
                .investment_market_value_base
                .round_dp(DECIMAL_PRECISION)
                .to_string(),
            total_value_base: value
                .total_value_base
                .round_dp(DECIMAL_PRECISION)
                .to_string(),
            cost_basis_base: value
                .cost_basis_base
                .round_dp(DECIMAL_PRECISION)
                .to_string(),
            net_contribution_base: value
                .net_contribution_base
                .round_dp(DECIMAL_PRECISION)
                .to_string(),
            external_inflow_base: value
                .external_inflow_base
                .round_dp(DECIMAL_PRECISION)
                .to_string(),
            external_outflow_base: value
                .external_outflow_base
                .round_dp(DECIMAL_PRECISION)
                .to_string(),
            performance_eligible_value_base: value
                .performance_eligible_value_base
                .round_dp(DECIMAL_PRECISION)
                .to_string(),
            calculated_at: value.calculated_at.to_rfc3339(),
        }
    }
}

impl From<DailyAccountValuationDB> for DailyAccountValuation {
    fn from(value: DailyAccountValuationDB) -> Self {
        let fx_rate_to_base = parse_fx_rate_to_base(&value);

        DailyAccountValuation {
            id: value.id,
            account_id: value.account_id,
            valuation_date: value.valuation_date,
            account_currency: value.account_currency,
            base_currency: value.base_currency,
            fx_rate_to_base,
            cash_balance: Decimal::from_str(&value.cash_balance).unwrap_or_default(),
            investment_market_value: Decimal::from_str(&value.investment_market_value)
                .unwrap_or_default(),
            total_value: Decimal::from_str(&value.total_value).unwrap_or_default(),
            cost_basis: Decimal::from_str(&value.cost_basis).unwrap_or_default(),
            net_contribution: Decimal::from_str(&value.net_contribution).unwrap_or_default(),
            cash_balance_base: Decimal::from_str(&value.cash_balance_base).unwrap_or_default(),
            investment_market_value_base: Decimal::from_str(&value.investment_market_value_base)
                .unwrap_or_default(),
            total_value_base: Decimal::from_str(&value.total_value_base).unwrap_or_default(),
            cost_basis_base: Decimal::from_str(&value.cost_basis_base).unwrap_or_default(),
            net_contribution_base: Decimal::from_str(&value.net_contribution_base)
                .unwrap_or_default(),
            external_inflow_base: Decimal::from_str(&value.external_inflow_base)
                .unwrap_or_default(),
            external_outflow_base: Decimal::from_str(&value.external_outflow_base)
                .unwrap_or_default(),
            performance_eligible_value_base: Decimal::from_str(
                &value.performance_eligible_value_base,
            )
            .unwrap_or_default(),
            calculated_at: DateTime::parse_from_rfc3339(&value.calculated_at)
                .map(|dt| dt.with_timezone(&Utc))
                .unwrap_or_else(|_| Utc::now()),
        }
    }
}

fn parse_fx_rate_to_base(value: &DailyAccountValuationDB) -> Decimal {
    Decimal::from_str(&value.fx_rate_to_base).unwrap_or_else(|error| {
        error!(
            "Corrupt FX rate '{}' for account {} on {}; defaulting to 1.0: {}",
            value.fx_rate_to_base, value.account_id, value.valuation_date, error
        );
        Decimal::ONE
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn malformed_fx_rate_defaults_to_one_not_zero() {
        let db_value = DailyAccountValuationDB {
            id: "valuation-1".to_string(),
            account_id: "account-1".to_string(),
            valuation_date: NaiveDate::from_ymd_opt(2026, 4, 22).unwrap(),
            account_currency: "EUR".to_string(),
            base_currency: "USD".to_string(),
            fx_rate_to_base: "not-a-rate".to_string(),
            cash_balance: "10".to_string(),
            investment_market_value: "20".to_string(),
            total_value: "30".to_string(),
            cost_basis: "25".to_string(),
            net_contribution: "5".to_string(),
            cash_balance_base: "10".to_string(),
            investment_market_value_base: "20".to_string(),
            total_value_base: "30".to_string(),
            cost_basis_base: "25".to_string(),
            net_contribution_base: "5".to_string(),
            external_inflow_base: "0".to_string(),
            external_outflow_base: "0".to_string(),
            performance_eligible_value_base: "30".to_string(),
            calculated_at: "2026-04-22T00:00:00Z".to_string(),
        };

        let valuation = DailyAccountValuation::from(db_value);

        assert_eq!(valuation.fx_rate_to_base, Decimal::ONE);
    }
}
