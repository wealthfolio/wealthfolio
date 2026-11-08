//! Health diagnostics exercised against the engine's persisted lot book.
use super::*;
use crate::activities::{ACTIVITY_SUBTYPE_POSITION_CLOSE, ACTIVITY_SUBTYPE_POSITION_OPEN};
use crate::assets::AssetService;
use crate::health::checks::ConsistencyIssueInfo;
use crate::health::service::{
    gather_incomplete_basis_trade_activities, gather_missing_lot_disposal_sells,
};

const SHORTS: &str = r#"
id: INLINE-HEALTH-SHORTS
title: Health short lot lifecycle
policy: { base_currency: USD, timezone: UTC, as_of: 2026-10-05 }
accounts:
  - { id: business, currency: USD, cost_basis_method: WAC }
assets:
  - { id: aapl, quote_ccy: USD, instrument_type: EQUITY }
activities:
  - { id: deposit, account: business, type: DEPOSIT, date: 2026-10-01T09:00:00Z, amount: 1000 }
  - { id: short-1, account: business, type: SELL, subtype: POSITION_OPEN, date: 2026-10-01T10:00:00Z, asset: aapl, quantity: 5, unit_price: 20, amount: 100 }
  - { id: short-2, account: business, type: SELL, subtype: POSITION_OPEN, date: 2026-10-01T11:00:00Z, asset: aapl, quantity: 5, unit_price: 22, amount: 110 }
  - { id: cover, account: business, type: BUY, subtype: POSITION_CLOSE, date: 2026-10-01T12:00:00Z, asset: aapl, quantity: 4, unit_price: 15, amount: 60 }
quotes:
  - { asset: aapl, day: 2026-10-01, close: 20 }
"#;

/// Loads the synthetic WAC short-opening and cover scenario.
fn facts() -> ScenarioFacts {
    serde_yaml::from_str::<Scenario>(SHORTS).unwrap().facts()
}

/// Projects the fixture through the real coordinator and rejects unexpected engine issues.
async fn projected(facts: ScenarioFacts) -> Harness {
    let h = harness(facts).await;
    let result = h
        .coordinator
        .run_job(
            PortfolioJobRequest {
                force_full: true,
                ..request()
            },
            &SilentObserver,
        )
        .await
        .unwrap();
    assert!(result.failures.is_empty(), "{:?}", result.failures);
    assert!(h
        .store
        .activity_issues(&["business".to_string()])
        .unwrap()
        .is_empty());
    h
}

/// Uses the fixture repositories for asset metadata without introducing provider requests.
fn assets(h: &Harness) -> AssetService {
    AssetService::new(h.sources.assets.clone(), h.quote_service.clone()).unwrap()
}

/// Runs the production missing-disposal gatherer over persisted fixture evidence.
async fn sales(h: &Harness, activities: &[Activity]) -> Vec<ConsistencyIssueInfo> {
    gather_missing_lot_disposal_sells(
        h.lot_repo.as_ref(),
        &assets(h),
        &h.account_repo.list(None, None, None).unwrap(),
        activities,
        Some("UTC"),
    )
    .await
}

/// Recognizes short openings after WAC pooling removes their individual source links.
#[tokio::test]
async fn health_accepts_wac_short_openings_after_partial_and_full_covers() {
    for cover_quantity in [dec!(4), dec!(10)] {
        let mut input = facts();
        let cover = input
            .activities
            .iter_mut()
            .find(|a| a.id == "cover")
            .unwrap();
        cover.quantity = Some(cover_quantity);
        cover.amount = Some(cover_quantity * dec!(15));
        let h = projected(input).await;
        let lots = h
            .lot_repo
            .get_all_lots_for_account("business")
            .await
            .unwrap();
        assert_eq!(lots.len(), 1);
        assert!(
            lots[0].open_activity_id.is_none(),
            "WAC erased opening provenance"
        );
        assert_eq!(
            lots[0].original_quantity.parse::<Decimal>().unwrap(),
            dec!(-10)
        );
        assert_eq!(lots[0].is_closed, cover_quantity == dec!(10));
        assert!(sales(&h, &h.activity_repo.all()).await.is_empty());
    }
}

