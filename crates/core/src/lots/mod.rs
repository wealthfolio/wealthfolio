//! Persisted tax lots.
//!
//! A [`LotRecord`] is the durable, relational form of a tax lot: one row per
//! acquisition (or transferred sub-lot), updated in-place as shares are disposed.
//! This is distinct from the in-memory [`crate::portfolio::snapshot::Lot`], which
//! is a computation intermediate produced by the holdings calculator.
//!
//! Lot rows are initially written alongside the existing JSON snapshot path as a
//! parallel record. Quantity mismatches between the two representations are logged
//! at CRITICAL severity so they can be caught before the lots table becomes
//! the authoritative source.
//!
//! `open_activity_id` is intentionally left NULL in this parallel-write phase.
//! Transferred sub-lots use composite IDs (e.g. `<activity_id>_lot2`) that do not
//! correspond to any row in the `activities` table, so linking them would violate
//! the foreign-key constraint. The column will be populated once incremental lot
//! maintenance replaces the full-replay approach.

use async_trait::async_trait;
use chrono::{NaiveDate, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::str::FromStr;

use crate::activities::{
    Activity, ACTIVITY_TYPE_ADJUSTMENT, ACTIVITY_TYPE_SELL, ACTIVITY_TYPE_TRANSFER_OUT,
};
use crate::errors::Result;
use crate::portfolio::snapshot::AccountStateSnapshot;

// ── Repository trait ──────────────────────────────────────────────────────────

/// Records a lot that was fully disposed (remaining_quantity → 0).
///
/// Carries the full lot data so that `sync_lots_for_account` can INSERT the
/// closed lot even if it was never previously written to the database.  This
/// happens during a full recalc/replay: the lot is created and consumed
/// entirely within a single pass, so `extract_lot_records` (which only sees
/// lots still in the in-memory VecDeque) never produces a row for it.
#[derive(Debug, Clone)]
pub struct LotClosure {
    pub lot_id: String,
    /// ISO 8601 date the lot was fully consumed ("YYYY-MM-DD").
    pub close_date: String,
    /// The activity that fully disposed the lot, if known.
    pub close_activity_id: Option<String>,
    /// The activity that originally opened this lot. Carried through so the
    /// closure-insert can preserve the FK link instead of writing NULL.
    /// `None` only for lots that don't correspond to an activity row (e.g.
    /// HOLDINGS-mode synthetic lots, which do not flow through this path).
    pub open_activity_id: Option<String>,

    // ── Fields needed to INSERT the lot if it doesn't exist yet ──
    pub account_id: String,
    pub asset_id: String,
    /// ISO 8601 date the lot was opened ("YYYY-MM-DD").
    pub open_date: String,
    /// Quantity when the lot was first created.
    pub original_quantity: String,
    /// Cost per unit in the asset's quote currency.
    pub cost_per_unit: String,
    /// Cost basis at lot creation (cost_per_unit × original_quantity + fee).
    /// Immutable.
    pub original_cost_basis: String,
    /// Transaction fees allocated to this lot.
    pub fee_allocated: String,
}

/// Persistence interface for lot rows.
#[async_trait]
pub trait LotRepositoryTrait: Send + Sync {
    /// Replaces all open lot rows for the given account with the provided records.
    /// Existing rows for the account are deleted before inserting new ones.
    async fn replace_lots_for_account(&self, account_id: &str, lots: &[LotRecord]) -> Result<()>;

    /// Returns all open (is_closed = 0) lot rows for the given account.
    async fn get_open_lots_for_account(&self, account_id: &str) -> Result<Vec<LotRecord>>;

    /// Returns all open (is_closed = 0) lot rows across all accounts.
    /// Used when building live holdings for the TOTAL pseudo-account.
    async fn get_all_open_lots(&self) -> Result<Vec<LotRecord>>;

    /// Returns all lots that were active on `date` for the specified accounts.
    /// A lot is active if: `open_date <= date AND (is_closed=0 OR close_date > date)`.
    async fn get_lots_as_of_date(
        &self,
        account_ids: &[String],
        date: NaiveDate,
    ) -> Result<Vec<LotRecord>>;

    /// Returns every lot row (open and closed) for the given account.
    /// Callers that need positions at multiple historical dates can fetch once
    /// and filter in memory using the `open_date` / `close_date` fields.
    async fn get_all_lots_for_account(&self, account_id: &str) -> Result<Vec<LotRecord>>;

    /// Returns every lot row (open and closed) for the given asset across all accounts.
    async fn get_lots_for_asset(&self, asset_id: &str) -> Result<Vec<LotRecord>>;

    /// Returns every lot row (open and closed) across all accounts.
    /// Used when computing valuations for the TOTAL pseudo-account.
    async fn get_all_lots(&self) -> Result<Vec<LotRecord>>;

    /// Syncs the lots table for the given account without ever deleting rows:
    /// - Open lots in `open_lots` are upserted (inserted if new, remaining_quantity updated if changed).
    /// - Lots listed in `closures` are marked is_closed=1 with their close_date/activity.
    ///
    /// Replaces `replace_lots_for_account` once the transition to incremental lot maintenance
    /// is complete.
    async fn sync_lots_for_account(
        &self,
        account_id: &str,
        open_lots: &[LotRecord],
        closures: &[LotClosure],
    ) -> Result<()>;

    /// Returns total quantity per asset across all open lots (all accounts).
    /// Used for quote sync planning — determines which assets need price data.
    async fn get_open_position_quantities(&self) -> Result<HashMap<String, Decimal>>;

    /// Returns the total number of lot rows (open and closed) in the lots table.
    /// Used by the startup backfill to check if the table is empty.
    fn count_lots(&self) -> Result<i64>;
}

// ── Domain types ──────────────────────────────────────────────────────────────

/// A row in the `lots` table — a persisted tax lot.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LotRecord {
    pub id: String,
    pub account_id: String,
    pub asset_id: String,

    /// Date the lot was opened (ISO 8601, e.g. "2024-03-15").
    pub open_date: String,
    /// The activity that created this lot. NULL when the lot originates from a
    /// transferred sub-lot whose ID does not directly correspond to an activity row.
    pub open_activity_id: Option<String>,

    /// Total quantity acquired, in **as-acquired (pre-split)** units. Immutable after insert.
    pub original_quantity: String,
    /// Quantity still held, in **as-acquired (pre-split)** units. Reduced on each disposal.
    /// Effective shares held now = `remaining_quantity * split_ratio`.
    pub remaining_quantity: String,

    /// Cost per unit in the asset's quote currency, in **as-acquired** terms.
    /// Immutable after insert. Adjusted cost per current share = `cost_per_unit / split_ratio`.
    pub cost_per_unit: String,
    /// Cost basis at lot creation (cost_per_unit × original_quantity + fee_allocated).
    /// Immutable. Split-invariant — splits don't change the dollars paid.
    pub original_cost_basis: String,
    /// Open cost basis remaining for the lot. Reduced proportionally on
    /// partial sells: `remaining_cost_basis -= (consumed_qty / original_quantity) × original_cost_basis`.
    /// Reaches zero on full close.
    pub remaining_cost_basis: String,
    /// Transaction fees allocated to this lot. Immutable.
    pub fee_allocated: String,

    /// Cumulative product of post-acquisition SPLIT activity ratios for this lot's asset.
    /// Defaults to "1" (no splits since open_date). Multiplied by `remaining_quantity` to
    /// derive effective current shares; divided into `cost_per_unit` to derive adjusted
    /// per-share basis. See docs/architecture/data_model.md §3.5.
    pub split_ratio: String,

    /// True once remaining_quantity reaches zero.
    pub is_closed: bool,

    /// Date the lot was fully disposed (ISO 8601). None if still open.
    pub close_date: Option<String>,
    /// The activity that fully closed this lot. None if still open.
    pub close_activity_id: Option<String>,

    pub created_at: String,
    pub updated_at: String,
}

