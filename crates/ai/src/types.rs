//! Shared types for AI assistant - domain types, streaming events, and tool results.
//!
//! This module defines all chat-related types used by the AI assistant:
//! - Domain types: ChatThread, ChatMessage, ChatMessageContent, ChatMessagePart
//! - Streaming types: AiStreamEvent, ToolResult, ToolResultData, ToolCall
//! - Request/Response types: SendMessageRequest, AiSettings, etc.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

use crate::error::AiError;

// ============================================================================
// Constants
// ============================================================================

/// Current schema version for message content.
pub const CHAT_CONTENT_SCHEMA_VERSION: u32 = 1;

/// Current schema version for thread config snapshot.
pub const CHAT_CONFIG_SCHEMA_VERSION: u32 = 1;

/// Default tools allowed. Includes read-only tools and safe mutation tools
/// (`record_activity`/`record_activities` require explicit user confirmation before creating).
pub const DEFAULT_TOOLS_ALLOWLIST: &[&str] = &[
    "get_holdings",
    "get_accounts",
    "get_cash_balances",
    "get_performance",
    "search_activities",
    "get_valuation_history",
    "get_income",
    "get_asset_allocation",
    "get_goals",
    "record_activity",
    "record_activities",
    "import_csv",
    "get_health_status",
    "propose_transaction_categories",
    "list_categorization_context",
    "create_categorization_rule",
    "list_asset_taxonomies",
    "get_asset_taxonomy_assignments",
    "prepare_asset_classification",
    "get_portfolios",
    "get_net_worth",
    "get_contribution_limits",
];

const LEGACY_VISIBLE_DATA_TOOLS: &[&str] = &[
    "get_accounts",
    "get_holdings",
    "search_activities",
    "get_performance",
    "get_income",
    "get_asset_allocation",
    "get_valuation_history",
    "get_goals",
];

/// Normalize persisted provider tool allowlists to match grouped UI access controls.
///
/// Older settings stored only the visible card tool IDs. For example, the
/// Transactions card saved `search_activities` but omitted transaction draft
/// and import tools. Keep those legacy settings working by expanding each
/// group to the backend tools it represents.
pub fn normalize_tools_allowlist(tools_allowlist: Option<Vec<String>>) -> Option<Vec<String>> {
    let mut tools = tools_allowlist?;
    if tools.is_empty() {
        return Some(tools);
    }

    let has = |tools: &[String], tool: &str| tools.iter().any(|item| item == tool);

    if has(&tools, "get_accounts") {
        push_tool_once(&mut tools, "get_cash_balances");
        push_tool_once(&mut tools, "get_portfolios");
    }

    if has(&tools, "get_holdings") {
        push_tool_once(&mut tools, "get_net_worth");
    }

    if has(&tools, "get_goals") {
        push_tool_once(&mut tools, "get_contribution_limits");
    }

    if has(&tools, "search_activities") {
        push_tool_once(&mut tools, "record_activity");
        push_tool_once(&mut tools, "record_activities");
        push_tool_once(&mut tools, "import_csv");
        push_tool_once(&mut tools, "propose_transaction_categories");
        push_tool_once(&mut tools, "list_categorization_context");
        push_tool_once(&mut tools, "create_categorization_rule");
    }

    if LEGACY_VISIBLE_DATA_TOOLS
        .iter()
        .all(|tool| has(&tools, tool))
    {
        push_tool_once(&mut tools, "get_health_status");
    }

    Some(tools)
}

fn push_tool_once(tools: &mut Vec<String>, tool: &str) {
    if !tools.iter().any(|item| item == tool) {
        tools.push(tool.to_string());
    }
}

/// Maximum size in bytes for persisted message content (256KB).
pub const CHAT_MAX_CONTENT_SIZE_BYTES: usize = 256 * 1024;

// ============================================================================
// Thread Configuration
// ============================================================================

