#![allow(clippy::unwrap_used, clippy::panic, reason = "test code")]
//! Device sync replay of entities whose IDs come from natural keys.
//!
//! Many synced rows take their ID from a key (portfolio + account, activity +
//! taxonomy, month + category, account + date, ...). Real flows delete such a
//! row and later write the same ID again. Each flow test runs on device A
//! through the real repositories, replays A's outbox on device B after every
//! user step (one push and pull per step) and checks that B ends up with A's
//! rows.
//!
//! The last test guards the other half of the rule: an entity with a random
//! UUID stays deleted when newer writes for its ID arrive.

mod common;

use std::collections::HashMap;
use std::sync::Arc;

use chrono::NaiveDate;
use diesel::connection::SimpleConnection;
use diesel::prelude::*;
use rust_decimal::Decimal;
use serde_json::json;
use wealthfolio_core::goals::{GoalRepositoryTrait, SaveGoalPlan};
use wealthfolio_core::portfolio::snapshot::{
    AccountStateSnapshot, SnapshotRepositoryTrait, SnapshotSource,
};
use wealthfolio_core::portfolios::{NewPortfolio, PortfolioRepositoryTrait, PortfolioUpdate};
use wealthfolio_core::sync::{SyncEntity, SyncOperation};
use wealthfolio_spending::activity_assignments::{
    ActivityTaxonomyAssignmentRepositoryTrait, NewActivityTaxonomyAssignment,
};
use wealthfolio_spending::activity_events::ActivityEventsRepositoryTrait;
use wealthfolio_spending::activity_splits::{ActivitySplitRepositoryTrait, NewActivitySplit};
use wealthfolio_spending::budget::{BudgetRepositoryTrait, BudgetTargetType, NewBudgetTarget};
use wealthfolio_spending::categorization_rules::{
    CategorizationRulesRepositoryTrait, NewCategorizationRule, RuleMatchType,
};
use wealthfolio_spending::events::{EventsRepositoryTrait, NewEvent};
use wealthfolio_storage_sqlite::db::{self, get_connection};
use wealthfolio_storage_sqlite::goals::GoalRepository;
use wealthfolio_storage_sqlite::portfolio::snapshot::SnapshotRepository;
use wealthfolio_storage_sqlite::portfolios::PortfolioRepository;
use wealthfolio_storage_sqlite::schema::{
    activities, activity_taxonomy_assignments, budget_targets, goal_plans, holdings_snapshots,
    portfolio_accounts, portfolios, quotes, spending_activity_events, spending_activity_splits,
    spending_categorization_rules, spending_events,
};
use wealthfolio_storage_sqlite::spending::activity_assignments::ActivityTaxonomyAssignmentRepository;
use wealthfolio_storage_sqlite::spending::activity_events::ActivityEventsRepository;
use wealthfolio_storage_sqlite::spending::activity_splits::ActivitySplitRepository;
use wealthfolio_storage_sqlite::spending::budget::BudgetRepository;
use wealthfolio_storage_sqlite::spending::categorization_rules::CategorizationRulesRepository;
use wealthfolio_storage_sqlite::spending::events::EventsRepository;
use wealthfolio_storage_sqlite::sync::app_sync::AppSyncRepository;

const SPENDING: &str = "spending_categories";
const CHECKING: &str = "acc-checking";
const BROKERAGE: &str = "acc-brokerage";
const GROCERY_RUN: &str = "act-grocery-run";
const SPRING_TRIP: &str = "event-spring-trip";
const HOUSE_GOAL: &str = "goal-house-deposit";
/// "Travel", seeded by the spending module migration on every database.
const TRAVEL_EVENT_TYPE: &str = "255600dc-c2a3-47e0-979d-a602c21fc337";

fn setup_db() -> (
    common::TestDir,
    std::sync::Arc<db::DbPool>,
    db::WriteHandle,
    std::sync::Arc<wealthfolio_storage_sqlite::sync::ProfileSyncState>,
) {
    let dir = common::TestDir::new();
    let access = db::DbAccess::plaintext(dir.path().join("app.db").to_str().unwrap());
    access.prepare().unwrap();
    access.run_migrations().unwrap();
    let pool = access.create_pool().unwrap();
    let sync_state = std::sync::Arc::default();
    let (writer, _task) = db::write_actor::spawn_writer_with_sync_state(
        (*pool).clone(),
        std::sync::Arc::new(|| {}),
        std::sync::Arc::clone(&sync_state),
    )
    .unwrap();
    (dir, pool, writer, sync_state)
}

/// One profile database with its writer and sync repository.
struct Device {
    _dir: common::TestDir,
    pool: Arc<db::DbPool>,
    writer: db::WriteHandle,
    sync: AppSyncRepository,
}

impl Device {
    fn new() -> Self {
        let (dir, pool, writer, _sync_state) = setup_db();
        let sync = AppSyncRepository::new(pool.clone(), writer.clone());
        Self {
            _dir: dir,
            pool,
            writer,
            sync,
        }
    }

    fn conn(&self) -> db::DbConnection {
        get_connection(&self.pool).expect("open a connection")
    }

    /// Raw SQL for prerequisite rows: no outbox events, nothing to replay.
    fn seed(&self, sql: &str) {
        self.conn()
            .batch_execute(sql)
            .expect("seed prerequisite rows");
    }
}

/// Seeds the same prerequisite rows on both devices.
fn seed_both(a: &Device, b: &Device, sql: &str) {
    a.seed(sql);
    b.seed(sql);
}

/// What one push (A) and pull (B) moved.
struct Cycle {
    pushed: Vec<(SyncEntity, String, SyncOperation)>,
    applied: usize,
}

impl Cycle {
    fn assert_pushed(&self, entity: SyncEntity, entity_id: &str, op: SyncOperation) {
        assert!(
            self.pushed
                .iter()
                .any(|(e, id, o)| *e == entity && id == entity_id && *o == op),
            "expected A to push {entity:?} {op:?} for '{entity_id}'; pushed {:?}",
            self.pushed
        );
    }

    fn assert_all_applied(&self) {
        assert_eq!(
            self.applied,
            self.pushed.len(),
            "B must apply every event A pushed in this cycle: {:?}",
            self.pushed
        );
    }
}

type ReplayEvent = (
    SyncEntity,
    String,
    SyncOperation,
    String,
    String,
    i64,
    serde_json::Value,
);

