use super::model::{TaxBucketBalances, TaxProfile};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TaxBucketKind {
    Taxable,
    TaxDeferred,
    TaxFree,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct WithdrawalOutcome {
    pub remaining_buckets: TaxBucketBalances,
    pub gross_withdrawal: f64,
    pub spending_funded: f64,
    pub tax_amount: f64,
}

/// Build the retirement tax buckets used by the engine.
///
/// Prepared goal-based plans populate explicit bucket balances. Older/manual plans
/// fall back to "all taxable" so existing requests continue to run.
pub(crate) fn initial_withdrawal_buckets(
    tax: &Option<TaxProfile>,
    total_portfolio: f64,
) -> TaxBucketBalances {
    match tax {
        Some(profile) => profile.withdrawal_buckets.scale_to_total(total_portfolio),
        None => TaxBucketBalances {
            taxable: total_portfolio.max(0.0),
            ..TaxBucketBalances::default()
        },
    }
}

pub(crate) fn apply_growth(buckets: TaxBucketBalances, annual_return: f64) -> TaxBucketBalances {
    let growth = 1.0 + annual_return;
    if !growth.is_finite() || growth <= 0.0 {
        return TaxBucketBalances::default();
    }
    TaxBucketBalances {
        taxable: buckets.taxable * growth,
        tax_deferred: buckets.tax_deferred * growth,
        tax_free: buckets.tax_free * growth,
        // Unrealized growth, not basis: leaving this flat while the balance grows
        // is what widens the taxable gain fraction over the accumulation phase.
        taxable_cost_basis: buckets.taxable_cost_basis,
    }
}

pub(crate) fn add_contribution(
    buckets: TaxBucketBalances,
    contribution: f64,
    tax: &Option<TaxProfile>,
) -> TaxBucketBalances {
    if contribution <= 0.0 {
        return buckets;
    }
    let allocation = match tax {
        Some(profile) => profile.withdrawal_buckets.scale_to_total(contribution),
        None => TaxBucketBalances {
            taxable: contribution,
            ..TaxBucketBalances::default()
        },
    };
    TaxBucketBalances {
        taxable: buckets.taxable + allocation.taxable,
        tax_deferred: buckets.tax_deferred + allocation.tax_deferred,
        tax_free: buckets.tax_free + allocation.tax_free,
        // Freshly contributed cash is already-taxed principal, not gain yet.
        taxable_cost_basis: buckets.taxable_cost_basis + allocation.taxable,
    }
}

/// Gross up a net spending gap for display-only tax estimates.
///
/// The projection ledger withdraws from finite bucket balances. This helper is
/// used by budget/reconciliation DTOs, so it uses the configured bucket mix as a
/// tax-rate blend and does not cap estimates by today's balances.
pub(crate) fn compute_gross_withdrawal(
    spending_gap: f64,
    tax: &Option<TaxProfile>,
    age: u32,
) -> (f64, f64) {
    if spending_gap <= 0.0 {
        return (0.0, 0.0);
    }
    let Some(profile) = tax else {
        return (spending_gap, 0.0);
    };

    let buckets = profile.withdrawal_buckets;
    let total = buckets.total();
    let rate = if total > 0.0 {
        let taxable = buckets.taxable / total;
        let deferred = buckets.tax_deferred / total;
        let tax_free = buckets.tax_free / total;
        taxable
            * effective_tax_rate(profile, TaxBucketKind::Taxable, age)
            * buckets.taxable_gain_fraction()
            + deferred * effective_tax_rate(profile, TaxBucketKind::TaxDeferred, age)
            + tax_free * effective_tax_rate(profile, TaxBucketKind::TaxFree, age)
    } else {
        // No bucket breakdown at all: fall back to the flat configured rate,
        // same as before this bucket carried a cost-basis estimate.
        effective_tax_rate(profile, TaxBucketKind::Taxable, age)
    }
    .clamp(0.0, 0.99);

    let gross = spending_gap / (1.0 - rate);
    (gross, gross - spending_gap)
}

/// Fund the planned annual spending gap for one year.
pub(crate) fn apply_planned_spending_withdrawal(
    available_buckets: &TaxBucketBalances,
    total_expenses: f64,
    income: f64,
    tax: &Option<TaxProfile>,
    age: u32,
) -> WithdrawalOutcome {
    let spending_gap = (total_expenses - income).max(0.0);
    withdraw_for_net_target(spending_gap, *available_buckets, tax, age)
}

fn withdraw_for_net_target(
    net_target: f64,
    buckets: TaxBucketBalances,
    tax: &Option<TaxProfile>,
    age: u32,
) -> WithdrawalOutcome {
    if net_target <= 0.0 || buckets.total() <= 0.0 {
        return WithdrawalOutcome {
            remaining_buckets: buckets,
            gross_withdrawal: 0.0,
            spending_funded: 0.0,
            tax_amount: 0.0,
        };
    }

    let mut remaining = buckets;
    let mut remaining_net = net_target;
    let mut gross_withdrawal = 0.0;
    let mut spending_funded = 0.0;
    let mut tax_amount = 0.0;

    for kind in [
        TaxBucketKind::Taxable,
        TaxBucketKind::TaxDeferred,
        TaxBucketKind::TaxFree,
    ] {
        if remaining_net <= 0.0 {
            break;
        }
        let available_gross = bucket_balance(remaining, kind);
        if available_gross <= 0.0 {
            continue;
        }
        let rate = match kind {
            // Only the unrealized-gain share of a taxable-bucket withdrawal is
            // taxed; the rest is already-taxed principal coming back out.
            TaxBucketKind::Taxable => {
                effective_tax_rate_for_kind(tax, kind, age) * remaining.taxable_gain_fraction()
            }
            _ => effective_tax_rate_for_kind(tax, kind, age),
        };
        let net_per_gross = (1.0 - rate).max(0.01);
        let needed_gross = remaining_net / net_per_gross;
        let gross_from_bucket = available_gross.min(needed_gross);
        let net_from_bucket = gross_from_bucket * net_per_gross;

        set_bucket_balance(&mut remaining, kind, available_gross - gross_from_bucket);
        if kind == TaxBucketKind::Taxable {
            // Average-cost method: withdrawing X% of the taxable balance also
            // realizes X% of its remaining cost basis, so the gain fraction stays
            // consistent for the next growth/withdrawal step.
            remaining.taxable_cost_basis *= 1.0 - (gross_from_bucket / available_gross);
        }
        gross_withdrawal += gross_from_bucket;
        spending_funded += net_from_bucket;
        tax_amount += gross_from_bucket - net_from_bucket;
        remaining_net -= net_from_bucket;
    }

    WithdrawalOutcome {
        remaining_buckets: remaining,
        gross_withdrawal,
        spending_funded,
        tax_amount,
    }
}

fn effective_tax_rate_for_kind(tax: &Option<TaxProfile>, kind: TaxBucketKind, age: u32) -> f64 {
    tax.as_ref()
        .map(|profile| effective_tax_rate(profile, kind, age))
        .unwrap_or(0.0)
}

fn effective_tax_rate(profile: &TaxProfile, kind: TaxBucketKind, age: u32) -> f64 {
    let mut rate = match kind {
        TaxBucketKind::Taxable => profile.taxable_withdrawal_rate,
        TaxBucketKind::TaxDeferred => profile.tax_deferred_withdrawal_rate,
        TaxBucketKind::TaxFree => profile.tax_free_withdrawal_rate,
    };
    if kind == TaxBucketKind::TaxDeferred {
        if let (Some(penalty), Some(penalty_age)) = (
            profile.early_withdrawal_penalty_rate,
            profile.early_withdrawal_penalty_age,
        ) {
            if age < penalty_age {
                rate += penalty;
            }
        }
    }
    rate.clamp(0.0, 0.99)
}

fn bucket_balance(buckets: TaxBucketBalances, kind: TaxBucketKind) -> f64 {
    match kind {
        TaxBucketKind::Taxable => buckets.taxable,
        TaxBucketKind::TaxDeferred => buckets.tax_deferred,
        TaxBucketKind::TaxFree => buckets.tax_free,
    }
}

fn set_bucket_balance(buckets: &mut TaxBucketBalances, kind: TaxBucketKind, value: f64) {
    match kind {
        TaxBucketKind::Taxable => buckets.taxable = value.max(0.0),
        TaxBucketKind::TaxDeferred => buckets.tax_deferred = value.max(0.0),
        TaxBucketKind::TaxFree => buckets.tax_free = value.max(0.0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::planning::retirement::*;

    fn tax_with_buckets() -> Option<TaxProfile> {
        Some(TaxProfile {
            taxable_withdrawal_rate: 0.20,
            tax_deferred_withdrawal_rate: 0.30,
            tax_free_withdrawal_rate: 0.0,
            early_withdrawal_penalty_rate: None,
            early_withdrawal_penalty_age: None,
            country_code: None,
            withdrawal_buckets: TaxBucketBalances {
                taxable: 50_000.0,
                tax_deferred: 50_000.0,
                tax_free: 0.0,
                ..TaxBucketBalances::default()
            },
        })
    }

    #[test]
    fn initial_buckets_fall_back_to_taxable() {
        let buckets = initial_withdrawal_buckets(&None, 100_000.0);
        assert_eq!(
            buckets,
            TaxBucketBalances {
                taxable: 100_000.0,
                ..TaxBucketBalances::default()
            }
        );
    }

    #[test]
    fn compute_gross_withdrawal_uses_bucket_mix_without_balance_cap() {
        let (gross, tax_amt) = compute_gross_withdrawal(60_000.0, &tax_with_buckets(), 60);
        // Display gross-up uses the bucket mix as a blended rate and does not
        // stop at today's finite bucket balances.
        assert!((gross - 80_000.0).abs() < 0.1, "gross = {}", gross);
        assert!((tax_amt - 20_000.0).abs() < 0.1, "tax = {}", tax_amt);
    }

    #[test]
    fn apply_growth_depletes_on_invalid_tail_returns() {
        let buckets = TaxBucketBalances {
            taxable: 100.0,
            tax_deferred: 200.0,
            tax_free: 300.0,
            ..TaxBucketBalances::default()
        };

        assert_eq!(apply_growth(buckets, -1.0), TaxBucketBalances::default());
        assert_eq!(apply_growth(buckets, -1.25), TaxBucketBalances::default());
        assert_eq!(
            apply_growth(buckets, f64::NAN),
            TaxBucketBalances::default()
        );
    }

    #[test]
    fn tax_early_withdrawal_penalty_hits_tax_deferred_only() {
        let tax = Some(TaxProfile {
            taxable_withdrawal_rate: 0.20,
            tax_deferred_withdrawal_rate: 0.20,
            tax_free_withdrawal_rate: 0.0,
            early_withdrawal_penalty_rate: Some(0.10),
            early_withdrawal_penalty_age: Some(59),
            country_code: None,
            withdrawal_buckets: TaxBucketBalances {
                taxable: 0.0,
                tax_deferred: 100_000.0,
                tax_free: 0.0,
                ..TaxBucketBalances::default()
            },
        });
        let (gross_early, _) = compute_gross_withdrawal(40_000.0, &tax, 50);
        let (gross_late, _) = compute_gross_withdrawal(40_000.0, &tax, 60);
        assert!(
            (gross_early - 57_142.86).abs() < 0.1,
            "early = {}",
            gross_early
        );
        assert!((gross_late - 50_000.0).abs() < 0.1, "late = {}", gross_late);
    }

    #[test]
    fn planned_spending_returns_correct_tuple() {
        let outcome = apply_planned_spending_withdrawal(
            &TaxBucketBalances {
                taxable: 50_000.0,
                tax_deferred: 50_000.0,
                tax_free: 0.0,
                ..TaxBucketBalances::default()
            },
            70_000.0,
            10_000.0,
            &tax_with_buckets(),
            65,
        );
        assert!(
            (outcome.gross_withdrawal - 78_571.43).abs() < 0.1,
            "gross = {}",
            outcome.gross_withdrawal
        );
        assert!(
            (outcome.spending_funded - 60_000.0).abs() < 0.1,
            "spending = {}",
            outcome.spending_funded
        );
        assert!((outcome.tax_amount - 18_571.43).abs() < 0.1);
    }

    #[test]
    fn no_tax_profile_passthrough() {
        let (gross, tax) = compute_gross_withdrawal(40_000.0, &None, 60);
        assert!((gross - 40_000.0).abs() < 0.01);
        assert!((tax - 0.0).abs() < 0.01);
    }

    #[test]
    fn contribution_allocation_uses_bucket_mix() {
        let buckets = add_contribution(TaxBucketBalances::default(), 100.0, &tax_with_buckets());
        assert!((buckets.taxable - 50.0).abs() < 0.01);
        assert!((buckets.tax_deferred - 50.0).abs() < 0.01);
        assert!((buckets.tax_free - 0.0).abs() < 0.01);
        // Fresh cash is already-taxed principal, so it becomes cost basis immediately.
        assert!((buckets.taxable_cost_basis - 50.0).abs() < 0.01);
    }

    #[test]
    fn taxable_gain_fraction_reflects_cost_basis() {
        let buckets = TaxBucketBalances {
            taxable: 100_000.0,
            taxable_cost_basis: 40_000.0,
            ..TaxBucketBalances::default()
        };
        assert!((buckets.taxable_gain_fraction() - 0.6).abs() < 1e-9);

        let underwater = TaxBucketBalances {
            taxable: 50_000.0,
            taxable_cost_basis: 80_000.0,
            ..TaxBucketBalances::default()
        };
        assert_eq!(underwater.taxable_gain_fraction(), 0.0);

        assert_eq!(TaxBucketBalances::default().taxable_gain_fraction(), 0.0);
    }

    #[test]
    fn apply_growth_leaves_cost_basis_unchanged() {
        let buckets = TaxBucketBalances {
            taxable: 100_000.0,
            taxable_cost_basis: 60_000.0,
            ..TaxBucketBalances::default()
        };
        let grown = apply_growth(buckets, 0.10);
        assert!((grown.taxable - 110_000.0).abs() < 0.1);
        assert!((grown.taxable_cost_basis - 60_000.0).abs() < 0.1);
        // Same basis on a larger balance: gain fraction widens as it compounds.
        assert!(grown.taxable_gain_fraction() > buckets.taxable_gain_fraction());
    }

    #[test]
    fn compute_gross_withdrawal_taxes_only_unrealized_gain() {
        let tax = Some(TaxProfile {
            taxable_withdrawal_rate: 0.20,
            tax_deferred_withdrawal_rate: 0.0,
            tax_free_withdrawal_rate: 0.0,
            early_withdrawal_penalty_rate: None,
            early_withdrawal_penalty_age: None,
            country_code: None,
            withdrawal_buckets: TaxBucketBalances {
                taxable: 100_000.0,
                taxable_cost_basis: 60_000.0, // 40% of the bucket is unrealized gain
                ..TaxBucketBalances::default()
            },
        });
        let (gross, tax_amt) = compute_gross_withdrawal(92_000.0, &tax, 60);
        // Effective rate = 20% * 40% gain fraction = 8%, not the full 20%.
        assert!((gross - 100_000.0).abs() < 0.1, "gross = {}", gross);
        assert!((tax_amt - 8_000.0).abs() < 0.1, "tax = {}", tax_amt);
    }

    #[test]
    fn taxable_withdrawal_reduces_cost_basis_pro_rata() {
        let tax = Some(TaxProfile {
            taxable_withdrawal_rate: 0.20,
            tax_deferred_withdrawal_rate: 0.0,
            tax_free_withdrawal_rate: 0.0,
            early_withdrawal_penalty_rate: None,
            early_withdrawal_penalty_age: None,
            country_code: None,
            withdrawal_buckets: TaxBucketBalances::default(),
        });
        let buckets = TaxBucketBalances {
            taxable: 100_000.0,
            taxable_cost_basis: 60_000.0,
            ..TaxBucketBalances::default()
        };
        // Net target 46,000 at an 8% effective rate (20% * 40% gain) needs 50,000 gross.
        let outcome = apply_planned_spending_withdrawal(&buckets, 46_000.0, 0.0, &tax, 60);
        assert!((outcome.gross_withdrawal - 50_000.0).abs() < 0.1);
        assert!((outcome.spending_funded - 46_000.0).abs() < 0.1);
        assert!((outcome.tax_amount - 4_000.0).abs() < 0.1);
        // Half the balance withdrawn realizes half the remaining cost basis too.
        assert!(
            (outcome.remaining_buckets.taxable_cost_basis - 30_000.0).abs() < 0.1,
            "remaining basis = {}",
            outcome.remaining_buckets.taxable_cost_basis
        );
        assert!((outcome.remaining_buckets.taxable - 50_000.0).abs() < 0.1);
    }
}
