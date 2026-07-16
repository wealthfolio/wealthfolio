//! Streaming agent build + response handling.
//!
//! Owns the model-↔-tools-↔-model loop. `spawn_chat_stream` builds the rig
//! agent for the active provider/model, sends the system event, and delegates
//! to `stream_agent_response`. `stream_agent_response` runs the rig multi-turn
//! stream, fanning rig stream items out to `AiStreamEvent`s on the mpsc.
//!
//! `ThinkTagParser` is a fallback for models that emit `<think>` tags inline
//! (some Ollama models, deepseek-r1, etc.) so we can route reasoning content
//! to the reasoning-delta event stream rather than the visible text stream.

use futures::StreamExt;
use log::{debug, error};
use rig::{
    agent::{Agent, MultiTurnStreamItem},
    client::CompletionClient,
    completion::{CompletionModel, Message},
    message::{
        AssistantContent, Reasoning, Text, ToolCall as RigToolCall, ToolChoice, ToolResultContent,
        UserContent,
    },
    providers::groq::{GroqAdditionalParameters, ReasoningFormat},
    streaming::{StreamedAssistantContent, StreamedUserContent, StreamingChat},
    tool::ToolDyn,
    OneOrMany,
};
use std::{collections::HashMap, sync::Arc};
use tokio::sync::mpsc;

use crate::env::AiEnvironment;
use crate::error::AiError;
use crate::providers::ProviderService;
use crate::title_generator::{TitleGenerator, TitleGeneratorConfig, TitleGeneratorTrait};
use crate::tools::ToolSet;
use crate::types::{
    AiStreamEvent, ChatMessage, ChatMessageContent, ChatMessagePart, ChatRepositoryTrait,
    ChatThread, MessageAttachment, SimpleChatMessage, ToolCall, ToolResultData,
};

use super::history::build_user_prompt;
use super::provider_clients::{
    create_anthropic_client, create_gemini_client, create_groq_client, create_ollama_client,
    create_openai_client, create_openrouter_client, remap_provider_error,
    validate_ollama_model_if_possible,
};
use super::redact_tool_arguments_for_persistence;
use super::working_context::{user_time_context, ChatWorkingContext};

// ============================================================================
// Spawn Chat Stream
// ============================================================================

/// Context needed for title generation after stream completes.
struct TitleContext<E: AiEnvironment> {
    /// Environment for creating TitleGenerator.
    env: Arc<E>,
    /// Current thread title (None or empty triggers generation).
    current_title: Option<String>,
    /// Deterministic title set at creation (used to avoid overwriting user edits).
    initial_title: Option<String>,
    /// Whether this stream created a new thread.
    is_new_thread: bool,
    /// User message to generate title from.
    user_message: String,
    /// Provider ID to use for title generation.
    provider_id: String,
    /// Model ID being used for chat (fallback for title generation).
    model_id: String,
}

