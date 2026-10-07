#![allow(clippy::unwrap_used, clippy::panic, reason = "test code")]
use db::get_connection;
use diesel::prelude::*;
use rust_decimal::Decimal;
use wealthfolio_core::activities::{ActivityRepositoryTrait, ActivityUpsert};
use wealthfolio_core::sync::{SyncEntity, SyncOperation};
use wealthfolio_storage_sqlite::schema::{activities, sync_applied_events, sync_entity_metadata};
use wealthfolio_storage_sqlite::{
    activities::ActivityRepository, db, sync::app_sync::AppSyncRepository,
};

fn setup_db() -> (
    tempfile::TempDir,
    std::sync::Arc<db::DbPool>,
    db::WriteHandle,
    std::sync::Arc<wealthfolio_storage_sqlite::sync::ProfileSyncState>,
) {
    let dir = tempfile::tempdir().unwrap();
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

#[tokio::test]
async fn pending_patch_must_not_cross_profile_databases() {
    check_isolation(false, false, false, false).await;
}

#[tokio::test]
async fn batched_pending_patch_must_not_cross_profile_databases() {
    check_isolation(true, false, false, false).await;
}

#[tokio::test]
async fn pending_patch_survives_writer_recreation() {
    check_isolation(true, true, false, false).await;
}

#[tokio::test]
async fn cleared_pending_patch_is_not_replayed_after_writer_recreation() {
    check_isolation(true, true, true, false).await;
}

#[tokio::test]
async fn pending_patch_can_be_restored_after_database_rollback() {
    check_isolation(true, true, true, true).await;
}

async fn check_isolation(batched: bool, recreate: bool, replaced: bool, rollback: bool) {
    let (_profile_b_dir, pool, writer, _profile_b_sync_state) = setup_db();
    let mut conn = get_connection(&pool).expect("conn");

    let entity_id = "broker_activity_patch:fb2b00cb29fd12b1fe0a06d8878ddd16".to_string();
    let entity_db = "broker_activity_user_patch".to_string();

    let (_profile_a_dir, profile_a_pool, mut profile_a_writer, profile_a_sync_state) = setup_db();
    let profile_a = AppSyncRepository::new(profile_a_pool.clone(), profile_a_writer.clone());
    let payload = serde_json::json!({
        "sourceSystem": "SNAPTRADE",
        "providerAccountId": "provider-account-1",
        "sourceRecordId": "broker-record-missing-first",
        "overlay": {
            "notes": "Synced pending note",
            "activityTypeOverride": "SELL",
            "subtype": "DRIP",
            "needsReview": false
        }
    });
    let event_id = "broker-patch-event-missing-first".to_string();
    let timestamp = "2026-02-01T00:00:00Z".to_string();
    if batched {
        let applied = profile_a
            .apply_remote_events_lww_batch(vec![(
                SyncEntity::BrokerActivityUserPatch,
                entity_id.clone(),
                SyncOperation::Update,
                event_id,
                timestamp,
                9,
                payload,
            )])
            .await
            .expect("defer batched patch");
        assert_eq!(applied, 0);
    } else {
        let applied = profile_a
            .apply_remote_event_lww(
                SyncEntity::BrokerActivityUserPatch,
                entity_id.clone(),
                SyncOperation::Update,
                event_id,
                timestamp,
                9,
                payload,
            )
            .await
            .expect("defer patch");
        assert!(!applied);
    }

    let metadata_count: i64 = sync_entity_metadata::table
        .filter(sync_entity_metadata::entity.eq(&entity_db))
        .filter(sync_entity_metadata::entity_id.eq(&entity_id))
        .count()
        .get_result(&mut conn)
        .expect("metadata count");
    assert_eq!(metadata_count, 0);
    let applied_event_count: i64 = sync_applied_events::table
        .filter(sync_applied_events::event_id.eq("broker-patch-event-missing-first"))
        .count()
        .get_result(&mut conn)
        .expect("applied event count");
    assert_eq!(applied_event_count, 0);
    drop(conn);

    if recreate {
        // Device sync advances its cursor even when an edit waits for a broker import.
        profile_a.set_cursor(9).await.unwrap();
        profile_a_writer.shutdown().await;
        drop(profile_a);
        if replaced {
            if rollback {
                let previous = profile_a_sync_state.take_for_database_replacement();
                // Rollback reopens the original database with its pending edits.
                profile_a_sync_state.restore_after_database_rollback(previous);
            } else {
                profile_a_sync_state.clear();
            }
        }
        let (reopened_writer, _task) = db::write_actor::spawn_writer_with_sync_state(
            (*profile_a_pool).clone(),
            std::sync::Arc::new(|| {}),
            profile_a_sync_state,
        )
        .unwrap();
        profile_a_writer = reopened_writer;
        let reopened = AppSyncRepository::new(profile_a_pool.clone(), profile_a_writer.clone());
        assert_eq!(reopened.get_cursor().unwrap(), 9);
    }

    // Both profiles import the same shared broker identity. B must leave A's edit pending.
    for (pool, writer, is_owner) in [
        (pool, writer, false),
        (profile_a_pool, profile_a_writer, true),
    ] {
        let mut conn = get_connection(&pool).unwrap();
        diesel::sql_query(
            "INSERT INTO accounts \
             (id, name, account_type, `group`, currency, is_default, is_active, created_at, updated_at, \
              platform_id, account_number, meta, provider, provider_account_id, is_archived, tracking_mode) \
             VALUES ('broker-local-account', 'Broker Account', 'cash', NULL, 'USD', 0, 1, \
                     CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, NULL, NULL, 'SNAPTRADE', \
                     'provider-account-1', 0, 'portfolio')",
        )
        .execute(&mut conn)
        .expect("insert broker account");

        drop(conn);
        let activity_repo = ActivityRepository::new(pool.clone(), writer);
        activity_repo
            .bulk_upsert(vec![ActivityUpsert {
                id: "broker-local-activity-imported-later".to_string(),
                account_id: "broker-local-account".to_string(),
                asset_id: None,
                activity_type: "BUY".to_string(),
                subtype: None,
                activity_date: "2026-01-01T00:00:00Z".to_string(),
                quantity: Some(Decimal::new(10, 0)),
                unit_price: Some(Decimal::new(5, 0)),
                currency: "USD".to_string(),
                fee: Some(Decimal::new(1, 0)),
                tax: None,
                amount: Some(Decimal::new(50, 0)),
                status: None,
                notes: Some("Broker note".to_string()),
                fx_rate: None,
                metadata: Some("{\"broker\":\"keep\"}".to_string()),
                needs_review: Some(true),
                source_system: Some("SNAPTRADE".to_string()),
                source_record_id: Some("broker-record-missing-first".to_string()),
                source_group_id: Some("broker-group".to_string()),
                idempotency_key: Some("broker-idempotency-missing-first".to_string()),
                import_run_id: None,
            }])
            .await
            .expect("import broker activity");

        let mut conn = get_connection(&pool).expect("conn");
        let row = activities::table
            .find("broker-local-activity-imported-later")
            .select((
                activities::activity_type,
                activities::activity_type_override,
                activities::subtype,
                activities::notes,
                activities::needs_review,
                activities::is_user_modified,
                activities::amount,
                activities::source_group_id,
            ))
            .first::<(
                String,
                Option<String>,
                Option<String>,
                Option<String>,
                i32,
                i32,
                Option<String>,
                Option<String>,
            )>(&mut conn)
            .expect("imported broker activity");

        let receives_patch = is_owner && (!replaced || rollback);
        assert_eq!(row.0, "BUY");
        assert_eq!(row.1, receives_patch.then(|| "SELL".to_string()));
        assert_eq!(row.2, receives_patch.then(|| "DRIP".to_string()));
        assert_eq!(
            row.3.as_deref(),
            Some(if receives_patch {
                "Synced pending note"
            } else {
                "Broker note"
            })
        );
        assert_eq!(row.4, if receives_patch { 0 } else { 1 });
        assert_eq!(row.5, i32::from(receives_patch));
        assert_eq!(row.6.as_deref(), Some("50"));
        assert_eq!(row.7.as_deref(), Some("broker-group"));
        let applied_count: i64 = sync_applied_events::table
            .filter(sync_applied_events::event_id.eq("broker-patch-event-missing-first"))
            .count()
            .get_result(&mut conn)
            .unwrap();
        assert_eq!(applied_count, i64::from(receives_patch));
    }
}
