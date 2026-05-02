use async_trait::async_trait;
use chrono::NaiveDate;
use diesel::prelude::*;
use diesel::r2d2::{ConnectionManager, Pool};
use diesel::sql_query;
use diesel::sql_types::Text;
use diesel::sqlite::Sqlite;
use diesel::sqlite::SqliteConnection;
use std::collections::HashMap;
use std::sync::Arc;

use super::model::DailyAccountValuationDB;
use crate::db::{get_connection, WriteHandle};
use crate::errors::StorageError;
use wealthfolio_core::constants::PORTFOLIO_TOTAL_ACCOUNT_ID;
use crate::schema::daily_account_valuation;
use crate::schema::daily_account_valuation::dsl::*;
use wealthfolio_core::errors::Result;
use wealthfolio_core::portfolio::valuation::{
    DailyAccountValuation, NegativeBalanceInfo, ValuationRepositoryTrait,
};

pub struct ValuationRepository {
    pool: Arc<Pool<ConnectionManager<SqliteConnection>>>,
    writer: WriteHandle,
}

impl ValuationRepository {
    pub fn new(pool: Arc<Pool<ConnectionManager<SqliteConnection>>>, writer: WriteHandle) -> Self {
        Self { pool, writer }
    }
}

#[async_trait]
impl ValuationRepositoryTrait for ValuationRepository {
    async fn save_valuations(&self, valuation_records: &[DailyAccountValuation]) -> Result<()> {
        if valuation_records.is_empty() {
            return Ok(());
        }

        // Materialize the records once before moving into the closure
        let records_to_save: Vec<DailyAccountValuationDB> = valuation_records
            .iter()
            .cloned()
            .map(DailyAccountValuationDB::from)
            .collect();

        self.writer
            .exec(move |conn| {
                for chunk in records_to_save.chunks(1000) {
                    diesel::replace_into(daily_account_valuation::table)
                        .values(chunk) // Pass the chunk directly
                        .execute(conn)
                        .map_err(StorageError::from)?;
                }
                Ok(())
            })
            .await
    }

    fn get_historical_valuations(
        &self,
        input_account_id: &str,
        start_date_opt: Option<NaiveDate>,
        end_date_opt: Option<NaiveDate>,
    ) -> Result<Vec<DailyAccountValuation>> {
        let mut conn = get_connection(&self.pool)?;

        let mut query = daily_account_valuation::table
            .filter(account_id.eq(input_account_id))
            .order(valuation_date.asc())
            .into_boxed();

        if let Some(start_date_val) = start_date_opt {
            query = query.filter(valuation_date.ge(start_date_val));
        }

        if let Some(end_date_val) = end_date_opt {
            query = query.filter(valuation_date.le(end_date_val));
        }

        let history_dbs = query
            .load::<DailyAccountValuationDB>(&mut conn)
            .map_err(StorageError::from)?;

        // Convert Vec<DailyAccountValuationDB> to Vec<DailyAccountValuation>
        // Handle potential conversion errors if necessary (using From implicitly handles unwrap_or_default)
        let history_records: Vec<DailyAccountValuation> = history_dbs
            .into_iter()
            .map(DailyAccountValuation::from)
            .collect();

        Ok(history_records)
    }

    fn load_latest_valuation_date(&self, input_account_id: &str) -> Result<Option<NaiveDate>> {
        use diesel::OptionalExtension; // Ensure OptionalExtension is in scope
        let mut conn = get_connection(&self.pool)?;

        // Select the max date. This returns Option<NaiveDate> at the SQL level.
        // Execute with .first(). This returns Result<T, Error> where T is Option<NaiveDate>.
        // Use .optional() to convert Result<Option<NaiveDate>, Error> where Error=NotFound to Ok(None),
        // and other errors to Err(...). This yields a Result<Option<Option<NaiveDate>>, Error>.
        let result: Option<Option<NaiveDate>> = daily_account_valuation::table
            .filter(account_id.eq(input_account_id))
            .select(diesel::dsl::max(valuation_date))
            .first::<Option<NaiveDate>>(&mut conn)
            .optional()
            .map_err(StorageError::from)?;

        // Flatten the Option<Option<NaiveDate>> to Option<NaiveDate>
        let latest_date = result.flatten();

        Ok(latest_date)
    }

