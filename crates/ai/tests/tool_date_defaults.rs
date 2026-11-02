//! Date defaults through the real read tools, with only service boundaries mocked.
#![cfg(feature = "test-utils")]
#![allow(clippy::unwrap_used, clippy::panic, reason = "test code")]

use chrono::{Duration, NaiveDate, Utc};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use wealthfolio_agent_tools::{
    tools::{GetNetWorth, GetValuationHistory},
    AgentTool,
};
use wealthfolio_ai::env::test_env::MockEnvironment;
use wealthfolio_core::{
    errors::{Error, Result},
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