/// One engine push + pull: A's pending outbox, in push order, replayed on B
/// as a single batch, then marked sent on A.
async fn sync_cycle(a: &Device, b: &Device, next_seq: &mut i64) -> Cycle {
    let events = a
        .sync
        .list_pending_outbox(10_000)
        .expect("list A's pending outbox");
    let mut pushed = Vec::with_capacity(events.len());
    let mut event_ids = Vec::with_capacity(events.len());
    let mut batch: Vec<ReplayEvent> = Vec::with_capacity(events.len());
    for event in events {
        *next_seq += 1;
        let payload: serde_json::Value =
            serde_json::from_str(&event.payload).expect("outbox payload is JSON");
        pushed.push((event.entity, event.entity_id.clone(), event.op));
        event_ids.push(event.event_id.clone());
        batch.push((
            event.entity,
            event.entity_id,
            event.op,
            event.event_id,
            event.client_timestamp,
            *next_seq,
            payload,
        ));
    }
    let applied = b
        .sync
        .apply_remote_events_lww_batch(batch)
        .await
        .expect("B replays A's batch");
    a.sync
        .mark_outbox_sent(event_ids)
        .await
        .expect("mark A's outbox sent");
    assert!(
        b.sync
            .list_pending_outbox(1)
            .expect("list B's pending outbox")
            .is_empty(),
        "B wrote nothing locally, so it has nothing to push back"
    );
    Cycle { pushed, applied }
}

fn remote_event(
    entity: SyncEntity,
    entity_id: &str,
    op: SyncOperation,
    event_id: &str,
    client_timestamp: &str,
    seq: i64,
    payload: serde_json::Value,
) -> ReplayEvent {
    (
        entity,
        entity_id.to_string(),
        op,
        event_id.to_string(),
        client_timestamp.to_string(),
        seq,
        payload,
    )
}

/// Replays one synthetic event on its own batch; returns the applied count.
async fn replay(device: &Device, event: ReplayEvent) -> usize {
    device
        .sync
        .apply_remote_events_lww_batch(vec![event])
        .await
        .expect("replay synthetic event")
}

// ----------------------------- seed rows -----------------------------

fn account_sql(id: &str, name: &str, account_type: &str, tracking_mode: &str) -> String {
    format!(
        "INSERT INTO accounts (id, name, account_type, `group`, currency, is_default, is_active, \
         created_at, updated_at, platform_id, account_number, meta, provider, \
         provider_account_id, is_archived, tracking_mode) \
         VALUES ('{id}', '{name}', '{account_type}', NULL, 'USD', 0, 1, '2026-01-01 00:00:00', \
         '2026-01-01 00:00:00', NULL, NULL, NULL, NULL, NULL, 0, '{tracking_mode}');"
    )
}

fn cash_account_sql(id: &str, name: &str) -> String {
    account_sql(id, name, "CASH", "TRANSACTIONS")
}

/// A manual cash withdrawal: its spending data syncs (`source_system = MANUAL`).
fn manual_withdrawal_sql(id: &str, account_id: &str, amount: &str) -> String {
    format!(
        "INSERT INTO activities (id, account_id, asset_id, activity_type, activity_type_override, \
         source_type, subtype, status, activity_date, settlement_date, quantity, unit_price, \
         amount, fee, currency, fx_rate, notes, metadata, source_system, source_record_id, \
         source_group_id, idempotency_key, import_run_id, is_user_modified, needs_review, \
         created_at, updated_at) \
         VALUES ('{id}', '{account_id}', NULL, 'WITHDRAWAL', NULL, NULL, NULL, 'POSTED', \
         '2026-03-10T00:00:00Z', NULL, NULL, NULL, '{amount}', NULL, 'USD', NULL, NULL, NULL, \
         'MANUAL', NULL, NULL, NULL, NULL, 0, 0, '2026-03-10T00:00:00Z', \
         '2026-03-10T00:00:00Z');"
    )
}

fn cash_activity_seed() -> String {
    [
        cash_account_sql(CHECKING, "Checking"),
        manual_withdrawal_sql(GROCERY_RUN, CHECKING, "42.5"),
    ]
    .concat()
}

fn event_sql(id: &str, name: &str) -> String {
    format!(
        "INSERT INTO spending_events (id, name, description, event_type_id, start_date, \
         end_date, created_at, updated_at) \
         VALUES ('{id}', '{name}', NULL, '{TRAVEL_EVENT_TYPE}', '2026-03-01', '2026-03-31', \
         '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');"
    )
}

fn goal_sql(id: &str) -> String {
    format!(
        "INSERT INTO goals (id, title, description, target_amount, goal_type, status_lifecycle, \
         status_health, priority, cover_image_key, currency, start_date, target_date, \
         summary_current_value, summary_progress, projected_completion_date, \
         projected_value_at_target_date, created_at, updated_at, summary_target_amount) \
         VALUES ('{id}', 'House deposit', NULL, 50000, 'custom_save_up', 'active', 'on_track', \
         1, NULL, 'USD', NULL, NULL, 0, 0, NULL, NULL, '2026-01-01T00:00:00Z', \
         '2026-01-01T00:00:00Z', 50000);"
    )
}

// ----------------------------- row readers -----------------------------

fn portfolio_names(d: &Device) -> Vec<(String, String)> {
    portfolios::table
        .select((portfolios::id, portfolios::name))
        .order(portfolios::id.asc())
        .load(&mut d.conn())
        .expect("load portfolios")
}

/// (account_id, membership id, sort_order), by account.
fn memberships(d: &Device, portfolio_id: &str) -> Vec<(String, String, i32)> {
    portfolio_accounts::table
        .filter(portfolio_accounts::portfolio_id.eq(portfolio_id))
        .select((
            portfolio_accounts::account_id,
            portfolio_accounts::id,
            portfolio_accounts::sort_order,
        ))
        .order(portfolio_accounts::account_id.asc())
        .load(&mut d.conn())
        .expect("load portfolio memberships")
}

fn member_accounts(d: &Device, portfolio_id: &str) -> Vec<String> {
    memberships(d, portfolio_id)
        .into_iter()
        .map(|(account_id, ..)| account_id)
        .collect()
}

fn membership_id(d: &Device, portfolio_id: &str, account_id: &str) -> String {
    memberships(d, portfolio_id)
        .into_iter()
        .find(|(account, ..)| account == account_id)
        .map(|(_, id, _)| id)
        .expect("membership exists")
}

fn membership_exists(d: &Device, id: &str) -> bool {
    portfolio_accounts::table
        .find(id)
        .select(portfolio_accounts::id)
        .first::<String>(&mut d.conn())
        .optional()
        .expect("read membership")
        .is_some()
}

/// (assignment id, category_id) in the spending taxonomy.
fn categories(d: &Device, activity_id: &str) -> Vec<(String, String)> {
    activity_taxonomy_assignments::table
        .filter(activity_taxonomy_assignments::activity_id.eq(activity_id))
        .filter(activity_taxonomy_assignments::taxonomy_id.eq(SPENDING))
        .select((
            activity_taxonomy_assignments::id,
            activity_taxonomy_assignments::category_id,
        ))
        .order(activity_taxonomy_assignments::id.asc())
        .load(&mut d.conn())
        .expect("load category assignments")
}