    async fn delete_valuations_for_account(
        &self,
        input_account_id: &str,
        since_date: Option<NaiveDate>,
    ) -> Result<()> {
        let account_id_owned = input_account_id.to_string();
        self.writer
            .exec(move |conn| {
                match since_date {
                    None => {
                        diesel::delete(
                            daily_account_valuation::table.filter(account_id.eq(account_id_owned)),
                        )
                        .execute(conn)
                        .map_err(StorageError::from)?;
                    }
                    Some(date) => {
                        let date_str = date.to_string();
                        diesel::delete(
                            daily_account_valuation::table
                                .filter(account_id.eq(account_id_owned))
                                .filter(valuation_date.ge(date_str)),
                        )
                        .execute(conn)
                        .map_err(StorageError::from)?;
                    }
                }
                Ok(())
            })
            .await
    }

    fn get_latest_valuations(
        &self,
        input_account_ids: &[String],
    ) -> Result<Vec<DailyAccountValuation>> {
        if input_account_ids.is_empty() {
            return Ok(Vec::new());
        }

        let mut conn = get_connection(&self.pool)?;

        let placeholders: String = input_account_ids
            .iter()
            .map(|_| "?")
            .collect::<Vec<&str>>()
            .join(", ");

        // Ensure all fields from DailyAccountValuationDB are selected, in the correct order.
        let sql = format!(
            "WITH RankedValuations AS ( \
                SELECT \
                    id, account_id, valuation_date, account_currency, base_currency, \
                    fx_rate_to_base, cash_balance, investment_market_value, total_value, \
                    cost_basis, net_contribution, calculated_at, alternative_market_value, \
                    ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY valuation_date DESC) as rn \
                FROM {} \
                WHERE account_id IN ({}) \
            ) \
            SELECT \
                id, account_id, valuation_date, account_currency, base_currency, \
                fx_rate_to_base, cash_balance, investment_market_value, total_value, \
                cost_basis, net_contribution, calculated_at, alternative_market_value \
            FROM RankedValuations \
            WHERE rn = 1",
            "daily_account_valuation", // Use direct table name string
            placeholders
        );

        let mut query_builder = sql_query(sql).into_boxed::<Sqlite>();

        for acc_id_str in input_account_ids {
            query_builder = query_builder.bind::<Text, _>(acc_id_str);
        }

        let latest_valuations_db: Vec<DailyAccountValuationDB> = query_builder
            .load::<DailyAccountValuationDB>(&mut conn)
            .map_err(StorageError::from)?;

        // To maintain input order, we first put results into a map
        let mut results_map: HashMap<String, DailyAccountValuation> = latest_valuations_db
            .into_iter()
            .map(|db_item| {
                (
                    db_item.account_id.clone(),
                    DailyAccountValuation::from(db_item),
                )
            })
            .collect();

        // Then build the ordered Vec
        let mut ordered_results = Vec::new();
        for acc_id_str in input_account_ids {
            if let Some(valuation) = results_map.remove(acc_id_str) {
                // Use remove to avoid cloning if DailyAccountValuation is large
                ordered_results.push(valuation);
            }
        }
        Ok(ordered_results)
    }

