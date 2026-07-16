//! Trade handlers (BUY / SELL). `impl HoldingsCalculator`.
use super::super::economics::*;
use super::super::{HoldingsCalculator, ProjectionRun, SideEffectBuffer};
use crate::activities::Activity;
use crate::errors::{CalculatorError, Result};
use crate::portfolio::snapshot::AccountStateSnapshot;
use log::warn;
use rust_decimal::Decimal;

impl HoldingsCalculator {
    /// Handle BUY activity.
    /// Books cash outflow in ACTIVITY currency.
    pub(crate) fn handle_buy(
        &self,
        activity: &Activity,
        state: &mut AccountStateSnapshot,
        account_currency: &str,
        asset_cache: &mut AssetCache,
        run: &ProjectionRun,
        buffer: &mut SideEffectBuffer,
    ) -> Result<()> {
        let activity_currency = &activity.currency;
        let asset_id = activity.asset_id.as_deref().unwrap_or("");
        let account_id = state.account_id.clone();

        self.ensure_asset_cached(asset_id, activity_currency, asset_cache);
        let asset_info = asset_cache
            .get(asset_id)
            .cloned()
            .unwrap_or_else(|| AssetPositionInfo::fallback(activity_currency));
        let quantity = activity.qty();
        let close_only = has_position_close_intent(activity);

        if asset_info.allows_negative_lots && close_only {
            let existing_short_quantity = state
                .positions
                .get(asset_id)
                .map(negative_lot_effective_quantity_abs)
                .unwrap_or(Decimal::ZERO);

            if existing_short_quantity.is_zero() {
                return Err(CalculatorError::InvalidActivity(format!(
                    "BUY activity {} is marked POSITION_CLOSE for asset {} but no short position exists. Split the trade into valid open/close activities.",
                    activity.id, asset_id
                ))
                .into());
            }

            if quantity > existing_short_quantity {
                return Err(CalculatorError::InvalidActivity(format!(
                    "BUY activity {} is marked POSITION_CLOSE for {} units of asset {} but only {} are short. Split the excess into a separate Buy activity.",
                    activity.id, quantity, asset_id, existing_short_quantity
                ))
                .into());
            }
        }

        if asset_info.requires_explicit_short_intent {
            let existing_short_quantity = state
                .positions
                .get(asset_id)
                .map(negative_lot_effective_quantity_abs)
                .unwrap_or(Decimal::ZERO);

            if close_only && existing_short_quantity.is_zero() {
                return Err(CalculatorError::InvalidActivity(format!(
                    "BUY activity {} is marked POSITION_CLOSE for stock/ETF asset {} but no short position exists. Skipping cash and lot effects.",
                    activity.id, asset_id
                ))
                .into());
            }

            if !close_only && existing_short_quantity > Decimal::ZERO {
                return Err(CalculatorError::InvalidActivity(format!(
                    "BUY activity {} would reduce short stock/ETF asset {} without Buy to Cover intent. Skipping cash and lot effects.",
                    activity.id, asset_id
                ))
                .into());
            }
        }

        let position = self.get_or_create_position_mut_cached(
            state,
            asset_id,
            activity_currency,
            activity.activity_date,
            asset_cache,
        )?;

        // Determine position currency and if conversion is needed
        let position_currency = position.currency.clone();
        let needs_conversion =
            !position_currency.is_empty() && position_currency != activity.currency;

        // Get values for lot, converting if needed.
        let lot_unit_price = effective_unit_price(activity, &asset_info);
        let (unit_price_for_lot, fee_for_lot, tax_for_lot, fx_rate_used) = if needs_conversion {
            let (converted_price, converted_fee, converted_tax, fx_rate) = self
                .convert_to_position_currency(
                    lot_unit_price,
                    activity.fee_amt(),
                    activity.tax_amt(),
                    activity,
                    &position_currency,
                    account_currency,
                )?;
            (converted_price, converted_fee, converted_tax, fx_rate)
        } else {
            (lot_unit_price, activity.fee_amt(), activity.tax_amt(), None)
        };

        // Use add_lot_values to avoid cloning Activity
        let book_basis =
            self.lot_book_basis_for_activity(activity, &position_currency, account_currency);
        let mut cash_quantity = quantity;

        if asset_info.allows_negative_lots
            && (!asset_info.requires_explicit_short_intent || has_position_close_intent(activity))
        {
            let close_only = has_position_close_intent(activity);
            let short_quantity = negative_lot_effective_quantity_abs(position);
            let close_quantity = quantity.min(short_quantity);
            let open_quantity = quantity - close_quantity;

            if asset_info.requires_explicit_short_intent {
                cash_quantity = close_quantity;
            }

            if close_quantity > Decimal::ZERO {
                let close_fee = proportional_amount(fee_for_lot, close_quantity, quantity);
                let close_tax = proportional_amount(tax_for_lot, close_quantity, quantity);
                let close_cost = close_quantity * unit_price_for_lot + close_fee + close_tax;
                let reduction = position.reduce_negative_lots_fifo(close_quantity)?;
                self.record_reduction(
                    &account_id,
                    asset_id,
                    activity,
                    &reduction,
                    close_cost,
                    &position_currency,
                    run,
                    buffer,
                );
            }

            if open_quantity > Decimal::ZERO {
                if close_only {
                    if asset_info.requires_explicit_short_intent {
                        warn!(
                            "BUY activity {} covers {} of {} requested stock/ETF shares. Enter the excess as a separate Buy activity.",
                            activity.id, close_quantity, quantity
                        );
                    } else {
                        warn!(
                            "Option BUY activity {} is marked POSITION_CLOSE but only {} of {} contracts were short. Leaving unmatched quantity cash-only.",
                            activity.id, close_quantity, quantity
                        );
                    }
                } else {
                    let open_fee = proportional_amount(fee_for_lot, open_quantity, quantity);
                    let open_tax = proportional_amount(tax_for_lot, open_quantity, quantity);
                    let lot_id = if close_quantity > Decimal::ZERO {
                        format!("{}:open", activity.id)
                    } else {
                        activity.id.clone()
                    };
                    position.open_lot_signed(
                        lot_id,
                        open_quantity,
                        unit_price_for_lot,
                        open_fee,
                        open_tax,
                        activity.activity_date,
                        fx_rate_used,
                        Some(activity.id.clone()),
                        book_basis,
                        true,
                    )?;
                }
            }
        } else {
            let _cost_basis_asset_curr = position.add_lot_values(
                activity.id.clone(),
                quantity,
                unit_price_for_lot,
                fee_for_lot,
                tax_for_lot,
                activity.activity_date,
                fx_rate_used,
                Some(activity.id.clone()),
                book_basis,
            )?;
        }

        let gross_cost = proportional_amount(
            gross_trade_amount(activity, &asset_info),
            cash_quantity,
            quantity,
        );
        let cash_fee = proportional_amount(activity.fee_amt(), cash_quantity, quantity);
        let cash_tax = proportional_amount(activity.tax_amt(), cash_quantity, quantity);
        let total_cost = gross_cost + cash_fee + cash_tax;
        if activity_currency != account_currency {
            if let Some(fx_rate) = activity.fx_rate.filter(|r| *r != Decimal::ZERO) {
                // Broker converted at transaction time — book in account currency
                add_cash(state, account_currency, -(total_cost * fx_rate));
            } else {
                // No fx_rate — book in activity currency (multi-currency account)
                add_cash(state, activity_currency, -total_cost);
            }
        } else {
            add_cash(state, activity_currency, -total_cost);
        }

        Ok(())
    }

