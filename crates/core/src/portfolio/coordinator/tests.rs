//! Coordinator over the in-memory doubles: marker-driven refolds and
//! revalues, windowed persistence, and parity with the kernel goldens.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::sync::{Arc, RwLock};

use rust_decimal::Decimal;
use rust_decimal_macros::dec;

use super::*;
use crate::accounts::AccountRepositoryTrait;
use crate::activities::{Activity, ActivityRepositoryTrait};
use crate::assets::AssetRepositoryTrait;
use crate::fx::{FxRepositoryTrait, FxService};
use crate::lots::LotRepositoryTrait;
use crate::portfolio::projection::{ActivityIssueKind, GENESIS};
use crate::portfolio::snapshot::{
    AccountStateSnapshot, SnapshotRepositoryTrait, SnapshotService, SnapshotServiceTrait,
    SnapshotSource,
};
use crate::portfolio::valuation::ValuationRepositoryTrait;
use crate::quotes::{Quote, QuoteServiceTrait};
use crate::test_support::in_memory::*;
use crate::test_support::scenario::{as_of_instant, load_all_scenarios, Scenario, ScenarioFacts};

struct Harness {
    coordinator: PortfolioCoordinator,
    account_repo: Arc<InMemoryAccountRepository>,
    activity_repo: Arc<InMemoryActivityRepository>,
    quote_service: Arc<InMemoryQuoteService>,
    fx_repo: Arc<InMemoryFxRepository>,
    valuation_repo: Arc<dyn ValuationRepositoryTrait>,
    snapshot_repo: Arc<dyn SnapshotRepositoryTrait>,
    lot_repo: Arc<dyn LotRepositoryTrait>,
    projections: Arc<dyn ProjectionStoreTrait>,
    store: Arc<InMemoryProjectionStore>,
    sources: FactSources,
    base_currency: Arc<RwLock<String>>,
    timezone: Arc<RwLock<String>>,
    _clock: crate::utils::clock::FrozenClock,
}

fn scenario(id: &str) -> Scenario {
    load_all_scenarios()
        .into_iter()
        .find(|s| s.id == id)
        .unwrap_or_else(|| panic!("scenario {id} not found"))
}

/// Short fixtures: two-day windows exercise every window boundary.
async fn harness(facts: ScenarioFacts) -> Harness {
    harness_with(facts, WindowCadence::Days(2)).await
}

async fn harness_with(facts: ScenarioFacts, cadence: WindowCadence) -> Harness {
    let clock = crate::utils::clock::freeze(as_of_instant(facts.as_of, &facts.timezone));
    let base_currency = Arc::new(RwLock::new(facts.base_currency.clone()));
    let timezone = Arc::new(RwLock::new(facts.timezone.clone()));
    let archived: HashSet<String> = facts
        .accounts
        .iter()
        .filter(|a| a.is_archived)
        .map(|a| a.id.clone())
        .collect();
    let activity_ids: HashSet<String> = facts.activities.iter().map(|a| a.id.clone()).collect();
    let asset_ids: HashSet<String> = facts.assets.iter().map(|a| a.id.clone()).collect();

    let account_repo = Arc::new(InMemoryAccountRepository::new(facts.accounts.clone()));
    let account_repo_dyn: Arc<dyn AccountRepositoryTrait> = account_repo.clone();
    let asset_repo: Arc<dyn AssetRepositoryTrait> =
        Arc::new(InMemoryAssetRepository::new(facts.assets.clone()));
    let activity_repo = Arc::new(InMemoryActivityRepository::new(
        facts.activities.clone(),
        archived.clone(),
    ));
    let activity_repo_dyn: Arc<dyn ActivityRepositoryTrait> = activity_repo.clone();
    let snapshot_repo: Arc<dyn SnapshotRepositoryTrait> =
        Arc::new(InMemorySnapshotRepository::new(archived));
    let valuation_repo: Arc<dyn ValuationRepositoryTrait> =
        Arc::new(InMemoryValuationRepository::default());
    let lot_repo: Arc<dyn LotRepositoryTrait> =
        Arc::new(InMemoryLotRepository::new(activity_ids, asset_ids));
    let quote_service = Arc::new(InMemoryQuoteService::new(
        facts.quotes.clone(),
        facts.assets.clone(),
    ));
    let quote_service_dyn: Arc<dyn QuoteServiceTrait> = quote_service.clone();
    let fx_repo = Arc::new(InMemoryFxRepository::new(facts.fx_rates.clone()));
    let fx_repo_dyn: Arc<dyn FxRepositoryTrait> = fx_repo.clone();
    let fx_service = Arc::new(FxService::new(fx_repo.clone()));
    fx_service.initialize().expect("fx converter initializes");
    let snapshot_service = Arc::new(SnapshotService::new(
        timezone.clone(),
        account_repo_dyn.clone(),
        snapshot_repo.clone(),
        activity_repo_dyn.clone(),
    ));
    let store = Arc::new(InMemoryProjectionStore::new(
        snapshot_repo.clone(),
        lot_repo.clone(),
        valuation_repo.clone(),
    ));
    let projections: Arc<dyn ProjectionStoreTrait> = store.clone();
    let sources = FactSources {
        accounts: account_repo_dyn,
        activities: activity_repo_dyn,
        assets: asset_repo,
        quotes: quote_service_dyn,
        fx_rates: fx_repo_dyn,
        snapshots: snapshot_repo.clone(),
        projections: projections.clone(),
    };
    let coordinator = PortfolioCoordinator::new(CoordinatorDeps {
        base_currency: base_currency.clone(),
        timezone: timezone.clone(),
        sources: sources.clone(),
        fx_service,
        snapshot_service,
        projections: projections.clone(),
        lots: lot_repo.clone(),
        window_cadence: cadence,
    });
    snapshot_repo
        .save_snapshots(&facts.observed_snapshots)
        .await
        .expect("observed snapshots seeded");
    Harness {
        coordinator,
        account_repo,
        activity_repo,
        quote_service,
        fx_repo,
        valuation_repo,
        snapshot_repo,
        lot_repo,
        projections,
        store,
        sources,
        base_currency,
        timezone,
        _clock: clock,
    }
}

impl Harness {
    /// Applies activity changes to the doubles and records what the SQLite
    /// triggers would: each changed row's account from the day before its
    /// UTC date, its transfer partners from theirs, and a split's asset.
    /// `before` holds the rows as they were (updates and deletions mark their
    /// old date too).
    fn change_activities(
        &self,
        added: Vec<Activity>,
        updated: Vec<Activity>,
        removed: &[String],
        before: &[Activity],
    ) {
        let mut changed: Vec<Activity> = added.iter().chain(&updated).cloned().collect();
        changed.extend(
            before
                .iter()
                .filter(|a| removed.contains(&a.id) || updated.iter().any(|u| u.id == a.id))
                .cloned(),
        );
        self.activity_repo.apply(added, updated, removed);
        let mut all = before.to_vec();
        all.extend(changed.iter().cloned());
        for activity in &changed {
            self.mark_activity(activity);
            if let (Some(asset), "SPLIT") = (&activity.asset_id, activity.effective_type()) {
                self.store.mark(MarkerScope::Asset(asset.clone()), GENESIS);
            }
            if let Some(group) = &activity.source_group_id {
                for partner in all.iter().filter(|a| {
                    a.source_group_id.as_ref() == Some(group) && a.account_id != activity.account_id
                }) {
                    self.mark_activity(partner);
                }
            }
        }
    }

    fn mark_activity(&self, activity: &Activity) {
        let day = activity.activity_date.date_naive().pred_opt().unwrap();
        self.store
            .mark(MarkerScope::Account(activity.account_id.clone()), day);
    }

    fn add_quotes(&self, quotes: Vec<Quote>) {
        for quote in &quotes {
            self.store.mark(
                MarkerScope::Prices(quote.asset_id.clone()),
                quote.timestamp.date_naive(),
            );
        }
        self.quote_service.add_quotes(quotes);
    }

    fn rows(&self, account: &str) -> Vec<crate::portfolio::valuation::DailyAccountValuation> {
        self.valuation_repo
            .get_historical_valuations(account, None, None)
            .unwrap()
    }
}

fn request() -> PortfolioJobRequest {
    PortfolioJobRequest {
        account_ids: None,
        market_sync: MarketSyncMode::None,
        ..PortfolioJobRequest::default()
    }
}

// The in-memory repositories have no triggers: these tests set the marker the
// SQL trigger writes (rules §5, pinned by the storage tests) and check the job
// does what the marker asks.

#[tokio::test]
async fn an_account_arriving_after_its_snapshot_is_projected() {
    let mut facts = scenario("EDGE-MIX-02").facts();
    let all_accounts = facts.accounts.clone();
    facts.accounts.retain(|a| a.id != "acc-h");
    let mut h = harness(facts).await;
    // Its snapshot's marker: a job cannot project an account it does not
    // know, and consumes the marker.
    h.store.mark(MarkerScope::Account("acc-h".into()), GENESIS);
    let first = h
        .coordinator
        .run_job(request(), &SilentObserver)
        .await
        .unwrap();
    assert!(first.failures.is_empty());
    assert!(h.rows("acc-h").is_empty());
    // The account arrives; its insert marks it from the beginning.
    h.coordinator.deps.sources.accounts = Arc::new(InMemoryAccountRepository::new(all_accounts));
    h.store.mark(MarkerScope::Account("acc-h".into()), GENESIS);
    let second = h
        .coordinator
        .run_job(request(), &SilentObserver)
        .await
        .unwrap();
    assert!(second.failures.is_empty());
    assert!(!h.rows("acc-h").is_empty());
}

#[tokio::test]
async fn a_lot_selection_change_is_validated() {
    let h = harness(scenario("NOM-TRADE-01").facts()).await;
    let first = h
        .coordinator
        .run_job(request(), &SilentObserver)
        .await
        .unwrap();
    assert!(first.failures.is_empty());
    let account = first.account_ids[0].clone();
    h.account_repo.set_meta(
        &account,
        r#"{"accounting":{"lotSelectionStrategy":"HIGHEST_COST"}}"#,
    );
    h.store.mark(MarkerScope::Account(account.clone()), GENESIS);
    let second = h
        .coordinator
        .run_job(request(), &SilentObserver)
        .await
        .unwrap();
    assert!(second
        .failures
        .iter()
        .any(|f| f.account_id == account && f.code == "UNSUPPORTED_COST_BASIS"));
}

