//! Budget group deletion preserves defaults, effective plans, and user edits.
#![allow(clippy::unwrap_used, clippy::panic, reason = "test code")]
mod common;

use std::sync::Arc;

use diesel::connection::SimpleConnection;
use wealthfolio_core::fx::FxService;
use wealthfolio_core::taxonomies::TaxonomyService;
use wealthfolio_spending::budget::{
    BudgetOperation, BudgetRepositoryTrait, BudgetRolloverTargetType, BudgetService,
    BudgetSnapshot, BudgetTargetType, NewBudgetGroupAssignment, NewBudgetRolloverSetting,
    NewBudgetTarget,
};
use wealthfolio_spending::insight::{InsightService, SpendingInsightRequest};
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

const SOURCE: &str = "8cbd26c8-e3b2-4176-8c61-e5c11e10b808";
const DESTINATION: &str = "3ff71753-5dd5-4372-9ca2-63d8d9a04851";
const OTHER: &str = "6e25d097-0c73-4521-9407-d47e8dfb73e2";

struct Fixture {
    pool: Arc<db::DbPool>,
    repo: Arc<BudgetRepository>,
    service: BudgetService,
    insight: InsightService,
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
        let insight = InsightService::new(
            budget_repo.clone(),
            activity_repo,
            account_repo,
            assignment_repo,
            split_repo,
            settings.clone(),
            taxonomy,
            fx,
        );
        settings
            .update(SpendingSettingsUpdate {
                enabled: Some(true),
                account_ids: Some(vec!["cash".into()]),
                excluded_category_ids: None,
            })
            .await
            .unwrap();
        let fixture = Self {
            pool,
            repo: budget_repo,
            service,
            insight,
            _dir: dir,
        };
        fixture.seed("INSERT INTO accounts (id,name,account_type,currency,is_default,is_active,created_at,updated_at,is_archived,tracking_mode) VALUES ('cash','Cash','CASH','USD',0,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,0,'TRANSACTIONS');");
        fixture
    }

    fn seed(&self, sql: &str) {
        db::get_connection(&self.pool)
            .unwrap()
            .batch_execute(sql)
            .unwrap();
    }

    async fn buffer(&self, group: &str, period: &str, amount: &str) {
        self.repo
            .upsert_target(NewBudgetTarget {
                id: None,
                period_key: period.into(),
                target_type: BudgetTargetType::GroupBuffer,
                taxonomy_id: None,
                category_id: None,
                group_id: Some(group.into()),
                amount: amount.into(),
            })
            .await
            .unwrap();
    }

    async fn get(&self, period: &str) -> BudgetSnapshot {
        self.service
            .get(Some(period.into()), "USD", "UTC")
            .await
            .unwrap()
    }
}

