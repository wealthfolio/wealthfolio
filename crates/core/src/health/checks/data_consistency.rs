//! Data consistency health check.
//!
//! Detects orphan references, negative positions, and legacy data needing migration.

use async_trait::async_trait;
use chrono::NaiveDate;
use rust_decimal::Decimal;

use crate::errors::Result;
use crate::health::model::{
    AffectedItem, DiagnosticDomain, DiagnosticLevel, Evidence, FixAction, HealthCategory,
    HealthDiagnostic, HealthEntityRef, HealthIssue, NavigateAction, Severity,
};
use crate::health::traits::{HealthCheck, HealthContext};

/// Types of data consistency issues.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum ConsistencyIssueType {
    /// Activity references a non-existent account
    OrphanActivityAccount,
    /// Activity references a non-existent asset
    OrphanActivityAsset,
    /// Holding has negative quantity for non-liability asset
    NegativePosition,
    /// Asset has legacy sector/country data not migrated to taxonomy
    LegacyClassification,
    /// Account has negative total portfolio value in its history
    NegativeAccountBalance,
    /// Cash account had a negative balance at some point (may be a bank overdraft)
    NegativeCashBalance,
    /// A sell activity has no matching lot disposal row for realized P&L attribution
    MissingLotDisposalForSell,
    /// Holdings snapshots exist for a date but the generated valuation read model has no row
    MissingGeneratedValuation,
    /// A generated valuation row has incomplete value coverage
    IncompleteValuationValue,
    /// A generated valuation row has incomplete cost-basis coverage
    IncompleteValuationBasis,
    /// A generated valuation row has an unknown performance flow boundary
    UnknownPerformanceFlowSource,
}

/// Root cause classification for valuation-quality issues (incomplete value /
/// missing generated row). Drives the structured diagnostic `code`, wording and
/// remediation action shown to the user.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValuationIssueReason {
    /// A held asset has no market quotes at all (unresolved symbol / provider gap).
    MissingMarketQuote,
    /// A manual/custom asset has no manual valuation entered.
    MissingManualValuation,
    /// A required FX rate is missing for the account/base currency conversion.
    MissingFxRate,
    /// The row is fully unavailable for returns (nothing priced, no cash).
    Unavailable,
    /// Cause could not be pinned to a specific asset (generic fallback).
    Unknown,
    /// Incomplete cost basis on a TRANSACTIONS-tracked account (an acquiring
    /// activity has no cost basis).
    IncompleteBasisActivity,
    /// Incomplete cost basis on a HOLDINGS-tracked account (the holdings
    /// snapshot has no cost basis; there are no transactions to fix).
    IncompleteBasisSnapshot,
}

impl ValuationIssueReason {
    /// Stable machine code used as the diagnostic `code`.
    pub fn code(self) -> &'static str {
        match self {
            ValuationIssueReason::MissingMarketQuote => "MISSING_MARKET_QUOTE",
            ValuationIssueReason::MissingManualValuation => "MISSING_MANUAL_VALUATION",
            ValuationIssueReason::MissingFxRate => "MISSING_FX_RATE",
            ValuationIssueReason::Unavailable => "UNAVAILABLE_VALUATION",
            ValuationIssueReason::Unknown => "INCOMPLETE_VALUATION",
            ValuationIssueReason::IncompleteBasisActivity => "INCOMPLETE_BASIS_ACTIVITY",
            ValuationIssueReason::IncompleteBasisSnapshot => "INCOMPLETE_BASIS_SNAPSHOT",
        }
    }
}

/// Data about a consistency issue.
#[derive(Debug, Clone)]
pub struct ConsistencyIssueInfo {
    /// Type of consistency issue
    pub issue_type: ConsistencyIssueType,
    /// ID of the affected record (activity_id, asset_id, etc.)
    pub record_id: String,
    /// Human-readable description (used as display name for affected items)
    pub description: String,
    /// Related account ID (if applicable)
    pub account_id: Option<String>,
    /// Related asset ID (if applicable)
    pub asset_id: Option<String>,
    /// First date the balance went negative (NegativeAccountBalance only)
    pub first_negative_date: Option<NaiveDate>,
    /// Cash balance on first_negative_date, in account currency (NegativeAccountBalance only)
    pub cash_balance: Option<Decimal>,
    /// Total portfolio value on first_negative_date, in account currency (NegativeAccountBalance only)
    pub total_value_at_date: Option<Decimal>,
    /// Account currency (NegativeAccountBalance only)
    pub account_currency: Option<String>,
    /// Activity date for activity-specific issues
    pub activity_date: Option<NaiveDate>,
    /// Asset display symbol for activity-specific issues
    pub asset_symbol: Option<String>,
    /// Asset display name for activity-specific issues
    pub asset_name: Option<String>,
    /// Activity quantity for activity-specific issues
    pub quantity: Option<Decimal>,
    /// Activity proceeds for activity-specific issues
    pub proceeds: Option<Decimal>,
    /// Root cause classification for valuation-quality issues (drives diagnostics).
    pub reason: Option<ValuationIssueReason>,
    /// The specific activity to deep-link to (e.g. the acquiring transaction that
    /// lacks a cost basis), when the issue traces to one activity row.
    pub activity_id: Option<String>,
}

/// Health check that detects data consistency problems.
pub struct DataConsistencyCheck;

impl DataConsistencyCheck {
    /// Creates a new data consistency check.
    pub fn new() -> Self {
        Self
    }

