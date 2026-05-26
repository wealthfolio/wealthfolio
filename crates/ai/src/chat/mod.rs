//! Chat orchestration - model ↔ tools ↔ model loop with streaming.
//!
//! This module provides the main chat streaming functionality using rig-core.
//! It handles:
//! - Building agents with tools via rig's AgentBuilder
//! - Streaming responses with text deltas and tool calls
//! - Multi-turn tool execution
//! - Emitting structured stream events for the frontend
//!
//! Sub-modules:
//! - `provider_clients`: per-provider rig client factories + Ollama preflight + error remapping.

mod attachments;
mod history;
mod provider_clients;
mod streaming;
mod working_context;

use attachments::{messages_have_attachment_markers, validate_attachments, SessionAttachmentCache};
use streaming::spawn_chat_stream;
use working_context::ChatWorkingContext;

use futures::stream::BoxStream;
use log::{debug, error, info};
use std::sync::Arc;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::env::AiEnvironment;
use crate::error::AiError;
use crate::providers::ProviderService;
use crate::title_generator::truncate_to_title;
use crate::tools::constants::MAX_HISTORY_CHARS;
use crate::types::{
    AiStreamEvent, ChatMessage, ChatMessagePart, ChatMessageRole, ChatThread, ListThreadsRequest,
    SendMessageRequest, SimpleChatMessage, ThreadPage,
};
// Used only by the inline `mod tests` (test-only fixtures + redact tests).
#[cfg(test)]
use crate::types::MessageAttachment;

fn derive_initial_thread_title(first_user_message: &str) -> Option<String> {
    let trimmed = first_user_message.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(truncate_to_title(trimmed, 50))
}

const REDACTED_CSV_CONTENT_PLACEHOLDER: &str =
    "[redacted: CSV content kept only in session memory]";

fn redact_tool_arguments_for_persistence(
    tool_name: &str,
    args: &serde_json::Value,
) -> serde_json::Value {
    if tool_name != "import_csv" {
        return args.clone();
    }

    let mut redacted = args.clone();
    if let Some(arguments) = redacted.as_object_mut() {
        if arguments.contains_key("csvContent") {
            arguments.insert(
                "csvContent".to_string(),
                serde_json::Value::String(REDACTED_CSV_CONTENT_PLACEHOLDER.to_string()),
            );
        }
        if arguments.contains_key("csv_content") {
            arguments.insert(
                "csv_content".to_string(),
                serde_json::Value::String(REDACTED_CSV_CONTENT_PLACEHOLDER.to_string()),
            );
        }
    }

    redacted
}

// ============================================================================
// Chat Stream Configuration
// ============================================================================

/// Configuration for chat streaming.
pub struct ChatConfig {
    /// Maximum number of tool call rounds before stopping.
    pub max_tool_rounds: usize,
    /// Maximum tokens for each completion.
    pub max_tokens: Option<u32>,
    /// Temperature for sampling.
    pub temperature: Option<f32>,
}

impl Default for ChatConfig {
    fn default() -> Self {
        Self {
            max_tool_rounds: 5,
            max_tokens: Some(4096),
            temperature: Some(0.7),
        }
    }
}

// ============================================================================
// Chat Service
// ============================================================================

/// Chat service for managing threads and streaming responses.
pub struct ChatService<E: AiEnvironment + 'static> {
    env: Arc<E>,
    session_attachments: Arc<SessionAttachmentCache>,
    #[allow(dead_code)]
    config: ChatConfig,
}

