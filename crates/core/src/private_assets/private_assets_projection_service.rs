//! Read-side projection service for private-assets views.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use async_trait::async_trait;
use chrono::{NaiveDate, Utc};
use rust_decimal::Decimal;

use super::{
    FundManagerRepositoryTrait, PrivateAsset, PrivateAssetCurrentTotals, PrivateAssetDetail,
    PrivateAssetFreshnessState, PrivateAssetHistoricalPoint, PrivateAssetListRow,
    PrivateAssetProjectionServiceTrait, PrivateAssetRepositoryTrait, PrivateAssetStatus,
    PrivateSnapshot, PrivateSnapshotCashFlowType, PrivateSnapshotRepositoryTrait,
    PrivateSnapshotValueSourceType, PrivateSubAssetRepositoryTrait,
};
use crate::errors::ValidationError;
use crate::{Error, Result};

const STALE_AFTER_DAYS: i64 = 90;

pub fn derive_private_asset_freshness(
    latest_snapshot: Option<&PrivateSnapshot>,
    today: NaiveDate,
) -> PrivateAssetFreshnessState {
    let Some(snapshot) = latest_snapshot else {
        return PrivateAssetFreshnessState::Missing;
    };

    if snapshot.value_source_type == PrivateSnapshotValueSourceType::Estimated {
        return PrivateAssetFreshnessState::Estimated;
    }

    if today.signed_duration_since(snapshot.as_of_date).num_days() > STALE_AFTER_DAYS {
        PrivateAssetFreshnessState::Stale
    } else {
        PrivateAssetFreshnessState::Current
    }
}

fn calculate_cumulative_cash_flows(
    snapshots: &[PrivateSnapshot],
    as_of_date: NaiveDate,
) -> (Decimal, Decimal) {
    let mut contributed = Decimal::ZERO;
    let mut distributed = Decimal::ZERO;

    for snapshot in snapshots
        .iter()
        .filter(|snapshot| snapshot.as_of_date <= as_of_date)
    {
        match snapshot.cash_flow_type {
            PrivateSnapshotCashFlowType::TotalToDate => {
                contributed = snapshot.contributed_amount;
                distributed = snapshot.distributed_amount;
            }
            PrivateSnapshotCashFlowType::PeriodOnly => {
                contributed += snapshot.contributed_amount;
                distributed += snapshot.distributed_amount;
            }
        }
    }

    (contributed, distributed)
}

pub struct PrivateAssetProjectionService {
    base_currency: Arc<RwLock<String>>,
    fund_manager_repository: Arc<dyn FundManagerRepositoryTrait>,
    private_asset_repository: Arc<dyn PrivateAssetRepositoryTrait>,
    private_sub_asset_repository: Arc<dyn PrivateSubAssetRepositoryTrait>,
    private_snapshot_repository: Arc<dyn PrivateSnapshotRepositoryTrait>,
    today_override: Option<NaiveDate>,
}

impl PrivateAssetProjectionService {
    pub fn new(
        base_currency: Arc<RwLock<String>>,
        fund_manager_repository: Arc<dyn FundManagerRepositoryTrait>,
        private_asset_repository: Arc<dyn PrivateAssetRepositoryTrait>,
        private_sub_asset_repository: Arc<dyn PrivateSubAssetRepositoryTrait>,
        private_snapshot_repository: Arc<dyn PrivateSnapshotRepositoryTrait>,
    ) -> Self {
        Self {
            base_currency,
            fund_manager_repository,
            private_asset_repository,
            private_sub_asset_repository,
            private_snapshot_repository,
            today_override: None,
        }
    }

    #[cfg(test)]
    fn with_today(
        base_currency: Arc<RwLock<String>>,
        fund_manager_repository: Arc<dyn FundManagerRepositoryTrait>,
        private_asset_repository: Arc<dyn PrivateAssetRepositoryTrait>,
        private_sub_asset_repository: Arc<dyn PrivateSubAssetRepositoryTrait>,
        private_snapshot_repository: Arc<dyn PrivateSnapshotRepositoryTrait>,
        today: NaiveDate,
    ) -> Self {
        Self {
            base_currency,
            fund_manager_repository,
            private_asset_repository,
            private_sub_asset_repository,
            private_snapshot_repository,
            today_override: Some(today),
        }
    }

