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

/// One way of measuring return over the period. `period` is missing when
/// the scope cannot support it, and `unavailable_reason` says why.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceReturnView {
    pub period: Option<Decimal>,
    pub annualized: Option<Decimal>,
    /// Cumulative curve; filled for history requests only.
    #[serde(default)]
    pub series: Vec<ReturnData>,
    pub unavailable_reason: Option<String>,
    /// Stable code of `unavailable_reason` (e.g. `MIXED_TWR_NOT_APPLICABLE`),
    /// so a host can show its own text.
    #[serde(default)]
    pub unavailable_reason_code: Option<String>,
}

/// Every return computed for a scope. Each keeps one meaning for every kind
/// of scope; the host picks which one to show.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceReturns {
    /// Time-weighted return: deposits and withdrawals do not move it.
    pub twr: PerformanceReturnView,
    /// Money-weighted return: the internal rate of return on the dated
    /// deposits and withdrawals; the yearly rate is the same rate over a
    /// year.
    pub money_weighted: PerformanceReturnView,
    /// Gain over book cost, for holdings accounts over their full history.
    pub return_on_cost: PerformanceReturnView,
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
        returns: {
            let unavailable = PerformanceReturnView {
                unavailable_reason: Some(reason.clone()),
                ..PerformanceReturnView::default()
            };
            PerformanceReturns {
                twr: unavailable.clone(),
                money_weighted: unavailable.clone(),
                return_on_cost: unavailable,
            }
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
        is_holdings_mode: false,
        is_mixed_tracking_mode: false,
        amounts: PerformanceAmounts::default(),
        unclassified_transfers: Vec::new(),
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
    pub basis: PerformanceSummaryBasis,
    pub quality: DataQualityStatus,
    pub amount_status: PerformanceSummaryStatus,
    pub basis_status: BasisStatus,
    pub reasons: Vec<String>,
}

impl Default for PerformanceSummary {
    fn default() -> Self {
        Self {
            amount: None,
            basis: PerformanceSummaryBasis::NotApplicable,
            quality: DataQualityStatus::NotApplicable,
            amount_status: PerformanceSummaryStatus::Unavailable,
            basis_status: BasisStatus::NotApplicable,
            reasons: Vec::new(),
        }
    }
}

/// How the money in and out of a period is known.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PerformanceFlowKnowledge {
    /// Recorded transactions.
    #[default]
    Confirmed,
    /// Estimated, for example from the change between two holdings snapshots.
    Inferred,
    /// A flow in the period has no known amount or boundary.
    Missing,
}

/// The gain and capital of the accounts of one tracking mode in a mixed scope.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceAmountsPart {
    pub tracking: TrackingMode,
    pub gain: Decimal,
    pub capital: Decimal,
}

/// The amounts a period's return is built from, in the scope's currency. An
/// amount that does not apply to the scope, or cannot be known, is absent.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceAmounts {
    pub start_value: Option<Decimal>,
    /// Deposits and transfers in; purchases in an account that does not track cash.
    pub money_in: Option<Decimal>,
    pub money_out: Option<Decimal>,
    pub gain: Option<Decimal>,
    pub end_value: Option<Decimal>,
    /// What an ROI divides the gain by: book cost, or a mixed scope's capital.
    pub capital: Option<Decimal>,
    pub flows: PerformanceFlowKnowledge,
    /// A mixed scope's transactions accounts and its holdings accounts.
    #[serde(default)]
    pub parts: Vec<PerformanceAmountsPart>,
}