/// Per-thread agent configuration snapshot.
///
/// Captures the model, prompt template, and tool allowlist at thread creation.
/// This enables deterministic replay and debugging of conversations.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatThreadConfig {
    /// Schema version for backward compatibility.
    pub schema_version: u32,

    /// Provider ID (e.g., "openai", "anthropic").
    pub provider_id: String,

    /// Model ID (e.g., "gpt-4o", "claude-3-sonnet").
    pub model_id: String,

    /// Prompt template ID.
    pub prompt_template_id: String,

    /// Prompt template version.
    pub prompt_version: String,

    /// Locale for formatting and language.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locale: Option<String>,

    /// Detail level for responses.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail_level: Option<String>,

    /// Allowlist of tool names that can be used in this thread.
    /// If None, uses default read-only tools.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools_allowlist: Option<Vec<String>>,
}

impl ChatThreadConfig {
    /// Create a new config with default settings.
    pub fn new(
        provider_id: &str,
        model_id: &str,
        template_id: &str,
        template_version: &str,
    ) -> Self {
        Self {
            schema_version: CHAT_CONFIG_SCHEMA_VERSION,
            provider_id: provider_id.to_string(),
            model_id: model_id.to_string(),
            prompt_template_id: template_id.to_string(),
            prompt_version: template_version.to_string(),
            locale: None,
            detail_level: None,
            tools_allowlist: None,
        }
    }

    /// Create config with default read-only tools allowlist.
    pub fn with_default_tools(mut self) -> Self {
        self.tools_allowlist = Some(
            DEFAULT_TOOLS_ALLOWLIST
                .iter()
                .map(|s| s.to_string())
                .collect(),
        );
        self
    }

    /// Get the effective tools allowlist.
    pub fn get_tools_allowlist(&self) -> Vec<String> {
        self.tools_allowlist.clone().unwrap_or_else(|| {
            DEFAULT_TOOLS_ALLOWLIST
                .iter()
                .map(|s| s.to_string())
                .collect()
        })
    }

    /// Serialize to JSON.
    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(self)
    }

    /// Deserialize from JSON.
    pub fn from_json(json: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(json)
    }
}

impl Default for ChatThreadConfig {
    fn default() -> Self {
        Self {
            schema_version: CHAT_CONFIG_SCHEMA_VERSION,
            provider_id: String::new(),
            model_id: String::new(),
            prompt_template_id: "wealthfolio-assistant-v1".to_string(),
            prompt_version: "1.0.0".to_string(),
            locale: None,
            detail_level: None,
            tools_allowlist: Some(
                DEFAULT_TOOLS_ALLOWLIST
                    .iter()
                    .map(|s| s.to_string())
                    .collect(),
            ),
        }
    }
}

// ============================================================================
// Domain Types
// ============================================================================

/// A chat thread.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatThread {
    pub id: String,
    pub title: Option<String>,
    /// Whether the thread is pinned to the top of the list.
    #[serde(default)]
    pub is_pinned: bool,
    pub tags: Vec<String>,
    /// Per-thread agent configuration snapshot.
    /// Captures model, prompt template, and tool allowlist at creation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<ChatThreadConfig>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl ChatThread {
    /// Create a new thread with generated UUID.
    pub fn new() -> Self {
        let now = Utc::now();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            title: None,
            is_pinned: false,
            tags: Vec::new(),
            config: None,
            created_at: now,
            updated_at: now,
        }
    }

    /// Create a new thread with config snapshot.
    pub fn with_config(config: ChatThreadConfig) -> Self {
        let now = Utc::now();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            title: None,
            is_pinned: false,
            tags: Vec::new(),
            config: Some(config),
            created_at: now,
            updated_at: now,
        }
    }

    /// Create a thread with specific ID (for reconstruction from DB).
    pub fn with_id(
        id: String,
        title: Option<String>,
        is_pinned: bool,
        config: Option<ChatThreadConfig>,
        created_at: DateTime<Utc>,
        updated_at: DateTime<Utc>,
    ) -> Self {
        Self {
            id,
            title,
            is_pinned,
            tags: Vec::new(),
            config,
            created_at,
            updated_at,
        }
    }

    /// Get the effective tools allowlist from config.
    pub fn get_tools_allowlist(&self) -> Vec<String> {
        self.config
            .as_ref()
            .map(|c| c.get_tools_allowlist())
            .unwrap_or_else(|| {
                DEFAULT_TOOLS_ALLOWLIST
                    .iter()
                    .map(|s| s.to_string())
                    .collect()
            })
    }
}

