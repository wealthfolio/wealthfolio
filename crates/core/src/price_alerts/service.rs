use std::sync::Arc;

use async_trait::async_trait;
use chrono::Utc;
use rust_decimal::Decimal;

use crate::{
    assets::AssetRepositoryTrait,
    errors::{Result, ValidationError},
    quotes::{Quote, QuoteServiceTrait},
    utils::time_utils,
};

use super::{
    NewPriceAlert, NewPriceAlertEvent, PriceAlert, PriceAlertCondition, PriceAlertEvent,
    PriceAlertRepositoryTrait, PriceAlertServiceTrait, PriceAlertStatus,
};

pub struct PriceAlertService {
    repository: Arc<dyn PriceAlertRepositoryTrait>,
    asset_repository: Arc<dyn AssetRepositoryTrait>,
    quote_service: Arc<dyn QuoteServiceTrait>,
}

impl PriceAlertService {
    pub fn new(
        repository: Arc<dyn PriceAlertRepositoryTrait>,
        asset_repository: Arc<dyn AssetRepositoryTrait>,
        quote_service: Arc<dyn QuoteServiceTrait>,
    ) -> Self {
        Self {
            repository,
            asset_repository,
            quote_service,
        }
    }

    fn parsed_target(alert: &PriceAlert) -> Result<Decimal> {
        Ok(alert.target_price.parse::<Decimal>()?)
    }

    fn quote_triggers(alert: &PriceAlert, quote: &Quote) -> Result<bool> {
        if !quote.currency.eq_ignore_ascii_case(&alert.currency) {
            return Ok(false);
        }

        let quote_day = quote.timestamp.date_naive();
        if quote_day < alert.armed_market_date {
            return Ok(false);
        }

        let target = Self::parsed_target(alert)?;
        let observed = if quote_day == alert.armed_market_date {
            quote.close
        } else {
            match alert.condition {
                PriceAlertCondition::Above => quote.high,
                PriceAlertCondition::Below => quote.low,
            }
        };

        Ok(match alert.condition {
            PriceAlertCondition::Above => observed >= target,
            PriceAlertCondition::Below => observed <= target,
        })
    }

    fn latest_close_satisfies(alert: &PriceAlert, quote: &Quote) -> Result<bool> {
        let target = Self::parsed_target(alert)?;
        Ok(match alert.condition {
            PriceAlertCondition::Above => quote.close >= target,
            PriceAlertCondition::Below => quote.close <= target,
        })
    }
}

#[async_trait]
impl PriceAlertServiceTrait for PriceAlertService {
    fn get_alerts(&self) -> Result<Vec<PriceAlert>> {
        self.repository.list_alerts()
    }

    fn get_events(&self, unacknowledged_only: bool) -> Result<Vec<PriceAlertEvent>> {
        self.repository.list_events(unacknowledged_only)
    }

    fn count_unacknowledged_events(&self) -> Result<i64> {
        self.repository.count_unacknowledged_events()
    }

    fn get_active_asset_ids(&self) -> Result<Vec<String>> {
        let mut ids: Vec<String> = self
            .repository
            .list_active_alerts(None)?
            .into_iter()
            .map(|alert| alert.asset_id)
            .collect();
        ids.sort();
        ids.dedup();
        Ok(ids)
    }

    async fn create_alert(&self, mut input: NewPriceAlert) -> Result<PriceAlert> {
        let target = input.target_price.trim().parse::<Decimal>()?;
        if target <= Decimal::ZERO {
            return Err(ValidationError::InvalidInput(
                "target_price must be greater than zero".to_string(),
            )
            .into());
        }
        input.target_price = target.normalize().to_string();

        let duplicate_exists = self.repository.list_alerts()?.into_iter().any(|alert| {
            alert.asset_id == input.asset_id
                && alert.condition == input.condition
                && alert.target_price == input.target_price
        });
        if duplicate_exists {
            return Err(ValidationError::InvalidInput(
                "An identical price alert already exists".to_string(),
            )
            .into());
        }

        let asset = self.asset_repository.get_by_id(&input.asset_id)?;
        if let Ok(current) = self.quote_service.get_latest_quote(&asset.id) {
            let already_satisfied = match input.condition {
                PriceAlertCondition::Above => current.close >= target,
                PriceAlertCondition::Below => current.close <= target,
            };
            if already_satisfied {
                return Err(ValidationError::InvalidInput(
                    "The target is already satisfied by the latest price".to_string(),
                )
                .into());
            }
        }

        let armed_market_date =
            time_utils::market_effective_date(Utc::now(), asset.instrument_exchange_mic.as_deref());
        self.repository
            .create_alert(input, asset.quote_ccy, armed_market_date)
            .await
    }

    async fn pause_alert(&self, alert_id: &str) -> Result<PriceAlert> {
        self.repository
            .set_status(
                alert_id,
                PriceAlertStatus::Paused,
                Some("USER_PAUSED".to_string()),
                None,
            )
            .await
    }