#[tokio::test]
async fn optional_defaults_stay_deleted_across_reads_reviewed_writes_and_restart() {
    let f = Fixture::new().await;
    assert_eq!(
        f.repo.list_groups().await.unwrap().len(),
        6,
        "fresh migrations seed all defaults"
    );
    f.service
        .delete_group(SOURCE, DESTINATION, Some("2026-03".into()), "USD", "UTC")
        .await
        .unwrap();
    for readonly in [true, false] {
        let snapshot = if readonly {
            f.service
                .get_readonly(Some("2026-03".into()), "USD", "UTC")
                .await
                .unwrap()
        } else {
            f.get("2026-03").await
        };
        assert!(!snapshot.state.groups.iter().any(|g| g.id == SOURCE));
    }
    let review = f
        .service
        .prepare_change(
            BudgetOperation::SetTarget {
                target: NewBudgetTarget {
                    id: None,
                    period_key: "default".into(),
                    target_type: BudgetTargetType::GroupBuffer,
                    taxonomy_id: None,
                    category_id: None,
                    group_id: Some(DESTINATION.into()),
                    amount: "25".into(),
                },
            },
            Some("2026-03".into()),
            "USD",
            "UTC",
        )
        .await
        .unwrap();
    f.service.commit_change(review, "USD", "UTC").await.unwrap();
    // Re-running startup migrations and reopening the database must not reseed.
    let access = db::DbAccess::plaintext(f._dir.path().join("app.db").to_str().unwrap());
    access.run_migrations().unwrap();
    let reopened_pool = access.create_pool().unwrap();
    let writer = db::write_actor::spawn_writer((*reopened_pool).clone()).unwrap();
    let reopened = BudgetRepository::new(reopened_pool, writer);
    assert!(!reopened
        .list_groups()
        .await
        .unwrap()
        .iter()
        .any(|g| g.id == SOURCE));
    let insight = f
        .insight
        .compute(
            SpendingInsightRequest {
                start_date: "2026-03-01T00:00:00Z".into(),
                end_date: "2026-03-31T23:59:59Z".into(),
                compare_start_date: None,
                compare_end_date: None,
                account_ids: None,
                compare: None,
            },
            "USD",
            "UTC",
        )
        .await
        .unwrap();
    assert!(!serde_json::to_string(&insight).unwrap().contains(SOURCE));
    assert!(!f
        .get("2026-04")
        .await
        .state
        .groups
        .iter()
        .any(|g| g.id == SOURCE));
    f.service.reset_groups(None, "USD", "UTC").await.unwrap();
    assert_eq!(
        f.repo
            .list_groups()
            .await
            .unwrap()
            .iter()
            .find(|g| g.key == "giving")
            .unwrap()
            .id,
        SOURCE
    );
}

#[tokio::test]
async fn only_other_is_synthesized_and_materialized_on_reads_and_reviewed_writes() {
    let f = Fixture::new().await;
    f.seed("DELETE FROM budget_group_assignments; DELETE FROM budget_groups;");
    let pure = f
        .service
        .get_readonly(Some("2026-03".into()), "USD", "UTC")
        .await
        .unwrap();
    assert_eq!(pure.state.groups.len(), 1);
    assert_eq!(pure.state.groups[0].id, OTHER);
    assert!(
        f.repo.list_groups().await.unwrap().is_empty(),
        "readonly must not persist repairs"
    );
    let review = f
        .service
        .prepare_change(
            BudgetOperation::SetTarget {
                target: NewBudgetTarget {
                    id: None,
                    period_key: "default".into(),
                    target_type: BudgetTargetType::GroupBuffer,
                    taxonomy_id: None,
                    category_id: None,
                    group_id: Some(OTHER.into()),
                    amount: "10".into(),
                },
            },
            Some("2026-03".into()),
            "USD",
            "UTC",
        )
        .await
        .unwrap();
    f.service.commit_change(review, "USD", "UTC").await.unwrap();
    assert_eq!(f.repo.list_groups().await.unwrap().len(), 1);
    f.repo.delete_group(OTHER).await.unwrap();
    let ordinary = f.get("2026-03").await;
    assert_eq!(ordinary.state.groups.len(), 1);
    assert_eq!(ordinary.state.groups[0].id, OTHER);
    assert_eq!(f.repo.list_groups().await.unwrap().len(), 1);
}