/// Spawn a chat stream with the appropriate provider.
#[allow(clippy::too_many_arguments)]
pub(super) async fn spawn_chat_stream<E: AiEnvironment + 'static>(
    env: Arc<E>,
    tx: mpsc::Sender<AiStreamEvent>,
    user_message: String,
    history_messages: Vec<SimpleChatMessage>,
    attachments: Vec<MessageAttachment>,
    provider_id: String,
    model_id: String,
    thread_id: String,
    run_id: String,
    message_id: String,
    thread_title: Option<String>,
    initial_title: Option<String>,
    is_new_thread: bool,
    thinking_override: Option<bool>,
    prior_attachment_content_unavailable: bool,
    working_context: ChatWorkingContext,
) -> Result<(), AiError> {
    // Send system event first
    tx.send(AiStreamEvent::system(&thread_id, &run_id, &message_id))
        .await
        .map_err(|e| AiError::Internal(e.to_string()))?;

    // Get provider settings and model capabilities
    let provider_service = ProviderService::new(env.clone());
    let api_key = provider_service.get_api_key(&provider_id)?;
    let provider_url = provider_service.get_provider_url(&provider_id);
    let mut capabilities = provider_service.get_model_capabilities(&provider_id, &model_id);

    // Best-effort preflight for Ollama: if we can list models and the selected model
    // is definitely missing, fail fast with a clear actionable error.
    if provider_id == "ollama" {
        validate_ollama_model_if_possible(provider_url.as_deref(), &model_id).await?;
    }

    // Apply thinking override from request if provided
    if let Some(thinking) = thinking_override {
        capabilities.thinking = thinking;
    }

    debug!(
        "Starting chat stream: provider={}, model={}, supports_tools={}, thinking={}",
        provider_id, model_id, capabilities.tools, capabilities.thinking
    );

    // Build preamble - include tool limitation notice if model doesn't support tools
    let base_preamble = crate::SYSTEM_PROMPT.trim();

    // Build dynamic context
    let base_currency = env.base_currency();
    let user_time = user_time_context(env.as_ref());

    let dynamic_context = format!(
        "\n\n## Current Context\n\
        - User timezone: {}\n\
        - Current date in user timezone: {}\n\
        - Current weekday in user timezone: {}\n\
        - Current datetime in user timezone: {}\n\
        - Base currency: {}\n\
        - When a tool requires a date, resolve relative phrases such as yesterday, today, \
        tomorrow, last Friday, or next Monday against this current date before calling the tool.",
        user_time.timezone, user_time.date, user_time.weekday, user_time.datetime, base_currency
    );

    // Build preamble with capability-specific instructions
    let mut preamble = format!("{}{}", base_preamble, dynamic_context);

    if let Some(context) = working_context.render() {
        preamble.push_str("\n\n");
        preamble.push_str(&context);
    }

    if prior_attachment_content_unavailable {
        preamble.push_str(
            "\n\n## Attachment Availability\n\
            Previous messages may show attachment filename markers, but those file contents are \
            not available in the current app session. If the user refers to those files, ask them \
            to reattach the file instead of inferring from the filename or prior chat history.",
        );
    }

    // Add tool limitation notice if model doesn't support tools
    if !capabilities.tools {
        preamble.push_str(
            "\n\n## Important Limitation\n\
            You do not have access to tools or function calling. You cannot retrieve account, \
            holdings, transaction, income, allocation, or performance data.\n\
            If the user asks for any of that personal portfolio data, your first sentence MUST \
            start with: \"I don't have access to your ...\" (for example: \
            \"I don't have access to your holdings with the current model.\").\n\
            Then suggest switching to a model that supports tools (look for the gear icon in \
            the model picker). Never guess, fabricate, or imply you retrieved that data.",
        );
    }

    // Create title context for post-stream title generation (clone user_message before move)
    let title_ctx = TitleContext {
        env: env.clone(),
        current_title: thread_title,
        initial_title,
        is_new_thread,
        user_message: user_message.clone(),
        provider_id: provider_id.clone(),
        model_id: model_id.clone(),
    };

    // Reject image/PDF attachments when the model doesn't support vision
    if !capabilities.vision {
        if let Some(att) = attachments
            .iter()
            .find(|a| a.content_type.starts_with("image/") || a.content_type == "application/pdf")
        {
            return Err(AiError::InvalidInput(format!(
                "The current model does not support image/PDF attachments ({}). \
                 Please switch to a vision-capable model.",
                att.name
            )));
        }
    }

    // Build multimodal user content from text + attachments
    let prompt = build_user_prompt(&user_message, &attachments);

    // Build history from previous messages
    let history: Vec<Message> = history_messages
        .iter()
        .map(|msg| {
            if msg.role.eq_ignore_ascii_case("user") {
                Message::User {
                    content: OneOrMany::one(UserContent::Text(Text {
                        text: msg.content.clone(),
                    })),
                }
            } else {
                Message::Assistant {
                    id: None,
                    content: OneOrMany::one(AssistantContent::Text(Text {
                        text: msg.content.clone(),
                    })),
                }
            }
        })
        .collect();

    // Clone env for repository access in stream_agent_response
    let repo = env.chat_repository();

    // Get the tools allowlist for this provider (None = all tools allowed)
    let tools_allowlist = provider_service.get_tools_allowlist(&provider_id);

    // If this provider has a restricted allowlist, clarify the limitation behavior.
    if capabilities.tools {
        if let Some(allowlist) = &tools_allowlist {
            let allowed = allowlist.join(", ");
            preamble.push_str(&format!(
                "\n\n## Tool Access Scope\n\
                You can only use these tools in this thread: {}.\n\
                If the user asks for portfolio data that requires a tool outside this scope, \
                your first sentence MUST start with: \"I don't have access to your ...\" \
                (for example: \"I don't have access to your transactions in this chat \
                configuration.\"). Then ask whether they want to switch to a model/provider \
                setup with broader access. Never invent missing data.",
                allowed
            ));
        }
    }

    // Resolve effective tuning (catalog defaults merged with user overrides) once.
    // Drives temperature, max_tokens, and provider-specific extra_options for
    // every builder path below.
    let resolved_tuning = provider_service.get_resolved_tuning(&provider_id);

    // Merge catalog's extra_options with per-call thinking params. The thinking
    // params are PROVIDER-SPECIFIC shapes (Anthropic's `thinking.budget_tokens`,
    // Gemini's `thinkingConfig`, Groq's `reasoning_format`, Ollama's `think`,
    // OpenAI's `reasoning_effort`) that can't live in the JSON catalog because
    // they're dynamic per-capability. Catalog holds the rest
    // (Ollama's `num_ctx`/`repeat_penalty`, Gemini's `safetySettings`).
    fn merge_json_into(dest: &mut serde_json::Value, src: serde_json::Value) {
        match (dest, src) {
            (serde_json::Value::Object(dest_map), serde_json::Value::Object(src_map)) => {
                for (k, v) in src_map {
                    if let Some(existing) = dest_map.get_mut(&k) {
                        merge_json_into(existing, v);
                    } else {
                        dest_map.insert(k, v);
                    }
                }
            }
            (dest_slot, src_val) => {
                *dest_slot = src_val;
            }
        }
    }

    let combine_params = |thinking_params: Option<serde_json::Value>| -> Option<serde_json::Value> {
        let mut combined = resolved_tuning.extra_options.clone();
        if let Some(thinking) = thinking_params {
            if combined.is_null() {
                combined = thinking;
            } else {
                merge_json_into(&mut combined, thinking);
            }
        }
        match &combined {
            serde_json::Value::Null => None,
            serde_json::Value::Object(m) if m.is_empty() => None,
            _ => Some(combined),
        }
    };

    // Helper macro to build agent WITH tools and stream
    macro_rules! build_with_tools_and_stream {
        ($client:expr, $thinking_params:expr) => {
            build_with_tools_and_stream!($client, $thinking_params, None::<u64>)
        };
        ($client:expr, $thinking_params:expr, $max_tokens:expr) => {{
            let tool_set = ToolSet::new(env.clone(), env.base_currency());

            // Build filtered tool list based on provider allowlist
            let is_allowed = |name: &str| -> bool {
                match &tools_allowlist {
                    None => true, // None = all tools allowed
                    Some(list) => list.iter().any(|t| t == name),
                }
            };

            let mut allowed_tools: Vec<Box<dyn ToolDyn>> = Vec::new();

            // Migrated read tools come from the shared agent-tools catalog,
            // wrapped for rig. Same names, same allowlist semantics.
            let agent_env: Arc<dyn wealthfolio_agent_tools::AgentEnvironment> = env.clone();
            for tool in crate::tools::agent_catalog().iter() {
                if is_allowed(tool.name()) {
                    allowed_tools.push(Box::new(crate::tools::RigAgentTool::new(
                        tool.clone(),
                        agent_env.clone(),
                    )));
                }
            }

            // record_activity, record_activities, propose_transaction_categories,
            // create_categorization_rule, and prepare_asset_classification now
            // come from the shared agent-tools catalog above (via RigAgentTool).
            // Only import_csv still implements rig's Tool trait directly.
            if is_allowed("import_csv") {
                allowed_tools.push(Box::new(tool_set.import_csv));
            }

            let mut builder = $client
                .agent(&model_id)
                .preamble(&preamble)
                .tools(allowed_tools)
                .tool_choice(ToolChoice::Auto);

            // Temperature from resolved tuning. Providers that shouldn't set
            // temperature (e.g. Anthropic, per their own guidance) simply omit
            // it from the catalog.
            if let Some(temp) = resolved_tuning.temperature {
                builder = builder.temperature(temp);
            }

            // Max output tokens — prefer caller-supplied ($max_tokens), fall
            // back to the mode-appropriate value from resolved tuning.
            let caller_max: Option<u64> = Into::<Option<u64>>::into($max_tokens);
            let effective_max =
                caller_max.or_else(|| resolved_tuning.max_tokens_for_mode(capabilities.thinking));
            if let Some(tokens) = effective_max {
                builder = builder.max_tokens(tokens);
            }

            // Provider-specific additional params: catalog extra_options merged
            // with per-call thinking params.
            if let Some(params) = combine_params($thinking_params) {
                builder = builder.additional_params(params);
            }

            let agent = builder.build();
            stream_agent_response(
                agent, prompt, history, tx, repo, thread_id, run_id, message_id, title_ctx,
            )
            .await
            .map_err(|e| remap_provider_error(&provider_id, &model_id, e))
        }};
    }

    // Helper macro to build agent WITHOUT tools and stream
    macro_rules! build_without_tools_and_stream {
        ($client:expr, $thinking_params:expr) => {
            build_without_tools_and_stream!($client, $thinking_params, None::<u64>)
        };
        ($client:expr, $thinking_params:expr, $max_tokens:expr) => {{
            let mut builder = $client.agent(&model_id).preamble(&preamble);

            if let Some(temp) = resolved_tuning.temperature {
                builder = builder.temperature(temp);
            }

            let caller_max: Option<u64> = Into::<Option<u64>>::into($max_tokens);
            let effective_max =
                caller_max.or_else(|| resolved_tuning.max_tokens_for_mode(capabilities.thinking));
            if let Some(tokens) = effective_max {
                builder = builder.max_tokens(tokens);
            }

            if let Some(params) = combine_params($thinking_params) {
                builder = builder.additional_params(params);
            }

            let agent = builder.build();
            stream_agent_response(
                agent, prompt, history, tx, repo, thread_id, run_id, message_id, title_ctx,
            )
            .await
            .map_err(|e| remap_provider_error(&provider_id, &model_id, e))
        }};
    }

    // Provider-specific reasoning params using rig-core native types where available:
    // - Groq: GroqAdditionalParameters with reasoning_format OR include_reasoning (mutually exclusive!)
    //   Note: gpt-oss models don't support reasoning_format - they include reasoning by default
    // - Ollama: Raw JSON with think: true/false
    // - Gemini: GenerationConfig with ThinkingConfig
    // - Anthropic: Raw JSON (no native rig-core struct)
    // - OpenAI: Raw JSON (Reasoning struct is for responses_api only)
    let is_groq_gpt_oss = model_id.contains("gpt-oss");

    // Groq params: reasoning_format and include_reasoning are MUTUALLY EXCLUSIVE
    // For gpt-oss models: don't send reasoning_format (not supported), reasoning is on by default
    // For reasoning-capable models: use reasoning_format to control output format
    // For non-reasoning models (compound, etc.): don't send any reasoning params
    let groq_reasoning_params_with_tools: Option<serde_json::Value> = if is_groq_gpt_oss {
        // gpt-oss models don't support reasoning_format, reasoning is included by default
        // When tools are used, reasoning is automatically hidden in the response
        None
    } else if capabilities.thinking {
        // Use reasoning_format only (not include_reasoning) - they're mutually exclusive
        serde_json::to_value(GroqAdditionalParameters {
            reasoning_format: Some(ReasoningFormat::Hidden), // Model reasons but output hidden with tools
            include_reasoning: None,
            extra: None,
        })
        .ok()
    } else {
        // Non-reasoning models don't support reasoning params at all
        None
    };

    let groq_reasoning_params_no_tools: Option<serde_json::Value> = if is_groq_gpt_oss {
        // gpt-oss models include reasoning by default in the reasoning field
        None
    } else if capabilities.thinking {
        // Use reasoning_format only (not include_reasoning) - they're mutually exclusive
        serde_json::to_value(GroqAdditionalParameters {
            reasoning_format: Some(ReasoningFormat::Parsed), // Reasoning exposed in response
            include_reasoning: None,
            extra: None,
        })
        .ok()
    } else {
        // Non-reasoning models don't support reasoning params at all
        None
    };

    // Ollama: only the dynamic `think` flag is built inline. Static options
    // (num_ctx, repeat_penalty, repeat_last_n) live in the catalog's
    // `tuning.extraOptions` and are merged in via `combine_params`.
    let ollama_thinking_params: Option<serde_json::Value> = Some(serde_json::json!({
        "think": capabilities.thinking,
    }));

    // Anthropic: extended thinking with budget_tokens
    // Only enable thinking when capabilities.thinking is true
    let anthropic_thinking_params: Option<serde_json::Value> = if capabilities.thinking {
        Some(serde_json::json!({
            "thinking": {
                "type": "enabled",
                "budget_tokens": 8000
            }
        }))
    } else {
        None
    };

    // OpenAI: reasoning_effort for o1/o3 models
    // NOTE: Reasoning with tool calls causes "reasoning item without required following item" errors
    // in multi-turn conversations. Only enable reasoning when NOT using tools.
    // See: https://community.openai.com/t/error-badrequesterror-400-item-of-type-reasoning-was-provided-without-its-required-following-item/1303809
    let openai_thinking_params_no_tools: Option<serde_json::Value> = if capabilities.thinking {
        Some(serde_json::json!({
            "reasoning_effort": "medium"
        }))
    } else {
        None // Don't send reasoning_effort when thinking disabled
    };

    // Gemini: Only pass thinking_config to avoid sending unsupported fields.
    // The full GenerationConfig struct includes fields (temperature, maxOutputTokens)
    // that may not be accepted by all Gemini API versions/models.
    let gemini_thinking_params: Option<serde_json::Value> = if capabilities.thinking {
        // Enable thinking with a reasonable budget.
        // Must be nested inside generationConfig to match rig's AdditionalParameters struct
        // which deserializes "generationConfig" into GenerationConfig (has thinkingConfig field).
        Some(serde_json::json!({
            "generationConfig": {
                "thinkingConfig": {
                    "thinkingBudget": 8192,
                    "includeThoughts": true
                }
            }
        }))
    } else {
        // Don't send thinking_config at all when disabled - simpler and avoids API issues
        None
    };

    // Route to provider with tool support check
    if capabilities.tools {
        match provider_id.as_str() {
            "anthropic" => {
                let client = create_anthropic_client(api_key, &provider_id, provider_url)?;
                build_with_tools_and_stream!(client, anthropic_thinking_params.clone())
            }
            "gemini" | "google" => {
                let client = create_gemini_client(api_key, &provider_id, provider_url)?;
                build_with_tools_and_stream!(client, gemini_thinking_params.clone())
            }
            "groq" => {
                let client = create_groq_client(api_key, &provider_id, provider_url)?;
                build_with_tools_and_stream!(client, groq_reasoning_params_with_tools.clone())
            }
            "ollama" => {
                let client = create_ollama_client(provider_url)?;
                build_with_tools_and_stream!(client, ollama_thinking_params.clone())
            }
            "openai" => {
                // Don't pass reasoning params with tools - causes multi-turn errors
                let client = create_openai_client(api_key, &provider_id, provider_url)?;
                build_with_tools_and_stream!(client, None::<serde_json::Value>)
            }
            "openrouter" => {
                let client = create_openrouter_client(api_key, &provider_id, provider_url)?;
                build_with_tools_and_stream!(client, None::<serde_json::Value>)
            }
            _ => {
                let client = create_openai_client(api_key, &provider_id, provider_url)?;
                build_with_tools_and_stream!(client, None::<serde_json::Value>)
            }
        }
    } else {
        match provider_id.as_str() {
            "anthropic" => {
                let client = create_anthropic_client(api_key, &provider_id, provider_url)?;
                build_without_tools_and_stream!(client, anthropic_thinking_params.clone())
            }
            "gemini" | "google" => {
                let client = create_gemini_client(api_key, &provider_id, provider_url)?;
                build_without_tools_and_stream!(client, gemini_thinking_params.clone())
            }
            "groq" => {
                let client = create_groq_client(api_key, &provider_id, provider_url)?;
                build_without_tools_and_stream!(client, groq_reasoning_params_no_tools.clone())
            }
            "ollama" => {
                let client = create_ollama_client(provider_url)?;
                build_without_tools_and_stream!(client, ollama_thinking_params.clone())
            }
            "openai" => {
                // Reasoning params OK without tools
                let client = create_openai_client(api_key, &provider_id, provider_url)?;
                build_without_tools_and_stream!(client, openai_thinking_params_no_tools.clone())
            }
            "openrouter" => {
                let client = create_openrouter_client(api_key, &provider_id, provider_url)?;
                build_without_tools_and_stream!(client, None::<serde_json::Value>)
            }
            _ => {
                let client = create_openai_client(api_key, &provider_id, provider_url)?;
                build_without_tools_and_stream!(client, None::<serde_json::Value>)
            }
        }
    }
}
// ============================================================================
// Think Tag Parser (fallback for models that output <think> tags in text)
// ============================================================================

