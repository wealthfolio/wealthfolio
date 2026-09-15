use super::delete_account_references;
use crate::accounts::AccountRepository;
use crate::db::{write_actor::spawn_writer, DbAccess};
use crate::sync::app_sync::AppSyncRepository;
use diesel::Connection as _;
use wealthfolio_core::accounts::AccountRepositoryTrait;
use wealthfolio_core::sync::{SyncEntity, SyncOperation};
use wealthfolio_spending::settings::SETTING_KEY_ACCOUNT_IDS;

const REPAIR: &str =
    include_str!("../../migrations/2026-09-15-000001_account_delete_cleanup/up.sql");

fn apply_repair(conn: &rusqlite::Connection) {
    // Re-run the consolidated migration against seeded legacy data.
    let down = include_str!("../../migrations/2026-09-15-000001_account_delete_cleanup/down.sql");
    conn.execute_batch(&format!("BEGIN;{down}{REPAIR}COMMIT;"))
        .unwrap();
}

fn fixture() -> (tempfile::TempDir, DbAccess, rusqlite::Connection) {
    let dir = tempfile::tempdir().unwrap();
    let access = DbAccess::plaintext(dir.path().join("test.db").to_str().unwrap());
    access.run_migrations().unwrap();
    let conn = access.connect_rusqlite().unwrap();
    conn.execute_batch(
        "INSERT INTO accounts(id,name,currency) VALUES ('delete','Delete','USD'),('keep','Keep','USD');
         INSERT INTO import_templates(id) VALUES ('template');
         INSERT INTO import_account_templates(id,account_id,template_id) VALUES
            ('link-delete','delete','template'),('link-keep','keep','template');
         INSERT INTO allocation_targets(id,name,scope_type,scope_id) VALUES
            ('target-delete','Delete','account','delete'),('target-shared','Shared','all',NULL),
            ('target-portfolio','Portfolio','portfolio','delete');
         INSERT INTO allocation_target_weights(id,target_id,taxonomy_id,category_id,target_bps)
            SELECT 'weight','target-delete',taxonomy_id,id,10000 FROM taxonomy_categories
            WHERE taxonomy_id='asset_classes' LIMIT 1;
         INSERT INTO allocation_target_constraints(id,target_id,subject_type,subject_id,action) VALUES
            ('owned','target-delete','account','keep','trade'),
            ('reference','target-shared','account','delete','trade'),
            ('unrelated','target-shared','asset','delete','trade');
         INSERT INTO contribution_limits(id,group_name,contribution_year,limit_amount,account_ids)
            VALUES ('limit','Limit',2026,1000,' keep , delete,delete,delete-prefix,,other');
         INSERT INTO app_settings(setting_key,setting_value) VALUES
            ('spending.account_ids','[\"keep\",\"delete\",\"delete-prefix\",\"delete\"]')
            ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value;"
    ).unwrap();
    (dir, access, conn)
}

fn count(conn: &rusqlite::Connection, table: &str) -> i64 {
    conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}

fn lists(conn: &rusqlite::Connection) -> (Option<String>, String) {
    (
        conn.query_row(
            "SELECT account_ids FROM contribution_limits WHERE id='limit'",
            [],
            |r| r.get(0),
        )
        .unwrap(),
        conn.query_row(
            "SELECT setting_value FROM app_settings WHERE setting_key=?1",
            [SETTING_KEY_ACCOUNT_IDS],
            |r| r.get(0),
        )
        .unwrap(),
    )
}

fn assert_clean(conn: &rusqlite::Connection) {
    assert_eq!(count(conn, "import_account_templates"), 1);
    assert_eq!(count(conn, "allocation_targets"), 2);
    assert_eq!(count(conn, "allocation_target_weights"), 0);
    assert_eq!(count(conn, "allocation_target_constraints"), 1);
    assert_eq!(
        conn.query_row("SELECT id FROM allocation_target_constraints", [], |r| {
            r.get::<_, String>(0)
        })
        .unwrap(),
        "unrelated"
    );
    assert_eq!(count(conn, "import_templates WHERE id='template'"), 1);
    assert_eq!(
        lists(conn),
        (
            Some(" keep ,delete-prefix,,other".into()),
            "[\"keep\",\"delete-prefix\"]".into()
        )
    );
}

#[tokio::test]
async fn local_delete_cleans_references_atomically_and_is_idempotent() {
    let (_dir, access, conn) = fixture();
    let pool = access.create_pool().unwrap();
    let writer = spawn_writer((*pool).clone()).unwrap();
    let repo = AccountRepository::new(pool, writer);
    conn.execute_batch("CREATE TRIGGER fail_account_delete BEFORE DELETE ON accounts BEGIN SELECT RAISE(ABORT,'injected failure'); END;").unwrap();
    assert!(repo.delete("delete").await.is_err());
    assert_eq!(count(&conn, "import_account_templates"), 2);
    assert_eq!(count(&conn, "allocation_targets"), 3);
    assert_eq!(count(&conn, "allocation_target_constraints"), 3);
    assert_eq!(
        lists(&conn).0.as_deref(),
        Some(" keep , delete,delete,delete-prefix,,other")
    );
    conn.execute_batch("DROP TRIGGER fail_account_delete;")
        .unwrap();
    assert_eq!(repo.delete("delete").await.unwrap(), 1);
    assert_clean(&conn);
    assert_eq!(repo.delete("delete").await.unwrap(), 0);
    assert_clean(&conn);
}

