//! Regression coverage for the complete service/writer path and sync replay.
#![allow(clippy::unwrap_used, clippy::panic, reason = "test code")]
mod common;

use diesel::{connection::SimpleConnection, prelude::*};
use rust_decimal::Decimal;
use std::sync::Arc;
use wealthfolio_core::{
    sync::{SyncEntity, SyncOperation},
    taxonomies::{NewCategory, TaxonomyRepositoryTrait, TaxonomyService, TaxonomyServiceTrait},
};
use wealthfolio_spending::{
    budget::{BudgetRepositoryTrait, BudgetTargetType, NewBudgetTarget},
    category_merge::{CategoryMergeCommit, CategoryMergeRequest, CategoryMergeService},
};
use wealthfolio_storage_sqlite::{
    db,
    spending::{budget::BudgetRepository, category_merge::CategoryMergeRepository},
    sync::AppSyncRepository,
    taxonomies::TaxonomyRepository,
};

const TAXONOMY: &str = "spending_categories";
const SOURCE: &str = "merge-source";
const DESTINATION: &str = "merge-destination";

struct Fixture {
    pool: Arc<db::DbPool>,
    writer: db::WriteHandle,
    taxonomy: Arc<TaxonomyRepository>,
    service: CategoryMergeService,
    budget: BudgetRepository,
    _dir: common::TestDir,
}
impl Fixture {
    async fn merge(&self, source: &str, destination: &str) {
        let review = self
            .service
            .review(CategoryMergeRequest {
                taxonomy_id: TAXONOMY.into(),
                category_id: source.into(),
                destination_id: Some(destination.into()),
            })
            .await
            .unwrap();
        self.service
            .commit(CategoryMergeCommit {
                taxonomy_id: TAXONOMY.into(),
                category_id: source.into(),
                destination_id: destination.into(),
                revision: review.revision,
            })
            .await
            .unwrap();
    }
    fn events(&self) -> Vec<MergeEvent> {
        diesel::sql_query("SELECT entity,entity_id,op,event_id,client_timestamp,payload FROM sync_outbox ORDER BY rowid")
            .load(&mut db::get_connection(&self.pool).unwrap()).unwrap()
    }
    async fn replay(&self, events: &[MergeEvent]) -> wealthfolio_core::Result<()> {
        let repo = AppSyncRepository::new(self.pool.clone(), self.writer.clone());
        repo.apply_remote_events_lww_batch(
            events
                .iter()
                .enumerate()
                .map(|(index, e)| {
                    (
                        serde_json::from_value(serde_json::json!(e.entity)).unwrap(),
                        e.entity_id.clone(),
                        serde_json::from_value(serde_json::json!(e.op)).unwrap(),
                        e.event_id.clone(),
                        e.client_timestamp.clone(),
                        index as i64 + 1,
                        serde_json::from_str(&e.payload).unwrap(),
                    )
                })
                .collect(),
        )
        .await?;
        Ok(())
    }
    async fn new() -> Self {
        std::env::set_var("CONNECT_API_URL", "http://test.local");
        let dir = common::TestDir::new();
        let access = db::DbAccess::plaintext(dir.path().join("app.db").to_str().unwrap());
        access.prepare().unwrap();
        access.run_migrations().unwrap();
        let pool = access.create_pool().unwrap();
        let writer = db::write_actor::spawn_writer((*pool).clone()).unwrap();
        let taxonomy = Arc::new(TaxonomyRepository::new(pool.clone(), writer.clone()));
        for id in [SOURCE, DESTINATION] {
            taxonomy
                .create_category(NewCategory {
                    id: Some(id.into()),
                    taxonomy_id: TAXONOMY.into(),
                    name: id.into(),
                    key: id.into(),
                    ..Default::default()
                })
                .await
                .unwrap();
        }
        let service = CategoryMergeService::new(Arc::new(CategoryMergeRepository::new(
            pool.clone(),
            writer.clone(),
        )));
        let budget = BudgetRepository::new(pool.clone(), writer.clone());
        Self {
            pool,
            writer,
            taxonomy,
            service,
            budget,
            _dir: dir,
        }
    }
    fn seed(&self, sql: &str) {
        db::get_connection(&self.pool)
            .unwrap()
            .batch_execute(sql)
            .unwrap();
    }
    fn count(&self, sql: &str) -> i64 {
        #[derive(QueryableByName)]
        struct Count {
            #[diesel(sql_type=diesel::sql_types::BigInt)]
            n: i64,
        }
        diesel::sql_query(sql)
            .get_result::<Count>(&mut db::get_connection(&self.pool).unwrap())
            .unwrap()
            .n
    }
    async fn prepared(&self) -> CategoryMergeCommit {
        let review = self
            .service
            .review(CategoryMergeRequest {
                taxonomy_id: TAXONOMY.into(),
                category_id: SOURCE.into(),
                destination_id: Some(DESTINATION.into()),
            })
            .await
            .unwrap();
        CategoryMergeCommit {
            taxonomy_id: TAXONOMY.into(),
            category_id: SOURCE.into(),
            destination_id: DESTINATION.into(),
            revision: review.revision,
        }
    }
    async fn target(&self, category: &str, period: &str, amount: &str) {
        self.budget
            .upsert_target(NewBudgetTarget {
                id: None,
                period_key: period.into(),
                target_type: BudgetTargetType::Category,
                taxonomy_id: Some(TAXONOMY.into()),
                category_id: Some(category.into()),
                group_id: None,
                amount: amount.into(),
            })
            .await
            .unwrap();
    }
    fn references(&self) {
        self.seed("INSERT INTO accounts (id,name,account_type,currency,is_default,is_active,created_at,updated_at,is_archived,tracking_mode)
            VALUES ('cash','Cash','CASH','USD',0,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,1,'TRANSACTIONS');
            INSERT INTO activities (id,account_id,activity_type,status,activity_date,amount,currency,source_system,is_user_modified,needs_review,created_at,updated_at)
            VALUES ('past','cash','WITHDRAWAL','POSTED','2020-01-01T00:00:00Z','12.5','USD','MANUAL',0,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
            ('future','cash','WITHDRAWAL','POSTED','2030-03-01T00:00:00Z','12.5','USD','MANUAL',0,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
            ('broker','cash','WITHDRAWAL','POSTED','2026-03-01T00:00:00Z','12.5','USD','SNAPTRADE',1,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
            INSERT INTO activity_taxonomy_assignments (id,activity_id,taxonomy_id,category_id,weight,source)
            VALUES ('assignment-past','past','spending_categories','merge-source',10000,'rule'),
            ('assignment-future','future','spending_categories','merge-source',10000,'manual'),
            ('assignment-broker','broker','spending_categories','merge-source',10000,'manual');
            INSERT INTO spending_activity_splits (id,activity_id,taxonomy_id,category_id,amount,note,sort_order)
            VALUES ('split-source','future','spending_categories','merge-source','4.25','keep this',7),
            ('split-destination','future','spending_categories','merge-destination','8.25','keep that',9),
            ('split-broker','broker','spending_categories','merge-source','12.5','local only',0);
            INSERT INTO spending_categorization_rules (id,name,pattern,match_type,taxonomy_id,category_id,activity_type,priority,is_global,preset_id,preset_rule_key,preset_version,preset_modified)
            VALUES ('rule','Original','store','contains','spending_categories','merge-source','WITHDRAWAL',9,1,'preset','store','1',0);
            INSERT INTO budget_group_assignments (id,group_id,taxonomy_id,category_id,is_system)
            VALUES ('source-link','032ecb02-5912-42e8-9724-2cd566fc08d5','spending_categories','merge-source',0),
            ('destination-link','032ecb02-5912-42e8-9724-2cd566fc08d5','spending_categories','merge-destination',0);");
    }
    fn assert_merged(&self) {
        assert!(self
            .taxonomy
            .get_category(TAXONOMY, SOURCE)
            .unwrap()
            .is_none());
        for table in [
            "activity_taxonomy_assignments",
            "spending_activity_splits",
            "spending_categorization_rules",
            "budget_targets",
            "budget_group_assignments",
            "budget_rollover_settings",
        ] {
            assert_eq!(
                self.count(&format!(
                    "SELECT COUNT(*) n FROM {table} WHERE category_id = 'merge-source'"
                )),
                0,
                "{table}"
            );
        }
        assert_eq!(self.count("SELECT COUNT(*) n FROM spending_activity_splits WHERE (id='split-source' AND category_id='merge-destination' AND amount='4.25' AND note='keep this' AND sort_order=7) OR (id='split-destination' AND category_id='merge-destination' AND amount='8.25' AND note='keep that' AND sort_order=9) OR (id='split-broker' AND category_id='merge-destination' AND amount='12.5' AND note='local only')"),3);
        assert_eq!(self.count("SELECT COUNT(*) n FROM activity_taxonomy_assignments WHERE category_id='merge-destination' AND source='manual'"),3);
        assert_eq!(self.count("SELECT COUNT(*) n FROM spending_categorization_rules WHERE id='rule' AND category_id='merge-destination' AND pattern='store' AND match_type='contains' AND activity_type='WITHDRAWAL' AND priority=9 AND preset_id='preset' AND preset_rule_key='store' AND preset_version='1' AND preset_modified=1"),1);
        assert_eq!(self.count("SELECT COUNT(*) n FROM budget_group_assignments WHERE id='destination-link' AND category_id='merge-destination'"),1);
    }
}

#[tokio::test]
async fn merge_moves_all_history_and_splits_rules_budgets_atomically() {
    let f = Fixture::new().await;
    f.references();
    let old_service = TaxonomyService::new(f.taxonomy.clone());
    assert!(
        old_service.delete_category(TAXONOMY, SOURCE).await.is_err(),
        "original symptom"
    );
    for (category, period, amount) in [
        (SOURCE, "default", "100"),
        (SOURCE, "2026-03", "50"),
        (DESTINATION, "default", "200"),
        (DESTINATION, "2026-04", "0"),
    ] {
        f.target(category, period, amount).await;
    }
    let reviewed = f
        .service
        .review(CategoryMergeRequest {
            taxonomy_id: TAXONOMY.into(),
            category_id: SOURCE.into(),
            destination_id: Some(DESTINATION.into()),
        })
        .await
        .unwrap();
    for (period, current, moved, after) in [
        ("default", "200", "100", "300"),
        ("2026-03", "200", "50", "250"),
        ("2026-04", "0", "100", "100"),
    ] {
        let change = reviewed
            .budget_changes
            .iter()
            .find(|c| c.period_key == period)
            .unwrap();
        assert_eq!(
            (
                &*change.current_amount,
                &*change.moved_amount,
                &*change.new_amount
            ),
            (current, moved, after)
        );
    }
    let destination = f
        .taxonomy
        .get_category(TAXONOMY, DESTINATION)
        .unwrap()
        .unwrap();
    f.seed("DELETE FROM sync_outbox");
    f.service.commit(f.prepared().await).await.unwrap();
    f.assert_merged();
    assert_eq!(
        f.taxonomy
            .get_category(TAXONOMY, DESTINATION)
            .unwrap()
            .unwrap(),
        destination
    );
    let targets = f.budget.list_targets().await.unwrap();
    for (period, expected) in [("default", "300"), ("2026-03", "250"), ("2026-04", "100")] {
        assert_eq!(
            targets
                .iter()
                .find(|t| t.category_id.as_deref() == Some(DESTINATION) && t.period_key == period)
                .unwrap()
                .amount,
            expected
        );
    }
    assert_eq!(f.count("SELECT COUNT(*) n FROM sync_outbox WHERE entity IN ('activity_taxonomy_assignment','spending_activity_split') AND payload LIKE '%broker%'"),0);
    assert_eq!(f.count("SELECT COUNT(*) n FROM sync_outbox WHERE entity='custom_taxonomy' AND payload LIKE '%category_merges%'"),1);
    // Every merge effect travels in one semantic event, with no early row writes.
    assert_eq!(f.count("SELECT COUNT(*) n FROM sync_outbox"), 1);
    assert_eq!(f.count("SELECT COUNT(*) n FROM sync_outbox WHERE entity='custom_taxonomy' AND rowid=(SELECT MAX(rowid) FROM sync_outbox)"),1);
    assert!(old_service
        .delete_category(TAXONOMY, DESTINATION)
        .await
        .is_err());
}

#[tokio::test]
async fn effective_amounts_preserve_zero_missing_defaults_and_exact_decimals() {
    for rows in [
        vec![
            (SOURCE, "2026-03", "0"),
            (DESTINATION, "default", "200.123456789"),
        ],
        vec![
            (SOURCE, "default", "0.000000001"),
            (DESTINATION, "2026-03", "1.234567891"),
        ],
        vec![
            (SOURCE, "default", "100"),
            (SOURCE, "2026-03", "0"),
            (DESTINATION, "default", "0"),
            (DESTINATION, "2026-04", "25"),
        ],
    ] {
        let f = Fixture::new().await;
        for (c, p, a) in &rows {
            f.target(c, p, a).await;
        }
        let before = f.budget.list_targets().await.unwrap();
        f.service.commit(f.prepared().await).await.unwrap();
        let after = f.budget.list_targets().await.unwrap();
        let effective = |targets: &[wealthfolio_spending::budget::BudgetTarget],
                         category: &str,
                         period: &str| {
            targets
                .iter()
                .find(|t| t.category_id.as_deref() == Some(category) && t.period_key == period)
                .or_else(|| {
                    targets.iter().find(|t| {
                        t.category_id.as_deref() == Some(category) && t.period_key == "default"
                    })
                })
                .map(|t| Decimal::from_str_exact(&t.amount).unwrap())
                .unwrap_or(Decimal::ZERO)
        };
        for p in ["2020-01", "2026-03", "2026-04", "2030-12"] {
            assert_eq!(
                effective(&after, DESTINATION, p),
                effective(&before, SOURCE, p) + effective(&before, DESTINATION, p)
            );
        }
    }
}

#[tokio::test]
async fn unrepresentable_budget_sums_reject_the_whole_merge_even_with_a_forged_commit() {
    let f = Fixture::new().await;
    f.target(SOURCE, "default", "79228162514264337593543950335")
        .await;
    f.target(DESTINATION, "default", "1").await;
    let base = f
        .service
        .review(CategoryMergeRequest {
            taxonomy_id: TAXONOMY.into(),
            category_id: SOURCE.into(),
            destination_id: None,
        })
        .await
        .unwrap();
    f.seed("DELETE FROM sync_outbox");
    let result = f
        .service
        .commit(CategoryMergeCommit {
            taxonomy_id: TAXONOMY.into(),
            category_id: SOURCE.into(),
            destination_id: DESTINATION.into(),
            revision: base.revision,
        })
        .await;
    assert!(result.unwrap_err().to_string().contains("exactly"));
    assert!(f.taxonomy.get_category(TAXONOMY, SOURCE).unwrap().is_some());
    assert_eq!(f.count("SELECT COUNT(*) n FROM budget_targets WHERE amount='1' AND category_id='merge-destination'"),1);
    assert_eq!(f.count("SELECT COUNT(*) n FROM sync_outbox"), 0);
}

#[tokio::test]
async fn snapshot_roundtrip_preserves_redirects_and_does_not_restore_merged_seed_categories() {
    let source = Fixture::new().await;
    source.target("cat_other_expense", "default", "100").await;
    source.target(DESTINATION, "default", "200").await;
    let review = source
        .service
        .review(CategoryMergeRequest {
            taxonomy_id: TAXONOMY.into(),
            category_id: "cat_other_expense".into(),
            destination_id: Some(DESTINATION.into()),
        })
        .await
        .unwrap();
    source
        .service
        .commit(CategoryMergeCommit {
            taxonomy_id: TAXONOMY.into(),
            category_id: "cat_other_expense".into(),
            destination_id: DESTINATION.into(),
            revision: review.revision,
        })
        .await
        .unwrap();
    let sync = AppSyncRepository::new(source.pool.clone(), source.writer.clone());
    let bytes = sync.export_snapshot_sqlite_image(vec![]).await.unwrap();
    let snapshot_path = source._dir.path().join("snapshot.db");
    std::fs::write(&snapshot_path, bytes).unwrap();
    let peer = Fixture::new().await;
    assert!(peer
        .taxonomy
        .get_category(TAXONOMY, "cat_other_expense")
        .unwrap()
        .is_some());
    let peer_sync = AppSyncRepository::new(peer.pool.clone(), peer.writer.clone());
    peer_sync
        .restore_snapshot_tables_from_file(
            snapshot_path.to_str().unwrap().into(),
            vec![],
            100,
            "peer-snapshot".into(),
            Some(1),
        )
        .await
        .unwrap();
    assert!(peer
        .taxonomy
        .get_category(TAXONOMY, "cat_other_expense")
        .unwrap()
        .is_none());
    assert_eq!(peer.count("SELECT COUNT(*) n FROM app_settings WHERE setting_key='spending.category_merges' AND setting_value LIKE '%cat_other_expense%'"),1);
    let targets = peer.budget.list_targets().await.unwrap();
    assert_eq!(
        targets
            .iter()
            .find(|t| t.category_id.as_deref() == Some(DESTINATION) && t.period_key == "default")
            .unwrap()
            .amount,
        "300"
    );
    assert!(TaxonomyService::new(peer.taxonomy.clone())
        .delete_category(TAXONOMY, DESTINATION)
        .await
        .is_err());
}

#[tokio::test]
async fn chained_merges_survive_newer_stale_bundles_that_omit_the_final_destination() {
    let f = Fixture::new().await;
    f.references();
    f.target(SOURCE, "default", "100").await;
    f.target(DESTINATION, "default", "200").await;
    f.service.commit(f.prepared().await).await.unwrap();
    #[derive(QueryableByName)]
    struct Payload {
        #[diesel(sql_type=diesel::sql_types::Text)]
        payload: String,
    }
    let old:Payload=diesel::sql_query("SELECT payload FROM sync_outbox WHERE entity='custom_taxonomy' ORDER BY rowid DESC LIMIT 1")
        .get_result(&mut db::get_connection(&f.pool).unwrap()).unwrap();
    f.taxonomy
        .create_category(NewCategory {
            id: Some("third".into()),
            taxonomy_id: TAXONOMY.into(),
            name: "Third".into(),
            key: "third".into(),
            ..Default::default()
        })
        .await
        .unwrap();
    f.target("third", "default", "300").await;
    let review = f
        .service
        .review(CategoryMergeRequest {
            taxonomy_id: TAXONOMY.into(),
            category_id: DESTINATION.into(),
            destination_id: Some("third".into()),
        })
        .await
        .unwrap();
    f.service
        .commit(CategoryMergeCommit {
            taxonomy_id: TAXONOMY.into(),
            category_id: DESTINATION.into(),
            destination_id: "third".into(),
            revision: review.revision,
        })
        .await
        .unwrap();
    let sync = AppSyncRepository::new(f.pool.clone(), f.writer.clone());
    sync.apply_remote_event_lww(
        SyncEntity::CustomTaxonomy,
        TAXONOMY.into(),
        SyncOperation::Update,
        "stale-before-third".into(),
        "2099-01-01T00:00:00Z".into(),
        100,
        serde_json::from_str(&old.payload).unwrap(),
    )
    .await
    .unwrap();
    assert!(f.taxonomy.get_category(TAXONOMY, SOURCE).unwrap().is_none());
    assert!(f
        .taxonomy
        .get_category(TAXONOMY, DESTINATION)
        .unwrap()
        .is_none());
    assert!(f
        .taxonomy
        .get_category(TAXONOMY, "third")
        .unwrap()
        .is_some());
    assert_eq!(
        f.count("SELECT COUNT(*) n FROM spending_activity_splits WHERE category_id='third'"),
        3
    );
    assert_eq!(
        f.count("SELECT COUNT(*) n FROM activity_taxonomy_assignments WHERE category_id='third'"),
        3
    );
    assert_eq!(
        f.count("SELECT COUNT(*) n FROM budget_targets WHERE category_id='third' AND amount='600'"),
        1
    );
}

#[tokio::test]
async fn stale_partial_exclusions_cannot_expand_to_the_whole_merged_category() {
    use wealthfolio_spending::settings::{
        SpendingSettingsRepositoryTrait, SETTING_KEY_EXCLUDED_CATEGORY_IDS,
    };
    let f = Fixture::new().await;
    f.service.commit(f.prepared().await).await.unwrap();
    let settings = wealthfolio_storage_sqlite::spending::settings::SpendingSettingsRepository::new(
        f.pool.clone(),
        f.writer.clone(),
    );
    assert!(settings
        .set_setting(SETTING_KEY_EXCLUDED_CATEGORY_IDS, "[\"merge-source\"]")
        .await
        .is_err());
    let sync = AppSyncRepository::new(f.pool.clone(), f.writer.clone());
    sync.apply_remote_event_lww(SyncEntity::SpendingSetting,SETTING_KEY_EXCLUDED_CATEGORY_IDS.into(),SyncOperation::Update,"delayed-exclusion".into(),"2099-01-01T00:00:00Z".into(),100,
        serde_json::json!({"settingKey":SETTING_KEY_EXCLUDED_CATEGORY_IDS,"settingValue":"[\"merge-source\"]"})).await.unwrap();
    assert_eq!(
        settings
            .get_setting(SETTING_KEY_EXCLUDED_CATEGORY_IDS)
            .await
            .unwrap()
            .as_deref(),
        None
    );
}

#[derive(QueryableByName, Clone)]
struct MergeEvent {
    #[diesel(sql_type=diesel::sql_types::Text)]
    entity: String,
    #[diesel(sql_type=diesel::sql_types::Text)]
    entity_id: String,
    #[diesel(sql_type=diesel::sql_types::Text)]
    op: String,
    #[diesel(sql_type=diesel::sql_types::Text)]
    event_id: String,
    #[diesel(sql_type=diesel::sql_types::Text)]
    client_timestamp: String,
    #[diesel(sql_type=diesel::sql_types::Text)]
    payload: String,
}

#[tokio::test]
async fn concurrent_overlapping_merges_union_budget_origins_once_in_both_orders() {
    for same_destination in [false, true] {
        let a = Fixture::new().await;
        let b = Fixture::new().await;
        for f in [&a, &b] {
            f.taxonomy
                .create_category(NewCategory {
                    id: Some("third".into()),
                    taxonomy_id: TAXONOMY.into(),
                    name: "Third".into(),
                    key: "third".into(),
                    ..Default::default()
                })
                .await
                .unwrap();
            for (id, period, amount) in [
                (SOURCE, "default", "100"),
                (SOURCE, "2026-03", "50"),
                (DESTINATION, "default", "200"),
                ("third", "default", "300"),
                ("third", "2026-04", "0"),
            ] {
                f.target(id, period, amount).await;
            }
            f.seed("DELETE FROM sync_outbox");
        }
        a.merge(SOURCE, DESTINATION).await;
        b.merge(
            if same_destination {
                "third"
            } else {
                DESTINATION
            },
            if same_destination {
                DESTINATION
            } else {
                "third"
            },
        )
        .await;
        let ae = a.events();
        let be = b.events();
        assert_eq!(ae.len(), 1);
        assert_eq!(be.len(), 1);
        b.replay(&ae).await.unwrap();
        a.replay(&be).await.unwrap();
        let root = if same_destination {
            DESTINATION
        } else {
            "third"
        };
        for f in [&a, &b] {
            let values = f.budget.list_targets().await.unwrap();
            for (period, amount) in [("default", "600"), ("2026-03", "550"), ("2026-04", "300")] {
                assert_eq!(
                    values
                        .iter()
                        .find(|t| t.category_id.as_deref() == Some(root) && t.period_key == period)
                        .unwrap()
                        .amount,
                    amount
                );
            }
            assert_eq!(
                values
                    .iter()
                    .filter(|t| t.taxonomy_id.as_deref() == Some(TAXONOMY))
                    .count(),
                3
            );
        }
        // Repeated and later bundles cannot count a contribution a second time.
        b.replay(&ae).await.unwrap();
        a.replay(&be).await.unwrap();
    }
}

#[tokio::test]
async fn peer_exclusion_conflict_is_atomic_and_later_resolution_unblocks_sync() {
    use wealthfolio_spending::settings::{
        SpendingSettingsRepositoryTrait, SETTING_KEY_EXCLUDED_CATEGORY_IDS,
    };
    let a = Fixture::new().await;
    let b = Fixture::new().await;
    for f in [&a, &b] {
        f.references();
        f.seed("DELETE FROM sync_outbox");
    }
    a.merge(SOURCE, DESTINATION).await;
    let merge = a.events();
    let settings = wealthfolio_storage_sqlite::spending::settings::SpendingSettingsRepository::new(
        b.pool.clone(),
        b.writer.clone(),
    );
    settings
        .set_setting(SETTING_KEY_EXCLUDED_CATEGORY_IDS, "[\"merge-source\"]")
        .await
        .unwrap();
    let old_setting = b.events();
    let before = b.count("SELECT COUNT(*) n FROM sync_entity_metadata");
    assert!(b
        .replay(&merge)
        .await
        .unwrap_err()
        .to_string()
        .contains("Exclusions"));
    assert_eq!(
        b.count(
            "SELECT COUNT(*) n FROM activity_taxonomy_assignments WHERE category_id='merge-source'"
        ),
        3
    );
    assert_eq!(
        b.count("SELECT COUNT(*) n FROM spending_activity_splits WHERE category_id='merge-source'"),
        2
    );
    assert_eq!(
        b.count("SELECT COUNT(*) n FROM sync_entity_metadata"),
        before
    );
    assert_eq!(
        b.count("SELECT COUNT(*) n FROM app_settings WHERE setting_key='spending.category_merges'"),
        0
    );
    a.replay(&old_setting).await.unwrap();
    assert_eq!(a.count("SELECT COUNT(*) n FROM app_settings WHERE setting_key='spending.excluded_category_ids'"),0);
    // The author explicitly resolves the partial exclusion. The older event
    // must not block the newer setting behind it in the existing sync stream.
    settings
        .set_setting(SETTING_KEY_EXCLUDED_CATEGORY_IDS, "[]")
        .await
        .unwrap();
    a.replay(&b.events()).await.unwrap();
    b.replay(&merge).await.unwrap();
    a.assert_merged();
    b.assert_merged();
    for f in [&a, &b] {
        assert_eq!(f.count("SELECT COUNT(*) n FROM app_settings WHERE setting_key='spending.excluded_category_ids' AND setting_value LIKE '%merge-source%'"),0);
    }
}

#[tokio::test]
async fn peer_rollover_conflict_retains_balance_until_explicit_removal_and_retry() {
    use wealthfolio_spending::budget::{BudgetRolloverTargetType, NewBudgetRolloverSetting};
    let a = Fixture::new().await;
    let b = Fixture::new().await;
    for f in [&a, &b] {
        f.references();
        f.seed("DELETE FROM sync_outbox");
    }
    a.merge(SOURCE, DESTINATION).await;
    let merge = a.events();
    let saved = b
        .budget
        .upsert_rollover_setting(NewBudgetRolloverSetting {
            id: None,
            target_type: BudgetRolloverTargetType::Category,
            taxonomy_id: Some(TAXONOMY.into()),
            category_id: Some(SOURCE.into()),
            group_id: None,
            enabled: true,
            start_month: "2026-03".into(),
            starting_balance: "23".into(),
        })
        .await
        .unwrap();
    assert!(b
        .replay(&merge)
        .await
        .unwrap_err()
        .to_string()
        .contains("CategoryRollover"));
    assert_eq!(
        b.budget.list_rollover_settings().await.unwrap()[0].starting_balance,
        "23"
    );
    assert_eq!(
        b.count(
            "SELECT COUNT(*) n FROM activity_taxonomy_assignments WHERE category_id='merge-source'"
        ),
        3
    );
    a.replay(&b.events()).await.unwrap();
    assert_eq!(b.budget.list_rollover_settings().await.unwrap().len(), 1);
    b.budget.delete_rollover_setting(&saved.id).await.unwrap();
    a.replay(&b.events()).await.unwrap();
    b.replay(&merge).await.unwrap();
    a.assert_merged();
    b.assert_merged();
    assert!(b.budget.list_rollover_settings().await.unwrap().is_empty());
}

#[tokio::test]
async fn conflicting_offline_destinations_block_replay_without_destroying_merged_data() {
    let f = Fixture::new().await;
    f.references();
    f.target(SOURCE, "default", "100").await;
    f.target(DESTINATION, "default", "200").await;
    f.service.commit(f.prepared().await).await.unwrap();
    #[derive(QueryableByName)]
    struct Payload {
        #[diesel(sql_type=diesel::sql_types::Text)]
        payload: String,
    }
    let row:Payload=diesel::sql_query("SELECT payload FROM sync_outbox WHERE entity='custom_taxonomy' ORDER BY rowid DESC LIMIT 1")
        .get_result(&mut db::get_connection(&f.pool).unwrap()).unwrap();
    let mut conflicting: serde_json::Value = serde_json::from_str(&row.payload).unwrap();
    conflicting["category_merges"][0]["destinationId"] = "cat_other_expense".into();
    let sync = AppSyncRepository::new(f.pool.clone(), f.writer.clone());
    let error = sync
        .apply_remote_event_lww(
            SyncEntity::CustomTaxonomy,
            TAXONOMY.into(),
            SyncOperation::Update,
            "conflicting-merge".into(),
            "2099-01-01T00:00:00Z".into(),
            100,
            conflicting,
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("Conflicting category merges"));
    f.assert_merged();
    assert_eq!(f.count("SELECT COUNT(*) n FROM budget_targets WHERE category_id='merge-destination' AND amount='300'"),1);
}

#[tokio::test]
async fn reviewed_merge_rejects_same_id_edits_and_new_references() {
    for mutation in ["UPDATE spending_activity_splits SET note='concurrent edit' WHERE id='split-source'",
        "UPDATE spending_categorization_rules SET pattern='changed' WHERE id='rule'",
        "INSERT INTO budget_targets(id,period_key,target_type,taxonomy_id,category_id,amount) VALUES('concurrent','2026-07','category','spending_categories','merge-source','23')",
        "INSERT INTO app_settings(setting_key,setting_value) VALUES('spending.excluded_category_ids','[\"merge-source\"]')"] {
        let f=Fixture::new().await;f.references();let request=f.prepared().await;
        f.seed(mutation);f.seed("DELETE FROM sync_outbox");
        let err=f.service.commit(request).await.unwrap_err();assert!(err.to_string().contains("changed"));
        assert!(f.taxonomy.get_category(TAXONOMY,SOURCE).unwrap().is_some());
        assert_eq!(f.count("SELECT COUNT(*) n FROM activity_taxonomy_assignments WHERE category_id='merge-source'"),3);
        assert_eq!(f.count("SELECT COUNT(*) n FROM sync_outbox"),0);
    }
}

#[tokio::test]
async fn injected_failure_rolls_back_rows_settings_redirects_and_outbox() {
    let f = Fixture::new().await;
    f.references();
    f.target(SOURCE, "default", "100").await;
    f.seed("INSERT INTO app_settings(setting_key,setting_value) VALUES('spending.excluded_category_ids','[\"merge-source\",\"merge-destination\"]'); DELETE FROM sync_outbox;
        CREATE TRIGGER fail_merge BEFORE DELETE ON taxonomy_categories WHEN OLD.id='merge-source' BEGIN SELECT RAISE(ABORT,'injected merge failure'); END;");
    assert!(f.service.commit(f.prepared().await).await.is_err());
    assert_eq!(
        f.count(
            "SELECT COUNT(*) n FROM activity_taxonomy_assignments WHERE category_id='merge-source'"
        ),
        3
    );
    assert_eq!(
        f.count("SELECT COUNT(*) n FROM spending_activity_splits WHERE category_id='merge-source'"),
        2
    );
    assert_eq!(f.count("SELECT COUNT(*) n FROM spending_categorization_rules WHERE preset_modified=0 AND category_id='merge-source'"),1);
    assert_eq!(f.count("SELECT COUNT(*) n FROM budget_targets WHERE category_id='merge-source' AND amount='100'"),1);
    assert_eq!(f.count("SELECT COUNT(*) n FROM app_settings WHERE setting_key='spending.excluded_category_ids' AND setting_value LIKE '%merge-source%'"),1);
    assert_eq!(
        f.count("SELECT COUNT(*) n FROM app_settings WHERE setting_key='spending.category_merges'"),
        0
    );
    assert_eq!(f.count("SELECT COUNT(*) n FROM sync_outbox"), 0);
    f.seed("DROP TRIGGER fail_merge");
    f.service.commit(f.prepared().await).await.unwrap();
    assert_eq!(f.count("SELECT COUNT(*) n FROM app_settings WHERE setting_key='spending.excluded_category_ids' AND setting_value LIKE '%merge-source%'"),0);
}

#[tokio::test]
async fn inherited_exclusions_are_compared_and_obsolete_raw_source_is_removed() {
    let f = Fixture::new().await;
    f.seed("UPDATE taxonomy_categories SET parent_id='cat_food' WHERE id='merge-source';
        INSERT INTO app_settings(setting_key,setting_value) VALUES('spending.excluded_category_ids','[\"cat_food\"]')");
    assert!(f
        .service
        .review(CategoryMergeRequest {
            taxonomy_id: TAXONOMY.into(),
            category_id: SOURCE.into(),
            destination_id: Some(DESTINATION.into())
        })
        .await
        .is_err());
    f.seed("UPDATE taxonomy_categories SET parent_id='cat_food' WHERE id='merge-destination';
        UPDATE app_settings SET setting_value='[\"cat_food\",\"merge-source\"]' WHERE setting_key='spending.excluded_category_ids'");
    f.service.commit(f.prepared().await).await.unwrap();
    assert_eq!(f.count("SELECT COUNT(*) n FROM app_settings WHERE setting_key='spending.excluded_category_ids' AND setting_value='[\"cat_food\"]'"),1);
    assert_eq!(
        f.taxonomy
            .get_category(TAXONOMY, DESTINATION)
            .unwrap()
            .unwrap()
            .parent_id
            .as_deref(),
        Some("cat_food")
    );
}

#[tokio::test]
async fn outbox_failure_rolls_back_already_projected_events_and_all_merge_rows() {
    let f = Fixture::new().await;
    f.references();
    f.target(SOURCE, "default", "100").await;
    f.seed("DELETE FROM sync_outbox; CREATE TRIGGER fail_merge_outbox BEFORE INSERT ON sync_outbox
        WHEN NEW.entity='custom_taxonomy' BEGIN SELECT RAISE(ABORT,'injected outbox failure'); END;");
    assert!(f.service.commit(f.prepared().await).await.is_err());
    assert!(f.taxonomy.get_category(TAXONOMY, SOURCE).unwrap().is_some());
    assert_eq!(
        f.count(
            "SELECT COUNT(*) n FROM activity_taxonomy_assignments WHERE category_id='merge-source'"
        ),
        3
    );
    assert_eq!(f.count("SELECT COUNT(*) n FROM budget_targets WHERE category_id='merge-source' AND amount='100'"),1);
    assert_eq!(
        f.count("SELECT COUNT(*) n FROM budget_targets WHERE category_id='merge-destination'"),
        0
    );
    assert_eq!(
        f.count("SELECT COUNT(*) n FROM app_settings WHERE setting_key='spending.category_merges'"),
        0
    );
    assert_eq!(f.count("SELECT COUNT(*) n FROM sync_outbox"), 0);
}

#[tokio::test]
async fn group_rollover_allows_same_group_but_blocks_cross_group_history_changes() {
    for same_group in [true, false] {
        let f = Fixture::new().await;
        f.references();
        f.target(SOURCE, "default", "100").await;
        f.seed("INSERT INTO budget_rollover_settings(id,target_type,group_id,enabled,start_month,starting_balance)
            VALUES('group-rollover','group','032ecb02-5912-42e8-9724-2cd566fc08d5',1,'2026-01','23')");
        if !same_group {
            f.seed("UPDATE budget_group_assignments SET group_id='a409e0d6-9152-49c8-a5b4-a147a8ac636e' WHERE id='destination-link'");
        }
        let review = f
            .service
            .review(CategoryMergeRequest {
                taxonomy_id: TAXONOMY.into(),
                category_id: SOURCE.into(),
                destination_id: Some(DESTINATION.into()),
            })
            .await;
        if same_group {
            review.unwrap();
            f.service.commit(f.prepared().await).await.unwrap();
            assert_eq!(f.count("SELECT COUNT(*) n FROM budget_rollover_settings WHERE id='group-rollover' AND starting_balance='23' AND enabled=1"),1);
        } else {
            assert!(review.unwrap_err().to_string().contains("group_rollover"));
        }
    }
}

#[tokio::test]
async fn merging_savings_ignores_expense_group_rollover_and_preserves_other_goal_settings() {
    let f = Fixture::new().await;
    for id in ["saving-source", "saving-destination"] {
        f.taxonomy
            .create_category(NewCategory {
                id: Some(id.into()),
                taxonomy_id: "savings_categories".into(),
                name: id.into(),
                key: id.into(),
                ..Default::default()
            })
            .await
            .unwrap();
    }
    f.seed("INSERT INTO budget_group_assignments(id,group_id,taxonomy_id,category_id,is_system) VALUES
        ('saving-source-link','032ecb02-5912-42e8-9724-2cd566fc08d5','savings_categories','saving-source',0),
        ('saving-destination-link','a409e0d6-9152-49c8-a5b4-a147a8ac636e','savings_categories','saving-destination',0);
        INSERT INTO budget_rollover_settings(id,target_type,group_id,enabled,start_month,starting_balance)
        VALUES('group-rollover','group','032ecb02-5912-42e8-9724-2cd566fc08d5',1,'2026-01','23');
        INSERT INTO budget_rollover_settings(id,target_type,taxonomy_id,category_id,enabled,start_month,starting_balance)
        VALUES('independent-goal','category','savings_categories','cat_savings_investments',1,'2026-01','17');
        INSERT INTO budget_targets(id,period_key,target_type,taxonomy_id,category_id,amount) VALUES
        ('saving-target','default','category','savings_categories','saving-source','100')");
    let review = f
        .service
        .review(CategoryMergeRequest {
            taxonomy_id: "savings_categories".into(),
            category_id: "saving-source".into(),
            destination_id: Some("saving-destination".into()),
        })
        .await
        .unwrap();
    f.service
        .commit(CategoryMergeCommit {
            taxonomy_id: "savings_categories".into(),
            category_id: "saving-source".into(),
            destination_id: "saving-destination".into(),
            revision: review.revision,
        })
        .await
        .unwrap();
    assert!(f
        .taxonomy
        .get_category("savings_categories", "saving-source")
        .unwrap()
        .is_none());
    assert_eq!(f.count("SELECT COUNT(*) n FROM budget_targets WHERE taxonomy_id='savings_categories' AND category_id='saving-destination' AND amount='100'"),1);
    assert_eq!(f.count("SELECT COUNT(*) n FROM budget_rollover_settings WHERE starting_balance IN ('23','17') AND enabled=1"),2);
}

#[tokio::test]
async fn income_targets_merge_without_touching_same_id_expense_records_or_exclusions() {
    let f = Fixture::new().await;
    f.references();
    f.seed("INSERT INTO app_settings(setting_key,setting_value) VALUES('spending.excluded_category_ids','[\"merge-source\"]')");
    for id in [SOURCE, DESTINATION] {
        f.taxonomy
            .create_category(NewCategory {
                id: Some(id.into()),
                taxonomy_id: "income_sources".into(),
                name: id.into(),
                key: id.into(),
                ..Default::default()
            })
            .await
            .unwrap();
    }
    for (id, period, amount) in [
        (SOURCE, "default", "100"),
        (SOURCE, "2026-03", "50"),
        (DESTINATION, "default", "200"),
    ] {
        f.budget
            .upsert_target(NewBudgetTarget {
                id: None,
                period_key: period.into(),
                target_type: BudgetTargetType::Category,
                taxonomy_id: Some("income_sources".into()),
                category_id: Some(id.into()),
                group_id: None,
                amount: amount.into(),
            })
            .await
            .unwrap();
    }
    let review = f
        .service
        .review(CategoryMergeRequest {
            taxonomy_id: "income_sources".into(),
            category_id: SOURCE.into(),
            destination_id: Some(DESTINATION.into()),
        })
        .await
        .unwrap();
    f.service
        .commit(CategoryMergeCommit {
            taxonomy_id: "income_sources".into(),
            category_id: SOURCE.into(),
            destination_id: DESTINATION.into(),
            revision: review.revision,
        })
        .await
        .unwrap();
    assert!(f
        .taxonomy
        .get_category("income_sources", SOURCE)
        .unwrap()
        .is_none());
    assert!(f.taxonomy.get_category(TAXONOMY, SOURCE).unwrap().is_some());
    assert_eq!(f.count("SELECT COUNT(*) n FROM activity_taxonomy_assignments WHERE taxonomy_id='spending_categories' AND category_id='merge-source'"),3);
    assert_eq!(f.count("SELECT COUNT(*) n FROM app_settings WHERE setting_key='spending.excluded_category_ids' AND setting_value='[\"merge-source\"]'"),1);
    let targets = f.budget.list_targets().await.unwrap();
    for (period, amount) in [("default", "300"), ("2026-03", "250")] {
        assert_eq!(
            targets
                .iter()
                .find(|t| t.taxonomy_id.as_deref() == Some("income_sources")
                    && t.category_id.as_deref() == Some(DESTINATION)
                    && t.period_key == period)
                .unwrap()
                .amount,
            amount
        );
    }
}

#[tokio::test]
async fn preset_upgrade_preserves_retargeted_rule_and_user_edit_precedence() {
    use wealthfolio_spending::categorization_rules::{
        CategorizationRulesRepositoryTrait, NewCategorizationRule,
    };
    let f = Fixture::new().await;
    f.references();
    f.service.commit(f.prepared().await).await.unwrap();
    let repo=wealthfolio_storage_sqlite::spending::categorization_rules::CategorizationRulesRepository::new(f.pool.clone(),f.writer.clone());
    let rule:NewCategorizationRule=serde_json::from_value(serde_json::json!({"name":"Upgrade","pattern":"changed","taxonomyId":TAXONOMY,"categoryId":SOURCE,"presetId":"preset","presetRuleKey":"store","presetVersion":"2"})).unwrap();
    let counts = repo
        .import_preset_rules("preset", "2", vec![rule])
        .await
        .unwrap();
    assert_eq!(counts.skipped_existing, 1);
    f.assert_merged();
    let assignments=wealthfolio_storage_sqlite::spending::activity_assignments::ActivityTaxonomyAssignmentRepository::new(f.pool.clone(),f.writer.clone());
    use wealthfolio_spending::activity_assignments::{
        ActivityTaxonomyAssignmentRepositoryTrait, NewActivityTaxonomyAssignment,
    };
    let result = assignments
        .assign_rule_many_single_select(
            vec![NewActivityTaxonomyAssignment {
                id: None,
                activity_id: "past".into(),
                taxonomy_id: TAXONOMY.into(),
                category_id: "cat_other_expense".into(),
                weight: 10000,
                source: "rule".into(),
            }],
            false,
        )
        .await
        .unwrap();
    assert!(result.is_empty());
    assert_eq!(
        assignments.list_for_activity("past").await.unwrap()[0].category_id,
        DESTINATION
    );
}

#[tokio::test]
async fn invalid_destinations_and_protected_references_are_blocked() {
    let f = Fixture::new().await;
    for id in [SOURCE, "missing", "cat_salary"] {
        assert!(f
            .service
            .review(CategoryMergeRequest {
                taxonomy_id: TAXONOMY.into(),
                category_id: SOURCE.into(),
                destination_id: Some(id.into())
            })
            .await
            .is_err());
    }
    for sql in [
        "INSERT INTO taxonomy_categories(id,taxonomy_id,parent_id,name,key) VALUES('child','spending_categories','merge-source','Child','child')",
        "INSERT INTO app_settings(setting_key,setting_value) VALUES('spending.excluded_category_ids','[\"merge-source\"]')",
        "INSERT INTO budget_rollover_settings(id,target_type,taxonomy_id,category_id,enabled,start_month,starting_balance) VALUES('roll','category','spending_categories','merge-source',0,'2026-01','0')",
        "INSERT INTO budget_targets(id,period_key,target_type,taxonomy_id,category_id,amount) VALUES('target','default','category','spending_categories','merge-source','0'); UPDATE taxonomy_categories SET parent_id='cat_food' WHERE id='merge-destination'",
        "INSERT INTO assets(id,kind,quote_mode,quote_ccy) VALUES('asset','INVESTMENT','MANUAL','USD'); INSERT INTO asset_taxonomy_assignments(id,asset_id,taxonomy_id,category_id,weight,source) VALUES('asset-assignment','asset','spending_categories','merge-source',10000,'manual')",
        "INSERT INTO allocation_targets(id,name,scope_type,taxonomy_id) VALUES('allocation','Allocation','all','spending_categories'); INSERT INTO allocation_target_weights(id,target_id,taxonomy_id,category_id,target_bps) VALUES('weight','allocation','spending_categories','merge-source',10000)",
    ] {
        let f=Fixture::new().await;f.seed(sql);f.seed("DELETE FROM sync_outbox");
        assert!(f.service.review(CategoryMergeRequest {taxonomy_id:TAXONOMY.into(),category_id:SOURCE.into(),destination_id:Some(DESTINATION.into())}).await.is_err());
        assert!(f.taxonomy.get_category(TAXONOMY,SOURCE).unwrap().is_some());
        assert_eq!(f.count("SELECT COUNT(*) n FROM sync_outbox"),0);
    }
}

#[tokio::test]
async fn chunked_replay_preserves_peer_local_sidecars_and_redirects_delayed_events() {
    for taxonomy_first in [false, true] {
        let source = Fixture::new().await;
        #[derive(QueryableByName)]
        struct Payload {
            #[diesel(sql_type=diesel::sql_types::Text)]
            payload: String,
        }
        let stale_bundle:Payload=diesel::sql_query("SELECT payload FROM sync_outbox WHERE entity='custom_taxonomy' ORDER BY rowid DESC LIMIT 1")
            .get_result(&mut db::get_connection(&source.pool).unwrap()).unwrap();
        // The old decoder requires `categories`; current merge bundles omit
        // that required field so an old client fails before destructive replay.
        #[derive(serde::Deserialize)]
        struct LegacyBundle {
            taxonomy: serde_json::Value,
            categories: Vec<serde_json::Value>,
        }
        let old: LegacyBundle = serde_json::from_str(&stale_bundle.payload).unwrap();
        assert!(old.taxonomy.is_object());
        assert!(!old.categories.is_empty());
        source.references();
        source.target(SOURCE, "default", "100").await;
        source.target(DESTINATION, "default", "200").await;
        source.seed("DELETE FROM sync_outbox");
        let peer = Fixture::new().await;
        peer.references();
        peer.target(SOURCE, "default", "100").await;
        peer.target(DESTINATION, "default", "200").await;
        source
            .service
            .commit(source.prepared().await)
            .await
            .unwrap();
        let mut renamed = peer
            .taxonomy
            .get_category(TAXONOMY, DESTINATION)
            .unwrap()
            .unwrap();
        renamed.name = "Peer cosmetic name".into();
        peer.taxonomy.update_category(renamed).await.unwrap();
        let repo = AppSyncRepository::new(peer.pool.clone(), peer.writer.clone());
        #[derive(QueryableByName)]
        struct Event {
            #[diesel(sql_type=diesel::sql_types::Text)]
            entity: String,
            #[diesel(sql_type=diesel::sql_types::Text)]
            entity_id: String,
            #[diesel(sql_type=diesel::sql_types::Text)]
            op: String,
            #[diesel(sql_type=diesel::sql_types::Text)]
            event_id: String,
            #[diesel(sql_type=diesel::sql_types::Text)]
            client_timestamp: String,
            #[diesel(sql_type=diesel::sql_types::Text)]
            payload: String,
        }
        let mut events=diesel::sql_query("SELECT entity,entity_id,op,event_id,client_timestamp,payload FROM sync_outbox ORDER BY rowid")
            .load::<Event>(&mut db::get_connection(&source.pool).unwrap()).unwrap();
        if taxonomy_first {
            events.sort_by_key(|e| if e.entity == "custom_taxonomy" { 0 } else { 1 });
            for event in &mut events {
                event.client_timestamp = "2090-01-01T00:00:00Z".into();
            }
        }
        for (index, event) in events.iter().enumerate() {
            if event.entity == "custom_taxonomy" {
                let legacy = serde_json::from_str::<LegacyBundle>(&event.payload);
                assert!(legacy.is_err(), "legacy clients must reject merge bundles");
            }
            repo.apply_remote_event_lww(
                serde_json::from_value(serde_json::json!(event.entity)).unwrap(),
                event.entity_id.clone(),
                serde_json::from_value(serde_json::json!(event.op)).unwrap(),
                event.event_id.clone(),
                event.client_timestamp.clone(),
                index as i64 + 1,
                serde_json::from_str(&event.payload).unwrap(),
            )
            .await
            .unwrap();
            assert_eq!(
                peer.count("SELECT COUNT(*) n FROM spending_activity_splits"),
                3,
                "chunk {index}"
            );
        }
        peer.assert_merged();
        // A later-delivered edit still naming the removed category is normalized,
        // without reviving it or flattening its split allocation.
        repo.apply_remote_event_lww(SyncEntity::SpendingActivitySplit,"split-source".into(),SyncOperation::Update,
            "delayed-split".into(),"2099-01-01T00:00:00Z".into(),100,
            serde_json::json!({"id":"split-source","activityId":"future","taxonomyId":TAXONOMY,"categoryId":SOURCE,
                "amount":"4.25","note":"delayed user note","sortOrder":7,"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2099-01-01T00:00:00Z"})).await.unwrap();
        assert_eq!(peer.count("SELECT COUNT(*) n FROM spending_activity_splits WHERE id='split-source' AND category_id='merge-destination' AND note='delayed user note'"),1);
        assert!(peer
            .taxonomy
            .get_category(TAXONOMY, SOURCE)
            .unwrap()
            .is_none());
        repo.apply_remote_event_lww(
            SyncEntity::CustomTaxonomy,
            TAXONOMY.into(),
            SyncOperation::Update,
            "stale-taxonomy-newer-clock".into(),
            "2099-02-01T00:00:00Z".into(),
            101,
            serde_json::from_str(&stale_bundle.payload).unwrap(),
        )
        .await
        .unwrap();
        assert!(peer
            .taxonomy
            .get_category(TAXONOMY, SOURCE)
            .unwrap()
            .is_none());
        assert_eq!(
            peer.count("SELECT COUNT(*) n FROM spending_activity_splits"),
            3
        );
        let targets = peer.budget.list_targets().await.unwrap();
        assert_eq!(targets.iter().find(|t|t.category_id.as_deref()==Some(DESTINATION)&&t.period_key=="default").unwrap().amount,"300");
    }
}

#[tokio::test]
async fn later_reviewed_aggregate_edit_supersedes_original_budget_functions() {
    let author = Fixture::new().await;
    let peer = Fixture::new().await;
    for f in [&author, &peer] {
        f.target(SOURCE, "default", "100").await;
        f.target(DESTINATION, "default", "200").await;
        f.target("cat_other_expense", "default", "300").await;
        f.seed("DELETE FROM sync_outbox");
    }
    author.merge(SOURCE, DESTINATION).await;
    peer.replay(&author.events()).await.unwrap();
    author.seed("DELETE FROM sync_outbox");
    author.target(DESTINATION, "default", "350").await;
    author.target(DESTINATION, "2026-03", "0").await;
    author.merge(DESTINATION, "cat_other_expense").await;
    peer.replay(&author.events()).await.unwrap();
    for f in [&author, &peer] {
        let targets = f.budget.list_targets().await.unwrap();
        for (period, amount) in [("default", "650"), ("2026-03", "300")] {
            assert_eq!(
                targets
                    .iter()
                    .find(|t| t.category_id.as_deref() == Some("cat_other_expense")
                        && t.period_key == period)
                    .unwrap()
                    .amount,
                amount
            );
        }
    }
}

#[tokio::test]
async fn unaware_budget_update_cannot_overwrite_a_merged_aggregate() {
    let merged = Fixture::new().await;
    let peer = Fixture::new().await;
    for f in [&merged, &peer] {
        f.target(SOURCE, "default", "100").await;
        f.target(DESTINATION, "default", "200").await;
        f.seed("DELETE FROM sync_outbox");
    }
    merged.merge(SOURCE, DESTINATION).await;
    peer.target(DESTINATION, "default", "250").await;
    merged.replay(&peer.events()).await.unwrap();
    assert_eq!(
        merged
            .budget
            .list_targets()
            .await
            .unwrap()
            .iter()
            .find(|t| t.category_id.as_deref() == Some(DESTINATION))
            .unwrap()
            .amount,
        "300"
    );
    assert!(
        peer.replay(&merged.events()).await.is_err(),
        "unreviewed edit must block before source deletion"
    );
    assert!(peer
        .taxonomy
        .get_category(TAXONOMY, SOURCE)
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn copying_and_overwriting_month_targets_preserves_observed_merge_context() {
    let author = Fixture::new().await;
    let peer = Fixture::new().await;
    for f in [&author, &peer] {
        f.target(SOURCE, "default", "100").await;
        f.target(DESTINATION, "default", "200").await;
        f.seed("DELETE FROM sync_outbox");
    }
    author.merge(SOURCE, DESTINATION).await;
    peer.replay(&author.events()).await.unwrap();
    author.seed("DELETE FROM sync_outbox");
    author.target(DESTINATION, "2026-03", "350").await;
    author
        .budget
        .copy_period_targets("2026-03", "2026-04", false)
        .await
        .unwrap();
    peer.replay(&author.events()).await.unwrap();
    assert_eq!(
        peer.budget
            .list_targets()
            .await
            .unwrap()
            .iter()
            .find(|t| t.category_id.as_deref() == Some(DESTINATION) && t.period_key == "2026-04")
            .unwrap()
            .amount,
        "350"
    );
    author.seed("DELETE FROM sync_outbox");
    author
        .budget
        .copy_period_targets("2026-05", "2026-04", true)
        .await
        .unwrap();
    peer.replay(&author.events()).await.unwrap();
    assert!(!peer
        .budget
        .list_targets()
        .await
        .unwrap()
        .iter()
        .any(|t| t.category_id.as_deref() == Some(DESTINATION) && t.period_key == "2026-04"));
}
