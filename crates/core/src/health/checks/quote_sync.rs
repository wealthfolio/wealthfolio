//! Quote sync error health check.
//!
//! Detects assets that are consistently failing to sync quotes.

use async_trait::async_trait;
use std::collections::{HashMap, HashSet};

use crate::assets::{Asset, AssetServiceTrait, QuoteMode};
use crate::errors::Result;
use crate::fx::FxServiceTrait;
use crate::health::model::{
    AffectedItem, DiagnosticDomain, Evidence, FixAction, HealthCategory, HealthDiagnostic,
    HealthEntityRef, HealthIssue, NavigateAction, Severity,
};
use crate::health::traits::{HealthCheck, HealthContext};
use crate::portfolio::coordinator::fx_pair_of;
use crate::quotes::QuoteServiceTrait;

/// Data about an asset with sync errors.
#[derive(Debug, Clone)]
pub struct QuoteSyncErrorInfo {
    /// Asset ID
    pub asset_id: String,
    /// Symbol for display
    pub symbol: String,
    /// Number of consecutive sync failures
    pub error_count: i32,
    /// Last error message
    pub last_error: Option<String>,
    /// Market value in base currency (if held)
    pub market_value: f64,
    /// Whether this asset has ever synced successfully (has any quotes)
    pub has_synced_before: bool,
}

/// Gathers quote sync errors from the sync state.
///
/// Returns a list of assets that have sync errors, along with their symbols and market values.
///
/// # Arguments
/// * `quote_service` - The quote service for accessing sync state
/// * `asset_service` - The asset service for looking up asset symbols
/// * `holding_market_values` - Map of asset_id -> market_value from current holdings
/// * `latest_quote_times` - Map of asset_id -> last quote timestamp (to detect never-synced assets)
/// * `fx_service` - When given, FX pairs it converts without a quote of their own are left out
pub fn gather_quote_sync_errors(
    quote_service: &dyn QuoteServiceTrait,
    asset_service: &dyn AssetServiceTrait,
    holding_market_values: &HashMap<String, f64>,
    latest_quote_times: &HashMap<String, chrono::DateTime<chrono::Utc>>,
    fx_service: Option<&dyn FxServiceTrait>,
) -> Vec<QuoteSyncErrorInfo> {
    // Get sync states with errors
    let sync_states_with_errors = match quote_service.get_sync_states_with_errors() {
        Ok(states) => states,
        Err(_) => return Vec::new(),
    };

    if sync_states_with_errors.is_empty() {
        return Vec::new();
    }

    // Get asset IDs that have errors
    let asset_ids_set: HashSet<String> = sync_states_with_errors
        .iter()
        .map(|s| s.asset_id.clone())
        .collect();

    // Get all assets and filter to those with errors
    let all_assets = match asset_service.get_assets() {
        Ok(assets) => assets,
        Err(_) => return Vec::new(),
    };

    let failing_assets: Vec<Asset> = all_assets
        .into_iter()
        .filter(|a| asset_ids_set.contains(&a.id))
        .collect();

    let converted_fx_ids: HashSet<String> = match fx_service {
        Some(fx_service) => {
            let fx_ids: Vec<String> = failing_assets
                .iter()
                .filter(|a| fx_pair_of(a).is_some())
                .map(|a| a.id.clone())
                .collect();
            let quoted_ids: HashSet<String> = if fx_ids.is_empty() {
                HashSet::new()
            } else {
                match quote_service.get_latest_quotes(&fx_ids) {
                    Ok(quotes) => quotes.into_keys().collect(),
                    // Unknown quote history: keep reporting the pairs.
                    Err(_) => fx_ids.into_iter().collect(),
                }
            };
            fx_pairs_converted_without_quotes(&failing_assets, &quoted_ids, |from, to| {
                fx_service.get_latest_exchange_rate(from, to).is_ok()
            })
        }
        None => HashSet::new(),
    };

    // Build a map of asset_id -> (symbol, quote_mode)
    let asset_map: HashMap<String, (String, QuoteMode)> = failing_assets
        .into_iter()
        .map(|a| {
            (
                a.id.clone(),
                (a.display_code.clone().unwrap_or_default(), a.quote_mode),
            )
        })
        .collect();

    // Convert to QuoteSyncErrorInfo, filtering out manual pricing assets
    sync_states_with_errors
        .into_iter()
        .filter_map(|s| {
            let (symbol, quote_mode) = asset_map
                .get(&s.asset_id)
                .cloned()
                .unwrap_or_else(|| (s.asset_id.clone(), QuoteMode::Market));

            // Skip assets with manual pricing - they don't need quote syncing
            if quote_mode == QuoteMode::Manual {
                return None;
            }
            // Skip FX pairs that convert through other rates without a quote of their own
            if converted_fx_ids.contains(&s.asset_id) {
                return None;
            }

            let market_value = holding_market_values
                .get(&s.asset_id)
                .copied()
                .unwrap_or(0.0);
            // Asset has synced before if it has any quotes
            let has_synced_before = latest_quote_times.contains_key(&s.asset_id);

            Some(QuoteSyncErrorInfo {
                asset_id: s.asset_id,
                symbol,
                error_count: s.error_count,
                last_error: s.last_error,
                market_value,
                has_synced_before,
            })
        })
        .collect()
}

