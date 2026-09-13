//! Title generation service for chat threads.
//!
//! Auto-generates short descriptive titles from user messages using a fast model.
//! Falls back to truncating the first user message if generation fails.

use async_trait::async_trait;
use log::{debug, warn};
use reqwest::Client as HttpClient;
use rig::{
    client::{AgentClientExt, Nothing},
    completion::Prompt,
    providers::{anthropic, gemini, groq, ollama, openai, openrouter},
};

use crate::env::AiEnvironment;
use crate::error::AiError;
use crate::provider_urls::ensure_openai_v1_base_url;
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

        let response = match provider_id {
            "anthropic" => {
                let key = api_key.ok_or_else(|| AiError::MissingApiKey(provider_id.to_string()))?;
                let mut builder = anthropic::Client::<HttpClient>::builder()
                    .api_key(&key)
                    .http_client(wealthfolio_http::client());
                if let Some(url) = provider_url {
                    builder = builder.base_url(&url);
                }
                let client = builder
                    .build()
                    .map_err(|e| AiError::Provider(e.to_string()))?;
                client
                    .agent(model_id)
                    .max_tokens(self.config.max_tokens as u64)
                    .build()
                    .prompt(&prompt)
                    .await
                    .map_err(|e| AiError::Provider(e.to_string()))?
            }
            "gemini" | "google" => {
                let key = api_key.ok_or_else(|| AiError::MissingApiKey(provider_id.to_string()))?;
                let mut builder = gemini::Client::<HttpClient>::builder()
                    .api_key(&key)
                    .http_client(wealthfolio_http::client());
                if let Some(url) = provider_url {
                    builder = builder.base_url(&url);
                }
                let client = builder
                    .build()
                    .map_err(|e| AiError::Provider(e.to_string()))?;
                client
                    .agent(model_id)
                    .build()
                    .prompt(&prompt)
                    .await
                    .map_err(|e| AiError::Provider(e.to_string()))?
            }
            "groq" => {
                let key = api_key.ok_or_else(|| AiError::MissingApiKey(provider_id.to_string()))?;
                let mut builder = groq::Client::<HttpClient>::builder()
                    .api_key(&key)
                    .http_client(wealthfolio_http::client());
                if let Some(url) = provider_url {
                    let normalized = ensure_openai_v1_base_url(&url);
                    builder = builder.base_url(&normalized);
                }
                let client = builder
                    .build()
                    .map_err(|e| AiError::Provider(e.to_string()))?;
                client
                    .agent(model_id)
                    .build()
                    .prompt(&prompt)
                    .await
                    .map_err(|e| AiError::Provider(e.to_string()))?
            }
            "ollama" => {
                let mut builder = ollama::Client::<HttpClient>::builder()
                    .api_key(Nothing)
                    .http_client(wealthfolio_http::client());
                if let Some(url) = provider_url {
                    builder = builder.base_url(&url);
                }
                let client = builder
                    .build()
                    .map_err(|e| AiError::Provider(e.to_string()))?;
                client
                    .agent(model_id)
                    .build()
                    .prompt(&prompt)
                    .await
                    .map_err(|e| AiError::Provider(e.to_string()))?
            }
            "openrouter" => {
                let key = api_key.ok_or_else(|| AiError::MissingApiKey(provider_id.to_string()))?;
                let mut builder = openrouter::Client::<HttpClient>::builder()
                    .api_key(&key)
                    .http_client(wealthfolio_http::client());
                if let Some(url) = provider_url {
                    let normalized = ensure_openai_v1_base_url(&url);
                    builder = builder.base_url(&normalized);
                }
                let client = builder
                    .build()
                    .map_err(|e| AiError::Provider(e.to_string()))?;
                client
                    .agent(model_id)
                    .build()
                    .prompt(&prompt)
                    .await
                    .map_err(|e| AiError::Provider(e.to_string()))?
            }
            _ => {
                // Default to OpenAI-compatible
                let key = api_key.ok_or_else(|| AiError::MissingApiKey(provider_id.to_string()))?;
                let mut builder = openai::CompletionsClient::<HttpClient>::builder()
                    .api_key(&key)
                    .http_client(wealthfolio_http::client());
                if let Some(url) = provider_url {
                    let normalized = ensure_openai_v1_base_url(&url);
                    builder = builder.base_url(&normalized);
                }
                let client = builder
                    .build()
                    .map_err(|e| AiError::Provider(e.to_string()))?;
                client
                    .agent(model_id)
                    .build()
                    .prompt(&prompt)
                    .await
                    .map_err(|e| AiError::Provider(e.to_string()))?
            }
        };

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
}
