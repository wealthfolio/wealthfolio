use wealthfolio_core::assets::{AssetKind, NewAsset};
use wealthfolio_core::errors::{DatabaseError, ValidationError};
use wealthfolio_core::fx::{ExchangeRate, FxRepositoryTrait};
use wealthfolio_core::quotes::constants::DATA_SOURCE_MANUAL;
use wealthfolio_core::quotes::Quote;
use wealthfolio_core::{Error, Result};

use crate::assets::{AssetDB, InsertableAssetDB};
use crate::db::get_connection;
use crate::db::WriteHandle;
use crate::errors::StorageError;
use crate::market_data::QuoteDB;
use crate::schema::{assets, quotes};
use async_trait::async_trait;
use chrono::{DateTime, NaiveDate, NaiveDateTime, TimeZone, Utc};
use diesel::prelude::*;
use diesel::r2d2::{ConnectionManager, Pool};
use diesel::sql_query;
use diesel::sqlite::SqliteConnection;
use rust_decimal::Decimal;
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Arc;

#[derive(Clone)]
pub struct FxRepository {
    pool: Arc<Pool<ConnectionManager<SqliteConnection>>>,
    writer: WriteHandle,
}

impl FxRepository {
    pub fn new(pool: Arc<Pool<ConnectionManager<SqliteConnection>>>, writer: WriteHandle) -> Self {
        Self { pool, writer }
    }

    pub fn get_all_currency_quotes(&self) -> Result<HashMap<String, Vec<Quote>>> {
        let mut conn = get_connection(&self.pool)?;

        let query = "
            SELECT q.*
            FROM quotes q
            INNER JOIN assets a ON q.asset_id = a.id
            WHERE a.kind = 'FX'
            ORDER BY q.asset_id, q.timestamp";

        let quotes_db: Vec<QuoteDB> = diesel::sql_query(query)
            .load(&mut conn)
            .map_err(StorageError::from)?;

        let mut grouped_quotes: HashMap<String, Vec<Quote>> = HashMap::with_capacity(100);
        for quote_db in quotes_db {
            let quote = Quote::from(quote_db);
            grouped_quotes
                .entry(quote.asset_id.clone())
                .or_default()
                .push(quote);
        }

        Ok(grouped_quotes)
    }

    pub fn get_latest_currency_rates(&self) -> Result<HashMap<String, Decimal>> {
        let mut conn = get_connection(&self.pool)?;

        let query = "
            WITH LatestQuotes AS (
                SELECT q.*
                FROM quotes q
                INNER JOIN assets a ON q.asset_id = a.id
                WHERE a.kind = 'FX'
                AND (q.asset_id, q.timestamp) IN (
                    SELECT asset_id, MAX(timestamp)
                    FROM quotes
                    GROUP BY asset_id
                )
            )
            SELECT * FROM LatestQuotes";

        let quotes_db: Vec<QuoteDB> = diesel::sql_query(query)
            .load(&mut conn)
            .map_err(StorageError::from)?;

        Ok(quotes_db
            .into_iter()
            .map(|q| {
                (
                    q.asset_id,
                    Decimal::from_str(&q.close).unwrap_or_else(|_| Decimal::from(0)),
                )
            })
            .collect())
    }