    fn get_accounts_with_negative_balance(
        &self,
        input_account_ids: &[String],
    ) -> Result<Vec<NegativeBalanceInfo>> {
        if input_account_ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut conn = get_connection(&self.pool)?;
        let placeholders: String = input_account_ids
            .iter()
            .map(|_| "?")
            .collect::<Vec<&str>>()
            .join(", ");
        // SQLite returns non-aggregated columns from the row that determines MIN().
        let sql = format!(
            "SELECT account_id, MIN(valuation_date) AS first_negative_date, \
             cash_balance, total_value, account_currency \
             FROM daily_account_valuation \
             WHERE CAST(total_value AS REAL) < 0 AND account_id IN ({}) \
             GROUP BY account_id",
            placeholders
        );
        let mut query_builder = sql_query(sql).into_boxed::<Sqlite>();
        for acc_id in input_account_ids {
            query_builder = query_builder.bind::<Text, _>(acc_id);
        }
        #[derive(QueryableByName)]
        struct NegativeBalanceRow {
            #[diesel(sql_type = diesel::sql_types::Text, column_name = "account_id")]
            acc_id: String,
            #[diesel(sql_type = diesel::sql_types::Text, column_name = "first_negative_date")]
            neg_date: String,
            #[diesel(sql_type = diesel::sql_types::Text, column_name = "cash_balance")]
            cash_bal: String,
            #[diesel(sql_type = diesel::sql_types::Text, column_name = "total_value")]
            total_val: String,
            #[diesel(sql_type = diesel::sql_types::Text, column_name = "account_currency")]
            acc_currency: String,
        }
        let rows: Vec<NegativeBalanceRow> = query_builder
            .load::<NegativeBalanceRow>(&mut conn)
            .map_err(StorageError::from)?;
        let result = rows
            .into_iter()
            .filter_map(|r| {
                let date = NaiveDate::parse_from_str(&r.neg_date, "%Y-%m-%d").ok()?;
                let cash = r.cash_bal.parse::<rust_decimal::Decimal>().ok()?;
                let total = r.total_val.parse::<rust_decimal::Decimal>().ok()?;
                Some(NegativeBalanceInfo {
                    account_id: r.acc_id,
                    first_negative_date: date,
                    cash_balance: cash,
                    total_value: total,
                    account_currency: r.acc_currency,
                })
            })
            .collect();
        Ok(result)
    }

    fn get_valuations_on_date(
        &self,
        input_account_ids: &[String],
        input_date: NaiveDate,
    ) -> Result<Vec<DailyAccountValuation>> {
        if input_account_ids.is_empty() {
            return Ok(Vec::new()); // No need to query if the list is empty
        }

        let mut conn = get_connection(&self.pool)?;

        let history_dbs = daily_account_valuation::table
            .filter(account_id.eq_any(input_account_ids)) // Use eq_any for multiple IDs
            .filter(valuation_date.eq(input_date)) // Filter by the specific date
            .load::<DailyAccountValuationDB>(&mut conn)
            .map_err(StorageError::from)?;

        // Convert Vec<DailyAccountValuationDB> to Vec<DailyAccountValuation>
        let history_records: Vec<DailyAccountValuation> = history_dbs
            .into_iter()
            .map(DailyAccountValuation::from)
            .collect();

        Ok(history_records)
    }

    /// Returns per-account rows only — excludes the synthesized TOTAL row,
    /// which is regenerated by the aggregator from per-account data.
    fn get_all_account_valuations(
        &self,
        start_date_opt: Option<NaiveDate>,
        end_date_opt: Option<NaiveDate>,
    ) -> Result<Vec<DailyAccountValuation>> {
        let mut conn = get_connection(&self.pool)?;

        let mut query = daily_account_valuation::table
            .filter(account_id.ne(PORTFOLIO_TOTAL_ACCOUNT_ID))
            .order(valuation_date.asc())
            .into_boxed();

        if let Some(sd) = start_date_opt {
            query = query.filter(valuation_date.ge(sd));
        }
        if let Some(ed) = end_date_opt {
            query = query.filter(valuation_date.le(ed));
        }

        let rows = query
            .load::<DailyAccountValuationDB>(&mut conn)
            .map_err(StorageError::from)?;

        Ok(rows.into_iter().map(DailyAccountValuation::from).collect())
    }
}
