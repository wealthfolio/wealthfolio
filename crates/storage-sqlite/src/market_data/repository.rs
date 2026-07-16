use async_trait::async_trait;
use chrono::NaiveDate;
use diesel::prelude::*;
use diesel::r2d2::{ConnectionManager, Pool};
use diesel::sql_query;
use diesel::sql_types::{Integer, Text};
use diesel::sqlite::Sqlite;
use diesel::sqlite::SqliteConnection;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use super::model::{MarketDataProviderSettingDB, QuoteDB, UpdateMarketDataProviderSettingDB};
use crate::db::{get_connection, WriteHandle};
use crate::errors::{IntoCore, StorageError};
use crate::schema::market_data_providers::dsl as market_data_providers_dsl;
use crate::schema::quotes::dsl as quotes_dsl;
use crate::utils::chunk_for_sqlite;
use wealthfolio_core::quotes::store::{ProviderSettingsStore, QuoteStore};
use wealthfolio_core::quotes::types::{AssetId, Day, QuoteSource};
use wealthfolio_core::quotes::{
    LatestQuotePair, MarketDataProviderSetting, Quote, UpdateMarketDataProviderSetting,
};
use wealthfolio_core::Result;

// Source priority for tie-breaking latest-quote lookups on the same `day`.
// MANUAL wins (explicit user override), then providers / others, then
// BROKER. Broker trade prices are useful fallbacks, but should not shadow a
// provider quote for the same day.
// Unqualified column form — for use inside diesel typed queries.
const SOURCE_PRIORITY_CASE: &str =
    "CASE source WHEN 'MANUAL' THEN 1 WHEN 'BROKER' THEN 3 ELSE 2 END";
// Same expression qualified with table alias `q` — for use inside raw window
// function SQL (`ROW_NUMBER() OVER (... ORDER BY ...)`).
const SOURCE_PRIORITY_CASE_Q: &str =
    "CASE q.source WHEN 'MANUAL' THEN 1 WHEN 'BROKER' THEN 3 ELSE 2 END";

pub struct MarketDataRepository {
    pool: Arc<Pool<ConnectionManager<SqliteConnection>>>,
    writer: WriteHandle,
}

impl MarketDataRepository {
    pub fn new(pool: Arc<Pool<ConnectionManager<SqliteConnection>>>, writer: WriteHandle) -> Self {
        Self { pool, writer }
    }
}

// =============================================================================
// QuoteStore Implementation
// =============================================================================

#[async_trait]
impl QuoteStore for MarketDataRepository {
    // =========================================================================
    // Mutations
    // =========================================================================

    async fn save_quote(&self, quote: &Quote) -> Result<Quote> {
        let quote_cloned = quote.clone();
        let db_row = QuoteDB::from(&quote_cloned);

        let saved_row = self
            .writer
            .exec_tx(move |tx| -> Result<QuoteDB> {
                let mut payload = db_row;
                let existing = quotes_dsl::quotes
                    .filter(quotes_dsl::asset_id.eq(&payload.asset_id))
                    .filter(quotes_dsl::day.eq(&payload.day))
                    .filter(quotes_dsl::source.eq(&payload.source))
                    .select(QuoteDB::as_select())
                    .first::<QuoteDB>(tx.conn())
                    .optional()
                    .map_err(StorageError::QueryFailed)?;

                let is_update = existing.is_some();
                if let Some(existing_row) = existing {
                    payload.id = existing_row.id;
                }

                diesel::replace_into(quotes_dsl::quotes)
                    .values(&payload)
                    .execute(tx.conn())
                    .map_err(StorageError::QueryFailed)?;

                if is_update {
                    tx.update(&payload)?;
                } else {
                    tx.insert(&payload)?;
                }

                Ok(payload)
            })
            .await?;

        Ok(Quote::from(saved_row))
    }

    async fn delete_quote(&self, quote_id: &str) -> Result<()> {
        let id_to_delete = quote_id.to_string();
        self.writer
            .exec_tx(move |tx| -> Result<()> {
                let existing = quotes_dsl::quotes
                    .filter(quotes_dsl::id.eq(&id_to_delete))
                    .select(QuoteDB::as_select())
                    .first::<QuoteDB>(tx.conn())
                    .optional()
                    .map_err(StorageError::QueryFailed)?;

                diesel::delete(quotes_dsl::quotes.filter(quotes_dsl::id.eq(&id_to_delete)))
                    .execute(tx.conn())
                    .map_err(StorageError::QueryFailed)?;

                if let Some(row) = existing {
                    tx.delete_model(&row);
                }
                Ok(())
            })
            .await
    }

