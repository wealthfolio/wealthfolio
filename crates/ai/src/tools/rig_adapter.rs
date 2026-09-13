//! Adapter exposing `wealthfolio-agent-tools` tools to rig agents.
//!
//! Runtime-named catalog tools register through Rig's `DynamicTool` API.
//! Definitions and structured JSON results retain the catalog contract.

use std::sync::Arc;

use rig::completion::ToolDefinition;
use rig::tool::{DynamicTool, ToolExecutionError, ToolOutput};
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

impl RigAgentTool {
    pub fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: self.tool.name().to_string(),
            description: self.tool.description().to_string(),
            parameters: self.tool.input_schema(),
        }
    }

    pub async fn call(
        &self,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, ToolExecutionError> {
        self.tool
            .call(self.env.clone(), args)
            .await
            .map(|result| result.content)
            .map_err(|error| {
                let feedback = error.to_string();
                ToolExecutionError::from_error(error).with_model_feedback(feedback)
            })
    }

    pub fn into_dynamic(self) -> DynamicTool {
        let definition = self.definition();
        let adapter = Arc::new(self);
        DynamicTool::new(
            definition.name,
            definition.description,
            definition.parameters,
            move |_context, args| {
                let adapter = adapter.clone();
                Box::pin(async move { adapter.call(args).await.map(ToolOutput::json) })
            },
        )
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
        let def = adapter().definition();
        assert_eq!(def.name, "echo");
        assert_eq!(def.description, "Echoes its arguments.");
        assert_eq!(
            def.parameters,
            serde_json::json!({ "type": "object", "properties": {} })
        );
    }

    #[tokio::test]
    async fn call_serializes_success_output() {
        let out = adapter().call(serde_json::json!({"a":1})).await.unwrap();
        let value = out;
        assert_eq!(value, serde_json::json!({ "echo": { "a": 1 } }));
    }

    #[tokio::test]
    async fn tool_error_display_matches_legacy_format() {
        let err = adapter()
            .call(serde_json::json!({"fail":true}))
            .await
            .unwrap_err();
        assert_eq!(err.to_string(), "Tool execution failed: boom");
    }
}
