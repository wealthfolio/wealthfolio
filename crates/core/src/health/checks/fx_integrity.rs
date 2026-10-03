//! FX integrity health check.
//!
//! Detects missing or stale foreign exchange rates.

use async_trait::async_trait;
use chrono::{DateTime, Duration, Utc};

use crate::errors::Result;
use crate::health::model::{
    AffectedItem, DiagnosticDomain, Evidence, HealthCategory, HealthDiagnostic, HealthEntityRef,
    HealthIssue, NavigateAction, Severity,
};
use crate::health::traits::{HealthCheck, HealthContext};

/// Data about a currency pair needed for FX checks.
#[derive(Debug, Clone)]
pub struct FxPairInfo {
    /// Currency pair ID (e.g., "EUR:USD")
    pub pair_id: String,
    /// From currency
    pub from_currency: String,
    /// To currency (base currency)
    pub to_currency: String,
    /// Market value of holdings using this pair (in base currency)
    pub affected_mv: f64,
    /// Latest quote timestamp (None if no quote exists)
    pub latest_quote_time: Option<DateTime<Utc>>,
}

/// A currency pair whose two directions disagree in the stored rates: each
/// direction converts at its own rate, so a conversion and its reverse do
/// not match.
#[derive(Debug, Clone)]
pub struct FxConflictInfo {
    /// Currency pair ID (e.g., "CAD:USD")
    pub pair_id: String,
    pub from_currency: String,
    pub to_currency: String,
    /// Days both directions are recorded and disagree.
    pub days: usize,
    pub first_day: chrono::NaiveDate,
    pub last_day: chrono::NaiveDate,
}

/// Health check that detects missing or stale FX rates.
pub struct FxIntegrityCheck;

impl FxIntegrityCheck {
    /// Creates a new FX integrity check.
    pub fn new() -> Self {
        Self
    }

