//! Unit tests for the income service.

use super::*;
use crate::activities::{
    Activity, ActivityBulkMutationResult, ActivityRepositoryTrait, ActivitySearchResponse,
    ActivityUpdate, ActivityUpsert, BulkUpsertResult, ImportMapping, ImportTemplate, IncomeData,
    NewActivity, Sort,
};
use crate::constants::DISPLAY_DECIMAL_PRECISION;
use crate::fx::{ExchangeRate, FxService, FxServiceTrait};
use crate::limits::ContributionActivity;
use crate::test_support::in_memory::InMemoryFxRepository;
use crate::utils::clock;
use crate::Result;
use chrono::{DateTime, NaiveDate, TimeZone, Utc};
use rust_decimal::Decimal;
use rust_decimal_macros::dec;
use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, Mutex, RwLock};

struct MockActivityRepository {
    // `IncomeData` isn't `Clone`; the service reads it once per summary.
    income: Mutex<Vec<IncomeData>>,
    first_activity_date: DateTime<Utc>,
}

#[async_trait::async_trait]
impl ActivityRepositoryTrait for MockActivityRepository {
    fn get_activity(&self, _activity_id: &str) -> Result<Activity> {
        unimplemented!("unused in income service tests")
    }

    fn get_activities(&self) -> Result<Vec<Activity>> {
        unimplemented!("unused in income service tests")
    }

    fn get_activities_by_account_id(&self, _account_id: &str) -> Result<Vec<Activity>> {
        unimplemented!("unused in income service tests")
    }

    fn get_activities_by_account_ids(&self, _account_ids: &[String]) -> Result<Vec<Activity>> {
        unimplemented!("unused in income service tests")
    }

    fn get_trading_activities(&self) -> Result<Vec<Activity>> {
        unimplemented!("unused in income service tests")
    }

    fn get_income_activities(&self) -> Result<Vec<Activity>> {
        unimplemented!("unused in income service tests")
    }

    fn get_contribution_activities(
        &self,
        _account_ids: &[String],
        _start_utc: DateTime<Utc>,
        _end_exclusive_utc: DateTime<Utc>,
    ) -> Result<Vec<ContributionActivity>> {
        unimplemented!("unused in income service tests")
    }

    fn search_activities(
        &self,
        _page: i64,
        _page_size: i64,
        _account_id_filter: Option<Vec<String>>,
        _activity_type_filter: Option<Vec<String>>,
        _asset_id_keyword: Option<String>,
        _sort: Option<Sort>,
        _needs_review_filter: Option<bool>,
        _date_from: Option<NaiveDate>,
        _date_to: Option<NaiveDate>,
        _instrument_type_filter: Option<Vec<String>>,
        _activity_id_filter: Option<Vec<String>>,
    ) -> Result<ActivitySearchResponse> {
        unimplemented!("unused in income service tests")
    }

    async fn create_activity(&self, _new_activity: NewActivity) -> Result<Activity> {
        unimplemented!("unused in income service tests")
    }

    async fn update_activity(&self, _activity_update: ActivityUpdate) -> Result<Activity> {
        unimplemented!("unused in income service tests")
    }

    async fn delete_activity(&self, _activity_id: String) -> Result<Activity> {
        unimplemented!("unused in income service tests")
    }

    async fn link_transfer_activities(
        &self,
        _activity_a_id: String,
        _activity_b_id: String,
    ) -> Result<(Activity, Activity)> {
        unimplemented!("unused in income service tests")
    }

    async fn unlink_transfer_activities(
        &self,
        _activity_a_id: String,
        _activity_b_id: String,
    ) -> Result<(Activity, Activity)> {
        unimplemented!("unused in income service tests")
    }

    async fn bulk_mutate_activities(
        &self,
        _creates: Vec<NewActivity>,
        _updates: Vec<ActivityUpdate>,
        _delete_ids: Vec<String>,
    ) -> Result<ActivityBulkMutationResult> {
        unimplemented!("unused in income service tests")
    }

    async fn create_activities(&self, _activities: Vec<NewActivity>) -> Result<usize> {
        unimplemented!("unused in income service tests")
    }

    fn get_first_activity_date(
        &self,
        _account_ids: Option<&[String]>,
    ) -> Result<Option<DateTime<Utc>>> {
        Ok(Some(self.first_activity_date))
    }