/// A transfer that is neither matched to another account nor marked
/// external; it withholds the time- and money-weighted returns of its period.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceUnclassifiedTransfer {
    pub activity_id: String,
    pub account_id: String,
    pub date: NaiveDate,
    /// Unsigned, in `currency`; absent for a transfer of securities.
    pub amount: Option<Decimal>,
    pub currency: String,
    pub outflow: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceResult {
    pub scope: PerformanceScopeDescriptor,
    pub period: PerformancePeriod,
    pub returns: PerformanceReturns,
    pub attribution: PerformanceAttribution,
    pub risk: PerformanceRisk,
    pub data_quality: PerformanceDataQuality,
    #[serde(default)]
    pub basis_status: BasisStatus,
    #[serde(default, alias = "headline")]
    pub summary: PerformanceSummary,
    #[serde(default)]
    pub is_holdings_mode: bool,
    #[serde(default)]
    pub is_mixed_tracking_mode: bool,
    #[serde(default)]
    pub amounts: PerformanceAmounts,
    #[serde(default)]
    pub unclassified_transfers: Vec<PerformanceUnclassifiedTransfer>,
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
            returns: PerformanceReturns {
                twr: PerformanceReturnView {
                    unavailable_reason: Some("display reason".to_string()),
                    ..PerformanceReturnView::default()
                },
                money_weighted: PerformanceReturnView {
                    period: Some(Decimal::new(12, 2)),
                    series: vec![ReturnData {
                        date: NaiveDate::from_ymd_opt(2026, 6, 30).unwrap(),
                        value: Decimal::new(12, 2),
                    }],
                    ..PerformanceReturnView::default()
                },
                return_on_cost: PerformanceReturnView::default(),
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
                basis: PerformanceSummaryBasis::Mixed,
                quality: DataQualityStatus::Partial,
                amount_status: PerformanceSummaryStatus::Complete,
                basis_status: BasisStatus::PartialUnknown,
                reasons: vec!["display reason".to_string()],
            },
            is_holdings_mode: false,
            is_mixed_tracking_mode: true,
            amounts: PerformanceAmounts {
                money_in: Some(Decimal::new(500, 0)),
                gain: Some(Decimal::new(1234, 2)),
                capital: Some(Decimal::new(1000, 0)),
                flows: PerformanceFlowKnowledge::Inferred,
                parts: vec![PerformanceAmountsPart {
                    tracking: TrackingMode::Holdings,
                    gain: Decimal::new(1234, 2),
                    capital: Decimal::new(1000, 0),
                }],
                ..PerformanceAmounts::default()
            },
            unclassified_transfers: vec![PerformanceUnclassifiedTransfer {
                activity_id: "activity-1".to_string(),
                account_id: "account-1".to_string(),
                date: NaiveDate::from_ymd_opt(2026, 3, 2).expect("valid date"),
                amount: Some(Decimal::new(200, 0)),
                currency: "CAD".to_string(),
                outflow: false,
            }],
        };

        let value = serde_json::to_value(&result).expect("performance result should serialize");

        assert!(value.get("mode").is_none());
        assert!(value.get("series").is_none());
        assert_eq!(value["returns"]["moneyWeighted"]["period"], json!(0.12));
        assert_eq!(
            value["returns"]["moneyWeighted"]["series"][0]["date"],
            json!("2026-06-30")
        );
        assert_eq!(
            value["returns"]["twr"]["unavailableReason"],
            json!("display reason")
        );
        assert_eq!(value["basisStatus"], json!("partialUnknown"));
        assert_eq!(value["isMixedTrackingMode"], json!(true));
        assert_eq!(value["amounts"]["moneyIn"], json!(500.0));
        assert_eq!(value["amounts"]["startValue"], json!(null));
        assert_eq!(value["amounts"]["flows"], json!("inferred"));
        assert_eq!(value["amounts"]["parts"][0]["tracking"], json!("HOLDINGS"));
        assert_eq!(
            value["unclassifiedTransfers"][0],
            json!({
                "activityId": "activity-1",
                "accountId": "account-1",
                "date": "2026-03-02",
                "amount": 200.0,
                "currency": "CAD",
                "outflow": false,
            })
        );
        assert!(value.get("headline").is_none());
        assert!(value["summary"].get("componentCoverage").is_none());
        assert!(value["summary"].get("percent").is_none());
        assert!(value["summary"].get("method").is_none());
        assert_eq!(value["summary"]["basis"], json!("mixed"));
        assert_eq!(value["summary"]["quality"], json!("partial"));
        assert_eq!(value["summary"]["amountStatus"], json!("complete"));
        assert_eq!(value["summary"]["basisStatus"], json!("partialUnknown"));
        assert_eq!(value["summary"]["reasons"][0], json!("display reason"));
    }
}
