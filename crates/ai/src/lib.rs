//! Wealthfolio AI - LLM orchestration using rig-core.
//!
//! This crate provides the AI assistant functionality for Wealthfolio,
//! handling the model ↔ tools ↔ model orchestration loop and streaming
//! `AiStreamEvent` to Tauri/Axum consumers.
//!
//! # Architecture
//!
//! - `chat`: Streaming chat service with tool execution loop. Split into
//!   `streaming`, `attachments`, `working_context`, `history`, `provider_clients`.
//! - `providers`: Provider catalog and rig-core client factory.
//! - `tools`: Tool registry, schemas, and bounded outputs.
//! - `types`: Shared DTOs/events used by Axum/Tauri + frontend.
//! - `env`: Environment abstraction for services/secrets/config (`MockEnvironment`
//!   exposed via the `test-utils` feature).
//! - `title_generator`: Auto-generates thread titles from user messages.
//! - `eval`: Stream-event ordering + guardrail assertion helpers and a
//!   `GoldenScenario` struct (test-only). The harness that would drive
//!   `ChatService` against a stub LLM is not implemented; the helpers
//!   sit ready for a future mocked-agent runner.
//! - `live_evals`: Real-LLM behavioral evals — TOML suites driven by the
//!   `eval` binary against Ollama / cloud providers (feature `test-utils`).
//! - `provider_model`: AI provider domain models (catalog, settings, merged views).
//! - `provider_service`: AI provider service for settings management.
//! - `prompt_template` + `prompt_template_service`: Versioned prompt templates.
//!
//! # Running tests vs evals
//!
//! - `cargo test -p wealthfolio-ai`              fast, deterministic, no LLM.
//! - `cargo run -p wealthfolio-ai --bin eval --features eval`
//!   Drives real model (Ollama by default; cloud via `WF_EVAL_PROVIDER`).
//!   See `crates/ai/README.md` and `crates/ai/evals/README.md`.
//!
//! # Example
//!
//! ```ignore
//! use wealthfolio_ai::{ChatService, ChatConfig, AiEnvironment};
//!
//! // Create environment (Tauri/Axum implements AiEnvironment)
//! let env = create_runtime_environment(...);
//!
//! // Create chat service
//! let service = ChatService::new(Arc::new(env), ChatConfig::default());
//!
//! // Send message and get stream
//! let stream = service.send_message(SendMessageRequest {
//!     thread_id: None,
//!     content: "Show me my holdings".to_string(),
//!     ..Default::default()
//! }).await?;
//!
//! // Process stream events
//! while let Some(event) = stream.next().await {
//!     match event {
//!         AiStreamEvent::TextDelta { delta, .. } => print!("{}", delta),
//!         AiStreamEvent::ToolResult { result, .. } => render_tool_result(result),
//!         AiStreamEvent::Done { message, .. } => break,
//!         _ => {}
//!     }
//! }
//! ```

pub mod chat;
pub mod env;
pub mod error;
#[cfg(test)]
pub mod eval;
#[cfg(feature = "test-utils")]
pub mod live_evals;
pub mod prompt_template;
pub mod prompt_template_service;
pub mod provider_model;
pub mod provider_service;
mod provider_urls;
pub mod providers;
pub mod stream_hook;
pub mod title_generator;
pub mod tools;
pub mod types;

/// The chat agent's system prompt, baked at compile time. Exposed for
/// integration tests in `tests/system_prompt.rs` to assert content invariants.
pub const SYSTEM_PROMPT: &str = include_str!("system_prompt.txt");

// Re-export main types for convenience
pub use chat::{ChatConfig, ChatService};
pub use env::{AgentEnvironment, AiEnvironment};
pub use error::AiError;
pub use providers::ProviderService;
pub use title_generator::{
    truncate_to_title, FakeTitleGenerator, TitleGenerator, TitleGeneratorConfig,
    TitleGeneratorTrait,
};
pub use tools::{
    ToolSet, DEFAULT_PAGE_SIZE, DEFAULT_VALUATIONS_DAYS, MAX_ACCOUNTS, MAX_ACTIVITIES_ROWS,
    MAX_GOALS, MAX_HOLDINGS, MAX_INCOME_RECORDS, MAX_VALUATIONS_POINTS,
};
pub use types::{
    // Streaming and request types
    AiStreamEvent,
    // Domain types (chat thread, message, content)
    ChatMessage,
    ChatMessageContent,
    ChatMessagePart,
    ChatMessageRole,
    ChatModelConfig,
    ChatRepositoryResult,
    ChatRepositoryTrait,
    ChatThread,
    ChatThreadConfig,
    // Pagination types
    ListThreadsRequest,
    SendMessageRequest,
    SimpleChatMessage,
    ThreadPage,
    ToolCall,
    ToolResult,
    ToolResultData,
    UsageStats,
    // Constants
    CHAT_CONFIG_SCHEMA_VERSION,
    CHAT_CONTENT_SCHEMA_VERSION,
    CHAT_MAX_CONTENT_SIZE_BYTES,
    DEFAULT_TOOLS_ALLOWLIST,
};

// Provider model types
pub use provider_model::{
    // Catalog types
    AiProviderCatalog,
    // User settings types
    AiProviderSettings,
    // Merged view types
    AiProvidersResponse,
    CapabilityInfo,
    CatalogModel,
    CatalogProvider,
    ConnectionField,
    // Provider config types
    FetchedModel,
    ListModelsResponse,
    MergedModel,
    MergedProvider,
    ModelCapabilities,
    // Update types
    ModelCapabilityOverrideUpdate,
    ModelCapabilityOverrides,
    // Provider API error
    ProviderApiError,
    ProviderConfig,
    ProviderDefaultConfig,
    ProviderUserSettings,
    SetDefaultProviderRequest,
    UpdateProviderSettingsRequest,
    // Constants
    AI_PROVIDER_SETTINGS_KEY,
    AI_PROVIDER_SETTINGS_SCHEMA_VERSION,
};

// Provider service
pub use provider_service::{AiProviderService, AiProviderServiceTrait};

// Prompt template types
pub use prompt_template::{
    ChatRunConfig, DetailLevel, KnobType, PromptTemplate, PromptTemplateCatalog,
    TemplateCatalogMetadata, TemplateKnob, TemplateSection, TemplateSections,
    PROMPT_TEMPLATE_SCHEMA_VERSION,
};

// Prompt template service
pub use prompt_template_service::{
    build_run_config_from_context, PromptTemplateInfo, PromptTemplateService,
    PromptTemplateServiceTrait,
};