/// Rules R1.5: every read of a holdings snapshot on a later day (holdings,
/// account values, net worth) carries its quantities across the splits
/// recorded since, as valuation does, so it agrees with the stored rows.
#[tokio::test]
async fn a_holdings_snapshot_read_after_its_splits_agrees_with_its_valuation() {
    // EDGE-SPLIT-03 without its second snapshot: acc-h holds 10 x and 10 y
    // from 01-01; both split 2:1 on 01-03, x recorded on acc-h, y on acc-t.
    let mut facts = scenario("EDGE-SPLIT-03").facts();
    let first = NaiveDate::from_ymd_opt(2025, 1, 1).unwrap();
    facts
        .observed_snapshots
        .retain(|s| s.snapshot_date == first);
    let h = harness(facts).await;
    h.coordinator
        .run_job(request(), &SilentObserver)
        .await
        .unwrap();
    let snapshots = SnapshotService::new(
        h.timezone.clone(),
        h.account_repo.clone(),
        h.snapshot_repo.clone(),
        h.activity_repo.clone(),
    );
    let held = |snapshot: &AccountStateSnapshot| -> BTreeMap<String, (Decimal, Decimal)> {
        snapshot
            .positions
            .iter()
            .map(|(asset, p)| (asset.clone(), (p.quantity, p.average_cost)))
            .collect()
    };
    let expected = |quantity: Decimal, average_cost: Decimal| {
        BTreeMap::from([
            ("x".to_string(), (quantity, average_cost)),
            ("y".to_string(), (quantity, average_cost)),
        ])
    };
    let read = |day: u32| {
        snapshots
            .get_latest_snapshots_as_of(
                &["acc-h".to_string()],
                NaiveDate::from_ymd_opt(2025, 1, day).unwrap(),
            )
            .unwrap()
            .remove("acc-h")
            .unwrap()
    };
    assert_eq!(held(&read(2)), expected(dec!(10), dec!(5)), "as entered");
    assert_eq!(held(&read(3)), expected(dec!(20), dec!(2.5)), "split");

    // Read today (01-04), as the holdings page does: 20 x at 10 and 20 y at
    // 5 is the 300 the stored row for today holds.
    let today = snapshots
        .get_latest_holdings_snapshot("acc-h")
        .unwrap()
        .unwrap();
    assert_eq!(held(&today), expected(dec!(20), dec!(2.5)));
    let row = h.rows("acc-h").pop().unwrap();
    assert_eq!(
        (row.valuation_date, row.total_value),
        (NaiveDate::from_ymd_opt(2025, 1, 4).unwrap(), dec!(300))
    );
    // The snapshot itself stays as entered.
    let stored = h
        .snapshot_repo
        .get_latest_snapshot_before_date("acc-h", NaiveDate::from_ymd_opt(2025, 1, 4).unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(held(&stored), expected(dec!(10), dec!(5)));
}

/// Rules R1.1: a transactions account's holdings are the projection's. A
/// snapshot it kept from holdings mode (imported or entered, newer than its
/// last projected one) stays stored but is not read.
#[tokio::test]
async fn a_snapshot_kept_from_holdings_mode_is_not_read_on_a_transactions_account() {
    let facts = scenario("EDGE-SPLIT-03").facts();
    let as_of = facts.as_of;
    let h = harness(facts).await;
    h.coordinator
        .run_job(request(), &SilentObserver)
        .await
        .unwrap();
    let projected = h
        .snapshot_repo
        .get_latest_snapshot_before_date("acc-t", as_of)
        .unwrap()
        .unwrap();
    assert_eq!(projected.source, SnapshotSource::Calculated);
    assert!(projected.snapshot_date < as_of);
    // What broker sync saved while the account tracked holdings.
    let kept = AccountStateSnapshot {
        id: AccountStateSnapshot::stable_id("acc-t", as_of),
        snapshot_date: as_of,
        positions: Default::default(),
        cash_balances: [(projected.currency.clone(), dec!(25000))].into(),
        source: SnapshotSource::BrokerImported,
        ..projected.clone()
    };
    h.snapshot_repo.save_snapshots(&[kept]).await.unwrap();

    let snapshots = SnapshotService::new(
        h.timezone.clone(),
        h.account_repo.clone(),
        h.snapshot_repo.clone(),
        h.activity_repo.clone(),
    );
    let read = |snapshot: Option<AccountStateSnapshot>| {
        snapshot.map(|s| (s.snapshot_date, s.source, s.cash_balances))
    };
    let expected = read(Some(projected.clone()));
    assert_eq!(
        read(
            snapshots
                .get_latest_snapshots_as_of(&["acc-t".to_string()], as_of)
                .unwrap()
                .remove("acc-t")
        ),
        expected,
        "latest as of today"
    );
    assert_eq!(
        read(snapshots.get_latest_holdings_snapshot("acc-t").unwrap()),
        expected,
        "latest holdings"
    );
    assert!(snapshots
        .get_holdings_keyframes("acc-t", None, None)
        .unwrap()
        .iter()
        .all(|s| s.source == SnapshotSource::Calculated));
    assert_eq!(
        read(
            snapshots
                .get_holdings_timeline("acc-t", None, None)
                .unwrap()
                .snapshot_at(as_of)
                .cloned()
        ),
        expected,
        "timeline today"
    );
    // The kept snapshot stays stored, for a switch back to holdings mode.
    assert_eq!(
        h.snapshot_repo
            .get_latest_snapshot_before_date("acc-t", as_of)
            .unwrap()
            .unwrap()
            .source,
        SnapshotSource::BrokerImported
    );
}

/// A transactions account's snapshots are projections: its lots split only
/// on its own split rows (rules R1.5), so a split recorded on another
/// account after its latest snapshot leaves it as projected.
#[tokio::test]
async fn a_transactions_snapshot_is_not_carried_across_another_accounts_split() {
    // EDGE-SPLIT-03 with y's split recorded on acc-h, and acc-t holding 10 y
    // bought on 01-01.
    let mut facts = scenario("EDGE-SPLIT-03").facts();
    let split = facts
        .activities
        .iter_mut()
        .find(|a| a.id == "split-y")
        .unwrap();
    split.account_id = "acc-h".to_string();
    let mut buy = split.clone();
    buy.id = "buy-y".to_string();
    buy.account_id = "acc-t".to_string();
    buy.activity_type = "BUY".to_string();
    buy.activity_date = as_of_instant(NaiveDate::from_ymd_opt(2025, 1, 1).unwrap(), "UTC");
    buy.quantity = Some(dec!(10));
    buy.unit_price = Some(dec!(10));
    buy.amount = Some(dec!(100));
    facts.activities.push(buy);
    let h = harness(facts).await;
    h.coordinator
        .run_job(request(), &SilentObserver)
        .await
        .unwrap();
    let snapshots = SnapshotService::new(
        h.timezone.clone(),
        h.account_repo.clone(),
        h.snapshot_repo.clone(),
        h.activity_repo.clone(),
    );
    let read = snapshots
        .get_latest_snapshots_as_of(
            &["acc-t".to_string()],
            NaiveDate::from_ymd_opt(2025, 1, 4).unwrap(),
        )
        .unwrap()
        .remove("acc-t")
        .unwrap();
    assert_eq!(read.positions["y"].quantity, dec!(10));
}

#[tokio::test]
async fn an_asset_arriving_after_its_snapshot_reprices_it() {
    let mut facts = scenario("PERF-HOLD-02").facts();
    facts.quotes.clear();
    let mut arriving = facts.assets.clone();
    for asset in &mut arriving {
        asset.kind = crate::assets::AssetKind::Property;
    }
    facts.assets.clear();
    let mut h = harness(facts).await;
    h.coordinator
        .run_job(request(), &SilentObserver)
        .await
        .unwrap();
    // The assets arrive; each insert marks its holders, snapshot holders
    // included.
    h.coordinator.deps.sources.assets = Arc::new(InMemoryAssetRepository::new(arriving.clone()));
    for asset in &arriving {
        h.store.mark(MarkerScope::Asset(asset.id.clone()), GENESIS);
    }
    h.coordinator
        .run_job(request(), &SilentObserver)
        .await
        .unwrap();
    // Everything a rebuild from scratch gives, but when it was calculated.
    let rows = |h: &Harness| {
        let mut rows = h.rows("acc-h");
        for row in &mut rows {
            row.calculated_at = chrono::DateTime::<chrono::Utc>::MIN_UTC;
        }
        rows
    };
    let projected = rows(&h);
    h.coordinator
        .run_job(
            PortfolioJobRequest {
                force_full: true,
                ..request()
            },
            &SilentObserver,
        )
        .await
        .unwrap();
    assert_eq!(projected, rows(&h));
}

#[tokio::test]
async fn an_fx_asset_arriving_after_its_rates_revalues_conversions() {
    use chrono::TimeZone;
    use rust_decimal::Decimal;
    use std::collections::HashMap;
    // A holdings account of 100 EUR in a USD portfolio, EUR/USD at 1.
    let mut facts = scenario("EDGE-MIX-04").facts();
    facts.activities.clear();
    facts.accounts[0].currency = "EUR".into();
    facts.observed_snapshots.truncate(1);
    facts.observed_snapshots[0].currency = "EUR".into();
    facts.observed_snapshots[0].cash_balances = HashMap::from([("EUR".into(), Decimal::from(100))]);
    facts.fx_rates = vec![crate::fx::ExchangeRate {
        id: "old-fx".into(),
        from_currency: "EUR".into(),
        to_currency: "USD".into(),
        rate: Decimal::ONE,
        source: "MANUAL".into(),
        timestamp: chrono::Utc.with_ymd_and_hms(2025, 1, 1, 12, 0, 0).unwrap(),
    }];
    let h = harness(facts).await;
    h.coordinator
        .run_job(request(), &SilentObserver)
        .await
        .unwrap();
    // A sync batch delivers a rate of 2 before its FX asset: the rate's own
    // trigger marks it as a price, the asset's insert as a holder change and
    // as conversions from the rate's day.
    let day = NaiveDate::from_ymd_opt(2025, 1, 3).unwrap();
    h.fx_repo.add_rates(vec![crate::fx::ExchangeRate {
        id: "batch-fx".into(),
        from_currency: "EUR".into(),
        to_currency: "USD".into(),
        rate: Decimal::from(2),
        source: "MANUAL".into(),
        timestamp: chrono::Utc.with_ymd_and_hms(2025, 1, 3, 12, 0, 0).unwrap(),
    }]);
    h.store.mark(MarkerScope::Prices("batch-fx".into()), day);
    h.store.mark(MarkerScope::Asset("batch-fx".into()), GENESIS);
    h.store.mark(MarkerScope::Fx("batch-fx".into()), day);
    let report = h
        .coordinator
        .run_job(request(), &SilentObserver)
        .await
        .unwrap();
    assert!(report.failures.is_empty());
    let value = h
        .rows("acc-h")
        .into_iter()
        .find(|row| row.valuation_date == day)
        .unwrap()
        .total_value_base;
    assert_eq!(value, Decimal::from(200));
}

fn plan_of(report: &PortfolioJobReport, account: &str) -> Option<RebuildPlan> {
    report
        .plans
        .iter()
        .find(|p| p.account_id == account)
        .map(|p| p.plan)
}

#[tokio::test]
async fn a_run_persists_rows_and_consumes_its_markers() {
    let scenario = scenario("NOM-TRADE-01");
    let harness = harness(scenario.facts()).await;
    assert!(!harness.projections.pending_markers().unwrap().is_empty());
    let report = harness
        .coordinator
        .run_job(request(), &SilentObserver)
        .await
        .unwrap();
    assert!(report.failures.is_empty(), "{:?}", report.failures);

    let account = &report.account_ids[0];
    assert_eq!(
        plan_of(&report, account),
        Some(RebuildPlan::Refold { from: GENESIS })
    );
    let valuations = harness.rows(account);
    assert!(!valuations.is_empty(), "valuation rows persisted");
    assert!(valuations.iter().all(|v| v.account_id == *account));
    assert!(!harness
        .snapshot_repo
        .get_snapshots_by_account(account, None, None)
        .unwrap()
        .is_empty());
    assert!(!harness
        .lot_repo
        .get_all_lots_for_account(account)
        .await
        .unwrap()
        .is_empty());
    assert!(harness.projections.pending_markers().unwrap().is_empty());
    assert!(harness.coordinator.stale_accounts().unwrap().is_empty());

    // Nothing stale: nothing planned.
    let again = harness
        .coordinator
        .run_job(request(), &SilentObserver)
        .await
        .unwrap();
    assert!(again.plans.is_empty(), "{:?}", again.plans);
}

/// The kernel golden of a scenario (the insta header stripped).
fn kernel_golden(id: &str) -> Option<serde_yaml::Value> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../portfolio-engine/tests/fixtures/goldens/kernel")
        .join(format!("{id}.snap"));
    let text = std::fs::read_to_string(path).ok()?;
    let body = text.splitn(3, "---\n").nth(2)?;
    serde_yaml::from_str(body).ok()
}