impl Default for ChatThread {
    fn default() -> Self {
        Self::new()
    }
}

/// Message role.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatMessageRole {
    User,
    Assistant,
    System,
    Tool,
}

impl std::fmt::Display for ChatMessageRole {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ChatMessageRole::User => write!(f, "user"),
            ChatMessageRole::Assistant => write!(f, "assistant"),
            ChatMessageRole::System => write!(f, "system"),
            ChatMessageRole::Tool => write!(f, "tool"),
        }
    }
}

impl std::str::FromStr for ChatMessageRole {
    type Err = String;

    fn from_str(s: &str) -> std::result::Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "user" => Ok(ChatMessageRole::User),
            "assistant" => Ok(ChatMessageRole::Assistant),
            "system" => Ok(ChatMessageRole::System),
            "tool" => Ok(ChatMessageRole::Tool),
            _ => Err(format!("Unknown role: {}", s)),
        }
    }
}

/// A chat message with structured content.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub thread_id: String,
    pub role: ChatMessageRole,
    pub content: ChatMessageContent,
    pub created_at: DateTime<Utc>,
}

impl ChatMessage {
    /// Create a new user message with text content.
    pub fn user(thread_id: &str, text: &str) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            thread_id: thread_id.to_string(),
            role: ChatMessageRole::User,
            content: ChatMessageContent::text(text),
            created_at: Utc::now(),
        }
    }

    /// Create a new assistant message (empty, to be filled during streaming).
    pub fn assistant(thread_id: &str) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            thread_id: thread_id.to_string(),
            role: ChatMessageRole::Assistant,
            content: ChatMessageContent::new(vec![]),
            created_at: Utc::now(),
        }
    }

    /// Create a new assistant message with specific ID.
    pub fn assistant_with_id(id: &str, thread_id: &str) -> Self {
        Self {
            id: id.to_string(),
            thread_id: thread_id.to_string(),
            role: ChatMessageRole::Assistant,
            content: ChatMessageContent::new(vec![]),
            created_at: Utc::now(),
        }
    }

    /// Get the plain text content.
    pub fn get_text(&self) -> String {
        self.content.get_text_content()
    }
}

/// Structured message content with versioning.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessageContent {
    pub schema_version: u32,
    pub parts: Vec<ChatMessagePart>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
}

impl ChatMessageContent {
    /// Create new content with default schema version.
    pub fn new(parts: Vec<ChatMessagePart>) -> Self {
        Self {
            schema_version: CHAT_CONTENT_SCHEMA_VERSION,
            parts,
            truncated: false,
        }
    }

    /// Create content for simple text.
    pub fn text(content: &str) -> Self {
        Self::new(vec![ChatMessagePart::Text {
            content: content.to_string(),
        }])
    }

    /// Get concatenated text from all text parts.
    pub fn get_text_content(&self) -> String {
        self.parts
            .iter()
            .filter_map(|p| match p {
                ChatMessagePart::Text { content } => Some(content.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("")
    }

    /// Serialize to JSON.
    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(self)
    }

    /// Deserialize from JSON.
    pub fn from_json(json: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(json)
    }
}

/// Individual message parts representing the agent loop.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ChatMessagePart {
    /// System metadata.
    #[serde(rename_all = "camelCase")]
    System { content: String },

    /// Text content.
    #[serde(rename_all = "camelCase")]
    Text { content: String },

    /// Reasoning/thinking content (optional).
    #[serde(rename_all = "camelCase")]
    Reasoning { content: String },

    /// Tool call.
    #[serde(rename_all = "camelCase")]
    ToolCall {
        tool_call_id: String,
        name: String,
        arguments: serde_json::Value,
    },

    /// Tool result.
    #[serde(rename_all = "camelCase")]
    ToolResult {
        tool_call_id: String,
        success: bool,
        data: serde_json::Value,
        #[serde(default, skip_serializing_if = "HashMap::is_empty")]
        meta: HashMap<String, serde_json::Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },

    /// Error.
    #[serde(rename_all = "camelCase")]
    Error { code: String, message: String },
}

// ============================================================================
// Repository Trait
// ============================================================================

// ============================================================================
// Pagination Types
// ============================================================================

/// A page of chat threads with cursor-based pagination.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadPage {
    /// The threads in this page.
    pub threads: Vec<ChatThread>,
    /// Cursor for the next page (None if no more pages).
    pub next_cursor: Option<String>,
    /// Whether there are more threads after this page.
    pub has_more: bool,
}