    async fn upsert_quotes(&self, input_quotes: &[Quote]) -> Result<usize> {
        if input_quotes.is_empty() {
            return Ok(0);
        }

        let db_rows: Vec<QuoteDB> = input_quotes.iter().map(QuoteDB::from).collect();

        self.writer
            .exec_tx(move |tx| -> Result<usize> {
                // Skip provider quotes for days that already have a MANUAL override.
                let db_rows = {
                    let provider_pairs: HashSet<(&str, &str)> = db_rows
                        .iter()
                        .filter(|r| r.source != "MANUAL")
                        .map(|r| (r.asset_id.as_str(), r.day.as_str()))
                        .collect();

                    if provider_pairs.is_empty() {
                        db_rows
                    } else {
                        let asset_ids: Vec<&str> = provider_pairs.iter().map(|(a, _)| *a).collect();
                        let days: Vec<&str> = provider_pairs.iter().map(|(_, d)| *d).collect();

                        let manual_days: HashSet<(String, String)> = quotes_dsl::quotes
                            .filter(quotes_dsl::source.eq("MANUAL"))
                            .filter(quotes_dsl::asset_id.eq_any(&asset_ids))
                            .filter(quotes_dsl::day.eq_any(&days))
                            .select((quotes_dsl::asset_id, quotes_dsl::day))
                            .load::<(String, String)>(tx.conn())
                            .map_err(StorageError::QueryFailed)?
                            .into_iter()
                            .collect();

                        if manual_days.is_empty() {
                            db_rows
                        } else {
                            db_rows
                                .into_iter()
                                .filter(|r| {
                                    r.source == "MANUAL"
                                        || !manual_days
                                            .contains(&(r.asset_id.clone(), r.day.clone()))
                                })
                                .collect()
                        }
                    }
                };

                let mut total_upserted: usize = 0;

                let (manual_rows, provider_rows): (Vec<QuoteDB>, Vec<QuoteDB>) = db_rows
                    .into_iter()
                    .partition(|row| row.source.eq_ignore_ascii_case("MANUAL"));

                for chunk in provider_rows.chunks(1_000) {
                    total_upserted += diesel::replace_into(quotes_dsl::quotes)
                        .values(chunk)
                        .execute(tx.conn())
                        .map_err(StorageError::QueryFailed)?;
                }

                for row in manual_rows {
                    let mut payload = row;
                    let existing = quotes_dsl::quotes
                        .filter(quotes_dsl::asset_id.eq(&payload.asset_id))
                        .filter(quotes_dsl::day.eq(&payload.day))
                        .filter(quotes_dsl::source.eq(&payload.source))
                        .select(QuoteDB::as_select())
                        .first::<QuoteDB>(tx.conn())
                        .optional()
                        .map_err(StorageError::QueryFailed)?;

                    let is_update = existing.is_some();
                    if let Some(existing_row) = existing {
                        payload.id = existing_row.id;
                    }

                    total_upserted += diesel::replace_into(quotes_dsl::quotes)
                        .values(&payload)
                        .execute(tx.conn())
                        .map_err(StorageError::QueryFailed)?;

                    if is_update {
                        tx.update(&payload)?;
                    } else {
                        tx.insert(&payload)?;
                    }
                }
                Ok(total_upserted)
            })
            .await
    }

    async fn delete_quotes_for_asset(&self, asset_id: &AssetId) -> Result<usize> {
        let asset_id_str = asset_id.as_str().to_string();

        self.writer
            .exec_tx(move |tx| -> Result<usize> {
                let existing_rows = quotes_dsl::quotes
                    .filter(quotes_dsl::asset_id.eq(&asset_id_str))
                    .select(QuoteDB::as_select())
                    .load::<QuoteDB>(tx.conn())
                    .map_err(StorageError::QueryFailed)?;

                let count = diesel::delete(
                    quotes_dsl::quotes.filter(quotes_dsl::asset_id.eq(&asset_id_str)),
                )
                .execute(tx.conn())
                .map_err(StorageError::QueryFailed)?;

                for row in &existing_rows {
                    tx.delete_model(row);
                }

                Ok(count)
            })
            .await
    }

    async fn delete_provider_quotes_for_asset(&self, asset_id: &AssetId) -> Result<usize> {
        let asset_id_str = asset_id.as_str().to_string();

        self.writer
            .exec(move |conn: &mut SqliteConnection| -> Result<usize> {
                let count = diesel::delete(
                    quotes_dsl::quotes
                        .filter(quotes_dsl::asset_id.eq(asset_id_str))
                        .filter(quotes_dsl::source.ne("MANUAL")),
                )
                .execute(conn)
                .map_err(StorageError::QueryFailed)?;
                Ok(count)
            })
            .await
    }

    // =========================================================================
    // Single Asset Queries (Strong Types)
    // =========================================================================

    fn latest(&self, asset_id: &AssetId, source: Option<&QuoteSource>) -> Result<Option<Quote>> {
        let mut conn = get_connection(&self.pool)?;

        let mut query = quotes_dsl::quotes
            .filter(quotes_dsl::asset_id.eq(asset_id.as_str()))
            .order((
                quotes_dsl::day.desc(),
                diesel::dsl::sql::<Integer>(SOURCE_PRIORITY_CASE).asc(),
            ))
            .into_boxed();

        if let Some(src) = source {
            query = query.filter(quotes_dsl::source.eq(src.to_storage_string()));
        }

        let result = query.first::<QuoteDB>(&mut conn).optional().into_core()?;

        Ok(result.map(Quote::from))
    }

    fn range(
        &self,
        asset_id: &AssetId,
        start: Day,
        end: Day,
        source: Option<&QuoteSource>,
    ) -> Result<Vec<Quote>> {
        let mut conn = get_connection(&self.pool)?;

        let start_str = start.date().format("%Y-%m-%d").to_string();
        let end_str = end.date().format("%Y-%m-%d").to_string();

        if source.is_none() {
            let sql = format!(
                "WITH RankedQuotes AS ( \
                    SELECT \
                        q.*, \
                        ROW_NUMBER() OVER (PARTITION BY q.asset_id, q.day ORDER BY {priority} ASC, q.timestamp DESC) as rn \
                    FROM quotes q \
                    WHERE q.asset_id = ? AND q.day >= ? AND q.day <= ? \
                ) \
                SELECT * FROM RankedQuotes WHERE rn = 1 \
                ORDER BY day ASC",
                priority = SOURCE_PRIORITY_CASE_Q
            );

            let results: Vec<QuoteDB> = sql_query(sql)
                .bind::<Text, _>(asset_id.as_str())
                .bind::<Text, _>(start_str)
                .bind::<Text, _>(end_str)
                .load::<QuoteDB>(&mut conn)
                .into_core()?;

            return Ok(results.into_iter().map(Quote::from).collect());
        }

        let src = match source {
            Some(src) => src,
            None => unreachable!("source=None returns from ranked query above"),
        };

        let query = quotes_dsl::quotes
            .filter(quotes_dsl::asset_id.eq(asset_id.as_str()))
            .filter(quotes_dsl::day.ge(&start_str))
            .filter(quotes_dsl::day.le(&end_str))
            .filter(quotes_dsl::source.eq(src.to_storage_string()))
            .order(quotes_dsl::day.asc());

        let results = query.load::<QuoteDB>(&mut conn).into_core()?;

        Ok(results.into_iter().map(Quote::from).collect())
    }

    // =========================================================================
    // Batch Queries (Strong Types)
    // =========================================================================