fn golden_str(value: &serde_yaml::Value, key: &str) -> String {
    match value.get(key) {
        Some(serde_yaml::Value::String(s)) => s.clone(),
        Some(other) => serde_yaml::to_string(other)
            .unwrap_or_default()
            .trim()
            .to_string(),
        None => String::new(),
    }
}

fn golden_decimal(value: &serde_yaml::Value, key: &str) -> rust_decimal::Decimal {
    golden_str(value, key).parse().unwrap_or_default()
}

fn same_status(row: &str, golden: &str) -> bool {
    row.to_ascii_lowercase().replace('_', "") == golden.to_ascii_lowercase().replace('_', "")
}

/// Every parity scenario through the real fact loading, row mapping and
/// persistence, one two-day window at a time and in yearly windows: the
/// stored valuations, lots and keyframes must equal the kernel golden
/// (architecture §3.3). Nothing here asserts mere non-emptiness.
#[tokio::test]
async fn every_parity_scenario_persists_the_kernel_golden() {
    for cadence in [WindowCadence::Days(2), WindowCadence::Year] {
        assert_parity(cadence).await;
    }
}

async fn assert_parity(cadence: WindowCadence) {
    let mut compared = 0;
    for scenario in load_all_scenarios()
        .into_iter()
        .filter(|s| s.is_parity_eligible())
    {
        let Some(golden) = kernel_golden(&scenario.id) else {
            panic!("{}: no kernel golden", scenario.id);
        };
        let facts = scenario.facts();
        let harness = harness_with(facts.clone(), cadence).await;
        let report = harness
            .coordinator
            .run_job(request(), &SilentObserver)
            .await
            .unwrap();
        assert!(
            report.failures.is_empty(),
            "{}: {:?}",
            scenario.id,
            report.failures
        );
        assert!(
            harness.coordinator.stale_accounts().unwrap().is_empty(),
            "{}: stale after rebuild",
            scenario.id
        );
        let accounts = golden["baseline"]["accounts"]
            .as_mapping()
            .expect("golden accounts");
        for (account_id, expected) in accounts {
            let account_id = account_id.as_str().unwrap();
            let Some(account) = facts.accounts.iter().find(|a| a.id == account_id) else {
                continue;
            };
            if account.is_archived {
                continue;
            }
            let label = format!("{}: {account_id}", scenario.id);
            let rows = harness
                .valuation_repo
                .get_historical_valuations(account_id, None, None)
                .unwrap();
            let expected_rows = expected["valuations"]
                .as_sequence()
                .cloned()
                .unwrap_or_default();
            assert_eq!(
                rows.len(),
                expected_rows.len(),
                "{label}: valuation row count"
            );
            for (row, want) in rows.iter().zip(&expected_rows) {
                assert_eq!(
                    row.valuation_date.to_string(),
                    golden_str(want, "date"),
                    "{label}"
                );
                let day = format!("{label} {}", row.valuation_date);
                for (name, actual, key) in [
                    ("total_value_base", row.total_value_base, "total_value_base"),
                    (
                        "cash_balance_base",
                        row.cash_balance_base,
                        "cash_balance_base",
                    ),
                    ("cost_basis_base", row.cost_basis_base, "cost_basis_base"),
                    (
                        "net_contribution_base",
                        row.net_contribution_base,
                        "net_contribution_base",
                    ),
                    (
                        "external_inflow_base",
                        row.external_inflow_base,
                        "external_inflow_base",
                    ),
                    (
                        "external_outflow_base",
                        row.external_outflow_base,
                        "external_outflow_base",
                    ),
                ] {
                    assert_eq!(
                        actual.round_dp(8).normalize(),
                        golden_decimal(want, key).normalize(),
                        "{day}: {name}"
                    );
                }
                assert!(
                    same_status(row.value_status.as_str(), &golden_str(want, "value_status")),
                    "{day}: value_status {:?} != {}",
                    row.value_status,
                    golden_str(want, "value_status")
                );
            }
            if account.tracking_mode == crate::accounts::TrackingMode::Holdings {
                continue;
            }
            let lots = harness
                .lot_repo
                .get_all_lots_for_account(account_id)
                .await
                .unwrap();
            let expected_lots = expected["lots"].as_sequence().cloned().unwrap_or_default();
            assert_eq!(lots.len(), expected_lots.len(), "{label}: lot count");
            for want in &expected_lots {
                let id = golden_str(want, "id");
                let lot = lots
                    .iter()
                    .find(|l| l.id == id)
                    .unwrap_or_else(|| panic!("{label}: lot {id} not persisted"));
                // Goldens print decimals at 8 places; rows keep full precision.
                let stored = |raw: &str| {
                    raw.parse::<rust_decimal::Decimal>()
                        .unwrap()
                        .round_dp(8)
                        .normalize()
                };
                assert_eq!(
                    stored(&lot.remaining_quantity),
                    golden_decimal(want, "remaining_quantity").normalize(),
                    "{label}: lot {id} remaining quantity"
                );
                assert_eq!(
                    stored(&lot.remaining_cost_basis),
                    golden_decimal(want, "remaining_cost_basis").normalize(),
                    "{label}: lot {id} remaining cost basis"
                );
            }
            let keyframes = harness
                .snapshot_repo
                .get_snapshots_by_account(account_id, None, None)
                .unwrap();
            let expected_keyframes = expected["keyframes"]
                .as_sequence()
                .map(|k| k.len())
                .unwrap_or(0);
            assert_eq!(
                keyframes.len(),
                expected_keyframes,
                "{label}: keyframe count"
            );
            let disposals = harness
                .lot_repo
                .get_lot_disposals_for_account(account_id)
                .await
                .unwrap();
            let expected_disposals = expected["disposals"]
                .as_sequence()
                .cloned()
                .unwrap_or_default();
            assert_eq!(
                disposals.len(),
                expected_disposals.len(),
                "{label}: disposal count"
            );
            for want in &expected_disposals {
                let activity = golden_str(want, "activity_id");
                let realized = golden_decimal(want, "realized_pnl_base").normalize();
                assert!(
                    disposals.iter().any(|d| {
                        activity.starts_with(&d.disposal_activity_id)
                            && d.realized_pnl_base
                                .parse::<rust_decimal::Decimal>()
                                .is_ok_and(|v| v.round_dp(8).normalize() == realized)
                    }),
                    "{label}: disposal of {activity} (realized {realized}) not persisted"
                );
            }
        }
        compared += 1;
    }
    assert!(compared >= 81, "only {compared} scenarios compared");
}

fn normalized_valuations(
    mut rows: Vec<crate::portfolio::valuation::DailyAccountValuation>,
) -> Vec<crate::portfolio::valuation::DailyAccountValuation> {
    for row in &mut rows {
        row.calculated_at = chrono::DateTime::<chrono::Utc>::MIN_UTC;
    }
    rows.sort_by(|a, b| {
        (a.account_id.clone(), a.valuation_date).cmp(&(b.account_id.clone(), b.valuation_date))
    });
    rows
}

fn normalized_lots(mut rows: Vec<crate::lots::LotRecord>) -> Vec<crate::lots::LotRecord> {
    for row in &mut rows {
        row.created_at.clear();
        row.updated_at.clear();
    }
    rows.sort_by(|a, b| a.id.cmp(&b.id));
    rows
}

/// LIFE fixtures: after every lifecycle step (appends, backdated edits,
/// deletions, quote backfills, a new day) the incrementally maintained
/// projection must equal a fresh run over the same facts.
#[tokio::test]
async fn lifecycle_steps_match_a_fresh_rebuild() {
    let mut steps_checked = 0;
    let mut plans_seen: HashSet<&str> = HashSet::new();
    for scenario in load_all_scenarios()
        .into_iter()
        .filter(|s| !s.lifecycle.is_empty())
    {
        let baseline = scenario.facts();
        let live = harness(baseline.clone()).await;
        live.coordinator
            .run_job(request(), &SilentObserver)
            .await
            .unwrap();
        for (index, step) in scenario.lifecycle.iter().enumerate() {
            let label = format!("{} step {} ({})", scenario.id, index + 1, step.label);
            let before = scenario.facts_after(index);
            let after = scenario.facts_after(index + 1);
            crate::utils::clock::set_frozen(as_of_instant(after.as_of, &after.timezone));
            let by_id = |ids: &[String]| -> Vec<Activity> {
                after
                    .activities
                    .iter()
                    .filter(|a| ids.contains(&a.id))
                    .cloned()
                    .collect()
            };
            let added: Vec<String> = step.add_activities.iter().map(|a| a.id.clone()).collect();
            let updated: Vec<String> = step
                .update_activities
                .iter()
                .map(|a| a.id.clone())
                .collect();
            live.change_activities(
                by_id(&added),
                by_id(&updated),
                &step.remove_activities,
                &before.activities,
            );
            live.add_quotes(
                after
                    .quotes
                    .iter()
                    .filter(|q| {
                        step.add_quotes.iter().any(|spec| {
                            spec.asset == q.asset_id && spec.day == q.timestamp.date_naive()
                        })
                    })
                    .cloned()
                    .collect(),
            );
            for spec in &step.add_fx_rates {
                let rate = crate::test_support::scenario::fx_rate_from_spec(spec);
                live.store.mark(MarkerScope::Fx(rate.id), spec.day);
            }
            live.fx_repo.add_rates(
                step.add_fx_rates
                    .iter()
                    .map(crate::test_support::scenario::fx_rate_from_spec)
                    .collect(),
            );

            let report = live
                .coordinator
                .try_update_all(MarketSyncMode::None, &SilentObserver)
                .await
                .unwrap();
            assert!(report.failures.is_empty(), "{label}: {:?}", report.failures);
            for plan in &report.plans {
                plans_seen.insert(match plan.plan {
                    RebuildPlan::Refold { from } if from == GENESIS => "full",
                    RebuildPlan::Refold { .. } => "refold",
                    RebuildPlan::Revalue { .. } => "revalue",
                });
            }
            assert!(
                live.coordinator.stale_accounts().unwrap().is_empty(),
                "{label}: stale after the run"
            );

            let fresh = harness(after.clone()).await;
            fresh
                .coordinator
                .run_job(request(), &SilentObserver)
                .await
                .unwrap();
            for account in after.accounts.iter().filter(|a| !a.is_archived) {
                assert_eq!(
                    normalized_valuations(live.rows(&account.id)),
                    normalized_valuations(fresh.rows(&account.id)),
                    "{label}: valuations of {}",
                    account.id
                );
                let incremental = live
                    .lot_repo
                    .get_all_lots_for_account(&account.id)
                    .await
                    .unwrap();
                let rebuilt = fresh
                    .lot_repo
                    .get_all_lots_for_account(&account.id)
                    .await
                    .unwrap();
                assert_eq!(
                    format!("{:#?}", normalized_lots(incremental)),
                    format!("{:#?}", normalized_lots(rebuilt)),
                    "{label}: lots of {}",
                    account.id
                );
            }
            steps_checked += 1;
        }
    }
    assert!(steps_checked > 0, "no lifecycle steps found");
    // The equivalence above only proves the incremental paths if they ran.
    for path in ["refold", "revalue"] {
        assert!(
            plans_seen.contains(path),
            "no lifecycle step took the {path} path"
        );
    }
}