fn assignment_id(d: &Device, activity_id: &str) -> String {
    let rows = categories(d, activity_id);
    assert_eq!(rows.len(), 1, "A has one category assignment: {rows:?}");
    rows[0].0.clone()
}

/// (split id, category_id, amount).
fn splits(d: &Device, activity_id: &str) -> Vec<(String, String, String)> {
    spending_activity_splits::table
        .filter(spending_activity_splits::activity_id.eq(activity_id))
        .select((
            spending_activity_splits::id,
            spending_activity_splits::category_id,
            spending_activity_splits::amount,
        ))
        .order(spending_activity_splits::id.asc())
        .load(&mut d.conn())
        .expect("load splits")
}

fn event_tag(d: &Device, activity_id: &str) -> Option<String> {
    spending_activity_events::table
        .find(activity_id)
        .select(spending_activity_events::event_id)
        .first::<String>(&mut d.conn())
        .optional()
        .expect("read event tag")
}

fn events(d: &Device) -> Vec<(String, String)> {
    spending_events::table
        .select((spending_events::id, spending_events::name))
        .order(spending_events::id.asc())
        .load(&mut d.conn())
        .expect("load events")
}

/// (target id, category_id, amount) for one month, by category.
fn targets(d: &Device, period_key: &str) -> Vec<(String, Option<String>, String)> {
    budget_targets::table
        .filter(budget_targets::period_key.eq(period_key))
        .select((
            budget_targets::id,
            budget_targets::category_id,
            budget_targets::amount,
        ))
        .order(budget_targets::category_id.asc())
        .load(&mut d.conn())
        .expect("load budget targets")
}

/// (rule id, preset_rule_key, category_id) for one preset.
fn preset_rules(d: &Device, preset_id: &str) -> Vec<(String, Option<String>, Option<String>)> {
    spending_categorization_rules::table
        .filter(spending_categorization_rules::preset_id.eq(preset_id))
        .select((
            spending_categorization_rules::id,
            spending_categorization_rules::preset_rule_key,
            spending_categorization_rules::category_id,
        ))
        .order(spending_categorization_rules::id.asc())
        .load(&mut d.conn())
        .expect("load preset rules")
}

/// (snapshot id, source, cash_balances JSON) for one account.
fn snapshots(d: &Device, account_id: &str) -> Vec<(String, String, String)> {
    holdings_snapshots::table
        .filter(holdings_snapshots::account_id.eq(account_id))
        .select((
            holdings_snapshots::id,
            holdings_snapshots::source,
            holdings_snapshots::cash_balances,
        ))
        .order(holdings_snapshots::id.asc())
        .load(&mut d.conn())
        .expect("load snapshots")
}

/// (plan_kind, settings_json, version).
fn goal_plan(d: &Device, goal_id: &str) -> Option<(String, String, i32)> {
    goal_plans::table
        .find(goal_id)
        .select((
            goal_plans::plan_kind,
            goal_plans::settings_json,
            goal_plans::version,
        ))
        .first(&mut d.conn())
        .optional()
        .expect("read goal plan")
}

fn quote_close(d: &Device, quote_id: &str) -> Option<String> {
    quotes::table
        .find(quote_id)
        .select(quotes::close)
        .first::<String>(&mut d.conn())
        .optional()
        .expect("read quote")
}

fn activity_exists(d: &Device, activity_id: &str) -> bool {
    activities::table
        .find(activity_id)
        .select(activities::id)
        .first::<String>(&mut d.conn())
        .optional()
        .expect("read activity")
        .is_some()
}

// ----------------------------- inputs -----------------------------

/// The single-category write the activity form makes: it clears any splits.
async fn assign_category(
    repo: &ActivityTaxonomyAssignmentRepository,
    activity_id: &str,
    category_id: &str,
) {
    repo.assign_many_single_select_clearing_splits(vec![NewActivityTaxonomyAssignment {
        id: None,
        activity_id: activity_id.to_string(),
        taxonomy_id: SPENDING.to_string(),
        category_id: category_id.to_string(),
        weight: 10_000,
        source: "manual".to_string(),
    }])
    .await
    .expect("assign category on A");
}

fn split_line(category_id: &str, amount: Decimal) -> NewActivitySplit {
    NewActivitySplit {
        taxonomy_id: SPENDING.to_string(),
        category_id: category_id.to_string(),
        amount,
        note: None,
        sort_order: None,
    }
}

fn category_target(period_key: &str, category_id: &str, amount: &str) -> NewBudgetTarget {
    NewBudgetTarget {
        id: None,
        period_key: period_key.to_string(),
        target_type: BudgetTargetType::Category,
        taxonomy_id: Some(SPENDING.to_string()),
        category_id: Some(category_id.to_string()),
        group_id: None,
        amount: amount.to_string(),
    }
}

/// Preset rules as the preset import service builds them: no ID, so the
/// repository derives it from (preset, rule key).
fn preset_rule_inputs() -> Vec<NewCategorizationRule> {
    [
        ("groceries", "Groceries", "grocery", "cat_groceries"),
        ("coffee", "Coffee", "coffee", "cat_food"),
    ]
    .into_iter()
    .map(|(key, name, pattern, category_id)| NewCategorizationRule {
        id: None,
        name: name.to_string(),
        pattern: pattern.to_string(),
        match_type: RuleMatchType::Contains,
        taxonomy_id: Some(SPENDING.to_string()),
        category_id: Some(category_id.to_string()),
        activity_type: None,
        amount_op: None,
        amount_value: None,
        amount_value2: None,
        priority: 0,
        is_global: true,
        account_id: None,
        preset_id: Some("ca".to_string()),
        preset_rule_key: Some(key.to_string()),
        preset_version: Some("1".to_string()),
    })
    .collect()
}

/// A manual holdings entry, built as `save_manual_snapshot` builds it.
fn manual_snapshot(account_id: &str, date: NaiveDate, cash: i64) -> AccountStateSnapshot {
    let cash = Decimal::from(cash);
    AccountStateSnapshot {
        id: AccountStateSnapshot::stable_id(account_id, date),
        account_id: account_id.to_string(),
        snapshot_date: date,
        currency: "USD".to_string(),
        positions: HashMap::new(),
        cash_balances: HashMap::from([("USD".to_string(), cash)]),
        cost_basis: Decimal::ZERO,
        net_contribution: cash,
        net_contribution_base: cash,
        cash_total_account_currency: cash,
        cash_total_base_currency: cash,
        calculated_at: chrono::Utc::now().naive_utc(),
        source: SnapshotSource::ManualEntry,
    }
}