    pub fn get_exchange_rates(&self) -> Result<Vec<ExchangeRate>> {
        let mut conn = get_connection(&self.pool)?;

        let forex_assets = assets::table
            .filter(assets::kind.eq(AssetKind::Fx.as_db_str()))
            .order_by(assets::display_code.asc())
            .load::<AssetDB>(&mut conn)
            .map_err(StorageError::from)?;

        let latest_quotes = sql_query(
            r#"SELECT
                q.id, q.asset_id, q.day, q.source, q.open, q.high, q.low, q.close, q.adjclose, q.volume,
                q.currency, q.notes, q.created_at, q.timestamp
             FROM quotes q
             WHERE q.asset_id IN (
                 SELECT id FROM assets WHERE kind = 'FX'
             )
             AND (q.asset_id, q.timestamp) IN (
                 SELECT asset_id, MAX(timestamp) as max_timestamp
                 FROM quotes
                 GROUP BY asset_id
             )
             ORDER BY q.asset_id"#,
        )
        .load::<QuoteDB>(&mut conn)
        .map_err(StorageError::from)?;

        let latest_quotes_by_id: HashMap<String, QuoteDB> = latest_quotes
            .into_iter()
            .map(|q| (q.asset_id.clone(), q))
            .collect();

        let mut exchange_rates = Vec::with_capacity(forex_assets.len());

        for asset in forex_assets {
            let from_currency = asset.instrument_symbol.clone().unwrap_or_default();
            let to_currency = asset.quote_ccy.clone();

            if let Some(quote_db) = latest_quotes_by_id.get(&asset.id) {
                let timestamp = chrono::DateTime::parse_from_rfc3339(&quote_db.timestamp)
                    .map(|dt| dt.with_timezone(&Utc))
                    .unwrap_or_else(|_| Utc::now());
                let rate = Decimal::from_str(&quote_db.close).unwrap_or(Decimal::ZERO);

                exchange_rates.push(ExchangeRate {
                    id: asset.id.clone(),
                    from_currency,
                    to_currency,
                    rate,
                    source: quote_db.source.clone(),
                    timestamp,
                });
            } else {
                let timestamp = chrono::DateTime::parse_from_rfc3339(&asset.updated_at)
                    .map(|dt| dt.with_timezone(&Utc))
                    .unwrap_or_else(|_| Utc::now());

                let preferred_provider = asset
                    .provider_config
                    .as_ref()
                    .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
                    .and_then(|v| v.get("preferred_provider")?.as_str().map(String::from));

                exchange_rates.push(ExchangeRate {
                    id: asset.id.clone(),
                    from_currency,
                    to_currency,
                    rate: Decimal::ZERO,
                    source: preferred_provider
                        .clone()
                        .unwrap_or_else(|| DATA_SOURCE_MANUAL.to_string()),
                    timestamp,
                });
            }
        }

        Ok(exchange_rates)
    }

    pub fn get_all_historical_exchange_rates(&self) -> Result<Vec<ExchangeRate>> {
        let mut conn = get_connection(&self.pool)?;

        let results: Vec<(QuoteDB, AssetDB)> = quotes::table
            .inner_join(assets::table.on(quotes::asset_id.eq(assets::id)))
            .filter(assets::kind.eq(AssetKind::Fx.as_db_str()))
            .select((quotes::all_columns, assets::all_columns))
            .order_by((quotes::asset_id.asc(), quotes::timestamp.asc()))
            .load(&mut conn)
            .map_err(StorageError::from)?;

        Ok(results
            .into_iter()
            .map(|(quote_db, asset_db)| {
                let timestamp = chrono::DateTime::parse_from_rfc3339(&quote_db.timestamp)
                    .map(|dt| dt.with_timezone(&Utc))
                    .unwrap_or_else(|_| Utc::now());
                let rate = Decimal::from_str(&quote_db.close).unwrap_or(Decimal::ZERO);

                ExchangeRate {
                    id: asset_db.id,
                    from_currency: asset_db.instrument_symbol.unwrap_or_default(),
                    to_currency: asset_db.quote_ccy,
                    rate,
                    source: quote_db.source.clone(),
                    timestamp,
                }
            })
            .collect())
    }

