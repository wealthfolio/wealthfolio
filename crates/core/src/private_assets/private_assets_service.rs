//! Narrow write-side service for the private-assets ledger.

use std::sync::{Arc, RwLock};

use async_trait::async_trait;

use super::{
    FundManager, FundManagerRepositoryTrait, NewFundManager, NewPrivateAsset, NewPrivateSnapshot,
    NewPrivateSubAsset, PrivateAsset, PrivateAssetRepositoryTrait, PrivateAssetStatus,
    PrivateAssetVehicleKind, PrivateAssetsServiceTrait, PrivateSnapshot,
    PrivateSnapshotRepositoryTrait, PrivateSubAsset, PrivateSubAssetRepositoryTrait,
    UpdateFundManager, UpdatePrivateAsset, UpdatePrivateSnapshot, UpdatePrivateSubAsset,
};
use crate::errors::{DatabaseError, Result, ValidationError};
use crate::Error;

pub struct PrivateAssetsService {
    base_currency: Arc<RwLock<String>>,
    fund_manager_repository: Arc<dyn FundManagerRepositoryTrait>,
    private_asset_repository: Arc<dyn PrivateAssetRepositoryTrait>,
    private_sub_asset_repository: Arc<dyn PrivateSubAssetRepositoryTrait>,
    private_snapshot_repository: Arc<dyn PrivateSnapshotRepositoryTrait>,
}

impl PrivateAssetsService {
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
        }
    }

    fn validate_vehicle_manager_coherence(
        &self,
        vehicle_kind: PrivateAssetVehicleKind,
        fund_manager_id: Option<&str>,
    ) -> Result<()> {
        match vehicle_kind {
            PrivateAssetVehicleKind::Direct => {
                if fund_manager_id.is_some() {
                    return Err(Error::Validation(ValidationError::InvalidInput(
                        "Direct private assets must not have a fund manager".to_string(),
                    )));
                }
            }
            _ => {
                let fund_manager_id = fund_manager_id
                    .ok_or_else(|| ValidationError::MissingField("fund_manager_id".to_string()))?;
                self.ensure_fund_manager_exists(fund_manager_id)?;
            }
        }

        Ok(())
    }

    fn validate_asset_currency(&self, currency: &str) -> Result<()> {
        let base_currency = self.base_currency.read().unwrap().clone();
        if currency.eq_ignore_ascii_case(&base_currency) {
            Ok(())
        } else {
            Err(Error::Validation(ValidationError::InvalidInput(format!(
                "Private assets must use the portfolio base currency '{}' in v1",
                base_currency
            ))))
        }
    }

    fn ensure_fund_manager_exists(&self, fund_manager_id: &str) -> Result<()> {
        if self
            .fund_manager_repository
            .get_by_id(fund_manager_id)?
            .is_some()
        {
            Ok(())
        } else {
            Err(Error::Database(DatabaseError::NotFound(format!(
                "Fund manager '{}' not found",
                fund_manager_id
            ))))
        }
    }

    fn ensure_private_asset_exists(&self, private_asset_id: &str) -> Result<()> {
        if self
            .private_asset_repository
            .get_by_id(private_asset_id)?
            .is_some()
        {
            Ok(())
        } else {
            Err(Error::Database(DatabaseError::NotFound(format!(
                "Private asset '{}' not found",
                private_asset_id
            ))))
        }
    }
}

#[async_trait]
impl PrivateAssetsServiceTrait for PrivateAssetsService {
    fn get_fund_manager(&self, fund_manager_id: &str) -> Result<Option<FundManager>> {
        self.fund_manager_repository.get_by_id(fund_manager_id)
    }

    fn list_fund_managers(&self) -> Result<Vec<FundManager>> {
        self.fund_manager_repository.list()
    }

    async fn create_fund_manager(&self, fund_manager: NewFundManager) -> Result<FundManager> {
        self.fund_manager_repository.create(fund_manager).await
    }

