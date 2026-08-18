use async_trait::async_trait;

use crate::errors::Result;

use super::{NewPriceAlert, NewPriceAlertEvent, PriceAlert, PriceAlertEvent};

#[async_trait]
pub trait PriceAlertRepositoryTrait: Send + Sync {
    fn list_alerts(&self) -> Result<Vec<PriceAlert>>;
    fn list_active_alerts(&self, asset_ids: Option<&[String]>) -> Result<Vec<PriceAlert>>;
    fn list_events(&self, unacknowledged_only: bool) -> Result<Vec<PriceAlertEvent>>;
    fn count_unacknowledged_events(&self) -> Result<i64>;
    async fn create_alert(
        &self,
        input: NewPriceAlert,
        currency: String,
        armed_market_date: chrono::NaiveDate,
    ) -> Result<PriceAlert>;
    async fn set_status(
        &self,
        alert_id: &str,
        status: super::PriceAlertStatus,
        pause_reason: Option<String>,
        armed_market_date: Option<chrono::NaiveDate>,
    ) -> Result<PriceAlert>;
    async fn delete_alert(&self, alert_id: &str) -> Result<()>;
    async fn acknowledge_events(&self, event_ids: Option<Vec<String>>) -> Result<usize>;
    async fn trigger_alert(
        &self,
        alert_id: &str,
        event: NewPriceAlertEvent,
    ) -> Result<Option<PriceAlertEvent>>;
}

#[async_trait]
pub trait PriceAlertServiceTrait: Send + Sync {
    fn get_alerts(&self) -> Result<Vec<PriceAlert>>;
    fn get_events(&self, unacknowledged_only: bool) -> Result<Vec<PriceAlertEvent>>;
    fn count_unacknowledged_events(&self) -> Result<i64>;
    fn get_active_asset_ids(&self) -> Result<Vec<String>>;
    async fn create_alert(&self, input: NewPriceAlert) -> Result<PriceAlert>;
    async fn pause_alert(&self, alert_id: &str) -> Result<PriceAlert>;
    async fn rearm_alert(&self, alert_id: &str) -> Result<PriceAlert>;
    async fn delete_alert(&self, alert_id: &str) -> Result<()>;
    async fn acknowledge_events(&self, event_ids: Option<Vec<String>>) -> Result<usize>;
    async fn evaluate(&self, asset_ids: Option<Vec<String>>) -> Result<Vec<PriceAlertEvent>>;
}
