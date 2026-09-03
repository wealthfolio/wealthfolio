use crate::activities::{
    is_securities_transfer, Activity, ActivityCompiler, DefaultActivityCompiler,
    ACTIVITY_SUBTYPE_DIVIDEND_IN_KIND, ACTIVITY_SUBTYPE_DRIP, ACTIVITY_SUBTYPE_STAKING_REWARD,
    ACTIVITY_TYPE_BUY, ACTIVITY_TYPE_CREDIT, ACTIVITY_TYPE_DEPOSIT, ACTIVITY_TYPE_DIVIDEND,
    ACTIVITY_TYPE_FEE, ACTIVITY_TYPE_INTEREST, ACTIVITY_TYPE_SELL, ACTIVITY_TYPE_SPLIT,
    ACTIVITY_TYPE_TAX, ACTIVITY_TYPE_TRANSFER_IN, ACTIVITY_TYPE_TRANSFER_OUT,
    ACTIVITY_TYPE_WITHDRAWAL,
};
use crate::fx::currency::currency_minor_unit;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BasisStatus {
    Complete,
    PartialUnknown,
    Unknown,
    #[default]
    NotApplicable,
}

impl BasisStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Complete => "COMPLETE",
            Self::PartialUnknown => "PARTIAL_UNKNOWN",
            Self::Unknown => "UNKNOWN",
            Self::NotApplicable => "NOT_APPLICABLE",
        }
    }

    pub fn from_code(value: &str) -> Self {
        match value.trim().to_ascii_uppercase().as_str() {
            "COMPLETE" => Self::Complete,
            "PARTIAL_UNKNOWN" | "PARTIAL" => Self::PartialUnknown,
            "UNKNOWN" => Self::Unknown,
            "NOT_APPLICABLE" | "N/A" | "NA" => Self::NotApplicable,
            _ => Self::Unknown,
        }
    }

    pub fn combine(self, next: Self) -> Self {
        match (self, next) {
            (Self::PartialUnknown, _) | (_, Self::PartialUnknown) => Self::PartialUnknown,
            (Self::Complete, Self::Unknown) | (Self::Unknown, Self::Complete) => {
                Self::PartialUnknown
            }
            (Self::Unknown, _) | (_, Self::Unknown) => Self::Unknown,
            (Self::Complete, _) | (_, Self::Complete) => Self::Complete,
            (Self::NotApplicable, Self::NotApplicable) => Self::NotApplicable,
        }
    }
}

pub struct ActivityEconomicsResolver;

/// Flat cash inputs shared by persistence normalization, migration, and the
/// runtime economics resolver. Monetary fields are magnitudes; direction is a
/// property of the activity economics, never the stored sign.
#[derive(Clone, Copy, Debug)]
pub struct ActivityCashInputs<'a> {
    pub activity_type: &'a str,
    /// Activity currency; scales currency-relative tolerances (minor units).
    pub currency: &'a str,
    pub is_security_transfer: bool,
    pub quantity: Option<Decimal>,
    pub unit_price: Option<Decimal>,
    pub amount: Option<Decimal>,
    pub fee: Option<Decimal>,
    pub tax: Option<Decimal>,
    pub unit_multiplier: Decimal,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ResolvedActivityCash {
    /// Authoritative stored final cash magnitude. Explicit zero is preserved.
    pub final_amount: Option<Decimal>,
    /// Signed final cash movement. Positive is an inflow; negative is an outflow.
    pub signed_cash_effect: Option<Decimal>,
    /// Pre-charge economics reverse-derived from final cash and charges.
    pub gross_amount: Option<Decimal>,
    /// Signed gross economic flow, independent from a charges-over-proceeds
    /// reversal in final cash.
    pub signed_gross_effect: Option<Decimal>,
}

impl ActivityEconomicsResolver {
    pub fn resolve_cash(activity: &Activity, unit_multiplier: Decimal) -> ResolvedActivityCash {
        Self::resolve_cash_inputs(ActivityCashInputs {
            activity_type: activity.effective_type(),
            currency: &activity.currency,
            is_security_transfer: Self::is_security_transfer(activity),
            quantity: activity.quantity,
            unit_price: activity.unit_price,
            amount: activity.amount,
            fee: activity.fee,
            tax: activity.tax,
            unit_multiplier,
        })
    }

