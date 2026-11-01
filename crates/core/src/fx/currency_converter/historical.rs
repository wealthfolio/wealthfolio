use super::CurrencyConverter;
use crate::fx::fx_errors::FxError;
use chrono::NaiveDate;
use rust_decimal::Decimal;
use std::collections::{HashSet, VecDeque};

const MAX_CARRY_DAYS: i64 = 7;

/// Converts with an as-of policy that is safe for dated financial records.
///
/// The nearest quote for each edge must be on or before `date` and no more
/// than seven calendar days old. Keeping this selector separate preserves the
/// existing nearest-neighbor behavior used by live consumers.
pub(super) fn convert_amount_as_of(
    converter: &CurrencyConverter,
    amount: Decimal,
    from_currency: &str,
    to_currency: &str,
    date: NaiveDate,
) -> Result<Decimal, FxError> {
    if from_currency == to_currency {
        return Ok(amount);
    }

    let mut queue: VecDeque<(String, Decimal)> = VecDeque::new();
    let mut visited: HashSet<String> = HashSet::new();
    let mut edge_errors = Vec::new();

    queue.push_back((from_currency.to_string(), Decimal::ONE));
    visited.insert(from_currency.to_string());

    while let Some((current_currency, current_rate)) = queue.pop_front() {
        if current_currency == to_currency {
            return checked_mul(
                amount,
                current_rate,
                from_currency,
                to_currency,
                date,
                "amount",
            );
        }

        if let Some(neighbors) = converter.adj.get(&current_currency) {
            let mut neighbors: Vec<_> = neighbors.iter().collect();
            neighbors.sort_unstable();
            for neighbor in neighbors {
                if visited.contains(neighbor) {
                    continue;
                }

                match direct_rate_as_of(converter, &current_currency, neighbor, date) {
                    Ok(Some(rate)) => {
                        let accumulated_rate = checked_mul(
                            current_rate,
                            rate,
                            &current_currency,
                            neighbor,
                            date,
                            "path rate",
                        )?;
                        visited.insert(neighbor.clone());
                        queue.push_back((neighbor.clone(), accumulated_rate));
                    }
                    Ok(None) => {}
                    Err(error) => edge_errors.push(error.to_string()),
                }
            }
        }
    }

    if edge_errors.is_empty() {
        Err(FxError::RateNotFound(format!(
            "No historical conversion path found for {} -> {} on {}",
            from_currency, to_currency, date
        )))
    } else {
        Err(FxError::RateNotFound(format!(
            "No valid historical conversion path found for {} -> {} on {}: {}",
            from_currency,
            to_currency,
            date,
            edge_errors.join("; ")
        )))
    }
}

fn checked_mul(
    left: Decimal,
    right: Decimal,
    from_currency: &str,
    to_currency: &str,
    date: NaiveDate,
    context: &str,
) -> Result<Decimal, FxError> {
    left.checked_mul(right).ok_or_else(|| {
        FxError::ConversionError(format!(
            "Historical conversion overflow for {} -> {} on {} while multiplying {}",
            from_currency, to_currency, date, context
        ))
    })
}

fn direct_rate_as_of(
    converter: &CurrencyConverter,
    from_currency: &str,
    to_currency: &str,
    requested_date: NaiveDate,
) -> Result<Option<Decimal>, FxError> {
    let Some(history) = converter
        .rates
        .get(&(from_currency.to_string(), to_currency.to_string()))
    else {
        return Ok(None);
    };

    let Some((rate_date, rate)) = history.range(..=requested_date).next_back() else {
        let first_date = history
            .keys()
            .next()
            .expect("history is non-empty when its map exists");
        return Err(FxError::RateNotFound(format!(
            "No historical rate for {}/{} on or before {}; earliest available rate is {} (future-only)",
            from_currency, to_currency, requested_date, first_date
        )));
    };

    if *rate <= Decimal::ZERO {
        return Err(FxError::ConversionError(format!(
            "Invalid nonpositive historical rate for {}/{} on {}: {}",
            from_currency, to_currency, rate_date, rate
        )));
    }

    let age_days = (requested_date - *rate_date).num_days();
    if age_days > MAX_CARRY_DAYS {
        return Err(FxError::RateNotFound(format!(
            "Historical rate for {}/{} is stale: {} is {} days before requested date {}; maximum carry is {} days",
            from_currency, to_currency, rate_date, age_days, requested_date, MAX_CARRY_DAYS
        )));
    }

    Ok(Some(*rate))
}
