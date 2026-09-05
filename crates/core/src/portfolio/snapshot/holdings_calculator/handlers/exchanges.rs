//! Exchange handlers (EXCHANGE_OUT / EXCHANGE_IN, ADJUSTMENT subtypes). `impl HoldingsCalculator`.
//!
//! Represents an in-kind, same-account exchange of one asset for another with
//! no cash movement (e.g. Spain's tax-deferred fund "traspaso", a share-class
//! conversion, a fund merger). The closing leg (EXCHANGE_OUT) removes lots via
//! FIFO; the opening leg (EXCHANGE_IN) adds lots carrying over that cost basis
//! rather than pricing at market. Neither leg touches `net_contribution` (this
//! is neither new capital in nor out), and neither leg records a realized
//! gain/loss visible to reporting — `record_reduction` always writes a lot
//! disposal row, but every realized-gain surface filters disposals to BUY/SELL
//! activities, so an ADJUSTMENT-typed disposal (like OPTION_EXPIRY's) is
//! already excluded by construction.
use super::super::economics::*;
use super::super::{HoldingsCalculator, ProjectionRun, SideEffectBuffer};
use crate::activities::Activity;
use crate::errors::Result;
use crate::portfolio::snapshot::AccountStateSnapshot;
use log::warn;

impl HoldingsCalculator {
    /// Handle EXCHANGE_OUT: closing leg of an in-kind asset exchange. Removes
    /// lots via FIFO with no cash effect and no net_contribution change, and
    /// stages the removed lots (plus this position's currency) for the paired
    /// EXCHANGE_IN leg via the exchange-lots cache.
    pub(crate) fn handle_exchange_out(
        &self,
        activity: &Activity,
        state: &mut AccountStateSnapshot,
        run: &ProjectionRun,
        buffer: &mut SideEffectBuffer,
    ) -> Result<()> {
        let asset_id = match activity.asset_id.as_deref() {
            Some(id) if !id.is_empty() => id,
            _ => {
                warn!(
                    "EXCHANGE_OUT activity {} has no asset_id; skipping.",
                    activity.id
                );
                return Ok(());
            }
        };

        let Some(position) = state.positions.get_mut(asset_id) else {
            warn!(
                "EXCHANGE_OUT {}: no position found for asset {}. Skipping.",
                activity.id, asset_id
            );
            return Ok(());
        };

        let position_currency = position.currency.clone();
        let transferred_short_position = position.quantity.is_sign_negative();
        let reduction = if transferred_short_position {
            position.reduce_negative_lots_fifo(activity.qty())?
        } else {
            position.reduce_lots_fifo(activity.qty())?
        };

        // Record each removed lot's disposal against its own cost basis (not
        // apportioned by quantity like a normal sale, since a fund switch's
        // per-lot unit cost can differ a lot across lots) so every disposal's
        // realized_pnl is exactly zero. The row is still excluded from
        // reporting because it isn't a BUY/SELL activity (see module doc).
        for lot in &reduction.removed_lots {
            self.record_lot_disposals(
                &state.account_id,
                asset_id,
                activity,
                std::slice::from_ref(lot),
                lot.cost_basis.abs(),
                lot.effective_quantity(),
                &position_currency,
                run,
                buffer,
            );
        }
        let close_date = self.activity_local_date(activity).to_string();
        for lot in &reduction.fully_consumed_lots {
            self.record_lot_closure(
                &state.account_id,
                asset_id,
                lot,
                &close_date,
                &activity.id,
                &position_currency,
                run,
                buffer,
            );
        }

        // net_contribution is intentionally left untouched: an exchange is
        // neither new capital in nor out.

        if let Some(group_id) = activity.source_group_id.as_ref() {
            if !reduction.removed_lots.is_empty() {
                buffer.exchange_cache_inserts.push((
                    group_id.clone(),
                    position_currency,
                    reduction.removed_lots,
                ));
            }
        } else {
            warn!(
                "EXCHANGE_OUT {} has no source_group_id; the paired EXCHANGE_IN leg cannot carry over cost basis.",
                activity.id
            );
        }

        Ok(())
    }

    /// Handle EXCHANGE_IN: opening leg of an in-kind asset exchange. Adds lots
    /// carrying over cost basis from the paired EXCHANGE_OUT leg (via the
    /// exchange-lots cache), converted to this asset's currency, with each new
    /// lot preserving its source lot's original acquisition date. No
    /// net_contribution change.
    pub(crate) fn handle_exchange_in(
        &self,
        activity: &Activity,
        state: &mut AccountStateSnapshot,
        asset_cache: &mut AssetCache,
        run: &ProjectionRun,
        buffer: &mut SideEffectBuffer,
    ) -> Result<()> {
        let asset_id = match activity.asset_id.as_deref() {
            Some(id) if !id.is_empty() => id,
            _ => {
                warn!(
                    "EXCHANGE_IN activity {} has no asset_id; skipping.",
                    activity.id
                );
                return Ok(());
            }
        };

        let Some(group_id) = activity.source_group_id.as_ref() else {
            warn!(
                "EXCHANGE_IN {} has no source_group_id; cannot carry over cost basis. Skipping.",
                activity.id
            );
            return Ok(());
        };

        let Some((source_currency, source_lots)) = run.exchange_lots_cache.get(group_id).cloned()
        else {
            warn!(
                "EXCHANGE_IN {} has no cached lots from a paired EXCHANGE_OUT (group {}). Skipping.",
                activity.id, group_id
            );
            return Ok(());
        };

        let activity_date = self.activity_local_date(activity);
        let asset_info = {
            let position = self.get_or_create_position_mut_cached(
                state,
                asset_id,
                &activity.currency,
                activity.activity_date,
                asset_cache,
            )?;
            position.currency.clone()
        };
        let position_currency = asset_info;

        let fx_rate = if position_currency == source_currency {
            None
        } else {
            match self.fx_service.get_exchange_rate_for_date(
                &source_currency,
                &position_currency,
                activity_date,
            ) {
                Ok(rate) => Some(rate),
                Err(e) => {
                    warn!(
                        "EXCHANGE_IN {}: failed to get {}->{} rate on {}: {}. Carrying cost basis unconverted.",
                        activity.id, source_currency, position_currency, activity_date, e
                    );
                    None
                }
            }
        };

        let asset_info = asset_cache
            .get(asset_id)
            .cloned()
            .unwrap_or_else(|| AssetPositionInfo::fallback(&activity.currency));

        let position = state
            .positions
            .get_mut(asset_id)
            .expect("position was just created/fetched above");

        let cost_basis_added = position.add_exchanged_lots(
            &activity.id,
            &source_lots,
            activity.qty(),
            fx_rate,
            activity.fee_amt(),
            activity.tax_amt(),
            asset_info.allows_negative_lots,
        )?;

        if cost_basis_added.is_zero() {
            warn!(
                "EXCHANGE_IN {} added no lots for asset {} (target quantity or cached lots invalid).",
                activity.id, asset_id
            );
        }

        buffer.exchange_cache_removals.push(group_id.clone());

        // net_contribution is intentionally left untouched: an exchange is
        // neither new capital in nor out.

        Ok(())
    }
}
