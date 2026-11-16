//! Option expiry health check.
//!
//! Lists option expiries recorded against the contract's underlying stock.
//! The engine books an expiry only against an option contract, so these
//! change nothing: the contract stays open and its gain or loss is never realized.
//! Where exactly one contract fits, the issue offers to move the expiry onto
//! it; otherwise each row links to the transaction to edit.

use async_trait::async_trait;

use crate::errors::Result;
use crate::health::fixes::{NoContractReason, OptionExpiryWithoutContractInfo};
use crate::health::model::{
    AffectedItem, DiagnosticDomain, Evidence, FixAction, HealthCategory, HealthDiagnostic,
    HealthEntityRef, HealthIssue, NavigateAction, Severity,
};
use crate::health::traits::{HealthCheck, HealthContext};

/// Health check for option expiries that name a stock, not a contract.
pub struct OptionExpiryCheck;

impl OptionExpiryCheck {
    pub fn new() -> Self {
        Self
    }

    /// One issue listing every such expiry, with the contract it would move to.
    /// `timezone` is the one the expiries were matched in.
    pub fn analyze(
        &self,
        expiries: &[OptionExpiryWithoutContractInfo],
        timezone: Option<&str>,
    ) -> Vec<HealthIssue> {
        if expiries.is_empty() {
            return Vec::new();
        }
        let count = expiries.len();
        let title = if count == 1 {
            "Option expiry is not linked to its contract".to_string()
        } else {
            format!("{count} option expiries are not linked to their contracts")
        };
        let message = "These option expiries name the underlying stock instead of the option contract, so the contract stays open and its gain or loss is not recorded. Link each expiry to the contract that expired.";

        let matched: Vec<String> = expiries
            .iter()
            .filter(|expiry| expiry.contract.is_some())
            .map(|expiry| expiry.activity_id.clone())
            .collect();
        let mut diagnostic =
            HealthDiagnostic::new(
                "OPTION_EXPIRY_WITHOUT_CONTRACT",
                "Expiries to link",
                "Each row shows the contract the expiry moves to and the units it ends. Open a row without one to choose the contract yourself.",
            )
                .domain(DiagnosticDomain::Ledger)
                .severity(Severity::Error);
        diagnostic = if matched.is_empty() {
            diagnostic.navigate(true, NavigateAction::to_activity(&expiries[0].activity_id))
        } else {
            diagnostic.fix(
                true,
                FixAction::match_option_expiry_contracts(matched, timezone),
            )
        };
        let affected_items: Vec<AffectedItem> = expiries
            .iter()
            .map(|expiry| AffectedItem::activity(expiry.activity_id.clone(), describe(expiry)))
            .collect();
        for (expiry, item) in expiries.iter().zip(&affected_items) {
            diagnostic = diagnostic.entity(HealthEntityRef::new("activity", &expiry.activity_id));
            let evidence = Evidence::new("Transaction", item.name.clone());
            diagnostic = diagnostic.evidence(match &item.route {
                Some(route) => evidence.with_route(route.clone()),
                None => evidence,
            });
        }

        vec![HealthIssue::builder()
            .id("option_expiry_without_contract")
            .severity(Severity::Error)
            .category(HealthCategory::DataConsistency)
            .code("option_expiry_without_contract")
            .param("count", count as u32)
            .title(title)
            .message(message)
            .affected_count(count as u32)
            .affected_items(affected_items)
            .diagnostics(vec![diagnostic])
            .build()]
    }
}

impl Default for OptionExpiryCheck {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl HealthCheck for OptionExpiryCheck {
    fn id(&self) -> &'static str {
        "option_expiry"
    }

    fn category(&self) -> HealthCategory {
        HealthCategory::DataConsistency
    }

    async fn run(&self, _ctx: &HealthContext) -> Result<Vec<HealthIssue>> {
        // The service calls analyze() directly with pre-gathered expiries.
        Ok(Vec::new())
    }
}