#[tokio::test]
async fn remote_delete_cleans_references_even_when_account_is_absent() {
    for absent in [false, true] {
        let (_dir, access, conn) = fixture();
        if absent {
            conn.execute("DELETE FROM accounts WHERE id='delete'", [])
                .unwrap();
        }
        let pool = access.create_pool().unwrap();
        let writer = spawn_writer((*pool).clone()).unwrap();
        let repo = AppSyncRepository::new(pool, writer);
        repo.apply_remote_event_lww(
            SyncEntity::Account,
            "delete".into(),
            SyncOperation::Delete,
            "delete-event".into(),
            "2026-09-15T00:00:00Z".into(),
            1,
            serde_json::json!({}),
        )
        .await
        .unwrap();
        assert_clean(&conn);
        assert_eq!(
            count(&conn, "sync_outbox"),
            0,
            "cleanup must not echo sync events"
        );
        assert_eq!(
            count(
                &conn,
                "sync_entity_metadata WHERE entity='account' AND last_op='delete'"
            ),
            1
        );
    }
}

#[tokio::test]
async fn snapshot_account_replacement_preserves_omitted_configuration_tables() {
    let (dir, access, conn) = fixture();
    let snapshot = dir.path().join("snapshot.db");
    let source = rusqlite::Connection::open(&snapshot).unwrap();
    source
        .execute_batch(
            "CREATE TABLE accounts(id TEXT,name TEXT,currency TEXT);
        INSERT INTO accounts VALUES ('delete','Restored','USD'),('keep','Keep','USD');",
        )
        .unwrap();
    drop(source);
    let pool = access.create_pool().unwrap();
    let writer = spawn_writer((*pool).clone()).unwrap();
    let repo = AppSyncRepository::new(pool, writer);
    let before = lists(&conn);
    repo.restore_snapshot_tables_from_file(
        snapshot.to_string_lossy().into_owned(),
        vec!["accounts".into()],
        1,
        "device".into(),
        None,
    )
    .await
    .unwrap();
    assert_eq!(count(&conn, "allocation_targets"), 3);
    assert_eq!(count(&conn, "allocation_target_weights"), 1);
    assert_eq!(count(&conn, "allocation_target_constraints"), 3);
    assert_eq!(count(&conn, "import_account_templates"), 2);
    assert_eq!(lists(&conn), before);
}

#[test]
fn repair_requires_absent_account_and_deletion_tombstone() {
    let (_dir, _access, conn) = fixture();
    conn.execute_batch("PRAGMA foreign_keys=OFF;
        DELETE FROM accounts WHERE id='delete';
        INSERT INTO sync_entity_metadata(entity,entity_id,last_event_id,last_client_timestamp,last_op,last_seq)
        VALUES ('account','keep','keep-event','2026-09-15','delete',1);").unwrap();
    apply_repair(&conn);
    assert_eq!(
        count(&conn, "allocation_targets"),
        3,
        "unknown parent and existing account must survive"
    );
    conn.execute_batch("INSERT INTO sync_entity_metadata(entity,entity_id,last_event_id,last_client_timestamp,last_op,last_seq)
        VALUES ('account','delete','delete-event','2026-09-15','delete',2);").unwrap();
    apply_repair(&conn);
    assert_clean(&conn);
    assert_eq!(count(&conn, "pragma_foreign_key_check"), 0);
    apply_repair(&conn);
    assert_clean(&conn);
}

#[test]
fn runtime_and_migration_prune_lists_identically() {
    let (_dir, access, conn) = fixture();
    conn.execute_batch("PRAGMA foreign_keys=OFF;
        DELETE FROM accounts WHERE id='delete';
        INSERT INTO sync_entity_metadata(entity,entity_id,last_event_id,last_client_timestamp,last_op,last_seq)
        VALUES ('account','delete','delete-event','2026-09-15','delete',1);").unwrap();
    let cases = [
        (Some("delete"), "[\"delete\"]", Some(""), "[]"),
        (None, "null", None, "null"),
        (Some(""), "{}", Some(""), "{}"),
        (
            Some("keep,delete-prefix,,\"quoted\",back\\slash,\tdelete\n,\u{2003}delete\u{2003}"),
            "[\"keep\",\"delete\",\"delete\"]",
            Some("keep,delete-prefix,,\"quoted\",back\\slash"),
            "[\"keep\"]",
        ),
        (Some("keep"), "invalid", Some("keep"), "invalid"),
        (
            Some("keep"),
            "[\"delete\",1]",
            Some("keep"),
            "[\"delete\",1]",
        ),
        (
            Some("keep"),
            "[\"delete\",null]",
            Some("keep"),
            "[\"delete\",null]",
        ),
    ];
    for (csv, json, expected_csv, expected_json) in cases {
        for migration in [false, true] {
            conn.execute(
                "UPDATE contribution_limits SET account_ids=?1 WHERE id='limit'",
                [csv],
            )
            .unwrap();
            conn.execute(
                "UPDATE app_settings SET setting_value=?1 WHERE setting_key=?2",
                [json, SETTING_KEY_ACCOUNT_IDS],
            )
            .unwrap();
            if migration {
                apply_repair(&conn);
            } else {
                let mut connection = access.connect().unwrap();
                connection
                    .transaction::<_, diesel::result::Error, _>(|connection| {
                        delete_account_references(connection, "delete").unwrap();
                        Ok(())
                    })
                    .unwrap();
            }
            assert_eq!(
                lists(&conn),
                (expected_csv.map(str::to_owned), expected_json.into()),
                "migration={migration} csv={csv:?} json={json}"
            );
        }
    }
}