    /// Handle SELL activity.
    /// Books cash inflow in account currency when fx_rate is provided,
    /// otherwise in activity currency.
    pub(crate) fn handle_sell(
        &self,
        activity: &Activity,
        state: &mut AccountStateSnapshot,
        account_currency: &str,
        asset_cache: &mut AssetCache,
        run: &ProjectionRun,
        buffer: &mut SideEffectBuffer,
    ) -> Result<()> {
        let activity_currency = &activity.currency;
        let asset_id = activity.asset_id.as_deref().unwrap_or("");
        let account_id = state.account_id.clone();

        // Ensure cache is populated for multiplier lookup
        self.ensure_asset_cached(asset_id, activity_currency, asset_cache);

        let asset_info = asset_cache
            .get(asset_id)
            .cloned()
            .unwrap_or_else(|| AssetPositionInfo::fallback(activity_currency));

        let quantity = activity.qty();
        let close_only = has_position_close_intent(activity);
        if asset_info.allows_negative_lots && close_only {
            let existing_long_quantity = state
                .positions
                .get(asset_id)
                .map(positive_lot_effective_quantity)
                .unwrap_or(Decimal::ZERO);

            if existing_long_quantity.is_zero() {
                return Err(CalculatorError::InvalidActivity(format!(
                    "SELL activity {} is marked POSITION_CLOSE for asset {} but no long position exists. Split the trade into valid open/close activities.",
                    activity.id, asset_id
                ))
                .into());
            }

            if quantity > existing_long_quantity {
                return Err(CalculatorError::InvalidActivity(format!(
                    "SELL activity {} is marked POSITION_CLOSE for {} units of asset {} but only {} are long. Split the excess into a separate Sell activity.",
                    activity.id, quantity, asset_id, existing_long_quantity
                ))
                .into());
            }
        }

        let open_short_intent = has_sell_short_open_intent(activity);
        if asset_info.requires_explicit_short_intent {
            let existing_quantity = state
                .positions
                .get(asset_id)
                .map(|position| position.quantity)
                .unwrap_or(Decimal::ZERO);

            if open_short_intent && existing_quantity > Decimal::ZERO {
                return Err(CalculatorError::InvalidActivity(format!(
                    "SELL activity {} is marked POSITION_OPEN for stock/ETF asset {} while a long position exists. Split into a normal Sell and a Sell Short activity.",
                    activity.id, asset_id
                ))
                .into());
            }

            if !open_short_intent && existing_quantity < Decimal::ZERO {
                return Err(CalculatorError::InvalidActivity(format!(
                    "SELL activity {} would increase short stock/ETF asset {} without Sell Short intent. Skipping cash and lot effects.",
                    activity.id, asset_id
                ))
                .into());
            }
        }

        let total_proceeds =
            gross_trade_amount(activity, &asset_info) - activity.fee_amt() - activity.tax_amt();
        if activity_currency != account_currency {
            if let Some(fx_rate) = activity.fx_rate.filter(|r| *r != Decimal::ZERO) {
                // Broker converted at transaction time — book in account currency
                add_cash(state, account_currency, total_proceeds * fx_rate);
            } else {
                // No fx_rate — book in activity currency (multi-currency account)
                add_cash(state, activity_currency, total_proceeds);
            }
        } else {
            add_cash(state, activity_currency, total_proceeds);
        }

        if asset_info.allows_negative_lots
            && (!asset_info.requires_explicit_short_intent || open_short_intent)
        {
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
            let lot_unit_price = effective_unit_price(activity, &asset_info);
            let (unit_price_for_lot, fee_for_lot, tax_for_lot, fx_rate_used) = if needs_conversion {
                let (converted_price, converted_fee, converted_tax, fx_rate) = self
                    .convert_to_position_currency(
                        lot_unit_price,
                        activity.fee_amt(),
                        activity.tax_amt(),
                        activity,
                        &position_currency,
                        account_currency,
                    )?;
                (converted_price, converted_fee, converted_tax, fx_rate)
            } else {
                (lot_unit_price, activity.fee_amt(), activity.tax_amt(), None)
            };

            let long_quantity = positive_lot_effective_quantity(position);
            let close_quantity = quantity.min(long_quantity);
            let open_quantity = quantity - close_quantity;

            if close_quantity > Decimal::ZERO {
                let close_fee = proportional_amount(fee_for_lot, close_quantity, quantity);
                let close_tax = proportional_amount(tax_for_lot, close_quantity, quantity);
                let close_proceeds = close_quantity * unit_price_for_lot - close_fee - close_tax;
                let reduction = position.reduce_positive_lots_fifo(close_quantity)?;
                self.record_reduction(
                    &account_id,
                    asset_id,
                    activity,
                    &reduction,
                    close_proceeds,
                    &position_currency,
                    run,
                    buffer,
                );
            }

            if open_quantity > Decimal::ZERO {
                if close_only {
                    warn!(
                        "Option SELL activity {} is marked POSITION_CLOSE but only {} of {} contracts were long. Leaving unmatched quantity cash-only.",
                        activity.id, close_quantity, quantity
                    );
                } else {
                    let open_fee = proportional_amount(fee_for_lot, open_quantity, quantity);
                    let open_tax = proportional_amount(tax_for_lot, open_quantity, quantity);
                    let lot_id = if close_quantity > Decimal::ZERO {
                        format!("{}:open", activity.id)
                    } else {
                        activity.id.clone()
                    };
                    let book_basis = self.lot_book_basis_for_activity(
                        activity,
                        &position_currency,
                        account_currency,
                    );
                    position.open_lot_signed(
                        lot_id,
                        -open_quantity,
                        unit_price_for_lot,
                        open_fee,
                        open_tax,
                        activity.activity_date,
                        fx_rate_used,
                        Some(activity.id.clone()),
                        book_basis,
                        true,
                    )?;
                }
            }

            return Ok(());
        }

        if let Some(position) = state.positions.get_mut(asset_id) {
            let position_currency = position.currency.clone();
            let total_proceeds_position_currency = self
                .convert_activity_amount_to_position_currency(
                    total_proceeds,
                    activity,
                    &position_currency,
                    account_currency,
                    "sell proceeds",
                )?;
            let reduction = position.reduce_lots_fifo(activity.qty())?;
            self.record_reduction(
                &state.account_id,
                asset_id,
                activity,
                &reduction,
                total_proceeds_position_currency,
                &position_currency,
                run,
                buffer,
            );
        } else {
            warn!(
                "Attempted to Sell non-existent/zero position {} via activity {}. Applying cash effect only.",
                asset_id, activity.id
            );
        }
        Ok(())
    }
}