/// Rows dated before `day` are the first run's rows (same stamp); rows from
/// `day` were rewritten by the later run.
fn untouched_before(
    before: &[crate::portfolio::valuation::DailyAccountValuation],
    after: &[crate::portfolio::valuation::DailyAccountValuation],
    day: chrono::NaiveDate,
) {
    for row in after {
        let first = before
            .iter()
            .find(|b| b.valuation_date == row.valuation_date);
        let stamp = first.map(|b| b.calculated_at);
        if row.valuation_date < day {
            assert_eq!(
                Some(row.calculated_at),
                stamp,
                "{} rewritten",
                row.valuation_date
            );
        } else {
            assert_ne!(
                Some(row.calculated_at),
                stamp,
                "{} not rewritten",
                row.valuation_date
            );
        }
    }
}

#[tokio::test]
async fn a_price_change_revalues_from_its_day_only() {
    let scenario = scenario("NOM-TRADE-01");
    let facts = scenario.facts();
    let account = facts.accounts[0].id.clone();
    let live = harness(facts.clone()).await;
    live.coordinator
        .run_job(request(), &SilentObserver)
        .await
        .unwrap();
    let first_run = crate::utils::clock::now();
    let rows_before = live.rows(&account);
    let lots_before = format!(
        "{:#?}",
        live.lot_repo
            .get_all_lots_for_account(&account)
            .await
            .unwrap()
    );

    let template = facts.quotes[0].clone();
    let late = Quote {
        id: "late-quote".to_string(),
        timestamp: template.timestamp + chrono::Duration::days(1),
        close: template.close * rust_decimal_macros::dec!(1.1),
        ..template
    };
    let changed_day = late.timestamp.date_naive();
    crate::utils::clock::set_frozen(first_run + chrono::Duration::hours(1));
    live.add_quotes(vec![late.clone()]);
    let report = live
        .coordinator
        .try_update_all(MarketSyncMode::None, &SilentObserver)
        .await
        .unwrap();
    assert_eq!(
        plan_of(&report, &account),
        Some(RebuildPlan::Revalue { from: changed_day })
    );
    untouched_before(&rows_before, &live.rows(&account), changed_day);
    assert_eq!(
        lots_before,
        format!(
            "{:#?}",
            live.lot_repo
                .get_all_lots_for_account(&account)
                .await
                .unwrap()
        ),
        "a revalue never rewrites lots"
    );

    let mut fresh_facts = facts.clone();
    fresh_facts.quotes.push(late);
    let fresh = harness(fresh_facts).await;
    fresh
        .coordinator
        .run_job(request(), &SilentObserver)
        .await
        .unwrap();
    assert_eq!(
        normalized_valuations(live.rows(&account)),
        normalized_valuations(fresh.rows(&account))
    );
}

#[tokio::test]
async fn a_new_day_revalues_only_the_new_day() {
    let scenario = scenario("NOM-TRADE-01");
    let facts = scenario.facts();
    let account = facts.accounts[0].id.clone();
    let harness = harness(facts.clone()).await;
    harness
        .coordinator
        .run_job(request(), &SilentObserver)
        .await
        .unwrap();
    let rows_before = harness.rows(&account);
    assert!(harness.coordinator.stale_accounts().unwrap().is_empty());

    let tomorrow = facts.as_of + chrono::Duration::days(1);
    crate::utils::clock::set_frozen(as_of_instant(tomorrow, &facts.timezone));
    let stale = harness.coordinator.stale_accounts().unwrap();
    assert!(!stale.is_empty());
    assert!(stale.iter().all(|s| s.reason == StaleReason::DayAdvanced));

    let report = harness
        .coordinator
        .try_update_all(MarketSyncMode::None, &SilentObserver)
        .await
        .unwrap();
    assert!(report.failures.is_empty(), "{:?}", report.failures);
    assert_eq!(
        plan_of(&report, &account),
        Some(RebuildPlan::Revalue { from: tomorrow })
    );
    let rows = harness.rows(&account);
    assert_eq!(rows.last().unwrap().valuation_date, tomorrow);
    untouched_before(&rows_before, &rows, tomorrow);
    assert!(harness.coordinator.stale_accounts().unwrap().is_empty());
}

/// Every account's rows and lots equal those of a fresh run over `facts`.
async fn assert_matches_a_fresh_rebuild(live: &Harness, facts: &ScenarioFacts, label: &str) {
    let fresh = harness(facts.clone()).await;
    fresh
        .coordinator
        .run_job(request(), &SilentObserver)
        .await
        .unwrap();
    for account in facts.accounts.iter().filter(|a| !a.is_archived) {
        assert_eq!(
            normalized_valuations(live.rows(&account.id)),
            normalized_valuations(fresh.rows(&account.id)),
            "{label}: valuations of {}",
            account.id
        );
        let incremental = live
            .lot_repo
            .get_all_lots_for_account(&account.id)
            .await
            .unwrap();
        let rebuilt = fresh
            .lot_repo
            .get_all_lots_for_account(&account.id)
            .await
            .unwrap();
        assert_eq!(
            format!("{:#?}", normalized_lots(incremental)),
            format!("{:#?}", normalized_lots(rebuilt)),
            "{label}: lots of {}",
            account.id
        );
    }
}

/// A split decides how every earlier close of its asset reads: editing one
/// revalues its holders from the beginning, not from the split's day.
#[tokio::test]
async fn a_split_edit_revalues_its_holders_from_the_beginning() {
    let scenario = scenario("EDGE-QT-04");
    let facts = scenario.facts();
    let live = harness(facts.clone()).await;
    live.coordinator
        .run_job(request(), &SilentObserver)
        .await
        .unwrap();

    let mut after = facts.clone();
    let split = after
        .activities
        .iter_mut()
        .find(|a| a.activity_type == "SPLIT")
        .expect("split");
    split.amount = Some(rust_decimal_macros::dec!(4));
    let split = split.clone();
    live.change_activities(Vec::new(), vec![split], &[], &facts.activities);
    let report = live
        .coordinator
        .try_update_all(MarketSyncMode::None, &SilentObserver)
        .await
        .unwrap();
    assert!(report.failures.is_empty(), "{:?}", report.failures);
    assert_matches_a_fresh_rebuild(&live, &after, "split edited").await;
}

/// An activity dated after today is left out of the fold; the day it comes
/// due, the account folds it rather than only valuing the new day.
#[tokio::test]
async fn a_future_activity_is_folded_when_its_day_comes() {
    let scenario = scenario("NOM-TRADE-01");
    let mut facts = scenario.facts();
    let mut deposit = facts
        .activities
        .iter()
        .find(|a| a.activity_type == "DEPOSIT")
        .expect("deposit")
        .clone();
    deposit.id = "scheduled-deposit".to_string();
    deposit.activity_date = as_of_instant(facts.as_of, &facts.timezone) + chrono::Duration::days(2);
    facts.activities.push(deposit);
    let live = harness(facts.clone()).await;
    live.coordinator
        .run_job(request(), &SilentObserver)
        .await
        .unwrap();

    let mut later = facts.clone();
    later.as_of = facts.as_of + chrono::Duration::days(3);
    crate::utils::clock::set_frozen(as_of_instant(later.as_of, &later.timezone));
    let report = live
        .coordinator
        .try_update_all(MarketSyncMode::None, &SilentObserver)
        .await
        .unwrap();
    assert!(report.failures.is_empty(), "{:?}", report.failures);
    let account = &facts.accounts[0].id;
    assert!(
        matches!(plan_of(&report, account), Some(RebuildPlan::Refold { .. })),
        "{:?}",
        plan_of(&report, account)
    );
    assert_matches_a_fresh_rebuild(&live, &later, "scheduled deposit due").await;
}

#[tokio::test]
async fn a_backdated_edit_rewrites_from_its_day_only() {
    let scenario = scenario("NOM-TRADE-01");
    let facts = scenario.facts();
    let account = facts.accounts[0].id.clone();
    let live = harness(facts.clone()).await;
    live.coordinator
        .run_job(request(), &SilentObserver)
        .await
        .unwrap();
    let first_run = crate::utils::clock::now();
    let rows_before = live.rows(&account);

    let mut edited = facts
        .activities
        .iter()
        .filter(|a| a.account_id == account)
        .max_by_key(|a| a.activity_date)
        .unwrap()
        .clone();
    edited.quantity = edited.quantity.map(|q| q * rust_decimal_macros::dec!(2));
    edited.amount = edited.amount.map(|a| a * rust_decimal_macros::dec!(2));
    let dirty_from = edited.activity_date.date_naive().pred_opt().unwrap();
    crate::utils::clock::set_frozen(first_run + chrono::Duration::hours(1));
    live.change_activities(Vec::new(), vec![edited.clone()], &[], &facts.activities);
    let report = live
        .coordinator
        .try_update_all(MarketSyncMode::None, &SilentObserver)
        .await
        .unwrap();
    assert_eq!(
        plan_of(&report, &account),
        Some(RebuildPlan::Refold { from: dirty_from })
    );
    untouched_before(&rows_before, &live.rows(&account), dirty_from);

    let mut after = facts.clone();
    if let Some(slot) = after.activities.iter_mut().find(|a| a.id == edited.id) {
        *slot = edited;
    }
    let fresh = harness(after).await;
    fresh
        .coordinator
        .run_job(request(), &SilentObserver)
        .await
        .unwrap();
    assert_eq!(
        normalized_valuations(live.rows(&account)),
        normalized_valuations(fresh.rows(&account))
    );
    assert_eq!(
        format!(
            "{:#?}",
            normalized_lots(
                live.lot_repo
                    .get_all_lots_for_account(&account)
                    .await
                    .unwrap()
            )
        ),
        format!(
            "{:#?}",
            normalized_lots(
                fresh
                    .lot_repo
                    .get_all_lots_for_account(&account)
                    .await
                    .unwrap()
            )
        )
    );
}

#[tokio::test]
async fn a_deletion_refolds_from_the_deleted_day() {
    let scenario = scenario("NOM-TRADE-01");
    let facts = scenario.facts();
    let account = facts.accounts[0].id.clone();
    let harness = harness(facts.clone()).await;
    harness
        .coordinator
        .run_job(request(), &SilentObserver)
        .await
        .unwrap();
    let removed = facts
        .activities
        .iter()
        .filter(|a| a.account_id == account)
        .max_by_key(|a| a.activity_date)
        .unwrap()
        .clone();
    harness.change_activities(
        Vec::new(),
        Vec::new(),
        std::slice::from_ref(&removed.id),
        &facts.activities,
    );
    let report = harness
        .coordinator
        .try_update_all(MarketSyncMode::None, &SilentObserver)
        .await
        .unwrap();
    assert_eq!(
        plan_of(&report, &account),
        Some(RebuildPlan::Refold {
            from: removed.activity_date.date_naive().pred_opt().unwrap()
        })
    );
}

#[tokio::test]
async fn failures_keep_the_markers_and_are_retried() {
    let scenario = scenario("NOM-TRADE-01");
    let harness = harness(scenario.facts()).await;
    harness.store.fail_next_persists(1);
    let report = harness
        .coordinator
        .run_job_with_retry(request(), &SilentObserver, RetryPolicy::immediate(3))
        .await
        .unwrap();
    assert!(report.failures.is_empty(), "{:?}", report.failures);
    assert!(harness.coordinator.stale_accounts().unwrap().is_empty());

    harness.store.fail_next_persists(5);
    let report = harness
        .coordinator
        .run_job_with_retry(
            PortfolioJobRequest {
                force_full: true,
                ..request()
            },
            &SilentObserver,
            RetryPolicy::immediate(2),
        )
        .await
        .unwrap();
    assert!(!report.failures.is_empty());
    assert!(report
        .failures
        .iter()
        .all(|f| f.code == "PROJECTION_FAILED"));
    assert!(
        !harness.projections.pending_markers().unwrap().is_empty(),
        "a failed run leaves its markers for the next one"
    );
}