/// Recognizes pooled short origins after option expiry or a security transfer relieves them.
#[tokio::test]
async fn health_accepts_wac_short_openings_relieved_by_expiry_or_transfer() {
    for expiry in [false, true] {
        let mut input = facts();
        if expiry {
            input.assets[0].instrument_type = Some(crate::assets::InstrumentType::Option);
        }
        let closing = input
            .activities
            .iter_mut()
            .find(|a| a.id == "cover")
            .unwrap();
        closing.activity_type = if expiry { "ADJUSTMENT" } else { "TRANSFER_OUT" }.to_string();
        closing.subtype =
            expiry.then(|| crate::activities::ACTIVITY_SUBTYPE_OPTION_EXPIRY.to_string());
        closing.quantity = Some(dec!(10));
        closing.unit_price = None;
        closing.amount = None;
        let h = projected(input).await;
        let lots = h
            .lot_repo
            .get_all_lots_for_account("business")
            .await
            .unwrap();
        assert_eq!(lots.len(), 1);
        assert!(lots[0].open_activity_id.is_none());
        assert!(lots[0].is_closed);
        assert!(sales(&h, &h.activity_repo.all()).await.is_empty());
    }
}

/// Keeps unmatched sales outside a pool interval, long closes, and invalid quantities visible.
#[tokio::test]
async fn health_does_not_use_a_wac_pool_for_unrelated_or_later_sales() {
    let h = projected(facts()).await;
    let mut activities = h.activity_repo.all();
    let template = activities
        .iter()
        .find(|a| a.id == "short-1")
        .unwrap()
        .clone();
    for (id, subtype, date, asset) in [
        ("ordinary-sale", None, "2026-10-01T10:30:00Z", "aapl"),
        (
            "long-close",
            Some(ACTIVITY_SUBTYPE_POSITION_CLOSE),
            "2026-10-01T10:30:00Z",
            "aapl",
        ),
        (
            "earlier-short",
            Some(ACTIVITY_SUBTYPE_POSITION_OPEN),
            "2026-09-30T10:30:00Z",
            "aapl",
        ),
        (
            "later-short",
            Some(ACTIVITY_SUBTYPE_POSITION_OPEN),
            "2026-10-01T13:00:00Z",
            "aapl",
        ),
        (
            "other-asset",
            Some(ACTIVITY_SUBTYPE_POSITION_OPEN),
            "2026-10-01T10:30:00Z",
            "other",
        ),
    ] {
        let mut activity = template.clone();
        activity.id = id.to_string();
        activity.subtype = subtype.map(str::to_string);
        activity.activity_date = date.parse().unwrap();
        activity.asset_id = Some(asset.to_string());
        activities.push(activity);
    }
    for (id, quantity) in [("zero-short", Some(dec!(0))), ("missing-quantity", None)] {
        let mut activity = template.clone();
        activity.id = id.to_string();
        activity.quantity = quantity;
        activities.push(activity);
    }
    let issues = sales(&h, &activities).await;
    let ids: HashSet<_> = issues
        .iter()
        .map(|issue| issue.record_id.as_str())
        .collect();
    assert_eq!(
        ids,
        HashSet::from([
            "ordinary-sale",
            "long-close",
            "earlier-short",
            "later-short",
            "other-asset",
            "zero-short",
            "missing-quantity"
        ])
    );
}

/// Requires persisted pool and disposal evidence before exempting WAC short openings.
#[tokio::test]
async fn health_still_reports_wac_short_openings_when_pool_or_disposals_are_missing() {
    for remove_pool in [false, true] {
        let h = projected(facts()).await;
        if remove_pool {
            h.lot_repo
                .replace_lots_for_account("business", &[])
                .await
                .unwrap();
        } else {
            h.lot_repo
                .sync_lot_disposals_for_account("business", &[], &[], true)
                .await
                .unwrap();
        }
        let issues = sales(&h, &h.activity_repo.all()).await;
        let ids: HashSet<_> = issues
            .iter()
            .map(|issue| issue.record_id.as_str())
            .collect();
        assert_eq!(ids, HashSet::from(["short-1", "short-2"]));
    }
}

