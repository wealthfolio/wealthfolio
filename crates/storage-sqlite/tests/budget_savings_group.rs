//! The Savings budget group shows top-level savings categories with their
//! targets, the transfers to savings categorized there, and the same editing
//! flows as expense categories: moving a category and rollover.
#![allow(clippy::unwrap_used, clippy::panic, reason = "test code")]
mod common;

use std::sync::Arc;

use diesel::connection::SimpleConnection;
use wealthfolio_core::fx::{FxService, FxServiceTrait, NewExchangeRate};
use wealthfolio_core::taxonomies::TaxonomyService;
use wealthfolio_spending::analytics::{AnalyticsService, MonthlyReport, ReportRequest};
use wealthfolio_spending::budget::{
    BudgetCategoryRow, BudgetGroupRow, BudgetOperation, BudgetRolloverTargetType, BudgetService,
    BudgetSnapshot, BudgetTargetType, NewBudgetRolloverSetting, NewBudgetTarget,
};
use wealthfolio_spending::events::EventsService;
use wealthfolio_spending::insight::{InsightService, SpendingInsight, SpendingInsightRequest};
use wealthfolio_spending::settings::{SpendingSettingsService, SpendingSettingsUpdate};
use wealthfolio_storage_sqlite::accounts::AccountRepository;
use wealthfolio_storage_sqlite::activities::ActivityRepository;
use wealthfolio_storage_sqlite::db;
use wealthfolio_storage_sqlite::fx::FxRepository;
use wealthfolio_storage_sqlite::spending::activity_assignments::ActivityTaxonomyAssignmentRepository;
use wealthfolio_storage_sqlite::spending::activity_events::ActivityEventsRepository;
use wealthfolio_storage_sqlite::spending::activity_splits::ActivitySplitRepository;
use wealthfolio_storage_sqlite::spending::budget::BudgetRepository;
use wealthfolio_storage_sqlite::spending::events::{EventTypesRepository, EventsRepository};
use wealthfolio_storage_sqlite::spending::settings::SpendingSettingsRepository;
use wealthfolio_storage_sqlite::taxonomies::TaxonomyRepository;

const SAVINGS: &str = "savings_categories";
const SPENDING: &str = "spending_categories";
const MONTH: &str = "2026-06";
const NEEDS_ID: &str = "032ecb02-5912-42e8-9724-2cd566fc08d5";
const SAVINGS_ID: &str = "1fb6f2a3-3245-4702-83e8-ab116458d13e";

struct Fixture {
    pool: Arc<db::DbPool>,
    service: BudgetService,
    insight: InsightService,
    analytics: AnalyticsService,
    settings: Arc<SpendingSettingsService>,
    fx: Arc<FxService>,
    _dir: common::TestDir,
}

impl Fixture {
    async fn new() -> Self {
        let dir = common::TestDir::new();
        let access = db::DbAccess::plaintext(dir.path().join("app.db").to_str().unwrap());
        access.prepare().unwrap();
        access.run_migrations().unwrap();
        let pool = access.create_pool().unwrap();
        let writer = db::write_actor::spawn_writer((*pool).clone()).unwrap();
        let settings = Arc::new(SpendingSettingsService::new(Arc::new(
            SpendingSettingsRepository::new(pool.clone(), writer.clone()),
        )));
        let budget_repo = Arc::new(BudgetRepository::new(pool.clone(), writer.clone()));
        let activity_repo = Arc::new(ActivityRepository::new(pool.clone(), writer.clone()));
        let account_repo = Arc::new(AccountRepository::new(pool.clone(), writer.clone()));
        let assignment_repo = Arc::new(ActivityTaxonomyAssignmentRepository::new(
            pool.clone(),
            writer.clone(),
        ));
        let split_repo = Arc::new(ActivitySplitRepository::new(pool.clone(), writer.clone()));
        let taxonomy = Arc::new(TaxonomyService::new(Arc::new(TaxonomyRepository::new(
            pool.clone(),
            writer.clone(),
        ))));
        let fx = Arc::new(FxService::new(Arc::new(FxRepository::new(
            pool.clone(),
            writer.clone(),
        ))));
        let service = BudgetService::new(
            budget_repo.clone(),
            activity_repo.clone(),
            account_repo.clone(),
            assignment_repo.clone(),
            split_repo.clone(),
            settings.clone(),
            taxonomy.clone(),
            fx.clone(),
        );
        let activity_events = Arc::new(ActivityEventsRepository::new(pool.clone(), writer.clone()));
        let events = Arc::new(EventsService::new(
            Arc::new(EventTypesRepository::new(pool.clone(), writer.clone())),
            Arc::new(EventsRepository::new(pool.clone(), writer.clone())),
            activity_repo.clone(),
            activity_events.clone(),
        ));
        let analytics = AnalyticsService::new(
            activity_repo.clone(),
            account_repo.clone(),
            assignment_repo.clone(),
            split_repo.clone(),
            settings.clone(),
            taxonomy.clone(),
            events,
            fx.clone(),
            activity_events,
        );
        let insight = InsightService::new(
            budget_repo,
            activity_repo,
            account_repo,
            assignment_repo,
            split_repo,
            settings.clone(),
            taxonomy,
            fx.clone(),
        );
        let fixture = Self {
            pool,
            service,
            insight,
            analytics,
            settings: settings.clone(),
            fx,
            _dir: dir,
        };
        // Two spending accounts and a brokerage account outside the spending set.
        fixture.seed(
            "INSERT INTO accounts (id,name,account_type,currency,is_default,is_active,created_at,updated_at,is_archived,tracking_mode) VALUES
              ('checking','Checking','CASH','EUR',0,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,0,'TRANSACTIONS'),
              ('cash-savings','Cash savings','CASH','EUR',0,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,0,'TRANSACTIONS'),
              ('brokerage','Brokerage','SECURITIES','EUR',0,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,0,'TRANSACTIONS');",
        );
        settings
            .update(SpendingSettingsUpdate {
                enabled: Some(true),
                account_ids: Some(vec!["checking".into(), "cash-savings".into()]),
                excluded_category_ids: None,
            })
            .await
            .unwrap();
        fixture
    }

