use crate::activities::{Activity, ActivityType};
use crate::assets::AssetRepositoryTrait;
use crate::errors::{CalculatorError, Error, Result};
use crate::fx::FxServiceTrait;
use crate::lots::LotClosure;
use crate::portfolio::snapshot::AccountStateSnapshot;
use crate::portfolio::snapshot::HoldingsCalculationResult;
use crate::portfolio::snapshot::HoldingsCalculationWarning;
use crate::portfolio::snapshot::Position;
use crate::utils::time_utils::{activity_date_in_tz, parse_user_timezone_or_default};

use chrono::{DateTime, NaiveDate, Utc};
use log::{debug, error, warn};
use rust_decimal::Decimal;
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::{Arc, Mutex, RwLock};

/// Helper function for cash mutations.
/// Books cash in the specified currency (should be activity.currency per design spec).
#[inline]
fn add_cash(state: &mut AccountStateSnapshot, currency: &str, delta: Decimal) {
    *state
        .cash_balances
        .entry(currency.to_string())
        .or_insert(Decimal::ZERO) += delta;
}

/// Gross trade value (pre-fee) for a BUY/SELL/TRANSFER lot.
///
/// When `activity.amount` is present and non-zero it is authoritative — brokers
/// report it as the settled cash leg, which is correct for bonds quoted on a
/// per-$100-face convention (qty=face, price=99.x), in-kind transfers (amount
/// set, price absent), and any case where `qty * price` disagrees with the
/// booked cash. Falls back to `qty * price * multiplier` when amount is
/// missing — required for compiler-generated BUY/TRANSFER_IN legs (DRIP,
/// staking, dividend-in-kind) where the compiler clears `amount` so the
/// calculator derives the cash leg from qty * price.
#[inline]
fn gross_trade_amount(activity: &Activity, multiplier: Decimal) -> Decimal {
    match activity.amount {
        Some(a) if !a.is_zero() => a.abs(),
        _ => activity.qty() * activity.price() * multiplier,
    }
}

/// Per-share/per-contract acquisition price for a lot (multiplier-inclusive).
///
/// Mirrors `gross_trade_amount`: if `amount` is authoritative, derive the
/// per-unit price from it so the lot's cost basis matches the booked cash.
#[inline]
fn effective_unit_price(activity: &Activity, multiplier: Decimal) -> Decimal {
    let qty = activity.qty();
    match activity.amount {
        Some(a) if !a.is_zero() && !qty.is_zero() => a.abs() / qty,
        _ => activity.price() * multiplier,
    }
}

/// Calculates the holding state (positions, cash, cost basis, net deposits) based on activities.
/// It does not calculate market values or base currency conversions related to valuation.
#[derive(Clone)]
pub struct HoldingsCalculator {
    pub fx_service: Arc<dyn FxServiceTrait>, // only deals with activity/account currency adjustments
    pub base_currency: Arc<RwLock<String>>,
    pub timezone: Arc<RwLock<String>>,
    pub asset_repository: Arc<dyn AssetRepositoryTrait>,
    /// Cache for lots removed during TRANSFER_OUT, keyed by source_group_id.
    /// When a paired TRANSFER_IN is processed (possibly on a different account),
    /// the lots are consumed from this cache and added to the destination position,
    /// preserving original acquisition dates and cost basis.
    transfer_lots_cache: Arc<Mutex<HashMap<String, Vec<super::Lot>>>>,
    /// Accumulates lot closures (fully consumed lots) during a recalculation run,
    /// keyed by account_id. Cleared at the start of each run.
    disposed_lots: Arc<Mutex<HashMap<String, Vec<LotClosure>>>>,
}
impl HoldingsCalculator {
    pub fn new(
        fx_service: Arc<dyn FxServiceTrait>,
        base_currency: Arc<RwLock<String>>,
        asset_repository: Arc<dyn AssetRepositoryTrait>,
    ) -> Self {
        Self::new_with_timezone(
            fx_service,
            base_currency,
            Arc::new(RwLock::new(String::new())),
            asset_repository,
        )
    }

