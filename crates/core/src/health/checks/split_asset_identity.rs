//! Split asset identity health check.
//!
//! The exchange-registry migrations re-keyed stored assets to their ISO MIC
//! (XNEO→NEOE, CXE→BCXE, DXE→CCXE, XTAI_OTC→ROCO, XAQE→AQSE), except where the
//! canonical twin already existed. On those databases one instrument lives in
//! two asset rows: the legacy-MIC row usually holds most activities and price
//! history, the canonical twin the live position. This check finds those pairs
//! and offers to merge each one.

use std::collections::{BTreeSet, HashMap};

use async_trait::async_trait;
use chrono::NaiveDate;
use rust_decimal::Decimal;
use wealthfolio_market_data::canonicalize_exchange_mic;

use crate::activities::Activity;
use crate::assets::{Asset, AssetMergePreview, InstrumentType};
use crate::errors::Result;
use crate::health::model::{
    DiagnosticDomain, Evidence, FixAction, HealthCategory, HealthDiagnostic, HealthEntityRef,
    HealthIssue, NavigateAction, Severity,
};
use crate::health::traits::{HealthCheck, HealthContext};
use crate::utils::time_utils::{activity_date_in_tz, parse_user_timezone_or_default};

/// One of the two asset rows of a split instrument.
#[derive(Debug, Clone, PartialEq)]
pub struct SplitAssetSide {
    pub asset_id: String,
    pub symbol: String,
    /// The MIC as stored on the row.
    pub exchange_mic: String,
    pub name: Option<String>,
    pub quote_ccy: String,
    pub activity_count: usize,
    /// First and last quote day, filled in by the service.
    pub quote_range: Option<(NaiveDate, NaiveDate)>,
}

/// The same trade recorded once on each row. Reported only; never changed.
#[derive(Debug, Clone, PartialEq)]
pub struct SuspectedDuplicateTrade {
    pub account_id: String,
    pub account_name: String,
    pub activity_type: String,
    pub date: NaiveDate,
    pub quantity: Decimal,
    pub unit_price: Decimal,
}

/// A canonical survivor and its legacy-MIC duplicate.
#[derive(Debug, Clone, PartialEq)]
pub struct SplitAssetPair {
    pub survivor: SplitAssetSide,
    pub duplicate: SplitAssetSide,
    /// The rows quote in different currencies. Reported, but not merged.
    pub currency_mismatch: bool,
    /// Names of accounts with activities on both rows.
    pub shared_account_names: Vec<String>,
    pub suspected_duplicates: Vec<SuspectedDuplicateTrade>,
    /// Read-only merge preview, filled in by the service.
    pub merge_preview: Option<AssetMergePreview>,
}

impl SplitAssetPair {
    /// Whether the pair can be merged by the fix action.
    pub fn is_mergeable(&self) -> bool {
        !self.currency_mismatch
            && self
                .merge_preview
                .as_ref()
                .is_some_and(|preview| preview.shared_source_snapshots.is_empty())
    }
}

/// Returns the canonical MIC when `mic` is a legacy alias, else `None`.
fn canonical_for_legacy(mic: &str) -> Option<String> {
    let canonical = canonicalize_exchange_mic(mic);
    (canonical != mic.trim().to_ascii_uppercase()).then_some(canonical)
}