    fn seed(&self, sql: &str) {
        db::get_connection(&self.pool)
            .unwrap()
            .batch_execute(sql)
            .unwrap();
    }

    /// One posted transfer leg, with an optional savings category.
    #[allow(clippy::too_many_arguments)]
    fn transfer(
        &self,
        id: &str,
        account_id: &str,
        activity_type: &str,
        date: &str,
        amount: &str,
        group: &str,
        savings_category: Option<&str>,
    ) {
        self.seed(&format!(
            "INSERT INTO activities (id,account_id,activity_type,status,activity_date,amount,currency,source_system,source_group_id,is_user_modified,needs_review,created_at,updated_at)
             VALUES ('{id}','{account_id}','{activity_type}','POSTED','{date}','{amount}','EUR','MANUAL','{group}',0,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);"
        ));
        if let Some(category_id) = savings_category {
            self.seed(&format!(
                "INSERT INTO activity_taxonomy_assignments (id,activity_id,taxonomy_id,category_id,weight,source,created_at,updated_at)
                 VALUES ('asg-{id}','{id}','{SAVINGS}','{category_id}',10000,'manual',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);"
            ));
        }
    }

    /// Existing split data, seeded without today's cash-flow validation.
    fn savings_split(&self, activity_id: &str, category_id: &str, amount: &str) {
        self.seed(&format!(
            "INSERT INTO spending_activity_splits (id,activity_id,taxonomy_id,category_id,amount)
             VALUES ('split-{activity_id}-{category_id}','{activity_id}','{SAVINGS}','{category_id}','{amount}');"
        ));
    }

    /// One posted expense from checking with a spending category.
    fn expense(&self, id: &str, date: &str, amount: &str, category_id: &str) {
        self.seed(&format!(
            "INSERT INTO activities (id,account_id,activity_type,status,activity_date,amount,currency,source_system,is_user_modified,needs_review,created_at,updated_at)
             VALUES ('{id}','checking','WITHDRAWAL','POSTED','{date}','{amount}','EUR','MANUAL',0,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
             INSERT INTO activity_taxonomy_assignments (id,activity_id,taxonomy_id,category_id,weight,source,created_at,updated_at)
             VALUES ('asg-{id}','{id}','{SPENDING}','{category_id}',10000,'manual',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);"
        ));
    }

    async fn target(&self, period_key: &str, taxonomy_id: &str, category_id: &str, amount: &str) {
        self.service
            .upsert_target(
                NewBudgetTarget {
                    id: None,
                    period_key: period_key.into(),
                    target_type: BudgetTargetType::Category,
                    taxonomy_id: Some(taxonomy_id.into()),
                    category_id: Some(category_id.into()),
                    group_id: None,
                    amount: amount.into(),
                },
                Some(MONTH.into()),
                "EUR",
                "UTC",
            )
            .await
            .unwrap();
    }

    /// Insight over the whole of June, as the dashboard asks for it.
    async fn insight(&self) -> SpendingInsight {
        self.insight_window("2026-06-01T00:00:00Z", "2026-06-30T23:59:59Z", "EUR", "UTC")
            .await
    }

    async fn insight_window(
        &self,
        start: &str,
        end: &str,
        currency: &str,
        timezone: &str,
    ) -> SpendingInsight {
        self.insight
            .compute(
                SpendingInsightRequest {
                    start_date: start.into(),
                    end_date: end.into(),
                    compare_start_date: None,
                    compare_end_date: None,
                    account_ids: None,
                    compare: None,
                },
                currency,
                timezone,
            )
            .await
            .unwrap()
    }

    async fn budget(&self, period_key: &str) -> BudgetSnapshot {
        self.service
            .get(Some(period_key.into()), "EUR", "UTC")
            .await
            .unwrap()
    }

    async fn report(
        &self,
        start: &str,
        end: &str,
        currency: &str,
        timezone: &str,
    ) -> MonthlyReport {
        self.analytics
            .monthly_report(
                ReportRequest {
                    start_date: start.into(),
                    end_date: end.into(),
                    account_ids: None,
                },
                timezone,
                currency,
            )
            .await
            .unwrap()
    }

    async fn review(&self, operation: BudgetOperation) -> BudgetSnapshot {
        let review = self
            .service
            .prepare_change(operation, Some(MONTH.into()), "EUR", "UTC")
            .await
            .unwrap();
        self.service
            .commit_change(review, "EUR", "UTC")
            .await
            .unwrap()
    }
}

fn group<'a>(snapshot: &'a BudgetSnapshot, group_id: &str) -> &'a BudgetGroupRow {
    snapshot
        .computed
        .group_rows
        .iter()
        .find(|row| row.group.id == group_id)
        .unwrap()
}

