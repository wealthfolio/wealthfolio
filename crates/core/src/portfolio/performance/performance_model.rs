use crate::{
    accounts::{account_supports_portfolio_scope, Account, AccountPurpose, TrackingMode},
    portfolio::economic_events::BasisStatus,
};
use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CumulativeReturn {
    pub date: NaiveDate,
    pub value: Decimal,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TotalReturn {
    pub rate: Decimal,
    pub amount: Decimal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[derive(Default)]
pub enum ReturnMethod {
    #[default]
    TimeWeighted,
    ValueReturn,
    SymbolPriceBased,
    NotApplicable,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReturnData {
    pub date: NaiveDate,
    pub value: Decimal,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceScopeDescriptor {
    pub id: String,
    pub currency: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PerformancePeriod {
    pub start_date: Option<NaiveDate>,
    pub end_date: Option<NaiveDate>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceReturns {
    pub twr: Option<Decimal>,
    pub annualized_twr: Option<Decimal>,
    /// Selected-period money-weighted return derived from annualized XIRR.
    pub irr: Option<Decimal>,
    /// Annualized XIRR using dated cash flows.
    pub annualized_irr: Option<Decimal>,
    pub value_return: Option<Decimal>,
    pub annualized_value_return: Option<Decimal>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PerformanceSummaryProfile {
    #[default]
    Full,
    #[serde(alias = "headline")]
    Summary,
    Dashboard,
}

pub fn performance_tracking_composition(
    tracking_modes: &HashMap<String, TrackingMode>,
    account_ids: &[String],
) -> String {
    let mut holdings_count = 0;
    let mut transaction_count = 0;

    for account_id in account_ids {
        if matches!(tracking_modes.get(account_id), Some(TrackingMode::Holdings)) {
            holdings_count += 1;
        } else {
            transaction_count += 1;
        }
    }

    match (holdings_count, transaction_count) {
        (0, _) => format!("transactions({transaction_count})"),
        (_, 0) => format!("holdings({holdings_count})"),
        _ => format!("mixed(holdings={holdings_count}, transactions={transaction_count})"),
    }
}

pub fn performance_summary_scope_key(account_ids: &[String]) -> String {
    let mut sorted = account_ids.to_vec();
    sorted.sort();
    sorted.dedup();
    format!("accounts:{}", sorted.join(","))
}

pub fn unique_account_ids(account_ids: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    account_ids
        .into_iter()
        .filter(|account_id| seen.insert(account_id.clone()))
        .collect()
}

pub fn performance_account_ids_from_map(
    accounts_by_id: &HashMap<String, Account>,
    account_ids: &[String],
) -> Vec<String> {
    let mut seen = HashSet::new();
    account_ids
        .iter()
        .filter_map(|account_id| accounts_by_id.get(account_id))
        .filter(|account| account_supports_portfolio_scope(account, AccountPurpose::Performance))
        .filter_map(|account| {
            if seen.insert(account.id.clone()) {
                Some(account.id.clone())
            } else {
                None
            }
        })
        .collect()
}

pub fn performance_account_tracking_modes_from_map(
    accounts_by_id: &HashMap<String, Account>,
    account_ids: &[String],
) -> HashMap<String, TrackingMode> {
    account_ids
        .iter()
        .filter_map(|account_id| {
            accounts_by_id
                .get(account_id)
                .map(|account| (account.id.clone(), account.tracking_mode))
        })
        .collect()
}

pub fn performance_account_types_from_map(
    accounts_by_id: &HashMap<String, Account>,
    account_ids: &[String],
) -> HashMap<String, String> {
    account_ids
        .iter()
        .filter_map(|account_id| {
            accounts_by_id
                .get(account_id)
                .map(|account| (account.id.clone(), account.account_type.clone()))
        })
        .collect()
}

pub fn empty_performance_metrics(
    id: &str,
    currency: String,
    start_date: Option<NaiveDate>,
    end_date: Option<NaiveDate>,
) -> PerformanceResult {
    unavailable_performance_metrics(
        id,
        currency,
        start_date,
        end_date,
        "Performance unavailable for this account type.",
    )
}

pub fn unavailable_performance_metrics(
    id: &str,
    currency: String,
    start_date: Option<NaiveDate>,
    end_date: Option<NaiveDate>,
    reason: impl Into<String>,
) -> PerformanceResult {
    let reason = reason.into();
    PerformanceResult {
        scope: PerformanceScopeDescriptor {
            id: id.to_string(),
            currency,
        },
        period: PerformancePeriod {
            start_date,
            end_date,
        },
        mode: ReturnMethod::NotApplicable,
        returns: PerformanceReturns {
            twr: None,
            annualized_twr: None,
            irr: None,
            annualized_irr: None,
            value_return: None,
            annualized_value_return: None,
        },
        attribution: PerformanceAttribution::default(),
        risk: PerformanceRisk {
            volatility: None,
            max_drawdown: None,
            peak_date: None,
            trough_date: None,
            recovery_date: None,
            drawdown_duration_days: None,
        },
        data_quality: PerformanceDataQuality {
            status: DataQualityStatus::NoData,
            warnings: Vec::new(),
            not_applicable_reasons: vec![reason.clone()],
        },
        basis_status: BasisStatus::NotApplicable,
        summary: PerformanceSummary {
            quality: DataQualityStatus::NoData,
            basis_status: BasisStatus::NotApplicable,
            reasons: vec![reason],
            ..PerformanceSummary::default()
        },
        series: Vec::new(),
        is_holdings_mode: false,
        is_mixed_tracking_mode: false,
    }
}

pub fn sync_performance_summary_quality(result: &mut PerformanceResult) {
    result.summary.quality = result.data_quality.status.clone();
    result.summary.reasons = result
        .data_quality
        .warnings
        .iter()
        .chain(result.data_quality.not_applicable_reasons.iter())
        .cloned()
        .collect();
}

#[derive(Debug, Clone)]
pub struct PerformanceSummaryBatchScope {
    pub account_ids: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct PerformanceSummaryScopeTiming {
    pub index: usize,
    pub total: usize,
    pub key: String,
    pub requested_accounts: usize,
    pub eligible_accounts: usize,
    pub tracking_composition: String,
    pub warnings: usize,
    pub skipped: bool,
    pub failed: bool,
    pub elapsed_ms: f64,
}

#[derive(Debug)]
pub struct PerformanceSummaryBatchResult {
    pub results: HashMap<String, PerformanceResult>,
    pub failed_scope_count: usize,
    pub scope_timings: Vec<PerformanceSummaryScopeTiming>,
    pub elapsed_ms: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceAttribution {
    pub contributions: Decimal,
    pub distributions: Decimal,
    pub income: Decimal,
    pub realized_pnl: Decimal,
    pub unrealized_pnl_change: Decimal,
    pub fx_effect: Decimal,
    pub fees: Decimal,
    pub taxes: Decimal,
    pub residual: Decimal,
}

impl Default for PerformanceAttribution {
    fn default() -> Self {
        Self {
            contributions: Decimal::ZERO,
            distributions: Decimal::ZERO,
            income: Decimal::ZERO,
            realized_pnl: Decimal::ZERO,
            unrealized_pnl_change: Decimal::ZERO,
            fx_effect: Decimal::ZERO,
            fees: Decimal::ZERO,
            taxes: Decimal::ZERO,
            residual: Decimal::ZERO,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceRisk {
    pub volatility: Option<Decimal>,
    pub max_drawdown: Option<Decimal>,
    pub peak_date: Option<NaiveDate>,
    pub trough_date: Option<NaiveDate>,
    pub recovery_date: Option<NaiveDate>,
    pub drawdown_duration_days: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DataQualityStatus {
    Ok,
    Partial,
    NoData,
    NotApplicable,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceDataQuality {
    pub status: DataQualityStatus,
    pub warnings: Vec<String>,
    pub not_applicable_reasons: Vec<String>,
}

impl PerformanceDataQuality {
    pub fn ok() -> Self {
        Self {
            status: DataQualityStatus::Ok,
            warnings: Vec::new(),
            not_applicable_reasons: Vec::new(),
        }
    }

    pub fn no_data(reason: impl Into<String>) -> Self {
        Self {
            status: DataQualityStatus::NoData,
            warnings: Vec::new(),
            not_applicable_reasons: vec![reason.into()],
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum PerformanceSummaryBasis {
    MarketValue,
    BookBasis,
    Mixed,
    #[default]
    NotApplicable,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum PerformanceSummaryStatus {
    Complete,
    #[default]
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceSummary {
    pub amount: Option<Decimal>,
    pub percent: Option<Decimal>,
    pub method: ReturnMethod,
    pub basis: PerformanceSummaryBasis,
    pub quality: DataQualityStatus,
    pub amount_status: PerformanceSummaryStatus,
    pub percent_status: PerformanceSummaryStatus,
    pub basis_status: BasisStatus,
    pub reasons: Vec<String>,
}

impl Default for PerformanceSummary {
    fn default() -> Self {
        Self {
            amount: None,
            percent: None,
            method: ReturnMethod::NotApplicable,
            basis: PerformanceSummaryBasis::NotApplicable,
            quality: DataQualityStatus::NotApplicable,
            amount_status: PerformanceSummaryStatus::Unavailable,
            percent_status: PerformanceSummaryStatus::Unavailable,
            basis_status: BasisStatus::NotApplicable,
            reasons: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceResult {
    pub scope: PerformanceScopeDescriptor,
    pub period: PerformancePeriod,
    pub mode: ReturnMethod,
    pub returns: PerformanceReturns,
    pub attribution: PerformanceAttribution,
    pub risk: PerformanceRisk,
    pub data_quality: PerformanceDataQuality,
    #[serde(default)]
    pub basis_status: BasisStatus,
    #[serde(default, alias = "headline")]
    pub summary: PerformanceSummary,
    pub series: Vec<ReturnData>,
    #[serde(default)]
    pub is_holdings_mode: bool,
    #[serde(default)]
    pub is_mixed_tracking_mode: bool,
}

// This struct now only holds the calculated performance metrics.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SimplePerformanceMetrics {
    pub account_id: String,
    pub account_currency: Option<String>,
    pub base_currency: Option<String>,
    pub fx_rate_to_base: Option<Decimal>,
    pub total_value: Option<Decimal>,
    pub total_gain_loss_amount: Option<Decimal>,
    pub cumulative_return_percent: Option<Decimal>,
    pub portfolio_weight: Option<Decimal>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::portfolio::economic_events::BasisStatus;
    use chrono::NaiveDate;
    use serde_json::json;

    #[test]
    fn performance_result_serializes_typed_summary_contract() {
        let result = PerformanceResult {
            scope: PerformanceScopeDescriptor {
                id: "scope-1".to_string(),
                currency: "CAD".to_string(),
            },
            period: PerformancePeriod {
                start_date: Some(NaiveDate::from_ymd_opt(2026, 6, 1).unwrap()),
                end_date: Some(NaiveDate::from_ymd_opt(2026, 6, 30).unwrap()),
            },
            mode: ReturnMethod::ValueReturn,
            returns: PerformanceReturns {
                twr: None,
                annualized_twr: None,
                irr: None,
                annualized_irr: None,
                value_return: Some(Decimal::new(12, 2)),
                annualized_value_return: None,
            },
            attribution: PerformanceAttribution::default(),
            risk: PerformanceRisk {
                volatility: None,
                max_drawdown: None,
                peak_date: None,
                trough_date: None,
                recovery_date: None,
                drawdown_duration_days: None,
            },
            data_quality: PerformanceDataQuality {
                status: DataQualityStatus::Partial,
                warnings: vec!["display warning".to_string()],
                not_applicable_reasons: vec!["display reason".to_string()],
            },
            basis_status: BasisStatus::PartialUnknown,
            summary: PerformanceSummary {
                amount: Some(Decimal::new(1234, 2)),
                percent: None,
                method: ReturnMethod::ValueReturn,
                basis: PerformanceSummaryBasis::Mixed,
                quality: DataQualityStatus::Partial,
                amount_status: PerformanceSummaryStatus::Complete,
                percent_status: PerformanceSummaryStatus::Unavailable,
                basis_status: BasisStatus::PartialUnknown,
                reasons: vec!["display reason".to_string()],
            },
            series: Vec::new(),
            is_holdings_mode: false,
            is_mixed_tracking_mode: true,
        };

        let value = serde_json::to_value(&result).expect("performance result should serialize");

        assert_eq!(value["mode"], json!("valueReturn"));
        assert_eq!(value["basisStatus"], json!("partialUnknown"));
        assert_eq!(value["isMixedTrackingMode"], json!(true));
        assert!(value.get("headline").is_none());
        assert!(value["summary"].get("componentCoverage").is_none());
        assert_eq!(value["summary"]["method"], json!("valueReturn"));
        assert_eq!(value["summary"]["basis"], json!("mixed"));
        assert_eq!(value["summary"]["quality"], json!("partial"));
        assert_eq!(value["summary"]["amountStatus"], json!("complete"));
        assert_eq!(value["summary"]["percentStatus"], json!("unavailable"));
        assert_eq!(value["summary"]["basisStatus"], json!("partialUnknown"));
        assert_eq!(value["summary"]["reasons"][0], json!("display reason"));
    }
}
