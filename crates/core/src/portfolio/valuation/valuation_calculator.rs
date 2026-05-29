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
    fx_rates_by_date: &HashMap<NaiveDate, DailyFxRateMap>,
    target_date: NaiveDate,
    base_currency: &str, // Pass base currency directly
) -> Result<DailyAccountValuation> {
    let account_currency = &holdings_snapshot.currency;
    let normalized_account_currency = normalize_currency_code(account_currency);
    let normalized_base_currency = normalize_currency_code(base_currency);

    // --- 1. Calculate Market Values (Account Currency) ---
    // Returns (total_investment_value, performance_eligible_value).
    // performance_eligible_value excludes holdings that are not part of TWR/IRR.
    let (total_investment_market_value_acct_ccy, performance_eligible_value_acct_ccy) =
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
    let cost_basis_acct_ccy = calculate_cost_basis_acct(
        holdings_snapshot,
        fx_rates_today,
        target_date,
        normalized_account_currency,
    )?;
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

    let cash_balance_base = total_cash_value_acct_ccy * fx_rate_to_base;
    let investment_market_value_base = total_investment_market_value_acct_ccy * fx_rate_to_base;
    let total_value_base = cash_balance_base + investment_market_value_base;
    let cost_basis_base = calculate_cost_basis_base(
        holdings_snapshot,
        fx_rates_today,
        fx_rates_by_date,
        target_date,
        normalized_base_currency,
    )?;
    let net_contribution_base = holdings_snapshot.net_contribution_base;
    let performance_eligible_value_base =
        (performance_eligible_value_acct_ccy + total_cash_value_acct_ccy) * fx_rate_to_base;

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
        cash_balance_base,
        investment_market_value_base,
        total_value_base,
        cost_basis_base,
        net_contribution_base,
        external_inflow_base: Decimal::ZERO,
        external_outflow_base: Decimal::ZERO,
        performance_eligible_value_base,
        calculated_at: Utc::now(),
    };

    Ok(metrics)
}

fn calculate_cost_basis_base(
    holdings_snapshot: &AccountStateSnapshot,
    fx_rates_today: &DailyFxRateMap,
    fx_rates_by_date: &HashMap<NaiveDate, DailyFxRateMap>,
    target_date: NaiveDate,
    base_currency: &str,
) -> Result<Decimal> {
    let mut total = Decimal::ZERO;

    for position in holdings_snapshot.positions.values() {
        if position.is_alternative {
            continue;
        }

        if position.total_cost_basis.is_zero() {
            continue;
        }

        let position_currency = normalize_currency_code(&position.currency);

        if position.lots.is_empty() {
            warn!(
                "Position {} has no materialized lots on {}. Falling back to valuation-date FX for cost basis.",
                position.asset_id, target_date
            );
            let rate = get_rate_from_map(
                fx_rates_today,
                position_currency,
                base_currency,
                target_date,
            )?;
            total += position.total_cost_basis * rate;
            continue;
        }

        for lot in &position.lots {
            if lot.cost_basis.is_zero() {
                continue;
            }
            let acquisition_date = lot.acquisition_date.date_naive();
            let empty_rates = DailyFxRateMap::new();
            let rates = fx_rates_by_date
                .get(&acquisition_date)
                .unwrap_or(&empty_rates);
            let rate =
                get_rate_from_map(rates, position_currency, base_currency, acquisition_date)?;
            total += lot.cost_basis * rate;
        }
    }

    Ok(total)
}

fn calculate_cost_basis_acct(
    holdings_snapshot: &AccountStateSnapshot,
    fx_rates_today: &DailyFxRateMap,
    target_date: NaiveDate,
    account_currency: &str,
) -> Result<Decimal> {
    if !holdings_snapshot
        .positions
        .values()
        .any(|position| position.is_alternative)
    {
        return Ok(holdings_snapshot.cost_basis);
    }

    let mut total = Decimal::ZERO;
    for position in holdings_snapshot.positions.values() {
        if position.is_alternative || position.total_cost_basis.is_zero() {
            continue;
        }

        let position_currency = normalize_currency_code(&position.currency);
        let rate = if position_currency == account_currency {
            Decimal::ONE
        } else {
            get_rate_from_map(
                fx_rates_today,
                position_currency,
                account_currency,
                target_date,
            )?
        };
        total += position.total_cost_basis * rate;
    }

    Ok(total)
}

