//! Manual `ServerHandler` implementation over the agent-tools catalog.
//!
//! Tools are registered at runtime from `AgentToolCatalog` (no proc
//! macros). Authorization is read per-request from the
//! [`crate::auth::McpAuthContext`] that host middleware injected into the
//! HTTP request extensions (rmcp forwards `http::request::Parts` into the
//! request context). Missing auth context fails closed.

use std::sync::Arc;

use rmcp::handler::server::ServerHandler;
use rmcp::model::{
    CallToolRequestParams, CallToolResult, Content, ErrorData as McpError, Implementation,
    ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerInfo, Tool,
};
use rmcp::service::{RequestContext, RoleServer};
use wealthfolio_agent_tools::{AgentEnvironment, AgentToolCatalog, AgentToolError};

use crate::audit::{AuditOutcome, AuditSink, McpAuditEntry};
use crate::auth::McpAuthContext;

/// MCP server handler backed by the shared agent-tool catalog.
///
/// Cheap to clone: the Streamable HTTP transport constructs one handler
/// per session via the service factory.
#[derive(Clone)]
pub struct WealthfolioMcpHandler {
    env: Arc<dyn AgentEnvironment>,
    catalog: Arc<AgentToolCatalog>,
    audit: Option<Arc<dyn AuditSink>>,
    instructions: Option<String>,
}

impl WealthfolioMcpHandler {
    pub fn new(
        env: Arc<dyn AgentEnvironment>,
        catalog: Arc<AgentToolCatalog>,
        audit: Option<Arc<dyn AuditSink>>,
        instructions: Option<String>,
    ) -> Self {
        Self {
            env,
            catalog,
            audit,
            instructions,
        }
    }

    /// Pull the auth context the host middleware injected; fail closed.
    fn auth_context(ctx: &RequestContext<RoleServer>) -> Result<McpAuthContext, McpError> {
        ctx.extensions
            .get::<http::request::Parts>()
            .and_then(|parts| parts.extensions.get::<McpAuthContext>())
            .cloned()
            .ok_or_else(|| {
                McpError::invalid_request(
                    "missing authentication context; the MCP endpoint must be served behind \
                     Wealthfolio's auth middleware",
                    None,
                )
            })
    }

    /// MCP session id for audit grouping (`Mcp-Session-Id` header).
    fn session_id(ctx: &RequestContext<RoleServer>) -> String {
        ctx.extensions
            .get::<http::request::Parts>()
            .and_then(|parts| parts.headers.get("mcp-session-id"))
            .and_then(|value| value.to_str().ok())
            .unwrap_or("stateless")
            .to_string()
    }

    /// Persist an audit entry, awaited before the tool result returns so the
    /// row is durable — a mutation must never commit without its audit trail
    /// (e.g. if the process exits right after the call).
    async fn audit(&self, entry: McpAuditEntry) {
        if let Some(sink) = &self.audit {
            sink.record(entry).await;
        }
    }

    fn audit_entry(
        auth: &McpAuthContext,
        session_id: String,
        tool: &str,
        args_summary: serde_json::Value,
        outcome: AuditOutcome,
        error_message: Option<String>,
    ) -> McpAuditEntry {
        McpAuditEntry {
            session_id,
            actor_kind: auth.actor_kind,
            actor_fingerprint: auth.actor_fingerprint.clone(),
            tool: tool.to_string(),
            scopes: auth
                .granted_scopes
                .iter()
                .map(|s| s.as_str().to_string())
                .collect(),
            args_summary,
            outcome,
            error_message,
        }
    }

    fn to_mcp_tool(tool: &Arc<dyn wealthfolio_agent_tools::AgentTool>) -> Tool {
        let schema = match tool.input_schema() {
            serde_json::Value::Object(map) => map,
            _ => serde_json::Map::new(),
        };
        Tool::new(tool.name(), tool.description(), Arc::new(schema))
    }
}

impl ServerHandler for WealthfolioMcpHandler {
    fn get_info(&self) -> ServerInfo {
        let mut server_info = Implementation::default();
        server_info.name = "wealthfolio".into();
        server_info.version = env!("CARGO_PKG_VERSION").into();

        let mut info = ServerInfo::default();
        info.capabilities = ServerCapabilities::builder().enable_tools().build();
        info.server_info = server_info;
        info.instructions = self.instructions.clone();
        info
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        let auth = Self::auth_context(&ctx)?;
        let tools = self
            .catalog
            .iter()
            .filter(|tool| auth.granted_scopes.grants_all(tool.required_scopes()))
            .map(Self::to_mcp_tool)
            .collect();
        Ok(ListToolsResult {
            tools,
            ..ListToolsResult::default()
        })
    }

    fn get_tool(&self, name: &str) -> Option<Tool> {
        self.catalog.get(name).map(Self::to_mcp_tool)
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, McpError> {
        let auth = Self::auth_context(&ctx)?;
        let session_id = Self::session_id(&ctx);
        let name = request.name.as_ref();

        let Some(tool) = self.catalog.get(name) else {
            // Audit name-probing too: unknown-tool calls must leave a trace.
            let message = format!("unknown tool: {name}");
            self.audit(Self::audit_entry(
                &auth,
                session_id,
                name,
                serde_json::Value::Null,
                AuditOutcome::Error,
                Some(message.clone()),
            ))
            .await;
            return Err(McpError::invalid_params(message, None));
        };

        let args = request
            .arguments
            .map(serde_json::Value::Object)
            .unwrap_or_else(|| serde_json::json!({}));
        let args_summary = tool.sanitize_args_for_audit(&args);

        let result = self
            .catalog
            .execute(self.env.clone(), &auth.granted_scopes, name, args)
            .await;

        match result {
            Ok(output) => {
                self.audit(Self::audit_entry(
                    &auth,
                    session_id,
                    name,
                    args_summary,
                    AuditOutcome::Success,
                    None,
                ))
                .await;
                let text =
                    serde_json::to_string(&output.content).unwrap_or_else(|_| "{}".to_string());
                let mut result = CallToolResult::success(vec![Content::text(text)]);
                result.structured_content = Some(output.content);
                Ok(result)
            }
            Err(err @ AgentToolError::ScopeDenied { .. }) => {
                let message = err.to_string();
                self.audit(Self::audit_entry(
                    &auth,
                    session_id,
                    name,
                    args_summary,
                    AuditOutcome::Denied,
                    Some(message.clone()),
                ))
                .await;
                Ok(CallToolResult::error(vec![Content::text(message)]))
            }
            Err(err) => {
                let message = err.to_string();
                self.audit(Self::audit_entry(
                    &auth,
                    session_id,
                    name,
                    args_summary,
                    AuditOutcome::Error,
                    Some(message.clone()),
                ))
                .await;
                Ok(CallToolResult::error(vec![Content::text(message)]))
            }
        }
    }
}