    /// Analyzes data for consistency issues.
    pub fn analyze(
        &self,
        issues_data: &[ConsistencyIssueInfo],
        _ctx: &HealthContext,
    ) -> Vec<HealthIssue> {
        let mut health_issues = Vec::new();

        if issues_data.is_empty() {
            return health_issues;
        }

        // Group by issue type
        let mut by_type: std::collections::HashMap<
            ConsistencyIssueType,
            Vec<&ConsistencyIssueInfo>,
        > = std::collections::HashMap::new();

        for issue in issues_data {
            by_type
                .entry(issue.issue_type.clone())
                .or_default()
                .push(issue);
        }

        // Emit health issue for orphan activities (account references)
        if let Some(orphan_account_issues) =
            by_type.get(&ConsistencyIssueType::OrphanActivityAccount)
        {
            let count = orphan_account_issues.len();
            let record_ids: Vec<String> = orphan_account_issues
                .iter()
                .map(|i| i.record_id.clone())
                .collect();
            let data_hash = compute_data_hash(&record_ids);

            health_issues.push(
                HealthIssue::builder()
                    .id(format!("orphan_activity_account:{}", data_hash))
                    .severity(Severity::Error)
                    .category(HealthCategory::DataConsistency)
                    .code("data_orphan_activity_account")
                    .param("count", count as u32)
                    .title(if count == 1 {
                        "Transaction references missing account".to_string()
                    } else {
                        format!("{} transactions reference missing accounts", count)
                    })
                    .message(
                        "Some transactions point to accounts that no longer exist. This may cause calculation errors.",
                    )
                    .affected_count(count as u32)
                    // Orphan activities reference a missing account, so they cannot
                    // be surfaced by the account-scoped activity search; link to the
                    // full activities view rather than an unsupported filter.
                    .navigate_action(NavigateAction::to_activities(None))
                    .data_hash(data_hash)
                    .build(),
            );
        }

        // Emit health issue for orphan activities (asset references)
        if let Some(orphan_asset_issues) = by_type.get(&ConsistencyIssueType::OrphanActivityAsset) {
            let count = orphan_asset_issues.len();
            let record_ids: Vec<String> = orphan_asset_issues
                .iter()
                .map(|i| i.record_id.clone())
                .collect();
            let data_hash = compute_data_hash(&record_ids);

            health_issues.push(
                HealthIssue::builder()
                    .id(format!("orphan_activity_asset:{}", data_hash))
                    .severity(Severity::Error)
                    .category(HealthCategory::DataConsistency)
                    .code("data_orphan_activity_asset")
                    .param("count", count as u32)
                    .title(if count == 1 {
                        "Transaction references missing asset".to_string()
                    } else {
                        format!("{} transactions reference missing assets", count)
                    })
                    .message(
                        "Some transactions point to assets that no longer exist. This may cause calculation errors.",
                    )
                    .affected_count(count as u32)
                    // No orphan filter on the activity search; link to the full view.
                    .navigate_action(NavigateAction::to_activities(None))
                    .data_hash(data_hash)
                    .build(),
            );
        }

        // Emit health issue for negative positions
        if let Some(negative_issues) = by_type.get(&ConsistencyIssueType::NegativePosition) {
            let count = negative_issues.len();
            let record_ids: Vec<String> = negative_issues
                .iter()
                .map(|i| i.record_id.clone())
                .collect();
            let data_hash = compute_data_hash(&record_ids);

            health_issues.push(
                HealthIssue::builder()
                    .id(format!("negative_position:{}", data_hash))
                    .severity(Severity::Warning)
                    .category(HealthCategory::DataConsistency)
                    .code("data_negative_position")
                    .param("count", count as u32)
                    .title(if count == 1 {
                        "Holding has negative quantity".to_string()
                    } else {
                        format!("{} holdings have negative quantities", count)
                    })
                    .message(
                        "Some holdings show negative quantities, which usually indicates missing or incorrect transactions.",
                    )
                    .affected_count(count as u32)
                    .navigate_action(NavigateAction::to_holdings(Some("negative")))
                    .data_hash(data_hash)
                    .build(),
            );
        }

        // Emit health issue for legacy classifications needing migration
        if let Some(legacy_issues) = by_type.get(&ConsistencyIssueType::LegacyClassification) {
            let count = legacy_issues.len();
            let asset_ids: Vec<String> = legacy_issues
                .iter()
                .filter_map(|i| i.asset_id.clone())
                .collect();
            let data_hash = compute_data_hash(&asset_ids);

            health_issues.push(
                HealthIssue::builder()
                    .id(format!("legacy_classification:{}", data_hash))
                    .severity(Severity::Info)
                    .category(HealthCategory::DataConsistency)
                    .code("data_legacy_classification")
                    .param("count", count as u32)
                    .title(if count == 1 {
                        "1 asset has old classification data".to_string()
                    } else {
                        format!("{} assets have old classification data", count)
                    })
                    .message(
                        "Some assets have legacy sector/country data that can be migrated to the new classification system.",
                    )
                    .affected_count(count as u32)
                    .navigate_action(NavigateAction::to_taxonomies())
                    .data_hash(data_hash)
                    .build(),
            );
        }

        // Emit health issue for accounts with negative portfolio balance
        if let Some(negative_balance_issues) =
            by_type.get(&ConsistencyIssueType::NegativeAccountBalance)
        {
            let count = negative_balance_issues.len();
            let account_ids: Vec<String> = negative_balance_issues
                .iter()
                .map(|i| i.record_id.clone())
                .collect();
            let data_hash = compute_data_hash(&account_ids);
            let affected_items: Vec<AffectedItem> = negative_balance_issues
                .iter()
                .map(|i| AffectedItem::account(i.record_id.clone(), i.description.clone()))
                .collect();

            // Details: one entry per account with date, breakdown, and likely cause
            let details: String = negative_balance_issues
                .iter()
                .filter_map(|i| {
                    let ccy = i.account_currency.as_deref()?;
                    let cash = i.cash_balance?;
                    let total = i.total_value_at_date?;
                    let investments = total - cash;
                    let date_line = i
                        .first_negative_date
                        .map(|d| format!("First went negative on {}.", d.format("%Y-%m-%d")))
                        .unwrap_or_default();
                    let breakdown = format!(
                        "Cash: {} {} | Investments: {} {}",
                        cash.round_dp(2),
                        ccy,
                        investments.round_dp(2),
                        ccy,
                    );
                    let likely_cause = if cash < Decimal::ZERO && investments >= Decimal::ZERO {
                        "→ Likely missing Transfer In or deposit before a buy transaction."
                    } else if cash >= Decimal::ZERO && investments < Decimal::ZERO {
                        "→ Likely missing Buy transaction before a Sell."
                    } else {
                        "→ Multiple data issues — check activities around this date."
                    };
                    Some(format!(
                        "{}\n{}\n{}\n{}",
                        i.description, date_line, breakdown, likely_cause
                    ))
                })
                .collect::<Vec<_>>()
                .join("\n\n");

            let mut builder = HealthIssue::builder()
                .id(format!("negative_account_balance:{}", data_hash))
                .severity(Severity::Warning)
                .category(HealthCategory::DataConsistency)
                .code("data_negative_account_balance")
                .param("count", count as u32)
                .title(if count == 1 {
                    "Account has negative portfolio balance".to_string()
                } else {
                    format!("{} accounts have negative portfolio balance", count)
                })
                .message(
                    "One or more accounts show a negative total value in their history. This is usually caused by missing buy transactions. Review your activities to fix this.",
                )
                .affected_count(count as u32)
                .affected_items(affected_items)
                .navigate_action(NavigateAction::to_activities(None))
                .data_hash(data_hash);
            if !details.is_empty() {
                builder = builder.details(details);
            }
            health_issues.push(builder.build());
        }

        // Emit info issue for cash accounts with negative balance (may be a normal overdraft)
        if let Some(cash_balance_issues) = by_type.get(&ConsistencyIssueType::NegativeCashBalance) {
            let count = cash_balance_issues.len();
            let account_ids: Vec<String> = cash_balance_issues
                .iter()
                .map(|i| i.record_id.clone())
                .collect();
            let data_hash = compute_data_hash(&account_ids);
            let affected_items: Vec<AffectedItem> = cash_balance_issues
                .iter()
                .map(|i| AffectedItem::account(i.record_id.clone(), i.description.clone()))
                .collect();
            let details: String = cash_balance_issues
                .iter()
                .filter_map(|i| {
                    let ccy = i.account_currency.as_deref()?;
                    let cash = i.cash_balance?;
                    let date_line = i
                        .first_negative_date
                        .map(|d| format!("First went negative on {}.", d.format("%Y-%m-%d")))
                        .unwrap_or_default();
                    Some(format!(
                        "{}\n{}\nCash: {} {}\n→ This may be a bank overdraft or a missing deposit entry.",
                        i.description, date_line, cash.round_dp(2), ccy,
                    ))
                })
                .collect::<Vec<_>>()
                .join("\n\n");

            let mut builder = HealthIssue::builder()
                .id(format!("negative_cash_balance:{}", data_hash))
                .severity(Severity::Info)
                .category(HealthCategory::DataConsistency)
                .code("data_negative_cash_balance")
                .param("count", count as u32)
                .title(if count == 1 {
                    "Cash account had a negative balance".to_string()
                } else {
                    format!("{} cash accounts had a negative balance", count)
                })
                .message(
                    "One or more cash accounts show a negative balance in their history. This may be a normal bank overdraft or a missing deposit entry.",
                )
                .affected_count(count as u32)
                .affected_items(affected_items)
                .navigate_action(NavigateAction::to_activities(None))
                .data_hash(data_hash);
            if !details.is_empty() {
                builder = builder.details(details);
            }
            health_issues.push(builder.build());
        }

        if let Some(missing_disposal_issues) =
            by_type.get(&ConsistencyIssueType::MissingLotDisposalForSell)
        {
            let count = missing_disposal_issues.len();
            let data_keys: Vec<String> = missing_disposal_issues
                .iter()
                .map(|i| {
                    format!(
                        "{}:{}:{}:{}",
                        i.record_id,
                        i.activity_date
                            .map(|d| d.format("%Y-%m-%d").to_string())
                            .unwrap_or_default(),
                        i.quantity.unwrap_or_default(),
                        i.proceeds.unwrap_or_default()
                    )
                })
                .collect();
            let data_hash = compute_data_hash(&data_keys);

            let mut seen_accounts = std::collections::HashSet::new();
            let affected_items: Vec<AffectedItem> = missing_disposal_issues
                .iter()
                .filter_map(|i| {
                    let account_id = i.account_id.as_ref()?;
                    if !seen_accounts.insert(account_id.clone()) {
                        return None;
                    }
                    Some(AffectedItem::account(
                        account_id.clone(),
                        i.description.clone(),
                    ))
                })
                .collect();

            let details = missing_disposal_issues
                .iter()
                .map(|i| {
                    let asset = i
                        .asset_symbol
                        .as_deref()
                        .or(i.asset_name.as_deref())
                        .unwrap_or("asset");
                    let date = i
                        .activity_date
                        .map(|d| d.format("%Y-%m-%d").to_string())
                        .unwrap_or_else(|| "unknown date".to_string());
                    let quantity = i
                        .quantity
                        .map(|q| format!("Quantity: {}", q.round_dp(6)))
                        .unwrap_or_else(|| "Quantity: unavailable".to_string());
                    let proceeds = match (i.proceeds, i.account_currency.as_deref()) {
                        (Some(amount), Some(currency)) => {
                            format!("Proceeds: {} {}", amount.round_dp(2), currency)
                        }
                        (Some(amount), None) => format!("Proceeds: {}", amount.round_dp(2)),
                        _ => "Proceeds: unavailable".to_string(),
                    };
                    format!(
                        "{}\nSell: {} on {}\n{} | {}\nReview the sell activity or rebuild account history so cost-basis lots are available.",
                        i.description, asset, date, quantity, proceeds
                    )
                })
                .collect::<Vec<_>>()
                .join("\n\n");

            let mut builder = HealthIssue::builder()
                .id(format!("missing_lot_disposal_for_sell:{}", data_hash))
                .severity(Severity::Warning)
                .category(HealthCategory::DataConsistency)
                .code("data_missing_lot_disposal_for_sell")
                .param("count", count as u32)
                .title(if count == 1 {
                    "Sale missing cost-basis match".to_string()
                } else {
                    format!("{} sales missing cost-basis matches", count)
                })
                .message(
                    "A sale could not be matched to a lot, so realized gain/loss and performance attribution may be incomplete.",
                )
                .affected_count(count as u32)
                .navigate_action(NavigateAction {
                    route: "/activities".to_string(),
                    query: Some(serde_json::json!({ "types": "SELL" })),
                    label: "Review Transactions".to_string(),
                })
                .data_hash(data_hash);
            if !affected_items.is_empty() {
                builder = builder.affected_items(affected_items);
            }
            if !details.is_empty() {
                builder = builder.details(details);
            }
            health_issues.push(builder.build());
        }

        if let Some(missing_issues) = by_type.get(&ConsistencyIssueType::MissingGeneratedValuation)
        {
            health_issues.push(build_valuation_quality_issue(
                "missing_generated_valuation",
                "data_missing_generated_valuation",
                missing_issues,
                Severity::Warning,
                "Account history needs rebuilding",
                "daily account values are missing",
                "Some daily account values are missing. Fix any missing prices, manual values, or exchange rates, then rebuild account history.",
            ));
        }

        if let Some(value_issues) = by_type.get(&ConsistencyIssueType::IncompleteValuationValue) {
            let copy = value_issue_copy(value_issues);
            health_issues.push(build_valuation_quality_issue(
                "incomplete_valuation_value",
                "data_incomplete_valuation_value",
                value_issues,
                Severity::Warning,
                copy.title,
                copy.plural_title,
                copy.message,
            ));
        }

        if let Some(basis_issues) = by_type.get(&ConsistencyIssueType::IncompleteValuationBasis) {
            let copy = basis_issue_copy(basis_issues);
            health_issues.push(build_valuation_quality_issue(
                "incomplete_valuation_basis",
                "data_incomplete_valuation_basis",
                basis_issues,
                Severity::Warning,
                copy.title,
                copy.plural_title,
                copy.message,
            ));
        }

        if let Some(flow_issues) = by_type.get(&ConsistencyIssueType::UnknownPerformanceFlowSource)
        {
            health_issues.push(build_unknown_performance_flow_issue(
                "unknown_performance_flow_source",
                "data_unknown_performance_flow_source",
                flow_issues,
                Severity::Error,
                "Transfer date needs review",
                "transfer dates need review",
                "Some transfers are unclear: Wealthfolio cannot tell if money moved between your own accounts or entered/left your portfolio. Review those transfers so returns are not overstated or understated.",
            ));
        }

        health_issues
    }
}

