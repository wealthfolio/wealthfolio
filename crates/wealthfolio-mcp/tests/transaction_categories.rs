//! Transaction-category tools against the native taxonomy service and SQLite writer.
#![allow(clippy::unwrap_used, clippy::panic, reason = "test code")]

mod support;

use std::sync::Arc;

use serde_json::{json, Value};
use wealthfolio_agent_tools::{AgentScopeSet, AgentToolCatalog, AgentToolError};
use wealthfolio_core::taxonomies::{NewCategory, NewTaxonomy, TaxonomyService};
use wealthfolio_storage_sqlite::{db, taxonomies::TaxonomyRepository};

struct Fixture {
    path: std::path::PathBuf,
    env: Arc<support::TaxonomyEnv>,
    catalog: AgentToolCatalog,
}

impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "wealthfolio-category-test-{}",
            rand::random::<u128>()
        ));
        let access = db::DbAccess::plaintext(path.join("app.db").to_str().unwrap());
        access.prepare().unwrap();
        access.run_migrations().unwrap();
        let pool = access.create_pool().unwrap();
        let writer = db::write_actor::spawn_writer((*pool).clone()).unwrap();
        let service = Arc::new(TaxonomyService::new(Arc::new(TaxonomyRepository::new(
            pool, writer,
        ))));
        Self {
            path,
            env: Arc::new(support::TaxonomyEnv {
                taxonomies: service,
            }),
            catalog: AgentToolCatalog::mcp_catalog(),
        }
    }

    async fn call(&self, name: &str, args: Value) -> Result<Value, AgentToolError> {
        self.catalog
            .execute(
                self.env.clone(),
                &AgentScopeSet::from_strs([
                    "classification:read",
                    "classification:suggest",
                    "classification:write",
                ]),
                name,
                args,
            )
            .await
            .map(|result| result.content)
    }

    async fn draft(&self, taxonomy: &str, key: &str) -> Value {
        self.call(
            "prepare_transaction_category",
            json!({
                "taxonomyId": taxonomy, "name": "Legal", "key": key,
            }),
        )
        .await
        .unwrap()["category"]
            .clone()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

#[tokio::test]
async fn list_categories_without_accounts_or_activity_access() {
    let fixture = Fixture::new();
    let result = fixture
        .catalog
        .execute(
            fixture.env.clone(),
            &AgentScopeSet::from_strs(["classification:read"]),
            "list_transaction_categories",
            json!({}),
        )
        .await
        .unwrap()
        .content;
    let taxonomies = result["taxonomies"].as_array().unwrap();
    assert_eq!(taxonomies.len(), 3);
    for id in [
        "spending_categories",
        "income_sources",
        "savings_categories",
    ] {
        let entry = taxonomies
            .iter()
            .find(|entry| entry["taxonomy"]["id"] == id)
            .unwrap();
        assert_eq!(entry["taxonomy"]["scope"], "activity");
        assert!(!entry["categories"].as_array().unwrap().is_empty());
        let filtered = fixture
            .call("list_transaction_categories", json!({"taxonomyId": id}))
            .await
            .unwrap();
        assert_eq!(filtered["taxonomies"].as_array().unwrap().len(), 1);
        assert_eq!(filtered["taxonomies"][0], *entry);
    }
}

#[tokio::test]
async fn prepare_then_commit_creates_roots_and_children_in_each_activity_taxonomy() {
    let fixture = Fixture::new();
    for id in [
        "spending_categories",
        "income_sources",
        "savings_categories",
    ] {
        let before = fixture.env.taxonomies.get_taxonomy(id).unwrap().unwrap();
        let draft = fixture.draft(id, "legal_custom").await;
        assert_eq!(
            fixture
                .env
                .taxonomies
                .get_taxonomy(id)
                .unwrap()
                .unwrap()
                .categories
                .len(),
            before.categories.len()
        );
        let created = fixture
            .call("commit_transaction_category", json!({"category": draft}))
            .await
            .unwrap()["created"]
            .clone();
        assert_eq!(created["id"], draft["id"]);
        assert_eq!(created["key"], "legal_custom");
        assert_eq!(created["color"], "#808080");
        assert_eq!(created["parentId"], Value::Null);
        assert_eq!(created["sortOrder"], 999);

        let child = fixture.call("prepare_transaction_category", json!({
            "taxonomyId": id, "name": "Legal advice", "key": "legal_advice_custom",
            "parentId": created["id"], "color": "#123abc", "description": "Professional advice",
        })).await.unwrap()["category"].clone();
        let saved = fixture
            .call("commit_transaction_category", json!({"category": child}))
            .await
            .unwrap()["created"]
            .clone();
        assert_eq!(saved["parentId"], created["id"]);
        assert_eq!(saved["color"], "#123abc");
        assert_eq!(saved["description"], "Professional advice");
        assert_eq!(saved["sortOrder"], 999);
        let stored = fixture.env.taxonomies.get_taxonomy(id).unwrap().unwrap();
        assert_eq!(stored.categories.len(), before.categories.len() + 2);
        assert!(stored
            .categories
            .iter()
            .any(|cat| cat.id == saved["id"].as_str().unwrap()));
    }
}

#[tokio::test]
async fn duplicates_and_replays_are_rejected_in_prepare_and_commit() {
    let fixture = Fixture::new();
    let first = fixture.draft("spending_categories", "legal_custom").await;
    let second = fixture.draft("spending_categories", "legal_custom").await;
    fixture
        .call("commit_transaction_category", json!({"category": first}))
        .await
        .unwrap();
    for draft in [first.clone(), second] {
        let error = fixture
            .call("commit_transaction_category", json!({"category": draft}))
            .await
            .unwrap_err();
        assert!(matches!(error, AgentToolError::InvalidInput(_)), "{error}");
    }
    let error = fixture
        .call(
            "prepare_transaction_category",
            json!({
                "taxonomyId": "spending_categories", "name": "Duplicate", "key": "legal_custom",
            }),
        )
        .await
        .unwrap_err();
    assert!(matches!(error, AgentToolError::InvalidInput(_)), "{error}");
    // A different key cannot reuse an existing ID, either.
    let mut reused_id = first;
    reused_id["key"] = json!("another_key");
    assert!(fixture
        .call(
            "commit_transaction_category",
            json!({"category": reused_id})
        )
        .await
        .is_err());
}

#[tokio::test]
async fn invalid_taxonomies_and_parents_cannot_mutate_asset_taxonomies() {
    let fixture = Fixture::new();
    let assets_before = fixture
        .env
        .taxonomies
        .get_taxonomy("asset_classes")
        .unwrap()
        .unwrap();
    let draft = fixture.draft("spending_categories", "legal_custom").await;
    // Even a custom activity-scoped taxonomy is outside this tool's remit.
    fixture
        .env
        .taxonomies
        .create_taxonomy(NewTaxonomy {
            id: Some("custom_activity".into()),
            scope: "activity".into(),
            name: "Custom".into(),
            ..Default::default()
        })
        .await
        .unwrap();
    for id in [
        "asset_classes",
        "missing",
        "custom_activity",
        "",
        " spending_categories",
    ] {
        assert!(fixture
            .call("list_transaction_categories", json!({"taxonomyId": id}))
            .await
            .is_err());
        let mut invalid = draft.clone();
        invalid["taxonomyId"] = json!(id);
        let mut prepare = invalid.clone();
        prepare.as_object_mut().unwrap().remove("id");
        assert!(fixture
            .call("prepare_transaction_category", prepare)
            .await
            .is_err());
        assert!(fixture
            .call("commit_transaction_category", json!({"category": invalid}))
            .await
            .is_err());
    }
    let foreign_parent = &assets_before.categories[0].id;
    for parent in [foreign_parent.as_str(), "missing", ""] {
        let mut invalid = draft.clone();
        invalid["parentId"] = json!(parent);
        let mut prepare = invalid.clone();
        prepare.as_object_mut().unwrap().remove("id");
        assert!(fixture
            .call("prepare_transaction_category", prepare)
            .await
            .is_err());
        assert!(fixture
            .call("commit_transaction_category", json!({"category": invalid}))
            .await
            .is_err());
    }
    assert_eq!(
        serde_json::to_value(assets_before).unwrap(),
        serde_json::to_value(
            fixture
                .env
                .taxonomies
                .get_taxonomy("asset_classes")
                .unwrap()
                .unwrap()
        )
        .unwrap()
    );
}

#[tokio::test]
async fn commit_revalidates_fields_and_a_deleted_parent() {
    let fixture = Fixture::new();
    let draft = fixture.draft("spending_categories", "legal_custom").await;
    for (field, value) in [
        ("id", json!("")),
        ("id", json!("not-a-uuid")),
        ("key", json!(" ")),
        ("key", json!("bad key")),
        ("name", json!(" ")),
        ("color", json!("red")),
    ] {
        let mut invalid = draft.clone();
        invalid[field] = value;
        assert!(
            fixture
                .call("commit_transaction_category", json!({"category": invalid}))
                .await
                .is_err(),
            "{field}"
        );
    }
    let parent = fixture
        .call("commit_transaction_category", json!({"category": draft}))
        .await
        .unwrap()["created"]
        .clone();
    let child = fixture.call("prepare_transaction_category", json!({
        "taxonomyId": "spending_categories", "name": "Child", "key": "child_custom", "parentId": parent["id"],
    })).await.unwrap()["category"].clone();
    fixture
        .env
        .taxonomies
        .delete_category("spending_categories", parent["id"].as_str().unwrap())
        .await
        .unwrap();
    assert!(fixture
        .call("commit_transaction_category", json!({"category": child}))
        .await
        .is_err());
}

#[tokio::test]
async fn a_builtin_id_with_asset_scope_is_rejected() {
    let fixture = Fixture::new();
    let draft = fixture.draft("savings_categories", "legal_custom").await;
    let mut taxonomy = fixture
        .env
        .taxonomies
        .get_taxonomy("savings_categories")
        .unwrap()
        .unwrap()
        .taxonomy;
    taxonomy.scope = "asset".into();
    fixture
        .env
        .taxonomies
        .update_taxonomy(taxonomy)
        .await
        .unwrap();
    assert!(fixture
        .call(
            "list_transaction_categories",
            json!({"taxonomyId": "savings_categories"})
        )
        .await
        .is_err());
    assert!(fixture
        .call(
            "prepare_transaction_category",
            json!({
                "taxonomyId": "savings_categories", "name": "Legal", "key": "legal_custom",
            })
        )
        .await
        .is_err());
    assert!(fixture
        .call("commit_transaction_category", json!({"category": draft}))
        .await
        .is_err());
    let listed = fixture
        .call("list_transaction_categories", json!({}))
        .await
        .unwrap();
    assert_eq!(listed["taxonomies"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn concurrent_native_creates_reject_duplicate_activity_keys() {
    let fixture = Fixture::new();
    for taxonomy_id in [
        "spending_categories",
        "income_sources",
        "savings_categories",
    ] {
        let category = NewCategory {
            taxonomy_id: taxonomy_id.into(),
            name: "Legal".into(),
            key: "concurrent_legal".into(),
            ..Default::default()
        };
        let service = &fixture.env.taxonomies;
        let (first, second) = tokio::join!(
            service.create_category(category.clone()),
            service.create_category(category)
        );
        assert_eq!(
            usize::from(first.is_ok()) + usize::from(second.is_ok()),
            1,
            "only one concurrent create may succeed: {first:?}, {second:?}"
        );
        let duplicate = first
            .as_ref()
            .err()
            .or_else(|| second.as_ref().err())
            .unwrap();
        assert!(
            duplicate
                .to_string()
                .contains("A category with this key already exists in the taxonomy"),
            "duplicate-key error must remain recognizable by the spending editor: {duplicate}"
        );
    }
}

#[tokio::test]
async fn asset_category_creation_keeps_existing_behavior() {
    let fixture = Fixture::new();
    let category = NewCategory {
        taxonomy_id: "asset_classes".into(),
        name: "Custom".into(),
        key: "custom_key".into(),
        ..Default::default()
    };
    fixture
        .env
        .taxonomies
        .create_category(category.clone())
        .await
        .unwrap();
    fixture
        .env
        .taxonomies
        .create_category(category)
        .await
        .unwrap();
}

#[derive(Default)]
struct AuditLog(tokio::sync::Mutex<Vec<wealthfolio_mcp::McpAuditEntry>>);

#[async_trait::async_trait]
impl wealthfolio_mcp::AuditSink for AuditLog {
    async fn record(&self, entry: wealthfolio_mcp::McpAuditEntry) {
        self.0.lock().await.push(entry);
    }
}

async fn rpc(client: &reqwest::Client, url: &str, method: &str, params: Value) -> Value {
    let response = client
        .post(url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .json(&json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}))
        .send()
        .await
        .unwrap();
    let text = response.text().await.unwrap();
    serde_json::from_str(&text).unwrap_or_else(|_| panic!("non-JSON response: {text}"))
}

#[tokio::test]
async fn mcp_transport_exposes_tools_and_audits_redacted_prepare_and_commit() {
    use axum::{
        body::Body,
        http::Request,
        middleware::{self, Next},
    };
    use rmcp::transport::streamable_http_server::StreamableHttpServerConfig;
    use wealthfolio_mcp::{ActorKind, AuditOutcome, McpAuthContext, McpServerBuilder};

    let fixture = Fixture::new();
    let audit = Arc::new(AuditLog::default());
    let service = McpServerBuilder::new(fixture.env.clone())
        .audit(audit.clone())
        .build_http_service(
            StreamableHttpServerConfig::default()
                .with_stateful_mode(false)
                .with_json_response(true)
                .with_sse_keep_alive(None),
        );
    let router = axum::Router::new()
        .nest_service("/mcp", service)
        .layer(middleware::from_fn(
            |mut req: Request<Body>, next: Next| async move {
                let scopes = if req.headers().contains_key("x-test-read-only") {
                    AgentScopeSet::from_strs(["classification:read"])
                } else {
                    AgentScopeSet::from_strs([
                        "classification:read",
                        "classification:suggest",
                        "classification:write",
                    ])
                };
                req.extensions_mut().insert(McpAuthContext {
                    actor_kind: ActorKind::Pat,
                    actor_fingerprint: "sha256:test".into(),
                    granted_scopes: scopes,
                });
                next.run(req).await
            },
        ));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/mcp", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let client = reqwest::Client::new();
    let initialized = rpc(
        &client,
        &url,
        "initialize",
        json!({
            "protocolVersion": "2025-03-26", "capabilities": {},
            "clientInfo": { "name": "category-test", "version": "1.0" }
        }),
    )
    .await;
    assert!(initialized.get("result").is_some(), "{initialized}");
    let tools = rpc(&client, &url, "tools/list", json!({})).await;
    let names: Vec<_> = tools["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    for name in [
        "list_transaction_categories",
        "prepare_transaction_category",
        "commit_transaction_category",
    ] {
        assert!(names.contains(&name));
    }
    let prepared = rpc(&client, &url, "tools/call", json!({
        "name": "prepare_transaction_category", "arguments": {
            "taxonomyId": "income_sources", "name": "Private consulting", "key": "private_consulting_custom",
            "description": "Private description"
        }
    })).await;
    let prepared: Value =
        serde_json::from_str(prepared["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    let args = json!({"category": prepared["category"]});
    let read_only = reqwest::Client::builder()
        .default_headers({
            let mut headers = reqwest::header::HeaderMap::new();
            headers.insert(
                "x-test-read-only",
                reqwest::header::HeaderValue::from_static("true"),
            );
            headers
        })
        .build()
        .unwrap();
    let visible = rpc(&read_only, &url, "tools/list", json!({})).await;
    let names: Vec<_> = visible["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"list_transaction_categories"));
    assert!(!names.contains(&"prepare_transaction_category"));
    assert!(!names.contains(&"commit_transaction_category"));
    let denied = rpc(
        &read_only,
        &url,
        "tools/call",
        json!({
            "name": "commit_transaction_category", "arguments": args
        }),
    )
    .await;
    assert_eq!(denied["result"]["isError"], true, "{denied}");
    let committed = rpc(
        &client,
        &url,
        "tools/call",
        json!({
            "name": "commit_transaction_category", "arguments": args
        }),
    )
    .await;
    assert_ne!(committed["result"]["isError"], true, "{committed}");
    let replayed = rpc(
        &client,
        &url,
        "tools/call",
        json!({
            "name": "commit_transaction_category", "arguments": args
        }),
    )
    .await;
    assert_eq!(replayed["result"]["isError"], true, "{replayed}");
    let malformed = rpc(
        &client,
        &url,
        "tools/call",
        json!({
            "name": "commit_transaction_category", "arguments": {
                "category": { "taxonomyId": "income_sources", "Private field": "Private value" }
            }
        }),
    )
    .await;
    assert_eq!(malformed["result"]["isError"], true, "{malformed}");
    let entries = audit.0.lock().await;
    assert_eq!(entries.len(), 5);
    assert_eq!(entries[0].outcome, AuditOutcome::Success);
    assert_eq!(entries[1].outcome, AuditOutcome::Denied);
    assert_eq!(entries[2].outcome, AuditOutcome::Success);
    assert_eq!(entries[3].outcome, AuditOutcome::Error);
    assert_eq!(entries[4].outcome, AuditOutcome::Error);
    for entry in entries.iter() {
        assert_eq!(
            entry.args_summary,
            json!({"taxonomyId": "income_sources", "category": "[redacted]"})
        );
        assert!(!format!("{entry:?}").contains("Private"));
        assert!(!format!("{entry:?}").contains("private_consulting"));
    }
    server.abort();
}
