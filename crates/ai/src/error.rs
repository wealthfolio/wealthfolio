//! AI assistant error types.

use thiserror::Error;
use wealthfolio_core::Error as CoreError;

/// AI assistant errors.
#[derive(Debug, Error)]
pub enum AiError {
    /// Invalid input or request.
    #[error("{0}")]
    InvalidInput(String),

    /// Missing API key for a provider.
    #[error("Missing API key for provider {0}")]
    MissingApiKey(String),

    /// Provider error (from rig-core or API).
    #[error("Provider error: {0}")]
    Provider(String),

    /// Tool not found in registry.
    #[error("Tool not found: {0}")]
    ToolNotFound(String),

    /// Tool not allowed for this thread.
    #[error("Tool not allowed: {0}")]
    ToolNotAllowed(String),

    /// Tool execution failed.
    #[error("Tool execution failed: {0}")]
    ToolExecutionFailed(String),

    /// Thread not found.
    #[error("Thread not found: {0}")]
    ThreadNotFound(String),

    /// Invalid cursor for pagination.
    #[error("Invalid cursor: {0}")]
    InvalidCursor(String),

    /// Core error from wealthfolio-core.
    #[error("Core error: {0}")]
    Core(#[from] CoreError),

    /// Internal error.
    #[error("Internal error: {0}")]
    Internal(String),
}

/// Map shared agent-tool errors back to the assistant's error type,
/// preserving the user/model-visible display string exactly:
/// `ExecutionFailed` and `ToolExecutionFailed` both display as
/// "Tool execution failed: {msg}", `InvalidInput` displays as the bare
/// message on both sides.
impl From<wealthfolio_agent_tools::AgentToolError> for AiError {
    fn from(err: wealthfolio_agent_tools::AgentToolError) -> Self {
        use wealthfolio_agent_tools::AgentToolError as ToolError;
        match err {
            ToolError::InvalidInput(msg) => AiError::InvalidInput(msg),
            ToolError::InvalidArgs(e) => AiError::InvalidInput(e.to_string()),
            ToolError::ExecutionFailed(msg) => AiError::ToolExecutionFailed(msg),
            other => AiError::ToolExecutionFailed(other.to_string()),
        }
    }
}

impl AiError {
    /// Create a new invalid input error.
    pub fn invalid_input(msg: impl Into<String>) -> Self {
        Self::InvalidInput(msg.into())
    }

    /// Create a new provider error.
    pub fn provider(msg: impl Into<String>) -> Self {
        Self::Provider(msg.into())
    }

    /// Create a new internal error.
    pub fn internal(msg: impl Into<String>) -> Self {
        Self::Internal(msg.into())
    }
}

/// Error code for programmatic handling in stream events.
impl AiError {
    pub fn code(&self) -> &'static str {
        match self {
            AiError::InvalidInput(_) => "INVALID_INPUT",
            AiError::MissingApiKey(_) => "MISSING_API_KEY",
            AiError::Provider(_) => "PROVIDER_ERROR",
            AiError::ToolNotFound(_) => "TOOL_NOT_FOUND",
            AiError::ToolNotAllowed(_) => "TOOL_NOT_ALLOWED",
            AiError::ToolExecutionFailed(_) => "TOOL_EXECUTION_FAILED",
            AiError::ThreadNotFound(_) => "THREAD_NOT_FOUND",
            AiError::InvalidCursor(_) => "INVALID_CURSOR",
            AiError::Core(_) => "CORE_ERROR",
            AiError::Internal(_) => "INTERNAL_ERROR",
        }
    }
}