fn savings_row(group: &BudgetGroupRow) -> Option<&BudgetCategoryRow> {
    group
        .categories
        .iter()
        .find(|row| row.taxonomy_id == SAVINGS && row.category_id == "cat_savings")
}

fn category_rollover(on: bool) -> NewBudgetRolloverSetting {
    NewBudgetRolloverSetting {
        id: None,
        target_type: BudgetRolloverTargetType::Category,
        taxonomy_id: Some(SAVINGS.into()),
        category_id: Some("cat_savings".into()),
        group_id: None,
        enabled: on,
        start_month: MONTH.into(),
        starting_balance: "0".into(),
    }
}

/// June: 300 to the brokerage for retirement, 50 to the brokerage on the
/// top-level Savings category, and 40 between the two spending accounts with
/// its other leg in May.
async fn june_fixture() -> Fixture {
    let f = Fixture::new().await;
    f.transfer(
        "retire-out",
        "checking",
        "TRANSFER_OUT",
        "2026-06-05T12:00:00Z",
        "300",
        "pair-retire",
        Some("cat_savings_retirement"),
    );
    f.transfer(
        "retire-in",
        "brokerage",
        "TRANSFER_IN",
        "2026-06-05T12:00:00Z",
        "300",
        "pair-retire",
        None,
    );
    f.transfer(
        "general-out",
        "checking",
        "TRANSFER_OUT",
        "2026-06-10T12:00:00Z",
        "50",
        "pair-general",
        Some("cat_savings"),
    );
    f.transfer(
        "general-in",
        "brokerage",
        "TRANSFER_IN",
        "2026-06-10T12:00:00Z",
        "50",
        "pair-general",
        None,
    );
    f.transfer(
        "internal-in",
        "cash-savings",
        "TRANSFER_IN",
        "2026-05-31T12:00:00Z",
        "40",
        "pair-internal",
        None,
    );
    f.transfer(
        "internal-out",
        "checking",
        "TRANSFER_OUT",
        "2026-06-01T12:00:00Z",
        "40",
        "pair-internal",
        Some("cat_savings_emergency"),
    );
    f.service
        .upsert_target(
            NewBudgetTarget {
                id: None,
                period_key: MONTH.into(),
                target_type: BudgetTargetType::Category,
                taxonomy_id: Some(SAVINGS.into()),
                category_id: Some("cat_savings".into()),
                group_id: None,
                amount: "400".into(),
            },
            Some(MONTH.into()),
            "EUR",
            "UTC",
        )
        .await
        .unwrap();
    f
}

#[tokio::test]
async fn savings_row_counts_categorized_transfers_out_of_the_spending_accounts() {
    let f = june_fixture().await;
    let june = f.budget(MONTH).await;
    let savings = group(&june, SAVINGS_ID);
    let row = savings_row(savings).expect("Savings row in the Savings group");

    assert_eq!(row.target, 400.0);
    // 300 + 50; the move between two spending accounts is not saving.
    assert_eq!(row.actual, 350.0);
    assert_eq!(savings.savings_actual, 350.0);
    // The group's spending figures hold no savings.
    assert_eq!(savings.actual, 0.0);
}

/// Old assignments and split lines can survive a transfer being linked or its
/// accounts changing scope. Neither may turn a debt balance transfer into goal
/// progress, including when the other card is archived or outside the window.
#[tokio::test]
async fn budget_balance_transfers_match_insight_despite_stale_savings_allocations() {
    for archived in [false, true] {
        for use_split in [false, true] {
            let f = Fixture::new().await;
            f.seed(&format!(
                "UPDATE accounts SET account_type='CREDIT_CARD' WHERE id IN ('checking','brokerage');
                 UPDATE accounts SET is_archived={} WHERE id='brokerage';",
                i32::from(archived),
            ));
            f.transfer(
                "balance-out",
                "checking",
                "TRANSFER_OUT",
                "2026-06-05T12:00:00Z",
                "1000",
                "pair-balance",
                (!use_split).then_some("cat_savings_retirement"),
            );
            f.transfer(
                "balance-in",
                "brokerage",
                "TRANSFER_IN",
                "2026-05-31T12:00:00Z",
                "1000",
                "pair-balance",
                None,
            );
            if use_split {
                f.savings_split("balance-out", "cat_savings_retirement", "1000");
            }
            // Context lookup must never import unrelated outside-account spend.
            f.expense("outside", "2026-06-10T12:00:00Z", "900", "cat_groceries");
            f.seed("UPDATE activities SET account_id='brokerage' WHERE id='outside';");

            let insight = f.insight().await;
            let report = f
                .report("2026-06-01T00:00:00Z", "2026-06-30T23:59:59Z", "EUR", "UTC")
                .await;
            assert_eq!(insight.headline.saved, 0.0);
            assert_eq!(insight.headline.spent, 0.0);
            assert_eq!(report.current.saved, insight.headline.saved);
            assert_eq!(report.current.outflow, insight.headline.spent);
            let june = f.budget(MONTH).await;
            assert_eq!(
                june.computed.totals.savings_actual, insight.headline.saved,
                "archived={archived}, split={use_split}",
            );
            assert_eq!(june.computed.totals.spending_actual, 0.0);
            assert_eq!(savings_row(group(&june, SAVINGS_ID)).unwrap().actual, 0.0);
        }
    }
}