    /// Analyzes FX pairs for integrity issues.
    pub fn analyze(&self, fx_pairs: &[FxPairInfo], ctx: &HealthContext) -> Vec<HealthIssue> {
        let mut issues = Vec::new();

        if fx_pairs.is_empty() {
            return issues;
        }

        // Calculate thresholds
        let warning_threshold = ctx.now - Duration::hours(ctx.config.fx_stale_warning_hours as i64);
        let critical_threshold =
            ctx.now - Duration::hours(ctx.config.fx_stale_critical_hours as i64);

        // Track issues by type
        let mut missing_pairs: Vec<&FxPairInfo> = Vec::new();
        let mut missing_mv = 0.0;
        let mut stale_warning_pairs: Vec<&FxPairInfo> = Vec::new();
        let mut stale_warning_mv = 0.0;
        let mut stale_error_pairs: Vec<&FxPairInfo> = Vec::new();
        let mut stale_error_mv = 0.0;

        for pair in fx_pairs {
            match pair.latest_quote_time {
                Some(quote_time) => {
                    if quote_time < critical_threshold {
                        stale_error_pairs.push(pair);
                        stale_error_mv += pair.affected_mv;
                    } else if quote_time < warning_threshold {
                        stale_warning_pairs.push(pair);
                        stale_warning_mv += pair.affected_mv;
                    }
                }
                None => {
                    // No rate exists at all
                    missing_pairs.push(pair);
                    missing_mv += pair.affected_mv;
                }
            }
        }

        // Emit issue for missing FX pairs (Error level)
        if !missing_pairs.is_empty() {
            let mv_pct = if ctx.total_portfolio_value > 0.0 {
                missing_mv / ctx.total_portfolio_value
            } else {
                0.0
            };

            let severity = if mv_pct > ctx.config.mv_escalation_threshold {
                Severity::Critical
            } else {
                Severity::Error
            };

            let count = missing_pairs.len();
            let title = if count == 1 {
                format!(
                    "Missing exchange rate for {}",
                    missing_pairs[0].from_currency
                )
            } else {
                format!("Missing exchange rates for {} currencies", count)
            };

            let pair_ids: Vec<String> = missing_pairs.iter().map(|p| p.pair_id.clone()).collect();
            let affected_items: Vec<AffectedItem> = missing_pairs
                .iter()
                .map(|p| {
                    AffectedItem::simple(
                        &p.pair_id,
                        format!("{} → {}", p.from_currency, p.to_currency),
                    )
                })
                .collect();
            let data_hash = compute_data_hash(&pair_ids, severity, mv_pct);

            issues.push(
                HealthIssue::builder()
                    .id(format!("fx_missing:{}", data_hash))
                    .severity(severity)
                    .category(HealthCategory::FxIntegrity)
                    .code("fx_missing")
                    .param("count", count as u32)
                    .param("currency", missing_pairs[0].from_currency.clone())
                    .title(title)
                    .message(
                        "We can't convert some holdings to your base currency. This affects your total portfolio value.",
                    )
                    .affected_count(count as u32)
                    .affected_mv_pct(mv_pct)
                    .diagnostics(vec![fx_diagnostic(
                        &missing_pairs,
                        "MISSING_FX_RATE",
                        "Missing exchange rate",
                        "No exchange rate is on record for these currency pairs, so holdings in \
                         those currencies can't be converted to your base currency.",
                    )])
                    .navigate_action(NavigateAction::to_market_data())
                    .affected_items(affected_items)
                    .data_hash(data_hash)
                    .build(),
            );
        }

        // Emit issue for critically stale FX rates (Error level)
        if !stale_error_pairs.is_empty() {
            let mv_pct = if ctx.total_portfolio_value > 0.0 {
                stale_error_mv / ctx.total_portfolio_value
            } else {
                0.0
            };

            let severity = if mv_pct > ctx.config.mv_escalation_threshold {
                Severity::Critical
            } else {
                Severity::Error
            };

            let count = stale_error_pairs.len();
            let title = if count == 1 {
                "Outdated exchange rate".to_string()
            } else {
                format!("Outdated exchange rates for {} currencies", count)
            };

            let pair_ids: Vec<String> = stale_error_pairs
                .iter()
                .map(|p| p.pair_id.clone())
                .collect();
            let affected_items: Vec<AffectedItem> = stale_error_pairs
                .iter()
                .map(|p| {
                    AffectedItem::simple(
                        &p.pair_id,
                        format!("{} → {}", p.from_currency, p.to_currency),
                    )
                })
                .collect();
            let data_hash = compute_data_hash(&pair_ids, severity, mv_pct);

            issues.push(
                HealthIssue::builder()
                    .id(format!("fx_stale:error:{}", data_hash))
                    .severity(severity)
                    .category(HealthCategory::FxIntegrity)
                    .code("fx_stale_error")
                    .param("count", count as u32)
                    .title(title)
                    .message(
                        "Some exchange rates haven't been updated in over 3 days. Currency conversions may be inaccurate.",
                    )
                    .affected_count(count as u32)
                    .affected_mv_pct(mv_pct)
                    .diagnostics(vec![fx_diagnostic(
                        &stale_error_pairs,
                        "STALE_FX_RATE",
                        "Outdated exchange rate",
                        "These exchange rates are more than 3 days old, so currency conversions \
                         for the affected holdings may be inaccurate.",
                    )])
                    .navigate_action(NavigateAction::to_market_data())
                    .affected_items(affected_items)
                    .data_hash(data_hash)
                    .build(),
            );
        }

        // Emit issue for slightly stale FX rates (Warning level)
        if !stale_warning_pairs.is_empty() {
            let mv_pct = if ctx.total_portfolio_value > 0.0 {
                stale_warning_mv / ctx.total_portfolio_value
            } else {
                0.0
            };

            let severity = if mv_pct > ctx.config.mv_escalation_threshold {
                Severity::Critical
            } else {
                Severity::Warning
            };

            let count = stale_warning_pairs.len();
            let title = if count == 1 {
                "Exchange rate update needed".to_string()
            } else {
                format!("Exchange rate updates needed for {} currencies", count)
            };

            let pair_ids: Vec<String> = stale_warning_pairs
                .iter()
                .map(|p| p.pair_id.clone())
                .collect();
            let affected_items: Vec<AffectedItem> = stale_warning_pairs
                .iter()
                .map(|p| {
                    AffectedItem::simple(
                        &p.pair_id,
                        format!("{} → {}", p.from_currency, p.to_currency),
                    )
                })
                .collect();
            let data_hash = compute_data_hash(&pair_ids, severity, mv_pct);

            issues.push(
                HealthIssue::builder()
                    .id(format!("fx_stale:warning:{}", data_hash))
                    .severity(severity)
                    .category(HealthCategory::FxIntegrity)
                    .code("fx_stale_warning")
                    .param("count", count as u32)
                    .title(title)
                    .message(
                        "Some exchange rates haven't been updated recently. Consider refreshing rates.",
                    )
                    .affected_count(count as u32)
                    .affected_mv_pct(mv_pct)
                    .diagnostics(vec![fx_diagnostic(
                        &stale_warning_pairs,
                        "STALE_FX_RATE",
                        "Exchange rate update needed",
                        "These exchange rates haven't been refreshed recently; conversions for the \
                         affected holdings may drift until they are updated.",
                    )])
                    .navigate_action(NavigateAction::to_market_data())
                    .affected_items(affected_items)
                    .data_hash(data_hash)
                    .build(),
            );
        }

        issues
    }
}