    /// Resolves the one direction exception that depends on account context.
    /// Investment-account interest is income; credit-card interest is a charge.
    pub fn resolve_cash_with_account_context(
        activity: &Activity,
        unit_multiplier: Decimal,
        is_credit_card_account: bool,
    ) -> ResolvedActivityCash {
        let mut resolved = Self::resolve_cash(activity, unit_multiplier);
        if is_credit_card_account && activity.effective_type() == ACTIVITY_TYPE_INTEREST {
            resolved.signed_cash_effect = resolved.final_amount.map(|amount| -amount.abs());
            resolved.signed_gross_effect = resolved.gross_amount.map(|amount| -amount.abs());
        }
        resolved
    }

    /// Resolves the cash movement of a stored event after expanding composite
    /// activities (DRIP, staking rewards, dividend in kind) through the same
    /// compiler used by the holdings engine. Parent-row diagnostics remain
    /// attached to the stored amount; only the signed movement is aggregated
    /// from canonical postings.
    pub fn resolve_compiled_cash(
        activity: &Activity,
        unit_multiplier: Decimal,
        is_credit_card_account: bool,
    ) -> crate::Result<ResolvedActivityCash> {
        let mut resolved = Self::resolve_cash_with_account_context(
            activity,
            unit_multiplier,
            is_credit_card_account,
        );
        let postings = DefaultActivityCompiler::new().compile(activity)?;
        if postings.is_empty() {
            resolved.signed_cash_effect = None;
            resolved.signed_gross_effect = None;
            return Ok(resolved);
        }

        let mut signed_cash_effect = Decimal::ZERO;
        let mut signed_gross_effect = Decimal::ZERO;
        let mut has_cash_effect = false;
        let mut has_gross_effect = false;
        for posting in postings {
            let posting_cash = Self::resolve_cash_with_account_context(
                &posting,
                unit_multiplier,
                is_credit_card_account,
            );
            if let Some(effect) = posting_cash.signed_cash_effect {
                signed_cash_effect += effect;
                has_cash_effect = true;
            }
            if let Some(effect) = posting_cash.signed_gross_effect {
                signed_gross_effect += effect;
                has_gross_effect = true;
            }
        }
        resolved.signed_cash_effect = has_cash_effect.then_some(signed_cash_effect);
        resolved.signed_gross_effect = has_gross_effect.then_some(signed_gross_effect);
        Ok(resolved)
    }