/// Helper to calculate the total market value of investment positions in the account currency.
/// Alternative assets are net-worth-only and are excluded from investment valuation.
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
        if position.is_alternative {
            continue;
        }

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
            performance_eligible_market_value += market_value;
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
    use crate::portfolio::snapshot::{Lot, Position, SnapshotSource};
    use crate::quotes::Quote;
    use chrono::DateTime;
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
            &HashMap::new(),
            target_date,
            "CAD",
        )
        .unwrap();

        assert_eq!(result.investment_market_value, dec!(0.0000329));
        assert_eq!(result.total_value, dec!(0.0000329));
        assert_eq!(result.cost_basis, dec!(0));
        assert_eq!(result.fx_rate_to_base, dec!(1));
    }

    #[test]
    fn investment_valuation_excludes_net_worth_only_positions() {
        let target_date = NaiveDate::from_ymd_opt(2024, 6, 4).unwrap();
        let now = Utc::now();
        let mut positions = HashMap::new();
        positions.insert(
            "ETF".to_string(),
            Position {
                id: "POS-ETF-acc_1".to_string(),
                account_id: "acc_1".to_string(),
                asset_id: "ETF".to_string(),
                quantity: dec!(2),
                average_cost: dec!(100),
                total_cost_basis: dec!(200),
                currency: "USD".to_string(),
                inception_date: now,
                lots: VecDeque::new(),
                created_at: now,
                last_updated: now,
                is_alternative: false,
                contract_multiplier: Decimal::ONE,
            },
        );
        positions.insert(
            "GOLD".to_string(),
            Position {
                id: "POS-GOLD-acc_1".to_string(),
                account_id: "acc_1".to_string(),
                asset_id: "GOLD".to_string(),
                quantity: dec!(1),
                average_cost: dec!(50),
                total_cost_basis: dec!(50),
                currency: "USD".to_string(),
                inception_date: now,
                lots: VecDeque::new(),
                created_at: now,
                last_updated: now,
                is_alternative: true,
                contract_multiplier: Decimal::ONE,
            },
        );
        let snapshot = AccountStateSnapshot {
            id: "acc_1_2024-06-04".to_string(),
            account_id: "acc_1".to_string(),
            snapshot_date: target_date,
            currency: "USD".to_string(),
            positions,
            cash_balances: HashMap::from([("USD".to_string(), dec!(10))]),
            cost_basis: dec!(250),
            net_contribution: dec!(250),
            net_contribution_base: dec!(250),
            cash_total_account_currency: dec!(10),
            cash_total_base_currency: dec!(10),
            calculated_at: now.naive_utc(),
            source: SnapshotSource::Calculated,
        };
        let quote = |asset_id: &str, close: Decimal| Quote {
            id: format!("quote-{asset_id}"),
            asset_id: asset_id.to_string(),
            timestamp: now,
            open: close,
            high: close,
            low: close,
            close,
            adjclose: close,
            volume: Decimal::ZERO,
            currency: "USD".to_string(),
            data_source: "MANUAL".to_string(),
            created_at: now,
            notes: None,
        };
        let quotes_today = HashMap::from([
            ("ETF".to_string(), quote("ETF", dec!(125))),
            ("GOLD".to_string(), quote("GOLD", dec!(75))),
        ]);

        let result = calculate_valuation(
            &snapshot,
            &quotes_today,
            &HashMap::new(),
            &HashMap::new(),
            target_date,
            "USD",
        )
        .unwrap();

        assert_eq!(result.investment_market_value, dec!(250));
        assert_eq!(result.total_value, dec!(260));
        assert_eq!(result.cost_basis, dec!(200));
        assert_eq!(result.cost_basis_base, dec!(200));
        assert_eq!(result.performance_eligible_value_base, dec!(260));
    }

    #[test]
    fn cash_balance_base_uses_calculated_cash_balance() {
        let target_date = NaiveDate::from_ymd_opt(2026, 5, 22).unwrap();
        let now = Utc::now();
        let snapshot = AccountStateSnapshot {
            id: "acc_1_2026-05-22".to_string(),
            account_id: "acc_1".to_string(),
            snapshot_date: target_date,
            currency: "CAD".to_string(),
            positions: HashMap::new(),
            cash_balances: HashMap::from([("CAD".to_string(), dec!(5988.44572355))]),
            cost_basis: Decimal::ZERO,
            net_contribution: Decimal::ZERO,
            net_contribution_base: Decimal::ZERO,
            cash_total_account_currency: dec!(4377.98972459),
            cash_total_base_currency: dec!(4377.98972459),
            calculated_at: now.naive_utc(),
            source: SnapshotSource::Calculated,
        };

        let result = calculate_valuation(
            &snapshot,
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            target_date,
            "CAD",
        )
        .unwrap();

        assert_eq!(result.cash_balance, dec!(5988.44572355));
        assert_eq!(result.cash_balance_base, dec!(5988.44572355));
        assert_eq!(result.total_value_base, dec!(5988.44572355));
    }

    #[test]
    fn cost_basis_base_uses_lot_acquisition_date_fx() {
        let target_date = NaiveDate::from_ymd_opt(2024, 6, 4).unwrap();
        let acquisition_date = DateTime::parse_from_rfc3339("2024-01-01T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);

        let lot = Lot {
            id: "lot-1".to_string(),
            position_id: "POS-ETF-acc_1".to_string(),
            acquisition_date,
            quantity: dec!(1),
            original_quantity: dec!(1),
            cost_basis: dec!(100),
            acquisition_price: dec!(100),
            acquisition_fees: Decimal::ZERO,
            original_acquisition_fees: Decimal::ZERO,
            fx_rate_to_position: None,
            source_activity_id: Some("buy-1".to_string()),
            split_ratio: Decimal::ONE,
        };

        let mut positions = HashMap::new();
        positions.insert(
            "ETF".to_string(),
            Position {
                id: "POS-ETF-acc_1".to_string(),
                account_id: "acc_1".to_string(),
                asset_id: "ETF".to_string(),
                quantity: dec!(1),
                average_cost: dec!(100),
                total_cost_basis: dec!(100),
                currency: "EUR".to_string(),
                inception_date: acquisition_date,
                lots: VecDeque::from([lot]),
                created_at: acquisition_date,
                last_updated: acquisition_date,
                is_alternative: false,
                contract_multiplier: Decimal::ONE,
            },
        );

        let snapshot = AccountStateSnapshot {
            id: "acc_1_2024-06-04".to_string(),
            account_id: "acc_1".to_string(),
            snapshot_date: target_date,
            currency: "USD".to_string(),
            positions,
            cash_balances: HashMap::new(),
            cost_basis: dec!(200),
            net_contribution: dec!(200),
            net_contribution_base: dec!(150),
            cash_total_account_currency: Decimal::ZERO,
            cash_total_base_currency: Decimal::ZERO,
            calculated_at: Utc::now().naive_utc(),
            source: SnapshotSource::Calculated,
        };

        let fx_rates_today = HashMap::from([(("EUR".to_string(), "USD".to_string()), dec!(2))]);
        let fx_rates_by_date = HashMap::from([(
            NaiveDate::from_ymd_opt(2024, 1, 1).unwrap(),
            HashMap::from([(("EUR".to_string(), "USD".to_string()), dec!(1.5))]),
        )]);

        let result = calculate_valuation(
            &snapshot,
            &HashMap::new(),
            &fx_rates_today,
            &fx_rates_by_date,
            target_date,
            "USD",
        )
        .unwrap();

        assert_eq!(result.cost_basis, dec!(200));
        assert_eq!(result.cost_basis_base, dec!(150.0));
    }
}