/// Request parameters for listing threads with pagination and search.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListThreadsRequest {
    /// Cursor from previous page's next_cursor.
    pub cursor: Option<String>,
    /// Maximum threads to return (default 20, max 100).
    pub limit: Option<u32>,
    /// Optional search query to filter by title.
    pub search: Option<String>,
}

impl Default for ListThreadsRequest {
    fn default() -> Self {
        Self {
            cursor: None,
            limit: Some(20),
            search: None,
        }
    }
}

// ============================================================================
// Repository Trait
// ============================================================================

/// Result type for repository operations.
pub type ChatRepositoryResult<T> = Result<T, AiError>;

/// Repository for AI chat persistence.
#[async_trait]
pub trait ChatRepositoryTrait: Send + Sync {
    // Thread operations
    async fn create_thread(&self, thread: ChatThread) -> ChatRepositoryResult<ChatThread>;
    fn get_thread(&self, thread_id: &str) -> ChatRepositoryResult<Option<ChatThread>>;
    fn list_threads(&self, limit: i64, offset: i64) -> ChatRepositoryResult<Vec<ChatThread>>;
    /// List threads with cursor-based pagination and optional search.
    fn list_threads_paginated(
        &self,
        request: &ListThreadsRequest,
    ) -> ChatRepositoryResult<ThreadPage>;
    async fn update_thread(&self, thread: ChatThread) -> ChatRepositoryResult<ChatThread>;
    async fn delete_thread(&self, thread_id: &str) -> ChatRepositoryResult<()>;

    // Message operations
    async fn create_message(&self, message: ChatMessage) -> ChatRepositoryResult<ChatMessage>;
    fn get_message(&self, message_id: &str) -> ChatRepositoryResult<Option<ChatMessage>>;
    fn get_messages_by_thread(&self, thread_id: &str) -> ChatRepositoryResult<Vec<ChatMessage>>;
    async fn update_message(&self, message: ChatMessage) -> ChatRepositoryResult<ChatMessage>;

    // Tag operations
    async fn add_tag(&self, thread_id: &str, tag: &str) -> ChatRepositoryResult<()>;
    async fn remove_tag(&self, thread_id: &str, tag: &str) -> ChatRepositoryResult<()>;
    fn get_tags(&self, thread_id: &str) -> ChatRepositoryResult<Vec<String>>;
}

// ============================================================================
// Tool Result Envelope
// ============================================================================

/// Result of tool execution with structured data and metadata.
///
/// All tool outputs are wrapped in this envelope to provide consistent
/// structure for the frontend to render rich UI components.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    /// The result data (structured JSON).
    pub data: serde_json::Value,
    /// Metadata about the result (counts, truncation info, duration, etc.).
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub meta: HashMap<String, serde_json::Value>,
}

impl ToolResult {
    /// Create a successful result with data.
    pub fn ok(data: impl Serialize) -> Self {
        Self {
            data: serde_json::to_value(data).unwrap_or(serde_json::Value::Null),
            meta: HashMap::new(),
        }
    }

    /// Create an empty result.
    pub fn empty() -> Self {
        Self {
            data: serde_json::Value::Null,
            meta: HashMap::new(),
        }
    }