    fn latest_batch(
        &self,
        asset_ids: &[AssetId],
        source: Option<&QuoteSource>,
    ) -> Result<HashMap<AssetId, Quote>> {
        if asset_ids.is_empty() {
            return Ok(HashMap::new());
        }

        let mut conn = get_connection(&self.pool)?;
        let mut result: HashMap<AssetId, Quote> = HashMap::new();

        // Chunk the asset_ids to avoid SQLite parameter limits
        for chunk in chunk_for_sqlite(asset_ids) {
            let symbols: Vec<&str> = chunk.iter().map(|id| id.as_str()).collect();
            let placeholders = symbols.iter().map(|_| "?").collect::<Vec<_>>().join(", ");

            let sql = if source.is_some() {
                format!(
                    "WITH RankedQuotes AS ( \
                        SELECT \
                            q.*, \
                            ROW_NUMBER() OVER (PARTITION BY q.asset_id ORDER BY q.day DESC, {priority} ASC) as rn \
                        FROM quotes q WHERE q.asset_id IN ({placeholders}) AND q.source = ? \
                    ) \
                    SELECT * FROM RankedQuotes WHERE rn = 1 \
                    ORDER BY asset_id",
                    priority = SOURCE_PRIORITY_CASE_Q,
                    placeholders = placeholders
                )
            } else {
                format!(
                    "WITH RankedQuotes AS ( \
                        SELECT \
                            q.*, \
                            ROW_NUMBER() OVER (PARTITION BY q.asset_id ORDER BY q.day DESC, {priority} ASC) as rn \
                        FROM quotes q WHERE q.asset_id IN ({placeholders}) \
                    ) \
                    SELECT * FROM RankedQuotes WHERE rn = 1 \
                    ORDER BY asset_id",
                    priority = SOURCE_PRIORITY_CASE_Q,
                    placeholders = placeholders
                )
            };

            let mut query_builder = Box::new(sql_query(sql)).into_boxed::<Sqlite>();

            for sym in &symbols {
                query_builder = query_builder.bind::<Text, _>(*sym);
            }

            if let Some(src) = source {
                query_builder = query_builder.bind::<Text, _>(src.to_storage_string());
            }

            let ranked_quotes_db: Vec<QuoteDB> =
                query_builder.load::<QuoteDB>(&mut conn).into_core()?;

            for quote_db in ranked_quotes_db {
                result.insert(AssetId::new(quote_db.asset_id.clone()), quote_db.into());
            }
        }

        Ok(result)
    }

    fn latest_with_previous(
        &self,
        asset_ids: &[AssetId],
    ) -> Result<HashMap<AssetId, LatestQuotePair>> {
        if asset_ids.is_empty() {
            return Ok(HashMap::new());
        }

        let mut conn = get_connection(&self.pool)?;
        let mut result_map: HashMap<AssetId, LatestQuotePair> = HashMap::new();

        // Chunk the asset_ids to avoid SQLite parameter limits
        for chunk in chunk_for_sqlite(asset_ids) {
            let symbols: Vec<&str> = chunk.iter().map(|id| id.as_str()).collect();
            let placeholders = symbols.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
            let sql = format!(
                "WITH DayQuotes AS ( \
                    SELECT \
                        q.*, \
                        ROW_NUMBER() OVER (PARTITION BY q.asset_id, q.day ORDER BY {priority} ASC, q.timestamp DESC) as day_rn \
                    FROM quotes q WHERE q.asset_id IN ({placeholders}) \
                ), \
                RankedQuotes AS ( \
                    SELECT \
                        *, \
                        ROW_NUMBER() OVER (PARTITION BY asset_id ORDER BY day DESC) as rn \
                    FROM DayQuotes WHERE day_rn = 1 \
                ) \
                SELECT * \
                FROM RankedQuotes \
                WHERE rn <= 2 \
                ORDER BY asset_id, rn",
                priority = SOURCE_PRIORITY_CASE_Q,
                placeholders = placeholders
            );

            let mut query_builder = Box::new(sql_query(sql)).into_boxed::<Sqlite>();

            for sym in &symbols {
                query_builder = query_builder.bind::<Text, _>(*sym);
            }

            let ranked_quotes_db: Vec<QuoteDB> =
                query_builder.load::<QuoteDB>(&mut conn).into_core()?;

            let mut current_asset_quotes: Vec<Quote> = Vec::new();

            for quote_db in ranked_quotes_db {
                let quote = Quote::from(quote_db);

                if current_asset_quotes.is_empty()
                    || quote.asset_id == current_asset_quotes[0].asset_id
                {
                    current_asset_quotes.push(quote);
                } else {
                    if !current_asset_quotes.is_empty() {
                        let latest_quote = current_asset_quotes.remove(0);
                        let previous_quote = if !current_asset_quotes.is_empty() {
                            Some(current_asset_quotes.remove(0))
                        } else {
                            None
                        };
                        result_map.insert(
                            AssetId::new(latest_quote.asset_id.clone()),
                            LatestQuotePair {
                                latest: latest_quote,
                                previous: previous_quote,
                            },
                        );
                    }
                    current_asset_quotes.clear();
                    current_asset_quotes.push(quote);
                }
            }

            // Process final asset from this chunk
            if !current_asset_quotes.is_empty() {
                let latest_quote = current_asset_quotes.remove(0);
                let previous_quote = if !current_asset_quotes.is_empty() {
                    Some(current_asset_quotes.remove(0))
                } else {
                    None
                };
                result_map.insert(
                    AssetId::new(latest_quote.asset_id.clone()),
                    LatestQuotePair {
                        latest: latest_quote,
                        previous: previous_quote,
                    },
                );
            }
        }

        Ok(result_map)
    }

    // =========================================================================
    // Legacy Methods (String-based, for backward compatibility)
    // =========================================================================