    async fn update_fund_manager(
        &self,
        fund_manager_id: &str,
        fund_manager: UpdateFundManager,
    ) -> Result<FundManager> {
        self.fund_manager_repository
            .update(fund_manager_id, fund_manager)
            .await
    }

    fn get_private_asset(&self, private_asset_id: &str) -> Result<Option<PrivateAsset>> {
        self.private_asset_repository.get_by_id(private_asset_id)
    }

    fn list_private_assets(&self, include_archived: bool) -> Result<Vec<PrivateAsset>> {
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

    async fn create_private_asset(&self, asset: NewPrivateAsset) -> Result<PrivateAsset> {
        self.validate_asset_currency(&asset.currency)?;
        self.validate_vehicle_manager_coherence(
            asset.vehicle_kind,
            asset.fund_manager_id.as_deref(),
        )?;
        self.private_asset_repository.create(asset).await
    }

    async fn update_private_asset(
        &self,
        private_asset_id: &str,
        asset: UpdatePrivateAsset,
    ) -> Result<PrivateAsset> {
        let existing = self
            .private_asset_repository
            .get_by_id(private_asset_id)?
            .ok_or_else(|| {
                Error::Database(DatabaseError::NotFound(format!(
                    "Private asset '{}' not found",
                    private_asset_id
                )))
            })?;

        let vehicle_kind = asset.vehicle_kind.unwrap_or(existing.vehicle_kind);
        let fund_manager_id = asset
            .fund_manager_id
            .clone()
            .unwrap_or(existing.fund_manager_id.clone());
        let currency = asset.currency.clone().unwrap_or(existing.currency.clone());

        self.validate_asset_currency(&currency)?;
        self.validate_vehicle_manager_coherence(vehicle_kind, fund_manager_id.as_deref())?;

        self.private_asset_repository
            .update(private_asset_id, asset)
            .await
    }

    fn list_private_sub_assets(&self, private_asset_id: &str) -> Result<Vec<PrivateSubAsset>> {
        self.private_sub_asset_repository
            .list_by_private_asset_id(private_asset_id)
    }

    async fn create_private_sub_asset(
        &self,
        sub_asset: NewPrivateSubAsset,
    ) -> Result<PrivateSubAsset> {
        self.ensure_private_asset_exists(&sub_asset.private_asset_id)?;
        self.private_sub_asset_repository.create(sub_asset).await
    }

    async fn update_private_sub_asset(
        &self,
        private_sub_asset_id: &str,
        sub_asset: UpdatePrivateSubAsset,
    ) -> Result<PrivateSubAsset> {
        self.private_sub_asset_repository
            .update(private_sub_asset_id, sub_asset)
            .await
    }

    fn list_private_snapshots(&self, private_asset_id: &str) -> Result<Vec<PrivateSnapshot>> {
        self.private_snapshot_repository
            .list_by_private_asset_id(private_asset_id)
    }

    fn get_latest_private_snapshot(
        &self,
        private_asset_id: &str,
    ) -> Result<Option<PrivateSnapshot>> {
        self.private_snapshot_repository
            .get_latest_by_private_asset_id(private_asset_id)
    }

    async fn create_private_snapshot(
        &self,
        snapshot: NewPrivateSnapshot,
    ) -> Result<PrivateSnapshot> {
        self.ensure_private_asset_exists(&snapshot.private_asset_id)?;
        self.private_snapshot_repository.create(snapshot).await
    }

    async fn update_private_snapshot(
        &self,
        private_snapshot_id: &str,
        snapshot: UpdatePrivateSnapshot,
    ) -> Result<PrivateSnapshot> {
        self.private_snapshot_repository
            .update(private_snapshot_id, snapshot)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::private_assets::{
        FundManager, NewFundManager, NewPrivateAsset, NewPrivateSnapshot, NewPrivateSubAsset,
        PrivateAssetStrategyType, UpdateFundManager, UpdatePrivateSnapshot, UpdatePrivateSubAsset,
    };
    use async_trait::async_trait;
    use chrono::{TimeZone, Utc};
    use rust_decimal_macros::dec;

    fn fixed_now() -> chrono::DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 4, 14, 12, 0, 0).unwrap()
    }

