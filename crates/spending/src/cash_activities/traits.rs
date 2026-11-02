use crate::activity_assignments::{ActivityTaxonomyAssignment, BulkCategoryAssignment};
use anyhow::Result;
use async_trait::async_trait;

use super::model::{
    CashActivity, CashActivitySearchRequest, CashActivitySearchResponse, SpendingContext,
};
use super::service::CashActivityService;

/// Surface of `CashActivityService` consumed by agent tools.
/// Mirrors the inherent method signatures exactly; extend (don't change)
/// when write tools need more of the service.
#[async_trait]
pub trait CashActivityServiceTrait: Send + Sync {
    async fn clear_allocations_reviewed(
        &self,
        _expected: crate::activity_splits::SplitReviewState,
        _taxonomy_id: &str,
    ) -> Result<()> {
        Err(anyhow::anyhow!("Reviewed allocation clearing unavailable"))
    }

    /// Full, classified Spending scope for the owning rule service. No FX.
    async fn list_for_rules(&self, _account_ids: &[String]) -> Result<Vec<CashActivity>> {
        Err(anyhow::anyhow!("Rule source unavailable"))
    }

    async fn set_event_reviewed(
        &self,
        activity_id: &str,
        expected: Option<String>,
        event_id: Option<String>,
    ) -> Result<()>;

    async fn search(&self, req: CashActivitySearchRequest) -> Result<CashActivitySearchResponse>;
    async fn get_by_activity_ids(&self, activity_ids: &[String]) -> Result<Vec<CashActivity>>;
    async fn bulk_assign_categories(
        &self,
        items: &[BulkCategoryAssignment],
    ) -> Result<Vec<ActivityTaxonomyAssignment>>;
    async fn spending_account_ids(&self) -> Result<Vec<String>>;
    async fn context(&self) -> Result<SpendingContext>;
    async fn validate_splits(
        &self,
        activity_id: &str,
        splits: &[crate::activity_splits::NewActivitySplit],
    ) -> Result<()>;
    async fn replace_splits_reviewed(
        &self,
        expected: crate::activity_splits::SplitReviewState,
        splits: Vec<crate::activity_splits::NewActivitySplit>,
    ) -> Result<Vec<crate::activity_splits::ActivitySplit>>;
}

#[async_trait]
impl CashActivityServiceTrait for CashActivityService {
    async fn clear_allocations_reviewed(
        &self,
        expected: crate::activity_splits::SplitReviewState,
        taxonomy_id: &str,
    ) -> Result<()> {
        CashActivityService::clear_allocations_reviewed(self, expected, taxonomy_id).await
    }

    async fn list_for_rules(&self, account_ids: &[String]) -> Result<Vec<CashActivity>> {
        CashActivityService::list(
            self,
            super::model::CashActivityFilter {
                account_ids: Some(account_ids.to_vec()),
                ..Default::default()
            },
        )
        .await
    }

    async fn set_event_reviewed(
        &self,
        activity_id: &str,
        expected: Option<String>,
        event_id: Option<String>,
    ) -> Result<()> {
        CashActivityService::set_event_reviewed(self, activity_id, expected, event_id).await
    }

    async fn validate_splits(
        &self,
        activity_id: &str,
        splits: &[crate::activity_splits::NewActivitySplit],
    ) -> Result<()> {
        CashActivityService::validate_splits(self, activity_id, splits)
            .await
            .map(|_| ())
    }
    async fn replace_splits_reviewed(
        &self,
        expected: crate::activity_splits::SplitReviewState,
        splits: Vec<crate::activity_splits::NewActivitySplit>,
    ) -> Result<Vec<crate::activity_splits::ActivitySplit>> {
        CashActivityService::replace_splits_reviewed(self, expected, splits).await
    }

    async fn context(&self) -> Result<SpendingContext> {
        CashActivityService::context(self).await
    }
    async fn search(&self, req: CashActivitySearchRequest) -> Result<CashActivitySearchResponse> {
        // `None`: the agent surface reads rows, not a headline figure, so it has
        // no base currency to convert into and skips FX entirely — which also
        // makes the timezone moot, since nothing is dated for a rate lookup.
        CashActivityService::search(self, req, None, "").await
    }

    async fn get_by_activity_ids(&self, activity_ids: &[String]) -> Result<Vec<CashActivity>> {
        CashActivityService::get_by_activity_ids(self, activity_ids).await
    }

    async fn bulk_assign_categories(
        &self,
        items: &[BulkCategoryAssignment],
    ) -> Result<Vec<ActivityTaxonomyAssignment>> {
        CashActivityService::bulk_assign_categories(self, items).await
    }

    async fn spending_account_ids(&self) -> Result<Vec<String>> {
        CashActivityService::spending_account_ids(self).await
    }
}