    fn get_latest_quote(&self, symbol: &str) -> Result<Quote> {
        let mut conn = get_connection(&self.pool)?;

        let query_result = quotes_dsl::quotes
            .filter(quotes_dsl::asset_id.eq(symbol))
            .order((
                quotes_dsl::day.desc(),
                diesel::dsl::sql::<Integer>(SOURCE_PRIORITY_CASE).asc(),
            ))
            .first::<QuoteDB>(&mut conn)
            .optional()
            .into_core()?;

        match query_result {
            Some(quote_db) => Ok(Quote::from(quote_db)),
            None => Err(wealthfolio_core::errors::Error::Database(
                wealthfolio_core::errors::DatabaseError::NotFound(format!(
                    "No quote found in database for symbol: {}",
                    symbol
                )),
            )),
        }
    }

    fn get_latest_quotes(&self, symbols: &[String]) -> Result<HashMap<String, Quote>> {
        if symbols.is_empty() {
            return Ok(HashMap::new());
        }

        let mut conn = get_connection(&self.pool)?;
        let mut result: HashMap<String, Quote> = HashMap::new();

        // Chunk the symbols to avoid SQLite parameter limits
        for chunk in chunk_for_sqlite(symbols) {
            let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(", ");

            let sql = format!(
                "WITH RankedQuotes AS ( \
                    SELECT \
                        q.*, \
                        ROW_NUMBER() OVER (PARTITION BY q.asset_id ORDER BY q.day DESC, {priority} ASC) as rn \
                    FROM quotes q WHERE q.asset_id IN ({placeholders}) \
                ) \
                SELECT * FROM RankedQuotes WHERE rn = 1 \
                ORDER BY asset_id",
                priority = SOURCE_PRIORITY_CASE_Q,
                placeholders = placeholders
            );

            let mut query_builder = Box::new(sql_query(sql)).into_boxed::<Sqlite>();

            for symbol_val in chunk {
                query_builder = query_builder.bind::<Text, _>(symbol_val);
            }

            let ranked_quotes_db: Vec<QuoteDB> =
                query_builder.load::<QuoteDB>(&mut conn).into_core()?;

            for quote_db in ranked_quotes_db {
                result.insert(quote_db.asset_id.clone(), quote_db.into());
            }
        }

        Ok(result)
    }

    fn get_latest_quotes_as_of(
        &self,
        symbols: &[String],
        as_of: chrono::NaiveDate,
    ) -> Result<HashMap<String, Quote>> {
        if symbols.is_empty() {
            return Ok(HashMap::new());
        }

        let mut conn = get_connection(&self.pool)?;
        let mut result: HashMap<String, Quote> = HashMap::new();
        let as_of_str = as_of.format("%Y-%m-%d").to_string();

        for chunk in chunk_for_sqlite(symbols) {
            let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(", ");

            let sql = format!(
                "WITH RankedQuotes AS ( \
                    SELECT \
                        q.*, \
                        ROW_NUMBER() OVER (PARTITION BY q.asset_id ORDER BY q.day DESC, {priority} ASC) as rn \
                    FROM quotes q \
                    WHERE q.asset_id IN ({placeholders}) AND q.day <= ? \
                ) \
                SELECT * FROM RankedQuotes WHERE rn = 1 \
                ORDER BY asset_id",
                priority = SOURCE_PRIORITY_CASE_Q,
                placeholders = placeholders
            );

            let mut query_builder = Box::new(sql_query(sql)).into_boxed::<Sqlite>();

            for symbol_val in chunk {
                query_builder = query_builder.bind::<Text, _>(symbol_val);
            }
            query_builder = query_builder.bind::<Text, _>(as_of_str.clone());

            let ranked_quotes_db: Vec<QuoteDB> =
                query_builder.load::<QuoteDB>(&mut conn).into_core()?;

            for quote_db in ranked_quotes_db {
                result.insert(quote_db.asset_id.clone(), quote_db.into());
            }
        }

        Ok(result)
    }

    fn get_latest_quotes_pair(
        &self,
        symbols: &[String],
    ) -> Result<HashMap<String, LatestQuotePair>> {
        if symbols.is_empty() {
            return Ok(HashMap::new());
        }

        let mut conn = get_connection(&self.pool)?;
        let mut result_map: HashMap<String, LatestQuotePair> = HashMap::new();

        // Chunk the symbols to avoid SQLite parameter limits
        for chunk in chunk_for_sqlite(symbols) {
            let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
            let sql = format!(
                "WITH DayQuotes AS ( \
                    SELECT \
                        q.*, \
                        ROW_NUMBER() OVER (PARTITION BY q.asset_id, q.day ORDER BY {priority} ASC, q.timestamp DESC) as day_rn \
                    FROM quotes q WHERE q.asset_id IN ({placeholders}) \
                ), \
                RankedQuotes AS ( \
                    SELECT \
                        *, \
                        ROW_NUMBER() OVER (PARTITION BY asset_id ORDER BY day DESC) as rn \
                    FROM DayQuotes WHERE day_rn = 1 \
                ) \
                SELECT * \
                FROM RankedQuotes \
                WHERE rn <= 2 \
                ORDER BY asset_id, rn",
                priority = SOURCE_PRIORITY_CASE_Q,
                placeholders = placeholders
            );

            let mut query_builder = Box::new(sql_query(sql)).into_boxed::<Sqlite>();

            for symbol_val in chunk {
                query_builder = query_builder.bind::<Text, _>(symbol_val);
            }

            let ranked_quotes_db: Vec<QuoteDB> =
                query_builder.load::<QuoteDB>(&mut conn).into_core()?;

            let mut current_asset_quotes: Vec<Quote> = Vec::new();

            for quote_db in ranked_quotes_db {
                let quote = Quote::from(quote_db);

                if current_asset_quotes.is_empty()
                    || quote.asset_id == current_asset_quotes[0].asset_id
                {
                    current_asset_quotes.push(quote);
                } else {
                    if !current_asset_quotes.is_empty() {
                        let latest_quote = current_asset_quotes.remove(0);
                        let previous_quote = if !current_asset_quotes.is_empty() {
                            Some(current_asset_quotes.remove(0))
                        } else {
                            None
                        };
                        result_map.insert(
                            latest_quote.asset_id.clone(),
                            LatestQuotePair {
                                latest: latest_quote,
                                previous: previous_quote,
                            },
                        );
                    }
                    current_asset_quotes.clear();
                    current_asset_quotes.push(quote);
                }
            }

            // Process final asset from this chunk
            if !current_asset_quotes.is_empty() {
                let latest_quote = current_asset_quotes.remove(0);
                let previous_quote = if !current_asset_quotes.is_empty() {
                    Some(current_asset_quotes.remove(0))
                } else {
                    None
                };
                result_map.insert(
                    latest_quote.asset_id.clone(),
                    LatestQuotePair {
                        latest: latest_quote,
                        previous: previous_quote,
                    },
                );
            }
        }

        Ok(result_map)
    }