    /// Runtime cash resolution is deliberately final-only. It never treats a
    /// stored amount as legacy gross and never substitutes a derived amount for
    /// a missing stored value. Derivation is restricted to proving direction
    /// for exceptional charges-over-proceeds cases.
    pub fn resolve_cash_inputs(inputs: ActivityCashInputs<'_>) -> ResolvedActivityCash {
        if inputs.activity_type == ACTIVITY_TYPE_SPLIT {
            return ResolvedActivityCash::default();
        }

        let fee = inputs.fee.unwrap_or(Decimal::ZERO).abs();
        if inputs.is_security_transfer {
            return ResolvedActivityCash {
                final_amount: (fee > Decimal::ZERO).then_some(fee),
                signed_cash_effect: (fee > Decimal::ZERO).then_some(-fee),
                gross_amount: (fee > Decimal::ZERO).then_some(fee),
                signed_gross_effect: (fee > Decimal::ZERO).then_some(-fee),
            };
        }

        let tax = inputs.tax.unwrap_or(Decimal::ZERO).abs();
        let charges = fee + tax;
        let expected_effect = Self::calculate_trade_cash_effect(inputs)
            .or_else(|| Self::calculate_standalone_charge_amount(inputs).map(|amount| -amount));
        let final_amount = inputs.amount.map(|amount| amount.abs());
        let signed_cash_effect = final_amount.map(|amount| {
            if amount.is_zero() {
                return Decimal::ZERO;
            }
            // A final amount is authoritative, so charges cannot reverse the
            // direction of typed deposits or income. SELL is the sole
            // magnitude-only event whose final cash can legitimately become
            // an outflow when charges exceed proceeds, and only when the
            // quantity/price economics reproduce that final magnitude.
            // Keep in lockstep with `isProvenNegativeSell` in
            // apps/frontend/src/lib/activity-utils.ts, including the epsilon.
            // One minor unit of the activity currency covers stored totals
            // the migration/writer preserved within their acceptance bands
            // (0.01 for USD, 1 for JPY, 1e-8 for BTC); a currency-blind
            // floor would flip such sells to inflows or over-reverse crypto.
            let reversal_tolerance =
                (amount * Decimal::new(1, 8)).max(currency_minor_unit(inputs.currency));
            if inputs.activity_type == ACTIVITY_TYPE_SELL
                && expected_effect.is_some_and(|expected| {
                    expected.is_sign_negative()
                        && (expected.abs() - amount).abs() <= reversal_tolerance
                })
            {
                -amount
            } else {
                Self::type_directed_cash_effect(inputs.activity_type, amount)
            }
        });

        let gross_amount = signed_cash_effect.and_then(|signed_final| {
            let gross = match inputs.activity_type {
                ACTIVITY_TYPE_BUY => -signed_final - charges,
                ACTIVITY_TYPE_SELL
                | ACTIVITY_TYPE_DEPOSIT
                | ACTIVITY_TYPE_DIVIDEND
                | ACTIVITY_TYPE_INTEREST
                | ACTIVITY_TYPE_CREDIT
                | ACTIVITY_TYPE_TRANSFER_IN => signed_final + charges,
                ACTIVITY_TYPE_WITHDRAWAL | ACTIVITY_TYPE_TRANSFER_OUT => -signed_final - charges,
                ACTIVITY_TYPE_FEE | ACTIVITY_TYPE_TAX => final_amount?,
                _ => return None,
            };
            (gross >= Decimal::ZERO).then_some(gross)
        });
        let signed_gross_effect =
            gross_amount.map(|gross| Self::type_directed_cash_effect(inputs.activity_type, gross));

        ResolvedActivityCash {
            final_amount,
            signed_cash_effect,
            gross_amount,
            signed_gross_effect,
        }
    }

    /// Calculates canonical final cash for a complete BUY or SELL. This is a
    /// persistence-boundary operation; runtime resolution never calls it to
    /// replace a missing stored amount.
    pub fn calculate_trade_final_cash(inputs: ActivityCashInputs<'_>) -> Option<Decimal> {
        Self::calculate_trade_cash_effect(inputs).map(|amount| amount.abs())
    }

    /// Copies the explicit charge carried by standalone FEE/TAX activities.
    /// Ordinary cash and income activities deliberately have no derivation
    /// helper.
    pub fn calculate_standalone_charge_amount(inputs: ActivityCashInputs<'_>) -> Option<Decimal> {
        match inputs.activity_type {
            ACTIVITY_TYPE_FEE => inputs.fee.map(|amount| amount.abs()),
            ACTIVITY_TYPE_TAX => inputs
                .tax
                .filter(|amount| !amount.is_zero())
                .map(|amount| amount.abs())
                .or_else(|| inputs.fee.map(|amount| amount.abs()))
                .or_else(|| inputs.tax.map(|amount| amount.abs())),
            _ => None,
        }
    }

    /// Recognized asset-income composites explicitly define their value as
    /// quantity × unit price. No other income/cash subtype may use this path.
    pub fn calculate_composite_final_cash(
        activity_type: &str,
        subtype: Option<&str>,
        quantity: Option<Decimal>,
        unit_price: Option<Decimal>,
        unit_multiplier: Decimal,
    ) -> Option<Decimal> {
        let subtype = subtype?.trim();
        let recognized = (activity_type == ACTIVITY_TYPE_DIVIDEND
            && (subtype.eq_ignore_ascii_case(ACTIVITY_SUBTYPE_DRIP)
                || subtype.eq_ignore_ascii_case(ACTIVITY_SUBTYPE_DIVIDEND_IN_KIND)))
            || (activity_type == ACTIVITY_TYPE_INTEREST
                && subtype.eq_ignore_ascii_case(ACTIVITY_SUBTYPE_STAKING_REWARD));
        if !recognized {
            return None;
        }

        let gross =
            quantity?.abs() * unit_price?.abs() * Self::valid_unit_multiplier(unit_multiplier);
        (!gross.is_zero()).then_some(gross)
    }