    fn get_import_mapping(
        &self,
        _account_id: &str,
        _context_kind: &str,
    ) -> Result<Option<ImportMapping>> {
        unimplemented!("unused in income service tests")
    }

    async fn save_import_mapping(&self, _mapping: &ImportMapping) -> Result<()> {
        unimplemented!("unused in income service tests")
    }

    async fn link_account_template(
        &self,
        _account_id: &str,
        _template_id: &str,
        _context_kind: &str,
    ) -> Result<()> {
        unimplemented!("unused in income service tests")
    }

    fn list_import_templates(&self) -> Result<Vec<ImportTemplate>> {
        unimplemented!("unused in income service tests")
    }

    fn get_import_template(&self, _template_id: &str) -> Result<Option<ImportTemplate>> {
        unimplemented!("unused in income service tests")
    }

    async fn save_import_template(&self, _template: &ImportTemplate) -> Result<()> {
        unimplemented!("unused in income service tests")
    }

    async fn delete_import_template(&self, _template_id: &str) -> Result<()> {
        unimplemented!("unused in income service tests")
    }

    fn get_broker_sync_profile(
        &self,
        _account_id: &str,
        _source_system: &str,
    ) -> Result<Option<ImportTemplate>> {
        unimplemented!("unused in income service tests")
    }

    async fn save_broker_sync_profile(&self, _template: &ImportTemplate) -> Result<()> {
        unimplemented!("unused in income service tests")
    }

    async fn link_broker_sync_profile(
        &self,
        _account_id: &str,
        _template_id: &str,
        _source_system: &str,
    ) -> Result<()> {
        unimplemented!("unused in income service tests")
    }

    fn get_income_activities_data(
        &self,
        _account_ids: Option<&[String]>,
    ) -> Result<Vec<IncomeData>> {
        Ok(std::mem::take(&mut *self.income.lock().unwrap()))
    }

    fn get_first_activity_date_overall(&self) -> Result<DateTime<Utc>> {
        Ok(self.first_activity_date)
    }

    fn get_activity_bounds_for_assets(
        &self,
        _asset_ids: &[String],
    ) -> Result<HashMap<String, (Option<NaiveDate>, Option<NaiveDate>)>> {
        unimplemented!("unused in income service tests")
    }

    fn get_holdings_snapshot_bounds_for_assets(
        &self,
        _asset_ids: &[String],
    ) -> Result<HashMap<String, (Option<NaiveDate>, Option<NaiveDate>)>> {
        unimplemented!("unused in income service tests")
    }

    fn check_existing_duplicates(
        &self,
        _idempotency_keys: &[String],
    ) -> Result<HashMap<String, String>> {
        unimplemented!("unused in income service tests")
    }

    async fn bulk_upsert(&self, _activities: Vec<ActivityUpsert>) -> Result<BulkUpsertResult> {
        unimplemented!("unused in income service tests")
    }

    async fn reassign_asset(&self, _old_asset_id: &str, _new_asset_id: &str) -> Result<u32> {
        unimplemented!("unused in income service tests")
    }

    async fn get_activity_accounts_and_currencies_by_asset_id(
        &self,
        _asset_id: &str,
    ) -> Result<(Vec<String>, Vec<String>)> {
        unimplemented!("unused in income service tests")
    }
}

fn income(
    date: &str,
    income_type: &str,
    asset_id: &str,
    currency: &str,
    amount: Decimal,
    account_id: &str,
) -> IncomeData {
    IncomeData {
        date: date.to_string(),
        income_type: income_type.to_string(),
        asset_id: asset_id.to_string(),
        asset_kind: "INVESTMENT".to_string(),
        symbol: asset_id.to_string(),
        symbol_name: asset_id.to_string(),
        currency: currency.to_string(),
        amount,
        account_id: account_id.to_string(),
        account_name: account_id.to_string(),
    }
}

fn summary<'a>(summaries: &'a [IncomeSummary], period: &str) -> &'a IncomeSummary {
    summaries
        .iter()
        .find(|summary| summary.period == period)
        .expect("every period has a summary")
}

