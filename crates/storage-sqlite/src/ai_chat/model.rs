//! Database models for AI chat persistence.
//!
//! Defines DB models for threads, messages, and the structured content_json schema.

use chrono::Utc;
use diesel::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::schema::{ai_messages, ai_thread_tags, ai_threads};

// ============================================================================
// Constants
// ============================================================================

/// Current schema version for message content JSON.
pub const CONTENT_SCHEMA_VERSION: u32 = 1;

/// Maximum size in bytes for persisted message content (256KB).
pub const MAX_CONTENT_SIZE_BYTES: usize = 256 * 1024;

// ============================================================================
// Database Models
// ============================================================================

/// Database model for AI chat threads.
#[derive(
    Debug,
    Clone,
    Queryable,
    Identifiable,
    Insertable,
    AsChangeset,
    Selectable,
    Serialize,
    Deserialize,
)]
#[diesel(table_name = ai_threads)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct AiThreadDB {
    pub id: String,
    pub title: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    /// JSON blob containing per-thread agent configuration snapshot.
    pub config_snapshot: Option<String>,
    /// Whether the thread is pinned to the top of the list.
    pub is_pinned: i32,
}

/// Database model for AI chat messages.
#[derive(
    Debug,
    Clone,
    Queryable,
    Identifiable,
    Insertable,
    AsChangeset,
    Selectable,
    Serialize,
    Deserialize,
)]
#[diesel(table_name = ai_messages)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct AiMessageDB {
    pub id: String,
    pub thread_id: String,
    pub role: String,
    pub content_json: String,
    pub created_at: String,
}

/// Database model for thread tags.
#[derive(
    Debug,
    Clone,
    Queryable,
    Identifiable,
    Insertable,
    AsChangeset,
    Selectable,
    Serialize,
    Deserialize,
)]
#[diesel(table_name = ai_thread_tags)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct AiThreadTagDB {
    pub id: String,
    pub thread_id: String,
    pub tag: String,
    pub created_at: String,
}

// ============================================================================
// Content JSON Schema (Versioned)
// ============================================================================

/// Root structure for message content stored as JSON.
/// Contains schema version for backward compatibility.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageContent {
    /// Schema version for backward compatibility.
    pub schema_version: u32,
    /// Ordered array of message parts representing the agent loop.
    pub parts: Vec<MessagePart>,
    /// Whether content was truncated due to size limits.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
    /// Token usage of the assistant turn, kept as the AI crate wrote it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<serde_json::Value>,
}

impl MessageContent {
    /// Create new message content with default schema version.
    pub fn new(parts: Vec<MessagePart>) -> Self {
        Self {
            schema_version: CONTENT_SCHEMA_VERSION,
            parts,
            truncated: false,
            usage: None,
        }
    }

    /// Create content for a simple text message.
    pub fn text(content: &str) -> Self {
        Self::new(vec![MessagePart::Text {
            content: content.to_string(),
        }])
    }

