use async_trait::async_trait;
use chrono::Utc;
use diesel::prelude::*;
use std::sync::Arc;
use uuid::Uuid;
use wealthfolio_core::{
    price_alerts::{
        NewPriceAlert, NewPriceAlertEvent, PriceAlert, PriceAlertEvent, PriceAlertRepositoryTrait,
        PriceAlertStatus,
    },
    Result,
};

use super::model::{PriceAlertDB, PriceAlertEventDB};
use crate::{
    db::{get_connection, DbPool, WriteHandle},
    errors::StorageError,
    schema::{price_alert_events, price_alerts},
};

pub struct PriceAlertRepository {
    pool: Arc<DbPool>,
    writer: WriteHandle,
}

impl PriceAlertRepository {
    pub fn new(pool: Arc<DbPool>, writer: WriteHandle) -> Self {
        Self { pool, writer }
    }

    fn convert_alerts(rows: Vec<PriceAlertDB>) -> Result<Vec<PriceAlert>> {
        rows.into_iter().map(PriceAlert::try_from).collect()
    }

    fn convert_events(rows: Vec<PriceAlertEventDB>) -> Result<Vec<PriceAlertEvent>> {
        rows.into_iter().map(PriceAlertEvent::try_from).collect()
    }
}

#[async_trait]
impl PriceAlertRepositoryTrait for PriceAlertRepository {
    fn list_alerts(&self) -> Result<Vec<PriceAlert>> {
        let mut conn = get_connection(&self.pool)?;
        let rows = price_alerts::table
            .order(price_alerts::created_at.desc())
            .select(PriceAlertDB::as_select())
            .load(&mut conn)
            .map_err(StorageError::from)?;
        Self::convert_alerts(rows)
    }

    fn list_active_alerts(&self, asset_ids: Option<&[String]>) -> Result<Vec<PriceAlert>> {
        let mut conn = get_connection(&self.pool)?;
        let mut query = price_alerts::table
            .filter(price_alerts::status.eq(PriceAlertStatus::Active.as_str()))
            .into_boxed();
        if let Some(ids) = asset_ids {
            query = query.filter(price_alerts::asset_id.eq_any(ids));
        }
        let rows = query
            .select(PriceAlertDB::as_select())
            .load(&mut conn)
            .map_err(StorageError::from)?;
        Self::convert_alerts(rows)
    }

    fn list_events(&self, unacknowledged_only: bool) -> Result<Vec<PriceAlertEvent>> {
        let mut conn = get_connection(&self.pool)?;
        let mut query = price_alert_events::table.into_boxed();
        if unacknowledged_only {
            query = query.filter(price_alert_events::acknowledged_at.is_null());
        }
        let rows = query
            .order(price_alert_events::triggered_at.desc())
            .select(PriceAlertEventDB::as_select())
            .load(&mut conn)
            .map_err(StorageError::from)?;
        Self::convert_events(rows)
    }

    fn count_unacknowledged_events(&self) -> Result<i64> {
        let mut conn = get_connection(&self.pool)?;
        price_alert_events::table
            .filter(price_alert_events::acknowledged_at.is_null())
            .count()
            .get_result(&mut conn)
            .map_err(StorageError::from)
            .map_err(Into::into)
    }

    async fn create_alert(
        &self,
        input: NewPriceAlert,
        currency: String,
        armed_market_date: chrono::NaiveDate,
    ) -> Result<PriceAlert> {
        self.writer
            .exec(move |conn| {
                let target_price = input.target_price.trim().to_string();
                let existing = price_alerts::table
                    .filter(price_alerts::asset_id.eq(&input.asset_id))
                    .filter(price_alerts::condition.eq(input.condition.as_str()))
                    .filter(price_alerts::target_price.eq(&target_price))
                    .select(PriceAlertDB::as_select())
                    .first(conn)
                    .optional()
                    .map_err(StorageError::from)?;
                if let Some(existing) = existing {
                    return PriceAlert::try_from(existing);
                }

                let now = Utc::now().to_rfc3339();
                let db = diesel::insert_into(price_alerts::table)
                    .values((
                        price_alerts::id.eq(Uuid::now_v7().to_string()),
                        price_alerts::asset_id.eq(input.asset_id),
                        price_alerts::condition.eq(input.condition.as_str()),
                        price_alerts::target_price.eq(target_price),
                        price_alerts::currency.eq(currency),
                        price_alerts::status.eq(PriceAlertStatus::Active.as_str()),
                        price_alerts::armed_at.eq(&now),
                        price_alerts::armed_market_date.eq(armed_market_date.to_string()),
                        price_alerts::pause_reason.eq::<Option<String>>(None),
                        price_alerts::created_at.eq(&now),
                        price_alerts::updated_at.eq(&now),
                    ))
                    .returning(PriceAlertDB::as_returning())
                    .get_result(conn)
                    .map_err(StorageError::from)?;
                PriceAlert::try_from(db)
            })
            .await
    }

