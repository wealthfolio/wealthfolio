//! Date defaults through the real read tools, with only service boundaries mocked.
#![cfg(feature = "test-utils")]
#![allow(clippy::unwrap_used, clippy::panic, reason = "test code")]

use chrono::{Datelike, Duration, NaiveDate, Utc};
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use wealthfolio_agent_tools::{
    tools::{GetNetWorth, GetPerformance, GetValuationHistory},
    AgentScope, AgentScopeSet, AgentTool, AgentToolCatalog, AgentToolError,
};
use wealthfolio_ai::{
    env::test_env::{MockAccountService, MockEnvironment, MockPerformanceService},
    tools::RigAgentTool,
};
use wealthfolio_core::{
    accounts::{Account, TrackingMode},
    errors::{Error, Result},
    portfolio::performance::{
        PerformanceResult, PerformanceServiceTrait, PerformanceSummaryProfile,
    },
    settings::{Settings, SettingsServiceTrait, SettingsUpdate},
    utils::time_utils::{parse_user_timezone_or_default, user_date_from_utc},
};

struct SettingsStub {
    timezone: String,
    fail: bool,
    reads: AtomicUsize,
}

#[async_trait::async_trait]
impl SettingsServiceTrait for SettingsStub {
    fn get_settings(&self) -> Result<Settings> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        if self.fail {
            return Err(Error::Unexpected("settings unavailable".into()));
        }
        Ok(Settings {
            timezone: self.timezone.clone(),
            ..Settings::default()
        })
    }
    async fn update_settings(&self, _: &SettingsUpdate) -> Result<()> {
        unreachable!()
    }
    fn get_base_currency(&self) -> Result<Option<String>> {
        unreachable!()
    }
    fn is_auto_update_check_enabled(&self) -> Result<bool> {
        unreachable!()
    }
    fn is_sync_enabled(&self) -> Result<bool> {
        unreachable!()
    }
    fn get_setting_value(&self, _: &str) -> Result<Option<String>> {
        unreachable!()
    }
    async fn set_setting_value(&self, _: &str, _: &str) -> Result<()> {
        unreachable!()
    }
}

fn fixture(timezone: &str, fail: bool) -> (Arc<MockEnvironment>, Arc<SettingsStub>) {
    let settings = Arc::new(SettingsStub {
        timezone: timezone.into(),
        fail,
        reads: AtomicUsize::new(0),
    });
    let mut env = MockEnvironment::new();
    env.settings_service = settings.clone();
    (Arc::new(env), settings)
}

