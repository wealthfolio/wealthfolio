//! Repository for AI chat persistence.
//!
//! Provides CRUD operations for chat threads and messages.
//! Implements the `ChatRepositoryTrait` from wealthfolio-ai.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use diesel::prelude::*;
use diesel::r2d2::{ConnectionManager, Pool};
use diesel::sqlite::SqliteConnection;
use std::sync::Arc;

use wealthfolio_ai::{
    AiError, ChatMessage, ChatMessageContent, ChatMessagePart, ChatMessageRole,
    ChatRepositoryResult, ChatRepositoryTrait, ChatThread, ChatThreadConfig, ListThreadsRequest,
    ThreadPage, CHAT_MAX_CONTENT_SIZE_BYTES,
};
use wealthfolio_core::errors::{DatabaseError, ValidationError};
use wealthfolio_core::{Error as CoreError, Result as CoreResult};

use crate::db::{get_connection, WriteHandle};
use crate::schema::{ai_messages, ai_thread_tags, ai_threads};

use super::model::{AiMessageDB, AiThreadDB, AiThreadTagDB, MessageContent, MessagePart};

// ============================================================================
// Helper: Convert CoreError to AiError
// ============================================================================

fn core_to_ai_error(e: CoreError) -> AiError {
    AiError::Core(e)
}

// ============================================================================
// Repository Implementation
// ============================================================================

/// SQLite implementation of AI chat repository.
pub struct AiChatRepository {
    pool: Arc<Pool<ConnectionManager<SqliteConnection>>>,
    writer: WriteHandle,
}

impl AiChatRepository {
    /// Create a new AI chat repository.
    pub fn new(pool: Arc<Pool<ConnectionManager<SqliteConnection>>>, writer: WriteHandle) -> Self {
        Self { pool, writer }
    }
}

#[async_trait]
impl ChatRepositoryTrait for AiChatRepository {
    // ========================================================================
    // Thread Operations
    // ========================================================================

    async fn create_thread(&self, thread: ChatThread) -> ChatRepositoryResult<ChatThread> {
        let thread_db = thread_to_db(&thread);
        let thread_id = thread_db.id.clone();

        self.writer
            .exec_tx(move |tx| -> CoreResult<ChatThread> {
                diesel::insert_into(ai_threads::table)
                    .values(&thread_db)
                    .execute(tx.conn())
                    .map_err(|e| CoreError::Database(DatabaseError::QueryFailed(e.to_string())))?;

                let db = ai_threads::table
                    .find(&thread_id)
                    .first::<AiThreadDB>(tx.conn())
                    .map_err(|e| CoreError::Database(DatabaseError::QueryFailed(e.to_string())))?;

                tx.insert(&db)?;

                Ok(db_to_thread(&db))
            })
            .await
            .map_err(core_to_ai_error)
    }

    fn get_thread(&self, thread_id: &str) -> ChatRepositoryResult<Option<ChatThread>> {
        let mut conn = get_connection(&self.pool).map_err(core_to_ai_error)?;

        let result = ai_threads::table
            .find(thread_id)
            .first::<AiThreadDB>(&mut conn)
            .optional()
            .map_err(|e| {
                AiError::Core(CoreError::Database(DatabaseError::QueryFailed(
                    e.to_string(),
                )))
            })?;

        Ok(result.map(|db| db_to_thread(&db)))
    }

    fn list_threads(&self, limit: i64, offset: i64) -> ChatRepositoryResult<Vec<ChatThread>> {
        let mut conn = get_connection(&self.pool).map_err(core_to_ai_error)?;

        // Sort by pinned status first (pinned at top), then by updated_at
        let threads_db = ai_threads::table
            .order((ai_threads::is_pinned.desc(), ai_threads::updated_at.desc()))
            .limit(limit)
            .offset(offset)
            .load::<AiThreadDB>(&mut conn)
            .map_err(|e| {
                AiError::Core(CoreError::Database(DatabaseError::QueryFailed(
                    e.to_string(),
                )))
            })?;

        // Load tags for each thread
        let mut threads: Vec<ChatThread> = Vec::with_capacity(threads_db.len());
        for db in threads_db {
            let mut thread = db_to_thread(&db);
            thread.tags = ai_thread_tags::table
                .filter(ai_thread_tags::thread_id.eq(&db.id))
                .select(ai_thread_tags::tag)
                .load::<String>(&mut conn)
                .unwrap_or_default();
            threads.push(thread);
        }

        Ok(threads)
    }

