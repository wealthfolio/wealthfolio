//! SQLite repository for tax lot rows.

use async_trait::async_trait;
use diesel::prelude::*;
use diesel::r2d2::{ConnectionManager, Pool};
use diesel::sql_query;
use diesel::sql_types::Text;
use diesel::sqlite::SqliteConnection;
use std::sync::Arc;

use crate::assets::AssetDB;
use crate::db::{get_connection, WriteHandle};
use crate::errors::StorageError;
use crate::utils::chunk_for_sqlite;
use chrono::NaiveDate;
use log::warn;
use rust_decimal::Decimal;
use std::collections::{HashMap, HashSet};
use wealthfolio_core::assets::Asset;
use wealthfolio_core::errors::Result;
use wealthfolio_core::fx::currency::{normalize_amount, normalize_currency_code, resolve_currency};
use wealthfolio_core::lots::{
    AssetLotSource, AssetLotView, LotClosure, LotDisposal, LotRecord, LotRepositoryTrait,
};
use wealthfolio_core::portfolio::snapshot::Position;

// ── Diesel model ──────────────────────────────────────────────────────────────

#[derive(Debug, Queryable, Selectable, Insertable)]
#[diesel(table_name = crate::schema::lots)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
struct LotRecordDB {
    id: String,
    account_id: String,
    asset_id: String,
    open_date: String,
    open_activity_id: Option<String>,
    original_quantity: String,
    cost_per_unit: String,
    original_cost_basis: String,
    remaining_cost_basis: String,
    original_cost_basis_base: String,
    remaining_cost_basis_base: String,
    fee_allocated: String,
    fee_allocated_base: String,
    tax_allocated: String,
    tax_allocated_base: String,
    currency: String,
    base_currency: String,
    fx_rate_to_base: String,
    cost_basis_method: String,
    remaining_quantity: String,
    split_ratio: String,
    is_closed: i32,
    close_date: Option<String>,
    close_activity_id: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Queryable, Selectable, Insertable)]
#[diesel(table_name = crate::schema::lot_disposals)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
struct LotDisposalDB {
    id: String,
    lot_id: String,
    account_id: String,
    asset_id: String,
    disposal_activity_id: String,
    disposal_date: String,
    quantity: String,
    proceeds: String,
    cost_basis: String,
    realized_pnl: String,
    proceeds_base: String,
    cost_basis_base: String,
    realized_pnl_base: String,
    currency: String,
    base_currency: String,
    fx_rate_to_base: String,
    cost_basis_method: String,
    created_at: String,
}

#[derive(Debug, QueryableByName)]
struct LatestHoldingsSnapshotRow {
    #[diesel(sql_type = Text)]
    snapshot_id: String,
    #[diesel(sql_type = Text)]
    account_id: String,
    #[diesel(sql_type = Text)]
    account_name: String,
    #[diesel(sql_type = Text)]
    currency: String,
    #[diesel(sql_type = Text)]
    snapshot_date: String,
    #[diesel(sql_type = Text)]
    positions: String,
}

impl From<LotRecordDB> for LotRecord {
    fn from(r: LotRecordDB) -> Self {
        LotRecord {
            id: r.id,
            account_id: r.account_id,
            asset_id: r.asset_id,
            open_date: r.open_date,
            open_activity_id: r.open_activity_id,
            original_quantity: r.original_quantity,
            remaining_quantity: r.remaining_quantity,
            cost_per_unit: r.cost_per_unit,
            original_cost_basis: r.original_cost_basis,
            remaining_cost_basis: r.remaining_cost_basis,
            original_cost_basis_base: r.original_cost_basis_base,
            remaining_cost_basis_base: r.remaining_cost_basis_base,
            fee_allocated: r.fee_allocated,
            fee_allocated_base: r.fee_allocated_base,
            tax_allocated: r.tax_allocated,
            tax_allocated_base: r.tax_allocated_base,
            currency: r.currency,
            base_currency: r.base_currency,
            fx_rate_to_base: r.fx_rate_to_base,
            cost_basis_method: r.cost_basis_method,
            split_ratio: r.split_ratio,
            is_closed: r.is_closed != 0,
            close_date: r.close_date,
            close_activity_id: r.close_activity_id,
            created_at: r.created_at,
            updated_at: r.updated_at,
        }
    }
}

impl From<&LotRecord> for LotRecordDB {
    fn from(r: &LotRecord) -> Self {
        LotRecordDB {
            id: r.id.clone(),
            account_id: r.account_id.clone(),
            asset_id: r.asset_id.clone(),
            open_date: r.open_date.clone(),
            open_activity_id: r.open_activity_id.clone(),
            original_quantity: r.original_quantity.clone(),
            cost_per_unit: r.cost_per_unit.clone(),
            original_cost_basis: r.original_cost_basis.clone(),
            remaining_cost_basis: r.remaining_cost_basis.clone(),
            original_cost_basis_base: r.original_cost_basis_base.clone(),
            remaining_cost_basis_base: r.remaining_cost_basis_base.clone(),
            fee_allocated: r.fee_allocated.clone(),
            fee_allocated_base: r.fee_allocated_base.clone(),
            tax_allocated: r.tax_allocated.clone(),
            tax_allocated_base: r.tax_allocated_base.clone(),
            currency: r.currency.clone(),
            base_currency: r.base_currency.clone(),
            fx_rate_to_base: r.fx_rate_to_base.clone(),
            cost_basis_method: r.cost_basis_method.clone(),
            remaining_quantity: r.remaining_quantity.clone(),
            split_ratio: r.split_ratio.clone(),
            is_closed: r.is_closed as i32,
            close_date: r.close_date.clone(),
            close_activity_id: r.close_activity_id.clone(),
            created_at: r.created_at.clone(),
            updated_at: r.updated_at.clone(),
        }
    }
}

impl From<&LotDisposal> for LotDisposalDB {
    fn from(d: &LotDisposal) -> Self {
        Self {
            id: d.id.clone(),
            lot_id: d.lot_id.clone(),
            account_id: d.account_id.clone(),
            asset_id: d.asset_id.clone(),
            disposal_activity_id: d.disposal_activity_id.clone(),
            disposal_date: d.disposal_date.clone(),
            quantity: d.quantity.clone(),
            proceeds: d.proceeds.clone(),
            cost_basis: d.cost_basis.clone(),
            realized_pnl: d.realized_pnl.clone(),
            proceeds_base: d.proceeds_base.clone(),
            cost_basis_base: d.cost_basis_base.clone(),
            realized_pnl_base: d.realized_pnl_base.clone(),
            currency: d.currency.clone(),
            base_currency: d.base_currency.clone(),
            fx_rate_to_base: d.fx_rate_to_base.clone(),
            cost_basis_method: d.cost_basis_method.clone(),
            created_at: d.created_at.clone(),
        }
    }
}

impl From<LotDisposalDB> for LotDisposal {
    fn from(d: LotDisposalDB) -> Self {
        Self {
            id: d.id,
            lot_id: d.lot_id,
            account_id: d.account_id,
            asset_id: d.asset_id,
            disposal_activity_id: d.disposal_activity_id,
            disposal_date: d.disposal_date,
            quantity: d.quantity,
            proceeds: d.proceeds,
            cost_basis: d.cost_basis,
            realized_pnl: d.realized_pnl,
            proceeds_base: d.proceeds_base,
            cost_basis_base: d.cost_basis_base,
            realized_pnl_base: d.realized_pnl_base,
            currency: d.currency,
            base_currency: d.base_currency,
            fx_rate_to_base: d.fx_rate_to_base,
            cost_basis_method: d.cost_basis_method,
            created_at: d.created_at,
        }
    }
}

// ── Repository ────────────────────────────────────────────────────────────────

pub struct LotsRepository {
    pool: Arc<Pool<ConnectionManager<SqliteConnection>>>,
    writer: WriteHandle,
}

impl LotsRepository {
    pub fn new(pool: Arc<Pool<ConnectionManager<SqliteConnection>>>, writer: WriteHandle) -> Self {
        Self { pool, writer }
    }
}

#[async_trait]
impl LotRepositoryTrait for LotsRepository {
    async fn replace_lots_for_account(&self, account_id: &str, lots: &[LotRecord]) -> Result<()> {
        use crate::schema::lots::dsl;

        let account_id = account_id.to_string();
        let db_lots: Vec<LotRecordDB> = lots.iter().map(LotRecordDB::from).collect();

        self.writer
            .exec(move |conn| {
                diesel::delete(dsl::lots.filter(dsl::account_id.eq(&account_id)))
                    .execute(conn)
                    .map_err(StorageError::from)?;

                if !db_lots.is_empty() {
                    let normalized = filter_and_normalize_lots(conn, db_lots, &account_id)?;
                    if !normalized.is_empty() {
                        diesel::insert_into(dsl::lots)
                            .values(&normalized)
                            .execute(conn)
                            .map_err(StorageError::from)?;
                    }
                }

                Ok(())
            })
            .await
    }

    async fn get_open_lots_for_account(&self, account_id: &str) -> Result<Vec<LotRecord>> {
        use crate::schema::lots::dsl;

        let account_id = account_id.to_string();
        let mut conn = get_connection(&self.pool)?;
        let rows: Vec<LotRecordDB> = dsl::lots
            .filter(dsl::account_id.eq(&account_id))
            .filter(dsl::is_closed.eq(0))
            .load(&mut conn)
            .map_err(StorageError::from)?;

        Ok(rows.into_iter().map(LotRecord::from).collect())
    }

    async fn get_open_lots_for_account_asset(
        &self,
        account_id: &str,
        asset_id: &str,
    ) -> Result<Vec<LotRecord>> {
        use crate::schema::lots::dsl;

        let account_id = account_id.to_string();
        let asset_id = asset_id.to_string();
        let mut conn = get_connection(&self.pool)?;
        let rows: Vec<LotRecordDB> = dsl::lots
            .filter(dsl::account_id.eq(&account_id))
            .filter(dsl::asset_id.eq(&asset_id))
            .filter(dsl::is_closed.eq(0))
            .load(&mut conn)
            .map_err(StorageError::from)?;

        Ok(rows.into_iter().map(LotRecord::from).collect())
    }

    async fn get_all_open_lots(&self) -> Result<Vec<LotRecord>> {
        use crate::schema::lots::dsl;

        let mut conn = get_connection(&self.pool)?;
        let rows: Vec<LotRecordDB> = dsl::lots
            .filter(dsl::is_closed.eq(0))
            .load(&mut conn)
            .map_err(StorageError::from)?;
        Ok(rows.into_iter().map(LotRecord::from).collect())
    }

