//! Kernel projection persistence: one transaction per account across
//! snapshots, positions, lots, disposals, valuations and the watermark.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, NaiveDate, Utc};
use diesel::prelude::*;
use diesel::sqlite::SqliteConnection;
use wealthfolio_core::errors::Result;
use wealthfolio_core::portfolio::projection::{
    AccountProjection, ProjectionCheckpoint, ProjectionStoreTrait, ProjectionWatermark,
};
use wealthfolio_core::portfolio::snapshot::Position;

use crate::db::{get_connection, DbPool, WriteHandle};
use crate::errors::StorageError;
use crate::lots::{filter_and_normalize_lots, LotDisposalDB, LotRecordDB};
use crate::portfolio::snapshot::{AccountStateSnapshotDB, SnapshotRepository};
use crate::portfolio::valuation::DailyAccountValuationDB;
use crate::schema::{projection_checkpoints, projection_watermarks};

#[derive(Debug, Clone, Queryable, Insertable, AsChangeset)]
#[diesel(table_name = projection_watermarks)]
struct ProjectionWatermarkDB {
    account_id: String,
    engine: String,
    fingerprint: String,
    as_of: String,
    computed_at: String,
}

#[derive(Debug, Clone, Queryable, Insertable)]
#[diesel(table_name = projection_checkpoints)]
struct ProjectionCheckpointDB {
    account_id: String,
    checkpoint_date: String,
    state: String,
    transfer_cache: String,
}

impl From<&ProjectionCheckpoint> for ProjectionCheckpointDB {
    fn from(checkpoint: &ProjectionCheckpoint) -> Self {
        Self {
            account_id: checkpoint.account_id.clone(),
            checkpoint_date: checkpoint.date.to_string(),
            state: checkpoint.state.clone(),
            transfer_cache: checkpoint.transfer_cache.clone(),
        }
    }
}

impl TryFrom<ProjectionCheckpointDB> for ProjectionCheckpoint {
    type Error = StorageError;

    fn try_from(row: ProjectionCheckpointDB) -> std::result::Result<Self, StorageError> {
        let date = NaiveDate::parse_from_str(&row.checkpoint_date, "%Y-%m-%d")
            .map_err(|e| StorageError::SerializationError(format!("checkpoint_date: {e}")))?;
        Ok(Self {
            account_id: row.account_id,
            date,
            state: row.state,
            transfer_cache: row.transfer_cache,
        })
    }
}

impl From<&ProjectionWatermark> for ProjectionWatermarkDB {
    fn from(watermark: &ProjectionWatermark) -> Self {
        Self {
            account_id: watermark.account_id.clone(),
            engine: watermark.engine.clone(),
            fingerprint: watermark.fingerprint.clone(),
            as_of: watermark.as_of.to_string(),
            computed_at: watermark.computed_at.to_rfc3339(),
        }
    }
}

impl TryFrom<ProjectionWatermarkDB> for ProjectionWatermark {
    type Error = StorageError;

    fn try_from(row: ProjectionWatermarkDB) -> std::result::Result<Self, StorageError> {
        let as_of = NaiveDate::parse_from_str(&row.as_of, "%Y-%m-%d")
            .map_err(|e| StorageError::SerializationError(format!("as_of: {e}")))?;
        let computed_at = DateTime::parse_from_rfc3339(&row.computed_at)
            .map(|d| d.with_timezone(&Utc))
            .map_err(|e| StorageError::SerializationError(format!("computed_at: {e}")))?;
        Ok(Self {
            account_id: row.account_id,
            engine: row.engine,
            fingerprint: row.fingerprint,
            as_of,
            computed_at,
        })
    }
}

pub struct ProjectionStore {
    pool: Arc<DbPool>,
    writer: WriteHandle,
}

impl ProjectionStore {
    pub fn new(pool: Arc<DbPool>, writer: WriteHandle) -> Self {
        Self { pool, writer }
    }
}

const SOURCE_CALCULATED: &str = "CALCULATED";