fn save_up_plan(goal_id: &str, monthly: u32) -> SaveGoalPlan {
    SaveGoalPlan {
        goal_id: goal_id.to_string(),
        plan_kind: "save_up".to_string(),
        planner_mode: None,
        settings_json: format!("{{\"monthlyContribution\":{monthly}}}"),
        summary_json: None,
    }
}

// ----------------------------- 1. portfolios -----------------------------

#[tokio::test]
async fn portfolio_rename_keeps_account_memberships_on_peer() {
    let (a, b) = (Device::new(), Device::new());
    seed_both(
        &a,
        &b,
        &[
            cash_account_sql(CHECKING, "Checking"),
            account_sql(BROKERAGE, "Brokerage", "SECURITIES", "TRANSACTIONS"),
        ]
        .concat(),
    );
    let repo = PortfolioRepository::new(a.pool.clone(), a.writer.clone());
    let mut seq = 0;
    let both_accounts = vec![CHECKING.to_string(), BROKERAGE.to_string()];

    let portfolio = repo
        .create(NewPortfolio {
            name: "Family".to_string(),
            description: None,
            sort_order: 0,
            account_ids: both_accounts.clone(),
        })
        .await
        .expect("create portfolio on A");
    let created = sync_cycle(&a, &b, &mut seq).await;
    let membership_ids: Vec<String> = memberships(&a, &portfolio.id)
        .into_iter()
        .map(|(_, id, _)| id)
        .collect();
    assert_eq!(membership_ids.len(), 2, "A has both memberships");
    for id in &membership_ids {
        created.assert_pushed(SyncEntity::PortfolioAccount, id, SyncOperation::Create);
    }
    assert_eq!(
        memberships(&b, &portfolio.id),
        memberships(&a, &portfolio.id),
        "B has both memberships after the create"
    );

    repo.update(PortfolioUpdate {
        id: portfolio.id.clone(),
        name: "Household".to_string(),
        description: None,
        sort_order: 0,
        account_ids: both_accounts,
    })
    .await
    .expect("rename portfolio on A");
    let renamed = sync_cycle(&a, &b, &mut seq).await;
    for id in &membership_ids {
        renamed.assert_pushed(SyncEntity::PortfolioAccount, id, SyncOperation::Delete);
        renamed.assert_pushed(SyncEntity::PortfolioAccount, id, SyncOperation::Create);
    }

    assert_eq!(
        portfolio_names(&a),
        vec![(portfolio.id.clone(), "Household".to_string())]
    );
    assert_eq!(
        member_accounts(&a, &portfolio.id),
        vec![BROKERAGE, CHECKING]
    );
    assert_eq!(
        portfolio_names(&b),
        portfolio_names(&a),
        "B shows the new name"
    );
    assert_eq!(
        memberships(&b, &portfolio.id),
        memberships(&a, &portfolio.id),
        "the rename must keep both account memberships on B"
    );
    renamed.assert_all_applied();
}

#[tokio::test]
async fn portfolio_account_removed_then_added_back_returns_on_peer() {
    let (a, b) = (Device::new(), Device::new());
    seed_both(
        &a,
        &b,
        &[
            cash_account_sql(CHECKING, "Checking"),
            account_sql(BROKERAGE, "Brokerage", "SECURITIES", "TRANSACTIONS"),
        ]
        .concat(),
    );
    let repo = PortfolioRepository::new(a.pool.clone(), a.writer.clone());
    let mut seq = 0;
    let edit = |account_ids: &[&str], id: &str| PortfolioUpdate {
        id: id.to_string(),
        name: "Family".to_string(),
        description: None,
        sort_order: 0,
        account_ids: account_ids.iter().map(|id| id.to_string()).collect(),
    };

    let portfolio = repo
        .create(NewPortfolio {
            name: "Family".to_string(),
            description: None,
            sort_order: 0,
            account_ids: vec![CHECKING.to_string(), BROKERAGE.to_string()],
        })
        .await
        .expect("create portfolio on A");
    sync_cycle(&a, &b, &mut seq).await;
    let brokerage_membership = membership_id(&a, &portfolio.id, BROKERAGE);
    assert_eq!(
        memberships(&b, &portfolio.id),
        memberships(&a, &portfolio.id)
    );

    repo.update(edit(&[CHECKING], &portfolio.id))
        .await
        .expect("remove the brokerage account on A");
    let removed = sync_cycle(&a, &b, &mut seq).await;
    removed.assert_pushed(
        SyncEntity::PortfolioAccount,
        &brokerage_membership,
        SyncOperation::Delete,
    );
    assert_eq!(member_accounts(&a, &portfolio.id), vec![CHECKING]);
    assert_eq!(
        memberships(&b, &portfolio.id),
        memberships(&a, &portfolio.id),
        "B keeps the checking membership and drops the brokerage one"
    );

    repo.update(edit(&[CHECKING, BROKERAGE], &portfolio.id))
        .await
        .expect("add the brokerage account back on A");
    let readded = sync_cycle(&a, &b, &mut seq).await;
    readded.assert_pushed(
        SyncEntity::PortfolioAccount,
        &brokerage_membership,
        SyncOperation::Create,
    );
    assert_eq!(
        member_accounts(&a, &portfolio.id),
        vec![BROKERAGE, CHECKING]
    );
    assert_eq!(
        memberships(&b, &portfolio.id),
        memberships(&a, &portfolio.id),
        "the account added back must return to the portfolio on B"
    );
    readded.assert_all_applied();
}

// ----------------------------- 2. categories -----------------------------

#[tokio::test]
async fn category_change_through_the_activity_form_reaches_peer() {
    let (a, b) = (Device::new(), Device::new());
    seed_both(&a, &b, &cash_activity_seed());
    let repo = ActivityTaxonomyAssignmentRepository::new(a.pool.clone(), a.writer.clone());
    let mut seq = 0;

    assign_category(&repo, GROCERY_RUN, "cat_food").await;
    let first = sync_cycle(&a, &b, &mut seq).await;
    let assignment = assignment_id(&a, GROCERY_RUN);
    first.assert_pushed(
        SyncEntity::ActivityTaxonomyAssignment,
        &assignment,
        SyncOperation::Create,
    );
    assert_eq!(categories(&b, GROCERY_RUN), categories(&a, GROCERY_RUN));

    // The form makes two calls: clear the taxonomy, then assign the new one.
    repo.clear_for_taxonomy(GROCERY_RUN, SPENDING)
        .await
        .expect("clear category on A");
    let cleared = sync_cycle(&a, &b, &mut seq).await;
    cleared.assert_pushed(
        SyncEntity::ActivityTaxonomyAssignment,
        &assignment,
        SyncOperation::Delete,
    );
    assert_eq!(categories(&b, GROCERY_RUN), categories(&a, GROCERY_RUN));

    assign_category(&repo, GROCERY_RUN, "cat_groceries").await;
    let changed = sync_cycle(&a, &b, &mut seq).await;
    changed.assert_pushed(
        SyncEntity::ActivityTaxonomyAssignment,
        &assignment,
        SyncOperation::Create,
    );

    assert_eq!(
        categories(&a, GROCERY_RUN),
        vec![(assignment.clone(), "cat_groceries".to_string())]
    );
    assert_eq!(
        categories(&b, GROCERY_RUN),
        categories(&a, GROCERY_RUN),
        "B must show the new category"
    );
    changed.assert_all_applied();
}