#[tokio::test]
async fn concurrent_requests_run_one_after_another() {
    let scenario = scenario("NOM-TRADE-01");
    let harness = harness(scenario.facts()).await;
    let first = harness.coordinator.run_job(request(), &SilentObserver);
    let second = harness.coordinator.run_job(request(), &SilentObserver);
    let (first, second) = tokio::join!(first, second);
    let (first, second) = (first.unwrap(), second.unwrap());
    assert!(first.failures.is_empty() && second.failures.is_empty());
    // One of them did the work; the other found nothing stale.
    assert_eq!(
        [first.plans.is_empty(), second.plans.is_empty()]
            .iter()
            .filter(|empty| **empty)
            .count(),
        1
    );
    assert!(harness.coordinator.stale_accounts().unwrap().is_empty());
}

#[tokio::test]
async fn a_future_dated_only_account_projects_without_failing() {
    let scenario = scenario("NOM-TRADE-01");
    let mut facts = scenario.facts();
    let mut account = facts.accounts[0].clone();
    account.id = "acc-future".to_string();
    account.name = "Future".to_string();
    facts.accounts.push(account);
    let mut deposit = facts.activities[0].clone();
    deposit.id = "future-deposit".to_string();
    deposit.account_id = "acc-future".to_string();
    deposit.activity_type = "DEPOSIT".to_string();
    deposit.asset_id = None;
    deposit.quantity = None;
    deposit.unit_price = None;
    deposit.amount = Some(rust_decimal_macros::dec!(100));
    deposit.activity_date = as_of_instant(facts.as_of, &facts.timezone) + chrono::Duration::days(1);
    facts.activities.push(deposit);
    let harness = harness(facts).await;
    let report = harness
        .coordinator
        .run_job(request(), &SilentObserver)
        .await
        .unwrap();
    assert!(report.failures.is_empty(), "{:?}", report.failures);
    assert!(harness.coordinator.stale_accounts().unwrap().is_empty());
}

#[tokio::test]
async fn an_out_of_policy_observed_snapshot_fails_only_its_account() {
    let scenario = scenario("NOM-OBS-01");
    let facts = scenario.facts();
    let holdings_account = facts
        .accounts
        .iter()
        .find(|a| a.tracking_mode == crate::accounts::TrackingMode::Holdings)
        .expect("holdings account")
        .id
        .clone();
    let harness = harness(facts).await;
    let bad_date = chrono::NaiveDate::from_ymd_opt(224, 7, 20).unwrap();
    harness
        .snapshot_repo
        .save_snapshots(&[manual_snapshot(&holdings_account, bad_date)])
        .await
        .unwrap();
    let report = harness
        .coordinator
        .run_job(request(), &SilentObserver)
        .await
        .unwrap();
    assert_eq!(report.failures.len(), 1, "{:?}", report.failures);
    assert_eq!(report.failures[0].account_id, holdings_account);
    assert_eq!(report.failures[0].code, "INVALID_SNAPSHOT_DATE");
    assert!(harness.rows(&holdings_account).is_empty());
    assert!(
        !harness.projections.pending_markers().unwrap().is_empty(),
        "the markers stay until the account can be projected"
    );
}

/// An account that cannot be projected keeps only its own markers: the
/// others are consumed, so later runs do not rebuild the healthy accounts
/// again, and a price change made meanwhile still reaches the failing
/// account once it is fixed, even when the fix marks it only from a later
/// day.
#[tokio::test]
async fn a_failing_account_holds_back_only_its_own_markers() {
    let scenario = scenario("NOM-MIX-01");
    let facts = scenario.facts();
    let holdings = "acc-h".to_string();
    let live = harness(facts.clone()).await;
    live.coordinator
        .run_job(request(), &SilentObserver)
        .await
        .unwrap();

    // A snapshot dated a month ahead (a typo) makes the account fail; the
    // store's triggers mark it from that day.
    let bad_date = facts.as_of + chrono::Duration::days(30);
    live.snapshot_repo
        .save_snapshots(&[manual_snapshot(&holdings, bad_date)])
        .await
        .unwrap();
    live.store
        .mark(MarkerScope::Account(holdings.clone()), bad_date);
    let pending_scopes = |live: &Harness| -> Vec<MarkerScope> {
        live.projections
            .pending_markers()
            .unwrap()
            .into_iter()
            .map(|m| m.scope)
            .collect()
    };
    let report = live
        .coordinator
        .run_job(request(), &SilentObserver)
        .await
        .unwrap();
    assert_eq!(report.failures.len(), 1, "{:?}", report.failures);
    assert_eq!(report.failures[0].code, "INVALID_SNAPSHOT_DATE");
    assert_eq!(
        pending_scopes(&live),
        vec![MarkerScope::Account(holdings.clone())]
    );

    // Nothing changed: the healthy accounts are not rebuilt again.
    let report = live
        .coordinator
        .run_job(request(), &SilentObserver)
        .await
        .unwrap();
    assert!(report.plans.is_empty(), "{:?}", report.plans);

    // A price changes while the account is out: its holders are revalued
    // and the price marker is consumed.
    let template = facts
        .quotes
        .iter()
        .find(|q| q.timestamp.date_naive().to_string() == "2025-01-09")
        .expect("01-09 close")
        .clone();
    let changed = Quote {
        id: "late-quote".to_string(),
        timestamp: template.timestamp + chrono::Duration::days(1),
        close: template.close * rust_decimal_macros::dec!(1.5),
        ..template
    };
    live.add_quotes(vec![changed.clone()]);
    let report = live
        .coordinator
        .run_job(request(), &SilentObserver)
        .await
        .unwrap();
    assert!(!report.plans.is_empty());
    assert_eq!(
        pending_scopes(&live),
        vec![MarkerScope::Account(holdings.clone())]
    );

    // The typo is removed; the delete trigger marks the account only from
    // the bad day. It still catches up with the price change.
    live.snapshot_repo
        .delete_snapshots_for_account_and_dates(&holdings, &[bad_date])
        .await
        .unwrap();
    live.store
        .mark(MarkerScope::Account(holdings.clone()), bad_date);
    let report = live
        .coordinator
        .run_job(request(), &SilentObserver)
        .await
        .unwrap();
    assert!(report.failures.is_empty(), "{:?}", report.failures);
    assert!(pending_scopes(&live).is_empty());
    let mut after = facts.clone();
    after.quotes.push(changed);
    assert_matches_a_fresh_rebuild(&live, &after, "failing account fixed").await;
}

#[tokio::test]
async fn a_changed_transfer_leg_refolds_its_partner() {
    let scenario = scenario("NOM-TXF-01");
    let facts = scenario.facts();
    let (out, into) = transfer_legs(&facts);
    let harness = harness(facts.clone()).await;
    harness
        .coordinator
        .run_job(request(), &SilentObserver)
        .await
        .unwrap();
    // Only the sending account is marked; the pair brings the receiver in.
    harness.store.mark(
        MarkerScope::Account(out.account_id.clone()),
        out.activity_date.date_naive(),
    );
    let report = harness
        .coordinator
        .run_job(request(), &SilentObserver)
        .await
        .unwrap();
    assert!(matches!(
        plan_of(&report, &into.account_id),
        Some(RebuildPlan::Refold { .. })
    ));
}

/// Settings this version reads but the engine does not compute: a profile
/// other than GENERIC.
const REFUSED_ACCOUNTING: &str =
    r#"{"accounting":{"costBasisMethod":"FIFO","costBasisProfile":"CANADA_ACB"}}"#;

#[tokio::test]
async fn unsupported_cost_basis_settings_fail_the_account() {
    let scenario = scenario("NOM-TRADE-01");
    let facts = scenario.facts();
    let account = facts.accounts[0].id.clone();
    let harness = harness(facts).await;
    harness.account_repo.set_meta(&account, REFUSED_ACCOUNTING);
    let report = harness
        .coordinator
        .run_job(request(), &SilentObserver)
        .await
        .unwrap();
    assert_eq!(report.failures.len(), 1, "{:?}", report.failures);
    assert_eq!(report.failures[0].code, "UNSUPPORTED_COST_BASIS");
    assert!(harness
        .lot_repo
        .get_all_lots_for_account(&account)
        .await
        .unwrap()
        .is_empty());
}

/// Engine rules R7.2: an account whose settings name WAC is computed, not
/// refused, its purchases pool (one lot, one disposal per sale), and its lot
/// and disposal rows record the method they were computed with.
#[tokio::test]
async fn an_account_set_to_wac_is_computed_and_its_rows_record_it() {
    let facts = scenario("NOM-CB-01").facts();
    let account = facts.accounts[0].id.clone();
    let harness = harness(facts).await;
    let report = harness
        .coordinator
        .run_job(request(), &SilentObserver)
        .await
        .unwrap();
    assert!(report.failures.is_empty(), "{:?}", report.failures);
    let lots = harness
        .lot_repo
        .get_all_lots_for_account(&account)
        .await
        .unwrap();
    let disposals = harness
        .lot_repo
        .get_lot_disposals_for_account(&account)
        .await
        .unwrap();
    assert_eq!((lots.len(), disposals.len()), (1, 2));
    assert!(lots.iter().all(|lot| lot.cost_basis_method == "WAC"));
    assert!(disposals.iter().all(|d| d.cost_basis_method == "WAC"));
}

/// Engine rules R7.2: accounts whose settings name LIFO or HIFO are computed,
/// each sale relieving the lots its method orders first, and their rows
/// record the method.
#[tokio::test]
async fn accounts_set_to_lifo_or_hifo_are_computed_and_their_rows_record_it() {
    // (fixture, method, lots, disposals, the lot sell-2 empties)
    for (fixture, method, lot_count, disposal_count, emptied) in [
        ("NOM-CB-02", "LIFO", 3, 2, "buy-3"),
        ("NOM-CB-03", "HIFO", 3, 3, "buy-2"),
    ] {
        let facts = scenario(fixture).facts();
        let account = facts.accounts[0].id.clone();
        let harness = harness(facts).await;
        let report = harness
            .coordinator
            .run_job(request(), &SilentObserver)
            .await
            .unwrap();
        assert!(
            report.failures.is_empty(),
            "{fixture}: {:?}",
            report.failures
        );
        let lots = harness
            .lot_repo
            .get_all_lots_for_account(&account)
            .await
            .unwrap();
        let disposals = harness
            .lot_repo
            .get_lot_disposals_for_account(&account)
            .await
            .unwrap();
        assert_eq!(
            (lots.len(), disposals.len()),
            (lot_count, disposal_count),
            "{fixture}"
        );
        assert!(
            lots.iter().all(|lot| lot.cost_basis_method == method),
            "{fixture}"
        );
        assert!(
            disposals.iter().all(|d| d.cost_basis_method == method),
            "{fixture}"
        );
        let emptied_lot = lots
            .iter()
            .find(|lot| lot.open_activity_id.as_deref() == Some(emptied))
            .unwrap_or_else(|| panic!("{fixture}: no lot for {emptied}"));
        assert!(emptied_lot.is_closed, "{fixture}: {emptied} still open");
    }
}

