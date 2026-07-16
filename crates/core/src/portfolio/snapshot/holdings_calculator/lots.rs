//! LotBook: lot-disposal and lot-closure recording for the holdings
//! calculator. These methods stage tax-lot accounting facts (realized P&L,
//! cost basis, closures) into the per-activity [`SideEffectBuffer`]; the FIFO
//! reducers and split logic they build on live on [`Position`]
//! (see `positions_model.rs`).

use super::economics::storage_money;
use super::{HoldingsCalculator, ProjectionRun, SideEffectBuffer};
use crate::activities::Activity;
use crate::lots::{LotClosure, LotDisposal};
use crate::portfolio::snapshot::{FifoReductionResult, Position};
use chrono::{NaiveDate, Utc};
use log::{error, warn};
use rust_decimal::Decimal;

impl HoldingsCalculator {
    /// Records a FIFO reduction's tax-lot facts: stages disposals for the
    /// removed lots and closures for the fully consumed ones. The closure date
    /// is the activity's user-local date.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn record_reduction(
        &self,
        account_id: &str,
        asset_id: &str,
        activity: &Activity,
        reduction: &FifoReductionResult,
        proceeds: Decimal,
        position_currency: &str,
        run: &ProjectionRun,
        buffer: &mut SideEffectBuffer,
    ) {
        self.record_lot_disposals(
            account_id,
            asset_id,
            activity,
            &reduction.removed_lots,
            proceeds,
            reduction.quantity_reduced,
            position_currency,
            run,
            buffer,
        );
        let close_date = self.activity_local_date(activity).to_string();
        for lot in &reduction.fully_consumed_lots {
            self.record_lot_closure(
                account_id,
                asset_id,
                lot,
                &close_date,
                &activity.id,
                position_currency,
                run,
                buffer,
            );
        }
    }

    /// Records a lot closure in the disposed lots log, carrying the full lot
    /// data so the persistence layer can INSERT the closed lot if it was never
    /// written to the database (e.g. during a full recalc/replay).
    #[allow(clippy::too_many_arguments)]
    pub(super) fn record_lot_closure(
        &self,
        account_id: &str,
        asset_id: &str,
        lot: &super::super::Lot,
        close_date: &str,
        activity_id: &str,
        position_currency: &str,
        run: &ProjectionRun,
        buffer: &mut SideEffectBuffer,
    ) {
        let orig_qty = if lot.original_quantity.is_zero() {
            lot.quantity
        } else {
            lot.original_quantity
        };
        // `acquisition_fees` is mutated on partial sells, so use the immutable
        // `original_fees()` accessor here. Otherwise a lot bought with a $10
        // fee, half-sold, then fully consumed would persist closure rows with
        // a $5 original fee.
        let orig_fees = lot.original_fees();
        let orig_taxes = lot.original_taxes();
        let original_cost_basis = lot.acquisition_price * orig_qty + orig_fees + orig_taxes;
        let base_currency = self.base_currency.read().unwrap().clone();
        let acquisition_date = lot.acquisition_date_key();
        let fx_rate_to_base =
            self.fx_rate_to_base_for_lot(lot, position_currency, &base_currency, acquisition_date);
        let cost_basis_method = run.cost_basis_method_for_account(account_id);
        buffer.disposed_lots.push((
            account_id.to_string(),
            LotClosure {
                lot_id: lot.id.clone(),
                close_date: close_date.to_string(),
                close_activity_id: Some(activity_id.to_string()),
                open_activity_id: lot.source_activity_id.clone(),
                account_id: account_id.to_string(),
                asset_id: asset_id.to_string(),
                open_date: acquisition_date.to_string(),
                original_quantity: orig_qty.to_string(),
                cost_per_unit: lot.acquisition_price.to_string(),
                // Original/at-acquisition cost basis, reconstructed from
                // the immutable acquisition_price / original_quantity /
                // original_acquisition_fees.
                original_cost_basis: original_cost_basis.to_string(),
                original_cost_basis_base: (original_cost_basis * fx_rate_to_base).to_string(),
                remaining_cost_basis_base: Decimal::ZERO.to_string(),
                fee_allocated: orig_fees.to_string(),
                fee_allocated_base: (orig_fees * fx_rate_to_base).to_string(),
                tax_allocated: orig_taxes.to_string(),
                tax_allocated_base: (orig_taxes * fx_rate_to_base).to_string(),
                currency: position_currency.to_string(),
                base_currency: base_currency.clone(),
                fx_rate_to_base: fx_rate_to_base.to_string(),
                cost_basis_method: cost_basis_method.clone(),
                // Carry the cumulative split ratio as of closure. A lot
                // that lived through a 2:1 split before being fully
                // consumed must persist with split_ratio = 2; otherwise
                // downstream tax-lot reporting sees a wrong split history.
                split_ratio: lot.effective_split_ratio().to_string(),
            },
        ));
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn record_lot_disposals(
        &self,
        account_id: &str,
        asset_id: &str,
        activity: &Activity,
        removed_lots: &[super::super::Lot],
        total_proceeds: Decimal,
        total_quantity_reduced: Decimal,
        position_currency: &str,
        run: &ProjectionRun,
        buffer: &mut SideEffectBuffer,
    ) {
        if removed_lots.is_empty() || total_quantity_reduced.is_zero() {
            return;
        }

        let disposal_date = self.activity_local_date(activity);
        let base_currency = self.base_currency.read().unwrap().clone();
        let disposal_fx_rate_to_base = self
            .fx_rate_for_basis(
                position_currency,
                &base_currency,
                disposal_date,
                &activity.id,
            )
            .unwrap_or(Decimal::ZERO);
        let disposal_base_available = !disposal_fx_rate_to_base.is_zero();
        if !disposal_base_available {
            warn!(
                "Persisting local lot disposal facts for activity {} with zero base attribution because disposal FX is missing.",
                activity.id
            );
        }
        let now = Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
        let cost_basis_method = run.cost_basis_method_for_account(account_id);

        for (index, lot) in removed_lots.iter().enumerate() {
            let effective_quantity = lot.effective_quantity();
            let proceeds = if total_quantity_reduced.is_zero() {
                Decimal::ZERO
            } else {
                total_proceeds * effective_quantity / total_quantity_reduced
            };
            let cost_basis = lot.cost_basis;
            let acquisition_date = lot.acquisition_date_key();
            let acquisition_fx_rate_to_base = self.fx_rate_to_base_for_lot(
                lot,
                position_currency,
                &base_currency,
                acquisition_date,
            );
            let acquisition_base_available = !acquisition_fx_rate_to_base.is_zero();
            if !acquisition_base_available {
                warn!(
                    "Persisting local lot disposal facts for activity {} lot {} with zero base attribution because acquisition FX is missing.",
                    activity.id, lot.id
                );
            }
            let base_available = disposal_base_available && acquisition_base_available;
            let proceeds_base = if base_available {
                proceeds * disposal_fx_rate_to_base
            } else {
                Decimal::ZERO
            };
            let cost_basis_base = if base_available {
                cost_basis * acquisition_fx_rate_to_base
            } else {
                Decimal::ZERO
            };
            let stored_proceeds = storage_money(proceeds);
            let stored_cost_basis = storage_money(cost_basis);
            let stored_realized_pnl = storage_money(stored_proceeds - stored_cost_basis);
            let stored_proceeds_base = storage_money(proceeds_base);
            let stored_cost_basis_base = storage_money(cost_basis_base);
            let stored_realized_pnl_base =
                storage_money(stored_proceeds_base - stored_cost_basis_base);
            buffer.lot_disposals.push((
                account_id.to_string(),
                LotDisposal {
                    id: format!("{}:{}:{}", activity.id, lot.id, index),
                    lot_id: lot.id.clone(),
                    account_id: account_id.to_string(),
                    asset_id: asset_id.to_string(),
                    disposal_activity_id: activity.id.clone(),
                    disposal_date: disposal_date.to_string(),
                    quantity: effective_quantity.to_string(),
                    proceeds: stored_proceeds.to_string(),
                    cost_basis: stored_cost_basis.to_string(),
                    realized_pnl: stored_realized_pnl.to_string(),
                    proceeds_base: stored_proceeds_base.to_string(),
                    cost_basis_base: stored_cost_basis_base.to_string(),
                    realized_pnl_base: stored_realized_pnl_base.to_string(),
                    currency: position_currency.to_string(),
                    base_currency: base_currency.clone(),
                    fx_rate_to_base: disposal_fx_rate_to_base.to_string(),
                    cost_basis_method: cost_basis_method.clone(),
                    created_at: now.clone(),
                },
            ));
        }
    }
}