/// IDs of the FX pairs among `assets` that have never returned a quote of
/// their own, yet `converts(from, to)` still finds a rate for them through
/// other stored pairs. Providers do not quote every cross (Yahoo has no
/// `AEDCOP=X`); once the pivot legs through USD have rates, the direct pair's
/// failures no longer leave any conversion without a rate, so they are not a
/// data problem. A pair that returned quotes before stays reported: its
/// failure may leave the converter on an old direct rate.
fn fx_pairs_converted_without_quotes(
    assets: &[Asset],
    quoted_ids: &HashSet<String>,
    converts: impl Fn(&str, &str) -> bool,
) -> HashSet<String> {
    assets
        .iter()
        .filter(|a| !quoted_ids.contains(&a.id))
        .filter_map(|a| fx_pair_of(a).map(|(from, to)| (a, from, to)))
        .filter(|(_, from, to)| converts(from, to))
        .map(|(a, _, _)| a.id.clone())
        .collect()
}

/// Health check that detects quote sync failures.
///
/// This check identifies assets that have repeated sync errors,
/// which may indicate provider issues, invalid symbols, or network problems.
pub struct QuoteSyncCheck;

impl QuoteSyncCheck {
    /// Creates a new quote sync check.
    pub fn new() -> Self {
        Self
    }