    fn list_threads_paginated(
        &self,
        request: &ListThreadsRequest,
    ) -> ChatRepositoryResult<ThreadPage> {
        let mut conn = get_connection(&self.pool).map_err(core_to_ai_error)?;

        let limit = request.limit.unwrap_or(20).min(100) as i64;

        // Build base query with optional search filter
        let mut query = ai_threads::table.into_boxed();

        // Apply search filter if provided (treat empty/whitespace as "no search")
        if let Some(search) = request
            .search
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let search_pattern = format!("%{}%", search);
            query = query.filter(ai_threads::title.like(search_pattern));
        }

        // Apply cursor if provided (format: "is_pinned:updated_at:id")
        // The filter expressions use bound parameters that require owned values.
        if let Some(cursor) = &request.cursor {
            let (cursor_pinned, cursor_updated_at, cursor_id) = parse_cursor(cursor)?;

            // For cursor-based pagination with composite sort (is_pinned DESC, updated_at DESC, id DESC):
            // We need to fetch rows that come AFTER the cursor position.
            // A row comes after if:
            // 1. is_pinned < cursor_pinned, OR
            // 2. is_pinned = cursor_pinned AND updated_at < cursor_updated_at, OR
            // 3. is_pinned = cursor_pinned AND updated_at = cursor_updated_at AND id < cursor_id
            query = query.filter(
                ai_threads::is_pinned
                    .lt(cursor_pinned)
                    .or(ai_threads::is_pinned
                        .eq(cursor_pinned)
                        .and(ai_threads::updated_at.lt(cursor_updated_at.clone())))
                    .or(ai_threads::is_pinned
                        .eq(cursor_pinned)
                        .and(ai_threads::updated_at.eq(cursor_updated_at))
                        .and(ai_threads::id.lt(cursor_id))),
            );
        }

        // Order by pinned status (desc), then updated_at (desc), then id (desc) for stable ordering
        query = query.order((
            ai_threads::is_pinned.desc(),
            ai_threads::updated_at.desc(),
            ai_threads::id.desc(),
        ));

        // Fetch limit + 1 to check if there are more
        let threads_db = query
            .limit(limit + 1)
            .load::<AiThreadDB>(&mut conn)
            .map_err(|e| {
                AiError::Core(CoreError::Database(DatabaseError::QueryFailed(
                    e.to_string(),
                )))
            })?;

        let has_more = threads_db.len() > limit as usize;
        let threads_db: Vec<_> = threads_db.into_iter().take(limit as usize).collect();

        // Load tags for each thread
        let mut threads: Vec<ChatThread> = Vec::with_capacity(threads_db.len());
        for db in &threads_db {
            let mut thread = db_to_thread(db);
            thread.tags = ai_thread_tags::table
                .filter(ai_thread_tags::thread_id.eq(&db.id))
                .select(ai_thread_tags::tag)
                .load::<String>(&mut conn)
                .unwrap_or_default();
            threads.push(thread);
        }

        // Generate next cursor from the last thread
        let next_cursor = if has_more {
            threads_db
                .last()
                .map(|t| encode_cursor(t.is_pinned, &t.updated_at, &t.id))
        } else {
            None
        };

