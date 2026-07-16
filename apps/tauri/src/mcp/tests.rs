//! Router-level tests for the embedded MCP server: health, bearer auth,
//! Origin validation, and a stateful-mode MCP initialize round-trip.

use std::sync::Arc;

use tokio_util::sync::CancellationToken;
use wealthfolio_agent_tools::AgentEnvironment;
use wealthfolio_mcp::{AuditSink, McpAuditEntry};
use wealthfolio_storage_sqlite::agent::{NewPersonalAccessToken, PatRepository};
use wealthfolio_storage_sqlite::db::{create_pool, run_migrations, write_actor::spawn_writer};

use super::server::build_router;

/// A real `PatRepository` backed by a fresh temp SQLite DB. The returned
/// `TempDir` keeps the file alive for the repository's lifetime.
fn pat_repo() -> (Arc<PatRepository>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("test.db").to_string_lossy().to_string();
    run_migrations(&db_path).unwrap();
    let pool = create_pool(&db_path).unwrap();
    let writer = spawn_writer((*pool).clone()).unwrap();
    (Arc::new(PatRepository::new(pool, writer)), dir)
}

/// Mints a full-scope PAT in `repo` and returns the raw token.
async fn mint_pat(repo: &PatRepository, scopes: &[&str]) -> String {
    let token = wealthfolio_mcp::pat::generate_token();
    let prefix = wealthfolio_mcp::pat::token_prefix(&token)
        .unwrap()
        .to_string();
    repo.create(NewPersonalAccessToken {
        name: "test".to_string(),
        token_prefix: prefix,
        token_hash: wealthfolio_mcp::pat::hash_token(&token),
        scopes_json: serde_json::to_string(scopes).unwrap(),
        expires_at: None,
    })
    .await
    .unwrap();
    token
}

struct StubEnv;

impl AgentEnvironment for StubEnv {
    fn base_currency(&self) -> String {
        "USD".to_string()
    }
    fn account_service(&self) -> Arc<dyn wealthfolio_core::accounts::AccountServiceTrait> {
        unimplemented!("StubEnv")
    }
    fn activity_service(&self) -> Arc<dyn wealthfolio_core::activities::ActivityServiceTrait> {
        unimplemented!("StubEnv")
    }
    fn holdings_service(
        &self,
    ) -> Arc<dyn wealthfolio_core::portfolio::holdings::HoldingsServiceTrait> {
        unimplemented!("StubEnv")
    }
    fn valuation_service(
        &self,
    ) -> Arc<dyn wealthfolio_core::portfolio::valuation::ValuationServiceTrait> {
        unimplemented!("StubEnv")
    }
    fn goal_service(&self) -> Arc<dyn wealthfolio_core::goals::GoalServiceTrait> {
        unimplemented!("StubEnv")
    }
    fn settings_service(&self) -> Arc<dyn wealthfolio_core::settings::SettingsServiceTrait> {
        unimplemented!("StubEnv")
    }
    fn quote_service(&self) -> Arc<dyn wealthfolio_core::quotes::QuoteServiceTrait> {
        unimplemented!("StubEnv")
    }
    fn asset_service(&self) -> Arc<dyn wealthfolio_core::assets::AssetServiceTrait> {
        unimplemented!("StubEnv")
    }
    fn allocation_service(
        &self,
    ) -> Arc<dyn wealthfolio_core::portfolio::allocation::AllocationServiceTrait> {
        unimplemented!("StubEnv")
    }
    fn performance_service(
        &self,
    ) -> Arc<dyn wealthfolio_core::portfolio::performance::PerformanceServiceTrait> {
        unimplemented!("StubEnv")
    }
    fn income_service(&self) -> Arc<dyn wealthfolio_core::portfolio::income::IncomeServiceTrait> {
        unimplemented!("StubEnv")
    }
    fn health_service(&self) -> Arc<dyn wealthfolio_core::health::HealthServiceTrait> {
        unimplemented!("StubEnv")
    }
    fn taxonomy_service(&self) -> Arc<dyn wealthfolio_core::taxonomies::TaxonomyServiceTrait> {
        unimplemented!("StubEnv")
    }
    fn portfolio_service(&self) -> Arc<dyn wealthfolio_core::portfolios::PortfolioServiceTrait> {
        unimplemented!("StubEnv")
    }
    fn net_worth_service(
        &self,
    ) -> Arc<dyn wealthfolio_core::portfolio::net_worth::NetWorthServiceTrait> {
        unimplemented!("StubEnv")
    }
    fn contribution_limit_service(
        &self,
    ) -> Arc<dyn wealthfolio_core::limits::ContributionLimitServiceTrait> {
        unimplemented!("StubEnv")
    }
    fn cash_activity_service(
        &self,
    ) -> Arc<dyn wealthfolio_spending::cash_activities::CashActivityServiceTrait> {
        unimplemented!("StubEnv")
    }
    fn categorization_rules_service(
        &self,
    ) -> Arc<dyn wealthfolio_spending::categorization_rules::CategorizationRulesServiceTrait> {
        unimplemented!("StubEnv")
    }
}

struct NoopSink;

#[async_trait::async_trait]
impl AuditSink for NoopSink {
    async fn record(&self, _entry: McpAuditEntry) {}
}

/// Spawns the real router on a random loopback port with a fresh PAT store
/// holding one full-scope token; returns `(base_url, token)`.
async fn spawn_server() -> (String, String) {
    let (repo, dir) = pat_repo();
    let token = mint_pat(&repo, &["accounts:read", "holdings:read"]).await;
    let base = spawn_server_with_repo(repo, dir).await;
    (base, token)
}

