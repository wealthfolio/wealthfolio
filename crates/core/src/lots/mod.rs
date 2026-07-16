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
//! Lots that map directly to an activity keep that activity's id in
//! `open_activity_id`. Synthetic sub-lots that do not correspond to an activity
//! row leave it NULL to preserve the foreign-key constraint.

use async_trait::async_trait;
use chrono::{NaiveDate, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::str::FromStr;

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
    /// `None` only for lots that don't correspond to an activity row.
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
    /// Original cost basis converted to base currency at acquisition date.
    pub original_cost_basis_base: String,
    /// Remaining cost basis converted with the acquisition-date FX rate.
    pub remaining_cost_basis_base: String,
    /// Transaction fees allocated to this lot.
    pub fee_allocated: String,
    /// Transaction fees converted to base currency at acquisition date.
    pub fee_allocated_base: String,
    /// Trade-level taxes allocated to this lot.
    pub tax_allocated: String,
    /// Trade-level taxes converted to base currency at acquisition date.
    pub tax_allocated_base: String,
    /// Lot currency, normally the asset quote currency.
    pub currency: String,
    /// User base currency used by the base fields.
    pub base_currency: String,
    /// FX rate from lot currency to base currency at acquisition.
    pub fx_rate_to_base: String,
    /// Cost-basis method used when this generated lot row was rebuilt.
    pub cost_basis_method: String,
    /// Cumulative product of post-acquisition SPLIT ratios at the time of
    /// closure. A lot opened before a 2:1 split and fully consumed after the
    /// split should persist with split_ratio = "2", not "1" — otherwise
    /// downstream tax-lot consumers see a misleading split history.
    pub split_ratio: String,
}

/// A deterministic disposal slice produced when a sell consumes a FIFO lot.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LotDisposal {
    pub id: String,
    pub lot_id: String,
    pub account_id: String,
    pub asset_id: String,
    pub disposal_activity_id: String,
    pub disposal_date: String,
    pub quantity: String,
    pub proceeds: String,
    pub cost_basis: String,
    pub realized_pnl: String,
    pub proceeds_base: String,
    pub cost_basis_base: String,
    pub realized_pnl_base: String,
    pub currency: String,
    pub base_currency: String,
    pub fx_rate_to_base: String,
    pub cost_basis_method: String,
    pub created_at: String,
}

/// Persistence interface for lot rows.
#[async_trait]
pub trait LotRepositoryTrait: Send + Sync {
    /// Replaces every lot row for the given account with the provided records.
    /// Existing open and closed rows for the account are deleted before insert.
    async fn replace_lots_for_account(&self, account_id: &str, lots: &[LotRecord]) -> Result<()>;

    /// Returns all open (is_closed = 0) lot rows for the given account.
    async fn get_open_lots_for_account(&self, account_id: &str) -> Result<Vec<LotRecord>>;

    /// Returns all open (is_closed = 0) lot rows for the given account and asset.
    async fn get_open_lots_for_account_asset(
        &self,
        account_id: &str,
        asset_id: &str,
    ) -> Result<Vec<LotRecord>> {
        Ok(self
            .get_open_lots_for_account(account_id)
            .await?
            .into_iter()
            .filter(|lot| lot.asset_id == asset_id)
            .collect())
    }

    /// Returns all open (is_closed = 0) lot rows across all accounts.
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

    /// Returns the read-model rows used by the asset Lots view.
    ///
    /// Transaction-derived lots come from the `lots` table. When requested,
    /// latest HOLDINGS-mode snapshot positions are appended as aggregate
    /// rows; they are not persisted as tax lots.
    async fn get_asset_lot_view(
        &self,
        asset_id: &str,
        include_snapshot_positions: bool,
    ) -> Result<Vec<AssetLotView>>;

    /// Returns every lot row (open and closed) across all accounts.
    async fn get_all_lots(&self) -> Result<Vec<LotRecord>>;

