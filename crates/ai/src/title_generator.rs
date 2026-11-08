//! Title generation service for chat threads.
//!
//! Auto-generates short descriptive titles from user messages using a fast model.
//! Falls back to truncating the first user message if generation fails.

use async_trait::async_trait;
use log::{debug, warn};
use rig::{operation::Completion, AgentBuilder, DynModel};

use crate::chat::provider_clients::{
    create_anthropic_client, create_gemini_client, create_groq_client, create_ollama_client,
    create_openai_client, create_openrouter_client,
};
use crate::env::AiEnvironment;
use crate::error::AiError;
use crate::providers::ProviderService;
use std::sync::Arc;

// ============================================================================
// Title Generator Trait
// ============================================================================

/// Trait for generating thread titles.
#[async_trait]
pub trait TitleGeneratorTrait: Send + Sync {
    /// Generate a title from the first user message.
    ///
    /// Returns a short (4 words max) descriptive title suitable for sidebar display.
    /// Falls back to truncating the message if LLM generation fails.
    ///
    /// `chat_model_id` is used as fallback if no title model is configured for the provider.
    async fn generate_title(
        &self,
        user_message: &str,
        provider_id: &str,
        chat_model_id: &str,
    ) -> String;
}

// ============================================================================
// Title Generator Implementation
// ============================================================================

/// Configuration for title generation.
pub struct TitleGeneratorConfig {
    /// Max characters for the truncated fallback title.
    pub fallback_max_chars: usize,
    /// Max tokens to generate for the title.
    pub max_tokens: u32,
    /// Temperature for title generation (lower = more focused).
    pub temperature: f32,
}

impl Default for TitleGeneratorConfig {
    fn default() -> Self {
        Self {
            fallback_max_chars: 50,
            max_tokens: 20,
            temperature: 0.3,
        }
    }
}

/// Title generator implementation using LLM providers.
pub struct TitleGenerator<E: AiEnvironment> {
    env: Arc<E>,
    config: TitleGeneratorConfig,
}

impl<E: AiEnvironment> TitleGenerator<E> {
    /// Create a new title generator.
    pub fn new(env: Arc<E>, config: TitleGeneratorConfig) -> Self {
        Self { env, config }
    }

    /// Generate a fallback title by truncating the user message.
    fn generate_fallback(&self, user_message: &str) -> String {
        truncate_to_title(user_message, self.config.fallback_max_chars)
    }

    /// Generate a title using the LLM with a specific model.
    async fn generate_with_llm(
        &self,
        user_message: &str,
        provider_id: &str,
        model_id: &str,
    ) -> Result<String, AiError> {
        let provider_service = ProviderService::new(self.env.clone());
        let api_key = provider_service.get_api_key(provider_id)?;
        let provider_url = provider_service.get_provider_url(provider_id);

        debug!(
            "Generating title with provider {} model {}",
            provider_id, model_id
        );

        let prompt = format!(
            "Generate a very short plain-text title (max 4 words) for this chat message.\n\
Rules:\n\
- Return ONLY the title text\n\
- No markdown (no **bold**, no *italics*, no backticks)\n\
- No quotes\n\
- No leading \"Title:\" prefix\n\n\
Message:\n\"{}\"\n\n\
Title:",
            truncate_to_title(user_message, 200)
        );

        let model: DynModel<Completion> = match provider_id {
            "anthropic" => create_anthropic_client(api_key, provider_id, provider_url)?
                .completion(model_id)
                .into(),
            "gemini" | "google" => create_gemini_client(api_key, provider_id, provider_url)?
                .completion(model_id)
                .into(),
            "groq" => create_groq_client(api_key, provider_id, provider_url)?
                .completion(model_id)
                .into(),
            "ollama" => create_ollama_client(provider_url)?
                .native_completion(model_id)
                .into(),
            "openrouter" => create_openrouter_client(api_key, provider_id, provider_url)?
                .completion(model_id)
                .into(),
            // Default to OpenAI-compatible Chat Completions: titles call no tools.
            _ => create_openai_client(api_key, provider_id, provider_url)?
                .chat(model_id)
                .into(),
        };
        let mut builder = AgentBuilder::new(model);
        if provider_id == "anthropic" {
            // Anthropic requires max_tokens.
            builder = builder.max_tokens(self.config.max_tokens as u64);
        }
        let response = builder
            .build()
            .prompt(prompt.as_str())
            .await
            .map_err(|_| {
                AiError::Provider(
                    wealthfolio_core::errors::PublicError::provider_unavailable().message,
                )
            })?
            .output();

        // Clean up the response (providers sometimes wrap titles in markdown/quotes).
        let title = clean_generated_title(&response);

        // Ensure reasonable length
        if title.is_empty() || title.len() > 100 {
            return Err(AiError::Internal(
                "Generated title too long or empty".into(),
            ));
        }

        Ok(title)
    }
}

