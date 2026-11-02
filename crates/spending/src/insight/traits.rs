use anyhow::Result;
use async_trait::async_trait;

/// Service surface consumed directly by agent tools, shared by both hosts.
#[async_trait]
pub trait InsightServiceTrait: Send + Sync {
    async fn compute(
        &self,
        req: super::model::SpendingInsightRequest,
        currency: &str,
        timezone: &str,
    ) -> Result<super::model::SpendingInsight>;
}

#[async_trait]
impl InsightServiceTrait for super::service::InsightService {
    async fn compute(
        &self,
        req: super::model::SpendingInsightRequest,
        currency: &str,
        timezone: &str,
    ) -> Result<super::model::SpendingInsight> {
        super::service::InsightService::compute(self, req, currency, timezone).await
    }
}
