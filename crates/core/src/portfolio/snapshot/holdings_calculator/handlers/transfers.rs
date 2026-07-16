//! Transfer handlers (TRANSFER_IN / TRANSFER_OUT). `impl HoldingsCalculator`.
use super::super::economics::*;
use super::super::{HoldingsCalculator, ProjectionRun, SideEffectBuffer};
use crate::activities::Activity;
use crate::errors::Result;
use crate::portfolio::economic_events::{ActivityEconomicsResolver, TransferBoundary};
use crate::portfolio::snapshot::{AccountStateSnapshot, Lot};
use log::warn;
use rust_decimal::Decimal;

/// Splits single-signed FIFO `lots` into a (cover, residual) pair so the first
/// `cover_qty_abs` effective units land in `cover` and the rest in `residual`.
/// A lot straddling the boundary is prorated by quantity (cost basis, fees, taxes
/// split proportionally). `cover_qty_abs` is in effective (post-split) units.
fn split_lots_by_cover_quantity(lots: &[Lot], cover_qty_abs: Decimal) -> (Vec<Lot>, Vec<Lot>) {
    let mut cover = Vec::new();
    let mut residual = Vec::new();
    let mut remaining = cover_qty_abs;

    for lot in lots {
        let lot_effective_abs = lot.effective_quantity().abs();
        if remaining <= Decimal::ZERO || lot_effective_abs.is_zero() {
            residual.push(lot.clone());
            continue;
        }
        if lot_effective_abs <= remaining {
            remaining -= lot_effective_abs;
            cover.push(lot.clone());
            continue;
        }

        // Partial: split this lot proportionally by effective units consumed.
        let split_ratio = lot.effective_split_ratio();
        let consumed_acquired = if split_ratio.is_zero() {
            remaining
        } else {
            remaining / split_ratio
        };
        let consumed_signed = if lot.quantity.is_sign_negative() {
            -consumed_acquired
        } else {
            consumed_acquired
        };
        let cover_fraction = consumed_signed / lot.quantity;

        let cover_cost_basis = lot.cost_basis * cover_fraction;
        let cover_fees = lot.acquisition_fees * cover_fraction;
        let cover_taxes = lot.acquisition_taxes * cover_fraction;
        let residual_quantity = lot.quantity - consumed_signed;

        let mut cover_lot = lot.clone();
        cover_lot.quantity = consumed_signed;
        cover_lot.original_quantity = consumed_signed;
        cover_lot.cost_basis = cover_cost_basis;
        cover_lot.acquisition_fees = cover_fees;
        cover_lot.original_acquisition_fees = cover_fees;
        cover_lot.acquisition_taxes = cover_taxes;
        cover_lot.original_acquisition_taxes = cover_taxes;
        cover.push(cover_lot);

        let mut residual_lot = lot.clone();
        residual_lot.quantity = residual_quantity;
        residual_lot.original_quantity = residual_quantity;
        residual_lot.cost_basis = lot.cost_basis - cover_cost_basis;
        residual_lot.acquisition_fees = lot.acquisition_fees - cover_fees;
        residual_lot.original_acquisition_fees = lot.acquisition_fees - cover_fees;
        residual_lot.acquisition_taxes = lot.acquisition_taxes - cover_taxes;
        residual_lot.original_acquisition_taxes = lot.acquisition_taxes - cover_taxes;
        residual.push(residual_lot);

        remaining = Decimal::ZERO;
    }

    (cover, residual)
}