struct IssueCopy {
    title: &'static str,
    plural_title: &'static str,
    message: &'static str,
}

fn value_issue_copy(issues: &[&ConsistencyIssueInfo]) -> IssueCopy {
    let has_market_quote = issues
        .iter()
        .any(|issue| issue.reason == Some(ValuationIssueReason::MissingMarketQuote));
    let has_manual_value = issues
        .iter()
        .any(|issue| issue.reason == Some(ValuationIssueReason::MissingManualValuation));
    let has_fx = issues
        .iter()
        .any(|issue| issue.reason == Some(ValuationIssueReason::MissingFxRate));
    let has_generic = issues.iter().any(|issue| {
        matches!(
            issue.reason,
            None | Some(ValuationIssueReason::Unavailable) | Some(ValuationIssueReason::Unknown)
        )
    });

    if has_market_quote && !has_manual_value && !has_fx && !has_generic {
        return IssueCopy {
            title: "Price date needs review",
            plural_title: "price dates need review",
            message: "Some trading days are missing exact market prices. Wealthfolio can carry forward the last available price, but syncing or adding the missing prices keeps daily values and returns accurate. If a date was a market holiday or the investment did not trade, dismiss this issue.",
        };
    }

    if has_manual_value && !has_market_quote && !has_fx && !has_generic {
        return IssueCopy {
            title: "Manual price date needs review",
            plural_title: "manual price dates need review",
            message: "Some manual holdings are missing values on days they were held. Wealthfolio can carry forward the last value, but adding the missing dates keeps daily values and returns accurate. If a separate value is not needed for the date, dismiss this issue.",
        };
    }

    if has_fx && !has_market_quote && !has_manual_value && !has_generic {
        return IssueCopy {
            title: "Exchange rate is missing",
            plural_title: "exchange rates are missing",
            message: "Some holdings need exchange rates before Wealthfolio can convert them to your base currency.",
        };
    }

    IssueCopy {
        title: "Holding value is missing",
        plural_title: "prices or values are missing",
        message: "Some holdings are missing a market price, manual value, or exchange rate. Add the missing data so Wealthfolio can calculate their value and returns.",
    }
}

