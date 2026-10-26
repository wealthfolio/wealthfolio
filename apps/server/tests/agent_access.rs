//! Integration tests for the `/mcp` endpoint (PAT auth) and the
//! agent-access management API.
//!
//! These boot the real router on a loopback port (the MCP transport
//! answers over SSE, so `oneshot` is not enough) with auth enabled.
#![allow(clippy::unwrap_used, clippy::panic, reason = "test code")]

use std::net::SocketAddr;

use argon2::{password_hash::SaltString, Argon2, PasswordHasher};
use axum::{
    body::{to_bytes, Body},
    extract::ConnectInfo,
    http::Request,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use rand::{rngs::OsRng, RngCore};
use reqwest::header;
use tempfile::TempDir;
use tower::ServiceExt;
use wealthfolio_server::{api::app_router_from_config, config::Config};

const PASSWORD: &str = "super-secret";

/// The canonical read-only scope set, used when minting test tokens.
const READ_ONLY_SCOPES: &[&str] = &[
    "accounts:read",
    "holdings:read",
    "performance:read",
    "activities:read",
    "financial-planning:read",
    "health:read",
    "classification:read",
    "spending:read",
];

/// Env vars are process-global; serialize config/state construction
/// (build_state itself mutates DATABASE_URL / WF_SECRET_FILE).
static ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct TestServer {
    base: String,
    client: reqwest::Client,
    /// Keeps the database directory alive for the server's lifetime.
    _tmp: TempDir,
}

async fn build_test_router(mcp_enabled: bool, audit_enabled: bool) -> (axum::Router, TempDir) {
    let tmp = tempfile::tempdir().unwrap();
    let router = {
        let _guard = ENV_LOCK.lock().await;
        std::env::set_var("WF_DATA_DIR", "");
        std::env::set_var("WF_DB_PATH", tmp.path().join("test.db"));
        std::env::set_var("WF_SECRET_FILE", tmp.path().join("secrets.json"));
        let salt = SaltString::generate(&mut OsRng);
        let password_hash = Argon2::default()
            .hash_password(PASSWORD.as_bytes(), &salt)
            .unwrap()
            .to_string();
        std::env::set_var("WF_AUTH_PASSWORD_HASH", password_hash);
        let mut secret_bytes = [0u8; 32];
        OsRng.fill_bytes(&mut secret_bytes);
        std::env::set_var("WF_SECRET_KEY", BASE64.encode(secret_bytes));
        std::env::set_var("WF_CORS_ALLOW_ORIGINS", "http://localhost:3000");
        if mcp_enabled {
            std::env::set_var("WF_MCP_ENABLED", "true");
        } else {
            std::env::remove_var("WF_MCP_ENABLED");
        }
        if audit_enabled {
            std::env::remove_var("WF_MCP_AUDIT_ENABLED");
        } else {
            std::env::set_var("WF_MCP_AUDIT_ENABLED", "false");
        }

        let config = Config::from_env().unwrap();
        app_router_from_config(&config).await.unwrap()
    };

    (router, tmp)
}

async fn spawn_server(mcp_enabled: bool, audit_enabled: bool) -> TestServer {
    let (router, tmp) = build_test_router(mcp_enabled, audit_enabled).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await;
    });

    TestServer {
        base: format!("http://{addr}"),
        client: reqwest::Client::new(),
        _tmp: tmp,
    }
}