/// Spawns the router with a caller-provided PAT store (and its backing temp
/// dir, which is moved into the serve task to stay alive). Returns base URL.
async fn spawn_server_with_repo(repo: Arc<PatRepository>, dir: tempfile::TempDir) -> String {
    let router = build_router(
        Arc::new(StubEnv),
        Some(Arc::new(NoopSink)),
        repo,
        CancellationToken::new(),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _keep_db_alive = dir;
        let _ = axum::serve(listener, router).await;
    });
    format!("http://{addr}")
}

fn init_body() -> String {
    serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": { "name": "test", "version": "1.0" }
        }
    })
    .to_string()
}

fn mcp_post(client: &reqwest::Client, base: &str) -> reqwest::RequestBuilder {
    client
        .post(format!("{base}/mcp"))
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .body(init_body())
}

/// Stateful mode answers over SSE — extract the first `data:` line that
/// carries a JSON payload (priming events have empty data).
fn parse_sse_data(body: &str) -> serde_json::Value {
    body.lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .find_map(|data| serde_json::from_str(data.trim()).ok())
        .unwrap_or_else(|| panic!("no SSE JSON data line in response: {body}"))
}

#[tokio::test]
async fn health_is_public() {
    let (base, _token) = spawn_server().await;
    let response = reqwest::get(format!("{base}/health")).await.unwrap();
    assert_eq!(response.status(), 200);
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body["status"], "ok");
    assert_eq!(body["server"], "wealthfolio-mcp");
    assert!(body["version"].is_string());
}

#[tokio::test]
async fn mcp_without_bearer_is_unauthorized() {
    let (base, _token) = spawn_server().await;
    let client = reqwest::Client::new();
    let response = mcp_post(&client, &base).send().await.unwrap();
    assert_eq!(response.status(), 401);
}

#[tokio::test]
async fn mcp_with_wrong_bearer_is_unauthorized() {
    let (base, _token) = spawn_server().await;
    let client = reqwest::Client::new();
    let response = mcp_post(&client, &base)
        .header("Authorization", "Bearer wfp_wrong")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401);
}

#[tokio::test]
async fn mcp_with_disallowed_origin_is_forbidden() {
    let (base, token) = spawn_server().await;
    let client = reqwest::Client::new();
    let response = mcp_post(&client, &base)
        .header("Authorization", format!("Bearer {token}"))
        .header("Origin", "https://evil.example")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 403);
}

#[tokio::test]
async fn mcp_initialize_roundtrip_succeeds() {
    let (base, token) = spawn_server().await;
    let client = reqwest::Client::new();
    let response = mcp_post(&client, &base)
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert!(
        response.headers().contains_key("mcp-session-id"),
        "stateful mode should assign a session id"
    );

    let body = response.text().await.unwrap();
    let parsed = parse_sse_data(&body);
    assert_eq!(parsed["jsonrpc"], "2.0");
    assert_eq!(parsed["id"], 1);
    assert_eq!(parsed["result"]["serverInfo"]["name"], "wealthfolio");
}

#[tokio::test]
async fn mcp_with_unknown_pat_is_unauthorized() {
    let (base, _token) = spawn_server().await;
    let client = reqwest::Client::new();
    // A well-formed `wfp_` token that was never minted -> 401.
    let response = mcp_post(&client, &base)
        .header(
            "Authorization",
            "Bearer wfp_notavalidtoken_notavalidtoken_notavalid",
        )
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401);
}

/// A PAT scoped to only `accounts:read` authenticates and is granted
/// exactly that scope: `tools/list` exposes `get_accounts` but hides
/// tools requiring other scopes (e.g. `get_holdings`).
#[tokio::test]
async fn mcp_scoped_pat_grants_only_its_scopes() {
    let (repo, dir) = pat_repo();

    let token = wealthfolio_mcp::pat::generate_token();
    let prefix = wealthfolio_mcp::pat::token_prefix(&token)
        .unwrap()
        .to_string();
    repo.create(NewPersonalAccessToken {
        name: "accounts-only".to_string(),
        token_prefix: prefix,
        token_hash: wealthfolio_mcp::pat::hash_token(&token),
        scopes_json: serde_json::json!(["accounts:read"]).to_string(),
        expires_at: None,
    })
    .await
    .unwrap();

    let base = spawn_server_with_repo(repo, dir).await;
    let client = reqwest::Client::new();

    // Handshake with the PAT succeeds.
    let init = mcp_post(&client, &base)
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .unwrap();
    assert_eq!(init.status(), 200);
    let session = init
        .headers()
        .get("mcp-session-id")
        .expect("stateful mode should assign a session id")
        .to_str()
        .unwrap()
        .to_string();

    // tools/list reflects exactly the granted scope.
    let response = client
        .post(format!("{base}/mcp"))
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .header("Authorization", format!("Bearer {token}"))
        .header("mcp-session-id", session)
        .body(serde_json::json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }).to_string())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let list = parse_sse_data(&response.text().await.unwrap());
    let names: Vec<&str> = list["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    assert!(
        names.contains(&"get_accounts"),
        "accounts:read should expose get_accounts: {names:?}"
    );
    assert!(
        !names.contains(&"get_holdings"),
        "accounts:read must NOT expose holdings tools: {names:?}"
    );
}

#[tokio::test]
async fn mcp_with_null_origin_passes() {
    let (base, token) = spawn_server().await;
    let client = reqwest::Client::new();
    let response = mcp_post(&client, &base)
        .header("Authorization", format!("Bearer {token}"))
        .header("Origin", "null")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);

    let body = response.text().await.unwrap();
    let parsed = parse_sse_data(&body);
    assert_eq!(parsed["result"]["serverInfo"]["name"], "wealthfolio");
}