#[tokio::test]
async fn uncategorize_then_recategorize_later_reaches_peer() {
    let (a, b) = (Device::new(), Device::new());
    seed_both(&a, &b, &cash_activity_seed());
    let repo = ActivityTaxonomyAssignmentRepository::new(a.pool.clone(), a.writer.clone());
    let mut seq = 0;

    assign_category(&repo, GROCERY_RUN, "cat_food").await;
    sync_cycle(&a, &b, &mut seq).await;
    let assignment = assignment_id(&a, GROCERY_RUN);
    assert_eq!(categories(&b, GROCERY_RUN), categories(&a, GROCERY_RUN));

    repo.clear_for_taxonomy(GROCERY_RUN, SPENDING)
        .await
        .expect("uncategorize on A");
    let cleared = sync_cycle(&a, &b, &mut seq).await;
    cleared.assert_pushed(
        SyncEntity::ActivityTaxonomyAssignment,
        &assignment,
        SyncOperation::Delete,
    );
    assert!(categories(&a, GROCERY_RUN).is_empty());
    assert!(
        categories(&b, GROCERY_RUN).is_empty(),
        "B is uncategorized too"
    );

    assign_category(&repo, GROCERY_RUN, "cat_food").await;
    let recategorized = sync_cycle(&a, &b, &mut seq).await;
    recategorized.assert_pushed(
        SyncEntity::ActivityTaxonomyAssignment,
        &assignment,
        SyncOperation::Create,
    );

    assert_eq!(
        categories(&a, GROCERY_RUN),
        vec![(assignment.clone(), "cat_food".to_string())]
    );
    assert_eq!(
        categories(&b, GROCERY_RUN),
        categories(&a, GROCERY_RUN),
        "B must be categorized again"
    );
    recategorized.assert_all_applied();
}

#[tokio::test]
async fn split_then_single_category_reaches_peer() {
    let (a, b) = (Device::new(), Device::new());
    seed_both(&a, &b, &cash_activity_seed());
    let assignments = ActivityTaxonomyAssignmentRepository::new(a.pool.clone(), a.writer.clone());
    let split_repo = ActivitySplitRepository::new(a.pool.clone(), a.writer.clone());
    let mut seq = 0;

    assign_category(&assignments, GROCERY_RUN, "cat_food").await;
    sync_cycle(&a, &b, &mut seq).await;
    let assignment = assignment_id(&a, GROCERY_RUN);
    assert_eq!(categories(&b, GROCERY_RUN), categories(&a, GROCERY_RUN));

    split_repo
        .replace_for_activity_clearing_assignment(
            GROCERY_RUN,
            SPENDING,
            vec![
                split_line("cat_food", Decimal::new(20, 0)),
                split_line("cat_groceries", Decimal::new(225, 1)),
            ],
        )
        .await
        .expect("split the activity on A");
    let split = sync_cycle(&a, &b, &mut seq).await;
    split.assert_pushed(
        SyncEntity::ActivityTaxonomyAssignment,
        &assignment,
        SyncOperation::Delete,
    );
    let split_rows = splits(&a, GROCERY_RUN);
    assert_eq!(split_rows.len(), 2, "A has two split lines");
    for (id, ..) in &split_rows {
        split.assert_pushed(SyncEntity::SpendingActivitySplit, id, SyncOperation::Create);
    }
    assert!(categories(&a, GROCERY_RUN).is_empty());
    assert_eq!(splits(&b, GROCERY_RUN), split_rows, "B has the split lines");
    assert!(categories(&b, GROCERY_RUN).is_empty());

    assign_category(&assignments, GROCERY_RUN, "cat_groceries").await;
    let single = sync_cycle(&a, &b, &mut seq).await;
    for (id, ..) in &split_rows {
        single.assert_pushed(SyncEntity::SpendingActivitySplit, id, SyncOperation::Delete);
    }
    single.assert_pushed(
        SyncEntity::ActivityTaxonomyAssignment,
        &assignment,
        SyncOperation::Create,
    );

    assert!(splits(&a, GROCERY_RUN).is_empty());
    assert_eq!(
        categories(&a, GROCERY_RUN),
        vec![(assignment.clone(), "cat_groceries".to_string())]
    );
    assert!(
        splits(&b, GROCERY_RUN).is_empty(),
        "B drops the split lines"
    );
    assert_eq!(
        categories(&b, GROCERY_RUN),
        categories(&a, GROCERY_RUN),
        "B must show the single category again"
    );
    single.assert_all_applied();
}

// ----------------------------- 3. event tags -----------------------------

#[tokio::test]
async fn event_tag_cleared_then_set_again_reaches_peer() {
    let (a, b) = (Device::new(), Device::new());
    seed_both(
        &a,
        &b,
        &[cash_activity_seed(), event_sql(SPRING_TRIP, "Spring trip")].concat(),
    );
    let tags = ActivityEventsRepository::new(a.pool.clone(), a.writer.clone());
    let mut seq = 0;

    tags.set_activity_event_tag(GROCERY_RUN, Some(SPRING_TRIP.to_string()))
        .await
        .expect("tag on A");
    let tagged = sync_cycle(&a, &b, &mut seq).await;
    tagged.assert_pushed(
        SyncEntity::SpendingActivityEvent,
        GROCERY_RUN,
        SyncOperation::Update,
    );
    assert_eq!(event_tag(&a, GROCERY_RUN).as_deref(), Some(SPRING_TRIP));
    assert_eq!(event_tag(&b, GROCERY_RUN), event_tag(&a, GROCERY_RUN));

    tags.set_activity_event_tag(GROCERY_RUN, None)
        .await
        .expect("clear tag on A");
    let cleared = sync_cycle(&a, &b, &mut seq).await;
    cleared.assert_pushed(
        SyncEntity::SpendingActivityEvent,
        GROCERY_RUN,
        SyncOperation::Delete,
    );
    assert_eq!(event_tag(&a, GROCERY_RUN), None);
    assert_eq!(event_tag(&b, GROCERY_RUN), None, "B clears the tag too");

    tags.set_activity_event_tag(GROCERY_RUN, Some(SPRING_TRIP.to_string()))
        .await
        .expect("tag again on A");
    let retagged = sync_cycle(&a, &b, &mut seq).await;
    retagged.assert_pushed(
        SyncEntity::SpendingActivityEvent,
        GROCERY_RUN,
        SyncOperation::Update,
    );

    assert_eq!(event_tag(&a, GROCERY_RUN).as_deref(), Some(SPRING_TRIP));
    assert_eq!(
        event_tag(&b, GROCERY_RUN),
        event_tag(&a, GROCERY_RUN),
        "B must show the tag again"
    );
    retagged.assert_all_applied();
}