/// Checks implicit covers under FIFO/WAC, including fees and over-covers that open long lots.
#[tokio::test]
async fn health_accepts_implicit_option_covers_but_keeps_unknown_long_costs() {
    for method in ["FIFO", "WAC"] {
        for fee in [dec!(0), dec!(1.25)] {
            // 4 partially covers, 10 closes, 12 also opens a long acquisition.
            for quantity in [dec!(4), dec!(10), dec!(12)] {
                let mut input = facts();
                input.accounts[0].meta =
                    Some(serde_json::json!({"accounting":{"costBasisMethod": method}}).to_string());
                input.assets[0].instrument_type = Some(crate::assets::InstrumentType::Option);
                for activity in &mut input.activities {
                    if activity.effective_type() == "SELL" {
                        activity.subtype = None;
                    }
                    if activity.id == "cover" {
                        activity.subtype = None;
                        activity.quantity = Some(quantity);
                        activity.unit_price = Some(dec!(0));
                        activity.amount = Some(fee);
                        activity.fee = Some(fee);
                    }
                }
                let h = projected(input).await;
                let all = h.activity_repo.all();
                let covers: Vec<_> = all.iter().filter(|a| a.id == "cover").cloned().collect();
                let issues = gather_incomplete_basis_trade_activities(
                    h.lot_repo.as_ref(),
                    &assets(&h),
                    &h.account_repo.list(None, None, None).unwrap(),
                    &covers,
                    Some("UTC"),
                )
                .await;
                assert_eq!(
                    issues.len(),
                    usize::from(quantity > dec!(10)),
                    "{method}, quantity {quantity}, fee {fee}"
                );
                // Implicit option short openings also remain valid after WAC pooling.
                assert!(sales(&h, &all).await.is_empty());
            }
        }
    }
}

/// Keeps incomplete-basis warnings when implicit option cover evidence is missing.
#[tokio::test]
async fn health_requires_implicit_option_covers_to_have_lots_and_disposals() {
    for remove_lots in [false, true] {
        let mut input = facts();
        input.assets[0].instrument_type = Some(crate::assets::InstrumentType::Option);
        let cover = input
            .activities
            .iter_mut()
            .find(|a| a.id == "cover")
            .unwrap();
        cover.subtype = None;
        cover.unit_price = Some(dec!(0));
        cover.amount = Some(dec!(0));
        let h = projected(input).await;
        if remove_lots {
            h.lot_repo
                .replace_lots_for_account("business", &[])
                .await
                .unwrap();
        } else {
            h.lot_repo
                .sync_lot_disposals_for_account("business", &[], &[], true)
                .await
                .unwrap();
        }
        let all = h.activity_repo.all();
        let covers: Vec<_> = all.into_iter().filter(|a| a.id == "cover").collect();
        let issues = gather_incomplete_basis_trade_activities(
            h.lot_repo.as_ref(),
            &assets(&h),
            &h.account_repo.list(None, None, None).unwrap(),
            &covers,
            Some("UTC"),
        )
        .await;
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].activity_id.as_deref(), Some("cover"));
    }
}

/// A pooled short cannot justify a SELL explicitly intended to close a long option position.
#[tokio::test]
async fn health_keeps_explicit_option_closes_with_missing_disposals_visible() {
    let mut input = facts();
    input.assets[0].instrument_type = Some(crate::assets::InstrumentType::Option);
    let mut invalid_close = input
        .activities
        .iter()
        .find(|a| a.id == "short-1")
        .unwrap()
        .clone();
    invalid_close.id = "long-close".to_string();
    invalid_close.subtype = Some(ACTIVITY_SUBTYPE_POSITION_CLOSE.to_string());
    invalid_close.activity_date = "2026-10-01T10:30:00Z".parse().unwrap();
    input.activities.push(invalid_close);
    let h = harness(input).await;
    let result = h
        .coordinator
        .run_job(
            PortfolioJobRequest {
                force_full: true,
                ..request()
            },
            &SilentObserver,
        )
        .await
        .unwrap();
    assert!(result.failures.is_empty());
    let engine_issues = h.store.activity_issues(&["business".to_string()]).unwrap();
    assert!(engine_issues.iter().any(
        |issue| issue.activity_id == "long-close" && issue.kind == ActivityIssueKind::Rejected
    ));
    let issues = sales(&h, &h.activity_repo.all()).await;
    let ids: Vec<_> = issues
        .iter()
        .map(|issue| issue.record_id.as_str())
        .collect();
    assert_eq!(ids, ["long-close"]);
}
