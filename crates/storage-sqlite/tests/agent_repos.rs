//! Integration tests for the agent/MCP storage: verifies the
//! personal_access_tokens and mcp_audit_log migrations apply cleanly and
//! the repositories round-trip against a real SQLite database.
#![allow(clippy::unwrap_used, clippy::panic, reason = "test code")]

use tempfile::tempdir;
use wealthfolio_storage_sqlite::agent::{
    AuditFilter, McpAuditRepository, NewMcpAuditLogDB, NewPersonalAccessToken, PatRepository,
};
use wealthfolio_storage_sqlite::db;

fn setup() -> (
    tempfile::TempDir,
    std::sync::Arc<db::DbPool>,
    db::WriteHandle,
) {
    let dir = tempdir().unwrap();
    let access = db::DbAccess::plaintext(db::get_db_path(dir.path().to_str().unwrap()));
    access.prepare().unwrap();
    access.run_migrations().unwrap();
    let pool = access.create_pool().unwrap();
    let writer = db::write_actor::spawn_writer((*pool).clone()).unwrap();
    (dir, pool, writer)
}

fn new_token(name: &str, prefix: &str, hash: &str) -> NewPersonalAccessToken {
    NewPersonalAccessToken {
        name: name.to_string(),
        token_prefix: prefix.to_string(),
        token_hash: hash.to_string(),
        scopes_json: r#"["accounts:read","holdings:read"]"#.to_string(),
        expires_at: None,
    }
}

#[tokio::test]
async fn pat_create_list_find_delete_touch() {
    let (_dir, pool, writer) = setup();
    let repo = PatRepository::new(pool, writer);

    let created = repo
        .create(new_token("Claude Desktop", "abc123def456", "hash-1"))
        .await
        .unwrap();
    assert_eq!(created.name, "Claude Desktop");
    assert!(created.revoked_at.is_none());

    repo.create(new_token("Other", "zzz999yyy888", "hash-2"))
        .await
        .unwrap();

    let all = repo.list().unwrap();
    assert_eq!(all.len(), 2);

    let found = repo.find_by_prefix("abc123def456").unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].token_hash, "hash-1");
    assert!(repo.find_by_prefix("nope").unwrap().is_empty());

    repo.touch_last_used(&created.id).await.unwrap();
    let touched = repo.find_by_prefix("abc123def456").unwrap();
    assert!(touched[0].last_used_at.is_some());

    // delete() hard-removes the row (cuts off access immediately).
    assert!(repo.delete(&created.id).await.unwrap());
    assert!(!repo.delete("missing-id").await.unwrap());
    assert!(repo.find_by_prefix("abc123def456").unwrap().is_empty());
}

#[tokio::test]
async fn duplicate_token_hash_is_rejected() {
    let (_dir, pool, writer) = setup();
    let repo = PatRepository::new(pool, writer);

    repo.create(new_token("One", "prefix-1", "same-hash"))
        .await
        .unwrap();
    let dup = repo.create(new_token("Two", "prefix-2", "same-hash")).await;
    assert!(dup.is_err(), "token_hash UNIQUE constraint must hold");
}