    /// Add metadata to the result.
    pub fn with_meta(mut self, key: &str, value: impl Serialize) -> Self {
        if let Ok(v) = serde_json::to_value(value) {
            self.meta.insert(key.to_string(), v);
        }
        self
    }

    /// Add truncation info to metadata.
    pub fn with_truncation(self, original_count: usize, returned_count: usize) -> Self {
        self.with_meta("originalCount", original_count)
            .with_meta("returnedCount", returned_count)
            .with_meta("truncated", original_count > returned_count)
    }

    /// Add duration to metadata.
    pub fn with_duration_ms(self, duration_ms: u128) -> Self {
        self.with_meta("durationMs", duration_ms)
    }

    /// Add account scope to metadata.
    pub fn with_account_scope(self, scope: &str) -> Self {
        self.with_meta("accountScope", scope)
    }

    /// Add row/point count to metadata.
    pub fn with_count(self, count: usize) -> Self {
        self.with_meta("count", count)
    }

    /// Convert to ToolResultData for streaming events.
    pub fn to_result_data(self, tool_call_id: &str, success: bool) -> ToolResultData {
        ToolResultData {
            tool_call_id: tool_call_id.to_string(),
            success,
            data: self.data,
            meta: self.meta,
            error: None,
        }
    }

    /// Convert to string for sending to LLM.
    pub fn to_llm_string(&self) -> String {
        serde_json::to_string(&self.data).unwrap_or_else(|_| "{}".to_string())
    }
}

// ============================================================================
// Tool Types
// ============================================================================

/// A tool call made by the assistant.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    /// Unique tool call ID.
    pub id: String,
    /// Name of the tool being called.
    pub name: String,
    /// Arguments passed to the tool (structured JSON).
    pub arguments: serde_json::Value,
}

impl ToolCall {
    /// Create a new tool call.
    pub fn new(name: &str, arguments: serde_json::Value) -> Self {
        Self {
            id: Uuid::now_v7().to_string(),
            name: name.to_string(),
            arguments,
        }
    }
}

/// Result data for a tool execution (for stream events).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResultData {
    /// The tool call this result responds to.
    pub tool_call_id: String,
    /// Whether the tool execution succeeded.
    pub success: bool,
    /// The result data (structured JSON, not stringified).
    pub data: serde_json::Value,
    /// Metadata about the result (counts, truncation info, etc.).
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub meta: HashMap<String, serde_json::Value>,
    /// Error message if execution failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// ============================================================================
// Stream Event Types
// ============================================================================

/// Events emitted during chat streaming.
///
/// All events include `thread_id`, `run_id`, and `message_id` for correlation
/// across reconnects. The stream ends with a terminal `Done` event.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AiStreamEvent {
    /// System event - metadata about the stream (sent first).
    #[serde(rename_all = "camelCase")]
    System {
        thread_id: String,
        run_id: String,
        message_id: String,
    },

    /// Text delta - partial text content.
    #[serde(rename_all = "camelCase")]
    TextDelta {
        thread_id: String,
        run_id: String,
        message_id: String,
        delta: String,
    },

    /// Reasoning delta - partial reasoning/thinking content (optional).
    #[serde(rename_all = "camelCase")]
    ReasoningDelta {
        thread_id: String,
        run_id: String,
        message_id: String,
        delta: String,
    },

    /// Tool call event - model wants to call a tool.
    #[serde(rename_all = "camelCase")]
    ToolCall {
        thread_id: String,
        run_id: String,
        message_id: String,
        tool_call: ToolCall,
    },

    /// Tool result event - tool execution completed.
    #[serde(rename_all = "camelCase")]
    ToolResult {
        thread_id: String,
        run_id: String,
        message_id: String,
        result: ToolResultData,
    },

    /// Error event - something went wrong.
    #[serde(rename_all = "camelCase")]
    Error {
        thread_id: String,
        run_id: String,
        message_id: Option<String>,
        code: String,
        message: String,
    },

    /// Done event - stream completed (terminal).
    #[serde(rename_all = "camelCase")]
    Done {
        thread_id: String,
        run_id: String,
        message_id: String,
        /// The complete assistant message with all content parts.
        message: ChatMessage,
        #[serde(skip_serializing_if = "Option::is_none")]
        usage: Option<UsageStats>,
    },

    /// Thread title updated event - sent after auto-generating title.
    #[serde(rename_all = "camelCase")]
    ThreadTitleUpdated {
        thread_id: String,
        run_id: String,
        title: String,
    },
}