/// Runs EDGE-TXF-02 (acc-a transfers to acc-b) with acc-a's meta set to
/// `meta` and checks the job refuses acc-a alone, and folds it FIFO as acc-b's
/// transfer partner: acc-b's results are those of an all-FIFO run.
async fn assert_acc_a_refused_and_folded_fifo(meta: &str) {
    let facts = scenario("EDGE-TXF-02").facts();
    let baseline = harness(facts.clone()).await;
    baseline
        .coordinator
        .run_job(request(), &SilentObserver)
        .await
        .unwrap();

    let refused = harness(facts).await;
    refused.account_repo.set_meta("acc-a", meta);
    let report = refused
        .coordinator
        .run_job(request(), &SilentObserver)
        .await
        .unwrap();
    assert_eq!(
        report
            .failures
            .iter()
            .map(|f| (f.account_id.as_str(), f.code.as_str()))
            .collect::<Vec<_>>(),
        vec![("acc-a", "UNSUPPORTED_COST_BASIS")],
        "{meta}"
    );
    let rows = |h: &Harness| {
        let mut rows = h.rows("acc-b");
        for row in &mut rows {
            row.calculated_at = chrono::DateTime::<chrono::Utc>::MIN_UTC;
        }
        rows
    };
    assert!(!rows(&refused).is_empty());
    assert_eq!(rows(&refused), rows(&baseline), "{meta}");
}

/// Engine rules R7.2: an account set to a method the engine does not compute
/// fails alone; folded as a transfer partner it folds FIFO.
#[tokio::test]
async fn a_refused_transfer_partner_folds_fifo() {
    assert_acc_a_refused_and_folded_fifo(REFUSED_ACCOUNTING).await;
}

/// Engine rules R7.2: settings this version cannot read (a code it does not
/// know, an entry that is not an object) are refused the same way: never read
/// as the defaults, and never failing another account.
#[tokio::test]
async fn an_account_whose_settings_cannot_be_read_fails_alone() {
    for meta in [
        r#"{"accounting":{"costBasisMethod":"ACB"}}"#,
        r#"{"accounting":"LIFO"}"#,
    ] {
        assert_acc_a_refused_and_folded_fifo(meta).await;
    }
}

#[tokio::test]
async fn explicitly_requested_archived_accounts_are_rebuilt() {
    let scenario = scenario("NOM-TXF-01");
    let mut facts = scenario.facts();
    let (_, into) = transfer_legs(&facts);
    let archived = into.account_id.clone();
    facts
        .accounts
        .iter_mut()
        .find(|a| a.id == archived)
        .unwrap()
        .is_archived = true;
    let harness = harness(facts).await;
    let report = harness
        .coordinator
        .run_job(
            PortfolioJobRequest {
                account_ids: Some(vec![archived.clone()]),
                force_full: true,
                ..request()
            },
            &SilentObserver,
        )
        .await
        .unwrap();
    assert!(report.failures.is_empty(), "{:?}", report.failures);
    assert!(report.account_ids.contains(&archived));
}

#[tokio::test]
async fn rejected_activities_are_stored_for_the_read_path() {
    let scenario = scenario("EDGE-DRIP-01");
    let facts = scenario.facts();
    let account = facts.accounts[0].id.clone();
    let harness = harness(facts).await;
    let report = harness
        .coordinator
        .run_job(request(), &SilentObserver)
        .await
        .unwrap();
    assert!(report.failures.is_empty(), "{:?}", report.failures);
    let rejected: Vec<_> = harness
        .projections
        .activity_issues(std::slice::from_ref(&account))
        .unwrap()
        .into_iter()
        .filter(|issue| issue.kind == ActivityIssueKind::Rejected)
        .collect();
    assert_eq!(rejected.len(), 1, "{rejected:?}");
    assert_eq!(rejected[0].activity_id, "drip-1");
}

/// The health check reads what the fold decided: an oversell (EDGE-POS-04),
/// a row without an amount (NOM-CASH-04), and the FX directions that
/// disagree (EDGE-FX-10).
#[tokio::test]
async fn the_health_view_reports_the_engine_decisions() {
    use crate::portfolio::coordinator::ProjectionFreshnessTrait;
    let kinds = |id: &str| {
        let id = id.to_string();
        async move {
            let harness = harness(scenario(&id).facts()).await;
            let report = harness
                .coordinator
                .run_job(request(), &SilentObserver)
                .await
                .unwrap();
            assert!(report.failures.is_empty(), "{:?}", report.failures);
            let mut kinds: Vec<(String, ActivityIssueKind)> = harness
                .coordinator
                .activity_issues()
                .unwrap()
                .into_iter()
                .map(|issue| (issue.activity_id, issue.kind))
                .collect();
            kinds.sort_by(|a, b| a.0.cmp(&b.0));
            (kinds, harness.coordinator.fx_conflicts().unwrap())
        }
    };
    let (oversold, _) = kinds("EDGE-POS-04").await;
    assert!(
        oversold
            .iter()
            .any(|(_, kind)| *kind == ActivityIssueKind::Oversold),
        "{oversold:?}"
    );
    let (no_amount, _) = kinds("NOM-CASH-04").await;
    assert!(
        no_amount
            .iter()
            .any(|(_, kind)| *kind == ActivityIssueKind::MissingAmount),
        "{no_amount:?}"
    );
    let (_, conflicts) = kinds("EDGE-FX-10").await;
    assert_eq!(conflicts.len(), 1, "{conflicts:?}");
    assert_eq!(conflicts[0].days, 1);
}

fn manual_snapshot(account_id: &str, date: chrono::NaiveDate) -> AccountStateSnapshot {
    AccountStateSnapshot {
        id: format!("{account_id}_{date}"),
        account_id: account_id.to_string(),
        snapshot_date: date,
        source: SnapshotSource::ManualEntry,
        ..AccountStateSnapshot::default()
    }
}

fn transfer_legs(
    facts: &ScenarioFacts,
) -> (crate::activities::Activity, crate::activities::Activity) {
    let out = facts
        .activities
        .iter()
        .find(|a| a.activity_type == "TRANSFER_OUT")
        .expect("transfer out")
        .clone();
    let into = facts
        .activities
        .iter()
        .find(|a| a.activity_type == "TRANSFER_IN" && a.source_group_id == out.source_group_id)
        .expect("paired transfer in")
        .clone();
    (out, into)
}

#[tokio::test]
async fn manual_snapshots_survive_a_rebuild() {
    let scenario = scenario("NOM-TRADE-01");
    let facts = scenario.facts();
    let account = facts.accounts[0].id.clone();
    let manual_date = facts.as_of - chrono::Duration::days(1);
    let harness = harness(facts).await;
    harness
        .snapshot_repo
        .save_snapshots(&[manual_snapshot(&account, manual_date)])
        .await
        .unwrap();
    harness
        .coordinator
        .run_job(request(), &SilentObserver)
        .await
        .unwrap();
    let snapshots = harness
        .snapshot_repo
        .get_snapshots_by_account(&account, None, None)
        .unwrap();
    assert!(snapshots
        .iter()
        .any(|s| s.snapshot_date == manual_date && s.source == SnapshotSource::ManualEntry));
    assert!(snapshots
        .iter()
        .any(|s| s.source == SnapshotSource::Calculated));
}

#[tokio::test]
async fn one_run_refolds_and_revalues_different_accounts_like_a_fresh_rebuild() {
    // acc-b's deposit changes (acc-b and its transfer partner acc-a refold)
    // while a new close revalues the holdings account acc-h from 01-10: one
    // job writes both kinds, in windows cut at each account's first day.
    let scenario = scenario("NOM-MIX-01");
    let before = scenario.facts();
    let mut after = before.clone();
    let deposit = after
        .activities
        .iter_mut()
        .find(|a| a.id == "dep-2")
        .expect("dep-2");
    deposit.amount = deposit
        .amount
        .map(|amount| amount + rust_decimal_macros::dec!(100));
    let edited: Vec<Activity> = vec![deposit.clone()];
    let template = before
        .quotes
        .iter()
        .find(|q| q.asset_id == "aapl" && q.timestamp.date_naive().to_string() == "2025-01-09")
        .expect("aapl close on 01-09")
        .clone();
    let late = Quote {
        id: "aapl-2025-01-10".to_string(),
        timestamp: template.timestamp + chrono::Duration::days(1),
        close: rust_decimal_macros::dec!(109),
        ..template
    };
    let revalued_from = late.timestamp.date_naive();
    after.quotes.push(late.clone());

    for cadence in [
        WindowCadence::Days(2),
        WindowCadence::Days(3),
        WindowCadence::Year,
    ] {
        let live = harness_with(before.clone(), cadence).await;
        live.coordinator
            .run_job(request(), &SilentObserver)
            .await
            .unwrap();
        live.change_activities(Vec::new(), edited.clone(), &[], &before.activities);
        live.add_quotes(vec![late.clone()]);
        let report = live
            .coordinator
            .run_job(request(), &SilentObserver)
            .await
            .unwrap();
        assert!(
            report.failures.is_empty(),
            "{cadence:?}: {:?}",
            report.failures
        );
        for account in ["acc-a", "acc-b"] {
            assert!(
                matches!(plan_of(&report, account), Some(RebuildPlan::Refold { .. })),
                "{cadence:?}: {account} refolds"
            );
        }
        assert_eq!(
            plan_of(&report, "acc-h"),
            Some(RebuildPlan::Revalue {
                from: revalued_from
            }),
            "{cadence:?}"
        );

        let fresh = harness_with(after.clone(), cadence).await;
        fresh
            .coordinator
            .run_job(request(), &SilentObserver)
            .await
            .unwrap();
        for account in ["acc-a", "acc-b", "acc-h"] {
            assert_eq!(
                normalized_valuations(live.rows(account)),
                normalized_valuations(fresh.rows(account)),
                "{cadence:?}: valuations of {account}"
            );
        }
    }
}

#[tokio::test]
async fn an_fx_rate_revalues_from_its_previous_observation_and_refolds_only_later_activity() {
    // USD/CAD is observed daily to 01-08, then on 01-13. A rate for 01-11 is
    // the nearest one for 01-10 too (and 01-12), so every account revalues
    // from 01-09; acc-1 sells (converting USD) on 01-10 and refolds, acc-2's
    // only activity is its 01-02 deposit, so it just revalues.
    let day = |d: u32| NaiveDate::from_ymd_opt(2025, 1, d).unwrap();
    let mut before = scenario("NOM-FX-01").facts();
    before
        .fx_rates
        .retain(|r| !(day(9)..=day(12)).contains(&r.timestamp.date_naive()));
    let mut second = before.accounts[0].clone();
    second.id = "acc-2".to_string();
    second.name = "CAD savings".to_string();
    before.accounts.push(second);
    let mut deposit = before
        .activities
        .iter()
        .find(|a| a.id == "dep-1")
        .expect("dep-1")
        .clone();
    deposit.id = "dep-2".to_string();
    deposit.account_id = "acc-2".to_string();
    before.activities.push(deposit);

    let mut rate = before
        .fx_rates
        .iter()
        .find(|r| r.timestamp.date_naive() == day(8))
        .expect("01-08 rate")
        .clone();
    rate.timestamp += chrono::Duration::days(3);
    rate.rate = rust_decimal_macros::dec!(1.50);
    let mut after = before.clone();
    after.fx_rates.push(rate.clone());

    let live = harness(before.clone()).await;
    live.coordinator
        .run_job(request(), &SilentObserver)
        .await
        .unwrap();
    live.fx_repo.add_rates(vec![rate.clone()]);
    live.store.mark(MarkerScope::Fx(rate.id.clone()), day(11));
    let report = live
        .coordinator
        .run_job(request(), &SilentObserver)
        .await
        .unwrap();
    assert!(report.failures.is_empty(), "{:?}", report.failures);
    assert_eq!(
        plan_of(&report, "acc-1"),
        Some(RebuildPlan::Refold { from: day(9) })
    );
    assert_eq!(
        plan_of(&report, "acc-2"),
        Some(RebuildPlan::Revalue { from: day(9) })
    );

    let fresh = harness(after).await;
    fresh
        .coordinator
        .run_job(request(), &SilentObserver)
        .await
        .unwrap();
    for account in ["acc-1", "acc-2"] {
        assert_eq!(
            normalized_valuations(live.rows(account)),
            normalized_valuations(fresh.rows(account)),
            "valuations of {account}"
        );
    }
    let realized = |disposals: Vec<crate::lots::LotDisposal>| -> Vec<(String, String)> {
        disposals
            .into_iter()
            .map(|d| (d.disposal_activity_id, d.realized_pnl_base))
            .collect()
    };
    assert_eq!(
        realized(
            live.lot_repo
                .get_lot_disposals_for_account("acc-1")
                .await
                .unwrap()
        ),
        realized(
            fresh
                .lot_repo
                .get_lot_disposals_for_account("acc-1")
                .await
                .unwrap()
        )
    );
}

