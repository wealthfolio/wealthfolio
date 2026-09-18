//! AI Chat Tauri commands for streaming responses and thread management.
//!
//! Uses Tauri's IPC Channel for efficient streaming of AI events.

use crate::database::DatabaseRuntime;

use futures::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, State};
use wealthfolio_ai::{
    AiError, AiStreamEvent, ChatMessage, ChatThread, ListThreadsRequest, SendMessageRequest,
    ThreadPage,
};

use super::error::CommandResult;

/// Request for updating thread title or pinned status.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateThreadRequest {
    pub id: String,
    pub title: Option<String>,
    pub is_pinned: Option<bool>,
}

/// Stream a chat message and receive AI events through a Tauri Channel.
///
/// The channel will receive `AiStreamEvent` objects:
/// - `system`: Initial event with thread_id, run_id, message_id
/// - `textDelta`: Partial text content
/// - `reasoningDelta`: Optional reasoning/thinking content
/// - `toolCall`: Tool invocation request
/// - `toolResult`: Tool execution result
/// - `error`: Error event
/// - `done`: Terminal event with final message
///
/// Returns Ok(()) when the stream completes successfully.
#[tauri::command]
pub async fn stream_ai_chat(
    context: State<'_, DatabaseRuntime>,
    request: SendMessageRequest,
    on_event: Channel<AiStreamEvent>,
) -> CommandResult<()> {
    let context = context.context()?;
    let service = context.ai_chat_service();

    let mut event_stream = service.send_message(request).await?;

    // Stream events to the frontend via the Tauri channel
    while let Some(event) = event_stream.next().await {
        if let Err(e) = on_event.send(event) {
            log::error!("Failed to send AI event to channel: {}", e);
            break;
        }
    }

    Ok(())
}

// ============================================================================
// Thread Management Commands
// ============================================================================

/// List all chat threads with cursor-based pagination and optional search.
///
/// Returns a `ThreadPage` with threads, next_cursor, and has_more flag.
#[tauri::command]
pub async fn list_ai_threads(
    context: State<'_, DatabaseRuntime>,
    cursor: Option<String>,
    limit: Option<u32>,
    search: Option<String>,
) -> CommandResult<ThreadPage> {
    let context = context.context()?;
    let service = context.ai_chat_service();
    let request = ListThreadsRequest {
        cursor,
        limit,
        search,
    };
    let page = service.list_threads_paginated(&request)?;
    Ok(page)
}

/// Get a single chat thread by ID.
#[tauri::command]
pub async fn get_ai_thread(
    context: State<'_, DatabaseRuntime>,
    thread_id: String,
) -> CommandResult<Option<ChatThread>> {
    let context = context.context()?;
    let service = context.ai_chat_service();
    let thread = service.get_thread(&thread_id)?;
    Ok(thread)
}

/// Get all messages for a chat thread.
#[tauri::command]
pub async fn get_ai_thread_messages(
    context: State<'_, DatabaseRuntime>,
    thread_id: String,
) -> CommandResult<Vec<ChatMessage>> {
    let context = context.context()?;
    let service = context.ai_chat_service();
    let messages = service.get_messages(&thread_id)?;
    Ok(messages)
}

/// Update a chat thread's title and/or pinned status.
#[tauri::command]
pub async fn update_ai_thread(
    context: State<'_, DatabaseRuntime>,
    request: UpdateThreadRequest,
) -> CommandResult<ChatThread> {
    let context = context.context()?;
    let service = context.ai_chat_service();

    // Update title if provided
    if let Some(title) = request.title {
        service.update_thread_title(&request.id, title).await?;
    }

    // Update pinned status if provided
    if let Some(is_pinned) = request.is_pinned {
        service.update_thread_pinned(&request.id, is_pinned).await?;
    }

    // Get updated thread
    let thread = service
        .get_thread(&request.id)?
        .ok_or_else(|| AiError::ThreadNotFound(request.id.clone()))?;
    Ok(thread)
}

/// Delete a chat thread and all its messages.
#[tauri::command]
pub async fn delete_ai_thread(
    context: State<'_, DatabaseRuntime>,
    thread_id: String,
) -> CommandResult<()> {
    let context = context.context()?;
    let service = context.ai_chat_service();
    service.delete_thread(&thread_id).await?;
    Ok(())
}

// ============================================================================
// Tag Management Commands
// ============================================================================

/// Add a tag to a thread.
#[tauri::command]
pub async fn add_ai_thread_tag(
    _context: State<'_, DatabaseRuntime>,
    _thread_id: String,
    _tag: String,
) -> CommandResult<()> {
    // TODO: Add tag support to ChatService
    Ok(())
}

/// Remove a tag from a thread.
#[tauri::command]
pub async fn remove_ai_thread_tag(
    _context: State<'_, DatabaseRuntime>,
    _thread_id: String,
    _tag: String,
) -> CommandResult<()> {
    // TODO: Add tag support to ChatService
    Ok(())
}

/// Get all tags for a thread.
#[tauri::command]
pub async fn get_ai_thread_tags(
    context: State<'_, DatabaseRuntime>,
    thread_id: String,
) -> CommandResult<Vec<String>> {
    let context = context.context()?;
    let service = context.ai_chat_service();
    let tags = service
        .get_thread(&thread_id)?
        .map(|t| t.tags)
        .unwrap_or_default();
    Ok(tags)
}

// ============================================================================
// Tool Result Update Command
// ============================================================================

/// Request for updating a tool result in a message.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateToolResultRequest {
    /// The thread ID containing the message with the tool result.
    pub thread_id: String,
    /// The tool call ID to update.
    pub tool_call_id: String,
    /// JSON patch to merge into the tool result data.
    pub result_patch: serde_json::Value,
}

/// Update a tool result in a message by merging a patch into the result data.
///
/// This is used by mutation tool UIs (e.g., record_activity) to persist
/// submission state. After the user confirms and the backend operation succeeds,
/// the frontend calls this to store metadata like created_activity_id.
#[tauri::command]
pub async fn update_tool_result(
    context: State<'_, DatabaseRuntime>,
    request: UpdateToolResultRequest,
) -> CommandResult<ChatMessage> {
    let context = context.context()?;
    let service = context.ai_chat_service();
    let message = service
        .update_tool_result(
            &request.thread_id,
            &request.tool_call_id,
            request.result_patch,
        )
        .await?;
    Ok(message)
}
