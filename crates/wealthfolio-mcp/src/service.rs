//! Builder producing the tower service hosts mount.

use std::sync::Arc;

use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use wealthfolio_agent_tools::{AgentEnvironment, AgentTool, AgentToolCatalog};

use crate::audit::AuditSink;
use crate::handler::WealthfolioMcpHandler;

/// Builds the Wealthfolio MCP Streamable HTTP service.
///
/// Defaults: the full MCP catalog (read + draft/suggest + commit tools,
/// scope-filtered per token at the boundary), no audit sink, no instructions.
/// Hosts must serve the result behind authentication middleware that
/// injects [`crate::auth::McpAuthContext`] — the handler fails closed
/// otherwise.
pub struct McpServerBuilder {
    env: Arc<dyn AgentEnvironment>,
    tools: Option<Vec<Arc<dyn AgentTool>>>,
    audit: Option<Arc<dyn AuditSink>>,
    instructions: Option<String>,
}

impl McpServerBuilder {
    pub fn new(env: Arc<dyn AgentEnvironment>) -> Self {
        Self {
            env,
            tools: None,
            audit: None,
            instructions: None,
        }
    }

    /// Override the tool set (default: the full MCP catalog).
    pub fn tools(mut self, tools: Vec<Arc<dyn AgentTool>>) -> Self {
        self.tools = Some(tools);
        self
    }

    pub fn audit(mut self, sink: Arc<dyn AuditSink>) -> Self {
        self.audit = Some(sink);
        self
    }

    /// Server instructions surfaced to MCP clients at initialize.
    pub fn instructions(mut self, instructions: impl Into<String>) -> Self {
        self.instructions = Some(instructions.into());
        self
    }

    pub fn build_handler(self) -> WealthfolioMcpHandler {
        let catalog = match self.tools {
            Some(tools) => AgentToolCatalog::new(tools),
            None => AgentToolCatalog::mcp_catalog(),
        };
        WealthfolioMcpHandler::new(self.env, Arc::new(catalog), self.audit, self.instructions)
    }

    /// Build the tower service to mount (e.g. `Router::nest_service("/mcp", svc)`).
    pub fn build_http_service(
        self,
        config: StreamableHttpServerConfig,
    ) -> StreamableHttpService<WealthfolioMcpHandler, LocalSessionManager> {
        let handler = self.build_handler();
        StreamableHttpService::new(
            move || Ok(handler.clone()),
            Arc::new(LocalSessionManager::default()),
            config,
        )
    }
}