/// Both directions of a cross-month internal transfer need the other month's
/// context. Genuine saving and returns still use their own buckets. Split
/// lines override a stale assignment, and spending exclusions stay independent.
#[tokio::test]
async fn budget_transfer_context_preserves_local_windows_fx_and_allocations() {
    for account_type in ["CASH", "CREDIT_CARD"] {
        let f = Fixture::new().await;
        f.seed(&format!(
            "UPDATE accounts SET account_type='{account_type}' WHERE id IN ('checking','cash-savings');
             INSERT INTO taxonomy_categories (id,taxonomy_id,name,key,color,sort_order)
             VALUES ('other-goal','savings_categories','Other goal','other_goal','#000000',99);"
        ));
        f.settings
            .update(SpendingSettingsUpdate {
                enabled: None,
                account_ids: None,
                excluded_category_ids: Some(vec!["cat_groceries".into()]),
            })
            .await
            .unwrap();
        f.fx.add_exchange_rate(NewExchangeRate {
            from_currency: "EUR".into(),
            to_currency: "USD".into(),
            rate: rust_decimal::Decimal::from(2),
            source: "MANUAL".into(),
        })
        .await
        .unwrap();

        for (id, account, kind, date, amount, pair, category) in [
            (
                "internal-out",
                "checking",
                "TRANSFER_OUT",
                "2026-06-01T03:59:59Z",
                "1000",
                "internal",
                Some("cat_savings"),
            ),
            (
                "internal-in",
                "cash-savings",
                "TRANSFER_IN",
                "2026-06-01T04:00:00Z",
                "1000",
                "internal",
                Some("cat_savings"),
            ),
            (
                "saved-out",
                "checking",
                "TRANSFER_OUT",
                "2026-06-01T04:00:00Z",
                "300",
                "saved",
                Some("other-goal"),
            ),
            (
                "saved-in",
                "brokerage",
                "TRANSFER_IN",
                "2026-06-01T04:00:00Z",
                "300",
                "saved",
                None,
            ),
            (
                "returned-out",
                "brokerage",
                "TRANSFER_OUT",
                "2026-07-01T03:59:59Z",
                "70",
                "returned",
                None,
            ),
            (
                "returned-in",
                "checking",
                "TRANSFER_IN",
                "2026-07-01T03:59:59Z",
                "70",
                "returned",
                Some("cat_savings"),
            ),
            // This genuine saving belongs to July locally and must stay out of June.
            (
                "july-out",
                "checking",
                "TRANSFER_OUT",
                "2026-07-01T04:00:00Z",
                "500",
                "july",
                Some("cat_savings"),
            ),
            (
                "july-in",
                "brokerage",
                "TRANSFER_IN",
                "2026-07-01T04:00:00Z",
                "500",
                "july",
                None,
            ),
        ] {
            f.transfer(id, account, kind, date, amount, pair, category);
        }
        f.savings_split("saved-out", "cat_savings_retirement", "100");
        f.savings_split("saved-out", "cat_savings_emergency", "200");
        f.savings_split("returned-in", "cat_savings", "70");
        f.expense("excluded", "2026-06-15T12:00:00Z", "60", "cat_groceries");
        f.expense("included", "2026-06-15T12:00:00Z", "30", "cat_food");
        f.expense("uncategorized", "2026-06-15T12:00:00Z", "20", "cat_food");
        f.seed("DELETE FROM activity_taxonomy_assignments WHERE activity_id='uncategorized';");

        let timezone = "America/Toronto";
        let start = "2026-06-01T04:00:00Z";
        let end = "2026-07-01T03:59:59Z";
        let june = f
            .service
            .get(Some(MONTH.into()), "USD", timezone)
            .await
            .unwrap();
        let insight = f.insight_window(start, end, "USD", timezone).await;
        let report = f.report(start, end, "USD", timezone).await;
        let totals = &june.computed.totals;
        assert_eq!(totals.savings_actual, 600.0, "{account_type}");
        assert_eq!(savings_row(group(&june, SAVINGS_ID)).unwrap().actual, 600.0);
        assert_eq!(
            june.computed
                .group_rows
                .iter()
                .flat_map(|g| &g.categories)
                .find(|c| c.category_id == "other-goal")
                .unwrap()
                .actual,
            0.0
        );
        assert_eq!(insight.headline.saved, totals.savings_actual);
        assert_eq!(report.current.saved, totals.savings_actual);
        assert_eq!(insight.headline.from_savings, 140.0);
        assert_eq!(report.current.from_savings, 140.0);
        assert_eq!(totals.spending_actual, 60.0);
        // Budget rows contain categorized spend; report/insight headlines also
        // include 40 of uncategorized spend. The excluded 120 appears nowhere.
        assert_eq!(insight.uncategorized.spent, 40.0);
        assert_eq!(insight.headline.spent, totals.spending_actual + 40.0);
        assert_eq!(report.current.outflow, insight.headline.spent);
        assert_eq!(report.current.net, insight.headline.net_cashflow);
        let june_bucket = insight.by_month.iter().find(|m| m.month == MONTH).unwrap();
        assert_eq!(june_bucket.saved, 600.0);
        assert_eq!(june_bucket.from_savings, 140.0);
        assert_eq!(insight.by_month.iter().map(|m| m.saved).sum::<f64>(), 600.0);
        let may = f
            .service
            .get(Some("2026-05".into()), "USD", timezone)
            .await
            .unwrap();
        assert_eq!(may.computed.totals.savings_actual, 0.0);
    }
}

