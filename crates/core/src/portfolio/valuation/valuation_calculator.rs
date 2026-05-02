use crate::errors::{Error, Result};
use crate::fx::currency::{normalize_amount, normalize_currency_code};
use crate::fx::FxError;
use crate::portfolio::snapshot::AccountStateSnapshot;
use crate::portfolio::valuation::DailyAccountValuation;
use crate::quotes::Quote;

use chrono::{NaiveDate, Utc};
use log::{error, warn};
use rust_decimal::Decimal;
use std::collections::HashMap;

// Type alias for the pre-fetched FX rate cache for a given day
// (from_currency, to_currency) -> rate
pub type DailyFxRateMap = HashMap<(String, String), Decimal>;

/// Calculates valuation metrics for a given holdings snapshot on a specific date.
/// Returns an `DailyAccountValuation` struct containing market values and base currency conversions.
/// Requires pre-fetched FX rates for the `target_date` via `fx_rates_today`.
///
/// # Arguments
///
/// * `holdings_snapshot` - The account state snapshot for the target date.
/// * `quotes_today` - Market quotes relevant for the target date.
/// * `fx_rates_today` - Pre-fetched FX rates for the target date.
/// * `target_date` - The date for which the valuation is calculated.
/// * `base_currency` - The target currency for the final valuation metrics.
///
pub fn calculate_valuation(
    holdings_snapshot: &AccountStateSnapshot, // Holdings for target_date
    quotes_today: &HashMap<String, Quote>,    // Market quotes for target_date
    fx_rates_today: &DailyFxRateMap,
    target_date: NaiveDate,
    base_currency: &str, // Pass base currency directly
) -> Result<DailyAccountValuation> {
    let account_currency = &holdings_snapshot.currency;
    let normalized_account_currency = normalize_currency_code(account_currency);
    let normalized_base_currency = normalize_currency_code(base_currency);

    // --- 1. Calculate Market Values (Account Currency) ---
    // Returns (total_investment_value, performance_eligible_value)
    // performance_eligible_value excludes alternative assets for TWR/IRR calculations
    let (total_investment_market_value_acct_ccy, performance_eligible_value) =
        calculate_investment_market_value_acct(
            holdings_snapshot,
            quotes_today,
            fx_rates_today,
            target_date,
            normalized_account_currency,
        )?;

    let total_cash_value_acct_ccy = calculate_cash_value_acct(
        holdings_snapshot,
        fx_rates_today,
        target_date,
        normalized_account_currency,
    )?;

    // Total market value in account currency (investments + cash)
    let total_market_value_acct_ccy =
        total_investment_market_value_acct_ccy + total_cash_value_acct_ccy;
    let cost_basis_acct_ccy = holdings_snapshot.cost_basis; // Already in acct ccy
    let net_contribution_acct_ccy = holdings_snapshot.net_contribution; // Get net deposit

    // --- 2. Get Base Currency FX Rate ---
    let fx_rate_to_base = match get_rate_from_map(
        fx_rates_today,
        normalized_account_currency,
        normalized_base_currency,
        target_date,
    ) {
        Ok(rate) => rate,
        Err(_) => {
            // Error already logged in get_rate_from_map if warning is sufficient,
            // but we need to fail the valuation if the base rate is missing.
            error!(
                "Valuation failed for account {}: Critical FX rate missing for {}->{} on {}.",
                holdings_snapshot.account_id, account_currency, base_currency, target_date
            );
            return Err(Error::Fx(FxError::RateNotFound(format!(
                "{}->{} on {}",
                account_currency, base_currency, target_date
            ))));
        }
    };

    // Note: DailyAccountValuation primarily uses account currency values.
    // Base currency values like market_value_base, book_cost_base are not part of it.
    // Gain/Loss calculations are also not part of DailyAccountValuation.

    // --- 3. Construct Result using DailyAccountValuation structure ---
    let metrics = DailyAccountValuation {
        id: format!("{}_{}", holdings_snapshot.account_id, target_date),
        account_id: holdings_snapshot.account_id.clone(),
        valuation_date: target_date,
        account_currency: account_currency.to_string(),
        base_currency: base_currency.to_string(),
        fx_rate_to_base,
        cash_balance: total_cash_value_acct_ccy,
        investment_market_value: total_investment_market_value_acct_ccy,
        total_value: total_market_value_acct_ccy,
        cost_basis: cost_basis_acct_ccy,
        net_contribution: net_contribution_acct_ccy,
        calculated_at: Utc::now(),
        alternative_market_value: total_investment_market_value_acct_ccy
            - performance_eligible_value,
    };

    Ok(metrics)
}

/// Helper to calculate the total market value of investments in the account currency.
/// Also calculates the investment-only value (excluding alternative assets) for performance calculations.
/// Returns (total_investment_value, performance_eligible_value).
fn calculate_investment_market_value_acct(
    holdings_snapshot: &AccountStateSnapshot,
    quotes_today: &HashMap<String, Quote>,
    fx_rates_today: &DailyFxRateMap,
    target_date: NaiveDate,
    account_currency: &str,
) -> Result<(Decimal, Decimal)> {
    let mut total_position_market_value = Decimal::ZERO;
    let mut performance_eligible_market_value = Decimal::ZERO;

    for (asset_id, position) in &holdings_snapshot.positions {
        if let Some(quote) = quotes_today.get(asset_id) {
            let (normalized_price, normalized_quote_currency) =
                normalize_amount(quote.close, &quote.currency);

            let quote_fx_rate = if normalized_quote_currency == account_currency {
                Decimal::ONE
            } else {
                get_rate_from_map(
                    fx_rates_today,
                    normalized_quote_currency,
                    account_currency,
                    target_date,
                )? // Propagate error if FX rate is missing
            };

            let market_value =
                position.quantity * normalized_price * position.contract_multiplier * quote_fx_rate;
            total_position_market_value += market_value;

            // Only include non-alternative assets in performance-eligible value
            if !position.is_alternative {
                performance_eligible_market_value += market_value;
            }
        } else {
            warn!(
                "Missing quote for asset {} on date {}. Position market value treated as ZERO.",
                asset_id, target_date
            );
        }
    }
    Ok((
        total_position_market_value,
        performance_eligible_market_value,
    ))
}

