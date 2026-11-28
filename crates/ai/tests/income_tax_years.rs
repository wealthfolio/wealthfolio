//! `get_income` answers for the user's tax year as well as calendar years.

#![cfg(feature = "test-utils")]
#![allow(clippy::unwrap_used, reason = "test code")]

use rust_decimal::Decimal;
use std::sync::Arc;
use wealthfolio_agent_tools::AgentTool;
use wealthfolio_ai::env::test_env::MockEnvironment;
use wealthfolio_ai::tools::GetIncome;
use wealthfolio_core::portfolio::income::{IncomeServiceTrait, IncomeSummary};
use wealthfolio_core::Result;

/// The periods the income service returns for a 1 July tax year.
struct JulyTaxYearIncome;

impl IncomeServiceTrait for JulyTaxYearIncome {
    fn get_income_summary(&self, _account_ids: Option<&[String]>) -> Result<Vec<IncomeSummary>> {
        let summary = |period: &str, total| {
            let mut summary = IncomeSummary::new(period, "AUD".to_string());
            summary.total_income = total;
            summary
        };
        Ok(vec![
            summary("ALL", Decimal::from(31)),
            summary("YTD", Decimal::from(24)),
            summary("LAST_YEAR", Decimal::from(6)),
            summary("TAX_YTD", Decimal::from(16)),
            summary("LAST_TAX_YEAR", Decimal::from(12)),
        ])
    }
}

fn env(income: impl IncomeServiceTrait + 'static) -> Arc<MockEnvironment> {
    let mut env = MockEnvironment::new();
    env.income_service = Arc::new(income);
    Arc::new(env)
}

#[tokio::test]
async fn returns_the_last_tax_year() {
    let result = GetIncome
        .call(
            env(JulyTaxYearIncome),
            serde_json::json!({ "period": "LAST_TAX_YEAR" }),
        )
        .await
        .unwrap();
    assert_eq!(result.content["period"], "LAST_TAX_YEAR");
    assert_eq!(result.content["totalIncome"], 12.0);
}

#[tokio::test]
async fn says_to_use_calendar_years_when_the_tax_year_starts_on_1_january() {
    // The mock service returns only calendar periods, as for a 1 January start.
    let error = GetIncome
        .call(
            Arc::new(MockEnvironment::new()),
            serde_json::json!({ "period": "TAX_YTD" }),
        )
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("use YTD or LAST_YEAR"), "{error}");
}

/// No income activities: the income service returns no periods at all.
struct NoIncome;

impl IncomeServiceTrait for NoIncome {
    fn get_income_summary(&self, _account_ids: Option<&[String]>) -> Result<Vec<IncomeSummary>> {
        Ok(Vec::new())
    }
}

#[tokio::test]
async fn does_not_blame_the_tax_year_start_when_there_is_no_income() {
    let error = GetIncome
        .call(env(NoIncome), serde_json::json!({ "period": "TAX_YTD" }))
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("not found in income data"), "{error}");
    assert!(!error.contains("1 January"), "{error}");
}
