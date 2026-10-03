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
use crate::utils::{chunk_for_sqlite, SQLITE_MAX_PARAMS_CHUNK};
use wealthfolio_core::quotes::store::{ProviderSettingsStore, QuoteStore};
use wealthfolio_core::quotes::types::{AssetId, Day, QuoteSource};
use wealthfolio_core::quotes::{
    LatestQuotePair, MarketDataProviderSetting, ProviderHistoryResetContext, Quote,
    ResetProviderHistoryResult, UpdateMarketDataProviderSetting,
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

/// `SOURCE_PRIORITY_CASE` for rows already read.
fn source_priority(source: &str) -> u8 {
    match source {
        "MANUAL" => 1,
        "BROKER" => 3,
        _ => 2,
    }
}

/// One quote per asset and day from rows ordered by (asset, day): the source
/// that ranks first, then the latest timestamp.
fn best_per_day(rows: Vec<QuoteDB>) -> Vec<QuoteDB> {
    fn rank(row: &QuoteDB) -> (u8, std::cmp::Reverse<&str>) {
        (
            source_priority(&row.source),
            std::cmp::Reverse(row.timestamp.as_str()),
        )
    }
    let mut best: Vec<QuoteDB> = Vec::with_capacity(rows.len());
    for row in rows {
        match best.last_mut() {
            Some(last) if last.asset_id == row.asset_id && last.day == row.day => {
                if rank(&row) < rank(last) {
                    *last = row;
                }
            }
            _ => best.push(row),
        }
    }
    best
}

pub struct MarketDataRepository {
    pool: Arc<Pool<ConnectionManager<SqliteConnection>>>,
    writer: WriteHandle,
}

impl MarketDataRepository {
    pub fn new(pool: Arc<Pool<ConnectionManager<SqliteConnection>>>, writer: WriteHandle) -> Self {
        Self { pool, writer }
    }
}

fn reset_context(conn: &mut SqliteConnection, id: &str) -> Result<ProviderHistoryResetContext> {
    use crate::schema::{assets, market_data_providers as providers};
    let asset: wealthfolio_core::assets::Asset = assets::table
        .find(id)
        .select(crate::assets::AssetDB::as_select())
        .first::<crate::assets::AssetDB>(conn)
        .map_err(StorageError::QueryFailed)?
        .into();
    let providers = providers::table
        .order(providers::id.asc())
        .select((
            providers::id,
            providers::enabled,
            providers::priority,
            providers::config,
        ))
        .load::<(String, bool, i32, Option<String>)>(conn)
        .map_err(StorageError::QueryFailed)?;
    // Exclude labels and last-sync bookkeeping: only fetch identity/configuration matters.
    let fingerprint = serde_json::json!({
        "kind": asset.kind, "active": asset.is_active, "mode": asset.quote_mode,
        "currency": asset.quote_ccy, "type": asset.instrument_type,
        "symbol": asset.instrument_symbol, "exchange": asset.instrument_exchange_mic,
        "metadata": asset.metadata, "assetProvider": asset.provider_config,
        "providers": providers,
    })
    .to_string();
    let earliest: Option<String> = quotes_dsl::quotes
        .filter(quotes_dsl::asset_id.eq(id))
        .filter(quotes_dsl::source.ne("MANUAL"))
        .filter(quotes_dsl::source.ne("BROKER"))
        .select(diesel::dsl::min(quotes_dsl::day))
        .first(conn)
        .map_err(StorageError::QueryFailed)?;
    let earliest_provider_date = earliest
        .map(|day| chrono::NaiveDate::parse_from_str(&day, "%Y-%m-%d"))
        .transpose()?;
    let provider_configuration = providers
        .iter()
        .filter(|(_, enabled, _, _)| *enabled)
        .map(|(id, _, priority, _)| (id.clone(), *priority))
        .collect();
    Ok(ProviderHistoryResetContext {
        asset,
        fingerprint,
        earliest_provider_date,
        provider_configuration,
    })
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

    fn provider_history_reset_context(
        &self,
        asset_id: &str,
    ) -> Result<ProviderHistoryResetContext> {
        let mut conn = get_connection(&self.pool)?;
        conn.transaction::<_, StorageError, _>(|conn| {
            reset_context(conn, asset_id).map_err(StorageError::from)
        })
        .map_err(Into::into)
    }

    async fn replace_provider_history(
        &self,
        context: ProviderHistoryResetContext,
        quotes: Vec<Quote>,
    ) -> Result<ResetProviderHistoryResult> {
        let first = quotes.first().ok_or_else(|| {
            wealthfolio_core::Error::Asset(
                "Cannot replace provider history with an empty response".into(),
            )
        })?;
        let source = first.data_source.clone();
        if source.is_empty()
            || matches!(source.as_str(), "MANUAL" | "BROKER")
            || quotes.iter().any(|q| {
                q.asset_id != context.asset.id
                    || q.data_source != source
                    || q.currency.is_empty()
                    || q.close <= rust_decimal::Decimal::ZERO
            })
        {
            return Err(wealthfolio_core::Error::Asset(
                "Invalid provider history replacement".into(),
            ));
        }
        let from_date = quotes
            .iter()
            .map(|q| q.timestamp.date_naive())
            .min()
            .unwrap()
            .to_string();
        let to_date = quotes
            .iter()
            .map(|q| q.timestamp.date_naive())
            .max()
            .unwrap()
            .to_string();
        let rows: Vec<QuoteDB> = quotes.iter().map(QuoteDB::from).collect();
        self.writer.exec_tx(move |tx| {
            let current = reset_context(tx.conn(), &context.asset.id)?;
            current.ensure_eligible()?;
            if current.fingerprint != context.fingerprint {
                return Err(wealthfolio_core::Error::Asset(
                    "Asset or provider settings changed during fetching; history was not replaced".into()));
            }
            let deleted_count = diesel::delete(quotes_dsl::quotes
                .filter(quotes_dsl::asset_id.eq(&context.asset.id))
                .filter(quotes_dsl::source.ne("MANUAL"))
                .filter(quotes_dsl::source.ne("BROKER")))
                .execute(tx.conn()).map_err(StorageError::QueryFailed)?;
            let mut inserted_count = 0;
            // INSERT (not REPLACE) protects unrelated/manual identities from collisions.
            // Deliberately bypass the ordinary upsert's manual-day exclusion.
            for chunk in rows.chunks(1_000) {
                inserted_count += diesel::insert_into(quotes_dsl::quotes).values(chunk)
                    .execute(tx.conn()).map_err(StorageError::QueryFailed)?;
            }
            let now = chrono::Utc::now().to_rfc3339();
            diesel::sql_query("INSERT INTO quote_sync_state
                (asset_id, data_source, sync_priority, error_count, last_synced_at, created_at, updated_at)
                VALUES (?, ?, 0, 0, ?, ?, ?)
                ON CONFLICT(asset_id) DO UPDATE SET data_source=excluded.data_source,
                error_count=0, last_error=NULL, last_synced_at=excluded.last_synced_at,
                updated_at=excluded.updated_at")
                .bind::<Text, _>(&context.asset.id).bind::<Text, _>(&source)
                .bind::<Text, _>(&now).bind::<Text, _>(&now).bind::<Text, _>(&now)
                .execute(tx.conn()).map_err(StorageError::QueryFailed)?;
            Ok(ResetProviderHistoryResult {
                asset_id: context.asset.id, source, from_date, to_date,
                inserted_count, deleted_count,
            })
        }).await
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
                        ROW_NUMBER() OVER (PARTITION BY q.asset_id ORDER BY q.day DESC, {priority} ASC, q.timestamp DESC) as rn \
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
        // One index seek per asset: ranking every quote up to `as_of` grows
        // with the price history.
        let requests: Vec<(String, NaiveDate)> = symbols
            .iter()
            .map(|symbol| (symbol.clone(), as_of))
            .collect();
        self.get_latest_quotes_as_of_dates(&requests)
    }

    fn get_latest_quotes_as_of_dates(
        &self,
        requests: &[(String, NaiveDate)],
    ) -> Result<HashMap<String, Quote>> {
        if requests.is_empty() {
            return Ok(HashMap::new());
        }

        const ASSET_DATE_BATCH_SIZE: usize = 400;
        let mut requests: Vec<_> = requests
            .iter()
            .filter(|(asset_id, _)| !asset_id.is_empty())
            .cloned()
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        requests.sort();

        let mut conn = get_connection(&self.pool)?;
        let mut result = HashMap::new();
        for chunk in requests.chunks(ASSET_DATE_BATCH_SIZE) {
            let request_values = chunk
                .iter()
                .map(|_| "(?, ?)")
                .collect::<Vec<_>>()
                .join(", ");
            let sql = format!(
                "WITH requested(asset_id, requested_day) AS (VALUES {request_values}), \
                 SelectedQuotes AS ( \
                    SELECT requested.asset_id, \
                           (SELECT q.id FROM quotes q \
                            WHERE q.asset_id = requested.asset_id \
                              AND q.day <= requested.requested_day \
                            ORDER BY q.day DESC, {priority} ASC, q.timestamp DESC \
                            LIMIT 1) AS quote_id \
                    FROM requested \
                 ) \
                 SELECT q.* FROM SelectedQuotes selected \
                 JOIN quotes q ON q.id = selected.quote_id \
                 ORDER BY q.asset_id",
                priority = SOURCE_PRIORITY_CASE_Q,
            );
            let mut query = Box::new(sql_query(sql)).into_boxed::<Sqlite>();
            for (asset_id, requested_date) in chunk {
                query = query.bind::<Text, _>(asset_id);
                query = query.bind::<Text, _>(requested_date.format("%Y-%m-%d").to_string());
            }
            for row in query.load::<QuoteDB>(&mut conn).into_core()? {
                let quote: Quote = row.into();
                result.insert(quote.asset_id.clone(), quote);
            }
        }
        Ok(result)
    }

    fn range_batch(
        &self,
        asset_ids: &[AssetId],
        start: Day,
        end: Day,
        source: Option<&QuoteSource>,
    ) -> Result<Vec<Quote>> {
        if asset_ids.is_empty() {
            return Ok(Vec::new());
        }

        let mut conn = get_connection(&self.pool)?;
        let start_str = start.date().format("%Y-%m-%d").to_string();
        let end_str = end.date().format("%Y-%m-%d").to_string();
        let mut result = Vec::new();

        for chunk in chunk_for_sqlite(asset_ids) {
            let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
            let sql = if source.is_some() {
                format!(
                    "SELECT q.* FROM quotes q \
                     WHERE q.asset_id IN ({placeholders}) \
                       AND q.day >= ? AND q.day <= ? AND q.source = ? \
                     ORDER BY q.asset_id, q.day ASC",
                    placeholders = placeholders
                )
            } else {
                // Ranking the sources in SQL sorts every row of the range; the
                // index already yields them in (asset, day) order, so the best
                // source per day is picked while reading instead.
                format!(
                    "SELECT q.* FROM quotes q \
                     WHERE q.asset_id IN ({placeholders}) AND q.day >= ? AND q.day <= ? \
                     ORDER BY q.asset_id, q.day",
                    placeholders = placeholders
                )
            };
            let mut query = Box::new(sql_query(sql)).into_boxed::<Sqlite>();
            for asset_id in chunk {
                query = query.bind::<Text, _>(asset_id.as_str());
            }
            query = query
                .bind::<Text, _>(start_str.clone())
                .bind::<Text, _>(end_str.clone());
            if let Some(source) = source {
                query = query.bind::<Text, _>(source.to_storage_string());
            }
            let rows = query.load::<QuoteDB>(&mut conn).into_core()?;
            let rows = if source.is_some() {
                rows
            } else {
                best_per_day(rows)
            };
            result.extend(rows.into_iter().map(Quote::from));
        }

        result.sort_by(|left, right| {
            left.asset_id
                .cmp(&right.asset_id)
                .then_with(|| left.timestamp.cmp(&right.timestamp))
        });

        Ok(result)
    }

    fn range_batch_from_dates(
        &self,
        asset_start_dates: &[(AssetId, Day)],
        end: Day,
        source: Option<&QuoteSource>,
    ) -> Result<Vec<Quote>> {
        if asset_start_dates.is_empty() {
            return Ok(Vec::new());
        }

        const ASSET_DATE_BATCH_SIZE: usize = 400;
        let mut conn = get_connection(&self.pool)?;
        let end_str = end.date().format("%Y-%m-%d").to_string();
        let mut result = Vec::new();

        for chunk in asset_start_dates.chunks(ASSET_DATE_BATCH_SIZE) {
            let request_values = chunk
                .iter()
                .map(|_| "(?, ?)")
                .collect::<Vec<_>>()
                .join(", ");
            let sql = if source.is_some() {
                format!(
                    "WITH requested(asset_id, start_day) AS (VALUES {request_values}) \
                     SELECT q.* FROM quotes q \
                     JOIN requested r ON r.asset_id = q.asset_id \
                     WHERE q.day >= r.start_day AND q.day <= ? AND q.source = ? \
                     ORDER BY q.asset_id, q.day ASC"
                )
            } else {
                format!(
                    "WITH requested(asset_id, start_day) AS (VALUES {request_values}), \
                     RankedQuotes AS ( \
                        SELECT q.*, \
                            ROW_NUMBER() OVER (PARTITION BY q.asset_id, q.day ORDER BY {priority} ASC, q.timestamp DESC) as rn \
                        FROM quotes q \
                        JOIN requested r ON r.asset_id = q.asset_id \
                        WHERE q.day >= r.start_day AND q.day <= ? \
                     ) \
                     SELECT * FROM RankedQuotes WHERE rn = 1 \
                     ORDER BY asset_id, day ASC",
                    priority = SOURCE_PRIORITY_CASE_Q,
                )
            };
            let mut query = Box::new(sql_query(sql)).into_boxed::<Sqlite>();
            for (asset_id, start) in chunk {
                query = query.bind::<Text, _>(asset_id.as_str());
                query = query.bind::<Text, _>(start.date().format("%Y-%m-%d").to_string());
            }
            query = query.bind::<Text, _>(end_str.clone());
            if let Some(source) = source {
                query = query.bind::<Text, _>(source.to_storage_string());
            }
            result.extend(
                query
                    .load::<QuoteDB>(&mut conn)
                    .into_core()?
                    .into_iter()
                    .map(Quote::from),
            );
        }

        result.sort_by(|left, right| {
            left.asset_id
                .cmp(&right.asset_id)
                .then_with(|| left.timestamp.cmp(&right.timestamp))
        });
        Ok(result)
    }

    fn get_latest_quotes_for_asset_dates(
        &self,
        requests: &[(String, NaiveDate)],
    ) -> Result<HashMap<(String, NaiveDate), Quote>> {
        if requests.is_empty() {
            return Ok(HashMap::new());
        }

        let mut requests: Vec<(String, NaiveDate)> = requests
            .iter()
            .filter(|(asset_id, _)| !asset_id.is_empty())
            .cloned()
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        requests.sort();

        let mut conn = get_connection(&self.pool)?;
        let mut result = HashMap::new();
        let pairs_per_chunk = (SQLITE_MAX_PARAMS_CHUNK / 2).max(1);

        for chunk in requests.chunks(pairs_per_chunk) {
            let request_values = chunk
                .iter()
                .map(|_| "(?, ?)")
                .collect::<Vec<_>>()
                .join(", ");
            let sql = format!(
                "WITH requested(asset_id, requested_day) AS (VALUES {request_values}), \
                 SelectedQuotes AS ( \
                    SELECT requested.asset_id, requested.requested_day, \
                           (SELECT q.id \
                            FROM quotes q \
                            WHERE q.asset_id = requested.asset_id \
                              AND q.day <= requested.requested_day \
                            ORDER BY q.day DESC, {priority} ASC, q.timestamp DESC \
                            LIMIT 1) AS quote_id \
                    FROM requested \
                 ) \
                 SELECT q.id, q.asset_id, selected.requested_day AS day, q.source, \
                        q.open, q.high, q.low, q.close, q.adjclose, q.volume, q.currency, \
                        q.notes, q.created_at, \
                        selected.requested_day || 'T12:00:00+00:00' AS timestamp \
                 FROM SelectedQuotes selected \
                 JOIN quotes q ON q.id = selected.quote_id \
                 ORDER BY q.asset_id, selected.requested_day",
                request_values = request_values,
                priority = SOURCE_PRIORITY_CASE_Q,
            );

            let mut query_builder = Box::new(sql_query(sql)).into_boxed::<Sqlite>();
            for (asset_id, requested_date) in chunk {
                query_builder = query_builder.bind::<Text, _>(asset_id);
                query_builder =
                    query_builder.bind::<Text, _>(requested_date.format("%Y-%m-%d").to_string());
            }

            // These are read-only forward-filled views: the row id belongs to the
            // source quote while day/timestamp identify the requested date. They
            // must never be passed to a quote persistence API.
            let rows: Vec<QuoteDB> = query_builder.load::<QuoteDB>(&mut conn).into_core()?;
            for row in rows {
                let quote: Quote = row.into();
                let requested_date = quote.timestamp.date_naive();
                result.insert((quote.asset_id.clone(), requested_date), quote);
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

    fn get_quote_bounds_for_assets_any_source(
        &self,
        asset_ids: &[String],
    ) -> Result<HashMap<String, (NaiveDate, NaiveDate)>> {
        if asset_ids.is_empty() {
            return Ok(HashMap::new());
        }

        let mut conn = get_connection(&self.pool)?;
        let mut result = HashMap::new();

        #[derive(QueryableByName)]
        struct QuoteBoundsRow {
            #[diesel(sql_type = diesel::sql_types::Text)]
            asset_id: String,
            #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::Text>)]
            min_day: Option<String>,
            #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::Text>)]
            max_day: Option<String>,
        }

        for chunk in chunk_for_sqlite(asset_ids) {
            let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
            let sql = format!(
                "SELECT asset_id, MIN(day) as min_day, MAX(day) as max_day \
                 FROM quotes WHERE asset_id IN ({}) GROUP BY asset_id",
                placeholders
            );
            let mut query_builder = Box::new(sql_query(sql)).into_boxed::<Sqlite>();
            for asset_id in chunk {
                query_builder = query_builder.bind::<Text, _>(asset_id);
            }

            let rows: Vec<QuoteBoundsRow> = query_builder
                .load::<QuoteBoundsRow>(&mut conn)
                .into_core()?;
            for row in rows {
                if let (Some(min_day), Some(max_day)) = (row.min_day, row.max_day) {
                    if let (Ok(min_date), Ok(max_date)) = (
                        NaiveDate::parse_from_str(&min_day, "%Y-%m-%d"),
                        NaiveDate::parse_from_str(&max_day, "%Y-%m-%d"),
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
    use chrono::{NaiveDate, NaiveTime, TimeZone, Utc};
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

    struct NoSecrets;
    impl wealthfolio_core::secrets::SecretStore for NoSecrets {
        fn set_secret(&self, _: &str, _: &str) -> Result<()> {
            Ok(())
        }
        fn get_secret(&self, _: &str) -> Result<Option<String>> {
            Ok(None)
        }
        fn delete_secret(&self, _: &str) -> Result<()> {
            Ok(())
        }
    }

    #[derive(Default)]
    struct ShortHistoryProvider {
        gate: Option<(Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>)>,
    }
    #[async_trait]
    impl wealthfolio_market_data::MarketDataProvider for ShortHistoryProvider {
        fn id(&self) -> &'static str {
            "YAHOO"
        }
        fn capabilities(&self) -> wealthfolio_market_data::ProviderCapabilities {
            wealthfolio_market_data::FixtureProvider::new("unused").capabilities()
        }
        fn rate_limit(&self) -> wealthfolio_market_data::RateLimit {
            Default::default()
        }
        async fn get_latest_quote(
            &self,
            _: &wealthfolio_market_data::QuoteContext,
            _: wealthfolio_market_data::ProviderInstrument,
        ) -> std::result::Result<
            wealthfolio_market_data::Quote,
            wealthfolio_market_data::errors::MarketDataError,
        > {
            unreachable!("history test must not fall back to latest")
        }
        async fn get_historical_quotes(
            &self,
            _: &wealthfolio_market_data::QuoteContext,
            _: wealthfolio_market_data::ProviderInstrument,
            start: chrono::DateTime<Utc>,
            end: chrono::DateTime<Utc>,
        ) -> std::result::Result<
            Vec<wealthfolio_market_data::Quote>,
            wealthfolio_market_data::errors::MarketDataError,
        > {
            if let Some((started, release)) = &self.gate {
                started.notify_one();
                release.notified().await;
            }
            Ok((2015..2020)
                .map(|year| {
                    wealthfolio_market_data::Quote::new(
                        Utc.with_ymd_and_hms(year, 1, 4, 12, 0, 0).unwrap(),
                        Decimal::TEN,
                        "USD".into(),
                        "YAHOO".into(),
                    )
                })
                .filter(|q| q.timestamp >= start && q.timestamp <= end)
                .collect())
        }
    }

    #[tokio::test]
    async fn backfill_execution_preserves_history_then_explicit_reset_replaces_it() {
        use wealthfolio_core::quotes::{
            MarketDataClient, QuoteSyncService, QuoteSyncServiceTrait, SyncMode,
        };
        let (repo, _temp) = create_test_repository().await;
        insert_test_asset(&repo, "AAPL");
        let mut conn = get_connection(&repo.pool).unwrap();
        diesel::sql_query("UPDATE market_data_providers SET enabled=0")
            .execute(&mut conn)
            .unwrap();
        diesel::sql_query("INSERT INTO accounts (id,name,account_type,currency,is_default,is_active,created_at,updated_at) VALUES ('history-account','History','SECURITIES','USD',0,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)")
            .execute(&mut conn).unwrap();
        diesel::sql_query("INSERT INTO activities (id,account_id,asset_id,activity_type,activity_date,quantity,unit_price,currency,created_at,updated_at) VALUES ('history-buy','history-account','AAPL','BUY','2010-01-04T12:00:00Z','1','1','USD',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)")
            .execute(&mut conn).unwrap();
        drop(conn);
        let old_quotes: Vec<_> = (2010..2020)
            .map(|year| {
                quote_with_source(
                    "AAPL",
                    NaiveDate::from_ymd_opt(year, 1, 4).unwrap(),
                    "YAHOO",
                    Decimal::ONE,
                )
            })
            .collect();
        repo.upsert_quotes(&old_quotes).await.unwrap();
        let repo = Arc::new(repo);
        let client = MarketDataClient::new_with_extra(
            Arc::new(NoSecrets),
            vec![],
            vec![Arc::new(ShortHistoryProvider::default())],
        )
        .await
        .unwrap();
        let sync = QuoteSyncService::new(
            Arc::new(tokio::sync::RwLock::new(client)),
            repo.clone(),
            Arc::new(crate::market_data::QuoteSyncStateRepository::new(
                repo.pool.clone(),
                repo.writer.clone(),
            )),
            Arc::new(crate::assets::AssetRepository::new(
                repo.pool.clone(),
                repo.writer.clone(),
            )),
            Arc::new(crate::activities::ActivityRepository::new(
                repo.pool.clone(),
                repo.writer.clone(),
            )),
        );
        let result = sync
            .sync(
                SyncMode::BackfillHistory { days: 365 },
                Some(vec!["AAPL".into()]),
            )
            .await
            .unwrap();
        assert_eq!(result.failed, 0, "{:?}", result.failures);
        assert_eq!(result.quotes_synced, 5);
        assert_eq!(raw_rows(&repo, "AAPL").len(), 10);
        let reset = sync.reset_provider_history("AAPL").await.unwrap();
        assert_eq!((reset.deleted_count, reset.inserted_count), (10, 5));
        assert_eq!(raw_rows(&repo, "AAPL").len(), 5);
    }

    #[tokio::test]
    async fn global_reset_commits_successes_preserves_failures_and_skips_manual_assets() {
        use wealthfolio_core::quotes::{MarketDataClient, QuoteSyncService};
        let (repo, _temp) = create_test_repository().await;
        for id in ["GOOD", "FAILED", "MANUAL"] {
            insert_test_asset(&repo, id);
            repo.save_quote(&quote_with_source(
                id,
                NaiveDate::from_ymd_opt(2010, 1, 4).unwrap(),
                "YAHOO",
                Decimal::ONE,
            ))
            .await
            .unwrap();
        }
        let mut conn = get_connection(&repo.pool).unwrap();
        diesel::sql_query("UPDATE market_data_providers SET enabled=0")
            .execute(&mut conn)
            .unwrap();
        diesel::sql_query(r#"UPDATE assets SET provider_config='{"preferred_provider":"UNAVAILABLE"}' WHERE id='FAILED'"#)
            .execute(&mut conn).unwrap();
        diesel::sql_query("UPDATE assets SET quote_mode='MANUAL' WHERE id='MANUAL'")
            .execute(&mut conn)
            .unwrap();
        drop(conn);
        let repo = Arc::new(repo);
        let client = MarketDataClient::new_with_extra(
            Arc::new(NoSecrets),
            vec![],
            vec![Arc::new(ShortHistoryProvider::default())],
        )
        .await
        .unwrap();
        let sync = QuoteSyncService::new(
            Arc::new(tokio::sync::RwLock::new(client)),
            repo.clone(),
            Arc::new(crate::market_data::QuoteSyncStateRepository::new(
                repo.pool.clone(),
                repo.writer.clone(),
            )),
            Arc::new(crate::assets::AssetRepository::new(
                repo.pool.clone(),
                repo.writer.clone(),
            )),
            Arc::new(crate::activities::ActivityRepository::new(
                repo.pool.clone(),
                repo.writer.clone(),
            )),
        );
        let result = sync.reset_all_provider_history().await.unwrap();
        assert_eq!(result.results.len(), 1);
        assert_eq!(result.results[0].asset_id, "GOOD");
        assert_eq!(result.failures.len(), 1);
        assert_eq!(result.failures[0].asset_id, "FAILED");
        assert!(result
            .skipped
            .iter()
            .any(|asset| asset.asset_id == "MANUAL"));
        assert_eq!(raw_rows(&repo, "GOOD").len(), 5);
        for id in ["FAILED", "MANUAL"] {
            let rows = raw_rows(&repo, id);
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0].close, "1");
        }
    }

    #[tokio::test]
    async fn reset_reports_busy_and_rechecks_configuration_after_fetch() {
        use wealthfolio_core::quotes::{MarketDataClient, QuoteSyncService};
        let (repo, _temp) = create_test_repository().await;
        insert_test_asset(&repo, "BUSY");
        diesel::sql_query("UPDATE market_data_providers SET enabled=0")
            .execute(&mut get_connection(&repo.pool).unwrap())
            .unwrap();
        repo.save_quote(&quote_with_source(
            "BUSY",
            NaiveDate::from_ymd_opt(2010, 1, 4).unwrap(),
            "YAHOO",
            Decimal::ONE,
        ))
        .await
        .unwrap();
        let repo = Arc::new(repo);
        let started = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let client = MarketDataClient::new_with_extra(
            Arc::new(NoSecrets),
            vec![],
            vec![Arc::new(ShortHistoryProvider {
                gate: Some((started.clone(), release.clone())),
            })],
        )
        .await
        .unwrap();
        let sync = Arc::new(QuoteSyncService::new(
            Arc::new(tokio::sync::RwLock::new(client)),
            repo.clone(),
            Arc::new(crate::market_data::QuoteSyncStateRepository::new(
                repo.pool.clone(),
                repo.writer.clone(),
            )),
            Arc::new(crate::assets::AssetRepository::new(
                repo.pool.clone(),
                repo.writer.clone(),
            )),
            Arc::new(crate::activities::ActivityRepository::new(
                repo.pool.clone(),
                repo.writer.clone(),
            )),
        ));
        let running = {
            let sync = sync.clone();
            tokio::spawn(async move { sync.reset_provider_history("BUSY").await })
        };
        tokio::time::timeout(std::time::Duration::from_secs(3), started.notified())
            .await
            .unwrap();
        let busy = sync.reset_provider_history("BUSY").await.unwrap_err();
        assert!(busy.to_string().contains("Already refreshing"));
        diesel::sql_query("UPDATE assets SET quote_mode='MANUAL' WHERE id='BUSY'")
            .execute(&mut get_connection(&repo.pool).unwrap())
            .unwrap();
        release.notify_one();
        assert!(running.await.unwrap().is_err());
        assert_eq!(raw_rows(&repo, "BUSY").len(), 1);
    }

    fn raw_rows(repo: &MarketDataRepository, asset: &str) -> Vec<QuoteDB> {
        quotes_dsl::quotes
            .filter(quotes_dsl::asset_id.eq(asset))
            .order((quotes_dsl::day, quotes_dsl::source))
            .select(QuoteDB::as_select())
            .load(&mut get_connection(&repo.pool).unwrap())
            .unwrap()
    }

    #[tokio::test]
    async fn explicit_refresh_merges_five_years_without_deleting_ten_years() {
        let (repo, _temp) = create_test_repository().await;
        insert_test_asset(&repo, "MERGE");
        let quotes: Vec<_> = (2010..2020)
            .map(|year| {
                quote_with_source(
                    "MERGE",
                    NaiveDate::from_ymd_opt(year, 1, 4).unwrap(),
                    "YAHOO",
                    Decimal::ONE,
                )
            })
            .collect();
        repo.upsert_quotes(&quotes).await.unwrap();
        let recent: Vec<_> = quotes[5..]
            .iter()
            .cloned()
            .map(|mut q| {
                q.close = Decimal::TEN;
                q
            })
            .collect();
        repo.upsert_quotes(&recent).await.unwrap();
        let rows = raw_rows(&repo, "MERGE");
        assert_eq!(rows.len(), 10);
        assert_eq!(rows[0].close, "1");
        assert_eq!(rows[9].close, "10");
    }

    #[tokio::test]
    async fn reset_preserves_overlays_and_inserts_provider_rows_beneath_them() {
        let (repo, _temp) = create_test_repository().await;
        insert_test_asset(&repo, "RESET");
        let old = NaiveDate::from_ymd_opt(2010, 1, 4).unwrap();
        let today = NaiveDate::from_ymd_opt(2025, 1, 4).unwrap();
        for (date, source) in [(old, "YAHOO"), (today, "MANUAL"), (today, "BROKER")] {
            repo.save_quote(&quote_with_source("RESET", date, source, Decimal::ONE))
                .await
                .unwrap();
        }
        let context = repo.provider_history_reset_context("RESET").unwrap();
        assert_eq!(context.earliest_provider_date, Some(old));
        let result = repo
            .replace_provider_history(
                context,
                vec![quote_with_source("RESET", today, "YAHOO", Decimal::TEN)],
            )
            .await
            .unwrap();
        assert_eq!((result.deleted_count, result.inserted_count), (1, 1));
        let rows = raw_rows(&repo, "RESET");
        assert_eq!(rows.len(), 3);
        assert!(rows.iter().all(|r| r.day == "2025-01-04"));
        assert!(rows.iter().any(|r| r.source == "YAHOO" && r.close == "10"));
    }

    #[tokio::test]
    async fn reset_rolls_back_deletion_when_insertion_fails() {
        let (repo, _temp) = create_test_repository().await;
        insert_test_asset(&repo, "ROLLBACK");
        let date = NaiveDate::from_ymd_opt(2025, 1, 4).unwrap();
        repo.upsert_quotes(&[quote_with_source("ROLLBACK", date, "YAHOO", Decimal::ONE)])
            .await
            .unwrap();
        let before = raw_rows(&repo, "ROLLBACK");
        let context = repo.provider_history_reset_context("ROLLBACK").unwrap();
        diesel::sql_query("CREATE TRIGGER reject_reset BEFORE INSERT ON quotes WHEN NEW.source = 'FAIL' BEGIN SELECT RAISE(ABORT, 'injected failure'); END")
            .execute(&mut get_connection(&repo.pool).unwrap()).unwrap();
        assert!(repo
            .replace_provider_history(
                context,
                vec![quote_with_source("ROLLBACK", date, "FAIL", Decimal::TEN)]
            )
            .await
            .is_err());
        assert_eq!(
            serde_json::to_value(raw_rows(&repo, "ROLLBACK")).unwrap(),
            serde_json::to_value(before).unwrap()
        );
    }

    #[tokio::test]
    async fn reset_ignores_unrelated_custom_provider_configuration_changes() {
        let (repo, _temp) = create_test_repository().await;
        insert_test_asset(&repo, "RESET");
        let date = NaiveDate::from_ymd_opt(2025, 1, 4).unwrap();
        repo.save_quote(&quote_with_source("RESET", date, "YAHOO", Decimal::ONE))
            .await
            .unwrap();
        let mut conn = get_connection(&repo.pool).unwrap();
        diesel::sql_query("INSERT INTO market_data_custom_providers
            (id, code, name, description, enabled, priority, config, created_at, updated_at)
            VALUES ('unrelated', 'UNRELATED', 'Unrelated', '', 1, 1, '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)")
            .execute(&mut conn).unwrap();
        let context = repo.provider_history_reset_context("RESET").unwrap();
        diesel::sql_query(r#"UPDATE market_data_custom_providers SET config='{"changed":true}' WHERE id='unrelated'"#)
            .execute(&mut conn).unwrap();
        let result = repo
            .replace_provider_history(
                context,
                vec![quote_with_source("RESET", date, "YAHOO", Decimal::TEN)],
            )
            .await
            .unwrap();
        assert_eq!((result.deleted_count, result.inserted_count), (1, 1));
        let rows = raw_rows(&repo, "RESET");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].close, "10");
    }

    #[tokio::test]
    async fn reset_rejects_empty_wrong_asset_and_changed_configuration() {
        let (repo, _temp) = create_test_repository().await;
        insert_test_asset(&repo, "CONFLICT");
        let date = NaiveDate::from_ymd_opt(2025, 1, 4).unwrap();
        let quote = quote_with_source("CONFLICT", date, "YAHOO", Decimal::ONE);
        repo.save_quote(&quote).await.unwrap();
        let context = repo.provider_history_reset_context("CONFLICT").unwrap();
        assert!(repo
            .replace_provider_history(context.clone(), vec![])
            .await
            .is_err());
        let mut wrong_asset = quote.clone();
        wrong_asset.asset_id = "WRONG".into();
        assert!(repo
            .replace_provider_history(context.clone(), vec![wrong_asset])
            .await
            .is_err());
        diesel::sql_query("UPDATE assets SET instrument_symbol='CHANGED' WHERE id='CONFLICT'")
            .execute(&mut get_connection(&repo.pool).unwrap())
            .unwrap();
        assert!(repo
            .replace_provider_history(context, vec![quote.clone()])
            .await
            .is_err());
        assert_eq!(raw_rows(&repo, "CONFLICT").len(), 1);
        let context = repo.provider_history_reset_context("CONFLICT").unwrap();
        diesel::sql_query("UPDATE market_data_providers SET priority=priority+1 WHERE id='YAHOO'")
            .execute(&mut get_connection(&repo.pool).unwrap())
            .unwrap();
        assert!(repo
            .replace_provider_history(context, vec![quote])
            .await
            .is_err());
    }

    #[tokio::test]
    async fn quote_bounds_across_sources_use_earliest_and_latest_dates() {
        let (repo, _temp) = create_test_repository().await;
        let asset_id = "AAPL";
        insert_test_asset(&repo, asset_id);
        let earliest = NaiveDate::from_ymd_opt(2020, 1, 2).unwrap();
        let latest = NaiveDate::from_ymd_opt(2024, 6, 3).unwrap();

        repo.save_quote(&quote_with_source(
            asset_id,
            earliest,
            "MANUAL",
            Decimal::from(100),
        ))
        .await
        .unwrap();
        repo.save_quote(&quote_with_source(
            asset_id,
            latest,
            "YAHOO",
            Decimal::from(200),
        ))
        .await
        .unwrap();

        let bounds = repo
            .get_quote_bounds_for_assets_any_source(&[asset_id.to_string()])
            .unwrap();

        assert_eq!(bounds.get(asset_id), Some(&(earliest, latest)));
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
    async fn range_batch_keeps_the_best_source_of_each_day() {
        let (repo, _temp) = create_test_repository().await;
        insert_test_asset(&repo, "RANK-A");
        insert_test_asset(&repo, "RANK-B");
        let day = |d: u32| NaiveDate::from_ymd_opt(2024, 6, d).unwrap();
        let at = |d: u32, hour: u32, source: &str, close: i64| {
            let mut quote = quote_with_source("RANK-A", day(d), source, Decimal::from(close));
            quote.timestamp = Utc.from_utc_datetime(&day(d).and_hms_opt(hour, 0, 0).unwrap());
            quote
        };
        for quote in [
            // Day 3: manual beats the provider and the broker.
            at(3, 16, "BROKER", 13),
            at(3, 16, "YAHOO", 12),
            at(3, 16, "MANUAL", 11),
            // Day 4: between providers the later one wins; the broker last.
            at(4, 12, "STOOQ", 21),
            at(4, 16, "YAHOO", 22),
            at(4, 20, "BROKER", 23),
            // Day 5: a broker quote alone still counts.
            at(5, 16, "BROKER", 33),
        ] {
            repo.save_quote(&quote).await.expect("save quote");
        }
        repo.save_quote(&quote_with_source(
            "RANK-B",
            day(3),
            "YAHOO",
            Decimal::from(41),
        ))
        .await
        .expect("save quote");

        let asset_ids = [AssetId::new("RANK-B"), AssetId::new("RANK-A")];
        let quotes = repo
            .range_batch(&asset_ids, Day::new(day(3)), Day::new(day(5)), None)
            .expect("get batch range");
        let closes: Vec<(String, Decimal)> = quotes
            .iter()
            .map(|q| (q.asset_id.clone(), q.close))
            .collect();
        assert_eq!(
            closes,
            vec![
                ("RANK-A".to_string(), Decimal::from(11)),
                ("RANK-A".to_string(), Decimal::from(22)),
                ("RANK-A".to_string(), Decimal::from(33)),
                ("RANK-B".to_string(), Decimal::from(41)),
            ]
        );
        let mut single = Vec::new();
        for asset_id in &asset_ids {
            single.extend(
                repo.range(asset_id, Day::new(day(3)), Day::new(day(5)), None)
                    .expect("get single-asset range"),
            );
        }
        single.sort_by(|left, right| {
            left.asset_id
                .cmp(&right.asset_id)
                .then_with(|| left.timestamp.cmp(&right.timestamp))
        });
        assert_eq!(quotes, single);
    }

    #[tokio::test]
    async fn range_batch_matches_single_asset_range_and_source_filtering() {
        let (repo, _temp) = create_test_repository().await;
        let day = NaiveDate::from_ymd_opt(2024, 6, 3).unwrap();
        for asset_id in ["BATCH-A", "BATCH-B"] {
            insert_test_asset(&repo, asset_id);
            repo.save_quote(&quote_with_source(
                asset_id,
                day,
                "BROKER",
                Decimal::from(9),
            ))
            .await
            .expect("save broker quote");
            repo.save_quote(&quote_with_source(
                asset_id,
                day,
                "YAHOO",
                Decimal::from(10),
            ))
            .await
            .expect("save provider quote");
        }

        let asset_ids = [AssetId::new("BATCH-B"), AssetId::new("BATCH-A")];
        let quotes = repo
            .range_batch(&asset_ids, Day::new(day), Day::new(day), None)
            .expect("get batch range");

        assert_eq!(quotes.len(), 2);
        assert_eq!(quotes[0].asset_id, "BATCH-A");
        assert_eq!(quotes[1].asset_id, "BATCH-B");
        assert!(quotes
            .iter()
            .all(|quote| { quote.data_source == "YAHOO" && quote.close == Decimal::from(10) }));

        let mut expected = Vec::new();
        for asset_id in &asset_ids {
            expected.extend(
                repo.range(asset_id, Day::new(day), Day::new(day), None)
                    .expect("get single-asset range"),
            );
        }
        expected.sort_by(|left, right| left.asset_id.cmp(&right.asset_id));
        assert_eq!(quotes, expected);

        let broker = QuoteSource::from_storage_string("BROKER");
        let broker_quotes = repo
            .range_batch(&asset_ids, Day::new(day), Day::new(day), Some(&broker))
            .expect("get source-filtered batch range");
        assert_eq!(broker_quotes.len(), 2);
        assert!(broker_quotes
            .iter()
            .all(|quote| quote.data_source == "BROKER" && quote.close == Decimal::from(9)));
    }

    #[tokio::test]
    async fn asset_specific_batch_ranges_do_not_expand_newer_assets_to_global_start() {
        let (repo, _temp) = create_test_repository().await;
        let old_day = NaiveDate::from_ymd_opt(2020, 1, 2).unwrap();
        let recent_day = NaiveDate::from_ymd_opt(2024, 6, 3).unwrap();
        for asset_id in ["RANGE-OLD", "RANGE-NEW"] {
            insert_test_asset(&repo, asset_id);
            repo.save_quote(&quote_with_source(
                asset_id,
                old_day,
                "YAHOO",
                Decimal::from(10),
            ))
            .await
            .expect("save old quote");
            repo.save_quote(&quote_with_source(
                asset_id,
                recent_day,
                "YAHOO",
                Decimal::from(20),
            ))
            .await
            .expect("save recent quote");
        }

        let quotes = repo
            .range_batch_from_dates(
                &[
                    (AssetId::new("RANGE-OLD"), Day::new(old_day)),
                    (AssetId::new("RANGE-NEW"), Day::new(recent_day)),
                ],
                Day::new(recent_day),
                None,
            )
            .expect("get asset-specific ranges");

        let old_asset_dates: Vec<_> = quotes
            .iter()
            .filter(|quote| quote.asset_id == "RANGE-OLD")
            .map(|quote| quote.timestamp.date_naive())
            .collect();
        let new_asset_dates: Vec<_> = quotes
            .iter()
            .filter(|quote| quote.asset_id == "RANGE-NEW")
            .map(|quote| quote.timestamp.date_naive())
            .collect();
        assert_eq!(old_asset_dates, vec![old_day, recent_day]);
        assert_eq!(new_asset_dates, vec![recent_day]);
    }

    #[tokio::test]
    async fn asset_specific_seed_query_preserves_the_persisted_quote_date() {
        let (repo, _temp) = create_test_repository().await;
        let asset_id = "SEED-DATE";
        insert_test_asset(&repo, asset_id);
        let quote_day = NaiveDate::from_ymd_opt(2020, 1, 2).unwrap();
        let cutoff_day = NaiveDate::from_ymd_opt(2024, 6, 3).unwrap();
        repo.save_quote(&quote_with_source(
            asset_id,
            quote_day,
            "YAHOO",
            Decimal::from(42),
        ))
        .await
        .expect("save seed quote");

        let quotes = repo
            .get_latest_quotes_as_of_dates(&[(asset_id.to_string(), cutoff_day)])
            .expect("get asset-specific seed");
        let quote = quotes.get(asset_id).expect("seed quote exists");

        assert_eq!(quote.timestamp.date_naive(), quote_day);
        assert_eq!(quote.close, Decimal::from(42));
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

    #[tokio::test]
    async fn latest_quotes_as_of_uses_timestamp_for_equal_priority_sources() {
        let (repo, _temp) = create_test_repository().await;
        let asset_id = "SEED-TIE";
        insert_test_asset(&repo, asset_id);

        let day = NaiveDate::from_ymd_opt(2024, 6, 3).unwrap();
        let mut earlier = quote_with_source(asset_id, day, "YAHOO", Decimal::from(51));
        earlier.timestamp = day.and_hms_opt(12, 0, 0).unwrap().and_utc();
        let mut later = quote_with_source(asset_id, day, "STOOQ", Decimal::from(52));
        later.timestamp = day.and_hms_opt(16, 0, 0).unwrap().and_utc();

        repo.save_quote(&earlier)
            .await
            .expect("save earlier provider");
        repo.save_quote(&later).await.expect("save later provider");

        let quotes = repo
            .get_latest_quotes_as_of(&[asset_id.to_string()], day)
            .expect("get latest quotes as of");
        let quote = quotes.get(asset_id).expect("quote exists");
        assert_eq!(quote.data_source, "STOOQ");
        assert_eq!(quote.close, Decimal::from(52));
    }

    #[tokio::test]
    async fn latest_quotes_as_of_prefers_the_latest_day_over_source_priority() {
        let (repo, _temp) = create_test_repository().await;
        insert_test_asset(&repo, "LATER-PROVIDER");
        insert_test_asset(&repo, "ONLY-MANUAL");

        let monday = NaiveDate::from_ymd_opt(2024, 6, 3).unwrap();
        let tuesday = NaiveDate::from_ymd_opt(2024, 6, 4).unwrap();
        for (asset_id, day, source, close) in [
            ("LATER-PROVIDER", monday, "MANUAL", 50),
            ("LATER-PROVIDER", tuesday, "YAHOO", 51),
            ("ONLY-MANUAL", monday, "MANUAL", 70),
        ] {
            repo.save_quote(&quote_with_source(
                asset_id,
                day,
                source,
                Decimal::from(close),
            ))
            .await
            .expect("save quote");
        }

        let quotes = repo
            .get_latest_quotes_as_of(
                &["LATER-PROVIDER".to_string(), "ONLY-MANUAL".to_string()],
                tuesday,
            )
            .expect("get latest quotes as of");
        assert_eq!(quotes.len(), 2);
        assert_eq!(quotes["LATER-PROVIDER"].close, Decimal::from(51));
        assert_eq!(quotes["ONLY-MANUAL"].close, Decimal::from(70));
    }

    #[tokio::test]
    async fn sparse_asset_date_quotes_select_latest_prior_without_calendar_expansion() {
        let (repo, _temp) = create_test_repository().await;
        let asset_id = "SPARSE";
        insert_test_asset(&repo, asset_id);

        let old_day = NaiveDate::from_ymd_opt(2020, 1, 1).unwrap();
        let newer_day = NaiveDate::from_ymd_opt(2024, 6, 3).unwrap();
        let before_first_quote = NaiveDate::from_ymd_opt(2019, 12, 31).unwrap();
        let first_request = NaiveDate::from_ymd_opt(2023, 1, 1).unwrap();
        let exact_request = newer_day;
        let second_request = NaiveDate::from_ymd_opt(2026, 1, 1).unwrap();
        repo.save_quote(&quote_with_source(
            asset_id,
            old_day,
            "YAHOO",
            Decimal::from(40),
        ))
        .await
        .expect("save old quote");
        repo.save_quote(&quote_with_source(
            asset_id,
            newer_day,
            "BROKER",
            Decimal::from(52),
        ))
        .await
        .expect("save broker quote");
        repo.save_quote(&quote_with_source(
            asset_id,
            newer_day,
            "YAHOO",
            Decimal::from(51),
        ))
        .await
        .expect("save provider quote");

        let requests = vec![
            (asset_id.to_string(), before_first_quote),
            (asset_id.to_string(), first_request),
            (asset_id.to_string(), exact_request),
            (asset_id.to_string(), second_request),
        ];
        let quotes = repo
            .get_latest_quotes_for_asset_dates(&requests)
            .expect("load sparse quotes");

        let first = quotes
            .get(&(asset_id.to_string(), first_request))
            .expect("first sparse quote");
        assert_eq!(first.close, Decimal::from(40));
        assert_eq!(first.timestamp.date_naive(), first_request);
        assert_eq!(
            first.timestamp.time(),
            NaiveTime::from_hms_opt(12, 0, 0).unwrap()
        );

        let exact = quotes
            .get(&(asset_id.to_string(), exact_request))
            .expect("exact-date sparse quote");
        assert_eq!(exact.close, Decimal::from(51));
        assert_eq!(exact.data_source, "YAHOO");

        let second = quotes
            .get(&(asset_id.to_string(), second_request))
            .expect("second sparse quote");
        assert_eq!(second.close, Decimal::from(51));
        assert_eq!(second.data_source, "YAHOO");
        assert_eq!(second.timestamp.date_naive(), second_request);
        assert!(!quotes.contains_key(&(asset_id.to_string(), before_first_quote)));
        assert_eq!(quotes.len(), 3);
    }

    #[tokio::test]
    async fn sparse_asset_date_quotes_use_timestamp_to_break_equal_source_priority() {
        let (repo, _temp) = create_test_repository().await;
        let asset_id = "SPARSE-TIE";
        insert_test_asset(&repo, asset_id);

        let quote_day = NaiveDate::from_ymd_opt(2025, 4, 1).unwrap();
        let requested_day = NaiveDate::from_ymd_opt(2025, 4, 2).unwrap();
        let mut earlier = quote_with_source(asset_id, quote_day, "YAHOO", Decimal::from(40));
        earlier.timestamp = quote_day.and_hms_opt(12, 0, 0).unwrap().and_utc();
        let mut later = quote_with_source(asset_id, quote_day, "STOOQ", Decimal::from(41));
        later.timestamp = quote_day.and_hms_opt(16, 0, 0).unwrap().and_utc();

        repo.save_quote(&earlier).await.expect("save earlier quote");
        repo.save_quote(&later).await.expect("save later quote");

        let quotes = repo
            .get_latest_quotes_for_asset_dates(&[(asset_id.to_string(), requested_day)])
            .expect("load sparse quote");
        let selected = quotes
            .get(&(asset_id.to_string(), requested_day))
            .expect("selected sparse quote");

        assert_eq!(selected.data_source, "STOOQ");
        assert_eq!(selected.close, Decimal::from(41));
        assert_eq!(
            selected.timestamp.time(),
            NaiveTime::from_hms_opt(12, 0, 0).unwrap()
        );
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
