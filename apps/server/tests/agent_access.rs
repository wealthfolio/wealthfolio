//! Integration tests for the `/mcp` endpoint (PAT auth) and the
//! agent-access management API.
//!
//! These boot the real router on a loopback port (the MCP transport
//! answers over SSE, so `oneshot` is not enough) with auth enabled.

use std::net::SocketAddr;

use argon2::{password_hash::SaltString, Argon2, PasswordHasher};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use rand::{rngs::OsRng, RngCore};
use reqwest::header;
use tempfile::TempDir;
use wealthfolio_server::{api::app_router, build_state, config::Config};

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

        let config = Config::from_env();
        let state = build_state(&config).await.unwrap();
        app_router(state, &config)
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

    let session = mcp_initialize(&server, &pat).await;

    // tools/list -> the read-only catalog: 16 read tools + get_import_mapping
    // (also activities:read) = 17.
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
        17,
        "read-only catalog must expose 17 tools (incl. get_import_mapping): {tools:?}"
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
/// read-only catalog. (Read-only tokens see 17; the full MCP catalog is
/// 16 read + get_import_mapping + 5 draft/suggest + 3 commit + 2 import = 27.)
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
        ])
        .collect();
    let (status, created) = create_pat(
        &server,
        &cookie,
        serde_json::json!({ "name": "writer", "scopes": full_scopes }),
    )
    .await;
    assert_eq!(status, 201);
    assert_eq!(created["scopes"].as_array().unwrap().len(), 11);
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
        27,
        "full-scope token must see all 27 tools: {names:?}"
    );
    assert!(
        names.contains(&"commit_activity_import"),
        "import tool visible"
    );
    assert!(names.contains(&"record_activity"), "draft tool visible");
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