/// Disposal rows must reference a stored lot and a stored activity
/// (`lot_disposals` foreign keys). A row that cannot is dropped with a
/// warning rather than rolling back the whole account.
fn referentially_valid_disposals(
    conn: &mut SqliteConnection,
    disposals: Vec<LotDisposalDB>,
    account: &str,
) -> Result<Vec<LotDisposalDB>> {
    use crate::schema::activities::dsl as a;
    use crate::schema::lots::dsl as l;
    let lot_ids: HashSet<String> = l::lots
        .filter(l::account_id.eq(account))
        .select(l::id)
        .load::<String>(conn)
        .map_err(StorageError::from)?
        .into_iter()
        .collect();
    let wanted: Vec<String> = disposals
        .iter()
        .map(|d| d.disposal_activity_id.clone())
        .collect();
    let activity_ids: HashSet<String> = a::activities
        .filter(a::id.eq_any(&wanted))
        .select(a::id)
        .load::<String>(conn)
        .map_err(StorageError::from)?
        .into_iter()
        .collect();
    Ok(disposals
        .into_iter()
        .filter(|d| {
            let valid =
                lot_ids.contains(&d.lot_id) && activity_ids.contains(&d.disposal_activity_id);
            if !valid {
                log::warn!(
                    "Dropping lot disposal {} for account {}: lot {} or activity {} is not stored",
                    d.id,
                    account,
                    d.lot_id,
                    d.disposal_activity_id
                );
            }
            valid
        })
        .collect())
}

#[async_trait]
impl ProjectionStoreTrait for ProjectionStore {
    fn get_watermarks(&self, account_ids: &[String]) -> Result<Vec<ProjectionWatermark>> {
        use crate::schema::projection_watermarks::dsl;
        if account_ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut conn = get_connection(&self.pool)?;
        let rows: Vec<ProjectionWatermarkDB> = dsl::projection_watermarks
            .filter(dsl::account_id.eq_any(account_ids))
            .load(&mut conn)
            .map_err(StorageError::from)?;
        rows.into_iter()
            .map(|row| ProjectionWatermark::try_from(row).map_err(Into::into))
            .collect()
    }

    fn get_checkpoints(&self, account_ids: &[String]) -> Result<Vec<ProjectionCheckpoint>> {
        use crate::schema::projection_checkpoints::dsl;
        let mut conn = get_connection(&self.pool)?;
        dsl::projection_checkpoints
            .filter(dsl::account_id.eq_any(account_ids))
            .load::<ProjectionCheckpointDB>(&mut conn)
            .map_err(StorageError::from)?
            .into_iter()
            .map(|row| ProjectionCheckpoint::try_from(row).map_err(Into::into))
            .collect()
    }