        Ok(ThreadPage {
            threads,
            next_cursor,
            has_more,
        })
    }

    async fn update_thread(&self, thread: ChatThread) -> ChatRepositoryResult<ChatThread> {
        let thread_id = thread.id.clone();
        let title = thread.title.clone();
        let is_pinned: i32 = if thread.is_pinned { 1 } else { 0 };
        let config_snapshot = thread
            .config
            .as_ref()
            .and_then(|c| serde_json::to_string(c).ok());
        let updated_at = Utc::now().to_rfc3339();

        self.writer
            .exec_tx(move |tx| -> CoreResult<ChatThread> {
                diesel::update(ai_threads::table.find(&thread_id))
                    .set((
                        ai_threads::title.eq(&title),
                        ai_threads::is_pinned.eq(&is_pinned),
                        ai_threads::config_snapshot.eq(&config_snapshot),
                        ai_threads::updated_at.eq(&updated_at),
                    ))
                    .execute(tx.conn())
                    .map_err(|e| CoreError::Database(DatabaseError::QueryFailed(e.to_string())))?;

                let db = ai_threads::table
                    .find(&thread_id)
                    .first::<AiThreadDB>(tx.conn())
                    .map_err(|e| CoreError::Database(DatabaseError::QueryFailed(e.to_string())))?;

                tx.update(&db)?;

                Ok(db_to_thread(&db))
            })
            .await
            .map_err(core_to_ai_error)
    }

    async fn delete_thread(&self, thread_id: &str) -> ChatRepositoryResult<()> {
        let thread_id = thread_id.to_string();
        self.writer
            .exec_tx(move |tx| -> CoreResult<()> {
                // CASCADE will delete messages and tags automatically
                let affected = diesel::delete(ai_threads::table.find(&thread_id))
                    .execute(tx.conn())
                    .map_err(|e| CoreError::Database(DatabaseError::QueryFailed(e.to_string())))?;
                if affected > 0 {
                    tx.delete::<AiThreadDB>(thread_id.clone());
                }
                Ok(())
            })
            .await
            .map_err(core_to_ai_error)
    }

    // ========================================================================
    // Message Operations
    // ========================================================================

    async fn create_message(&self, message: ChatMessage) -> ChatRepositoryResult<ChatMessage> {
        let message_db = message_to_db(&message)?;
        let message_id = message_db.id.clone();
        let thread_id = message_db.thread_id.clone();

        self.writer
            .exec_tx(move |tx| -> CoreResult<ChatMessage> {
                // Insert message
                diesel::insert_into(ai_messages::table)
                    .values(&message_db)
                    .execute(tx.conn())
                    .map_err(|e| CoreError::Database(DatabaseError::QueryFailed(e.to_string())))?;

                // Update thread's updated_at
                diesel::update(ai_threads::table.find(&thread_id))
                    .set(ai_threads::updated_at.eq(chrono::Utc::now().to_rfc3339()))
                    .execute(tx.conn())
                    .map_err(|e| CoreError::Database(DatabaseError::QueryFailed(e.to_string())))?;

                let thread_db = ai_threads::table
                    .find(&thread_id)
                    .first::<AiThreadDB>(tx.conn())
                    .map_err(|e| CoreError::Database(DatabaseError::QueryFailed(e.to_string())))?;

                let db = ai_messages::table
                    .find(&message_id)
                    .first::<AiMessageDB>(tx.conn())
                    .map_err(|e| CoreError::Database(DatabaseError::QueryFailed(e.to_string())))?;

                tx.insert(&db)?;
                tx.update(&thread_db)?;

                db_to_message(&db).map_err(|e| match e {
                    AiError::InvalidInput(msg) => {
                        CoreError::Validation(ValidationError::InvalidInput(msg))
                    }
                    _ => CoreError::Database(DatabaseError::QueryFailed(e.to_string())),
                })
            })
            .await
            .map_err(core_to_ai_error)
    }

    fn get_message(&self, message_id: &str) -> ChatRepositoryResult<Option<ChatMessage>> {
        let mut conn = get_connection(&self.pool).map_err(core_to_ai_error)?;

        let result = ai_messages::table
            .find(message_id)
            .first::<AiMessageDB>(&mut conn)
            .optional()
            .map_err(|e| {
                AiError::Core(CoreError::Database(DatabaseError::QueryFailed(
                    e.to_string(),
                )))
            })?;

        match result {
            Some(db) => Ok(Some(db_to_message(&db)?)),
            None => Ok(None),
        }
    }

    fn get_messages_by_thread(&self, thread_id: &str) -> ChatRepositoryResult<Vec<ChatMessage>> {
        let mut conn = get_connection(&self.pool).map_err(core_to_ai_error)?;

        let messages_db = ai_messages::table
            .filter(ai_messages::thread_id.eq(thread_id))
            .order(ai_messages::created_at.asc())
            .load::<AiMessageDB>(&mut conn)
            .map_err(|e| {
                AiError::Core(CoreError::Database(DatabaseError::QueryFailed(
                    e.to_string(),
                )))
            })?;

        messages_db
            .iter()
            .map(db_to_message)
            .collect::<ChatRepositoryResult<Vec<_>>>()
    }

    async fn update_message(&self, message: ChatMessage) -> ChatRepositoryResult<ChatMessage> {
        let message_id = message.id.clone();
        let content_json = convert_content_to_json(&message.content)?;

        self.writer
            .exec_tx(move |tx| -> CoreResult<ChatMessage> {
                diesel::update(ai_messages::table.find(&message_id))
                    .set(ai_messages::content_json.eq(&content_json))
                    .execute(tx.conn())
                    .map_err(|e| CoreError::Database(DatabaseError::QueryFailed(e.to_string())))?;

                let db = ai_messages::table
                    .find(&message_id)
                    .first::<AiMessageDB>(tx.conn())
                    .map_err(|e| CoreError::Database(DatabaseError::QueryFailed(e.to_string())))?;

                tx.update(&db)?;

                db_to_message(&db).map_err(|e| match e {
                    AiError::InvalidInput(msg) => {
                        CoreError::Validation(ValidationError::InvalidInput(msg))
                    }
                    _ => CoreError::Database(DatabaseError::QueryFailed(e.to_string())),
                })
            })
            .await
            .map_err(core_to_ai_error)
    }

    // ========================================================================
    // Tag Operations
    // ========================================================================

    async fn add_tag(&self, thread_id: &str, tag: &str) -> ChatRepositoryResult<()> {
        let tag_db = AiThreadTagDB::new(
            uuid::Uuid::new_v4().to_string(),
            thread_id.to_string(),
            tag.to_string(),
        );

        self.writer
            .exec_tx(move |tx| -> CoreResult<()> {
                let inserted = diesel::insert_into(ai_thread_tags::table)
                    .values(&tag_db)
                    .on_conflict((ai_thread_tags::thread_id, ai_thread_tags::tag))
                    .do_nothing()
                    .execute(tx.conn())
                    .map_err(|e| CoreError::Database(DatabaseError::QueryFailed(e.to_string())))?;
                if inserted > 0 {
                    tx.insert(&tag_db)?;
                }
                Ok(())
            })
            .await
            .map_err(core_to_ai_error)
    }

    async fn remove_tag(&self, thread_id: &str, tag: &str) -> ChatRepositoryResult<()> {
        let thread_id = thread_id.to_string();
        let tag = tag.to_string();

        self.writer
            .exec_tx(move |tx| -> CoreResult<()> {
                let existing_ids = ai_thread_tags::table
                    .filter(ai_thread_tags::thread_id.eq(&thread_id))
                    .filter(ai_thread_tags::tag.eq(&tag))
                    .select(ai_thread_tags::id)
                    .load::<String>(tx.conn())
                    .map_err(|e| CoreError::Database(DatabaseError::QueryFailed(e.to_string())))?;

                diesel::delete(
                    ai_thread_tags::table
                        .filter(ai_thread_tags::thread_id.eq(&thread_id))
                        .filter(ai_thread_tags::tag.eq(&tag)),
                )
                .execute(tx.conn())
                .map_err(|e| CoreError::Database(DatabaseError::QueryFailed(e.to_string())))?;

                for id in existing_ids {
                    tx.delete::<AiThreadTagDB>(id.clone());
                }
                Ok(())
            })
            .await
            .map_err(core_to_ai_error)
    }

    fn get_tags(&self, thread_id: &str) -> ChatRepositoryResult<Vec<String>> {
        let mut conn = get_connection(&self.pool).map_err(core_to_ai_error)?;

        ai_thread_tags::table
            .filter(ai_thread_tags::thread_id.eq(thread_id))
            .select(ai_thread_tags::tag)
            .load::<String>(&mut conn)
            .map_err(|e| {
                AiError::Core(CoreError::Database(DatabaseError::QueryFailed(
                    e.to_string(),
                )))
            })
    }
}