#[tokio::test]
async fn budget_balance_transfers_do_not_consume_savings_rollover() {
    let f = june_fixture().await;
    f.seed("UPDATE accounts SET account_type='CREDIT_CARD' WHERE id='checking';
            INSERT INTO accounts (id,name,account_type,currency,is_default,is_active,created_at,updated_at,is_archived,tracking_mode)
            VALUES ('outside-card','Archived card','CREDIT_CARD','EUR',0,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,1,'TRANSACTIONS');");
    f.transfer(
        "balance-out",
        "checking",
        "TRANSFER_OUT",
        "2026-06-05T12:00:00Z",
        "1000",
        "balance",
        Some("cat_savings"),
    );
    f.transfer(
        "balance-in",
        "outside-card",
        "TRANSFER_IN",
        "2026-05-31T12:00:00Z",
        "1000",
        "balance",
        None,
    );
    f.target("default", SAVINGS, "cat_savings", "400").await;
    f.service
        .upsert_rollover_setting(category_rollover(true), Some(MONTH.into()), "EUR", "UTC")
        .await
        .unwrap();

    let june = f.budget(MONTH).await;
    assert_eq!(june.computed.totals.savings_actual, 350.0);
    let july = f.budget("2026-07").await;
    let row = savings_row(group(&july, SAVINGS_ID)).unwrap();
    assert_eq!(row.actual, 0.0);
    assert_eq!(row.rollover_in, 50.0);
    assert_eq!(row.remaining, 450.0);
    assert_eq!(row.rollover_out, 450.0);
    assert!(!row.overspent);
    assert_eq!(july.computed.totals.spending_actual, 0.0);
}

#[tokio::test]
async fn budget_unlinked_transfers_keep_expense_income_and_card_behavior() {
    for (account_type, spent, income) in [("CASH", 100.0, 40.0), ("CREDIT_CARD", 0.0, 0.0)] {
        let f = Fixture::new().await;
        f.seed(&format!(
            "UPDATE accounts SET account_type='{account_type}' WHERE id='checking';"
        ));
        f.expense("out", "2026-06-15T12:00:00Z", "100", "cat_groceries");
        f.expense("in", "2026-06-15T12:00:00Z", "40", "cat_groceries");
        f.seed("UPDATE activities SET activity_type='TRANSFER_OUT' WHERE id='out';
                UPDATE activities SET activity_type='TRANSFER_IN' WHERE id='in';
                UPDATE activity_taxonomy_assignments SET taxonomy_id='income_sources',category_id='cat_income_salary' WHERE activity_id='in';");
        let june = f.budget(MONTH).await;
        let insight = f.insight().await;
        let report = f
            .report("2026-06-01T00:00:00Z", "2026-06-30T23:59:59Z", "EUR", "UTC")
            .await;
        assert_eq!(june.computed.totals.spending_actual, spent);
        assert_eq!(june.computed.totals.income_actual, income);
        assert_eq!(june.computed.totals.savings_actual, 0.0);
        assert_eq!(insight.headline.spent, spent);
        assert_eq!(insight.headline.income, income);
        assert_eq!(report.current.outflow, spent);
        assert_eq!(report.current.income, income);
        assert_eq!(report.current.saved, 0.0);
    }
}

#[tokio::test]
async fn savings_category_moves_to_another_group() {
    let f = june_fixture().await;

    let moved = f
        .service
        .assign_category_to_group(
            Some(SAVINGS.into()),
            "cat_savings".into(),
            NEEDS_ID.into(),
            Some(MONTH.into()),
            "EUR",
            "UTC",
        )
        .await
        .unwrap();
    assert!(savings_row(group(&moved, NEEDS_ID)).is_some());
    assert!(savings_row(group(&moved, SAVINGS_ID)).is_none());

    let back = f
        .review(BudgetOperation::AssignCategory {
            taxonomy_id: SAVINGS.into(),
            category_id: "cat_savings".into(),
            group_id: SAVINGS_ID.into(),
        })
        .await;
    assert!(savings_row(group(&back, SAVINGS_ID)).is_some());
    assert!(back
        .state
        .group_assignments
        .iter()
        .all(|a| a.category_id != "cat_savings" || a.taxonomy_id == SAVINGS));
}

/// A savings rollover carries an unmet goal into the next month. Group
/// rollover carries the group's expense budget, so turning it on, directly or
/// through a review, leaves the savings rollover alone.
#[tokio::test]
async fn savings_rollover_carries_the_unmet_goal_apart_from_group_rollover() {
    let f = june_fixture().await;
    f.target("default", SAVINGS, "cat_savings", "400").await;
    let mut may_start = category_rollover(true);
    may_start.start_month = "2026-05".into();
    let june = f
        .service
        .upsert_rollover_setting(may_start, Some(MONTH.into()), "EUR", "UTC")
        .await
        .unwrap();
    let row = savings_row(group(&june, SAVINGS_ID)).unwrap();
    assert!(row.rollover_enabled);
    // Nothing saved in May: its 400 carries in, so 450 is still to save.
    assert_eq!(row.rollover_in, 400.0);
    assert_eq!(row.remaining, 450.0);
    assert!(!row.overspent);

    let group_rollover = |group_id: &str| NewBudgetRolloverSetting {
        id: None,
        target_type: BudgetRolloverTargetType::Group,
        taxonomy_id: None,
        category_id: None,
        group_id: Some(group_id.into()),
        enabled: true,
        start_month: MONTH.into(),
        starting_balance: "0".into(),
    };
    let june = f
        .service
        .upsert_rollover_setting(group_rollover(SAVINGS_ID), Some(MONTH.into()), "EUR", "UTC")
        .await
        .unwrap();
    assert!(group(&june, SAVINGS_ID).rollover_enabled);
    assert!(
        savings_row(group(&june, SAVINGS_ID))
            .unwrap()
            .rollover_enabled
    );

    // The savings category moves to Needs; a reviewed group rollover there
    // turns off Needs' expense rollovers but not the savings one.
    f.service
        .assign_category_to_group(
            Some(SAVINGS.into()),
            "cat_savings".into(),
            NEEDS_ID.into(),
            Some(MONTH.into()),
            "EUR",
            "UTC",
        )
        .await
        .unwrap();
    f.service
        .upsert_rollover_setting(
            NewBudgetRolloverSetting {
                taxonomy_id: Some(SPENDING.into()),
                category_id: Some("cat_groceries".into()),
                ..category_rollover(true)
            },
            Some(MONTH.into()),
            "EUR",
            "UTC",
        )
        .await
        .unwrap();
    let june = f
        .review(BudgetOperation::SetRollover {
            setting: group_rollover(NEEDS_ID),
        })
        .await;
    let needs = group(&june, NEEDS_ID);
    assert!(needs.rollover_enabled);
    assert!(savings_row(needs).unwrap().rollover_enabled);
    assert!(
        !spending_row(needs, "cat_groceries")
            .unwrap()
            .rollover_enabled
    );

    // With Needs' group rollover on, a savings rollover can still be set,
    // directly and through a review; an expense one cannot.
    f.service
        .upsert_rollover_setting(category_rollover(true), Some(MONTH.into()), "EUR", "UTC")
        .await
        .unwrap();
    f.review(BudgetOperation::SetRollover {
        setting: category_rollover(true),
    })
    .await;
    let groceries = NewBudgetRolloverSetting {
        taxonomy_id: Some(SPENDING.into()),
        category_id: Some("cat_groceries".into()),
        ..category_rollover(true)
    };
    assert!(f
        .service
        .upsert_rollover_setting(groceries.clone(), Some(MONTH.into()), "EUR", "UTC")
        .await
        .is_err());
    assert!(f
        .service
        .prepare_change(
            BudgetOperation::SetRollover { setting: groceries },
            Some(MONTH.into()),
            "EUR",
            "UTC"
        )
        .await
        .is_err());
}

/// June as in `june_fixture`, plus a 100 groceries budget and 150 of groceries.
async fn mixed_fixture() -> Fixture {
    let f = june_fixture().await;
    f.target(MONTH, SPENDING, "cat_groceries", "100").await;
    f.expense("groceries", "2026-06-12T12:00:00Z", "150", "cat_groceries");
    f
}

fn spending_row<'a>(group: &'a BudgetGroupRow, category_id: &str) -> Option<&'a BudgetCategoryRow> {
    group
        .categories
        .iter()
        .find(|row| row.taxonomy_id == SPENDING && row.category_id == category_id)
}