#[test]
fn income_without_an_exchange_rate_is_left_out_of_converted_totals() {
    let _clock = clock::freeze(Utc.with_ymd_and_hms(2026, 6, 15, 12, 0, 0).unwrap());

    // EUR has a rate to the base currency; GBP, INR and JPY have none.
    let fx_service = FxService::new(Arc::new(InMemoryFxRepository::new(vec![ExchangeRate {
        id: "EURUSD".to_string(),
        from_currency: "EUR".to_string(),
        to_currency: "USD".to_string(),
        rate: dec!(1.1),
        source: "MANUAL".to_string(),
        timestamp: Utc.with_ymd_and_hms(2026, 1, 2, 0, 0, 0).unwrap(),
    }])));
    fx_service.initialize().unwrap();

    let service = IncomeService::new(
        Arc::new(fx_service),
        Arc::new(MockActivityRepository {
            income: Mutex::new(vec![
                income("2024-09", "DIVIDEND", "VOD", "GBP", dec!(40), "acc-gbp"),
                income("2025-05", "DIVIDEND", "SAP", "EUR", dec!(100), "acc-eur"),
                income(
                    "2025-07",
                    "INTEREST",
                    "CASH:JPY",
                    "JPY",
                    dec!(50000),
                    "acc-jpy",
                ),
                income(
                    "2026-03",
                    "INTEREST",
                    "CASH:USD",
                    "USD",
                    dec!(2500),
                    "acc-usd",
                ),
                income(
                    "2026-04",
                    "INTEREST",
                    "CASH:INR",
                    "INR",
                    dec!(1234567.89),
                    "acc-inr",
                ),
            ]),
            first_activity_date: Utc.with_ymd_and_hms(2024, 1, 15, 0, 0, 0).unwrap(),
        }),
        Arc::new(RwLock::new("USD".to_string())),
    );

    let summaries = service.get_income_summary(None).unwrap();
    let currencies = |codes: &[&str]| -> BTreeSet<String> {
        codes.iter().map(|code| code.to_string()).collect()
    };

    let all = summary(&summaries, "ALL");
    assert_eq!(all.total_income, dec!(2610));
    // 29 months from January 2024 to June 2026.
    assert_eq!(
        all.monthly_average,
        (dec!(2610) / dec!(29)).round_dp(DISPLAY_DECIMAL_PRECISION)
    );
    assert_eq!(all.by_type.get("INTEREST"), Some(&dec!(2500)));
    assert_eq!(all.by_type.get("DIVIDEND"), Some(&dec!(110)));
    assert!(!all.by_month.contains_key("2026-04"));
    assert!(!all.by_asset.contains_key("CASH:INR"));
    assert!(!all.by_account.contains_key("acc-inr"));
    // Each currency's own total still includes it.
    assert_eq!(all.by_currency.get("GBP"), Some(&dec!(40)));
    assert_eq!(all.by_currency.get("INR"), Some(&dec!(1234567.89)));
    assert_eq!(all.by_currency.get("JPY"), Some(&dec!(50000)));
    assert_eq!(all.by_currency.get("USD"), Some(&dec!(2500)));
    assert_eq!(all.by_currency.get("EUR"), Some(&dec!(100)));
    // The converted per-currency totals leave it out too.
    assert_eq!(
        all.by_currency_base,
        HashMap::from([
            ("EUR".to_string(), dec!(110)),
            ("USD".to_string(), dec!(2500)),
        ])
    );
    assert_eq!(
        all.unconverted_currencies,
        currencies(&["GBP", "INR", "JPY"])
    );

    // Each period's year-over-year growth compares against the year before,
    // so it also names the currencies left out of that year, and no earlier.
    let ytd = summary(&summaries, "YTD");
    assert_eq!(ytd.total_income, dec!(2500));
    assert_eq!(ytd.unconverted_currencies, currencies(&["INR", "JPY"]));

    let last_year = summary(&summaries, "LAST_YEAR");
    assert_eq!(last_year.total_income, dec!(110));
    assert_eq!(
        last_year.unconverted_currencies,
        currencies(&["GBP", "JPY"])
    );

    let two_years_ago = summary(&summaries, "TWO_YEARS_AGO");
    assert_eq!(two_years_ago.total_income, dec!(0));
    assert_eq!(two_years_ago.unconverted_currencies, currencies(&["GBP"]));
}