// Tax-conclusion concepts (disposal method, wash-sale, holding period) live in
// future tax-overlay tables. The neutral lots table intentionally stores only
// inventory facts.

// ── Extraction helpers ────────────────────────────────────────────────────────

/// Converts the in-memory lots from a holdings snapshot into [`LotRecord`]s
/// suitable for persisting to the `lots` table.
///
/// Each open lot in every position of the snapshot becomes one row.
/// `open_activity_id` is set from the in-memory `Lot.source_activity_id` so
/// the FK CASCADE removes the row when its activity is deleted. For
/// HOLDINGS-mode lots and synthetic lots that don't correspond to an
/// activity row, `source_activity_id` is `None` and the column stays NULL.
/// `original_quantity` comes from `lot.original_quantity` when available (new
/// snapshots). For old snapshots that predate the field (where it deserializes
/// as zero), falls back to `lot.quantity` (the remaining amount).
pub fn extract_lot_records(snapshot: &AccountStateSnapshot) -> Vec<LotRecord> {
    let now = Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let mut records = Vec::new();

    for position in snapshot.positions.values() {
        for lot in &position.lots {
            let orig_qty = if lot.original_quantity.is_zero() {
                lot.quantity
            } else {
                lot.original_quantity
            };
            // Original cost basis (immutable) is reconstructed from at-acquisition
            // values that the in-memory model preserves: acquisition_price stays
            // at the as-acquired price, acquisition_fees stays at the original
            // fee allocation. lot.cost_basis is mutated on partial sells (it's
            // effectively the remaining_cost_basis).
            let original_cost_basis = lot.acquisition_price * orig_qty + lot.acquisition_fees;
            records.push(LotRecord {
                id: lot.id.clone(),
                account_id: snapshot.account_id.clone(),
                asset_id: position.asset_id.clone(),
                open_date: lot.acquisition_date.format("%Y-%m-%d").to_string(),
                open_activity_id: lot.source_activity_id.clone(),
                original_quantity: orig_qty.to_string(),
                remaining_quantity: lot.quantity.to_string(),
                cost_per_unit: lot.acquisition_price.to_string(),
                original_cost_basis: original_cost_basis.to_string(),
                remaining_cost_basis: lot.cost_basis.to_string(),
                fee_allocated: lot.acquisition_fees.to_string(),
                split_ratio: lot.effective_split_ratio().to_string(),
                is_closed: false,
                close_date: None,
                close_activity_id: None,
                created_at: now.clone(),
                updated_at: now.clone(),
            });
        }
    }

    records
}

/// Checks that the lot quantities extracted from a snapshot are consistent with
/// the position quantities stored in that same snapshot.
///
/// Any discrepancy is logged at ERROR severity so it can be investigated before
/// the lots table is relied upon for live calculations.
///
/// Returns the number of mismatches found (0 = all consistent).
pub fn check_lot_quantity_consistency(
    snapshot: &AccountStateSnapshot,
    lot_records: &[LotRecord],
) -> usize {
    // Lot quantities are stored in as-acquired (pre-split) units; effective
    // current shares are remaining_quantity * split_ratio. Compare against the
    // position quantity in the same effective-share space.
    let mut lot_qty_by_asset: HashMap<&str, Decimal> = HashMap::new();
    for record in lot_records {
        let qty = Decimal::from_str(&record.remaining_quantity).unwrap_or(Decimal::ZERO);
        let ratio = Decimal::from_str(&record.split_ratio).unwrap_or(Decimal::ONE);
        *lot_qty_by_asset
            .entry(record.asset_id.as_str())
            .or_insert(Decimal::ZERO) += qty * ratio;
    }

    let mut mismatches = 0;
    for (asset_id, position) in &snapshot.positions {
        let lot_qty = lot_qty_by_asset
            .get(asset_id.as_str())
            .copied()
            .unwrap_or(Decimal::ZERO);
        if lot_qty != position.quantity {
            log::error!(
                "CRITICAL: lot quantity mismatch for account {} asset {}: \
                 lots sum to {}, position reports {}",
                snapshot.account_id,
                asset_id,
                lot_qty,
                position.quantity
            );
            mismatches += 1;
        }
    }
    mismatches
}

// ── Split-ratio backfill ─────────────────────────────────────────────────────

