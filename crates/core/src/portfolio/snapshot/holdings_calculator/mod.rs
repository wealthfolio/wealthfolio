use crate::accounts::account_types;
use crate::activities::{Activity, ActivityType};
use crate::assets::AssetRepositoryTrait;
use crate::errors::{CalculatorError, Result};
use crate::fx::FxServiceTrait;
use crate::lots::{extract_lot_records_with_cost_basis_method, LotClosure, LotDisposal, LotRecord};
use crate::portfolio::snapshot::AccountStateSnapshot;
use crate::portfolio::snapshot::HoldingsCalculationResult;
use crate::portfolio::snapshot::HoldingsCalculationWarning;
use crate::utils::time_utils::{activity_date_in_tz, parse_user_timezone_or_default};

use chrono::{DateTime, NaiveDate, Utc};
use log::{debug, warn};
use rust_decimal::Decimal;
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::{Arc, RwLock};

/// Currency-conversion, asset-cache, and cash-total helpers (`impl HoldingsCalculator`).
mod fx;
/// LotBook: tax-lot disposal/closure recording (`impl HoldingsCalculator`).
mod lots;

/// Trade-economics/intent helpers and asset-fact cache types.
/// `pub(crate)` so other modules (e.g. health checks) reuse the canonical trade math.
pub(crate) mod economics;
/// Per-activity handlers grouped by domain.
mod handlers;
use economics::*;

/// Calculates the holding state (positions, cash, cost basis, net deposits) based on activities.
/// It does not calculate market values or base currency conversions related to valuation.
/// Stateless projector of holdings: it owns only its (thread-safe) service
/// dependencies. All per-recalculation-run state lives in a [`ProjectionRun`]
/// that the caller threads through `calculate_next_holdings*`.
#[derive(Clone)]
pub struct HoldingsCalculator {
    pub fx_service: Arc<dyn FxServiceTrait>, // only deals with activity/account currency adjustments
    pub base_currency: Arc<RwLock<String>>,
    pub timezone: Arc<RwLock<String>>,
    pub asset_repository: Arc<dyn AssetRepositoryTrait>,
}

/// Mutable state accumulated across a single recalculation run.
///
/// A single run spans every account and day being recalculated. It must not be
/// recreated per account or per day, because paired security transfers use
/// `source_group_id` to move lot-level cost basis through this run state, and
/// lot disposals/closures are drained after the final in-memory snapshots are
/// produced. This replaces the previous shared `Arc<Mutex<_>>` caches with one
/// explicit owner.
#[derive(Default)]
#[must_use = "ProjectionRun carries transfer-lot and disposal state for a full recalculation run"]
pub struct ProjectionRun {
    /// Lots removed during TRANSFER_OUT, keyed by source_group_id. A paired
    /// TRANSFER_IN (possibly on a different account or day) consumes them,
    /// preserving original acquisition dates and cost basis.
    transfer_lots_cache: HashMap<String, Vec<super::Lot>>,
    /// Lot closures (fully consumed lots) accumulated during the run, by account_id.
    disposed_lots: HashMap<String, Vec<LotClosure>>,
    /// Sell/transfer disposal slices accumulated during the run, by account_id.
    lot_disposals: HashMap<String, Vec<LotDisposal>>,
    /// Cost-basis method selected for each account during the run.
    cost_basis_methods: HashMap<String, String>,
}

impl ProjectionRun {
    /// Create projection state for one full recalculation run.
    ///
    /// Keep this value alive across all accounts and dates in that run. Creating
    /// a fresh `ProjectionRun` for each day or account will lose paired transfer
    /// lots and disposal artifacts.
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_cost_basis_method(&mut self, account_id: &str, cost_basis_method: &str) {
        self.cost_basis_methods.insert(
            account_id.to_string(),
            cost_basis_method.trim().to_ascii_uppercase(),
        );
    }

    fn cost_basis_method_for_account(&self, account_id: &str) -> String {
        self.cost_basis_methods
            .get(account_id)
            .cloned()
            .unwrap_or_else(|| "FIFO".to_string())
    }