    fn calculate_trade_cash_effect(inputs: ActivityCashInputs<'_>) -> Option<Decimal> {
        if inputs.is_security_transfer
            || !matches!(inputs.activity_type, ACTIVITY_TYPE_BUY | ACTIVITY_TYPE_SELL)
        {
            return None;
        }

        let gross = Self::derived_positive_gross(inputs)?;
        let fee = inputs.fee.unwrap_or(Decimal::ZERO).abs();
        let tax = inputs.tax.unwrap_or(Decimal::ZERO).abs();
        Self::cash_effect_from_trade_gross(inputs.activity_type, gross, fee, tax)
    }

    pub(crate) fn derived_positive_gross(inputs: ActivityCashInputs<'_>) -> Option<Decimal> {
        let multiplier = Self::valid_unit_multiplier(inputs.unit_multiplier);
        let gross = inputs.quantity?.abs() * inputs.unit_price?.abs() * multiplier;
        (gross > Decimal::ZERO).then_some(gross)
    }

    fn cash_effect_from_trade_gross(
        activity_type: &str,
        gross: Decimal,
        fee: Decimal,
        tax: Decimal,
    ) -> Option<Decimal> {
        let charges = fee.abs() + tax.abs();
        match activity_type {
            ACTIVITY_TYPE_BUY => Some(-(gross.abs() + charges)),
            ACTIVITY_TYPE_SELL => Some(gross.abs() - charges),
            _ => None,
        }
    }

    fn valid_unit_multiplier(unit_multiplier: Decimal) -> Decimal {
        if unit_multiplier > Decimal::ZERO {
            unit_multiplier
        } else {
            Decimal::ONE
        }
    }

    fn type_directed_cash_effect(activity_type: &str, amount: Decimal) -> Decimal {
        match activity_type {
            ACTIVITY_TYPE_SELL
            | ACTIVITY_TYPE_DEPOSIT
            | ACTIVITY_TYPE_DIVIDEND
            | ACTIVITY_TYPE_INTEREST
            | ACTIVITY_TYPE_CREDIT
            | ACTIVITY_TYPE_TRANSFER_IN => amount.abs(),
            ACTIVITY_TYPE_BUY
            | ACTIVITY_TYPE_WITHDRAWAL
            | ACTIVITY_TYPE_FEE
            | ACTIVITY_TYPE_TAX
            | ACTIVITY_TYPE_TRANSFER_OUT => -amount.abs(),
            _ => Decimal::ZERO,
        }
    }

    pub fn is_security_transfer(activity: &Activity) -> bool {
        is_securities_transfer(activity.effective_type(), activity.asset_id.as_deref())
    }
}

#[cfg(test)]
mod cash_tests {
    use super::*;
    use crate::assets::{Asset, InstrumentType};
    use rust_decimal_macros::dec;