fn clean_generated_title(raw: &str) -> String {
    let mut title = raw
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or(raw)
        .trim()
        .to_string();

    // Iteratively strip common wrappers like **Title**, "Title", `Title`, etc.
    for _ in 0..4 {
        let trimmed = title.trim();
        let mut changed = false;

        if (trimmed.starts_with("**") && trimmed.ends_with("**")
            || trimmed.starts_with("__") && trimmed.ends_with("__"))
            && trimmed.len() > 4
        {
            title = trimmed[2..trimmed.len() - 2].trim().to_string();
            changed = true;
        } else if (trimmed.starts_with('`') && trimmed.ends_with('`')
            || trimmed.starts_with('"') && trimmed.ends_with('"')
            || trimmed.starts_with('\'') && trimmed.ends_with('\'')
            || trimmed.starts_with('*') && trimmed.ends_with('*'))
            && trimmed.len() > 2
        {
            title = trimmed[1..trimmed.len() - 1].trim().to_string();
            changed = true;
        }

        if !changed {
            break;
        }
    }

    // Strip any remaining leading/trailing markdown decoration characters.
    title = title
        .trim_matches(|c: char| matches!(c, '*' | '_' | '`' | '"' | '\''))
        .trim()
        .to_string();

    // Collapse whitespace.
    title.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[async_trait]
impl<E: AiEnvironment + 'static> TitleGeneratorTrait for TitleGenerator<E> {
    async fn generate_title(
        &self,
        user_message: &str,
        provider_id: &str,
        chat_model_id: &str,
    ) -> String {
        let provider_service = ProviderService::new(self.env.clone());
        let title_model = provider_service
            .get_title_model(provider_id)
            .unwrap_or_else(|| chat_model_id.to_string());

        // Try title model first
        match self
            .generate_with_llm(user_message, provider_id, &title_model)
            .await
        {
            Ok(title) => return title,
            Err(e) => {
                warn!(
                    "Title generation failed with title model '{}': {}",
                    title_model, e
                );
            }
        }

        // Fall back to chat model if it's different from the title model
        if title_model != chat_model_id {
            debug!(
                "Retrying title generation with chat model '{}'",
                chat_model_id
            );
            match self
                .generate_with_llm(user_message, provider_id, chat_model_id)
                .await
            {
                Ok(title) => return title,
                Err(e) => {
                    warn!(
                        "Title generation failed with chat model '{}': {}",
                        chat_model_id, e
                    );
                }
            }
        }

        // Final fallback: truncate the message
        self.generate_fallback(user_message)
    }
}

// Prompt template reserved for future LLM-based title generation:
// "Generate a short, descriptive title (3-8 words) for a chat conversation..."

// ============================================================================
// Utility Functions
// ============================================================================

/// Truncate a string to create a title, respecting word boundaries.
pub fn truncate_to_title(text: &str, max_chars: usize) -> String {
    let text = text.trim();

    // If short enough, return as-is (char-count, not byte-count).
    if text.chars().count() <= max_chars {
        return text.to_string();
    }

    // Find the byte index for the max char boundary and the last whitespace within it.
    let mut end_byte = text.len();
    let mut last_space_byte: Option<usize> = None;
    let mut last_space_char: Option<usize> = None;

    for (chars_seen, (idx, ch)) in text.char_indices().enumerate() {
        if chars_seen == max_chars {
            end_byte = idx;
            break;
        }
        if ch.is_whitespace() {
            last_space_byte = Some(idx);
            last_space_char = Some(chars_seen);
        }
    }

    let truncated = &text[..end_byte];
    let title = match (last_space_byte, last_space_char) {
        (Some(byte_idx), Some(char_idx)) if char_idx > max_chars / 2 => &truncated[..byte_idx],
        _ => truncated,
    };

    format!("{}...", title.trim())
}

// ============================================================================
// Fake Provider for Testing
// ============================================================================

/// A fake title generator for testing that returns deterministic titles.
pub struct FakeTitleGenerator {
    /// Fixed title to return, or None to use fallback.
    pub fixed_title: Option<String>,
    /// Fallback max chars.
    pub fallback_max_chars: usize,
}

impl FakeTitleGenerator {
    /// Create a fake generator that returns a fixed title.
    pub fn with_title(title: &str) -> Self {
        Self {
            fixed_title: Some(title.to_string()),
            fallback_max_chars: 50,
        }
    }

    /// Create a fake generator that always uses fallback.
    pub fn with_fallback() -> Self {
        Self {
            fixed_title: None,
            fallback_max_chars: 50,
        }
    }
}