#[tokio::test]
async fn monthly_snapshot_totals_and_remaining_survive_deletion_with_disabled_destination_rollover()
{
    for reviewed in [false, true] {
        let f = Fixture::new().await;
        f.buffer(SOURCE, "default", "100").await;
        f.buffer(SOURCE, "2026-03", "50").await;
        f.buffer(DESTINATION, "default", "200").await;
        f.repo
            .upsert_rollover_setting(NewBudgetRolloverSetting {
                id: None,
                target_type: BudgetRolloverTargetType::Group,
                taxonomy_id: None,
                category_id: None,
                group_id: Some(DESTINATION.into()),
                enabled: false,
                start_month: "2026-01".into(),
                starting_balance: "75".into(),
            })
            .await
            .unwrap();
        let before = f.get("2026-03").await;
        let after = if reviewed {
            let review = f
                .service
                .prepare_change(
                    BudgetOperation::DeleteGroup {
                        id: SOURCE.into(),
                        reassign_to_group_id: DESTINATION.into(),
                    },
                    Some("2026-03".into()),
                    "USD",
                    "UTC",
                )
                .await
                .unwrap();
            f.service.commit_change(review, "USD", "UTC").await.unwrap()
        } else {
            f.service
                .delete_group(SOURCE, DESTINATION, Some("2026-03".into()), "USD", "UTC")
                .await
                .unwrap()
        };
        assert_eq!(
            serde_json::to_value(before.computed.totals).unwrap(),
            serde_json::to_value(after.computed.totals).unwrap()
        );
        let row = after
            .computed
            .group_rows
            .iter()
            .find(|r| r.group.id == DESTINATION)
            .unwrap();
        assert_eq!(row.planned_total, 250.0);
        assert_eq!(row.remaining, 250.0);
        assert_eq!(after.state.rollover_settings[0].starting_balance, "75");
        assert_eq!(f.get("2026-04").await.computed.totals.group_buffer, 300.0);
    }
}