fn basis_issue_copy(issues: &[&ConsistencyIssueInfo]) -> IssueCopy {
    let has_activity = issues
        .iter()
        .any(|issue| issue.reason == Some(ValuationIssueReason::IncompleteBasisActivity));
    let has_snapshot = issues
        .iter()
        .any(|issue| issue.reason == Some(ValuationIssueReason::IncompleteBasisSnapshot));
    let has_unclassified = issues.iter().any(|issue| issue.reason.is_none());

    if has_activity && !has_snapshot && !has_unclassified {
        return IssueCopy {
            title: "Transaction is missing a purchase price",
            plural_title: "transactions are missing purchase prices",
            message: "Some buys or transfer-ins are missing the price paid. Add the price to each transaction so Wealthfolio can calculate cost basis, gains/losses, and returns.",
        };
    }

    if has_snapshot && !has_activity && !has_unclassified {
        return IssueCopy {
            title: "Holding is missing cost basis",
            plural_title: "holdings are missing cost basis",
            message: "Some holdings are missing what you paid for them. Add the cost basis so Wealthfolio can calculate gains/losses and returns.",
        };
    }

    IssueCopy {
        title: "Cost basis input needs review",
        plural_title: "cost basis inputs need review",
        message: "Some transactions or holdings are missing what you paid. Add the missing cost basis so gains/losses and returns can be calculated.",
    }
}