    pub fn get_exchange_rate(&self, from: &str, to: &str) -> Result<Option<ExchangeRate>> {
        let mut conn = get_connection(&self.pool)?;

        let expected_key = format!("FX:{}/{}", from, to);

        let result: Option<(QuoteDB, AssetDB)> = quotes::table
            .inner_join(assets::table.on(quotes::asset_id.eq(assets::id)))
            .filter(assets::instrument_key.eq(&expected_key))
            .order_by(quotes::timestamp.desc())
            .select((quotes::all_columns, assets::all_columns))
            .first(&mut conn)
            .optional()
            .map_err(StorageError::from)?;

        Ok(result.map(|(quote_db, asset_db)| {
            let timestamp = chrono::DateTime::parse_from_rfc3339(&quote_db.timestamp)
                .map(|dt| dt.with_timezone(&Utc))
                .unwrap_or_else(|_| Utc::now());
            let rate = Decimal::from_str(&quote_db.close).unwrap_or(Decimal::ZERO);

            ExchangeRate {
                id: asset_db.id,
                from_currency: asset_db.instrument_symbol.unwrap_or_default(),
                to_currency: asset_db.quote_ccy,
                rate,
                source: quote_db.source.clone(),
                timestamp,
            }
        }))
    }

    pub fn get_exchange_rate_by_id(&self, id: &str) -> Result<Option<ExchangeRate>> {
        let mut conn = get_connection(&self.pool)?;

        let result: Option<(QuoteDB, AssetDB)> = quotes::table
            .inner_join(assets::table.on(quotes::asset_id.eq(assets::id)))
            .filter(assets::instrument_key.eq(id).or(quotes::asset_id.eq(id)))
            .order_by(quotes::timestamp.desc())
            .select((quotes::all_columns, assets::all_columns))
            .first(&mut conn)
            .optional()
            .map_err(StorageError::from)?;

        Ok(result.map(|(quote_db, asset_db)| {
            let timestamp = chrono::DateTime::parse_from_rfc3339(&quote_db.timestamp)
                .map(|dt| dt.with_timezone(&Utc))
                .unwrap_or_else(|_| Utc::now());
            let rate = Decimal::from_str(&quote_db.close).unwrap_or(Decimal::ZERO);

            ExchangeRate {
                id: asset_db.id,
                from_currency: asset_db.instrument_symbol.unwrap_or_default(),
                to_currency: asset_db.quote_ccy,
                rate,
                source: quote_db.source.clone(),
                timestamp,
            }
        }))
    }

    pub fn get_historical_quotes(
        &self,
        symbol: &str,
        start_date: NaiveDateTime,
        end_date: NaiveDateTime,
    ) -> Result<Vec<Quote>> {
        let mut conn = get_connection(&self.pool)?;

        let start_dt_str = Utc.from_utc_datetime(&start_date).to_rfc3339();
        let end_dt_str = Utc.from_utc_datetime(&end_date).to_rfc3339();

        // symbol is an instrument_key (e.g., "FX:EUR/USD") or asset_id
        let asset_ids: Vec<String> = assets::table
            .filter(assets::instrument_key.eq(symbol).or(assets::id.eq(symbol)))
            .select(assets::id)
            .load(&mut conn)
            .map_err(StorageError::from)?;

        if asset_ids.is_empty() {
            return Ok(Vec::new());
        }

        let quotes_db = quotes::table
            .filter(quotes::asset_id.eq_any(&asset_ids))
            .filter(quotes::timestamp.ge(start_dt_str))
            .filter(quotes::timestamp.le(end_dt_str))
            .order_by(quotes::timestamp.asc())
            .load::<QuoteDB>(&mut conn)
            .map_err(StorageError::from)?;

        Ok(quotes_db.into_iter().map(Quote::from).collect())
    }

