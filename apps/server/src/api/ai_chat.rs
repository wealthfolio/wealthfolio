//! AI Chat streaming endpoint and thread management.
//!
//! Provides NDJSON streaming for AI assistant chat messages and
//! REST endpoints for thread CRUD operations.

use std::sync::Arc;

use axum::{
    body::Body,
    extract::{Path, Query},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use futures::StreamExt;
use serde::{Deserialize, Serialize};

use crate::main_lib::AppState;
use wealthfolio_ai::{
    AiError, AiStreamEvent, ChatMessage, ChatThread, ListThreadsRequest, SendMessageRequest,
    ThreadPage,
};

// ============================================================================
// Request/Response Types
// ============================================================================

/// Query parameters for listing threads with cursor-based pagination.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListThreadsQuery {
    /// Cursor from previous page's next_cursor.
    pub cursor: Option<String>,
    /// Maximum threads to return (default 20, max 100).
    pub limit: Option<u32>,
    /// Optional search query to filter by title.
    pub search: Option<String>,
}

/// Request for updating thread title or pinned status.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateThreadRequest {
    pub title: Option<String>,
    pub is_pinned: Option<bool>,
}

/// Request for adding/removing a tag.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TagRequest {
    pub tag: String,
}

/// Request for updating a tool result.
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

// ============================================================================
// Streaming Endpoint
// ============================================================================

/// POST /api/v1/ai/chat/stream
///
/// Streams AI assistant responses as NDJSON (one JSON object per line).
/// Each line is a complete `AiStreamEvent` JSON object.
///
/// Event types: `system`, `textDelta`, `reasoningDelta`, `toolCall`, `toolResult`, `error`, `done`
///
/// The stream always starts with a `system` event and ends with a `done` event.
async fn stream_chat(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Json(request): Json<SendMessageRequest>,
) -> Result<Response, AiChatError> {
    let event_stream = state
        .ai_chat_service
        .send_message(request)
        .await
        .map_err(AiChatError::Ai)?;

    // Convert event stream to NDJSON body
    let ndjson_stream = event_stream.map(|event: AiStreamEvent| {
        let mut json = serde_json::to_string(&event).unwrap_or_else(|e| {
            // Fallback error event if serialization fails
            format!(
                r#"{{"type":"error","threadId":"","runId":"","messageId":null,"code":"serialization_error","message":"{}"}}"#,
                e
            )
        });
        json.push('\n');
        Ok::<_, std::convert::Infallible>(json)
    });

    let body = Body::from_stream(ndjson_stream);

    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/x-ndjson")
        .header(header::CACHE_CONTROL, "no-cache")
        .header(header::CONNECTION, "keep-alive")
        .body(body)
        .expect("constant status and headers are valid"))
}

// ============================================================================
// Thread Management Endpoints
// ============================================================================

/// GET /api/v1/ai/threads
///
/// List chat threads with cursor-based pagination and optional search.
///
/// Query parameters:
/// - `cursor`: Cursor from previous page's next_cursor
/// - `limit`: Maximum threads to return (default 20, max 100)
/// - `search`: Optional search query to filter by title
///
/// Returns a `ThreadPage` with threads, next_cursor, and has_more flag.
async fn list_threads(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Query(query): Query<ListThreadsQuery>,
) -> Result<Json<ThreadPage>, AiChatError> {
    let request = ListThreadsRequest {
        cursor: query.cursor,
        limit: query.limit,
        search: query.search,
    };
    let page = state
        .ai_chat_service
        .list_threads_paginated(&request)
        .map_err(AiChatError::Ai)?;
    Ok(Json(page))
}

/// GET /api/v1/ai/threads/:id
///
/// Get a single chat thread by ID.
async fn get_thread(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Path(thread_id): Path<String>,
) -> Result<Json<Option<ChatThread>>, AiChatError> {
    let thread = state
        .ai_chat_service
        .get_thread(&thread_id)
        .map_err(AiChatError::Ai)?;
    Ok(Json(thread))
}

/// GET /api/v1/ai/threads/:id/messages
///
/// Get all messages for a chat thread.
async fn get_thread_messages(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Path(thread_id): Path<String>,
) -> Result<Json<Vec<ChatMessage>>, AiChatError> {
    let messages = state
        .ai_chat_service
        .get_messages(&thread_id)
        .map_err(AiChatError::Ai)?;
    Ok(Json(messages))
}

/// PUT /api/v1/ai/threads/:id
///
/// Update a chat thread's title and/or pinned status.
async fn update_thread(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Path(thread_id): Path<String>,
    Json(request): Json<UpdateThreadRequest>,
) -> Result<Json<ChatThread>, AiChatError> {
    // Update title if provided
    if let Some(title) = request.title {
        state
            .ai_chat_service
            .update_thread_title(&thread_id, title)
            .await
            .map_err(AiChatError::Ai)?;
    }

    // Update pinned status if provided
    if let Some(is_pinned) = request.is_pinned {
        state
            .ai_chat_service
            .update_thread_pinned(&thread_id, is_pinned)
            .await
            .map_err(AiChatError::Ai)?;
    }

    // Get updated thread
    let thread = state
        .ai_chat_service
        .get_thread(&thread_id)
        .map_err(AiChatError::Ai)?
        .ok_or_else(|| AiChatError::NotFound(format!("Thread {} not found", thread_id)))?;
    Ok(Json(thread))
}