#[tokio::test]
async fn activity_tagged_with_new_event_after_old_event_deleted_reaches_peer() {
    let (a, b) = (Device::new(), Device::new());
    seed_both(
        &a,
        &b,
        &[cash_activity_seed(), event_sql(SPRING_TRIP, "Spring trip")].concat(),
    );
    let tags = ActivityEventsRepository::new(a.pool.clone(), a.writer.clone());
    let events_repo = EventsRepository::new(a.pool.clone(), a.writer.clone());
    let mut seq = 0;

    tags.set_activity_event_tag(GROCERY_RUN, Some(SPRING_TRIP.to_string()))
        .await
        .expect("tag on A");
    sync_cycle(&a, &b, &mut seq).await;
    assert_eq!(event_tag(&b, GROCERY_RUN).as_deref(), Some(SPRING_TRIP));

    events_repo
        .delete(SPRING_TRIP)
        .await
        .expect("delete the event on A");
    let deleted = sync_cycle(&a, &b, &mut seq).await;
    deleted.assert_pushed(
        SyncEntity::SpendingActivityEvent,
        GROCERY_RUN,
        SyncOperation::Delete,
    );
    deleted.assert_pushed(
        SyncEntity::SpendingEvent,
        SPRING_TRIP,
        SyncOperation::Delete,
    );
    assert!(events(&a).is_empty());
    assert_eq!(event_tag(&a, GROCERY_RUN), None);
    assert!(events(&b).is_empty(), "B deletes the event too");
    assert_eq!(event_tag(&b, GROCERY_RUN), None);

    let getaway = events_repo
        .create(NewEvent {
            id: None,
            name: "Weekend getaway".to_string(),
            description: None,
            event_type_id: TRAVEL_EVENT_TYPE.to_string(),
            start_date: "2026-03-08".to_string(),
            end_date: "2026-03-12".to_string(),
        })
        .await
        .expect("create a new event on A");
    tags.set_activity_event_tag(GROCERY_RUN, Some(getaway.id.clone()))
        .await
        .expect("tag with the new event on A");
    let retagged = sync_cycle(&a, &b, &mut seq).await;
    retagged.assert_pushed(
        SyncEntity::SpendingEvent,
        &getaway.id,
        SyncOperation::Create,
    );
    retagged.assert_pushed(
        SyncEntity::SpendingActivityEvent,
        GROCERY_RUN,
        SyncOperation::Update,
    );

    assert_eq!(
        events(&a),
        vec![(getaway.id.clone(), "Weekend getaway".to_string())]
    );
    assert_eq!(event_tag(&a, GROCERY_RUN), Some(getaway.id.clone()));
    assert_eq!(events(&b), events(&a), "B receives the new event");
    assert_eq!(
        event_tag(&b, GROCERY_RUN),
        event_tag(&a, GROCERY_RUN),
        "B must tag the activity with the new event"
    );
    retagged.assert_all_applied();
}

// ----------------------------- 4. budget -----------------------------

#[tokio::test]
async fn budget_copy_month_with_overwrite_reaches_peer() {
    let (a, b) = (Device::new(), Device::new());
    let budget = BudgetRepository::new(a.pool.clone(), a.writer.clone());
    let mut seq = 0;

    for (period, category, amount) in [
        ("2026-04", "cat_food", "400"),
        ("2026-04", "cat_groceries", "600"),
        ("2026-05", "cat_food", "300"),
        ("2026-05", "cat_groceries", "500"),
    ] {
        budget
            .upsert_target(category_target(period, category, amount))
            .await
            .expect("set a budget target on A");
    }
    sync_cycle(&a, &b, &mut seq).await;
    assert_eq!(targets(&b, "2026-04"), targets(&a, "2026-04"));
    assert_eq!(targets(&b, "2026-05"), targets(&a, "2026-05"));
    let may_ids: Vec<String> = targets(&a, "2026-05")
        .into_iter()
        .map(|(id, ..)| id)
        .collect();
    assert_eq!(may_ids.len(), 2, "A has two May targets");

    budget
        .copy_period_targets("2026-04", "2026-05", true)
        .await
        .expect("copy April over May on A");
    let copied = sync_cycle(&a, &b, &mut seq).await;
    for id in &may_ids {
        copied.assert_pushed(SyncEntity::BudgetTarget, id, SyncOperation::Delete);
        copied.assert_pushed(SyncEntity::BudgetTarget, id, SyncOperation::Update);
    }

    assert_eq!(
        targets(&a, "2026-05"),
        vec![
            (
                may_ids[0].clone(),
                Some("cat_food".to_string()),
                "400".to_string()
            ),
            (
                may_ids[1].clone(),
                Some("cat_groceries".to_string()),
                "600".to_string()
            ),
        ]
    );
    assert_eq!(
        targets(&b, "2026-05"),
        targets(&a, "2026-05"),
        "B must hold May's targets with April's amounts"
    );
    copied.assert_all_applied();
}

#[tokio::test]
async fn budget_target_deleted_then_set_again_reaches_peer() {
    let (a, b) = (Device::new(), Device::new());
    let budget = BudgetRepository::new(a.pool.clone(), a.writer.clone());
    let mut seq = 0;

    let target = budget
        .upsert_target(category_target("2026-05", "cat_food", "300"))
        .await
        .expect("set a budget target on A");
    let set = sync_cycle(&a, &b, &mut seq).await;
    set.assert_pushed(SyncEntity::BudgetTarget, &target.id, SyncOperation::Update);
    assert_eq!(targets(&b, "2026-05"), targets(&a, "2026-05"));

    budget
        .delete_target(&target.id)
        .await
        .expect("delete the target on A");
    let deleted = sync_cycle(&a, &b, &mut seq).await;
    deleted.assert_pushed(SyncEntity::BudgetTarget, &target.id, SyncOperation::Delete);
    assert!(targets(&a, "2026-05").is_empty());
    assert!(
        targets(&b, "2026-05").is_empty(),
        "B deletes the target too"
    );

    budget
        .upsert_target(category_target("2026-05", "cat_food", "350"))
        .await
        .expect("set the target again on A");
    let reset = sync_cycle(&a, &b, &mut seq).await;
    reset.assert_pushed(SyncEntity::BudgetTarget, &target.id, SyncOperation::Update);

    assert_eq!(
        targets(&a, "2026-05"),
        vec![(
            target.id.clone(),
            Some("cat_food".to_string()),
            "350".to_string()
        )]
    );
    assert_eq!(
        targets(&b, "2026-05"),
        targets(&a, "2026-05"),
        "B must hold the target set again"
    );
    reset.assert_all_applied();
}