impl<E: AiEnvironment + 'static> ChatService<E> {
    /// Create a new chat service.
    pub fn new(env: Arc<E>, config: ChatConfig) -> Self {
        Self {
            env,
            session_attachments: Arc::new(SessionAttachmentCache::new()),
            config,
        }
    }

    /// Create a new chat thread and persist it to the repository.
    pub async fn create_thread(&self) -> Result<ChatThread, AiError> {
        let thread = ChatThread::new();
        self.env.chat_repository().create_thread(thread).await
    }

    /// Get a thread by ID from the repository.
    pub fn get_thread(&self, thread_id: &str) -> Result<Option<ChatThread>, AiError> {
        self.env.chat_repository().get_thread(thread_id)
    }

    /// Get messages for a thread from the repository.
    pub fn get_messages(&self, thread_id: &str) -> Result<Vec<ChatMessage>, AiError> {
        self.env.chat_repository().get_messages_by_thread(thread_id)
    }

    /// List all threads from the repository.
    pub fn list_threads(&self, limit: i64, offset: i64) -> Result<Vec<ChatThread>, AiError> {
        self.env.chat_repository().list_threads(limit, offset)
    }

    /// List threads with cursor-based pagination and optional search.
    pub fn list_threads_paginated(
        &self,
        request: &ListThreadsRequest,
    ) -> Result<ThreadPage, AiError> {
        self.env.chat_repository().list_threads_paginated(request)
    }

    /// Update thread title in the repository.
    pub async fn update_thread_title(
        &self,
        thread_id: &str,
        title: String,
    ) -> Result<ChatThread, AiError> {
        let repo = self.env.chat_repository();
        let thread = repo
            .get_thread(thread_id)?
            .ok_or_else(|| AiError::ThreadNotFound(thread_id.to_string()))?;

        let updated = ChatThread {
            title: Some(title),
            updated_at: chrono::Utc::now(),
            ..thread
        };
        repo.update_thread(updated).await
    }

    /// Update thread pinned status in the repository.
    pub async fn update_thread_pinned(
        &self,
        thread_id: &str,
        is_pinned: bool,
    ) -> Result<ChatThread, AiError> {
        let repo = self.env.chat_repository();
        let thread = repo
            .get_thread(thread_id)?
            .ok_or_else(|| AiError::ThreadNotFound(thread_id.to_string()))?;

        let updated = ChatThread {
            is_pinned,
            updated_at: chrono::Utc::now(),
            ..thread
        };
        repo.update_thread(updated).await
    }

    /// Delete a thread and its messages from the repository.
    pub async fn delete_thread(&self, thread_id: &str) -> Result<(), AiError> {
        self.env.chat_repository().delete_thread(thread_id).await?;
        self.session_attachments.clear_thread(thread_id);
        Ok(())
    }

    /// Send a message and get a streaming response.
    pub async fn send_message(
        &self,
        request: SendMessageRequest,
    ) -> Result<BoxStream<'static, AiStreamEvent>, AiError> {
        let repo = self.env.chat_repository();

        // Validate attachments sent with this request before creating/persisting anything.
        let incoming_attachments = request.attachments.clone().unwrap_or_default();
        validate_attachments(&incoming_attachments)?;

        // Get or create thread
        let (thread, is_new_thread, initial_title) = match &request.thread_id {
            Some(id) => {
                let thread = repo
                    .get_thread(id)?
                    .ok_or_else(|| AiError::ThreadNotFound(id.clone()))?;
                (thread, false, None)
            }
            None => {
                let mut new_thread = ChatThread::new();
                new_thread.title = derive_initial_thread_title(&request.content);
                let created = repo.create_thread(new_thread).await?;
                let initial_title = created.title.clone();
                (created, true, initial_title)
            }
        };

        let thread_id = thread.id.clone();
        info!("Processing message for thread {}", thread_id);

        // Load previous messages for context (history)
        let mut previous_messages = repo.get_messages_by_thread(&thread_id)?;

        // When editing a message, truncate context to the parent message (inclusive)
        if let Some(ref parent_id) = request.parent_message_id {
            if let Some(parent_pos) = previous_messages.iter().position(|m| m.id == *parent_id) {
                previous_messages.truncate(parent_pos + 1);
            }
        }

        // Build history with a reverse character-budget window:
        // take messages from most recent backwards until the budget is exhausted.
        let mut history_messages: Vec<SimpleChatMessage> = Vec::new();
        let mut budget = MAX_HISTORY_CHARS;
        let mut skipped_empty: usize = 0;
        for msg in previous_messages.iter().rev() {
            let text = msg.content.get_text_content();
            if text.is_empty() {
                skipped_empty += 1;
                continue;
            }
            let simple = match msg.role {
                ChatMessageRole::User => SimpleChatMessage::user(&text),
                ChatMessageRole::Assistant => SimpleChatMessage::assistant(&text),
                _ => continue,
            };
            if text.len() > budget {
                break;
            }
            budget -= text.len();
            history_messages.push(simple);
        }
        history_messages.reverse();
        debug!(
            "Thread {} history: {} msgs sent, {} stored in db, {} skipped (empty text_content)",
            thread_id,
            history_messages.len(),
            previous_messages.len(),
            skipped_empty,
        );

        let effective_attachments = self
            .session_attachments
            .resolve_for_thread(&thread_id, &incoming_attachments)?;
        let prior_attachment_content_unavailable = incoming_attachments.is_empty()
            && effective_attachments.is_empty()
            && messages_have_attachment_markers(&previous_messages);
        let working_context = ChatWorkingContext::from_messages_and_attachments(
            &previous_messages,
            &effective_attachments,
        );

        // Save user message with attachment placeholders (no binary data stored)
        let mut persist_text = request.content.clone();
        for att in &incoming_attachments {
            persist_text.push_str(&format!("\n\u{1F4CE} {}", att.name));
        }
        let user_message = ChatMessage::user(&thread_id, &persist_text);
        repo.create_message(user_message).await?;

        // Get provider settings
        let provider_service = ProviderService::new(self.env.clone());
        let settings = provider_service.get_settings()?;

        let provider_id = request
            .effective_provider_id()
            .map(|s| s.to_string())
            .unwrap_or_else(|| settings.provider_id.clone());
        let model_id = request
            .effective_model_id()
            .map(|s| s.to_string())
            .unwrap_or_else(|| settings.model.clone());

        debug!("Using provider {} with model {}", provider_id, model_id);

        // Generate IDs for this run
        let run_id = Uuid::now_v7().to_string();
        let message_id = Uuid::now_v7().to_string();

        // Create channel for events
        let (tx, rx) = mpsc::channel::<AiStreamEvent>(100);

        // Clone what we need for the async task
        let env = self.env.clone();
        let content = request.content.clone();
        let thread_id_clone = thread_id.clone();
        let run_id_clone = run_id.clone();
        let message_id_clone = message_id.clone();
        let thread_title = thread.title.clone();
        let initial_title_clone = initial_title.clone();
        let is_new_thread_clone = is_new_thread;
        let thinking_override = request.config.as_ref().and_then(|c| c.thinking);

        // Spawn the streaming task
        tokio::spawn(async move {
            if let Err(e) = spawn_chat_stream(
                env,
                tx.clone(),
                content,
                history_messages,
                effective_attachments,
                provider_id,
                model_id,
                thread_id_clone.clone(),
                run_id_clone.clone(),
                message_id_clone,
                thread_title,
                initial_title_clone,
                is_new_thread_clone,
                thinking_override,
                prior_attachment_content_unavailable,
                working_context,
            )
            .await
            {
                error!("Chat stream error: {}", e);
                let _ = tx
                    .send(AiStreamEvent::error(
                        &thread_id_clone,
                        &run_id_clone,
                        None,
                        e.code(),
                        &e.to_string(),
                    ))
                    .await;
            }
        });

        // Convert receiver to stream
        let stream = tokio_stream::wrappers::ReceiverStream::new(rx);
        Ok(Box::pin(stream))
    }

    /// List available tool names.
    pub fn list_tools(&self) -> Vec<String> {
        vec![
            "get_holdings".to_string(),
            "get_accounts".to_string(),
            "search_activities".to_string(),
            "get_goals".to_string(),
            "get_valuation_history".to_string(),
            "get_income".to_string(),
            "get_asset_allocation".to_string(),
            "get_performance".to_string(),
            "record_activity".to_string(),
            "record_activities".to_string(),
            "import_csv".to_string(),
        ]
    }

    /// Get environment reference.
    pub fn env(&self) -> &Arc<E> {
        &self.env
    }

    /// Update a tool result in a message by merging a patch into the result data.
    ///
    /// This is used by the frontend to persist submission state for mutation tools
    /// (e.g., record_activity). After the user confirms and the activity is created,
    /// the frontend calls this to store the created_activity_id in the tool result.
    ///
    /// The thread_id is used to search for the message containing the tool_call_id.
    pub async fn update_tool_result(
        &self,
        thread_id: &str,
        tool_call_id: &str,
        result_patch: serde_json::Value,
    ) -> Result<ChatMessage, AiError> {
        let repo = self.env.chat_repository();

        // Get all messages in the thread to find the one with this tool call
        let messages = repo.get_messages_by_thread(thread_id)?;

        // Find the message containing this tool_call_id
        let mut target_message: Option<ChatMessage> = None;
        for msg in messages {
            for part in &msg.content.parts {
                if let ChatMessagePart::ToolResult {
                    tool_call_id: ref id,
                    ..
                } = part
                {
                    if id == tool_call_id {
                        target_message = Some(msg);
                        break;
                    }
                }
            }
            if target_message.is_some() {
                break;
            }
        }

        let mut message = target_message.ok_or_else(|| {
            AiError::InvalidInput(format!(
                "Tool result not found for tool_call_id: {}",
                tool_call_id
            ))
        })?;

        // Find and update the tool result part
        for part in &mut message.content.parts {
            if let ChatMessagePart::ToolResult {
                tool_call_id: ref id,
                ref mut data,
                ref mut meta,
                ..
            } = part
            {
                if id == tool_call_id {
                    // Merge the patch into data
                    if let serde_json::Value::Object(patch_obj) = &result_patch {
                        if let serde_json::Value::Object(data_obj) = data {
                            for (key, value) in patch_obj {
                                data_obj.insert(key.clone(), value.clone());
                            }
                        }
                        // Also store in meta for easier access
                        for (key, value) in patch_obj {
                            meta.insert(key.clone(), value.clone());
                        }
                    }
                    break;
                }
            }
        }

        // Save the updated message
        repo.update_message(message).await
    }
}