    /// Analyzes sync states for recurring errors.
    ///
    /// This is the core logic, exposed for testing and direct use.
    pub fn analyze(
        &self,
        sync_errors: &[QuoteSyncErrorInfo],
        ctx: &HealthContext,
    ) -> Vec<HealthIssue> {
        let mut issues = Vec::new();

        if sync_errors.is_empty() {
            return issues;
        }

        // Categorize by error count severity:
        //   1-5 failures: warning (visible immediately so health center
        //     matches the toast notification the user just saw)
        //   6+ failures: error (persistent issue)
        let warning_threshold = 1;
        let error_threshold = 6;

        let warning_errors: Vec<_> = sync_errors
            .iter()
            .filter(|e| e.error_count >= warning_threshold && e.error_count < error_threshold)
            .collect();

        let persistent_errors: Vec<_> = sync_errors
            .iter()
            .filter(|e| e.error_count >= error_threshold)
            .collect();

        // Calculate market value impact
        let warning_mv: f64 = warning_errors.iter().map(|e| e.market_value).sum();
        let error_mv: f64 = persistent_errors.iter().map(|e| e.market_value).sum();

        // Emit error-level issue for persistent sync failures
        if !persistent_errors.is_empty() {
            let mv_pct = ctx.affected_mv_pct(error_mv);

            // Escalate to Critical if MV% exceeds threshold
            let severity = if mv_pct.is_some_and(|pct| pct > ctx.config.mv_escalation_threshold) {
                Severity::Critical
            } else {
                Severity::Error
            };

            let count = persistent_errors.len();
            let title = if count == 1 {
                format!("Quotes sync failing for {}", persistent_errors[0].symbol)
            } else {
                format!("Quotes sync failing for {} assets", count)
            };

            // Build details with error messages
            let details = build_error_details(&persistent_errors);
            let asset_ids: Vec<String> = persistent_errors
                .iter()
                .map(|e| e.asset_id.clone())
                .collect();
            let affected_items: Vec<AffectedItem> = persistent_errors
                .iter()
                .map(|e| AffectedItem::asset(&e.asset_id, &e.symbol))
                .collect();
            let data_hash = compute_data_hash(&asset_ids, severity);

            issues.push(
                HealthIssue::builder()
                    .id(format!("quote_sync:error:{}", data_hash))
                    .severity(severity)
                    .category(HealthCategory::PriceStaleness)
                    .code("quote_sync_error")
                    .param("count", count as u32)
                    .param("symbol", persistent_errors[0].symbol.clone())
                    .title(title)
                    .message(
                        "These assets have repeatedly failed to sync prices. Check the symbols or data provider settings.",
                    )
                    .affected_count(count as u32)
                    .affected_mv_pct(mv_pct)
                    .affected_items(affected_items)
                    .fix_action(FixAction::retry_sync(asset_ids))
                    .navigate_action(NavigateAction::to_market_data())
                    .diagnostics(vec![quote_sync_diagnostic(&persistent_errors)])
                    .details(details)
                    .data_hash(data_hash)
                    .build(),
            );
        }

        // Emit warning-level issue for recent sync failures
        if !warning_errors.is_empty() {
            let mv_pct = ctx.affected_mv_pct(warning_mv);

            let count = warning_errors.len();
            let title = if count == 1 {
                format!("Sync issues for {}", warning_errors[0].symbol)
            } else {
                format!("Sync issues for {} assets", count)
            };

            let details = build_error_details(&warning_errors);
            let asset_ids: Vec<String> =
                warning_errors.iter().map(|e| e.asset_id.clone()).collect();
            let affected_items: Vec<AffectedItem> = warning_errors
                .iter()
                .map(|e| AffectedItem::asset(&e.asset_id, &e.symbol))
                .collect();
            let data_hash = compute_data_hash(&asset_ids, Severity::Warning);

            issues.push(
                HealthIssue::builder()
                    .id(format!("quote_sync:warning:{}", data_hash))
                    .severity(Severity::Warning)
                    .category(HealthCategory::PriceStaleness)
                    .code("quote_sync_warning")
                    .param("count", count as u32)
                    .param("symbol", warning_errors[0].symbol.clone())
                    .title(title)
                    .message(
                        "Some assets are having trouble syncing prices. This may resolve automatically.",
                    )
                    .affected_count(count as u32)
                    .affected_mv_pct(mv_pct)
                    .affected_items(affected_items)
                    .fix_action(FixAction::retry_sync(asset_ids))
                    .diagnostics(vec![quote_sync_diagnostic(&warning_errors)])
                    .details(details)
                    .data_hash(data_hash)
                    .build(),
            );
        }

        issues
    }
}