    fn get_latest_quote_before(&self, symbol: &str, before: NaiveDate) -> Result<Option<Quote>> {
        let mut conn = get_connection(&self.pool)?;
        let before_str = before.format("%Y-%m-%d").to_string();

        let result = quotes_dsl::quotes
            .filter(quotes_dsl::asset_id.eq(symbol))
            .filter(quotes_dsl::day.lt(&before_str))
            .order((
                quotes_dsl::day.desc(),
                diesel::dsl::sql::<Integer>(SOURCE_PRIORITY_CASE).asc(),
                quotes_dsl::timestamp.desc(),
            ))
            .first::<QuoteDB>(&mut conn)
            .optional()
            .into_core()?;

        Ok(result.map(Quote::from))
    }

    fn get_historical_quotes(&self, symbol: &str) -> Result<Vec<Quote>> {
        let mut conn = get_connection(&self.pool)?;

        // Order by day descending (newest first) - most callers need latest quote first
        // Frontend charts should sort ascending if needed for chronological display
        let sql = format!(
            "WITH RankedQuotes AS ( \
                SELECT \
                    q.*, \
                    ROW_NUMBER() OVER (PARTITION BY q.asset_id, q.day ORDER BY {priority} ASC, q.timestamp DESC) as rn \
                FROM quotes q WHERE q.asset_id = ? \
            ) \
            SELECT * FROM RankedQuotes WHERE rn = 1 \
            ORDER BY day DESC",
            priority = SOURCE_PRIORITY_CASE_Q
        );

        let results: Vec<QuoteDB> = sql_query(sql)
            .bind::<Text, _>(symbol)
            .load::<QuoteDB>(&mut conn)
            .into_core()?;

        Ok(results.into_iter().map(Quote::from).collect())
    }

    fn get_all_historical_quotes(&self) -> Result<Vec<Quote>> {
        let mut conn = get_connection(&self.pool)?;

        let sql = format!(
            "WITH RankedQuotes AS ( \
                SELECT \
                    q.*, \
                    ROW_NUMBER() OVER (PARTITION BY q.asset_id, q.day ORDER BY {priority} ASC, q.timestamp DESC) as rn \
                FROM quotes q \
            ) \
            SELECT * FROM RankedQuotes WHERE rn = 1 \
            ORDER BY day DESC",
            priority = SOURCE_PRIORITY_CASE_Q
        );

        let results: Vec<QuoteDB> = sql_query(sql).load::<QuoteDB>(&mut conn).into_core()?;

        Ok(results.into_iter().map(Quote::from).collect())
    }

    fn get_quotes_in_range(
        &self,
        symbol: &str,
        start: NaiveDate,
        end: NaiveDate,
    ) -> Result<Vec<Quote>> {
        let mut conn = get_connection(&self.pool)?;

        let start_str = start.format("%Y-%m-%d").to_string();
        let end_str = end.format("%Y-%m-%d").to_string();

        let sql = format!(
            "WITH RankedQuotes AS ( \
                SELECT \
                    q.*, \
                    ROW_NUMBER() OVER (PARTITION BY q.asset_id, q.day ORDER BY {priority} ASC, q.timestamp DESC) as rn \
                FROM quotes q \
                WHERE q.asset_id = ? AND q.day >= ? AND q.day <= ? \
            ) \
            SELECT * FROM RankedQuotes WHERE rn = 1 \
            ORDER BY day ASC",
            priority = SOURCE_PRIORITY_CASE_Q
        );

        let results: Vec<QuoteDB> = sql_query(sql)
            .bind::<Text, _>(symbol)
            .bind::<Text, _>(start_str)
            .bind::<Text, _>(end_str)
            .load::<QuoteDB>(&mut conn)
            .into_core()?;

        Ok(results.into_iter().map(Quote::from).collect())
    }

    fn find_duplicate_quotes(&self, symbol: &str, date: NaiveDate) -> Result<Vec<Quote>> {
        let mut conn = get_connection(&self.pool)?;

        let date_str = date.format("%Y-%m-%d").to_string();

        let results = quotes_dsl::quotes
            .filter(quotes_dsl::asset_id.eq(symbol))
            .filter(quotes_dsl::day.eq(&date_str))
            .load::<QuoteDB>(&mut conn)
            .into_core()?;

        Ok(results.into_iter().map(Quote::from).collect())
    }

    fn get_quote_bounds_for_assets(
        &self,
        asset_ids: &[String],
        source: &str,
    ) -> Result<HashMap<String, (NaiveDate, NaiveDate)>> {
        if asset_ids.is_empty() {
            return Ok(HashMap::new());
        }

        let mut conn = get_connection(&self.pool)?;
        let mut result: HashMap<String, (NaiveDate, NaiveDate)> = HashMap::new();

        #[derive(QueryableByName, Debug)]
        struct QuoteBoundsRow {
            #[diesel(sql_type = diesel::sql_types::Text)]
            asset_id: String,
            #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::Text>)]
            min_day: Option<String>,
            #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::Text>)]
            max_day: Option<String>,
        }

        // Chunk the asset_ids to avoid SQLite parameter limits
        for chunk in chunk_for_sqlite(asset_ids) {
            let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(", ");

            let sql = format!(
                "SELECT asset_id, MIN(day) as min_day, MAX(day) as max_day \
                 FROM quotes \
                 WHERE asset_id IN ({}) AND source = ? \
                 GROUP BY asset_id",
                placeholders
            );

            let mut query_builder = Box::new(sql_query(sql)).into_boxed::<Sqlite>();

            for asset_id in chunk {
                query_builder = query_builder.bind::<Text, _>(asset_id);
            }
            query_builder = query_builder.bind::<Text, _>(source);

            let rows: Vec<QuoteBoundsRow> = query_builder
                .load::<QuoteBoundsRow>(&mut conn)
                .into_core()?;

            for row in rows {
                if let (Some(min_str), Some(max_str)) = (row.min_day, row.max_day) {
                    if let (Ok(min_date), Ok(max_date)) = (
                        NaiveDate::parse_from_str(&min_str, "%Y-%m-%d"),
                        NaiveDate::parse_from_str(&max_str, "%Y-%m-%d"),
                    ) {
                        result.insert(row.asset_id, (min_date, max_date));
                    }
                }
            }
        }

        Ok(result)
    }
}

