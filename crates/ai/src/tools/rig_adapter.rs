//! Adapter exposing `wealthfolio-agent-tools` tools to rig agents.
//!
//! rig's `Tool` trait is not object-safe (`const NAME`, typed Args/Output),
//! so the catalog's `dyn AgentTool`s implement rig's object-safe `ToolDyn`
//! directly via this wrapper. The agent builder consumes
//! `Box<dyn ToolDyn>`, so one wrapper type covers every catalog tool.
//!
//! Behavior parity with the former direct `Tool` impls (guarded by
//! `tests/tool_outputs_parity.rs`):
//! - definition: name/description/parameters pass through unchanged.
//! - success: output JSON is value-identical (key order may differ).
//! - tool failure: rig formats errors as `ToolCallError: {display}`, and
//!   `AgentToolError::ExecutionFailed` displays as
//!   "Tool execution failed: ..." — same text as the old
//!   `AiError::ToolExecutionFailed`.

use std::sync::Arc;

use rig::completion::ToolDefinition;
use rig::tool::{ToolDyn, ToolError};
use rig::wasm_compat::WasmBoxedFuture;
use wealthfolio_agent_tools::{AgentEnvironment, AgentTool};

/// A catalog tool bound to an environment, callable by a rig agent.
pub struct RigAgentTool {
    tool: Arc<dyn AgentTool>,
    env: Arc<dyn AgentEnvironment>,
}

impl RigAgentTool {
    pub fn new(tool: Arc<dyn AgentTool>, env: Arc<dyn AgentEnvironment>) -> Self {
        Self { tool, env }
    }
}

impl ToolDyn for RigAgentTool {
    fn name(&self) -> String {
        self.tool.name().to_string()
    }

    fn definition<'a>(&'a self, _prompt: String) -> WasmBoxedFuture<'a, ToolDefinition> {
        Box::pin(async move {
            ToolDefinition {
                name: self.tool.name().to_string(),
                description: self.tool.description().to_string(),
                parameters: self.tool.input_schema(),
            }
        })
    }

    fn call<'a>(&'a self, args: String) -> WasmBoxedFuture<'a, Result<String, ToolError>> {
        Box::pin(async move {
            let args: serde_json::Value =
                serde_json::from_str(&args).map_err(ToolError::JsonError)?;
            let result = self
                .tool
                .call(self.env.clone(), args)
                .await
                .map_err(|e| ToolError::ToolCallError(Box::new(e)))?;
            serde_json::to_string(&result.content).map_err(ToolError::JsonError)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::env::test_env::MockEnvironment;
    use wealthfolio_agent_tools::{
        AgentScope, AgentTool, AgentToolAccess, AgentToolError, AgentToolResult,
    };

    struct EchoTool;

    #[async_trait::async_trait]
    impl AgentTool for EchoTool {
        fn name(&self) -> &'static str {
            "echo"
        }
        fn description(&self) -> &'static str {
            "Echoes its arguments."
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
            if args.get("fail").is_some() {
                return Err(AgentToolError::ExecutionFailed("boom".to_string()));
            }
            Ok(AgentToolResult {
                content: serde_json::json!({ "echo": args }),
            })
        }
    }

    fn adapter() -> RigAgentTool {
        RigAgentTool::new(Arc::new(EchoTool), Arc::new(MockEnvironment::new()))
    }

    #[tokio::test]
    async fn definition_passes_through() {
        let def = adapter().definition(String::new()).await;
        assert_eq!(def.name, "echo");
        assert_eq!(def.description, "Echoes its arguments.");
        assert_eq!(
            def.parameters,
            serde_json::json!({ "type": "object", "properties": {} })
        );
    }

    #[tokio::test]
    async fn call_serializes_success_output() {
        let out = adapter().call(r#"{"a":1}"#.to_string()).await.unwrap();
        let value: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(value, serde_json::json!({ "echo": { "a": 1 } }));
    }

    #[tokio::test]
    async fn tool_error_display_matches_legacy_format() {
        let err = adapter()
            .call(r#"{"fail":true}"#.to_string())
            .await
            .unwrap_err();
        assert_eq!(
            err.to_string(),
            "ToolCallError: Tool execution failed: boom"
        );
    }

    #[tokio::test]
    async fn malformed_json_args_is_json_error() {
        let err = adapter().call("not json".to_string()).await.unwrap_err();
        assert!(matches!(err, ToolError::JsonError(_)));
    }
}
