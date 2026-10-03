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

// ── Repository trait ──────────────────────────────────────────────────────────

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
    /// FX rate from the lot currency to the account currency at acquisition,
    /// when known. Persisted so the open-lot book reproduces account-currency
    /// cost basis exactly on an append-only rebuild (no market-FX fallback).
    /// `None` for same-currency lots or lots written before this column existed.
    pub fx_rate_to_account: Option<String>,
    /// Account currency that `fx_rate_to_account` converts into. `None`
    /// whenever `fx_rate_to_account` is `None`.
    pub account_currency: Option<String>,
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

/// Reconstructs an in-memory [`crate::portfolio::snapshot::Lot`] from a
/// persisted [`LotRecord`].
///
/// The `lots` table is the source of truth for a lot's *open* state, so the
/// in-memory lot's remaining fields (`quantity`, `cost_basis`) come from the
/// record's `remaining_*` columns, while immutable acquisition-side values
/// (`original_quantity`, `acquisition_price`, allocated fee/tax) come from
/// their immutable columns. Base FX is preserved from `fx_rate_to_base`.
///
/// The account-FX book (`fx_rate_to_account`, `account_currency`) is restored
/// from the persisted `lots.fx_rate_to_account` / `lots.account_currency`
/// columns, so an append-only rebuild reproduces the same account-currency cost
/// basis as a full rebuild for multi-currency accounts (no market-FX fallback).
///
/// `fx_rate_to_position` is not retained per-lot and stays `None`; it only
/// records the activity→position conversion for the audit trail and affects no
/// monetary total (quantity, cost basis, valuation, and realized P&L all flow
/// through `remaining_quantity` / `remaining_cost_basis` / `fx_rate_to_base`).
///
/// `acquisition_fees` / `acquisition_taxes` are set to the immutable allocated
/// amounts (equal to `original_acquisition_fees` / `original_acquisition_taxes`).
/// The table stores only the immutable allocation, not the running
/// proportionally-reduced remainder. This is exact for any lot not partially
/// consumed before it was persisted, and only affects the fee/tax *memo*
/// breakdown (never a monetary total: quantity, cost basis, valuation and
/// realized P&L all flow through `remaining_quantity` / `remaining_cost_basis`).
pub fn lot_record_to_snapshot_lot(
    position_id: &str,
    record: LotRecord,
) -> crate::portfolio::snapshot::Lot {
    // Diagnostics below name the lot and the offending column but never the
    // stored value: these columns carry quantities, cost basis, unit price,
    // fees and taxes, and financial data must not reach the logs. The lot id
    // is enough to locate the row.
    let acquisition_local_date = NaiveDate::parse_from_str(&record.open_date, "%Y-%m-%d").ok();
    if acquisition_local_date.is_none() {
        log::warn!(
            "Lot {} has an unparseable open_date; falling back to the current time. \
             The hydrated lot's acquisition date will be wrong.",
            record.id
        );
    }
    let acquisition_date = acquisition_local_date
        .and_then(|date| date.and_hms_opt(0, 0, 0))
        .map(|naive| naive.and_utc())
        .unwrap_or_else(Utc::now);

    let split_ratio = match Decimal::from_str(&record.split_ratio) {
        Ok(ratio) if !ratio.is_zero() => ratio,
        _ => {
            log::warn!(
                "Lot {} has an invalid split_ratio; defaulting to 1.",
                record.id
            );
            Decimal::ONE
        }
    };

    let lot_id = record.id.clone();
    let parse = |field: &str, value: &str| {
        Decimal::from_str(value).unwrap_or_else(|_| {
            log::warn!(
                "Lot {} has an unparseable {}; defaulting to 0.",
                lot_id,
                field
            );
            Decimal::ZERO
        })
    };
    let fees = parse("fee_allocated", &record.fee_allocated);
    let taxes = parse("tax_allocated", &record.tax_allocated);

    crate::portfolio::snapshot::Lot {
        id: record.id,
        position_id: position_id.to_string(),
        acquisition_date,
        acquisition_local_date,
        quantity: parse("remaining_quantity", &record.remaining_quantity),
        original_quantity: parse("original_quantity", &record.original_quantity),
        cost_basis: parse("remaining_cost_basis", &record.remaining_cost_basis),
        acquisition_price: parse("cost_per_unit", &record.cost_per_unit),
        acquisition_fees: fees,
        original_acquisition_fees: fees,
        acquisition_taxes: taxes,
        original_acquisition_taxes: taxes,
        fx_rate_to_position: None,
        fx_rate_to_account: record
            .fx_rate_to_account
            .as_deref()
            .and_then(|value| Decimal::from_str(value).ok()),
        account_currency: record.account_currency,
        fx_rate_to_base: Decimal::from_str(&record.fx_rate_to_base).ok(),
        base_currency: Some(record.base_currency),
        source_activity_id: record.open_activity_id,
        split_ratio,
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {

    // ── Helpers ───────────────────────────────────────────────────────────────

    // ── extract_lot_records ───────────────────────────────────────────────────

    // ── check_lot_quantity_consistency ────────────────────────────────────────
}
