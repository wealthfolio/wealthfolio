//! Bounded decimal arithmetic (architecture §4.3: no stage panics on user
//! data). `rust_decimal` panics on overflow, so every product or quotient of
//! user magnitudes goes through these helpers: a result above
//! [`MAX_MAGNITUDE`] is declined (`None`) and the caller rejects the event,
//! marks the day or declines the metric, with a diagnostic.

use rust_decimal::Decimal;

use crate::model::MAX_MAGNITUDE;

pub(crate) fn bounded(value: Decimal) -> Option<Decimal> {
    (value.abs() <= MAX_MAGNITUDE).then_some(value)
}

pub(crate) fn mul(left: Decimal, right: Decimal) -> Option<Decimal> {
    left.checked_mul(right).and_then(bounded)
}

/// `None` for a zero denominator as well.
pub(crate) fn div(numerator: Decimal, denominator: Decimal) -> Option<Decimal> {
    numerator.checked_div(denominator).and_then(bounded)
}

pub(crate) fn product(factors: &[Decimal]) -> Option<Decimal> {
    factors
        .iter()
        .try_fold(Decimal::ONE, |total, factor| mul(total, *factor))
}

/// `amount × part / total`, dividing first when the intermediate product
/// would leave the range (a part of an amount never exceeds it when
/// `part <= total`).
pub(crate) fn proportional(amount: Decimal, part: Decimal, total: Decimal) -> Option<Decimal> {
    if part == total {
        return Some(amount);
    }
    mul(amount, part)
        .and_then(|value| div(value, total))
        .or_else(|| div(amount, total).and_then(|value| mul(value, part)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    #[test]
    fn out_of_range_results_are_declined() {
        assert_eq!(mul(MAX_MAGNITUDE, dec!(2)), None);
        assert_eq!(mul(Decimal::MAX, Decimal::MAX), None);
        assert_eq!(div(dec!(1), Decimal::ZERO), None);
        assert_eq!(div(MAX_MAGNITUDE, dec!(0.5)), None);
        assert_eq!(product(&[dec!(1e10), dec!(1e10), dec!(10)]), None);
        assert_eq!(mul(dec!(2), dec!(3)), Some(dec!(6)));
    }

    #[test]
    fn proportional_divides_first_when_the_product_is_out_of_range() {
        let amount = dec!(1e15);
        let total = dec!(1e19);
        assert_eq!(
            proportional(amount, dec!(5e18), total),
            Some(dec!(500000000000000))
        );
        assert_eq!(proportional(amount, total, total), Some(amount));
        assert_eq!(proportional(amount, dec!(1), Decimal::ZERO), None);
    }
}