    fn today(&self) -> NaiveDate {
        self.today_override
            .unwrap_or_else(|| Utc::now().date_naive())
    }

    fn validate_asset_currency(&self, asset: &PrivateAsset) -> Result<()> {
        let base_currency = self.base_currency.read().unwrap().clone();
        if asset.currency.eq_ignore_ascii_case(&base_currency) {
            Ok(())
        } else {
            Err(Error::Validation(ValidationError::InvalidInput(format!(
                "Private asset '{}' must use the portfolio base currency '{}' in v1",
                asset.name, base_currency
            ))))
        }
    }

    fn list_assets(&self, include_archived: bool) -> Result<Vec<PrivateAsset>> {
        let assets = self.private_asset_repository.list()?;
        if include_archived {
            Ok(assets)
        } else {
            Ok(assets
                .into_iter()
                .filter(|asset| asset.status != PrivateAssetStatus::Archived)
                .collect())
        }
    }
}

#[async_trait]
impl PrivateAssetProjectionServiceTrait for PrivateAssetProjectionService {
    fn list_private_asset_rows(&self, include_archived: bool) -> Result<Vec<PrivateAssetListRow>> {
        let assets = self.list_assets(include_archived)?;
        let today = self.today();
        let manager_names: HashMap<String, String> = self
            .fund_manager_repository
            .list()?
            .into_iter()
            .map(|manager| (manager.id, manager.name))
            .collect();

        assets
            .into_iter()
            .map(|asset| {
                self.validate_asset_currency(&asset)?;
                let latest_snapshot = self
                    .private_snapshot_repository
                    .get_latest_by_private_asset_id(&asset.id)?;

                Ok(PrivateAssetListRow {
                    asset_id: asset.id.clone(),
                    name: asset.name,
                    fund_manager_name: asset
                        .fund_manager_id
                        .as_ref()
                        .and_then(|manager_id| manager_names.get(manager_id).cloned()),
                    vehicle_kind: asset.vehicle_kind,
                    strategy_type: asset.strategy_type,
                    currency: asset.currency,
                    status: asset.status,
                    commitment_amount: asset.commitment_amount,
                    freshness_state: derive_private_asset_freshness(
                        latest_snapshot.as_ref(),
                        today,
                    ),
                    latest_snapshot,
                })
            })
            .collect()
    }

    fn get_private_asset_detail(
        &self,
        private_asset_id: &str,
    ) -> Result<Option<PrivateAssetDetail>> {
        let Some(asset) = self.private_asset_repository.get_by_id(private_asset_id)? else {
            return Ok(None);
        };

        let fund_manager = match &asset.fund_manager_id {
            Some(fund_manager_id) => self.fund_manager_repository.get_by_id(fund_manager_id)?,
            None => None,
        };
        let latest_snapshot = self
            .private_snapshot_repository
            .get_latest_by_private_asset_id(private_asset_id)?;
        let snapshots = self
            .private_snapshot_repository
            .list_by_private_asset_id(private_asset_id)?;
        let sub_assets = self
            .private_sub_asset_repository
            .list_by_private_asset_id(private_asset_id)?;

        let today = self.today();
        Ok(Some(PrivateAssetDetail {
            asset,
            fund_manager,
            sub_assets,
            latest_snapshot: latest_snapshot.clone(),
            snapshots,
            freshness_state: derive_private_asset_freshness(latest_snapshot.as_ref(), today),
        }))
    }

    fn get_private_asset_current_totals(
        &self,
        include_archived: bool,
    ) -> Result<PrivateAssetCurrentTotals> {
        let assets = self.list_assets(include_archived)?;
        let mut total_current_value = Decimal::ZERO;
        let mut total_contributed = Decimal::ZERO;
        let mut total_distributed = Decimal::ZERO;
        let mut latest_as_of_date = None;

        for asset in assets {
            self.validate_asset_currency(&asset)?;
            let snapshots = self
                .private_snapshot_repository
                .list_by_private_asset_id(&asset.id)?;

            if let Some(snapshot) = snapshots.last() {
                let (contributed_amount, distributed_amount) =
                    calculate_cumulative_cash_flows(&snapshots, snapshot.as_of_date);
                total_current_value += snapshot.current_value;
                total_contributed += contributed_amount;
                total_distributed += distributed_amount;
                latest_as_of_date = match latest_as_of_date {
                    Some(current_latest) if current_latest >= snapshot.as_of_date => {
                        Some(current_latest)
                    }
                    _ => Some(snapshot.as_of_date),
                };
            }
        }

        Ok(PrivateAssetCurrentTotals {
            total_current_value,
            total_contributed,
            total_distributed,
            latest_as_of_date,
        })
    }

