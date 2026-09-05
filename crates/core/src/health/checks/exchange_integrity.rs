//! Exchange integrity health check.
//!
//! Detects in-kind asset exchange groups (EXCHANGE_OUT/EXCHANGE_IN, an
//! ADJUSTMENT subtype pair) that don't resolve to a valid pair — e.g. only one
//! recorded leg. An orphaned leg leaves cost basis stranded (the closed
//! asset's lots are gone but nothing carried the basis to a new asset), so we
//! surface it as an actionable issue.
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

/// One leg of an invalid exchange group, with human-readable detail.
#[derive(Debug, Clone)]
pub struct ExchangeLegDetail {
    pub account_id: String,
    pub account_name: String,
    /// Subtype, e.g. "EXCHANGE_IN" / "EXCHANGE_OUT".
    pub subtype: String,
    pub asset_symbol: Option<String>,
    pub quantity: Option<Decimal>,
    pub date: NaiveDate,
}

/// An exchange group that does not resolve to exactly one IN + one OUT leg.
#[derive(Debug, Clone)]
pub struct InvalidExchangeGroupInfo {
    /// Internal grouping key — used for identity/change-detection only, never shown to the user.
    pub group_id: String,
    pub legs: Vec<ExchangeLegDetail>,
}

impl InvalidExchangeGroupInfo {
    fn date_range(&self) -> Option<(NaiveDate, NaiveDate)> {
        let mut dates = self.legs.iter().map(|l| l.date);
        let first = dates.next()?;
        Some(dates.fold((first, first), |(min, max), d| (min.min(d), max.max(d))))
    }
}

/// Health check that detects incomplete / invalid exchange groups.
pub struct ExchangeIntegrityCheck;

impl ExchangeIntegrityCheck {
    pub fn new() -> Self {
        Self
    }

    /// Builds a single aggregated health issue for all invalid exchange groups.
    pub fn analyze(
        &self,
        groups: &[InvalidExchangeGroupInfo],
        _ctx: &HealthContext,
    ) -> Vec<HealthIssue> {
        if groups.is_empty() {
            return Vec::new();
        }

        let count = groups.len();
        let data_hash = compute_data_hash(groups);

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

        let all_dates: Vec<NaiveDate> = groups
            .iter()
            .flat_map(|g| g.legs.iter().map(|l| l.date))
            .collect();
        let mut query = json!({ "types": "ADJUSTMENT", "healthContext": "activity" });
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
            "Exchange needs matching or confirmation".to_string()
        } else {
            format!("{} exchanges need matching or confirmation", count)
        };