/// Finds instruments split across a legacy-MIC row and its canonical twin.
///
/// A row whose MIC is a legacy alias pairs with the one other row of the same
/// kind, instrument type and exact symbol whose MIC is the canonical spelling.
/// A legacy row that is inactive with no activities is the state a merge
/// leaves behind and is not reported again.
pub fn find_split_asset_pairs(
    assets: &[Asset],
    activities: &[Activity],
    account_names: &HashMap<String, String>,
    timezone: Option<&str>,
) -> Vec<SplitAssetPair> {
    let mut by_asset: HashMap<&str, Vec<&Activity>> = HashMap::new();
    for activity in activities {
        if let Some(asset_id) = activity.asset_id.as_deref() {
            by_asset.entry(asset_id).or_default().push(activity);
        }
    }
    let tz = parse_user_timezone_or_default(timezone.unwrap_or_default());

    let mut pairs = Vec::new();
    for duplicate in assets {
        let (Some(instrument_type), Some(symbol), Some(mic)) = (
            duplicate.instrument_type.as_ref(),
            duplicate.instrument_symbol.as_deref(),
            duplicate.instrument_exchange_mic.as_deref(),
        ) else {
            continue;
        };
        if matches!(instrument_type, InstrumentType::Fx | InstrumentType::Crypto) {
            continue;
        }
        let Some(canonical) = canonical_for_legacy(mic) else {
            continue;
        };
        let duplicate_activities = by_asset.get(duplicate.id.as_str());
        let duplicate_count = duplicate_activities.map_or(0, Vec::len);
        if !duplicate.is_active && duplicate_count == 0 {
            continue;
        }

        let mut candidates = assets.iter().filter(|survivor| {
            survivor.id != duplicate.id
                && survivor.kind == duplicate.kind
                && survivor.instrument_type.as_ref() == Some(instrument_type)
                && survivor.instrument_symbol.as_deref() == Some(symbol)
                && survivor
                    .instrument_exchange_mic
                    .as_deref()
                    .is_some_and(|m| m.trim().eq_ignore_ascii_case(&canonical))
        });
        let (Some(survivor), None) = (candidates.next(), candidates.next()) else {
            continue;
        };

        let survivor_activities = by_asset.get(survivor.id.as_str());
        let account_set = |list: Option<&Vec<&Activity>>| -> BTreeSet<String> {
            list.into_iter()
                .flatten()
                .map(|activity| activity.account_id.clone())
                .collect()
        };
        let shared_accounts: BTreeSet<String> = account_set(survivor_activities)
            .intersection(&account_set(duplicate_activities))
            .cloned()
            .collect();
        let account_name = |id: &str| {
            account_names
                .get(id)
                .cloned()
                .unwrap_or_else(|| id.to_string())
        };

        let mut suspected_duplicates = Vec::new();
        let mut matched_survivor_ids: BTreeSet<&str> = BTreeSet::new();
        for left in duplicate_activities.into_iter().flatten() {
            if !shared_accounts.contains(&left.account_id) {
                continue;
            }
            let (Some(quantity), Some(unit_price)) = (left.quantity, left.unit_price) else {
                continue;
            };
            let date = activity_date_in_tz(left.activity_date, tz);
            let twin = survivor_activities.into_iter().flatten().find(|right| {
                !matched_survivor_ids.contains(right.id.as_str())
                    && right.account_id == left.account_id
                    && right.effective_type() == left.effective_type()
                    && activity_date_in_tz(right.activity_date, tz) == date
                    && right.quantity == Some(quantity)
                    && right.unit_price == Some(unit_price)
            });
            if let Some(twin) = twin {
                matched_survivor_ids.insert(twin.id.as_str());
                suspected_duplicates.push(SuspectedDuplicateTrade {
                    account_id: left.account_id.clone(),
                    account_name: account_name(&left.account_id),
                    activity_type: left.effective_type().to_string(),
                    date,
                    quantity,
                    unit_price,
                });
            }
        }
        suspected_duplicates.sort_by(|a, b| {
            (&a.account_name, a.date, &a.activity_type).cmp(&(
                &b.account_name,
                b.date,
                &b.activity_type,
            ))
        });

        let side = |asset: &Asset, count: usize| SplitAssetSide {
            asset_id: asset.id.clone(),
            symbol: symbol.to_string(),
            exchange_mic: asset.instrument_exchange_mic.clone().unwrap_or_default(),
            name: asset.name.clone(),
            quote_ccy: asset.quote_ccy.clone(),
            activity_count: count,
            quote_range: None,
        };
        let mut shared_account_names: Vec<String> =
            shared_accounts.iter().map(|id| account_name(id)).collect();
        shared_account_names.sort();

        pairs.push(SplitAssetPair {
            survivor: side(survivor, survivor_activities.map_or(0, Vec::len)),
            duplicate: side(duplicate, duplicate_count),
            currency_mismatch: !survivor
                .quote_ccy
                .trim()
                .eq_ignore_ascii_case(duplicate.quote_ccy.trim()),
            shared_account_names,
            suspected_duplicates,
            merge_preview: None,
        });
    }

    pairs.sort_by(|a, b| {
        (
            &a.survivor.symbol,
            &a.survivor.asset_id,
            &a.duplicate.asset_id,
        )
            .cmp(&(
                &b.survivor.symbol,
                &b.survivor.asset_id,
                &b.duplicate.asset_id,
            ))
    });
    pairs
}

/// Health check that reports instruments split across two asset rows.
pub struct SplitAssetIdentityCheck;

