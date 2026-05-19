//! Repository implementations for private-assets storage.

use async_trait::async_trait;
use chrono::Utc;
use diesel::prelude::*;
use std::sync::Arc;
use uuid::Uuid;

use wealthfolio_core::errors::Result;
use wealthfolio_core::private_assets::{
    FundManager, FundManagerRepositoryTrait, NewFundManager, NewPrivateAsset, NewPrivateSnapshot,
    NewPrivateSubAsset, PrivateAsset, PrivateAssetRepositoryTrait, PrivateAssetStatus,
    PrivateAssetStrategyType, PrivateAssetVehicleKind, PrivateSnapshot,
    PrivateSnapshotRepositoryTrait, PrivateSubAsset, PrivateSubAssetReportingBasis,
    PrivateSubAssetRepositoryTrait, UpdateFundManager, UpdatePrivateAsset, UpdatePrivateSnapshot,
    UpdatePrivateSubAsset,
};

use crate::db::{get_connection, DbPool, WriteHandle};
use crate::errors::StorageError;
use crate::schema::{fund_managers, private_assets, private_snapshots, private_sub_assets};

use super::model::{
    FundManagerDB, NewFundManagerDB, NewPrivateAssetDB, NewPrivateSnapshotDB, NewPrivateSubAssetDB,
    PrivateAssetDB, PrivateSnapshotDB, PrivateSubAssetDB,
};

pub struct FundManagerRepository {
    pool: Arc<DbPool>,
    writer: WriteHandle,
}

impl FundManagerRepository {
    pub fn new(pool: Arc<DbPool>, writer: WriteHandle) -> Self {
        Self { pool, writer }
    }
}

pub struct PrivateAssetRepository {
    pool: Arc<DbPool>,
    writer: WriteHandle,
}

impl PrivateAssetRepository {
    pub fn new(pool: Arc<DbPool>, writer: WriteHandle) -> Self {
        Self { pool, writer }
    }
}

pub struct PrivateSubAssetRepository {
    pool: Arc<DbPool>,
    writer: WriteHandle,
}

impl PrivateSubAssetRepository {
    pub fn new(pool: Arc<DbPool>, writer: WriteHandle) -> Self {
        Self { pool, writer }
    }
}

pub struct PrivateSnapshotRepository {
    pool: Arc<DbPool>,
    writer: WriteHandle,
}

impl PrivateSnapshotRepository {
    pub fn new(pool: Arc<DbPool>, writer: WriteHandle) -> Self {
        Self { pool, writer }
    }
}

fn to_status_text(value: PrivateAssetStatus) -> String {
    match value {
        PrivateAssetStatus::Active => "ACTIVE".to_string(),
        PrivateAssetStatus::Realized => "REALIZED".to_string(),
        PrivateAssetStatus::Archived => "ARCHIVED".to_string(),
    }
}

fn to_vehicle_kind_text(value: PrivateAssetVehicleKind) -> String {
    match value {
        PrivateAssetVehicleKind::Fund => "FUND".to_string(),
        PrivateAssetVehicleKind::CoInvestment => "CO_INVESTMENT".to_string(),
        PrivateAssetVehicleKind::Direct => "DIRECT".to_string(),
        PrivateAssetVehicleKind::RealEstate => "REAL_ESTATE".to_string(),
        PrivateAssetVehicleKind::Other => "OTHER".to_string(),
    }
}

fn to_strategy_type_text(value: PrivateAssetStrategyType) -> String {
    match value {
        PrivateAssetStrategyType::Venture => "VENTURE".to_string(),
        PrivateAssetStrategyType::PrivateEquity => "PRIVATE_EQUITY".to_string(),
        PrivateAssetStrategyType::HedgeFund => "HEDGE_FUND".to_string(),
        PrivateAssetStrategyType::PrivateCredit => "PRIVATE_CREDIT".to_string(),
        PrivateAssetStrategyType::FundOfFunds => "FUND_OF_FUNDS".to_string(),
        PrivateAssetStrategyType::Energy => "ENERGY".to_string(),
        PrivateAssetStrategyType::RealEstate => "REAL_ESTATE".to_string(),
        PrivateAssetStrategyType::Other => "OTHER".to_string(),
    }
}

