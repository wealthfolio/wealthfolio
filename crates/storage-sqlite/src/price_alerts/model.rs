use std::str::FromStr;

use chrono::{DateTime, NaiveDate, Utc};
use diesel::prelude::*;
use wealthfolio_core::{
    errors::Result,
    price_alerts::{PriceAlert, PriceAlertCondition, PriceAlertEvent, PriceAlertStatus},
};

#[derive(Debug, Clone, Queryable, Selectable, Identifiable)]
#[diesel(table_name = crate::schema::price_alerts)]
pub struct PriceAlertDB {
    pub id: String,
    pub asset_id: String,
    pub condition: String,
    pub target_price: String,
    pub currency: String,
    pub status: String,
    pub armed_at: String,
    pub armed_market_date: String,
    pub pause_reason: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl TryFrom<PriceAlertDB> for PriceAlert {
    type Error = wealthfolio_core::Error;

    fn try_from(db: PriceAlertDB) -> Result<Self> {
        Ok(Self {
            id: db.id,
            asset_id: db.asset_id,
            condition: PriceAlertCondition::from_str(&db.condition)?,
            target_price: db.target_price,
            currency: db.currency,
            status: PriceAlertStatus::from_str(&db.status)?,
            armed_at: DateTime::parse_from_rfc3339(&db.armed_at)?.with_timezone(&Utc),
            armed_market_date: NaiveDate::parse_from_str(&db.armed_market_date, "%Y-%m-%d")?,
            pause_reason: db.pause_reason,
            created_at: DateTime::parse_from_rfc3339(&db.created_at)?.with_timezone(&Utc),
            updated_at: DateTime::parse_from_rfc3339(&db.updated_at)?.with_timezone(&Utc),
        })
    }
}

#[derive(Debug, Clone, Queryable, Selectable, Identifiable)]
#[diesel(table_name = crate::schema::price_alert_events)]
pub struct PriceAlertEventDB {
    pub id: String,
    pub alert_id: String,
    pub asset_id: String,
    pub quote_id: String,
    pub target_price: String,
    pub observed_close: String,
    pub observed_high: String,
    pub observed_low: String,
    pub currency: String,
    pub quote_timestamp: String,
    pub triggered_at: String,
    pub acknowledged_at: Option<String>,
}

impl TryFrom<PriceAlertEventDB> for PriceAlertEvent {
    type Error = wealthfolio_core::Error;

    fn try_from(db: PriceAlertEventDB) -> Result<Self> {
        Ok(Self {
            id: db.id,
            alert_id: db.alert_id,
            asset_id: db.asset_id,
            quote_id: db.quote_id,
            target_price: db.target_price,
            observed_close: db.observed_close,
            observed_high: db.observed_high,
            observed_low: db.observed_low,
            currency: db.currency,
            quote_timestamp: DateTime::parse_from_rfc3339(&db.quote_timestamp)?.with_timezone(&Utc),
            triggered_at: DateTime::parse_from_rfc3339(&db.triggered_at)?.with_timezone(&Utc),
            acknowledged_at: db
                .acknowledged_at
                .map(|value| DateTime::parse_from_rfc3339(&value).map(|dt| dt.with_timezone(&Utc)))
                .transpose()?,
        })
    }
}