/// Lightweight parser for `<think>` tags in streamed text.
/// Only performs string operations when potential tags are detected.
#[derive(Default)]
struct ThinkTagParser {
    buffer: String,
    in_think_block: bool,
}

enum ParsedThinkSegment {
    Text(String),
    Reasoning(String),
}

impl ThinkTagParser {
    /// Process text delta, returns ordered segments to emit.
    fn process(&mut self, delta: &str) -> Vec<ParsedThinkSegment> {
        // Fast path: no potential tags and not in a think block
        if !self.in_think_block && !delta.contains('<') && self.buffer.is_empty() {
            return vec![ParsedThinkSegment::Text(delta.to_string())];
        }

        self.buffer.push_str(delta);
        let mut segments = Vec::new();

        loop {
            if self.in_think_block {
                if let Some(end_idx) = self.buffer.find("</think>") {
                    if end_idx > 0 {
                        segments.push(ParsedThinkSegment::Reasoning(
                            self.buffer[..end_idx].to_string(),
                        ));
                    }
                    self.buffer = self.buffer[end_idx + 8..].to_string();
                    self.in_think_block = false;
                } else if self.buffer.len() > 8
                    && !self.buffer.ends_with('<')
                    && !self.buffer.ends_with("</")
                {
                    // Safe to emit most of the buffer as reasoning
                    let safe_len = self.buffer.len().saturating_sub(8);
                    segments.push(ParsedThinkSegment::Reasoning(
                        self.buffer[..safe_len].to_string(),
                    ));
                    self.buffer = self.buffer[safe_len..].to_string();
                    break;
                } else {
                    break;
                }
            } else if let Some(start_idx) = self.buffer.find("<think>") {
                if start_idx > 0 {
                    segments.push(ParsedThinkSegment::Text(
                        self.buffer[..start_idx].to_string(),
                    ));
                }
                self.buffer = self.buffer[start_idx + 7..].to_string();
                self.in_think_block = true;
            } else if self.buffer.len() > 7 && !self.buffer.ends_with('<') {
                // Safe to emit most of the buffer as text
                let safe_len = self.buffer.len().saturating_sub(7);
                segments.push(ParsedThinkSegment::Text(
                    self.buffer[..safe_len].to_string(),
                ));
                self.buffer = self.buffer[safe_len..].to_string();
                break;
            } else {
                break;
            }
        }

        segments
    }