    fn make_asset(id: &str, vehicle_kind: PrivateAssetVehicleKind) -> PrivateAsset {
        PrivateAsset {
            id: id.to_string(),
            name: "Asset".to_string(),
            fund_manager_id: None,
            vehicle_kind,
            strategy_type: PrivateAssetStrategyType::PrivateEquity,
            currency: "USD".to_string(),
            status: PrivateAssetStatus::Active,
            commitment_amount: Some(dec!(100)),
            notes: None,
            created_at: fixed_now(),
            updated_at: fixed_now(),
        }
    }

    fn make_manager(id: &str) -> FundManager {
        FundManager {
            id: id.to_string(),
            name: "Manager".to_string(),
            notes: None,
            created_at: fixed_now(),
            updated_at: fixed_now(),
        }
    }

    struct MockFundManagerRepository {
        managers: Vec<FundManager>,
    }

    #[async_trait]
    impl FundManagerRepositoryTrait for MockFundManagerRepository {
        fn get_by_id(&self, id: &str) -> Result<Option<FundManager>> {
            Ok(self
                .managers
                .iter()
                .find(|manager| manager.id == id)
                .cloned())
        }

        fn list(&self) -> Result<Vec<FundManager>> {
            Ok(self.managers.clone())
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
            Ok(self.assets.iter().find(|asset| asset.id == id).cloned())
        }

        fn list(&self) -> Result<Vec<PrivateAsset>> {
            Ok(self.assets.clone())
        }

        async fn create(&self, asset: NewPrivateAsset) -> Result<PrivateAsset> {
            Ok(PrivateAsset {
                id: asset.id.unwrap_or_else(|| "created-asset".to_string()),
                name: asset.name,
                fund_manager_id: asset.fund_manager_id,
                vehicle_kind: asset.vehicle_kind,
                strategy_type: asset.strategy_type,
                currency: asset.currency,
                status: asset.status,
                commitment_amount: asset.commitment_amount,
                notes: asset.notes,
                created_at: fixed_now(),
                updated_at: fixed_now(),
            })
        }

        async fn update(&self, id: &str, asset: UpdatePrivateAsset) -> Result<PrivateAsset> {
            let mut existing = self
                .assets
                .iter()
                .find(|row| row.id == id)
                .cloned()
                .expect("existing asset");
            if let Some(name) = asset.name {
                existing.name = name;
            }
            if let Some(fund_manager_id) = asset.fund_manager_id {
                existing.fund_manager_id = fund_manager_id;
            }
            if let Some(vehicle_kind) = asset.vehicle_kind {
                existing.vehicle_kind = vehicle_kind;
            }
            Ok(existing)
        }
    }

    struct MockPrivateSubAssetRepository;

