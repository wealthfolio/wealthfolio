//! Category deletion must preserve real financial references while allowing
//! removal of untouched automatic budget links, through the shared writer.
#![allow(clippy::unwrap_used, clippy::panic, reason = "test code")]

use diesel::connection::SimpleConnection;
use std::sync::Arc;
use wealthfolio_core::taxonomies::{
    NewCategory, TaxonomyRepositoryTrait, TaxonomyService, TaxonomyServiceTrait,
};
use wealthfolio_storage_sqlite::{db, taxonomies::TaxonomyRepository};

struct Fixture {
    _dir: tempfile::TempDir,
    pool: Arc<db::DbPool>,
    repo: Arc<TaxonomyRepository>,
    service: TaxonomyService,
    writer: db::WriteHandle,
}
impl Fixture {
    async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let access = db::DbAccess::plaintext(dir.path().join("app.db").to_str().unwrap());
        access.prepare().unwrap();
        access.run_migrations().unwrap();
        let pool = access.create_pool().unwrap();
        let writer = db::write_actor::spawn_writer((*pool).clone()).unwrap();
        let repo = Arc::new(TaxonomyRepository::new(pool.clone(), writer.clone()));
        let service = TaxonomyService::new(repo.clone());
        service
            .create_category(NewCategory {
                id: Some("custom".into()),
                taxonomy_id: "spending_categories".into(),
                name: "Custom".into(),
                key: "custom_delete_test".into(),
                ..Default::default()
            })
            .await
            .unwrap();
        Self {
            _dir: dir,
            pool,
            repo,
            service,
            writer,
        }
    }
    fn seed(&self, sql: &str) {
        db::get_connection(&self.pool)
            .unwrap()
            .batch_execute(sql)
            .unwrap();
    }
}

#[tokio::test]
async fn untouched_automatic_budget_link_does_not_block_category_deletion() {
    let fixture = Fixture::new().await;
    fixture.seed("INSERT INTO budget_group_assignments (id, group_id, taxonomy_id, category_id, is_system)
        VALUES ('automatic', '032ecb02-5912-42e8-9724-2cd566fc08d5', 'spending_categories', 'custom', 1)");
    assert_eq!(
        fixture
            .service
            .delete_category("spending_categories", "custom")
            .await
            .unwrap(),
        1
    );
}

#[tokio::test]
async fn split_references_prevent_cascading_allocation_loss() {
    let fixture = Fixture::new().await;
    fixture.seed("INSERT INTO accounts (id,name,account_type,currency,is_default,is_active,created_at,updated_at,is_archived,tracking_mode)
        VALUES ('cash','Cash','CASH','USD',0,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,0,'TRANSACTIONS');
        INSERT INTO activities (id,account_id,activity_type,status,activity_date,amount,currency,source_system,is_user_modified,needs_review,created_at,updated_at)
        VALUES ('charge','cash','WITHDRAWAL','POSTED','2026-01-01T00:00:00Z','10','USD','MANUAL',0,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
        INSERT INTO spending_activity_splits (id,activity_id,taxonomy_id,category_id,amount)
        VALUES ('split','charge','spending_categories','custom','10')");
    assert!(fixture
        .service
        .delete_category("spending_categories", "custom")
        .await
        .is_err());
    // The repository rechecks inside the writer too, covering a reference that
    // arrives after a service's read-side preflight.
    assert!(fixture
        .repo
        .delete_category("spending_categories", "custom")
        .await
        .is_err());
    assert!(fixture
        .repo
        .get_category("spending_categories", "custom")
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn explicit_budget_group_configuration_is_protected() {
    let fixture = Fixture::new().await;
    fixture.seed(
        "INSERT INTO budget_group_assignments (id,group_id,taxonomy_id,category_id,is_system)
        VALUES ('manual','032ecb02-5912-42e8-9724-2cd566fc08d5','spending_categories','custom',0)",
    );
    assert!(fixture
        .service
        .delete_category("spending_categories", "custom")
        .await
        .is_err());
    assert!(fixture
        .repo
        .delete_category("spending_categories", "custom")
        .await
        .is_err());
}

#[tokio::test]
async fn edited_seed_link_is_user_configuration() {
    let f = Fixture::new().await;
    f.seed("INSERT INTO budget_group_assignments (id,group_id,taxonomy_id,category_id,is_system,created_at,updated_at) VALUES ('edited','032ecb02-5912-42e8-9724-2cd566fc08d5','spending_categories','custom',1,'2026-01-01','2026-01-02')");
    let refs = f
        .repo
        .get_category_references("spending_categories", "custom")
        .unwrap();
    assert_eq!(refs.budget_group_assignments, 1);
    assert_eq!(refs.automatic_budget_links, 0);
    assert!(f
        .repo
        .delete_category("spending_categories", "custom")
        .await
        .is_err());
}

#[tokio::test]
async fn reviewed_edits_recheck_state_and_tree_inside_writer() {
    let f = Fixture::new().await;
    let initial = f
        .repo
        .get_category("spending_categories", "custom")
        .unwrap()
        .unwrap();
    let mut renamed = initial.clone();
    renamed.name = "Renamed".into();
    let current = f
        .repo
        .update_category_reviewed(initial.clone(), renamed)
        .await
        .unwrap();
    assert_eq!(current.name, "Renamed");
    assert!(f
        .repo
        .delete_category_reviewed(initial.clone())
        .await
        .is_err());
    assert!(f
        .repo
        .update_category_reviewed(initial.clone(), initial)
        .await
        .is_err());
    let mut cycle = current.clone();
    cycle.parent_id = Some(current.id.clone());
    assert!(f
        .repo
        .update_category_reviewed(current.clone(), cycle)
        .await
        .is_err());
    let mut duplicate = current.clone();
    duplicate.key = f
        .repo
        .get_categories("spending_categories")
        .unwrap()
        .into_iter()
        .find(|c| c.id != "custom")
        .unwrap()
        .key;
    assert!(f
        .repo
        .update_category_reviewed(current.clone(), duplicate)
        .await
        .is_err());
    assert_eq!(
        f.repo
            .get_category("spending_categories", "custom")
            .unwrap()
            .unwrap(),
        current
    );
    f.repo.delete_category_reviewed(current).await.unwrap();
    assert!(f
        .repo
        .get_category("spending_categories", "custom")
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn deleted_unused_seed_category_stays_deleted_after_budget_reset_and_restart() {
    use wealthfolio_spending::budget::{
        service::{default_assignment_inputs, default_group_inputs},
        BudgetRepositoryTrait,
    };
    let f = Fixture::new().await;
    f.service
        .delete_category("spending_categories", "cat_other_expense")
        .await
        .unwrap();
    let budget = wealthfolio_storage_sqlite::spending::budget::BudgetRepository::new(
        f.pool.clone(),
        f.writer.clone(),
    );
    let groups = budget
        .upsert_system_groups(default_group_inputs())
        .await
        .unwrap();
    let map = groups.into_iter().map(|g| (g.key, g.id)).collect();
    budget
        .upsert_system_group_assignments(default_assignment_inputs(&map))
        .await
        .unwrap();
    assert!(!budget
        .list_group_assignments()
        .await
        .unwrap()
        .iter()
        .any(|a| a.category_id == "cat_other_expense"));
    let access = db::DbAccess::plaintext(f._dir.path().join("app.db").to_str().unwrap());
    access.run_migrations().unwrap();
    assert!(f
        .repo
        .get_category("spending_categories", "cat_other_expense")
        .unwrap()
        .is_none());
}