    async fn set_status(
        &self,
        alert_id: &str,
        status: PriceAlertStatus,
        pause_reason: Option<String>,
        armed_market_date: Option<chrono::NaiveDate>,
    ) -> Result<PriceAlert> {
        let alert_id = alert_id.to_string();
        self.writer
            .exec(move |conn| {
                let now = Utc::now().to_rfc3339();
                let target = price_alerts::table.find(alert_id);
                let db = if let Some(armed_market_date) = armed_market_date {
                    diesel::update(target)
                        .set((
                            price_alerts::status.eq(status.as_str()),
                            price_alerts::pause_reason.eq(pause_reason),
                            price_alerts::armed_at.eq(&now),
                            price_alerts::armed_market_date.eq(armed_market_date.to_string()),
                            price_alerts::updated_at.eq(&now),
                        ))
                        .returning(PriceAlertDB::as_returning())
                        .get_result(conn)
                        .map_err(StorageError::from)?
                } else {
                    diesel::update(target)
                        .set((
                            price_alerts::status.eq(status.as_str()),
                            price_alerts::pause_reason.eq(pause_reason),
                            price_alerts::updated_at.eq(&now),
                        ))
                        .returning(PriceAlertDB::as_returning())
                        .get_result(conn)
                        .map_err(StorageError::from)?
                };
                PriceAlert::try_from(db)
            })
            .await
    }

    async fn delete_alert(&self, alert_id: &str) -> Result<()> {
        let alert_id = alert_id.to_string();
        self.writer
            .exec(move |conn| {
                diesel::delete(price_alerts::table.find(alert_id))
                    .execute(conn)
                    .map_err(StorageError::from)?;
                Ok(())
            })
            .await
    }

    async fn acknowledge_events(&self, event_ids: Option<Vec<String>>) -> Result<usize> {
        self.writer
            .exec(move |conn| {
                let now = Utc::now().to_rfc3339();
                let count = match event_ids {
                    Some(ids) if ids.is_empty() => 0,
                    Some(ids) => diesel::update(
                        price_alert_events::table.filter(price_alert_events::id.eq_any(ids)),
                    )
                    .set(price_alert_events::acknowledged_at.eq(Some(now)))
                    .execute(conn)
                    .map_err(StorageError::from)?,
                    None => diesel::update(
                        price_alert_events::table
                            .filter(price_alert_events::acknowledged_at.is_null()),
                    )
                    .set(price_alert_events::acknowledged_at.eq(Some(now)))
                    .execute(conn)
                    .map_err(StorageError::from)?,
                };
                Ok(count)
            })
            .await
    }

