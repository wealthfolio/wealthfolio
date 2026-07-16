//! Transfer integrity health check.
//!
//! Detects transfer groups that don't resolve to a valid pair (e.g. a transfer
//! with only one recorded leg). These can make returns look wrong if the app
//! cannot tell whether money moved between owned accounts or entered/left the
//! portfolio, so we surface them as actionable issues.
//!
//! The internal `group_id` is used only for identity / change-detection and is
//! never shown to the user; the UI sees friendly per-leg transaction details.

use async_trait::async_trait;
use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde_json::json;

use crate::errors::Result;
use crate::health::model::{
    AffectedItem, DiagnosticDomain, Evidence, HealthCategory, HealthDiagnostic, HealthEntityRef,
    HealthIssue, NavigateAction, Severity,
};
use crate::health::traits::{HealthCheck, HealthContext};

/// One leg of an invalid transfer group, with human-readable detail.
#[derive(Debug, Clone)]
pub struct TransferLegDetail {
    pub account_id: String,
    pub account_name: String,
    /// Canonical activity type, e.g. "TRANSFER_IN" / "TRANSFER_OUT".
    pub activity_type: String,
    pub amount: Option<Decimal>,
    pub currency: String,
    pub date: NaiveDate,
}

/// A transfer group that does not resolve to exactly one IN + one OUT leg.
#[derive(Debug, Clone)]
pub struct InvalidTransferGroupInfo {
    /// Internal grouping key — used for identity/change-detection only, never shown to the user.
    pub group_id: String,
    pub legs: Vec<TransferLegDetail>,
}

impl InvalidTransferGroupInfo {
    fn date_range(&self) -> Option<(NaiveDate, NaiveDate)> {
        let mut dates = self.legs.iter().map(|l| l.date);
        let first = dates.next()?;
        Some(dates.fold((first, first), |(min, max), d| (min.min(d), max.max(d))))
    }
}

/// Health check that detects incomplete / invalid transfer groups.
pub struct TransferIntegrityCheck;

impl TransferIntegrityCheck {
    pub fn new() -> Self {
        Self
    }

    /// Builds a single aggregated health issue for all invalid or unreviewed transfer groups.
    pub fn analyze(
        &self,
        groups: &[InvalidTransferGroupInfo],
        _ctx: &HealthContext,
    ) -> Vec<HealthIssue> {
        if groups.is_empty() {
            return Vec::new();
        }

        let count = groups.len();
        let data_hash = compute_data_hash(groups);

        // One affected item per leg, routed to Activities with focused filters.
        // Labels carry the transaction detail; the internal group_id is never exposed.
        let affected_items: Vec<AffectedItem> = groups
            .iter()
            .flat_map(|g| g.legs.iter())
            .map(affected_item_for_leg)
            .collect();

        let details = groups
            .iter()
            .map(format_group_details)
            .collect::<Vec<_>>()
            .join("\n\n");

        // Deeplink: transfers filtered to the affected date window.
        let all_dates: Vec<NaiveDate> = groups
            .iter()
            .flat_map(|g| g.legs.iter().map(|l| l.date))
            .collect();
        let mut query = json!({ "types": "TRANSFER_IN,TRANSFER_OUT", "healthContext": "activity" });
        if let (Some(from), Some(to)) = (all_dates.iter().min(), all_dates.iter().max()) {
            query["from"] = json!(from.format("%Y-%m-%d").to_string());
            query["to"] = json!(to.format("%Y-%m-%d").to_string());
        }
        let navigate = NavigateAction {
            route: "/activities".to_string(),
            query: Some(query),
            label: "Review Transactions".to_string(),
        };

        let title = if count == 1 {
            "Transfer needs matching or confirmation".to_string()
        } else {
            format!("{} transfers need matching or confirmation", count)
        };

        let mut builder = HealthIssue::builder()
            .id(format!("invalid_transfer_group:{}", data_hash))
            .severity(Severity::Error)
            .category(HealthCategory::DataConsistency)
            .code("transfer_incomplete")
            .param("count", count as u32)
            .title(title)
            .message(
                "Some transfers are missing the other side of the move. Match the two transactions if this was between your accounts, or mark the transfer as external if money entered or left your portfolio.",
            )
            .affected_count(count as u32)
            .navigate_action(navigate.clone())
            .diagnostics(vec![transfer_diagnostic(groups, navigate)])
            .data_hash(data_hash);
        if !affected_items.is_empty() {
            builder = builder.affected_items(affected_items);
        }
        if !details.is_empty() {
            builder = builder.details(details);
        }

        vec![builder.build()]
    }
}