    async fn get_lots_as_of_date(
        &self,
        account_ids: &[String],
        date: NaiveDate,
    ) -> Result<Vec<LotRecord>> {
        use crate::schema::lots::dsl;

        let date_str = date.format("%Y-%m-%d").to_string();
        let mut conn = get_connection(&self.pool)?;
        // A lot was active on `date` if it opened on or before that date AND
        // either (a) it is still open, or (b) it closed after that date.
        // The old query used .assume_not_null() on close_date which could drop
        // open lots (NULL > 'x' is NULL in SQL, not TRUE).
        let rows: Vec<LotRecordDB> = dsl::lots
            .filter(dsl::account_id.eq_any(account_ids))
            .filter(dsl::open_date.le(&date_str))
            .filter(
                dsl::is_closed.eq(0).or(dsl::close_date
                    .is_not_null()
                    .and(dsl::close_date.gt(&date_str))),
            )
            .load(&mut conn)
            .map_err(StorageError::from)?;
        Ok(rows.into_iter().map(LotRecord::from).collect())
    }

    async fn get_all_lots_for_account(&self, account_id: &str) -> Result<Vec<LotRecord>> {
        use crate::schema::lots::dsl;

        let account_id = account_id.to_string();
        let mut conn = get_connection(&self.pool)?;
        let rows: Vec<LotRecordDB> = dsl::lots
            .filter(dsl::account_id.eq(&account_id))
            .load(&mut conn)
            .map_err(StorageError::from)?;
        Ok(rows.into_iter().map(LotRecord::from).collect())
    }

    async fn get_lots_for_asset(&self, asset_id: &str) -> Result<Vec<LotRecord>> {
        use crate::schema::lots::dsl;

        let asset_id = asset_id.to_string();
        let mut conn = get_connection(&self.pool)?;
        let rows: Vec<LotRecordDB> = dsl::lots
            .filter(dsl::asset_id.eq(&asset_id))
            .order(dsl::open_date.asc())
            .load(&mut conn)
            .map_err(StorageError::from)?;
        Ok(rows.into_iter().map(LotRecord::from).collect())
    }

    async fn get_asset_lot_view(
        &self,
        asset_id: &str,
        include_snapshot_positions: bool,
    ) -> Result<Vec<AssetLotView>> {
        use crate::schema::accounts::dsl as accounts_dsl;
        use crate::schema::lots::dsl;

        let mut conn = get_connection(&self.pool)?;
        let transaction_rows: Vec<LotRecordDB> = dsl::lots
            .inner_join(accounts_dsl::accounts.on(accounts_dsl::id.eq(dsl::account_id)))
            .filter(dsl::asset_id.eq(asset_id))
            .filter(accounts_dsl::is_active.eq(true))
            .select(LotRecordDB::as_select())
            .order((dsl::open_date.asc(), dsl::account_id.asc(), dsl::id.asc()))
            .load(&mut conn)
            .map_err(StorageError::from)?;

        let account_names: HashMap<String, String> = if transaction_rows.is_empty() {
            HashMap::new()
        } else {
            let account_ids: Vec<String> = transaction_rows
                .iter()
                .map(|row| row.account_id.clone())
                .collect();
            accounts_dsl::accounts
                .filter(accounts_dsl::id.eq_any(account_ids))
                .select((accounts_dsl::id, accounts_dsl::name))
                .load::<(String, String)>(&mut conn)
                .map_err(StorageError::from)?
                .into_iter()
                .collect()
        };
        let contract_multiplier = load_asset_contract_multiplier(&mut conn, asset_id)?;
        let disposal_totals = load_lot_disposal_totals_by_lot(&mut conn, asset_id)?;

        let mut rows: Vec<AssetLotView> = transaction_rows
            .into_iter()
            .map(|row| {
                let account_name = account_names
                    .get(&row.account_id)
                    .cloned()
                    .unwrap_or_else(|| row.account_id.clone());
                let totals = disposal_totals.get(&row.id);
                transaction_lot_view_row(row, account_name, contract_multiplier, totals)
            })
            .collect();

        if include_snapshot_positions {
            rows.extend(load_snapshot_lot_view_rows(&mut conn, asset_id)?);
        }

        rows.sort_by(|a, b| {
            let a_date = a.acquisition_date.as_ref().or(a.snapshot_date.as_ref());
            let b_date = b.acquisition_date.as_ref().or(b.snapshot_date.as_ref());
            a_date
                .cmp(&b_date)
                .then_with(|| a.account_id.cmp(&b.account_id))
                .then_with(|| a.id.cmp(&b.id))
        });

        Ok(rows)
    }

    async fn get_all_lots(&self) -> Result<Vec<LotRecord>> {
        use crate::schema::lots::dsl;

        let mut conn = get_connection(&self.pool)?;
        let rows: Vec<LotRecordDB> = dsl::lots.load(&mut conn).map_err(StorageError::from)?;
        Ok(rows.into_iter().map(LotRecord::from).collect())
    }