fn audit_entry(tool: &str, outcome: &str) -> NewMcpAuditLogDB {
    NewMcpAuditLogDB {
        session_id: "sess-1".to_string(),
        actor_kind: "pat".to_string(),
        actor_fingerprint: "sha256:test".to_string(),
        tool: tool.to_string(),
        scopes_json: r#"["accounts:read"]"#.to_string(),
        args_summary: Some(r#"{"a":1}"#.to_string()),
        outcome: outcome.to_string(),
        error_message: None,
    }
}

#[tokio::test]
async fn audit_insert_page_filter_purge() {
    let (_dir, pool, writer) = setup();
    let repo = McpAuditRepository::new(pool, writer);

    repo.insert(audit_entry("get_accounts", "success"))
        .await
        .unwrap();
    repo.insert(audit_entry("get_holdings", "success"))
        .await
        .unwrap();
    repo.insert(audit_entry("get_holdings", "denied"))
        .await
        .unwrap();

    let (rows, total) = repo.list_paged(1, 10, &AuditFilter::default()).unwrap();
    assert_eq!(total, 3);
    assert_eq!(rows.len(), 3);

    let only_holdings = vec!["get_holdings".to_string()];
    let (filtered, filtered_total) = repo
        .list_paged(
            1,
            10,
            &AuditFilter {
                tools: &only_holdings,
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(filtered_total, 2);
    assert!(filtered.iter().all(|r| r.tool == "get_holdings"));

    let (page2, _) = repo.list_paged(2, 2, &AuditFilter::default()).unwrap();
    assert_eq!(page2.len(), 1);

    let purged = repo.purge_all().await.unwrap();
    assert_eq!(purged, 3);
    let (after, total_after) = repo.list_paged(1, 10, &AuditFilter::default()).unwrap();
    assert!(after.is_empty());
    assert_eq!(total_after, 0);
}

#[tokio::test]
async fn audit_tool_search_treats_underscore_literally() {
    let (_dir, pool, writer) = setup();
    let repo = McpAuditRepository::new(pool, writer);

    // `get_holdings` has a literal underscore; `getXholdings` differs only at
    // that position. An unescaped LIKE `%get_holdings%` would treat `_` as a
    // wildcard and match both — escaping must keep the search literal.
    repo.insert(audit_entry("get_holdings", "success"))
        .await
        .unwrap();
    repo.insert(audit_entry("getXholdings", "success"))
        .await
        .unwrap();

    let search = "get_holdings".to_string();
    let (rows, total) = repo
        .list_paged(
            1,
            10,
            &AuditFilter {
                tool_search: Some(&search),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(
        total, 1,
        "underscore must match literally, not as a wildcard"
    );
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].tool, "get_holdings");
}

#[tokio::test]
async fn audit_rejects_invalid_outcome() {
    let (_dir, pool, writer) = setup();
    let repo = McpAuditRepository::new(pool, writer);
    let result = repo.insert(audit_entry("get_accounts", "weird")).await;
    assert!(result.is_err(), "outcome CHECK constraint must hold");
}

#[tokio::test]
async fn permission_edit_preserves_credentials_expiration_and_usage() {
    let (_dir, pool, writer) = setup();
    let repo = PatRepository::new(pool, writer);
    let mut input = new_token("editable", "edit-prefix", "edit-hash");
    input.expires_at = Some("2000-01-01T00:00:00Z".into());
    let created = repo.create(input).await.unwrap();
    repo.touch_last_used(&created.id).await.unwrap();
    let before = repo.list().unwrap().remove(0);
    let after = repo
        .update_scopes(&created.id, vec!["holdings:read".into()])
        .await
        .unwrap()
        .unwrap();
    assert_eq!(after.id, before.id);
    assert_eq!(after.revoked_at, before.revoked_at);
    assert_eq!(after.token_hash, before.token_hash);
    assert_eq!(after.token_prefix, before.token_prefix);
    assert_eq!(after.expires_at, before.expires_at);
    assert_eq!(after.created_at, before.created_at);
    assert_eq!(after.last_used_at, before.last_used_at);
    assert_eq!(after.name, before.name);
    assert_eq!(after.scopes_json, r#"["holdings:read"]"#);
    assert!(repo
        .update_scopes("missing", vec!["accounts:read".into()])
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn permission_edit_does_not_overwrite_concurrent_usage_or_another_token() {
    let (_dir, pool, writer) = setup();
    let repo = PatRepository::new(pool, writer);
    let edited = repo
        .create(new_token("editable", "edit-prefix", "edit-hash"))
        .await
        .unwrap();
    let other = repo
        .create(new_token("other", "other-prefix", "other-hash"))
        .await
        .unwrap();
    let (update, touch) = tokio::join!(
        repo.update_scopes(&edited.id, vec!["accounts:read".into()]),
        repo.touch_last_used(&edited.id),
    );
    assert!(update.unwrap().is_some());
    touch.unwrap();
    let row = repo.find_by_prefix(&edited.token_prefix).unwrap().remove(0);
    assert!(row.last_used_at.is_some());
    assert_eq!(row.scopes_json, r#"["accounts:read"]"#);
    assert_eq!(row.token_hash, edited.token_hash);
    let unaffected = repo.find_by_prefix(&other.token_prefix).unwrap().remove(0);
    assert_eq!(unaffected.scopes_json, other.scopes_json);
    assert_eq!(unaffected.last_used_at, other.last_used_at);
    repo.delete(&edited.id).await.unwrap();
    assert!(repo
        .update_scopes(&edited.id, vec!["holdings:read".into()])
        .await
        .unwrap()
        .is_none());
}
