use anyhow::Result;
use async_trait::async_trait;

/// Service surface consumed directly by agent tools, shared by both hosts.
#[async_trait]
pub trait AnalyticsServiceTrait: Send + Sync {
    async fn monthly_report(
        &self,
        req: super::model::ReportRequest,
        timezone: &str,
        base_currency: &str,
    ) -> Result<super::model::MonthlyReport>;
    async fn event_spending_summaries(
        &self,
        req: super::model::EventSummariesRequest,
        timezone: &str,
    ) -> Result<Vec<super::model::EventSpendingSummary>>;
}

#[async_trait]
impl AnalyticsServiceTrait for super::service::AnalyticsService {
    async fn monthly_report(
        &self,
        req: super::model::ReportRequest,
        timezone: &str,
        base_currency: &str,
    ) -> Result<super::model::MonthlyReport> {
        super::service::AnalyticsService::monthly_report(self, req, timezone, base_currency).await
    }
    async fn event_spending_summaries(
        &self,
        req: super::model::EventSummariesRequest,
        timezone: &str,
    ) -> Result<Vec<super::model::EventSpendingSummary>> {
        super::service::AnalyticsService::event_spending_summaries(self, req, timezone).await
    }
}