    async fn sync_lots_for_account(
        &self,
        account_id: &str,
        open_lots: &[LotRecord],
        closures: &[LotClosure],
    ) -> Result<()> {
        use crate::schema::lots::dsl;

        let account_id = account_id.to_string();
        let db_lots: Vec<LotRecordDB> = open_lots.iter().map(LotRecordDB::from).collect();
        let closures: Vec<LotClosure> = closures.to_vec();

        self.writer
            .exec(move |conn| {
                // Normalize open-lot batch: drop rows whose asset_id no longer
                // exists (FK would reject them), and null out
                // open_activity_id when it points to an activity row that
                // doesn't exist (compiler-generated synthetic IDs like
                // `drip-1:buy`, or activities since deleted).
                let normalized_lots = filter_and_normalize_lots(conn, db_lots, &account_id)?;

                // Upsert open lots one at a time (SQLite Diesel doesn't support
                // batch ON CONFLICT)
                // Refresh ALL replay-derived columns on conflict. The lot's
                // fee/price/date/asset/account can change when a user edits
                // the opening activity (including reassigning it to a
                // different account), so it's not enough to update only
                // quantities and cost basis — the full set of fields
                // produced by the calculator must overwrite the stale row.
                //
                // Preserved across conflicts: id (PK) and created_at (audit
                // anchor for when the row first appeared).
                for lot in &normalized_lots {
                    diesel::insert_into(dsl::lots)
                        .values(lot)
                        .on_conflict(dsl::id)
                        .do_update()
                        .set((
                            dsl::account_id.eq(diesel::upsert::excluded(dsl::account_id)),
                            dsl::asset_id.eq(diesel::upsert::excluded(dsl::asset_id)),
                            dsl::open_date.eq(diesel::upsert::excluded(dsl::open_date)),
                            dsl::open_activity_id
                                .eq(diesel::upsert::excluded(dsl::open_activity_id)),
                            dsl::original_quantity
                                .eq(diesel::upsert::excluded(dsl::original_quantity)),
                            dsl::remaining_quantity
                                .eq(diesel::upsert::excluded(dsl::remaining_quantity)),
                            dsl::cost_per_unit.eq(diesel::upsert::excluded(dsl::cost_per_unit)),
                            dsl::original_cost_basis
                                .eq(diesel::upsert::excluded(dsl::original_cost_basis)),
                            dsl::remaining_cost_basis
                                .eq(diesel::upsert::excluded(dsl::remaining_cost_basis)),
                            dsl::original_cost_basis_base
                                .eq(diesel::upsert::excluded(dsl::original_cost_basis_base)),
                            dsl::remaining_cost_basis_base
                                .eq(diesel::upsert::excluded(dsl::remaining_cost_basis_base)),
                            dsl::fee_allocated.eq(diesel::upsert::excluded(dsl::fee_allocated)),
                            dsl::fee_allocated_base
                                .eq(diesel::upsert::excluded(dsl::fee_allocated_base)),
                            dsl::tax_allocated.eq(diesel::upsert::excluded(dsl::tax_allocated)),
                            dsl::tax_allocated_base
                                .eq(diesel::upsert::excluded(dsl::tax_allocated_base)),
                            dsl::currency.eq(diesel::upsert::excluded(dsl::currency)),
                            dsl::base_currency.eq(diesel::upsert::excluded(dsl::base_currency)),
                            dsl::fx_rate_to_base.eq(diesel::upsert::excluded(dsl::fx_rate_to_base)),
                            dsl::cost_basis_method
                                .eq(diesel::upsert::excluded(dsl::cost_basis_method)),
                            dsl::split_ratio.eq(diesel::upsert::excluded(dsl::split_ratio)),
                            dsl::is_closed.eq(diesel::upsert::excluded(dsl::is_closed)),
                            dsl::close_date.eq(diesel::upsert::excluded(dsl::close_date)),
                            dsl::close_activity_id
                                .eq(diesel::upsert::excluded(dsl::close_activity_id)),
                            dsl::updated_at.eq(diesel::upsert::excluded(dsl::updated_at)),
                        ))
                        .execute(conn)
                        .map_err(StorageError::from)?;
                }

                // Build closure records, then normalize them through the same
                // filter so missing-asset closures are dropped and synthetic
                // open/close_activity_ids are nulled out.
                let now = chrono::Utc::now()
                    .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                    .to_string();
                let closure_lots: Vec<LotRecordDB> = closures
                    .iter()
                    .map(|closure| LotRecordDB {
                        id: closure.lot_id.clone(),
                        account_id: closure.account_id.clone(),
                        asset_id: closure.asset_id.clone(),
                        open_date: closure.open_date.clone(),
                        open_activity_id: closure.open_activity_id.clone(),
                        original_quantity: closure.original_quantity.clone(),
                        remaining_quantity: "0".to_string(),
                        cost_per_unit: closure.cost_per_unit.clone(),
                        original_cost_basis: closure.original_cost_basis.clone(),
                        original_cost_basis_base: closure.original_cost_basis_base.clone(),
                        // Closure means the lot was fully consumed in one pass — no
                        // remaining basis. The disposed amount is captured in the
                        // separate disposal record (when lot_disposals lands).
                        remaining_cost_basis: "0".to_string(),
                        remaining_cost_basis_base: "0".to_string(),
                        fee_allocated: closure.fee_allocated.clone(),
                        fee_allocated_base: closure.fee_allocated_base.clone(),
                        tax_allocated: closure.tax_allocated.clone(),
                        tax_allocated_base: closure.tax_allocated_base.clone(),
                        currency: closure.currency.clone(),
                        base_currency: closure.base_currency.clone(),
                        fx_rate_to_base: closure.fx_rate_to_base.clone(),
                        cost_basis_method: closure.cost_basis_method.clone(),
                        split_ratio: closure.split_ratio.clone(),
                        is_closed: 1,
                        close_date: Some(closure.close_date.clone()),
                        close_activity_id: closure.close_activity_id.clone(),
                        created_at: now.clone(),
                        updated_at: now.clone(),
                    })
                    .collect();
                let normalized_closures =
                    filter_and_normalize_lots(conn, closure_lots, &account_id)?;
                // Same broad refresh for closure UPSERTs. Editing the
                // opening BUY of an already-fully-consumed lot must
                // re-propagate the new fee/price/date through the
                // persisted closure row; otherwise the lots table keeps
                // stale provenance for downstream tax-lot reporting.
                for closed_lot in &normalized_closures {
                    diesel::insert_into(dsl::lots)
                        .values(closed_lot)
                        .on_conflict(dsl::id)
                        .do_update()
                        .set((
                            dsl::account_id.eq(diesel::upsert::excluded(dsl::account_id)),
                            dsl::asset_id.eq(diesel::upsert::excluded(dsl::asset_id)),
                            dsl::open_date.eq(diesel::upsert::excluded(dsl::open_date)),
                            dsl::open_activity_id
                                .eq(diesel::upsert::excluded(dsl::open_activity_id)),
                            dsl::original_quantity
                                .eq(diesel::upsert::excluded(dsl::original_quantity)),
                            dsl::remaining_quantity.eq("0"),
                            dsl::cost_per_unit.eq(diesel::upsert::excluded(dsl::cost_per_unit)),
                            dsl::original_cost_basis
                                .eq(diesel::upsert::excluded(dsl::original_cost_basis)),
                            // Closure means remaining basis is zero; the
                            // disposed amount lives in the (forthcoming)
                            // lot_disposals overlay rather than on the lot.
                            dsl::remaining_cost_basis.eq("0"),
                            dsl::original_cost_basis_base
                                .eq(diesel::upsert::excluded(dsl::original_cost_basis_base)),
                            dsl::remaining_cost_basis_base.eq("0"),
                            dsl::fee_allocated.eq(diesel::upsert::excluded(dsl::fee_allocated)),
                            dsl::fee_allocated_base
                                .eq(diesel::upsert::excluded(dsl::fee_allocated_base)),
                            dsl::tax_allocated.eq(diesel::upsert::excluded(dsl::tax_allocated)),
                            dsl::tax_allocated_base
                                .eq(diesel::upsert::excluded(dsl::tax_allocated_base)),
                            dsl::currency.eq(diesel::upsert::excluded(dsl::currency)),
                            dsl::base_currency.eq(diesel::upsert::excluded(dsl::base_currency)),
                            dsl::fx_rate_to_base.eq(diesel::upsert::excluded(dsl::fx_rate_to_base)),
                            dsl::cost_basis_method
                                .eq(diesel::upsert::excluded(dsl::cost_basis_method)),
                            dsl::split_ratio.eq(diesel::upsert::excluded(dsl::split_ratio)),
                            dsl::is_closed.eq(1),
                            dsl::close_date.eq(diesel::upsert::excluded(dsl::close_date)),
                            dsl::close_activity_id
                                .eq(diesel::upsert::excluded(dsl::close_activity_id)),
                            dsl::updated_at.eq(diesel::upsert::excluded(dsl::updated_at)),
                        ))
                        .execute(conn)
                        .map_err(StorageError::from)?;
                }

                // Delete orphaned lots for this account that weren't produced by
                // this recalculation. Orphans arise when activities are deleted
                // (FK SET NULL on open_activity_id) and a subsequent rebuild
                // creates new lots with new IDs, leaving the old ones behind.
                //
                // Safety: when both open_lots and closures are empty we do NOT
                // wipe the account's lots. An empty result here means the
                // calculation either failed mid-flight (e.g. an activity with a
                // bad asset_id errored) or it ran for an account with no
                // activities at all. In the latter case, callers that legitimately
                // want to clear an account use `replace_lots_for_account(id, &[])`
                // explicitly. In the former case, wiping would destroy correct
                // data — leaving the existing rows stale until the next successful
                // recalc is the safer outcome.
                let known_ids: Vec<&str> = normalized_lots
                    .iter()
                    .map(|l| l.id.as_str())
                    .chain(closures.iter().map(|c| c.lot_id.as_str()))
                    .collect();

                if known_ids.is_empty() {
                    // Check whether existing lots would have been destroyed by the
                    // old wipe-all behaviour and warn loudly so the underlying
                    // calculator failure can be investigated.
                    let existing: i64 = dsl::lots
                        .filter(dsl::account_id.eq(&account_id))
                        .count()
                        .get_result(conn)
                        .map_err(StorageError::from)?;
                    if existing > 0 {
                        log::warn!(
                            "sync_lots_for_account: skipping orphan cleanup for account {} \
                             because the recalculation produced no lots and no closures. \
                             {} existing lot row(s) preserved. This usually indicates a \
                             holdings_calculator error during recalc; check the logs for \
                             'Failed to process activity' or 'Invalid asset_id' messages. \
                             Use replace_lots_for_account explicitly if a wipe is intended.",
                            account_id,
                            existing
                        );
                    }
                } else {
                    // Delete orphaned OPEN lots not produced by this pass.
                    // Closed lots (is_closed=1) are preserved across recalcs:
                    // a subsequent incremental may not include earlier
                    // activities in its replay window, so its `known_ids`
                    // won't list historical closures (`take_disposed_lots`
                    // drains the closure list, so they only appear in the
                    // pass that produced them).
                    //
                    // The previous code also swept closed lots with
                    // `open_activity_id IS NULL`, on the assumption that
                    // those came from `FK ON DELETE SET NULL`. That premise
                    // is wrong: the schema is `ON DELETE CASCADE` on
                    // `open_activity_id` (see migration), so a deleted
                    // opening activity removes the whole lot row — it never
                    // leaves a NULL FK behind. Meanwhile the storage-layer
                    // F1 fix normalizes synthetic compiler IDs (e.g.
                    // `drip-1:buy`) to NULL `open_activity_id` for valid
                    // closed lots; sweeping them was destroying real
                    // closed-lot history for DRIP / staking /
                    // dividend-in-kind activities on every incremental.
                    diesel::delete(
                        dsl::lots
                            .filter(dsl::account_id.eq(&account_id))
                            .filter(dsl::is_closed.eq(0))
                            .filter(diesel::dsl::not(dsl::id.eq_any(&known_ids))),
                    )
                    .execute(conn)
                    .map_err(StorageError::from)?;
                }

                Ok(())
            })
            .await
    }

    async fn sync_lot_disposals_for_account(
        &self,
        account_id: &str,
        affected_activity_ids: &[String],
        disposals: &[LotDisposal],
        replace_all: bool,
    ) -> Result<()> {
        use crate::schema::lot_disposals::dsl;

        let account_id = account_id.to_string();
        let affected_activity_ids = affected_activity_ids.to_vec();
        let db_disposals: Vec<LotDisposalDB> = disposals.iter().map(LotDisposalDB::from).collect();

        self.writer
            .exec(move |conn| {
                if replace_all {
                    diesel::delete(dsl::lot_disposals.filter(dsl::account_id.eq(&account_id)))
                        .execute(conn)
                        .map_err(StorageError::from)?;
                } else if !affected_activity_ids.is_empty() {
                    diesel::delete(
                        dsl::lot_disposals
                            .filter(dsl::account_id.eq(&account_id))
                            .filter(dsl::disposal_activity_id.eq_any(&affected_activity_ids)),
                    )
                    .execute(conn)
                    .map_err(StorageError::from)?;
                }

                if !db_disposals.is_empty() {
                    diesel::insert_into(dsl::lot_disposals)
                        .values(&db_disposals)
                        .execute(conn)
                        .map_err(StorageError::from)?;
                }

                Ok(())
            })
            .await
    }

    async fn get_lot_disposals_for_account(&self, account_id: &str) -> Result<Vec<LotDisposal>> {
        use crate::schema::lot_disposals::dsl;

        let mut conn = get_connection(&self.pool)?;
        let rows: Vec<LotDisposalDB> = dsl::lot_disposals
            .filter(dsl::account_id.eq(account_id))
            .order((
                dsl::disposal_date.asc(),
                dsl::disposal_activity_id.asc(),
                dsl::id.asc(),
            ))
            .load(&mut conn)
            .map_err(StorageError::from)?;

        Ok(rows.into_iter().map(LotDisposal::from).collect())
    }

    async fn get_lot_disposals_for_accounts_in_date_range(
        &self,
        account_ids: &[String],
        start_date_exclusive: NaiveDate,
        end_date_inclusive: NaiveDate,
    ) -> Result<Vec<LotDisposal>> {
        self.get_lot_disposals_for_accounts_in_date_range_sync(
            account_ids,
            start_date_exclusive,
            end_date_inclusive,
        )
    }

    fn get_lot_disposals_for_accounts_in_date_range_sync(
        &self,
        account_ids: &[String],
        start_date_exclusive: NaiveDate,
        end_date_inclusive: NaiveDate,
    ) -> Result<Vec<LotDisposal>> {
        use crate::schema::lot_disposals::dsl;

        if account_ids.is_empty() {
            return Ok(Vec::new());
        }

        let mut conn = get_connection(&self.pool)?;
        let start = start_date_exclusive.to_string();
        let end = end_date_inclusive.to_string();
        let mut rows = Vec::new();

        for chunk in chunk_for_sqlite(account_ids) {
            let chunk_rows: Vec<LotDisposalDB> = dsl::lot_disposals
                .filter(dsl::account_id.eq_any(chunk))
                .filter(dsl::disposal_date.gt(&start))
                .filter(dsl::disposal_date.le(&end))
                .order((
                    dsl::disposal_date.asc(),
                    dsl::disposal_activity_id.asc(),
                    dsl::id.asc(),
                ))
                .load(&mut conn)
                .map_err(StorageError::from)?;
            rows.extend(chunk_rows);
        }

        rows.sort_by(|a, b| {
            a.disposal_date
                .cmp(&b.disposal_date)
                .then_with(|| a.disposal_activity_id.cmp(&b.disposal_activity_id))
                .then_with(|| a.id.cmp(&b.id))
        });

        Ok(rows.into_iter().map(LotDisposal::from).collect())
    }