// ------------------------------------------------------------- app parity

/// What every app path must reproduce: one kernel run over all of a
/// scenario's facts (no window, no scope, no sparse read), stored through
/// the same row mappings the coordinator writes with.
struct Reference {
    valuations: BTreeMap<String, Vec<crate::portfolio::valuation::DailyAccountValuation>>,
    lots: BTreeMap<String, Vec<crate::lots::LotRecord>>,
    disposals: BTreeMap<String, Vec<crate::lots::LotDisposal>>,
    resolved: persist::Resolved,
    rejected: BTreeSet<engine::model::ActivityId>,
}

fn reference(harness: &Harness, facts: &ScenarioFacts) -> Reference {
    use crate::portfolio::snapshot::snapshot_date_requires_remediation;
    let quotes: Vec<engine::model::RawQuote> = harness
        .quote_service
        .get_all_historical_quotes()
        .unwrap()
        .into_values()
        .flatten()
        .map(|(_, quote)| facts::raw_quote(&quote))
        .collect();
    let mut observed = Vec::new();
    for account in facts
        .accounts
        .iter()
        .filter(|a| a.tracking_mode == crate::accounts::TrackingMode::Holdings)
    {
        for snapshot in harness
            .snapshot_repo
            .get_snapshots_by_account(&account.id, None, None)
            .unwrap()
            .iter()
            .filter(|s| {
                s.source != SnapshotSource::Calculated
                    && !snapshot_date_requires_remediation(s.snapshot_date, facts.as_of)
            })
        {
            observed.push(facts::raw_observed_snapshot(snapshot));
        }
    }
    let loaded = facts::LoadedFacts {
        scope: Vec::new(),
        raw: engine::model::RawFacts {
            policy: engine::model::Policy::new(
                engine::model::Currency::parse(&facts.base_currency).unwrap(),
                facts.timezone.parse().unwrap_or(chrono_tz::Tz::UTC),
                facts.as_of,
            ),
            // Each account folds by the method its settings name, as the job
            // reads them (engine rules R7.2).
            accounts: facts
                .accounts
                .iter()
                .map(|account| engine::model::RawAccount {
                    cost_basis_method: Some(
                        account
                            .accounting_settings()
                            .unwrap()
                            .cost_basis_method
                            .as_str()
                            .to_string(),
                    ),
                    ..facts::raw_account(account)
                })
                .collect(),
            assets: facts.assets.iter().map(facts::raw_asset).collect(),
            activities: facts.activities.iter().map(facts::raw_activity).collect(),
            quotes,
            fx_rates: facts.fx_rates.iter().map(facts::raw_fx_rate).collect(),
            observed_snapshots: observed,
        },
        fx_pairs: BTreeMap::new(),
        invalid_snapshot_dates: Vec::new(),
        unsupported_accounts: Vec::new(),
        base_currency: facts.base_currency.clone(),
        timezone: facts.timezone.clone(),
        as_of: facts.as_of,
    };
    let resolved = persist::resolve(&loaded).unwrap();
    let fx = engine::FxResolver {
        surface: &resolved.surfaces.fx,
        policy: resolved.facts.policy(),
    };
    let range = resolved.range();
    let bundle = engine::project(&resolved.ledger, &resolved.facts, &fx, None, range).unwrap();
    let series = engine::value(&engine::ValueInputs {
        resolved: engine::Resolved {
            facts: &resolved.facts,
            ledger: &resolved.ledger,
            surfaces: &resolved.surfaces,
            range,
        },
        bundle: &bundle,
        lots: None,
    });
    let records = engine::lot_records(&bundle, &resolved.facts, &fx);
    let mut valuations = BTreeMap::new();
    let mut lots = BTreeMap::new();
    let mut disposals = BTreeMap::new();
    for account in facts.accounts.iter().filter(|a| !a.is_archived) {
        let id = engine::model::AccountId::new(account.id.as_str());
        valuations.insert(
            account.id.clone(),
            series
                .get(&id)
                .map(|s| persist::valuation_rows(s, &account.id, &facts.base_currency))
                .unwrap_or_default(),
        );
        lots.insert(
            account.id.clone(),
            persist::lot_rows(&resolved, records.clone(), &account.id),
        );
        let own: Vec<&engine::model::LotDisposal> = bundle
            .disposals
            .iter()
            .filter(|d| d.account == id)
            .collect();
        disposals.insert(
            account.id.clone(),
            persist::disposal_rows(&resolved, &own, &account.id),
        );
    }
    let rejected = bundle.rejected_activities();
    Reference {
        valuations,
        lots,
        disposals,
        resolved,
        rejected,
    }
}

fn normalized_disposals(mut rows: Vec<crate::lots::LotDisposal>) -> Vec<crate::lots::LotDisposal> {
    for row in &mut rows {
        row.created_at.clear();
    }
    rows.sort_by(|a, b| a.id.cmp(&b.id));
    rows
}

/// The first difference between two row lists, field by field.
fn first_difference<T: serde::Serialize>(app: &[T], kernel: &[T]) -> Option<String> {
    let app: Vec<serde_json::Value> = app
        .iter()
        .map(|r| serde_json::to_value(r).unwrap())
        .collect();
    let kernel: Vec<serde_json::Value> = kernel
        .iter()
        .map(|r| serde_json::to_value(r).unwrap())
        .collect();
    for (index, (a, k)) in app.iter().zip(&kernel).enumerate() {
        if a == k {
            continue;
        }
        let fields: Vec<String> = a
            .as_object()
            .into_iter()
            .flatten()
            .filter(|(key, value)| k.get(key.as_str()) != Some(value))
            .map(|(key, value)| format!("{key}: app {value} kernel {}", k[key.as_str()]))
            .collect();
        let at = a
            .get("valuation_date")
            .or_else(|| a.get("id"))
            .cloned()
            .unwrap_or_default();
        return Some(format!("row {index} ({at}): {}", fields.join(", ")));
    }
    (app.len() != kernel.len()).then(|| format!("{} rows, kernel {}", app.len(), kernel.len()))
}

/// Where the stored projection of `accounts` differs from the reference.
async fn stored_differences(
    harness: &Harness,
    reference: &Reference,
    accounts: &[String],
    label: &str,
) -> Vec<String> {
    let mut found = Vec::new();
    for account in accounts {
        let mut note = |what: &str, difference: Option<String>| {
            if let Some(difference) = difference {
                found.push(format!("{label}: {what} of {account}: {difference}"));
            }
        };
        note(
            "valuations",
            first_difference(
                &normalized_valuations(harness.rows(account)),
                &normalized_valuations(reference.valuations[account].clone()),
            ),
        );
        let stored = harness
            .lot_repo
            .get_all_lots_for_account(account)
            .await
            .unwrap();
        note(
            "lots",
            first_difference(
                &normalized_lots(stored),
                &normalized_lots(reference.lots[account].clone()),
            ),
        );
        let stored = harness
            .lot_repo
            .get_lot_disposals_for_account(account)
            .await
            .unwrap();
        note(
            "disposals",
            first_difference(
                &normalized_disposals(stored),
                &normalized_disposals(reference.disposals[account].clone()),
            ),
        );
    }
    found
}

/// Where the read path's performance differs from the kernel's over the
/// reference.
async fn read_differences(
    harness: &Harness,
    reference: &Reference,
    accounts: &[String],
    label: &str,
) -> Vec<String> {
    use crate::portfolio::performance::{
        from_kernel, PerformanceService, PerformanceServiceTrait, PerformanceSummaryProfile,
    };
    let service = PerformanceService::new(
        harness.base_currency.clone(),
        harness.timezone.clone(),
        harness.sources.clone(),
        harness.valuation_repo.clone(),
        harness.lot_repo.clone(),
    );
    let all_rows: Vec<_> = reference.valuations.values().flatten().cloned().collect();
    let series = rows::stored_series(&all_rows);
    let lot_rows: Vec<_> = reference.lots.values().flatten().cloned().collect();
    let lots = rows::stored_lots(&lot_rows);
    let disposal_rows: Vec<_> = reference.disposals.values().flatten().cloned().collect();
    let disposals = rows::stored_disposals(&disposal_rows);
    let range = reference.resolved.range();
    let inputs = engine::MeasureInputs {
        effects: engine::effects(
            &engine::Resolved {
                facts: &reference.resolved.facts,
                ledger: &reference.resolved.ledger,
                surfaces: &reference.resolved.surfaces,
                range,
            },
            &disposals,
            &lots,
            &reference.rejected,
        ),
        series: &series,
        lots: &lots,
        disposals: &disposals,
    };
    let mut found = Vec::new();
    let mut compare = |what: String,
                       read: crate::errors::Result<
        crate::portfolio::performance::PerformanceResult,
    >,
                       kernel: std::result::Result<
        engine::model::PerformanceResult,
        engine::EngineError,
    >| {
        let difference = match (read, kernel) {
            (Ok(read), Ok(kernel)) => {
                let read = serde_json::to_value(&read).unwrap();
                let kernel = serde_json::to_value(from_kernel(kernel)).unwrap();
                (read != kernel).then(|| {
                    let keys: Vec<String> = read
                        .as_object()
                        .into_iter()
                        .flatten()
                        .filter(|(key, value)| kernel.get(key.as_str()) != Some(value))
                        .map(|(key, value)| {
                            let short = |v: &serde_json::Value| {
                                v.to_string().chars().take(160).collect::<String>()
                            };
                            format!(
                                "{key}: read {} kernel {}",
                                short(value),
                                short(&kernel[key.as_str()])
                            )
                        })
                        .collect();
                    keys.join("; ")
                })
            }
            (Err(_), Err(_)) => None,
            (read, kernel) => Some(format!(
                "read {:?}, kernel {:?}",
                read.map(|_| ()),
                kernel.map(|_| ())
            )),
        };
        if let Some(difference) = difference {
            found.push(format!("{label}: {what}: {difference}"));
        }
    };
    let modes = std::collections::HashMap::new();
    let types = std::collections::HashMap::new();
    let window = engine::Window::default();
    let full = engine::MeasureProfile::Full;
    for account in accounts {
        let id = engine::model::AccountId::new(account.as_str());
        compare(
            format!("summary of {account}"),
            service
                .calculate_performance_summary(
                    "account",
                    account,
                    None,
                    None,
                    None,
                    None,
                    PerformanceSummaryProfile::Full,
                )
                .await,
            engine::measure_account(&inputs, &id, window, full, false),
        );
        compare(
            format!("history of {account}"),
            service
                .calculate_performance_history("account", account, None, None, None, None)
                .await,
            engine::measure_account(&inputs, &id, window, full, true),
        );
        compare(
            format!("scope of {account}"),
            service
                .calculate_performance_summary_for_accounts(
                    account,
                    std::slice::from_ref(account),
                    "",
                    &modes,
                    &types,
                    None,
                    None,
                    PerformanceSummaryProfile::Full,
                )
                .await,
            engine::measure_scope(
                &inputs,
                account,
                std::slice::from_ref(&id),
                window,
                full,
                false,
            ),
        );
    }
    if accounts.len() > 1 {
        let scope: Vec<engine::model::AccountId> = accounts
            .iter()
            .map(|a| engine::model::AccountId::new(a.as_str()))
            .collect();
        compare(
            "portfolio".to_string(),
            service
                .calculate_performance_summary_for_accounts(
                    "portfolio",
                    accounts,
                    "",
                    &modes,
                    &types,
                    None,
                    None,
                    PerformanceSummaryProfile::Full,
                )
                .await,
            engine::measure_scope(&inputs, "portfolio", &scope, window, full, false),
        );
    }
    found
}