/// Spending figures are consumption only: the dashboard compares them with
/// consumption outflow, and Insight's headline is the same consumption.
#[tokio::test]
async fn spending_totals_are_consumption_and_match_insight() {
    let f = mixed_fixture().await;
    let june = f.budget(MONTH).await;
    let totals = &june.computed.totals;

    assert_eq!(totals.spending_planned, 100.0);
    assert_eq!(totals.spending_actual, 150.0);
    assert_eq!(totals.spending_remaining, -50.0);
    assert_eq!(totals.savings_planned, 400.0);
    assert_eq!(totals.savings_actual, 350.0);
    assert_eq!(totals.overspent_count, 2, "groceries and Needs");
    let savings = group(&june, SAVINGS_ID);
    assert_eq!((savings.planned_total, savings.actual), (0.0, 0.0));
    assert_eq!(
        (savings.savings_target_total, savings.savings_actual),
        (400.0, 350.0)
    );

    let insight = f.insight().await;
    assert_eq!(insight.headline.spent, totals.spending_actual);
    assert_eq!(insight.headline.budget, totals.spending_planned);
    assert_eq!(insight.headline.saved, 350.0);
}

/// Savings targets are goals: saving more than the target is ahead, not over.
#[tokio::test]
async fn saving_past_the_goal_is_not_overspending() {
    let f = june_fixture().await;
    f.transfer(
        "extra-out",
        "checking",
        "TRANSFER_OUT",
        "2026-06-20T12:00:00Z",
        "100",
        "pair-extra",
        Some("cat_savings"),
    );
    f.transfer(
        "extra-in",
        "brokerage",
        "TRANSFER_IN",
        "2026-06-20T12:00:00Z",
        "100",
        "pair-extra",
        None,
    );
    let june = f.budget(MONTH).await;
    let savings = group(&june, SAVINGS_ID);
    let row = savings_row(savings).unwrap();

    assert_eq!(row.actual, 450.0);
    // 50 ahead of the goal.
    assert_eq!(row.remaining, -50.0);
    assert!(!row.overspent);
    assert!(!savings.overspent);
    assert_eq!(june.computed.totals.overspent_count, 0);
}

