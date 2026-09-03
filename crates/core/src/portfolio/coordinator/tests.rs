//! Coordinator over the in-memory doubles: kernel persistence, freshness
//! detection and the cold-start repair.

use std::collections::HashSet;
use std::sync::{Arc, RwLock};

use super::*;
use crate::accounts::{AccountAccountingSettings, AccountRepositoryTrait, CostBasisMethod};
use crate::activities::ActivityRepositoryTrait;
use crate::assets::AssetRepositoryTrait;
use crate::fx::{FxRepositoryTrait, FxService};
use crate::lots::LotRepositoryTrait;
use crate::portfolio::snapshot::{
    AccountStateSnapshot, SnapshotRepositoryTrait, SnapshotService, SnapshotSource,
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
    sources: FactSources,
    lot_repo: Arc<dyn LotRepositoryTrait>,
    projections: Arc<dyn ProjectionStoreTrait>,
    store: Arc<InMemoryProjectionStore>,
    _clock: crate::utils::clock::FrozenClock,
}

fn scenario(id: &str) -> Scenario {
    load_all_scenarios()
        .into_iter()
        .find(|s| s.id == id)
        .unwrap_or_else(|| panic!("scenario {id} not found"))
}

async fn harness(facts: ScenarioFacts) -> Harness {
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
    };
    let coordinator = PortfolioCoordinator::new(CoordinatorDeps {
        base_currency,
        timezone,
        sources: sources.clone(),
        fx_service,
        snapshot_service,
        projections: projections.clone(),
        lots: lot_repo.clone(),
        // Short fixtures: a checkpoint every two days exercises the resume path.
        checkpoint_cadence: CheckpointCadence::EveryDays(2),
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
        _clock: clock,
    }
}

fn request() -> PortfolioJobRequest {
    PortfolioJobRequest {
        account_ids: None,
        market_sync: MarketSyncMode::None,
        ..PortfolioJobRequest::default()
    }
}

#[tokio::test]
async fn run_job_persists_rows_and_records_watermarks() {
    let scenario = scenario("NOM-TRADE-01");
    let harness = harness(scenario.facts()).await;
    let report = harness
        .coordinator
        .run_job(request(), &SilentObserver)
        .await
        .unwrap();
    assert!(report.failures.is_empty(), "{:?}", report.failures);

    let account = &report.account_ids[0];
    let valuations = harness
        .valuation_repo
        .get_historical_valuations(account, None, None)
        .unwrap();
    assert!(!valuations.is_empty(), "valuation rows persisted");
    assert!(valuations.iter().all(|v| v.account_id == *account));
    let snapshots = harness
        .snapshot_repo
        .get_snapshots_by_account(account, None, None)
        .unwrap();
    assert!(!snapshots.is_empty(), "keyframes persisted");
    let lots = harness
        .lot_repo
        .get_all_lots_for_account(account)
        .await
        .unwrap();
    assert!(!lots.is_empty(), "lot rows persisted");
    let watermark = harness
        .projections
        .get_watermarks(std::slice::from_ref(account))
        .unwrap();
    assert_eq!(watermark.len(), 1);
    assert!(!harness
        .projections
        .get_checkpoints(std::slice::from_ref(account))
        .unwrap()
        .is_empty());
    assert!(harness.coordinator.stale_accounts().unwrap().is_empty());
}