    /// Serialize to JSON string.
    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(self)
    }

    /// Deserialize from JSON string.
    pub fn from_json(json: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(json)
    }

    /// Serialize with size enforcement, truncating large tool payloads if needed.
    pub fn to_json_with_limit(&self, max_bytes: usize) -> Result<String, serde_json::Error> {
        let json = self.to_json()?;
        if json.len() <= max_bytes {
            return Ok(json);
        }

        // Need to truncate - create a copy with truncated payloads
        let mut truncated_content = self.clone();
        truncated_content.truncated = true;
        truncated_content.truncate_large_payloads(max_bytes);

        truncated_content.to_json()
    }

    /// Truncate large tool payloads while preserving metadata.
    fn truncate_large_payloads(&mut self, target_bytes: usize) {
        // Calculate overhead for structure
        let overhead = 100; // Approximate JSON structure overhead
        let available = target_bytes.saturating_sub(overhead);
        let part_count = self.parts.len().max(1);
        let per_part_budget = available / part_count;

        for part in &mut self.parts {
            match part {
                MessagePart::ToolCall { arguments, .. } => {
                    let json = serde_json::to_string(arguments).unwrap_or_default();
                    if json.len() > per_part_budget {
                        *arguments = serde_json::json!({
                            "_truncated": true,
                            "_originalSize": json.len()
                        });
                    }
                }
                MessagePart::ToolResult { data, meta, .. } => {
                    let json = serde_json::to_string(data).unwrap_or_default();
                    if json.len() > per_part_budget {
                        meta.insert("_truncated".to_string(), serde_json::json!(true));
                        meta.insert("_originalSize".to_string(), serde_json::json!(json.len()));
                        *data = serde_json::Value::Null;
                    }
                }
                MessagePart::Text { content } => {
                    if content.len() > per_part_budget {
                        content.truncate(per_part_budget.saturating_sub(20));
                        content.push_str("... [truncated]");
                    }
                }
                MessagePart::Reasoning { content } => {
                    if content.len() > per_part_budget {
                        content.truncate(per_part_budget.saturating_sub(20));
                        content.push_str("... [truncated]");
                    }
                }
                MessagePart::Error { message, .. } => {
                    if message.len() > per_part_budget {
                        message.truncate(per_part_budget.saturating_sub(20));
                        message.push_str("... [truncated]");
                    }
                }
                MessagePart::System { .. } => {
                    // System parts are typically small, skip truncation
                }
            }
        }
    }

    /// Get total text content from all text parts.
    pub fn get_text_content(&self) -> String {
        self.parts
            .iter()
            .filter_map(|p| match p {
                MessagePart::Text { content } => Some(content.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("")
    }
}

/// Individual message part types representing agent loop events.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MessagePart {
    /// System/metadata part.
    #[serde(rename_all = "camelCase")]
    System {
        /// System message content or metadata.
        content: String,
    },

    /// Text content delta (concatenated).
    #[serde(rename_all = "camelCase")]
    Text {
        /// The text content.
        content: String,
    },

    /// Reasoning/thinking content (optional, provider-dependent).
    #[serde(rename_all = "camelCase")]
    Reasoning {
        /// The reasoning content.
        content: String,
    },

    /// Tool call made by the assistant.
    #[serde(rename_all = "camelCase")]
    ToolCall {
        /// Unique tool call ID.
        tool_call_id: String,
        /// Name of the tool called.
        name: String,
        /// Arguments passed to the tool (structured JSON).
        arguments: serde_json::Value,
    },

    /// Result from tool execution.
    #[serde(rename_all = "camelCase")]
    ToolResult {
        /// The tool call ID this result responds to.
        tool_call_id: String,
        /// Whether execution succeeded.
        success: bool,
        /// Result data (structured JSON).
        data: serde_json::Value,
        /// Metadata (counts, truncation info, etc.).
        #[serde(default, skip_serializing_if = "HashMap::is_empty")]
        meta: HashMap<String, serde_json::Value>,
        /// Error message if failed.
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },

    /// Error event during processing.
    #[serde(rename_all = "camelCase")]
    Error {
        /// Error code for programmatic handling.
        code: String,
        /// Human-readable error message.
        message: String,
    },
}

// ============================================================================
// Conversion Implementations
// ============================================================================

impl AiThreadDB {
    /// Create a new thread DB model.
    pub fn new(id: String, title: Option<String>) -> Self {
        let now = Utc::now().to_rfc3339();
        Self {
            id,
            title,
            created_at: now.clone(),
            updated_at: now,
            config_snapshot: None,
            is_pinned: 0,
        }
    }

    /// Create a new thread DB model with config snapshot.
    pub fn with_config(id: String, title: Option<String>, config_snapshot: Option<String>) -> Self {
        let now = Utc::now().to_rfc3339();
        Self {
            id,
            title,
            created_at: now.clone(),
            updated_at: now,
            config_snapshot,
            is_pinned: 0,
        }
    }
}

impl AiMessageDB {
    /// Create a new message DB model.
    pub fn new(id: String, thread_id: String, role: String, content: MessageContent) -> Self {
        let content_json = content
            .to_json_with_limit(MAX_CONTENT_SIZE_BYTES)
            .unwrap_or_else(|_| r#"{"schemaVersion":1,"parts":[],"truncated":true}"#.to_string());

        Self {
            id,
            thread_id,
            role,
            content_json,
            created_at: Utc::now().to_rfc3339(),
        }
    }

    /// Parse the content_json field into MessageContent.
    pub fn parse_content(&self) -> Result<MessageContent, serde_json::Error> {
        MessageContent::from_json(&self.content_json)
    }
}

impl AiThreadTagDB {
    /// Create a new thread tag DB model.
    pub fn new(id: String, thread_id: String, tag: String) -> Self {
        Self {
            id,
            thread_id,
            tag,
            created_at: Utc::now().to_rfc3339(),
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
    fn test_message_content_serialization() {
        let content = MessageContent::new(vec![
            MessagePart::Text {
                content: "Hello!".to_string(),
            },
            MessagePart::ToolCall {
                tool_call_id: "tc-1".to_string(),
                name: "get_holdings".to_string(),
                arguments: serde_json::json!({"account_id": "123"}),
            },
        ]);

        let json = content.to_json().unwrap();
        assert!(json.contains("schemaVersion"));
        assert!(json.contains("Hello!"));
        assert!(json.contains("get_holdings"));

        let parsed = MessageContent::from_json(&json).unwrap();
        assert_eq!(parsed.schema_version, CONTENT_SCHEMA_VERSION);
        assert_eq!(parsed.parts.len(), 2);
    }

    #[test]
    fn test_truncation_with_limit() {
        let large_data = "x".repeat(300_000);
        let content = MessageContent::new(vec![MessagePart::Text {
            content: large_data,
        }]);

        let json = content.to_json_with_limit(MAX_CONTENT_SIZE_BYTES).unwrap();
        assert!(json.len() <= MAX_CONTENT_SIZE_BYTES);

        let parsed = MessageContent::from_json(&json).unwrap();
        assert!(parsed.truncated);
    }

    #[test]
    fn test_text_content_extraction() {
        let content = MessageContent::new(vec![
            MessagePart::Text {
                content: "Hello ".to_string(),
            },
            MessagePart::ToolCall {
                tool_call_id: "tc-1".to_string(),
                name: "test".to_string(),
                arguments: serde_json::json!({}),
            },
            MessagePart::Text {
                content: "World!".to_string(),
            },
        ]);

        assert_eq!(content.get_text_content(), "Hello World!");
    }

    #[test]
    fn test_message_part_types() {
        let parts = vec![
            MessagePart::System {
                content: "System init".to_string(),
            },
            MessagePart::Text {
                content: "User text".to_string(),
            },
            MessagePart::Reasoning {
                content: "Thinking...".to_string(),
            },
            MessagePart::ToolCall {
                tool_call_id: "tc-1".to_string(),
                name: "tool".to_string(),
                arguments: serde_json::json!({}),
            },
            MessagePart::ToolResult {
                tool_call_id: "tc-1".to_string(),
                success: true,
                data: serde_json::json!({"result": "ok"}),
                meta: HashMap::new(),
                error: None,
            },
            MessagePart::Error {
                code: "ERR_001".to_string(),
                message: "Something went wrong".to_string(),
            },
        ];

        let content = MessageContent::new(parts);
        let json = content.to_json().unwrap();

        // Verify all types serialize correctly
        assert!(json.contains("\"type\":\"system\""));
        assert!(json.contains("\"type\":\"text\""));
        assert!(json.contains("\"type\":\"reasoning\""));
        assert!(json.contains("\"type\":\"toolCall\""));
        assert!(json.contains("\"type\":\"toolResult\""));
        assert!(json.contains("\"type\":\"error\""));
    }
}