/// Money brought back from savings is one uncategorized "from savings" figure:
/// the app does not let it take a category, so it never lowers a savings goal,
/// even when an older row still carries a savings category. Goals then match
/// Insight's savings breakdown, which counts money moved to savings.
#[tokio::test]
async fn money_brought_back_from_savings_leaves_goals_as_saved() {
    let f = june_fixture().await;
    for (id, category) in [("back", None), ("stale", Some("cat_savings"))] {
        f.transfer(
            &format!("{id}-out"),
            "brokerage",
            "TRANSFER_OUT",
            "2026-06-25T12:00:00Z",
            "100",
            &format!("pair-{id}"),
            None,
        );
        f.transfer(
            &format!("{id}-in"),
            "checking",
            "TRANSFER_IN",
            "2026-06-25T12:00:00Z",
            "100",
            &format!("pair-{id}"),
            category,
        );
    }
    let june = f.budget(MONTH).await;
    let row = savings_row(group(&june, SAVINGS_ID)).unwrap();
    assert_eq!(row.actual, 350.0);
    assert_eq!(row.remaining, 50.0);
    assert_eq!(june.computed.totals.savings_actual, 350.0);
    assert_eq!(june.computed.totals.spending_actual, 0.0);

    let insight = f.insight().await;
    assert_eq!(insight.headline.from_savings, 200.0);
    let breakdown: f64 = insight.savings_breakdown.iter().map(|r| r.amount).sum();
    assert_eq!(breakdown, june.computed.totals.savings_actual);
}

/// An expense category moved into the Savings group stays consumption in
/// Budget and in Insight; only where it is listed changes.
#[tokio::test]
async fn expense_category_in_the_savings_group_stays_consumption() {
    let f = mixed_fixture().await;
    let moved = f
        .service
        .assign_category_to_group(
            Some(SPENDING.into()),
            "cat_groceries".into(),
            SAVINGS_ID.into(),
            Some(MONTH.into()),
            "EUR",
            "UTC",
        )
        .await
        .unwrap();

    let insight = f.insight().await;
    assert_eq!(insight.headline.spent, 150.0);
    assert_eq!(insight.headline.saved, 350.0);
    let insight_savings = insight
        .groups
        .iter()
        .find(|g| g.group.id == SAVINGS_ID)
        .expect("Savings group lists the groceries it now holds");
    assert_eq!(insight_savings.spent, 150.0);
    assert_eq!(insight_savings.budget.total, 100.0);

    let savings = group(&moved, SAVINGS_ID);
    assert!(spending_row(savings, "cat_groceries").is_some());
    assert_eq!(savings.actual, 150.0);
    assert!(savings.overspent);
    assert_eq!(moved.computed.totals.spending_actual, 150.0);
    assert_eq!(moved.computed.totals.spending_planned, 100.0);
    assert_eq!(moved.computed.totals.savings_actual, 350.0);
    assert_eq!(savings.savings_actual, 350.0);
}