fn to_reporting_basis_text(value: PrivateSubAssetReportingBasis) -> String {
    match value {
        PrivateSubAssetReportingBasis::Unknown => "UNKNOWN".to_string(),
        PrivateSubAssetReportingBasis::Gross => "GROSS".to_string(),
        PrivateSubAssetReportingBasis::Net => "NET".to_string(),
    }
}

#[async_trait]
impl FundManagerRepositoryTrait for FundManagerRepository {
    fn get_by_id(&self, id: &str) -> Result<Option<FundManager>> {
        let mut conn = get_connection(&self.pool)?;
        let row = fund_managers::table
            .find(id)
            .select(FundManagerDB::as_select())
            .first::<FundManagerDB>(&mut conn)
            .optional()
            .map_err(StorageError::from)?;
        row.map(TryInto::try_into).transpose()
    }

    fn list(&self) -> Result<Vec<FundManager>> {
        let mut conn = get_connection(&self.pool)?;
        let rows = fund_managers::table
            .order(fund_managers::name.asc())
            .select(FundManagerDB::as_select())
            .load::<FundManagerDB>(&mut conn)
            .map_err(StorageError::from)?;
        rows.into_iter().map(TryInto::try_into).collect()
    }

    async fn create(&self, fund_manager: NewFundManager) -> Result<FundManager> {
        self.writer
            .exec(move |conn| {
                let mut row: NewFundManagerDB = fund_manager.into();
                row.id = Some(row.id.unwrap_or_else(|| Uuid::new_v4().to_string()));

                let inserted = diesel::insert_into(fund_managers::table)
                    .values(&row)
                    .returning(FundManagerDB::as_returning())
                    .get_result(conn)
                    .map_err(StorageError::from)?;

                Ok(FundManager::try_from(inserted).map_err(StorageError::from)?)
            })
            .await
    }

    async fn update(&self, id: &str, fund_manager: UpdateFundManager) -> Result<FundManager> {
        let id = id.to_string();
        self.writer
            .exec(move |conn| {
                let existing = fund_managers::table
                    .find(&id)
                    .select(FundManagerDB::as_select())
                    .first::<FundManagerDB>(conn)
                    .map_err(StorageError::from)?;

                let updated = FundManagerDB {
                    id: existing.id,
                    name: fund_manager.name.unwrap_or(existing.name),
                    notes: fund_manager.notes.unwrap_or(existing.notes),
                    created_at: existing.created_at,
                    updated_at: Utc::now().to_rfc3339(),
                };

                diesel::update(fund_managers::table.find(&id))
                    .set(&updated)
                    .execute(conn)
                    .map_err(StorageError::from)?;

                Ok(FundManager::try_from(updated).map_err(StorageError::from)?)
            })
            .await
    }
}

#[async_trait]
impl PrivateAssetRepositoryTrait for PrivateAssetRepository {
    fn get_by_id(&self, id: &str) -> Result<Option<PrivateAsset>> {
        let mut conn = get_connection(&self.pool)?;
        let row = private_assets::table
            .find(id)
            .select(PrivateAssetDB::as_select())
            .first::<PrivateAssetDB>(&mut conn)
            .optional()
            .map_err(StorageError::from)?;
        row.map(TryInto::try_into).transpose()
    }

    fn list(&self) -> Result<Vec<PrivateAsset>> {
        let mut conn = get_connection(&self.pool)?;
        let rows = private_assets::table
            .order(private_assets::name.asc())
            .select(PrivateAssetDB::as_select())
            .load::<PrivateAssetDB>(&mut conn)
            .map_err(StorageError::from)?;
        rows.into_iter().map(TryInto::try_into).collect()
    }