    pub async fn add_quote(
        &self,
        asset_id: String,
        date_str: String,
        rate: Decimal,
        source_str: String,
    ) -> Result<Quote> {
        self.writer
            .exec(move |conn| {
                let naive_date = NaiveDate::parse_from_str(&date_str, "%Y-%m-%d").map_err(|e| {
                    Error::Validation(ValidationError::InvalidInput(format!(
                        "Invalid date format: {}",
                        e
                    )))
                })?;
                let naive_datetime = naive_date.and_hms_opt(16, 0, 0).ok_or_else(|| {
                    Error::Validation(ValidationError::InvalidInput(format!(
                        "Failed to create NaiveDateTime for {}",
                        date_str
                    )))
                })?;
                let timestamp_utc: DateTime<Utc> = Utc.from_utc_datetime(&naive_datetime);
                let timestamp_str = timestamp_utc.to_rfc3339();
                let created_at_str = Utc::now().to_rfc3339();

                let asset: AssetDB = assets::table
                    .filter(assets::id.eq(&asset_id))
                    .first(conn)
                    .map_err(StorageError::from)?;

                let currency = asset.instrument_symbol.unwrap_or_default();
                let quote_id = format!("{}_{}_{}", asset_id, date_str, source_str);

                let quote_db = QuoteDB {
                    id: quote_id,
                    asset_id: asset_id.clone(),
                    day: date_str.clone(),
                    source: source_str.clone(),
                    open: Some(rate.to_string()),
                    high: Some(rate.to_string()),
                    low: Some(rate.to_string()),
                    close: rate.to_string(),
                    adjclose: Some(rate.to_string()),
                    volume: None,
                    currency,
                    created_at: created_at_str,
                    timestamp: timestamp_str.clone(),
                    notes: None,
                };

                diesel::insert_into(quotes::table)
                    .values(&quote_db)
                    .on_conflict(quotes::id)
                    .do_update()
                    .set((
                        quotes::close.eq(quote_db.close.clone()),
                        quotes::source.eq(&quote_db.source),
                    ))
                    .execute(conn)
                    .map_err(StorageError::from)?;

                quotes::table
                    .filter(quotes::asset_id.eq(&asset_id))
                    .filter(quotes::day.eq(&date_str))
                    .filter(quotes::source.eq(&source_str))
                    .first::<QuoteDB>(conn)
                    .map(Quote::from)
                    .map_err(|e| StorageError::from(e).into())
            })
            .await
    }

    pub async fn save_exchange_rate(&self, rate: ExchangeRate) -> Result<ExchangeRate> {
        self.writer
            .exec(move |conn| {
                let quote = rate.to_quote();
                let quote_db = QuoteDB::from(&quote);

                diesel::insert_into(quotes::table)
                    .values(&quote_db)
                    .on_conflict(quotes::id)
                    .do_update()
                    .set((
                        quotes::open.eq(quote_db.open.clone()),
                        quotes::high.eq(quote_db.high.clone()),
                        quotes::low.eq(quote_db.low.clone()),
                        quotes::close.eq(quote_db.close.clone()),
                        quotes::adjclose.eq(quote_db.adjclose.clone()),
                        quotes::volume.eq(quote_db.volume.clone()),
                        quotes::source.eq(&quote_db.source),
                    ))
                    .execute(conn)
                    .map_err(StorageError::from)?;

                // Return the rate directly — no need to read back
                Ok(rate)
            })
            .await
    }

    pub async fn update_exchange_rate(&self, rate: &ExchangeRate) -> Result<ExchangeRate> {
        let rate_owned = rate.clone();
        self.writer
            .exec(move |conn| {
                let quote = rate_owned.to_quote();
                let quote_db = QuoteDB::from(&quote);

                let updated = diesel::update(quotes::table)
                    .filter(quotes::asset_id.eq(&quote_db.asset_id))
                    .filter(quotes::day.eq(&quote_db.day))
                    .set((
                        quotes::close.eq(quote_db.close.clone()),
                        quotes::source.eq(&quote_db.source),
                    ))
                    .execute(conn)
                    .map_err(StorageError::from)?;

                if updated == 0 {
                    return Err(Error::Database(DatabaseError::NotFound(format!(
                        "Exchange rate quote not found for asset {}",
                        quote_db.asset_id
                    ))));
                }

                Ok(rate_owned)
            })
            .await
    }