    #[async_trait]
    impl PrivateSubAssetRepositoryTrait for MockPrivateSubAssetRepository {
        fn list_by_private_asset_id(
            &self,
            _private_asset_id: &str,
        ) -> Result<Vec<PrivateSubAsset>> {
            Ok(vec![])
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

    struct MockPrivateSnapshotRepository;

    #[async_trait]
    impl PrivateSnapshotRepositoryTrait for MockPrivateSnapshotRepository {
        fn list_by_private_asset_id(
            &self,
            _private_asset_id: &str,
        ) -> Result<Vec<PrivateSnapshot>> {
            Ok(vec![])
        }

        fn get_latest_by_private_asset_id(
            &self,
            _private_asset_id: &str,
        ) -> Result<Option<PrivateSnapshot>> {
            Ok(None)
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

    fn make_service(assets: Vec<PrivateAsset>, managers: Vec<FundManager>) -> PrivateAssetsService {
        PrivateAssetsService::new(
            Arc::new(RwLock::new("USD".to_string())),
            Arc::new(MockFundManagerRepository { managers }),
            Arc::new(MockPrivateAssetRepository { assets }),
            Arc::new(MockPrivateSubAssetRepository),
            Arc::new(MockPrivateSnapshotRepository),
        )
    }

    #[tokio::test]
    async fn create_private_asset_rejects_direct_asset_with_manager() {
        let service = make_service(vec![], vec![]);

        let error = service
            .create_private_asset(NewPrivateAsset {
                id: None,
                name: "Direct Deal".to_string(),
                fund_manager_id: Some("manager-1".to_string()),
                vehicle_kind: PrivateAssetVehicleKind::Direct,
                strategy_type: PrivateAssetStrategyType::PrivateEquity,
                currency: "USD".to_string(),
                status: PrivateAssetStatus::Active,
                commitment_amount: Some(dec!(10)),
                notes: None,
            })
            .await
            .unwrap_err();

        assert!(matches!(
            error,
            Error::Validation(ValidationError::InvalidInput(message))
                if message == "Direct private assets must not have a fund manager"
        ));
    }

    #[tokio::test]
    async fn create_private_asset_requires_existing_manager_for_non_direct_assets() {
        let service = make_service(vec![], vec![]);

        let error = service
            .create_private_asset(NewPrivateAsset {
                id: None,
                name: "Fund I".to_string(),
                fund_manager_id: None,
                vehicle_kind: PrivateAssetVehicleKind::Fund,
                strategy_type: PrivateAssetStrategyType::PrivateEquity,
                currency: "USD".to_string(),
                status: PrivateAssetStatus::Active,
                commitment_amount: Some(dec!(10)),
                notes: None,
            })
            .await
            .unwrap_err();

        assert!(matches!(
            error,
            Error::Validation(ValidationError::MissingField(field)) if field == "fund_manager_id"
        ));
    }

    #[tokio::test]
    async fn update_private_asset_rejects_manager_on_existing_direct_asset() {
        let service = make_service(
            vec![make_asset("asset-1", PrivateAssetVehicleKind::Direct)],
            vec![],
        );

        let error = service
            .update_private_asset(
                "asset-1",
                UpdatePrivateAsset {
                    fund_manager_id: Some(Some("manager-1".to_string())),
                    ..UpdatePrivateAsset::default()
                },
            )
            .await
            .unwrap_err();

        assert!(matches!(
            error,
            Error::Validation(ValidationError::InvalidInput(message))
                if message == "Direct private assets must not have a fund manager"
        ));
    }

    #[tokio::test]
    async fn create_private_asset_rejects_non_base_currency() {
        let service = make_service(vec![], vec![make_manager("manager-1")]);

        let error = service
            .create_private_asset(NewPrivateAsset {
                id: None,
                name: "Fund I".to_string(),
                fund_manager_id: Some("manager-1".to_string()),
                vehicle_kind: PrivateAssetVehicleKind::Fund,
                strategy_type: PrivateAssetStrategyType::PrivateEquity,
                currency: "EUR".to_string(),
                status: PrivateAssetStatus::Active,
                commitment_amount: Some(dec!(10)),
                notes: None,
            })
            .await
            .unwrap_err();

        assert!(matches!(
            error,
            Error::Validation(ValidationError::InvalidInput(message))
                if message == "Private assets must use the portfolio base currency 'USD' in v1"
        ));
    }

    #[tokio::test]
    async fn update_private_asset_rejects_non_base_currency() {
        let service = make_service(
            vec![PrivateAsset {
                fund_manager_id: Some("manager-1".to_string()),
                ..make_asset("asset-1", PrivateAssetVehicleKind::Fund)
            }],
            vec![make_manager("manager-1")],
        );

        let error = service
            .update_private_asset(
                "asset-1",
                UpdatePrivateAsset {
                    currency: Some("CAD".to_string()),
                    ..UpdatePrivateAsset::default()
                },
            )
            .await
            .unwrap_err();

        assert!(matches!(
            error,
            Error::Validation(ValidationError::InvalidInput(message))
                if message == "Private assets must use the portfolio base currency 'USD' in v1"
        ));
    }
}