    async fn rearm_alert(&self, alert_id: &str) -> Result<PriceAlert> {
        let alert = self
            .repository
            .list_alerts()?
            .into_iter()
            .find(|alert| alert.id == alert_id)
            .ok_or_else(|| ValidationError::InvalidInput("Price alert not found".to_string()))?;
        let asset = self.asset_repository.get_by_id(&alert.asset_id)?;
        if let Ok(current) = self.quote_service.get_latest_quote(&asset.id) {
            if Self::latest_close_satisfies(&alert, &current)? {
                return Err(ValidationError::InvalidInput(
                    "The target is already satisfied by the latest price".to_string(),
                )
                .into());
            }
        }
        let armed_market_date =
            time_utils::market_effective_date(Utc::now(), asset.instrument_exchange_mic.as_deref());
        self.repository
            .set_status(
                alert_id,
                PriceAlertStatus::Active,
                None,
                Some(armed_market_date),
            )
            .await
    }

    async fn delete_alert(&self, alert_id: &str) -> Result<()> {
        self.repository.delete_alert(alert_id).await
    }

    async fn acknowledge_events(&self, event_ids: Option<Vec<String>>) -> Result<usize> {
        self.repository.acknowledge_events(event_ids).await
    }

    async fn evaluate(&self, asset_ids: Option<Vec<String>>) -> Result<Vec<PriceAlertEvent>> {
        let alerts = self.repository.list_active_alerts(asset_ids.as_deref())?;
        let mut triggered = Vec::new();

        for alert in alerts {
            let mut quotes = self.quote_service.get_historical_quotes(&alert.asset_id)?;
            quotes.sort_by_key(|quote| quote.timestamp);
            for quote in quotes {
                if !Self::quote_triggers(&alert, &quote)? {
                    continue;
                }

                let event = NewPriceAlertEvent {
                    id: format!("{}:{}", alert.id, quote.id),
                    alert_id: alert.id.clone(),
                    asset_id: alert.asset_id.clone(),
                    quote_id: quote.id.clone(),
                    target_price: alert.target_price.clone(),
                    observed_close: quote.close.to_string(),
                    observed_high: quote.high.to_string(),
                    observed_low: quote.low.to_string(),
                    currency: quote.currency.clone(),
                    quote_timestamp: quote.timestamp,
                    triggered_at: Utc::now(),
                };
                if let Some(event) = self.repository.trigger_alert(&alert.id, event).await? {
                    triggered.push(event);
                }
                break;
            }
        }

        Ok(triggered)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Utc};
    use rust_decimal_macros::dec;

    fn alert(condition: PriceAlertCondition, armed_market_date: chrono::NaiveDate) -> PriceAlert {
        PriceAlert {
            id: "alert-1".to_string(),
            asset_id: "asset-1".to_string(),
            condition,
            target_price: "100".to_string(),
            currency: "USD".to_string(),
            status: PriceAlertStatus::Active,
            armed_at: Utc::now(),
            armed_market_date,
            pause_reason: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    fn quote(day: u32, close: Decimal, high: Decimal, low: Decimal) -> Quote {
        Quote {
            id: format!("quote-{day}"),
            asset_id: "asset-1".to_string(),
            timestamp: Utc.with_ymd_and_hms(2026, 8, day, 20, 0, 0).unwrap(),
            open: close,
            high,
            low,
            close,
            adjclose: close,
            volume: Decimal::ZERO,
            currency: "USD".to_string(),
            data_source: "TEST".to_string(),
            created_at: Utc::now(),
            notes: None,
        }
    }

    #[test]
    fn ignores_historical_quotes_before_alert_was_armed() {
        let alert = alert(
            PriceAlertCondition::Above,
            chrono::NaiveDate::from_ymd_opt(2026, 8, 10).unwrap(),
        );
        assert!(!PriceAlertService::quote_triggers(
            &alert,
            &quote(9, dec!(90), dec!(120), dec!(80))
        )
        .unwrap());
    }

    #[test]
    fn uses_close_on_the_day_the_alert_was_armed() {
        let alert = alert(
            PriceAlertCondition::Above,
            chrono::NaiveDate::from_ymd_opt(2026, 8, 10).unwrap(),
        );
        assert!(!PriceAlertService::quote_triggers(
            &alert,
            &quote(10, dec!(95), dec!(110), dec!(90))
        )
        .unwrap());
    }

    #[test]
    fn uses_daily_high_and_low_after_the_armed_day() {
        let armed = chrono::NaiveDate::from_ymd_opt(2026, 8, 10).unwrap();
        assert!(PriceAlertService::quote_triggers(
            &alert(PriceAlertCondition::Above, armed),
            &quote(11, dec!(95), dec!(100), dec!(90))
        )
        .unwrap());
        assert!(PriceAlertService::quote_triggers(
            &alert(PriceAlertCondition::Below, armed),
            &quote(11, dec!(105), dec!(110), dec!(100))
        )
        .unwrap());
    }

    #[test]
    fn latest_close_satisfaction_matches_condition() {
        let armed = chrono::NaiveDate::from_ymd_opt(2026, 8, 10).unwrap();
        let latest = quote(10, dec!(100), dec!(101), dec!(99));
        assert!(PriceAlertService::latest_close_satisfies(
            &alert(PriceAlertCondition::Above, armed),
            &latest,
        )
        .unwrap());
        assert!(PriceAlertService::latest_close_satisfies(
            &alert(PriceAlertCondition::Below, armed),
            &latest,
        )
        .unwrap());
    }
}