    async fn create(&self, asset: NewPrivateAsset) -> Result<PrivateAsset> {
        self.writer
            .exec(move |conn| {
                let mut row: NewPrivateAssetDB = asset.into();
                row.id = Some(row.id.unwrap_or_else(|| Uuid::new_v4().to_string()));

                let inserted = diesel::insert_into(private_assets::table)
                    .values(&row)
                    .returning(PrivateAssetDB::as_returning())
                    .get_result(conn)
                    .map_err(StorageError::from)?;

                Ok(PrivateAsset::try_from(inserted).map_err(StorageError::from)?)
            })
            .await
    }

    async fn update(&self, id: &str, asset: UpdatePrivateAsset) -> Result<PrivateAsset> {
        let id = id.to_string();
        self.writer
            .exec(move |conn| {
                let existing = private_assets::table
                    .find(&id)
                    .select(PrivateAssetDB::as_select())
                    .first::<PrivateAssetDB>(conn)
                    .map_err(StorageError::from)?;

                let updated = PrivateAssetDB {
                    id: existing.id,
                    name: asset.name.unwrap_or(existing.name),
                    fund_manager_id: asset.fund_manager_id.unwrap_or(existing.fund_manager_id),
                    vehicle_kind: asset
                        .vehicle_kind
                        .map(to_vehicle_kind_text)
                        .unwrap_or(existing.vehicle_kind),
                    strategy_type: asset
                        .strategy_type
                        .map(to_strategy_type_text)
                        .unwrap_or(existing.strategy_type),
                    currency: asset.currency.unwrap_or(existing.currency),
                    status: asset.status.map(to_status_text).unwrap_or(existing.status),
                    commitment_amount: asset
                        .commitment_amount
                        .map(|value| value.map(|amount| amount.to_string()))
                        .unwrap_or(existing.commitment_amount),
                    notes: asset.notes.unwrap_or(existing.notes),
                    created_at: existing.created_at,
                    updated_at: Utc::now().to_rfc3339(),
                };

                diesel::update(private_assets::table.find(&id))
                    .set(&updated)
                    .execute(conn)
                    .map_err(StorageError::from)?;

                Ok(PrivateAsset::try_from(updated).map_err(StorageError::from)?)
            })
            .await
    }
}

#[async_trait]
impl PrivateSubAssetRepositoryTrait for PrivateSubAssetRepository {
    fn list_by_private_asset_id(&self, private_asset_id: &str) -> Result<Vec<PrivateSubAsset>> {
        let mut conn = get_connection(&self.pool)?;
        let rows = private_sub_assets::table
            .filter(private_sub_assets::private_asset_id.eq(private_asset_id))
            .order(private_sub_assets::name.asc())
            .select(PrivateSubAssetDB::as_select())
            .load::<PrivateSubAssetDB>(&mut conn)
            .map_err(StorageError::from)?;
        rows.into_iter().map(TryInto::try_into).collect()
    }

    async fn create(&self, sub_asset: NewPrivateSubAsset) -> Result<PrivateSubAsset> {
        self.writer
            .exec(move |conn| {
                let mut row: NewPrivateSubAssetDB = sub_asset.into();
                row.id = Some(row.id.unwrap_or_else(|| Uuid::new_v4().to_string()));

                let inserted = diesel::insert_into(private_sub_assets::table)
                    .values(&row)
                    .returning(PrivateSubAssetDB::as_returning())
                    .get_result(conn)
                    .map_err(StorageError::from)?;

                Ok(PrivateSubAsset::try_from(inserted).map_err(StorageError::from)?)
            })
            .await
    }