/// Where the app's answer differs from one kernel run over all the facts:
/// at every window cadence (a boundary every day included), when one account
/// is rebuilt on its own, and when performance is read back.
async fn app_differences(facts: &ScenarioFacts, label: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut reference = None;
    for cadence in [
        WindowCadence::Days(1),
        WindowCadence::Days(2),
        WindowCadence::Year,
    ] {
        let harness = harness_with(facts.clone(), cadence).await;
        let report = harness
            .coordinator
            .run_job(request(), &SilentObserver)
            .await
            .unwrap();
        let failed: BTreeSet<&str> = report
            .failures
            .iter()
            .map(|f| f.account_id.as_str())
            .collect();
        let accounts: Vec<String> = facts
            .accounts
            .iter()
            .filter(|a| !a.is_archived && !failed.contains(a.id.as_str()))
            .map(|a| a.id.clone())
            .collect();
        let reference = reference.get_or_insert_with(|| self::reference(&harness, facts));
        found.extend(
            stored_differences(
                &harness,
                reference,
                &accounts,
                &format!("{label} {cadence:?}"),
            )
            .await,
        );
        if matches!(cadence, WindowCadence::Year) {
            found.extend(
                read_differences(&harness, reference, &accounts, &format!("{label} read")).await,
            );
            for account in &accounts {
                let alone = harness_with(facts.clone(), WindowCadence::Year).await;
                let request = PortfolioJobRequest {
                    account_ids: Some(vec![account.clone()]),
                    ..request()
                };
                alone
                    .coordinator
                    .run_job(request, &SilentObserver)
                    .await
                    .unwrap();
                found.extend(
                    stored_differences(
                        &alone,
                        reference,
                        std::slice::from_ref(account),
                        &format!("{label} {account} alone"),
                    )
                    .await,
                );
            }
        }
    }
    found
}

#[tokio::test]
async fn the_app_matches_one_kernel_run_on_every_scenario() {
    let mut compared = 0;
    let mut found = Vec::new();
    for scenario in load_all_scenarios()
        .into_iter()
        .filter(|s| !s.has_marker(crate::test_support::scenario::Marker::S))
    {
        found.extend(app_differences(&scenario.facts(), &scenario.id).await);
        compared += 1;
    }
    assert!(
        found.is_empty(),
        "{} differences:\n{}",
        found.len(),
        found.join("\n")
    );
    assert!(compared > 100, "only {compared} scenarios compared");
}

#[tokio::test]
async fn the_app_matches_one_kernel_run_on_generated_scenarios() {
    use crate::test_support::generate::{generated_count, scenario_yaml};
    let mut found = Vec::new();
    for seed in 0..generated_count() {
        let yaml = scenario_yaml(seed);
        let scenario: Scenario =
            serde_yaml::from_str(&yaml).unwrap_or_else(|e| panic!("seed {seed}: {e}"));
        scenario
            .validate()
            .unwrap_or_else(|e| panic!("seed {seed}: {e}"));
        found.extend(app_differences(&scenario.facts(), &scenario.id).await);
    }
    assert!(
        found.is_empty(),
        "{} differences:\n{}",
        found.len(),
        found.join("\n")
    );
}

/// Valuation rows whose history reads hold their thread until another task
/// has run. On a runtime's only async worker that task could not run, so the
/// read would wait out its timeout instead.
struct GatedValuations {
    inner: Arc<dyn ValuationRepositoryTrait>,
    started: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    release: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
    released_in_time: std::sync::atomic::AtomicBool,
}

impl GatedValuations {
    fn new(
        inner: Arc<dyn ValuationRepositoryTrait>,
    ) -> (
        Arc<Self>,
        tokio::sync::oneshot::Receiver<()>,
        std::sync::mpsc::Sender<()>,
    ) {
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let gate = Arc::new(Self {
            inner,
            started: std::sync::Mutex::new(Some(started_tx)),
            release: std::sync::Mutex::new(release_rx),
            released_in_time: std::sync::atomic::AtomicBool::new(false),
        });
        (gate, started_rx, release_tx)
    }

    fn hold(&self) {
        let Some(started) = self.started.lock().unwrap().take() else {
            return;
        };
        let _ = started.send(());
        let released = self
            .release
            .lock()
            .unwrap()
            .recv_timeout(std::time::Duration::from_secs(5))
            .is_ok();
        self.released_in_time
            .store(released, std::sync::atomic::Ordering::SeqCst);
    }

    /// Ends the wait of a releaser whose read never reached the rows.
    fn close(&self) {
        self.started.lock().unwrap().take();
    }

    fn released_in_time(&self) -> bool {
        self.released_in_time
            .load(std::sync::atomic::Ordering::SeqCst)
    }
}

#[async_trait]
impl ValuationRepositoryTrait for GatedValuations {
    async fn replace_valuations_for_account(
        &self,
        account_id: &str,
        since_date: Option<NaiveDate>,
        valuation_records: &[crate::portfolio::valuation::DailyAccountValuation],
    ) -> Result<()> {
        self.inner
            .replace_valuations_for_account(account_id, since_date, valuation_records)
            .await
    }

    fn get_historical_valuations(
        &self,
        account_id: &str,
        start_date: Option<NaiveDate>,
        end_date: Option<NaiveDate>,
    ) -> Result<Vec<crate::portfolio::valuation::DailyAccountValuation>> {
        self.hold();
        self.inner
            .get_historical_valuations(account_id, start_date, end_date)
    }

    fn get_historical_valuations_for_accounts(
        &self,
        account_ids: &[String],
        start_date: Option<NaiveDate>,
        end_date: Option<NaiveDate>,
    ) -> Result<Vec<crate::portfolio::valuation::DailyAccountValuation>> {
        self.hold();
        self.inner
            .get_historical_valuations_for_accounts(account_ids, start_date, end_date)
    }

    async fn delete_valuations_for_account(
        &self,
        account_id: &str,
        since_date: Option<NaiveDate>,
    ) -> Result<()> {
        self.inner
            .delete_valuations_for_account(account_id, since_date)
            .await
    }

    fn get_latest_valuations(
        &self,
        account_ids: &[String],
    ) -> Result<Vec<crate::portfolio::valuation::DailyAccountValuation>> {
        self.inner.get_latest_valuations(account_ids)
    }

    fn get_valuations_on_date(
        &self,
        account_ids: &[String],
        date: NaiveDate,
    ) -> Result<Vec<crate::portfolio::valuation::DailyAccountValuation>> {
        self.inner.get_valuations_on_date(account_ids, date)
    }

    fn get_accounts_with_negative_balance(
        &self,
        account_ids: &[String],
    ) -> Result<Vec<crate::portfolio::valuation::NegativeBalanceInfo>> {
        self.inner.get_accounts_with_negative_balance(account_ids)
    }
}

/// Releases the gated read once it has started. This task needs the async
/// worker the read would hold if it ran there.
fn release_when_started(
    started: tokio::sync::oneshot::Receiver<()>,
    release: std::sync::mpsc::Sender<()>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        if started.await.is_ok() {
            let _ = release.send(());
        }
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn performance_reads_leave_the_async_worker_free() {
    use crate::portfolio::performance::{PerformanceService, PerformanceServiceTrait};
    let harness = harness(scenario("NOM-TXF-01").facts()).await;
    let (gate, started, release) = GatedValuations::new(harness.valuation_repo.clone());
    let service = PerformanceService::new(
        harness.base_currency.clone(),
        harness.timezone.clone(),
        harness.sources.clone(),
        gate.clone(),
        harness.lot_repo.clone(),
    );

    let read = tokio::spawn(async move {
        service
            .calculate_performance_history("account", "acc-a", None, None, None, None)
            .await
            .map(|_| ())
    });
    let releaser = release_when_started(started, release);
    read.await.expect("read task").expect("performance read");
    gate.close();
    releaser.await.expect("releaser task");

    assert!(gate.released_in_time(), "the read held the async worker");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn scoped_valuation_reads_leave_the_async_worker_free() {
    use crate::portfolio::valuation::{ValuationService, ValuationServiceTrait};
    let harness = harness(scenario("NOM-TXF-01").facts()).await;
    // The scope's aggregation reads the stored histories of both accounts.
    harness
        .coordinator
        .run_job(request(), &SilentObserver)
        .await
        .expect("projection");
    let (gate, started, release) = GatedValuations::new(harness.valuation_repo.clone());
    let service = ValuationService::new(
        gate.clone(),
        harness.sources.clone(),
        harness.lot_repo.clone(),
        harness.timezone.clone(),
    );
    let base_currency = harness.base_currency.read().unwrap().clone();

    let read = tokio::spawn(async move {
        let accounts = ["acc-a".to_string(), "acc-b".to_string()];
        service
            .get_historical_valuations_for_accounts(
                "portfolio",
                &accounts,
                &base_currency,
                None,
                None,
            )
            .await
            .map(|_| ())
    });
    let releaser = release_when_started(started, release);
    read.await
        .expect("read task")
        .expect("scoped valuation read");
    gate.close();
    releaser.await.expect("releaser task");

    assert!(gate.released_in_time(), "the read held the async worker");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn valuation_totals_leave_the_async_worker_free() {
    use crate::portfolio::valuation::{ValuationService, ValuationServiceTrait};
    let harness = harness(scenario("NOM-TXF-01").facts()).await;
    let (gate, started, release) = GatedValuations::new(harness.valuation_repo.clone());
    let service = ValuationService::new(
        gate.clone(),
        harness.sources.clone(),
        harness.lot_repo.clone(),
        harness.timezone.clone(),
    );
    let base_currency = harness.base_currency.read().unwrap().clone();

    let read = tokio::spawn(async move {
        let accounts = ["acc-a".to_string(), "acc-b".to_string()];
        service
            .get_historical_valuation_totals_for_accounts(
                "portfolio",
                &accounts,
                &base_currency,
                None,
                None,
            )
            .await
            .map(|_| ())
    });
    let releaser = release_when_started(started, release);
    read.await
        .expect("read task")
        .expect("valuation totals read");
    gate.close();
    releaser.await.expect("releaser task");

    assert!(gate.released_in_time(), "the read held the async worker");
}