    pub async fn delete_exchange_rate(&self, rate_id: &str) -> Result<()> {
        let rate_id_owned = rate_id.to_string();
        self.writer
            .exec_tx(move |tx| {
                diesel::delete(quotes::table.filter(quotes::asset_id.eq(&rate_id_owned)))
                    .execute(tx.conn())
                    .map_err(StorageError::from)?;

                let assets_deleted =
                    diesel::delete(assets::table.filter(assets::id.eq(&rate_id_owned)))
                        .execute(tx.conn())
                        .map_err(StorageError::from)?;

                if assets_deleted > 0 {
                    tx.delete::<AssetDB>(rate_id_owned.clone());
                }

                Ok(())
            })
            .await
    }

    /// Creates or updates an FX asset in the database.
    /// Returns the asset UUID.
    pub async fn create_fx_asset(&self, from: &str, to: &str, source: &str) -> Result<String> {
        let from_owned = from.to_string();
        let to_owned = to.to_string();
        let source_owned = source.to_string();

        self.writer
            .exec_tx(move |tx| {
                let expected_key = format!("FX:{}/{}", from_owned, to_owned);
                let existing: Option<AssetDB> = assets::table
                    .filter(assets::instrument_key.eq(&expected_key))
                    .first(tx.conn())
                    .optional()
                    .map_err(StorageError::from)?;

                if let Some(existing_asset) = existing {
                    Ok(existing_asset.id)
                } else {
                    let new_asset = NewAsset::new_fx_asset(&from_owned, &to_owned, &source_owned);
                    let asset_db: InsertableAssetDB = new_asset.into();

                    diesel::insert_into(assets::table)
                        .values(&asset_db)
                        .execute(tx.conn())
                        .map_err(StorageError::from)?;

                    // Read back to get the DB-generated UUID
                    let inserted: AssetDB = assets::table
                        .filter(assets::instrument_key.eq(&expected_key))
                        .first(tx.conn())
                        .map_err(StorageError::from)?;

                    tx.insert(&inserted)?;

                    Ok(inserted.id)
                }
            })
            .await
    }
}

#[async_trait]
impl FxRepositoryTrait for FxRepository {
    fn get_latest_exchange_rates(&self) -> Result<Vec<ExchangeRate>> {
        self.get_exchange_rates()
    }

    fn get_historical_exchange_rates(&self) -> Result<Vec<ExchangeRate>> {
        self.get_all_historical_exchange_rates()
    }

    fn get_latest_exchange_rate(&self, from: &str, to: &str) -> Result<Option<ExchangeRate>> {
        self.get_exchange_rate(from, to)
    }

    fn get_latest_exchange_rate_by_symbol(&self, symbol: &str) -> Result<Option<ExchangeRate>> {
        self.get_exchange_rate_by_id(symbol)
    }

    fn get_historical_quotes(
        &self,
        symbol: &str,
        start_date: NaiveDateTime,
        end_date: NaiveDateTime,
    ) -> Result<Vec<Quote>> {
        self.get_historical_quotes(symbol, start_date, end_date)
    }

    async fn add_quote(
        &self,
        symbol: String,
        date: String,
        rate: Decimal,
        source: String,
    ) -> Result<Quote> {
        self.add_quote(symbol, date, rate, source).await
    }

    async fn save_exchange_rate(&self, rate: ExchangeRate) -> Result<ExchangeRate> {
        self.save_exchange_rate(rate).await
    }

    async fn update_exchange_rate(&self, rate: &ExchangeRate) -> Result<ExchangeRate> {
        self.update_exchange_rate(rate).await
    }

    async fn delete_exchange_rate(&self, rate_id: &str) -> Result<()> {
        self.delete_exchange_rate(rate_id).await
    }

    async fn create_fx_asset(
        &self,
        from_currency: &str,
        to_currency: &str,
        source: &str,
    ) -> Result<String> {
        self.create_fx_asset(from_currency, to_currency, source)
            .await
    }
}
