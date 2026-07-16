use crate::errors::{Error, Result};
use crate::fx::currency::{normalize_amount, normalize_currency_code};
use crate::fx::FxError;
use crate::portfolio::economic_events::BasisStatus;
use crate::portfolio::snapshot::AccountStateSnapshot;
use crate::portfolio::valuation::{DailyAccountValuation, ExternalFlowSource, ValuationStatus};
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
    calculate_valuation_with_price_factors(
        holdings_snapshot,
        quotes_today,
        fx_rates_today,
        fx_rates_by_date,
        target_date,
        base_currency,
        &HashMap::new(),
    )
}

/// Calculates valuation metrics with per-asset price factors for quote series
/// whose historical closes are already split-adjusted.
pub fn calculate_valuation_with_price_factors(
    holdings_snapshot: &AccountStateSnapshot, // Holdings for target_date
    quotes_today: &HashMap<String, Quote>,    // Market quotes for target_date
    fx_rates_today: &DailyFxRateMap,
    fx_rates_by_date: &HashMap<NaiveDate, DailyFxRateMap>,
    target_date: NaiveDate,
    base_currency: &str, // Pass base currency directly
    split_price_factors: &HashMap<String, Decimal>,
) -> Result<DailyAccountValuation> {
    let account_currency = &holdings_snapshot.currency;
    let normalized_account_currency = normalize_currency_code(account_currency);
    let normalized_base_currency = normalize_currency_code(base_currency);

    // --- 1. Calculate Market Values (Account Currency) ---
    let investment_valuation = calculate_investment_market_value_acct(
        holdings_snapshot,
        quotes_today,
        fx_rates_today,
        target_date,
        normalized_account_currency,
        split_price_factors,
    )?;

    let total_cash_value_acct_ccy = calculate_cash_value_acct(
        holdings_snapshot,
        fx_rates_today,
        target_date,
        normalized_account_currency,
    )?;

    // Total market value in account currency (investments + cash)
    let total_market_value_acct_ccy =
        investment_valuation.total_market_value + total_cash_value_acct_ccy;
    let cost_basis_acct_ccy = calculate_cost_basis_acct(
        holdings_snapshot,
        fx_rates_today,
        fx_rates_by_date,
        target_date,
        normalized_account_currency,
    )?;
    let book_basis_acct_ccy = cost_basis_acct_ccy + total_cash_value_acct_ccy;
    let net_contribution_acct_ccy = holdings_snapshot.net_contribution;

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
    let investment_market_value_base = investment_valuation.total_market_value * fx_rate_to_base;
    let total_value_base = cash_balance_base + investment_market_value_base;
    let cost_basis_base = calculate_cost_basis_base(
        holdings_snapshot,
        fx_rates_today,
        fx_rates_by_date,
        target_date,
        normalized_base_currency,
    )?;
    let book_basis_base = cost_basis_base + cash_balance_base;
    let net_contribution_base = holdings_snapshot.net_contribution_base;
    let performance_eligible_value_base = (investment_valuation.performance_eligible_market_value
        + total_cash_value_acct_ccy)
        * fx_rate_to_base;
    let value_status = investment_valuation.value_status(total_cash_value_acct_ccy);

    // --- 3. Construct Result using DailyAccountValuation structure ---
    let metrics = DailyAccountValuation {
        id: format!("{}_{}", holdings_snapshot.account_id, target_date),
        account_id: holdings_snapshot.account_id.clone(),
        valuation_date: target_date,
        account_currency: account_currency.to_string(),
        base_currency: base_currency.to_string(),
        fx_rate_to_base,
        cash_balance: total_cash_value_acct_ccy,
        investment_market_value: investment_valuation.total_market_value,
        total_value: total_market_value_acct_ccy,
        cost_basis: cost_basis_acct_ccy,
        book_basis: book_basis_acct_ccy,
        net_contribution: net_contribution_acct_ccy,
        cash_balance_base,
        investment_market_value_base,
        total_value_base,
        cost_basis_base,
        book_basis_base,
        net_contribution_base,
        external_inflow_base: Decimal::ZERO,
        external_outflow_base: Decimal::ZERO,
        external_flow_source: ExternalFlowSource::Unknown,
        performance_eligible_value_base,
        value_status,
        basis_status: investment_valuation.basis_status,
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
    calculate_cost_basis_in_currency(
        holdings_snapshot,
        fx_rates_today,
        fx_rates_by_date,
        target_date,
        base_currency,
    )
}

fn calculate_cost_basis_in_currency(
    holdings_snapshot: &AccountStateSnapshot,
    fx_rates_today: &DailyFxRateMap,
    fx_rates_by_date: &HashMap<NaiveDate, DailyFxRateMap>,
    target_date: NaiveDate,
    target_currency: &str,
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
            if position_currency != target_currency {
                warn!(
                    "Position {} has no materialized lots on {}. Falling back to valuation-date FX for cost basis.",
                    position.asset_id, target_date
                );
            }
            let rate = get_rate_from_map(
                fx_rates_today,
                position_currency,
                target_currency,
                target_date,
            )?;
            total += position.total_cost_basis * rate;
            continue;
        }

        for lot in &position.lots {
            if lot.cost_basis.is_zero() {
                continue;
            }
            if let Some(rate) = lot.stored_fx_rate_to(target_currency) {
                total += lot.cost_basis * rate;
                continue;
            }

            let acquisition_date = lot.acquisition_date_key();
            let empty_rates = DailyFxRateMap::new();
            let rates = fx_rates_by_date
                .get(&acquisition_date)
                .unwrap_or(&empty_rates);
            let rate =
                get_rate_from_map(rates, position_currency, target_currency, acquisition_date)?;
            total += lot.cost_basis * rate;
        }
    }

    Ok(total)
}