impl HoldingsCalculator {
    /// Book cost basis of a position in the account currency, anchored to each
    /// lot's acquisition-date FX (stored rate preferred). Falls back to the
    /// position aggregate when no lots are materialized.
    pub(super) fn position_cost_basis_in_account_currency(
        &self,
        position: &Position,
        account_currency: &str,
        target_date: NaiveDate,
    ) -> Decimal {
        let position_currency = &position.currency;

        if position_currency.is_empty() {
            warn!(
                "Position {} has no currency set. Skipping its cost basis.",
                position.id
            );
            return Decimal::ZERO;
        }

        if position.lots.is_empty() {
            if position_currency != account_currency {
                warn!(
                    "Position {} has no materialized lots on {}. Falling back to valuation-date FX for account cost basis.",
                    position.asset_id, target_date
                );
            }
            return self.convert_cost_basis_to_account_currency(
                position.total_cost_basis,
                position_currency,
                account_currency,
                target_date,
                &position.id,
            );
        }

        position
            .lots
            .iter()
            .filter(|lot| !lot.quantity.is_zero() && !lot.cost_basis.is_zero())
            .map(|lot| {
                if let Some(rate) = lot.stored_fx_rate_to(account_currency) {
                    return lot.cost_basis * rate;
                }

                self.convert_cost_basis_to_account_currency(
                    lot.cost_basis,
                    position_currency,
                    account_currency,
                    lot.acquisition_date_key(),
                    &lot.id,
                )
            })
            .sum()
    }