impl SplitAssetIdentityCheck {
    pub fn new() -> Self {
        Self
    }

    /// Builds one aggregated issue with a diagnostic (and merge fix) per pair.
    pub fn analyze(&self, pairs: &[SplitAssetPair], _ctx: &HealthContext) -> Vec<HealthIssue> {
        if pairs.is_empty() {
            return Vec::new();
        }
        let count = pairs.len();
        let severity = if pairs
            .iter()
            .any(|pair| !pair.shared_account_names.is_empty())
        {
            Severity::Error
        } else {
            Severity::Warning
        };
        let title = if count == 1 {
            format!(
                "{} is split across two asset records",
                pairs[0].survivor.symbol
            )
        } else {
            format!("{} investments are split across two asset records", count)
        };

        let issue = HealthIssue::builder()
            .id("split_asset_identity:pairs")
            .severity(severity)
            .category(HealthCategory::DataConsistency)
            .code("data_split_asset_identity")
            .param("count", count as u32)
            .param("symbol", pairs[0].survivor.symbol.clone())
            .title(title)
            .message(
                "An exchange code was renamed, but these investments already had a record under the new code. Their transactions and price history are split between the two records. Merge each pair into one.",
            )
            .affected_count(count as u32)
            .diagnostics(pairs.iter().map(pair_diagnostic).collect())
            .build();
        vec![issue]
    }
}

impl Default for SplitAssetIdentityCheck {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl HealthCheck for SplitAssetIdentityCheck {
    fn id(&self) -> &'static str {
        "split_asset_identity"
    }

    fn category(&self) -> HealthCategory {
        HealthCategory::DataConsistency
    }

    async fn run(&self, _ctx: &HealthContext) -> Result<Vec<HealthIssue>> {
        // The service calls analyze() directly with pre-gathered asset pairs.
        Ok(Vec::new())
    }
}

fn holding_route(asset_id: &str) -> String {
    format!("/holdings/{}", urlencoding::encode(asset_id))
}

fn format_day(day: NaiveDate) -> String {
    day.format("%b %-d, %Y").to_string()
}

fn describe_side(side: &SplitAssetSide) -> String {
    let mut parts = vec![format!("{} on {}", side.symbol, side.exchange_mic)];
    if let Some(name) = side.name.as_deref().filter(|name| !name.trim().is_empty()) {
        parts.push(name.to_string());
    }
    parts.push(match side.activity_count {
        1 => "1 transaction".to_string(),
        n => format!("{n} transactions"),
    });
    parts.join(" · ")
}

fn describe_trade(trade: &SuspectedDuplicateTrade) -> String {
    format!(
        "{} · {} · {} · {} @ {}",
        trade.account_name,
        format_day(trade.date),
        trade.activity_type,
        trade.quantity.normalize(),
        trade.unit_price.normalize()
    )
}

fn plural(count: u32, one: &str, many: &str) -> String {
    if count == 1 {
        format!("1 {one}")
    } else {
        format!("{count} {many}")
    }
}

/// The confirmation text shown before the merge runs: what moves, what the
/// price history ends up as, and what it leaves for the user to review.
fn confirm_message(pair: &SplitAssetPair, preview: &AssetMergePreview) -> String {
    let old = &pair.duplicate.exchange_mic;
    let new = &pair.survivor.exchange_mic;
    let mut lines = vec![format!(
        "{} will move from the {old} record to the {new} record, and the {old} record will be retired.",
        plural(
            pair.duplicate.activity_count as u32,
            "transaction",
            "transactions"
        )
    )];

    let mut prices = if preview.overlapping_quote_days == 0 {
        "Price history: no overlapping days.".to_string()
    } else {
        format!(
            "Price history: {}: {} kept from {new}, {} kept from {old}.",
            plural(
                preview.overlapping_quote_days,
                "overlapping day",
                "overlapping days"
            ),
            preview.overlap_days_kept_from_survivor,
            preview.overlap_days_kept_from_duplicate
        )
    };
    if preview.duplicate_quotes_moved > 0 || preview.duplicate_quotes_dropped > 0 {
        prices.push_str(&format!(
            " {old} prices moving to {new}: {}. {old} prices replaced by the {new} price for the same day and source: {}.",
            preview.duplicate_quotes_moved, preview.duplicate_quotes_dropped
        ));
    }
    lines.push(prices);

    if !pair.suspected_duplicates.is_empty() {
        lines.push(
            "These trades appear on both records and may be duplicates. The merge keeps both; review them afterwards:"
                .to_string(),
        );
        lines.extend(
            pair.suspected_duplicates
                .iter()
                .map(|trade| format!("• {}", describe_trade(trade))),
        );
    }
    lines.push("Affected accounts are recalculated after the merge.".to_string());
    lines.join("\n")
}

