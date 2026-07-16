use crate::errors::{Error as CoreError, Result as CoreResult, ValidationError};
use rust_decimal::Decimal;

use super::model::{NewAllocationTarget, NewAllocationTargetWeight, ScopeType};

fn invalid(msg: &str) -> CoreError {
    CoreError::Validation(ValidationError::InvalidInput(msg.to_string()))
}

pub fn validate_new_target(input: &NewAllocationTarget) -> CoreResult<()> {
    if input.name.trim().is_empty() {
        return Err(invalid("Target name is required"));
    }
    if matches!(input.scope_type, ScopeType::Account | ScopeType::Portfolio)
        && input.scope_id.is_none()
    {
        return Err(invalid("scope_id required for account/portfolio scope"));
    }
    if matches!(input.scope_type, ScopeType::All) && input.scope_id.is_some() {
        return Err(invalid("scope_id must be null for all scope"));
    }
    if input.drift_band_bps < 0 || input.drift_band_bps > 10000 {
        return Err(invalid("drift_band_bps must be between 0 and 10000"));
    }
    if let Some(factor) = input.relative_factor_bps {
        if !(0..=10000).contains(&factor) {
            return Err(invalid("relative_factor_bps must be between 0 and 10000"));
        }
    }
    if let Some(max_turnover_bps) = input.max_turnover_bps {
        if !(0..=10000).contains(&max_turnover_bps) {
            return Err(invalid("max_turnover_bps must be between 0 and 10000"));
        }
    }
    if let Some(min_trade_amount) = &input.min_trade_amount {
        let amount = min_trade_amount
            .parse::<Decimal>()
            .map_err(|_| invalid("min_trade_amount must be a valid decimal"))?;
        if amount < Decimal::ZERO {
            return Err(invalid("min_trade_amount must be non-negative"));
        }
    }
    Ok(())
}