impl AiStreamEvent {
    /// Create a system event (sent first in the stream).
    pub fn system(thread_id: &str, run_id: &str, message_id: &str) -> Self {
        Self::System {
            thread_id: thread_id.to_string(),
            run_id: run_id.to_string(),
            message_id: message_id.to_string(),
        }
    }

    /// Create a text delta event.
    pub fn text_delta(thread_id: &str, run_id: &str, message_id: &str, delta: &str) -> Self {
        Self::TextDelta {
            thread_id: thread_id.to_string(),
            run_id: run_id.to_string(),
            message_id: message_id.to_string(),
            delta: delta.to_string(),
        }
    }

    /// Create a reasoning delta event.
    pub fn reasoning_delta(thread_id: &str, run_id: &str, message_id: &str, delta: &str) -> Self {
        Self::ReasoningDelta {
            thread_id: thread_id.to_string(),
            run_id: run_id.to_string(),
            message_id: message_id.to_string(),
            delta: delta.to_string(),
        }
    }

    /// Create a tool call event.
    pub fn tool_call(thread_id: &str, run_id: &str, message_id: &str, tool_call: ToolCall) -> Self {
        Self::ToolCall {
            thread_id: thread_id.to_string(),
            run_id: run_id.to_string(),
            message_id: message_id.to_string(),
            tool_call,
        }
    }

    /// Create a tool result event.
    pub fn tool_result(
        thread_id: &str,
        run_id: &str,
        message_id: &str,
        result: ToolResultData,
    ) -> Self {
        Self::ToolResult {
            thread_id: thread_id.to_string(),
            run_id: run_id.to_string(),
            message_id: message_id.to_string(),
            result,
        }
    }

    /// Create an error event.
    pub fn error(
        thread_id: &str,
        run_id: &str,
        message_id: Option<&str>,
        code: &str,
        message: &str,
    ) -> Self {
        Self::Error {
            thread_id: thread_id.to_string(),
            run_id: run_id.to_string(),
            message_id: message_id.map(|s| s.to_string()),
            code: code.to_string(),
            message: message.to_string(),
        }
    }

    /// Create a done event.
    pub fn done(
        thread_id: &str,
        run_id: &str,
        message: ChatMessage,
        usage: Option<UsageStats>,
    ) -> Self {
        Self::Done {
            thread_id: thread_id.to_string(),
            run_id: run_id.to_string(),
            message_id: message.id.clone(),
            message,
            usage,
        }
    }

    /// Create a thread title updated event.
    pub fn thread_title_updated(thread_id: &str, run_id: &str, title: &str) -> Self {
        Self::ThreadTitleUpdated {
            thread_id: thread_id.to_string(),
            run_id: run_id.to_string(),
            title: title.to_string(),
        }
    }
}

/// Token usage statistics.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageStats {
    /// Number of prompt tokens used.
    pub prompt_tokens: u32,
    /// Number of completion tokens generated.
    pub completion_tokens: u32,
    /// Total tokens (prompt + completion).
    pub total_tokens: u32,
}

// ============================================================================
// Request Types
// ============================================================================

/// Model configuration for AI chat requests.
/// Matches the frontend's AiChatModelConfig type.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatModelConfig {
    /// Provider ID (e.g., "openai", "anthropic", "ollama").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// Model ID (e.g., "gpt-4o", "claude-3-sonnet", "llama3.2").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Override thinking/reasoning capability for this request.
    /// If None, uses the model's default capability from the catalog/settings.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<bool>,
}