#[tokio::test]
async fn stale_detection_follows_facts_and_market_data() {
    let scenario = scenario("NOM-TRADE-01");
    let facts = scenario.facts();
    let harness = harness(facts.clone()).await;
    assert_eq!(
        harness.coordinator.stale_accounts().unwrap()[0].reason,
        StaleReason::Unprojected
    );
    harness
        .coordinator
        .run_job(request(), &SilentObserver)
        .await
        .unwrap();
    assert!(harness.coordinator.stale_accounts().unwrap().is_empty());

    // A new quote observation only moves the market-data watermark.
    let template = facts.quotes[0].clone();
    harness.quote_service.add_quotes(vec![Quote {
        id: "late-quote".to_string(),
        timestamp: template.timestamp + chrono::Duration::days(1),
        created_at: template.created_at + chrono::Duration::days(30),
        ..template
    }]);
    let stale = harness.coordinator.stale_accounts().unwrap();
    assert_eq!(stale.len(), 1);
    assert_eq!(stale[0].reason, StaleReason::MarketDataChanged);

    // A new activity changes the facts.
    let mut activity = facts.activities[0].clone();
    activity.id = "late-activity".to_string();
    activity.activity_date += chrono::Duration::days(1);
    harness.activity_repo.apply(vec![activity], Vec::new(), &[]);
    let stale = harness.coordinator.stale_accounts().unwrap();
    assert_eq!(stale[0].reason, StaleReason::FactsChanged);

    // The cold-start check repairs it.
    harness
        .coordinator
        .ensure_consistent(MarketSyncMode::None, &SilentObserver)
        .await
        .unwrap();
    assert!(harness.coordinator.stale_accounts().unwrap().is_empty());
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
/// persistence: the stored valuations, lots and keyframes must equal the
/// kernel golden (architecture §3.3). Nothing here asserts mere non-emptiness.
#[tokio::test]
async fn every_parity_scenario_persists_the_kernel_golden() {
    let mut compared = 0;
    for scenario in load_all_scenarios()
        .into_iter()
        .filter(|s| s.is_parity_eligible())
    {
        let Some(golden) = kernel_golden(&scenario.id) else {
            panic!("{}: no kernel golden", scenario.id);
        };
        let facts = scenario.facts();
        let harness = harness(facts.clone()).await;
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
/// projection must equal a fresh run over the same facts, and the
/// consistency check must find nothing stale.
#[tokio::test]
async fn lifecycle_steps_match_a_fresh_rebuild() {
    let mut steps_checked = 0;
    let mut plans_seen: HashSet<String> = HashSet::new();
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
            let after = scenario.facts_after(index + 1);
            crate::utils::clock::set_frozen(as_of_instant(after.as_of, &after.timezone));
            let by_id = |ids: &[String]| -> Vec<crate::activities::Activity> {
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
            live.activity_repo
                .apply(by_id(&added), by_id(&updated), &step.remove_activities);
            let new_quotes: Vec<Quote> = after
                .quotes
                .iter()
                .filter(|q| {
                    step.add_quotes.iter().any(|spec| {
                        spec.asset == q.asset_id && spec.day == q.timestamp.date_naive()
                    })
                })
                .cloned()
                .collect();
            live.quote_service.add_quotes(new_quotes);
            live.fx_repo.add_rates(
                step.add_fx_rates
                    .iter()
                    .map(crate::test_support::scenario::fx_rate_from_spec)
                    .collect(),
            );

            let report = live
                .coordinator
                .ensure_consistent(MarketSyncMode::None, &SilentObserver)
                .await
                .unwrap();
            assert!(report.failures.is_empty(), "{label}: {:?}", report.failures);
            for plan in &report.plans {
                plans_seen.insert(
                    match plan.plan {
                        RebuildPlan::Full => "full",
                        RebuildPlan::Resume { .. } => "resume",
                        RebuildPlan::Revalue => "revalue",
                        RebuildPlan::Skip => "skip",
                    }
                    .to_string(),
                );
            }
            assert!(
                live.coordinator.stale_accounts().unwrap().is_empty(),
                "{label}: stale after the consistency pass"
            );

            let fresh = harness(after.clone()).await;
            fresh
                .coordinator
                .run_job(request(), &SilentObserver)
                .await
                .unwrap();
            for account in after.accounts.iter().filter(|a| !a.is_archived) {
                let incremental = live
                    .valuation_repo
                    .get_historical_valuations(&account.id, None, None)
                    .unwrap();
                let rebuilt = fresh
                    .valuation_repo
                    .get_historical_valuations(&account.id, None, None)
                    .unwrap();
                assert_eq!(
                    normalized_valuations(incremental),
                    normalized_valuations(rebuilt),
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
    // The equivalence above only proves the fast paths if they ran.
    for path in ["resume", "revalue", "full"] {
        assert!(
            plans_seen.contains(path),
            "no lifecycle step took the {path} path"
        );
    }
}

fn plan_of(report: &PortfolioJobReport, account: &str) -> RebuildPlan {
    report
        .plans
        .iter()
        .find(|p| p.account_id == account)
        .unwrap_or_else(|| panic!("no plan for {account}"))
        .plan
}

#[tokio::test]
async fn fresh_accounts_are_skipped_unless_a_full_rebuild_is_forced() {
    let scenario = scenario("NOM-TRADE-01");
    let facts = scenario.facts();
    let account = facts.accounts[0].id.clone();
    let harness = harness(facts).await;
    let first = harness
        .coordinator
        .run_job(request(), &SilentObserver)
        .await
        .unwrap();
    assert_eq!(plan_of(&first, &account), RebuildPlan::Full);
    let second = harness
        .coordinator
        .run_job(request(), &SilentObserver)
        .await
        .unwrap();
    assert_eq!(plan_of(&second, &account), RebuildPlan::Skip);
    let forced = harness
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
    assert_eq!(plan_of(&forced, &account), RebuildPlan::Full);
}

#[tokio::test]
async fn market_data_and_new_days_revalue_without_reprojecting() {
    let scenario = scenario("NOM-TRADE-01");
    let facts = scenario.facts();
    let account = facts.accounts[0].id.clone();
    let live = harness(facts.clone()).await;
    live.coordinator
        .run_job(request(), &SilentObserver)
        .await
        .unwrap();
    let lots_before = format!(
        "{:#?}",
        live.lot_repo
            .get_all_lots_for_account(&account)
            .await
            .unwrap()
    );

    let template = facts.quotes[0].clone();
    live.quote_service.add_quotes(vec![Quote {
        id: "late-quote".to_string(),
        timestamp: template.timestamp + chrono::Duration::days(1),
        close: template.close * rust_decimal_macros::dec!(1.1),
        ..template
    }]);
    let report = live
        .coordinator
        .ensure_consistent(MarketSyncMode::None, &SilentObserver)
        .await
        .unwrap();
    assert_eq!(plan_of(&report, &account), RebuildPlan::Revalue);

    let tomorrow = facts.as_of + chrono::Duration::days(1);
    crate::utils::clock::set_frozen(as_of_instant(tomorrow, &facts.timezone));
    let report = live
        .coordinator
        .ensure_consistent(MarketSyncMode::None, &SilentObserver)
        .await
        .unwrap();
    assert_eq!(plan_of(&report, &account), RebuildPlan::Revalue);
    let lots_after = format!(
        "{:#?}",
        live.lot_repo
            .get_all_lots_for_account(&account)
            .await
            .unwrap()
    );
    assert_eq!(lots_before, lots_after, "a revalue never rewrites lots");

    // The revalued rows equal a fresh rebuild over the same facts.
    let mut fresh_facts = facts.clone();
    fresh_facts.as_of = tomorrow;
    fresh_facts.quotes = {
        let mut quotes = facts.quotes.clone();
        quotes.push(Quote {
            id: "late-quote".to_string(),
            timestamp: facts.quotes[0].timestamp + chrono::Duration::days(1),
            close: facts.quotes[0].close * rust_decimal_macros::dec!(1.1),
            ..facts.quotes[0].clone()
        });
        quotes
    };
    let fresh = harness(fresh_facts).await;
    fresh
        .coordinator
        .run_job(request(), &SilentObserver)
        .await
        .unwrap();
    assert_eq!(
        normalized_valuations(
            live.valuation_repo
                .get_historical_valuations(&account, None, None)
                .unwrap()
        ),
        normalized_valuations(
            fresh
                .valuation_repo
                .get_historical_valuations(&account, None, None)
                .unwrap()
        )
    );
}

#[tokio::test]
async fn a_backdated_edit_resumes_from_the_last_checkpoint() {
    let scenario = scenario("NOM-TRADE-01");
    let facts = scenario.facts();
    let account = facts.accounts[0].id.clone();
    let live = harness(facts.clone()).await;
    live.coordinator
        .run_job(request(), &SilentObserver)
        .await
        .unwrap();
    let checkpoints = live
        .projections
        .get_checkpoints(std::slice::from_ref(&account))
        .unwrap();
    assert!(
        checkpoints.len() > 1,
        "two-day cadence leaves several checkpoints"
    );

    // Edit the latest activity (moving its quantity): the change is dated
    // late, so the run resumes from the last checkpoint before it.
    let mut edited = facts
        .activities
        .iter()
        .filter(|a| a.account_id == account)
        .max_by_key(|a| a.activity_date)
        .unwrap()
        .clone();
    let edit_day = edited.activity_date.date_naive();
    edited.quantity = edited.quantity.map(|q| q * rust_decimal_macros::dec!(2));
    edited.amount = edited.amount.map(|a| a * rust_decimal_macros::dec!(2));
    edited.updated_at = as_of_instant(facts.as_of, &facts.timezone) + chrono::Duration::hours(1);
    live.activity_repo
        .apply(Vec::new(), vec![edited.clone()], &[]);
    let report = live
        .coordinator
        .ensure_consistent(MarketSyncMode::None, &SilentObserver)
        .await
        .unwrap();
    let RebuildPlan::Resume { since } = plan_of(&report, &account) else {
        panic!("expected a resume, got {:?}", report.plans);
    };
    assert!(
        since <= edit_day,
        "resume starts on or before the edited day"
    );
    assert!(
        since
            > facts
                .activities
                .iter()
                .map(|a| a.activity_date.date_naive())
                .min()
                .unwrap(),
        "resume starts after the first activity"
    );

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
        normalized_valuations(
            live.valuation_repo
                .get_historical_valuations(&account, None, None)
                .unwrap()
        ),
        normalized_valuations(
            fresh
                .valuation_repo
                .get_historical_valuations(&account, None, None)
                .unwrap()
        )
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
async fn a_resume_does_not_backfill_rows_before_an_account_existed() {
    // A checkpoint carries an entry for every account the fold covered,
    // including accounts that held nothing yet. Seeding a valuation keyframe
    // from such an empty entry emitted zero-value rows for every day between
    // the checkpoint and the account's first activity, so a resumed run no
    // longer matched a fold from genesis.
    let scenario = scenario("NOM-TRADE-01");
    let mut facts = scenario.facts();
    let mut late_account = facts.accounts[0].clone();
    late_account.id = "acc-late".to_string();
    late_account.name = "Opened later".to_string();
    facts.accounts.push(late_account);

    let opened_on = facts.as_of;
    let mut deposit = facts.activities[0].clone();
    deposit.id = "late-deposit".to_string();
    deposit.account_id = "acc-late".to_string();
    deposit.activity_type = "DEPOSIT".to_string();
    deposit.asset_id = None;
    deposit.quantity = None;
    deposit.unit_price = None;
    deposit.amount = Some(rust_decimal_macros::dec!(500));
    deposit.activity_date = as_of_instant(opened_on, &facts.timezone);
    facts.activities.push(deposit);

    let harness = harness(facts.clone()).await;
    let loaded = facts::load(
        &harness.sources,
        &["acc-late".to_string()],
        &facts.base_currency,
        &facts.timezone,
        facts.as_of,
    )
    .unwrap();

    // Resume from a day well before the account opened, holding nothing.
    let resume_day = opened_on - chrono::Duration::days(5);
    let resume = engine::model::ProjectionState {
        date: resume_day,
        accounts: std::collections::BTreeMap::from([(
            engine::model::AccountId::new("acc-late"),
            engine::model::AccountState::empty(
                engine::model::AccountId::new("acc-late"),
                engine::model::Currency::parse(&facts.base_currency).unwrap(),
            ),
        )]),
        transfer_cache: Default::default(),
    };
    let resumed = persist::compute(&loaded, Some(resume), CheckpointCadence::EveryDays(2)).unwrap();
    let series = resumed
        .series
        .get(&engine::model::AccountId::new("acc-late"))
        .expect("the late account is valued");
    let first_valued = series.days.first().expect("at least one day").date;
    assert_eq!(
        first_valued, opened_on,
        "valuation starts on the account's first activity, not at the resume point {resume_day}"
    );
}

#[tokio::test]
async fn a_deletion_rebuilds_fully_unless_the_change_is_dated() {
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
    harness
        .activity_repo
        .apply(Vec::new(), Vec::new(), std::slice::from_ref(&removed.id));

    // Without a date the deleted row cannot be placed: full fold.
    let report = harness
        .coordinator
        .ensure_consistent(MarketSyncMode::None, &SilentObserver)
        .await
        .unwrap();
    assert_eq!(plan_of(&report, &account), RebuildPlan::Full);

    // With the event's date, a later deletion resumes.
    harness
        .activity_repo
        .apply(vec![removed.clone()], Vec::new(), &[]);
    harness
        .coordinator
        .run_job(request(), &SilentObserver)
        .await
        .unwrap();
    harness
        .activity_repo
        .apply(Vec::new(), Vec::new(), std::slice::from_ref(&removed.id));
    let report = harness
        .coordinator
        .run_job(
            PortfolioJobRequest {
                earliest_change_at: Some(removed.activity_date),
                ..request()
            },
            &SilentObserver,
        )
        .await
        .unwrap();
    assert!(
        matches!(plan_of(&report, &account), RebuildPlan::Resume { .. }),
        "{:?}",
        report.plans
    );
}

#[tokio::test]
async fn storage_failures_are_retried_with_backoff() {
    let scenario = scenario("NOM-TRADE-01");
    let facts = scenario.facts();
    let harness = harness(facts).await;
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
    assert!(report
        .failures
        .iter()
        .all(|f| f.code == "PROJECTION_PERSIST_FAILED"));
    assert!(!report.failures.is_empty());
}

fn scoped(account_ids: Vec<&str>) -> PortfolioJobRequest {
    PortfolioJobRequest {
        account_ids: Some(account_ids.into_iter().map(String::from).collect()),
        market_sync: MarketSyncMode::None,
        ..PortfolioJobRequest::default()
    }
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
async fn concurrent_same_scope_requests_both_run() {
    let scenario = scenario("NOM-TRADE-01");
    let harness = harness(scenario.facts()).await;
    let first = harness.coordinator.run_job(request(), &SilentObserver);
    let second = harness.coordinator.run_job(request(), &SilentObserver);
    let (first, second) = tokio::join!(first, second);
    for report in [first.unwrap(), second.unwrap()] {
        assert!(!report.account_ids.is_empty(), "nothing is skipped");
        assert!(report.failures.is_empty(), "{:?}", report.failures);
    }
    assert!(harness.coordinator.stale_accounts().unwrap().is_empty());
}

#[tokio::test]
async fn a_new_day_makes_the_projection_stale() {
    let scenario = scenario("NOM-TRADE-01");
    let facts = scenario.facts();
    let harness = harness(facts.clone()).await;
    harness
        .coordinator
        .run_job(request(), &SilentObserver)
        .await
        .unwrap();
    assert!(harness.coordinator.stale_accounts().unwrap().is_empty());

    let tomorrow = facts.as_of + chrono::Duration::days(1);
    crate::utils::clock::set_frozen(as_of_instant(tomorrow, &facts.timezone));
    let stale = harness.coordinator.stale_accounts().unwrap();
    assert!(!stale.is_empty());
    assert!(stale.iter().all(|s| s.reason == StaleReason::DayAdvanced));

    let report = harness
        .coordinator
        .ensure_consistent(MarketSyncMode::None, &SilentObserver)
        .await
        .unwrap();
    assert!(report.failures.is_empty(), "{:?}", report.failures);
    assert!(harness.coordinator.stale_accounts().unwrap().is_empty());
    let watermarks = harness
        .projections
        .get_watermarks(&report.account_ids)
        .unwrap();
    assert!(watermarks.iter().all(|w| w.as_of == tomorrow));
}

#[tokio::test]
async fn resyncing_identical_market_data_is_not_stale() {
    let scenario = scenario("NOM-TRADE-01");
    let facts = scenario.facts();
    let harness = harness(facts.clone()).await;
    harness
        .coordinator
        .run_job(request(), &SilentObserver)
        .await
        .unwrap();
    // A provider sync re-upserts the same closes with fresh row timestamps.
    let resynced: Vec<Quote> = facts
        .quotes
        .iter()
        .map(|q| Quote {
            id: format!("{}-resync", q.id),
            created_at: q.created_at + chrono::Duration::days(30),
            ..q.clone()
        })
        .collect();
    harness.quote_service.add_quotes(resynced);
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
    assert_eq!(
        harness
            .projections
            .get_watermarks(&["acc-future".to_string()])
            .unwrap()
            .len(),
        1
    );
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
    assert!(harness
        .projections
        .get_watermarks(std::slice::from_ref(&holdings_account))
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn deleting_a_transfer_leg_makes_the_partner_stale() {
    let scenario = scenario("NOM-TXF-01");
    let facts = scenario.facts();
    let (out, into) = transfer_legs(&facts);
    let harness = harness(facts).await;
    harness
        .coordinator
        .run_job(request(), &SilentObserver)
        .await
        .unwrap();
    harness
        .activity_repo
        .apply(Vec::new(), Vec::new(), std::slice::from_ref(&out.id));
    let stale = harness.coordinator.stale_accounts().unwrap();
    let partner = stale
        .iter()
        .find(|s| s.account_id == into.account_id)
        .expect("the receiving account is stale too");
    assert_eq!(partner.reason, StaleReason::FactsChanged);

    // A job raised for an account that no longer exists repairs the partners.
    let report = harness
        .coordinator
        .run_job(scoped(vec!["deleted-account"]), &SilentObserver)
        .await
        .unwrap();
    assert!(report.account_ids.contains(&into.account_id));
    assert!(harness.coordinator.stale_accounts().unwrap().is_empty());
}

#[tokio::test]
async fn unsupported_cost_basis_settings_fail_the_account() {
    let scenario = scenario("NOM-TRADE-01");
    let facts = scenario.facts();
    let account = facts.accounts[0].id.clone();
    let harness = harness(facts).await;
    harness
        .account_repo
        .set_accounting_settings(AccountAccountingSettings {
            cost_basis_method: CostBasisMethod::Lifo,
            ..AccountAccountingSettings::default_for_account(account.clone())
        });
    let report = harness
        .coordinator
        .run_job(request(), &SilentObserver)
        .await
        .unwrap();
    assert_eq!(report.failures.len(), 1, "{:?}", report.failures);
    assert_eq!(report.failures[0].code, "UNSUPPORTED_COST_BASIS");
    assert!(harness
        .projections
        .get_watermarks(std::slice::from_ref(&account))
        .unwrap()
        .is_empty());
    assert!(harness
        .lot_repo
        .get_all_lots_for_account(&account)
        .await
        .unwrap()
        .is_empty());
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
        .run_job(scoped(vec![archived.as_str()]), &SilentObserver)
        .await
        .unwrap();
    assert_eq!(report.account_ids, vec![archived.clone()]);
    assert!(report.failures.is_empty(), "{:?}", report.failures);
    assert_eq!(
        harness
            .projections
            .get_watermarks(std::slice::from_ref(&archived))
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn observed_snapshot_facts_are_ordered_so_the_fingerprint_is_stable() {
    // Snapshot positions and cash live in hash maps, whose iteration order
    // differs per load. Unsorted, an account with an observed snapshot never
    // matched its own watermark: it was reported stale and rebuilt forever.
    let scenario = scenario("NOM-OBS-01");
    let facts = scenario.facts();
    let account = facts
        .accounts
        .iter()
        .find(|a| a.tracking_mode == crate::accounts::TrackingMode::Holdings)
        .expect("holdings account")
        .id
        .clone();
    let harness = harness(facts).await;

    // Two positions and two cash buckets, inserted in reverse order.
    let mut snapshot = manual_snapshot(
        &account,
        chrono::NaiveDate::from_ymd_opt(2025, 1, 6).unwrap(),
    );
    // Six assets inserted out of order: an unsorted load would have to hit
    // the sorted permutation by chance (1 in 720) for this to pass.
    for asset in ["zzz", "mmm", "aaa", "ttt", "ccc", "ppp"] {
        snapshot.positions.insert(
            asset.to_string(),
            crate::portfolio::snapshot::Position {
                id: format!("{account}-{asset}"),
                account_id: account.clone(),
                asset_id: asset.to_string(),
                quantity: rust_decimal_macros::dec!(1),
                average_cost: rust_decimal_macros::dec!(10),
                total_cost_basis: rust_decimal_macros::dec!(10),
                currency: "USD".to_string(),
                ..Default::default()
            },
        );
    }
    snapshot
        .cash_balances
        .insert("USD".into(), rust_decimal_macros::dec!(5));
    snapshot
        .cash_balances
        .insert("CAD".into(), rust_decimal_macros::dec!(7));
    harness
        .snapshot_repo
        .save_snapshots(&[snapshot])
        .await
        .unwrap();

    let loaded = facts::load(
        &harness.sources,
        std::slice::from_ref(&account),
        "USD",
        "UTC",
        chrono::NaiveDate::from_ymd_opt(2025, 1, 12).unwrap(),
    )
    .unwrap();
    let observed = loaded
        .raw
        .observed_snapshots
        .iter()
        .find(|s| s.positions.len() == 6)
        .expect("the six-position snapshot");
    let assets: Vec<&str> = observed
        .positions
        .iter()
        .map(|p| p.asset_id.as_str())
        .collect();
    assert_eq!(
        assets,
        vec!["aaa", "ccc", "mmm", "ppp", "ttt", "zzz"],
        "positions sorted by asset"
    );
    let currencies: Vec<&str> = observed.cash.iter().map(|(c, _)| c.as_str()).collect();
    assert_eq!(currencies, vec!["CAD", "USD"], "cash sorted by currency");

    // The fingerprint a job stores must equal the one the next check computes.
    let again = facts::load(
        &harness.sources,
        std::slice::from_ref(&account),
        "USD",
        "UTC",
        chrono::NaiveDate::from_ymd_opt(2025, 1, 12).unwrap(),
    )
    .unwrap();
    assert_eq!(
        loaded.fingerprints.get(&account),
        again.fingerprints.get(&account),
        "the same facts must fingerprint the same on every load"
    );
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