    /// Syncs the lots table for the given account while preserving closed history:
    /// - Open lots in `open_lots` are upserted (inserted if new, remaining_quantity updated if changed).
    /// - Existing open lots missing from `open_lots` are removed.
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

    /// Synchronizes deterministic disposal slices for an account.
    ///
    /// Full replays pass `replace_all=true` to rebuild the account read model
    /// from scratch. Incremental replays pass the activity ids in the replay
    /// window so stale rows for edited sells are removed without dropping older
    /// realized P&L history.
    async fn sync_lot_disposals_for_account(
        &self,
        _account_id: &str,
        _affected_activity_ids: &[String],
        _disposals: &[LotDisposal],
        _replace_all: bool,
    ) -> Result<()> {
        Ok(())
    }

    /// Returns deterministic disposal slices for an account.
    async fn get_lot_disposals_for_account(&self, _account_id: &str) -> Result<Vec<LotDisposal>> {
        Ok(Vec::new())
    }

    /// Returns deterministic disposal slices for accounts inside the performance period.
    ///
    /// Performance periods use the same convention as valuation flows:
    /// `(start_date, end_date]`.
    async fn get_lot_disposals_for_accounts_in_date_range(
        &self,
        account_ids: &[String],
        start_date_exclusive: NaiveDate,
        end_date_inclusive: NaiveDate,
    ) -> Result<Vec<LotDisposal>> {
        let mut disposals = Vec::new();
        for account_id in account_ids {
            for disposal in self.get_lot_disposals_for_account(account_id).await? {
                let Ok(disposal_date) =
                    NaiveDate::parse_from_str(&disposal.disposal_date, "%Y-%m-%d")
                else {
                    continue;
                };
                if disposal_date > start_date_exclusive && disposal_date <= end_date_inclusive {
                    disposals.push(disposal);
                }
            }
        }
        Ok(disposals)
    }

    /// Synchronous variant for read paths that cannot become async without
    /// changing the public valuation API.
    fn get_lot_disposals_for_accounts_in_date_range_sync(
        &self,
        account_ids: &[String],
        start_date_exclusive: NaiveDate,
        end_date_inclusive: NaiveDate,
    ) -> Result<Vec<LotDisposal>>;

    /// Returns total quantity per asset across all open lots (all accounts).
    /// Used for quote sync planning — determines which assets need price data.
    async fn get_open_position_quantities(&self) -> Result<HashMap<String, Decimal>>;

    /// Returns the total number of lot rows (open and closed) in the lots table.
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
    /// Original cost basis converted to base currency at acquisition date.
    pub original_cost_basis_base: String,
    /// Open cost basis remaining converted with the acquisition-date FX rate.
    pub remaining_cost_basis_base: String,
    /// Transaction fees allocated to this lot. Immutable.
    pub fee_allocated: String,
    /// Transaction fees converted to base currency at acquisition date.
    pub fee_allocated_base: String,
    /// Trade-level taxes allocated to this lot. Immutable.
    pub tax_allocated: String,
    /// Trade-level taxes converted to base currency at acquisition date.
    pub tax_allocated_base: String,
    /// Lot currency, normally the asset quote currency.
    pub currency: String,
    /// User base currency used by the base fields.
    pub base_currency: String,
    /// FX rate from lot currency to base currency at acquisition.
    pub fx_rate_to_base: String,
    /// Cost-basis method used when this generated lot row was rebuilt.
    pub cost_basis_method: String,

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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AssetLotSource {
    TransactionLot,
    SnapshotPosition,
}

/// UI-facing lot read model for an asset.
///
/// Snapshot rows are aggregate positions from the latest HOLDINGS-mode account
/// snapshots. They intentionally share the view with real transaction lots
/// without becoming rows in the `lots` table.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetLotView {
    pub id: String,
    pub account_id: String,
    pub account_name: String,
    pub asset_id: String,
    pub source: AssetLotSource,
    /// Currency for native lot money fields such as cost_basis and unit_cost.
    pub currency: String,
    /// User base currency for *_base fields when available.
    pub base_currency: Option<String>,
    /// Currency used by valuation_* fields after minor-unit normalization.
    pub valuation_currency: String,
    /// Effective current quantity. For transaction lots this is
    /// `remaining_quantity * split_ratio`; snapshot positions are already
    /// aggregate current quantities.
    pub quantity: Decimal,
    /// As-acquired quantity for transaction lots. Snapshot positions report the
    /// aggregate snapshot quantity here for shape consistency.
    pub original_quantity: Decimal,
    /// Remaining quantity in as-acquired units for transaction lots. Snapshot
    /// positions report the aggregate snapshot quantity here.
    pub remaining_quantity: Decimal,
    pub cost_basis: Decimal,
    pub cost_basis_base: Option<Decimal>,
    pub unit_cost: Decimal,
    pub fees: Decimal,
    pub taxes: Decimal,
    pub taxes_base: Option<Decimal>,
    pub valuation_unit_cost: Decimal,
    pub valuation_cost_basis: Decimal,
    pub fx_rate_to_base: Option<Decimal>,
    pub split_ratio: Decimal,
    pub contract_multiplier: Decimal,
    pub acquisition_date: Option<String>,
    pub snapshot_date: Option<String>,
    pub is_closed: bool,
    pub close_date: Option<String>,
    pub disposal_proceeds: Option<Decimal>,
    pub disposal_cost_basis: Option<Decimal>,
    pub disposal_cost_basis_base: Option<Decimal>,
    pub realized_pnl: Option<Decimal>,
    pub realized_pnl_base: Option<Decimal>,
    pub valuation_disposal_cost_basis: Option<Decimal>,
    pub valuation_realized_pnl: Option<Decimal>,
}