/// Request to send a chat message.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[derive(Default)]
pub struct SendMessageRequest {
    /// Thread ID (creates new thread if not provided).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    /// The message content.
    pub content: String,
    /// Model configuration (provider and model selection).
    /// Takes precedence over deprecated provider_id/model_id fields.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config: Option<ChatModelConfig>,
    /// Override provider ID (uses default if not specified).
    /// @deprecated Use config.provider instead.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    /// Override model ID (uses provider default if not specified).
    /// @deprecated Use config.model instead.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    /// Tool allowlist for this request (uses all if not specified).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allowed_tools: Option<Vec<String>>,
    /// Parent message ID for edit operations.
    /// When set, AI context is truncated to this message (inclusive).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_message_id: Option<String>,
    /// File attachments (CSV, images, PDFs).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<MessageAttachment>>,
}

/// A file attachment sent with a chat message.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageAttachment {
    /// Original filename (e.g., "statement.pdf", "trades.csv").
    pub name: String,
    /// MIME type (e.g., "text/csv", "image/png", "application/pdf").
    pub content_type: String,
    /// File content: plain text for CSV, base64-encoded for images/PDFs.
    pub data: String,
}

impl SendMessageRequest {
    /// Get the effective provider ID (config takes precedence).
    pub fn effective_provider_id(&self) -> Option<&str> {
        self.config
            .as_ref()
            .and_then(|c| c.provider.as_deref())
            .or(self.provider_id.as_deref())
    }

    /// Get the effective model ID (config takes precedence).
    pub fn effective_model_id(&self) -> Option<&str> {
        self.config
            .as_ref()
            .and_then(|c| c.model.as_deref())
            .or(self.model_id.as_deref())
    }
}

// ============================================================================
// Simple Chat Message (for rig-core compatibility)
// ============================================================================

/// A simple chat message for building rig-core history.
///
/// This is a simplified format used internally to convert between
/// ChatMessage (rich, persisted) and rig-core's Message type.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimpleChatMessage {
    /// Message role as string (user, assistant, system, tool).
    pub role: String,
    /// Text content of the message.
    pub content: String,
}

impl SimpleChatMessage {
    /// Create a new user message.
    pub fn user(content: &str) -> Self {
        Self {
            role: "user".to_string(),
            content: content.to_string(),
        }
    }

    /// Create a new assistant message.
    pub fn assistant(content: &str) -> Self {
        Self {
            role: "assistant".to_string(),
            content: content.to_string(),
        }
    }

    /// Create a new system message.
    pub fn system(content: &str) -> Self {
        Self {
            role: "system".to_string(),
            content: content.to_string(),
        }
    }
}