    pub fn new_with_timezone(
        fx_service: Arc<dyn FxServiceTrait>,
        base_currency: Arc<RwLock<String>>,
        timezone: Arc<RwLock<String>>,
        asset_repository: Arc<dyn AssetRepositoryTrait>,
    ) -> Self {
        Self {
            fx_service,
            base_currency,
            timezone,
            asset_repository,
            transfer_lots_cache: Arc::new(Mutex::new(HashMap::new())),
            disposed_lots: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Clears the transfer lots cache. Should be called at the start of each
    /// recalculation run to prevent stale data from previous runs.
    pub fn clear_transfer_lots_cache(&self) {
        if let Ok(mut cache) = self.transfer_lots_cache.lock() {
            cache.clear();
        }
    }

    /// Clears the disposed lots log. Should be called at the start of each recalculation run.
    pub fn clear_disposed_lots(&self) {
        if let Ok(mut log) = self.disposed_lots.lock() {
            log.clear();
        }
    }

    /// Returns and removes all accumulated lot closures for the given account.
    pub fn take_disposed_lots(&self, account_id: &str) -> Vec<LotClosure> {
        if let Ok(mut log) = self.disposed_lots.lock() {
            log.remove(account_id).unwrap_or_default()
        } else {
            Vec::new()
        }
    }

    /// Records a lot closure in the disposed lots log, carrying the full lot
    /// data so the persistence layer can INSERT the closed lot if it was never
    /// written to the database (e.g. during a full recalc/replay).
    fn record_lot_closure(
        &self,
        account_id: &str,
        asset_id: &str,
        lot: &super::Lot,
        close_date: &str,
        activity_id: &str,
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
        if let Ok(mut log) = self.disposed_lots.lock() {
            log.entry(account_id.to_string())
                .or_default()
                .push(LotClosure {
                    lot_id: lot.id.clone(),
                    close_date: close_date.to_string(),
                    close_activity_id: Some(activity_id.to_string()),
                    open_activity_id: lot.source_activity_id.clone(),
                    account_id: account_id.to_string(),
                    asset_id: asset_id.to_string(),
                    open_date: lot.acquisition_date.format("%Y-%m-%d").to_string(),
                    original_quantity: orig_qty.to_string(),
                    cost_per_unit: lot.acquisition_price.to_string(),
                    // Original/at-acquisition cost basis, reconstructed from
                    // the immutable acquisition_price / original_quantity /
                    // original_acquisition_fees.
                    original_cost_basis: (lot.acquisition_price * orig_qty + orig_fees).to_string(),
                    fee_allocated: orig_fees.to_string(),
                    // Carry the cumulative split ratio as of closure. A lot
                    // that lived through a 2:1 split before being fully
                    // consumed must persist with split_ratio = 2; otherwise
                    // downstream tax-lot reporting sees a wrong split history.
                    split_ratio: lot.effective_split_ratio().to_string(),
                });
        }
    }

    fn activity_local_date(&self, activity: &Activity) -> NaiveDate {
        let tz = parse_user_timezone_or_default(&self.timezone.read().unwrap());
        activity_date_in_tz(activity.activity_date, tz)
    }

    /// Calculates the next day's holding state based on the previous state and today's activities.
    /// Returns a snapshot with updated positions, cash, cost basis, and net deposits,
    /// but with valuation fields (market value, base conversions, day gain) potentially stale or zeroed.
    ///
    /// The result includes both the calculated snapshot and any warnings for activities that
    /// could not be processed. This allows callers to see which activities failed without
    /// stopping the entire calculation.
    pub fn calculate_next_holdings(
        &self,
        previous_snapshot: &AccountStateSnapshot,
        activities_today: &[Activity], // Assumes these are for the *target* date and already split-adjusted
        target_date: NaiveDate,
    ) -> Result<HoldingsCalculationResult> {
        debug!(
            "Calculating holdings for account {} on date {}",
            previous_snapshot.account_id, target_date
        );

        let mut next_state = previous_snapshot.clone();
        next_state.snapshot_date = target_date;
        next_state.calculated_at = Utc::now().naive_utc();
        next_state.cost_basis = Decimal::ZERO; // Will be recalculated at the end
        next_state.net_contribution = previous_snapshot.net_contribution; // Carry forward
        next_state.net_contribution_base = previous_snapshot.net_contribution_base;

        let account_currency = next_state.currency.clone();
        let mut warnings: Vec<HoldingsCalculationWarning> = Vec::new();

        // Session-wide asset info cache to avoid DB lookups per unique asset.
        // Stores (currency, is_alternative, contract_multiplier) for each asset.
        let mut asset_cache: HashMap<String, (String, bool, Decimal)> = HashMap::new();

        for activity in activities_today {
            if self.activity_local_date(activity) != target_date {
                let warning = HoldingsCalculationWarning {
                    activity_id: activity.id.clone(),
                    account_id: next_state.account_id.clone(),
                    date: target_date,
                    message: format!(
                        "Activity date {} does not match target snapshot date {}. Skipped.",
                        self.activity_local_date(activity),
                        target_date
                    ),
                };
                warn!("{}", warning);
                warnings.push(warning);
                continue;
            }
            match self.process_single_activity(
                activity,
                &mut next_state,
                &account_currency,
                &mut asset_cache,
            ) {
                Ok(_) => {} // Activity processed successfully
                Err(e) => {
                    let warning = HoldingsCalculationWarning {
                        activity_id: activity.id.clone(),
                        account_id: next_state.account_id.clone(),
                        date: target_date,
                        message: format!("Failed to process activity: {}", e),
                    };
                    error!("{}", warning);
                    warnings.push(warning);
                    // Continue processing other activities
                }
            }
        }

        // Recalculate cost basis in account currency using SNAPSHOT date rates
        let mut final_cost_basis_acct = Decimal::ZERO;
        for position in next_state.positions.values() {
            let position_currency = &position.currency;

            if position_currency.is_empty() {
                warn!(
                    "Position {} has no currency set. Skipping its cost basis.",
                    position.id
                );
                continue;
            }
            if position_currency == &account_currency {
                final_cost_basis_acct += position.total_cost_basis;
                continue;
            }

            match self.fx_service.convert_currency_for_date(
                position.total_cost_basis,
                position_currency,
                &account_currency,
                target_date,
            ) {
                Ok(converted_cost) => {
                    final_cost_basis_acct += converted_cost;
                }
                Err(e) => {
                    error!(
                         "Holdings Calc (Book Cost): Failed to convert {} {} to {} on {}: {}. Using original unconverted cost for snapshot.",
                         position.total_cost_basis, position_currency, account_currency, target_date, e
                     );
                    if position_currency != &account_currency {
                        final_cost_basis_acct += position.total_cost_basis;
                    }
                }
            }
        }
        next_state.cost_basis = final_cost_basis_acct;

        // Compute cash totals (once at end of day per spec)
        self.compute_cash_totals(&mut next_state, target_date);

        next_state.id = format!(
            "{}_{}",
            next_state.account_id,
            target_date.format("%Y-%m-%d")
        );

        Ok(HoldingsCalculationResult::with_warnings(
            next_state, warnings,
        ))
    }

    /// Processes a single activity, updating positions, cash, and net_deposit.
    /// Books cash in ACTIVITY currency (not account currency) per design spec.
    /// Uses asset_cache to avoid repeated DB lookups for asset currencies and kind info.
    fn process_single_activity(
        &self,
        activity: &Activity,
        state: &mut AccountStateSnapshot,
        account_currency: &str,
        asset_cache: &mut HashMap<String, (String, bool, Decimal)>,
    ) -> Result<()> {
        let activity_type = ActivityType::from_str(&activity.activity_type).map_err(|_| {
            CalculatorError::UnsupportedActivityType(activity.activity_type.clone())
        })?;

        // Dispatch to Specific Handlers
        // NOTE: Removed precomputation of amount_acct/fee_acct - handlers convert when needed
        match activity_type {
            ActivityType::Buy => self.handle_buy(activity, state, account_currency, asset_cache),
            ActivityType::Sell => self.handle_sell(activity, state, account_currency, asset_cache),
            ActivityType::Deposit => self.handle_deposit(activity, state, account_currency),
            ActivityType::Withdrawal => self.handle_withdrawal(activity, state, account_currency),
            ActivityType::Dividend | ActivityType::Interest | ActivityType::Credit => {
                self.handle_income(activity, state, account_currency)
            }
            ActivityType::Fee | ActivityType::Tax => {
                self.handle_charge(activity, state, &activity_type)
            }
            ActivityType::TransferIn => {
                self.handle_transfer_in(activity, state, account_currency, asset_cache)
            }
            ActivityType::TransferOut => {
                self.handle_transfer_out(activity, state, account_currency, asset_cache)
            }
            ActivityType::Split => self.handle_split(activity, state, asset_cache),
            ActivityType::Adjustment => self.handle_adjustment(activity, state, asset_cache),
            ActivityType::Unknown => {
                warn!(
                    "Unknown activity type for activity {}. Skipping.",
                    activity.id
                );
                Ok(())
            }
        }
    }

    // --- Activity Type Handlers ---
    // Per design spec: Book cash in ACTIVITY currency, not account currency.

    /// Handle BUY activity.
    /// Books cash outflow in ACTIVITY currency.
    fn handle_buy(
        &self,
        activity: &Activity,
        state: &mut AccountStateSnapshot,
        account_currency: &str,
        asset_cache: &mut HashMap<String, (String, bool, Decimal)>,
    ) -> Result<()> {
        let activity_currency = &activity.currency;
        let asset_id = activity.asset_id.as_deref().unwrap_or("");

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

        // For options, price is per-share but each contract covers `multiplier` shares
        let multiplier = asset_cache
            .get(asset_id)
            .map(|(_, _, m)| *m)
            .unwrap_or(Decimal::ONE);

        // Get values for lot, converting if needed.
        // Prefer the broker-reported `amount` (settled cash, multiplier-inclusive)
        // when present so lot cost basis matches the booked cash leg; otherwise
        // fall back to `price * multiplier`.
        let lot_unit_price = effective_unit_price(activity, multiplier);
        let (unit_price_for_lot, fee_for_lot, fx_rate_used) = if needs_conversion {
            let (converted_price, converted_fee, fx_rate) = self.convert_to_position_currency(
                lot_unit_price,
                activity.fee_amt(),
                activity,
                &position_currency,
                account_currency,
            )?;
            (converted_price, converted_fee, fx_rate)
        } else {
            (lot_unit_price, activity.fee_amt(), None)
        };

        // Use add_lot_values to avoid cloning Activity
        let _cost_basis_asset_curr = position.add_lot_values(
            activity.id.clone(),
            activity.qty(),
            unit_price_for_lot,
            fee_for_lot,
            activity.activity_date,
            fx_rate_used,
            Some(activity.id.clone()),
        )?;

        // Book cash outflow — prefer broker-reported `amount` when present
        let total_cost = gross_trade_amount(activity, multiplier) + activity.fee_amt();
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
    fn handle_sell(
        &self,
        activity: &Activity,
        state: &mut AccountStateSnapshot,
        account_currency: &str,
        asset_cache: &mut HashMap<String, (String, bool, Decimal)>,
    ) -> Result<()> {
        let activity_currency = &activity.currency;
        let asset_id = activity.asset_id.as_deref().unwrap_or("");

        // Ensure cache is populated for multiplier lookup
        self.ensure_asset_cached(asset_id, activity_currency, asset_cache);

        // Book cash inflow — prefer broker-reported `amount` when present.
        let multiplier = asset_cache
            .get(asset_id)
            .map(|(_, _, m)| *m)
            .unwrap_or(Decimal::ONE);
        let total_proceeds = gross_trade_amount(activity, multiplier) - activity.fee_amt();
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

        if let Some(position) = state.positions.get_mut(asset_id) {
            let reduction = position.reduce_lots_fifo(activity.qty())?;
            let close_date = self.activity_local_date(activity).to_string();
            for lot in &reduction.fully_consumed_lots {
                self.record_lot_closure(
                    &state.account_id,
                    asset_id,
                    lot,
                    &close_date,
                    &activity.id,
                );
            }
        } else {
            warn!(
                "Attempted to Sell non-existent/zero position {} via activity {}. Applying cash effect only.",
                asset_id, activity.id
            );
        }
        Ok(())
    }

    /// Handle DEPOSIT activity.
    /// Books cash inflow in ACTIVITY currency.
    /// Updates net_contribution in account currency.
    fn handle_deposit(
        &self,
        activity: &Activity,
        state: &mut AccountStateSnapshot,
        account_currency: &str,
    ) -> Result<()> {
        let activity_currency = &activity.currency;
        let activity_date = self.activity_local_date(activity);
        let activity_amount = activity.amt();

        // Book cash in ACTIVITY currency (amount - fee)
        let net_amount = activity_amount - activity.fee_amt();
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
    fn handle_withdrawal(
        &self,
        activity: &Activity,
        state: &mut AccountStateSnapshot,
        account_currency: &str,
    ) -> Result<()> {
        let activity_currency = &activity.currency;
        let activity_date = self.activity_local_date(activity);
        // Use absolute value - activity type dictates direction
        let activity_amount = -activity.amt().abs();

        // Book cash outflow in ACTIVITY currency (amount + fee)
        let net_amount = activity_amount - activity.fee_amt();
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
    fn handle_income(
        &self,
        activity: &Activity,
        state: &mut AccountStateSnapshot,
        account_currency: &str,
    ) -> Result<()> {
        use crate::activities::{ACTIVITY_SUBTYPE_BONUS, ACTIVITY_TYPE_CREDIT};

        let activity_currency = &activity.currency;
        let activity_amount = activity.amt();

        // Book cash in ACTIVITY currency (amount - fee)
        let net_amount = activity_amount - activity.fee_amt();
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
                        activity.id, activity_amount, activity_currency, &base_ccy, activity_date, e
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
    fn handle_charge(
        &self,
        activity: &Activity,
        state: &mut AccountStateSnapshot,
        activity_type: &ActivityType,
    ) -> Result<()> {
        let activity_currency = &activity.currency;

        // Determine charge amount: prefer fee field, fall back to amount
        let charge = if activity.fee_amt() != Decimal::ZERO {
            activity.fee_amt()
        } else {
            activity.amt()
        };

        if charge == Decimal::ZERO {
            warn!(
                "Activity {} ({}): 'fee' and 'amount' are both zero. No cash change.",
                activity.id,
                activity_type.as_str()
            );
            return Ok(());
        }

        // Book cash outflow in ACTIVITY currency
        add_cash(state, activity_currency, -charge.abs());

        // Charges do not affect net_contribution
        Ok(())
    }

    /// Handle TRANSFER_IN activity.
    /// Books cash/asset inflow in ACTIVITY currency.
    /// Transfers always affect account-level net_contribution; portfolio boundary is handled by aggregation.
    fn handle_transfer_in(
        &self,
        activity: &Activity,
        state: &mut AccountStateSnapshot,
        account_currency: &str,
        asset_cache: &mut HashMap<String, (String, bool, Decimal)>,
    ) -> Result<()> {
        let activity_currency = &activity.currency;
        let activity_amount = activity.amt();
        let asset_id = activity.asset_id.as_deref().unwrap_or("");

        if asset_id.is_empty() {
            // Cash transfer: book in ACTIVITY currency
            let net_amount = activity_amount - activity.fee_amt();
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

            // Try lot-level transfer: look up cached lots from paired TRANSFER_OUT
            let cached_lots = activity.source_group_id.as_ref().and_then(|group_id| {
                self.transfer_lots_cache
                    .lock()
                    .ok()
                    .and_then(|mut cache| cache.remove(group_id))
            });

            let cost_basis_asset_curr = if let Some(lots) = cached_lots {
                // Lot-level transfer: lots are already in the asset's position currency
                // (same asset = same listing currency), so no FX conversion needed.
                position.add_transferred_lots(&activity.id, &lots, None)?
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
                // For options, price is per-share but each contract covers `multiplier` shares
                let multiplier = asset_cache
                    .get(asset_id)
                    .map(|(_, _, m)| *m)
                    .unwrap_or(Decimal::ONE);

                // Prefer broker-reported `amount` when present so the lot cost
                // basis matches what actually moved.
                let lot_unit_price = effective_unit_price(activity, multiplier);
                let (unit_price_for_lot, fee_for_lot, fx_rate_used) = if needs_conversion {
                    let (converted_price, converted_fee, fx_rate) = self
                        .convert_to_position_currency(
                            lot_unit_price,
                            activity.fee_amt(),
                            activity,
                            &position_currency,
                            account_currency,
                        )?;
                    (converted_price, converted_fee, fx_rate)
                } else {
                    (lot_unit_price, activity.fee_amt(), None)
                };

                position.add_lot_values(
                    activity.id.clone(),
                    activity.qty(),
                    unit_price_for_lot,
                    fee_for_lot,
                    activity.activity_date,
                    fx_rate_used,
                    Some(activity.id.clone()),
                )?
            };

            // Book fee in ACTIVITY currency
            add_cash(state, activity_currency, -activity.fee_amt());

            let cost_basis_acct = self.convert_position_amount_to_account_currency(
                cost_basis_asset_curr,
                &position_currency,
                activity,
                account_currency,
                "Net Deposit TransferIn Asset",
            );

            let base_ccy = self.base_currency.read().unwrap();
            let cost_basis_base = match self.fx_service.convert_currency_for_date(
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
            };

            state.net_contribution += cost_basis_acct;
            state.net_contribution_base += cost_basis_base;
        }
        Ok(())
    }

    /// Handle TRANSFER_OUT activity.
    /// Books cash/asset outflow in ACTIVITY currency.
    /// Transfers always affect account-level net_contribution; portfolio boundary is handled by aggregation.
    fn handle_transfer_out(
        &self,
        activity: &Activity,
        state: &mut AccountStateSnapshot,
        account_currency: &str,
        _asset_cache: &mut HashMap<String, (String, bool, Decimal)>,
    ) -> Result<()> {
        let activity_currency = &activity.currency;
        let activity_date = self.activity_local_date(activity);
        // Use absolute value - activity type dictates direction
        let activity_amount = -activity.amt().abs();
        let asset_id = activity.asset_id.as_deref().unwrap_or("");

        if asset_id.is_empty() {
            // Cash transfer: book outflow in ACTIVITY currency (amount + fee)
            let net_amount = activity_amount - activity.fee_amt();
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

                let reduction = position.reduce_lots_fifo(activity.qty())?;
                let cost_basis_removed = reduction.cost_basis_removed;

                // Record fully consumed lots as closed
                let close_date = activity_date.to_string();
                for lot in &reduction.fully_consumed_lots {
                    self.record_lot_closure(
                        &state.account_id,
                        asset_id,
                        lot,
                        &close_date,
                        &activity.id,
                    );
                }

                // Cache removed lots for paired TRANSFER_IN (lot-level transfer)
                if let Some(ref group_id) = activity.source_group_id {
                    if !reduction.removed_lots.is_empty() {
                        if let Ok(mut cache) = self.transfer_lots_cache.lock() {
                            cache.insert(group_id.clone(), reduction.removed_lots);
                        }
                    }
                }

                if !position_currency.is_empty() && cost_basis_removed != Decimal::ZERO {
                    let cost_basis_removed_acct = self.convert_position_amount_to_account_currency(
                        cost_basis_removed,
                        &position_currency,
                        activity,
                        account_currency,
                        "Net Deposit TransferOut Asset",
                    );

                    let base_ccy = self.base_currency.read().unwrap();
                    let cost_basis_removed_base = match self.fx_service.convert_currency_for_date(
                        cost_basis_removed,
                        &position_currency,
                        &base_ccy,
                        activity_date,
                    ) {
                        Ok(converted) => converted,
                        Err(e) => {
                            warn!(
                                "Holdings Calc (NetContribBase TransferOut Asset {}): Failed conversion: {}.",
                                activity.id, e
                            );
                            cost_basis_removed
                        }
                    };

                    state.net_contribution -= cost_basis_removed_acct;
                    state.net_contribution_base -= cost_basis_removed_base;
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
    fn handle_split(
        &self,
        activity: &Activity,
        state: &mut AccountStateSnapshot,
        _asset_cache: &mut HashMap<String, (String, bool, Decimal)>,
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
    fn handle_adjustment(
        &self,
        activity: &Activity,
        state: &mut AccountStateSnapshot,
        _asset_cache: &mut HashMap<String, (String, bool, Decimal)>,
    ) -> Result<()> {
        use crate::activities::ACTIVITY_SUBTYPE_OPTION_EXPIRY;

        match activity.subtype.as_deref() {
            Some(subtype) if subtype.eq_ignore_ascii_case(ACTIVITY_SUBTYPE_OPTION_EXPIRY) => {
                let asset_id = activity.asset_id.as_deref().unwrap_or("");
                if let Some(position) = state.positions.get_mut(asset_id) {
                    let qty = activity.qty();
                    let reduction = position.reduce_lots_fifo(qty)?;
                    let close_date = self.activity_local_date(activity).to_string();
                    for lot in &reduction.fully_consumed_lots {
                        self.record_lot_closure(
                            &state.account_id,
                            asset_id,
                            lot,
                            &close_date,
                            &activity.id,
                        );
                    }
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

    /// Populates the asset cache for a given asset_id if not already present.
    fn ensure_asset_cached(
        &self,
        asset_id: &str,
        activity_currency: &str,
        cache: &mut HashMap<String, (String, bool, Decimal)>,
    ) {
        if !asset_id.is_empty() && !cache.contains_key(asset_id) {
            let (ccy, is_alt, multiplier) = self.get_position_info(asset_id).unwrap_or_else(|_| {
                warn!(
                    "Failed to get asset info for {}, using activity currency {} and multiplier 1",
                    asset_id, activity_currency
                );
                (activity_currency.to_string(), false, Decimal::ONE)
            });
            cache.insert(asset_id.to_string(), (ccy, is_alt, multiplier));
        }
    }

    /// Converts an amount from activity currency to account currency.
    /// If the activity has a valid fx_rate (Some and not zero), uses it directly.
    /// Otherwise, falls back to the FxService for conversion.
    /// The fx_rate represents the rate to convert from activity currency to account currency.
    fn convert_to_account_currency(
        &self,
        amount: Decimal,
        activity: &Activity,
        account_currency: &str,
        context: &str,
    ) -> Decimal {
        let activity_currency = &activity.currency;

        // If currencies are the same, no conversion needed
        if activity_currency == account_currency {
            return amount;
        }

        // Check if activity has a valid fx_rate (Some and not zero)
        if let Some(fx_rate) = activity.fx_rate {
            if fx_rate != Decimal::ZERO {
                // Use the provided fx_rate directly
                debug!(
                    "Using activity fx_rate {} for {} conversion {}->{} (activity {})",
                    fx_rate, context, activity_currency, account_currency, activity.id
                );
                return amount * fx_rate;
            }
        }

        // Fall back to FxService for conversion
        let activity_date = self.activity_local_date(activity);
        match self.fx_service.convert_currency_for_date(
            amount,
            activity_currency,
            account_currency,
            activity_date,
        ) {
            Ok(converted) => converted,
            Err(e) => {
                warn!(
                    "Holdings Calc ({} {}): Failed conversion {} {}->{} on {}: {}. Using original amount.",
                    context, activity.id, amount, activity_currency, account_currency, activity_date, e
                );
                amount // Fallback to original amount
            }
        }
    }

    /// Determines the currency, alternative asset flag, and contract multiplier for a position.
    /// Returns (currency, is_alternative, contract_multiplier).
    fn get_position_info(&self, asset_id: &str) -> Result<(String, bool, Decimal)> {
        debug!("Getting position info for asset_id: {}", asset_id);
        match self.asset_repository.get_by_id(asset_id) {
            Ok(asset) => {
                let is_alternative = asset.is_alternative();
                let multiplier = asset.contract_multiplier();
                Ok((asset.quote_ccy, is_alternative, multiplier))
            }
            Err(e) => {
                error!("Failed to get asset for asset_id '{}': {}", asset_id, e);
                Err(Error::Calculation(CalculatorError::Calculation(format!(
                    "Asset not found for id: {}",
                    asset_id
                ))))
            }
        }
    }

    /// Converts an amount from position currency to account currency.
    /// This is used for cost basis which is stored in position currency, not activity currency.
    /// When activity currency == position currency, uses activity's fx_rate if available.
    /// Otherwise, falls back to FxService with position currency.
    fn convert_position_amount_to_account_currency(
        &self,
        amount: Decimal,
        position_currency: &str,
        activity: &Activity,
        account_currency: &str,
        context: &str,
    ) -> Decimal {
        // If position currency matches account currency, no conversion needed
        if position_currency == account_currency {
            return amount;
        }

        // If activity currency matches position currency, we can use activity's fx_rate
        if activity.currency == position_currency {
            if let Some(fx_rate) = activity.fx_rate {
                if fx_rate != Decimal::ZERO {
                    debug!(
                        "Using activity fx_rate {} for {} conversion {}->{} (activity {})",
                        fx_rate, context, position_currency, account_currency, activity.id
                    );
                    return amount * fx_rate;
                }
            }
        }

        // Fall back to FxService for conversion
        let activity_date = self.activity_local_date(activity);
        match self.fx_service.convert_currency_for_date(
            amount,
            position_currency,
            account_currency,
            activity_date,
        ) {
            Ok(converted) => converted,
            Err(e) => {
                warn!(
                    "Holdings Calc ({} {}): Failed conversion {} {}->{} on {}: {}. Using original amount.",
                    context, activity.id, amount, position_currency, account_currency, activity_date, e
                );
                amount // Fallback to original amount
            }
        }
    }

    /// Helper method to get/create position with asset currency caching.
    /// Uses cache to avoid repeated DB lookups for the same asset.
    /// Cache stores (currency, is_alternative, contract_multiplier) tuple for each asset.
    fn get_or_create_position_mut_cached<'a>(
        &self,
        state: &'a mut AccountStateSnapshot,
        asset_id: &str,
        activity_currency: &str,
        date: DateTime<Utc>,
        cache: &mut HashMap<String, (String, bool, Decimal)>,
    ) -> std::result::Result<&'a mut Position, CalculatorError> {
        if asset_id.is_empty() {
            return Err(CalculatorError::InvalidActivity(format!(
                "Invalid asset_id for position: {}",
                asset_id
            )));
        }

        self.ensure_asset_cached(asset_id, activity_currency, cache);

        let (ref position_currency, is_alternative, multiplier) = cache[asset_id];

        Ok(state
            .positions
            .entry(asset_id.to_string())
            .or_insert_with(|| {
                Position::new_with_alternative_flag(
                    state.account_id.clone(),
                    asset_id.to_string(),
                    position_currency.clone(),
                    date,
                    is_alternative,
                    multiplier,
                )
            }))
    }

    /// Converts unit_price and fee to position currency.
    /// Returns (converted_price, converted_fee, fx_rate_used).
    fn convert_to_position_currency(
        &self,
        unit_price: Decimal,
        fee: Decimal,
        activity: &Activity,
        position_currency: &str,
        account_currency: &str,
    ) -> Result<(Decimal, Decimal, Option<Decimal>)> {
        let activity_date = self.activity_local_date(activity);

        // Determine when we can use the activity's fx_rate for position currency conversion
        let can_use_fx_rate =
            position_currency == account_currency || activity.currency == account_currency;

        if can_use_fx_rate {
            if let Some(fx_rate) = activity.fx_rate.filter(|r| *r != Decimal::ZERO) {
                debug!(
                    "Using activity fx_rate {} for position currency conversion {} -> {} (activity {})",
                    fx_rate, activity.currency, position_currency, activity.id
                );
                return Ok((unit_price * fx_rate, fee * fx_rate, Some(fx_rate)));
            }
        }

        // Fall back to FxService
        let converted_price = self
            .fx_service
            .convert_currency_for_date(
                unit_price,
                &activity.currency,
                position_currency,
                activity_date,
            )
            .map_err(|e| {
                CalculatorError::CurrencyConversion(format!(
                    "Failed to convert unit_price from {} to {}: {}",
                    activity.currency, position_currency, e
                ))
            })?;

        let converted_fee = self
            .fx_service
            .convert_currency_for_date(fee, &activity.currency, position_currency, activity_date)
            .map_err(|e| {
                CalculatorError::CurrencyConversion(format!(
                    "Failed to convert fee from {} to {}: {}",
                    activity.currency, position_currency, e
                ))
            })?;

        // Calculate implied fx_rate for audit trail
        let fx_rate_used = if unit_price != Decimal::ZERO {
            Some(converted_price / unit_price)
        } else {
            None
        };

        Ok((converted_price, converted_fee, fx_rate_used))
    }

    /// Computes cash totals in account and base currencies.
    /// Called once at end of daily calculation per spec.
    fn compute_cash_totals(&self, state: &mut AccountStateSnapshot, target_date: NaiveDate) {
        let account_currency = &state.currency;
        let base_ccy = self.base_currency.read().unwrap();

        let mut total_acct = Decimal::ZERO;
        let mut total_base = Decimal::ZERO;

        for (currency, &amount) in &state.cash_balances {
            // Convert to account currency
            if currency == account_currency {
                total_acct += amount;
            } else {
                match self.fx_service.convert_currency_for_date(
                    amount,
                    currency,
                    account_currency,
                    target_date,
                ) {
                    Ok(converted) => total_acct += converted,
                    Err(e) => {
                        warn!(
                            "Failed to convert cash {} {} to account currency {}: {}. Using unconverted.",
                            amount, currency, account_currency, e
                        );
                        total_acct += amount;
                    }
                }
            }

            // Convert to base currency
            if currency == base_ccy.as_str() {
                total_base += amount;
            } else {
                match self.fx_service.convert_currency_for_date(
                    amount,
                    currency,
                    &base_ccy,
                    target_date,
                ) {
                    Ok(converted) => total_base += converted,
                    Err(e) => {
                        warn!(
                            "Failed to convert cash {} {} to base currency {}: {}. Using unconverted.",
                            amount, currency, &base_ccy, e
                        );
                        total_base += amount;
                    }
                }
            }
        }

        state.cash_total_account_currency = total_acct;
        state.cash_total_base_currency = total_base;
    }
}