/// DELETE /api/v1/ai/threads/:id
///
/// Delete a chat thread and all its messages.
async fn delete_thread(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Path(thread_id): Path<String>,
) -> Result<StatusCode, AiChatError> {
    state
        .ai_chat_service
        .delete_thread(&thread_id)
        .await
        .map_err(AiChatError::Ai)?;
    Ok(StatusCode::NO_CONTENT)
}

// ============================================================================
// Tag Management Endpoints
// ============================================================================

/// POST /api/v1/ai/threads/:id/tags
///
/// Add a tag to a thread.
async fn add_tag(
    axum::Extension(_state): axum::Extension<Arc<AppState>>,
    Path(_thread_id): Path<String>,
    Json(_request): Json<TagRequest>,
) -> Result<StatusCode, AiChatError> {
    // TODO: Add tag support to ChatService
    Ok(StatusCode::NO_CONTENT)
}

/// DELETE /api/v1/ai/threads/:id/tags/:tag
///
/// Remove a tag from a thread.
async fn remove_tag(
    axum::Extension(_state): axum::Extension<Arc<AppState>>,
    Path((_thread_id, _tag)): Path<(String, String)>,
) -> Result<StatusCode, AiChatError> {
    // TODO: Add tag support to ChatService
    Ok(StatusCode::NO_CONTENT)
}

/// GET /api/v1/ai/threads/:id/tags
///
/// Get all tags for a thread.
async fn get_tags(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Path(thread_id): Path<String>,
) -> Result<Json<Vec<String>>, AiChatError> {
    // Return tags from thread if found
    let tags = state
        .ai_chat_service
        .get_thread(&thread_id)
        .map_err(AiChatError::Ai)?
        .map(|t| t.tags)
        .unwrap_or_default();
    Ok(Json(tags))
}

// ============================================================================
// Tool Result Management
// ============================================================================

/// PATCH /api/v1/ai/tool-result
///
/// Update a tool result in a message by merging a patch into the result data.
/// This is used by mutation tool UIs (e.g., record_activity) to persist
/// submission state after the backend operation succeeds.
async fn update_tool_result(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Json(request): Json<UpdateToolResultRequest>,
) -> Result<Json<ChatMessage>, AiChatError> {
    let message = state
        .ai_chat_service
        .update_tool_result(
            &request.thread_id,
            &request.tool_call_id,
            request.result_patch,
        )
        .await
        .map_err(AiChatError::Ai)?;
    Ok(Json(message))
}

// ============================================================================
// Error Handling
// ============================================================================

/// Error type for AI chat endpoints.
#[derive(Debug)]
pub enum AiChatError {
    Ai(AiError),
    NotFound(String),
}

impl IntoResponse for AiChatError {
    fn into_response(self) -> Response {
        let (status, code, message) = match self {
            AiChatError::Ai(e) => {
                let status = match &e {
                    AiError::InvalidInput(_) => StatusCode::BAD_REQUEST,
                    AiError::MissingApiKey(_) => StatusCode::BAD_REQUEST,
                    AiError::Provider(_) => StatusCode::BAD_GATEWAY,
                    AiError::ToolNotFound(_) => StatusCode::BAD_REQUEST,
                    AiError::ToolNotAllowed(_) => StatusCode::FORBIDDEN,
                    AiError::ToolExecutionFailed(_) => StatusCode::INTERNAL_SERVER_ERROR,
                    AiError::ThreadNotFound(_) => StatusCode::NOT_FOUND,
                    AiError::InvalidCursor(_) => StatusCode::BAD_REQUEST,
                    AiError::Core(_) => StatusCode::INTERNAL_SERVER_ERROR,
                    AiError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
                };
                (status, e.code().to_string(), e.to_string())
            }
            AiChatError::NotFound(msg) => (StatusCode::NOT_FOUND, "not_found".to_string(), msg),
        };

        let body = serde_json::json!({
            "code": code,
            "error": message
        });

        (status, Json(body)).into_response()
    }
}

// ============================================================================
// Router
// ============================================================================

pub fn router<S: Clone + Send + Sync + 'static>() -> Router<S> {
    use axum::routing::patch;

    Router::new()
        // Streaming endpoint
        .route("/ai/chat/stream", post(stream_chat))
        // Thread management
        .route("/ai/threads", get(list_threads))
        .route(
            "/ai/threads/{id}",
            get(get_thread).put(update_thread).delete(delete_thread),
        )
        // Thread messages
        .route("/ai/threads/{id}/messages", get(get_thread_messages))
        // Tool result update
        .route("/ai/tool-result", patch(update_tool_result))
        // Tag management
        .route("/ai/threads/{id}/tags", get(get_tags).post(add_tag))
        .route("/ai/threads/{id}/tags/{tag}", delete(remove_tag))
}