// =============================================================================
// ProviderSettingsStore Implementation
// =============================================================================

impl ProviderSettingsStore for MarketDataRepository {
    fn get_all_providers(&self) -> Result<Vec<MarketDataProviderSetting>> {
        let mut conn = get_connection(&self.pool)?;
        let db_results = market_data_providers_dsl::market_data_providers
            .order(market_data_providers_dsl::priority.desc())
            .select(MarketDataProviderSettingDB::as_select())
            .load::<MarketDataProviderSettingDB>(&mut conn)
            .into_core()?;

        Ok(db_results
            .into_iter()
            .map(MarketDataProviderSetting::from)
            .collect())
    }

    fn get_provider(&self, id: &str) -> Result<MarketDataProviderSetting> {
        let mut conn = get_connection(&self.pool)?;
        let db_result = market_data_providers_dsl::market_data_providers
            .find(id)
            .select(MarketDataProviderSettingDB::as_select())
            .first::<MarketDataProviderSettingDB>(&mut conn)
            .into_core()?;

        Ok(MarketDataProviderSetting::from(db_result))
    }

    fn update_provider(
        &self,
        id: &str,
        changes: UpdateMarketDataProviderSetting,
    ) -> Result<MarketDataProviderSetting> {
        let mut conn = get_connection(&self.pool)?;

        let changes_db = UpdateMarketDataProviderSettingDB {
            priority: changes.priority,
            enabled: changes.enabled,
        };

        diesel::update(market_data_providers_dsl::market_data_providers.find(id))
            .set(&changes_db)
            .execute(&mut conn)
            .into_core()?;

        let db_result = market_data_providers_dsl::market_data_providers
            .find(id)
            .select(MarketDataProviderSettingDB::as_select())
            .first::<MarketDataProviderSettingDB>(&mut conn)
            .into_core()?;

        Ok(MarketDataProviderSetting::from(db_result))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{create_pool, run_migrations, write_actor::spawn_writer};
    use chrono::{NaiveDate, TimeZone, Utc};
    use rust_decimal::Decimal;
    use tempfile::tempdir;
    use wealthfolio_core::quotes::Quote;

    async fn create_test_repository() -> (MarketDataRepository, tempfile::TempDir) {
        std::env::set_var("CONNECT_API_URL", "http://test.local");
        let temp_dir = tempdir().expect("Failed to create temp directory");
        let db_path = temp_dir.path().join("test.db");
        let db_path_str = db_path.to_string_lossy().to_string();
        run_migrations(&db_path_str).expect("Failed to run migrations");
        let pool = create_pool(&db_path_str).expect("Failed to create pool");
        let writer = spawn_writer((*pool).clone()).expect("Failed to spawn writer actor");
        let repo = MarketDataRepository::new(Arc::clone(&pool), writer);
        (repo, temp_dir)
    }

    fn insert_test_asset(repo: &MarketDataRepository, asset_id: &str) {
        let mut conn = get_connection(&repo.pool).expect("get conn");
        diesel::sql_query(format!(
            "INSERT INTO assets (id, kind, quote_mode, quote_ccy, instrument_type, \
             instrument_symbol) VALUES ('{}', 'INVESTMENT', 'MARKET', 'USD', 'EQUITY', '{}')",
            asset_id, asset_id
        ))
        .execute(&mut conn)
        .expect("insert asset");
    }

    fn quote_with_source(asset_id: &str, date: NaiveDate, source: &str, close: Decimal) -> Quote {
        let ts = Utc.from_utc_datetime(&date.and_hms_opt(16, 0, 0).unwrap());
        let date_str = date.format("%Y-%m-%d").to_string();
        Quote {
            id: format!("{}_{}_{}", asset_id, date_str, source),
            asset_id: asset_id.to_string(),
            timestamp: ts,
            open: close,
            high: close,
            low: close,
            close,
            adjclose: close,
            volume: Decimal::ZERO,
            currency: "USD".to_string(),
            data_source: source.to_string(),
            created_at: Utc::now(),
            notes: None,
        }
    }

    /// With multiple quotes for the same (asset, day) but different sources,
    /// latest-quote lookups should resolve deterministically to MANUAL over
    /// provider quotes over BROKER fallback quotes.
    #[tokio::test]
    async fn latest_quote_prefers_manual_over_provider_over_broker() {
        let (repo, _temp) = create_test_repository().await;
        let asset_id = "AAPL";
        insert_test_asset(&repo, asset_id);

        let day = NaiveDate::from_ymd_opt(2024, 6, 3).unwrap();
        repo.save_quote(&quote_with_source(
            asset_id,
            day,
            "YAHOO",
            Decimal::from(200),
        ))
        .await
        .expect("save YAHOO");
        repo.save_quote(&quote_with_source(
            asset_id,
            day,
            "BROKER",
            Decimal::from(201),
        ))
        .await
        .expect("save BROKER");
        repo.save_quote(&quote_with_source(
            asset_id,
            day,
            "MANUAL",
            Decimal::from(150),
        ))
        .await
        .expect("save MANUAL");

        let latest = repo
            .get_latest_quote(asset_id)
            .expect("get_latest_quote should succeed");
        assert_eq!(
            latest.data_source, "MANUAL",
            "get_latest_quote should prefer MANUAL source"
        );
        assert_eq!(latest.close, Decimal::from(150));

        let batch = repo
            .get_latest_quotes(&[asset_id.to_string()])
            .expect("get_latest_quotes should succeed");
        assert_eq!(
            batch.get(asset_id).map(|q| q.data_source.as_str()),
            Some("MANUAL"),
            "get_latest_quotes should prefer MANUAL source"
        );

        // Typed-API lookup uses the same priority.
        let latest_typed = repo
            .latest(&AssetId::new(asset_id.to_string()), None)
            .expect("latest should succeed")
            .expect("quote should exist");
        assert_eq!(latest_typed.data_source, "MANUAL");
    }

    /// When no MANUAL quote exists, provider quotes should win over BROKER
    /// fallback quotes on the same day.
    #[tokio::test]
    async fn latest_quote_prefers_provider_when_no_manual() {
        let (repo, _temp) = create_test_repository().await;
        let asset_id = "MSFT";
        insert_test_asset(&repo, asset_id);

        let day = NaiveDate::from_ymd_opt(2024, 6, 3).unwrap();
        repo.save_quote(&quote_with_source(
            asset_id,
            day,
            "YAHOO",
            Decimal::from(300),
        ))
        .await
        .expect("save YAHOO");
        repo.save_quote(&quote_with_source(
            asset_id,
            day,
            "BROKER",
            Decimal::from(305),
        ))
        .await
        .expect("save BROKER");

        let latest = repo
            .get_latest_quote(asset_id)
            .expect("get_latest_quote should succeed");
        assert_eq!(latest.data_source, "YAHOO");
        assert_eq!(latest.close, Decimal::from(300));
    }

    /// Priority is a tiebreaker within a day; a later day always wins even
    /// with a lower-priority source.
    #[tokio::test]
    async fn later_day_wins_regardless_of_source_priority() {
        let (repo, _temp) = create_test_repository().await;
        let asset_id = "GOOG";
        insert_test_asset(&repo, asset_id);

        let earlier = NaiveDate::from_ymd_opt(2024, 6, 2).unwrap();
        let later = NaiveDate::from_ymd_opt(2024, 6, 3).unwrap();
        repo.save_quote(&quote_with_source(
            asset_id,
            earlier,
            "MANUAL",
            Decimal::from(100),
        ))
        .await
        .expect("save MANUAL earlier");
        repo.save_quote(&quote_with_source(
            asset_id,
            later,
            "YAHOO",
            Decimal::from(180),
        ))
        .await
        .expect("save YAHOO later");

        let latest = repo
            .get_latest_quote(asset_id)
            .expect("get_latest_quote should succeed");
        assert_eq!(latest.data_source, "YAHOO");
        assert_eq!(latest.close, Decimal::from(180));
    }

    #[tokio::test]
    async fn latest_quote_pair_uses_distinct_days_after_source_priority() {
        let (repo, _temp) = create_test_repository().await;
        let asset_id = "QQQ";
        insert_test_asset(&repo, asset_id);

        let previous_day = NaiveDate::from_ymd_opt(2024, 6, 2).unwrap();
        let latest_day = NaiveDate::from_ymd_opt(2024, 6, 3).unwrap();
        repo.save_quote(&quote_with_source(
            asset_id,
            previous_day,
            "YAHOO",
            Decimal::from(90),
        ))
        .await
        .expect("save previous");
        repo.save_quote(&quote_with_source(
            asset_id,
            latest_day,
            "BROKER",
            Decimal::from(99),
        ))
        .await
        .expect("save broker latest");
        repo.save_quote(&quote_with_source(
            asset_id,
            latest_day,
            "YAHOO",
            Decimal::from(100),
        ))
        .await
        .expect("save provider latest");

        let pair = repo
            .get_latest_quotes_pair(&[asset_id.to_string()])
            .expect("get pair")
            .remove(asset_id)
            .expect("pair exists");

        assert_eq!(pair.latest.data_source, "YAHOO");
        assert_eq!(pair.latest.close, Decimal::from(100));
        let previous = pair.previous.expect("previous quote");
        assert_eq!(previous.timestamp.date_naive(), previous_day);
        assert_eq!(previous.close, Decimal::from(90));
    }

    #[tokio::test]
    async fn typed_latest_with_previous_uses_distinct_days_after_source_priority() {
        let (repo, _temp) = create_test_repository().await;
        let asset_id = "BND";
        insert_test_asset(&repo, asset_id);

        let previous_day = NaiveDate::from_ymd_opt(2024, 6, 2).unwrap();
        let latest_day = NaiveDate::from_ymd_opt(2024, 6, 3).unwrap();
        repo.save_quote(&quote_with_source(
            asset_id,
            previous_day,
            "YAHOO",
            Decimal::from(70),
        ))
        .await
        .expect("save previous");
        repo.save_quote(&quote_with_source(
            asset_id,
            latest_day,
            "BROKER",
            Decimal::from(74),
        ))
        .await
        .expect("save broker latest");
        repo.save_quote(&quote_with_source(
            asset_id,
            latest_day,
            "YAHOO",
            Decimal::from(75),
        ))
        .await
        .expect("save provider latest");

        let pair = repo
            .latest_with_previous(&[AssetId::new(asset_id.to_string())])
            .expect("get pair")
            .remove(&AssetId::new(asset_id.to_string()))
            .expect("pair exists");

        assert_eq!(pair.latest.data_source, "YAHOO");
        assert_eq!(pair.latest.close, Decimal::from(75));
        let previous = pair.previous.expect("previous quote");
        assert_eq!(previous.timestamp.date_naive(), previous_day);
        assert_eq!(previous.close, Decimal::from(70));
    }

    #[tokio::test]
    async fn historical_and_range_queries_apply_source_priority_per_day() {
        let (repo, _temp) = create_test_repository().await;
        let asset_id = "VTI";
        insert_test_asset(&repo, asset_id);

        let previous_day = NaiveDate::from_ymd_opt(2024, 6, 2).unwrap();
        let duplicate_day = NaiveDate::from_ymd_opt(2024, 6, 3).unwrap();
        repo.save_quote(&quote_with_source(
            asset_id,
            previous_day,
            "YAHOO",
            Decimal::from(99),
        ))
        .await
        .expect("save previous");
        repo.save_quote(&quote_with_source(
            asset_id,
            duplicate_day,
            "BROKER",
            Decimal::from(101),
        ))
        .await
        .expect("save broker");
        repo.save_quote(&quote_with_source(
            asset_id,
            duplicate_day,
            "YAHOO",
            Decimal::from(100),
        ))
        .await
        .expect("save provider");

        let history = repo
            .get_historical_quotes(asset_id)
            .expect("get historical");
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].timestamp.date_naive(), duplicate_day);
        assert_eq!(history[0].data_source, "YAHOO");
        assert_eq!(history[0].close, Decimal::from(100));