/// Convert ChatMessage to SimpleChatMessage for rig-core.
impl From<&ChatMessage> for SimpleChatMessage {
    fn from(msg: &ChatMessage) -> Self {
        Self {
            role: msg.role.to_string(),
            content: msg.get_text(),
        }
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_thread_creation() {
        let thread = ChatThread::new();
        assert!(!thread.id.is_empty());
        assert!(thread.title.is_none());
    }

    #[test]
    fn test_message_content_serialization() {
        let content = ChatMessageContent::new(vec![
            ChatMessagePart::Text {
                content: "Hello".to_string(),
            },
            ChatMessagePart::ToolCall {
                tool_call_id: "tc-1".to_string(),
                name: "test".to_string(),
                arguments: serde_json::json!({}),
            },
        ]);

        let json = content.to_json().unwrap();
        assert!(json.contains("schemaVersion"));
        assert!(json.contains("text"));
        assert!(json.contains("toolCall"));
    }

    #[test]
    fn test_role_parsing() {
        assert_eq!(
            "user".parse::<ChatMessageRole>().unwrap(),
            ChatMessageRole::User
        );
        assert_eq!(
            "assistant".parse::<ChatMessageRole>().unwrap(),
            ChatMessageRole::Assistant
        );
        assert_eq!(
            "system".parse::<ChatMessageRole>().unwrap(),
            ChatMessageRole::System
        );
        assert_eq!(
            "tool".parse::<ChatMessageRole>().unwrap(),
            ChatMessageRole::Tool
        );
    }

    #[test]
    fn test_thread_config_creation() {
        let config = ChatThreadConfig::new("openai", "gpt-4o", "wealthfolio-assistant-v1", "1.0.0");
        assert_eq!(config.provider_id, "openai");
        assert_eq!(config.model_id, "gpt-4o");
        assert_eq!(config.prompt_template_id, "wealthfolio-assistant-v1");
        assert_eq!(config.prompt_version, "1.0.0");
        assert!(config.tools_allowlist.is_none());
    }

    #[test]
    fn test_thread_config_with_default_tools() {
        let config = ChatThreadConfig::new("anthropic", "claude-3-sonnet", "test", "1.0.0")
            .with_default_tools();
        assert!(config.tools_allowlist.is_some());
        let tools = config.get_tools_allowlist();
        assert!(tools.contains(&"get_holdings".to_string()));
        assert!(tools.contains(&"get_accounts".to_string()));
        assert!(tools.contains(&"get_cash_balances".to_string()));
    }

    #[test]
    fn test_normalize_tools_allowlist_expands_grouped_tools() {
        let tools = normalize_tools_allowlist(Some(vec![
            "get_accounts".to_string(),
            "get_holdings".to_string(),
            "search_activities".to_string(),
            "get_performance".to_string(),
            "get_income".to_string(),
            "get_asset_allocation".to_string(),
            "get_valuation_history".to_string(),
            "get_goals".to_string(),
        ]))
        .unwrap();

        assert!(tools.contains(&"get_cash_balances".to_string()));
        assert!(tools.contains(&"record_activity".to_string()));
        assert!(tools.contains(&"record_activities".to_string()));
        assert!(tools.contains(&"import_csv".to_string()));
        assert!(tools.contains(&"get_health_status".to_string()));
    }

    // Cross-tool allowlist coverage evals live in `crates/ai/tests/allowlist.rs`.

    #[test]
    fn test_normalize_tools_allowlist_preserves_empty_and_none() {
        assert!(normalize_tools_allowlist(None).is_none());
        assert_eq!(
            normalize_tools_allowlist(Some(Vec::new())),
            Some(Vec::new())
        );
    }

    #[test]
    fn test_tool_result_creation() {
        let result = ToolResult::ok(serde_json::json!({"value": 100}))
            .with_meta("count", 5)
            .with_truncation(100, 50);

        assert!(result.meta.contains_key("count"));
        assert!(result.meta.contains_key("truncated"));
        assert_eq!(result.meta["truncated"], true);
    }

    #[test]
    fn test_tool_result_metadata() {
        let result = ToolResult::ok(serde_json::json!({"test": true}))
            .with_duration_ms(150)
            .with_account_scope("acc-123")
            .with_count(42);

        assert_eq!(result.meta["durationMs"], 150);
        assert_eq!(result.meta["accountScope"], "acc-123");
        assert_eq!(result.meta["count"], 42);
    }

    #[test]
    fn test_ai_stream_event_serialization() {
        let event = AiStreamEvent::text_delta("thread-1", "run-1", "msg-1", "Hello");
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("textDelta"));
        assert!(json.contains("threadId"));
    }

    #[test]
    fn test_thread_title_updated_event_serialization() {
        let event =
            AiStreamEvent::thread_title_updated("thread-1", "run-1", "My Portfolio Summary");
        let json = serde_json::to_string(&event).unwrap();
        // Verify camelCase serialization: "threadTitleUpdated" as the type
        assert!(json.contains("threadTitleUpdated"));
        assert!(json.contains("threadId"));
        assert!(json.contains("runId"));
        assert!(json.contains("thread-1"));
        assert!(json.contains("My Portfolio Summary"));
    }

    #[test]
    fn test_simple_chat_message_from_chat_message() {
        let chat_msg = ChatMessage::user("thread-1", "Hello world");
        let simple_msg = SimpleChatMessage::from(&chat_msg);
        assert_eq!(simple_msg.role, "user");
        assert_eq!(simple_msg.content, "Hello world");
    }
}