// ============================================================================
// Cursor Helper Functions
// ============================================================================

/// Parse a cursor string into its components (is_pinned, updated_at, id).
/// Cursor format: "is_pinned:updated_at:id" where is_pinned is 0 or 1.
fn parse_cursor(cursor: &str) -> ChatRepositoryResult<(i32, String, String)> {
    let parts: Vec<&str> = cursor.splitn(3, ':').collect();
    if parts.len() != 3 {
        return Err(AiError::InvalidCursor(format!(
            "Expected format 'is_pinned:updated_at:id', got '{}'",
            cursor
        )));
    }

    let is_pinned: i32 = parts[0]
        .parse()
        .map_err(|_| AiError::InvalidCursor(format!("Invalid is_pinned value: {}", parts[0])))?;

    Ok((is_pinned, parts[1].to_string(), parts[2].to_string()))
}

/// Encode a cursor from thread fields.
fn encode_cursor(is_pinned: i32, updated_at: &str, id: &str) -> String {
    format!("{}:{}:{}", is_pinned, updated_at, id)
}

// ============================================================================
// Conversion Functions
// ============================================================================

fn thread_to_db(thread: &ChatThread) -> AiThreadDB {
    // Serialize config snapshot to JSON if present
    let config_snapshot = thread
        .config
        .as_ref()
        .and_then(|c| serde_json::to_string(c).ok());

    AiThreadDB {
        id: thread.id.clone(),
        title: thread.title.clone(),
        created_at: thread.created_at.to_rfc3339(),
        updated_at: thread.updated_at.to_rfc3339(),
        config_snapshot,
        is_pinned: if thread.is_pinned { 1 } else { 0 },
    }
}