fn pair_diagnostic(pair: &SplitAssetPair) -> HealthDiagnostic {
    let survivor = &pair.survivor;
    let duplicate = &pair.duplicate;
    let severity = if pair.shared_account_names.is_empty() {
        Severity::Warning
    } else {
        Severity::Error
    };

    // The title carries the symbol and both MICs: the detail sheet groups
    // diagnostics by code, title and explanation, and a group of several hides
    // the primary action.
    let mut diagnostic = HealthDiagnostic::new(
        "SPLIT_ASSET_IDENTITY",
        format!(
            "{} is recorded on both {} and {}",
            survivor.symbol, survivor.exchange_mic, duplicate.exchange_mic
        ),
        format!(
            "{} is the old code for {}. Merging moves the transactions, prices, classifications and snapshot positions of the {} record onto the {} record.",
            duplicate.exchange_mic,
            survivor.exchange_mic,
            duplicate.exchange_mic,
            survivor.exchange_mic
        ),
    )
    .domain(DiagnosticDomain::Ledger)
    .severity(severity)
    .entity(
        HealthEntityRef::new("asset", survivor.asset_id.clone())
            .label(format!("{} ({})", survivor.symbol, survivor.exchange_mic))
            .route(holding_route(&survivor.asset_id)),
    )
    .entity(
        HealthEntityRef::new("asset", duplicate.asset_id.clone())
            .label(format!("{} ({})", duplicate.symbol, duplicate.exchange_mic))
            .route(holding_route(&duplicate.asset_id)),
    )
    .evidence(
        Evidence::new("Current record", describe_side(survivor))
            .with_route(holding_route(&survivor.asset_id)),
    )
    .evidence(
        Evidence::new("Old record", describe_side(duplicate))
            .with_route(holding_route(&duplicate.asset_id)),
    );

    for side in [survivor, duplicate] {
        if let Some((first, last)) = side.quote_range {
            diagnostic = diagnostic.evidence(Evidence::new(
                format!("Prices on {}", side.exchange_mic),
                format!("{} to {}", format_day(first), format_day(last)),
            ));
        }
    }
    if !pair.shared_account_names.is_empty() {
        diagnostic = diagnostic.evidence(Evidence::new(
            "Accounts using both",
            pair.shared_account_names.join(", "),
        ));
    }
    for trade in &pair.suspected_duplicates {
        diagnostic = diagnostic.evidence(Evidence::new(
            "Possible duplicate trade",
            describe_trade(trade),
        ));
    }
    if pair.currency_mismatch {
        diagnostic = diagnostic.evidence(Evidence::new(
            "Quote currencies differ",
            format!(
                "{} {}, {} {}. Not merged automatically.",
                survivor.exchange_mic,
                survivor.quote_ccy,
                duplicate.exchange_mic,
                duplicate.quote_ccy
            ),
        ));
    }
    if let Some(preview) = &pair.merge_preview {
        for snapshot in &preview.shared_source_snapshots {
            diagnostic = diagnostic.evidence(Evidence::new(
                "Snapshot listing both",
                format!(
                    "{} · {}. Edit it so the holding appears once, then merge.",
                    snapshot.account_name, snapshot.snapshot_date
                ),
            ));
        }
    }

    let review = |side: &SplitAssetSide| NavigateAction {
        label: format!("Review {} record", side.exchange_mic),
        ..NavigateAction::to_asset_activities(side.asset_id.clone())
    };
    match pair.merge_preview.as_ref().filter(|_| pair.is_mergeable()) {
        Some(preview) => {
            diagnostic = diagnostic
                .fix(
                    true,
                    FixAction::merge_split_asset(
                        survivor.asset_id.clone(),
                        duplicate.asset_id.clone(),
                        &survivor.symbol,
                        confirm_message(pair, preview),
                    ),
                )
                .navigate(false, review(duplicate));
        }
        None => {
            diagnostic = diagnostic
                .navigate(true, review(duplicate))
                .navigate(false, review(survivor));
        }
    }
    diagnostic
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::activities::ActivityStatus;
    use crate::assets::AssetKind;
    use crate::health::model::{ActionRef, HealthConfig};
    use chrono::{TimeZone, Utc};
    use rust_decimal_macros::dec;

    fn asset(id: &str, symbol: &str, mic: &str, ccy: &str) -> Asset {
        Asset {
            id: id.to_string(),
            kind: AssetKind::Investment,
            name: Some(format!("{symbol} name")),
            quote_ccy: ccy.to_string(),
            instrument_type: Some(InstrumentType::Equity),
            instrument_symbol: Some(symbol.to_string()),
            instrument_exchange_mic: Some(mic.to_string()),
            is_active: true,
            ..Asset::default()
        }
    }

    fn activity(id: &str, account: &str, asset: &str, kind: &str, qty: Decimal) -> Activity {
        let at = Utc.with_ymd_and_hms(2026, 3, 2, 15, 0, 0).unwrap();
        Activity {
            id: id.to_string(),
            account_id: account.to_string(),
            asset_id: Some(asset.to_string()),
            activity_type: kind.to_string(),
            activity_type_override: None,
            source_type: None,
            subtype: None,
            status: ActivityStatus::Posted,
            activity_date: at,
            settlement_date: None,
            quantity: Some(qty),
            unit_price: Some(dec!(31.5)),
            amount: None,
            fee: None,
            tax: None,
            currency: "CAD".to_string(),
            fx_rate: None,
            notes: None,
            metadata: None,
            source_system: None,
            source_record_id: None,
            source_group_id: None,
            idempotency_key: None,
            import_run_id: None,
            is_user_modified: false,
            needs_review: false,
            created_at: at,
            updated_at: at,
        }
    }

    fn pairs(assets: &[Asset], activities: &[Activity]) -> Vec<SplitAssetPair> {
        find_split_asset_pairs(assets, activities, &HashMap::new(), None)
    }

    #[test]
    fn every_legacy_alias_pairs_with_its_canonical_twin() {
        let aliases = [
            ("XNEO", "NEOE"),
            ("CXE", "BCXE"),
            ("DXE", "CCXE"),
            ("XTAI_OTC", "ROCO"),
            ("XAQE", "AQSE"),
        ];
        for (legacy, canonical) in aliases {
            let assets = vec![
                asset("legacy", "SYM", legacy, "CAD"),
                asset("canonical", "SYM", canonical, "CAD"),
            ];
            let found = pairs(&assets, &[]);
            assert_eq!(found.len(), 1, "{legacy} -> {canonical}");
            assert_eq!(found[0].survivor.asset_id, "canonical");
            assert_eq!(found[0].duplicate.asset_id, "legacy");
        }
    }

    #[test]
    fn mic_case_and_whitespace_are_normalized() {
        let assets = vec![
            asset("legacy", "VBG", " xneo ", "CAD"),
            asset("canonical", "VBG", "neoe", "CAD"),
        ];
        assert_eq!(pairs(&assets, &[]).len(), 1);
    }

    #[test]
    fn fx_and_crypto_rows_are_ignored() {
        for instrument_type in [InstrumentType::Fx, InstrumentType::Crypto] {
            let mut legacy = asset("legacy", "SYM", "XNEO", "CAD");
            let mut canonical = asset("canonical", "SYM", "NEOE", "CAD");
            legacy.instrument_type = Some(instrument_type.clone());
            canonical.instrument_type = Some(instrument_type);
            assert!(pairs(&[legacy, canonical], &[]).is_empty());
        }
    }

    #[test]
    fn different_symbol_type_or_kind_is_not_a_pair() {
        let legacy = asset("legacy", "VBG", "XNEO", "CAD");

        let other_symbol = asset("canonical", "VBU", "NEOE", "CAD");
        assert!(pairs(&[legacy.clone(), other_symbol], &[]).is_empty());

        let mut other_type = asset("canonical", "VBG", "NEOE", "CAD");
        other_type.instrument_type = Some(InstrumentType::Bond);
        assert!(pairs(&[legacy.clone(), other_type], &[]).is_empty());

        let mut other_kind = asset("canonical", "VBG", "NEOE", "CAD");
        other_kind.kind = AssetKind::Other;
        assert!(pairs(&[legacy, other_kind], &[]).is_empty());
    }

    #[test]
    fn currency_mismatch_is_reported_without_a_merge_fix() {
        let assets = vec![
            asset("legacy", "VBG", "XNEO", "USD"),
            asset("canonical", "VBG", "NEOE", "CAD"),
        ];
        let mut found = pairs(&assets, &[]);
        assert_eq!(found.len(), 1);
        assert!(found[0].currency_mismatch);
        found[0].merge_preview = Some(AssetMergePreview::default());
        assert!(!found[0].is_mergeable());

        let ctx = HealthContext::new(HealthConfig::default(), "CAD", 0.0);
        let issue = &SplitAssetIdentityCheck::new().analyze(&found, &ctx)[0];
        let diagnostic = &issue.diagnostics.as_ref().unwrap()[0];
        assert!(diagnostic
            .actions
            .iter()
            .all(|action| matches!(action.action, ActionRef::Navigate { .. })));
        assert!(issue.fix_action.is_none());
    }

    #[test]
    fn retired_duplicate_is_not_reported() {
        let mut legacy = asset("legacy", "VBG", "XNEO", "CAD");
        legacy.is_active = false;
        let canonical = asset("canonical", "VBG", "NEOE", "CAD");
        assert!(pairs(&[legacy.clone(), canonical.clone()], &[]).is_empty());

        // Inactive but still holding activities: not retired yet.
        let activities = vec![activity("a1", "acc", "legacy", "BUY", dec!(10))];
        assert_eq!(pairs(&[legacy, canonical], &activities).len(), 1);
    }

    #[test]
    fn single_rows_are_not_reported() {
        assert!(pairs(&[asset("canonical", "VBG", "NEOE", "CAD")], &[]).is_empty());
        assert!(pairs(&[asset("legacy", "VBG", "XNEO", "CAD")], &[]).is_empty());
    }

    #[test]
    fn pairs_are_ordered_by_symbol() {
        let assets = vec![
            asset("vbu-l", "VBU", "XNEO", "CAD"),
            asset("eacc-c", "EACC", "NEOE", "CAD"),
            asset("vbu-c", "VBU", "NEOE", "CAD"),
            asset("eacc-l", "EACC", "XNEO", "CAD"),
        ];
        let symbols: Vec<String> = pairs(&assets, &[])
            .into_iter()
            .map(|pair| pair.survivor.symbol)
            .collect();
        assert_eq!(symbols, vec!["EACC", "VBU"]);
    }

    #[test]
    fn shared_accounts_and_duplicate_trades_are_collected() {
        let assets = vec![
            asset("legacy", "VBG", "XNEO", "CAD"),
            asset("canonical", "VBG", "NEOE", "CAD"),
        ];
        let activities = vec![
            activity("b1", "acc", "legacy", "BUY", dec!(10)),
            activity("b2", "acc", "legacy", "BUY", dec!(5)),
            activity("b1-twin", "acc", "canonical", "BUY", dec!(10.0)),
            activity("s1", "acc", "canonical", "SELL", dec!(3)),
            activity("other", "acc2", "legacy", "BUY", dec!(10)),
        ];
        let names = HashMap::from([("acc".to_string(), "TFSA".to_string())]);
        let found = find_split_asset_pairs(&assets, &activities, &names, None);
        let pair = &found[0];
        assert_eq!(pair.duplicate.activity_count, 3);
        assert_eq!(pair.survivor.activity_count, 2);
        assert_eq!(pair.shared_account_names, vec!["TFSA"]);
        assert_eq!(pair.suspected_duplicates.len(), 1);
        assert_eq!(pair.suspected_duplicates[0].account_name, "TFSA");
        assert_eq!(pair.suspected_duplicates[0].quantity, dec!(10));
    }

    fn mergeable_pair(symbol: &str, shared: bool) -> SplitAssetPair {
        let assets = vec![
            asset(&format!("{symbol}-l"), symbol, "XNEO", "CAD"),
            asset(&format!("{symbol}-c"), symbol, "NEOE", "CAD"),
        ];
        let mut activities = vec![activity("a", "acc", &format!("{symbol}-l"), "BUY", dec!(1))];
        if shared {
            activities.push(activity(
                "b",
                "acc",
                &format!("{symbol}-c"),
                "SELL",
                dec!(1),
            ));
        }
        let mut pair = pairs(&assets, &activities).remove(0);
        pair.merge_preview = Some(AssetMergePreview {
            overlapping_quote_days: 12,
            overlap_days_kept_from_survivor: 11,
            overlap_days_kept_from_duplicate: 1,
            duplicate_quotes_dropped: 11,
            duplicate_quotes_moved: 400,
            shared_source_snapshots: Vec::new(),
        });
        pair
    }

    #[test]
    fn analyze_builds_one_issue_with_a_merge_fix_per_pair() {
        let ctx = HealthContext::new(HealthConfig::default(), "CAD", 0.0);
        let found = vec![mergeable_pair("EACC", false), mergeable_pair("FEQT", true)];
        let issues = SplitAssetIdentityCheck::new().analyze(&found, &ctx);
        assert_eq!(issues.len(), 1);
        let issue = &issues[0];
        assert_eq!(issue.code.as_deref(), Some("data_split_asset_identity"));
        assert_eq!(issue.params.get("count"), Some(&serde_json::json!(2)));
        assert_eq!(issue.category, HealthCategory::DataConsistency);
        assert_eq!(issue.severity, Severity::Error, "FEQT has a shared account");
        assert!(issue.id.starts_with("split_asset_identity:"));

        let diagnostics = issue.diagnostics.as_ref().unwrap();
        assert_eq!(diagnostics.len(), 2);
        assert_ne!(diagnostics[0].title, diagnostics[1].title);
        assert_eq!(diagnostics[0].severity, Severity::Warning);
        assert_eq!(diagnostics[1].severity, Severity::Error);

        let fix = diagnostics[1]
            .actions
            .iter()
            .find_map(|action| match (&action.action, action.primary) {
                (ActionRef::Fix { action }, true) => Some(action),
                _ => None,
            })
            .expect("primary merge fix");
        assert_eq!(fix.id, "merge_split_asset");
        assert_eq!(fix.label, "Merge FEQT");
        assert_eq!(
            fix.payload,
            serde_json::json!({
                "pairs": [{ "survivorAssetId": "FEQT-c", "duplicateAssetId": "FEQT-l" }]
            })
        );
        let confirm = fix.confirm.as_deref().expect("merge asks for confirmation");
        assert!(confirm.contains("12 overlapping days: 11 kept from NEOE, 1 kept from XNEO"));
    }

    #[test]
    fn severity_is_warning_without_shared_accounts() {
        let ctx = HealthContext::new(HealthConfig::default(), "CAD", 0.0);
        let issues = SplitAssetIdentityCheck::new().analyze(&[mergeable_pair("EACC", false)], &ctx);
        assert_eq!(issues[0].severity, Severity::Warning);
        assert!(SplitAssetIdentityCheck::new().analyze(&[], &ctx).is_empty());
    }

    #[test]
    fn blocking_snapshot_withholds_the_merge_fix() {
        let ctx = HealthContext::new(HealthConfig::default(), "CAD", 0.0);
        let mut pair = mergeable_pair("VBG", true);
        pair.merge_preview
            .as_mut()
            .unwrap()
            .shared_source_snapshots
            .push(crate::assets::SharedSourceSnapshot {
                account_id: "acc".to_string(),
                account_name: "TFSA".to_string(),
                snapshot_date: "2026-01-31".to_string(),
            });
        let issue = &SplitAssetIdentityCheck::new().analyze(&[pair], &ctx)[0];
        let diagnostic = &issue.diagnostics.as_ref().unwrap()[0];
        assert!(issue.fix_action.is_none());
        assert!(diagnostic
            .evidence
            .iter()
            .any(|row| row.value.contains("TFSA · 2026-01-31")));
    }

    #[test]
    fn confirm_message_lists_suspected_duplicate_trades() {
        let assets = vec![
            asset("legacy", "VBG", "XNEO", "CAD"),
            asset("canonical", "VBG", "NEOE", "CAD"),
        ];
        let activities = vec![
            activity("b1", "acc", "legacy", "BUY", dec!(10)),
            activity("b1-twin", "acc", "canonical", "BUY", dec!(10)),
        ];
        let names = HashMap::from([("acc".to_string(), "TFSA".to_string())]);
        let pair = find_split_asset_pairs(&assets, &activities, &names, None).remove(0);
        let message = confirm_message(&pair, &AssetMergePreview::default());
        assert!(message.contains("1 transaction will move from the XNEO record"));
        assert!(message.contains("Price history: no overlapping days."));
        assert!(message.contains("• TFSA · Mar 2, 2026 · BUY · 10 @ 31.5"));
    }
}