    async fn get_open_position_quantities(&self) -> Result<HashMap<String, Decimal>> {
        // Quantities are stored as TEXT for Decimal precision, so SUM() in
        // SQLite would force a lossy REAL cast. Fetch only the columns we
        // need (avoiding the full LotRecordDB row) and aggregate as
        // Decimal in Rust to keep precision intact.
        //
        // `remaining_quantity` is in as-acquired (pre-split) units;
        // effective shares held now = remaining_quantity * split_ratio.
        // Callers (e.g. quote sync planning) want the effective open
        // position per asset, so the multiplication happens here. A lot
        // serialized before `split_ratio` existed may have it as "0" or
        // "" — treat both as 1.0 to match `Lot::effective_split_ratio`.
        use crate::schema::lots::dsl;

        let mut conn = get_connection(&self.pool)?;
        let rows: Vec<(String, String, String)> = dsl::lots
            .filter(dsl::is_closed.eq(0))
            .select((dsl::asset_id, dsl::remaining_quantity, dsl::split_ratio))
            .load(&mut conn)
            .map_err(StorageError::from)?;

        let mut quantities: HashMap<String, Decimal> = HashMap::new();
        for (asset_id, remaining, split_ratio) in rows {
            let qty = remaining.parse::<Decimal>().unwrap_or(Decimal::ZERO);
            let ratio = match split_ratio.parse::<Decimal>() {
                Ok(r) if !r.is_zero() => r,
                _ => Decimal::ONE,
            };
            *quantities.entry(asset_id).or_default() += qty * ratio;
        }
        Ok(quantities)
    }

    fn count_lots(&self) -> Result<i64> {
        use crate::schema::lots::dsl;
        use diesel::dsl::count_star;

        let mut conn = get_connection(&self.pool)?;
        let n: i64 = dsl::lots
            .select(count_star())
            .first(&mut conn)
            .map_err(StorageError::from)?;
        Ok(n)
    }
}

fn parse_decimal(value: &str) -> Decimal {
    value.parse::<Decimal>().unwrap_or(Decimal::ZERO)
}

fn parse_nonzero_ratio(value: &str) -> Decimal {
    match value.parse::<Decimal>() {
        Ok(r) if !r.is_zero() => r,
        _ => Decimal::ONE,
    }
}

fn non_empty_currency(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn normalize_lot_money(amount: Decimal, currency: &str) -> Decimal {
    normalize_amount(amount, currency).0
}

#[derive(Default)]
struct LotDisposalTotals {
    proceeds: Decimal,
    cost_basis: Decimal,
    cost_basis_base: Decimal,
    realized_pnl: Decimal,
    realized_pnl_base: Decimal,
}

fn load_lot_disposal_totals_by_lot(
    conn: &mut SqliteConnection,
    asset_id: &str,
) -> Result<HashMap<String, LotDisposalTotals>> {
    use crate::schema::lot_disposals::dsl;

    let rows: Vec<LotDisposalDB> = dsl::lot_disposals
        .filter(dsl::asset_id.eq(asset_id))
        .load(conn)
        .map_err(StorageError::from)?;

    let mut totals = HashMap::<String, LotDisposalTotals>::new();
    for row in rows {
        let entry = totals.entry(row.lot_id).or_default();
        entry.proceeds += parse_decimal(&row.proceeds);
        entry.cost_basis += parse_decimal(&row.cost_basis);
        entry.cost_basis_base += parse_decimal(&row.cost_basis_base);
        entry.realized_pnl += parse_decimal(&row.realized_pnl);
        entry.realized_pnl_base += parse_decimal(&row.realized_pnl_base);
    }

    Ok(totals)
}

fn transaction_lot_view_row(
    row: LotRecordDB,
    account_name: String,
    contract_multiplier: Decimal,
    disposal_totals: Option<&LotDisposalTotals>,
) -> AssetLotView {
    let split_ratio = parse_nonzero_ratio(&row.split_ratio);
    let remaining_quantity = parse_decimal(&row.remaining_quantity);
    let original_quantity = parse_decimal(&row.original_quantity);
    let currency = resolve_currency(&[row.currency.as_str(), row.base_currency.as_str()]);
    let base_currency = non_empty_currency(&row.base_currency);
    let valuation_currency = normalize_currency_code(&currency).to_string();
    let cost_basis = parse_decimal(&row.remaining_cost_basis);
    let cost_basis_base = parse_decimal(&row.remaining_cost_basis_base);
    let unit_cost = parse_decimal(&row.cost_per_unit);
    let fees = parse_decimal(&row.fee_allocated);
    let taxes = parse_decimal(&row.tax_allocated);
    let taxes_base = parse_decimal(&row.tax_allocated_base);
    let disposal_proceeds = disposal_totals.map(|totals| totals.proceeds);
    let disposal_cost_basis = disposal_totals.map(|totals| totals.cost_basis);
    let disposal_cost_basis_base = disposal_totals.map(|totals| totals.cost_basis_base);
    let realized_pnl = disposal_totals.map(|totals| totals.realized_pnl);
    let realized_pnl_base = disposal_totals.map(|totals| totals.realized_pnl_base);

    AssetLotView {
        id: row.id,
        account_id: row.account_id,
        account_name,
        asset_id: row.asset_id,
        source: AssetLotSource::TransactionLot,
        currency: currency.clone(),
        base_currency,
        valuation_currency,
        quantity: remaining_quantity * split_ratio,
        original_quantity,
        remaining_quantity,
        cost_basis,
        cost_basis_base: Some(cost_basis_base),
        unit_cost,
        fees,
        taxes,
        taxes_base: Some(taxes_base),
        valuation_unit_cost: normalize_lot_money(unit_cost, &currency),
        valuation_cost_basis: normalize_lot_money(cost_basis, &currency),
        fx_rate_to_base: Some(parse_decimal(&row.fx_rate_to_base)),
        split_ratio,
        contract_multiplier,
        acquisition_date: Some(row.open_date),
        snapshot_date: None,
        is_closed: row.is_closed != 0,
        close_date: row.close_date,
        disposal_proceeds,
        disposal_cost_basis,
        disposal_cost_basis_base,
        realized_pnl,
        realized_pnl_base,
        valuation_disposal_cost_basis: disposal_cost_basis
            .map(|amount| normalize_lot_money(amount, &currency)),
        valuation_realized_pnl: realized_pnl.map(|amount| normalize_lot_money(amount, &currency)),
    }
}

fn snapshot_position_view_row(
    snapshot: &LatestHoldingsSnapshotRow,
    quantity: Decimal,
    average_cost: Decimal,
    total_cost_basis: Decimal,
    currency: &str,
    contract_multiplier: Decimal,
    asset_id: &str,
) -> AssetLotView {
    let currency = resolve_currency(&[currency, snapshot.currency.as_str()]);
    let valuation_currency = normalize_currency_code(&currency).to_string();

    AssetLotView {
        id: format!(
            "SNAPSHOT-{}-{}-{}",
            snapshot.snapshot_id, snapshot.account_id, asset_id
        ),
        account_id: snapshot.account_id.clone(),
        account_name: snapshot.account_name.clone(),
        asset_id: asset_id.to_string(),
        source: AssetLotSource::SnapshotPosition,
        currency: currency.clone(),
        base_currency: None,
        valuation_currency,
        quantity,
        original_quantity: quantity,
        remaining_quantity: quantity,
        cost_basis: total_cost_basis,
        cost_basis_base: None,
        unit_cost: average_cost,
        fees: Decimal::ZERO,
        taxes: Decimal::ZERO,
        taxes_base: None,
        valuation_unit_cost: normalize_lot_money(average_cost, &currency),
        valuation_cost_basis: normalize_lot_money(total_cost_basis, &currency),
        fx_rate_to_base: None,
        split_ratio: Decimal::ONE,
        contract_multiplier,
        acquisition_date: None,
        snapshot_date: Some(snapshot.snapshot_date.clone()),
        is_closed: false,
        close_date: None,
        disposal_proceeds: None,
        disposal_cost_basis: None,
        disposal_cost_basis_base: None,
        realized_pnl: None,
        realized_pnl_base: None,
        valuation_disposal_cost_basis: None,
        valuation_realized_pnl: None,
    }
}

fn load_snapshot_lot_view_rows(
    conn: &mut SqliteConnection,
    asset_id_param: &str,
) -> Result<Vec<AssetLotView>> {
    let latest_snapshots: Vec<LatestHoldingsSnapshotRow> = sql_query(
        r#"
        SELECT
            hs.id AS snapshot_id,
            hs.account_id AS account_id,
            a.name AS account_name,
            CAST(hs.currency AS TEXT) AS currency,
            CAST(hs.snapshot_date AS TEXT) AS snapshot_date,
            hs.positions AS positions
        FROM holdings_snapshots hs
        JOIN accounts a ON a.id = hs.account_id
        JOIN (
            SELECT hs2.account_id, MAX(hs2.snapshot_date) AS max_snapshot_date
            FROM holdings_snapshots hs2
            JOIN accounts a2 ON a2.id = hs2.account_id
            WHERE hs2.source <> 'CALCULATED'
              AND a2.tracking_mode = 'HOLDINGS'
              AND a2.is_active = 1
            GROUP BY hs2.account_id
        ) latest
          ON latest.account_id = hs.account_id
         AND latest.max_snapshot_date = hs.snapshot_date
        WHERE hs.source <> 'CALCULATED'
          AND a.tracking_mode = 'HOLDINGS'
          AND a.is_active = 1
        ORDER BY hs.account_id ASC, hs.id ASC
        "#,
    )
    .load(conn)
    .map_err(StorageError::from)?;

    if latest_snapshots.is_empty() {
        return Ok(Vec::new());
    }

    let snapshot_ids: Vec<String> = latest_snapshots
        .iter()
        .map(|s| s.snapshot_id.clone())
        .collect();

    let populated_snapshot_ids: HashSet<String> = {
        use crate::schema::snapshot_positions::dsl as sp;
        sp::snapshot_positions
            .select(sp::snapshot_id)
            .filter(sp::snapshot_id.eq_any(&snapshot_ids))
            .distinct()
            .load(conn)
            .map_err(StorageError::from)?
            .into_iter()
            .collect()
    };

    let relational_positions: HashMap<String, (Decimal, Decimal, Decimal, String, Decimal)> = {
        use crate::schema::snapshot_positions::dsl as sp;
        let rows: Vec<(String, String, String, String, String, String)> = sp::snapshot_positions
            .filter(sp::snapshot_id.eq_any(&snapshot_ids))
            .filter(sp::asset_id.eq(asset_id_param))
            .select((
                sp::snapshot_id,
                sp::quantity,
                sp::average_cost,
                sp::total_cost_basis,
                sp::currency,
                sp::contract_multiplier,
            ))
            .load(conn)
            .map_err(StorageError::from)?;

        rows.into_iter()
            .map(
                |(
                    snapshot_id,
                    quantity,
                    average_cost,
                    total_cost_basis,
                    currency,
                    contract_multiplier,
                )| {
                    (
                        snapshot_id,
                        (
                            parse_decimal(&quantity),
                            parse_decimal(&average_cost),
                            parse_decimal(&total_cost_basis),
                            currency,
                            parse_nonzero_ratio(&contract_multiplier),
                        ),
                    )
                },
            )
            .collect()
    };

    let mut rows = Vec::new();
    for snapshot in &latest_snapshots {
        if let Some((quantity, average_cost, total_cost_basis, currency, contract_multiplier)) =
            relational_positions.get(&snapshot.snapshot_id).cloned()
        {
            rows.push(snapshot_position_view_row(
                snapshot,
                quantity,
                average_cost,
                total_cost_basis,
                &currency,
                contract_multiplier,
                asset_id_param,
            ));
            continue;
        }

        if populated_snapshot_ids.contains(&snapshot.snapshot_id) {
            continue;
        }

        let positions = deserialize_positions_json(&snapshot.positions, &snapshot.account_id);
        if let Some(position) = positions.get(asset_id_param) {
            rows.push(snapshot_position_view_row(
                snapshot,
                position.quantity,
                position.average_cost,
                position.total_cost_basis,
                &position.currency,
                position.contract_multiplier,
                asset_id_param,
            ));
        }
    }

    Ok(rows)
}

fn load_asset_contract_multiplier(
    conn: &mut SqliteConnection,
    asset_id_param: &str,
) -> Result<Decimal> {
    use crate::schema::assets::dsl;

    let asset: Option<AssetDB> = dsl::assets
        .filter(dsl::id.eq(asset_id_param))
        .select(AssetDB::as_select())
        .first(conn)
        .optional()
        .map_err(StorageError::from)?;

    Ok(asset
        .map(Asset::from)
        .map(|asset| asset.contract_multiplier())
        .unwrap_or(Decimal::ONE))
}

/// Deserialize the legacy `holdings_snapshots.positions` JSON column into a
/// position map. Returns empty for "{}" or unparseable input. `acct_id` is
/// stamped onto each Position so callers see a consistent account_id even
/// if older serialized payloads lacked the field.
fn deserialize_positions_json(json: &str, acct_id: &str) -> HashMap<String, Position> {
    if json.is_empty() || json == "{}" {
        return HashMap::new();
    }
    match serde_json::from_str::<HashMap<String, Position>>(json) {
        Ok(mut map) => {
            for pos in map.values_mut() {
                if pos.account_id.is_empty() {
                    pos.account_id = acct_id.to_string();
                }
            }
            map
        }
        Err(e) => {
            warn!(
                "Failed to parse positions JSON fallback (acct {}): {}",
                acct_id, e
            );
            HashMap::new()
        }
    }
}

/// Returns the subset of `candidate_ids` that exist in `assets`. Used by lot
/// write paths to drop records whose asset has been deleted while the legacy
/// positions JSON still referenced it — without this filter, the lots table's
/// `asset_id` FK would reject the whole batch.
fn existing_asset_ids<'a, I>(
    conn: &mut SqliteConnection,
    candidate_ids: I,
) -> std::result::Result<HashSet<String>, StorageError>
where
    I: IntoIterator<Item = &'a str>,
{
    use crate::schema::assets::dsl as a;

    let unique: HashSet<String> = candidate_ids.into_iter().map(|s| s.to_string()).collect();
    if unique.is_empty() {
        return Ok(HashSet::new());
    }
    let needles: Vec<String> = unique.iter().cloned().collect();
    let found: Vec<String> = a::assets
        .select(a::id)
        .filter(a::id.eq_any(&needles))
        .load(conn)
        .map_err(StorageError::from)?;
    Ok(found.into_iter().collect())
}