fn db_to_thread(db: &AiThreadDB) -> ChatThread {
    // Parse config snapshot from JSON if present
    let config = db
        .config_snapshot
        .as_ref()
        .and_then(|json| serde_json::from_str::<ChatThreadConfig>(json).ok());

    ChatThread {
        id: db.id.clone(),
        title: db.title.clone(),
        is_pinned: db.is_pinned != 0,
        tags: Vec::new(), // Tags are loaded separately
        config,
        created_at: DateTime::parse_from_rfc3339(&db.created_at)
            .map(|dt| dt.with_timezone(&Utc))
            .unwrap_or_else(|_| Utc::now()),
        updated_at: DateTime::parse_from_rfc3339(&db.updated_at)
            .map(|dt| dt.with_timezone(&Utc))
            .unwrap_or_else(|_| Utc::now()),
    }
}

fn message_to_db(msg: &ChatMessage) -> ChatRepositoryResult<AiMessageDB> {
    let content_json = convert_content_to_json(&msg.content)?;

    Ok(AiMessageDB {
        id: msg.id.clone(),
        thread_id: msg.thread_id.clone(),
        role: msg.role.to_string(),
        content_json,
        created_at: msg.created_at.to_rfc3339(),
    })
}

fn db_to_message(db: &AiMessageDB) -> ChatRepositoryResult<ChatMessage> {
    let content = convert_json_to_content(&db.content_json)?;
    let role = db
        .role
        .parse::<ChatMessageRole>()
        .map_err(AiError::InvalidInput)?;

    Ok(ChatMessage {
        id: db.id.clone(),
        thread_id: db.thread_id.clone(),
        role,
        content,
        created_at: DateTime::parse_from_rfc3339(&db.created_at)
            .map(|dt| dt.with_timezone(&Utc))
            .unwrap_or_else(|_| Utc::now()),
    })
}

/// Convert ChatMessageContent to JSON string for storage.
fn convert_content_to_json(content: &ChatMessageContent) -> ChatRepositoryResult<String> {
    // Convert core parts to storage parts
    let storage_parts: Vec<MessagePart> = content
        .parts
        .iter()
        .map(|p| match p {
            ChatMessagePart::System { content } => MessagePart::System {
                content: content.clone(),
            },
            ChatMessagePart::Text { content } => MessagePart::Text {
                content: content.clone(),
            },
            ChatMessagePart::Reasoning { content } => MessagePart::Reasoning {
                content: content.clone(),
            },
            ChatMessagePart::ToolCall {
                tool_call_id,
                name,
                arguments,
            } => MessagePart::ToolCall {
                tool_call_id: tool_call_id.clone(),
                name: name.clone(),
                arguments: arguments.clone(),
            },
            ChatMessagePart::ToolResult {
                tool_call_id,
                success,
                data,
                meta,
                error,
            } => MessagePart::ToolResult {
                tool_call_id: tool_call_id.clone(),
                success: *success,
                data: data.clone(),
                meta: meta.clone(),
                error: error.clone(),
            },
            ChatMessagePart::Error { code, message } => MessagePart::Error {
                code: code.clone(),
                message: message.clone(),
            },
        })
        .collect();

    let usage = content
        .usage
        .as_ref()
        .map(serde_json::to_value)
        .transpose()
        .map_err(|e| AiError::InvalidInput(e.to_string()))?;

    let storage_content = MessageContent {
        schema_version: content.schema_version,
        parts: storage_parts,
        truncated: content.truncated,
        usage,
    };

    storage_content
        .to_json_with_limit(CHAT_MAX_CONTENT_SIZE_BYTES)
        .map_err(|e| AiError::InvalidInput(e.to_string()))
}