    pub(super) fn lots_cost_basis_in_currency(
        &self,
        lots: &[super::super::Lot],
        position_currency: &str,
        target_currency: &str,
        fallback_date: NaiveDate,
        context_id: &str,
    ) -> Decimal {
        lots.iter()
            .filter(|lot| !lot.quantity.is_zero() && !lot.cost_basis.is_zero())
            .map(|lot| {
                self.lot_cost_basis_in_currency(
                    lot,
                    position_currency,
                    target_currency,
                    fallback_date,
                    context_id,
                )
            })
            .sum()
    }

    fn lot_cost_basis_in_currency(
        &self,
        lot: &super::super::Lot,
        position_currency: &str,
        target_currency: &str,
        fallback_date: NaiveDate,
        context_id: &str,
    ) -> Decimal {
        if position_currency == target_currency {
            return lot.cost_basis;
        }

        if let Some(rate) = lot.stored_fx_rate_to(target_currency) {
            return lot.cost_basis * rate;
        }

        let acquisition_date = lot.acquisition_date_key();
        match self.fx_service.convert_currency_for_date(
            lot.cost_basis,
            position_currency,
            target_currency,
            acquisition_date,
        ) {
            Ok(converted) => converted,
            Err(acquisition_err) => {
                warn!(
                    "Holdings Calc (Lot Book FX {}): Failed acquisition-date conversion {} {}->{} on {}: {}.",
                    context_id,
                    lot.cost_basis,
                    position_currency,
                    target_currency,
                    acquisition_date,
                    acquisition_err
                );

                if fallback_date == acquisition_date {
                    return lot.cost_basis;
                }

                match self.fx_service.convert_currency_for_date(
                    lot.cost_basis,
                    position_currency,
                    target_currency,
                    fallback_date,
                ) {
                    Ok(converted) => converted,
                    Err(fallback_err) => {
                        warn!(
                            "Holdings Calc (Lot Book FX {}): Failed fallback conversion {} {}->{} on {}: {}. Using original amount.",
                            context_id,
                            lot.cost_basis,
                            position_currency,
                            target_currency,
                            fallback_date,
                            fallback_err
                        );
                        lot.cost_basis
                    }
                }
            }
        }
    }

    fn convert_cost_basis_to_account_currency(
        &self,
        amount: Decimal,
        from_currency: &str,
        account_currency: &str,
        date: NaiveDate,
        context_id: &str,
    ) -> Decimal {
        if from_currency == account_currency {
            return amount;
        }

        match self.fx_service.convert_currency_for_date(
            amount,
            from_currency,
            account_currency,
            date,
        ) {
            Ok(converted_cost) => converted_cost,
            Err(e) => {
                error!(
                    "Holdings Calc (Book Cost): Failed to convert {} {} to {} on {} for {}: {}. Using original unconverted cost for snapshot.",
                    amount, from_currency, account_currency, date, context_id, e
                );
                amount
            }
        }
    }
}