impl HoldingsCalculator {
    /// Handle TRANSFER_IN activity.
    /// Books cash/asset inflow in ACTIVITY currency.
    /// Transfers always affect account-level net_contribution; portfolio boundary is handled by aggregation.
    pub(crate) fn handle_transfer_in(
        &self,
        activity: &Activity,
        state: &mut AccountStateSnapshot,
        account_currency: &str,
        asset_cache: &mut AssetCache,
        run: &ProjectionRun,
        buffer: &mut SideEffectBuffer,
    ) -> Result<()> {
        let activity_currency = &activity.currency;
        let activity_amount = activity.amt();
        let asset_id = activity.asset_id.as_deref().unwrap_or("");

        if asset_id.is_empty() {
            // Cash transfer: book in ACTIVITY currency (amount - fee - tax)
            let net_amount = activity_amount - activity.fee_amt() - activity.tax_amt();
            add_cash(state, activity_currency, net_amount);

            let activity_date = self.activity_local_date(activity);
            let amount_acct = self.convert_to_account_currency(
                activity_amount,
                activity,
                account_currency,
                "TransferIn Cash",
            );

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
                        "Holdings Calc (NetContrib TransferIn Cash {}): Failed conversion {}: {}.",
                        activity.id, activity_currency, e
                    );
                    Decimal::ZERO
                }
            };

            state.net_contribution += amount_acct;
            state.net_contribution_base += amount_base;
        } else {
            // Asset transfer
            let activity_date = self.activity_local_date(activity);

            let position = self.get_or_create_position_mut_cached(
                state,
                asset_id,
                activity_currency,
                activity.activity_date,
                asset_cache,
            )?;

            let position_currency = position.currency.clone();
            let needs_conversion =
                !position_currency.is_empty() && position_currency != activity.currency;
            let asset_info = asset_cache
                .get(asset_id)
                .cloned()
                .unwrap_or_else(|| AssetPositionInfo::fallback(activity_currency));

            // Try lot-level transfer: peek cached lots from the paired
            // TRANSFER_OUT. The cache removal is staged below only after the lots
            // are actually booked, so a failed/no-op TRANSFER_IN must not consume
            // the cached lots (their cost basis would otherwise be lost).
            let cached_lots = activity
                .source_group_id
                .as_ref()
                .and_then(|group_id| run.transfer_lots_cache.get(group_id).cloned());

            let (cost_basis_asset_curr, added_lots) = if let Some(lots) = cached_lots {
                // Lot-level transfer: lots are already in the asset's position currency
                // (same asset = same listing currency), so no FX conversion needed.
                //
                // Net against opposite-sign resident lots first so a position can
                // never simultaneously hold long and short lots of the same asset
                // (mirrors the buy-to-cover / sell-to-close netting in trades.rs).
                let incoming_negative = lots
                    .iter()
                    .find(|lot| !lot.quantity.is_zero())
                    .map(|lot| lot.quantity.is_sign_negative())
                    .unwrap_or(false);
                let incoming_qty_abs: Decimal =
                    lots.iter().map(|lot| lot.effective_quantity().abs()).sum();

                // Resident quantity on the side the incoming lots oppose.
                let resident_opposite_abs = if incoming_negative {
                    positive_lot_effective_quantity(position)
                } else {
                    negative_lot_effective_quantity_abs(position)
                };

                let cover_qty_abs = if asset_info.allows_negative_lots {
                    incoming_qty_abs.min(resident_opposite_abs)
                } else {
                    Decimal::ZERO
                };

                // Reduce the opposing resident leg FIFO (if any) and add only the
                // residual incoming lots. The reduction's disposal/closure
                // recording and net_contribution relief run after the `position`
                // borrow ends (below) to satisfy the borrow checker.
                let (lots_to_add, cover_outcome) = if cover_qty_abs > Decimal::ZERO {
                    let (cover_lots, residual_lots) =
                        split_lots_by_cover_quantity(&lots, cover_qty_abs);
                    // Proceeds = magnitude of the cost basis brought in by the
                    // covering incoming lots. Always positive (like the
                    // close_cost/close_proceeds convention in trades.rs);
                    // record_lot_disposals derives the realized-P/L sign from the
                    // removed lots' signed effective quantity. Taking the absolute
                    // value keeps both cover directions correct (incoming long
                    // covering a resident short, and incoming short covering a
                    // resident long — the cover lots' cost basis is negative for
                    // the latter).
                    let cover_proceeds: Decimal = cover_lots
                        .iter()
                        .map(|lot| lot.cost_basis)
                        .sum::<Decimal>()
                        .abs();
                    let reduction = if incoming_negative {
                        position.reduce_positive_lots_fifo(cover_qty_abs)?
                    } else {
                        position.reduce_negative_lots_fifo(cover_qty_abs)?
                    };
                    (residual_lots, Some((reduction, cover_proceeds)))
                } else {
                    (lots.clone(), None)
                };

                let cost_basis = position.add_transferred_lots(
                    &activity.id,
                    &lots_to_add,
                    None,
                    asset_info.allows_negative_lots,
                )?;
                let added_lots: Vec<Lot> = position
                    .lots
                    .iter()
                    .filter(|lot| lot.source_activity_id.as_deref() == Some(activity.id.as_str()))
                    .cloned()
                    .collect();
                // `position` borrow ends here; `state` is free again.

                if let Some((reduction, cover_proceeds)) = cover_outcome {
                    self.record_reduction(
                        &state.account_id,
                        asset_id,
                        activity,
                        &reduction,
                        cover_proceeds,
                        &position_currency,
                        run,
                        buffer,
                    );

                    // Relieve the covered resident lots' cost basis from
                    // net_contribution (same convention as TRANSFER_OUT).
                    if !position_currency.is_empty()
                        && reduction.cost_basis_removed != Decimal::ZERO
                    {
                        let removed_acct = self.lots_cost_basis_in_currency(
                            &reduction.removed_lots,
                            &position_currency,
                            account_currency,
                            activity_date,
                            &activity.id,
                        );
                        let base_ccy = self.base_currency.read().unwrap().clone();
                        let removed_base = self.lots_cost_basis_in_currency(
                            &reduction.removed_lots,
                            &position_currency,
                            &base_ccy,
                            activity_date,
                            &activity.id,
                        );
                        state.net_contribution -= removed_acct;
                        state.net_contribution_base -= removed_base;
                    }
                }

                // Stage the cache removal only if the lots were actually booked
                // (covered and/or added). If every incoming lot was skipped
                // (e.g. negative lots on a non-shortable asset), keep the cache
                // intact so the cost basis is not silently lost.
                if let Some(group_id) = activity.source_group_id.as_ref() {
                    if cover_qty_abs > Decimal::ZERO || !added_lots.is_empty() {
                        buffer.transfer_cache_removals.push(group_id.clone());
                    } else {
                        warn!(
                            "TransferIn {} booked none of the cached lots for asset {} \
                             (negative lots not allowed). Keeping cache entry.",
                            activity.id, asset_id
                        );
                    }
                }

                (cost_basis, added_lots)
            } else {
                // Fallback: no cached lots (external transfer or no source_group_id).
                // Use the activity's unit_price as the acquisition price.
                if activity.source_group_id.is_some() {
                    warn!(
                        "TransferIn {} has source_group_id but no cached lots from paired TransferOut. \
                         Using unit_price fallback (cost basis may be inaccurate).",
                        activity.id
                    );
                }
                let compiled_economics =
                    ActivityEconomicsResolver::compile_activity_with_unit_multiplier(
                        activity,
                        None,
                        TransferBoundary::External,
                        asset_info.contract_multiplier,
                    );
                let lot_unit_price = if activity.qty().is_zero() {
                    Decimal::ZERO
                } else {
                    compiled_economics.lot_cost_basis_value / activity.qty()
                };
                let (unit_price_for_lot, fee_for_lot, fx_rate_used) = if needs_conversion {
                    let (converted_price, converted_fee, _converted_tax, fx_rate) = self
                        .convert_to_position_currency(
                            lot_unit_price,
                            activity.fee_amt(),
                            Decimal::ZERO,
                            activity,
                            &position_currency,
                            account_currency,
                        )?;
                    (converted_price, converted_fee, fx_rate)
                } else {
                    (lot_unit_price, activity.fee_amt(), None)
                };

                let book_basis = self.lot_book_basis_for_activity(
                    activity,
                    &position_currency,
                    account_currency,
                );
                let cost_basis = position.add_lot_values(
                    activity.id.clone(),
                    activity.qty(),
                    unit_price_for_lot,
                    fee_for_lot,
                    Decimal::ZERO,
                    activity.activity_date,
                    fx_rate_used,
                    Some(activity.id.clone()),
                    book_basis,
                )?;
                let added_lots: Vec<crate::portfolio::snapshot::Lot> = position
                    .lots
                    .iter()
                    .filter(|lot| lot.source_activity_id.as_deref() == Some(activity.id.as_str()))
                    .cloned()
                    .collect();
                (cost_basis, added_lots)
            };

            // Book fee in ACTIVITY currency
            add_cash(state, activity_currency, -activity.fee_amt());

            let cost_basis_acct = if added_lots.is_empty() {
                self.convert_position_amount_to_account_currency(
                    cost_basis_asset_curr,
                    &position_currency,
                    activity,
                    account_currency,
                    "Net Deposit TransferIn Asset",
                )
            } else {
                self.lots_cost_basis_in_currency(
                    &added_lots,
                    &position_currency,
                    account_currency,
                    activity_date,
                    &activity.id,
                )
            };
            let base_ccy = self.base_currency.read().unwrap().clone();
            let cost_basis_base = if added_lots.is_empty() {
                match self.fx_service.convert_currency_for_date(
                    cost_basis_asset_curr,
                    &position_currency,
                    &base_ccy,
                    activity_date,
                ) {
                    Ok(converted) => converted,
                    Err(e) => {
                        warn!(
                            "Holdings Calc (NetContribBase TransferIn Asset {}): Failed conversion: {}.",
                            activity.id, e
                        );
                        cost_basis_asset_curr
                    }
                }
            } else {
                self.lots_cost_basis_in_currency(
                    &added_lots,
                    &position_currency,
                    &base_ccy,
                    activity_date,
                    &activity.id,
                )
            };

            state.net_contribution += cost_basis_acct;
            state.net_contribution_base += cost_basis_base;
        }
        Ok(())
    }

    /// Handle TRANSFER_OUT activity.
    /// Books cash/asset outflow in ACTIVITY currency.
    /// Transfers always affect account-level net_contribution; portfolio boundary is handled by aggregation.
    pub(crate) fn handle_transfer_out(
        &self,
        activity: &Activity,
        state: &mut AccountStateSnapshot,
        account_currency: &str,
        _asset_cache: &mut AssetCache,
        run: &ProjectionRun,
        buffer: &mut SideEffectBuffer,
    ) -> Result<()> {
        let activity_currency = &activity.currency;
        let activity_date = self.activity_local_date(activity);
        // Use absolute value - activity type dictates direction
        let activity_amount = -activity.amt().abs();
        let asset_id = activity.asset_id.as_deref().unwrap_or("");

        if asset_id.is_empty() {
            // Cash transfer: book outflow in ACTIVITY currency (amount + fee + tax)
            let net_amount = activity_amount - activity.fee_amt() - activity.tax_amt();
            add_cash(state, activity_currency, net_amount);

            let amount_acct = self.convert_to_account_currency(
                activity_amount,
                activity,
                account_currency,
                "TransferOut Cash",
            );

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
                        "Holdings Calc (NetContrib TransferOut Cash {}): Failed conversion {}: {}.",
                        activity.id, activity_currency, e
                    );
                    Decimal::ZERO
                }
            };

            state.net_contribution += amount_acct;
            state.net_contribution_base += amount_base;
        } else {
            // Asset transfer
            let activity_date = self.activity_local_date(activity);

            // Book fee in ACTIVITY currency
            add_cash(state, activity_currency, -activity.fee_amt());

            if let Some(position) = state.positions.get_mut(asset_id) {
                let position_currency = position.currency.clone();
                if position_currency.is_empty() {
                    warn!(
                        "Position {} being transferred out has no currency set.",
                        position.id
                    );
                }

                // Positions are single-signed (transfer-in nets opposite-sign
                // lots), so dispatching on the net position sign relieves the
                // correct leg.
                let transferred_short_position = position.quantity.is_sign_negative();
                let reduction = if transferred_short_position {
                    position.reduce_negative_lots_fifo(activity.qty())?
                } else {
                    position.reduce_lots_fifo(activity.qty())?
                };
                let cost_basis_removed = reduction.cost_basis_removed;
                let disposal_proceeds = if transferred_short_position {
                    cost_basis_removed.abs()
                } else {
                    cost_basis_removed
                };
                self.record_reduction(
                    &state.account_id,
                    asset_id,
                    activity,
                    &reduction,
                    disposal_proceeds,
                    &position_currency,
                    run,
                    buffer,
                );

                if !position_currency.is_empty() && cost_basis_removed != Decimal::ZERO {
                    let cost_basis_removed_acct = self.lots_cost_basis_in_currency(
                        &reduction.removed_lots,
                        &position_currency,
                        account_currency,
                        activity_date,
                        &activity.id,
                    );

                    let base_ccy = self.base_currency.read().unwrap().clone();
                    let cost_basis_removed_base = self.lots_cost_basis_in_currency(
                        &reduction.removed_lots,
                        &position_currency,
                        &base_ccy,
                        activity_date,
                        &activity.id,
                    );

                    state.net_contribution -= cost_basis_removed_acct;
                    state.net_contribution_base -= cost_basis_removed_base;
                }

                // Stage removed lots for the paired TRANSFER_IN (lot-level
                // transfer). Committed to the cache only if this TRANSFER_OUT
                // succeeds.
                if let Some(ref group_id) = activity.source_group_id {
                    if !reduction.removed_lots.is_empty() {
                        buffer
                            .transfer_cache_inserts
                            .push((group_id.clone(), reduction.removed_lots));
                    }
                }
            } else {
                warn!(
                    "Attempted to TransferOut non-existent position {} via activity {}. Fee applied only.",
                    asset_id, activity.id
                );
            }
        }
        Ok(())
    }
}