// The cost_basis_method field is generation provenance for inventory rows.
// Tax-conclusion concepts (wash sale, holding period, tax character) belong in
// future tax-overlay tables.

// ── Extraction helpers ────────────────────────────────────────────────────────

/// Converts the in-memory lots from a holdings snapshot into [`LotRecord`]s
/// suitable for persisting to the `lots` table.
///
/// Each open lot in every position of the snapshot becomes one row.
/// `open_activity_id` is set from the in-memory `Lot.source_activity_id` so
/// the FK CASCADE removes the row when its activity is deleted. For
/// compiler-generated synthetic activity legs that don't correspond to an
/// activity row, `source_activity_id` is `None` and the column stays NULL.
/// `original_quantity` comes from `lot.original_quantity` when available (new
/// snapshots). For old snapshots that predate the field (where it deserializes
/// as zero), falls back to `lot.quantity` (the remaining amount).
pub fn extract_lot_records(snapshot: &AccountStateSnapshot) -> Vec<LotRecord> {
    extract_lot_records_with_cost_basis_method(snapshot, "FIFO")
}

/// Converts in-memory lots to [`LotRecord`]s and records the cost-basis method
/// used by the generation pass.
pub fn extract_lot_records_with_cost_basis_method(
    snapshot: &AccountStateSnapshot,
    cost_basis_method: &str,
) -> Vec<LotRecord> {
    let now = Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let mut records = Vec::new();
    let cost_basis_method = cost_basis_method.trim().to_ascii_uppercase();

    for position in snapshot.positions.values() {
        for lot in &position.lots {
            let orig_qty = if lot.original_quantity.is_zero() {
                lot.quantity
            } else {
                lot.original_quantity
            };
            // Original cost basis (immutable) is reconstructed from at-acquisition
            // values: `acquisition_price` is immutable; `original_fees()` returns
            // the immutable `original_acquisition_fees` (falling back to
            // `acquisition_fees` for pre-this-field snapshots that haven't been
            // partially consumed yet). `lot.cost_basis` is mutated on partial
            // sells and represents the remaining open cost basis.
            let orig_fees = lot.original_fees();
            let orig_taxes = lot.original_taxes();
            let original_cost_basis = lot.acquisition_price * orig_qty + orig_fees + orig_taxes;
            records.push(LotRecord {
                id: lot.id.clone(),
                account_id: snapshot.account_id.clone(),
                asset_id: position.asset_id.clone(),
                open_date: lot.acquisition_date_key().to_string(),
                open_activity_id: lot.source_activity_id.clone(),
                original_quantity: orig_qty.to_string(),
                remaining_quantity: lot.quantity.to_string(),
                cost_per_unit: lot.acquisition_price.to_string(),
                original_cost_basis: original_cost_basis.to_string(),
                remaining_cost_basis: lot.cost_basis.to_string(),
                original_cost_basis_base: original_cost_basis.to_string(),
                remaining_cost_basis_base: lot.cost_basis.to_string(),
                fee_allocated: orig_fees.to_string(),
                fee_allocated_base: orig_fees.to_string(),
                tax_allocated: orig_taxes.to_string(),
                tax_allocated_base: orig_taxes.to_string(),
                currency: position.currency.clone(),
                base_currency: snapshot.currency.clone(),
                fx_rate_to_base: Decimal::ONE.to_string(),
                cost_basis_method: cost_basis_method.clone(),
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
            acquisition_local_date: None,
            quantity: qty,
            original_quantity: qty,
            cost_basis: qty * price + fee,
            acquisition_price: price,
            acquisition_fees: fee,
            original_acquisition_fees: fee,
            acquisition_taxes: Decimal::ZERO,
            original_acquisition_taxes: Decimal::ZERO,
            fx_rate_to_position: None,
            fx_rate_to_account: None,
            account_currency: None,
            fx_rate_to_base: None,
            base_currency: None,
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
            assert_eq!(r.cost_basis_method, "FIFO");
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

    /// Regression: a lot that has been partially consumed must still persist
    /// the immutable `original_cost_basis` and `fee_allocated` it had at
    /// acquisition. Before adding `original_acquisition_fees`,
    /// `extract_lot_records` reconstructed those values from the mutated
    /// `acquisition_fees` field, silently corrupting the new lot table on
    /// every partial sell.
    #[test]
    fn extract_lot_records_preserves_original_fees_after_partial_sell() {
        // Lot bought 100 shares @ $15 with a $10 fee. Partially consumed:
        // remaining = 50, cost_basis halved, acquisition_fees halved on the
        // in-memory side. The persisted record must still report the original
        // fee of $10 and an original_cost_basis of 100*$15 + $10 = $1510.
        let mut lot = make_lot(
            "buy-1",
            "POS-XYZ-acc1",
            (2024, 1, 1),
            dec!(100),
            dec!(15),
            dec!(10),
        );
        lot.quantity = dec!(50);
        lot.cost_basis = dec!(750);
        lot.acquisition_fees = dec!(5); // mutated by reduce_lots_fifo

        let pos = make_position("acc1", "XYZ", "USD", vec![lot]);
        let mut positions = HashMap::new();
        positions.insert("XYZ".to_string(), pos);
        let snap = make_snapshot("acc1", positions);

        let records = extract_lot_records(&snap);
        assert_eq!(records.len(), 1);
        let r = &records[0];
        assert_eq!(r.remaining_quantity.parse::<Decimal>().unwrap(), dec!(50));
        assert_eq!(r.original_quantity.parse::<Decimal>().unwrap(), dec!(100));
        assert_eq!(r.fee_allocated.parse::<Decimal>().unwrap(), dec!(10));
        assert_eq!(
            r.original_cost_basis.parse::<Decimal>().unwrap(),
            dec!(1510)
        );
        assert_eq!(
            r.remaining_cost_basis.parse::<Decimal>().unwrap(),
            dec!(750)
        );
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
            original_cost_basis_base: "9250".to_string(),
            remaining_cost_basis_base: "9250".to_string(),
            fee_allocated: "0".to_string(),
            fee_allocated_base: "0".to_string(),
            tax_allocated: "0".to_string(),
            tax_allocated_base: "0".to_string(),
            currency: "USD".to_string(),
            base_currency: "USD".to_string(),
            fx_rate_to_base: "1".to_string(),
            cost_basis_method: "FIFO".to_string(),
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
}
