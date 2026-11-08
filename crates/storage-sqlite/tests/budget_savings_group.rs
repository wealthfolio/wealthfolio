//! The Savings budget group shows top-level savings categories with their
//! targets, the transfers to savings categorized there, and the same editing
//! flows as expense categories: moving a category and rollover.
#![allow(clippy::unwrap_used, clippy::panic, reason = "test code")]
mod common;

use std::sync::Arc;

use diesel::connection::SimpleConnection;
use wealthfolio_core::fx::FxService;
use wealthfolio_core::taxonomies::TaxonomyService;
use wealthfolio_spending::budget::{
    BudgetCategoryRow, BudgetGroupRow, BudgetOperation, BudgetRolloverTargetType, BudgetService,
    BudgetSnapshot, BudgetTargetType, NewBudgetRolloverSetting, NewBudgetTarget,
};
use wealthfolio_spending::settings::{SpendingSettingsService, SpendingSettingsUpdate};
use wealthfolio_storage_sqlite::accounts::AccountRepository;
use wealthfolio_storage_sqlite::activities::ActivityRepository;
use wealthfolio_storage_sqlite::db;
use wealthfolio_storage_sqlite::fx::FxRepository;
use wealthfolio_storage_sqlite::spending::activity_assignments::ActivityTaxonomyAssignmentRepository;
use wealthfolio_storage_sqlite::spending::activity_splits::ActivitySplitRepository;
use wealthfolio_storage_sqlite::spending::budget::BudgetRepository;
use wealthfolio_storage_sqlite::spending::settings::SpendingSettingsRepository;
use wealthfolio_storage_sqlite::taxonomies::TaxonomyRepository;

const SAVINGS: &str = "savings_categories";
const MONTH: &str = "2026-06";
const NEEDS_ID: &str = "032ecb02-5912-42e8-9724-2cd566fc08d5";
const SAVINGS_ID: &str = "1fb6f2a3-3245-4702-83e8-ab116458d13e";

struct Fixture {
    pool: Arc<db::DbPool>,
    service: BudgetService,
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
        let service = BudgetService::new(
            Arc::new(BudgetRepository::new(pool.clone(), writer.clone())),
            Arc::new(ActivityRepository::new(pool.clone(), writer.clone())),
            Arc::new(AccountRepository::new(pool.clone(), writer.clone())),
            Arc::new(ActivityTaxonomyAssignmentRepository::new(
                pool.clone(),
                writer.clone(),
            )),
            Arc::new(ActivitySplitRepository::new(pool.clone(), writer.clone())),
            settings.clone(),
            Arc::new(TaxonomyService::new(Arc::new(TaxonomyRepository::new(
                pool.clone(),
                writer.clone(),
            )))),
            Arc::new(FxService::new(Arc::new(FxRepository::new(
                pool.clone(),
                writer.clone(),
            )))),
        );
        let fixture = Self {
            pool,
            service,
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

    async fn budget(&self, period_key: &str) -> BudgetSnapshot {
        self.service
            .get(Some(period_key.into()), "EUR", "UTC")
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
    assert_eq!(savings.actual, 350.0);
}

#[tokio::test]
async fn savings_category_moves_to_another_group() {
    let f = june_fixture().await;

    let moved = f
        .service
        .assign_category_to_group(
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

#[tokio::test]
async fn savings_category_rolls_over_until_its_group_does() {
    let f = june_fixture().await;
    let june = f
        .service
        .upsert_rollover_setting(category_rollover(true), Some(MONTH.into()), "EUR", "UTC")
        .await
        .unwrap();
    assert!(
        savings_row(group(&june, SAVINGS_ID))
            .unwrap()
            .rollover_enabled
    );

    // Turning on the group's rollover through a reviewed change turns the
    // category's off, as the direct path does.
    let june = f
        .review(BudgetOperation::SetRollover {
            setting: NewBudgetRolloverSetting {
                id: None,
                target_type: BudgetRolloverTargetType::Group,
                taxonomy_id: None,
                category_id: None,
                group_id: Some(SAVINGS_ID.into()),
                enabled: true,
                start_month: MONTH.into(),
                starting_balance: "0".into(),
            },
        })
        .await;
    assert!(group(&june, SAVINGS_ID).rollover_enabled);
    assert!(
        !savings_row(group(&june, SAVINGS_ID))
            .unwrap()
            .rollover_enabled
    );
}