/// Mirror of `existing_asset_ids` for the `activities` table. Used to validate
/// `lots.open_activity_id` / `lots.close_activity_id` before write — the
/// activity-compiler can emit synthetic IDs (e.g. `drip-1:buy`) that look like
/// real IDs but don't have rows in `activities`, and a user can delete an
/// activity at any time. Storing such an ID would violate the FK constraint
/// and abort the whole batch.
fn existing_activity_ids<'a, I>(
    conn: &mut SqliteConnection,
    candidate_ids: I,
) -> std::result::Result<HashSet<String>, StorageError>
where
    I: IntoIterator<Item = &'a str>,
{
    use crate::schema::activities::dsl as ac;

    let unique: HashSet<String> = candidate_ids.into_iter().map(|s| s.to_string()).collect();
    if unique.is_empty() {
        return Ok(HashSet::new());
    }
    let needles: Vec<String> = unique.iter().cloned().collect();
    let found: Vec<String> = ac::activities
        .select(ac::id)
        .filter(ac::id.eq_any(&needles))
        .load(conn)
        .map_err(StorageError::from)?;
    Ok(found.into_iter().collect())
}

/// Pre-write normalization for a batch of `LotRecordDB`:
///
///   * Drop rows whose `asset_id` is missing from `assets` (with a warn log).
///   * Null out `open_activity_id` / `close_activity_id` when they point at
///     activities that don't exist (with a warn log). The compiler emits
///     synthetic IDs like `<parent>:buy` for DRIP / staking / dividend-in-kind
///     legs; the lot record is still real and useful, just can't claim
///     provenance through the FK.
///
/// Returns the normalized batch ready for insert/upsert.
fn filter_and_normalize_lots(
    conn: &mut SqliteConnection,
    lots: Vec<LotRecordDB>,
    account_id: &str,
) -> std::result::Result<Vec<LotRecordDB>, StorageError> {
    if lots.is_empty() {
        return Ok(lots);
    }
    let valid_assets = existing_asset_ids(conn, lots.iter().map(|l| l.asset_id.as_str()))?;
    let valid_activities = existing_activity_ids(
        conn,
        lots.iter()
            .filter_map(|l| l.open_activity_id.as_deref())
            .chain(lots.iter().filter_map(|l| l.close_activity_id.as_deref())),
    )?;

    let mut out = Vec::with_capacity(lots.len());
    for mut lot in lots {
        if !valid_assets.contains(lot.asset_id.as_str()) {
            warn!(
                "Dropping lot {} for missing asset {} (account {})",
                lot.id, lot.asset_id, account_id
            );
            continue;
        }
        if let Some(ref aid) = lot.open_activity_id {
            if !valid_activities.contains(aid.as_str()) {
                warn!(
                    "Lot {} references unknown open_activity_id {} (account {}); persisting as NULL",
                    lot.id, aid, account_id
                );
                lot.open_activity_id = None;
            }
        }
        if let Some(ref aid) = lot.close_activity_id {
            if !valid_activities.contains(aid.as_str()) {
                warn!(
                    "Lot {} references unknown close_activity_id {} (account {}); persisting as NULL",
                    lot.id, aid, account_id
                );
                lot.close_activity_id = None;
            }
        }
        out.push(lot);
    }
    Ok(out)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{create_pool, run_migrations, write_actor::spawn_writer};
    use tempfile::tempdir;

    fn dec(value: &str) -> Decimal {
        value.parse::<Decimal>().unwrap()
    }

    async fn setup() -> (
        LotsRepository,
        Arc<Pool<ConnectionManager<SqliteConnection>>>,
        tempfile::TempDir,
    ) {
        std::env::set_var("CONNECT_API_URL", "http://test.local");
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db").to_string_lossy().to_string();
        run_migrations(&db_path).unwrap();
        let pool = create_pool(&db_path).unwrap();
        let writer = spawn_writer((*pool).clone()).unwrap();
        let repo = LotsRepository::new(Arc::clone(&pool), writer);
        (repo, pool, dir)
    }

    fn insert_account_with_tracking_mode(
        pool: &Arc<Pool<ConnectionManager<SqliteConnection>>>,
        id: &str,
        tracking_mode: &str,
    ) {
        let mut conn = get_connection(pool).unwrap();
        diesel::sql_query(format!(
            "INSERT INTO accounts (id, name, account_type, currency, is_default, is_active, \
             created_at, updated_at, tracking_mode, is_archived) \
             VALUES ('{}', 'Test', 'REGULAR', 'USD', 0, 1, datetime('now'), datetime('now'), '{}', 0)",
            id, tracking_mode
        ))
        .execute(&mut conn)
        .unwrap();
    }

    fn insert_account(pool: &Arc<Pool<ConnectionManager<SqliteConnection>>>, id: &str) {
        insert_account_with_tracking_mode(pool, id, "TRANSACTIONS");
    }

    fn insert_asset(pool: &Arc<Pool<ConnectionManager<SqliteConnection>>>, id: &str) {
        let mut conn = get_connection(pool).unwrap();
        diesel::sql_query(format!(
            "INSERT INTO assets (id, kind, is_active, quote_mode, quote_ccy, created_at, updated_at) \
             VALUES ('{}', 'INVESTMENT', 1, 'MARKET', 'USD', datetime('now'), datetime('now'))",
            id
        ))
        .execute(&mut conn)
        .unwrap();
    }

    /// Seed an activity row so a lot's `open_activity_id` / `close_activity_id`
    /// FK can target it without violating the constraint. Uses minimal columns;
    /// tests only care that the id exists.
    fn insert_activity(pool: &Arc<Pool<ConnectionManager<SqliteConnection>>>, id: &str) {
        let mut conn = get_connection(pool).unwrap();
        diesel::sql_query(format!(
            "INSERT INTO activities (id, account_id, activity_type, status, activity_date, currency, \
             is_user_modified, needs_review, created_at, updated_at) \
             VALUES ('{}', 'acc1', 'BUY', 'POSTED', '2024-01-15T00:00:00Z', 'USD', 0, 0, \
             datetime('now'), datetime('now'))",
            id
        ))
        .execute(&mut conn)
        .unwrap();
    }

    fn make_lot_record(id: &str, account_id: &str, asset_id: &str, qty: &str) -> LotRecord {
        LotRecord {
            id: id.to_string(),
            account_id: account_id.to_string(),
            asset_id: asset_id.to_string(),
            open_date: "2024-01-15".to_string(),
            open_activity_id: None,
            original_quantity: qty.to_string(),
            remaining_quantity: qty.to_string(),
            cost_per_unit: "150".to_string(),
            original_cost_basis: "15000".to_string(),
            remaining_cost_basis: "15000".to_string(),
            original_cost_basis_base: "15000".to_string(),
            remaining_cost_basis_base: "15000".to_string(),
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
        }
    }

    fn make_lot_disposal(
        id: &str,
        account_id: &str,
        lot_id: &str,
        activity_id: &str,
        disposal_date: &str,
    ) -> LotDisposal {
        LotDisposal {
            id: id.to_string(),
            lot_id: lot_id.to_string(),
            account_id: account_id.to_string(),
            asset_id: "AAPL".to_string(),
            disposal_activity_id: activity_id.to_string(),
            disposal_date: disposal_date.to_string(),
            quantity: "1".to_string(),
            proceeds: "160".to_string(),
            cost_basis: "150".to_string(),
            realized_pnl: "10".to_string(),
            proceeds_base: "160".to_string(),
            cost_basis_base: "150".to_string(),
            realized_pnl_base: "10".to_string(),
            currency: "USD".to_string(),
            base_currency: "USD".to_string(),
            fx_rate_to_base: "1".to_string(),
            cost_basis_method: "FIFO".to_string(),
            created_at: "2026-02-01T00:00:00.000Z".to_string(),
        }
    }

    #[tokio::test]
    async fn asset_lot_view_normalizes_quote_unit_display_fields_without_using_base() {
        let (repo, pool, _dir) = setup().await;
        insert_account(&pool, "acc1");
        insert_asset(&pool, "CTY");

        let mut lot = make_lot_record("cty-lot", "acc1", "CTY", "51");
        lot.currency = "GBp".to_string();
        lot.base_currency = "USD".to_string();
        lot.fx_rate_to_base = "0.0125".to_string();
        lot.cost_per_unit = "556.765".to_string();
        lot.original_cost_basis = "28395.015".to_string();
        lot.remaining_cost_basis = "28395.015".to_string();
        lot.original_cost_basis_base = "354.9376875".to_string();
        lot.remaining_cost_basis_base = "354.9376875".to_string();
        lot.fee_allocated = "100".to_string();
        lot.fee_allocated_base = "1.25".to_string();
        lot.tax_allocated = "50".to_string();
        lot.tax_allocated_base = "0.625".to_string();

        repo.replace_lots_for_account("acc1", &[lot]).await.unwrap();

        let rows = repo.get_asset_lot_view("CTY", false).await.unwrap();
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert_eq!(row.currency, "GBp");
        assert_eq!(row.base_currency.as_deref(), Some("USD"));
        assert_eq!(row.valuation_currency, "GBP");
        assert_eq!(row.unit_cost, dec("556.765"));
        assert_eq!(row.cost_basis, dec("28395.015"));
        assert_eq!(row.cost_basis_base, Some(dec("354.9376875")));
        assert_eq!(row.valuation_unit_cost, dec("5.56765"));
        assert_eq!(row.valuation_cost_basis, dec("283.95015"));
    }

    #[tokio::test]
    async fn get_lot_disposals_for_accounts_in_date_range_filters_period() {
        let (repo, pool, _dir) = setup().await;
        insert_account(&pool, "acc1");
        insert_account(&pool, "acc2");
        insert_asset(&pool, "AAPL");
        insert_activity(&pool, "sell-old");
        insert_activity(&pool, "sell-1");
        insert_activity(&pool, "sell-2");

        repo.replace_lots_for_account(
            "acc1",
            &[
                make_lot_record("lot-old", "acc1", "AAPL", "1"),
                make_lot_record("lot-1", "acc1", "AAPL", "1"),
            ],
        )
        .await
        .unwrap();
        repo.replace_lots_for_account("acc2", &[make_lot_record("lot-2", "acc2", "AAPL", "1")])
            .await
            .unwrap();

        repo.sync_lot_disposals_for_account(
            "acc1",
            &[],
            &[
                make_lot_disposal("disp-old", "acc1", "lot-old", "sell-old", "2026-01-01"),
                make_lot_disposal("disp-1", "acc1", "lot-1", "sell-1", "2026-02-01"),
            ],
            true,
        )
        .await
        .unwrap();
        repo.sync_lot_disposals_for_account(
            "acc2",
            &[],
            &[make_lot_disposal(
                "disp-2",
                "acc2",
                "lot-2",
                "sell-2",
                "2026-02-15",
            )],
            true,
        )
        .await
        .unwrap();

        let disposals = repo
            .get_lot_disposals_for_accounts_in_date_range(
                &["acc1".to_string(), "acc2".to_string()],
                NaiveDate::from_ymd_opt(2026, 1, 31).unwrap(),
                NaiveDate::from_ymd_opt(2026, 2, 28).unwrap(),
            )
            .await
            .unwrap();

        let ids: Vec<&str> = disposals
            .iter()
            .map(|disposal| disposal.id.as_str())
            .collect();
        assert_eq!(ids, vec!["disp-1", "disp-2"]);
    }

    #[tokio::test]
    async fn replace_inserts_and_replaces_lots_for_account() {
        let (repo, pool, _dir) = setup().await;
        insert_account(&pool, "acc1");
        insert_asset(&pool, "AAPL");
        insert_asset(&pool, "MSFT");

        // Insert 3 lots: 2 AAPL, 1 MSFT
        let initial = vec![
            make_lot_record("l1", "acc1", "AAPL", "50"),
            make_lot_record("l2", "acc1", "AAPL", "30"),
            make_lot_record("l3", "acc1", "MSFT", "100"),
        ];
        repo.replace_lots_for_account("acc1", &initial)
            .await
            .unwrap();
        assert_eq!(repo.count_lots().unwrap(), 3);

        // Replace with 2 different lots
        let replacement = vec![
            make_lot_record("l4", "acc1", "AAPL", "80"),
            make_lot_record("l5", "acc1", "MSFT", "60"),
        ];
        repo.replace_lots_for_account("acc1", &replacement)
            .await
            .unwrap();
        assert_eq!(repo.count_lots().unwrap(), 2);

        // Old IDs must be gone
        let mut conn = get_connection(&pool).unwrap();
        let ids: Vec<String> = crate::schema::lots::dsl::lots
            .select(crate::schema::lots::dsl::id)
            .load(&mut conn)
            .unwrap();
        assert!(!ids.contains(&"l1".to_string()));
        assert!(ids.contains(&"l4".to_string()));
        assert!(ids.contains(&"l5".to_string()));
    }

    #[tokio::test]
    async fn replace_only_affects_target_account() {
        let (repo, pool, _dir) = setup().await;
        insert_account(&pool, "acc1");
        insert_account(&pool, "acc2");
        insert_asset(&pool, "AAPL");
        insert_asset(&pool, "LQD");

        repo.replace_lots_for_account(
            "acc1",
            &[
                make_lot_record("a1", "acc1", "AAPL", "50"),
                make_lot_record("a2", "acc1", "AAPL", "30"),
            ],
        )
        .await
        .unwrap();

        repo.replace_lots_for_account(
            "acc2",
            &[
                make_lot_record("b1", "acc2", "LQD", "100"),
                make_lot_record("b2", "acc2", "LQD", "50"),
                make_lot_record("b3", "acc2", "LQD", "25"),
            ],
        )
        .await
        .unwrap();

        assert_eq!(repo.count_lots().unwrap(), 5);

        // Replace only acc1; acc2 must be untouched
        repo.replace_lots_for_account("acc1", &[make_lot_record("a3", "acc1", "AAPL", "80")])
            .await
            .unwrap();

        assert_eq!(repo.count_lots().unwrap(), 4); // 1 (acc1) + 3 (acc2)

        let mut conn = get_connection(&pool).unwrap();
        let acc2_count: i64 = crate::schema::lots::dsl::lots
            .filter(crate::schema::lots::dsl::account_id.eq("acc2"))
            .select(diesel::dsl::count_star())
            .first(&mut conn)
            .unwrap();
        assert_eq!(acc2_count, 3);
    }

    #[tokio::test]
    async fn replace_with_empty_slice_clears_account() {
        let (repo, pool, _dir) = setup().await;
        insert_account(&pool, "acc1");
        insert_asset(&pool, "AAPL");

        repo.replace_lots_for_account("acc1", &[make_lot_record("l1", "acc1", "AAPL", "50")])
            .await
            .unwrap();
        assert_eq!(repo.count_lots().unwrap(), 1);

        repo.replace_lots_for_account("acc1", &[]).await.unwrap();
        assert_eq!(repo.count_lots().unwrap(), 0);
    }

    /// Regression test for the FK-violation bug where compiler-generated
    /// synthetic activity IDs (e.g. `drip-1:buy` for DRIP/staking/dividend-
    /// in-kind BUY legs) would cause `replace_lots_for_account` /
    /// `sync_lots_for_account` to abort with a FK violation on
    /// `lots.open_activity_id`.
    ///
    /// The storage layer should detect that the referenced activity doesn't
    /// exist, null out the FK column with a warning, and still persist the
    /// rest of the lot data.
    #[tokio::test]
    async fn synthetic_open_activity_id_is_nulled_out() {
        let (repo, pool, _dir) = setup().await;
        insert_account(&pool, "acc1");
        insert_asset(&pool, "AAPL");

        // `drip-1:buy` is not in the activities table.
        let mut lot = make_lot_record("lot-drip", "acc1", "AAPL", "10");
        lot.open_activity_id = Some("drip-1:buy".to_string());

        // Should succeed (no FK violation), with the open_activity_id stored as NULL.
        repo.replace_lots_for_account("acc1", &[lot]).await.unwrap();

        let stored = repo.get_open_lots_for_account("acc1").await.unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].id, "lot-drip");
        assert!(
            stored[0].open_activity_id.is_none(),
            "synthetic activity_id {:?} should be normalized to NULL",
            stored[0].open_activity_id
        );
    }

    /// Regression test for the data-corruption bug where a recalculation that
    /// failed (e.g. activity with empty asset_id) would produce empty results,
    /// and `sync_lots_for_account` would then wipe every lot for the account.
    ///
    /// `sync_lots_for_account` must NEVER delete an account's existing lots
    /// when it is given empty inputs. Callers that legitimately want to clear
    /// an account use `replace_lots_for_account(id, &[])` explicitly.
    #[tokio::test]
    async fn sync_with_empty_inputs_does_not_wipe_existing_lots() {
        let (repo, pool, _dir) = setup().await;
        insert_account(&pool, "acc1");
        insert_asset(&pool, "AAPL");
        insert_asset(&pool, "MSFT");

        // Seed the account with some lots.
        let initial = vec![
            make_lot_record("l1", "acc1", "AAPL", "50"),
            make_lot_record("l2", "acc1", "AAPL", "30"),
            make_lot_record("l3", "acc1", "MSFT", "100"),
        ];
        repo.sync_lots_for_account("acc1", &initial, &[])
            .await
            .unwrap();
        assert_eq!(repo.count_lots().unwrap(), 3);

        // Simulate a failed recalc that produced nothing for this account.
        // The function MUST NOT wipe the existing lots.
        repo.sync_lots_for_account("acc1", &[], &[]).await.unwrap();
        assert_eq!(
            repo.count_lots().unwrap(),
            3,
            "sync_lots_for_account with empty inputs must preserve existing lots \
             (failed recalcs would otherwise wipe correct data)"
        );

        // Verify the actual rows are unchanged.
        let lots = repo.get_all_lots_for_account("acc1").await.unwrap();
        assert_eq!(lots.len(), 3);
        let ids: Vec<&str> = lots.iter().map(|l| l.id.as_str()).collect();
        assert!(ids.contains(&"l1"));
        assert!(ids.contains(&"l2"));
        assert!(ids.contains(&"l3"));

        // Sanity check: the explicit wipe path still works for the legitimate
        // "account drained" case.
        repo.replace_lots_for_account("acc1", &[]).await.unwrap();
        assert_eq!(repo.count_lots().unwrap(), 0);
    }

    /// `sync_lots_for_account` should still remove orphaned lots when given a
    /// non-empty new set (the partial-replacement case for incremental recalc).
    #[tokio::test]
    async fn sync_with_partial_inputs_removes_orphans() {
        let (repo, pool, _dir) = setup().await;
        insert_account(&pool, "acc1");
        insert_asset(&pool, "AAPL");
        insert_asset(&pool, "MSFT");

        let initial = vec![
            make_lot_record("l1", "acc1", "AAPL", "50"),
            make_lot_record("l2", "acc1", "AAPL", "30"),
            make_lot_record("l3", "acc1", "MSFT", "100"),
        ];
        repo.sync_lots_for_account("acc1", &initial, &[])
            .await
            .unwrap();
        assert_eq!(repo.count_lots().unwrap(), 3);

        // Recalc keeps only l1; l2 and l3 should be orphaned and removed.
        let kept = vec![make_lot_record("l1", "acc1", "AAPL", "50")];
        repo.sync_lots_for_account("acc1", &kept, &[])
            .await
            .unwrap();
        assert_eq!(repo.count_lots().unwrap(), 1);

        let lots = repo.get_all_lots_for_account("acc1").await.unwrap();
        assert_eq!(lots.len(), 1);
        assert_eq!(lots[0].id, "l1");
    }

    /// Regression: editing the opening BUY's fee / price / date must
    /// propagate to the persisted lot row on the next recalc. Before
    /// broadening the UPSERT SET clause, the conflict handler refreshed
    /// quantities and cost basis but left `fee_allocated`, `open_date`,
    /// `open_activity_id`, and `asset_id` from the original row.
    #[tokio::test]
    async fn sync_upsert_refreshes_origin_fields_on_open_lot_edit() {
        let (repo, pool, _dir) = setup().await;
        insert_account(&pool, "acc1");
        insert_asset(&pool, "AAPL");
        insert_asset(&pool, "MSFT");
        insert_activity(&pool, "buy-1");
        insert_activity(&pool, "buy-1-edited");

        // Initial: AAPL @ 150 with $10 fee, opened 2024-01-15.
        let mut lot = make_lot_record("lot-1", "acc1", "AAPL", "100");
        lot.open_date = "2024-01-15".to_string();
        lot.open_activity_id = Some("buy-1".to_string());
        lot.fee_allocated = "10".to_string();
        lot.cost_per_unit = "150".to_string();
        lot.original_cost_basis = "15010".to_string();
        repo.sync_lots_for_account("acc1", &[lot], &[])
            .await
            .unwrap();

        // User edits the BUY: changes asset to MSFT, date to 2024-02-01,
        // fee to $25, price to 200. Activity id rolls over too.
        let mut edited = make_lot_record("lot-1", "acc1", "MSFT", "100");
        edited.open_date = "2024-02-01".to_string();
        edited.open_activity_id = Some("buy-1-edited".to_string());
        edited.fee_allocated = "25".to_string();
        edited.cost_per_unit = "200".to_string();
        edited.original_cost_basis = "20025".to_string();
        repo.sync_lots_for_account("acc1", &[edited], &[])
            .await
            .unwrap();

        let stored = repo.get_all_lots_for_account("acc1").await.unwrap();
        assert_eq!(stored.len(), 1);
        let l = &stored[0];
        assert_eq!(l.asset_id, "MSFT", "asset_id must follow the edit");
        assert_eq!(l.open_date, "2024-02-01", "open_date must follow the edit");
        assert_eq!(
            l.open_activity_id.as_deref(),
            Some("buy-1-edited"),
            "open_activity_id must follow the edit"
        );
        assert_eq!(l.fee_allocated, "25", "fee_allocated must follow the edit");
        assert_eq!(l.cost_per_unit, "200");
        assert_eq!(l.original_cost_basis, "20025");
    }

    /// Regression: editing the opening BUY of an already-fully-consumed lot
    /// must refresh the closure row's basis/fee/date too. The previous
    /// closure UPSERT only set close metadata + is_closed, leaving every
    /// other column at the pre-edit value.
    #[tokio::test]
    async fn sync_upsert_refreshes_origin_fields_on_closure() {
        let (repo, pool, _dir) = setup().await;
        insert_account(&pool, "acc1");
        insert_asset(&pool, "AAPL");
        insert_activity(&pool, "buy-1");
        insert_activity(&pool, "buy-1-edited");
        insert_activity(&pool, "sell-1");

        // First pass: lot bought 100 @ $150 with $10 fee, then fully sold.
        let closure_v1 = LotClosure {
            lot_id: "lot-1".to_string(),
            close_date: "2024-06-01".to_string(),
            close_activity_id: Some("sell-1".to_string()),
            open_activity_id: Some("buy-1".to_string()),
            account_id: "acc1".to_string(),
            asset_id: "AAPL".to_string(),
            open_date: "2024-01-15".to_string(),
            original_quantity: "100".to_string(),
            cost_per_unit: "150".to_string(),
            original_cost_basis: "15010".to_string(),
            original_cost_basis_base: "15010".to_string(),
            remaining_cost_basis_base: "0".to_string(),
            fee_allocated: "10".to_string(),
            fee_allocated_base: "10".to_string(),
            tax_allocated: "0".to_string(),
            tax_allocated_base: "0".to_string(),
            currency: "USD".to_string(),
            base_currency: "USD".to_string(),
            fx_rate_to_base: "1".to_string(),
            cost_basis_method: "FIFO".to_string(),
            split_ratio: "1".to_string(),
        };
        repo.sync_lots_for_account("acc1", &[], &[closure_v1])
            .await
            .unwrap();

        let stored = repo.get_all_lots_for_account("acc1").await.unwrap();
        assert_eq!(stored.len(), 1);
        assert!(stored[0].is_closed);

        // User edits the now-historical BUY: fee changes to $25, price to
        // $200. Replay produces a closure with the corrected basis.
        let closure_v2 = LotClosure {
            lot_id: "lot-1".to_string(),
            close_date: "2024-06-01".to_string(),
            close_activity_id: Some("sell-1".to_string()),
            open_activity_id: Some("buy-1-edited".to_string()),
            account_id: "acc1".to_string(),
            asset_id: "AAPL".to_string(),
            open_date: "2024-02-01".to_string(),
            original_quantity: "100".to_string(),
            cost_per_unit: "200".to_string(),
            original_cost_basis: "20025".to_string(),
            original_cost_basis_base: "20025".to_string(),
            remaining_cost_basis_base: "0".to_string(),
            fee_allocated: "25".to_string(),
            fee_allocated_base: "25".to_string(),
            tax_allocated: "0".to_string(),
            tax_allocated_base: "0".to_string(),
            currency: "USD".to_string(),
            base_currency: "USD".to_string(),
            fx_rate_to_base: "1".to_string(),
            cost_basis_method: "FIFO".to_string(),
            split_ratio: "1".to_string(),
        };
        repo.sync_lots_for_account("acc1", &[], &[closure_v2])
            .await
            .unwrap();

        let stored = repo.get_all_lots_for_account("acc1").await.unwrap();
        assert_eq!(stored.len(), 1);
        let l = &stored[0];
        assert!(l.is_closed);
        assert_eq!(l.open_date, "2024-02-01");
        assert_eq!(l.open_activity_id.as_deref(), Some("buy-1-edited"));
        assert_eq!(l.cost_per_unit, "200");
        assert_eq!(l.original_cost_basis, "20025");
        assert_eq!(l.fee_allocated, "25");
    }

    /// Regression: `get_open_position_quantities` must apply `split_ratio`.
    /// Quantities are stored in as-acquired (pre-split) units; the returned
    /// per-asset total is the effective (current) quantity used by quote
    /// sync planning and similar consumers. Pre-fix the sum was raw
    /// remaining_quantity, undercounting post-split holdings.
    #[tokio::test]
    async fn get_open_position_quantities_applies_split_ratio() {
        let (repo, pool, _dir) = setup().await;
        insert_account(&pool, "acc1");
        insert_asset(&pool, "AAPL");
        insert_asset(&pool, "MSFT");

        // AAPL: 10 shares as-acquired, 2:1 split applied → effective 20.
        let mut split_lot = make_lot_record("lot-aapl", "acc1", "AAPL", "10");
        split_lot.original_quantity = "10".to_string();
        split_lot.split_ratio = "2".to_string();

        // MSFT: 50 shares, no split.
        let plain_lot = make_lot_record("lot-msft", "acc1", "MSFT", "50");

        repo.replace_lots_for_account("acc1", &[split_lot, plain_lot])
            .await
            .unwrap();

        let qtys = repo.get_open_position_quantities().await.unwrap();
        assert_eq!(
            qtys.get("AAPL").copied(),
            Some(rust_decimal::Decimal::from(20)),
            "effective quantity must be remaining_quantity * split_ratio"
        );
        assert_eq!(
            qtys.get("MSFT").copied(),
            Some(rust_decimal::Decimal::from(50)),
            "non-split lots return remaining_quantity unchanged"
        );
    }

    #[tokio::test]
    async fn asset_lot_view_can_append_latest_holdings_snapshot_positions() {
        let (repo, pool, _dir) = setup().await;
        insert_account(&pool, "acc1");
        insert_account_with_tracking_mode(&pool, "acc_holdings", "HOLDINGS");
        insert_asset(&pool, "AAPL");

        repo.replace_lots_for_account("acc1", &[make_lot_record("lot-1", "acc1", "AAPL", "50")])
            .await
            .unwrap();

        let mut conn = get_connection(&pool).unwrap();
        diesel::sql_query(
            "INSERT INTO holdings_snapshots (id, account_id, snapshot_date, currency, positions, \
             cash_balances, cost_basis, net_contribution, calculated_at, net_contribution_base, \
             cash_total_account_currency, cash_total_base_currency, source) \
             VALUES ('snap-holdings', 'acc_holdings', '2026-05-20', 'USD', '{}', '{}', \
             '2400', '0', '2026-05-20T00:00:00Z', '0', '0', '0', 'MANUAL_ENTRY')",
        )
        .execute(&mut conn)
        .unwrap();
        diesel::sql_query(
            "INSERT INTO snapshot_positions (snapshot_id, asset_id, quantity, average_cost, \
             total_cost_basis, currency, inception_date, is_alternative, contract_multiplier, \
             created_at, last_updated) \
             VALUES ('snap-holdings', 'AAPL', '12', '200', '2400', 'USD', \
             '2026-05-20T00:00:00Z', 0, '1', '2026-05-20T00:00:00Z', \
             '2026-05-20T00:00:00Z')",
        )
        .execute(&mut conn)
        .unwrap();
        drop(conn);

        let transaction_only = repo.get_asset_lot_view("AAPL", false).await.unwrap();
        assert_eq!(transaction_only.len(), 1);
        assert_eq!(transaction_only[0].source, AssetLotSource::TransactionLot);

        let with_snapshots = repo.get_asset_lot_view("AAPL", true).await.unwrap();
        assert_eq!(with_snapshots.len(), 2);

        let snapshot_row = with_snapshots
            .iter()
            .find(|row| row.source == AssetLotSource::SnapshotPosition)
            .expect("snapshot aggregate row");
        assert_eq!(snapshot_row.account_id, "acc_holdings");
        assert_eq!(snapshot_row.quantity, Decimal::from(12));
        assert_eq!(snapshot_row.unit_cost, Decimal::from(200));
        assert_eq!(snapshot_row.cost_basis, Decimal::from(2400));
        assert_eq!(snapshot_row.currency, "USD");
        assert_eq!(snapshot_row.valuation_currency, "USD");
        assert_eq!(snapshot_row.valuation_unit_cost, Decimal::from(200));
        assert_eq!(snapshot_row.valuation_cost_basis, Decimal::from(2400));
        assert_eq!(snapshot_row.contract_multiplier, Decimal::ONE);
        assert_eq!(snapshot_row.snapshot_date.as_deref(), Some("2026-05-20"));
    }

    #[tokio::test]
    async fn asset_lot_view_normalizes_snapshot_position_quote_unit_currency() {
        let (repo, pool, _dir) = setup().await;
        insert_account_with_tracking_mode(&pool, "acc_holdings", "HOLDINGS");
        insert_asset(&pool, "CTY");

        let mut conn = get_connection(&pool).unwrap();
        diesel::sql_query(
            "INSERT INTO holdings_snapshots (id, account_id, snapshot_date, currency, positions, \
             cash_balances, cost_basis, net_contribution, calculated_at, net_contribution_base, \
             cash_total_account_currency, cash_total_base_currency, source) \
             VALUES ('snap-gbp', 'acc_holdings', '2026-05-20', 'GBP', '{}', '{}', \
             '283.95015', '0', '2026-05-20T00:00:00Z', '0', '0', '0', 'MANUAL_ENTRY')",
        )
        .execute(&mut conn)
        .unwrap();
        diesel::sql_query(
            "INSERT INTO snapshot_positions (snapshot_id, asset_id, quantity, average_cost, \
             total_cost_basis, currency, inception_date, is_alternative, contract_multiplier, \
             created_at, last_updated) \
             VALUES ('snap-gbp', 'CTY', '51', '556.765', '28395.015', 'GBp', \
             '2026-05-20T00:00:00Z', 0, '1', '2026-05-20T00:00:00Z', \
             '2026-05-20T00:00:00Z')",
        )
        .execute(&mut conn)
        .unwrap();
        drop(conn);

        let rows = repo.get_asset_lot_view("CTY", true).await.unwrap();
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert_eq!(row.source, AssetLotSource::SnapshotPosition);
        assert_eq!(row.currency, "GBp");
        assert_eq!(row.valuation_currency, "GBP");
        assert_eq!(row.unit_cost, dec("556.765"));
        assert_eq!(row.cost_basis, dec("28395.015"));
        assert_eq!(row.valuation_unit_cost, dec("5.56765"));
        assert_eq!(row.valuation_cost_basis, dec("283.95015"));
    }

    #[tokio::test]
    async fn asset_lot_view_includes_closed_lots_and_lifecycle_fields() {
        let (repo, pool, _dir) = setup().await;
        insert_account(&pool, "acc1");
        insert_asset(&pool, "AAPL");
        let mut conn = get_connection(&pool).unwrap();
        diesel::sql_query("UPDATE assets SET instrument_type = 'OPTION' WHERE id = 'AAPL'")
            .execute(&mut conn)
            .unwrap();
        drop(conn);

        let mut open_lot = make_lot_record("open-lot", "acc1", "AAPL", "10");
        open_lot.split_ratio = "2".to_string();

        let mut closed_lot = make_lot_record("closed-lot", "acc1", "AAPL", "5");
        closed_lot.remaining_quantity = "0".to_string();
        closed_lot.remaining_cost_basis = "0".to_string();
        closed_lot.is_closed = true;
        closed_lot.close_date = Some("2024-03-01".to_string());

        repo.replace_lots_for_account("acc1", &[open_lot, closed_lot])
            .await
            .unwrap();

        let rows = repo.get_asset_lot_view("AAPL", false).await.unwrap();
        assert_eq!(rows.len(), 2);

        let open_row = rows.iter().find(|row| row.id == "open-lot").unwrap();
        assert_eq!(open_row.account_name, "Test");
        assert_eq!(open_row.original_quantity, Decimal::from(10));
        assert_eq!(open_row.remaining_quantity, Decimal::from(10));
        assert_eq!(open_row.split_ratio, Decimal::from(2));
        assert_eq!(open_row.contract_multiplier, Decimal::from(100));
        assert_eq!(open_row.quantity, Decimal::from(20));
        assert!(!open_row.is_closed);

        let closed_row = rows.iter().find(|row| row.id == "closed-lot").unwrap();
        assert!(closed_row.is_closed);
        assert_eq!(closed_row.remaining_quantity, Decimal::ZERO);
        assert_eq!(closed_row.quantity, Decimal::ZERO);
        assert_eq!(closed_row.close_date.as_deref(), Some("2024-03-01"));
    }

    #[tokio::test]
    async fn asset_lot_view_normalizes_closed_lot_disposal_display_fields() {
        let (repo, pool, _dir) = setup().await;
        insert_account(&pool, "acc1");
        insert_asset(&pool, "AAPL");
        insert_activity(&pool, "sell-1");

        let mut closed_lot = make_lot_record("closed-lot", "acc1", "AAPL", "51");
        closed_lot.currency = "GBp".to_string();
        closed_lot.base_currency = "GBP".to_string();
        closed_lot.fx_rate_to_base = "0.01".to_string();
        closed_lot.cost_per_unit = "556.765".to_string();
        closed_lot.original_cost_basis = "28395.015".to_string();
        closed_lot.original_cost_basis_base = "283.95015".to_string();
        closed_lot.remaining_quantity = "0".to_string();
        closed_lot.remaining_cost_basis = "0".to_string();
        closed_lot.remaining_cost_basis_base = "0".to_string();
        closed_lot.is_closed = true;
        closed_lot.close_date = Some("2024-03-01".to_string());

        repo.replace_lots_for_account("acc1", &[closed_lot])
            .await
            .unwrap();

        let mut disposal =
            make_lot_disposal("disp-1", "acc1", "closed-lot", "sell-1", "2024-03-01");
        disposal.asset_id = "AAPL".to_string();
        disposal.proceeds = "31000".to_string();
        disposal.cost_basis = "28395.015".to_string();
        disposal.realized_pnl = "2604.985".to_string();
        disposal.proceeds_base = "310".to_string();
        disposal.cost_basis_base = "283.95015".to_string();
        disposal.realized_pnl_base = "26.04985".to_string();
        disposal.currency = "GBp".to_string();
        disposal.base_currency = "GBP".to_string();
        disposal.fx_rate_to_base = "0.01".to_string();
        repo.sync_lot_disposals_for_account("acc1", &[], &[disposal], true)
            .await
            .unwrap();

        let rows = repo.get_asset_lot_view("AAPL", false).await.unwrap();
        let row = rows.iter().find(|row| row.id == "closed-lot").unwrap();
        assert_eq!(row.currency, "GBp");
        assert_eq!(row.valuation_currency, "GBP");
        assert_eq!(row.disposal_proceeds, Some(dec("31000")));
        assert_eq!(row.disposal_cost_basis, Some(dec("28395.015")));
        assert_eq!(row.realized_pnl, Some(dec("2604.985")));
        assert_eq!(row.valuation_disposal_cost_basis, Some(dec("283.95015")));
        assert_eq!(row.valuation_realized_pnl, Some(dec("26.04985")));
    }

    #[tokio::test]
    async fn asset_lot_view_falls_back_to_snapshot_positions_json() {
        let (repo, pool, _dir) = setup().await;
        insert_account_with_tracking_mode(&pool, "acc_holdings_json", "HOLDINGS");
        insert_asset(&pool, "AAPL");

        let now = chrono::Utc::now();
        let position = Position {
            id: "POS-AAPL-acc_holdings_json".to_string(),
            account_id: "acc_holdings_json".to_string(),
            asset_id: "AAPL".to_string(),
            quantity: Decimal::from(3),
            average_cost: Decimal::from(25),
            total_cost_basis: Decimal::from(75),
            currency: "USD".to_string(),
            inception_date: now,
            lots: Default::default(),
            created_at: now,
            last_updated: now,
            is_alternative: false,
            contract_multiplier: Decimal::ONE,
        };
        let positions_json =
            serde_json::to_string(&HashMap::from([("AAPL".to_string(), position)]))
                .unwrap()
                .replace('\'', "''");

        let mut conn = get_connection(&pool).unwrap();
        diesel::sql_query(format!(
            "INSERT INTO holdings_snapshots (id, account_id, snapshot_date, currency, positions, \
             cash_balances, cost_basis, net_contribution, calculated_at, net_contribution_base, \
             cash_total_account_currency, cash_total_base_currency, source) \
             VALUES ('snap-json', 'acc_holdings_json', '2026-05-20', 'USD', '{}', '{}', \
             '75', '0', '2026-05-20T00:00:00Z', '0', '0', '0', 'MANUAL_ENTRY')",
            positions_json, "{}"
        ))
        .execute(&mut conn)
        .unwrap();
        drop(conn);

        let rows = repo.get_asset_lot_view("AAPL", true).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].source, AssetLotSource::SnapshotPosition);
        assert_eq!(rows[0].account_id, "acc_holdings_json");
        assert_eq!(rows[0].quantity, Decimal::from(3));
        assert_eq!(rows[0].unit_cost, Decimal::from(25));
        assert_eq!(rows[0].cost_basis, Decimal::from(75));
    }
}