    /// Flush remaining buffer at end of stream.
    fn flush(&mut self) -> Vec<ParsedThinkSegment> {
        if self.buffer.is_empty() {
            return vec![];
        }

        if self.in_think_block {
            vec![ParsedThinkSegment::Reasoning(std::mem::take(
                &mut self.buffer,
            ))]
        } else {
            vec![ParsedThinkSegment::Text(std::mem::take(&mut self.buffer))]
        }
    }
}

// ============================================================================
// Stream Agent Response
// ============================================================================

/// Stream responses from a rig agent, converting to AiStreamEvent.
#[allow(clippy::too_many_arguments)]
async fn stream_agent_response<M: CompletionModel + 'static, E: AiEnvironment + 'static>(
    agent: Agent<M>,
    prompt: Message,
    history: Vec<Message>,
    tx: mpsc::Sender<AiStreamEvent>,
    repo: Arc<dyn ChatRepositoryTrait>,
    thread_id: String,
    run_id: String,
    message_id: String,
    title_ctx: TitleContext<E>,
) -> Result<(), AiError> {
    // Attach a per-run hook that deduplicates repeated tool calls, caps the
    // total tool-call count, and aborts stuck text-token loops. Cheap to clone
    // (state is behind an Arc<Mutex<_>>).
    let hook = crate::stream_hook::WealthfolioStreamHook::new();

    // Start multi-turn streaming (up to 6 tool rounds). The hook provides the
    // finer-grained guards inside those turns.
    let mut stream = agent
        .stream_chat(prompt, history)
        .with_hook(hook)
        .multi_turn(6)
        .await;

    // Generate/refine title concurrently so it can update the UI during streaming.
    let should_attempt_title = title_ctx.is_new_thread
        || title_ctx
            .current_title
            .as_deref()
            .map(str::trim)
            .map(str::is_empty)
            .unwrap_or(true);

    if should_attempt_title {
        let thread_id_bg = thread_id.clone();
        let run_id_bg = run_id.clone();
        let tx_bg = tx.clone();
        let repo_bg = repo.clone();
        let env_bg = title_ctx.env.clone();
        let user_message_bg = title_ctx.user_message.clone();
        let provider_id_bg = title_ctx.provider_id.clone();
        let model_id_bg = title_ctx.model_id.clone();
        let initial_title_bg = title_ctx.initial_title.clone();

        tokio::spawn(async move {
            debug!("Generating title for thread {} (concurrent)", thread_id_bg);
            let title_gen = TitleGenerator::new(env_bg, TitleGeneratorConfig::default());
            let new_title = title_gen
                .generate_title(&user_message_bg, &provider_id_bg, &model_id_bg)
                .await;

            let next_title = new_title.trim();
            if next_title.is_empty() {
                return;
            }

            let Ok(Some(thread)) = repo_bg.get_thread(&thread_id_bg) else {
                return;
            };

            let current_title_trimmed = thread.title.as_deref().unwrap_or("").trim();
            let should_update = if let Some(initial) = initial_title_bg.as_deref() {
                // New thread: only refine if user hasn't renamed it.
                current_title_trimmed.is_empty() || current_title_trimmed == initial.trim()
            } else {
                // Existing thread: only fill missing title.
                current_title_trimmed.is_empty()
            };

            if !should_update {
                return;
            }

            if current_title_trimmed == next_title {
                return;
            }

            let updated_thread = ChatThread {
                title: Some(next_title.to_string()),
                updated_at: chrono::Utc::now(),
                ..thread
            };

            if repo_bg.update_thread(updated_thread).await.is_ok() {
                let _ = tx_bg
                    .send(AiStreamEvent::thread_title_updated(
                        &thread_id_bg,
                        &run_id_bg,
                        next_title,
                    ))
                    .await;
            }
        });
    }

    // Track content parts for final message
    let mut content_parts: Vec<ChatMessagePart> = vec![];
    let mut accumulated_text = String::new();
    let mut accumulated_reasoning = String::new();
    let mut tool_names_by_id: HashMap<String, String> = HashMap::new();

    // Parser for <think> tags (fallback for models that don't use native thinking API)
    let mut think_parser = ThinkTagParser::default();

    while let Some(chunk) = stream.next().await {
        match chunk {
            // Text streaming - parse for <think> tags as fallback
            Ok(MultiTurnStreamItem::StreamAssistantItem(StreamedAssistantContent::Text(
                Text { text },
            ))) => {
                if !text.is_empty() {
                    // Parse <think> tags and emit ordered segments (models should not think if disabled via API)
                    for segment in think_parser.process(&text) {
                        match segment {
                            ParsedThinkSegment::Text(text_out) if !text_out.is_empty() => {
                                // Flush reasoning before text to preserve order
                                if !accumulated_reasoning.is_empty() {
                                    content_parts.push(ChatMessagePart::Reasoning {
                                        content: std::mem::take(&mut accumulated_reasoning),
                                    });
                                }
                                accumulated_text.push_str(&text_out);
                                tx.send(AiStreamEvent::text_delta(
                                    &thread_id,
                                    &run_id,
                                    &message_id,
                                    &text_out,
                                ))
                                .await
                                .map_err(|e| AiError::Internal(e.to_string()))?;
                            }
                            ParsedThinkSegment::Reasoning(reasoning_out)
                                if !reasoning_out.is_empty() =>
                            {
                                // Flush text before reasoning to preserve order
                                if !accumulated_text.is_empty() {
                                    content_parts.push(ChatMessagePart::Text {
                                        content: std::mem::take(&mut accumulated_text),
                                    });
                                }
                                accumulated_reasoning.push_str(&reasoning_out);
                                tx.send(AiStreamEvent::reasoning_delta(
                                    &thread_id,
                                    &run_id,
                                    &message_id,
                                    &reasoning_out,
                                ))
                                .await
                                .map_err(|e| AiError::Internal(e.to_string()))?;
                            }
                            _ => {}
                        }
                    }
                }
            }

            // Reasoning/thinking streaming (provider-native)
            Ok(MultiTurnStreamItem::StreamAssistantItem(StreamedAssistantContent::Reasoning(
                Reasoning { reasoning, .. },
            ))) => {
                if !reasoning.is_empty() {
                    let reasoning_text = reasoning.join(" ");
                    // Flush text before reasoning to preserve order
                    if !accumulated_text.is_empty() {
                        content_parts.push(ChatMessagePart::Text {
                            content: std::mem::take(&mut accumulated_text),
                        });
                    }
                    content_parts.push(ChatMessagePart::Reasoning {
                        content: reasoning_text.clone(),
                    });
                    tx.send(AiStreamEvent::reasoning_delta(
                        &thread_id,
                        &run_id,
                        &message_id,
                        &reasoning_text,
                    ))
                    .await
                    .map_err(|e| AiError::Internal(e.to_string()))?;
                }
            }

            // Reasoning delta (provider-native streaming)
            Ok(MultiTurnStreamItem::StreamAssistantItem(
                StreamedAssistantContent::ReasoningDelta { reasoning, .. },
            )) => {
                if !reasoning.is_empty() {
                    // Flush text before reasoning to preserve order
                    if !accumulated_text.is_empty() {
                        content_parts.push(ChatMessagePart::Text {
                            content: std::mem::take(&mut accumulated_text),
                        });
                    }
                    accumulated_reasoning.push_str(&reasoning);
                    tx.send(AiStreamEvent::reasoning_delta(
                        &thread_id,
                        &run_id,
                        &message_id,
                        &reasoning,
                    ))
                    .await
                    .map_err(|e| AiError::Internal(e.to_string()))?;
                }
            }

            // Tool call
            Ok(MultiTurnStreamItem::StreamAssistantItem(StreamedAssistantContent::ToolCall {
                tool_call: RigToolCall { id, function, .. },
                ..
            })) => {
                // Flush accumulated reasoning and text BEFORE the tool call to preserve order
                if !accumulated_reasoning.is_empty() {
                    content_parts.push(ChatMessagePart::Reasoning {
                        content: std::mem::take(&mut accumulated_reasoning),
                    });
                }
                if !accumulated_text.is_empty() {
                    content_parts.push(ChatMessagePart::Text {
                        content: std::mem::take(&mut accumulated_text),
                    });
                }

                let args: serde_json::Value =
                    serde_json::from_str(&function.arguments.to_string()).unwrap_or_default();
                let persisted_args = redact_tool_arguments_for_persistence(&function.name, &args);
                tool_names_by_id.insert(id.clone(), function.name.clone());

                content_parts.push(ChatMessagePart::ToolCall {
                    tool_call_id: id.clone(),
                    name: function.name.clone(),
                    arguments: persisted_args,
                });

                tx.send(AiStreamEvent::tool_call(
                    &thread_id,
                    &run_id,
                    &message_id,
                    ToolCall {
                        id: id.clone(),
                        name: function.name.clone(),
                        arguments: args,
                    },
                ))
                .await
                .map_err(|e| AiError::Internal(e.to_string()))?;
            }

            // Tool call delta (provider-native)
            Ok(MultiTurnStreamItem::StreamAssistantItem(
                StreamedAssistantContent::ToolCallDelta { .. },
            )) => {
                // Tool call deltas are handled by providers that stream tool args incrementally.
                // We currently rely on full ToolCall items for execution.
            }

            // Provider-specific final payload
            Ok(MultiTurnStreamItem::StreamAssistantItem(StreamedAssistantContent::Final(_))) => {
                // No-op: FinalResponse is handled separately; some providers emit a final payload here.
            }

            // Tool result
            Ok(MultiTurnStreamItem::StreamUserItem(StreamedUserContent::ToolResult {
                tool_result,
                ..
            })) => {
                let content_to_string = |content: ToolResultContent| -> String {
                    match content {
                        ToolResultContent::Text(Text { text }) => text,
                        ToolResultContent::Image(image) => image.try_into_url().unwrap_or_default(),
                    }
                };

                let result_text = tool_result
                    .content
                    .into_iter()
                    .map(content_to_string)
                    .collect::<Vec<_>>()
                    .join("\n");

                // Parse result as JSON for structured data
                let data: serde_json::Value =
                    serde_json::from_str(&result_text).unwrap_or(serde_json::json!(result_text));
                let tool_name = tool_names_by_id
                    .get(&tool_result.id)
                    .map(std::string::String::as_str);
                let should_pause_for_asset_selection =
                    tool_result_requires_asset_selection(tool_name, &data);

                content_parts.push(ChatMessagePart::ToolResult {
                    tool_call_id: tool_result.id.clone(),
                    success: true,
                    data: data.clone(),
                    meta: std::collections::HashMap::new(),
                    error: None,
                });

                tx.send(AiStreamEvent::tool_result(
                    &thread_id,
                    &run_id,
                    &message_id,
                    ToolResultData {
                        tool_call_id: tool_result.id,
                        success: true,
                        data,
                        meta: std::collections::HashMap::new(),
                        error: None,
                    },
                ))
                .await
                .map_err(|e| AiError::Internal(e.to_string()))?;

                if should_pause_for_asset_selection {
                    break;
                }
            }

            // Final response - use if no meaningful text was accumulated (some providers like Gemini
            // may not stream text deltas for tool-calling responses, and Ollama/DeepSeek may
            // send reasoning natively without streaming text deltas)
            Ok(MultiTurnStreamItem::FinalResponse(final_response)) => {
                let response_text = final_response.response().to_string();
                // Use trim() to handle cases where only whitespace was accumulated
                if accumulated_text.trim().is_empty() && !response_text.trim().is_empty() {
                    accumulated_text = response_text.clone();
                    tx.send(AiStreamEvent::text_delta(
                        &thread_id,
                        &run_id,
                        &message_id,
                        &response_text,
                    ))
                    .await
                    .map_err(|e| AiError::Internal(e.to_string()))?;
                }
            }

            // Other stream items - ignore
            Ok(_) => {}

            // Errors
            Err(error) => {
                error!("Stream error: {}", error);
                tx.send(AiStreamEvent::error(
                    &thread_id,
                    &run_id,
                    Some(&message_id),
                    "STREAM_ERROR",
                    &error.to_string(),
                ))
                .await
                .map_err(|e| AiError::Internal(e.to_string()))?;
                return Err(AiError::Provider(error.to_string()));
            }
        }
    }

    // Flush any remaining buffered content from the think parser
    for segment in think_parser.flush() {
        match segment {
            ParsedThinkSegment::Text(remaining_text) if !remaining_text.is_empty() => {
                if !accumulated_reasoning.is_empty() {
                    content_parts.push(ChatMessagePart::Reasoning {
                        content: std::mem::take(&mut accumulated_reasoning),
                    });
                }
                accumulated_text.push_str(&remaining_text);
                tx.send(AiStreamEvent::text_delta(
                    &thread_id,
                    &run_id,
                    &message_id,
                    &remaining_text,
                ))
                .await
                .map_err(|e| AiError::Internal(e.to_string()))?;
            }
            ParsedThinkSegment::Reasoning(remaining_reasoning)
                if !remaining_reasoning.is_empty() =>
            {
                if !accumulated_text.is_empty() {
                    content_parts.push(ChatMessagePart::Text {
                        content: std::mem::take(&mut accumulated_text),
                    });
                }
                accumulated_reasoning.push_str(&remaining_reasoning);
                tx.send(AiStreamEvent::reasoning_delta(
                    &thread_id,
                    &run_id,
                    &message_id,
                    &remaining_reasoning,
                ))
                .await
                .map_err(|e| AiError::Internal(e.to_string()))?;
            }
            _ => {}
        }
    }

    // Flush remaining accumulated content in order (reasoning before text)
    if !accumulated_reasoning.is_empty() {
        content_parts.push(ChatMessagePart::Reasoning {
            content: accumulated_reasoning,
        });
    }

    // Push any remaining accumulated text at the END to preserve interleaved order
    // (text before tool calls was already flushed when tool calls arrived)
    if !accumulated_text.is_empty() {
        content_parts.push(ChatMessagePart::Text {
            content: accumulated_text,
        });
    }

    // Build final message
    let mut final_message = ChatMessage::assistant_with_id(&message_id, &thread_id);
    final_message.content = ChatMessageContent::new(content_parts);

    // Save assistant message to repository after stream completes
    if let Err(e) = repo.create_message(final_message.clone()).await {
        error!("Failed to save assistant message to repository: {}", e);
        // Continue anyway - the message was streamed successfully
    }

    // Send done event - this is the terminal event, stream closes after this
    tx.send(AiStreamEvent::done(
        &thread_id,
        &run_id,
        final_message,
        None,
    ))
    .await
    .map_err(|e| AiError::Internal(e.to_string()))?;

    Ok(())
}