        let range = repo
            .get_quotes_in_range(asset_id, previous_day, duplicate_day)
            .expect("get range");
        assert_eq!(range.len(), 2);
        assert_eq!(range[1].timestamp.date_naive(), duplicate_day);
        assert_eq!(range[1].data_source, "YAHOO");
        assert_eq!(range[1].close, Decimal::from(100));

        let all_history = repo.get_all_historical_quotes().expect("get all history");
        let asset_quotes: Vec<_> = all_history
            .iter()
            .filter(|quote| quote.asset_id == asset_id)
            .collect();
        assert_eq!(asset_quotes.len(), 2);
        assert!(asset_quotes
            .iter()
            .any(|quote| quote.timestamp.date_naive() == duplicate_day
                && quote.data_source == "YAHOO"
                && quote.close == Decimal::from(100)));
    }

    #[tokio::test]
    async fn typed_range_without_source_applies_source_priority_per_day() {
        let (repo, _temp) = create_test_repository().await;
        let asset_id = "VXUS";
        insert_test_asset(&repo, asset_id);

        let previous_day = NaiveDate::from_ymd_opt(2024, 6, 2).unwrap();
        let duplicate_day = NaiveDate::from_ymd_opt(2024, 6, 3).unwrap();
        repo.save_quote(&quote_with_source(
            asset_id,
            previous_day,
            "YAHOO",
            Decimal::from(60),
        ))
        .await
        .expect("save previous");
        repo.save_quote(&quote_with_source(
            asset_id,
            duplicate_day,
            "BROKER",
            Decimal::from(62),
        ))
        .await
        .expect("save broker");
        repo.save_quote(&quote_with_source(
            asset_id,
            duplicate_day,
            "YAHOO",
            Decimal::from(61),
        ))
        .await
        .expect("save provider");

        let range = repo
            .range(
                &AssetId::new(asset_id.to_string()),
                Day::new(previous_day),
                Day::new(duplicate_day),
                None,
            )
            .expect("get typed range");

        assert_eq!(range.len(), 2);
        assert_eq!(range[1].timestamp.date_naive(), duplicate_day);
        assert_eq!(range[1].data_source, "YAHOO");
        assert_eq!(range[1].close, Decimal::from(61));
    }

    #[tokio::test]
    async fn latest_quotes_as_of_applies_source_priority_on_cutoff_day() {
        let (repo, _temp) = create_test_repository().await;
        let asset_id = "IEMG";
        insert_test_asset(&repo, asset_id);

        let day = NaiveDate::from_ymd_opt(2024, 6, 3).unwrap();
        repo.save_quote(&quote_with_source(
            asset_id,
            day,
            "BROKER",
            Decimal::from(52),
        ))
        .await
        .expect("save broker");
        repo.save_quote(&quote_with_source(
            asset_id,
            day,
            "YAHOO",
            Decimal::from(51),
        ))
        .await
        .expect("save provider");

        let quotes = repo
            .get_latest_quotes_as_of(&[asset_id.to_string()], day)
            .expect("get latest quotes as of");
        let quote = quotes.get(asset_id).expect("quote exists");
        assert_eq!(quote.data_source, "YAHOO");
        assert_eq!(quote.close, Decimal::from(51));
    }

    /// `get_latest_quotes_as_of` must exclude quotes whose `day` is after the
    /// supplied cutoff, and omit the asset entirely when no qualifying row exists.
    #[tokio::test]
    async fn get_latest_quotes_as_of_excludes_future_rows() {
        let (repo, _temp) = create_test_repository().await;
        let asset_id = "MORGAGE";
        insert_test_asset(&repo, asset_id);

        let past = NaiveDate::from_ymd_opt(2020, 1, 1).unwrap();
        let present = NaiveDate::from_ymd_opt(2024, 6, 1).unwrap();
        let future = NaiveDate::from_ymd_opt(2041, 12, 31).unwrap();

        repo.save_quote(&quote_with_source(
            asset_id,
            past,
            "MANUAL",
            Decimal::from(100_000),
        ))
        .await
        .expect("save past");
        repo.save_quote(&quote_with_source(
            asset_id,
            present,
            "MANUAL",
            Decimal::from(80_000),
        ))
        .await
        .expect("save present");
        repo.save_quote(&quote_with_source(
            asset_id,
            future,
            "MANUAL",
            Decimal::ZERO,
        ))
        .await
        .expect("save future");

        // as_of = present: should return the present row (not the future row)
        let result = repo
            .get_latest_quotes_as_of(&[asset_id.to_string()], present)
            .expect("get_latest_quotes_as_of should succeed");
        assert_eq!(result.len(), 1, "should have one entry");
        let quote = result.get(asset_id).expect("asset should be present");
        assert_eq!(
            quote.close,
            Decimal::from(80_000),
            "should return present row, not future"
        );

        // as_of = before all rows: asset should be absent
        let before_all = NaiveDate::from_ymd_opt(2019, 12, 31).unwrap();
        let empty = repo
            .get_latest_quotes_as_of(&[asset_id.to_string()], before_all)
            .expect("get_latest_quotes_as_of should succeed with empty result");
        assert!(empty.is_empty(), "no quotes before all rows");
    }
}
