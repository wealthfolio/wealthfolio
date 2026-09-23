//! Cash-flow handlers (DEPOSIT / WITHDRAWAL / income / charge). `impl HoldingsCalculator`.
use super::super::economics::*;
use super::super::HoldingsCalculator;
use crate::activities::{Activity, ActivityType};
use crate::errors::Result;
use crate::portfolio::economic_events::ActivityEconomicsResolver;
use crate::portfolio::performance::affects_net_contribution;
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
        let resolved = ActivityEconomicsResolver::resolve_cash(activity, Decimal::ONE);
        let cash_effect = resolved.signed_cash_effect.unwrap_or(Decimal::ZERO);
        let gross_effect = resolved.signed_gross_effect.unwrap_or(Decimal::ZERO);

        let (cash_currency, cash_effect) = cash_booking(activity, cash_effect);
        add_cash(state, &cash_currency, cash_effect);

        // Convert for net_contribution (pre-fee amount in account currency)
        let amount_acct = self.convert_to_account_currency(
            gross_effect,
            activity,
            account_currency,
            "Deposit Amount",
        );

        // Convert for net_contribution_base
        let base_ccy = self.base_currency.read().unwrap();
        let amount_base = match self.fx_service.convert_currency_for_date(
            gross_effect,
            activity_currency,
            &base_ccy,
            activity_date,
        ) {
            Ok(c) => c,
            Err(e) => {
                warn!(
                    "Holdings Calc (NetContrib Deposit {}): Failed conversion {} {}->{} on {}: {}. Base contribution not updated.",
                    activity.id, gross_effect, activity_currency, base_ccy, activity_date, e
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
        let resolved = ActivityEconomicsResolver::resolve_cash(activity, Decimal::ONE);
        let cash_effect = resolved.signed_cash_effect.unwrap_or(Decimal::ZERO);
        let gross_effect = resolved.signed_gross_effect.unwrap_or(Decimal::ZERO);

        let (cash_currency, cash_effect) = cash_booking(activity, cash_effect);
        add_cash(state, &cash_currency, cash_effect);

        // Convert for net_contribution (pre-fee amount in account currency)
        let amount_acct = self.convert_to_account_currency(
            gross_effect,
            activity,
            account_currency,
            "Withdrawal Amount",
        );

        // Convert for net_contribution_base
        let base_ccy = self.base_currency.read().unwrap();
        let amount_base = match self.fx_service.convert_currency_for_date(
            gross_effect,
            activity_currency,
            &base_ccy,
            activity_date,
        ) {
            Ok(c) => c,
            Err(e) => {
                warn!(
                    "Holdings Calc (NetContrib Withdrawal {}): Failed conversion {} {}->{} on {}: {}. Base contribution not updated.",
                    activity.id, gross_effect, activity_currency, base_ccy, activity_date, e
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
    /// - External CREDIT: updates net_contribution like DEPOSIT
    /// - Internal CREDIT: no net_contribution change
    /// - DIVIDEND, INTEREST: no net_contribution change
    pub(crate) fn handle_income(
        &self,
        activity: &Activity,
        state: &mut AccountStateSnapshot,
        account_currency: &str,
    ) -> Result<()> {
        let activity_currency = &activity.currency;
        let resolved = ActivityEconomicsResolver::resolve_cash(activity, Decimal::ONE);
        let cash_effect = resolved.signed_cash_effect.unwrap_or(Decimal::ZERO);
        let gross_effect = resolved.signed_gross_effect.unwrap_or(Decimal::ZERO);

        let (cash_currency, cash_effect) = cash_booking(activity, cash_effect);
        add_cash(state, &cash_currency, cash_effect);

        if affects_net_contribution(activity) {
            let activity_date = self.activity_local_date(activity);

            // Convert to account currency for net_contribution
            let amount_acct = self.convert_to_account_currency(
                gross_effect,
                activity,
                account_currency,
                "External Credit",
            );

            // Convert to base currency for net_contribution_base
            let base_ccy = self.base_currency.read().unwrap();
            let amount_base = match self.fx_service.convert_currency_for_date(
                gross_effect,
                activity_currency,
                &base_ccy,
                activity_date,
            ) {
                Ok(c) => c,
                Err(e) => {
                    warn!(
                        "Holdings Calc (NetContrib External Credit {}): Failed conversion {} {}->{} on {}: {}. Base contribution not updated.",
                        activity.id,
                        gross_effect,
                        activity_currency,
                        base_ccy,
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
        let resolved = ActivityEconomicsResolver::resolve_cash_with_account_context(
            activity,
            Decimal::ONE,
            *activity_type == ActivityType::Interest,
        );
        let charge = resolved.signed_cash_effect.unwrap_or(Decimal::ZERO);

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
        let (cash_currency, cash_effect) = cash_booking(activity, charge);
        add_cash(state, &cash_currency, cash_effect);

        // Charges do not affect net_contribution
        Ok(())
    }
}