// ----------------------------- 5. preset rules -----------------------------

#[tokio::test]
async fn preset_rules_reinstalled_after_removal_reach_peer() {
    let (a, b) = (Device::new(), Device::new());
    let rules = CategorizationRulesRepository::new(a.pool.clone(), a.writer.clone());
    let mut seq = 0;

    let installed = rules
        .import_preset_rules("ca", "1", preset_rule_inputs())
        .await
        .expect("install the preset on A");
    assert_eq!(installed.added, 2);
    let first = sync_cycle(&a, &b, &mut seq).await;
    let rule_ids: Vec<String> = preset_rules(&a, "ca")
        .into_iter()
        .map(|(id, ..)| id)
        .collect();
    assert_eq!(rule_ids.len(), 2, "A has the preset's two rules");
    for id in &rule_ids {
        first.assert_pushed(
            SyncEntity::SpendingCategorizationRule,
            id,
            SyncOperation::Create,
        );
    }
    assert_eq!(preset_rules(&b, "ca"), preset_rules(&a, "ca"));

    let (removed, kept) = rules
        .remove_preset("ca")
        .await
        .expect("remove the preset on A");
    assert_eq!((removed, kept), (2, 0));
    let uninstalled = sync_cycle(&a, &b, &mut seq).await;
    for id in &rule_ids {
        uninstalled.assert_pushed(
            SyncEntity::SpendingCategorizationRule,
            id,
            SyncOperation::Delete,
        );
    }
    assert!(preset_rules(&a, "ca").is_empty());
    assert!(
        preset_rules(&b, "ca").is_empty(),
        "B removes the preset too"
    );

    let reinstalled = rules
        .import_preset_rules("ca", "1", preset_rule_inputs())
        .await
        .expect("install the preset again on A");
    assert_eq!(reinstalled.added, 2);
    let again = sync_cycle(&a, &b, &mut seq).await;
    for id in &rule_ids {
        again.assert_pushed(
            SyncEntity::SpendingCategorizationRule,
            id,
            SyncOperation::Create,
        );
    }

    let a_rules = preset_rules(&a, "ca");
    assert_eq!(
        a_rules
            .iter()
            .map(|(id, ..)| id.clone())
            .collect::<Vec<_>>(),
        rule_ids,
        "A reinstalls the rules under the same IDs"
    );
    assert_eq!(
        preset_rules(&b, "ca"),
        a_rules,
        "B must have the reinstalled preset rules"
    );
    again.assert_all_applied();
}

// ----------------------------- 6. holdings snapshot -----------------------------

#[tokio::test]
async fn manual_snapshot_deleted_then_entered_again_reaches_peer() {
    let (a, b) = (Device::new(), Device::new());
    seed_both(
        &a,
        &b,
        &account_sql(BROKERAGE, "Brokerage", "SECURITIES", "HOLDINGS"),
    );
    let repo = SnapshotRepository::new(a.pool.clone(), a.writer.clone());
    let mut seq = 0;
    let date = NaiveDate::from_ymd_opt(2026, 3, 31).expect("valid date");
    let snapshot_id = AccountStateSnapshot::stable_id(BROKERAGE, date);

    repo.save_or_update_snapshot(&manual_snapshot(BROKERAGE, date, 1_000))
        .await
        .expect("enter holdings on A");
    let entered = sync_cycle(&a, &b, &mut seq).await;
    entered.assert_pushed(SyncEntity::Snapshot, &snapshot_id, SyncOperation::Create);
    assert_eq!(snapshots(&b, BROKERAGE), snapshots(&a, BROKERAGE));

    repo.delete_snapshot_for_account_by_id(BROKERAGE, &snapshot_id)
        .await
        .expect("delete the snapshot on A");
    let deleted = sync_cycle(&a, &b, &mut seq).await;
    deleted.assert_pushed(SyncEntity::Snapshot, &snapshot_id, SyncOperation::Delete);
    assert!(snapshots(&a, BROKERAGE).is_empty());
    assert!(
        snapshots(&b, BROKERAGE).is_empty(),
        "B deletes the snapshot too"
    );

    repo.save_or_update_snapshot(&manual_snapshot(BROKERAGE, date, 1_500))
        .await
        .expect("enter holdings again on A");
    let reentered = sync_cycle(&a, &b, &mut seq).await;
    reentered.assert_pushed(SyncEntity::Snapshot, &snapshot_id, SyncOperation::Create);

    let a_rows = snapshots(&a, BROKERAGE);
    assert_eq!(a_rows.len(), 1, "A has the re-entered snapshot");
    assert_eq!(a_rows[0].0, snapshot_id);
    assert_eq!(a_rows[0].1, "MANUAL_ENTRY");
    assert_eq!(
        snapshots(&b, BROKERAGE),
        a_rows,
        "B must have the re-entered snapshot"
    );
    reentered.assert_all_applied();
}

// ----------------------------- 7. goal plan -----------------------------

#[tokio::test]
async fn goal_plan_deleted_then_saved_again_reaches_peer() {
    let (a, b) = (Device::new(), Device::new());
    seed_both(&a, &b, &goal_sql(HOUSE_GOAL));
    let goals = GoalRepository::new(a.pool.clone(), a.writer.clone());
    let mut seq = 0;

    goals
        .save_goal_plan(save_up_plan(HOUSE_GOAL, 500))
        .await
        .expect("save the plan on A");
    let saved = sync_cycle(&a, &b, &mut seq).await;
    saved.assert_pushed(SyncEntity::GoalPlan, HOUSE_GOAL, SyncOperation::Create);
    assert_eq!(goal_plan(&b, HOUSE_GOAL), goal_plan(&a, HOUSE_GOAL));

    let removed = goals
        .delete_goal_plan(HOUSE_GOAL)
        .await
        .expect("delete the plan on A");
    assert_eq!(removed, 1);
    let deleted = sync_cycle(&a, &b, &mut seq).await;
    deleted.assert_pushed(SyncEntity::GoalPlan, HOUSE_GOAL, SyncOperation::Delete);
    assert_eq!(goal_plan(&a, HOUSE_GOAL), None);
    assert_eq!(goal_plan(&b, HOUSE_GOAL), None, "B deletes the plan too");

    goals
        .save_goal_plan(save_up_plan(HOUSE_GOAL, 750))
        .await
        .expect("save the plan again on A");
    let resaved = sync_cycle(&a, &b, &mut seq).await;
    resaved.assert_pushed(SyncEntity::GoalPlan, HOUSE_GOAL, SyncOperation::Create);

    assert_eq!(
        goal_plan(&a, HOUSE_GOAL),
        Some((
            "save_up".to_string(),
            "{\"monthlyContribution\":750}".to_string(),
            1
        ))
    );
    assert_eq!(
        goal_plan(&b, HOUSE_GOAL),
        goal_plan(&a, HOUSE_GOAL),
        "B must have the plan saved again"
    );
    resaved.assert_all_applied();
}