/// Builds a diagnostic for a group of quote-sync failures. Assets that have
/// never returned a quote are classified as a symbol/provider problem
/// (`INVALID_SYMBOL_OR_PROVIDER`); assets that synced before are a transient/
/// provider sync failure (`QUOTE_SYNC_FAILED`). Evidence carries the failure
/// count and (truncated) last provider error.
fn quote_sync_diagnostic(errors: &[&QuoteSyncErrorInfo]) -> HealthDiagnostic {
    let never_synced = errors.iter().all(|e| !e.has_synced_before);
    let (code, title, explanation) = if never_synced {
        (
            "INVALID_SYMBOL_OR_PROVIDER",
            "Symbol or provider problem",
            "These assets have never returned a quote, which usually means the symbol is \
             unresolved or the configured data provider can't price them. Check the symbol and \
             provider in Market Data settings.",
        )
    } else {
        (
            "QUOTE_SYNC_FAILED",
            "Price sync failing",
            "These assets have repeatedly failed to sync a quote. This may be a temporary \
             provider issue, or the symbol/provider may need correcting.",
        )
    };

    let mut diagnostic =
        HealthDiagnostic::new(code, title, explanation).domain(DiagnosticDomain::MarketData);
    for error in errors {
        let asset_route = format!(
            "/holdings/{}?tab=quotes&healthContext=price",
            urlencoding::encode(&error.asset_id)
        );
        let last_error = error
            .last_error
            .as_deref()
            .map(|message| {
                let truncated: String = message.chars().take(80).collect();
                format!(" — {truncated}")
            })
            .unwrap_or_default();
        let value = format!("{} failure(s){}", error.error_count, last_error);
        diagnostic = diagnostic
            .entity(
                HealthEntityRef::new("asset", error.asset_id.clone())
                    .label(error.symbol.clone())
                    .route(asset_route.clone()),
            )
            .evidence(Evidence::new(error.symbol.clone(), value).with_route(asset_route));
    }

    let asset_ids: Vec<String> = errors.iter().map(|e| e.asset_id.clone()).collect();
    diagnostic
        .fix(true, FixAction::retry_sync(asset_ids))
        .navigate(false, NavigateAction::to_market_data())
}

impl Default for QuoteSyncCheck {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl HealthCheck for QuoteSyncCheck {
    fn id(&self) -> &'static str {
        "quote_sync"
    }

    fn category(&self) -> HealthCategory {
        HealthCategory::PriceStaleness
    }

    async fn run(&self, _ctx: &HealthContext) -> Result<Vec<HealthIssue>> {
        // The service will call analyze() directly with the data it gathers
        Ok(Vec::new())
    }
}

/// Builds a details string from error info.
fn build_error_details(errors: &[&QuoteSyncErrorInfo]) -> String {
    let mut lines = Vec::new();
    for (i, error) in errors.iter().take(5).enumerate() {
        let error_msg = error.last_error.as_deref().unwrap_or("Unknown error");
        lines.push(format!(
            "{}. {} - {} failures: {}",
            i + 1,
            error.symbol,
            error.error_count,
            truncate_error(error_msg)
        ));
    }
    if errors.len() > 5 {
        lines.push(format!("... and {} more", errors.len() - 5));
    }
    lines.join("\n")
}

/// Truncates an error message to a reasonable length.
fn truncate_error(msg: &str) -> &str {
    if msg.len() > 80 {
        &msg[..msg.floor_char_boundary(80)]
    } else {
        msg
    }
}