/// Convert JSON string from storage to ChatMessageContent.
fn convert_json_to_content(json: &str) -> ChatRepositoryResult<ChatMessageContent> {
    let storage_content =
        MessageContent::from_json(json).map_err(|e| AiError::InvalidInput(e.to_string()))?;

    // Convert storage parts to core parts
    let core_parts: Vec<ChatMessagePart> = storage_content
        .parts
        .into_iter()
        .map(|p| match p {
            MessagePart::System { content } => ChatMessagePart::System { content },
            MessagePart::Text { content } => ChatMessagePart::Text { content },
            MessagePart::Reasoning { content } => ChatMessagePart::Reasoning { content },
            MessagePart::ToolCall {
                tool_call_id,
                name,
                arguments,
            } => ChatMessagePart::ToolCall {
                tool_call_id,
                name,
                arguments,
            },
            MessagePart::ToolResult {
                tool_call_id,
                success,
                data,
                meta,
                error,
            } => ChatMessagePart::ToolResult {
                tool_call_id,
                success,
                data,
                meta,
                error,
            },
            MessagePart::Error { code, message } => ChatMessagePart::Error { code, message },
        })
        .collect();

    Ok(ChatMessageContent {
        schema_version: storage_content.schema_version,
        parts: core_parts,
        truncated: storage_content.truncated,
        // Usage is diagnostic: a shape this version can't read (written by a
        // newer synced device) is dropped rather than failing the message.
        usage: storage_content
            .usage
            .and_then(|usage| serde_json::from_value(usage).ok()),
    })
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    // ========================================================================
    // Thread Conversion Tests
    // ========================================================================

    #[test]
    fn test_thread_conversion() {
        let thread = ChatThread::new();
        let db = thread_to_db(&thread);
        let back = db_to_thread(&db);

        assert_eq!(thread.id, back.id);
        assert_eq!(thread.title, back.title);
        assert!(back.config.is_none());
    }

    #[test]
    fn test_thread_conversion_with_config() {
        let config = ChatThreadConfig::new("openai", "gpt-4o", "wealthfolio-assistant-v1", "1.0.0")
            .with_default_tools();
        let thread = ChatThread::with_config(config.clone());

        let db = thread_to_db(&thread);
        assert!(db.config_snapshot.is_some());

        let back = db_to_thread(&db);
        assert!(back.config.is_some());
        let back_config = back.config.unwrap();
        assert_eq!(back_config.provider_id, "openai");
        assert_eq!(back_config.model_id, "gpt-4o");
        assert_eq!(back_config.prompt_template_id, "wealthfolio-assistant-v1");
        assert!(back_config.tools_allowlist.is_some());
    }

    #[test]
    fn test_thread_conversion_pinned() {
        let mut thread = ChatThread::new();
        thread.is_pinned = true;
        thread.title = Some("Pinned Thread".to_string());

        let db = thread_to_db(&thread);
        assert_eq!(db.is_pinned, 1);
        assert_eq!(db.title, Some("Pinned Thread".to_string()));

        let back = db_to_thread(&db);
        assert!(back.is_pinned);
        assert_eq!(back.title, Some("Pinned Thread".to_string()));
    }

    #[test]
    fn test_thread_conversion_timestamps() {
        let thread = ChatThread::new();
        let db = thread_to_db(&thread);
        let back = db_to_thread(&db);

        // Timestamps should round-trip (within tolerance for RFC3339 parsing)
        assert!((thread.created_at - back.created_at).num_seconds().abs() < 1);
        assert!((thread.updated_at - back.updated_at).num_seconds().abs() < 1);
    }

    // ========================================================================
    // Message Conversion Tests
    // ========================================================================

    #[test]
    fn test_message_conversion() {
        let mut msg = ChatMessage::user("thread-1", "Hello!");
        msg.content.parts.push(ChatMessagePart::ToolCall {
            tool_call_id: "tc-1".to_string(),
            name: "test_tool".to_string(),
            arguments: serde_json::json!({"arg": "value"}),
        });

        let db = message_to_db(&msg).unwrap();
        let back = db_to_message(&db).unwrap();

        assert_eq!(msg.id, back.id);
        assert_eq!(msg.thread_id, back.thread_id);
        assert_eq!(msg.role, back.role);
        assert_eq!(msg.content.parts.len(), back.content.parts.len());
    }

    #[test]
    fn test_message_conversion_all_roles() {
        let roles = [
            (ChatMessageRole::User, "user"),
            (ChatMessageRole::Assistant, "assistant"),
            (ChatMessageRole::System, "system"),
            (ChatMessageRole::Tool, "tool"),
        ];

        for (role, role_str) in roles {
            let mut msg = ChatMessage::user("thread-1", "test");
            msg.role = role;

            let db = message_to_db(&msg).unwrap();
            assert_eq!(db.role, role_str);

            let back = db_to_message(&db).unwrap();
            assert_eq!(back.role, role);
        }
    }

    #[test]
    fn test_message_conversion_with_tool_result() {
        let mut msg = ChatMessage::assistant("thread-1");
        msg.content.parts = vec![
            ChatMessagePart::Text {
                content: "Here are your holdings:".to_string(),
            },
            ChatMessagePart::ToolCall {
                tool_call_id: "tc-123".to_string(),
                name: "get_holdings".to_string(),
                arguments: serde_json::json!({"account_id": "acc-1"}),
            },
            ChatMessagePart::ToolResult {
                tool_call_id: "tc-123".to_string(),
                success: true,
                data: serde_json::json!({
                    "holdings": [
                        {"symbol": "AAPL", "quantity": 10, "value": 1500.0},
                        {"symbol": "GOOGL", "quantity": 5, "value": 2500.0}
                    ]
                }),
                meta: {
                    let mut m = HashMap::new();
                    m.insert("row_count".to_string(), serde_json::json!(2));
                    m.insert("truncated".to_string(), serde_json::json!(false));
                    m
                },
                error: None,
            },
        ];

        let db = message_to_db(&msg).unwrap();
        let back = db_to_message(&db).unwrap();

        assert_eq!(back.content.parts.len(), 3);

        // Verify tool result preserved
        if let ChatMessagePart::ToolResult {
            tool_call_id,
            success,
            meta,
            ..
        } = &back.content.parts[2]
        {
            assert_eq!(tool_call_id, "tc-123");
            assert!(success);
            assert_eq!(meta.get("row_count"), Some(&serde_json::json!(2)));
        } else {
            panic!("Expected ToolResult part");
        }
    }

    #[test]
    fn test_message_conversion_with_error() {
        let mut msg = ChatMessage::assistant("thread-1");
        msg.content.parts = vec![ChatMessagePart::Error {
            code: "providerError".to_string(),
            message: "API rate limit exceeded".to_string(),
        }];

        let db = message_to_db(&msg).unwrap();
        let back = db_to_message(&db).unwrap();

        if let ChatMessagePart::Error { code, message } = &back.content.parts[0] {
            assert_eq!(code, "providerError");
            assert_eq!(message, "API rate limit exceeded");
        } else {
            panic!("Expected Error part");
        }
    }

    #[test]
    fn test_message_conversion_with_reasoning() {
        let mut msg = ChatMessage::assistant("thread-1");
        msg.content.parts = vec![
            ChatMessagePart::Reasoning {
                content: "Let me think about this...".to_string(),
            },
            ChatMessagePart::Text {
                content: "Based on my analysis...".to_string(),
            },
        ];

        let db = message_to_db(&msg).unwrap();
        let back = db_to_message(&db).unwrap();

        assert_eq!(back.content.parts.len(), 2);

        if let ChatMessagePart::Reasoning { content } = &back.content.parts[0] {
            assert_eq!(content, "Let me think about this...");
        } else {
            panic!("Expected Reasoning part");
        }
    }

    // ========================================================================
    // Content JSON Round-trip Tests
    // ========================================================================

    #[test]
    fn test_content_json_roundtrip() {
        let content = ChatMessageContent::text("Test message");
        let json = convert_content_to_json(&content).unwrap();
        let back = convert_json_to_content(&json).unwrap();

        assert_eq!(content.get_text_content(), back.get_text_content());
    }

    #[test]
    fn test_content_json_roundtrip_complex() {
        let content = ChatMessageContent::new(vec![
            ChatMessagePart::System {
                content: "System prompt here".to_string(),
            },
            ChatMessagePart::Text {
                content: "User question".to_string(),
            },
            ChatMessagePart::ToolCall {
                tool_call_id: "tc-1".to_string(),
                name: "get_accounts".to_string(),
                arguments: serde_json::json!({}),
            },
            ChatMessagePart::ToolResult {
                tool_call_id: "tc-1".to_string(),
                success: true,
                data: serde_json::json!({"accounts": []}),
                meta: HashMap::new(),
                error: None,
            },
            ChatMessagePart::Text {
                content: "Response text".to_string(),
            },
        ]);

        let json = convert_content_to_json(&content).unwrap();
        let back = convert_json_to_content(&json).unwrap();

        assert_eq!(content.parts.len(), back.parts.len());
        assert_eq!(content.schema_version, back.schema_version);
    }

    #[test]
    fn test_content_json_preserves_schema_version() {
        let content = ChatMessageContent {
            schema_version: 1,
            parts: vec![ChatMessagePart::Text {
                content: "test".to_string(),
            }],
            truncated: false,
            usage: None,
        };

        let json = convert_content_to_json(&content).unwrap();
        let back = convert_json_to_content(&json).unwrap();

        assert_eq!(back.schema_version, 1);
    }

    #[test]
    fn test_content_json_preserves_truncated_flag() {
        let mut content = ChatMessageContent::text("test");
        content.truncated = true;

        let json = convert_content_to_json(&content).unwrap();
        let back = convert_json_to_content(&json).unwrap();

        assert!(back.truncated);
    }

    #[test]
    fn test_content_json_round_trips_usage() {
        let mut content = ChatMessageContent::text("answer");
        content.usage = Some(wealthfolio_ai::UsageStats {
            provider_id: "anthropic".to_string(),
            model_id: "claude-sonnet-5-5".to_string(),
            model_calls: 2,
            input_tokens: Some(21_000),
            cached_input_tokens: Some(9_800),
            cache_write_input_tokens: Some(1_200),
            output_tokens: Some(450),
            reasoning_tokens: None,
            total_tokens: Some(21_450),
        });

        let json = convert_content_to_json(&content).unwrap();
        let back = convert_json_to_content(&json).unwrap();

        assert_eq!(back.usage, content.usage);
    }

    #[test]
    fn test_content_json_without_usage_keeps_the_existing_shape() {
        let json = convert_content_to_json(&ChatMessageContent::text("hi")).unwrap();

        assert_eq!(
            json,
            r#"{"schemaVersion":1,"parts":[{"type":"text","content":"hi"}]}"#
        );
    }

    #[test]
    fn test_content_json_drops_unreadable_usage() {
        let json = r#"{"schemaVersion":1,"parts":[{"type":"text","content":"hi"}],"usage":{"modelCalls":"many"}}"#;

        let back = convert_json_to_content(json).unwrap();

        assert_eq!(back.get_text_content(), "hi");
        assert!(back.usage.is_none());
    }

    // ========================================================================
    // Thread Config Round-trip Tests
    // ========================================================================

    #[test]
    fn test_thread_config_roundtrip_with_all_fields() {
        let config = ChatThreadConfig {
            schema_version: 1,
            provider_id: "anthropic".to_string(),
            model_id: "claude-3-sonnet".to_string(),
            prompt_template_id: "wealthfolio-assistant-v1".to_string(),
            prompt_version: "2.0.0".to_string(),
            locale: Some("en-US".to_string()),
            detail_level: Some("detailed".to_string()),
            tools_allowlist: Some(vec!["get_holdings".to_string(), "get_accounts".to_string()]),
        };

        let thread = ChatThread::with_config(config.clone());
        let db = thread_to_db(&thread);
        let back = db_to_thread(&db);

        let back_config = back.config.expect("Config should be present");
        assert_eq!(back_config.provider_id, "anthropic");
        assert_eq!(back_config.model_id, "claude-3-sonnet");
        assert_eq!(back_config.locale, Some("en-US".to_string()));
        assert_eq!(back_config.detail_level, Some("detailed".to_string()));
        assert_eq!(
            back_config.tools_allowlist,
            Some(vec!["get_holdings".to_string(), "get_accounts".to_string()])
        );
    }

    #[test]
    fn test_thread_config_roundtrip_minimal() {
        let config = ChatThreadConfig::new("openai", "gpt-4", "template", "1.0.0");
        let thread = ChatThread::with_config(config);
        let db = thread_to_db(&thread);
        let back = db_to_thread(&db);

        let back_config = back.config.expect("Config should be present");
        assert!(back_config.locale.is_none());
        assert!(back_config.detail_level.is_none());
        assert!(back_config.tools_allowlist.is_none());
    }
}