/// Builds a structured diagnostic for an FX issue: one evidence row per pair
/// (pair, rate freshness, affected market value) plus a navigation action to the
/// market-data settings where rates are managed.
impl FxIntegrityCheck {
    /// One issue for every pair whose directions disagree.
    pub fn analyze_conflicts(&self, conflicts: &[FxConflictInfo]) -> Vec<HealthIssue> {
        if conflicts.is_empty() {
            return Vec::new();
        }
        let count = conflicts.len();
        let pair_ids: Vec<String> = conflicts
            .iter()
            .map(|c| format!("{}:{}:{}:{}", c.pair_id, c.days, c.first_day, c.last_day))
            .collect();
        let data_hash = compute_data_hash(&pair_ids, Severity::Warning, 0.0);
        let affected_items: Vec<AffectedItem> = conflicts
            .iter()
            .map(|c| {
                AffectedItem::simple(
                    &c.pair_id,
                    format!(
                        "{} ↔ {} ({} {}, {} to {})",
                        c.from_currency,
                        c.to_currency,
                        c.days,
                        if c.days == 1 { "day" } else { "days" },
                        c.first_day,
                        c.last_day
                    ),
                )
            })
            .collect();
        let first = &conflicts[0];
        vec![HealthIssue::builder()
            .id(format!("fx_conflicting_rates:{}", data_hash))
            .severity(Severity::Warning)
            .category(HealthCategory::FxIntegrity)
            .code("fx_conflicting_rates")
            .param("count", count as u32)
            .param("from", first.from_currency.clone())
            .param("to", first.to_currency.clone())
            .title(if count == 1 {
                format!(
                    "Exchange rates for {} and {} disagree",
                    first.from_currency, first.to_currency
                )
            } else {
                format!("Exchange rates disagree for {count} currency pairs")
            })
            .message(
                "Rates are recorded in both directions for the same days, and they don't match. Each direction is used as recorded, so converting one way and back gives a different amount. Correct or remove the wrong rates.",
            )
            .affected_count(count as u32)
            .affected_items(affected_items)
            .navigate_action(NavigateAction::to_market_data())
            .data_hash(data_hash)
            .build()]
    }
}

fn fx_diagnostic(
    pairs: &[&FxPairInfo],
    code: &str,
    title: &str,
    explanation: &str,
) -> HealthDiagnostic {
    let mut diagnostic =
        HealthDiagnostic::new(code, title, explanation).domain(DiagnosticDomain::Fx);
    for pair in pairs {
        let rate_state = match pair.latest_quote_time {
            Some(ts) => format!("last rate {}", ts.format("%Y-%m-%d")),
            None => "no rate on record".to_string(),
        };
        let label = format!("{} → {}", pair.from_currency, pair.to_currency);
        let value = format!(
            "{rate_state} · affects ~{:.0} in base currency",
            pair.affected_mv
        );
        diagnostic = diagnostic
            .entity(HealthEntityRef::new("currencyPair", pair.pair_id.clone()).label(label.clone()))
            .evidence(Evidence::new(label, value));
    }
    diagnostic.navigate(true, NavigateAction::to_market_data())
}

impl Default for FxIntegrityCheck {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl HealthCheck for FxIntegrityCheck {
    fn id(&self) -> &'static str {
        "fx_integrity"
    }

    fn category(&self) -> HealthCategory {
        HealthCategory::FxIntegrity
    }

    async fn run(&self, _ctx: &HealthContext) -> Result<Vec<HealthIssue>> {
        // The service will call analyze() directly with FX data
        Ok(Vec::new())
    }
}

