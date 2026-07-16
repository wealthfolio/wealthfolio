//! Cash-flow handlers (DEPOSIT / WITHDRAWAL / income / charge). `impl HoldingsCalculator`.
use super::super::economics::*;
use super::super::HoldingsCalculator;
use crate::activities::{Activity, ActivityType};
use crate::errors::Result;
use crate::portfolio::snapshot::AccountStateSnapshot;
use log::warn;
use rust_decimal::Decimal;

impl HoldingsCalculator {
    /// Handle DEPOSIT activity.
    /// Books cash inflow in ACTIVITY currency.
    /// Updates net_contribution in account currency.
    pub(crate) fn handle_deposit(
        &self,
        activity: &Activity,
        state: &mut AccountStateSnapshot,
        account_currency: &str,
    ) -> Result<()> {
        let activity_currency = &activity.currency;
        let activity_date = self.activity_local_date(activity);
        let activity_amount = activity.amt();

        // Book cash in ACTIVITY currency (amount - fee - tax)
        let net_amount = activity_amount - activity.fee_amt() - activity.tax_amt();
        add_cash(state, activity_currency, net_amount);

        // Convert for net_contribution (pre-fee amount in account currency)
        let amount_acct = self.convert_to_account_currency(
            activity_amount,
            activity,
            account_currency,
            "Deposit Amount",
        );

        // Convert for net_contribution_base
        let base_ccy = self.base_currency.read().unwrap();
        let amount_base = match self.fx_service.convert_currency_for_date(
            activity_amount,
            activity_currency,
            &base_ccy,
            activity_date,
        ) {
            Ok(c) => c,
            Err(e) => {
                warn!(
                    "Holdings Calc (NetContrib Deposit {}): Failed conversion {} {}->{} on {}: {}. Base contribution not updated.",
                    activity.id, activity_amount, activity_currency, &base_ccy, activity_date, e
                );
                Decimal::ZERO
            }
        };

        state.net_contribution += amount_acct;
        state.net_contribution_base += amount_base;
        Ok(())
    }

    /// Handle WITHDRAWAL activity.
    /// Books cash outflow in ACTIVITY currency.
    /// Updates net_contribution in account currency.
    pub(crate) fn handle_withdrawal(
        &self,
        activity: &Activity,
        state: &mut AccountStateSnapshot,
        account_currency: &str,
    ) -> Result<()> {
        let activity_currency = &activity.currency;
        let activity_date = self.activity_local_date(activity);
        // Use absolute value - activity type dictates direction
        let activity_amount = -activity.amt().abs();

        // Book cash outflow in ACTIVITY currency (amount + fee + tax)
        let net_amount = activity_amount - activity.fee_amt() - activity.tax_amt();
        add_cash(state, activity_currency, net_amount);

        // Convert for net_contribution (pre-fee amount in account currency)
        let amount_acct = self.convert_to_account_currency(
            activity_amount,
            activity,
            account_currency,
            "Withdrawal Amount",
        );

        // Convert for net_contribution_base
        let base_ccy = self.base_currency.read().unwrap();
        let amount_base = match self.fx_service.convert_currency_for_date(
            activity_amount,
            activity_currency,
            &base_ccy,
            activity_date,
        ) {
            Ok(c) => c,
            Err(e) => {
                warn!(
                    "Holdings Calc (NetContrib Withdrawal {}): Failed conversion {} {}->{} on {}: {}. Base contribution not updated.",
                    activity.id, activity_amount, activity_currency, &base_ccy, activity_date, e
                );
                Decimal::ZERO
            }
        };

        state.net_contribution += amount_acct;
        state.net_contribution_base += amount_base;
        Ok(())
    }

    /// Handle DIVIDEND/INTEREST/CREDIT activities.
    /// Books cash inflow in ACTIVITY currency.
    ///
    /// Net contribution behavior:
    /// - CREDIT/BONUS: external flow (new capital), updates net_contribution like DEPOSIT
    /// - CREDIT/REBATE, CREDIT/REFUND, other: internal flow, no net_contribution change
    /// - DIVIDEND, INTEREST: no net_contribution change
    pub(crate) fn handle_income(
        &self,
        activity: &Activity,
        state: &mut AccountStateSnapshot,
        account_currency: &str,
    ) -> Result<()> {
        use crate::activities::{ACTIVITY_SUBTYPE_BONUS, ACTIVITY_TYPE_CREDIT};

        let activity_currency = &activity.currency;
        let activity_amount = activity.amt();

        // Book cash in ACTIVITY currency (gross income - fees - withholding tax).
        // All types dispatched here (DIVIDEND/INTEREST/CREDIT) apply withholding tax.
        let net_amount = activity_amount - activity.fee_amt() - activity.tax_amt();
        add_cash(state, activity_currency, net_amount);

        // CREDIT/BONUS is external contribution (new capital entering portfolio)
        // Other CREDIT subtypes (REBATE, REFUND) and income types don't affect net_contribution
        if activity.effective_type() == ACTIVITY_TYPE_CREDIT
            && activity.subtype.as_deref() == Some(ACTIVITY_SUBTYPE_BONUS)
        {
            let activity_date = self.activity_local_date(activity);

            // Convert to account currency for net_contribution
            let amount_acct = self.convert_to_account_currency(
                activity_amount,
                activity,
                account_currency,
                "Credit Bonus",
            );

            // Convert to base currency for net_contribution_base
            let base_ccy = self.base_currency.read().unwrap();
            let amount_base = match self.fx_service.convert_currency_for_date(
                activity_amount,
                activity_currency,
                &base_ccy,
                activity_date,
            ) {
                Ok(c) => c,
                Err(e) => {
                    warn!(
                        "Holdings Calc (NetContrib Credit Bonus {}): Failed conversion {} {}->{} on {}: {}. Base contribution not updated.",
                        activity.id,
                        activity_amount,
                        activity_currency,
                        &base_ccy,
                        activity_date,
                        e
                    );
                    Decimal::ZERO
                }
            };

            state.net_contribution += amount_acct;
            state.net_contribution_base += amount_base;
        }

        Ok(())
    }

    /// Handle FEE/TAX activities.
    /// Books cash outflow in ACTIVITY currency.
    /// Charges do NOT affect net_contribution.
    pub(crate) fn handle_charge(
        &self,
        activity: &Activity,
        state: &mut AccountStateSnapshot,
        activity_type: &ActivityType,
    ) -> Result<()> {
        let activity_currency = &activity.currency;

        let charge = activity.charge_amt_for(activity_type);

        if charge == Decimal::ZERO {
            let expected_fields = match activity_type {
                ActivityType::Tax => "'tax', 'fee', and 'amount'",
                _ => "'fee' and 'amount'",
            };
            warn!(
                "Activity {} ({}): {} are zero. No cash change.",
                activity.id,
                activity_type.as_str(),
                expected_fields
            );
            return Ok(());
        }

        // Book cash outflow in ACTIVITY currency
        add_cash(state, activity_currency, -charge.abs());

        // Charges do not affect net_contribution
        Ok(())
    }
}