fn tool_result_requires_asset_selection(tool_name: Option<&str>, data: &serde_json::Value) -> bool {
    tool_name == Some("prepare_asset_classification")
        && data.get("draftStatus").and_then(serde_json::Value::as_str)
            == Some("needsAssetSelection")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_think_parser_emits_ordered_segments() {
        let mut parser = ThinkTagParser::default();
        let segments = parser.process("hello<think>reason</think>");

        assert_eq!(segments.len(), 2);
        assert!(matches!(&segments[0], ParsedThinkSegment::Text(text) if text == "hello"));
        assert!(matches!(&segments[1], ParsedThinkSegment::Reasoning(text) if text == "reason"));
    }

    #[test]
    fn test_think_parser_flush_preserves_trailing_text_after_reasoning() {
        let mut parser = ThinkTagParser::default();
        let segments = parser.process("hello<think>reason</think>world");

        assert_eq!(segments.len(), 2);
        assert!(matches!(&segments[0], ParsedThinkSegment::Text(text) if text == "hello"));
        assert!(matches!(&segments[1], ParsedThinkSegment::Reasoning(text) if text == "reason"));

        let flushed = parser.flush();
        assert_eq!(flushed.len(), 1);
        assert!(matches!(&flushed[0], ParsedThinkSegment::Text(text) if text == "world"));
    }

    #[test]
    fn asset_classification_selection_result_pauses_stream() {
        assert!(tool_result_requires_asset_selection(
            Some("prepare_asset_classification"),
            &serde_json::json!({
                "draftStatus": "needsAssetSelection",
                "assetCandidates": [{ "assetId": "asset-vt-xnas" }]
            }),
        ));

        assert!(!tool_result_requires_asset_selection(
            Some("prepare_asset_classification"),
            &serde_json::json!({ "draftStatus": "draft" }),
        ));
        assert!(!tool_result_requires_asset_selection(
            Some("other_tool"),
            &serde_json::json!({ "draftStatus": "needsAssetSelection" }),
        ));
    }
}
