//! Rate conversion only. Calendar accrual and money posting belong to the ledger.
use serde::{Deserialize, Serialize};

use super::LoanFrequency;

/// The convention is explicit; currency and liability type cannot determine it.
#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum InterestMethod {
    /// Compatibility with loans entered before an interest convention was recorded.
    #[default]
    NominalPeriodic,
    Monthly,
    Semiannual,
}

impl InterestMethod {
    pub fn periodic_rate(self, annual_percent: f64, frequency: LoanFrequency) -> f64 {
        let annual = annual_percent / 100.0;
        let periods = frequency.periods();
        let compounds = match self {
            Self::NominalPeriodic => return annual / periods,
            Self::Monthly => 12.0,
            Self::Semiannual => 2.0,
        };
        // ln_1p/exp_m1 remain accurate near zero, where powf(x) - 1 loses precision.
        ((annual / compounds).ln_1p() * compounds / periods).exp_m1()
    }
}

/// Unrounded level payment. Callers round the contractual payment to currency cents.
/// Accelerated biweekly means half a monthly payment over the same amortization.
pub fn payment_amount(
    principal: f64,
    annual_percent: f64,
    payment_count: usize,
    frequency: LoanFrequency,
    method: InterestMethod,
) -> Option<f64> {
    if !super::valid_amount(principal)
        || !annual_percent.is_finite()
        || !(0.0..=100.0).contains(&annual_percent)
        || !(1..=super::MAX_PAYMENTS).contains(&payment_count)
    {
        return None;
    }
    let (periods, count, divisor) = if frequency == LoanFrequency::AcceleratedBiweekly {
        (
            LoanFrequency::Monthly,
            payment_count as f64 * 12.0 / 26.0,
            2.0,
        )
    } else {
        (frequency, payment_count as f64, 1.0)
    };
    let rate = method.periodic_rate(annual_percent, periods);
    Some(if rate == 0.0 {
        principal / count / divisor
    } else {
        principal * rate / -(-count * rate.ln_1p()).exp_m1() / divisor
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_and_near_zero_rates_are_stable() {
        for rate in [0.0, 1e-12] {
            let amount = payment_amount(
                1200.0,
                rate,
                12,
                LoanFrequency::Monthly,
                InterestMethod::Semiannual,
            )
            .unwrap();
            assert!((amount - 100.0).abs() < 1e-8);
        }
    }

    #[test]
    fn compounding_frequency_is_independent_of_payment_frequency() {
        let rate = InterestMethod::Semiannual.periodic_rate(5.0, LoanFrequency::Biweekly);
        assert!(((1.0 + rate).powi(26) - 1.025_f64.powi(2)).abs() < 1e-12);
        assert_eq!(
            rate,
            InterestMethod::Semiannual.periodic_rate(5.0, LoanFrequency::AcceleratedBiweekly)
        );
    }
}