pub fn validate_weights_sum(weights: &[NewAllocationTargetWeight]) -> CoreResult<()> {
    let total: i32 = weights.iter().map(|n| n.target_bps).sum();
    if total != 10000 {
        return Err(invalid(&format!(
            "Target allocations must sum to 10000 bps (100%), got {total}"
        )));
    }
    let mut seen = std::collections::HashSet::new();
    for weight in weights {
        if weight.target_bps < 0 || weight.target_bps > 10000 {
            return Err(invalid(&format!(
                "target_bps for category {} must be between 0 and 10000",
                weight.category_id
            )));
        }
        if !seen.insert(&weight.category_id) {
            return Err(invalid(&format!(
                "Duplicate category_id: {}",
                weight.category_id
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::portfolio::allocation_targets::model::TriggerType;

    fn base_target(name: &str) -> NewAllocationTarget {
        NewAllocationTarget {
            name: name.to_string(),
            scope_type: ScopeType::All,
            scope_id: None,
            taxonomy_id: "asset_classes".to_string(),
            trigger_type: TriggerType::Threshold,
            drift_band_bps: 500,
            band_type: None,
            relative_factor_bps: None,
            rebalance_goal: None,
            min_trade_amount: None,
            whole_shares_only: None,
            allow_sells: None,
            max_turnover_bps: None,
        }
    }

    fn weight(category_id: &str, bps: i32) -> NewAllocationTargetWeight {
        NewAllocationTargetWeight {
            category_id: category_id.to_string(),
            target_bps: bps,
            is_locked: false,
            is_required: true,
        }
    }

    // ── validate_new_target ─────────────────────────────────────────────────

    #[test]
    fn target_empty_name_rejected() {
        let p = base_target("  ");
        assert!(validate_new_target(&p).is_err());
    }

    #[test]
    fn target_valid_passes() {
        assert!(validate_new_target(&base_target("My target")).is_ok());
    }

    #[test]
    fn target_account_scope_requires_scope_id() {
        let p = NewAllocationTarget {
            scope_type: ScopeType::Account,
            scope_id: None,
            ..base_target("p")
        };
        assert!(validate_new_target(&p).is_err());
    }

    #[test]
    fn target_account_scope_with_scope_id_passes() {
        let p = NewAllocationTarget {
            scope_type: ScopeType::Account,
            scope_id: Some("acc-1".to_string()),
            ..base_target("p")
        };
        assert!(validate_new_target(&p).is_ok());
    }

    #[test]
    fn target_all_scope_rejects_scope_id() {
        let p = NewAllocationTarget {
            scope_id: Some("unexpected".to_string()),
            ..base_target("p")
        };
        assert!(validate_new_target(&p).is_err());
    }

    #[test]
    fn target_drift_band_out_of_range_rejected() {
        let p = NewAllocationTarget {
            drift_band_bps: 10001,
            ..base_target("p")
        };
        assert!(validate_new_target(&p).is_err());
    }

    #[test]
    fn target_drift_band_zero_allowed() {
        let p = NewAllocationTarget {
            drift_band_bps: 0,
            ..base_target("p")
        };
        assert!(validate_new_target(&p).is_ok());
    }

    // ── validate_weights_sum ───────────────────────────────────────────────────

    #[test]
    fn weights_sum_to_10000_passes() {
        let weights = vec![weight("EQUITY", 6000), weight("FIXED_INCOME", 4000)];
        assert!(validate_weights_sum(&weights).is_ok());
    }

    #[test]
    fn weights_not_summing_to_10000_rejected() {
        let weights = vec![weight("EQUITY", 6000), weight("FIXED_INCOME", 3000)];
        assert!(validate_weights_sum(&weights).is_err());
    }

    #[test]
    fn weights_duplicate_category_rejected() {
        let weights = vec![weight("EQUITY", 5000), weight("EQUITY", 5000)];
        assert!(validate_weights_sum(&weights).is_err());
    }

    #[test]
    fn weights_negative_bps_rejected() {
        let weights = vec![weight("EQUITY", -100), weight("FIXED_INCOME", 10100)];
        assert!(validate_weights_sum(&weights).is_err());
    }

    #[test]
    fn relative_factor_bps_out_of_range_rejected() {
        let p = NewAllocationTarget {
            relative_factor_bps: Some(10001),
            ..base_target("p")
        };
        assert!(validate_new_target(&p).is_err());
    }

    #[test]
    fn relative_factor_bps_negative_rejected() {
        let p = NewAllocationTarget {
            relative_factor_bps: Some(-1),
            ..base_target("p")
        };
        assert!(validate_new_target(&p).is_err());
    }

    #[test]
    fn relative_factor_bps_valid_passes() {
        let p = NewAllocationTarget {
            relative_factor_bps: Some(2000),
            ..base_target("p")
        };
        assert!(validate_new_target(&p).is_ok());
    }

    #[test]
    fn relative_factor_bps_none_passes() {
        assert!(validate_new_target(&base_target("p")).is_ok());
    }

    #[test]
    fn max_turnover_bps_valid_range_passes() {
        for bps in [0, 1, 10000] {
            let p = NewAllocationTarget {
                max_turnover_bps: Some(bps),
                ..base_target("p")
            };
            assert!(
                validate_new_target(&p).is_ok(),
                "max_turnover_bps={bps} should be valid"
            );
        }
    }

    #[test]
    fn max_turnover_bps_out_of_range_rejected() {
        for bps in [-1, 10001] {
            let p = NewAllocationTarget {
                max_turnover_bps: Some(bps),
                ..base_target("p")
            };
            assert!(
                validate_new_target(&p).is_err(),
                "max_turnover_bps={bps} should be rejected"
            );
        }
    }

    #[test]
    fn weights_zero_target_allowed_when_sum_correct() {
        // Zero-current category can have a target — valid if sum == 10000
        let weights = vec![
            weight("EQUITY", 6000),
            weight("FIXED_INCOME", 4000),
            weight("BONDS", 0),
        ];
        // Sum is 10000 but BONDS has 0 — still valid per spec
        assert!(validate_weights_sum(&weights).is_ok());
    }
}
