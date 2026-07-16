//! End-to-end Streamable HTTP round-trip against the real rmcp transport.
//!
//! Proves the load-bearing assumptions of the MCP integration:
//! - `StreamableHttpService` mounts in an axum `Router` via `nest_service`.
//! - Host middleware extensions (`McpAuthContext`) reach the handler
//!   through the forwarded `http::request::Parts` (regression guard for
//!   rmcp upgrades — this propagation is what all auth rests on).
//! - Scope filtering hides tools from `tools/list` and denies `tools/call`.
//! - Missing auth context fails closed.
//! - Audit entries are recorded with the right outcomes.

use std::sync::Arc;

use axum::body::Body;
use axum::http::Request;
use axum::middleware::{self, Next};
use axum::response::Response;
use rmcp::transport::streamable_http_server::StreamableHttpServerConfig;
use tokio::sync::Mutex;
use wealthfolio_agent_tools::{
    AgentEnvironment, AgentScope, AgentScopeSet, AgentTool, AgentToolAccess, AgentToolError,
    AgentToolResult,
};
use wealthfolio_mcp::{
    ActorKind, AuditOutcome, AuditSink, McpAuditEntry, McpAuthContext, McpServerBuilder,
};

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

/// Visible/callable with AccountsRead.
struct EchoTool;

#[async_trait::async_trait]
impl AgentTool for EchoTool {
    fn name(&self) -> &'static str {
        "echo"
    }
    fn description(&self) -> &'static str {
        "Echoes arguments."
    }
    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({ "type": "object", "properties": {} })
    }
    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::AccountsRead]
    }
    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Read
    }
    async fn call(
        &self,
        _env: Arc<dyn AgentEnvironment>,
        args: serde_json::Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        Ok(AgentToolResult {
            content: serde_json::json!({ "echo": args }),
        })
    }
}

/// Requires a scope the test caller is NOT granted.
struct HiddenTool;

#[async_trait::async_trait]
impl AgentTool for HiddenTool {
    fn name(&self) -> &'static str {
        "hidden"
    }
    fn description(&self) -> &'static str {
        "Requires portfolio:read."
    }
    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({ "type": "object", "properties": {} })
    }
    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::HoldingsRead]
    }
    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Read
    }
    async fn call(
        &self,
        _env: Arc<dyn AgentEnvironment>,
        _args: serde_json::Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        Ok(AgentToolResult {
            content: serde_json::json!({}),
        })
    }
}

#[derive(Default)]
struct CapturingSink {
    entries: Mutex<Vec<McpAuditEntry>>,
}

#[async_trait::async_trait]
impl AuditSink for CapturingSink {
    async fn record(&self, entry: McpAuditEntry) {
        self.entries.lock().await.push(entry);
    }
}

async fn inject_auth(mut req: Request<Body>, next: Next) -> Response {
    req.extensions_mut().insert(McpAuthContext {
        actor_kind: ActorKind::Pat,
        actor_fingerprint: "sha256:test".to_string(),
        granted_scopes: AgentScopeSet::from_strs(["accounts:read"]),
    });
    next.run(req).await
}

async fn spawn_server(with_auth: bool, sink: Arc<CapturingSink>) -> String {
    let service = McpServerBuilder::new(Arc::new(StubEnv))
        .tools(vec![Arc::new(EchoTool), Arc::new(HiddenTool)])
        .audit(sink)
        .build_http_service(
            StreamableHttpServerConfig::default()
                .with_stateful_mode(false)
                .with_json_response(true)
                .with_sse_keep_alive(None),
        );

    let mut router = axum::Router::new().nest_service("/mcp", service);
    if with_auth {
        router = router.layer(middleware::from_fn(inject_auth));
    }

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    format!("http://{addr}/mcp")
}

async fn rpc(client: &reqwest::Client, url: &str, body: serde_json::Value) -> serde_json::Value {
    let response = client
        .post(url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .body(body.to_string())
        .send()
        .await
        .unwrap();
    let text = response.text().await.unwrap();
    serde_json::from_str(&text).unwrap_or_else(|_| panic!("non-JSON response: {text}"))
}

fn init_body() -> serde_json::Value {
    serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": { "name": "test", "version": "1.0" }
        }
    })
}

#[tokio::test]
async fn full_roundtrip_with_scope_filtering_and_audit() {
    let sink = Arc::new(CapturingSink::default());
    let url = spawn_server(true, sink.clone()).await;
    let client = reqwest::Client::new();

    // initialize
    let init = rpc(&client, &url, init_body()).await;
    assert_eq!(init["result"]["serverInfo"]["name"], "wealthfolio");

    // tools/list — only the AccountsRead tool is visible
    let list = rpc(
        &client,
        &url,
        serde_json::json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
    )
    .await;
    let tools = list["result"]["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 1, "scope filtering failed: {tools:?}");
    assert_eq!(tools[0]["name"], "echo");

    // tools/call success with structured content
    let call = rpc(
        &client,
        &url,
        serde_json::json!({
            "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": { "name": "echo", "arguments": { "a": 1 } }
        }),
    )
    .await;
    assert_eq!(
        call["result"]["structuredContent"],
        serde_json::json!({ "echo": { "a": 1 } })
    );
    assert_ne!(call["result"]["isError"], serde_json::json!(true));

    // tools/call on a scope-denied tool returns a tool error, not success
    let denied = rpc(
        &client,
        &url,
        serde_json::json!({
            "jsonrpc": "2.0", "id": 4, "method": "tools/call",
            "params": { "name": "hidden", "arguments": {} }
        }),
    )
    .await;
    assert_eq!(denied["result"]["isError"], true);

    // tools/call with an unknown name is rejected — and still audited, so
    // name-probing leaves a trace.
    let unknown = rpc(
        &client,
        &url,
        serde_json::json!({
            "jsonrpc": "2.0", "id": 5, "method": "tools/call",
            "params": { "name": "no_such_tool", "arguments": {} }
        }),
    )
    .await;
    assert!(
        unknown["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains("unknown tool"),
        "expected unknown-tool error, got: {unknown}"
    );

    // audit entries: success for echo, denied for hidden, error for the
    // unknown tool. The handler awaits the audit write before responding, so
    // the rows are present by now; the short poll just tolerates sink latency.
    let mut tries = 0;
    loop {
        let entries = sink.entries.lock().await;
        if entries.len() >= 3 {
            assert!(entries
                .iter()
                .any(|e| e.tool == "echo" && e.outcome == AuditOutcome::Success));
            assert!(entries
                .iter()
                .any(|e| e.tool == "hidden" && e.outcome == AuditOutcome::Denied));
            let unknown_entry = entries
                .iter()
                .find(|e| e.tool == "no_such_tool")
                .expect("unknown-tool call must be audited");
            assert_eq!(unknown_entry.outcome, AuditOutcome::Error);
            assert_eq!(unknown_entry.args_summary, serde_json::Value::Null);
            assert!(unknown_entry
                .error_message
                .as_deref()
                .unwrap_or_default()
                .contains("unknown tool"));
            assert!(entries.iter().all(|e| e.actor_fingerprint == "sha256:test"));
            break;
        }
        drop(entries);
        tries += 1;
        assert!(tries < 100, "audit entries never arrived");
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn missing_auth_context_fails_closed() {
    let sink = Arc::new(CapturingSink::default());
    let url = spawn_server(false, sink).await;
    let client = reqwest::Client::new();

    let list = rpc(
        &client,
        &url,
        serde_json::json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }),
    )
    .await;
    assert!(
        list["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains("missing authentication context"),
        "expected fail-closed error, got: {list}"
    );
}
