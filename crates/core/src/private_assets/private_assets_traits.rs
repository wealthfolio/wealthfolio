//! Repository traits for the private-assets ledger seam.

use async_trait::async_trait;

use crate::Result;

use super::{
    FundManager, NewFundManager, NewPrivateAsset, NewPrivateSnapshot, NewPrivateSubAsset,
    PrivateAsset, PrivateAssetCurrentTotals, PrivateAssetDetail, PrivateAssetHistoricalPoint,
    PrivateAssetListRow, PrivateSnapshot, PrivateSubAsset, UpdateFundManager, UpdatePrivateAsset,
    UpdatePrivateSnapshot, UpdatePrivateSubAsset,
};

#[async_trait]
pub trait FundManagerRepositoryTrait: Send + Sync {
    fn get_by_id(&self, id: &str) -> Result<Option<FundManager>>;
    fn list(&self) -> Result<Vec<FundManager>>;
    async fn create(&self, fund_manager: NewFundManager) -> Result<FundManager>;
    async fn update(&self, id: &str, fund_manager: UpdateFundManager) -> Result<FundManager>;
}

#[async_trait]
pub trait PrivateAssetRepositoryTrait: Send + Sync {
    fn get_by_id(&self, id: &str) -> Result<Option<PrivateAsset>>;
    fn list(&self) -> Result<Vec<PrivateAsset>>;
    async fn create(&self, asset: NewPrivateAsset) -> Result<PrivateAsset>;
    async fn update(&self, id: &str, asset: UpdatePrivateAsset) -> Result<PrivateAsset>;
}

#[async_trait]
pub trait PrivateSubAssetRepositoryTrait: Send + Sync {
    fn list_by_private_asset_id(&self, private_asset_id: &str) -> Result<Vec<PrivateSubAsset>>;
    async fn create(&self, sub_asset: NewPrivateSubAsset) -> Result<PrivateSubAsset>;
    async fn update(&self, id: &str, sub_asset: UpdatePrivateSubAsset) -> Result<PrivateSubAsset>;
}

#[async_trait]
pub trait PrivateSnapshotRepositoryTrait: Send + Sync {
    fn list_by_private_asset_id(&self, private_asset_id: &str) -> Result<Vec<PrivateSnapshot>>;
    fn get_latest_by_private_asset_id(
        &self,
        private_asset_id: &str,
    ) -> Result<Option<PrivateSnapshot>>;
    async fn create(&self, snapshot: NewPrivateSnapshot) -> Result<PrivateSnapshot>;
    async fn update(&self, id: &str, snapshot: UpdatePrivateSnapshot) -> Result<PrivateSnapshot>;
}

#[async_trait]
pub trait PrivateAssetsServiceTrait: Send + Sync {
    fn get_fund_manager(&self, fund_manager_id: &str) -> Result<Option<FundManager>>;
    fn list_fund_managers(&self) -> Result<Vec<FundManager>>;
    async fn create_fund_manager(&self, fund_manager: NewFundManager) -> Result<FundManager>;
    async fn update_fund_manager(
        &self,
        fund_manager_id: &str,
        fund_manager: UpdateFundManager,
    ) -> Result<FundManager>;

    fn get_private_asset(&self, private_asset_id: &str) -> Result<Option<PrivateAsset>>;
    fn list_private_assets(&self, include_archived: bool) -> Result<Vec<PrivateAsset>>;
    async fn create_private_asset(&self, asset: NewPrivateAsset) -> Result<PrivateAsset>;
    async fn update_private_asset(
        &self,
        private_asset_id: &str,
        asset: UpdatePrivateAsset,
    ) -> Result<PrivateAsset>;

    fn list_private_sub_assets(&self, private_asset_id: &str) -> Result<Vec<PrivateSubAsset>>;
    async fn create_private_sub_asset(
        &self,
        sub_asset: NewPrivateSubAsset,
    ) -> Result<PrivateSubAsset>;
    async fn update_private_sub_asset(
        &self,
        private_sub_asset_id: &str,
        sub_asset: UpdatePrivateSubAsset,
    ) -> Result<PrivateSubAsset>;

    fn list_private_snapshots(&self, private_asset_id: &str) -> Result<Vec<PrivateSnapshot>>;
    fn get_latest_private_snapshot(
        &self,
        private_asset_id: &str,
    ) -> Result<Option<PrivateSnapshot>>;
    async fn create_private_snapshot(
        &self,
        snapshot: NewPrivateSnapshot,
    ) -> Result<PrivateSnapshot>;
    async fn update_private_snapshot(
        &self,
        private_snapshot_id: &str,
        snapshot: UpdatePrivateSnapshot,
    ) -> Result<PrivateSnapshot>;
}

#[async_trait]
pub trait PrivateAssetProjectionServiceTrait: Send + Sync {
    fn list_private_asset_rows(&self, include_archived: bool) -> Result<Vec<PrivateAssetListRow>>;
    fn get_private_asset_detail(
        &self,
        private_asset_id: &str,
    ) -> Result<Option<PrivateAssetDetail>>;
    fn get_private_asset_current_totals(
        &self,
        include_archived: bool,
    ) -> Result<PrivateAssetCurrentTotals>;
    fn get_private_asset_historical_series(
        &self,
        include_archived: bool,
    ) -> Result<Vec<PrivateAssetHistoricalPoint>>;
}
