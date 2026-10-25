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
use chrono::{DateTime, NaiveDate, NaiveTime, TimeZone, Utc};
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
        _contribution_year: Option<i32>,
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

/// Income received at UTC midnight on `date` (YYYY-MM-DD).
fn income(
    date: &str,
    income_type: &str,
    asset_id: &str,
    currency: &str,
    amount: Decimal,
    account_id: &str,
) -> IncomeData {
    let day = NaiveDate::parse_from_str(date, "%Y-%m-%d").expect("a YYYY-MM-DD date");
    IncomeData {
        activity_date: day.and_time(NaiveTime::MIN).and_utc(),
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
fn income_growth_preserves_hundredth_percent_precision() {
    let _clock = clock::freeze(Utc.with_ymd_and_hms(2026, 6, 15, 12, 0, 0).unwrap());
    let fx = Arc::new(FxService::new(Arc::new(InMemoryFxRepository::new(vec![]))));
    fx.initialize().unwrap();
    for (previous, current, percent) in [
        (dec!(100), dec!(112.34), dec!(12.34)),
        (dec!(100), dec!(87.66), dec!(-12.34)),
        (dec!(110), dec!(2500), dec!(2172.73)),
    ] {
        let service = IncomeService::new(
            fx.clone(),
            Arc::new(MockActivityRepository {
                income: Mutex::new(vec![
                    income("2025-03-15", "INTEREST", "CASH:USD", "USD", previous, "a"),
                    income("2026-03-15", "INTEREST", "CASH:USD", "USD", current, "a"),
                ]),
                first_activity_date: Utc.with_ymd_and_hms(2025, 1, 1, 0, 0, 0).unwrap(),
            }),
            Arc::new(RwLock::new("USD".into())),
        );
        let summaries = service.get_income_summary(None).unwrap();
        let ytd = summary(&summaries, "YTD");
        assert_eq!(ytd.total_income, current);
        assert_eq!(summary(&summaries, "LAST_YEAR").total_income, previous);
        assert_eq!(summary(&summaries, "ALL").total_income, previous + current);
        assert_eq!(
            (ytd.yoy_growth.expect("positive comparison") * dec!(100)).round_dp(2),
            percent
        );
    }
}

#[test]
fn growth_is_left_out_when_the_year_before_has_no_income() {
    let _clock = clock::freeze(Utc.with_ymd_and_hms(2026, 6, 15, 12, 0, 0).unwrap());

    let fx_service = FxService::new(Arc::new(InMemoryFxRepository::new(Vec::new())));
    fx_service.initialize().unwrap();

    let service = IncomeService::new(
        Arc::new(fx_service),
        Arc::new(MockActivityRepository {
            income: Mutex::new(vec![
                income("2025-05-15", "DIVIDEND", "SAP", "USD", dec!(110), "acc"),
                income(
                    "2026-03-15",
                    "INTEREST",
                    "CASH:USD",
                    "USD",
                    dec!(2500),
                    "acc",
                ),
            ]),
            first_activity_date: Utc.with_ymd_and_hms(2025, 5, 2, 0, 0, 0).unwrap(),
        }),
        Arc::new(RwLock::new("USD".to_string())),
    );

    let summaries = service.get_income_summary(None).unwrap();

    // 2,500 this year against 110 last year.
    assert_eq!(
        summary(&summaries, "YTD").yoy_growth,
        Some((dec!(2500) - dec!(110)) / dec!(110))
    );
    // No income in 2024, so last year's growth would read as 0%.
    assert_eq!(summary(&summaries, "LAST_YEAR").yoy_growth, None);
    assert_eq!(summary(&summaries, "TWO_YEARS_AGO").yoy_growth, None);
    assert_eq!(summary(&summaries, "ALL").yoy_growth, None);
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
                income("2024-09-15", "DIVIDEND", "VOD", "GBP", dec!(40), "acc-gbp"),
                income("2025-05-15", "DIVIDEND", "SAP", "EUR", dec!(100), "acc-eur"),
                income(
                    "2025-07-15",
                    "INTEREST",
                    "CASH:JPY",
                    "JPY",
                    dec!(50000),
                    "acc-jpy",
                ),
                income(
                    "2026-03-15",
                    "INTEREST",
                    "CASH:USD",
                    "USD",
                    dec!(2500),
                    "acc-usd",
                ),
                income(
                    "2026-04-15",
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
    // 2024's only income, in GBP, was left out: nothing to compare with.
    assert_eq!(last_year.yoy_growth, None);

    let two_years_ago = summary(&summaries, "TWO_YEARS_AGO");
    assert_eq!(two_years_ago.total_income, dec!(0));
    assert_eq!(two_years_ago.unconverted_currencies, currencies(&["GBP"]));
}

#[test]
fn income_converts_at_the_rate_on_the_day_it_was_received() {
    let _clock = clock::freeze(Utc.with_ymd_and_hms(2026, 6, 15, 12, 0, 0).unwrap());

    let eur_usd = |year: i32, month: u32, day: u32, rate: Decimal| ExchangeRate {
        id: format!("EURUSD-{year}-{month}-{day}"),
        from_currency: "EUR".to_string(),
        to_currency: "USD".to_string(),
        rate,
        source: "MANUAL".to_string(),
        timestamp: Utc.with_ymd_and_hms(year, month, day, 0, 0, 0).unwrap(),
    };
    let fx_service = FxService::new(Arc::new(InMemoryFxRepository::new(vec![
        eur_usd(2025, 5, 2, dec!(1.05)),
        eur_usd(2025, 5, 3, dec!(1.06)),
        eur_usd(2025, 5, 4, dec!(1.08)),
        eur_usd(2026, 6, 1, dec!(1.17)),
    ])));
    fx_service.initialize().unwrap();

    let service = IncomeService::new_with_timezone(
        Arc::new(fx_service),
        Arc::new(MockActivityRepository {
            income: Mutex::new(vec![
                income("2025-05-02", "DIVIDEND", "SAP", "EUR", dec!(100), "acc-eur"),
                // 20:00 UTC on 3 May is already 4 May in Tokyo.
                IncomeData {
                    activity_date: Utc.with_ymd_and_hms(2025, 5, 3, 20, 0, 0).unwrap(),
                    ..income(
                        "2025-05-03",
                        "DIVIDEND",
                        "ASML",
                        "EUR",
                        dec!(100),
                        "acc-eur",
                    )
                },
            ]),
            first_activity_date: Utc.with_ymd_and_hms(2025, 5, 2, 0, 0, 0).unwrap(),
        }),
        Arc::new(RwLock::new("USD".to_string())),
        Arc::new(RwLock::new("Asia/Tokyo".to_string())),
    );

    let summaries = service.get_income_summary(None).unwrap();

    // Today's rate (1.17) would make each $117. The holdings income column
    // converts on the activity's day in the user's timezone; so does this.
    for period in ["ALL", "LAST_YEAR"] {
        let summary = summary(&summaries, period);
        assert_eq!(summary.by_asset["SAP"].income, dec!(105));
        assert_eq!(summary.by_asset["ASML"].income, dec!(108));
        assert_eq!(summary.total_income, dec!(213));
        assert_eq!(summary.by_month.get("2025-05"), Some(&dec!(213)));
    }
}

#[test]
fn income_counts_toward_its_month_in_the_users_timezone() {
    let _clock = clock::freeze(Utc.with_ymd_and_hms(2026, 6, 15, 12, 0, 0).unwrap());

    let fx_service = FxService::new(Arc::new(InMemoryFxRepository::new(Vec::new())));
    fx_service.initialize().unwrap();

    let service = IncomeService::new_with_timezone(
        Arc::new(fx_service),
        Arc::new(MockActivityRepository {
            income: Mutex::new(vec![
                // 08:30 on 1 January 2026 in Tokyo is still 2025 in UTC.
                IncomeData {
                    activity_date: Utc.with_ymd_and_hms(2025, 12, 31, 23, 30, 0).unwrap(),
                    ..income("2025-12-31", "DIVIDEND", "SAP", "USD", dec!(100), "acc-usd")
                },
                // 08:30 on 1 March 2026 in Tokyo.
                IncomeData {
                    activity_date: Utc.with_ymd_and_hms(2026, 2, 28, 23, 30, 0).unwrap(),
                    ..income(
                        "2026-02-28",
                        "DIVIDEND",
                        "ASML",
                        "USD",
                        dec!(100),
                        "acc-usd",
                    )
                },
            ]),
            first_activity_date: Utc.with_ymd_and_hms(2025, 12, 31, 23, 30, 0).unwrap(),
        }),
        Arc::new(RwLock::new("USD".to_string())),
        Arc::new(RwLock::new("Asia/Tokyo".to_string())),
    );

    let summaries = service.get_income_summary(None).unwrap();

    // The activity list shows these on 1 January and 1 March, so the income
    // page counts them there too.
    let months = |by_month: &HashMap<String, Decimal>| {
        let mut months: Vec<_> = by_month
            .iter()
            .map(|(month, income)| (month.clone(), *income))
            .collect();
        months.sort();
        months
    };
    let expected = vec![
        ("2026-01".to_string(), dec!(100)),
        ("2026-03".to_string(), dec!(100)),
    ];
    for period in ["ALL", "YTD"] {
        let summary = summary(&summaries, period);
        assert_eq!(summary.total_income, dec!(200));
        assert_eq!(months(&summary.by_month), expected);
        assert_eq!(months(&summary.by_account["acc-usd"].by_month), expected);
    }
    // Five months from January to June 2026, not six from December 2025.
    assert_eq!(summary(&summaries, "ALL").monthly_average, dec!(40));

    let last_year = summary(&summaries, "LAST_YEAR");
    assert_eq!(last_year.total_income, dec!(0));
    assert!(last_year.by_month.is_empty());
}