/// Logs in and returns the `wf_session` cookie value (the JWT).
async fn login(server: &TestServer) -> String {
    let response = server
        .client
        .post(format!("{}/api/v1/auth/login", server.base))
        .json(&serde_json::json!({ "password": PASSWORD }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let set_cookie = response
        .headers()
        .get(header::SET_COOKIE)
        .expect("login should set a cookie")
        .to_str()
        .unwrap();
    set_cookie
        .split(';')
        .next()
        .unwrap()
        .trim_start_matches("wf_session=")
        .to_string()
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

/// POSTs a JSON-RPC message to `/mcp` with optional bearer + session id.
async fn mcp_post(
    server: &TestServer,
    bearer: Option<&str>,
    session: Option<&str>,
    body: serde_json::Value,
) -> reqwest::Response {
    let mut request = server
        .client
        .post(format!("{}/mcp", server.base))
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .body(body.to_string());
    if let Some(token) = bearer {
        request = request.header("Authorization", format!("Bearer {token}"));
    }
    if let Some(session) = session {
        request = request.header("mcp-session-id", session);
    }
    request.send().await.unwrap()
}

/// Stateful mode answers over SSE — extract the first `data:` line that
/// carries a JSON payload (priming events have empty data).
fn parse_sse_data(body: &str) -> serde_json::Value {
    body.lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .find_map(|data| serde_json::from_str(data.trim()).ok())
        .unwrap_or_else(|| panic!("no SSE JSON data line in response: {body}"))
}

/// Creates a PAT via the JWT-protected REST API; returns the response JSON.
async fn create_pat(
    server: &TestServer,
    cookie: &str,
    body: serde_json::Value,
) -> (reqwest::StatusCode, serde_json::Value) {
    let response = server
        .client
        .post(format!("{}/api/v1/agent-access/tokens", server.base))
        .header(header::COOKIE, format!("wf_session={cookie}"))
        .json(&body)
        .send()
        .await
        .unwrap();
    let status = response.status();
    let json = response.json().await.unwrap();
    (status, json)
}

/// Runs the MCP initialize handshake; returns the session id.
async fn mcp_initialize(server: &TestServer, pat: &str) -> String {
    let response = mcp_post(server, Some(pat), None, init_body()).await;
    assert_eq!(response.status(), 200);
    let session = response
        .headers()
        .get("mcp-session-id")
        .expect("stateful mode should assign a session id")
        .to_str()
        .unwrap()
        .to_string();
    let init = parse_sse_data(&response.text().await.unwrap());
    assert_eq!(init["result"]["serverInfo"]["name"], "wealthfolio");

    // The spec-mandated initialized notification (202 Accepted).
    let notify = mcp_post(
        server,
        Some(pat),
        Some(&session),
        serde_json::json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
    )
    .await;
    assert_eq!(notify.status(), 202);
    session
}

#[tokio::test]
async fn mcp_pat_lifecycle() {
    let server = spawn_server(true, true).await;

    // (a) No PAT -> 401 with a JSON-RPC-shaped body.
    let response = mcp_post(&server, None, None, init_body()).await;
    assert_eq!(response.status(), 401);
    let body: serde_json::Value = response.json().await.unwrap();
    assert!(body["error"]["message"].is_string());

    // (b) Garbage PAT -> 401.
    let response = mcp_post(
        &server,
        Some("wfp_notavalidtoken_notavalidtoken_notavalid"),
        None,
        init_body(),
    )
    .await;
    assert_eq!(response.status(), 401);

    // (c) A JWT does not work on /mcp.
    let cookie = login(&server).await;
    let response = mcp_post(&server, Some(&cookie), None, init_body()).await;
    assert_eq!(response.status(), 401);

    // (d) Create a PAT via REST, then run the MCP handshake with it.
    let (status, created) = create_pat(
        &server,
        &cookie,
        serde_json::json!({ "name": "  ci token  ", "scopes": READ_ONLY_SCOPES }),
    )
    .await;
    assert_eq!(status, 201);
    let pat = created["token"].as_str().unwrap().to_string();
    assert!(pat.starts_with("wfp_"));
    assert_eq!(pat.len(), 47, "wfp_ + 43 base64url chars");
    assert_eq!(created["name"], "ci token");
    assert_eq!(created["tokenPrefix"].as_str().unwrap().len(), 12);
    assert!(pat[4..].starts_with(created["tokenPrefix"].as_str().unwrap()));
    assert_eq!(created["scopes"].as_array().unwrap().len(), 8);
    let token_id = created["id"].as_str().unwrap().to_string();

    // Empty name is rejected.
    let (status, _) = create_pat(
        &server,
        &cookie,
        serde_json::json!({ "name": "   ", "scopes": READ_ONLY_SCOPES }),
    )
    .await;
    assert_eq!(status, 400);

    // Empty scopes are rejected.
    let (status, _) = create_pat(
        &server,
        &cookie,
        serde_json::json!({ "name": "no scopes", "scopes": [] }),
    )
    .await;
    assert_eq!(status, 400);

    // Unknown scopes are rejected.
    let (status, _) = create_pat(
        &server,
        &cookie,
        serde_json::json!({ "name": "bad scope", "scopes": ["accounts:read", "bogus:scope"] }),
    )
    .await;
    assert_eq!(status, 400);

    // activities:write without activities:draft is rejected (dependency).
    let (status, _) = create_pat(
        &server,
        &cookie,
        serde_json::json!({ "name": "write only", "scopes": ["activities:write"] }),
    )
    .await;
    assert_eq!(status, 400);

    // classification:write without classification:suggest is rejected (dependency).
    let (status, _) = create_pat(
        &server,
        &cookie,
        serde_json::json!({ "name": "classification write only", "scopes": ["classification:write"] }),
    )
    .await;
    assert_eq!(status, 400);

    // market-data:write without holdings:read is rejected (dependency).
    let (status, _) = create_pat(
        &server,
        &cookie,
        serde_json::json!({ "name": "quote write only", "scopes": ["market-data:write"] }),
    )
    .await;
    assert_eq!(status, 400);

    let session = mcp_initialize(&server, &pat).await;

    // tools/list -> the read-only catalog: 16 read tools + get_import_mapping
    // and find_transfer_matches (also activities:read) + list_categorization_rules
    // (spending:read), plus the two Spending proposal tools = 21.
    let response = mcp_post(
        &server,
        Some(&pat),
        Some(&session),
        serde_json::json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
    )
    .await;
    assert_eq!(response.status(), 200);
    let list = parse_sse_data(&response.text().await.unwrap());
    let tools = list["result"]["tools"].as_array().unwrap();
    let names: Vec<&str> = tools
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        tools.len(),
        41,
        "read-only catalog must expose 41 tools (including Spending reads and proposals): {names:?}"
    );

    // (h) tools/call succeeds and writes an audit row (awaited before the
    // response returns; the poll just tolerates sink latency).
    let response = mcp_post(
        &server,
        Some(&pat),
        Some(&session),
        serde_json::json!({
            "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": { "name": "get_accounts", "arguments": {} }
        }),
    )
    .await;
    assert_eq!(response.status(), 200);
    let call = parse_sse_data(&response.text().await.unwrap());
    assert_ne!(call["result"]["isError"], serde_json::json!(true));

    let mut audit: Option<serde_json::Value> = None;
    for _ in 0..100 {
        let page: serde_json::Value = server
            .client
            .get(format!("{}/api/v1/agent-access/audit", server.base))
            .header(header::COOKIE, format!("wf_session={cookie}"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        if page["totalCount"].as_i64().unwrap_or(0) >= 1 {
            audit = Some(page);
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    let audit = audit.expect("audit row for tools/call never arrived");
    let item = &audit["items"][0];
    assert_eq!(item["tool"], "get_accounts");
    assert_eq!(item["actorKind"], "pat");
    assert_eq!(item["outcome"], "success");
    assert!(item["actorFingerprint"]
        .as_str()
        .unwrap()
        .starts_with("sha256:"));

    // (e) A PAT is not a JWT: protected /api/v1 routes reject it.
    let response = server
        .client
        .get(format!("{}/api/v1/accounts", server.base))
        .header("Authorization", format!("Bearer {pat}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401);

    // Token listing exposes metadata but never the hash or the token.
    let tokens: serde_json::Value = server
        .client
        .get(format!("{}/api/v1/agent-access/tokens", server.base))
        .header(header::COOKIE, format!("wf_session={cookie}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let listed = tokens
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == token_id.as_str())
        .expect("created token should be listed");
    assert!(listed.get("tokenHash").is_none());
    assert!(listed.get("token").is_none());
    assert_eq!(listed["tokenPrefix"], created["tokenPrefix"]);

    // Status endpoint reflects the enabled MCP endpoint.
    let status_json: serde_json::Value = server
        .client
        .get(format!("{}/api/v1/agent-access/status", server.base))
        .header(header::COOKIE, format!("wf_session={cookie}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(status_json["mcpEnabled"], true);
    assert_eq!(status_json["auditEnabled"], true);
    assert_eq!(status_json["endpoint"], "/mcp");

    // (f) Remove -> subsequent /mcp calls fail; unknown id -> 404.
    let response = server
        .client
        .delete(format!(
            "{}/api/v1/agent-access/tokens/{token_id}",
            server.base
        ))
        .header(header::COOKIE, format!("wf_session={cookie}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 204);
    let response = mcp_post(&server, Some(&pat), None, init_body()).await;
    assert_eq!(response.status(), 401);
    let response = server
        .client
        .delete(format!(
            "{}/api/v1/agent-access/tokens/no-such-token",
            server.base
        ))
        .header(header::COOKIE, format!("wf_session={cookie}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 404);

    // (g) Expired PAT -> 401.
    let (status, expired) = create_pat(
        &server,
        &cookie,
        serde_json::json!({ "name": "expired", "expiresAt": "2000-01-01T00:00:00Z", "scopes": READ_ONLY_SCOPES }),
    )
    .await;
    assert_eq!(status, 201);
    let expired_pat = expired["token"].as_str().unwrap();
    let response = mcp_post(&server, Some(expired_pat), None, init_body()).await;
    assert_eq!(response.status(), 401);

    // Audit purge clears the log.
    let purge: serde_json::Value = server
        .client
        .post(format!("{}/api/v1/agent-access/audit/purge", server.base))
        .header(header::COOKIE, format!("wf_session={cookie}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(purge["purged"].as_u64().unwrap() >= 1);
}

/// A write/suggest-scoped token sees the draft, suggest, commit, AND import
/// tools via `tools/list` — proving scope-gated visibility extends past the
/// read-only catalog. (Read-only tokens see 19; the full catalog includes the
/// previous 36 tools plus three category-management tools = 39.)
#[tokio::test]
async fn mcp_write_scoped_token_sees_write_tools() {
    let server = spawn_server(true, false).await;
    let cookie = login(&server).await;

    let full_scopes: Vec<&str> = READ_ONLY_SCOPES
        .iter()
        .copied()
        .chain([
            "activities:draft",
            "activities:write",
            "classification:suggest",
            "classification:write",
            "spending:write",
            "budget:write",
            "market-data:write",
        ])
        .collect();
    let (status, created) = create_pat(
        &server,
        &cookie,
        serde_json::json!({ "name": "writer", "scopes": full_scopes }),
    )
    .await;
    assert_eq!(status, 201);
    assert_eq!(created["scopes"].as_array().unwrap().len(), 15);
    let pat = created["token"].as_str().unwrap().to_string();

    let session = mcp_initialize(&server, &pat).await;
    let response = mcp_post(
        &server,
        Some(&pat),
        Some(&session),
        serde_json::json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
    )
    .await;
    assert_eq!(response.status(), 200);
    let list = parse_sse_data(&response.text().await.unwrap());
    let tools = list["result"]["tools"].as_array().unwrap();
    let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert_eq!(
        tools.len(),
        67,
        "full-scope token must see all 67 tools: {names:?}"
    );
    for name in [
        "list_categorization_rules",
        "rerun_categorization_rules",
        "find_transfer_matches",
        "link_transfer_activities",
        "unlink_transfer_activities",
        "prepare_quote_import",
        "commit_quote_import",
        "prepare_activity_updates",
        "commit_activity_updates",
    ] {
        assert!(names.contains(&name), "{name} visible");
    }
    assert!(
        names.contains(&"commit_activity_import"),
        "import tool visible"
    );
    assert!(names.contains(&"record_activity"), "draft tool visible");
    assert!(
        names.contains(&"commit_categorization_rule"),
        "categorization rule commit tool visible"
    );
    assert!(names.contains(&"commit_transaction_categories"));
    assert!(
        names.contains(&"prepare_asset_classification"),
        "suggest tool visible"
    );
    assert!(
        names.contains(&"commit_activity_draft"),
        "commit tool visible"
    );
    assert!(
        names.contains(&"commit_activity_drafts"),
        "batch commit tool visible"
    );
    assert!(
        names.contains(&"commit_asset_classification_draft"),
        "classification commit tool visible"
    );
}

/// Exercise the actual MCP tools, shared resolver, writer and SQLite storage.
/// Manual quotes keep this deterministic and independent of market providers.
#[tokio::test]
async fn mcp_import_reuses_reviewed_crypto_assets_despite_equity_collisions() {
    let server = spawn_server(true, false).await;
    let cookie = login(&server).await;
    let account = api_post(
        &server,
        &cookie,
        "accounts",
        serde_json::json!({
            "name": "Synthetic crypto account", "accountType": "CRYPTOCURRENCY",
            "currency": "EUR", "isDefault": false, "isActive": true,
            "trackingMode": "TRANSACTIONS"
        }),
    )
    .await;
    let mut crypto_ids = Vec::new();
    for symbol in ["BNB", "PEPE"] {
        for kind in ["EQUITY", "CRYPTO"] {
            let asset = api_post(
                &server,
                &cookie,
                "assets",
                serde_json::json!({
                    "kind": "INVESTMENT", "name": format!("Synthetic {kind} {symbol}"),
                    "instrumentSymbol": symbol, "instrumentType": kind,
                    "instrumentExchangeMic": if kind == "EQUITY" { Some("XETR") } else { None },
                    "quoteCcy": "EUR", "quoteMode": "MANUAL"
                }),
            )
            .await;
            if kind == "CRYPTO" {
                crypto_ids.push(asset["id"].clone());
            }
        }
    }
    let (status, token) = create_pat(&server, &cookie, serde_json::json!({
        "name": "import regression", "scopes": ["activities:read", "activities:draft", "activities:write"]
    })).await;
    assert_eq!(status, 201);
    let pat = token["token"].as_str().unwrap();
    let session = mcp_initialize(&server, pat).await;
    let mut activities = serde_json::json!([
        { "date": "2024-06-01", "activityType": "BUY", "currency": "EUR",
          "symbol": "crypto:BNB-EUR", "quantity": 0.5, "unitPrice": 500, "amount": 250 },
        { "date": "2024-06-02", "activityType": "BUY", "currency": "EUR",
          "symbol": "PEPE", "instrumentType": "crypto", "quantity": 10, "unitPrice": 1, "amount": 10 },
        { "date": "2024-06-03", "activityType": "BUY", "currency": "EUR",
          "assetId": crypto_ids[0], "quantity": 1, "unitPrice": 500, "amount": 500 }
    ]);
    for row in activities.as_array_mut().unwrap() {
        row["accountId"] = account["id"].clone();
    }
    let preview = mcp_call_tool(
        &server,
        pat,
        &session,
        "prepare_activity_import",
        serde_json::json!({ "activities": activities.clone() }),
    )
    .await;
    assert_eq!(preview["summary"]["valid"], 3, "{preview}");
    let expected_ids = [&crypto_ids[0], &crypto_ids[1], &crypto_ids[0]];
    for ((input, reviewed), expected_id) in activities
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .zip(preview["rows"].as_array().unwrap())
        .zip(expected_ids)
    {
        assert_eq!(&reviewed["assetId"], expected_id, "{reviewed}");
        assert_eq!(reviewed["instrumentType"], "CRYPTO");
        assert!(!reviewed["symbol"].as_str().unwrap().contains(':'));
        input
            .as_object_mut()
            .unwrap()
            .extend(reviewed.as_object().unwrap().clone());
    }
    let committed = mcp_call_tool(
        &server,
        pat,
        &session,
        "commit_activity_import",
        serde_json::json!({ "activities": activities }),
    )
    .await;
    assert_eq!(committed["summary"]["imported"], 3, "{committed}");
    assert_eq!(committed["summary"]["assetsCreated"], 0, "{committed}");

    let stored = api_post(
        &server,
        &cookie,
        "activities/search",
        serde_json::json!({
            "page": 0, "pageSize": 10, "accountIdFilter": account["id"]
        }),
    )
    .await;
    let rows = stored["data"].as_array().unwrap();
    assert_eq!(rows.len(), 3, "{stored}");
    assert_eq!(
        rows.iter()
            .filter(|r| r["assetId"] == crypto_ids[0])
            .count(),
        2
    );
    assert_eq!(
        rows.iter()
            .filter(|r| r["assetId"] == crypto_ids[1])
            .count(),
        1
    );
    assert!(rows.iter().all(|r| r["instrumentType"] == "CRYPTO"));
    let assets: Vec<serde_json::Value> = server
        .client
        .get(format!("{}/api/v1/assets", server.base))
        .header(header::COOKIE, format!("wf_session={cookie}"))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        assets.iter().filter(|a| a["kind"] == "INVESTMENT").count(),
        4
    );
}

/// POSTs JSON to the cookie-authenticated REST API and returns the body.
async fn api_post(
    server: &TestServer,
    cookie: &str,
    path: &str,
    body: serde_json::Value,
) -> serde_json::Value {
    let response = server
        .client
        .post(format!("{}/api/v1/{path}", server.base))
        .header(header::COOKIE, format!("wf_session={cookie}"))
        .json(&body)
        .send()
        .await
        .unwrap();
    let status = response.status();
    let value: serde_json::Value = response.json().await.unwrap();
    assert!(status.is_success(), "{path}: {status} {value}");
    value
}

/// PUTs JSON to the cookie-authenticated REST API and returns the body.
async fn api_put(
    server: &TestServer,
    cookie: &str,
    path: &str,
    body: serde_json::Value,
) -> serde_json::Value {
    let response = server
        .client
        .put(format!("{}/api/v1/{path}", server.base))
        .header(header::COOKIE, format!("wf_session={cookie}"))
        .json(&body)
        .send()
        .await
        .unwrap();
    let status = response.status();
    let value: serde_json::Value = response.json().await.unwrap();
    assert!(status.is_success(), "{path}: {status} {value}");
    value
}

/// Calls an MCP tool and returns its structured result, failing on tool errors.
async fn mcp_call_tool(
    server: &TestServer,
    pat: &str,
    session: &str,
    name: &str,
    arguments: serde_json::Value,
) -> serde_json::Value {
    let response = mcp_post(
        server,
        Some(pat),
        Some(session),
        serde_json::json!({
            "jsonrpc": "2.0", "id": name, "method": "tools/call",
            "params": { "name": name, "arguments": arguments }
        }),
    )
    .await;
    assert_eq!(response.status(), 200);
    let result = parse_sse_data(&response.text().await.unwrap());
    assert!(result.get("error").is_none(), "{result}");
    assert_ne!(result["result"]["isError"], true, "{name}: {result}");
    result["result"]["structuredContent"].clone()
}

/// Mints a read/draft/write activity token and opens an MCP session.
async fn activity_writer_session(server: &TestServer, cookie: &str) -> (String, String) {
    let (status, token) = create_pat(
        server,
        cookie,
        serde_json::json!({
            "name": "activity writer",
            "scopes": ["activities:read", "activities:draft", "activities:write"]
        }),
    )
    .await;
    assert_eq!(status, 201);
    let pat = token["token"].as_str().unwrap().to_string();
    let session = mcp_initialize(server, &pat).await;
    (pat, session)
}

async fn create_eur_account(server: &TestServer, cookie: &str, name: &str) -> serde_json::Value {
    api_post(
        server,
        cookie,
        "accounts",
        serde_json::json!({
            "name": name, "accountType": "SECURITIES", "currency": "EUR",
            "isDefault": false, "isActive": true, "trackingMode": "TRANSACTIONS"
        }),
    )
    .await
}

async fn stored_activities(
    server: &TestServer,
    cookie: &str,
    account: &serde_json::Value,
) -> Vec<serde_json::Value> {
    let stored = api_post(
        server,
        cookie,
        "activities/search",
        serde_json::json!({ "page": 0, "pageSize": 10, "accountIdFilter": account["id"] }),
    )
    .await;
    stored["data"].as_array().unwrap().clone()
}

/// Disables every market-data provider. Symbol search, quote-currency and
/// profile lookups all go through them, so the test makes no outbound requests.
async fn disable_market_data_providers(server: &TestServer, cookie: &str) {
    let providers: Vec<serde_json::Value> = server
        .client
        .get(format!("{}/api/v1/providers/settings", server.base))
        .header(header::COOKIE, format!("wf_session={cookie}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(!providers.is_empty());
    for provider in providers {
        let response = server
            .client
            .put(format!("{}/api/v1/providers/settings", server.base))
            .header(header::COOKIE, format!("wf_session={cookie}"))
            .json(&serde_json::json!({
                "providerId": provider["id"], "priority": provider["priority"], "enabled": false
            }))
            .send()
            .await
            .unwrap();
        assert!(response.status().is_success(), "{provider}");
    }
}

/// Regression guard for #1375 / #1602, fixed on main by ad574a2b5 (imports)
/// and 92df6b700 (draft commits): MCP writes for a security that is not stored
/// yet must create the asset and link the activity to it, not save an activity
/// with no asset while reporting success. Providers are disabled, so every
/// identity is resolved from the rows alone.
#[tokio::test]
async fn mcp_writes_link_activities_to_newly_created_assets() {
    let server = spawn_server(true, false).await;
    let cookie = login(&server).await;
    disable_market_data_providers(&server, &cookie).await;
    let (pat, session) = activity_writer_session(&server, &cookie).await;

    // Import: symbol-only rows, as an agent maps them from a statement.
    let crypto_account = api_post(
        &server,
        &cookie,
        "accounts",
        serde_json::json!({
            "name": "Import crypto", "accountType": "CRYPTOCURRENCY", "currency": "EUR",
            "isDefault": false, "isActive": true, "trackingMode": "TRANSACTIONS"
        }),
    )
    .await;
    let suffix_account = create_eur_account(&server, &cookie, "Import ticker").await;
    let securities_account = create_eur_account(&server, &cookie, "Import securities").await;
    for (account, row, symbol) in [
        // A ticker as in the reports, its suffix naming the venue.
        (
            &suffix_account,
            serde_json::json!({
                "symbol": "ZZSUF.PA", "instrumentType": "EQUITY", "quoteCcy": "EUR"
            }),
            "ZZSUF",
        ),
        (
            &crypto_account,
            serde_json::json!({
                "symbol": "ZZCOIN", "instrumentType": "CRYPTO", "quoteMode": "MANUAL"
            }),
            "ZZCOIN",
        ),
        (
            &securities_account,
            serde_json::json!({
                "symbol": "ZZIMPORT", "exchangeMic": "XPAR", "instrumentType": "EQUITY",
                "quoteCcy": "EUR", "quoteMode": "MANUAL"
            }),
            "ZZIMPORT",
        ),
    ] {
        let mut row = row;
        row.as_object_mut().unwrap().extend(
            serde_json::json!({
                "accountId": account["id"], "activityType": "BUY", "date": "2026-07-27",
                "currency": "EUR", "quantity": 2, "unitPrice": 10.0
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        let preview = mcp_call_tool(
            &server,
            &pat,
            &session,
            "prepare_activity_import",
            serde_json::json!({ "activities": [row.clone()] }),
        )
        .await;
        assert_eq!(preview["summary"]["valid"], 1, "{preview}");
        let committed = mcp_call_tool(
            &server,
            &pat,
            &session,
            "commit_activity_import",
            serde_json::json!({ "activities": [row] }),
        )
        .await;
        assert_eq!(committed["summary"]["imported"], 1, "{committed}");
        assert_eq!(committed["summary"]["assetsCreated"], 1, "{committed}");
        let imported = stored_activities(&server, &cookie, account).await;
        assert_eq!(imported.len(), 1);
        assert_eq!(imported[0]["assetSymbol"], symbol, "{imported:?}");
    }

    // Draft commit: the shape record_activity returns for a resolved security
    // that has no stored asset yet, including its non-UUID draft asset id.
    let account = create_eur_account(&server, &cookie, "Draft").await;
    let draft = serde_json::json!({
        "accountId": account["id"], "activityType": "BUY", "activityDate": "2026-08-28",
        "symbol": "ZZDRAFT", "assetId": "ZZDRAFT:XPAR", "assetName": "Synthetic ETF",
        "exchangeMic": "XPAR", "quoteCcy": "EUR", "instrumentType": "ETF",
        "currency": "EUR", "quantity": 3, "unitPrice": 18.9,
        "priceSource": "user", "pricingMode": "MARKET", "isCustomAsset": false
    });
    let created = mcp_call_tool(
        &server,
        &pat,
        &session,
        "commit_activity_draft",
        serde_json::json!({ "draft": draft }),
    )
    .await;
    let drafted = stored_activities(&server, &cookie, &account).await;
    assert_eq!(drafted.len(), 1);
    assert_eq!(drafted[0]["assetSymbol"], "ZZDRAFT", "{drafted:?}");
    assert_eq!(created["created"]["assetId"], drafted[0]["assetId"]);
}

/// When validation rejects a row, commit_activity_import must not import it
/// (nor the rest of the batch) and report success. An unknown ticker that
/// carries a quoteCcy passes the importer's lighter checks, so it used to be
/// imported, create an asset, and be listed as failed at once. With providers
/// disabled the ticker cannot be found, as an unknown one would not be.
#[tokio::test]
async fn mcp_import_commits_nothing_when_a_row_fails_validation() {
    let server = spawn_server(true, false).await;
    let cookie = login(&server).await;
    disable_market_data_providers(&server, &cookie).await;
    let (pat, session) = activity_writer_session(&server, &cookie).await;
    let account = create_eur_account(&server, &cookie, "Rejected").await;
    let rows = serde_json::json!([
        { "accountId": account["id"], "activityType": "BUY", "date": "2026-07-27",
          "symbol": "ZZQXNOPE", "quoteCcy": "EUR", "currency": "EUR",
          "quantity": 1, "unitPrice": 10.0 },
        { "accountId": account["id"], "activityType": "DEPOSIT", "date": "2026-07-27",
          "currency": "EUR", "amount": 100.0 }
    ]);
    let preview = mcp_call_tool(
        &server,
        &pat,
        &session,
        "prepare_activity_import",
        serde_json::json!({ "activities": rows.clone() }),
    )
    .await;
    assert_eq!(preview["summary"]["invalid"], 1, "{preview}");

    let committed = mcp_call_tool(
        &server,
        &pat,
        &session,
        "commit_activity_import",
        serde_json::json!({ "activities": rows }),
    )
    .await;
    assert_eq!(committed["summary"]["success"], false, "{committed}");
    assert_eq!(committed["summary"]["total"], 2, "{committed}");
    assert_eq!(committed["summary"]["imported"], 0, "{committed}");
    assert_eq!(committed["summary"]["skipped"], 2, "{committed}");
    assert_eq!(committed["summary"]["assetsCreated"], 0, "{committed}");
    assert_eq!(
        committed["failed"].as_array().unwrap().len(),
        1,
        "{committed}"
    );
    assert_eq!(committed["failed"][0]["symbol"], "ZZQXNOPE", "{committed}");
    assert!(stored_activities(&server, &cookie, &account)
        .await
        .is_empty());
}

/// A row the check passes can still fail while being written: a split with a
/// zero ratio fails its account's batch. The importer skips those rows and
/// still reported success; the other accounts' rows are imported.
#[tokio::test]
async fn mcp_import_reports_rows_that_fail_while_being_written() {
    let server = spawn_server(true, false).await;
    let cookie = login(&server).await;
    disable_market_data_providers(&server, &cookie).await;
    let (pat, session) = activity_writer_session(&server, &cookie).await;
    let split_account = create_eur_account(&server, &cookie, "Split").await;
    let cash_account = create_eur_account(&server, &cookie, "Cash").await;
    let rows = serde_json::json!([
        { "accountId": split_account["id"], "activityType": "SPLIT", "date": "2026-07-27",
          "symbol": "ZZSPLIT", "exchangeMic": "XPAR", "instrumentType": "EQUITY",
          "quoteCcy": "EUR", "quoteMode": "MANUAL", "currency": "EUR", "amount": 0 },
        { "accountId": cash_account["id"], "activityType": "DEPOSIT", "date": "2026-07-27",
          "currency": "EUR", "amount": 100.0 }
    ]);
    let preview = mcp_call_tool(
        &server,
        &pat,
        &session,
        "prepare_activity_import",
        serde_json::json!({ "activities": rows.clone() }),
    )
    .await;
    assert_eq!(preview["summary"]["invalid"], 0, "{preview}");

    let committed = mcp_call_tool(
        &server,
        &pat,
        &session,
        "commit_activity_import",
        serde_json::json!({ "activities": rows }),
    )
    .await;
    assert_eq!(committed["summary"]["success"], false, "{committed}");
    assert_eq!(committed["summary"]["imported"], 1, "{committed}");
    assert_eq!(
        committed["failed"][0]["activityType"], "SPLIT",
        "{committed}"
    );
    assert_eq!(
        stored_activities(&server, &cookie, &cash_account)
            .await
            .len(),
        1
    );
}

/// #1698: an agent finds unlinked transfers with the candidates the Link
/// Transfer dialog suggests, links confirmed pairs (each on its own, so a bad
/// pair does not block the rest) and unlinks a pair linked by mistake.
#[tokio::test]
async fn mcp_finds_links_and_unlinks_transfers() {
    let server = spawn_server(true, false).await;
    let cookie = login(&server).await;
    disable_market_data_providers(&server, &cookie).await;
    let (pat, session) = activity_writer_session(&server, &cookie).await;
    let chequing = create_eur_account(&server, &cookie, "Chequing").await;
    let savings = create_eur_account(&server, &cookie, "Savings").await;
    let transfer = |account: &serde_json::Value, activity_type: &str, date: &str, amount: &str| {
        api_post(
            &server,
            &cookie,
            "activities",
            serde_json::json!({
                "accountId": account["id"], "activityType": activity_type,
                "activityDate": date, "currency": "EUR", "amount": amount
            }),
        )
    };
    let out_id =
        transfer(&chequing, "TRANSFER_OUT", "2026-04-01T12:00:00Z", "100").await["id"].clone();
    let in_id =
        transfer(&savings, "TRANSFER_IN", "2026-04-01T12:00:00Z", "100").await["id"].clone();
    let other_id =
        transfer(&savings, "TRANSFER_IN", "2026-04-02T12:00:00Z", "250").await["id"].clone();
    // A pending transfer stays out of the scan and cannot be linked.
    let pending = api_post(
        &server,
        &cookie,
        "activities",
        serde_json::json!({
            "accountId": chequing["id"], "activityType": "TRANSFER_OUT", "status": "PENDING",
            "activityDate": "2026-04-02T12:00:00Z", "currency": "EUR", "amount": "250"
        }),
    )
    .await;
    assert_eq!(pending["status"], "PENDING", "{pending}");

    let found = mcp_call_tool(
        &server,
        &pat,
        &session,
        "find_transfer_matches",
        serde_json::json!({}),
    )
    .await;
    assert_eq!(found["total"], 3, "{found}");
    let outgoing = found["transfers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|transfer| transfer["activity"]["id"] == out_id)
        .unwrap_or_else(|| panic!("{found}"));
    assert_eq!(outgoing["activity"]["accountName"], "Chequing");
    assert_eq!(outgoing["linkState"], "needs_counterpart", "{outgoing}");
    assert_eq!(
        outgoing["candidates"][0]["activity"]["id"], in_id,
        "{outgoing}"
    );
    assert_eq!(outgoing["candidates"][0]["confidence"], "high");
    assert_eq!(
        outgoing["candidates"].as_array().unwrap().len(),
        1,
        "{outgoing}"
    );

    // The second pair reuses the now-linked outgoing side and the third has a
    // pending side; each fails alone.
    let linked = mcp_call_tool(
        &server,
        &pat,
        &session,
        "link_transfer_activities",
        serde_json::json!({ "pairs": [
            { "activityAId": out_id, "activityBId": in_id },
            { "activityAId": other_id, "activityBId": out_id },
            { "activityAId": other_id, "activityBId": pending["id"] }
        ]}),
    )
    .await;
    assert_eq!(linked["linked"].as_array().unwrap().len(), 1, "{linked}");
    assert_eq!(linked["linked"][0]["transferOutId"], out_id);
    assert_eq!(linked["linked"][0]["transferInId"], in_id);
    assert_eq!(linked["errors"][0]["index"], 1, "{linked}");
    assert_eq!(linked["errors"][1]["index"], 2, "{linked}");
    assert!(
        linked["errors"][1]["message"]
            .as_str()
            .is_some_and(|message| message.contains("not posted")),
        "{linked}"
    );

    let lookup = mcp_call_tool(
        &server,
        &pat,
        &session,
        "find_transfer_matches",
        serde_json::json!({ "activityId": out_id }),
    )
    .await;
    assert_eq!(lookup["total"], 0, "{lookup}");
    assert_eq!(lookup["linkedTo"], in_id, "{lookup}");
    let remaining = mcp_call_tool(
        &server,
        &pat,
        &session,
        "find_transfer_matches",
        serde_json::json!({}),
    )
    .await;
    assert_eq!(remaining["total"], 1, "{remaining}");

    let unlinked = mcp_call_tool(
        &server,
        &pat,
        &session,
        "unlink_transfer_activities",
        serde_json::json!({ "pairs": [{ "activityAId": in_id, "activityBId": out_id }] }),
    )
    .await;
    assert_eq!(
        unlinked["unlinked"].as_array().unwrap().len(),
        1,
        "{unlinked}"
    );
    assert!(
        unlinked["errors"].as_array().unwrap().is_empty(),
        "{unlinked}"
    );
    let lookup = mcp_call_tool(
        &server,
        &pat,
        &session,
        "find_transfer_matches",
        serde_json::json!({ "activityId": out_id }),
    )
    .await;
    assert_eq!(lookup["total"], 1, "{lookup}");
    assert!(lookup.get("linkedTo").is_none(), "{lookup}");
    // Unlinking marks both sides as money from or to outside the portfolio.
    assert_eq!(lookup["transfers"][0]["linkState"], "external", "{lookup}");
}

/// A lookup names the other side of every linked pair the shared link state
/// sees: a pair with one leg later marked external, and a pair whose other
/// side's account was archived, which must not show up as needing a link,
/// in the scan or in the Health Center. Linking the first pair again repairs it.
#[tokio::test]
async fn mcp_transfer_lookups_see_every_linked_pair() {
    let server = spawn_server(true, false).await;
    let cookie = login(&server).await;
    disable_market_data_providers(&server, &cookie).await;
    let (pat, session) = activity_writer_session(&server, &cookie).await;
    let chequing = create_eur_account(&server, &cookie, "Chequing").await;
    let savings = create_eur_account(&server, &cookie, "Savings").await;
    let closed = create_eur_account(&server, &cookie, "Closed").await;
    let transfer = |account: &serde_json::Value, activity_type: &str, amount: &str| {
        api_post(
            &server,
            &cookie,
            "activities",
            serde_json::json!({
                "accountId": account["id"], "activityType": activity_type,
                "activityDate": "2026-04-01T12:00:00Z", "currency": "EUR", "amount": amount
            }),
        )
    };
    let out_id = transfer(&chequing, "TRANSFER_OUT", "100").await["id"].clone();
    let in_id = transfer(&savings, "TRANSFER_IN", "100").await["id"].clone();
    let kept_id = transfer(&chequing, "TRANSFER_OUT", "60").await["id"].clone();
    let archived_id = transfer(&closed, "TRANSFER_IN", "60").await["id"].clone();
    let linked = mcp_call_tool(
        &server,
        &pat,
        &session,
        "link_transfer_activities",
        serde_json::json!({ "pairs": [
            { "activityAId": out_id, "activityBId": in_id },
            { "activityAId": kept_id, "activityBId": archived_id }
        ]}),
    )
    .await;
    assert_eq!(linked["linked"].as_array().unwrap().len(), 2, "{linked}");

    // Mark one leg of the first pair as money from outside the portfolio.
    let response = server
        .client
        .put(format!("{}/api/v1/activities", server.base))
        .header(header::COOKIE, format!("wf_session={cookie}"))
        .json(&serde_json::json!({
            "id": in_id, "accountId": savings["id"], "activityType": "TRANSFER_IN",
            "activityDate": "2026-04-01T12:00:00Z", "currency": "EUR", "amount": "100",
            "metadata": "{\"flow\":{\"is_external\":true}}"
        }))
        .send()
        .await
        .unwrap();
    assert!(
        response.status().is_success(),
        "{}",
        response.text().await.unwrap()
    );
    // Archive the account holding the other side of the second pair.
    let response = server
        .client
        .put(format!(
            "{}/api/v1/accounts/{}",
            server.base,
            closed["id"].as_str().unwrap()
        ))
        .header(header::COOKIE, format!("wf_session={cookie}"))
        .json(&serde_json::json!({
            "id": closed["id"], "name": "Closed", "accountType": "SECURITIES",
            "isDefault": false, "isActive": true, "isArchived": true
        }))
        .send()
        .await
        .unwrap();
    let archived: serde_json::Value = response.json().await.unwrap();
    assert_eq!(archived["isArchived"], true, "{archived}");

    let lookup = |activity_id: serde_json::Value| {
        mcp_call_tool(
            &server,
            &pat,
            &session,
            "find_transfer_matches",
            serde_json::json!({ "activityId": activity_id }),
        )
    };
    for (activity_id, counterpart, state) in [
        (&out_id, &in_id, "linked"),
        (&in_id, &out_id, "linked_but_marked_external"),
        (&kept_id, &archived_id, "linked"),
    ] {
        let found = lookup(activity_id.clone()).await;
        assert_eq!(found["total"], 0, "{found}");
        assert_eq!(&found["linkedTo"], counterpart, "{found}");
        assert_eq!(found["linkedState"], state, "{found}");
    }
    let scan = mcp_call_tool(
        &server,
        &pat,
        &session,
        "find_transfer_matches",
        serde_json::json!({}),
    )
    .await;
    assert_eq!(scan["total"], 0, "{scan}");
    assert_eq!(transfer_issue_legs(&server, &cookie).await, 1);

    let relinked = mcp_call_tool(
        &server,
        &pat,
        &session,
        "link_transfer_activities",
        serde_json::json!({ "pairs": [{ "activityAId": in_id, "activityBId": out_id }] }),
    )
    .await;
    assert_eq!(
        relinked["linked"].as_array().unwrap().len(),
        1,
        "{relinked}"
    );
    let found = lookup(in_id.clone()).await;
    assert_eq!(found["linkedTo"], out_id, "{found}");
    assert_eq!(found["linkedState"], "linked", "{found}");
    assert_eq!(transfer_issue_legs(&server, &cookie).await, 0);
}

/// Runs the Health Center checks and counts the transfer legs they flag.
async fn transfer_issue_legs(server: &TestServer, cookie: &str) -> u64 {
    let status = api_post(server, cookie, "health/check", serde_json::json!({})).await;
    status["issues"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|issue| {
            issue["id"]
                .as_str()
                .is_some_and(|id| id.starts_with("invalid_transfer_group:"))
        })
        .map(|issue| issue["affectedCount"].as_u64().unwrap())
        .sum()
}

/// Part of #1701: a bare date is a calendar day. West of UTC, UTC midnight
/// falls on the previous local day, so a bare date is stored at the day's
/// midnight in the configured timezone. The instant stays on the same UTC day,
/// so the UTC-based date filter and duplicate keys keep matching, and nothing
/// changes at or east of UTC. The preview shows the date as submitted.
#[tokio::test]
async fn mcp_writes_place_bare_dates_on_their_local_day() {
    let server = spawn_server(true, false).await;
    let cookie = login(&server).await;
    disable_market_data_providers(&server, &cookie).await;
    let (pat, session) = activity_writer_session(&server, &cookie).await;
    // Midnight in Toronto (EDT) is 04:00 UTC; Paris keeps UTC midnight.
    for (timezone, stored_time) in [("America/Toronto", "04:00"), ("Europe/Paris", "00:00")] {
        let response = server
            .client
            .put(format!("{}/api/v1/settings", server.base))
            .header(header::COOKIE, format!("wf_session={cookie}"))
            .json(&serde_json::json!({ "timezone": timezone }))
            .send()
            .await
            .unwrap();
        assert!(response.status().is_success());
        let account = create_eur_account(&server, &cookie, timezone).await;
        let deposit = |date: &str, amount: f64| {
            serde_json::json!({
                "accountId": account["id"], "activityType": "DEPOSIT", "date": date,
                "currency": "EUR", "amount": amount
            })
        };

        let preview = mcp_call_tool(
            &server,
            &pat,
            &session,
            "prepare_activity_import",
            serde_json::json!({ "activities": [deposit("2026-04-01", 105.31)] }),
        )
        .await;
        assert_eq!(preview["rows"][0]["date"], "2026-04-01", "{preview}");
        let committed = mcp_call_tool(
            &server,
            &pat,
            &session,
            "commit_activity_import",
            serde_json::json!({ "activities": [deposit("2026-04-01", 105.31)] }),
        )
        .await;
        assert_eq!(committed["summary"]["imported"], 1, "{committed}");
        mcp_call_tool(
            &server,
            &pat,
            &session,
            "commit_activity_draft",
            serde_json::json!({ "draft": {
                "accountId": account["id"], "activityType": "DEPOSIT", "activityDate": "2026-04-02",
                "currency": "EUR", "amount": 50.0,
                "priceSource": "none", "pricingMode": "MARKET", "isCustomAsset": false
            }}),
        )
        .await;
        let mut dates: Vec<String> = stored_activities(&server, &cookie, &account)
            .await
            .iter()
            .map(|activity| activity["date"].as_str().unwrap().to_string())
            .collect();
        dates.sort();
        assert_eq!(
            dates,
            vec![
                format!("2026-04-01T{stored_time}:00+00:00"),
                format!("2026-04-02T{stored_time}:00+00:00")
            ],
            "{timezone}"
        );

        // The UTC-based date filter still finds the day's activity.
        let found = mcp_call_tool(
            &server,
            &pat,
            &session,
            "search_activities",
            serde_json::json!({
                "accountId": account["id"], "dateFrom": "2026-04-01", "dateTo": "2026-04-01"
            }),
        )
        .await;
        assert_eq!(
            found["activities"].as_array().unwrap().len(),
            1,
            "{timezone}: {found}"
        );

        // A row an earlier version stored at UTC midnight is still a duplicate.
        let committed = mcp_call_tool(
            &server,
            &pat,
            &session,
            "commit_activity_import",
            serde_json::json!({ "activities": [deposit("2026-04-03T00:00:00Z", 7.0)] }),
        )
        .await;
        assert_eq!(committed["summary"]["imported"], 1, "{committed}");
        let preview = mcp_call_tool(
            &server,
            &pat,
            &session,
            "prepare_activity_import",
            serde_json::json!({ "activities": [deposit("2026-04-03", 7.0)] }),
        )
        .await;
        assert_eq!(preview["summary"]["duplicates"], 1, "{timezone}: {preview}");
    }
}

/// The total value of `account` on `date`, polled until it equals `expected`:
/// the recalculation after a write is queued and debounced.
async fn await_valuation(
    server: &TestServer,
    pat: &str,
    session: &str,
    account: &serde_json::Value,
    date: &str,
    expected: f64,
) {
    let mut last = serde_json::Value::Null;
    for _ in 0..150 {
        last = mcp_call_tool(
            server,
            pat,
            session,
            "get_valuation_history",
            serde_json::json!({ "accountId": account["id"], "startDate": date, "endDate": date }),
        )
        .await;
        if last["valuations"][0]["totalValue"].as_f64() == Some(expected) {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    panic!("valuation on {date} never reached {expected}: {last}");
}

/// The stored quote valuations use for `asset_id` on `date`.
async fn effective_quote(
    server: &TestServer,
    cookie: &str,
    asset_id: &str,
    date: &str,
) -> serde_json::Value {
    let history: Vec<serde_json::Value> = server
        .client
        .get(format!("{}/api/v1/market-data/quotes/history", server.base))
        .query(&[("symbol", asset_id)])
        .header(header::COOKIE, format!("wf_session={cookie}"))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    history
        .into_iter()
        .find(|quote| quote["timestamp"].as_str().unwrap().starts_with(date))
        .unwrap_or(serde_json::Value::Null)
}

/// An EUR account holding two units of a manually priced fund, bought at 10
/// on 2026-07-27 with deposited cash (the purchase stores its price as a
/// manual quote), and a session whose token can read holdings and write
/// quotes. Returns the account, the fund's asset id, the token and the session
/// once the valuation carries the purchase price to 2026-08-31.
async fn fund_holding_session(
    server: &TestServer,
    cookie: &str,
) -> (serde_json::Value, String, String, String) {
    disable_market_data_providers(server, cookie).await;
    // One currency throughout, so valuations need no exchange rates.
    let response = server
        .client
        .put(format!("{}/api/v1/settings", server.base))
        .header(header::COOKIE, format!("wf_session={cookie}"))
        .json(&serde_json::json!({ "baseCurrency": "EUR" }))
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success(), "{}", response.status());
    let account = create_eur_account(server, cookie, "Statement").await;
    let asset = api_post(
        server,
        cookie,
        "assets",
        serde_json::json!({
            "kind": "INVESTMENT", "name": "Statement fund", "instrumentSymbol": "ZZFUND",
            "instrumentType": "EQUITY", "quoteCcy": "EUR", "quoteMode": "MANUAL"
        }),
    )
    .await;
    let asset_id = asset["id"].as_str().unwrap().to_string();
    for activity in [
        serde_json::json!({ "activityType": "DEPOSIT", "amount": "20" }),
        serde_json::json!({
            "activityType": "BUY", "quantity": "2", "unitPrice": "10",
            "asset": { "id": asset_id }
        }),
    ] {
        let mut activity = activity;
        activity.as_object_mut().unwrap().extend(
            serde_json::json!({
                "accountId": account["id"], "activityDate": "2026-07-27T12:00:00Z",
                "currency": "EUR"
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        api_post(server, cookie, "activities", activity).await;
    }

    let (status, token) = create_pat(
        server,
        cookie,
        serde_json::json!({
            "name": "quote writer", "scopes": ["holdings:read", "market-data:write"]
        }),
    )
    .await;
    assert_eq!(status, 201);
    let pat = token["token"].as_str().unwrap().to_string();
    let session = mcp_initialize(server, &pat).await;
    // The month-end value carries the purchase price until a quote is saved.
    await_valuation(server, &pat, &session, &account, "2026-08-31", 20.0).await;
    (account, asset_id, pat, session)
}

/// Stores a provider-sourced quote, as a market data sync would.
async fn store_provider_quote(
    server: &TestServer,
    cookie: &str,
    asset_id: &str,
    date: &str,
    close: f64,
) {
    let response = server
        .client
        .put(format!(
            "{}/api/v1/market-data/quotes/{asset_id}",
            server.base
        ))
        .header(header::COOKIE, format!("wf_session={cookie}"))
        .json(&serde_json::json!({
            "id": format!("{asset_id}_{date}_YAHOO"), "assetId": asset_id,
            "timestamp": format!("{date}T12:00:00Z"), "open": close, "high": close,
            "low": close, "close": close, "adjclose": close, "volume": 0,
            "currency": "EUR", "dataSource": "YAHOO", "createdAt": "2026-10-01T00:00:00Z",
            "notes": null
        }))
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success(), "{}", response.status());
}

/// #1856: an agent saves a statement's closing prices for an existing asset.
/// The preview reports each row's outcome against the stored quotes, a commit
/// with a conflicting row saves nothing, an approved commit saves manual
/// quotes (also over an equal provider price) that the valuation uses once the
/// queued recalculation has run, and repeating it changes nothing.
#[tokio::test]
async fn mcp_quote_import_saves_reviewed_prices_and_revalues() {
    let server = spawn_server(true, false).await;
    let cookie = login(&server).await;
    let (account, asset_id, pat, session) = fund_holding_session(&server, &cookie).await;
    store_provider_quote(&server, &cookie, &asset_id, "2026-09-30", 13.0).await;

    let statement = serde_json::json!([
        { "assetId": asset_id, "date": "2026-08-31", "price": 12.5, "currency": "EUR" },
        { "assetId": asset_id, "date": "2026-07-27", "price": 11, "currency": "EUR" },
        { "assetId": asset_id, "date": "2026-09-30", "price": 13, "currency": "EUR" }
    ]);
    let preview = mcp_call_tool(
        &server,
        &pat,
        &session,
        "prepare_quote_import",
        serde_json::json!({ "quotes": statement }),
    )
    .await;
    assert_eq!(preview["summary"]["create"], 2, "{preview}");
    assert_eq!(preview["summary"]["conflict"], 1, "{preview}");
    assert_eq!(preview["rows"][0]["outcome"], "create", "{preview}");
    assert_eq!(preview["rows"][0]["asset"]["symbol"], "ZZFUND", "{preview}");
    assert_eq!(preview["rows"][1]["outcome"], "conflict", "{preview}");
    assert_eq!(
        preview["rows"][1]["existing"]["source"], "MANUAL",
        "{preview}"
    );
    assert_eq!(preview["rows"][1]["existing"]["price"], 10.0, "{preview}");
    // The provider already has the statement price; it is still saved as manual.
    assert_eq!(preview["rows"][2]["outcome"], "create", "{preview}");
    assert_eq!(
        preview["rows"][2]["existing"]["source"], "YAHOO",
        "{preview}"
    );

    // The conflict stops the whole batch.
    let blocked = mcp_call_tool(
        &server,
        &pat,
        &session,
        "commit_quote_import",
        serde_json::json!({ "quotes": statement }),
    )
    .await;
    assert_eq!(blocked["committed"], false, "{blocked}");
    assert_eq!(blocked["saved"], 0, "{blocked}");
    assert_eq!(blocked["recalculation"], "none", "{blocked}");
    assert!(effective_quote(&server, &cookie, &asset_id, "2026-08-31")
        .await
        .is_null());
    assert_eq!(
        effective_quote(&server, &cookie, &asset_id, "2026-07-27").await["close"],
        10.0
    );

    // The user keeps the purchase price and approves the statement's prices.
    let approved = serde_json::json!({ "quotes": [statement[0].clone(), statement[2].clone()] });
    let committed = mcp_call_tool(
        &server,
        &pat,
        &session,
        "commit_quote_import",
        approved.clone(),
    )
    .await;
    assert_eq!(committed["committed"], true, "{committed}");
    assert_eq!(committed["saved"], 2, "{committed}");
    assert_eq!(committed["recalculation"], "queued", "{committed}");
    await_valuation(&server, &pat, &session, &account, "2026-08-31", 25.0).await;

    // Repeating the commit is a no-op.
    let repeated = mcp_call_tool(&server, &pat, &session, "commit_quote_import", approved).await;
    assert_eq!(repeated["committed"], true, "{repeated}");
    assert_eq!(repeated["saved"], 0, "{repeated}");
    assert_eq!(repeated["summary"]["skip"], 2, "{repeated}");
    assert_eq!(repeated["recalculation"], "none", "{repeated}");

    // Provider prices stored later for those days stay beneath the manual ones.
    for (date, close) in [("2026-08-31", 12.5), ("2026-09-30", 13.0)] {
        store_provider_quote(&server, &cookie, &asset_id, date, 99.0).await;
        let effective = effective_quote(&server, &cookie, &asset_id, date).await;
        assert_eq!(effective["dataSource"], "MANUAL", "{effective}");
        assert_eq!(effective["close"], close, "{effective}");
    }
}

/// The quote CSV import handlers no longer queue their own recalculation:
/// `import_quotes` emits PriceHistoryChanged, and the valuation still follows.
#[tokio::test]
async fn csv_quote_import_still_revalues() {
    let server = spawn_server(true, false).await;
    let cookie = login(&server).await;
    let (account, asset_id, pat, session) = fund_holding_session(&server, &cookie).await;

    let imported = api_post(
        &server,
        &cookie,
        "market-data/quotes/import",
        serde_json::json!({
            "quotes": [{
                "symbol": asset_id, "date": "2026-08-31", "close": 15, "currency": "EUR"
            }],
            "overwriteExisting": false
        }),
    )
    .await;
    assert_eq!(imported[0]["validationStatus"], "valid", "{imported}");
    await_valuation(&server, &pat, &session, &account, "2026-08-31", 30.0).await;
}

/// Calls an MCP tool that is expected to fail and returns the tool error text.
async fn mcp_call_tool_error(
    server: &TestServer,
    pat: &str,
    session: &str,
    name: &str,
    arguments: serde_json::Value,
) -> String {
    let response = mcp_post(
        server,
        Some(pat),
        Some(session),
        serde_json::json!({
            "jsonrpc": "2.0", "id": name, "method": "tools/call",
            "params": { "name": name, "arguments": arguments }
        }),
    )
    .await;
    assert_eq!(response.status(), 200);
    let result = parse_sse_data(&response.text().await.unwrap());
    assert_eq!(result["result"]["isError"], true, "{name}: {result}");
    result["result"]["content"][0]["text"]
        .as_str()
        .unwrap()
        .to_string()
}

fn activity_by_id<'a>(
    activities: &'a [serde_json::Value],
    id: &serde_json::Value,
) -> &'a serde_json::Value {
    activities
        .iter()
        .find(|activity| activity["id"] == *id)
        .unwrap_or_else(|| panic!("{id} in {activities:?}"))
}

fn changed_fields(changes: &serde_json::Value) -> Vec<&str> {
    changes
        .as_array()
        .unwrap()
        .iter()
        .map(|change| change["field"].as_str().unwrap())
        .collect()
}

/// #1853: a BTC transfer in recorded before its acquisition cost was known
/// gets its cost and fee in place, previewed first, without a second activity
/// or a changed quantity, and marked user-modified so broker syncs keep it.
#[tokio::test]
async fn mcp_updates_add_missing_cost_to_a_transfer_in() {
    let server = spawn_server(true, false).await;
    let cookie = login(&server).await;
    disable_market_data_providers(&server, &cookie).await;
    let (pat, session) = activity_writer_session(&server, &cookie).await;
    let wallet = api_post(
        &server,
        &cookie,
        "accounts",
        serde_json::json!({
            "name": "Wallet", "accountType": "CRYPTOCURRENCY", "currency": "EUR",
            "isDefault": false, "isActive": true, "trackingMode": "TRANSACTIONS"
        }),
    )
    .await;
    let transfer = api_post(
        &server,
        &cookie,
        "activities",
        serde_json::json!({
            "accountId": wallet["id"], "activityType": "TRANSFER_IN",
            "activityDate": "2026-03-02T09:30:00Z", "currency": "EUR", "quantity": "0.01",
            "asset": {
                "symbol": "BTC", "instrumentType": "CRYPTO", "quoteCcy": "EUR",
                "quoteMode": "MANUAL"
            },
            "notes": "StackinSat delivery"
        }),
    )
    .await;
    let stored = stored_activities(&server, &cookie, &wallet).await;
    assert_eq!(stored.len(), 1, "{stored:?}");
    assert!(stored[0]["amount"].is_null(), "{stored:?}");
    assert_eq!(stored[0]["isUserModified"], false, "{stored:?}");

    let row = serde_json::json!({ "activityId": transfer["id"], "amount": "650.50", "fee": 2.5 });
    let preview = mcp_call_tool(
        &server,
        &pat,
        &session,
        "prepare_activity_updates",
        serde_json::json!({ "updates": [row.clone()] }),
    )
    .await;
    assert_eq!(preview["summary"]["ready"], 1, "{preview}");
    let changes = &preview["rows"][0]["changes"];
    assert_eq!(changed_fields(changes), vec!["amount", "fee"], "{preview}");
    assert!(changes[0]["current"].is_null(), "{preview}");
    assert_eq!(changes[0]["proposed"], "650.5", "{preview}");
    assert_eq!(changes[1]["proposed"], "2.5", "{preview}");
    // The preview wrote nothing.
    let unchanged = stored_activities(&server, &cookie, &wallet).await;
    assert!(unchanged[0]["amount"].is_null(), "{unchanged:?}");

    let committed = mcp_call_tool(
        &server,
        &pat,
        &session,
        "commit_activity_updates",
        serde_json::json!({ "updates": [row] }),
    )
    .await;
    assert_eq!(committed["errors"], serde_json::json!([]), "{committed}");
    assert_eq!(committed["updated"][0]["activityId"], transfer["id"]);
    assert_eq!(
        changed_fields(&committed["updated"][0]["changes"]),
        vec!["amount", "fee"],
        "{committed}"
    );

    let stored = stored_activities(&server, &cookie, &wallet).await;
    assert_eq!(stored.len(), 1, "no second activity: {stored:?}");
    let updated = &stored[0];
    assert_eq!(updated["id"], transfer["id"]);
    assert_eq!(updated["activityType"], "TRANSFER_IN");
    assert_eq!(
        updated["quantity"]
            .as_str()
            .unwrap()
            .parse::<f64>()
            .unwrap(),
        0.01,
        "{updated}"
    );
    assert_eq!(updated["assetId"], transfer["assetId"], "{updated}");
    assert_eq!(updated["date"], "2026-03-02T09:30:00+00:00", "{updated}");
    assert_eq!(updated["comment"], "StackinSat delivery", "{updated}");
    assert_eq!(
        updated["amount"].as_str().unwrap().parse::<f64>().unwrap(),
        650.5,
        "{updated}"
    );
    assert_eq!(
        updated["fee"].as_str().unwrap().parse::<f64>().unwrap(),
        2.5,
        "{updated}"
    );
    assert_eq!(updated["isUserModified"], true, "{updated}");
}

/// A bare date in an update is a calendar day in the configured timezone,
/// as it is for created activities (#1701).
#[tokio::test]
async fn mcp_updates_place_a_bare_date_on_its_local_day() {
    let server = spawn_server(true, false).await;
    let cookie = login(&server).await;
    disable_market_data_providers(&server, &cookie).await;
    let (pat, session) = activity_writer_session(&server, &cookie).await;
    let response = server
        .client
        .put(format!("{}/api/v1/settings", server.base))
        .header(header::COOKIE, format!("wf_session={cookie}"))
        .json(&serde_json::json!({ "timezone": "America/Toronto" }))
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
    let account = create_eur_account(&server, &cookie, "Toronto").await;
    let deposit = api_post(
        &server,
        &cookie,
        "activities",
        serde_json::json!({
            "accountId": account["id"], "activityType": "DEPOSIT",
            "activityDate": "2026-04-01T12:00:00Z", "currency": "EUR", "amount": "100"
        }),
    )
    .await;

    let row = serde_json::json!({ "activityId": deposit["id"], "date": "2026-04-05" });
    let preview = mcp_call_tool(
        &server,
        &pat,
        &session,
        "prepare_activity_updates",
        serde_json::json!({ "updates": [row.clone()] }),
    )
    .await;
    // Midnight in Toronto (EDT) is 04:00 UTC.
    assert_eq!(
        preview["rows"][0]["changes"],
        serde_json::json!([{
            "field": "date",
            "current": "2026-04-01T12:00:00+00:00",
            "proposed": "2026-04-05T04:00:00+00:00"
        }]),
        "{preview}"
    );
    mcp_call_tool(
        &server,
        &pat,
        &session,
        "commit_activity_updates",
        serde_json::json!({ "updates": [row] }),
    )
    .await;
    let stored = stored_activities(&server, &cookie, &account).await;
    assert_eq!(stored[0]["date"], "2026-04-05T04:00:00+00:00", "{stored:?}");
}

/// A linked transfer's other leg receives the mirrored date, while a change
/// that would break the pair is refused with the way to unlink it first.
#[tokio::test]
async fn mcp_updates_keep_linked_transfers_paired() {
    let server = spawn_server(true, false).await;
    let cookie = login(&server).await;
    disable_market_data_providers(&server, &cookie).await;
    let (pat, session) = activity_writer_session(&server, &cookie).await;
    let chequing = create_eur_account(&server, &cookie, "Chequing").await;
    let savings = create_eur_account(&server, &cookie, "Savings").await;
    let brokerage = create_eur_account(&server, &cookie, "Brokerage").await;
    let transfer = |account: &serde_json::Value, activity_type: &str| {
        api_post(
            &server,
            &cookie,
            "activities",
            serde_json::json!({
                "accountId": account["id"], "activityType": activity_type,
                "activityDate": "2026-04-01T12:00:00Z", "currency": "EUR", "amount": "100"
            }),
        )
    };
    let out_id = transfer(&chequing, "TRANSFER_OUT").await["id"].clone();
    let in_id = transfer(&savings, "TRANSFER_IN").await["id"].clone();
    let linked = mcp_call_tool(
        &server,
        &pat,
        &session,
        "link_transfer_activities",
        serde_json::json!({ "pairs": [{ "activityAId": out_id, "activityBId": in_id }] }),
    )
    .await;
    assert_eq!(linked["errors"], serde_json::json!([]), "{linked}");

    let moved = serde_json::json!({ "activityId": out_id, "date": "2026-04-03T12:00:00Z" });
    let preview = mcp_call_tool(
        &server,
        &pat,
        &session,
        "prepare_activity_updates",
        serde_json::json!({ "updates": [moved.clone()] }),
    )
    .await;
    let previewed = &preview["rows"][0];
    assert_eq!(previewed["status"], "ready", "{preview}");
    assert_eq!(previewed["linkedActivityId"], in_id, "{preview}");
    assert_eq!(changed_fields(&previewed["linkedChanges"]), vec!["date"]);
    let committed = mcp_call_tool(
        &server,
        &pat,
        &session,
        "commit_activity_updates",
        serde_json::json!({ "updates": [moved] }),
    )
    .await;
    assert_eq!(committed["errors"], serde_json::json!([]), "{committed}");
    assert_eq!(
        changed_fields(&committed["updated"][0]["linkedChanges"]),
        vec!["date"],
        "{committed}"
    );
    for (account, id) in [(&chequing, &out_id), (&savings, &in_id)] {
        let stored = stored_activities(&server, &cookie, account).await;
        assert_eq!(
            activity_by_id(&stored, id)["date"],
            "2026-04-03T12:00:00+00:00",
            "{stored:?}"
        );
    }

    // Moving one leg to another account would break the pair.
    let rehomed = serde_json::json!({ "activityId": in_id, "accountId": brokerage["id"] });
    let preview = mcp_call_tool(
        &server,
        &pat,
        &session,
        "prepare_activity_updates",
        serde_json::json!({ "updates": [rehomed.clone()] }),
    )
    .await;
    let error = preview["rows"][0]["error"].as_str().unwrap();
    assert!(error.contains("accountId"), "{error}");
    assert!(error.contains("unlink_transfer_activities"), "{error}");
    let committed = mcp_call_tool(
        &server,
        &pat,
        &session,
        "commit_activity_updates",
        serde_json::json!({ "updates": [rehomed] }),
    )
    .await;
    assert_eq!(committed["updated"], serde_json::json!([]), "{committed}");
    assert_eq!(committed["errors"][0]["activityId"], in_id, "{committed}");
    let stored = stored_activities(&server, &cookie, &savings).await;
    assert_eq!(activity_by_id(&stored, &in_id)["accountId"], savings["id"]);
    assert!(stored_activities(&server, &cookie, &brokerage)
        .await
        .is_empty());
    let found = mcp_call_tool(
        &server,
        &pat,
        &session,
        "find_transfer_matches",
        serde_json::json!({ "activityId": in_id }),
    )
    .await;
    assert_eq!(found["linkedTo"], out_id, "still linked: {found}");
}

/// Core mirrors a linked cross-currency cash transfer with the pair's stored
/// rate, so a leg keeps its FX rate: a new rate would no longer match the two
/// amounts. An amount alone is mirrored at the stored rate.
#[tokio::test]
async fn mcp_updates_keep_the_rate_of_a_cross_currency_pair() {
    let server = spawn_server(true, false).await;
    let cookie = login(&server).await;
    disable_market_data_providers(&server, &cookie).await;
    let (pat, session) = activity_writer_session(&server, &cookie).await;
    let euros = create_eur_account(&server, &cookie, "Euros").await;
    let dollars = api_post(
        &server,
        &cookie,
        "accounts",
        serde_json::json!({
            "name": "Dollars", "accountType": "SECURITIES", "currency": "USD",
            "isDefault": false, "isActive": true, "trackingMode": "TRANSACTIONS"
        }),
    )
    .await;
    let transfer = |account: &serde_json::Value, row: serde_json::Value| {
        let mut row = row;
        row.as_object_mut().unwrap().extend(
            serde_json::json!({
                "accountId": account["id"], "activityDate": "2026-04-01T12:00:00Z"
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        api_post(&server, &cookie, "activities", row)
    };
    let out_id = transfer(
        &euros,
        serde_json::json!({ "activityType": "TRANSFER_OUT", "currency": "EUR", "amount": "100" }),
    )
    .await["id"]
        .clone();
    let incoming = transfer(
        &dollars,
        serde_json::json!({
            "activityType": "TRANSFER_IN", "currency": "USD", "amount": "110", "fxRate": "1.1"
        }),
    )
    .await;
    assert_eq!(incoming["fxRate"], "1.1", "{incoming}");
    let in_id = incoming["id"].clone();
    let linked = mcp_call_tool(
        &server,
        &pat,
        &session,
        "link_transfer_activities",
        serde_json::json!({ "pairs": [{ "activityAId": out_id, "activityBId": in_id }] }),
    )
    .await;
    assert_eq!(linked["errors"], serde_json::json!([]), "{linked}");

    let preview = mcp_call_tool(
        &server,
        &pat,
        &session,
        "prepare_activity_updates",
        serde_json::json!({ "updates": [
            { "activityId": in_id, "amount": "120", "fxRate": "1.2" },
            { "activityId": out_id, "notes": "rent" }
        ]}),
    )
    .await;
    let repriced = &preview["rows"][0];
    assert_eq!(repriced["status"], "invalid", "{preview}");
    let error = repriced["error"].as_str().unwrap();
    assert!(error.contains("fxRate"), "{error}");
    assert!(error.contains("unlink_transfer_activities"), "{error}");
    assert_eq!(preview["rows"][1]["status"], "ready", "{preview}");

    // An amount alone is mirrored at the stored rate: 121 / 1.1 = 110.
    let preview = mcp_call_tool(
        &server,
        &pat,
        &session,
        "prepare_activity_updates",
        serde_json::json!({ "updates": [{ "activityId": in_id, "amount": "121" }] }),
    )
    .await;
    assert_eq!(
        preview["rows"][0]["linkedChanges"],
        serde_json::json!([{ "field": "amount", "current": "100", "proposed": "110" }]),
        "{preview}"
    );
}

/// Broker sync can group rows that are not a linked transfer pair, such as a
/// deposit and its fee. Updating one, through the app's update (the activity
/// form, addons) or MCP, leaves the other as it was: only the other leg of a
/// linked pair is kept in step.
#[tokio::test]
async fn updates_leave_other_activities_of_a_source_group_alone() {
    let server = spawn_server(true, false).await;
    let cookie = login(&server).await;
    disable_market_data_providers(&server, &cookie).await;
    let (pat, session) = activity_writer_session(&server, &cookie).await;
    let account = create_eur_account(&server, &cookie, "Broker cash").await;
    let grouped = |activity_type: &str, amount: &str, notes: &str| {
        api_post(
            &server,
            &cookie,
            "activities",
            serde_json::json!({
                "accountId": account["id"], "activityType": activity_type,
                "activityDate": "2026-04-01T12:00:00Z", "currency": "EUR", "amount": amount,
                "notes": notes, "sourceGroupId": "broker-group-1"
            }),
        )
    };
    let deposit = grouped("DEPOSIT", "100", "deposit").await;
    let fee = grouped("FEE", "5", "broker fee").await;
    assert_eq!(fee["sourceGroupId"], "broker-group-1", "{fee}");
    let fee_before = activity_by_id(
        &stored_activities(&server, &cookie, &account).await,
        &fee["id"],
    )
    .clone();

    api_put(
        &server,
        &cookie,
        "activities",
        serde_json::json!({
            "id": deposit["id"], "accountId": account["id"], "activityType": "DEPOSIT",
            "activityDate": "2026-04-02T12:00:00Z", "currency": "USD", "amount": "150",
            "notes": "corrected"
        }),
    )
    .await;
    let stored = stored_activities(&server, &cookie, &account).await;
    assert_eq!(
        activity_by_id(&stored, &deposit["id"])["comment"],
        "corrected"
    );
    let fee_after = activity_by_id(&stored, &fee["id"]);
    for field in ["date", "currency", "amount", "comment"] {
        assert_eq!(fee_after[field], fee_before[field], "{field}: {fee_after}");
    }

    let committed = mcp_call_tool(
        &server,
        &pat,
        &session,
        "commit_activity_updates",
        serde_json::json!({ "updates": [{ "activityId": fee["id"], "notes": "fee corrected" }] }),
    )
    .await;
    assert_eq!(committed["errors"], serde_json::json!([]), "{committed}");
    let stored = stored_activities(&server, &cookie, &account).await;
    let deposit_after = activity_by_id(&stored, &deposit["id"]);
    assert_eq!(deposit_after["comment"], "corrected", "{deposit_after}");
    assert_eq!(deposit_after["currency"], "USD", "{deposit_after}");
    assert_eq!(
        activity_by_id(&stored, &fee["id"])["comment"],
        "fee corrected"
    );
}

/// Each row of a batch is applied on its own: a missing activity and an
/// invalid value fail alone, the other rows go through, and an unlinked
/// activity may move to another account.
#[tokio::test]
async fn mcp_updates_apply_each_row_on_its_own() {
    let server = spawn_server(true, false).await;
    let cookie = login(&server).await;
    disable_market_data_providers(&server, &cookie).await;
    let (pat, session) = activity_writer_session(&server, &cookie).await;
    let account = create_eur_account(&server, &cookie, "Everyday").await;
    let other = create_eur_account(&server, &cookie, "Other").await;
    let deposit = |amount: &str| {
        api_post(
            &server,
            &cookie,
            "activities",
            serde_json::json!({
                "accountId": account["id"], "activityType": "DEPOSIT",
                "activityDate": "2026-04-01T12:00:00Z", "currency": "EUR", "amount": amount
            }),
        )
    };
    let first = deposit("10").await["id"].clone();
    let second = deposit("20").await["id"].clone();
    let third = deposit("30").await["id"].clone();
    let rows = serde_json::json!({ "updates": [
        { "activityId": first, "amount": "12.5" },
        { "activityId": "no-such-activity", "fee": 1 },
        { "activityId": third, "amount": "abc" },
        { "activityId": second, "accountId": other["id"], "notes": "moved" }
    ]});

    let preview = mcp_call_tool(
        &server,
        &pat,
        &session,
        "prepare_activity_updates",
        rows.clone(),
    )
    .await;
    assert_eq!(
        preview["summary"],
        serde_json::json!({ "total": 4, "ready": 2, "invalid": 2 }),
        "{preview}"
    );
    let committed = mcp_call_tool(&server, &pat, &session, "commit_activity_updates", rows).await;
    let updated: Vec<_> = committed["updated"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["index"].as_u64().unwrap())
        .collect();
    assert_eq!(updated, vec![0, 3], "{committed}");
    let errors = committed["errors"].as_array().unwrap();
    assert_eq!(errors.len(), 2, "{committed}");
    assert_eq!(errors[0]["index"], 1);
    assert!(
        errors[0]["message"].as_str().unwrap().contains("not found"),
        "{committed}"
    );
    assert_eq!(errors[1]["index"], 2);
    assert!(
        errors[1]["message"].as_str().unwrap().contains("amount"),
        "{committed}"
    );

    let stored = stored_activities(&server, &cookie, &account).await;
    assert_eq!(stored.len(), 2, "{stored:?}");
    let amount =
        |activity: &serde_json::Value| activity["amount"].as_str().unwrap().parse::<f64>().unwrap();
    assert_eq!(amount(activity_by_id(&stored, &first)), 12.5);
    assert_eq!(amount(activity_by_id(&stored, &third)), 30.0);
    let moved = stored_activities(&server, &cookie, &other).await;
    assert_eq!(moved.len(), 1, "{moved:?}");
    assert_eq!(moved[0]["id"], second);
    assert_eq!(moved[0]["comment"], "moved");

    // Oversized batches are refused as a whole.
    let oversized: Vec<_> = (0..101)
        .map(|_| serde_json::json!({ "activityId": first, "fee": 1 }))
        .collect();
    let error = mcp_call_tool_error(
        &server,
        &pat,
        &session,
        "commit_activity_updates",
        serde_json::json!({ "updates": oversized }),
    )
    .await;
    assert!(error.contains("100"), "{error}");
}

#[tokio::test]
async fn mcp_audit_disabled_writes_no_rows() {
    let server = spawn_server(true, false).await;
    let cookie = login(&server).await;

    // Status reflects the disabled audit log.
    let status_json: serde_json::Value = server
        .client
        .get(format!("{}/api/v1/agent-access/status", server.base))
        .header(header::COOKIE, format!("wf_session={cookie}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(status_json["mcpEnabled"], true);
    assert_eq!(status_json["auditEnabled"], false);

    // A successful tools/call must not write an audit row.
    let (status, created) = create_pat(
        &server,
        &cookie,
        serde_json::json!({ "name": "ci", "scopes": READ_ONLY_SCOPES }),
    )
    .await;
    assert_eq!(status, 201);
    let pat = created["token"].as_str().unwrap().to_string();
    let session = mcp_initialize(&server, &pat).await;

    let response = mcp_post(
        &server,
        Some(&pat),
        Some(&session),
        serde_json::json!({
            "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": { "name": "get_accounts", "arguments": {} }
        }),
    )
    .await;
    assert_eq!(response.status(), 200);
    let call = parse_sse_data(&response.text().await.unwrap());
    assert_ne!(call["result"]["isError"], serde_json::json!(true));

    // The sink is disabled, so no row is written; a small delay guards against
    // any async write slipping in before asserting the log stayed empty.
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let page: serde_json::Value = server
        .client
        .get(format!("{}/api/v1/agent-access/audit", server.base))
        .header(header::COOKIE, format!("wf_session={cookie}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        page["totalCount"].as_i64().unwrap(),
        0,
        "no audit row should be written when WF_MCP_AUDIT_ENABLED=false"
    );
}

#[tokio::test]
async fn mcp_disabled_returns_404() {
    let server = spawn_server(false, true).await;

    // (i) /mcp is not mounted at all when WF_MCP_ENABLED is false.
    let response = mcp_post(&server, None, None, init_body()).await;
    assert_eq!(response.status(), 404);

    // The management API still reports the endpoint as disabled.
    let cookie = login(&server).await;
    let status_json: serde_json::Value = server
        .client
        .get(format!("{}/api/v1/agent-access/status", server.base))
        .header(header::COOKIE, format!("wf_session={cookie}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(status_json["mcpEnabled"], false);
}

#[tokio::test]
async fn profile_deletion_closes_initialized_mcp_sessions() {
    let server = spawn_server(true, true).await;
    let cookie = login(&server).await;
    let (status, token) = create_pat(
        &server,
        &cookie,
        serde_json::json!({"name":"deletion test", "scopes":READ_ONLY_SCOPES}),
    )
    .await;
    assert_eq!(status, 201);
    let pat = token["token"].as_str().unwrap();
    let session = mcp_initialize(&server, pat).await;
    let state: serde_json::Value = server
        .client
        .post(format!("{}/api/v1/profiles/get_profile_state", server.base))
        .header(header::COOKIE, format!("wf_session={cookie}"))
        .json(&serde_json::json!({}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let profile = &state["profiles"][0];
    let response = server
        .client
        .post(format!("{}/api/v1/profiles/delete_profile", server.base))
        .header(header::COOKIE, format!("wf_session={cookie}"))
        .header(
            "x-wf-profile-scope",
            state["session"]["scopeId"].as_str().unwrap(),
        )
        .json(&serde_json::json!({"profileId":profile["id"],"confirmation":profile["name"]}))
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .unwrap();
    let status = response.status();
    assert_eq!(status, 200, "{}", response.text().await.unwrap());
    let response = mcp_post(
        &server,
        Some(pat),
        Some(&session),
        serde_json::json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
    )
    .await;
    assert!(!response.status().is_success());
}

async fn category_api_get(server: &TestServer, cookie: &str, path: &str) -> serde_json::Value {
    let response = server
        .client
        .get(format!("{}/api/v1/{path}", server.base))
        .header(header::COOKIE, format!("wf_session={cookie}"))
        .send()
        .await
        .unwrap();
    let status = response.status();
    let value = response.json().await.unwrap();
    assert!(status.is_success(), "{path}: {status} {value}");
    value
}

/// Synthetic spending rows and categories, independent of bundled merchant rules.
async fn category_save_fixture(
    server: &TestServer,
    cookie: &str,
) -> (
    serde_json::Value,
    Vec<serde_json::Value>,
    String,
    String,
    String,
) {
    disable_market_data_providers(server, cookie).await;
    let account = api_post(
        server,
        cookie,
        "accounts",
        serde_json::json!({
            "name": "Synthetic spending", "accountType": "CASH", "currency": "EUR",
            "isDefault": false, "isActive": true, "trackingMode": "TRANSACTIONS"
        }),
    )
    .await;
    api_put(
        server,
        cookie,
        "spending/settings",
        serde_json::json!({
            "enabled": true, "accountIds": [account["id"]]
        }),
    )
    .await;
    let mut activities = Vec::new();
    for day in [1, 2] {
        activities.push(
            api_post(
                server,
                cookie,
                "activities",
                serde_json::json!({
                    "accountId": account["id"], "activityType": "WITHDRAWAL",
                    "activityDate": format!("2026-04-0{day}T12:00:00Z"), "currency": "EUR",
                    "amount": "12.50", "notes": format!("Synthetic merchant {day}")
                }),
            )
            .await,
        );
    }
    let mut categories = Vec::new();
    for (taxonomy, key) in [
        ("spending_categories", "synthetic_first"),
        ("spending_categories", "synthetic_second"),
        ("income_sources", "synthetic_income"),
    ] {
        let category = api_post(
            server,
            cookie,
            "taxonomies/categories",
            serde_json::json!({
                "taxonomyId": taxonomy, "name": key, "key": key, "color": "#123456",
                "sortOrder": 0
            }),
        )
        .await;
        categories.push(category["id"].as_str().unwrap().to_string());
    }
    (
        account,
        activities,
        categories[0].clone(),
        categories[1].clone(),
        categories[2].clone(),
    )
}

async fn category_writer_session(server: &TestServer, cookie: &str) -> (String, String) {
    let (status, token) = create_pat(
        server,
        cookie,
        serde_json::json!({
            "name": "category writer",
            "scopes": ["spending:read", "spending:write"]
        }),
    )
    .await;
    assert_eq!(status, 201);
    let pat = token["token"].as_str().unwrap().to_string();
    let session = mcp_initialize(server, &pat).await;
    (pat, session)
}

fn category_assignment(activity: &serde_json::Value, category: &str) -> serde_json::Value {
    serde_json::json!({
        "activityId": activity["id"], "taxonomyId": "spending_categories", "categoryId": category
    })
}

async fn category_rows(
    server: &TestServer,
    cookie: &str,
    activity: &serde_json::Value,
) -> serde_json::Value {
    category_api_get(
        server,
        cookie,
        &format!(
            "spending/activities/{}/assignments",
            activity["id"].as_str().unwrap()
        ),
    )
    .await
}

async fn category_splits(
    server: &TestServer,
    cookie: &str,
    activity: &serde_json::Value,
) -> serde_json::Value {
    category_api_get(
        server,
        cookie,
        &format!(
            "spending/activities/{}/splits",
            activity["id"].as_str().unwrap()
        ),
    )
    .await
}

#[tokio::test]
async fn mcp_category_save_persists_reviewed_proposals_and_retries() {
    let server = spawn_server(true, false).await;
    let cookie = login(&server).await;
    let (account, activities, first, second, _) = category_save_fixture(&server, &cookie).await;
    let (pat, session) = category_writer_session(&server, &cookie).await;
    let before = stored_activities(&server, &cookie, &account).await;
    let filters = serde_json::json!({"activityIds": [activities[0]["id"], activities[1]["id"]]});
    let context = mcp_call_tool(
        &server,
        &pat,
        &session,
        "list_categorization_context",
        filters.clone(),
    )
    .await;
    assert_eq!(context["summary"]["total"], 2, "{context}");
    let proposed = mcp_call_tool(
        &server,
        &pat,
        &session,
        "propose_transaction_categories",
        serde_json::json!({
            "activityIds": filters["activityIds"],
            "aiProposals": activities.iter().map(|a| serde_json::json!({
                "activityId": a["id"], "taxonomyId": "spending_categories",
                "categoryKey": "synthetic_first", "confidence": 0.9
            })).collect::<Vec<_>>()
        }),
    )
    .await;
    assert_eq!(proposed["draftStatus"], "draft");
    let assignments: Vec<_> = proposed["proposals"].as_array().unwrap().iter().map(|p| {
        serde_json::json!({"activityId": p["activityId"], "taxonomyId": p["taxonomyId"], "categoryId": p["categoryId"]})
    }).collect();
    assert_eq!(assignments.len(), 2, "{proposed}");
    assert!(category_rows(&server, &cookie, &activities[0])
        .await
        .as_array()
        .unwrap()
        .is_empty());
    let args = serde_json::json!({"assignments": assignments});
    let saved = mcp_call_tool(
        &server,
        &pat,
        &session,
        "commit_transaction_categories",
        args.clone(),
    )
    .await;
    assert_eq!(saved["draftStatus"], "applied");
    assert_eq!(saved["assignmentCount"], 2);
    for a in &activities {
        let rows = category_rows(&server, &cookie, a).await;
        assert_eq!(rows.as_array().unwrap().len(), 1);
        assert_eq!(rows[0]["categoryId"], first);
        assert_eq!(rows[0]["taxonomyId"], "spending_categories");
        assert_eq!(rows[0]["weight"], 10000);
        assert_eq!(rows[0]["source"], "manual");
        assert!(saved["assignments"].as_array().unwrap().contains(&rows[0]));
    }
    // Imported assignments can carry noncanonical IDs. Replacement must keep
    // that identity rather than generating a new assignment row.
    let stored_id = serde_json::json!("synthetic-imported-assignment");
    let profile = api_post(
        &server,
        &cookie,
        "profiles/get_profile_state",
        serde_json::json!({}),
    )
    .await;
    let database = server
        ._tmp
        .path()
        .join("profiles")
        .join(profile["session"]["profileId"].as_str().unwrap())
        .join("app.db");
    assert!(database.is_file());
    let db = wealthfolio_storage_sqlite::db::DbAccess::plaintext(database.to_str().unwrap())
        .connect_rusqlite()
        .unwrap();
    let changed = db
        .execute(
            "UPDATE activity_taxonomy_assignments SET id = ?1 WHERE activity_id = ?2",
            [
                stored_id.as_str().unwrap(),
                activities[0]["id"].as_str().unwrap(),
            ],
        )
        .unwrap();
    assert_eq!(changed, 1);
    drop(db);
    let repeated = mcp_call_tool(
        &server,
        &pat,
        &session,
        "commit_transaction_categories",
        args.clone(),
    )
    .await;
    assert_eq!(repeated["assignmentCount"], 2);
    assert_eq!(
        category_rows(&server, &cookie, &activities[0]).await[0]["id"],
        stored_id
    );
    let fresh_session = mcp_initialize(&server, &pat).await;
    let fresh = mcp_call_tool(
        &server,
        &pat,
        &fresh_session,
        "list_categorization_context",
        filters,
    )
    .await;
    assert_eq!(fresh["summary"]["total"], 0, "{fresh}");
    assert_eq!(stored_activities(&server, &cookie, &account).await, before);

    // Like the native Apply action, a confirmed delayed draft replaces current
    // assignments. A retry is not optimistic locking against intervening edits.
    api_put(
        &server,
        &cookie,
        &format!(
            "spending/activities/{}/assignments",
            activities[0]["id"].as_str().unwrap()
        ),
        serde_json::json!({"taxonomyId": "spending_categories", "categoryId": second}),
    )
    .await;
    mcp_call_tool(
        &server,
        &pat,
        &session,
        "commit_transaction_categories",
        args,
    )
    .await;
    let rows = category_rows(&server, &cookie, &activities[0]).await;
    assert_eq!(rows[0]["categoryId"], first);
    assert_eq!(rows[0]["id"], stored_id);
}

#[tokio::test]
async fn mcp_category_save_rolls_back_assignments_and_split_clearing() {
    let server = spawn_server(true, false).await;
    let cookie = login(&server).await;
    let (_, activities, first, second, income) = category_save_fixture(&server, &cookie).await;
    let (pat, session) = category_writer_session(&server, &cookie).await;
    api_put(
        &server,
        &cookie,
        &format!(
            "spending/activities/{}/assignments",
            activities[1]["id"].as_str().unwrap()
        ),
        serde_json::json!({"taxonomyId": "spending_categories", "categoryId": first}),
    )
    .await;
    let split_path = format!(
        "spending/activities/{}/splits",
        activities[0]["id"].as_str().unwrap()
    );
    api_put(
        &server,
        &cookie,
        &split_path,
        serde_json::json!([
            {"taxonomyId": "spending_categories", "categoryId": first, "amount": "5.00"},
            {"taxonomyId": "spending_categories", "categoryId": second, "amount": "7.50"}
        ]),
    )
    .await;
    let prior_rows = category_rows(&server, &cookie, &activities[1]).await;
    let prior_splits = category_splits(&server, &cookie, &activities[0]).await;
    assert_eq!(prior_splits.as_array().unwrap().len(), 2);

    let proposed = mcp_call_tool(&server, &pat, &session, "propose_transaction_categories",
        serde_json::json!({"activityIds": [activities[0]["id"], activities[1]["id"]], "status": "all"})).await;
    assert_eq!(proposed["summary"]["protectedSplits"], 1);
    assert!(!proposed["proposals"]
        .as_array()
        .unwrap()
        .iter()
        .any(|p| p["activityId"] == activities[0]["id"]));
    assert!(!proposed["unproposed"]
        .as_array()
        .unwrap()
        .iter()
        .any(|p| p["activityId"] == activities[0]["id"]));
    let conflict = mcp_call_tool(&server, &pat, &session, "commit_transaction_categories",
        serde_json::json!({"assignments": [category_assignment(&activities[1], &second), category_assignment(&activities[0], &second)]})).await;
    assert_eq!(conflict["draftStatus"], "conflict");
    assert_eq!(conflict["assignmentCount"], 0);
    assert_eq!(conflict["conflicts"][0]["activityId"], activities[0]["id"]);
    assert_eq!(conflict["conflicts"][0]["reason"], "protected_splits");
    assert_eq!(
        category_rows(&server, &cookie, &activities[1]).await,
        prior_rows
    );
    assert_eq!(
        category_splits(&server, &cookie, &activities[0]).await,
        prior_splits
    );

    // A category in another taxonomy is rejected before any persistence.
    let error = mcp_call_tool_error(
        &server,
        &pat,
        &session,
        "commit_transaction_categories",
        serde_json::json!({"assignments": [
            category_assignment(&activities[0], &second),
            category_assignment(&activities[1], &income)
        ]}),
    )
    .await;
    assert!(!error.is_empty());
    assert!(category_rows(&server, &cookie, &activities[0])
        .await
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(
        category_rows(&server, &cookie, &activities[1]).await,
        prior_rows
    );
    assert_eq!(
        category_splits(&server, &cookie, &activities[0]).await,
        prior_splits
    );

    for (invalid, reason) in [
        (
            serde_json::json!({"activityId": "missing-activity", "taxonomyId": "spending_categories", "categoryId": first}),
            "Record not found",
        ),
        (
            serde_json::json!({"activityId": activities[1]["id"], "taxonomyId": "income_sources", "categoryId": income}),
            "Spending activities can only use spending categories",
        ),
        (
            category_assignment(&activities[1], "missing-category"),
            "Category does not belong to the selected cash-flow taxonomy",
        ),
        (
            serde_json::json!({"activityId": activities[1]["id"], "taxonomyId": "missing-taxonomy", "categoryId": first}),
            "Taxonomy is not assignable to spending activities",
        ),
    ] {
        let error = mcp_call_tool_error(&server, &pat, &session, "commit_transaction_categories",
            serde_json::json!({"assignments": [category_assignment(&activities[0], &second), invalid]})).await;
        assert!(error.starts_with("Tool execution failed:"), "{error}");
        assert!(error.contains(reason), "expected {reason:?}, got {error:?}");
        assert_eq!(
            category_rows(&server, &cookie, &activities[1]).await,
            prior_rows
        );
        assert_eq!(
            category_splits(&server, &cookie, &activities[0]).await,
            prior_splits
        );
    }
    mcp_call_tool(
        &server,
        &pat,
        &session,
        "commit_transaction_categories",
        serde_json::json!({"assignments": [{
            "activityId": activities[0]["id"], "taxonomyId": "spending_categories", "categoryId": second,
            "expectedSplits": prior_splits,
        }]}),
    )
    .await;
    assert!(category_splits(&server, &cookie, &activities[0])
        .await
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(
        category_rows(&server, &cookie, &activities[0]).await[0]["categoryId"],
        second
    );
}

#[tokio::test]
async fn mcp_category_save_denies_insufficient_scopes_and_redacts_audit_errors() {
    let server = spawn_server(true, true).await;
    let cookie = login(&server).await;
    let (_, activities, first, _, _) = category_save_fixture(&server, &cookie).await;
    let (pat, session) = category_writer_session(&server, &cookie).await;
    api_put(
        &server,
        &cookie,
        &format!(
            "spending/activities/{}/splits",
            activities[0]["id"].as_str().unwrap()
        ),
        serde_json::json!([{
            "taxonomyId": "spending_categories", "categoryId": first, "amount": "12.50"
        }]),
    )
    .await;
    let prior_splits = category_splits(&server, &cookie, &activities[0]).await;
    let args = serde_json::json!({"assignments": [category_assignment(&activities[0], &first)]});
    for scopes in [
        serde_json::json!(["classification:read"]),
        serde_json::json!(["classification:read", "classification:suggest"]),
    ] {
        let (status, token) = create_pat(
            &server,
            &cookie,
            serde_json::json!({"name": "limited", "scopes": scopes}),
        )
        .await;
        assert_eq!(status, 201);
        let limited_pat = token["token"].as_str().unwrap();
        let limited_session = mcp_initialize(&server, limited_pat).await;
        let list = mcp_post(
            &server,
            Some(limited_pat),
            Some(&limited_session),
            serde_json::json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}),
        )
        .await;
        let list = parse_sse_data(&list.text().await.unwrap());
        assert!(!list["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["name"] == "commit_transaction_categories"));
        let error = mcp_call_tool_error(
            &server,
            limited_pat,
            &limited_session,
            "commit_transaction_categories",
            args.clone(),
        )
        .await;
        assert!(error.contains("Scope denied"), "{error}");
        assert_eq!(
            category_splits(&server, &cookie, &activities[0]).await,
            prior_splits
        );
        assert!(category_rows(&server, &cookie, &activities[0])
            .await
            .as_array()
            .unwrap()
            .is_empty());
    }
    for malformed in [
        serde_json::json!({"assignments": "sensitive-sentinel"}),
        serde_json::json!({"assignments": [{"activityId": {"sensitive-sentinel": true}, "taxonomyId": "spending_categories", "categoryId": first}]}),
        serde_json::json!({"assignments": [{"activityId": activities[0]["id"], "taxonomyId": "spending_categories"}], "sensitive-sentinel": true}),
    ] {
        let error = mcp_call_tool_error(
            &server,
            &pat,
            &session,
            "commit_transaction_categories",
            malformed,
        )
        .await;
        assert!(!error.contains("sensitive-sentinel"), "{error}");
    }
    mcp_call_tool_error(
        &server,
        &pat,
        &session,
        "commit_transaction_categories",
        serde_json::json!({"assignments": [{
            "activityId": "sensitive-sentinel", "taxonomyId": "spending_categories",
            "categoryId": first
        }]}),
    )
    .await;
    let mut valid = args;
    valid["sensitive-sentinel"] = serde_json::json!("private extra value");
    mcp_call_tool(
        &server,
        &pat,
        &session,
        "commit_transaction_categories",
        valid,
    )
    .await;
    let audit = category_api_get(&server, &cookie, "agent-access/audit").await;
    let rows: Vec<_> = audit["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["tool"] == "commit_transaction_categories")
        .collect();
    assert_eq!(rows.len(), 7, "{audit}");
    for row in rows {
        let text = row.to_string();
        assert!(!text.contains("sensitive-sentinel"), "{row}");
        assert!(!text.contains("private extra value"), "{row}");
        assert!(
            !text.contains(activities[0]["id"].as_str().unwrap()),
            "{row}"
        );
        assert!(!text.contains(&first), "{row}");
    }
}

#[tokio::test]
async fn spending_only_reads_are_scoped_paginated_and_available_without_investment_grants() {
    let server = spawn_server(true, false).await;
    let cookie = login(&server).await;
    let (account, activities, first, _, _) = category_save_fixture(&server, &cookie).await;
    let (status, token) = create_pat(
        &server,
        &cookie,
        serde_json::json!({"name":"spending reader", "scopes":["spending:read"]}),
    )
    .await;
    assert_eq!(status, 201);
    let pat = token["token"].as_str().unwrap();
    let session = mcp_initialize(&server, pat).await;
    let context = mcp_call_tool(
        &server,
        pat,
        &session,
        "get_spending_context",
        serde_json::json!({}),
    )
    .await;
    assert_eq!(context["availability"], "available");
    assert_eq!(context["accountIds"], serde_json::json!([account["id"]]));
    let list = mcp_post(
        &server,
        Some(pat),
        Some(&session),
        serde_json::json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
    )
    .await;
    let list = parse_sse_data(&list.text().await.unwrap());
    let names = list["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect::<Vec<_>>();
    for name in [
        "get_spending_context",
        "search_spending_transactions",
        "list_transaction_categories",
        "list_categorization_context",
        "propose_transaction_categories",
        "create_categorization_rule",
        "list_categorization_rules",
    ] {
        assert!(names.contains(&name), "{name}");
    }
    for name in [
        "search_activities",
        "get_holdings",
        "list_asset_taxonomies",
        "commit_transaction_categories",
        "rerun_categorization_rules",
    ] {
        assert!(!names.contains(&name), "{name}");
        assert!(
            mcp_call_tool_error(&server, pat, &session, name, serde_json::json!({}))
                .await
                .contains("Scope denied")
        );
    }
    let page = mcp_call_tool(
        &server,
        pat,
        &session,
        "search_spending_transactions",
        serde_json::json!({"limit":1,"sortDir":"asc"}),
    )
    .await;
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    assert_eq!(page["totalCount"], 2);
    assert_eq!(page["hasMore"], true);
    assert_eq!(page["fxRequested"], false);
    assert_eq!(page["items"][0]["accountId"], account["id"]);
    let next = mcp_call_tool(
        &server,
        pat,
        &session,
        "search_spending_transactions",
        serde_json::json!({"offset":1,"limit":1,"sortDir":"asc"}),
    )
    .await;
    assert_eq!(next["hasMore"], false);
    assert_ne!(next["items"][0]["id"], page["items"][0]["id"]);
    let outside = mcp_call_tool(
        &server,
        pat,
        &session,
        "search_spending_transactions",
        serde_json::json!({"accountIds":["not-enrolled"]}),
    )
    .await;
    assert_eq!(outside["totalCount"], 0);
    assert_eq!(outside["context"]["accountIds"], serde_json::json!([]));
    api_put(&server, &cookie, &format!("spending/activities/{}/splits", activities[0]["id"].as_str().unwrap()),
        serde_json::json!([{"taxonomyId":"spending_categories","categoryId":first,"amount":"12.50"}])).await;
    let split = mcp_call_tool(
        &server,
        pat,
        &session,
        "search_spending_transactions",
        serde_json::json!({"activityIds":[activities[0]["id"]],"status":"categorized"}),
    )
    .await;
    assert_eq!(split["totalCount"], 1);
    assert_eq!(
        split["items"][0]["effectiveAllocations"][0]["categoryId"],
        first
    );
    assert_eq!(split["items"][0]["splits"].as_array().unwrap().len(), 1);
    let uncategorized = mcp_call_tool(
        &server,
        pat,
        &session,
        "search_spending_transactions",
        serde_json::json!({"activityIds":[activities[0]["id"]],"status":"uncategorized"}),
    )
    .await;
    assert_eq!(uncategorized["totalCount"], 0);
    let categories = mcp_call_tool(
        &server,
        pat,
        &session,
        "list_transaction_categories",
        serde_json::json!({}),
    )
    .await;
    assert_eq!(categories["taxonomies"].as_array().unwrap().len(), 3);
    api_put(
        &server,
        &cookie,
        "spending/settings",
        serde_json::json!({"enabled":false}),
    )
    .await;
    let context = mcp_call_tool(
        &server,
        pat,
        &session,
        "get_spending_context",
        serde_json::json!({}),
    )
    .await;
    assert_eq!(context["availability"], "disabled");
    assert_eq!(context["accountIds"], serde_json::json!([]));
    let disabled = mcp_call_tool(
        &server,
        pat,
        &session,
        "search_spending_transactions",
        serde_json::json!({"activityIds":[activities[0]["id"]]}),
    )
    .await;
    assert_eq!(disabled["totalCount"], 0);
    let configuration = mcp_call_tool(
        &server,
        pat,
        &session,
        "list_transaction_categories",
        serde_json::json!({}),
    )
    .await;
    assert_eq!(configuration, categories);
}

#[tokio::test]
async fn mcp_permission_edits_apply_in_the_existing_session() {
    let server = spawn_server(true, true).await;
    let cookie = login(&server).await;
    let (_, created) = create_pat(
        &server,
        &cookie,
        serde_json::json!({"name":"editable", "scopes":["accounts:read"]}),
    )
    .await;
    let pat = created["token"].as_str().unwrap();
    let id = created["id"].as_str().unwrap();
    let session = mcp_initialize(&server, pat).await;
    let denied =
        mcp_call_tool_error(&server, pat, &session, "get_goals", serde_json::json!({})).await;
    assert!(denied.contains("Scope denied"));
    let url = format!("{}/api/v1/agent-access/tokens/{id}", server.base);
    let patch = |scopes: serde_json::Value| {
        server
            .client
            .patch(&url)
            .header(header::COOKIE, format!("wf_session={cookie}"))
            .json(&serde_json::json!({"scopes":scopes}))
    };
    for scopes in [
        serde_json::json!(["accounts:read", "financial-planning:read"]),
        serde_json::json!(["accounts:read"]),
    ] {
        let response = patch(scopes.clone()).send().await.unwrap();
        assert_eq!(response.status(), 200);
        let edited: serde_json::Value = response.json().await.unwrap();
        assert_eq!(edited["scopes"], scopes);
        for field in ["id", "name", "tokenPrefix", "createdAt", "expiresAt"] {
            assert_eq!(edited[field], created[field]);
        }
        assert!(edited.get("token").is_none() && edited.get("tokenHash").is_none());
        let response = mcp_post(
            &server,
            Some(pat),
            Some(&session),
            serde_json::json!({"jsonrpc":"2.0","id":"list","method":"tools/list"}),
        )
        .await;
        let list = parse_sse_data(&response.text().await.unwrap());
        let visible = list["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["name"] == "get_goals");
        if scopes.as_array().unwrap().len() == 2 {
            assert!(visible);
            assert!(
                mcp_call_tool(&server, pat, &session, "get_goals", serde_json::json!({})).await
                    ["goals"]
                    .is_array()
            );
        } else {
            assert!(!visible);
            assert!(mcp_call_tool_error(
                &server,
                pat,
                &session,
                "get_goals",
                serde_json::json!({})
            )
            .await
            .contains("Scope denied"));
        }
    }
}

/// Management requests do not need the streaming MCP transport, so exercise
/// their complete authentication/router/persistence path without a TCP listener.
async fn scope_api_request(
    app: &axum::Router,
    method: &str,
    path: &str,
    credential: Option<(&str, &str)>,
    body: serde_json::Value,
) -> axum::response::Response {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json")
        .extension(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 12345))));
    if let Some((name, value)) = credential {
        request = request.header(name, value);
    }
    app.clone()
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap()
}

async fn scope_response_json(response: axum::response::Response) -> serde_json::Value {
    serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap()
}

#[tokio::test]
async fn permission_edits_management_requires_session_and_preserves_token_metadata() {
    let (app, _tmp) = build_test_router(true, true).await;
    let response = scope_api_request(
        &app,
        "POST",
        "/api/v1/auth/login",
        None,
        serde_json::json!({"password": PASSWORD}),
    )
    .await;
    assert_eq!(response.status(), 200);
    let cookie = response.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string();
    let auth = Some(("cookie", cookie.as_str()));
    let created = scope_api_request(&app, "POST", "/api/v1/agent-access/tokens", auth,
        serde_json::json!({"name":"editable", "scopes":["accounts:read"], "expiresAt":"2099-01-01T00:00:00Z"})).await;
    assert_eq!(created.status(), 201);
    let created = scope_response_json(created).await;
    let url = format!(
        "/api/v1/agent-access/tokens/{}",
        created["id"].as_str().unwrap()
    );
    let bearer = format!("Bearer {}", created["token"].as_str().unwrap());
    for credential in [None, Some(("authorization", bearer.as_str()))] {
        let response = scope_api_request(
            &app,
            "PATCH",
            &url,
            credential,
            serde_json::json!({"scopes":["holdings:read"]}),
        )
        .await;
        assert_eq!(response.status(), 401);
    }
    let before = scope_response_json(
        scope_api_request(
            &app,
            "GET",
            "/api/v1/agent-access/tokens",
            auth,
            serde_json::Value::Null,
        )
        .await,
    )
    .await[0]
        .clone();
    for scopes in [
        serde_json::json!([]),
        serde_json::json!(["unknown:scope"]),
        serde_json::json!(["activities:write"]),
        serde_json::json!(["classification:write"]),
        serde_json::json!(["market-data:write"]),
    ] {
        assert_eq!(
            scope_api_request(
                &app,
                "PATCH",
                &url,
                auth,
                serde_json::json!({"scopes":scopes})
            )
            .await
            .status(),
            400
        );
    }
    for payload in [
        serde_json::json!({}),
        serde_json::json!({"scopes":"accounts:read"}),
        serde_json::json!({"scopes":["holdings:read"], "expiresAt":null}),
        serde_json::json!({"scopes":["holdings:read"], "name":"renamed"}),
    ] {
        assert_eq!(
            scope_api_request(&app, "PATCH", &url, auth, payload)
                .await
                .status(),
            422
        );
    }
    let unchanged = scope_response_json(
        scope_api_request(
            &app,
            "GET",
            "/api/v1/agent-access/tokens",
            auth,
            serde_json::Value::Null,
        )
        .await,
    )
    .await[0]
        .clone();
    assert_eq!(unchanged, before);
    let response = scope_api_request(
        &app,
        "PATCH",
        &url,
        auth,
        serde_json::json!({"scopes":["holdings:read", "accounts:read", "holdings:read"]}),
    )
    .await;
    assert_eq!(response.status(), 200);
    let updated = scope_response_json(response).await;
    assert_eq!(
        updated["scopes"],
        serde_json::json!(["accounts:read", "holdings:read"])
    );
    for field in [
        "id",
        "name",
        "tokenPrefix",
        "fingerprint",
        "createdAt",
        "expiresAt",
        "lastUsedAt",
        "revokedAt",
    ] {
        assert_eq!(updated[field], before[field]);
    }
    assert!(updated.get("token").is_none() && updated.get("tokenHash").is_none());
    assert_eq!(
        scope_api_request(
            &app,
            "PATCH",
            "/api/v1/agent-access/tokens/missing",
            auth,
            serde_json::json!({"scopes":["accounts:read"]})
        )
        .await
        .status(),
        404
    );
    let expired = scope_response_json(scope_api_request(&app, "POST", "/api/v1/agent-access/tokens", auth,
        serde_json::json!({"name":"expired", "scopes":["accounts:read"], "expiresAt":"2000-01-01T00:00:00Z"})).await).await;
    let url = format!(
        "/api/v1/agent-access/tokens/{}",
        expired["id"].as_str().unwrap()
    );
    assert_eq!(
        scope_api_request(
            &app,
            "PATCH",
            &url,
            auth,
            serde_json::json!({"scopes":["holdings:read"]})
        )
        .await
        .status(),
        200
    );
    let expired_bearer = format!("Bearer {}", expired["token"].as_str().unwrap());
    assert_eq!(
        scope_api_request(
            &app,
            "POST",
            "/mcp",
            Some(("authorization", &expired_bearer)),
            init_body()
        )
        .await
        .status(),
        401
    );
}

#[tokio::test]
async fn agent_budget_reads_are_pure_and_share_missing_group_resolution_with_insight() {
    for missing in [
        "key = 'other'",
        "key IN ('needs','wants','other')",
        "is_system = 1",
    ] {
        let server = spawn_server(true, false).await;
        let cookie = login(&server).await;
        category_save_fixture(&server, &cookie).await;
        let (_, token) = create_pat(
            &server,
            &cookie,
            serde_json::json!({"name":"budget reader","scopes":["spending:read"]}),
        )
        .await;
        let pat = token["token"].as_str().unwrap();
        let session = mcp_initialize(&server, pat).await;
        let profile = api_post(
            &server,
            &cookie,
            "profiles/get_profile_state",
            serde_json::json!({}),
        )
        .await;
        let path = server
            ._tmp
            .path()
            .join("profiles")
            .join(profile["session"]["profileId"].as_str().unwrap())
            .join("app.db");
        let db = wealthfolio_storage_sqlite::db::DbAccess::plaintext(path.to_str().unwrap())
            .connect_rusqlite()
            .unwrap();
        db.execute("INSERT INTO budget_groups (id,name,key,is_system) VALUES ('custom','My custom group','custom',0)", []).unwrap();
        db.execute(&format!("DELETE FROM budget_groups WHERE {missing}"), [])
            .unwrap();
        let count = || {
            db.query_row("SELECT COUNT(*) FROM budget_groups", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap()
        };
        let budget_outbox = || {
            db.query_row("SELECT COUNT(*) FROM sync_outbox WHERE entity IN ('budget_group','budget_group_assignment','budget_target','budget_rollover_setting')", [], |row| row.get::<_, i64>(0)).unwrap()
        };
        let before = count();
        let outbox_before = budget_outbox();
        let read = mcp_call_tool(
            &server,
            pat,
            &session,
            "get_budget",
            serde_json::json!({"periodKey":"default"}),
        )
        .await;
        let groups = read["budget"]["state"]["groups"].as_array().unwrap();
        assert_eq!(groups.len(), 7);
        assert!(groups
            .iter()
            .any(|group| group["id"] == "custom" && group["name"] == "My custom group"));
        let expected_ids = groups
            .iter()
            .map(|group| group["id"].as_str().unwrap().to_string())
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(count(), before, "agent read must not seed groups");
        assert_eq!(
            budget_outbox(),
            outbox_before,
            "agent read must not emit budget writes"
        );
        let insight = api_post(&server, &cookie, "spending/insight", serde_json::json!({"startDate":"2026-01-01T00:00:00Z","endDate":"2026-01-31T23:59:59Z"})).await;
        let insight_ids = insight["groups"]
            .as_array()
            .unwrap()
            .iter()
            .map(|group| group["group"]["id"].as_str().unwrap().to_string())
            .collect::<std::collections::BTreeSet<_>>();
        // Native Insight deliberately omits the Savings group from its
        // consumption breakdown; preserve that accounting presentation.
        let consumption_ids = groups
            .iter()
            .filter(|group| group["key"] != "savings")
            .map(|group| group["id"].as_str().unwrap().to_string())
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(
            insight_ids, consumption_ids,
            "Insight and Budget resolve the same consumption groups"
        );
        assert_eq!(count(), before, "Insight also stays pure");
        assert_eq!(budget_outbox(), outbox_before);
        let integration = category_api_get(
            &server,
            &cookie,
            "spending/budget/snapshot?periodKey=default",
        )
        .await;
        assert_eq!(
            integration["state"]["groups"],
            read["budget"]["state"]["groups"]
        );
        assert_eq!(count(), before, "addon snapshot read stays pure");
        assert_eq!(budget_outbox(), outbox_before);
        // The native screen deliberately retains its existing initialization lifecycle.
        let native = category_api_get(&server, &cookie, "spending/budget?periodKey=default").await;
        let native_ids = native["state"]["groups"]
            .as_array()
            .unwrap()
            .iter()
            .map(|group| group["id"].as_str().unwrap().to_string())
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(native_ids, expected_ids);
        assert_eq!(
            native["computed"]["totals"],
            read["budget"]["computed"]["totals"]
        );
        assert_eq!(count(), 7, "native budget read still seeds missing groups");
    }
}

async fn reviewed_budget_change(
    server: &TestServer,
    pat: &str,
    session: &str,
    operation: serde_json::Value,
    period: &str,
) -> serde_json::Value {
    let preview = mcp_call_tool(
        server,
        pat,
        session,
        "prepare_budget_change",
        serde_json::json!({"change":operation,"periodKey":period}),
    )
    .await;
    mcp_call_tool(
        server,
        pat,
        session,
        "commit_budget_change",
        preview["change"].clone(),
    )
    .await["budget"]
        .clone()
}
fn budget_category<'a>(snapshot: &'a serde_json::Value, id: &str) -> &'a serde_json::Value {
    snapshot["computed"]["groupRows"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|group| group["categories"].as_array().unwrap())
        .find(|c| c["categoryId"] == id)
        .unwrap()
}
#[tokio::test]
async fn reviewed_budget_defaults_overrides_copy_and_stale_reviews_use_native_calculations() {
    let server = spawn_server(true, false).await;
    let cookie = login(&server).await;
    let (_, _, category, _, _) = category_save_fixture(&server, &cookie).await;
    let (status, token) = create_pat(
        &server,
        &cookie,
        serde_json::json!({"name":"Budget only","scopes":["spending:read","budget:write"]}),
    )
    .await;
    assert_eq!(status, 201);
    let pat = token["token"].as_str().unwrap();
    let session = mcp_initialize(&server, pat).await;
    let set = |period: &str, amount: &str| serde_json::json!({"operation":"set_target","target":{"periodKey":period,"targetType":"category","taxonomyId":"spending_categories","categoryId":category,"amount":amount}});
    let default =
        reviewed_budget_change(&server, pat, &session, set("default", "100"), "2026-04").await;
    assert_eq!(budget_category(&default, &category)["target"], 100.0);
    let monthly =
        reviewed_budget_change(&server, pat, &session, set("2026-04", "200"), "2026-04").await;
    assert_eq!(budget_category(&monthly, &category)["target"], 200.0);
    let override_id = monthly["state"]["targets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["periodKey"] == "2026-04")
        .unwrap()["id"]
        .clone();
    let stale = mcp_call_tool(
        &server,
        pat,
        &session,
        "prepare_budget_change",
        serde_json::json!({"change":set("default","150"),"periodKey":"2026-04"}),
    )
    .await;
    let changed =
        reviewed_budget_change(&server, pat, &session, set("default", "300"), "2026-04").await;
    assert_eq!(
        budget_category(&changed, &category)["target"],
        200.0,
        "monthly override wins over newer default"
    );
    assert!(mcp_call_tool_error(
        &server,
        pat,
        &session,
        "commit_budget_change",
        stale["change"].clone()
    )
    .await
    .contains("refresh"));
    let historical = mcp_call_tool(
        &server,
        pat,
        &session,
        "get_budget",
        serde_json::json!({"periodKey":"2026-03"}),
    )
    .await;
    assert_eq!(
        budget_category(&historical["budget"], &category)["target"],
        300.0,
        "defaults also affect historical inheriting months"
    );
    let copied=reviewed_budget_change(&server,pat,&session,serde_json::json!({"operation":"copy_targets","sourcePeriodKey":"default","targetPeriodKey":"2026-04","overwrite":false}),"2026-04").await;
    assert_eq!(budget_category(&copied, &category)["target"], 200.0);
    let restored = reviewed_budget_change(
        &server,
        pat,
        &session,
        serde_json::json!({"operation":"remove_target","id":override_id}),
        "2026-04",
    )
    .await;
    assert_eq!(
        budget_category(&restored, &category)["target"],
        300.0,
        "remove override restores current default"
    );
    let copied=reviewed_budget_change(&server,pat,&session,serde_json::json!({"operation":"copy_targets","sourcePeriodKey":"default","targetPeriodKey":"2026-04","overwrite":true}),"2026-04").await;
    assert_eq!(budget_category(&copied, &category)["target"], 300.0);
    let native = category_api_get(&server, &cookie, "spending/budget?periodKey=2026-04").await;
    assert_eq!(
        native["computed"], copied["computed"],
        "native and MCP use the same calculator"
    );
    // Budget permission does not grant transaction organization.
    let denied = mcp_call_tool_error(
        &server,
        pat,
        &session,
        "commit_transaction_categories",
        serde_json::json!({"assignments":[]}),
    )
    .await;
    assert!(denied.contains("spending:write"));
}

#[tokio::test]
async fn reviewed_budget_groups_buffers_and_rollovers_preserve_atomic_native_operations() {
    let server = spawn_server(true, false).await;
    let cookie = login(&server).await;
    let (_, _, category, _, _) = category_save_fixture(&server, &cookie).await;
    let (_, token) = create_pat(
        &server,
        &cookie,
        serde_json::json!({"name":"Budget only","scopes":["spending:read","budget:write"]}),
    )
    .await;
    let pat = token["token"].as_str().unwrap();
    let session = mcp_initialize(&server, pat).await;
    let created = reviewed_budget_change(
        &server,
        pat,
        &session,
        serde_json::json!({"operation":"create_group","group":{"name":"Travel fund"}}),
        "2026-04",
    )
    .await;
    let group = created["state"]["groups"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["name"] == "Travel fund")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let other = created["state"]["groups"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["key"] == "other")
        .unwrap()["id"]
        .clone();
    reviewed_budget_change(&server,pat,&session,serde_json::json!({"operation":"update_group","id":group,"changes":{"name":"Trips","sortOrder":99}}),"2026-04").await;
    reviewed_budget_change(
        &server,
        pat,
        &session,
        serde_json::json!({"operation":"assign_category","categoryId":category,"groupId":group}),
        "2026-04",
    )
    .await;
    for (id, amount) in [
        (serde_json::json!(group), "20.25"),
        (other.clone(), "30.10"),
    ] {
        reviewed_budget_change(&server,pat,&session,serde_json::json!({"operation":"set_target","target":{"periodKey":"default","targetType":"group_buffer","groupId":id,"amount":amount}}),"2026-04").await;
    }
    let category_rollover = serde_json::json!({"operation":"set_rollover","setting":{"targetType":"category","taxonomyId":"spending_categories","categoryId":category,"enabled":true,"startMonth":"2026-04","startingBalance":"5.50"}});
    reviewed_budget_change(&server, pat, &session, category_rollover.clone(), "2026-04").await;
    let group_rollover=reviewed_budget_change(&server,pat,&session,serde_json::json!({"operation":"set_rollover","setting":{"targetType":"group","groupId":group,"enabled":true,"startMonth":"2026-04","startingBalance":"2.25"}}),"2026-04").await;
    let settings = group_rollover["state"]["rolloverSettings"]
        .as_array()
        .unwrap();
    assert_eq!(
        settings
            .iter()
            .find(|s| s["targetType"] == "category")
            .unwrap()["enabled"],
        false,
        "group activation disables category rollover in same writer operation"
    );
    assert!(mcp_call_tool_error(
        &server,
        pat,
        &session,
        "prepare_budget_change",
        serde_json::json!({"change":category_rollover})
    )
    .await
    .contains("rejected"));
    let group_setting = settings
        .iter()
        .find(|s| s["targetType"] == "group")
        .unwrap()["id"]
        .clone();
    reviewed_budget_change(
        &server,
        pat,
        &session,
        serde_json::json!({"operation":"remove_rollover","id":group_setting}),
        "2026-04",
    )
    .await;
    let deleted = reviewed_budget_change(
        &server,
        pat,
        &session,
        serde_json::json!({"operation":"delete_group","id":group,"reassignToGroupId":other}),
        "2026-04",
    )
    .await;
    assert!(!deleted["state"]["groups"]
        .as_array()
        .unwrap()
        .iter()
        .any(|g| g["id"] == group));
    assert_eq!(
        deleted["state"]["groupAssignments"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["categoryId"] == category)
            .unwrap()["groupId"],
        other
    );
    assert_eq!(
        deleted["state"]["targets"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["groupId"] == other)
            .unwrap()["amount"],
        "50.35"
    );
}

#[tokio::test]
async fn reviewed_spending_splits_rules_events_and_tags_roundtrip_without_activity_write_access() {
    let server = spawn_server(true, false).await;
    let cookie = login(&server).await;
    let (_, activities, first, second, _) = category_save_fixture(&server, &cookie).await;
    let (pat, session) = category_writer_session(&server, &cookie).await;
    let activity = activities[0]["id"].clone();
    let preview=mcp_call_tool(&server,&pat,&session,"prepare_spending_splits",serde_json::json!({"activityId":activity,"splits":[{"taxonomyId":"spending_categories","categoryId":first,"amount":"8.00","note":"Item"},{"taxonomyId":"spending_categories","categoryId":second,"amount":"4.50","note":"Tax and tip"}],"reviewNotes":"Receipt verified"})).await;
    assert_eq!(preview["valid"], true);
    assert_eq!(preview["remaining"], 0.0);
    let split = mcp_call_tool(
        &server,
        &pat,
        &session,
        "commit_spending_splits",
        preview["change"].clone(),
    )
    .await;
    assert_eq!(split["splits"].as_array().unwrap().len(), 2);
    assert!(!mcp_call_tool_error(
        &server,
        &pat,
        &session,
        "commit_spending_splits",
        preview["change"].clone()
    )
    .await
    .is_empty());
    let events = mcp_call_tool(
        &server,
        &pat,
        &session,
        "list_spending_events",
        serde_json::json!({}),
    )
    .await;
    let draft=mcp_call_tool(&server,&pat,&session,"prepare_spending_event",serde_json::json!({"event":{"name":"Trip","eventTypeId":events["eventTypes"][0]["id"],"startDate":"2026-06-01","endDate":"2026-06-10"}})).await;
    let event = mcp_call_tool(
        &server,
        &pat,
        &session,
        "commit_spending_event",
        draft["change"].clone(),
    )
    .await["created"]
        .clone();
    let tag = mcp_call_tool(
        &server,
        &pat,
        &session,
        "prepare_spending_event_tag",
        serde_json::json!({"activityId":activity,"eventId":event["id"]}),
    )
    .await;
    mcp_call_tool(
        &server,
        &pat,
        &session,
        "commit_spending_event_tag",
        tag["change"].clone(),
    )
    .await;
    // April purchase may be attached to the June event; no financial edit.
    let delete = mcp_call_tool(
        &server,
        &pat,
        &session,
        "prepare_spending_event",
        serde_json::json!({"eventId":event["id"],"event":null}),
    )
    .await;
    assert_eq!(delete["removedTagCount"], 1);
    let tag = mcp_call_tool(
        &server,
        &pat,
        &session,
        "prepare_spending_event_tag",
        serde_json::json!({"activityId":activities[1]["id"],"eventId":event["id"]}),
    )
    .await;
    mcp_call_tool(
        &server,
        &pat,
        &session,
        "commit_spending_event_tag",
        tag["change"].clone(),
    )
    .await;
    assert!(
        !mcp_call_tool_error(
            &server,
            &pat,
            &session,
            "commit_spending_event",
            delete["change"].clone()
        )
        .await
        .is_empty(),
        "new tag invalidates reviewed deletion"
    );
    let delete = mcp_call_tool(
        &server,
        &pat,
        &session,
        "prepare_spending_event",
        serde_json::json!({"eventId":event["id"],"event":null}),
    )
    .await;
    mcp_call_tool(
        &server,
        &pat,
        &session,
        "commit_spending_event",
        delete["change"].clone(),
    )
    .await;
    assert_eq!(
        category_splits(&server, &cookie, &activities[0])
            .await
            .as_array()
            .unwrap()
            .len(),
        2,
        "deleting event preserves splits"
    );
    let taxonomy = category_api_get(&server, &cookie, "taxonomies/spending_categories").await;
    let key = taxonomy["categories"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == first)
        .unwrap()["key"]
        .clone();
    let draft=mcp_call_tool(&server,&pat,&session,"create_categorization_rule",serde_json::json!({"pattern":"Synthetic merchant","taxonomyId":"spending_categories","categoryKey":key})).await;
    let saved = mcp_call_tool(
        &server,
        &pat,
        &session,
        "commit_categorization_rule",
        serde_json::json!({"rule":draft["rule"]}),
    )
    .await["created"]
        .clone();
    let preview = mcp_call_tool(
        &server,
        &pat,
        &session,
        "preview_categorization_rules",
        serde_json::json!({"onlyUncategorized":true}),
    )
    .await;
    assert_eq!(preview["summary"]["matched"], 2);
    assert_eq!(preview["summary"]["eligible"], 1);
    assert_eq!(preview["summary"]["protectedSplits"], 1);
    let ran = mcp_call_tool(
        &server,
        &pat,
        &session,
        "rerun_categorization_rules",
        serde_json::json!({}),
    )
    .await;
    assert_eq!(ran["matched"], 2);
    assert_eq!(ran["changed"], 1);
    assert_eq!(ran["protectedSplits"], 1);
    let reran = mcp_call_tool(
        &server,
        &pat,
        &session,
        "rerun_categorization_rules",
        serde_json::json!({"onlyUncategorized":false}),
    )
    .await;
    assert_eq!(reran["changed"], 0);
    assert_eq!(reran["unchanged"], 1);
    assert_eq!(reran["protectedSplits"], 1);
    mcp_call_tool(&server,&pat,&session,"commit_transaction_categories",serde_json::json!({"assignments":[{"activityId":activities[1]["id"],"taxonomyId":"spending_categories","categoryId":second}]})).await;
    let reran = mcp_call_tool(
        &server,
        &pat,
        &session,
        "rerun_categorization_rules",
        serde_json::json!({"onlyUncategorized":false}),
    )
    .await;
    assert_eq!(reran["changed"], 0);
    assert_eq!(reran["protectedManual"], 1);
    assert_eq!(reran["protectedSplits"], 1);
    let edit = mcp_call_tool(
        &server,
        &pat,
        &session,
        "prepare_categorization_rule_change",
        serde_json::json!({"ruleId":saved["id"],"changes":{"name":"Reviewed rule","priority":50}}),
    )
    .await;
    let updated = mcp_call_tool(
        &server,
        &pat,
        &session,
        "commit_categorization_rule_change",
        edit["change"].clone(),
    )
    .await;
    assert_eq!(updated["updated"]["priority"], 50);
    assert!(!mcp_call_tool_error(
        &server,
        &pat,
        &session,
        "commit_categorization_rule_change",
        edit["change"].clone()
    )
    .await
    .is_empty());
    let deletion = mcp_call_tool(
        &server,
        &pat,
        &session,
        "prepare_categorization_rule_change",
        serde_json::json!({"ruleId":saved["id"],"changes":null}),
    )
    .await;
    mcp_call_tool(
        &server,
        &pat,
        &session,
        "commit_categorization_rule_change",
        deletion["change"].clone(),
    )
    .await;
    let clear = mcp_call_tool(
        &server,
        &pat,
        &session,
        "prepare_spending_allocation_clear",
        serde_json::json!({"activityId":activity,"taxonomyId":"spending_categories"}),
    )
    .await;
    assert_eq!(clear["removedSplits"].as_array().unwrap().len(), 2);
    mcp_call_tool(
        &server,
        &pat,
        &session,
        "commit_spending_allocation_clear",
        clear["change"].clone(),
    )
    .await;
    assert!(category_splits(&server, &cookie, &activities[0])
        .await
        .as_array()
        .unwrap()
        .is_empty());
    assert!(
        !mcp_call_tool_error(
            &server,
            &pat,
            &session,
            "commit_spending_allocation_clear",
            clear["change"].clone()
        )
        .await
        .is_empty(),
        "replayed clear has stale evidence"
    );
}

#[tokio::test]
async fn spending_import_metadata_retries_saved_ids_without_reimporting_financial_rows() {
    let server = spawn_server(true, false).await;
    let cookie = login(&server).await;
    let (account, _, parent, _, _) = category_save_fixture(&server, &cookie).await;
    let child=api_post(&server,&cookie,"taxonomies/categories",serde_json::json!({"taxonomyId":"spending_categories","parentId":parent,"name":"Imported subcategory","key":"imported_child","color":"#123456","sortOrder":0})).await;
    let taxonomy = category_api_get(&server, &cookie, "taxonomies/spending_categories").await;
    let key = taxonomy["categories"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == parent)
        .unwrap()["key"]
        .clone();
    let (_,token)=create_pat(&server,&cookie,serde_json::json!({"name":"Import and organize","scopes":["activities:read","activities:draft","activities:write","spending:read","spending:write"]})).await;
    let pat = token["token"].as_str().unwrap();
    let session = mcp_initialize(&server, pat).await;
    let input = serde_json::json!({"activities":[{"date":"2026-05-10","activityType":"WITHDRAWAL","currency":"EUR","amount":42.25,"accountId":account["id"],"comment":"Imported synthetic purchase","lineNumber":2}]});
    mcp_call_tool(
        &server,
        pat,
        &session,
        "prepare_activity_import",
        input.clone(),
    )
    .await;
    let imported = mcp_call_tool(
        &server,
        pat,
        &session,
        "commit_activity_import",
        input.clone(),
    )
    .await;
    assert_eq!(imported["summary"]["imported"], 1);
    assert_eq!(imported["financialRows"][0]["financialStatus"], "imported");
    let id = imported["financialRows"][0]["activityId"].clone();
    assert!(
        stored_activities(&server, &cookie, &account)
            .await
            .iter()
            .any(|a| a["id"] == id),
        "reported saved ID must exist in SQLite"
    );
    let bad=mcp_call_tool(&server,pat,&session,"prepare_spending_import_metadata",serde_json::json!({"rows":[{"activityId":id,"taxonomyId":"spending_categories","categoryKey":key,"subcategoryKey":"imported_child","eventName":"Unknown event"}]})).await;
    assert_eq!(bad["rows"][0]["status"], "needs_review");
    assert!(
        bad["categoryAssignments"].as_array().unwrap().is_empty(),
        "unresolved rows never silently apply a successful half"
    );
    let mapped=mcp_call_tool(&server,pat,&session,"prepare_spending_import_metadata",serde_json::json!({"rows":[{"activityId":id,"taxonomyId":"spending_categories","categoryKey":key,"subcategoryKey":"imported_child"}]})).await;
    assert_eq!(mapped["rows"][0]["status"], "ready");
    assert_eq!(mapped["categoryAssignments"][0]["categoryId"], child["id"]);
    mcp_call_tool(
        &server,
        pat,
        &session,
        "commit_transaction_categories",
        serde_json::json!({"assignments":mapped["categoryAssignments"]}),
    )
    .await;
    assert_eq!(
        stored_activities(&server, &cookie, &account).await.len(),
        3,
        "metadata-only retry adds no financial rows"
    );
    let duplicate = mcp_call_tool(&server, pat, &session, "commit_activity_import", input).await;
    assert_eq!(duplicate["summary"]["imported"], 0);
    assert_eq!(
        duplicate["financialRows"][0]["financialStatus"],
        "duplicate_skipped"
    );
    assert_eq!(duplicate["financialRows"][0]["activityId"], id);
}

#[tokio::test]
async fn activity_write_reviews_split_loss_without_a_spending_grant_and_rejects_stale_review() {
    let server = spawn_server(true, false).await;
    let cookie = login(&server).await;
    let (_, activities, first, second, _) = category_save_fixture(&server, &cookie).await;
    let path = format!(
        "spending/activities/{}/splits",
        activities[0]["id"].as_str().unwrap()
    );
    let splits = serde_json::json!([{"taxonomyId":"spending_categories","categoryId":first,"amount":"8"},{"taxonomyId":"spending_categories","categoryId":second,"amount":"4.5"}]);
    api_put(&server, &cookie, &path, splits.clone()).await;
    let (pat, session) = activity_writer_session(&server, &cookie).await;
    let mut updates =
        serde_json::json!({"updates":[{"activityId":activities[0]["id"],"amount":"15"}]});
    let preview = mcp_call_tool(
        &server,
        &pat,
        &session,
        "prepare_activity_updates",
        updates.clone(),
    )
    .await;
    assert_eq!(preview["rows"][0]["status"], "ready", "{preview}");
    assert_eq!(preview["rows"][0]["splitReview"][0]["removedSplits"], 2);
    let evidence = serde_json::to_string(&preview["rows"][0]["splitReview"]).unwrap();
    assert!(!evidence.contains(&first));
    assert!(!evidence.contains(&second));
    let refused = mcp_call_tool(
        &server,
        &pat,
        &session,
        "commit_activity_updates",
        updates.clone(),
    )
    .await;
    assert_eq!(refused["updated"].as_array().unwrap().len(), 0);
    updates["updates"][0]["splitReview"] = preview["rows"][0]["splitReview"].clone();
    api_put(&server, &cookie, &path, splits).await; // new split state since review
    let stale = mcp_call_tool(
        &server,
        &pat,
        &session,
        "commit_activity_updates",
        updates.clone(),
    )
    .await;
    assert_eq!(stale["updated"].as_array().unwrap().len(), 0, "{stale}");
    assert_eq!(
        category_splits(&server, &cookie, &activities[0])
            .await
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let fresh = mcp_call_tool(
        &server,
        &pat,
        &session,
        "prepare_activity_updates",
        updates.clone(),
    )
    .await;
    updates["updates"][0]["splitReview"] = fresh["rows"][0]["splitReview"].clone();
    let saved = mcp_call_tool(&server, &pat, &session, "commit_activity_updates", updates).await;
    assert_eq!(saved["errors"], serde_json::json!([]), "{saved}");
    assert_eq!(saved["updated"].as_array().unwrap().len(), 1);
    assert!(category_splits(&server, &cookie, &activities[0])
        .await
        .as_array()
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn reviewed_asset_multiplier_swaps_succeed_through_mcp_single_and_bulk_native_updates() {
    let server = spawn_server(true, false).await;
    let cookie = login(&server).await;
    disable_market_data_providers(&server, &cookie).await;
    let account = create_eur_account(&server, &cookie, "Reviewed multiplier edits").await;
    let mut assets = Vec::new();
    for (kind, symbol, multiplier) in [
        ("EQUITY", "ZZREVIEWSTOCK", 1),
        ("OPTION", "ZZREVIEWOPTION", 100),
    ] {
        assets.push(api_post(&server,&cookie,"assets",serde_json::json!({"kind":"INVESTMENT","name":symbol,"instrumentSymbol":symbol,"instrumentType":kind,"quoteCcy":"EUR","quoteMode":"MANUAL","metadata":{"contractMultiplier":multiplier}})).await);
    }
    let (pat, session) = activity_writer_session(&server, &cookie).await;
    for mode in ["mcp", "single", "bulk"] {
        let activity=api_post(&server,&cookie,"activities",serde_json::json!({"accountId":account["id"],"activityType":"BUY","activityDate":"2026-04-01T12:00:00Z","currency":"EUR","asset":{"id":assets[0]["id"]},"quantity":"1","unitPrice":"2","notes":format!("Multiplier review {mode}")})).await;
        if mode == "mcp" {
            let mut args = serde_json::json!({"updates":[{"activityId":activity["id"],"assetId":assets[1]["id"]}]});
            let preview = mcp_call_tool(
                &server,
                &pat,
                &session,
                "prepare_activity_updates",
                args.clone(),
            )
            .await;
            assert_eq!(preview["rows"][0]["status"], "ready", "{preview}");
            args["updates"][0]["splitReview"] = preview["rows"][0]["splitReview"].clone();
            let result =
                mcp_call_tool(&server, &pat, &session, "commit_activity_updates", args).await;
            assert_eq!(result["errors"], serde_json::json!([]), "{result}");
            assert_eq!(result["updated"].as_array().unwrap().len(), 1);
        } else {
            let mut update = serde_json::json!({"id":activity["id"],"accountId":account["id"],"activityType":"BUY","activityDate":"2026-04-01T12:00:00Z","currency":"EUR","asset":{"id":assets[1]["id"]},"notes":format!("Multiplier review {mode}")});
            let review = api_post(
                &server,
                &cookie,
                "activities/split-effects",
                serde_json::json!([update.clone()]),
            )
            .await;
            assert_eq!(review[0][0]["removedSplits"], 0);
            update["splitReview"] = review[0].clone();
            if mode == "single" {
                api_put(&server, &cookie, "activities", update).await;
            } else {
                let result = api_post(
                    &server,
                    &cookie,
                    "activities/bulk",
                    serde_json::json!({"creates":[],"updates":[update],"deleteIds":[]}),
                )
                .await;
                assert_eq!(result["errors"], serde_json::json!([]), "{result}");
            }
        }
        let stored = stored_activities(&server, &cookie, &account).await;
        let updated = activity_by_id(&stored, &activity["id"]);
        assert_eq!(updated["amount"], "200", "{mode}: {updated}");
    }
    // A cash -> trade edit with a new symbol has no allocations to preview.
    // The read must leave symbol resolution to the existing native write path.
    let cash=api_post(&server,&cookie,"activities",serde_json::json!({"accountId":account["id"],"activityType":"DEPOSIT","activityDate":"2026-04-02T12:00:00Z","currency":"EUR","amount":"2"})).await;
    let review=api_post(&server,&cookie,"activities/split-effects",serde_json::json!([{"id":cash["id"],"accountId":account["id"],"activityType":"BUY","activityDate":"2026-04-02T12:00:00Z","currency":"EUR","asset":{"symbol":"ZZNEWSYMBOL","kind":"SECURITY","instrumentType":"EQUITY","quoteMode":"MANUAL"},"quantity":"1","unitPrice":"2"}])).await;
    assert_eq!(review[0][0]["removedSplits"], 0);
}

#[tokio::test]
async fn review_followup_split_cash_to_new_symbol_trade_preserves_native_edits() {
    let server = spawn_server(true, false).await;
    let cookie = login(&server).await;
    let (_, activities, first, second, _) = category_save_fixture(&server, &cookie).await;
    let securities = create_eur_account(&server, &cookie, "Moved split trade").await;
    api_put(&server,&cookie,&format!("spending/activities/{}/splits",activities[0]["id"].as_str().unwrap()),serde_json::json!([{"taxonomyId":"spending_categories","categoryId":first,"amount":"8"},{"taxonomyId":"spending_categories","categoryId":second,"amount":"4.5"}])).await;
    let mut update = serde_json::json!({"id":activities[0]["id"],"accountId":securities["id"],"activityType":"BUY","activityDate":"2026-04-01T12:00:00Z","currency":"EUR","asset":{"symbol":"ZZSPLITTRADE","kind":"SECURITY","instrumentType":"EQUITY","quoteMode":"MANUAL"},"quantity":"1","unitPrice":"10","amount":null});
    let review = api_post(
        &server,
        &cookie,
        "activities/split-effects",
        serde_json::json!([update.clone()]),
    )
    .await;
    assert_eq!(review[0][0]["removedSplits"], 2, "{review}");
    update["splitReview"] = review[0].clone();
    let saved = api_put(&server, &cookie, "activities", update.clone()).await;
    assert_eq!(saved["accountId"], securities["id"]);
    assert!(saved["assetId"].as_str().is_some(), "{saved}");
    update["asset"] = serde_json::json!({"id":saved["assetId"]});
    update["amount"] = serde_json::json!("11");
    let after = api_post(
        &server,
        &cookie,
        "activities/split-effects",
        serde_json::json!([update]),
    )
    .await;
    assert_eq!(
        after[0][0]["removedSplits"], 0,
        "splits cleared by the existing financial writer: {after}"
    );
}

#[tokio::test]
async fn review_followup_native_legacy_event_dates_keep_their_validation_contract() {
    let server = spawn_server(true, false).await;
    let cookie = login(&server).await;
    let types = category_api_get(&server, &cookie, "spending/event-types").await;
    let event = serde_json::json!({"name":"Legacy date event","eventTypeId":types[0]["id"],"startDate":"2026-06-01T00:00:00","endDate":"2026-06-02T00:00:00"});
    let saved = api_post(&server, &cookie, "spending/events", event.clone()).await;
    assert_eq!(saved["startDate"], event["startDate"]);
    let (pat, session) = category_writer_session(&server, &cookie).await;
    let error = mcp_call_tool_error(
        &server,
        &pat,
        &session,
        "prepare_spending_event",
        serde_json::json!({"eventId":saved["id"],"event":event}),
    )
    .await;
    assert!(!error.contains("2026-06-01"), "{error}");
}

#[tokio::test]
async fn reviewed_budget_group_patches_preserve_omissions_and_allow_explicit_clears() {
    let server = spawn_server(true, false).await;
    let cookie = login(&server).await;
    category_save_fixture(&server, &cookie).await;
    let (_, token) = create_pat(
        &server,
        &cookie,
        serde_json::json!({"name":"review","scopes":["spending:read","budget:write"]}),
    )
    .await;
    let pat = token["token"].as_str().unwrap();
    let session = mcp_initialize(&server, pat).await;
    let created=reviewed_budget_change(&server,pat,&session,serde_json::json!({"operation":"create_group","group":{"name":"Appearance","color":"#123456","icon":"Plane"}}),"2026-04").await;
    let group = created["state"]["groups"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["name"] == "Appearance")
        .unwrap();
    assert_eq!(group["color"], "#123456");
    assert_eq!(group["icon"], "Plane");
    let renamed=reviewed_budget_change(&server,pat,&session,serde_json::json!({"operation":"update_group","id":group["id"],"changes":{"name":"Renamed","sortOrder":99}}),"2026-04").await;
    let after = renamed["state"]["groups"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["id"] == group["id"])
        .unwrap();
    assert_eq!(after["name"], "Renamed");
    assert_eq!(after["color"], "#123456");
    assert_eq!(after["icon"], "Plane");
    let cleared=reviewed_budget_change(&server,pat,&session,serde_json::json!({"operation":"update_group","id":group["id"],"changes":{"color":null,"icon":null}}),"2026-04").await;
    let final_group = cleared["state"]["groups"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["id"] == group["id"])
        .unwrap();
    assert!(final_group["color"].is_null());
    assert!(final_group["icon"].is_null());
    assert_eq!(final_group["name"], "Renamed");
    assert_eq!(final_group["sortOrder"], 99);
}

#[tokio::test]
async fn spending_reads_preserve_exact_split_evidence_for_category_replacement() {
    let server = spawn_server(true, false).await;
    let cookie = login(&server).await;
    let (_, activities, first, second, _) = category_save_fixture(&server, &cookie).await;
    let (pat, session) = category_writer_session(&server, &cookie).await;
    let id = activities[0]["id"].as_str().unwrap();
    let path = format!("spending/activities/{id}/splits");
    let lines = serde_json::json!([
        {"taxonomyId":"spending_categories","categoryId":first,"amount":"1.234567890123456789"},
        {"taxonomyId":"spending_categories","categoryId":second,"amount":"11.265432109876543211"}
    ]);
    api_put(&server, &cookie, &path, lines.clone()).await;
    let found = mcp_call_tool(
        &server,
        &pat,
        &session,
        "search_spending_transactions",
        serde_json::json!({"activityIds":[id]}),
    )
    .await;
    let splits = found["items"][0]["splits"].clone();
    for rows in [&splits, &found["items"][0]["effectiveAllocations"]] {
        assert_eq!(rows.as_array().unwrap().len(), 2);
        assert!(rows
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["amount"].is_string()));
        assert_eq!(
            rows.as_array()
                .unwrap()
                .iter()
                .find(|row| row["categoryId"] == first)
                .unwrap()["amount"],
            "1.234567890123456789"
        );
    }
    let result = mcp_call_tool(
        &server, &pat, &session, "commit_transaction_categories",
        serde_json::json!({"assignments":[{"activityId":id,"taxonomyId":"spending_categories","categoryId":first,"expectedSplits":splits}]}),
    ).await;
    assert_eq!(result["draftStatus"], "applied");
    assert_eq!(result["assignmentCount"], 1);
    assert!(category_splits(&server, &cookie, &activities[0])
        .await
        .as_array()
        .unwrap()
        .is_empty());

    // The native/addon read is replacement evidence too. Returning a JSON
    // number here would make the same exact comparison fail after rounding.
    api_put(&server, &cookie, &path, lines).await;
    let native = category_splits(&server, &cookie, &activities[0]).await;
    assert_eq!(
        native
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["categoryId"] == first)
            .unwrap()["amount"],
        "1.234567890123456789"
    );
    api_post(&server, &cookie, "spending/assignments/bulk", serde_json::json!([{
        "activityId":id, "taxonomyId":"spending_categories", "categoryId":second, "expectedSplits":native
    }])).await;
    assert!(category_splits(&server, &cookie, &activities[0])
        .await
        .as_array()
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn reviewed_external_transfer_edit_is_atomic_and_preserves_the_other_legs_economics() {
    let server = spawn_server(true, false).await;
    let cookie = login(&server).await;
    let (cash, _, first, _, _) = category_save_fixture(&server, &cookie).await;
    let securities = create_eur_account(&server, &cookie, "Atomic transfer destination").await;
    let outgoing = api_post(&server,&cookie,"activities",serde_json::json!({"accountId":cash["id"],"activityType":"TRANSFER_OUT","activityDate":"2026-04-01T12:00:00Z","currency":"EUR","amount":"12.50","metadata":"{\"flow\":{\"is_external\":true}}"})).await;
    let incoming = api_post(&server,&cookie,"activities",serde_json::json!({"accountId":securities["id"],"activityType":"TRANSFER_IN","activityDate":"2026-04-01T12:00:00Z","currency":"EUR","amount":"12.50","metadata":"{\"flow\":{\"is_external\":true}}"})).await;
    let (pat, session) = activity_writer_session(&server, &cookie).await;
    let link = mcp_call_tool(
        &server,
        &pat,
        &session,
        "link_transfer_activities",
        serde_json::json!({"pairs":[{"activityAId":outgoing["id"],"activityBId":incoming["id"]}]}),
    )
    .await;
    assert_eq!(link["errors"], serde_json::json!([]));
    let profile = api_post(
        &server,
        &cookie,
        "profiles/get_profile_state",
        serde_json::json!({}),
    )
    .await;
    let path = server
        ._tmp
        .path()
        .join("profiles")
        .join(profile["session"]["profileId"].as_str().unwrap())
        .join("app.db");
    let db = wealthfolio_storage_sqlite::db::DbAccess::plaintext(path.to_str().unwrap())
        .connect_rusqlite()
        .unwrap();
    // Legacy allocations can survive linking or an account/type change. The
    // financial edit removes only the edited row's splits; unlink alone retains them.
    for (id, activity) in [("out-allocation", &outgoing), ("in-allocation", &incoming)] {
        db.execute("INSERT INTO spending_activity_splits (id,activity_id,taxonomy_id,category_id,amount,sort_order,created_at,updated_at) VALUES (?1,?2,'spending_categories',?3,'12.5',0,'2026-04-01T12:00:00Z','2026-04-01T12:00:00Z')",[id,activity["id"].as_str().unwrap(),first.as_str()]).unwrap();
    }
    db.execute(
        "UPDATE activities SET status='DRAFT', needs_review=1 WHERE id IN (?1,?2)",
        [
            outgoing["id"].as_str().unwrap(),
            incoming["id"].as_str().unwrap(),
        ],
    )
    .unwrap();
    let mut update = serde_json::json!({"id":outgoing["id"],"accountId":cash["id"],"activityType":"TRANSFER_OUT","activityDate":"2026-04-01T12:00:00Z","currency":"EUR","amount":"25","status":"POSTED","needsReview":false,"unlinkTransferPairId":incoming["id"],"metadata":"{\"flow\":{\"is_external\":true}}"});
    let review = api_post(
        &server,
        &cookie,
        "activities/split-effects",
        serde_json::json!([update.clone()]),
    )
    .await;
    assert_eq!(review[0].as_array().unwrap().len(), 2);
    assert_eq!(review[0][0]["removedSplits"], 1);
    assert_eq!(review[0][1]["removedSplits"], 0);
    update["splitReview"] = review[0].clone();
    // Change only the other leg after review. Its guard is checked inside the
    // transaction: failure must leave both legs, allocations and outbox unchanged.
    db.execute(
        "UPDATE activities SET notes='Changed counterpart' WHERE id=?1",
        [incoming["id"].as_str().unwrap()],
    )
    .unwrap();
    let outbox = || {
        db.query_row("SELECT COUNT(*) FROM sync_outbox", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap()
    };
    let before_outbox = outbox();
    let before_rowid: i64 = db
        .query_row(
            "SELECT COALESCE(MAX(rowid),0) FROM sync_outbox",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let response = server
        .client
        .put(format!("{}/api/v1/activities", server.base))
        .header(header::COOKIE, format!("wf_session={cookie}"))
        .json(&update)
        .send()
        .await
        .unwrap();
    assert!(!response.status().is_success());
    assert_eq!(outbox(), before_outbox);
    for row in [&outgoing, &incoming] {
        let group: Option<String> = db
            .query_row(
                "SELECT source_group_id FROM activities WHERE id=?1",
                [row["id"].as_str().unwrap()],
                |row| row.get(0),
            )
            .unwrap();
        assert!(group.is_some());
    }
    let amount: String = db
        .query_row(
            "SELECT amount FROM activities WHERE id=?1",
            [outgoing["id"].as_str().unwrap()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        amount.parse::<rust_decimal::Decimal>().unwrap(),
        "12.5".parse::<rust_decimal::Decimal>().unwrap()
    );
    let count: i64 = db
        .query_row("SELECT COUNT(*) FROM spending_activity_splits", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(count, 2);
    let fresh = api_post(
        &server,
        &cookie,
        "activities/split-effects",
        serde_json::json!([update.clone()]),
    )
    .await;
    update["splitReview"] = fresh[0].clone();
    api_put(&server, &cookie, "activities", update).await;
    for row in [&outgoing, &incoming] {
        let group: Option<String> = db
            .query_row(
                "SELECT source_group_id FROM activities WHERE id=?1",
                [row["id"].as_str().unwrap()],
                |row| row.get(0),
            )
            .unwrap();
        assert!(group.is_none());
    }
    let rows = stored_activities(&server, &cookie, &securities).await;
    let other = activity_by_id(&rows, &incoming["id"]);
    assert_eq!(
        other["amount"]
            .as_str()
            .unwrap()
            .parse::<rust_decimal::Decimal>()
            .unwrap(),
        "12.5".parse::<rust_decimal::Decimal>().unwrap()
    );
    assert_eq!(other["comment"], "Changed counterpart");
    let lifecycle: (String, bool) = db
        .query_row(
            "SELECT status,needs_review FROM activities WHERE id=?1",
            [incoming["id"].as_str().unwrap()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(lifecycle, ("DRAFT".to_string(), true));
    let payloads: Vec<String> = db
        .prepare(
            "SELECT payload FROM sync_outbox WHERE rowid>?1 AND entity='activity' ORDER BY rowid",
        )
        .unwrap()
        .query_map([before_rowid], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(payloads.len(), 2, "one final-state update per leg");
    for payload in payloads {
        let row: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert!(row["source_group_id"].is_null());
        let metadata: serde_json::Value =
            serde_json::from_str(row["metadata"].as_str().unwrap()).unwrap();
        assert_eq!(metadata["flow"]["is_external"], true);
        assert_eq!(
            row["amount"]
                .as_str()
                .unwrap()
                .parse::<rust_decimal::Decimal>()
                .unwrap(),
            if row["id"] == outgoing["id"] {
                "25"
            } else {
                "12.5"
            }
            .parse::<rust_decimal::Decimal>()
            .unwrap()
        );
    }
    let remaining: Vec<String> = db
        .prepare("SELECT activity_id FROM spending_activity_splits")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        remaining,
        vec![incoming["id"].as_str().unwrap().to_string()]
    );
}

#[tokio::test]
async fn transfer_edits_preserve_classification_and_unlink_only_counterpart_fields() {
    let server = spawn_server(true, false).await;
    let cookie = login(&server).await;
    let (cash, _, category, _, _) = category_save_fixture(&server, &cookie).await;
    let destination = create_eur_account(&server, &cookie, "Counterpart preservation").await;
    let profile = api_post(
        &server,
        &cookie,
        "profiles/get_profile_state",
        serde_json::json!({}),
    )
    .await;
    let path = server
        ._tmp
        .path()
        .join("profiles")
        .join(profile["session"]["profileId"].as_str().unwrap())
        .join("app.db");
    let db = wealthfolio_storage_sqlite::db::DbAccess::plaintext(path.to_str().unwrap())
        .connect_rusqlite()
        .unwrap();
    db.execute(
        "UPDATE accounts SET provider_account_id='preservation-provider' WHERE id=?1",
        [destination["id"].as_str().unwrap()],
    )
    .unwrap();
    let database_rows = |sql: &str, id: &str| -> Vec<serde_json::Value> {
        let mut statement = db.prepare(sql).unwrap();
        let columns: Vec<String> = statement
            .column_names()
            .iter()
            .map(|name| name.to_string())
            .collect();
        statement
            .query_map([id], |row| {
                let mut object = serde_json::Map::new();
                for (index, name) in columns.iter().enumerate() {
                    let value = row.get_ref(index)?;
                    let value = if let Ok(value) = value.as_str() {
                        serde_json::json!(value)
                    } else if let Ok(value) = value.as_i64() {
                        serde_json::json!(value)
                    } else if let Ok(value) = value.as_f64() {
                        serde_json::json!(value)
                    } else {
                        serde_json::Value::Null
                    };
                    object.insert(name.clone(), value);
                }
                Ok(serde_json::Value::Object(object))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    };
    db.execute(
        "UPDATE accounts SET provider_account_id='preservation-primary-provider' WHERE id=?1",
        [cash["id"].as_str().unwrap()],
    )
    .unwrap();
    let mut case = 0;
    for unlink in [true, false] {
        for (edited_broker, broker) in [(false, true), (false, false), (true, false), (true, true)]
        {
            for primary_type in ["TRANSFER_OUT", "TRANSFER_IN"] {
                for allocations in ["both", "counterpart", "none"] {
                    for bulk in [false, true] {
                        case += 1;
                        let activity_date = (chrono::NaiveDate::from_ymd_opt(2026, 4, 1).unwrap()
                            + chrono::Duration::days(case))
                        .format("%Y-%m-%dT12:00:00Z")
                        .to_string();
                        let other_type = if primary_type == "TRANSFER_OUT" {
                            "TRANSFER_IN"
                        } else {
                            "TRANSFER_OUT"
                        };
                        let primary = api_post(&server, &cookie, "activities", serde_json::json!({
                        "accountId":cash["id"],"activityType":primary_type,"activityDate":activity_date,"currency":"EUR","amount":"12.50","metadata":"{\"flow\":{\"is_external\":true}}"
                    })).await;
                        let other = api_post(&server, &cookie, "activities", serde_json::json!({
                        "accountId":destination["id"],"activityType":other_type,"activityDate":activity_date,"currency":"EUR","amount":"12.50","metadata":"{\"flow\":{\"is_external\":true}}"
                    })).await;
                        let primary_id = primary["id"].as_str().unwrap();
                        let other_id = other["id"].as_str().unwrap();
                        api_post(
                            &server,
                            &cookie,
                            "activities/link",
                            serde_json::json!({"activityAId":primary_id,"activityBId":other_id}),
                        )
                        .await;
                        if edited_broker {
                            let primary_raw = if primary_type == "TRANSFER_IN" {
                                "DEPOSIT"
                            } else {
                                "WITHDRAWAL"
                            };
                            db.execute("UPDATE activities SET activity_type=?1,activity_type_override=?2,source_system='SNAPTRADE',source_record_id=?3 WHERE id=?4",[primary_raw,primary_type,format!("primary-record-{case}").as_str(),primary_id]).unwrap();
                        }
                        // Reclassified broker and manual rows must retain BOTH raw and effective types.
                        let record_id = format!("preservation-record-{case}");
                        let raw = if other_type == "TRANSFER_IN" {
                            "DEPOSIT"
                        } else {
                            "WITHDRAWAL"
                        };
                        db.execute("UPDATE activities SET activity_type=?1,activity_type_override=?2,source_system=?3,source_record_id=?4,notes='Counterpart note',status='DRAFT',needs_review=1,fee='0.10',tax='0.20' WHERE id=?5", [Some(raw),Some(other_type),Some(if broker {"SNAPTRADE"} else {"MANUAL"}),if broker {Some(record_id.as_str())} else {None},Some(other_id)]).unwrap();
                        for (id, include) in [
                            (primary_id, allocations == "both"),
                            (other_id, allocations != "none"),
                        ] {
                            if include {
                                db.execute("INSERT INTO spending_activity_splits(id,activity_id,taxonomy_id,category_id,amount,note,sort_order,created_at,updated_at) VALUES(?1,?2,'spending_categories',?3,'12.50','Keep allocation',0,'2026-04-01','2026-04-01')",[format!("preserve-{case}-{id}").as_str(),id,category.as_str()]).unwrap();
                            }
                        }
                        let mut update = serde_json::json!({"id":primary_id,"accountId":cash["id"],"activityType":primary_type,"activityDate":activity_date,"currency":"EUR","amount":"25","notes":"Primary edit","unlinkTransferPairId":other_id,"metadata":"{\"flow\":{\"is_external\":true}}"});
                        if !unlink {
                            let object = update.as_object_mut().unwrap();
                            object.remove("unlinkTransferPairId");
                            object.remove("metadata");
                            update["amount"] = serde_json::json!("12.50");
                        }
                        let review = api_post(
                            &server,
                            &cookie,
                            "activities/split-effects",
                            serde_json::json!([update.clone()]),
                        )
                        .await;
                        update["splitReview"] = review[0].clone();
                        let primary_before =
                            database_rows("SELECT * FROM activities WHERE id=?1", primary_id);
                        let splits_before = database_rows(
                            "SELECT * FROM spending_activity_splits WHERE activity_id=?1",
                            other_id,
                        );
                        db.execute(
                            "UPDATE activities SET notes='Concurrent counterpart edit' WHERE id=?1",
                            [other_id],
                        )
                        .unwrap();
                        let counterpart_before =
                            database_rows("SELECT * FROM activities WHERE id=?1", other_id);
                        let before_rowid: i64 = db
                            .query_row(
                                "SELECT COALESCE(MAX(rowid),0) FROM sync_outbox",
                                [],
                                |row| row.get(0),
                            )
                            .unwrap();
                        let request = if bulk {
                            server
                                .client
                                .post(format!("{}/api/v1/activities/bulk", server.base))
                                .json(&serde_json::json!({"updates":[update.clone()]}))
                        } else {
                            server
                                .client
                                .put(format!("{}/api/v1/activities", server.base))
                                .json(&update)
                        };
                        let response = request
                            .header(header::COOKIE, format!("wf_session={cookie}"))
                            .send()
                            .await
                            .unwrap();
                        let status = response.status();
                        let body: serde_json::Value = response.json().await.unwrap();
                        assert!(
                            !status.is_success()
                                || body["errors"]
                                    .as_array()
                                    .is_some_and(|rows| !rows.is_empty()),
                            "stale counterpart must reject {case}"
                        );
                        assert_eq!(
                            database_rows("SELECT * FROM activities WHERE id=?1", primary_id),
                            primary_before
                        );
                        assert_eq!(
                            database_rows(
                                "SELECT * FROM spending_activity_splits WHERE activity_id=?1",
                                other_id
                            ),
                            splits_before
                        );
                        assert_eq!(
                            db.query_row(
                                "SELECT COUNT(*) FROM sync_outbox WHERE rowid>?1",
                                [before_rowid],
                                |row| row.get::<_, i64>(0)
                            )
                            .unwrap(),
                            0
                        );
                        let review = api_post(
                            &server,
                            &cookie,
                            "activities/split-effects",
                            serde_json::json!([update.clone()]),
                        )
                        .await;
                        update["splitReview"] = review[0].clone();
                        if bulk {
                            let result = api_post(
                                &server,
                                &cookie,
                                "activities/bulk",
                                serde_json::json!({"updates":[update]}),
                            )
                            .await;
                            assert_eq!(result["errors"], serde_json::json!([]));
                            assert_eq!(result["updated"].as_array().unwrap().len(), 2);
                        } else {
                            api_put(&server, &cookie, "activities", update).await;
                        }
                        let mut expected = counterpart_before[0].clone();
                        let mut actual =
                            database_rows("SELECT * FROM activities WHERE id=?1", other_id)
                                .remove(0);
                        assert_eq!(actual["source_group_id"].is_null(), unlink);
                        if !unlink {
                            assert_eq!(actual["source_group_id"], expected["source_group_id"]);
                        }
                        if !unlink && !edited_broker && !broker {
                            expected["notes"] = serde_json::json!("Primary edit");
                        }
                        assert_eq!(actual["is_user_modified"], 1);
                        let mut expected_metadata: serde_json::Value =
                            serde_json::from_str(expected["metadata"].as_str().unwrap()).unwrap();
                        if unlink {
                            expected_metadata["flow"]["is_external"] = serde_json::json!(true);
                        }
                        assert_eq!(
                            serde_json::from_str::<serde_json::Value>(
                                actual["metadata"].as_str().unwrap()
                            )
                            .unwrap(),
                            expected_metadata
                        );
                        for field in [
                            "source_group_id",
                            "metadata",
                            "updated_at",
                            "is_user_modified",
                        ] {
                            expected.as_object_mut().unwrap().remove(field);
                            actual.as_object_mut().unwrap().remove(field);
                        }
                        assert_eq!(
                            actual, expected,
                            "unlink-only counterpart changed in case {case}"
                        );
                        assert_eq!(
                            database_rows(
                                "SELECT * FROM spending_activity_splits WHERE activity_id=?1",
                                other_id
                            ),
                            splits_before
                        );
                        assert_eq!(
                            review[0]
                                .as_array()
                                .unwrap()
                                .iter()
                                .find(|effect| effect["activityId"] == other_id)
                                .unwrap()["removedSplits"],
                            0
                        );
                        let primary_after =
                            database_rows("SELECT * FROM activities WHERE id=?1", primary_id)
                                .remove(0);
                        assert_eq!(primary_after["source_group_id"].is_null(), unlink);
                        assert_eq!(
                            primary_after["activity_type"],
                            primary_before[0]["activity_type"]
                        );
                        assert_eq!(
                            primary_after["activity_type_override"],
                            primary_before[0]["activity_type_override"]
                        );
                        assert_eq!(
                            primary_after["amount"]
                                .as_str()
                                .unwrap()
                                .parse::<rust_decimal::Decimal>()
                                .unwrap(),
                            if unlink {
                                rust_decimal::Decimal::from(25)
                            } else {
                                "12.50".parse::<rust_decimal::Decimal>().unwrap()
                            }
                        );
                        assert_eq!(
                        db.query_row(
                            "SELECT COUNT(*) FROM spending_activity_splits WHERE activity_id=?1",
                            [primary_id],
                            |row| row.get::<_, i64>(0)
                        )
                        .unwrap(),
                        if !unlink && allocations=="both" { 1 } else { 0 }
                    );
                        if broker {
                            assert_eq!(db.query_row("SELECT COUNT(*) FROM sync_outbox WHERE rowid>?1 AND entity='broker_activity_user_patch' AND json_extract(payload,'$.source_record_id')=?2",(before_rowid,record_id.as_str()),|row|row.get::<_,i64>(0)).unwrap(),0);
                        }
                    }
                }
            }
        }
    }
}

#[tokio::test]
async fn paired_unlink_rejects_unreviewed_or_ambiguous_requests_without_writes() {
    let server = spawn_server(true, false).await;
    let cookie = login(&server).await;
    let (cash, _, _, _, _) = category_save_fixture(&server, &cookie).await;
    let destination = create_eur_account(&server, &cookie, "Unlink request validation").await;
    let primary = api_post(&server,&cookie,"activities",serde_json::json!({"accountId":cash["id"],"activityType":"TRANSFER_OUT","activityDate":"2026-04-02T12:00:00Z","currency":"EUR","amount":"12.50","metadata":"{\"flow\":{\"is_external\":true}}"})).await;
    let other = api_post(&server,&cookie,"activities",serde_json::json!({"accountId":destination["id"],"activityType":"TRANSFER_IN","activityDate":"2026-04-02T12:00:00Z","currency":"EUR","amount":"12.50","metadata":"{\"flow\":{\"is_external\":true}}"})).await;
    let primary_id = primary["id"].as_str().unwrap();
    let other_id = other["id"].as_str().unwrap();
    api_post(
        &server,
        &cookie,
        "activities/link",
        serde_json::json!({"activityAId":primary_id,"activityBId":other_id}),
    )
    .await;
    let profile = api_post(
        &server,
        &cookie,
        "profiles/get_profile_state",
        serde_json::json!({}),
    )
    .await;
    let path = server
        ._tmp
        .path()
        .join("profiles")
        .join(profile["session"]["profileId"].as_str().unwrap())
        .join("app.db");
    let db = wealthfolio_storage_sqlite::db::DbAccess::plaintext(path.to_str().unwrap())
        .connect_rusqlite()
        .unwrap();
    let snapshot = || {
        db.prepare("SELECT json_object('id',id,'group',source_group_id,'amount',amount,'notes',notes,'metadata',metadata,'updated',updated_at) FROM activities WHERE id IN (?1,?2) ORDER BY id").unwrap().query_map([primary_id,other_id],|row|row.get::<_,String>(0)).unwrap().collect::<Result<Vec<_>,_>>().unwrap()
    };
    let before = snapshot();
    let outbox_before: i64 = db
        .query_row("SELECT COUNT(*) FROM sync_outbox", [], |row| row.get(0))
        .unwrap();
    let unreviewed = serde_json::json!({"id":primary_id,"accountId":cash["id"],"activityType":"TRANSFER_OUT","activityDate":"2026-04-02T12:00:00Z","currency":"EUR","amount":"25","unlinkTransferPairId":other_id,"metadata":"{\"flow\":{\"is_external\":true}}"});
    let review = api_post(
        &server,
        &cookie,
        "activities/split-effects",
        serde_json::json!([unreviewed.clone()]),
    )
    .await;
    assert_eq!(review[0].as_array().unwrap().len(), 2);
    let mut reviewed = unreviewed.clone();
    reviewed["splitReview"] = review[0].clone();
    let mut missing_other = reviewed.clone();
    missing_other["splitReview"] = serde_json::json!([review[0][0]]);
    let mut duplicate_other = reviewed.clone();
    duplicate_other["splitReview"]
        .as_array_mut()
        .unwrap()
        .push(review[0][1].clone());
    for update in [unreviewed, missing_other, duplicate_other] {
        let response = server
            .client
            .put(format!("{}/api/v1/activities", server.base))
            .header(header::COOKIE, format!("wf_session={cookie}"))
            .json(&update)
            .send()
            .await
            .unwrap();
        assert!(!response.status().is_success());
        assert_eq!(snapshot(), before);
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM sync_outbox", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            outbox_before
        );
    }
    let other_update = serde_json::json!({"id":other_id,"accountId":destination["id"],"activityType":"TRANSFER_IN","activityDate":"2026-04-02T12:00:00Z","currency":"EUR","amount":"99"});
    for request in [
        serde_json::json!({"updates":[reviewed.clone(),reviewed.clone()]}),
        serde_json::json!({"updates":[reviewed.clone(),other_update]}),
        serde_json::json!({"updates":[reviewed],"deleteIds":[other_id]}),
    ] {
        let response = server
            .client
            .post(format!("{}/api/v1/activities/bulk", server.base))
            .header(header::COOKIE, format!("wf_session={cookie}"))
            .json(&request)
            .send()
            .await
            .unwrap();
        let status = response.status();
        let body: serde_json::Value = response.json().await.unwrap();
        assert!(
            !status.is_success()
                || body["errors"]
                    .as_array()
                    .is_some_and(|errors| !errors.is_empty())
        );
        assert_eq!(snapshot(), before);
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM sync_outbox", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            outbox_before
        );
    }
}