fn calculate_cost_basis_acct(
    holdings_snapshot: &AccountStateSnapshot,
    fx_rates_today: &DailyFxRateMap,
    fx_rates_by_date: &HashMap<NaiveDate, DailyFxRateMap>,
    target_date: NaiveDate,
    account_currency: &str,
) -> Result<Decimal> {
    calculate_cost_basis_in_currency(
        holdings_snapshot,
        fx_rates_today,
        fx_rates_by_date,
        target_date,
        account_currency,
    )
}

#[derive(Debug, Clone, PartialEq)]
struct InvestmentValuation {
    total_market_value: Decimal,
    performance_eligible_market_value: Decimal,
    priced_positions: u32,
    unpriced_positions: u32,
    basis_status: BasisStatus,
}

impl InvestmentValuation {
    fn value_status(&self, cash_value: Decimal) -> ValuationStatus {
        if self.unpriced_positions == 0 {
            ValuationStatus::Complete
        } else if self.priced_positions == 0 && cash_value.is_zero() {
            ValuationStatus::Unavailable
        } else {
            ValuationStatus::PartialUnpriced
        }
    }
}

/// Helper to calculate the total market value of investment positions in the account currency.
/// Alternative assets are net-worth-only and are excluded from investment valuation.
fn calculate_investment_market_value_acct(
    holdings_snapshot: &AccountStateSnapshot,
    quotes_today: &HashMap<String, Quote>,
    fx_rates_today: &DailyFxRateMap,
    target_date: NaiveDate,
    account_currency: &str,
    split_price_factors: &HashMap<String, Decimal>,
) -> Result<InvestmentValuation> {
    let mut total_position_market_value = Decimal::ZERO;
    let mut performance_eligible_market_value = Decimal::ZERO;
    let mut priced_positions = 0;
    let mut unpriced_positions = 0;
    let mut basis_status = BasisStatus::NotApplicable;

    for (asset_id, position) in &holdings_snapshot.positions {
        if position.is_alternative || position.quantity.is_zero() {
            continue;
        }

        basis_status = basis_status.combine(position.basis_status());

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

            let price_factor = split_price_factors
                .get(asset_id)
                .copied()
                .unwrap_or(Decimal::ONE);
            let valuation_price = normalized_price * price_factor;
            let market_value =
                position.quantity * valuation_price * position.contract_multiplier * quote_fx_rate;
            total_position_market_value += market_value;
            priced_positions += 1;
            if position.basis_status() == BasisStatus::Complete {
                performance_eligible_market_value += market_value;
            }
        } else {
            unpriced_positions += 1;
            warn!(
                "Missing quote for asset {} on date {}. Position market value treated as ZERO.",
                asset_id, target_date
            );
        }
    }
    Ok(InvestmentValuation {
        total_market_value: total_position_market_value,
        performance_eligible_market_value,
        priced_positions,
        unpriced_positions,
        basis_status,
    })
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

    fn test_position(asset_id: &str, quantity: Decimal, cost_basis: Decimal) -> Position {
        let now = Utc::now();
        Position {
            id: format!("POS-{asset_id}-acc_1"),
            account_id: "acc_1".to_string(),
            asset_id: asset_id.to_string(),
            quantity,
            average_cost: if quantity.is_zero() {
                Decimal::ZERO
            } else {
                cost_basis / quantity
            },
            total_cost_basis: cost_basis,
            currency: "USD".to_string(),
            inception_date: now,
            lots: VecDeque::new(),
            created_at: now,
            last_updated: now,
            is_alternative: false,
            contract_multiplier: Decimal::ONE,
        }
    }

    fn test_snapshot(positions: HashMap<String, Position>, cash: Decimal) -> AccountStateSnapshot {
        AccountStateSnapshot {
            id: "acc_1_2026-06-01".to_string(),
            account_id: "acc_1".to_string(),
            snapshot_date: NaiveDate::from_ymd_opt(2026, 6, 1).unwrap(),
            currency: "USD".to_string(),
            positions,
            cash_balances: if cash.is_zero() {
                HashMap::new()
            } else {
                HashMap::from([("USD".to_string(), cash)])
            },
            cost_basis: Decimal::ZERO,
            net_contribution: Decimal::ZERO,
            net_contribution_base: Decimal::ZERO,
            cash_total_account_currency: cash,
            cash_total_base_currency: cash,
            calculated_at: Utc::now().naive_utc(),
            source: SnapshotSource::Calculated,
        }
    }

    fn test_quote(asset_id: &str, close: Decimal) -> Quote {
        Quote {
            id: format!("quote-{asset_id}"),
            asset_id: asset_id.to_string(),
            timestamp: Utc::now(),
            open: close,
            high: close,
            low: close,
            close,
            adjclose: close,
            volume: Decimal::ZERO,
            currency: "USD".to_string(),
            data_source: "MANUAL".to_string(),
            created_at: Utc::now(),
            notes: None,
        }
    }

    #[test]
    fn partial_unpriced_position_is_typed_not_silent_zero() {
        let target_date = NaiveDate::from_ymd_opt(2026, 6, 1).unwrap();
        let positions = HashMap::from([
            (
                "PRICED".to_string(),
                test_position("PRICED", dec!(2), dec!(100)),
            ),
            (
                "UNPRICED".to_string(),
                test_position("UNPRICED", dec!(3), dec!(150)),
            ),
        ]);
        let snapshot = test_snapshot(positions, dec!(25));
        let quotes_today = HashMap::from([("PRICED".to_string(), test_quote("PRICED", dec!(80)))]);

        let result = calculate_valuation(
            &snapshot,
            &quotes_today,
            &HashMap::new(),
            &HashMap::new(),
            target_date,
            "USD",
        )
        .unwrap();

        assert_eq!(result.investment_market_value, dec!(160));
        assert_eq!(result.total_value, dec!(185));
        assert_eq!(result.value_status, ValuationStatus::PartialUnpriced);
        assert_eq!(result.basis_status, BasisStatus::Complete);
    }

    #[test]
    fn split_price_factor_adjusts_quote_basis_without_changing_quantity() {
        let target_date = NaiveDate::from_ymd_opt(2025, 11, 14).unwrap();
        let positions = HashMap::from([(
            "NFLX".to_string(),
            test_position("NFLX", dec!(20), dec!(200)),
        )]);
        let snapshot = test_snapshot(positions, Decimal::ZERO);
        let quotes_today = HashMap::from([("NFLX".to_string(), test_quote("NFLX", dec!(100)))]);
        let split_price_factors = HashMap::from([("NFLX".to_string(), dec!(10))]);

        let result = calculate_valuation_with_price_factors(
            &snapshot,
            &quotes_today,
            &HashMap::new(),
            &HashMap::new(),
            target_date,
            "USD",
            &split_price_factors,
        )
        .unwrap();

        assert_eq!(snapshot.positions.get("NFLX").unwrap().quantity, dec!(20));
        assert_eq!(result.investment_market_value, dec!(20000));
        assert_eq!(result.total_value, dec!(20000));
        assert_eq!(result.performance_eligible_value_base, dec!(20000));
    }

    #[test]
    fn fully_unpriced_position_is_unavailable_not_complete_zero() {
        let target_date = NaiveDate::from_ymd_opt(2026, 6, 1).unwrap();
        let positions = HashMap::from([(
            "MANUAL".to_string(),
            test_position("MANUAL", dec!(3), dec!(150)),
        )]);
        let snapshot = test_snapshot(positions, Decimal::ZERO);

        let result = calculate_valuation(
            &snapshot,
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            target_date,
            "USD",
        )
        .unwrap();

        assert_eq!(result.investment_market_value, Decimal::ZERO);
        assert_eq!(result.total_value, Decimal::ZERO);
        assert_eq!(result.value_status, ValuationStatus::Unavailable);
        assert_eq!(result.basis_status, BasisStatus::Complete);
    }

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
        assert_eq!(result.performance_eligible_value_base, Decimal::ZERO);
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
    fn non_calculated_snapshot_derives_book_basis_without_overwriting_net_contribution() {
        let target_date = NaiveDate::from_ymd_opt(2026, 5, 22).unwrap();
        let now = Utc::now();
        let mut positions = HashMap::new();
        positions.insert(
            "AAPL".to_string(),
            Position {
                id: "POS-AAPL-acc_1".to_string(),
                account_id: "acc_1".to_string(),
                asset_id: "AAPL".to_string(),
                quantity: dec!(100),
                average_cost: dec!(50),
                total_cost_basis: dec!(5000),
                currency: "CAD".to_string(),
                inception_date: now,
                lots: VecDeque::new(),
                created_at: now,
                last_updated: now,
                is_alternative: false,
                contract_multiplier: Decimal::ONE,
            },
        );
        let snapshot = AccountStateSnapshot {
            id: "acc_1_2026-05-22".to_string(),
            account_id: "acc_1".to_string(),
            snapshot_date: target_date,
            currency: "CAD".to_string(),
            positions,
            cash_balances: HashMap::from([("CAD".to_string(), dec!(250))]),
            cost_basis: dec!(5000),
            net_contribution: Decimal::ZERO,
            net_contribution_base: Decimal::ZERO,
            cash_total_account_currency: Decimal::ZERO,
            cash_total_base_currency: Decimal::ZERO,
            calculated_at: now.naive_utc(),
            source: SnapshotSource::ManualEntry,
        };
        let quote = Quote {
            id: "quote-aapl".to_string(),
            asset_id: "AAPL".to_string(),
            timestamp: now,
            open: dec!(200),
            high: dec!(200),
            low: dec!(200),
            close: dec!(200),
            adjclose: dec!(200),
            volume: Decimal::ZERO,
            currency: "CAD".to_string(),
            data_source: "MANUAL".to_string(),
            created_at: now,
            notes: None,
        };

        let result = calculate_valuation(
            &snapshot,
            &HashMap::from([("AAPL".to_string(), quote)]),
            &HashMap::new(),
            &HashMap::new(),
            target_date,
            "CAD",
        )
        .unwrap();

        assert_eq!(result.investment_market_value, dec!(20000));
        assert_eq!(result.cash_balance, dec!(250));
        assert_eq!(result.total_value, dec!(20250));
        assert_eq!(result.book_basis, dec!(5250));
        assert_eq!(result.book_basis_base, dec!(5250));
        assert_eq!(result.net_contribution, Decimal::ZERO);
        assert_eq!(result.net_contribution_base, Decimal::ZERO);
    }

    #[test]
    fn cost_basis_uses_lot_acquisition_date_fx() {
        let target_date = NaiveDate::from_ymd_opt(2024, 6, 4).unwrap();
        let acquisition_date = DateTime::parse_from_rfc3339("2024-01-01T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let now = Utc::now();

        let lot = Lot {
            id: "lot-1".to_string(),
            position_id: "POS-ETF-acc_1".to_string(),
            acquisition_date,
            acquisition_local_date: Some(NaiveDate::from_ymd_opt(2024, 1, 1).unwrap()),
            quantity: dec!(1),
            original_quantity: dec!(1),
            cost_basis: dec!(100),
            acquisition_price: dec!(100),
            acquisition_fees: Decimal::ZERO,
            original_acquisition_fees: Decimal::ZERO,
            acquisition_taxes: Decimal::ZERO,
            original_acquisition_taxes: Decimal::ZERO,
            fx_rate_to_position: None,
            fx_rate_to_account: None,
            account_currency: None,
            fx_rate_to_base: None,
            base_currency: None,
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

        let quote = Quote {
            id: "quote-etf".to_string(),
            asset_id: "ETF".to_string(),
            timestamp: now,
            open: dec!(120),
            high: dec!(120),
            low: dec!(120),
            close: dec!(120),
            adjclose: dec!(120),
            volume: Decimal::ZERO,
            currency: "EUR".to_string(),
            data_source: "MANUAL".to_string(),
            created_at: now,
            notes: None,
        };

        let result = calculate_valuation(
            &snapshot,
            &HashMap::from([("ETF".to_string(), quote)]),
            &fx_rates_today,
            &fx_rates_by_date,
            target_date,
            "USD",
        )
        .unwrap();

        assert_eq!(result.investment_market_value, dec!(240));
        assert_eq!(result.cost_basis, dec!(150.0));
        assert_eq!(result.cost_basis_base, dec!(150.0));
    }

    #[test]
    fn cost_basis_prefers_stored_lot_fx_over_market_fx() {
        let target_date = NaiveDate::from_ymd_opt(2026, 6, 22).unwrap();
        let acquisition_date = DateTime::parse_from_rfc3339("2026-06-20T23:30:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let acquisition_local_date = NaiveDate::from_ymd_opt(2026, 6, 20).unwrap();
        let now = Utc::now();

        let lot = Lot {
            id: "lot-1".to_string(),
            position_id: "POS-US-STOCK-acc_1".to_string(),
            acquisition_date,
            acquisition_local_date: Some(acquisition_local_date),
            quantity: dec!(1),
            original_quantity: dec!(1),
            cost_basis: dec!(100),
            acquisition_price: dec!(100),
            acquisition_fees: Decimal::ZERO,
            original_acquisition_fees: Decimal::ZERO,
            acquisition_taxes: Decimal::ZERO,
            original_acquisition_taxes: Decimal::ZERO,
            fx_rate_to_position: None,
            fx_rate_to_account: Some(dec!(1.3586)),
            account_currency: Some("SGD".to_string()),
            fx_rate_to_base: Some(dec!(1.3586)),
            base_currency: Some("SGD".to_string()),
            source_activity_id: Some("transfer-in-1".to_string()),
            split_ratio: Decimal::ONE,
        };

        let snapshot = AccountStateSnapshot {
            id: "acc_1_2026-06-22".to_string(),
            account_id: "acc_1".to_string(),
            snapshot_date: target_date,
            currency: "SGD".to_string(),
            positions: HashMap::from([(
                "US-STOCK".to_string(),
                Position {
                    id: "POS-US-STOCK-acc_1".to_string(),
                    account_id: "acc_1".to_string(),
                    asset_id: "US-STOCK".to_string(),
                    quantity: dec!(1),
                    average_cost: dec!(100),
                    total_cost_basis: dec!(100),
                    currency: "USD".to_string(),
                    inception_date: acquisition_date,
                    lots: VecDeque::from([lot]),
                    created_at: acquisition_date,
                    last_updated: acquisition_date,
                    is_alternative: false,
                    contract_multiplier: Decimal::ONE,
                },
            )]),
            cash_balances: HashMap::new(),
            cost_basis: dec!(135.86),
            net_contribution: dec!(135.86),
            net_contribution_base: dec!(135.86),
            cash_total_account_currency: Decimal::ZERO,
            cash_total_base_currency: Decimal::ZERO,
            calculated_at: Utc::now().naive_utc(),
            source: SnapshotSource::Calculated,
        };

        let market_rate = dec!(1.2903);
        let fx_rates_today = HashMap::from([(("USD".to_string(), "SGD".to_string()), market_rate)]);
        let fx_rates_by_date = HashMap::from([(
            acquisition_local_date,
            HashMap::from([(("USD".to_string(), "SGD".to_string()), market_rate)]),
        )]);
        let quote = Quote {
            id: "quote-us-stock".to_string(),
            asset_id: "US-STOCK".to_string(),
            timestamp: now,
            open: dec!(100),
            high: dec!(100),
            low: dec!(100),
            close: dec!(100),
            adjclose: dec!(100),
            volume: Decimal::ZERO,
            currency: "USD".to_string(),
            data_source: "MANUAL".to_string(),
            created_at: now,
            notes: None,
        };

        let result = calculate_valuation(
            &snapshot,
            &HashMap::from([("US-STOCK".to_string(), quote)]),
            &fx_rates_today,
            &fx_rates_by_date,
            target_date,
            "SGD",
        )
        .unwrap();

        assert_eq!(result.investment_market_value, dec!(129.0300));
        assert_eq!(result.cost_basis, dec!(135.8600));
        assert_eq!(result.cost_basis_base, dec!(135.8600));
    }
}
