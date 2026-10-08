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
    async fn replace_valuations_for_account(
        &self,
        input_account_id: &str,
        since_date: Option<NaiveDate>,
        valuation_records: &[DailyAccountValuation],
    ) -> Result<()> {
        let account_id_owned = input_account_id.to_string();
        let records_to_save: Vec<DailyAccountValuationDB> = valuation_records
            .iter()
            .cloned()
            .map(DailyAccountValuationDB::from)
            .collect();

        self.writer
            .exec(move |conn| {
                match since_date {
                    None => {
                        diesel::delete(
                            daily_account_valuation::table
                                .filter(account_id.eq(account_id_owned.clone())),
                        )
                        .execute(conn)
                        .map_err(StorageError::from)?;
                    }
                    Some(date) => {
                        let date_str = date.to_string();
                        diesel::delete(
                            daily_account_valuation::table
                                .filter(account_id.eq(account_id_owned.clone()))
                                .filter(valuation_date.ge(date_str)),
                        )
                        .execute(conn)
                        .map_err(StorageError::from)?;
                    }
                }

                for chunk in records_to_save.chunks(1000) {
                    diesel::replace_into(daily_account_valuation::table)
                        .values(chunk)
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

    fn get_historical_valuations_for_accounts(
        &self,
        input_account_ids: &[String],
        start_date_opt: Option<NaiveDate>,
        end_date_opt: Option<NaiveDate>,
    ) -> Result<Vec<DailyAccountValuation>> {
        if input_account_ids.is_empty() {
            return Ok(Vec::new());
        }

        let mut conn = get_connection(&self.pool)?;

        let mut query = daily_account_valuation::table
            .filter(account_id.eq_any(input_account_ids))
            .order((valuation_date.asc(), account_id.asc()))
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

        Ok(history_dbs
            .into_iter()
            .map(DailyAccountValuation::from)
            .collect())
    }

    fn get_max_calculated_at_for_accounts(
        &self,
        input_account_ids: &[String],
        start_date_opt: Option<NaiveDate>,
        end_date_opt: Option<NaiveDate>,
    ) -> Result<Option<String>> {
        use diesel::OptionalExtension;

        if input_account_ids.is_empty() {
            return Ok(None);
        }

        let mut conn = get_connection(&self.pool)?;
        let mut query = daily_account_valuation::table
            .filter(account_id.eq_any(input_account_ids))
            .into_boxed();

        if let Some(start_date_val) = start_date_opt {
            query = query.filter(valuation_date.ge(start_date_val));
        }

        if let Some(end_date_val) = end_date_opt {
            query = query.filter(valuation_date.le(end_date_val));
        }

        let result: Option<Option<String>> = query
            .select(diesel::dsl::max(calculated_at))
            .first::<Option<String>>(&mut conn)
            .optional()
            .map_err(StorageError::from)?;

        Ok(result.flatten())
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
                    fx_rate_to_base, cash_balance, investment_market_value, \
                    total_value, cost_basis, net_contribution, cash_balance_base, \
                    investment_market_value_base, total_value_base, cost_basis_base, \
                    net_contribution_base, external_inflow_base, external_outflow_base, \
                    external_flow_source, performance_eligible_value_base, value_status, \
                    basis_status, calculated_at, \
                    ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY valuation_date DESC) as rn \
                FROM {} \
                WHERE account_id IN ({}) \
            ) \
            SELECT \
                id, account_id, valuation_date, account_currency, base_currency, \
                fx_rate_to_base, cash_balance, investment_market_value, \
                total_value, cost_basis, net_contribution, cash_balance_base, \
                investment_market_value_base, total_value_base, cost_basis_base, \
                net_contribution_base, external_inflow_base, external_outflow_base, \
                external_flow_source, performance_eligible_value_base, value_status, \
                basis_status, calculated_at \
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
             WHERE (CAST(cash_balance AS REAL) < 0 OR CAST(total_value AS REAL) < 0) \
             AND account_id IN ({}) \
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
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use rust_decimal::Decimal;
    use tempfile::tempdir;
    use wealthfolio_core::portfolio::economic_events::BasisStatus;
    use wealthfolio_core::portfolio::valuation::{ExternalFlowSource, ValuationStatus};

    use super::*;
    use crate::db::{create_pool, run_migrations, write_actor::spawn_writer};

    fn date(day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(2025, 1, day).expect("valid test date")
    }

    fn valuation(account: &str, day: u32, cash: i64, total: i64) -> DailyAccountValuation {
        DailyAccountValuation {
            id: format!("{account}_{}", date(day)),
            account_id: account.to_string(),
            valuation_date: date(day),
            account_currency: "USD".to_string(),
            base_currency: "USD".to_string(),
            fx_rate_to_base: Decimal::ONE,
            cash_balance: Decimal::from(cash),
            investment_market_value: Decimal::from(total - cash),
            total_value: Decimal::from(total),
            cost_basis: Decimal::ZERO,
            book_basis: Decimal::ZERO,
            net_contribution: Decimal::ZERO,
            cash_balance_base: Decimal::from(cash),
            investment_market_value_base: Decimal::from(total - cash),
            total_value_base: Decimal::from(total),
            cost_basis_base: Decimal::ZERO,
            book_basis_base: Decimal::ZERO,
            net_contribution_base: Decimal::ZERO,
            external_inflow_base: Decimal::ZERO,
            external_outflow_base: Decimal::ZERO,
            external_flow_source: ExternalFlowSource::NoFlow,
            performance_eligible_value_base: Decimal::from(total),
            value_status: ValuationStatus::Complete,
            basis_status: BasisStatus::Complete,
            calculated_at: Utc::now(),
        }
    }

    #[tokio::test]
    async fn negative_balance_reports_the_first_day_cash_or_value_is_negative() {
        std::env::set_var("CONNECT_API_URL", "http://test.local");
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db").to_string_lossy().to_string();
        run_migrations(&db_path).unwrap();
        let pool = create_pool(&db_path).unwrap();
        let writer = spawn_writer((*pool).clone()).unwrap();
        let mut conn = get_connection(&pool).unwrap();
        for account in ["unfunded_buy", "sell_without_buy", "funded"] {
            sql_query(format!(
                "INSERT INTO accounts (id, name, account_type, currency, is_default, is_active, \
                 created_at, updated_at, tracking_mode, is_archived) \
                 VALUES ('{account}', '{account}', 'SECURITIES', 'USD', 0, 1, datetime('now'), \
                 datetime('now'), 'TRANSACTIONS', 0)"
            ))
            .execute(&mut conn)
            .unwrap();
        }
        let repository = ValuationRepository::new(pool.clone(), writer);
        // A buy with no deposit: cash is negative while the holding keeps
        // total value at or above zero.
        repository
            .replace_valuations_for_account(
                "unfunded_buy",
                None,
                &[
                    valuation("unfunded_buy", 1, 0, 0),
                    valuation("unfunded_buy", 2, -1000, 0),
                    valuation("unfunded_buy", 3, -1000, 200),
                ],
            )
            .await
            .unwrap();
        // A sell with no buy: cash stays positive, total value goes negative.
        repository
            .replace_valuations_for_account(
                "sell_without_buy",
                None,
                &[
                    valuation("sell_without_buy", 1, 100, 100),
                    valuation("sell_without_buy", 4, 300, -50),
                ],
            )
            .await
            .unwrap();
        repository
            .replace_valuations_for_account(
                "funded",
                None,
                &[
                    valuation("funded", 1, 1000, 1000),
                    valuation("funded", 2, 0, 800),
                ],
            )
            .await
            .unwrap();

        let mut found = repository
            .get_accounts_with_negative_balance(&[
                "unfunded_buy".to_string(),
                "sell_without_buy".to_string(),
                "funded".to_string(),
            ])
            .unwrap();
        found.sort_by(|a, b| a.account_id.cmp(&b.account_id));

        let summary: Vec<_> = found
            .iter()
            .map(|info| {
                (
                    info.account_id.as_str(),
                    info.first_negative_date,
                    info.cash_balance,
                    info.total_value,
                )
            })
            .collect();
        assert_eq!(
            summary,
            vec![
                (
                    "sell_without_buy",
                    date(4),
                    Decimal::from(300),
                    Decimal::from(-50)
                ),
                ("unfunded_buy", date(2), Decimal::from(-1000), Decimal::ZERO),
            ]
        );
    }
}