// ----------------------------- 8. manual quote -----------------------------

/// Receiver-level: manual `{asset}_{day}_MANUAL` quotes don't reach the
/// outbox yet, so these events are synthetic.
#[tokio::test]
async fn manual_quote_deleted_then_recreated_is_applied() {
    let b = Device::new();
    b.seed(
        "INSERT INTO assets (id, kind, name, display_code, notes, metadata, is_active, \
         quote_mode, quote_ccy, instrument_type, instrument_symbol, instrument_exchange_mic, \
         provider_config, created_at, updated_at) \
         VALUES ('asset-manual', 'INVESTMENT', 'Private fund', 'PRIV', NULL, NULL, 1, 'MANUAL', \
         'USD', NULL, NULL, NULL, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');",
    );
    let quote_id = "asset-manual_2025-01-03_MANUAL";
    let quote = |close: &str| {
        json!({
            "id": quote_id,
            "asset_id": "asset-manual",
            "day": "2025-01-03",
            "source": "MANUAL",
            "close": close,
            "currency": "USD",
            "created_at": "2025-01-03T00:00:00Z",
            "timestamp": "2025-01-03T16:00:00Z"
        })
    };

    let created = replay(
        &b,
        remote_event(
            SyncEntity::Quote,
            quote_id,
            SyncOperation::Create,
            "evt-quote-create",
            "2026-02-01T00:00:10Z",
            1,
            quote("100"),
        ),
    )
    .await;
    assert_eq!(created, 1);
    assert_eq!(quote_close(&b, quote_id).as_deref(), Some("100"));

    let deleted = replay(
        &b,
        remote_event(
            SyncEntity::Quote,
            quote_id,
            SyncOperation::Delete,
            "evt-quote-delete",
            "2026-02-01T00:00:20Z",
            2,
            json!({ "id": quote_id }),
        ),
    )
    .await;
    assert_eq!(deleted, 1);
    assert_eq!(quote_close(&b, quote_id), None);

    let recreated = replay(
        &b,
        remote_event(
            SyncEntity::Quote,
            quote_id,
            SyncOperation::Create,
            "evt-quote-recreate",
            "2026-02-01T00:00:30Z",
            3,
            quote("105"),
        ),
    )
    .await;
    assert_eq!(
        quote_close(&b, quote_id).as_deref(),
        Some("105"),
        "a newer manual quote for the same asset and day must be stored again"
    );
    assert_eq!(recreated, 1);
}

// ----------------------------- 9. stale delete -----------------------------

#[tokio::test]
async fn stale_delete_does_not_remove_newer_reused_id_row() {
    let b = Device::new();
    b.seed(
        &[
            cash_account_sql(CHECKING, "Checking"),
            "INSERT INTO portfolios (id, name, description, sort_order, created_at, updated_at) \
         VALUES ('pf-family', 'Family', NULL, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');"
                .to_string(),
        ]
        .concat(),
    );
    let membership = "pfm_pf-family_acc-checking";

    let created = replay(
        &b,
        remote_event(
            SyncEntity::PortfolioAccount,
            membership,
            SyncOperation::Create,
            "evt-membership-create",
            "2026-02-01T00:00:10Z",
            1,
            json!({
                "id": membership,
                "portfolio_id": "pf-family",
                "account_id": CHECKING,
                "sort_order": 0,
                "created_at": "2026-02-01T00:00:10Z"
            }),
        ),
    )
    .await;
    assert_eq!(created, 1);
    assert!(membership_exists(&b, membership));

    let stale = replay(
        &b,
        remote_event(
            SyncEntity::PortfolioAccount,
            membership,
            SyncOperation::Delete,
            "evt-membership-delete-stale",
            "2026-02-01T00:00:05Z",
            2,
            json!({ "id": membership }),
        ),
    )
    .await;
    assert!(
        membership_exists(&b, membership),
        "a delete older than the create must not remove the membership"
    );
    assert_eq!(stale, 0, "the stale delete is not applied");
}

// ----------------------------- 10. guard -----------------------------

/// Random-UUID entities keep delete-wins: newer writes never bring back a
/// deleted activity. Must pass before and after the reused-ID fix.
#[tokio::test]
async fn deleted_activity_stays_deleted_against_newer_writes() {
    let b = Device::new();
    let activity_id = "6b1f8c1e-7a40-4d2b-9a34-0f3c2f6f9d11";
    b.seed(
        &[
            cash_account_sql(CHECKING, "Checking"),
            manual_withdrawal_sql(activity_id, CHECKING, "42.5"),
        ]
        .concat(),
    );
    let activity = |amount: &str| {
        json!({
            "id": activity_id,
            "account_id": CHECKING,
            "activity_type": "WITHDRAWAL",
            "status": "POSTED",
            "activity_date": "2026-03-10T00:00:00Z",
            "amount": amount,
            "currency": "USD",
            "source_system": "MANUAL",
            "is_user_modified": 0,
            "needs_review": 0,
            "created_at": "2026-03-10T00:00:00Z",
            "updated_at": "2026-03-10T00:00:00Z"
        })
    };

    let deleted = replay(
        &b,
        remote_event(
            SyncEntity::Activity,
            activity_id,
            SyncOperation::Delete,
            "evt-activity-delete",
            "2026-02-01T00:00:10Z",
            1,
            json!({ "id": activity_id }),
        ),
    )
    .await;
    assert_eq!(deleted, 1);
    assert!(!activity_exists(&b, activity_id));

    let updated = replay(
        &b,
        remote_event(
            SyncEntity::Activity,
            activity_id,
            SyncOperation::Update,
            "evt-activity-update",
            "2026-02-01T00:00:20Z",
            2,
            activity("50"),
        ),
    )
    .await;
    assert_eq!(
        updated, 0,
        "a newer update must not revive a deleted activity"
    );

    let recreated = replay(
        &b,
        remote_event(
            SyncEntity::Activity,
            activity_id,
            SyncOperation::Create,
            "evt-activity-create",
            "2026-02-01T00:00:30Z",
            3,
            activity("60"),
        ),
    )
    .await;
    assert_eq!(
        recreated, 0,
        "a newer create must not revive a deleted activity"
    );
    assert!(
        !activity_exists(&b, activity_id),
        "the activity stays deleted on B"
    );
}