fn transfer_diagnostic(
    groups: &[InvalidTransferGroupInfo],
    navigate: NavigateAction,
) -> HealthDiagnostic {
    let mut diagnostic = HealthDiagnostic::new(
        "INVALID_TRANSFER_GROUP",
        "Transfer needs review",
        "This transfer is missing the other side of the move. Match the two transactions if it moved between your accounts, or mark it external if money entered or left your portfolio.",
    )
    .domain(DiagnosticDomain::Ledger)
    .navigate(true, navigate);

    let all_dates: Vec<NaiveDate> = groups
        .iter()
        .flat_map(|group| group.legs.iter().map(|leg| leg.date))
        .collect();
    if let (Some(from), Some(to)) = (all_dates.iter().min(), all_dates.iter().max()) {
        diagnostic = diagnostic.date_range(
            from.format("%Y-%m-%d").to_string(),
            to.format("%Y-%m-%d").to_string(),
        );
    }

    for group in groups {
        diagnostic = diagnostic.entity(HealthEntityRef::new(
            "transferGroup",
            group.group_id.clone(),
        ));
        for leg in &group.legs {
            let item = affected_item_for_leg(leg);
            if let Some(route) = item.route.clone() {
                diagnostic = diagnostic.entity(
                    HealthEntityRef::new(
                        "account",
                        format!("{}:{}", leg.account_id, leg.activity_type),
                    )
                    .label(leg.account_name.clone())
                    .route(route.clone()),
                );
                diagnostic =
                    diagnostic.evidence(Evidence::new("Transaction", item.name).with_route(route));
            } else {
                diagnostic = diagnostic.evidence(Evidence::new("Transaction", item.name));
            }
        }
    }

    diagnostic
}

impl Default for TransferIntegrityCheck {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl HealthCheck for TransferIntegrityCheck {
    fn id(&self) -> &'static str {
        "transfer_integrity"
    }

    fn category(&self) -> HealthCategory {
        HealthCategory::DataConsistency
    }

    async fn run(&self, _ctx: &HealthContext) -> Result<Vec<HealthIssue>> {
        // The service calls analyze() directly with pre-gathered transfer data.
        Ok(Vec::new())
    }
}

fn describe_leg(leg: &TransferLegDetail) -> String {
    let label = match leg.activity_type.as_str() {
        "TRANSFER_IN" => "Transfer In",
        "TRANSFER_OUT" => "Transfer Out",
        other => other,
    };
    let amount = leg
        .amount
        .map(|a| format!("{} {}", a.round_dp(2), leg.currency))
        .unwrap_or_else(|| leg.currency.clone());
    format!(
        "{} · {} · {} · {}",
        label,
        amount,
        leg.date.format("%b %-d, %Y"),
        leg.account_name,
    )
}

fn affected_item_for_leg(leg: &TransferLegDetail) -> AffectedItem {
    let date = leg.date.format("%Y-%m-%d").to_string();
    AffectedItem {
        id: format!(
            "{}:{}:{}:{}:{}",
            leg.account_id,
            leg.activity_type,
            date,
            leg.amount
                .map(|amount| amount.round_dp(2).to_string())
                .unwrap_or_default(),
            leg.currency
        ),
        name: describe_leg(leg),
        symbol: None,
        route: Some(format!(
            "/activities?account={}&from={}&to={}&types={}&healthContext=activity",
            urlencoding::encode(&leg.account_id),
            urlencoding::encode(&date),
            urlencoding::encode(&date),
            urlencoding::encode(&leg.activity_type),
        )),
    }
}