    async fn persist_account_projection(&self, projection: AccountProjection) -> Result<()> {
        let account = projection.account_id.clone();
        let since = projection.since.map(|d| d.to_string());
        let snapshot_positions: Option<Vec<(String, HashMap<String, Position>)>> =
            projection.snapshots.as_ref().map(|rows| {
                rows.iter()
                    .map(|s| (s.id.clone(), s.positions.clone()))
                    .collect()
            });
        let snapshots: Option<Vec<AccountStateSnapshotDB>> = projection
            .snapshots
            .map(|rows| rows.into_iter().map(AccountStateSnapshotDB::from).collect());
        let lots: Option<Vec<LotRecordDB>> = projection
            .lots
            .as_ref()
            .map(|rows| rows.iter().map(LotRecordDB::from).collect());
        let disposals: Option<Vec<LotDisposalDB>> = projection
            .disposals
            .as_ref()
            .map(|rows| rows.iter().map(LotDisposalDB::from).collect());
        let valuations: Vec<DailyAccountValuationDB> = projection
            .valuations
            .into_iter()
            .map(DailyAccountValuationDB::from)
            .collect();
        let checkpoints: Option<Vec<ProjectionCheckpointDB>> = projection
            .checkpoints
            .as_ref()
            .map(|rows| rows.iter().map(ProjectionCheckpointDB::from).collect());
        let watermark = ProjectionWatermarkDB::from(&projection.watermark);

        self.writer
            .exec(move |conn: &mut SqliteConnection| {
                if let Some(snapshots) = snapshots {
                    use crate::schema::holdings_snapshots::dsl as hs;
                    // Only calculated rows are the projection's; manual and
                    // imported snapshots are the user's (REG-0913). A resumed
                    // run keeps the rows before its start.
                    let target = hs::holdings_snapshots
                        .filter(hs::account_id.eq(&account))
                        .filter(hs::source.eq(SOURCE_CALCULATED));
                    match &since {
                        Some(since) => diesel::delete(target.filter(hs::snapshot_date.ge(since)))
                            .execute(conn)
                            .map_err(StorageError::from)?,
                        None => diesel::delete(target)
                            .execute(conn)
                            .map_err(StorageError::from)?,
                    };
                    if !snapshots.is_empty() {
                        diesel::replace_into(hs::holdings_snapshots)
                            .values(&snapshots)
                            .execute(conn)
                            .map_err(StorageError::from)?;
                    }
                    for (snapshot_id, positions) in snapshot_positions.iter().flatten() {
                        SnapshotRepository::write_snapshot_positions(conn, snapshot_id, positions)?;
                    }
                }
                if let Some(lots) = lots {
                    use crate::schema::lots::dsl as l;
                    // A resumed run re-emits every lot still open at its start
                    // and every closure inside it; lots closed before it stay.
                    let target = l::lots.filter(l::account_id.eq(&account));
                    match &since {
                        Some(since) => diesel::delete(
                            target.filter(l::is_closed.eq(0).or(l::close_date.ge(since.clone()))),
                        )
                        .execute(conn)
                        .map_err(StorageError::from)?,
                        None => diesel::delete(target)
                            .execute(conn)
                            .map_err(StorageError::from)?,
                    };
                    let normalized = filter_and_normalize_lots(conn, lots, &account)?;
                    if !normalized.is_empty() {
                        diesel::insert_into(l::lots)
                            .values(&normalized)
                            .execute(conn)
                            .map_err(StorageError::from)?;
                    }
                }
                if let Some(disposals) = disposals {
                    use crate::schema::lot_disposals::dsl as d;
                    let target = d::lot_disposals.filter(d::account_id.eq(&account));
                    match &since {
                        Some(since) => diesel::delete(target.filter(d::disposal_date.ge(since)))
                            .execute(conn)
                            .map_err(StorageError::from)?,
                        None => diesel::delete(target)
                            .execute(conn)
                            .map_err(StorageError::from)?,
                    };
                    let disposals = referentially_valid_disposals(conn, disposals, &account)?;
                    if !disposals.is_empty() {
                        diesel::insert_into(d::lot_disposals)
                            .values(&disposals)
                            .execute(conn)
                            .map_err(StorageError::from)?;
                    }
                }
                {
                    use crate::schema::daily_account_valuation::dsl as v;
                    let target = v::daily_account_valuation.filter(v::account_id.eq(&account));
                    match &since {
                        Some(since) => diesel::delete(target.filter(v::valuation_date.ge(since)))
                            .execute(conn)
                            .map_err(StorageError::from)?,
                        None => diesel::delete(target)
                            .execute(conn)
                            .map_err(StorageError::from)?,
                    };
                    for chunk in valuations.chunks(1000) {
                        diesel::replace_into(v::daily_account_valuation)
                            .values(chunk)
                            .execute(conn)
                            .map_err(StorageError::from)?;
                    }
                }
                if let Some(checkpoints) = checkpoints {
                    use crate::schema::projection_checkpoints::dsl as c;
                    let target = c::projection_checkpoints.filter(c::account_id.eq(&account));
                    match &since {
                        Some(since) => diesel::delete(target.filter(c::checkpoint_date.ge(since)))
                            .execute(conn)
                            .map_err(StorageError::from)?,
                        None => diesel::delete(target)
                            .execute(conn)
                            .map_err(StorageError::from)?,
                    };
                    if !checkpoints.is_empty() {
                        diesel::replace_into(c::projection_checkpoints)
                            .values(&checkpoints)
                            .execute(conn)
                            .map_err(StorageError::from)?;
                    }
                }
                diesel::replace_into(projection_watermarks::table)
                    .values(&watermark)
                    .execute(conn)
                    .map_err(StorageError::from)?;
                Ok(())
            })
            .await
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Arc;

    use chrono::{NaiveDate, Utc};
    use diesel::prelude::*;
    use rust_decimal::Decimal;
    use tempfile::tempdir;
    use wealthfolio_core::lots::{LotDisposal, LotRecord, LotRepositoryTrait};
    use wealthfolio_core::portfolio::economic_events::BasisStatus;
    use wealthfolio_core::portfolio::snapshot::{AccountStateSnapshot, Position, SnapshotSource};
    use wealthfolio_core::portfolio::valuation::{
        DailyAccountValuation, ExternalFlowSource, ValuationRepositoryTrait, ValuationStatus,
    };

    use super::*;
    use crate::db::{create_pool, get_connection, run_migrations, write_actor::spawn_writer};
    use crate::lots::LotsRepository;
    use crate::portfolio::valuation::ValuationRepository;
    use wealthfolio_core::portfolio::projection::ProjectionCheckpoint;

    struct Db {
        pool: Arc<DbPool>,
        writer: WriteHandle,
        _dir: tempfile::TempDir,
    }

    fn setup() -> Db {
        std::env::set_var("CONNECT_API_URL", "http://test.local");
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db").to_string_lossy().to_string();
        run_migrations(&db_path).unwrap();
        let pool = create_pool(&db_path).unwrap();
        let writer = spawn_writer((*pool).clone()).unwrap();
        let mut conn = get_connection(&pool).unwrap();
        diesel::sql_query(
            "INSERT INTO accounts (id, name, account_type, currency, is_default, is_active, \
             created_at, updated_at, tracking_mode, is_archived) \
             VALUES ('acc1', 'Test', 'SECURITIES', 'USD', 0, 1, datetime('now'), datetime('now'), 'TRANSACTIONS', 0)",
        )
        .execute(&mut conn)
        .unwrap();
        diesel::sql_query(
            "INSERT INTO assets (id, kind, is_active, quote_mode, quote_ccy, created_at, updated_at) \
             VALUES ('AAPL', 'INVESTMENT', 1, 'MARKET', 'USD', datetime('now'), datetime('now'))",
        )
        .execute(&mut conn)
        .unwrap();
        // Disposals reference the disposing activity row.
        diesel::sql_query(
            "INSERT INTO activities (id, account_id, activity_type, status, activity_date, currency, \
             is_user_modified, needs_review, created_at, updated_at) \
             VALUES ('sell-1', 'acc1', 'SELL', 'POSTED', '2025-01-05T00:00:00Z', 'USD', 0, 0, \
             datetime('now'), datetime('now'))",
        )
        .execute(&mut conn)
        .unwrap();
        Db {
            pool,
            writer,
            _dir: dir,
        }
    }

    fn date(day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(2025, 1, day).unwrap()
    }

    fn snapshot(day: u32, quantity: &str) -> AccountStateSnapshot {
        let mut positions = HashMap::new();
        positions.insert(
            "AAPL".to_string(),
            Position {
                id: "acc1-AAPL".to_string(),
                account_id: "acc1".to_string(),
                asset_id: "AAPL".to_string(),
                quantity: quantity.parse().unwrap(),
                average_cost: Decimal::from(100),
                total_cost_basis: Decimal::from(100) * quantity.parse::<Decimal>().unwrap(),
                currency: "USD".to_string(),
                ..Position::default()
            },
        );
        AccountStateSnapshot {
            id: AccountStateSnapshot::stable_id("acc1", date(day)),
            account_id: "acc1".to_string(),
            snapshot_date: date(day),
            currency: "USD".to_string(),
            positions,
            cash_balances: HashMap::from([("USD".to_string(), Decimal::from(500))]),
            cost_basis: Decimal::from(1000),
            net_contribution: Decimal::from(1500),
            net_contribution_base: Decimal::from(1500),
            cash_total_account_currency: Decimal::from(500),
            cash_total_base_currency: Decimal::from(500),
            calculated_at: Utc::now().naive_utc(),
            source: SnapshotSource::Calculated,
        }
    }

    fn lot(id: &str) -> LotRecord {
        LotRecord {
            id: id.to_string(),
            account_id: "acc1".to_string(),
            asset_id: "AAPL".to_string(),
            open_date: "2025-01-02".to_string(),
            open_activity_id: None,
            original_quantity: "10".to_string(),
            remaining_quantity: "10".to_string(),
            cost_per_unit: "100".to_string(),
            original_cost_basis: "1000".to_string(),
            remaining_cost_basis: "1000".to_string(),
            original_cost_basis_base: "1000".to_string(),
            remaining_cost_basis_base: "1000".to_string(),
            fee_allocated: "0".to_string(),
            fee_allocated_base: "0".to_string(),
            tax_allocated: "0".to_string(),
            tax_allocated_base: "0".to_string(),
            currency: "USD".to_string(),
            base_currency: "USD".to_string(),
            fx_rate_to_base: "1".to_string(),
            fx_rate_to_account: None,
            account_currency: None,
            cost_basis_method: "FIFO".to_string(),
            split_ratio: "1".to_string(),
            is_closed: false,
            close_date: None,
            close_activity_id: None,
            created_at: "2025-01-02T00:00:00.000Z".to_string(),
            updated_at: "2025-01-02T00:00:00.000Z".to_string(),
        }
    }

    fn disposal(id: &str) -> LotDisposal {
        LotDisposal {
            id: id.to_string(),
            lot_id: "lot-1".to_string(),
            account_id: "acc1".to_string(),
            asset_id: "AAPL".to_string(),
            disposal_activity_id: "sell-1".to_string(),
            disposal_date: "2025-01-05".to_string(),
            quantity: "4".to_string(),
            proceeds: "480".to_string(),
            cost_basis: "400".to_string(),
            realized_pnl: "80".to_string(),
            proceeds_base: "480".to_string(),
            cost_basis_base: "400".to_string(),
            realized_pnl_base: "80".to_string(),
            currency: "USD".to_string(),
            base_currency: "USD".to_string(),
            fx_rate_to_base: "1".to_string(),
            cost_basis_method: "FIFO".to_string(),
            created_at: "2025-01-05T00:00:00.000Z".to_string(),
        }
    }

    fn valuation(day: u32, total: i64) -> DailyAccountValuation {
        DailyAccountValuation {
            id: format!("acc1_{}", date(day)),
            account_id: "acc1".to_string(),
            valuation_date: date(day),
            account_currency: "USD".to_string(),
            base_currency: "USD".to_string(),
            fx_rate_to_base: Decimal::ONE,
            cash_balance: Decimal::from(500),
            investment_market_value: Decimal::from(total - 500),
            total_value: Decimal::from(total),
            cost_basis: Decimal::from(1000),
            book_basis: Decimal::from(1500),
            net_contribution: Decimal::from(1500),
            cash_balance_base: Decimal::from(500),
            investment_market_value_base: Decimal::from(total - 500),
            total_value_base: Decimal::from(total),
            cost_basis_base: Decimal::from(1000),
            book_basis_base: Decimal::from(1500),
            net_contribution_base: Decimal::from(1500),
            external_inflow_base: Decimal::ZERO,
            external_outflow_base: Decimal::ZERO,
            external_flow_source: ExternalFlowSource::NoFlow,
            performance_eligible_value_base: Decimal::from(total),
            value_status: ValuationStatus::Complete,
            basis_status: BasisStatus::Complete,
            calculated_at: Utc::now(),
        }
    }

    fn watermark(fingerprint: &str) -> ProjectionWatermark {
        ProjectionWatermark {
            account_id: "acc1".to_string(),
            engine: "kernel".to_string(),
            fingerprint: fingerprint.to_string(),
            as_of: date(10),
            computed_at: Utc::now(),
        }
    }

    fn projection(days: &[u32], lots: Vec<LotRecord>, fingerprint: &str) -> AccountProjection {
        AccountProjection {
            account_id: "acc1".to_string(),
            snapshots: Some(days.iter().map(|d| snapshot(*d, "10")).collect()),
            lots: Some(lots),
            disposals: Some(vec![disposal("d-1")]),
            valuations: days
                .iter()
                .map(|d| valuation(*d, 1500 + *d as i64))
                .collect(),
            watermark: watermark(fingerprint),
            since: None,
            checkpoints: None,
        }
    }

    #[tokio::test]
    async fn projection_round_trips_and_replaces_atomically() {
        let db = setup();
        let store = ProjectionStore::new(db.pool.clone(), db.writer.clone());
        let snapshots =
            crate::portfolio::snapshot::SnapshotRepository::new(db.pool.clone(), db.writer.clone());
        let lots = LotsRepository::new(db.pool.clone(), db.writer.clone());
        let valuations = ValuationRepository::new(db.pool.clone(), db.writer.clone());

        store
            .persist_account_projection(projection(
                &[2, 3, 4],
                vec![lot("lot-1"), lot("lot-2")],
                "fp-1",
            ))
            .await
            .unwrap();

        let stored_snapshots = snapshots
            .get_snapshots_by_account("acc1", None, None)
            .unwrap();
        assert_eq!(stored_snapshots.len(), 3);
        assert_eq!(
            stored_snapshots[0].positions["AAPL"].quantity,
            Decimal::from(10)
        );
        assert_eq!(stored_snapshots[0].cash_balances["USD"], Decimal::from(500));
        let stored_lots = lots.get_all_lots_for_account("acc1").await.unwrap();
        assert_eq!(stored_lots.len(), 2);
        let stored_disposals = lots.get_lot_disposals_for_account("acc1").await.unwrap();
        assert_eq!(stored_disposals.len(), 1);
        assert_eq!(stored_disposals[0].realized_pnl_base, "80");
        let stored_valuations = valuations
            .get_historical_valuations("acc1", None, None)
            .unwrap();
        assert_eq!(stored_valuations.len(), 3);
        assert_eq!(stored_valuations[2].total_value_base, Decimal::from(1504));
        let marks = store.get_watermarks(&["acc1".to_string()]).unwrap();
        assert_eq!(marks.len(), 1);
        assert_eq!(marks[0].fingerprint, "fp-1");
        assert_eq!(marks[0].as_of, date(10));

        // A second projection replaces every section and upserts the watermark.
        store
            .persist_account_projection(projection(&[2, 3], vec![lot("lot-1")], "fp-2"))
            .await
            .unwrap();
        assert_eq!(
            snapshots
                .get_snapshots_by_account("acc1", None, None)
                .unwrap()
                .len(),
            2
        );
        let stored_lots = lots.get_all_lots_for_account("acc1").await.unwrap();
        assert_eq!(stored_lots.len(), 1);
        assert_eq!(stored_lots[0].id, "lot-1");
        assert_eq!(
            valuations
                .get_historical_valuations("acc1", None, None)
                .unwrap()
                .len(),
            2
        );
        let marks = store.get_watermarks(&["acc1".to_string()]).unwrap();
        assert_eq!(marks.len(), 1);
        assert_eq!(marks[0].fingerprint, "fp-2");

        // Holdings-mode shape: snapshots and lots untouched, valuations replaced.
        store
            .persist_account_projection(AccountProjection {
                account_id: "acc1".to_string(),
                snapshots: None,
                lots: None,
                disposals: None,
                valuations: vec![valuation(7, 1700)],
                watermark: watermark("fp-3"),
                since: None,
                checkpoints: None,
            })
            .await
            .unwrap();
        assert_eq!(
            snapshots
                .get_snapshots_by_account("acc1", None, None)
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            lots.get_all_lots_for_account("acc1").await.unwrap().len(),
            1
        );
        let stored_valuations = valuations
            .get_historical_valuations("acc1", None, None)
            .unwrap();
        assert_eq!(stored_valuations.len(), 1);
        assert_eq!(stored_valuations[0].valuation_date, date(7));
    }

    #[tokio::test]
    async fn manual_snapshots_survive_a_projection_rewrite() {
        let db = setup();
        let store = ProjectionStore::new(db.pool.clone(), db.writer.clone());
        let snapshots = SnapshotRepository::new(db.pool.clone(), db.writer.clone());
        let mut manual = snapshot(3, "10");
        manual.id = "acc1_2025-01-03".to_string();
        manual.source = SnapshotSource::ManualEntry;
        snapshots.save_snapshots(&[manual]).await.unwrap();

        store
            .persist_account_projection(projection(&[2, 4], vec![lot("lot-1")], "fp-1"))
            .await
            .unwrap();
        store
            .persist_account_projection(projection(&[2, 5], vec![lot("lot-1")], "fp-2"))
            .await
            .unwrap();

        let stored = snapshots
            .get_snapshots_by_account("acc1", None, None)
            .unwrap();
        let manual_rows: Vec<_> = stored
            .iter()
            .filter(|s| s.source == SnapshotSource::ManualEntry)
            .collect();
        assert_eq!(
            manual_rows.len(),
            1,
            "manual snapshot survives every rewrite"
        );
        assert_eq!(manual_rows[0].snapshot_date, date(3));
        let calculated: Vec<NaiveDate> = stored
            .iter()
            .filter(|s| s.source == SnapshotSource::Calculated)
            .map(|s| s.snapshot_date)
            .collect();
        assert_eq!(calculated, vec![date(2), date(5)]);
    }

    #[tokio::test]
    async fn disposals_without_a_stored_activity_are_dropped_not_fatal() {
        let db = setup();
        let store = ProjectionStore::new(db.pool.clone(), db.writer.clone());
        let lots_repo = LotsRepository::new(db.pool.clone(), db.writer.clone());
        let mut orphan = disposal("disp-orphan");
        orphan.disposal_activity_id = "drip-1:buy".to_string();
        let mut projection = projection(&[2, 5], vec![lot("lot-1")], "fp-1");
        projection.disposals = Some(vec![disposal("disp-1"), orphan]);
        store.persist_account_projection(projection).await.unwrap();

        let stored = lots_repo
            .get_lot_disposals_for_account("acc1")
            .await
            .unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].id, "disp-1");
        assert_eq!(
            store.get_watermarks(&["acc1".to_string()]).unwrap().len(),
            1
        );
    }

    #[tokio::test]
    async fn a_resumed_projection_keeps_the_rows_before_its_start() {
        let db = setup();
        let store = ProjectionStore::new(db.pool.clone(), db.writer.clone());
        let snapshots = SnapshotRepository::new(db.pool.clone(), db.writer.clone());
        let lots = LotsRepository::new(db.pool.clone(), db.writer.clone());
        let valuations = ValuationRepository::new(db.pool.clone(), db.writer.clone());
        let checkpoint = |day: u32| ProjectionCheckpoint {
            account_id: "acc1".to_string(),
            date: date(day),
            state: format!("{{\"day\":{day}}}"),
            transfer_cache: "{}".to_string(),
        };

        // Full run: days 2..5, one lot closed on day 3 and one still open.
        let mut closed = lot("lot-closed");
        closed.is_closed = true;
        closed.close_date = Some("2025-01-03".to_string());
        closed.remaining_quantity = "0".to_string();
        let mut full = projection(&[2, 3, 4, 5], vec![closed.clone(), lot("lot-open")], "fp-1");
        let mut early = disposal("d-early");
        early.lot_id = "lot-closed".to_string();
        early.disposal_date = "2025-01-03".to_string();
        full.disposals = Some(vec![early]);
        full.checkpoints = Some(vec![checkpoint(3), checkpoint(5)]);
        store.persist_account_projection(full).await.unwrap();

        // Resume from day 4: rows dated 4+ are replaced, earlier rows stay.
        let mut resumed = projection(&[4, 5, 6], vec![lot("lot-open")], "fp-2");
        let mut late = disposal("d-late");
        late.lot_id = "lot-open".to_string();
        late.disposal_date = "2025-01-05".to_string();
        resumed.disposals = Some(vec![late]);
        resumed.since = Some(date(4));
        resumed.checkpoints = Some(vec![checkpoint(6)]);
        store.persist_account_projection(resumed).await.unwrap();

        let stored_snapshots = snapshots
            .get_snapshots_by_account("acc1", None, None)
            .unwrap();
        let snapshot_days: Vec<NaiveDate> =
            stored_snapshots.iter().map(|s| s.snapshot_date).collect();
        assert_eq!(
            snapshot_days,
            vec![date(2), date(3), date(4), date(5), date(6)]
        );
        let stored_lots = lots.get_all_lots_for_account("acc1").await.unwrap();
        let mut lot_ids: Vec<&str> = stored_lots.iter().map(|l| l.id.as_str()).collect();
        lot_ids.sort();
        assert_eq!(
            lot_ids,
            vec!["lot-closed", "lot-open"],
            "closed-before-start lot kept"
        );
        let stored_disposals = lots.get_lot_disposals_for_account("acc1").await.unwrap();
        let mut disposal_ids: Vec<&str> = stored_disposals.iter().map(|d| d.id.as_str()).collect();
        disposal_ids.sort();
        assert_eq!(
            disposal_ids,
            vec!["d-early", "d-late"],
            "the disposal before the start stays, the later one is replaced"
        );
        let stored_valuations = valuations
            .get_historical_valuations("acc1", None, None)
            .unwrap();
        let valuation_days: Vec<NaiveDate> =
            stored_valuations.iter().map(|v| v.valuation_date).collect();
        assert_eq!(
            valuation_days,
            vec![date(2), date(3), date(4), date(5), date(6)]
        );
        let mut checkpoint_days: Vec<NaiveDate> = store
            .get_checkpoints(&["acc1".to_string()])
            .unwrap()
            .iter()
            .map(|c| c.date)
            .collect();
        checkpoint_days.sort();
        assert_eq!(checkpoint_days, vec![date(3), date(6)]);
        assert_eq!(
            store.get_watermarks(&["acc1".to_string()]).unwrap()[0].fingerprint,
            "fp-2"
        );
    }
}