    fn get_private_asset_historical_series(
        &self,
        include_archived: bool,
    ) -> Result<Vec<PrivateAssetHistoricalPoint>> {
        let assets = self.list_assets(include_archived)?;
        let mut snapshots_by_asset: Vec<Vec<PrivateSnapshot>> = Vec::new();
        let mut dates: Vec<NaiveDate> = Vec::new();

        for asset in assets {
            self.validate_asset_currency(&asset)?;
            let snapshots = self
                .private_snapshot_repository
                .list_by_private_asset_id(&asset.id)?;
            dates.extend(snapshots.iter().map(|snapshot| snapshot.as_of_date));
            snapshots_by_asset.push(snapshots);
        }

        dates.sort_unstable();
        dates.dedup();

        let mut series = Vec::with_capacity(dates.len());
        for date in dates {
            let (total_current_value, total_contributed, total_distributed) =
                snapshots_by_asset.iter().fold(
                    (Decimal::ZERO, Decimal::ZERO, Decimal::ZERO),
                    |(current_sum, contributed_sum, distributed_sum), snapshots| {
                        let latest_snapshot = snapshots
                            .iter()
                            .rev()
                            .find(|snapshot| snapshot.as_of_date <= date);

                        match latest_snapshot {
                            Some(snapshot) => {
                                let (contributed_amount, distributed_amount) =
                                    calculate_cumulative_cash_flows(snapshots, date);
                                (
                                    current_sum + snapshot.current_value,
                                    contributed_sum + contributed_amount,
                                    distributed_sum + distributed_amount,
                                )
                            }
                            None => (current_sum, contributed_sum, distributed_sum),
                        }
                    },
                );

            series.push(PrivateAssetHistoricalPoint {
                as_of_date: date,
                total_current_value,
                total_contributed,
                total_distributed,
            });
        }

        Ok(series)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::private_assets::{
        FundManager, NewFundManager, NewPrivateAsset, NewPrivateSnapshot, NewPrivateSubAsset,
        PrivateAsset, PrivateAssetStrategyType, PrivateAssetVehicleKind, PrivateSnapshot,
        PrivateSnapshotCashFlowType, PrivateSubAsset, UpdateFundManager, UpdatePrivateAsset,
        UpdatePrivateSnapshot, UpdatePrivateSubAsset,
    };
    use async_trait::async_trait;
    use chrono::{DateTime, TimeZone};
    use rust_decimal_macros::dec;

    fn fixed_now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 4, 13, 12, 0, 0).unwrap()
    }

    fn make_manager(id: &str, name: &str) -> FundManager {
        FundManager {
            id: id.to_string(),
            name: name.to_string(),
            notes: None,
            created_at: fixed_now(),
            updated_at: fixed_now(),
        }
    }

    fn make_asset(
        id: &str,
        name: &str,
        fund_manager_id: Option<&str>,
        status: PrivateAssetStatus,
    ) -> PrivateAsset {
        PrivateAsset {
            id: id.to_string(),
            name: name.to_string(),
            fund_manager_id: fund_manager_id.map(str::to_string),
            vehicle_kind: PrivateAssetVehicleKind::Fund,
            strategy_type: PrivateAssetStrategyType::PrivateEquity,
            currency: "USD".to_string(),
            status,
            commitment_amount: Some(dec!(1000)),
            notes: None,
            created_at: fixed_now(),
            updated_at: fixed_now(),
        }
    }

    fn make_snapshot(
        id: &str,
        private_asset_id: &str,
        as_of_date: NaiveDate,
        current_value: Decimal,
        contributed_amount: Decimal,
        distributed_amount: Decimal,
        cash_flow_type: PrivateSnapshotCashFlowType,
    ) -> PrivateSnapshot {
        PrivateSnapshot {
            id: id.to_string(),
            private_asset_id: private_asset_id.to_string(),
            contributed_amount,
            distributed_amount,
            cash_flow_type,
            current_value,
            as_of_date,
            value_source_type: PrivateSnapshotValueSourceType::Statement,
            notes: None,
            created_at: fixed_now(),
        }
    }

    fn make_manual_snapshot(
        id: &str,
        private_asset_id: &str,
        as_of_date: NaiveDate,
        current_value: Decimal,
        contributed_amount: Decimal,
        distributed_amount: Decimal,
    ) -> PrivateSnapshot {
        PrivateSnapshot {
            value_source_type: PrivateSnapshotValueSourceType::Manual,
            ..make_snapshot(
                id,
                private_asset_id,
                as_of_date,
                current_value,
                contributed_amount,
                distributed_amount,
                PrivateSnapshotCashFlowType::TotalToDate,
            )
        }
    }

    fn make_estimated_snapshot(
        id: &str,
        private_asset_id: &str,
        as_of_date: NaiveDate,
        current_value: Decimal,
        contributed_amount: Decimal,
        distributed_amount: Decimal,
    ) -> PrivateSnapshot {
        PrivateSnapshot {
            value_source_type: PrivateSnapshotValueSourceType::Estimated,
            ..make_snapshot(
                id,
                private_asset_id,
                as_of_date,
                current_value,
                contributed_amount,
                distributed_amount,
                PrivateSnapshotCashFlowType::TotalToDate,
            )
        }
    }

    fn make_sub_asset(id: &str, private_asset_id: &str, name: &str) -> PrivateSubAsset {
        PrivateSubAsset {
            id: id.to_string(),
            private_asset_id: private_asset_id.to_string(),
            name: name.to_string(),
            reporting_basis: crate::private_assets::PrivateSubAssetReportingBasis::Net,
            strategy_type: None,
            cost_basis: Some(dec!(50)),
            current_value: Some(dec!(75)),
            ownership_percent: None,
            notes: None,
            created_at: fixed_now(),
            updated_at: fixed_now(),
        }
    }

    struct MockFundManagerRepository {
        fund_managers: Vec<FundManager>,
    }

    #[async_trait]
    impl FundManagerRepositoryTrait for MockFundManagerRepository {
        fn get_by_id(&self, id: &str) -> Result<Option<FundManager>> {
            Ok(self.fund_managers.iter().find(|row| row.id == id).cloned())
        }

        fn list(&self) -> Result<Vec<FundManager>> {
            Ok(self.fund_managers.clone())
        }

        async fn create(&self, _fund_manager: NewFundManager) -> Result<FundManager> {
            unimplemented!()
        }

        async fn update(&self, _id: &str, _fund_manager: UpdateFundManager) -> Result<FundManager> {
            unimplemented!()
        }
    }

    struct MockPrivateAssetRepository {
        assets: Vec<PrivateAsset>,
    }

    #[async_trait]
    impl PrivateAssetRepositoryTrait for MockPrivateAssetRepository {
        fn get_by_id(&self, id: &str) -> Result<Option<PrivateAsset>> {
            Ok(self.assets.iter().find(|row| row.id == id).cloned())
        }

        fn list(&self) -> Result<Vec<PrivateAsset>> {
            Ok(self.assets.clone())
        }

        async fn create(&self, _asset: NewPrivateAsset) -> Result<PrivateAsset> {
            unimplemented!()
        }

        async fn update(&self, _id: &str, _asset: UpdatePrivateAsset) -> Result<PrivateAsset> {
            unimplemented!()
        }
    }

    struct MockPrivateSubAssetRepository {
        sub_assets: Vec<PrivateSubAsset>,
    }

    #[async_trait]
    impl PrivateSubAssetRepositoryTrait for MockPrivateSubAssetRepository {
        fn list_by_private_asset_id(&self, private_asset_id: &str) -> Result<Vec<PrivateSubAsset>> {
            Ok(self
                .sub_assets
                .iter()
                .filter(|row| row.private_asset_id == private_asset_id)
                .cloned()
                .collect())
        }

        async fn create(&self, _sub_asset: NewPrivateSubAsset) -> Result<PrivateSubAsset> {
            unimplemented!()
        }

        async fn update(
            &self,
            _id: &str,
            _sub_asset: UpdatePrivateSubAsset,
        ) -> Result<PrivateSubAsset> {
            unimplemented!()
        }
    }

    struct MockPrivateSnapshotRepository {
        snapshots_by_asset: HashMap<String, Vec<PrivateSnapshot>>,
    }

    #[async_trait]
    impl PrivateSnapshotRepositoryTrait for MockPrivateSnapshotRepository {
        fn list_by_private_asset_id(&self, private_asset_id: &str) -> Result<Vec<PrivateSnapshot>> {
            Ok(self
                .snapshots_by_asset
                .get(private_asset_id)
                .cloned()
                .unwrap_or_default())
        }

        fn get_latest_by_private_asset_id(
            &self,
            private_asset_id: &str,
        ) -> Result<Option<PrivateSnapshot>> {
            Ok(self
                .snapshots_by_asset
                .get(private_asset_id)
                .and_then(|snapshots| snapshots.last().cloned()))
        }

        async fn create(&self, _snapshot: NewPrivateSnapshot) -> Result<PrivateSnapshot> {
            unimplemented!()
        }

        async fn update(
            &self,
            _id: &str,
            _snapshot: UpdatePrivateSnapshot,
        ) -> Result<PrivateSnapshot> {
            unimplemented!()
        }
    }

    fn make_service(
        assets: Vec<PrivateAsset>,
        fund_managers: Vec<FundManager>,
        sub_assets: Vec<PrivateSubAsset>,
        snapshots: Vec<PrivateSnapshot>,
    ) -> PrivateAssetProjectionService {
        let mut snapshots_by_asset: HashMap<String, Vec<PrivateSnapshot>> = HashMap::new();
        for snapshot in snapshots {
            snapshots_by_asset
                .entry(snapshot.private_asset_id.clone())
                .or_default()
                .push(snapshot);
        }
        for asset_snapshots in snapshots_by_asset.values_mut() {
            asset_snapshots.sort_by_key(|snapshot| (snapshot.as_of_date, snapshot.created_at));
        }

        PrivateAssetProjectionService::with_today(
            Arc::new(RwLock::new("USD".to_string())),
            Arc::new(MockFundManagerRepository { fund_managers }),
            Arc::new(MockPrivateAssetRepository { assets }),
            Arc::new(MockPrivateSubAssetRepository { sub_assets }),
            Arc::new(MockPrivateSnapshotRepository { snapshots_by_asset }),
            NaiveDate::from_ymd_opt(2026, 4, 13).unwrap(),
        )
    }

    #[test]
    fn derives_freshness_states_from_latest_snapshot() {
        let today = NaiveDate::from_ymd_opt(2026, 4, 13).unwrap();

        let current_snapshot = make_manual_snapshot(
            "snap-current",
            "asset-1",
            NaiveDate::from_ymd_opt(2026, 4, 1).unwrap(),
            dec!(100),
            dec!(100),
            dec!(0),
        );
        let stale_snapshot = make_snapshot(
            "snap-stale",
            "asset-1",
            NaiveDate::from_ymd_opt(2025, 12, 31).unwrap(),
            dec!(100),
            dec!(100),
            dec!(0),
            PrivateSnapshotCashFlowType::TotalToDate,
        );
        let estimated_snapshot = make_estimated_snapshot(
            "snap-estimated",
            "asset-1",
            NaiveDate::from_ymd_opt(2025, 1, 1).unwrap(),
            dec!(100),
            dec!(100),
            dec!(0),
        );

        assert_eq!(
            derive_private_asset_freshness(Some(&current_snapshot), today),
            PrivateAssetFreshnessState::Current
        );
        assert_eq!(
            derive_private_asset_freshness(Some(&stale_snapshot), today),
            PrivateAssetFreshnessState::Stale
        );
        assert_eq!(
            derive_private_asset_freshness(Some(&estimated_snapshot), today),
            PrivateAssetFreshnessState::Estimated
        );
        assert_eq!(
            derive_private_asset_freshness(None, today),
            PrivateAssetFreshnessState::Missing
        );
    }

    #[test]
    fn lists_asset_rows_and_builds_detail_payload() {
        let asset = make_asset(
            "asset-1",
            "North Fund I",
            Some("manager-1"),
            PrivateAssetStatus::Active,
        );
        let snapshot = make_snapshot(
            "snap-1",
            "asset-1",
            NaiveDate::from_ymd_opt(2026, 3, 31).unwrap(),
            dec!(250),
            dec!(200),
            dec!(25),
            PrivateSnapshotCashFlowType::TotalToDate,
        );
        let service = make_service(
            vec![asset.clone()],
            vec![make_manager("manager-1", "North Capital")],
            vec![make_sub_asset("sub-1", "asset-1", "Portfolio Co")],
            vec![snapshot.clone()],
        );

        let rows = service.list_private_asset_rows(false).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].fund_manager_name.as_deref(), Some("North Capital"));
        assert_eq!(rows[0].latest_snapshot.as_ref(), Some(&snapshot));
        assert_eq!(rows[0].freshness_state, PrivateAssetFreshnessState::Current);

        let detail = service
            .get_private_asset_detail("asset-1")
            .unwrap()
            .unwrap();
        assert_eq!(detail.asset, asset);
        assert_eq!(detail.fund_manager.unwrap().name, "North Capital");
        assert_eq!(detail.sub_assets.len(), 1);
        assert_eq!(detail.snapshots, vec![snapshot.clone()]);
        assert_eq!(detail.latest_snapshot, Some(snapshot));
        assert_eq!(detail.freshness_state, PrivateAssetFreshnessState::Current);
    }

    #[test]
    fn current_totals_exclude_missing_assets_and_hidden_archived_assets() {
        let active_current = make_asset(
            "asset-1",
            "Current Fund",
            Some("manager-1"),
            PrivateAssetStatus::Active,
        );
        let active_missing = make_asset(
            "asset-2",
            "Missing Fund",
            Some("manager-1"),
            PrivateAssetStatus::Active,
        );
        let archived = make_asset(
            "asset-3",
            "Archived Fund",
            Some("manager-1"),
            PrivateAssetStatus::Archived,
        );
        let service = make_service(
            vec![active_current, active_missing, archived],
            vec![make_manager("manager-1", "North Capital")],
            Vec::new(),
            vec![
                make_snapshot(
                    "snap-1",
                    "asset-1",
                    NaiveDate::from_ymd_opt(2026, 3, 31).unwrap(),
                    dec!(250),
                    dec!(200),
                    dec!(25),
                    PrivateSnapshotCashFlowType::TotalToDate,
                ),
                make_estimated_snapshot(
                    "snap-2",
                    "asset-3",
                    NaiveDate::from_ymd_opt(2026, 2, 1).unwrap(),
                    dec!(400),
                    dec!(300),
                    dec!(50),
                ),
            ],
        );

        let active_only = service.get_private_asset_current_totals(false).unwrap();
        assert_eq!(active_only.total_current_value, dec!(250));
        assert_eq!(active_only.total_contributed, dec!(200));
        assert_eq!(active_only.total_distributed, dec!(25));
        assert_eq!(
            active_only.latest_as_of_date,
            Some(NaiveDate::from_ymd_opt(2026, 3, 31).unwrap())
        );

        let including_archived = service.get_private_asset_current_totals(true).unwrap();
        assert_eq!(including_archived.total_current_value, dec!(650));
        assert_eq!(including_archived.total_contributed, dec!(500));
        assert_eq!(including_archived.total_distributed, dec!(75));
    }

    #[test]
    fn builds_historical_series_with_carry_forward_marks() {
        let service = make_service(
            vec![
                make_asset(
                    "asset-1",
                    "Fund A",
                    Some("manager-1"),
                    PrivateAssetStatus::Active,
                ),
                make_asset(
                    "asset-2",
                    "Fund B",
                    Some("manager-1"),
                    PrivateAssetStatus::Active,
                ),
            ],
            vec![make_manager("manager-1", "North Capital")],
            Vec::new(),
            vec![
                make_snapshot(
                    "snap-a1",
                    "asset-1",
                    NaiveDate::from_ymd_opt(2026, 1, 1).unwrap(),
                    dec!(100),
                    dec!(100),
                    dec!(0),
                    PrivateSnapshotCashFlowType::TotalToDate,
                ),
                make_snapshot(
                    "snap-a2",
                    "asset-1",
                    NaiveDate::from_ymd_opt(2026, 3, 1).unwrap(),
                    dec!(140),
                    dec!(120),
                    dec!(10),
                    PrivateSnapshotCashFlowType::TotalToDate,
                ),
                make_snapshot(
                    "snap-b1",
                    "asset-2",
                    NaiveDate::from_ymd_opt(2026, 2, 1).unwrap(),
                    dec!(200),
                    dec!(200),
                    dec!(0),
                    PrivateSnapshotCashFlowType::TotalToDate,
                ),
            ],
        );

        let series = service.get_private_asset_historical_series(false).unwrap();
        assert_eq!(
            series,
            vec![
                PrivateAssetHistoricalPoint {
                    as_of_date: NaiveDate::from_ymd_opt(2026, 1, 1).unwrap(),
                    total_current_value: dec!(100),
                    total_contributed: dec!(100),
                    total_distributed: dec!(0),
                },
                PrivateAssetHistoricalPoint {
                    as_of_date: NaiveDate::from_ymd_opt(2026, 2, 1).unwrap(),
                    total_current_value: dec!(300),
                    total_contributed: dec!(300),
                    total_distributed: dec!(0),
                },
                PrivateAssetHistoricalPoint {
                    as_of_date: NaiveDate::from_ymd_opt(2026, 3, 1).unwrap(),
                    total_current_value: dec!(340),
                    total_contributed: dec!(320),
                    total_distributed: dec!(10),
                },
            ]
        );
    }

    #[test]
    fn accumulates_period_only_cash_flows_for_current_totals_and_history() {
        let service = make_service(
            vec![make_asset(
                "asset-1",
                "Fund A",
                Some("manager-1"),
                PrivateAssetStatus::Active,
            )],
            vec![make_manager("manager-1", "North Capital")],
            Vec::new(),
            vec![
                make_snapshot(
                    "snap-1",
                    "asset-1",
                    NaiveDate::from_ymd_opt(2026, 1, 1).unwrap(),
                    dec!(100),
                    dec!(100),
                    dec!(0),
                    PrivateSnapshotCashFlowType::PeriodOnly,
                ),
                make_snapshot(
                    "snap-2",
                    "asset-1",
                    NaiveDate::from_ymd_opt(2026, 2, 1).unwrap(),
                    dec!(140),
                    dec!(25),
                    dec!(10),
                    PrivateSnapshotCashFlowType::PeriodOnly,
                ),
            ],
        );

        let totals = service.get_private_asset_current_totals(false).unwrap();
        assert_eq!(totals.total_current_value, dec!(140));
        assert_eq!(totals.total_contributed, dec!(125));
        assert_eq!(totals.total_distributed, dec!(10));

        let series = service.get_private_asset_historical_series(false).unwrap();
        assert_eq!(series.len(), 2);
        assert_eq!(series[0].total_contributed, dec!(100));
        assert_eq!(series[1].total_contributed, dec!(125));
        assert_eq!(series[1].total_distributed, dec!(10));
    }

    #[test]
    fn period_only_cash_flows_can_extend_a_total_to_date_baseline() {
        let service = make_service(
            vec![make_asset(
                "asset-1",
                "Fund A",
                Some("manager-1"),
                PrivateAssetStatus::Active,
            )],
            vec![make_manager("manager-1", "North Capital")],
            Vec::new(),
            vec![
                make_snapshot(
                    "snap-1",
                    "asset-1",
                    NaiveDate::from_ymd_opt(2026, 1, 1).unwrap(),
                    dec!(100),
                    dec!(100),
                    dec!(0),
                    PrivateSnapshotCashFlowType::TotalToDate,
                ),
                make_snapshot(
                    "snap-2",
                    "asset-1",
                    NaiveDate::from_ymd_opt(2026, 2, 1).unwrap(),
                    dec!(130),
                    dec!(25),
                    dec!(10),
                    PrivateSnapshotCashFlowType::PeriodOnly,
                ),
            ],
        );

        let totals = service.get_private_asset_current_totals(false).unwrap();
        assert_eq!(totals.total_contributed, dec!(125));
        assert_eq!(totals.total_distributed, dec!(10));
    }

    #[test]
    fn later_total_to_date_statement_replaces_prior_period_only_running_totals() {
        let service = make_service(
            vec![make_asset(
                "asset-1",
                "Fund A",
                Some("manager-1"),
                PrivateAssetStatus::Active,
            )],
            vec![make_manager("manager-1", "North Capital")],
            Vec::new(),
            vec![
                make_snapshot(
                    "snap-1",
                    "asset-1",
                    NaiveDate::from_ymd_opt(2026, 1, 1).unwrap(),
                    dec!(100),
                    dec!(100),
                    dec!(0),
                    PrivateSnapshotCashFlowType::TotalToDate,
                ),
                make_snapshot(
                    "snap-2",
                    "asset-1",
                    NaiveDate::from_ymd_opt(2026, 2, 1).unwrap(),
                    dec!(130),
                    dec!(25),
                    dec!(10),
                    PrivateSnapshotCashFlowType::PeriodOnly,
                ),
                make_snapshot(
                    "snap-3",
                    "asset-1",
                    NaiveDate::from_ymd_opt(2026, 3, 1).unwrap(),
                    dec!(150),
                    dec!(130),
                    dec!(12),
                    PrivateSnapshotCashFlowType::TotalToDate,
                ),
            ],
        );

        let totals = service.get_private_asset_current_totals(false).unwrap();
        assert_eq!(totals.total_current_value, dec!(150));
        assert_eq!(totals.total_contributed, dec!(130));
        assert_eq!(totals.total_distributed, dec!(12));

        let series = service.get_private_asset_historical_series(false).unwrap();
        assert_eq!(series.len(), 3);
        assert_eq!(series[1].total_contributed, dec!(125));
        assert_eq!(series[1].total_distributed, dec!(10));
        assert_eq!(series[2].total_contributed, dec!(130));
        assert_eq!(series[2].total_distributed, dec!(12));
    }

    #[test]
    fn current_totals_reject_non_base_currency_assets() {
        let service = make_service(
            vec![PrivateAsset {
                currency: "EUR".to_string(),
                ..make_asset(
                    "asset-1",
                    "Fund A",
                    Some("manager-1"),
                    PrivateAssetStatus::Active,
                )
            }],
            vec![make_manager("manager-1", "North Capital")],
            Vec::new(),
            vec![make_snapshot(
                "snap-1",
                "asset-1",
                NaiveDate::from_ymd_opt(2026, 1, 1).unwrap(),
                dec!(100),
                dec!(100),
                dec!(0),
                PrivateSnapshotCashFlowType::TotalToDate,
            )],
        );

        let error = service.get_private_asset_current_totals(false).unwrap_err();
        assert!(matches!(
            error,
            Error::Validation(ValidationError::InvalidInput(message))
                if message == "Private asset 'Fund A' must use the portfolio base currency 'USD' in v1"
        ));
    }

    #[test]
    fn historical_series_can_include_archived_assets_when_requested() {
        let service = make_service(
            vec![
                make_asset(
                    "asset-active",
                    "Fund A",
                    Some("manager-1"),
                    PrivateAssetStatus::Active,
                ),
                make_asset(
                    "asset-archived",
                    "Fund B",
                    Some("manager-1"),
                    PrivateAssetStatus::Archived,
                ),
            ],
            vec![make_manager("manager-1", "North Capital")],
            Vec::new(),
            vec![
                make_snapshot(
                    "snap-active",
                    "asset-active",
                    NaiveDate::from_ymd_opt(2026, 1, 1).unwrap(),
                    dec!(100),
                    dec!(100),
                    dec!(0),
                    PrivateSnapshotCashFlowType::TotalToDate,
                ),
                make_snapshot(
                    "snap-archived",
                    "asset-archived",
                    NaiveDate::from_ymd_opt(2026, 2, 1).unwrap(),
                    dec!(250),
                    dec!(200),
                    dec!(0),
                    PrivateSnapshotCashFlowType::TotalToDate,
                ),
            ],
        );

        let active_only = service.get_private_asset_historical_series(false).unwrap();
        assert_eq!(active_only.len(), 1);
        assert_eq!(active_only[0].total_current_value, dec!(100));

        let including_archived = service.get_private_asset_historical_series(true).unwrap();
        assert_eq!(including_archived.len(), 2);
        assert_eq!(including_archived[1].total_current_value, dec!(350));
    }
}
