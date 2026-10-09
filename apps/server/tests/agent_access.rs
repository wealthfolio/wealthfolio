//! Integration tests for the `/mcp` endpoint (PAT auth) and the
//! agent-access management API.
//!
//! These boot the real router on a loopback port (the MCP transport
//! answers over SSE, so `oneshot` is not enough) with auth enabled.
#![allow(clippy::unwrap_used, clippy::panic, reason = "test code")]

use std::net::SocketAddr;

use argon2::{password_hash::SaltString, Argon2, PasswordHasher};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use rand::{rngs::OsRng, RngCore};
use reqwest::header;
use tempfile::TempDir;
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

async fn spawn_server(mcp_enabled: bool, audit_enabled: bool) -> TestServer {
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
    assert_eq!(created["scopes"].as_array().unwrap().len(), 7);
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
    // and find_transfer_matches (also activities:read) = 18.
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
    assert_eq!(
        tools.len(),
        18,
        "read-only catalog must expose 18 tools (incl. get_import_mapping): {tools:?}"
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
/// read-only catalog. (Read-only tokens see 18; the full MCP catalog is
/// 16 read + 5 draft/suggest + 5 commit + 3 import + 3 transfer linking +
/// 2 quote import + 2 activity updates = 36.)
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
    assert_eq!(created["scopes"].as_array().unwrap().len(), 12);
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
        36,
        "full-scope token must see all 36 tools: {names:?}"
    );
    for name in [
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
            "scopes": ["activities:read", "classification:read", "classification:suggest", "classification:write"]
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

    // The second category exists, but in another taxonomy. This fails the FK
    // after the first assignment and split deletion enter the write transaction.
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

    for invalid in [
        serde_json::json!({"activityId": "missing-activity", "taxonomyId": "spending_categories", "categoryId": first}),
        serde_json::json!({"activityId": activities[1]["id"], "taxonomyId": "income_sources", "categoryId": income}),
        category_assignment(&activities[1], "missing-category"),
        serde_json::json!({"activityId": activities[1]["id"], "taxonomyId": "missing-taxonomy", "categoryId": first}),
    ] {
        mcp_call_tool_error(&server, &pat, &session, "commit_transaction_categories",
            serde_json::json!({"assignments": [category_assignment(&activities[0], &second), invalid]})).await;
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
        serde_json::json!({"assignments": [category_assignment(&activities[0], &second)]}),
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