#[async_trait]
impl TitleGeneratorTrait for FakeTitleGenerator {
    async fn generate_title(
        &self,
        user_message: &str,
        _provider_id: &str,
        _chat_model_id: &str,
    ) -> String {
        match &self.fixed_title {
            Some(title) => title.clone(),
            None => truncate_to_title(user_message, self.fallback_max_chars),
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
    fn test_truncate_to_title_short() {
        let result = truncate_to_title("Short message", 50);
        assert_eq!(result, "Short message");
    }

    #[test]
    fn test_truncate_to_title_long() {
        let result = truncate_to_title(
            "This is a much longer message that needs to be truncated for the sidebar",
            50,
        );
        assert!(result.len() <= 53); // 50 + "..."
        assert!(result.ends_with("..."));
    }

    #[test]
    fn test_truncate_to_title_word_boundary() {
        // Should break at word boundary, not mid-word
        let result = truncate_to_title("What are my portfolio holdings today", 30);
        assert_eq!(result, "What are my portfolio...");
    }

    #[test]
    fn test_truncate_to_title_preserves_short_words() {
        let result = truncate_to_title("A very short start", 50);
        assert_eq!(result, "A very short start");
    }

    #[tokio::test]
    async fn test_fake_title_generator_fixed() {
        let generator = FakeTitleGenerator::with_title("Test Title");
        let title = generator
            .generate_title("Any message", "openai", "gpt-4o")
            .await;
        assert_eq!(title, "Test Title");
    }

    #[tokio::test]
    async fn test_fake_title_generator_fallback() {
        let generator = FakeTitleGenerator::with_fallback();
        let title = generator
            .generate_title("What is my portfolio value?", "openai", "gpt-4o")
            .await;
        assert_eq!(title, "What is my portfolio value?");
    }

    #[tokio::test]
    async fn test_fake_title_generator_fallback_long() {
        let generator = FakeTitleGenerator::with_fallback();
        let title = generator
            .generate_title(
                "Can you show me a detailed breakdown of all my investment holdings across all accounts with their current market values?",
                "openai",
                "gpt-4o"
            )
            .await;
        assert!(title.ends_with("..."));
        assert!(title.len() <= 53);
    }

    /// Groq shut down `groq/compound`. Groq titles go to a model it still
    /// serves, and take the answer, not the reasoning gpt-oss sends with it.
    #[tokio::test]
    async fn groq_title_uses_a_served_model_and_skips_its_reasoning() {
        use crate::chat::provider_clients::transport_tests::read_request;
        use crate::env::test_env::MockEnvironment;
        use crate::provider_model::AI_PROVIDER_SETTINGS_KEY;
        use std::sync::Mutex;
        use tokio::io::AsyncWriteExt;
        use tokio::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let models = Arc::new(Mutex::new(Vec::new()));
        let requested = models.clone();
        let server = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let request = read_request(&mut socket).await;
                let (_, body) = request.split_once("\r\n\r\n").unwrap();
                let body: serde_json::Value = serde_json::from_str(body).unwrap();
                let model = body["model"].as_str().unwrap().to_string();
                requested.lock().unwrap().push(model.clone());
                let (status, reply) = if model == "groq/compound" {
                    (
                        "400 Bad Request",
                        serde_json::json!({"error": {
                            "message": "The model `groq/compound` has been decommissioned",
                            "type": "invalid_request_error", "code": "model_decommissioned"
                        }}),
                    )
                } else {
                    (
                        "200 OK",
                        serde_json::json!({
                            "id": "fixture", "object": "chat.completion", "created": 1,
                            "model": model, "choices": [{"index": 0, "message": {
                                "role": "assistant",
                                "reasoning": "The user asks about allocation.\nA short title fits.",
                                "content": "Portfolio Allocation Review"
                            }, "finish_reason": "stop"}],
                            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}
                        }),
                    )
                };
                let reply = reply.to_string();
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                    reply.len()
                );
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });

        let env = Arc::new(MockEnvironment::new().with_secret("ai_groq", "fixture-key"));
        env.settings_service
            .set_setting_value(
                AI_PROVIDER_SETTINGS_KEY,
                &serde_json::json!({"schemaVersion": 2, "providers": {"groq": {"customUrl": url}}})
                    .to_string(),
            )
            .await
            .unwrap();
        let generator = TitleGenerator::new(env, TitleGeneratorConfig::default());
        let title = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            generator.generate_title(
                "How is my portfolio allocated?",
                "groq",
                "openai/gpt-oss-120b",
            ),
        )
        .await
        .unwrap();
        server.abort();

        assert_eq!(
            (title.as_str(), models.lock().unwrap().as_slice()),
            (
                "Portfolio Allocation Review",
                ["openai/gpt-oss-20b".to_string()].as_slice()
            )
        );
    }
}