    async fn update(&self, id: &str, sub_asset: UpdatePrivateSubAsset) -> Result<PrivateSubAsset> {
        let id = id.to_string();
        self.writer
            .exec(move |conn| {
                let existing = private_sub_assets::table
                    .find(&id)
                    .select(PrivateSubAssetDB::as_select())
                    .first::<PrivateSubAssetDB>(conn)
                    .map_err(StorageError::from)?;

                let updated = PrivateSubAssetDB {
                    id: existing.id,
                    private_asset_id: existing.private_asset_id,
                    name: sub_asset.name.unwrap_or(existing.name),
                    reporting_basis: sub_asset
                        .reporting_basis
                        .map(to_reporting_basis_text)
                        .unwrap_or(existing.reporting_basis),
                    strategy_type: sub_asset
                        .strategy_type
                        .map(|value| value.map(to_strategy_type_text))
                        .unwrap_or(existing.strategy_type),
                    cost_basis: sub_asset
                        .cost_basis
                        .map(|value| value.map(|amount| amount.to_string()))
                        .unwrap_or(existing.cost_basis),
                    current_value: sub_asset
                        .current_value
                        .map(|value| value.map(|amount| amount.to_string()))
                        .unwrap_or(existing.current_value),
                    ownership_percent: sub_asset
                        .ownership_percent
                        .map(|value| value.map(|amount| amount.to_string()))
                        .unwrap_or(existing.ownership_percent),
                    notes: sub_asset.notes.unwrap_or(existing.notes),
                    created_at: existing.created_at,
                    updated_at: Utc::now().to_rfc3339(),
                };

                diesel::update(private_sub_assets::table.find(&id))
                    .set(&updated)
                    .execute(conn)
                    .map_err(StorageError::from)?;

                Ok(PrivateSubAsset::try_from(updated).map_err(StorageError::from)?)
            })
            .await
    }
}

#[async_trait]
impl PrivateSnapshotRepositoryTrait for PrivateSnapshotRepository {
    fn list_by_private_asset_id(&self, private_asset_id: &str) -> Result<Vec<PrivateSnapshot>> {
        let mut conn = get_connection(&self.pool)?;
        let rows = private_snapshots::table
            .filter(private_snapshots::private_asset_id.eq(private_asset_id))
            .order((
                private_snapshots::as_of_date.asc(),
                private_snapshots::created_at.asc(),
            ))
            .select(PrivateSnapshotDB::as_select())
            .load::<PrivateSnapshotDB>(&mut conn)
            .map_err(StorageError::from)?;
        rows.into_iter().map(TryInto::try_into).collect()
    }

    fn get_latest_by_private_asset_id(
        &self,
        private_asset_id: &str,
    ) -> Result<Option<PrivateSnapshot>> {
        let mut conn = get_connection(&self.pool)?;
        let row = private_snapshots::table
            .filter(private_snapshots::private_asset_id.eq(private_asset_id))
            .order((
                private_snapshots::as_of_date.desc(),
                private_snapshots::created_at.desc(),
            ))
            .select(PrivateSnapshotDB::as_select())
            .first::<PrivateSnapshotDB>(&mut conn)
            .optional()
            .map_err(StorageError::from)?;
        row.map(TryInto::try_into).transpose()
    }

    async fn create(&self, snapshot: NewPrivateSnapshot) -> Result<PrivateSnapshot> {
        self.writer
            .exec(move |conn| {
                let mut row: NewPrivateSnapshotDB = snapshot.into();
                row.id = Some(row.id.unwrap_or_else(|| Uuid::new_v4().to_string()));

                let inserted = diesel::insert_into(private_snapshots::table)
                    .values(&row)
                    .returning(PrivateSnapshotDB::as_returning())
                    .get_result(conn)
                    .map_err(StorageError::from)?;

                Ok(PrivateSnapshot::try_from(inserted).map_err(StorageError::from)?)
            })
            .await
    }