/// "RGLD · Jul 17, 2026 · WS - FHSA → RGLD260717C00195000 × 2", or the
/// count of contracts that fit when none or several do.
fn describe(expiry: &OptionExpiryWithoutContractInfo) -> String {
    let base = format!(
        "{} · {} · {}",
        expiry.stock_symbol,
        expiry.date.format("%b %-d, %Y"),
        expiry.account_name
    );
    let reason = match (&expiry.contract, expiry.no_contract) {
        (Some(contract), _) => {
            return format!(
                "{base} → {} × {}",
                contract.symbol,
                contract.quantity.normalize()
            )
        }
        (None, Some(NoContractReason::Several)) => "several contracts fit",
        (None, Some(NoContractReason::Shared)) => "another expiry names the same contract",
        (None, Some(NoContractReason::TradedAfterExpiry)) => {
            "the contract was traded after this expiry that day"
        }
        (None, Some(NoContractReason::NoneHeld) | None) => "no open contract found",
    };
    format!("{base} · {reason}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::health::fixes::ExpiryContract;
    use crate::health::model::ActionRef;
    use chrono::NaiveDate;
    use rust_decimal::Decimal;

    fn expiry(
        id: &str,
        contract: Option<&str>,
        no_contract: Option<NoContractReason>,
    ) -> OptionExpiryWithoutContractInfo {
        OptionExpiryWithoutContractInfo {
            activity_id: id.to_string(),
            account_id: "acc".to_string(),
            account_name: "FHSA".to_string(),
            date: NaiveDate::from_ymd_opt(2026, 7, 17).unwrap(),
            stock_symbol: "RGLD".to_string(),
            contract: contract.map(|asset_id| ExpiryContract {
                asset_id: asset_id.to_string(),
                symbol: "RGLD260717C00195000".to_string(),
                quantity: Decimal::from(2),
            }),
            no_contract,
        }
    }

    fn fix_of(issue: &HealthIssue) -> Option<FixAction> {
        issue.diagnostics.as_ref()?.iter().find_map(|diagnostic| {
            diagnostic
                .actions
                .iter()
                .find_map(|action| match &action.action {
                    ActionRef::Fix { action } => Some(action.clone()),
                    ActionRef::Navigate { .. } => None,
                })
        })
    }

    #[test]
    fn offers_the_fix_for_matched_expiries_only() {
        let issues = OptionExpiryCheck::new().analyze(
            &[
                expiry("exp-1", Some("rgld-call"), None),
                expiry("exp-2", None, Some(NoContractReason::Several)),
            ],
            Some("America/Toronto"),
        );
        assert_eq!(issues.len(), 1);
        let issue = &issues[0];
        assert_eq!(issue.severity, Severity::Error);
        assert_eq!(issue.affected_count, 2);
        let fix = fix_of(issue).unwrap();
        assert_eq!(fix.id, "match_option_expiry_contracts");
        assert_eq!(
            fix.payload,
            serde_json::json!({ "activityIds": ["exp-1"], "timezone": "America/Toronto" })
        );
        let items = issue.affected_items.as_ref().unwrap();
        assert!(items[0].name.ends_with("→ RGLD260717C00195000 × 2"));
        assert!(items[1].name.ends_with("several contracts fit"));
    }

    #[test]
    fn links_to_the_transaction_when_no_contract_fits() {
        let issues = OptionExpiryCheck::new().analyze(
            &[expiry("exp-1", None, Some(NoContractReason::NoneHeld))],
            None,
        );
        assert!(fix_of(&issues[0]).is_none());
        assert!(issues[0].affected_items.as_ref().unwrap()[0]
            .name
            .ends_with("no open contract found"));
    }

    #[test]
    fn reports_nothing_without_expiries() {
        assert!(OptionExpiryCheck::new().analyze(&[], None).is_empty());
    }
}