/// Computes a data hash for issue identity and change detection.
fn compute_data_hash(pair_ids: &[String], severity: Severity, mv_pct: f64) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    let mut sorted_ids = pair_ids.to_vec();
    sorted_ids.sort();
    for id in &sorted_ids {
        id.hash(&mut hasher);
    }
    severity.as_str().hash(&mut hasher);
    ((mv_pct * 100.0) as u32).hash(&mut hasher);

    format!("{:x}", hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::health::model::HealthConfig;

    #[test]
    fn disagreeing_directions_of_a_pair_are_one_warning() {
        let check = FxIntegrityCheck::new();
        let day = |d| chrono::NaiveDate::from_ymd_opt(2025, 1, d).unwrap();
        let conflict = FxConflictInfo {
            pair_id: "CAD:USD".to_string(),
            from_currency: "CAD".to_string(),
            to_currency: "USD".to_string(),
            days: 3,
            first_day: day(2),
            last_day: day(6),
        };
        assert!(check.analyze_conflicts(&[]).is_empty());
        let issues = check.analyze_conflicts(std::slice::from_ref(&conflict));
        assert_eq!(issues.len(), 1);
        let issue = &issues[0];
        assert_eq!(issue.code.as_deref(), Some("fx_conflicting_rates"));
        assert_eq!(issue.severity, Severity::Warning);
        assert_eq!(issue.category, HealthCategory::FxIntegrity);
        assert_eq!(issue.params.get("from"), Some(&serde_json::json!("CAD")));
        let items = issue.affected_items.as_ref().expect("items");
        assert_eq!(
            items[0].name,
            "CAD ↔ USD (3 days, 2025-01-02 to 2025-01-06)"
        );

        // A new conflicting day is a new issue, even after a dismissal.
        let mut later = conflict;
        later.days = 4;
        later.last_day = day(7);
        assert_ne!(
            check.analyze_conflicts(&[later])[0].data_hash,
            issue.data_hash
        );
    }

    #[test]
    fn test_missing_fx_pair() {
        let check = FxIntegrityCheck::new();
        let ctx = HealthContext::new(HealthConfig::default(), "USD", 100_000.0);

        let pairs = vec![FxPairInfo {
            pair_id: "EUR:USD".to_string(),
            from_currency: "EUR".to_string(),
            to_currency: "USD".to_string(),
            affected_mv: 10_000.0,
            latest_quote_time: None,
        }];

        let issues = check.analyze(&pairs, &ctx);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].severity, Severity::Error);
        assert_eq!(issues[0].category, HealthCategory::FxIntegrity);

        // The old unimplemented FX fetch fix action must not be shown; the issue
        // routes to market-data settings and carries a MISSING_FX_RATE diagnostic
        // with per-pair evidence.
        assert!(issues[0].fix_action.is_none());
        assert!(issues[0].navigate_action.is_some());
        let diagnostics = issues[0].diagnostics.as_ref().expect("fx diagnostics");
        assert_eq!(diagnostics[0].code, "MISSING_FX_RATE");
        assert!(diagnostics[0]
            .evidence
            .iter()
            .any(|e| e.label.contains("EUR → USD")));
    }

    #[test]
    fn test_stale_fx_pair() {
        let check = FxIntegrityCheck::new();
        let ctx = HealthContext::new(HealthConfig::default(), "USD", 100_000.0);

        let stale_time = ctx.now - Duration::hours(48);
        let pairs = vec![FxPairInfo {
            pair_id: "EUR:USD".to_string(),
            from_currency: "EUR".to_string(),
            to_currency: "USD".to_string(),
            affected_mv: 10_000.0,
            latest_quote_time: Some(stale_time),
        }];

        let issues = check.analyze(&pairs, &ctx);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].severity, Severity::Warning);
    }

    #[test]
    fn test_fresh_fx_pair_no_issues() {
        let check = FxIntegrityCheck::new();
        let ctx = HealthContext::new(HealthConfig::default(), "USD", 100_000.0);

        let fresh_time = ctx.now - Duration::hours(1);
        let pairs = vec![FxPairInfo {
            pair_id: "EUR:USD".to_string(),
            from_currency: "EUR".to_string(),
            to_currency: "USD".to_string(),
            affected_mv: 10_000.0,
            latest_quote_time: Some(fresh_time),
        }];

        let issues = check.analyze(&pairs, &ctx);
        assert!(issues.is_empty());
    }
}