    /// Returns and removes all accumulated lot closures for the given account,
    /// retagging them with the supplied cost-basis method.
    pub fn take_disposed_lots(
        &mut self,
        account_id: &str,
        cost_basis_method: &str,
    ) -> Vec<LotClosure> {
        let mut closures = self.disposed_lots.remove(account_id).unwrap_or_default();
        let cost_basis_method = cost_basis_method.trim().to_ascii_uppercase();
        for closure in &mut closures {
            closure.cost_basis_method = cost_basis_method.clone();
        }
        closures
    }

    /// Returns and removes all accumulated disposal slices for the given account,
    /// retagging them with the supplied cost-basis method.
    pub fn take_lot_disposals(
        &mut self,
        account_id: &str,
        cost_basis_method: &str,
    ) -> Vec<LotDisposal> {
        let mut disposals = self.lot_disposals.remove(account_id).unwrap_or_default();
        let cost_basis_method = cost_basis_method.trim().to_ascii_uppercase();
        for disposal in &mut disposals {
            disposal.cost_basis_method = cost_basis_method.clone();
        }
        disposals
    }

    /// Flush a successful activity's staged side effects into the run-level
    /// caches. Called only after the activity's snapshot mutation is committed.
    fn commit_side_effects(&mut self, buffer: SideEffectBuffer) {
        for (account_id, closure) in buffer.disposed_lots {
            self.disposed_lots
                .entry(account_id)
                .or_default()
                .push(closure);
        }
        for (account_id, disposal) in buffer.lot_disposals {
            self.lot_disposals
                .entry(account_id)
                .or_default()
                .push(disposal);
        }
        for (group_id, lots) in buffer.transfer_cache_inserts {
            self.transfer_lots_cache.insert(group_id, lots);
        }
        for group_id in buffer.transfer_cache_removals {
            self.transfer_lots_cache.remove(&group_id);
        }
    }
}