    async fn trigger_alert(
        &self,
        alert_id: &str,
        event: NewPriceAlertEvent,
    ) -> Result<Option<PriceAlertEvent>> {
        let alert_id = alert_id.to_string();
        self.writer
            .exec_tx(move |tx| {
                let conn = tx.conn();
                let status = price_alerts::table
                    .find(&alert_id)
                    .select(price_alerts::status)
                    .first::<String>(conn)
                    .map_err(StorageError::from)?;
                if status != PriceAlertStatus::Active.as_str() {
                    return Ok(None);
                }

                let exists = price_alert_events::table
                    .find(&event.id)
                    .select(price_alert_events::id)
                    .first::<String>(conn)
                    .optional()
                    .map_err(StorageError::from)?
                    .is_some();
                if exists {
                    return Ok(None);
                }

                let db = diesel::insert_into(price_alert_events::table)
                    .values((
                        price_alert_events::id.eq(event.id),
                        price_alert_events::alert_id.eq(&event.alert_id),
                        price_alert_events::asset_id.eq(event.asset_id),
                        price_alert_events::quote_id.eq(event.quote_id),
                        price_alert_events::target_price.eq(event.target_price),
                        price_alert_events::observed_close.eq(event.observed_close),
                        price_alert_events::observed_high.eq(event.observed_high),
                        price_alert_events::observed_low.eq(event.observed_low),
                        price_alert_events::currency.eq(event.currency),
                        price_alert_events::quote_timestamp.eq(event.quote_timestamp.to_rfc3339()),
                        price_alert_events::triggered_at.eq(event.triggered_at.to_rfc3339()),
                        price_alert_events::acknowledged_at.eq::<Option<String>>(None),
                    ))
                    .returning(PriceAlertEventDB::as_returning())
                    .get_result(conn)
                    .map_err(StorageError::from)?;

                diesel::update(price_alerts::table.find(&alert_id))
                    .set((
                        price_alerts::status.eq(PriceAlertStatus::Triggered.as_str()),
                        price_alerts::updated_at.eq(Utc::now().to_rfc3339()),
                    ))
                    .execute(conn)
                    .map_err(StorageError::from)?;

                Ok(Some(PriceAlertEvent::try_from(db)?))
            })
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{create_pool, get_connection, init, run_migrations, write_actor::spawn_writer};
    use chrono::{TimeZone, Utc};
    use diesel::{sql_query, sql_types::Text};
    use tempfile::tempdir;
    use wealthfolio_core::price_alerts::{NewPriceAlert, PriceAlertCondition};

    fn setup_repository() -> PriceAlertRepository {
        std::env::set_var("CONNECT_API_URL", "http://test.local");
        let app_data = tempdir()
            .expect("tempdir")
            .keep()
            .to_string_lossy()
            .to_string();
        let db_path = init(&app_data).expect("init db");
        run_migrations(&db_path).expect("migrate db");
        let pool = create_pool(&db_path).expect("create pool");
        let writer = spawn_writer(pool.as_ref().clone()).expect("spawn writer");

        let mut conn = get_connection(&pool).expect("connection");
        sql_query(
            "INSERT INTO assets (
                id, kind, name, display_code, is_active, quote_mode, quote_ccy,
                created_at, updated_at
             ) VALUES (?, 'INVESTMENT', 'Apple', 'AAPL', 1, 'MARKET', 'USD',
                CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
        )
        .bind::<Text, _>("asset-1")
        .execute(&mut conn)
        .expect("insert asset");
        drop(conn);

        PriceAlertRepository::new(pool, writer)
    }

    #[tokio::test]
    async fn triggering_is_atomic_and_deduplicated() {
        let repository = setup_repository();
        let alert = repository
            .create_alert(
                NewPriceAlert {
                    asset_id: "asset-1".to_string(),
                    condition: PriceAlertCondition::Above,
                    target_price: "100".to_string(),
                },
                "USD".to_string(),
                chrono::NaiveDate::from_ymd_opt(2026, 8, 16).unwrap(),
            )
            .await
            .expect("create alert");
        let event = NewPriceAlertEvent {
            id: format!("{}:quote-1", alert.id),
            alert_id: alert.id.clone(),
            asset_id: alert.asset_id.clone(),
            quote_id: "quote-1".to_string(),
            target_price: alert.target_price.clone(),
            observed_close: "101".to_string(),
            observed_high: "102".to_string(),
            observed_low: "99".to_string(),
            currency: "USD".to_string(),
            quote_timestamp: Utc.with_ymd_and_hms(2026, 8, 17, 20, 0, 0).unwrap(),
            triggered_at: Utc.with_ymd_and_hms(2026, 8, 17, 20, 1, 0).unwrap(),
        };

        assert!(repository
            .trigger_alert(&alert.id, event.clone())
            .await
            .expect("first trigger")
            .is_some());
        assert!(repository
            .trigger_alert(&alert.id, event)
            .await
            .expect("duplicate trigger")
            .is_none());

        let stored = repository.list_alerts().expect("list alerts");
        assert_eq!(stored[0].status, PriceAlertStatus::Triggered);
        assert_eq!(repository.count_unacknowledged_events().unwrap(), 1);
    }

    #[tokio::test]
    async fn identical_alert_creation_is_idempotent() {
        let repository = setup_repository();
        let input = NewPriceAlert {
            asset_id: "asset-1".to_string(),
            condition: PriceAlertCondition::Above,
            target_price: "100".to_string(),
        };
        let market_date = chrono::NaiveDate::from_ymd_opt(2026, 8, 16).unwrap();

        let first = repository
            .create_alert(input.clone(), "USD".to_string(), market_date)
            .await
            .expect("first create");
        let duplicate = repository
            .create_alert(input, "USD".to_string(), market_date)
            .await
            .expect("duplicate create");

        assert_eq!(duplicate.id, first.id);
        assert_eq!(repository.list_alerts().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn pause_preserves_arming_date_and_rearm_updates_it() {
        let repository = setup_repository();
        let original_market_date = chrono::NaiveDate::from_ymd_opt(2026, 8, 15).unwrap();
        let alert = repository
            .create_alert(
                NewPriceAlert {
                    asset_id: "asset-1".to_string(),
                    condition: PriceAlertCondition::Above,
                    target_price: "100".to_string(),
                },
                "USD".to_string(),
                original_market_date,
            )
            .await
            .expect("create alert");

        let paused = repository
            .set_status(
                &alert.id,
                PriceAlertStatus::Paused,
                Some("USER_PAUSED".to_string()),
                None,
            )
            .await
            .expect("pause alert");
        assert_eq!(paused.status, PriceAlertStatus::Paused);
        assert_eq!(paused.armed_market_date, original_market_date);
        assert_eq!(paused.pause_reason.as_deref(), Some("USER_PAUSED"));

        let rearmed_market_date = chrono::NaiveDate::from_ymd_opt(2026, 8, 18).unwrap();
        let rearmed = repository
            .set_status(
                &alert.id,
                PriceAlertStatus::Active,
                None,
                Some(rearmed_market_date),
            )
            .await
            .expect("rearm alert");
        assert_eq!(rearmed.status, PriceAlertStatus::Active);
        assert_eq!(rearmed.armed_market_date, rearmed_market_date);
        assert!(rearmed.pause_reason.is_none());
    }

    #[tokio::test]
    async fn acknowledges_selected_events_without_marking_others_read() {
        let repository = setup_repository();
        let market_date = chrono::NaiveDate::from_ymd_opt(2026, 8, 16).unwrap();

        for (target, quote_id) in [("100", "quote-1"), ("110", "quote-2")] {
            let alert = repository
                .create_alert(
                    NewPriceAlert {
                        asset_id: "asset-1".to_string(),
                        condition: PriceAlertCondition::Above,
                        target_price: target.to_string(),
                    },
                    "USD".to_string(),
                    market_date,
                )
                .await
                .expect("create alert");
            repository
                .trigger_alert(
                    &alert.id,
                    NewPriceAlertEvent {
                        id: format!("{}:{quote_id}", alert.id),
                        alert_id: alert.id.clone(),
                        asset_id: alert.asset_id,
                        quote_id: quote_id.to_string(),
                        target_price: target.to_string(),
                        observed_close: target.to_string(),
                        observed_high: target.to_string(),
                        observed_low: target.to_string(),
                        currency: "USD".to_string(),
                        quote_timestamp: Utc.with_ymd_and_hms(2026, 8, 17, 20, 0, 0).unwrap(),
                        triggered_at: Utc.with_ymd_and_hms(2026, 8, 17, 20, 1, 0).unwrap(),
                    },
                )
                .await
                .expect("trigger alert");
        }

        let unread = repository.list_events(true).expect("list unread events");
        assert_eq!(unread.len(), 2);
        assert_eq!(
            repository
                .acknowledge_events(Some(vec![unread[0].id.clone()]))
                .await
                .expect("acknowledge selected"),
            1
        );
        assert_eq!(repository.count_unacknowledged_events().unwrap(), 1);
        assert_eq!(
            repository
                .acknowledge_events(None)
                .await
                .expect("acknowledge remaining"),
            1
        );
        assert_eq!(repository.count_unacknowledged_events().unwrap(), 0);
    }
}