    fn inputs(activity_type: &'static str) -> ActivityCashInputs<'static> {
        ActivityCashInputs {
            activity_type,
            currency: "USD",
            is_security_transfer: false,
            quantity: Some(dec!(2)),
            unit_price: Some(dec!(10)),
            amount: None,
            fee: Some(dec!(1)),
            tax: Some(dec!(2)),
            unit_multiplier: Decimal::ONE,
        }
    }

    fn stored_activity(activity_type: &str) -> Activity {
        Activity {
            id: "activity-1".to_string(),
            account_id: "account-1".to_string(),
            asset_id: Some("asset-1".to_string()),
            activity_type: activity_type.to_string(),
            activity_type_override: None,
            source_type: None,
            subtype: None,
            status: crate::activities::ActivityStatus::Posted,
            activity_date: chrono::Utc::now(),
            settlement_date: None,
            quantity: None,
            unit_price: None,
            amount: None,
            fee: None,
            tax: None,
            currency: "USD".to_string(),
            fx_rate: None,
            notes: None,
            metadata: None,
            source_system: None,
            source_record_id: None,
            source_group_id: None,
            idempotency_key: None,
            import_run_id: None,
            is_user_modified: false,
            needs_review: false,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        }
    }

    #[test]
    fn charges_exceeding_gross_reverse_a_sell_at_a_non_unit_multiplier() {
        // Gross is 1 x 1 x 10 = 10, so charges of 12 prove the reversal and
        // the stored 2 books as an outflow. The multiplier comes from the
        // asset the caller passes - the row owns no multiplier of its own.
        let mut sell = stored_activity(ACTIVITY_TYPE_SELL);
        sell.quantity = Some(dec!(1));
        sell.unit_price = Some(dec!(1));
        sell.fee = Some(dec!(12));
        sell.amount = Some(dec!(2));

        let resolved = ActivityEconomicsResolver::resolve_cash(&sell, dec!(10));

        assert_eq!(resolved.signed_cash_effect, Some(dec!(-2)));
    }

    #[test]
    fn supplied_amount_is_always_authoritative_final_cash() {
        let mut dividend = inputs(ACTIVITY_TYPE_DIVIDEND);
        dividend.amount = Some(dec!(100));
        dividend.tax = Some(dec!(15));
        dividend.fee = None;

        let resolved = ActivityEconomicsResolver::resolve_cash_inputs(dividend);

        assert_eq!(resolved.final_amount, Some(dec!(100)));
        assert_eq!(resolved.signed_cash_effect, Some(dec!(100)));
        assert_eq!(resolved.gross_amount, Some(dec!(115)));
        assert_eq!(resolved.signed_gross_effect, Some(dec!(115)));
    }

    #[test]
    fn income_charges_cannot_reverse_an_authoritative_final_amount() {
        let mut dividend = inputs(ACTIVITY_TYPE_DIVIDEND);
        dividend.quantity = Some(dec!(1));
        dividend.unit_price = Some(dec!(10));
        dividend.amount = Some(dec!(100));
        dividend.fee = None;
        dividend.tax = Some(dec!(150));

        let resolved = ActivityEconomicsResolver::resolve_cash_inputs(dividend);

        assert_eq!(resolved.signed_cash_effect, Some(dec!(100)));
        assert_eq!(resolved.gross_amount, Some(dec!(250)));
    }

    #[test]
    fn final_trade_cash_reverse_derives_gross() {
        let mut buy = inputs(ACTIVITY_TYPE_BUY);
        buy.amount = Some(dec!(23));
        let buy = ActivityEconomicsResolver::resolve_cash_inputs(buy);
        assert_eq!(buy.signed_cash_effect, Some(dec!(-23)));
        assert_eq!(buy.gross_amount, Some(dec!(20)));

        let mut sell = inputs(ACTIVITY_TYPE_SELL);
        sell.amount = Some(dec!(17));
        let sell = ActivityEconomicsResolver::resolve_cash_inputs(sell);
        assert_eq!(sell.signed_cash_effect, Some(dec!(17)));
        assert_eq!(sell.gross_amount, Some(dec!(20)));
    }

    #[test]
    fn direction_uses_economics_when_charges_exceed_proceeds() {
        let mut sell = inputs(ACTIVITY_TYPE_SELL);
        sell.quantity = Some(dec!(1));
        sell.unit_price = Some(dec!(10));
        sell.amount = Some(dec!(2));
        sell.fee = Some(dec!(12));
        sell.tax = None;

        let resolved = ActivityEconomicsResolver::resolve_cash_inputs(sell);

        assert_eq!(resolved.signed_cash_effect, Some(dec!(-2)));
        assert_eq!(resolved.gross_amount, Some(dec!(10)));
    }

    #[test]
    fn negative_sell_direction_survives_sub_cent_rounding() {
        // Same vector as the TS test "keeps the outflow direction within the
        // shared epsilon" in activity-utils.test.ts — keep them identical.
        let mut sell = inputs(ACTIVITY_TYPE_SELL);
        sell.quantity = Some(dec!(1));
        sell.unit_price = Some(dec!(10));
        sell.amount = Some(dec!(2.000000005));
        sell.fee = Some(dec!(12));
        sell.tax = None;

        let resolved = ActivityEconomicsResolver::resolve_cash_inputs(sell);

        assert_eq!(resolved.signed_cash_effect, Some(dec!(-2.000000005)));
    }

    #[test]
    fn inconsistent_sell_diagnostics_cannot_reverse_final_cash() {
        let mut sell = inputs(ACTIVITY_TYPE_SELL);
        sell.quantity = Some(dec!(1));
        sell.unit_price = Some(dec!(10));
        sell.amount = Some(dec!(100));
        sell.fee = Some(dec!(12));
        sell.tax = None;

        let resolved = ActivityEconomicsResolver::resolve_cash_inputs(sell);

        assert_eq!(resolved.signed_cash_effect, Some(dec!(100)));
        assert_eq!(resolved.gross_amount, Some(dec!(112)));
    }

    #[test]
    fn runtime_does_not_derive_missing_amount_and_preserves_explicit_zero() {
        let missing = ActivityEconomicsResolver::resolve_cash_inputs(inputs(ACTIVITY_TYPE_SELL));
        assert_eq!(missing.final_amount, None);
        assert_eq!(missing.signed_cash_effect, None);
        let mut explicit_zero = inputs(ACTIVITY_TYPE_SELL);
        explicit_zero.amount = Some(Decimal::ZERO);
        let explicit_zero = ActivityEconomicsResolver::resolve_cash_inputs(explicit_zero);
        assert_eq!(explicit_zero.final_amount, Some(Decimal::ZERO));
        assert_eq!(explicit_zero.signed_cash_effect, Some(Decimal::ZERO));
    }

    #[test]
    fn writer_derivation_is_explicit_and_multiplier_aware() {
        let mut buy = inputs(ACTIVITY_TYPE_BUY);
        buy.unit_multiplier = dec!(100);

        assert_eq!(
            ActivityEconomicsResolver::calculate_trade_final_cash(buy),
            Some(dec!(2003))
        );
    }

    #[test]
    fn security_transfer_books_only_its_fee() {
        let mut transfer = inputs(ACTIVITY_TYPE_TRANSFER_IN);
        transfer.is_security_transfer = true;
        transfer.amount = Some(dec!(500));

        let resolved = ActivityEconomicsResolver::resolve_cash_inputs(transfer);

        assert_eq!(resolved.final_amount, Some(dec!(1)));
        assert_eq!(resolved.signed_cash_effect, Some(dec!(-1)));
        assert_eq!(resolved.gross_amount, Some(dec!(1)));
    }

    #[test]
    fn bond_default_multiplier_pairs_with_provider_quote_convention() {
        // Market-data providers normalize bond quotes to FRACTION-of-par
        // (Boerse Frankfurt divides percent quotes by 100; the treasury
        // source emits fractions; matured-bond backfill writes par as 1.0).
        // The default multiplier must pair with that stored convention:
        // face qty x quote x multiplier = face-value dollars. A percent
        // default here would double-apply the /100 and value every existing
        // bond position at 1/100.
        let bond = Asset {
            instrument_type: Some(InstrumentType::Bond),
            ..Default::default()
        };
        let provider_quote = dec!(0.995);
        let face_qty = dec!(10_000);
        assert_eq!(
            face_qty * provider_quote * bond.contract_multiplier(),
            dec!(9_950)
        );
    }

    #[test]
    fn bond_with_explicit_multiplier_metadata_pairs_with_percent_quotes() {
        // Percent-of-par pricing is opt-in via asset metadata (the source of
        // truth), for bonds whose quotes are genuinely maintained in percent.
        let configured_bond = Asset {
            instrument_type: Some(InstrumentType::Bond),
            metadata: Some(serde_json::json!({ "contractMultiplier": "0.01" })),
            ..Default::default()
        };
        let percent_quote = dec!(99.5);
        assert_eq!(
            dec!(10_000) * percent_quote * configured_bond.contract_multiplier(),
            dec!(9_950)
        );

        // Any explicit value wins over the default.
        let custom = Asset {
            instrument_type: Some(InstrumentType::Bond),
            metadata: Some(serde_json::json!({ "contractMultiplier": "0.02" })),
            ..Default::default()
        };
        assert_eq!(custom.contract_multiplier(), dec!(0.02));
    }
}