/// Helper to calculate the total value of cash balances in the account currency.
fn calculate_cash_value_acct(
    holdings_snapshot: &AccountStateSnapshot,
    fx_rates_today: &DailyFxRateMap,
    target_date: NaiveDate,
    account_currency: &str,
) -> Result<Decimal> {
    let mut total_cash_value = Decimal::ZERO;
    for (cash_currency, amount) in &holdings_snapshot.cash_balances {
        let (normalized_amount, normalized_cash_currency) =
            normalize_amount(*amount, cash_currency);

        let cash_fx_rate = if normalized_cash_currency == account_currency {
            Decimal::ONE
        } else {
            get_rate_from_map(
                fx_rates_today,
                normalized_cash_currency,
                account_currency,
                target_date,
            )?
            // Propagate error if FX rate is missing
        };
        total_cash_value += normalized_amount * cash_fx_rate;
    }
    Ok(total_cash_value)
}

/// Helper to get FX rate directly from the provided daily rate map.
/// Returns an error if the rate is missing. Logs a warning.
fn get_rate_from_map(
    // Renamed with leading underscore
    rate_map: &DailyFxRateMap,
    from_curr: &str,
    to_curr: &str,
    date: NaiveDate, // Keep date for logging context
) -> Result<Decimal> {
    if from_curr == to_curr {
        return Ok(Decimal::ONE);
    }

    let pair = (from_curr.to_string(), to_curr.to_string());

    match rate_map.get(&pair) {
        Some(rate) => Ok(*rate),
        None => {
            // Attempt inverse lookup
            let inverse_pair = (to_curr.to_string(), from_curr.to_string());
            match rate_map.get(&inverse_pair) {
                Some(inverse_rate) if *inverse_rate != Decimal::ZERO => {
                    Ok(Decimal::ONE / *inverse_rate)
                }
                _ => {
                    // Log warning here, let the caller decide if it's a fatal error
                    warn!(
                        "Required FX rate missing from provided cache for {}->{} on {}. Inverse lookup also failed or rate was zero.",
                        from_curr, to_curr, date
                    );
                    Err(Error::Fx(FxError::RateNotFound(format!(
                        "{}->{} on {}",
                        from_curr, to_curr, date
                    ))))
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::portfolio::snapshot::{Position, SnapshotSource};
    use crate::quotes::Quote;
    use rust_decimal_macros::dec;
    use std::collections::VecDeque;

    #[test]
    fn test_calculate_valuation_with_zero_cost_basis_position() {
        let target_date = NaiveDate::from_ymd_opt(2024, 6, 4).unwrap();

        let mut positions = HashMap::new();
        positions.insert(
            "SOL".to_string(),
            Position {
                id: "POS-SOL-acc_1".to_string(),
                account_id: "acc_1".to_string(),
                asset_id: "SOL".to_string(),
                quantity: dec!(0.000000329),
                average_cost: dec!(0),
                total_cost_basis: dec!(0),
                currency: "CAD".to_string(),
                inception_date: Utc::now(),
                lots: VecDeque::new(),
                created_at: Utc::now(),
                last_updated: Utc::now(),
                is_alternative: false,
                contract_multiplier: Decimal::ONE,
            },
        );

        let snapshot = AccountStateSnapshot {
            id: "acc_1_2024-06-04".to_string(),
            account_id: "acc_1".to_string(),
            snapshot_date: target_date,
            currency: "CAD".to_string(),
            positions,
            cash_balances: HashMap::new(),
            cost_basis: dec!(0),
            net_contribution: dec!(0),
            net_contribution_base: dec!(0),
            cash_total_account_currency: dec!(0),
            cash_total_base_currency: dec!(0),
            calculated_at: Utc::now().naive_utc(),
            source: SnapshotSource::Calculated,
        };

        let quote = Quote {
            id: "quote-sol".to_string(),
            asset_id: "SOL".to_string(),
            timestamp: Utc::now(),
            open: dec!(100),
            high: dec!(100),
            low: dec!(100),
            close: dec!(100),
            adjclose: dec!(100),
            volume: dec!(0),
            currency: "CAD".to_string(),
            data_source: "MANUAL".to_string(),
            created_at: Utc::now(),
            notes: None,
        };
        let quotes_today = HashMap::from([("SOL".to_string(), quote)]);
        let fx_rates_today = HashMap::new();

        let result = calculate_valuation(
            &snapshot,
            &quotes_today,
            &fx_rates_today,
            target_date,
            "CAD",
        )
        .unwrap();

        assert_eq!(result.investment_market_value, dec!(0.0000329));
        assert_eq!(result.total_value, dec!(0.0000329));
        assert_eq!(result.cost_basis, dec!(0));
        assert_eq!(result.fx_rate_to_base, dec!(1));
    }
}