    async fn update(&self, id: &str, snapshot: UpdatePrivateSnapshot) -> Result<PrivateSnapshot> {
        let id = id.to_string();
        self.writer
            .exec(move |conn| {
                let existing = private_snapshots::table
                    .find(&id)
                    .select(PrivateSnapshotDB::as_select())
                    .first::<PrivateSnapshotDB>(conn)
                    .map_err(StorageError::from)?;

                let mut updated: PrivateSnapshotDB = snapshot.into();
                updated.id = existing.id;
                updated.private_asset_id = existing.private_asset_id;
                updated.created_at = existing.created_at;

                diesel::update(private_snapshots::table.find(&id))
                    .set(&updated)
                    .execute(conn)
                    .map_err(StorageError::from)?;

                Ok(PrivateSnapshot::try_from(updated).map_err(StorageError::from)?)
            })
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{create_pool, get_connection, init, run_migrations, write_actor::spawn_writer};
    use chrono::NaiveDate;
    use diesel::sql_query;
    use rust_decimal::Decimal;
    use tempfile::{tempdir, TempDir};
    use wealthfolio_core::errors::{DatabaseError, Error};
    use wealthfolio_core::private_assets::{
        PrivateSnapshotCashFlowType, PrivateSnapshotValueSourceType,
    };

    struct TestStore {
        #[allow(dead_code)]
        temp_dir: TempDir,
        pool: Arc<DbPool>,
        fund_manager_repository: FundManagerRepository,
        private_asset_repository: PrivateAssetRepository,
        private_snapshot_repository: PrivateSnapshotRepository,
    }

    fn setup_test_store() -> TestStore {
        let temp_dir = tempdir().expect("tempdir");
        let app_data = temp_dir.path().to_str().expect("app data path");
        let db_path = init(app_data).expect("init db");
        run_migrations(&db_path).expect("run migrations");
        let pool = create_pool(&db_path).expect("create pool");
        let writer = spawn_writer((*pool).clone()).expect("spawn writer");

        TestStore {
            temp_dir,
            pool: pool.clone(),
            fund_manager_repository: FundManagerRepository::new(pool.clone(), writer.clone()),
            private_asset_repository: PrivateAssetRepository::new(pool.clone(), writer.clone()),
            private_snapshot_repository: PrivateSnapshotRepository::new(pool, writer),
        }
    }

    async fn create_fund_manager(store: &TestStore, id: &str) -> FundManager {
        store
            .fund_manager_repository
            .create(NewFundManager {
                id: Some(id.to_string()),
                name: format!("Manager {}", id),
                notes: None,
            })
            .await
            .expect("create fund manager")
    }

    async fn create_private_asset(
        store: &TestStore,
        id: &str,
        fund_manager_id: &str,
    ) -> PrivateAsset {
        store
            .private_asset_repository
            .create(NewPrivateAsset {
                id: Some(id.to_string()),
                name: format!("Asset {}", id),
                fund_manager_id: Some(fund_manager_id.to_string()),
                vehicle_kind: PrivateAssetVehicleKind::Fund,
                strategy_type: PrivateAssetStrategyType::PrivateEquity,
                currency: "USD".to_string(),
                status: PrivateAssetStatus::Active,
                commitment_amount: Some(Decimal::new(1000, 0)),
                notes: None,
            })
            .await
            .expect("create private asset")
    }

    #[tokio::test]
    async fn repository_rejects_direct_asset_with_manager_at_db_level() {
        let store = setup_test_store();
        let manager = create_fund_manager(&store, "manager-1").await;

        let error = store
            .private_asset_repository
            .create(NewPrivateAsset {
                id: Some("asset-1".to_string()),
                name: "Direct Deal".to_string(),
                fund_manager_id: Some(manager.id),
                vehicle_kind: PrivateAssetVehicleKind::Direct,
                strategy_type: PrivateAssetStrategyType::PrivateEquity,
                currency: "USD".to_string(),
                status: PrivateAssetStatus::Active,
                commitment_amount: Some(Decimal::new(10, 0)),
                notes: None,
            })
            .await
            .unwrap_err();

        let error_text = error.to_string();
        assert!(matches!(error, Error::Database(_)));
        assert!(error_text.contains("CHECK constraint failed"));
    }

    #[tokio::test]
    async fn updating_private_snapshot_persists_in_place() {
        let store = setup_test_store();
        let manager = create_fund_manager(&store, "manager-1").await;
        let asset = create_private_asset(&store, "asset-1", &manager.id).await;
        let snapshot = store
            .private_snapshot_repository
            .create(NewPrivateSnapshot {
                id: Some("snapshot-1".to_string()),
                private_asset_id: asset.id.clone(),
                contributed_amount: Decimal::new(100, 0),
                distributed_amount: Decimal::ZERO,
                cash_flow_type: PrivateSnapshotCashFlowType::TotalToDate,
                current_value: Decimal::new(120, 0),
                as_of_date: NaiveDate::from_ymd_opt(2026, 3, 31).unwrap(),
                value_source_type: PrivateSnapshotValueSourceType::Statement,
                notes: Some("before".to_string()),
            })
            .await
            .expect("create snapshot");

        let updated = store
            .private_snapshot_repository
            .update(
                &snapshot.id,
                UpdatePrivateSnapshot {
                    contributed_amount: Decimal::new(100, 0),
                    distributed_amount: Decimal::new(5, 0),
                    cash_flow_type: PrivateSnapshotCashFlowType::PeriodOnly,
                    current_value: Decimal::new(135, 0),
                    as_of_date: NaiveDate::from_ymd_opt(2026, 3, 31).unwrap(),
                    value_source_type: PrivateSnapshotValueSourceType::Manual,
                    notes: Some("after".to_string()),
                },
            )
            .await
            .expect("update snapshot");

        let snapshots = store
            .private_snapshot_repository
            .list_by_private_asset_id(&asset.id)
            .expect("list snapshots");

        assert_eq!(snapshots.len(), 1);
        assert_eq!(updated.id, snapshot.id);
        assert_eq!(updated.private_asset_id, asset.id);
        assert_eq!(updated.created_at, snapshot.created_at);
        assert_eq!(updated.current_value, Decimal::new(135, 0));
        assert_eq!(updated.distributed_amount, Decimal::new(5, 0));
        assert_eq!(
            updated.cash_flow_type,
            PrivateSnapshotCashFlowType::PeriodOnly
        );
        assert_eq!(snapshots[0], updated);
    }

    #[tokio::test]
    async fn listing_private_assets_fails_loudly_on_malformed_persisted_values() {
        let store = setup_test_store();
        let mut conn = get_connection(&store.pool).expect("db connection");

        sql_query(
            "INSERT INTO fund_managers (id, name, created_at, updated_at)
             VALUES ('manager-bad', 'Broken Manager', '2026-04-14T12:00:00Z', '2026-04-14T12:00:00Z')",
        )
        .execute(&mut conn)
        .expect("insert fund manager");

        sql_query(
            "INSERT INTO private_assets (
                id,
                name,
                fund_manager_id,
                vehicle_kind,
                strategy_type,
                currency,
                status,
                commitment_amount,
                notes,
                created_at,
                updated_at
            ) VALUES (
                'asset-bad',
                'Broken Asset',
                'manager-bad',
                'FUND',
                'PRIVATE_EQUITY',
                'USD',
                'ACTIVE',
                'not-a-decimal',
                NULL,
                '2026-04-14T12:00:00Z',
                '2026-04-14T12:00:00Z'
            )",
        )
        .execute(&mut conn)
        .expect("insert malformed private asset");

        let error = store.private_asset_repository.list().unwrap_err();

        assert!(matches!(
            error,
            Error::Database(DatabaseError::Internal(message))
                if message.contains("Invalid persisted private-assets decimal 'not-a-decimal'")
        ));
    }
}