/// A savings category moved into Needs stays out of Needs' consumption.
#[tokio::test]
async fn savings_category_in_an_expense_group_stays_out_of_consumption() {
    let f = mixed_fixture().await;
    let moved = f
        .service
        .assign_category_to_group(
            Some(SAVINGS.into()),
            "cat_savings".into(),
            NEEDS_ID.into(),
            Some(MONTH.into()),
            "EUR",
            "UTC",
        )
        .await
        .unwrap();
    let needs = group(&moved, NEEDS_ID);
    assert!(savings_row(needs).is_some());
    assert_eq!(needs.actual, 150.0);
    assert_eq!(needs.planned_total, 100.0);
    assert!(needs.overspent);
    assert_eq!(
        (needs.savings_target_total, needs.savings_actual),
        (400.0, 350.0)
    );
    assert_eq!(moved.computed.totals.spending_actual, 150.0);
    assert_eq!(moved.computed.totals.spending_planned, 100.0);
    assert_eq!(moved.computed.totals.savings_actual, 350.0);

    let insight = f.insight().await;
    assert_eq!(insight.headline.spent, 150.0);
    assert_eq!(insight.headline.saved, 350.0);
    let needs = insight
        .groups
        .iter()
        .find(|g| g.group.id == NEEDS_ID)
        .unwrap();
    assert_eq!(needs.spent, 150.0);
    assert!(needs.categories.iter().all(|c| c.taxonomy_id == SPENDING));
    // The Savings group, now empty, shows like any other empty group.
    let savings = insight
        .groups
        .iter()
        .find(|g| g.group.id == SAVINGS_ID)
        .unwrap();
    assert_eq!(savings.spent, 0.0);
}

/// By default the Savings group holds only savings categories, so Insight
/// leaves it out of its spending groups; a buffer there is spending budget.
#[tokio::test]
async fn insight_lists_the_savings_group_only_with_consumption() {
    let f = mixed_fixture().await;
    let insight = f.insight().await;
    assert!(insight.groups.iter().all(|g| g.group.id != SAVINGS_ID));

    f.service
        .upsert_target(
            NewBudgetTarget {
                id: None,
                period_key: MONTH.into(),
                target_type: BudgetTargetType::GroupBuffer,
                taxonomy_id: None,
                category_id: None,
                group_id: Some(SAVINGS_ID.into()),
                amount: "30".into(),
            },
            Some(MONTH.into()),
            "EUR",
            "UTC",
        )
        .await
        .unwrap();
    let june = f.budget(MONTH).await;
    let insight = f.insight().await;
    assert!(insight.groups.iter().any(|g| g.group.id == SAVINGS_ID));
    assert_eq!(june.computed.totals.spending_planned, 130.0);
    assert_eq!(
        insight.headline.budget,
        june.computed.totals.spending_planned
    );
}

/// An expense category may share its id with a savings category. Each keeps
/// its own group, and a move changes only the category it names.
#[tokio::test]
async fn same_id_in_both_taxonomies_keeps_separate_groups() {
    let f = june_fixture().await;
    f.seed(
        "INSERT INTO taxonomy_categories (id,taxonomy_id,parent_id,name,key,color,sort_order)
         VALUES ('cat_savings','spending_categories',NULL,'Savings fees','savings_fees','#000000',50);",
    );
    let june = f.budget(MONTH).await;
    let other_id = june
        .state
        .groups
        .iter()
        .find(|g| g.key == "other")
        .unwrap()
        .id
        .clone();
    // Unassigned expense row lands in Other; the savings row keeps Savings.
    assert!(savings_row(group(&june, SAVINGS_ID)).is_some());
    assert!(spending_row(group(&june, &other_id), "cat_savings").is_some());
    assert!(spending_row(group(&june, SAVINGS_ID), "cat_savings").is_none());

    // A direct move of the savings category leaves the expense one in Other.
    let moved = f
        .service
        .assign_category_to_group(
            Some(SAVINGS.into()),
            "cat_savings".into(),
            NEEDS_ID.into(),
            Some(MONTH.into()),
            "EUR",
            "UTC",
        )
        .await
        .unwrap();
    assert!(savings_row(group(&moved, NEEDS_ID)).is_some());
    assert!(spending_row(group(&moved, &other_id), "cat_savings").is_some());

    // A reviewed move of the expense category leaves the savings one in Needs.
    let moved = f
        .review(BudgetOperation::AssignCategory {
            taxonomy_id: SPENDING.into(),
            category_id: "cat_savings".into(),
            group_id: SAVINGS_ID.into(),
        })
        .await;
    assert!(savings_row(group(&moved, NEEDS_ID)).is_some());
    assert!(spending_row(group(&moved, SAVINGS_ID), "cat_savings").is_some());

    // Callers that send no taxonomy moved expense categories before savings
    // existed in groups; they still do.
    let legacy: BudgetOperation = serde_json::from_value(serde_json::json!({
        "operation": "assign_category",
        "categoryId": "cat_savings",
        "groupId": other_id,
    }))
    .unwrap();
    let moved = f.review(legacy).await;
    assert!(savings_row(group(&moved, NEEDS_ID)).is_some());
    assert!(spending_row(group(&moved, &other_id), "cat_savings").is_some());
    let moved = f
        .service
        .assign_category_to_group(
            None,
            "cat_savings".into(),
            SAVINGS_ID.into(),
            Some(MONTH.into()),
            "EUR",
            "UTC",
        )
        .await
        .unwrap();
    assert!(savings_row(group(&moved, NEEDS_ID)).is_some());
    assert!(spending_row(group(&moved, SAVINGS_ID), "cat_savings").is_some());
}