        let mut builder = HealthIssue::builder()
            .id(format!("invalid_exchange_group:{}", data_hash))
            .severity(Severity::Error)
            .category(HealthCategory::DataConsistency)
            .code("exchange_incomplete")
            .param("count", count as u32)
            .title(title)
            .message(
                "Some asset exchanges are missing the other side of the switch. Match the two transactions so cost basis carries over correctly.",
            )
            .affected_count(count as u32)
            .navigate_action(navigate.clone())
            .diagnostics(vec![exchange_diagnostic(groups, navigate)])
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

fn exchange_diagnostic(
    groups: &[InvalidExchangeGroupInfo],
    navigate: NavigateAction,
) -> HealthDiagnostic {
    let mut diagnostic = HealthDiagnostic::new(
        "INVALID_EXCHANGE_GROUP",
        "Exchange needs review",
        "This asset exchange is missing the other side of the switch. Match the two transactions so cost basis carries over correctly.",
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
            "exchangeGroup",
            group.group_id.clone(),
        ));
        for leg in &group.legs {
            let item = affected_item_for_leg(leg);
            if let Some(route) = item.route.clone() {
                diagnostic = diagnostic.entity(
                    HealthEntityRef::new("account", format!("{}:{}", leg.account_id, leg.subtype))
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

impl Default for ExchangeIntegrityCheck {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl HealthCheck for ExchangeIntegrityCheck {
    fn id(&self) -> &'static str {
        "exchange_integrity"
    }

    fn category(&self) -> HealthCategory {
        HealthCategory::DataConsistency
    }

    async fn run(&self, _ctx: &HealthContext) -> Result<Vec<HealthIssue>> {
        // The service calls analyze() directly with pre-gathered exchange data.
        Ok(Vec::new())
    }
}

fn describe_leg(leg: &ExchangeLegDetail) -> String {
    let label = match leg.subtype.as_str() {
        "EXCHANGE_IN" => "Exchange In",
        "EXCHANGE_OUT" => "Exchange Out",
        other => other,
    };
    let asset = leg.asset_symbol.clone().unwrap_or_else(|| "—".to_string());
    let quantity = leg
        .quantity
        .map(|q| q.round_dp(4).to_string())
        .unwrap_or_else(|| "—".to_string());
    format!(
        "{} · {} {} · {} · {}",
        label,
        quantity,
        asset,
        leg.date.format("%b %-d, %Y"),
        leg.account_name,
    )
}

fn affected_item_for_leg(leg: &ExchangeLegDetail) -> AffectedItem {
    let date = leg.date.format("%Y-%m-%d").to_string();
    AffectedItem {
        id: format!(
            "{}:{}:{}:{}",
            leg.account_id,
            leg.subtype,
            date,
            leg.asset_symbol.as_deref().unwrap_or_default()
        ),
        name: describe_leg(leg),
        symbol: leg.asset_symbol.clone(),
        route: Some(format!(
            "/activities?account={}&from={}&to={}&types=ADJUSTMENT&healthContext=activity",
            urlencoding::encode(&leg.account_id),
            urlencoding::encode(&date),
            urlencoding::encode(&date),
        )),
    }
}

fn format_group_details(group: &InvalidExchangeGroupInfo) -> String {
    let when = match group.date_range() {
        Some((from, to)) if from == to => {
            format!("Exchange on {} needs review", from.format("%b %-d, %Y"))
        }
        Some((from, to)) => format!(
            "Exchange between {} and {} needs review",
            from.format("%b %-d, %Y"),
            to.format("%b %-d, %Y")
        ),
        None => "Exchange needs review".to_string(),
    };
    let legs = group
        .legs
        .iter()
        .map(|leg| format!("  • {}", describe_leg(leg)))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "{}:\n{}\n  → Match this with the other side of the exchange so cost basis carries over correctly.",
        when, legs
    )
}

/// Computes a stable data hash over the affected group ids for change detection.
fn compute_data_hash(groups: &[InvalidExchangeGroupInfo]) -> String {
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

    fn leg(account_id: &str, subtype: &str) -> ExchangeLegDetail {
        ExchangeLegDetail {
            account_id: account_id.to_string(),
            account_name: format!("{} Account", account_id),
            subtype: subtype.to_string(),
            asset_symbol: Some("FUND_A".to_string()),
            quantity: Some(rust_decimal_macros::dec!(10)),
            date: NaiveDate::from_ymd_opt(2026, 6, 2).unwrap(),
        }
    }

    #[test]
    fn no_groups_produces_no_issue() {
        let check = ExchangeIntegrityCheck::new();
        let ctx = HealthContext::new(HealthConfig::default(), "USD", 100_000.0);
        assert!(check.analyze(&[], &ctx).is_empty());
    }

    #[test]
    fn single_leg_group_produces_error_issue_without_group_id() {
        let check = ExchangeIntegrityCheck::new();
        let ctx = HealthContext::new(HealthConfig::default(), "USD", 100_000.0);

        let groups = vec![InvalidExchangeGroupInfo {
            group_id: "wf-exchange-80RGYWMp5UoNHnwO98ymz".to_string(),
            legs: vec![leg("acc_broker", "EXCHANGE_OUT")],
        }];

        let issues = check.analyze(&groups, &ctx);
        assert_eq!(issues.len(), 1);
        let issue = &issues[0];
        assert_eq!(issue.severity, Severity::Error);
        assert_eq!(issue.category, HealthCategory::DataConsistency);
        assert_eq!(issue.affected_count, 1);
        assert!(issue.navigate_action.is_some());

        let id = "wf-exchange-80RGYWMp5UoNHnwO98ymz";
        assert!(!issue.title.contains(id));
        assert!(!issue.message.contains(id));
        assert!(issue.id.starts_with("invalid_exchange_group:"));
    }

    #[test]
    fn multiple_groups_aggregate_into_one_issue() {
        let check = ExchangeIntegrityCheck::new();
        let ctx = HealthContext::new(HealthConfig::default(), "USD", 100_000.0);

        let groups = vec![
            InvalidExchangeGroupInfo {
                group_id: "g1".to_string(),
                legs: vec![leg("a1", "EXCHANGE_OUT")],
            },
            InvalidExchangeGroupInfo {
                group_id: "g2".to_string(),
                legs: vec![leg("a2", "EXCHANGE_IN")],
            },
        ];

        let issues = check.analyze(&groups, &ctx);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].affected_count, 2);
        assert!(issues[0].title.contains('2'));
    }
}