async fn check_defaults(timezone: &str) {
    let (env, settings) = fixture(timezone, false);
    let tz = parse_user_timezone_or_default(timezone);
    let before = user_date_from_utc(Utc::now(), tz);
    let net_worth = GetNetWorth
        .call(env.clone(), serde_json::json!({}))
        .await
        .unwrap()
        .content;
    let history = GetValuationHistory
        .call(env, serde_json::json!({}))
        .await
        .unwrap()
        .content;
    let after = user_date_from_utc(Utc::now(), tz);
    // Accept either endpoint if a real local midnight passed while the calls ran.
    for value in [&net_worth["date"], &history["endDate"]] {
        assert!(
            [before.to_string(), after.to_string()]
                .iter()
                .any(|date| value == date),
            "{timezone}: before={before}, after={after}, actual={value}"
        );
    }
    let end = NaiveDate::parse_from_str(history["endDate"].as_str().unwrap(), "%Y-%m-%d").unwrap();
    assert_eq!(
        history["startDate"],
        (end - Duration::days(wealthfolio_agent_tools::constants::DEFAULT_VALUATIONS_DAYS))
            .to_string()
    );
    assert_eq!(settings.reads.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn defaults_use_east_of_utc_profile() {
    check_defaults("Etc/GMT-12").await;
}

#[tokio::test]
async fn defaults_use_west_of_utc_profile() {
    check_defaults("Etc/GMT+12").await;
}

#[tokio::test]
async fn empty_and_invalid_timezones_keep_utc_fallback() {
    check_defaults("").await;
    check_defaults("not/a/timezone").await;
}

#[tokio::test]
async fn explicit_historical_dates_do_not_read_settings() {
    let (env, settings) = fixture("Etc/GMT-12", true);
    let net_worth = GetNetWorth
        .call(env.clone(), serde_json::json!({"date":"2024-02-29"}))
        .await
        .unwrap()
        .content;
    assert_eq!(net_worth["date"], "2024-02-29");
    let history = GetValuationHistory
        .call(
            env,
            serde_json::json!({"startDate":"2024-01-01","endDate":"2024-02-29"}),
        )
        .await
        .unwrap()
        .content;
    assert_eq!(history["startDate"], "2024-01-01");
    assert_eq!(history["endDate"], "2024-02-29");
    assert_eq!(settings.reads.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn invalid_dates_still_default_to_profile_day() {
    let (env, _) = fixture("Etc/GMT-12", false);
    let tz = parse_user_timezone_or_default("Etc/GMT-12");
    let before = user_date_from_utc(Utc::now(), tz).to_string();
    let net_worth = GetNetWorth
        .call(env.clone(), serde_json::json!({"date":"invalid"}))
        .await
        .unwrap()
        .content;
    let history = GetValuationHistory
        .call(
            env,
            serde_json::json!({"startDate":"invalid","endDate":"invalid"}),
        )
        .await
        .unwrap()
        .content;
    let after = user_date_from_utc(Utc::now(), tz).to_string();
    assert!([&before, &after]
        .iter()
        .any(|date| net_worth["date"] == **date));
    assert!([&before, &after]
        .iter()
        .any(|date| history["endDate"] == **date));
    let end = NaiveDate::parse_from_str(history["endDate"].as_str().unwrap(), "%Y-%m-%d").unwrap();
    assert_eq!(
        history["startDate"],
        (end - Duration::days(wealthfolio_agent_tools::constants::DEFAULT_VALUATIONS_DAYS))
            .to_string()
    );
}

#[tokio::test]
async fn implicit_dates_propagate_settings_failure() {
    let (env, settings) = fixture("UTC", true);
    assert!(GetNetWorth
        .call(env.clone(), serde_json::json!({}))
        .await
        .unwrap_err()
        .to_string()
        .contains("settings unavailable"));
    assert!(GetValuationHistory
        .call(env, serde_json::json!({}))
        .await
        .unwrap_err()
        .to_string()
        .contains("settings unavailable"));
    assert_eq!(settings.reads.load(Ordering::SeqCst), 2);
}

/// Echo the tool's service arguments so assertions exercise the real tool's
/// date resolution without depending on the performance engine or its clock.
struct DateEchoPerformanceService;

#[async_trait::async_trait]
impl PerformanceServiceTrait for DateEchoPerformanceService {
    /// Return standard mock metrics with the requested dates echoed back, so
    /// tests can verify the tool's service arguments rather than engine output.
    async fn calculate_performance_history(
        &self,
        item_type: &str,
        item_id: &str,
        start_date: Option<NaiveDate>,
        end_date: Option<NaiveDate>,
        tracking_mode: Option<TrackingMode>,
        account_type: Option<&str>,
    ) -> Result<PerformanceResult> {
        let mut result = MockPerformanceService
            .calculate_performance_history(
                item_type,
                item_id,
                start_date,
                end_date,
                tracking_mode,
                account_type,
            )
            .await?;
        result.period.start_date = start_date;
        result.period.end_date = end_date;
        Ok(result)
    }

    async fn calculate_performance_history_for_accounts(
        &self,
        scope_id: &str,
        account_ids: &[String],
        _: &str,
        _: &HashMap<String, TrackingMode>,
        _: &HashMap<String, String>,
        start_date: Option<NaiveDate>,
        end_date: Option<NaiveDate>,
    ) -> Result<PerformanceResult> {
        assert_eq!(account_ids, &["investment"]);
        self.calculate_performance_history("account", scope_id, start_date, end_date, None, None)
            .await
    }

    async fn calculate_performance_summary(
        &self,
        _: &str,
        _: &str,
        _: Option<NaiveDate>,
        _: Option<NaiveDate>,
        _: Option<TrackingMode>,
        _: Option<&str>,
        _: PerformanceSummaryProfile,
    ) -> Result<PerformanceResult> {
        unreachable!("the tool requests history")
    }

    async fn calculate_performance_summary_for_accounts(
        &self,
        _: &str,
        _: &[String],
        _: &str,
        _: &HashMap<String, TrackingMode>,
        _: &HashMap<String, String>,
        _: Option<NaiveDate>,
        _: Option<NaiveDate>,
        _: PerformanceSummaryProfile,
    ) -> Result<PerformanceResult> {
        unreachable!("the tool requests history")
    }

    fn calculate_accounts_simple_performance(
        &self,
        _: &[String],
    ) -> Result<Vec<wealthfolio_core::performance::SimplePerformanceMetrics>> {
        unreachable!("the tool requests history")
    }
}

/// Check service date arguments and unsupported-account responses across all
/// periods, using fixed UTC offsets independently of the production parser.
async fn check_performance_defaults(timezone: &str, utc_offset_hours: i64) {
    let (mut env, settings) = fixture(timezone, false);
    let services = Arc::get_mut(&mut env).unwrap();
    services.performance_service = Arc::new(DateEchoPerformanceService);
    services.account_service = Arc::new(MockAccountService {
        accounts: vec![
            Account {
                id: "investment".into(),
                account_type: "SECURITIES".into(),
                currency: "USD".into(),
                is_active: true,
                ..Account::default()
            },
            Account {
                id: "credit-card".into(),
                account_type: "CREDIT_CARD".into(),
                currency: "USD".into(),
                is_active: true,
                ..Account::default()
            },
        ],
    });

    // Fixed offsets and UTC expectations are independent of the production
    // timezone parser. The two 12-hour zones differ by a day at any instant.
    let today = || (Utc::now() + Duration::hours(utc_offset_hours)).date_naive();
    let mut calls = 0;
    for account_id in [None, Some("investment"), Some("credit-card")] {
        for period in [
            None,
            Some("1M"),
            Some("3M"),
            Some("6M"),
            Some("1Y"),
            Some("ALL"),
        ] {
            let mut args = serde_json::json!({});
            if let Some(account_id) = account_id {
                args["accountId"] = account_id.into();
            }
            if let Some(period) = period {
                args["period"] = period.into();
            }
            let before = today();
            let output = GetPerformance
                .call(env.clone(), args)
                .await
                .unwrap()
                .content;
            let after = today();
            let end =
                NaiveDate::parse_from_str(output["periodEndDate"].as_str().unwrap(), "%Y-%m-%d")
                    .unwrap();
            assert!(
                [before, after].contains(&end),
                "{timezone}, {account_id:?}, {period:?}: expected {before}..{after}, actual {end}",
            );
            let expected_start = match period {
                None => NaiveDate::from_ymd_opt(end.year(), 1, 1),
                Some("1M") => Some(end - Duration::days(30)),
                Some("3M") => Some(end - Duration::days(90)),
                Some("6M") => Some(end - Duration::days(180)),
                Some("1Y") => Some(end - Duration::days(365)),
                Some("ALL") => None,
                _ => unreachable!(),
            };
            assert_eq!(
                output
                    .get("periodStartDate")
                    .and_then(serde_json::Value::as_str),
                expected_start.map(|date| date.to_string()).as_deref(),
            );
            calls += 1;
            assert_eq!(settings.reads.load(Ordering::SeqCst), calls);
        }
    }
}

#[tokio::test]
async fn performance_defaults_use_east_of_utc_profile() {
    check_performance_defaults("Etc/GMT-12", 12).await;
}

#[tokio::test]
async fn performance_defaults_use_west_of_utc_profile() {
    check_performance_defaults("Etc/GMT+12", -12).await;
}

#[tokio::test]
async fn performance_defaults_keep_utc_fallback() {
    check_performance_defaults("", 0).await;
    check_performance_defaults("not/a/timezone", 0).await;
}

/// Settings errors reach both entry points; scope denial reads no settings.
#[tokio::test]
async fn performance_settings_errors_reach_assistant_and_mcp() {
    let (env, settings) = fixture("UTC", true);
    let catalog = AgentToolCatalog::mcp_catalog();
    let args = serde_json::json!({});
    let denied = catalog
        .execute(
            env.clone(),
            &AgentScopeSet::new(),
            "get_performance",
            args.clone(),
        )
        .await
        .unwrap_err();
    assert!(matches!(denied, AgentToolError::ScopeDenied { .. }));
    assert_eq!(settings.reads.load(Ordering::SeqCst), 0);

    let mut granted = AgentScopeSet::new();
    granted.insert(AgentScope::PerformanceRead);
    let mcp_error = catalog
        .execute(env.clone(), &granted, "get_performance", args.clone())
        .await
        .unwrap_err();
    assert!(matches!(mcp_error, AgentToolError::ExecutionFailed(_)));
    assert!(mcp_error.to_string().contains("settings unavailable"));

    let assistant_error = RigAgentTool::new(Arc::new(GetPerformance), env)
        .call(args)
        .await
        .unwrap_err();
    assert!(assistant_error.to_string().contains("settings unavailable"));
    assert_eq!(settings.reads.load(Ordering::SeqCst), 2);
}