/// One-time data migration: convert legacy lot rows (where SPLIT activities had
/// been baked into `original_quantity`/`remaining_quantity`/`cost_per_unit` by
/// the old retroactive-adjustment path) to the new model where as-acquired
/// columns are immutable and `split_ratio` carries the cumulative effect of
/// post-acquisition splits.
///
/// For each open or closed lot whose `split_ratio = 1` and whose asset has at
/// least one SPLIT activity dated after `open_date`:
///
/// ```text
///   cumulative_ratio       = Π SPLIT.amount where activity_date > lot.open_date
///   new original_quantity  = original_quantity  / cumulative_ratio
///   new remaining_quantity = remaining_quantity / cumulative_ratio
///   new cost_per_unit      = cost_per_unit      × cumulative_ratio
///   new split_ratio        = cumulative_ratio
/// ```
///
/// `total_cost_basis` and `fee_allocated` are split-invariant and untouched.
/// The invariant `original_quantity × cost_per_unit + fee_allocated =
/// total_cost_basis` is verified post-rewrite within `1e-6` absolute tolerance;
/// any lot that fails is logged and skipped (the row stays in its existing
/// post-split form rather than being half-rewritten).
///
/// SPLIT activities are stored per-account but represent a single asset-level
/// corporate event. Cumulative ratio is therefore deduplicated by
/// `(asset_id, activity_date)` so an asset held across multiple accounts is
/// not adjusted by 2× the actual ratio.
///
/// Idempotent. Re-running after a successful backfill is a no-op because all
/// affected lots will then have `split_ratio ≠ 1`. Returns the number of lot
/// rows modified.
pub async fn backfill_split_ratios(
    lot_repo: &(dyn LotRepositoryTrait + Send + Sync),
    activity_repo: &(dyn crate::activities::ActivityRepositoryTrait + Send + Sync),
) -> Result<usize> {
    use crate::activities::ACTIVITY_TYPE_SPLIT;

    // Fast exit: nothing to migrate if the lots table is empty.
    if lot_repo.count_lots()? == 0 {
        return Ok(0);
    }

    // Build cumulative split index keyed by asset_id, deduplicated by date.
    let all_activities = activity_repo.get_activities()?;
    let mut splits_by_asset: HashMap<String, Vec<(NaiveDate, Decimal)>> = HashMap::new();
    for activity in &all_activities {
        if activity.activity_type != ACTIVITY_TYPE_SPLIT {
            continue;
        }
        let asset_id = match &activity.asset_id {
            Some(id) if !id.is_empty() => id.clone(),
            _ => continue,
        };
        // Prefer `amount`; fall back to `quantity` when amount is NULL —
        // some API paths historically wrote quantity but not amount.
        let ratio = match activity.amount {
            Some(r) if r.is_sign_positive() && !r.is_zero() => r,
            _ => {
                let q = activity.qty();
                if q.is_sign_positive() && !q.is_zero() {
                    q
                } else {
                    continue;
                }
            }
        };
        let date = activity.activity_date.date_naive();
        splits_by_asset
            .entry(asset_id)
            .or_default()
            .push((date, ratio));
    }
    for splits in splits_by_asset.values_mut() {
        splits.sort_by_key(|k| k.0);
        splits.dedup_by_key(|k| k.0);
    }

    if splits_by_asset.is_empty() {
        log::info!("backfill_split_ratios: no SPLIT activities found, skipping.");
        return Ok(0);
    }

    let all_lots = lot_repo.get_all_lots().await?;
    let epsilon = Decimal::from_str_exact("0.000001").unwrap_or(Decimal::ZERO);

    // Group lots by account_id so we can use replace_lots_for_account.
    let mut lots_by_account: HashMap<String, Vec<LotRecord>> = HashMap::new();
    let mut accounts_with_changes: HashMap<String, usize> = HashMap::new();

    for mut lot in all_lots {
        let stored_split_ratio = Decimal::from_str(&lot.split_ratio).unwrap_or(Decimal::ONE);
        // Skip lots that have already been migrated (split_ratio ≠ 1).
        if stored_split_ratio != Decimal::ONE {
            lots_by_account
                .entry(lot.account_id.clone())
                .or_default()
                .push(lot);
            continue;
        }

        let lot_open_date = match NaiveDate::parse_from_str(&lot.open_date, "%Y-%m-%d") {
            Ok(d) => d,
            Err(e) => {
                log::error!(
                    "backfill_split_ratios: lot {} has malformed open_date '{}': {}; leaving as-is",
                    lot.id,
                    lot.open_date,
                    e
                );
                lots_by_account
                    .entry(lot.account_id.clone())
                    .or_default()
                    .push(lot);
                continue;
            }
        };

        let cumulative_ratio = match splits_by_asset.get(&lot.asset_id) {
            Some(splits) => splits
                .iter()
                .filter(|(d, _)| *d > lot_open_date)
                .map(|(_, r)| *r)
                .fold(Decimal::ONE, |acc, r| acc * r),
            None => Decimal::ONE,
        };

        if cumulative_ratio == Decimal::ONE {
            // No relevant splits; lot stays as-is.
            lots_by_account
                .entry(lot.account_id.clone())
                .or_default()
                .push(lot);
            continue;
        }

        // Parse the existing (post-split-baked) values for the rewrite.
        let orig_qty = match Decimal::from_str(&lot.original_quantity) {
            Ok(v) => v,
            Err(e) => {
                log::error!(
                    "backfill_split_ratios: lot {} has malformed original_quantity '{}': {}; leaving as-is",
                    lot.id, lot.original_quantity, e
                );
                lots_by_account
                    .entry(lot.account_id.clone())
                    .or_default()
                    .push(lot);
                continue;
            }
        };
        let rem_qty = Decimal::from_str(&lot.remaining_quantity).unwrap_or(orig_qty);
        let cpu = match Decimal::from_str(&lot.cost_per_unit) {
            Ok(v) => v,
            Err(e) => {
                log::error!(
                    "backfill_split_ratios: lot {} has malformed cost_per_unit '{}': {}; leaving as-is",
                    lot.id, lot.cost_per_unit, e
                );
                lots_by_account
                    .entry(lot.account_id.clone())
                    .or_default()
                    .push(lot);
                continue;
            }
        };
        let new_orig_qty = orig_qty / cumulative_ratio;
        let new_rem_qty = rem_qty / cumulative_ratio;
        let new_cpu = cpu * cumulative_ratio;

        // total_cost_basis is preserved by construction: remaining × cpu is
        // invariant under (1/r, ×r) on its two factors. fee_allocated stays
        // untouched. We log an INFO-level warning when the stored
        // total_cost_basis differs noticeably from `remaining × cpu` so
        // pre-existing data corruption is visible, but we do NOT block the
        // migration — the discrepancy is independent of the split refactor.
        let fee = Decimal::from_str(&lot.fee_allocated).unwrap_or(Decimal::ZERO);
        let stored_tcb =
            Decimal::from_str(&lot.remaining_cost_basis).unwrap_or(rem_qty * cpu + fee);
        let expected_open_basis = if orig_qty.is_zero() {
            stored_tcb
        } else {
            new_rem_qty * new_cpu + (new_rem_qty / new_orig_qty) * fee
        };
        if (expected_open_basis - stored_tcb).abs() > epsilon * Decimal::TEN {
            log::warn!(
                "backfill_split_ratios: lot {} has open cost basis discrepancy \
                 (rem×cpu+prorated_fee={}, stored tcb={}, diff={}); migrating \
                 anyway (split refactor preserves the existing tcb value). \
                 This is pre-existing data corruption — typically an old FIFO \
                 bug that debited cost basis from this lot without removing \
                 shares.",
                lot.id,
                expected_open_basis,
                stored_tcb,
                (expected_open_basis - stored_tcb).abs()
            );
        }

        log::info!(
            "backfill_split_ratios: lot {} (asset {}) {}: orig {}→{}, rem {}→{}, cpu {}→{}, split_ratio 1→{}",
            lot.id, lot.asset_id, lot.open_date,
            orig_qty, new_orig_qty,
            rem_qty, new_rem_qty,
            cpu, new_cpu,
            cumulative_ratio
        );

        lot.original_quantity = new_orig_qty.to_string();
        lot.remaining_quantity = new_rem_qty.to_string();
        lot.cost_per_unit = new_cpu.to_string();
        lot.split_ratio = cumulative_ratio.to_string();
        // total_cost_basis is preserved as-is (open cost basis stays
        // numerically the same when rem×cpu is invariant). fee_allocated
        // unchanged (immutable).

        *accounts_with_changes
            .entry(lot.account_id.clone())
            .or_default() += 1;
        lots_by_account
            .entry(lot.account_id.clone())
            .or_default()
            .push(lot);
    }

    let mut total_modified = 0usize;
    for (account_id, lots) in lots_by_account {
        let modified = accounts_with_changes.get(&account_id).copied().unwrap_or(0);
        if modified == 0 {
            continue; // No changes for this account; skip the rewrite.
        }
        lot_repo
            .replace_lots_for_account(&account_id, &lots)
            .await?;
        total_modified += modified;
        log::info!(
            "backfill_split_ratios: rewrote {} lot(s) for account {}",
            modified,
            account_id
        );
    }

    if total_modified > 0 {
        log::info!(
            "backfill_split_ratios: complete, {} lot(s) migrated to as-acquired + split_ratio model",
            total_modified
        );
    }
    Ok(total_modified)
}