/// Side effects produced while processing a single activity. They are staged
/// here and only flushed into the [`ProjectionRun`] once the activity succeeds.
/// A handler that returns `Err` drops its buffer, so a failed activity leaves
/// no lot disposals, closures, or transfer-cache mutations behind (atomicity).
#[derive(Default)]
pub(crate) struct SideEffectBuffer {
    /// (account_id, closure) pairs for fully consumed lots.
    disposed_lots: Vec<(String, LotClosure)>,
    /// (account_id, disposal) pairs for sold/transferred lot slices.
    lot_disposals: Vec<(String, LotDisposal)>,
    /// (source_group_id, lots) removed during a TRANSFER_OUT, to be cached for
    /// the paired TRANSFER_IN.
    transfer_cache_inserts: Vec<(String, Vec<super::Lot>)>,
    /// source_group_ids whose cached lots were consumed by a TRANSFER_IN.
    transfer_cache_removals: Vec<String>,
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
        }
    }

    pub fn extract_lot_records_with_base(
        &self,
        snapshot: &AccountStateSnapshot,
        cost_basis_method: &str,
    ) -> Vec<LotRecord> {
        let mut records = extract_lot_records_with_cost_basis_method(snapshot, cost_basis_method);
        let base_currency = self.base_currency.read().unwrap().clone();
        let position_currency_by_asset: HashMap<&str, &str> = snapshot
            .positions
            .values()
            .map(|position| (position.asset_id.as_str(), position.currency.as_str()))
            .collect();
        let lot_by_asset_and_id: HashMap<(&str, &str), &super::Lot> = snapshot
            .positions
            .values()
            .flat_map(|position| {
                position
                    .lots
                    .iter()
                    .map(move |lot| ((position.asset_id.as_str(), lot.id.as_str()), lot))
            })
            .collect();

        for record in &mut records {
            let lot_currency = position_currency_by_asset
                .get(record.asset_id.as_str())
                .copied()
                .unwrap_or(snapshot.currency.as_str());
            let acquisition_date = NaiveDate::parse_from_str(&record.open_date, "%Y-%m-%d")
                .unwrap_or(snapshot.snapshot_date);
            let fx_rate_to_base = lot_by_asset_and_id
                .get(&(record.asset_id.as_str(), record.id.as_str()))
                .and_then(|lot| lot.stored_fx_rate_to(&base_currency))
                .unwrap_or_else(|| {
                    self.fx_rate_to_base(lot_currency, &base_currency, acquisition_date)
                });
            let original_cost_basis = parse_decimal_lossy(&record.original_cost_basis);
            let remaining_cost_basis = parse_decimal_lossy(&record.remaining_cost_basis);
            let fee_allocated = parse_decimal_lossy(&record.fee_allocated);
            let tax_allocated = parse_decimal_lossy(&record.tax_allocated);

            record.currency = lot_currency.to_string();
            record.base_currency = base_currency.clone();
            record.fx_rate_to_base = fx_rate_to_base.to_string();
            record.original_cost_basis_base = (original_cost_basis * fx_rate_to_base).to_string();
            record.remaining_cost_basis_base = (remaining_cost_basis * fx_rate_to_base).to_string();
            record.fee_allocated_base = (fee_allocated * fx_rate_to_base).to_string();
            record.tax_allocated_base = (tax_allocated * fx_rate_to_base).to_string();
        }

        records
    }

    fn fx_rate_to_base(
        &self,
        from_currency: &str,
        base_currency: &str,
        date: NaiveDate,
    ) -> Decimal {
        self.fx_rate_for_basis(from_currency, base_currency, date, "extract-lot-records")
            .unwrap_or(Decimal::ZERO)
    }

    fn fx_rate_to_base_for_lot(
        &self,
        lot: &super::Lot,
        from_currency: &str,
        base_currency: &str,
        date: NaiveDate,
    ) -> Decimal {
        lot.stored_fx_rate_to(base_currency)
            .unwrap_or_else(|| self.fx_rate_to_base(from_currency, base_currency, date))
    }

    fn activity_local_date(&self, activity: &Activity) -> NaiveDate {
        self.activity_local_date_from_utc(activity.activity_date)
    }

    fn activity_local_date_from_utc(&self, activity_date: DateTime<Utc>) -> NaiveDate {
        let tz = parse_user_timezone_or_default(&self.timezone.read().unwrap());
        activity_date_in_tz(activity_date, tz)
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
        run: &mut ProjectionRun,
        previous_snapshot: &AccountStateSnapshot,
        activities_today: &[Activity], // Assumes these are for the *target* date and already split-adjusted
        target_date: NaiveDate,
    ) -> Result<HoldingsCalculationResult> {
        self.calculate_next_holdings_for_account_type(
            run,
            previous_snapshot,
            activities_today,
            target_date,
            None,
        )
    }

    pub fn calculate_next_holdings_for_account_type(
        &self,
        run: &mut ProjectionRun,
        previous_snapshot: &AccountStateSnapshot,
        activities_today: &[Activity], // Assumes these are for the *target* date and already split-adjusted
        target_date: NaiveDate,
        account_type: Option<&str>,
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
        let mut asset_cache: AssetCache = HashMap::new();

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
            let activity_type = ActivityType::from_str(activity.effective_type()).ok();
            let requires_atomic_scratch = activity_type
                .as_ref()
                .is_some_and(Self::activity_requires_atomic_scratch);

            if requires_atomic_scratch {
                // Position/lot handlers can partially mutate state before a
                // later validation or FX step fails. Run them against a scratch
                // clone and flush side effects only after success.
                let mut scratch = next_state.clone();
                let mut side_effects = SideEffectBuffer::default();
                match self.process_single_activity(
                    activity,
                    &mut scratch,
                    &account_currency,
                    &mut asset_cache,
                    account_type,
                    run,
                    &mut side_effects,
                ) {
                    Ok(_) => {
                        next_state = scratch;
                        run.commit_side_effects(side_effects);
                    }
                    Err(e) => {
                        // Drop scratch + side_effects: no partial mutation persists.
                        Self::push_activity_warning(
                            &mut warnings,
                            activity,
                            &next_state.account_id,
                            target_date,
                            e,
                        );
                    }
                }
            } else {
                // Cash-only handlers are already all-or-nothing and do not
                // touch run-level artifacts, so avoid cloning the full snapshot
                // for common deposit/dividend/fee rows.
                let mut side_effects = SideEffectBuffer::default();
                match self.process_single_activity(
                    activity,
                    &mut next_state,
                    &account_currency,
                    &mut asset_cache,
                    account_type,
                    run,
                    &mut side_effects,
                ) {
                    Ok(_) => run.commit_side_effects(side_effects),
                    Err(e) => {
                        // Unsupported activity types reach this path before any mutation.
                        Self::push_activity_warning(
                            &mut warnings,
                            activity,
                            &next_state.account_id,
                            target_date,
                            e,
                        );
                    }
                }
            }
        }

        // Recalculate cost basis in account currency using historical lot FX.
        // Book cost must stay anchored to acquisition-date FX; only market value
        // should move with valuation-date FX.
        let mut final_cost_basis_acct = Decimal::ZERO;
        for position in next_state.positions.values() {
            final_cost_basis_acct += self.position_cost_basis_in_account_currency(
                position,
                &account_currency,
                target_date,
            );
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
    #[allow(clippy::too_many_arguments)]
    fn process_single_activity(
        &self,
        activity: &Activity,
        state: &mut AccountStateSnapshot,
        account_currency: &str,
        asset_cache: &mut AssetCache,
        account_type: Option<&str>,
        run: &ProjectionRun,
        buffer: &mut SideEffectBuffer,
    ) -> Result<()> {
        let activity_type = ActivityType::from_str(activity.effective_type()).map_err(|_| {
            CalculatorError::UnsupportedActivityType(activity.effective_type().to_string())
        })?;

        // Dispatch to Specific Handlers
        // NOTE: Removed precomputation of amount_acct/fee_acct - handlers convert when needed
        match activity_type {
            ActivityType::Buy => {
                self.handle_buy(activity, state, account_currency, asset_cache, run, buffer)
            }
            ActivityType::Sell => {
                self.handle_sell(activity, state, account_currency, asset_cache, run, buffer)
            }
            ActivityType::Deposit => self.handle_deposit(activity, state, account_currency),
            ActivityType::Withdrawal => self.handle_withdrawal(activity, state, account_currency),
            ActivityType::Interest if account_type == Some(account_types::CREDIT_CARD) => {
                self.handle_charge(activity, state, &activity_type)
            }
            ActivityType::Dividend | ActivityType::Interest | ActivityType::Credit => {
                self.handle_income(activity, state, account_currency)
            }
            ActivityType::Fee | ActivityType::Tax => {
                self.handle_charge(activity, state, &activity_type)
            }
            ActivityType::TransferIn => {
                self.handle_transfer_in(activity, state, account_currency, asset_cache, run, buffer)
            }
            ActivityType::TransferOut => self.handle_transfer_out(
                activity,
                state,
                account_currency,
                asset_cache,
                run,
                buffer,
            ),
            ActivityType::Split => self.handle_split(activity, state, asset_cache),
            ActivityType::Adjustment => {
                self.handle_adjustment(activity, state, asset_cache, run, buffer)
            }
            ActivityType::Unknown => {
                warn!(
                    "Unknown activity type for activity {}. Skipping.",
                    activity.id
                );
                Ok(())
            }
        }
    }

    fn activity_requires_atomic_scratch(activity_type: &ActivityType) -> bool {
        matches!(
            activity_type,
            ActivityType::Buy
                | ActivityType::Sell
                | ActivityType::TransferIn
                | ActivityType::TransferOut
                | ActivityType::Split
                | ActivityType::Adjustment
        )
    }

    fn push_activity_warning(
        warnings: &mut Vec<HoldingsCalculationWarning>,
        activity: &Activity,
        account_id: &str,
        target_date: NaiveDate,
        error: impl std::fmt::Display,
    ) {
        let warning = HoldingsCalculationWarning {
            activity_id: activity.id.clone(),
            account_id: account_id.to_string(),
            date: target_date,
            message: format!("Failed to process activity: {}", error),
        };
        log::error!("{}", warning);
        warnings.push(warning);
    }
}