#[allow(clippy::too_many_arguments)]
fn build_unknown_performance_flow_issue(
    id_prefix: &str,
    code: &str,
    issues: &[&ConsistencyIssueInfo],
    severity: Severity,
    title: &str,
    plural_title: &str,
    message: &str,
) -> HealthIssue {
    let mut data_keys: Vec<String> = issues
        .iter()
        .map(|i| {
            format!(
                "{}:{}",
                i.record_id,
                i.activity_date
                    .map(|d| d.format("%Y-%m-%d").to_string())
                    .unwrap_or_default()
            )
        })
        .collect();
    data_keys.sort();
    let data_hash = compute_data_hash(&data_keys);

    let affected_items: Vec<AffectedItem> = issues
        .iter()
        .map(|issue| {
            let query = unknown_transfer_issue_query(issue);
            let date = issue
                .activity_date
                .map(|date| date.format("%Y-%m-%d").to_string())
                .unwrap_or_else(|| "unknown date".to_string());
            AffectedItem {
                id: issue.record_id.clone(),
                name: format!("{} transfer on {}", issue.description, date),
                symbol: None,
                route: Some(activity_route_from_query(&query)),
            }
        })
        .collect();

    let details = issues
        .iter()
        .map(|issue| {
            let date = issue
                .activity_date
                .map(|date| date.format("%Y-%m-%d").to_string())
                .unwrap_or_else(|| "unknown date".to_string());
            format!(
                "{}\nDate: {}\nReview transfer transactions for this account and date.",
                issue.description, date
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");

    let diagnostics: Vec<HealthDiagnostic> = issues
        .iter()
        .map(|issue| unknown_transfer_diagnostic(issue))
        .collect();

    let mut builder = HealthIssue::builder()
        .id(format!("{}:{}", id_prefix, data_hash))
        .severity(severity)
        .category(HealthCategory::DataConsistency)
        .code(code)
        .param("count", issues.len() as u32)
        .title(if issues.len() == 1 {
            title.to_string()
        } else {
            format!("{} {}", issues.len(), plural_title)
        })
        .message(message)
        .affected_count(issues.len() as u32)
        .navigate_action(NavigateAction {
            route: "/activities".to_string(),
            query: Some(unknown_transfer_review_query(issues)),
            label: "Review Transactions".to_string(),
        })
        .diagnostics(diagnostics)
        .data_hash(data_hash);

    if !affected_items.is_empty() {
        builder = builder.affected_items(affected_items);
    }
    if !details.is_empty() {
        builder = builder.details(details);
    }

    builder.build()
}

fn unknown_transfer_review_query(issues: &[&ConsistencyIssueInfo]) -> serde_json::Value {
    let mut query = serde_json::Map::new();
    query.insert(
        "types".to_string(),
        serde_json::json!("TRANSFER_IN,TRANSFER_OUT"),
    );
    query.insert("healthContext".to_string(), serde_json::json!("activity"));

    let mut dates: Vec<_> = issues.iter().filter_map(|i| i.activity_date).collect();
    dates.sort_unstable();
    if let Some(first_date) = dates.first() {
        query.insert(
            "from".to_string(),
            serde_json::json!(first_date.to_string()),
        );
    }
    if let Some(last_date) = dates.last() {
        query.insert("to".to_string(), serde_json::json!(last_date.to_string()));
    }

    let mut account_ids: Vec<_> = issues
        .iter()
        .filter_map(|i| i.account_id.as_ref())
        .collect();
    account_ids.sort();
    account_ids.dedup();
    if let [account_id] = account_ids.as_slice() {
        query.insert("account".to_string(), serde_json::json!(account_id));
    }

    serde_json::Value::Object(query)
}

fn unknown_transfer_issue_query(
    issue: &ConsistencyIssueInfo,
) -> serde_json::Map<String, serde_json::Value> {
    let mut query = serde_json::Map::new();
    query.insert(
        "types".to_string(),
        serde_json::json!("TRANSFER_IN,TRANSFER_OUT"),
    );
    query.insert("healthContext".to_string(), serde_json::json!("activity"));
    if let Some(account_id) = issue.account_id.as_ref() {
        query.insert("account".to_string(), serde_json::json!(account_id));
    }
    if let Some(date) = issue.activity_date {
        let date = date.format("%Y-%m-%d").to_string();
        query.insert("from".to_string(), serde_json::json!(date.clone()));
        query.insert("to".to_string(), serde_json::json!(date));
    }
    query
}

fn activity_route_from_query(query: &serde_json::Map<String, serde_json::Value>) -> String {
    let params = query
        .iter()
        .filter_map(|(key, value)| {
            let value = value.as_str()?;
            Some(format!(
                "{}={}",
                urlencoding::encode(key),
                urlencoding::encode(value)
            ))
        })
        .collect::<Vec<_>>();
    format!("/activities?{}", params.join("&"))
}

fn unknown_transfer_diagnostic(issue: &ConsistencyIssueInfo) -> HealthDiagnostic {
    let query = unknown_transfer_issue_query(issue);
    let route = activity_route_from_query(&query);
    let navigate = NavigateAction {
        route: "/activities".to_string(),
        query: Some(serde_json::Value::Object(query)),
        label: "Review Transactions".to_string(),
    };

    let mut diagnostic = HealthDiagnostic::new(
        "TRANSFER_DATE_NEEDS_REVIEW",
        "Transfer needs review",
        "Review the transfers on this date. Match the two transactions if money moved between your accounts, or mark it external if money entered or left your portfolio.",
    )
    .domain(DiagnosticDomain::Ledger)
    .level(DiagnosticLevel::Source)
    .entity(
        HealthEntityRef::new("transferDate", issue.record_id.clone())
            .label(issue.description.clone())
            .route(route.clone()),
    )
    .evidence(Evidence::new("Transfer", issue.description.clone()).with_route(route))
    .navigate(true, navigate);

    if let Some(date) = issue.activity_date {
        let date = date.format("%Y-%m-%d").to_string();
        diagnostic = diagnostic
            .date(date.clone())
            .evidence(Evidence::new("Date", date));
    }

    diagnostic
}

#[allow(clippy::too_many_arguments)]
fn build_valuation_quality_issue(
    id_prefix: &str,
    code: &str,
    issues: &[&ConsistencyIssueInfo],
    severity: Severity,
    title: &str,
    plural_title: &str,
    message: &str,
) -> HealthIssue {
    let mut data_keys: Vec<String> = issues
        .iter()
        .map(|i| {
            format!(
                "{}:{}",
                i.record_id,
                i.activity_date
                    .map(|d| d.format("%Y-%m-%d").to_string())
                    .unwrap_or_default()
            )
        })
        .collect();
    data_keys.sort();
    let data_hash = compute_data_hash(&data_keys);

    let mut seen_items = std::collections::HashSet::new();
    let affected_items: Vec<AffectedItem> = issues
        .iter()
        .filter_map(|i| {
            if let Some(asset_id) = i.asset_id.as_ref() {
                if !seen_items.insert(format!("asset:{asset_id}")) {
                    return None;
                }
                let symbol = i.asset_symbol.clone().unwrap_or_else(|| asset_id.clone());
                return Some(AffectedItem::asset_with_name(
                    asset_id.clone(),
                    symbol,
                    i.asset_name.clone(),
                ));
            }

            let account_id = i.account_id.as_ref()?;
            if !seen_items.insert(format!("account:{account_id}")) {
                return None;
            }
            Some(AffectedItem::account(
                account_id.clone(),
                i.description.clone(),
            ))
        })
        .collect();

    let details = issues
        .iter()
        .map(|i| {
            let date = i
                .activity_date
                .map(|d| d.format("%Y-%m-%d").to_string())
                .unwrap_or_else(|| "unknown date".to_string());
            format!("{}\nDate: {}", i.description, date)
        })
        .collect::<Vec<_>>()
        .join("\n\n");

    let diagnostics: Vec<HealthDiagnostic> = issues
        .iter()
        .filter_map(|i| valuation_diagnostic(i))
        .collect();

    let mut builder = HealthIssue::builder()
        .id(format!("{}:{}", id_prefix, data_hash))
        .severity(severity)
        .category(HealthCategory::DataConsistency)
        .code(code)
        .param("count", issues.len() as u32)
        .title(if issues.len() == 1 {
            title.to_string()
        } else {
            format!("{} {}", issues.len(), plural_title)
        })
        .message(message)
        .affected_count(issues.len() as u32)
        .navigate_action(NavigateAction::to_activities(None))
        .data_hash(data_hash);
    if !affected_items.is_empty() {
        builder = builder.affected_items(affected_items);
    }
    if !details.is_empty() {
        builder = builder.details(details);
    }
    if !diagnostics.is_empty() {
        builder = builder.diagnostics(diagnostics);
    }
    builder.build()
}

fn asset_quote_route(asset_id: &str, date: Option<&str>) -> String {
    let encoded_asset_id = urlencoding::encode(asset_id);
    match date {
        Some(date) => format!(
            "/holdings/{}?tab=quotes&healthContext=price&date={}",
            encoded_asset_id,
            urlencoding::encode(date)
        ),
        None => format!("/holdings/{encoded_asset_id}?tab=quotes&healthContext=price"),
    }
}

fn asset_quote_navigate_action(asset_id: String, date: Option<&str>) -> NavigateAction {
    let query = match date {
        Some(date) => {
            serde_json::json!({ "tab": "quotes", "healthContext": "price", "date": date })
        }
        None => serde_json::json!({ "tab": "quotes", "healthContext": "price" }),
    };

    NavigateAction {
        route: format!("/holdings/{}", urlencoding::encode(&asset_id)),
        query: Some(query),
        label: "Add Price".to_string(),
    }
}

/// Builds a structured diagnostic (root cause, evidence, ordered actions) for a
/// classified valuation-quality issue. Returns `None` for issues without a
/// classified `reason` so the UI falls back to the flat `details` rendering.
fn valuation_diagnostic(issue: &ConsistencyIssueInfo) -> Option<HealthDiagnostic> {
    let reason = issue.reason?;

    let (title, explanation) = match reason {
        ValuationIssueReason::MissingMarketQuote => (
            "No price found",
            "Wealthfolio is missing the exact market price for this holding on the affected date. \
             It can carry forward the last available price, but syncing or adding the exact price keeps daily returns accurate. \
             If this was a market holiday or the investment did not trade, dismiss this issue.",
        ),
        ValuationIssueReason::MissingManualValuation => (
            "No value entered",
            "This manual holding has no value entered for the affected date. Wealthfolio can carry forward the last value, but adding this date keeps daily returns accurate. If a separate value is not needed for this date, dismiss this issue.",
        ),
        ValuationIssueReason::MissingFxRate => (
            "No exchange rate",
            "An exchange rate is missing, so this holding cannot be converted to your base currency.",
        ),
        ValuationIssueReason::Unavailable => (
            "Account value is missing",
            "This account could not be valued on the affected date. Wealthfolio hides returns for that period instead of showing a misleading number.",
        ),
        ValuationIssueReason::Unknown => (
            "Holding value needs review",
            "At least one holding could not be valued on the affected date. Add the missing price or value to restore complete returns.",
        ),
        ValuationIssueReason::IncompleteBasisActivity => (
            "Missing purchase price",
            "This transaction has no price, so Wealthfolio cannot calculate what you paid or your gain/loss. \
             Add the price you paid. If the shares were free, record them as a Transfer In.",
        ),
        ValuationIssueReason::IncompleteBasisSnapshot => (
            "Missing cost basis",
            "This holding has no cost basis, so Wealthfolio cannot calculate gain/loss. \
             Add what you paid in the holdings entry.",
        ),
    };

    let (domain, level) = match reason {
        ValuationIssueReason::MissingMarketQuote | ValuationIssueReason::MissingManualValuation => {
            (DiagnosticDomain::MarketData, DiagnosticLevel::Source)
        }
        ValuationIssueReason::MissingFxRate => (DiagnosticDomain::Fx, DiagnosticLevel::Source),
        ValuationIssueReason::Unavailable | ValuationIssueReason::Unknown => {
            (DiagnosticDomain::GeneratedData, DiagnosticLevel::Generated)
        }
        ValuationIssueReason::IncompleteBasisActivity
        | ValuationIssueReason::IncompleteBasisSnapshot => {
            (DiagnosticDomain::PerformanceInputs, DiagnosticLevel::Source)
        }
    };

    let mut diagnostic = HealthDiagnostic::new(reason.code(), title, explanation)
        .domain(domain)
        .level(level);

    if let Some(asset_id) = issue.asset_id.as_ref() {
        let label = issue
            .asset_symbol
            .clone()
            .map(|symbol| match issue.asset_name.as_ref() {
                Some(name) => format!("{symbol} — {name}"),
                None => symbol,
            })
            .unwrap_or_else(|| asset_id.clone());
        let issue_date = issue
            .activity_date
            .map(|date| date.format("%Y-%m-%d").to_string());
        let asset_route = match reason {
            ValuationIssueReason::MissingMarketQuote
            | ValuationIssueReason::MissingManualValuation => {
                asset_quote_route(asset_id, issue_date.as_deref())
            }
            ValuationIssueReason::IncompleteBasisSnapshot => {
                format!(
                    "/holdings/{}?tab=snapshots&healthContext=basis",
                    urlencoding::encode(asset_id)
                )
            }
            ValuationIssueReason::IncompleteBasisActivity => {
                format!(
                    "/holdings/{}?tab=activities&healthContext=activity",
                    urlencoding::encode(asset_id)
                )
            }
            _ => format!("/holdings/{}", urlencoding::encode(asset_id)),
        };
        let evidence_label = match reason {
            ValuationIssueReason::IncompleteBasisActivity => "Transaction",
            _ => "Asset",
        };
        diagnostic = diagnostic
            .evidence(Evidence::new(evidence_label, label.clone()).with_route(asset_route.clone()));
        diagnostic = diagnostic.entity(
            HealthEntityRef::new("asset", asset_id.clone())
                .label(label)
                .route(asset_route),
        );
    } else {
        diagnostic = diagnostic.evidence(Evidence::new("Account", issue.description.clone()));
    }

    if let Some(account_id) = issue.account_id.as_ref() {
        diagnostic = diagnostic.entity(
            HealthEntityRef::new("account", account_id.clone()).label(issue.description.clone()),
        );
    }

    if let Some(activity_id) = issue.activity_id.as_ref() {
        diagnostic = diagnostic.entity(
            HealthEntityRef::new("activity", activity_id.clone()).route(format!(
                "/activities?activity={}&healthContext=activity",
                urlencoding::encode(activity_id)
            )),
        );
    }

    if let Some(date) = issue.activity_date {
        let label = match reason {
            ValuationIssueReason::IncompleteBasisActivity => "Trade date",
            _ => "Date",
        };
        let date = date.format("%Y-%m-%d").to_string();
        diagnostic = diagnostic
            .date(date.clone())
            .evidence(Evidence::new(label, date));
    }

    match reason {
        ValuationIssueReason::MissingMarketQuote => {
            if let Some(asset_id) = issue.asset_id.clone() {
                let issue_date = issue
                    .activity_date
                    .map(|date| date.format("%Y-%m-%d").to_string());
                diagnostic = diagnostic
                    .fix(true, FixAction::sync_prices(vec![asset_id.clone()]))
                    .navigate(
                        false,
                        asset_quote_navigate_action(asset_id, issue_date.as_deref()),
                    );
            } else {
                diagnostic = diagnostic.navigate(true, NavigateAction::to_market_data());
            }
        }
        ValuationIssueReason::MissingManualValuation => {
            if let Some(asset_id) = issue.asset_id.clone() {
                let issue_date = issue
                    .activity_date
                    .map(|date| date.format("%Y-%m-%d").to_string());
                diagnostic = diagnostic.navigate(
                    true,
                    asset_quote_navigate_action(asset_id, issue_date.as_deref()),
                );
            }
        }
        ValuationIssueReason::MissingFxRate => {
            diagnostic = diagnostic.navigate(true, NavigateAction::to_market_data());
        }
        ValuationIssueReason::Unavailable | ValuationIssueReason::Unknown => {
            diagnostic = diagnostic.navigate(true, NavigateAction::to_activities(None));
            // Once the underlying prices/valuations are fixed, an account-scoped
            // rebuild regenerates the affected history rows.
            if let Some(account_id) = issue.account_id.clone() {
                diagnostic =
                    diagnostic.fix(false, FixAction::rebuild_account_history(vec![account_id]));
            }
        }
        ValuationIssueReason::IncompleteBasisActivity => {
            // Transaction-tracked: the acquiring activity lacks a cost basis.
            // Prefer an exact deep-link to that activity; otherwise fall back to
            // the asset's own activities tab (asset-scoped).
            if let Some(activity_id) = issue.activity_id.clone() {
                diagnostic = diagnostic.navigate(true, NavigateAction::to_activity(activity_id));
            } else if let Some(asset_id) = issue.asset_id.clone() {
                diagnostic =
                    diagnostic.navigate(true, NavigateAction::to_asset_activities(asset_id));
            } else {
                diagnostic = diagnostic.navigate(true, NavigateAction::to_activities(None));
            }
            if let Some(account_id) = issue.account_id.clone() {
                diagnostic =
                    diagnostic.fix(false, FixAction::rebuild_account_history(vec![account_id]));
            }
        }
        ValuationIssueReason::IncompleteBasisSnapshot => {
            // Holdings-tracked: there is no transaction; edit the holdings
            // snapshot's cost basis for the asset.
            if let Some(asset_id) = issue.asset_id.clone() {
                diagnostic =
                    diagnostic.navigate(true, NavigateAction::to_asset_snapshots(asset_id));
            }
            if let Some(account_id) = issue.account_id.clone() {
                diagnostic =
                    diagnostic.fix(false, FixAction::rebuild_account_history(vec![account_id]));
            }
        }
    }

    Some(diagnostic)
}

impl Default for DataConsistencyCheck {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl HealthCheck for DataConsistencyCheck {
    fn id(&self) -> &'static str {
        "data_consistency"
    }

    fn category(&self) -> HealthCategory {
        HealthCategory::DataConsistency
    }

    async fn run(&self, _ctx: &HealthContext) -> Result<Vec<HealthIssue>> {
        // The service will call analyze() directly with consistency data
        Ok(Vec::new())
    }
}

/// Computes a data hash for issue identity and change detection.
fn compute_data_hash(record_ids: &[String]) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    let mut sorted_ids = record_ids.to_vec();
    sorted_ids.sort();
    for id in &sorted_ids {
        id.hash(&mut hasher);
    }

    format!("{:x}", hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::health::model::HealthConfig;

    #[test]
    fn test_orphan_activity_account() {
        let check = DataConsistencyCheck::new();
        let ctx = HealthContext::new(HealthConfig::default(), "USD", 100_000.0);

        let issues_data = vec![ConsistencyIssueInfo {
            issue_type: ConsistencyIssueType::OrphanActivityAccount,
            record_id: "act_123".to_string(),
            description: "Activity references deleted account".to_string(),
            account_id: Some("acc_deleted".to_string()),
            asset_id: None,
            first_negative_date: None,
            cash_balance: None,
            total_value_at_date: None,
            account_currency: None,
            activity_date: None,
            asset_symbol: None,
            asset_name: None,
            quantity: None,
            proceeds: None,
            reason: None,
            activity_id: None,
        }];

        let issues = check.analyze(&issues_data, &ctx);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].severity, Severity::Error);
        assert_eq!(issues[0].category, HealthCategory::DataConsistency);
    }

    #[test]
    fn test_negative_position() {
        let check = DataConsistencyCheck::new();
        let ctx = HealthContext::new(HealthConfig::default(), "USD", 100_000.0);

        let issues_data = vec![ConsistencyIssueInfo {
            issue_type: ConsistencyIssueType::NegativePosition,
            record_id: "pos_123".to_string(),
            description: "Position has negative quantity".to_string(),
            account_id: Some("acc_1".to_string()),
            asset_id: Some("SEC:AAPL:XNAS".to_string()),
            first_negative_date: None,
            cash_balance: None,
            total_value_at_date: None,
            account_currency: None,
            activity_date: None,
            asset_symbol: None,
            asset_name: None,
            quantity: None,
            proceeds: None,
            reason: None,
            activity_id: None,
        }];

        let issues = check.analyze(&issues_data, &ctx);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].severity, Severity::Warning);
    }

    #[test]
    fn test_legacy_classification() {
        let check = DataConsistencyCheck::new();
        let ctx = HealthContext::new(HealthConfig::default(), "USD", 100_000.0);

        let issues_data = vec![ConsistencyIssueInfo {
            issue_type: ConsistencyIssueType::LegacyClassification,
            record_id: "SEC:AAPL:XNAS".to_string(),
            description: "Asset has legacy sector data".to_string(),
            account_id: None,
            asset_id: Some("SEC:AAPL:XNAS".to_string()),
            first_negative_date: None,
            cash_balance: None,
            total_value_at_date: None,
            account_currency: None,
            activity_date: None,
            asset_symbol: None,
            asset_name: None,
            quantity: None,
            proceeds: None,
            reason: None,
            activity_id: None,
        }];

        let issues = check.analyze(&issues_data, &ctx);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].severity, Severity::Info);
        // The legacy-classification finding routes to taxonomy settings rather
        // than offering the old unimplemented per-asset classification fix action;
        // the working migration lives on the ClassificationCheck finding.
        assert!(issues[0].fix_action.is_none());
        assert!(issues[0].navigate_action.is_some());
    }

    #[test]
    fn test_multiple_issue_types() {
        let check = DataConsistencyCheck::new();
        let ctx = HealthContext::new(HealthConfig::default(), "USD", 100_000.0);

        let issues_data = vec![
            ConsistencyIssueInfo {
                issue_type: ConsistencyIssueType::OrphanActivityAccount,
                record_id: "act_1".to_string(),
                description: "Orphan 1".to_string(),
                account_id: None,
                asset_id: None,
                first_negative_date: None,
                cash_balance: None,
                total_value_at_date: None,
                account_currency: None,
                activity_date: None,
                asset_symbol: None,
                asset_name: None,
                quantity: None,
                proceeds: None,
                reason: None,
                activity_id: None,
            },
            ConsistencyIssueInfo {
                issue_type: ConsistencyIssueType::OrphanActivityAccount,
                record_id: "act_2".to_string(),
                description: "Orphan 2".to_string(),
                account_id: None,
                asset_id: None,
                first_negative_date: None,
                cash_balance: None,
                total_value_at_date: None,
                account_currency: None,
                activity_date: None,
                asset_symbol: None,
                asset_name: None,
                quantity: None,
                proceeds: None,
                reason: None,
                activity_id: None,
            },
            ConsistencyIssueInfo {
                issue_type: ConsistencyIssueType::NegativePosition,
                record_id: "pos_1".to_string(),
                description: "Negative".to_string(),
                account_id: None,
                asset_id: None,
                first_negative_date: None,
                cash_balance: None,
                total_value_at_date: None,
                account_currency: None,
                activity_date: None,
                asset_symbol: None,
                asset_name: None,
                quantity: None,
                proceeds: None,
                reason: None,
                activity_id: None,
            },
        ];

        let issues = check.analyze(&issues_data, &ctx);
        // Should have 2 issues: one for orphan accounts (2 records), one for negative (1 record)
        assert_eq!(issues.len(), 2);
    }

    #[test]
    fn test_negative_account_balance() {
        let check = DataConsistencyCheck::new();
        let ctx = HealthContext::new(HealthConfig::default(), "USD", 100_000.0);

        let issues_data = vec![ConsistencyIssueInfo {
            issue_type: ConsistencyIssueType::NegativeAccountBalance,
            record_id: "acc_123".to_string(),
            description: "My Account".to_string(),
            account_id: Some("acc_123".to_string()),
            asset_id: None,
            first_negative_date: Some(chrono::NaiveDate::from_ymd_opt(2025, 1, 10).unwrap()),
            cash_balance: Some(rust_decimal_macros::dec!(-50.20)),
            total_value_at_date: Some(rust_decimal_macros::dec!(-50.20)),
            account_currency: Some("EUR".to_string()),
            activity_date: None,
            asset_symbol: None,
            asset_name: None,
            quantity: None,
            proceeds: None,
            reason: None,
            activity_id: None,
        }];

        let issues = check.analyze(&issues_data, &ctx);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].severity, Severity::Warning);
        assert_eq!(issues[0].category, HealthCategory::DataConsistency);
        assert!(issues[0].navigate_action.is_some());
    }

    #[test]
    fn test_missing_lot_disposal_for_sell() {
        let check = DataConsistencyCheck::new();
        let ctx = HealthContext::new(HealthConfig::default(), "USD", 100_000.0);

        let issues_data = vec![ConsistencyIssueInfo {
            issue_type: ConsistencyIssueType::MissingLotDisposalForSell,
            record_id: "sell-aapl".to_string(),
            description: "Business Investment".to_string(),
            account_id: Some("business".to_string()),
            asset_id: Some("aapl".to_string()),
            first_negative_date: None,
            cash_balance: None,
            total_value_at_date: None,
            account_currency: Some("USD".to_string()),
            activity_date: Some(chrono::NaiveDate::from_ymd_opt(2026, 6, 1).unwrap()),
            asset_symbol: Some("AAPL".to_string()),
            asset_name: Some("Apple Inc.".to_string()),
            quantity: Some(rust_decimal_macros::dec!(1)),
            proceeds: Some(rust_decimal_macros::dec!(291.10598755)),
            reason: None,
            activity_id: None,
        }];

        let issues = check.analyze(&issues_data, &ctx);

        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].severity, Severity::Warning);
        assert_eq!(issues[0].category, HealthCategory::DataConsistency);
        assert_eq!(issues[0].title, "Sale missing cost-basis match");
        assert!(issues[0]
            .message
            .contains("realized gain/loss and performance attribution"));
        assert!(issues[0]
            .details
            .as_deref()
            .is_some_and(|details| details.contains("AAPL on 2026-06-01")));
        let navigate_action = issues[0].navigate_action.as_ref().unwrap();
        assert_eq!(navigate_action.route, "/activities");
        assert_eq!(
            navigate_action
                .query
                .as_ref()
                .and_then(|query| query.get("types")),
            Some(&serde_json::json!("SELL"))
        );
    }

    #[test]
    fn valuation_quality_plural_titles_are_specific() {
        fn valuation_issue(
            issue_type: ConsistencyIssueType,
            record_id: &str,
            reason: Option<ValuationIssueReason>,
        ) -> ConsistencyIssueInfo {
            let is_basis_activity = reason == Some(ValuationIssueReason::IncompleteBasisActivity);
            let activity_date = if record_id.ends_with("-2") {
                chrono::NaiveDate::from_ymd_opt(2026, 6, 2).unwrap()
            } else {
                chrono::NaiveDate::from_ymd_opt(2026, 6, 1).unwrap()
            };
            ConsistencyIssueInfo {
                issue_type,
                record_id: record_id.to_string(),
                description: "TFSA".to_string(),
                account_id: Some("acc_tfsa".to_string()),
                asset_id: is_basis_activity.then(|| "asset_aapl".to_string()),
                first_negative_date: None,
                cash_balance: None,
                total_value_at_date: None,
                account_currency: None,
                activity_date: Some(activity_date),
                asset_symbol: is_basis_activity.then(|| "AAPL".to_string()),
                asset_name: is_basis_activity.then(|| "Apple Inc.".to_string()),
                quantity: None,
                proceeds: None,
                reason,
                activity_id: is_basis_activity.then(|| record_id.to_string()),
            }
        }

        let check = DataConsistencyCheck::new();
        let ctx = HealthContext::new(HealthConfig::default(), "USD", 100_000.0);
        let issues_data = vec![
            valuation_issue(
                ConsistencyIssueType::MissingGeneratedValuation,
                "missing-1",
                None,
            ),
            valuation_issue(
                ConsistencyIssueType::MissingGeneratedValuation,
                "missing-2",
                None,
            ),
            valuation_issue(
                ConsistencyIssueType::IncompleteValuationValue,
                "value-1",
                None,
            ),
            valuation_issue(
                ConsistencyIssueType::IncompleteValuationValue,
                "value-2",
                None,
            ),
            valuation_issue(
                ConsistencyIssueType::IncompleteValuationBasis,
                "basis-1",
                Some(ValuationIssueReason::IncompleteBasisActivity),
            ),
            valuation_issue(
                ConsistencyIssueType::IncompleteValuationBasis,
                "basis-2",
                Some(ValuationIssueReason::IncompleteBasisActivity),
            ),
            valuation_issue(
                ConsistencyIssueType::UnknownPerformanceFlowSource,
                "flow-1",
                None,
            ),
            valuation_issue(
                ConsistencyIssueType::UnknownPerformanceFlowSource,
                "flow-2",
                None,
            ),
        ];

        let issues = check.analyze(&issues_data, &ctx);
        let title_for = |prefix: &str| {
            issues
                .iter()
                .find(|issue| issue.id.starts_with(prefix))
                .map(|issue| issue.title.as_str())
        };

        assert_eq!(
            title_for("missing_generated_valuation:"),
            Some("2 daily account values are missing")
        );
        assert_eq!(
            title_for("incomplete_valuation_value:"),
            Some("2 prices or values are missing")
        );
        assert_eq!(
            title_for("incomplete_valuation_basis:"),
            Some("2 transactions are missing purchase prices")
        );
        assert_eq!(
            title_for("unknown_performance_flow_source:"),
            Some("2 transfer dates need review")
        );

        let unknown_flow_issue = issues
            .iter()
            .find(|issue| issue.id.starts_with("unknown_performance_flow_source:"))
            .expect("unknown flow issue");
        let navigate_query = unknown_flow_issue
            .navigate_action
            .as_ref()
            .and_then(|action| action.query.as_ref())
            .expect("unknown flow activity query");
        assert_eq!(
            navigate_query.get("types"),
            Some(&serde_json::json!("TRANSFER_IN,TRANSFER_OUT"))
        );
        assert!(navigate_query.get("q").is_none());
        assert_eq!(
            navigate_query.get("account"),
            Some(&serde_json::json!("acc_tfsa"))
        );
        assert_eq!(
            navigate_query.get("from"),
            Some(&serde_json::json!("2026-06-01"))
        );
        assert_eq!(
            navigate_query.get("to"),
            Some(&serde_json::json!("2026-06-01"))
        );
        assert_eq!(
            navigate_query.get("healthContext"),
            Some(&serde_json::json!("activity"))
        );
        let transfer_diagnostics = unknown_flow_issue
            .diagnostics
            .as_ref()
            .expect("transfer diagnostics");
        assert_eq!(transfer_diagnostics.len(), 2);
        assert!(transfer_diagnostics
            .iter()
            .all(|diagnostic| diagnostic.code == "TRANSFER_DATE_NEEDS_REVIEW"));
        assert!(transfer_diagnostics.iter().all(|diagnostic| diagnostic
            .evidence
            .iter()
            .any(|evidence| evidence.label == "Transfer")));
        let transfer_dates: Vec<_> = transfer_diagnostics
            .iter()
            .flat_map(|diagnostic| diagnostic.evidence.iter())
            .filter(|evidence| evidence.label == "Date")
            .map(|evidence| evidence.value.as_str())
            .collect();
        assert!(transfer_dates.contains(&"2026-06-01"));
        assert!(transfer_dates.contains(&"2026-06-02"));
        assert!(transfer_diagnostics
            .iter()
            .flat_map(|diagnostic| diagnostic.evidence.iter())
            .filter(|evidence| evidence.label == "Transfer")
            .filter_map(|evidence| evidence.route.as_deref())
            .any(|route| route.contains("from=2026-06-02")));

        let basis_issue = issues
            .iter()
            .find(|issue| issue.id.starts_with("incomplete_valuation_basis:"))
            .expect("basis issue");
        let diagnostic = &basis_issue.diagnostics.as_ref().expect("basis diagnostics")[0];
        assert_eq!(diagnostic.evidence[0].label, "Transaction");
    }

    #[test]
    fn test_no_issues() {
        let check = DataConsistencyCheck::new();
        let ctx = HealthContext::new(HealthConfig::default(), "USD", 100_000.0);

        let issues = check.analyze(&[], &ctx);
        assert!(issues.is_empty());
    }
}
