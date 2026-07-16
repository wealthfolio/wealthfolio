//! Corporate-action handlers (SPLIT / ADJUSTMENT). `impl HoldingsCalculator`.
use super::super::economics::*;
use super::super::{HoldingsCalculator, ProjectionRun, SideEffectBuffer};
use crate::activities::Activity;
use crate::errors::Result;
use crate::portfolio::snapshot::AccountStateSnapshot;
use crate::utils::time_utils::{activity_date_in_tz, parse_user_timezone_or_default};
use log::{debug, warn};
use rust_decimal::Decimal;

impl HoldingsCalculator {
    /// Handle SPLIT activity.
    ///
    /// Multiplies the cumulative `split_ratio` of every open lot acquired
    /// before the split's user-local calendar date, leaving `quantity`,
    /// `acquisition_price`, `cost_basis`, and `acquisition_fees` unchanged.
    /// Lots opened on or after the split date are not affected (their
    /// as-acquired units are already post-split). See
    /// positions_model::Position::apply_split and
    /// docs/architecture/data_model.md §3.5.
    ///
    /// SPLIT has no cash effect. Fractional cashouts must be reported by the
    /// importer as a paired SELL activity; this handler does not synthesize one.
    ///
    /// The ratio is read from `activity.amount` (JB/MS bridge convention) with
    /// a fallback to `activity.quantity` if amount is NULL or zero — the API's
    /// import paths historically wrote quantity but not amount in some cases,
    /// and a SPLIT row whose amount column is NULL would otherwise be silently
    /// skipped. Both fields carry the same number when both are set.
    pub(crate) fn handle_split(
        &self,
        activity: &Activity,
        state: &mut AccountStateSnapshot,
        _asset_cache: &mut AssetCache,
    ) -> Result<()> {
        let asset_id = match activity.asset_id.as_deref() {
            Some(id) if !id.is_empty() => id,
            _ => {
                warn!("SPLIT activity {} has no asset_id; skipping.", activity.id);
                return Ok(());
            }
        };

        let ratio = {
            let amt = activity.amt();
            if amt.is_sign_positive() && !amt.is_zero() {
                amt
            } else {
                activity.qty()
            }
        };
        if !ratio.is_sign_positive() || ratio.is_zero() {
            warn!(
                "SPLIT activity {} on {} has non-positive ratio (amount={:?}, quantity={:?}); skipping.",
                activity.id, activity.activity_date, activity.amount, activity.quantity
            );
            return Ok(());
        }

        if let Some(position) = state.positions.get_mut(asset_id) {
            let split_date = self.activity_local_date(activity);
            let tz = parse_user_timezone_or_default(&self.timezone.read().unwrap());
            position.apply_split(ratio, split_date, &activity.id, |instant| {
                activity_date_in_tz(instant, tz)
            })?;
        } else {
            // Position not yet open in this account, so there are no local lots
            // for this split to adjust.
            debug!(
                "SPLIT activity {} for asset {} on {}: no open position, skipping.",
                activity.id, asset_id, activity.activity_date
            );
        }
        Ok(())
    }

    /// Handle ADJUSTMENT activity.
    /// Dispatches on subtype:
    /// - OPTION_EXPIRY: removes option lots via FIFO, no cash effect
    /// - Other/None: no-op (future: RoC basis adjustment, merger/spinoff, etc.)
    pub(crate) fn handle_adjustment(
        &self,
        activity: &Activity,
        state: &mut AccountStateSnapshot,
        _asset_cache: &mut AssetCache,
        run: &ProjectionRun,
        buffer: &mut SideEffectBuffer,
    ) -> Result<()> {
        use crate::activities::ACTIVITY_SUBTYPE_OPTION_EXPIRY;

        match activity.subtype.as_deref() {
            Some(subtype) if subtype.eq_ignore_ascii_case(ACTIVITY_SUBTYPE_OPTION_EXPIRY) => {
                let asset_id = activity.asset_id.as_deref().unwrap_or("");
                if let Some(position) = state.positions.get_mut(asset_id) {
                    let position_currency = position.currency.clone();
                    let qty = activity.qty();
                    // Positions are single-signed (transfer-in nets opposite-sign
                    // lots), so dispatching on the net position sign relieves the
                    // correct leg.
                    let reduction = if position.quantity < Decimal::ZERO {
                        position.reduce_negative_lots_fifo(qty)?
                    } else {
                        position.reduce_positive_lots_fifo(qty)?
                    };
                    self.record_reduction(
                        &state.account_id,
                        asset_id,
                        activity,
                        &reduction,
                        Decimal::ZERO,
                        &position_currency,
                        run,
                        buffer,
                    );
                    debug!(
                        "OPTION_EXPIRY: removed qty={} cost_basis={} from {} (activity {})",
                        reduction.quantity_reduced,
                        reduction.cost_basis_removed,
                        asset_id,
                        activity.id
                    );
                } else {
                    warn!(
                        "OPTION_EXPIRY: no position found for asset {} (activity {}). Skipping.",
                        asset_id, activity.id
                    );
                }
                // No cash effect for expiry
                Ok(())
            }
            _ => {
                // Other adjustments: no-op for now
                Ok(())
            }
        }
    }
}