fn format_group_details(group: &InvalidTransferGroupInfo) -> String {
    let when = match group.date_range() {
        Some((from, to)) if from == to => {
            format!("Transfer on {} needs review", from.format("%b %-d, %Y"))
        }
        Some((from, to)) => format!(
            "Transfer between {} and {} needs review",
            from.format("%b %-d, %Y"),
            to.format("%b %-d, %Y")
        ),
        None => "Transfer needs review".to_string(),
    };
    let legs = group
        .legs
        .iter()
        .map(|leg| format!("  • {}", describe_leg(leg)))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "{}:\n{}\n  → Match this with the other side of the transfer, or mark it external if money entered or left your portfolio.",
        when, legs
    )
}

/// Computes a stable data hash over the affected group ids for change detection.
fn compute_data_hash(groups: &[InvalidTransferGroupInfo]) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut ids: Vec<&str> = groups.iter().map(|g| g.group_id.as_str()).collect();
    ids.sort_unstable();

    let mut hasher = DefaultHasher::new();
    for id in ids {
        id.hash(&mut hasher);
    }
    format!("{:x}", hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::health::model::HealthConfig;

    fn leg(account_id: &str, activity_type: &str) -> TransferLegDetail {
        TransferLegDetail {
            account_id: account_id.to_string(),
            account_name: format!("{} Account", account_id),
            activity_type: activity_type.to_string(),
            amount: Some(rust_decimal_macros::dec!(1200.00)),
            currency: "USD".to_string(),
            date: NaiveDate::from_ymd_opt(2026, 6, 2).unwrap(),
        }
    }

    #[test]
    fn no_groups_produces_no_issue() {
        let check = TransferIntegrityCheck::new();
        let ctx = HealthContext::new(HealthConfig::default(), "USD", 100_000.0);
        assert!(check.analyze(&[], &ctx).is_empty());
    }

    #[test]
    fn single_leg_group_produces_error_issue_without_group_id() {
        let check = TransferIntegrityCheck::new();
        let ctx = HealthContext::new(HealthConfig::default(), "USD", 100_000.0);

        let groups = vec![InvalidTransferGroupInfo {
            group_id: "wf-transfer-80RGYWMp5UoNHnwO98ymz".to_string(),
            legs: vec![leg("acc_checking", "TRANSFER_OUT")],
        }];

        let issues = check.analyze(&groups, &ctx);
        assert_eq!(issues.len(), 1);
        let issue = &issues[0];
        assert_eq!(issue.severity, Severity::Error);
        assert_eq!(issue.category, HealthCategory::DataConsistency);
        assert_eq!(issue.affected_count, 1);
        assert!(issue.navigate_action.is_some());

        // The technical group_id must never leak into user-facing text.
        let id = "wf-transfer-80RGYWMp5UoNHnwO98ymz";
        assert!(!issue.title.contains(id));
        assert!(!issue.message.contains(id));
        assert!(!issue.details.as_deref().unwrap_or_default().contains(id));
        assert!(issue
            .affected_items
            .as_ref()
            .unwrap()
            .iter()
            .all(|item| !item.name.contains(id)));
        let item = &issue.affected_items.as_ref().unwrap()[0];
        assert_eq!(
            item.route.as_deref(),
            Some(
                "/activities?account=acc_checking&from=2026-06-02&to=2026-06-02&types=TRANSFER_OUT&healthContext=activity"
            )
        );
        // ...but the issue id (internal) still ties to the data hash for dismissal.
        assert!(issue.id.starts_with("invalid_transfer_group:"));
    }

    #[test]
    fn multiple_groups_aggregate_into_one_issue() {
        let check = TransferIntegrityCheck::new();
        let ctx = HealthContext::new(HealthConfig::default(), "USD", 100_000.0);

        let groups = vec![
            InvalidTransferGroupInfo {
                group_id: "g1".to_string(),
                legs: vec![leg("a1", "TRANSFER_OUT")],
            },
            InvalidTransferGroupInfo {
                group_id: "g2".to_string(),
                legs: vec![leg("a2", "TRANSFER_IN")],
            },
        ];

        let issues = check.analyze(&groups, &ctx);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].affected_count, 2);
        assert!(issues[0].title.contains('2'));
    }
}