#[tokio::test]
async fn deleting_savings_group_preserves_category_targets_actuals_and_goal_rollover() {
    const SAVINGS: &str = "1fb6f2a3-3245-4702-83e8-ab116458d13e";
    for reviewed in [false, true] {
        let f = Fixture::new().await;
        for (taxonomy, category, amount) in [
            ("spending_categories", "cat_groceries", "100"),
            ("savings_categories", "cat_savings", "200"),
        ] {
            f.repo
                .upsert_group_assignment(NewBudgetGroupAssignment {
                    id: None,
                    group_id: SAVINGS.into(),
                    taxonomy_id: taxonomy.into(),
                    category_id: category.into(),
                })
                .await
                .unwrap();
            f.repo
                .upsert_target(NewBudgetTarget {
                    id: None,
                    period_key: "default".into(),
                    target_type: BudgetTargetType::Category,
                    taxonomy_id: Some(taxonomy.into()),
                    category_id: Some(category.into()),
                    group_id: None,
                    amount: amount.into(),
                })
                .await
                .unwrap();
        }
        f.seed("INSERT INTO activities (id,account_id,activity_type,status,activity_date,amount,currency,source_system,is_user_modified,needs_review,created_at,updated_at) VALUES
            ('expense','cash','WITHDRAWAL','POSTED','2026-03-10T12:00:00Z','75','USD','MANUAL',0,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
            ('saved','cash','TRANSFER_OUT','POSTED','2026-03-11T12:00:00Z','80','USD','MANUAL',0,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
            ('back','cash','TRANSFER_IN','POSTED','2026-03-12T12:00:00Z','30','USD','MANUAL',0,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
            INSERT INTO activity_taxonomy_assignments (id,activity_id,taxonomy_id,category_id,weight,source) VALUES
            ('expense-category','expense','spending_categories','cat_groceries',10000,'manual'),
            ('saved-category','saved','savings_categories','cat_savings',10000,'manual'),
            ('back-category','back','savings_categories','cat_savings',10000,'manual');");
        f.repo
            .upsert_rollover_setting(NewBudgetRolloverSetting {
                id: None,
                target_type: BudgetRolloverTargetType::Category,
                taxonomy_id: Some("savings_categories".into()),
                category_id: Some("cat_savings".into()),
                group_id: None,
                enabled: true,
                start_month: "2026-03".into(),
                starting_balance: "25".into(),
            })
            .await
            .unwrap();
        let before = f.get("2026-03").await;
        let after = if reviewed {
            let review = f
                .service
                .prepare_change(
                    BudgetOperation::DeleteGroup {
                        id: SAVINGS.into(),
                        reassign_to_group_id: DESTINATION.into(),
                    },
                    Some("2026-03".into()),
                    "USD",
                    "UTC",
                )
                .await
                .unwrap();
            f.service.commit_change(review, "USD", "UTC").await.unwrap()
        } else {
            f.service
                .delete_group(SAVINGS, DESTINATION, Some("2026-03".into()), "USD", "UTC")
                .await
                .unwrap()
        };
        // Comparing the complete totals also covers the separate savings fields
        // when this regression runs with the savings-goal implementation.
        assert_eq!(
            serde_json::to_value(&before.computed.totals).unwrap(),
            serde_json::to_value(&after.computed.totals).unwrap()
        );
        assert_eq!(after.computed.totals.spending_planned, 100.0);
        assert_eq!(after.computed.totals.spending_actual, 75.0);
        assert_eq!(after.computed.totals.spending_remaining, 25.0);
        assert_eq!(
            serde_json::to_value(&before.state.targets).unwrap(),
            serde_json::to_value(&after.state.targets).unwrap()
        );
        assert_eq!(
            serde_json::to_value(&before.state.rollover_settings).unwrap(),
            serde_json::to_value(&after.state.rollover_settings).unwrap()
        );
        assert!(after
            .state
            .group_assignments
            .iter()
            .filter(|a| a.category_id == "cat_savings" || a.category_id == "cat_groceries")
            .all(|a| a.group_id == DESTINATION));
    }
}

#[tokio::test]
async fn every_optional_default_can_be_deleted_and_only_other_remains() {
    let f = Fixture::new().await;
    let groups = f.repo.list_groups().await.unwrap();
    for (index, group) in groups.into_iter().filter(|g| g.id != OTHER).enumerate() {
        if index % 2 == 0 {
            f.service
                .delete_group(&group.id, OTHER, None, "USD", "UTC")
                .await
                .unwrap();
        } else {
            let review = f
                .service
                .prepare_change(
                    BudgetOperation::DeleteGroup {
                        id: group.id,
                        reassign_to_group_id: OTHER.into(),
                    },
                    None,
                    "USD",
                    "UTC",
                )
                .await
                .unwrap();
            f.service.commit_change(review, "USD", "UTC").await.unwrap();
        }
    }
    let snapshot = f.get("2026-03").await;
    assert_eq!(snapshot.state.groups.len(), 1);
    assert_eq!(snapshot.state.groups[0].id, OTHER);
    assert!(snapshot
        .state
        .group_assignments
        .iter()
        .all(|a| a.group_id == OTHER));
    f.service.reset_groups(None, "USD", "UTC").await.unwrap();
    assert_eq!(f.get("2026-03").await.state.groups.len(), 6);
}

#[tokio::test]
async fn writer_validation_keeps_the_runtime_input_error_contract() {
    let f = Fixture::new().await;
    let error = f
        .service
        .delete_group(OTHER, DESTINATION, None, "USD", "UTC")
        .await
        .unwrap_err();
    assert!(matches!(
        error.downcast_ref::<wealthfolio_spending::error::SpendingError>(),
        Some(wealthfolio_spending::error::SpendingError::InvalidInput { .. })
    ));
    let review = f
        .service
        .prepare_change(
            BudgetOperation::DeleteGroup {
                id: SOURCE.into(),
                reassign_to_group_id: DESTINATION.into(),
            },
            None,
            "USD",
            "UTC",
        )
        .await
        .unwrap();
    f.buffer(SOURCE, "2026-04", "25").await;
    let error = f
        .service
        .commit_change(review, "USD", "UTC")
        .await
        .unwrap_err();
    assert!(matches!(
        error.downcast_ref::<wealthfolio_spending::error::SpendingError>(),
        Some(wealthfolio_spending::error::SpendingError::InvalidInput { .. })
    ));
    assert!(f
        .repo
        .list_groups()
        .await
        .unwrap()
        .iter()
        .any(|g| g.id == SOURCE));
}