/// Computes a data hash for issue identity and change detection.
fn compute_data_hash(asset_ids: &[String], severity: Severity) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    let mut sorted_ids = asset_ids.to_vec();
    sorted_ids.sort();
    for id in &sorted_ids {
        id.hash(&mut hasher);
    }
    severity.as_str().hash(&mut hasher);

    format!("{:x}", hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assets::AssetKind;
    use crate::health::model::HealthConfig;

    fn fx_asset(id: &str, from: &str, to: &str) -> Asset {
        Asset {
            id: id.to_string(),
            kind: AssetKind::Fx,
            instrument_symbol: Some(from.to_string()),
            quote_ccy: to.to_string(),
            ..Default::default()
        }
    }

    /// Converts COP and AED both ways, as the converter does through
    /// COP/USD and USD/AED, and nothing else.
    fn converts_through_usd(from: &str, to: &str) -> bool {
        matches!((from, to), ("COP", "AED") | ("AED", "COP"))
    }

    fn ids(values: &[&str]) -> HashSet<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    /// Yahoo has no COPAED=X or AEDCOP=X. Once the USD legs have rates the
    /// direct pairs' failures leave no conversion without a rate.
    #[test]
    fn test_unquoted_fx_pairs_that_convert_through_other_rates_are_left_out() {
        let assets = vec![
            fx_asset("fx-cop-aed", "COP", "AED"),
            fx_asset("fx-aed-cop", "AED", "COP"),
        ];

        let left_out =
            fx_pairs_converted_without_quotes(&assets, &HashSet::new(), converts_through_usd);

        assert_eq!(left_out, ids(&["fx-cop-aed", "fx-aed-cop"]));
    }

    #[test]
    fn test_unquoted_fx_pair_without_any_conversion_stays_reported() {
        let assets = vec![fx_asset("fx-xof-aed", "XOF", "AED")];

        let left_out =
            fx_pairs_converted_without_quotes(&assets, &HashSet::new(), converts_through_usd);

        assert!(left_out.is_empty());
    }

    /// A pair that returned quotes before may leave the converter on its old
    /// direct rate, so its failures still matter.
    #[test]
    fn test_fx_pair_that_returned_quotes_before_stays_reported() {
        let assets = vec![fx_asset("fx-cop-aed", "COP", "AED")];

        let left_out =
            fx_pairs_converted_without_quotes(&assets, &ids(&["fx-cop-aed"]), converts_through_usd);

        assert!(left_out.is_empty());
    }

    #[test]
    fn test_non_fx_asset_stays_reported() {
        let assets = vec![Asset {
            id: "sec-badsym".to_string(),
            kind: AssetKind::Investment,
            instrument_symbol: Some("COP".to_string()),
            quote_ccy: "AED".to_string(),
            ..Default::default()
        }];

        let left_out = fx_pairs_converted_without_quotes(&assets, &HashSet::new(), |_, _| true);

        assert!(left_out.is_empty());
    }

    #[test]
    fn test_no_errors_no_issues() {
        let check = QuoteSyncCheck::new();
        let ctx = HealthContext::new(HealthConfig::default(), "USD", 100_000.0);

        let issues = check.analyze(&[], &ctx);
        assert!(issues.is_empty());
    }

    #[test]
    fn test_low_error_count_shows_warning() {
        let check = QuoteSyncCheck::new();
        let ctx = HealthContext::new(HealthConfig::default(), "USD", 100_000.0);

        // 2 failures - should show as warning (matches toast behavior)
        let sync_errors = vec![QuoteSyncErrorInfo {
            asset_id: "SEC:AAPL:XNAS".to_string(),
            symbol: "AAPL".to_string(),
            error_count: 2,
            last_error: Some("Network timeout".to_string()),
            market_value: 10_000.0,
            has_synced_before: true,
        }];

        let issues = check.analyze(&sync_errors, &ctx);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].severity, Severity::Warning);

        // Synced-before failures classify as a transient sync failure, and the
        // evidence surfaces the failure count + provider error.
        let diagnostics = issues[0].diagnostics.as_ref().expect("diagnostics");
        assert_eq!(diagnostics[0].code, "QUOTE_SYNC_FAILED");
        assert!(diagnostics[0].evidence[0].value.contains("Network timeout"));
    }

    #[test]
    fn test_never_synced_classifies_as_invalid_symbol_or_provider() {
        let check = QuoteSyncCheck::new();
        let ctx = HealthContext::new(HealthConfig::default(), "USD", 100_000.0);

        let sync_errors = vec![QuoteSyncErrorInfo {
            asset_id: "SEC:BADSYM:XNAS".to_string(),
            symbol: "BADSYM".to_string(),
            error_count: 3,
            last_error: Some("Symbol not found".to_string()),
            market_value: 0.0,
            has_synced_before: false,
        }];

        let issues = check.analyze(&sync_errors, &ctx);
        assert_eq!(issues.len(), 1);
        let diagnostics = issues[0].diagnostics.as_ref().expect("diagnostics");
        assert_eq!(diagnostics[0].code, "INVALID_SYMBOL_OR_PROVIDER");
        // Retry is the primary fix; market-data settings is the secondary nav.
        assert!(diagnostics[0].actions[0].primary);
    }

    #[test]
    fn test_warning_threshold() {
        let check = QuoteSyncCheck::new();
        let ctx = HealthContext::new(HealthConfig::default(), "USD", 100_000.0);

        // 3 failures - at warning threshold (for assets that have synced before)
        let sync_errors = vec![QuoteSyncErrorInfo {
            asset_id: "SEC:AAPL:XNAS".to_string(),
            symbol: "AAPL".to_string(),
            error_count: 3,
            last_error: Some("Provider error".to_string()),
            market_value: 10_000.0,
            has_synced_before: true,
        }];

        let issues = check.analyze(&sync_errors, &ctx);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].severity, Severity::Warning);
    }

    #[test]
    fn test_error_threshold() {
        let check = QuoteSyncCheck::new();
        let ctx = HealthContext::new(HealthConfig::default(), "USD", 100_000.0);

        // 6 failures - at error threshold (for assets that have synced before)
        let sync_errors = vec![QuoteSyncErrorInfo {
            asset_id: "SEC:AAPL:XNAS".to_string(),
            symbol: "AAPL".to_string(),
            error_count: 6,
            last_error: Some("Symbol not found".to_string()),
            market_value: 10_000.0,
            has_synced_before: true,
        }];

        let issues = check.analyze(&sync_errors, &ctx);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].severity, Severity::Error);
    }

    #[test]
    fn test_never_synced_low_errors_shows_warning() {
        let check = QuoteSyncCheck::new();
        let ctx = HealthContext::new(HealthConfig::default(), "USD", 100_000.0);

        // Never synced with 1 error — should show as warning so health center
        // matches the toast notification
        let sync_errors = vec![QuoteSyncErrorInfo {
            asset_id: "SEC:GOOGL:XTSE".to_string(),
            symbol: "GOOGL".to_string(),
            error_count: 1,
            last_error: Some("Symbol not found".to_string()),
            market_value: 0.0,
            has_synced_before: false,
        }];

        let issues = check.analyze(&sync_errors, &ctx);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].severity, Severity::Warning);
    }

    #[test]
    fn test_never_synced_high_errors_detected() {
        let check = QuoteSyncCheck::new();
        let ctx = HealthContext::new(HealthConfig::default(), "USD", 100_000.0);

        // Never synced but 8 consecutive failures — persistent issue, should flag
        let sync_errors = vec![QuoteSyncErrorInfo {
            asset_id: "SEC:XEQ:XNAS".to_string(),
            symbol: "XEQ".to_string(),
            error_count: 8,
            last_error: Some("Symbol not found".to_string()),
            market_value: 0.0,
            has_synced_before: false,
        }];

        let issues = check.analyze(&sync_errors, &ctx);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].severity, Severity::Error);
    }

    #[test]
    fn test_multiple_severities() {
        let check = QuoteSyncCheck::new();
        let ctx = HealthContext::new(HealthConfig::default(), "USD", 100_000.0);

        let sync_errors = vec![
            QuoteSyncErrorInfo {
                asset_id: "SEC:AAPL:XNAS".to_string(),
                symbol: "AAPL".to_string(),
                error_count: 3, // warning (has synced before)
                last_error: Some("Network timeout".to_string()),
                market_value: 5_000.0,
                has_synced_before: true,
            },
            QuoteSyncErrorInfo {
                asset_id: "SEC:MSFT:XNAS".to_string(),
                symbol: "MSFT".to_string(),
                error_count: 10, // error (has synced before)
                last_error: Some("Symbol delisted".to_string()),
                market_value: 15_000.0,
                has_synced_before: true,
            },
        ];

        let issues = check.analyze(&sync_errors, &ctx);
        assert_eq!(issues.len(), 2);

        // Should have one warning and one error
        let has_warning = issues.iter().any(|i| i.severity == Severity::Warning);
        let has_error = issues.iter().any(|i| i.severity == Severity::Error);
        assert!(has_warning);
        assert!(has_error);
    }

    #[test]
    fn test_truncate_error_non_ascii() {
        // 81 bytes, with byte 80 inside the 'é'
        let msg = format!("{}é", "x".repeat(79));
        assert_eq!(truncate_error(&msg), "x".repeat(79));
    }
}