// Provider client factories + ollama preflight + provider-error remapping live in
// `provider_clients` (sibling module). Imported below as needed.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::env::test_env::MockEnvironment;

    fn test_attachment(name: &str, data: &str) -> MessageAttachment {
        MessageAttachment {
            name: name.to_string(),
            content_type: "text/csv".to_string(),
            data: data.to_string(),
        }
    }

    #[tokio::test]
    async fn test_chat_service_create_thread() {
        let env = Arc::new(MockEnvironment::new());
        let service = ChatService::new(env, ChatConfig::default());

        let thread = service.create_thread().await.unwrap();
        assert!(!thread.id.is_empty());
    }

    #[tokio::test]
    async fn test_chat_service_create_and_get_thread() {
        let env = Arc::new(MockEnvironment::new());
        let service = ChatService::new(env, ChatConfig::default());

        let thread = service.create_thread().await.unwrap();
        let thread_id = thread.id.clone();

        let retrieved = service.get_thread(&thread_id).unwrap();
        assert!(retrieved.is_some());
        assert_eq!(retrieved.unwrap().id, thread_id);
    }

    #[test]
    fn test_chat_service_list_tools() {
        let env = Arc::new(MockEnvironment::new());
        let service = ChatService::new(env, ChatConfig::default());

        let tools = service.list_tools();
        assert!(tools.contains(&"get_accounts".to_string()));
        assert!(tools.contains(&"get_holdings".to_string()));
    }

    #[test]
    fn test_redact_import_csv_tool_arguments_for_persistence() {
        let args = serde_json::json!({
            "csvContent": "Date,Symbol\n2025-01-01,AAPL",
            "accountId": "acct-test"
        });

        let redacted = redact_tool_arguments_for_persistence("import_csv", &args);
        let serialized = serde_json::to_string(&redacted).unwrap();

        assert_eq!(redacted["accountId"], "acct-test");
        assert_eq!(redacted["csvContent"], REDACTED_CSV_CONTENT_PLACEHOLDER);
        assert!(!serialized.contains("2025-01-01,AAPL"));
    }

    #[tokio::test]
    async fn test_chat_service_clears_cached_attachments_when_thread_is_deleted() {
        let env = Arc::new(MockEnvironment::new());
        let service = ChatService::new(env, ChatConfig::default());

        let thread = service.create_thread().await.unwrap();
        let thread_id = thread.id.clone();
        let attachment = test_attachment("trades.csv", "a,b\n1,2");

        service
            .session_attachments
            .resolve_for_thread(&thread_id, &[attachment])
            .unwrap();
        assert_eq!(
            service
                .session_attachments
                .resolve_for_thread(&thread_id, &[])
                .unwrap()
                .len(),
            1
        );

        service.delete_thread(&thread_id).await.unwrap();

        assert!(service
            .session_attachments
            .resolve_for_thread(&thread_id, &[])
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn test_chat_service_update_thread_title() {
        let env = Arc::new(MockEnvironment::new());
        let service = ChatService::new(env, ChatConfig::default());

        let thread = service.create_thread().await.unwrap();
        let thread_id = thread.id.clone();

        let updated = service
            .update_thread_title(&thread_id, "New Title".to_string())
            .await
            .unwrap();
        assert_eq!(updated.title, Some("New Title".to_string()));

        // Verify it persists
        let retrieved = service.get_thread(&thread_id).unwrap().unwrap();
        assert_eq!(retrieved.title, Some("New Title".to_string()));
    }

    #[tokio::test]
    async fn test_chat_service_delete_thread() {
        let env = Arc::new(MockEnvironment::new());
        let service = ChatService::new(env, ChatConfig::default());

        let thread = service.create_thread().await.unwrap();
        let thread_id = thread.id.clone();

        service.delete_thread(&thread_id).await.unwrap();

        let retrieved = service.get_thread(&thread_id).unwrap();
        assert!(retrieved.is_none());
    }

    #[tokio::test]
    async fn test_chat_service_list_threads() {
        let env = Arc::new(MockEnvironment::new());
        let service = ChatService::new(env, ChatConfig::default());

        // Create a few threads
        service.create_thread().await.unwrap();
        service.create_thread().await.unwrap();
        service.create_thread().await.unwrap();

        let threads = service.list_threads(10, 0).unwrap();
        assert_eq!(threads.len(), 3);
    }

    // ollama_model_matches + remap_provider_error tests live in
    // `chat/provider_clients.rs` next to the implementation.

    // System-prompt content evals live in `crates/ai/tests/system_prompt.rs`
    // (cross-module contract checks belong with integration tests, not inline).
}