// ── Historical replay ────────────────────────────────────────────────────────

/// Adjusts lot rows to reflect their state at `as_of_date` by replaying
/// activities chronologically. Returns lots in the as-acquired-units +
/// `split_ratio` model:
///   `effective_remaining_at(as_of_date) = lot.remaining_quantity * lot.split_ratio`
///
/// Algorithm:
/// 1. Reset each lot to its as-acquired starting point: `remaining_quantity =
///    original_quantity` and `split_ratio = 1`.
/// 2. Walk SELL / TRANSFER_OUT / ADJUSTMENT / SPLIT activities for the asset
///    in chronological order, but only those with `activity_date <= as_of_date`.
///    - SPLIT (date X, lot.open_date < X): `lot.split_ratio *= ratio`. Lot
///      quantity, cost_per_unit, total_cost_basis, fee_allocated are untouched.
///    - SELL/TRANSFER_OUT/ADJUSTMENT (date X): consume `activity.qty()` in
///      effective units FIFO. For each lot, `effective_remaining =
///      remaining_quantity × split_ratio` (using the running ratio at this
///      point in the replay). Decrement `remaining_quantity` by
///      `consumed_effective / split_ratio`. Cost-basis proration uses
///      as-acquired units against the immutable `cost_per_unit`.
///
/// Lots with `original_quantity = 0` (legacy snapshots that predate the field)
/// are returned as-is since there is no anchor to replay from.
///
/// Lots whose `remaining_quantity` reaches zero after replay are filtered out
/// of the result.
pub fn replay_lots_to_date(
    lots: Vec<LotRecord>,
    activities: &[Activity],
    as_of_date: NaiveDate,
) -> Vec<LotRecord> {
    use crate::activities::ACTIVITY_TYPE_SPLIT;

    if lots.is_empty() {
        return lots;
    }

    // Filter to activity types that affect lot quantities, sorted by date.
    let relevant_types = [
        ACTIVITY_TYPE_SELL,
        ACTIVITY_TYPE_TRANSFER_OUT,
        ACTIVITY_TYPE_ADJUSTMENT,
        ACTIVITY_TYPE_SPLIT,
    ];
    let mut relevant: Vec<&Activity> = activities
        .iter()
        .filter(|a| relevant_types.contains(&a.effective_type()))
        .filter(|a| a.activity_date.date_naive() <= as_of_date)
        .collect();
    relevant.sort_by_key(|a| a.activity_date);

    // Drop lots that didn't exist yet at as_of_date. Callers that fetched lots
    // via storage's date-aware query already filter, but other callers (e.g.
    // valuation_service::calculate_valuation_history, which iterates all lots
    // for an account across many dates) rely on this.
    let in_scope: Vec<LotRecord> = lots
        .into_iter()
        .filter(|lot| {
            NaiveDate::parse_from_str(&lot.open_date, "%Y-%m-%d")
                .map(|d| d <= as_of_date)
                .unwrap_or(true)
        })
        .collect();

    // Group lots by (account_id, asset_id), FIFO order by open_date.
    let mut groups: HashMap<(String, String), Vec<LotRecord>> = HashMap::new();
    for lot in in_scope {
        groups
            .entry((lot.account_id.clone(), lot.asset_id.clone()))
            .or_default()
            .push(lot);
    }
    for group in groups.values_mut() {
        group.sort_by(|a, b| a.open_date.cmp(&b.open_date));
    }

    // Per (account, asset), does that account have any SPLIT activity to
    // replay? Lots received via TRANSFER_IN inherit a split_ratio from the
    // source account; the receiving account has no SPLIT activity to re-apply,
    // so resetting split_ratio to 1 here would silently drop the inherited
    // factor. Only reset for (account, asset) pairs where the account itself
    // has a SPLIT activity that the forward replay will multiply back in.
    let mut has_split: HashSet<(String, String)> = HashSet::new();
    for activity in &relevant {
        if activity.effective_type() == ACTIVITY_TYPE_SPLIT {
            if let Some(asset_id) = &activity.asset_id {
                has_split.insert((activity.account_id.clone(), asset_id.clone()));
            }
        }
    }

    // Reset each lot to its as-acquired starting point. Cost-basis columns are
    // split-invariant and stay as-stored; remaining is rewound to original.
    // split_ratio is rewound to 1 only when this account will replay a SPLIT
    // for the asset; otherwise the stored ratio (possibly inherited from a
    // transfer) is preserved.
    for ((account_id, asset_id), group) in groups.iter_mut() {
        let reset_split = has_split.contains(&(account_id.clone(), asset_id.clone()));
        for lot in group.iter_mut() {
            let orig = Decimal::from_str(&lot.original_quantity).unwrap_or(Decimal::ZERO);
            if !orig.is_zero() {
                lot.remaining_quantity = lot.original_quantity.clone();
                lot.remaining_cost_basis = lot.original_cost_basis.clone();
                if reset_split {
                    lot.split_ratio = Decimal::ONE.to_string();
                }
                lot.is_closed = false;
                lot.close_date = None;
                lot.close_activity_id = None;
            }
        }
    }

    // Replay activities in chronological order.
    for activity in &relevant {
        let asset_id: String = match &activity.asset_id {
            Some(id) => id.clone(),
            None => continue,
        };
        let key = (activity.account_id.clone(), asset_id);
        let group = match groups.get_mut(&key) {
            Some(g) => g,
            None => continue,
        };

        if activity.effective_type() == ACTIVITY_TYPE_SPLIT {
            // SPLIT: multiply split_ratio of every lot opened before the split.
            // Read the ratio from `amount`, with fallback to `quantity` if
            // amount is NULL — matches handle_split in the calculator.
            let ratio = {
                let amt = activity.amt();
                if amt.is_sign_positive() && !amt.is_zero() {
                    amt
                } else {
                    activity.qty()
                }
            };
            if ratio.is_sign_positive() && !ratio.is_zero() {
                let split_date = activity.activity_date.date_naive();
                for lot in group.iter_mut() {
                    let lot_open = NaiveDate::parse_from_str(&lot.open_date, "%Y-%m-%d")
                        .unwrap_or(NaiveDate::MIN);
                    if lot_open >= split_date {
                        continue;
                    }
                    let prior = Decimal::from_str(&lot.split_ratio).unwrap_or(Decimal::ONE);
                    let prior = if prior.is_zero() { Decimal::ONE } else { prior };
                    lot.split_ratio = (prior * ratio).to_string();
                }
            }
            continue;
        }

        // SELL / TRANSFER_OUT / ADJUSTMENT: consume in effective (current-at-date) units.
        let activity_date = activity.activity_date.date_naive();
        let mut effective_to_reduce = activity.qty().abs();
        for lot in group.iter_mut() {
            if effective_to_reduce <= Decimal::ZERO {
                break;
            }
            // Skip lots that didn't exist yet at this activity's date.
            // The group is FIFO-sorted by open_date, so once we've stopped
            // we won't encounter an earlier lot — but `continue` keeps the
            // intent obvious and matches the SPLIT path's pattern.
            let lot_open =
                NaiveDate::parse_from_str(&lot.open_date, "%Y-%m-%d").unwrap_or(NaiveDate::MIN);
            if lot_open > activity_date {
                continue;
            }
            let remaining = Decimal::from_str(&lot.remaining_quantity).unwrap_or(Decimal::ZERO);
            if remaining <= Decimal::ZERO {
                continue;
            }
            let lot_split_ratio = Decimal::from_str(&lot.split_ratio).unwrap_or(Decimal::ONE);
            let lot_split_ratio = if lot_split_ratio.is_zero() {
                Decimal::ONE
            } else {
                lot_split_ratio
            };
            let lot_effective = remaining * lot_split_ratio;
            if lot_effective <= Decimal::ZERO {
                continue;
            }

            let consume_effective = std::cmp::min(lot_effective, effective_to_reduce);
            let consume_original = consume_effective / lot_split_ratio;
            let new_remaining = remaining - consume_original;
            lot.remaining_quantity = new_remaining.to_string();

            // Reduce remaining_cost_basis by the same proportion of original.
            // Cost basis is split-invariant; partial sells deplete it linearly.
            let original_qty = Decimal::from_str(&lot.original_quantity).unwrap_or(Decimal::ZERO);
            if original_qty > Decimal::ZERO {
                let original_cost =
                    Decimal::from_str(&lot.original_cost_basis).unwrap_or(Decimal::ZERO);
                let new_remaining_cost = if new_remaining <= Decimal::ZERO {
                    Decimal::ZERO
                } else {
                    original_cost * (new_remaining / original_qty)
                };
                lot.remaining_cost_basis = new_remaining_cost.to_string();
            }

            if new_remaining <= Decimal::ZERO {
                lot.is_closed = true;
                lot.close_date = Some(
                    activity
                        .activity_date
                        .date_naive()
                        .format("%Y-%m-%d")
                        .to_string(),
                );
                lot.close_activity_id = Some(activity.id.clone());
            }

            effective_to_reduce -= consume_effective;
        }
    }

    // Return lots that still have positive remaining quantity.
    groups
        .into_values()
        .flatten()
        .filter(|lot| {
            let qty = Decimal::from_str(&lot.remaining_quantity).unwrap_or(Decimal::ZERO);
            qty > Decimal::ZERO
        })
        .collect()
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::portfolio::snapshot::{AccountStateSnapshot, Lot, Position};
    use chrono::{TimeZone, Utc};
    use rust_decimal_macros::dec;
    use std::collections::{HashMap, VecDeque};

    // ── Helpers ───────────────────────────────────────────────────────────────

    fn make_lot(
        id: &str,
        position_id: &str,
        date_ymd: (i32, u32, u32),
        qty: Decimal,
        price: Decimal,
        fee: Decimal,
    ) -> Lot {
        Lot {
            id: id.to_string(),
            position_id: position_id.to_string(),
            acquisition_date: Utc
                .with_ymd_and_hms(date_ymd.0, date_ymd.1, date_ymd.2, 0, 0, 0)
                .unwrap(),
            quantity: qty,
            original_quantity: qty,
            cost_basis: qty * price + fee,
            acquisition_price: price,
            acquisition_fees: fee,
            fx_rate_to_position: None,
            source_activity_id: None,
            split_ratio: Decimal::ONE,
        }
    }

    fn make_position(account_id: &str, asset_id: &str, currency: &str, lots: Vec<Lot>) -> Position {
        let mut pos = Position::new(
            account_id.to_string(),
            asset_id.to_string(),
            currency.to_string(),
            Utc::now(),
        );
        pos.lots = VecDeque::from(lots);
        pos.recalculate_aggregates();
        pos
    }

    fn make_snapshot(
        account_id: &str,
        positions: HashMap<String, Position>,
    ) -> AccountStateSnapshot {
        AccountStateSnapshot {
            id: format!("{}_test", account_id),
            account_id: account_id.to_string(),
            snapshot_date: chrono::NaiveDate::from_ymd_opt(2025, 12, 31).unwrap(),
            currency: "USD".to_string(),
            positions,
            calculated_at: Utc::now().naive_utc(),
            ..Default::default()
        }
    }

    // ── extract_lot_records ───────────────────────────────────────────────────

    /// AAPL with 3 lots from different purchase dates — verifies multi-lot
    /// aggregation and field mapping.
    #[test]
    fn extract_lot_records_aapl_three_lots() {
        let lots = vec![
            make_lot(
                "buy-aapl-1",
                "POS-AAPL-acc1",
                (2024, 1, 15),
                dec!(50),
                dec!(185.00),
                dec!(0),
            ),
            make_lot(
                "buy-aapl-2",
                "POS-AAPL-acc1",
                (2024, 6, 1),
                dec!(30),
                dec!(192.50),
                dec!(0),
            ),
            make_lot(
                "buy-aapl-3",
                "POS-AAPL-acc1",
                (2024, 10, 15),
                dec!(20),
                dec!(225.00),
                dec!(0),
            ),
        ];
        let pos = make_position("acc1", "AAPL", "USD", lots);
        assert_eq!(pos.quantity, dec!(100));

        let mut positions = HashMap::new();
        positions.insert("AAPL".to_string(), pos);
        let snap = make_snapshot("acc1", positions);

        let records = extract_lot_records(&snap);

        assert_eq!(records.len(), 3);
        let total_qty: Decimal = records
            .iter()
            .map(|r| r.remaining_quantity.parse::<Decimal>().unwrap())
            .sum();
        assert_eq!(total_qty, dec!(100));

        for r in &records {
            assert_eq!(r.account_id, "acc1");
            assert_eq!(r.asset_id, "AAPL");
            assert!(r.open_activity_id.is_none());
            assert!(!r.is_closed);
        }

        // Spot-check first lot
        let r1 = records.iter().find(|r| r.id == "buy-aapl-1").unwrap();
        assert_eq!(r1.remaining_quantity.parse::<Decimal>().unwrap(), dec!(50));
        assert_eq!(r1.cost_per_unit.parse::<Decimal>().unwrap(), dec!(185.00));
        assert_eq!(r1.open_date, "2024-01-15");
    }

    /// LQD bond ETF with 2 lots — verifies correct handling of bond-like symbols.
    #[test]
    fn extract_lot_records_lqd_two_lots() {
        let lots = vec![
            make_lot(
                "buy-lqd-1",
                "POS-LQD-acc1",
                (2024, 2, 1),
                dec!(100),
                dec!(107.25),
                dec!(0),
            ),
            make_lot(
                "buy-lqd-2",
                "POS-LQD-acc1",
                (2024, 8, 15),
                dec!(50),
                dec!(112.10),
                dec!(0),
            ),
        ];
        let pos = make_position("acc1", "LQD", "USD", lots);
        assert_eq!(pos.quantity, dec!(150));

        let mut positions = HashMap::new();
        positions.insert("LQD".to_string(), pos);
        let snap = make_snapshot("acc1", positions);

        let records = extract_lot_records(&snap);
        assert_eq!(records.len(), 2);

        let total_qty: Decimal = records
            .iter()
            .map(|r| r.remaining_quantity.parse::<Decimal>().unwrap())
            .sum();
        assert_eq!(total_qty, dec!(150));
    }

    /// AAPL Jun 2026 $200 call option — verifies options symbols are handled
    /// the same as any other asset_id.
    #[test]
    fn extract_lot_records_aapl_option_single_lot() {
        let symbol = "AAPL260619C00200000";
        let lots = vec![make_lot(
            "buy-opt-1",
            &format!("POS-{}-acc1", symbol),
            (2025, 11, 1),
            dec!(5),
            dec!(8.50),
            dec!(0),
        )];
        let pos = make_position("acc1", symbol, "USD", lots);

        let mut positions = HashMap::new();
        positions.insert(symbol.to_string(), pos);
        let snap = make_snapshot("acc1", positions);

        let records = extract_lot_records(&snap);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].asset_id, symbol);
        assert_eq!(
            records[0].remaining_quantity.parse::<Decimal>().unwrap(),
            dec!(5)
        );
    }

    /// Multi-asset portfolio: AAPL (3 lots) + LQD (2 lots) + option (1 lot).
    #[test]
    fn extract_lot_records_mixed_portfolio() {
        let mut positions = HashMap::new();

        positions.insert(
            "AAPL".to_string(),
            make_position(
                "acc1",
                "AAPL",
                "USD",
                vec![
                    make_lot(
                        "buy-aapl-1",
                        "POS-AAPL-acc1",
                        (2024, 1, 15),
                        dec!(50),
                        dec!(185.00),
                        dec!(0),
                    ),
                    make_lot(
                        "buy-aapl-2",
                        "POS-AAPL-acc1",
                        (2024, 6, 1),
                        dec!(30),
                        dec!(192.50),
                        dec!(0),
                    ),
                    make_lot(
                        "buy-aapl-3",
                        "POS-AAPL-acc1",
                        (2024, 10, 15),
                        dec!(20),
                        dec!(225.00),
                        dec!(0),
                    ),
                ],
            ),
        );
        positions.insert(
            "LQD".to_string(),
            make_position(
                "acc1",
                "LQD",
                "USD",
                vec![
                    make_lot(
                        "buy-lqd-1",
                        "POS-LQD-acc1",
                        (2024, 2, 1),
                        dec!(100),
                        dec!(107.25),
                        dec!(0),
                    ),
                    make_lot(
                        "buy-lqd-2",
                        "POS-LQD-acc1",
                        (2024, 8, 15),
                        dec!(50),
                        dec!(112.10),
                        dec!(0),
                    ),
                ],
            ),
        );
        positions.insert(
            "AAPL260619C00200000".to_string(),
            make_position(
                "acc1",
                "AAPL260619C00200000",
                "USD",
                vec![make_lot(
                    "buy-opt-1",
                    "POS-AAPL260619C00200000-acc1",
                    (2025, 11, 1),
                    dec!(5),
                    dec!(8.50),
                    dec!(0),
                )],
            ),
        );

        let snap = make_snapshot("acc1", positions);
        let records = extract_lot_records(&snap);

        assert_eq!(records.len(), 6);

        let aapl_qty: Decimal = records
            .iter()
            .filter(|r| r.asset_id == "AAPL")
            .map(|r| r.remaining_quantity.parse::<Decimal>().unwrap())
            .sum();
        assert_eq!(aapl_qty, dec!(100));

        let lqd_qty: Decimal = records
            .iter()
            .filter(|r| r.asset_id == "LQD")
            .map(|r| r.remaining_quantity.parse::<Decimal>().unwrap())
            .sum();
        assert_eq!(lqd_qty, dec!(150));

        let opt_qty: Decimal = records
            .iter()
            .filter(|r| r.asset_id == "AAPL260619C00200000")
            .map(|r| r.remaining_quantity.parse::<Decimal>().unwrap())
            .sum();
        assert_eq!(opt_qty, dec!(5));
    }

    // ── check_lot_quantity_consistency ────────────────────────────────────────

    #[test]
    fn consistency_check_passes_when_quantities_match() {
        let mut positions = HashMap::new();
        positions.insert(
            "AAPL".to_string(),
            make_position(
                "acc1",
                "AAPL",
                "USD",
                vec![
                    make_lot(
                        "l1",
                        "POS-AAPL-acc1",
                        (2024, 1, 15),
                        dec!(50),
                        dec!(185),
                        dec!(0),
                    ),
                    make_lot(
                        "l2",
                        "POS-AAPL-acc1",
                        (2024, 6, 1),
                        dec!(50),
                        dec!(192),
                        dec!(0),
                    ),
                ],
            ),
        );
        let snap = make_snapshot("acc1", positions);
        let records = extract_lot_records(&snap);

        let mismatches = check_lot_quantity_consistency(&snap, &records);
        assert_eq!(mismatches, 0);
    }

    #[test]
    fn consistency_check_detects_quantity_mismatch() {
        // Build a snapshot where position.quantity says 100 but the lot records only sum to 50.
        let mut positions = HashMap::new();
        let mut pos = make_position(
            "acc1",
            "AAPL",
            "USD",
            vec![
                make_lot(
                    "l1",
                    "POS-AAPL-acc1",
                    (2024, 1, 15),
                    dec!(50),
                    dec!(185),
                    dec!(0),
                ),
                make_lot(
                    "l2",
                    "POS-AAPL-acc1",
                    (2024, 6, 1),
                    dec!(50),
                    dec!(192),
                    dec!(0),
                ),
            ],
        );
        // Manually inflate the position quantity to create a mismatch.
        pos.quantity = dec!(100);
        positions.insert("AAPL".to_string(), pos);
        let snap = make_snapshot("acc1", positions);

        // Build lot records that only total 50.
        let partial_records = vec![LotRecord {
            id: "l1".to_string(),
            account_id: "acc1".to_string(),
            asset_id: "AAPL".to_string(),
            open_date: "2024-01-15".to_string(),
            open_activity_id: None,
            original_quantity: "50".to_string(),
            remaining_quantity: "50".to_string(),
            cost_per_unit: "185".to_string(),
            original_cost_basis: "9250".to_string(),
            remaining_cost_basis: "9250".to_string(),
            fee_allocated: "0".to_string(),
            split_ratio: "1".to_string(),
            is_closed: false,
            close_date: None,
            close_activity_id: None,
            created_at: "2024-01-15T00:00:00.000Z".to_string(),
            updated_at: "2024-01-15T00:00:00.000Z".to_string(),
        }];

        let mismatches = check_lot_quantity_consistency(&snap, &partial_records);
        assert_eq!(mismatches, 1);
    }

    // ── replay_lots_to_date tests ──────────────────────────────────────────

    fn make_lot_record(
        id: &str,
        account_id: &str,
        asset_id: &str,
        open_date: &str,
        original_qty: &str,
        remaining_qty: &str,
        cost_per_unit: &str,
    ) -> LotRecord {
        let orig = Decimal::from_str(original_qty).unwrap();
        let cpu = Decimal::from_str(cost_per_unit).unwrap();
        LotRecord {
            id: id.to_string(),
            account_id: account_id.to_string(),
            asset_id: asset_id.to_string(),
            open_date: open_date.to_string(),
            open_activity_id: Some(id.to_string()),
            original_quantity: original_qty.to_string(),
            remaining_quantity: remaining_qty.to_string(),
            cost_per_unit: cost_per_unit.to_string(),
            original_cost_basis: (orig * cpu).to_string(),
            remaining_cost_basis: (Decimal::from_str(remaining_qty).unwrap_or(Decimal::ZERO) * cpu)
                .to_string(),
            fee_allocated: "0".to_string(),
            split_ratio: "1".to_string(),
            is_closed: remaining_qty == "0",
            close_date: None,
            close_activity_id: None,
            created_at: "2024-01-01T00:00:00.000Z".to_string(),
            updated_at: "2024-01-01T00:00:00.000Z".to_string(),
        }
    }

    fn make_activity(
        id: &str,
        account_id: &str,
        asset_id: &str,
        activity_type: &str,
        date: &str,
        quantity: Decimal,
    ) -> Activity {
        use crate::activities::ActivityStatus;
        Activity {
            id: id.to_string(),
            account_id: account_id.to_string(),
            asset_id: Some(asset_id.to_string()),
            activity_type: activity_type.to_string(),
            activity_type_override: None,
            source_type: None,
            subtype: None,
            status: ActivityStatus::Posted,
            activity_date: NaiveDate::parse_from_str(date, "%Y-%m-%d")
                .unwrap()
                .and_hms_opt(0, 0, 0)
                .unwrap()
                .and_utc(),
            settlement_date: None,
            quantity: Some(quantity),
            unit_price: Some(dec!(100)),
            // Mirror production: SPLIT activities carry the ratio in both
            // `quantity` and `amount` (the JB/MS bridges set both, and the
            // live `handle_split` reads from `amount`). Other activity types
            // set amount=None as before.
            amount: if activity_type == "SPLIT" {
                Some(quantity)
            } else {
                None
            },
            fee: Some(Decimal::ZERO),
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
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    #[test]
    fn replay_no_activities_returns_lots_with_original_qty() {
        // Buy 10 on Jan 1, current remaining is 6 (some sells happened).
        // Replay to Jan 15 with no activities → should get 10 (original).
        let lots = vec![make_lot_record(
            "buy1",
            "acc1",
            "AAPL",
            "2024-01-01",
            "10",
            "6",
            "150",
        )];
        let result = replay_lots_to_date(lots, &[], NaiveDate::from_ymd_opt(2024, 1, 15).unwrap());
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].remaining_quantity, "10");
    }

    #[test]
    fn replay_partial_sell() {
        // Buy 10 on Jan 1, sell 4 on Feb 1. Query Jan 15 → 10, query Feb 15 → 6.
        let lots = vec![make_lot_record(
            "buy1",
            "acc1",
            "AAPL",
            "2024-01-01",
            "10",
            "6",
            "150",
        )];
        let activities = vec![make_activity(
            "sell1",
            "acc1",
            "AAPL",
            "SELL",
            "2024-02-01",
            dec!(4),
        )];

        // Before the sell
        let result = replay_lots_to_date(
            lots.clone(),
            &activities,
            NaiveDate::from_ymd_opt(2024, 1, 15).unwrap(),
        );
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].remaining_quantity, "10");

        // After the sell
        let result = replay_lots_to_date(
            lots,
            &activities,
            NaiveDate::from_ymd_opt(2024, 2, 15).unwrap(),
        );
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].remaining_quantity, "6");
    }

    #[test]
    fn replay_full_sell_removes_lot() {
        // Buy 10, sell 10 → lot should not appear.
        let lots = vec![make_lot_record(
            "buy1",
            "acc1",
            "AAPL",
            "2024-01-01",
            "10",
            "0",
            "150",
        )];
        let activities = vec![make_activity(
            "sell1",
            "acc1",
            "AAPL",
            "SELL",
            "2024-02-01",
            dec!(10),
        )];

        let result = replay_lots_to_date(
            lots,
            &activities,
            NaiveDate::from_ymd_opt(2024, 3, 1).unwrap(),
        );
        assert_eq!(result.len(), 0);
    }

    #[test]
    fn replay_fifo_order_across_lots() {
        // Two lots: buy 10 on Jan 1, buy 5 on Feb 1. Sell 12 on Mar 1.
        // Jan 15: 10 + 5 = 15. Feb 15: 10 + 5 = 15. Mar 15: FIFO removes 10 + 2 = 3 left.
        let lots = vec![
            make_lot_record("buy1", "acc1", "AAPL", "2024-01-01", "10", "0", "150"),
            make_lot_record("buy2", "acc1", "AAPL", "2024-02-01", "5", "3", "160"),
        ];
        let activities = vec![make_activity(
            "sell1",
            "acc1",
            "AAPL",
            "SELL",
            "2024-03-01",
            dec!(12),
        )];

        let result = replay_lots_to_date(
            lots,
            &activities,
            NaiveDate::from_ymd_opt(2024, 3, 15).unwrap(),
        );
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "buy2");
        assert_eq!(result[0].remaining_quantity, "3");
    }

    #[test]
    fn replay_split_updates_split_ratio_not_quantity() {
        // Buy 10 on Jan 1, 4:1 split on Feb 1.
        //   Jan 15: split hasn't happened → split_ratio=1, remaining=10, effective=10.
        //   Feb 15: split has happened → split_ratio=4, remaining=10, effective=40.
        // remaining_quantity (in as-acquired units) is unchanged by the split.
        let lots = vec![make_lot_record(
            "buy1",
            "acc1",
            "AAPL",
            "2024-01-01",
            "10",
            "40",
            "150",
        )];
        let activities = vec![make_activity(
            "split1",
            "acc1",
            "AAPL",
            "SPLIT",
            "2024-02-01",
            dec!(4),
        )];

        // Before split
        let result = replay_lots_to_date(
            lots.clone(),
            &activities,
            NaiveDate::from_ymd_opt(2024, 1, 15).unwrap(),
        );
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].remaining_quantity, "10");
        assert_eq!(result[0].split_ratio, "1");

        // After split: as-acquired units unchanged; split_ratio reflects the 4:1.
        let result = replay_lots_to_date(
            lots,
            &activities,
            NaiveDate::from_ymd_opt(2024, 2, 15).unwrap(),
        );
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].remaining_quantity, "10");
        assert_eq!(result[0].split_ratio, "4");
    }

    #[test]
    fn replay_split_then_sell_consumes_in_effective_units() {
        // Buy 10 on Jan 1, 2:1 split on Feb 1, sell 5 on Mar 1.
        //   Feb 15: split_ratio=2, remaining=10, effective=20.
        //   Mar 15: SELL of 5 (effective) → consumed_original = 5/2 = 2.5,
        //           remaining=7.5, split_ratio=2, effective=15.
        let lots = vec![make_lot_record(
            "buy1",
            "acc1",
            "AAPL",
            "2024-01-01",
            "10",
            "15",
            "150",
        )];
        let activities = vec![
            make_activity("split1", "acc1", "AAPL", "SPLIT", "2024-02-01", dec!(2)),
            make_activity("sell1", "acc1", "AAPL", "SELL", "2024-03-01", dec!(5)),
        ];

        let result = replay_lots_to_date(
            lots,
            &activities,
            NaiveDate::from_ymd_opt(2024, 3, 15).unwrap(),
        );
        assert_eq!(result.len(), 1);
        assert_eq!(
            Decimal::from_str(&result[0].remaining_quantity).unwrap(),
            dec!(7.5)
        );
        assert_eq!(result[0].split_ratio, "2");
        // Effective check: 7.5 × 2 = 15 shares held post-sell.
    }

    #[test]
    fn replay_buy_sell_buy_does_not_consume_future_lot() {
        // Buy 10 on Jan 1, sell 10 on Jan 31 (closes BUY1), buy 5 on Mar 1.
        // Query as-of Feb 15: BUY1 is closed, BUY2 doesn't exist yet → empty.
        // Query as-of Mar 15: BUY1 still closed, BUY2 exists with 5.
        // The bug case: if SELL processing didn't filter by lot.open_date, an
        // intermediate state could see SELL consume BUY2 (which didn't exist
        // yet) when both lots are passed to replay together.
        let lots = vec![
            make_lot_record("buy1", "acc1", "AAPL", "2024-01-01", "10", "0", "150"),
            make_lot_record("buy2", "acc1", "AAPL", "2024-03-01", "5", "5", "160"),
        ];
        let activities = vec![make_activity(
            "sell1",
            "acc1",
            "AAPL",
            "SELL",
            "2024-01-31",
            dec!(10),
        )];

        // Between sell and second buy: nothing held.
        let result = replay_lots_to_date(
            lots.clone(),
            &activities,
            NaiveDate::from_ymd_opt(2024, 2, 15).unwrap(),
        );
        assert_eq!(result.len(), 0, "Feb 15: BUY1 closed, BUY2 not yet open");

        // After second buy: only BUY2.
        let result = replay_lots_to_date(
            lots,
            &activities,
            NaiveDate::from_ymd_opt(2024, 3, 15).unwrap(),
        );
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "buy2");
        assert_eq!(result[0].remaining_quantity, "5");
    }

    #[test]
    fn replay_sell_does_not_pull_from_future_lot_when_earlier_depleted() {
        // Buy 4 on Jan 1, sell 5 on Feb 1 (over-sells! could be a corporate
        // action or import error), buy 10 on Mar 1.
        // Query Feb 15: BUY1 had 4, sell of 5 fully depletes BUY1 (1 unmatched).
        // Without the open_date filter, the SELL would pull the 1 extra from
        // BUY2 (Mar 1) — which doesn't exist on Feb 1.
        // With the filter: BUY1 → 0 remaining (the 1 extra is silently
        // dropped by the FIFO loop hitting end-of-group). BUY2 untouched.
        let lots = vec![
            make_lot_record("buy1", "acc1", "AAPL", "2024-01-01", "4", "0", "150"),
            make_lot_record("buy2", "acc1", "AAPL", "2024-03-01", "10", "9", "160"),
        ];
        let activities = vec![make_activity(
            "sell1",
            "acc1",
            "AAPL",
            "SELL",
            "2024-02-01",
            dec!(5),
        )];

        let result = replay_lots_to_date(
            lots,
            &activities,
            NaiveDate::from_ymd_opt(2024, 2, 15).unwrap(),
        );
        // BUY1 fully consumed → filtered out. BUY2 not yet open → filtered out.
        assert_eq!(result.len(), 0);
    }

    #[test]
    fn replay_different_accounts_isolated() {
        // Same asset in two accounts. Sell in acc1 doesn't affect acc2.
        let lots = vec![
            make_lot_record("buy1", "acc1", "AAPL", "2024-01-01", "10", "5", "150"),
            make_lot_record("buy2", "acc2", "AAPL", "2024-01-01", "10", "10", "150"),
        ];
        let activities = vec![make_activity(
            "sell1",
            "acc1",
            "AAPL",
            "SELL",
            "2024-02-01",
            dec!(5),
        )];

        let result = replay_lots_to_date(
            lots,
            &activities,
            NaiveDate::from_ymd_opt(2024, 3, 1).unwrap(),
        );
        assert_eq!(result.len(), 2);
        let acc1_lot = result.iter().find(|l| l.account_id == "acc1").unwrap();
        let acc2_lot = result.iter().find(|l| l.account_id == "acc2").unwrap();
        assert_eq!(acc1_lot.remaining_quantity, "5");
        assert_eq!(acc2_lot.remaining_quantity, "10");
    }
}
