//! Provider-specific rig client constructors + error remapping.
//!
//! Each function builds a configured rig client for one provider (Anthropic,
//! Gemini, Groq, OpenAI, OpenRouter, Ollama). Kept here so the streaming agent
//! builder doesn't have to mix provider plumbing with response handling.

use log::debug;
use reqwest::Client as HttpClient;
use rig::{
    client::Nothing,
    providers::{anthropic, gemini, groq, ollama, openai, openrouter},
};
use std::time::Duration;

use crate::error::AiError;

pub(super) fn create_anthropic_client(
    api_key: Option<String>,
    provider_id: &str,
    provider_url: Option<String>,
) -> Result<anthropic::Client<HttpClient>, AiError> {
    let key = api_key.ok_or_else(|| AiError::MissingApiKey(provider_id.to_string()))?;
    let mut builder = anthropic::Client::builder().api_key(&key);
    if let Some(url) = provider_url {
        builder = builder.base_url(&url);
    }
    builder
        .build()
        .map_err(|e| AiError::Provider(e.to_string()))
}

pub(super) fn create_gemini_client(
    api_key: Option<String>,
    provider_id: &str,
    provider_url: Option<String>,
) -> Result<gemini::Client<HttpClient>, AiError> {
    let key = api_key.ok_or_else(|| AiError::MissingApiKey(provider_id.to_string()))?;
    let mut builder = gemini::Client::builder().api_key(&key);
    if let Some(url) = provider_url {
        builder = builder.base_url(&url);
    }
    builder
        .build()
        .map_err(|e| AiError::Provider(e.to_string()))
}

pub(super) fn create_groq_client(
    api_key: Option<String>,
    provider_id: &str,
    provider_url: Option<String>,
) -> Result<groq::Client<HttpClient>, AiError> {
    let key = api_key.ok_or_else(|| AiError::MissingApiKey(provider_id.to_string()))?;
    let mut builder = groq::Client::builder().api_key(&key);
    if let Some(url) = provider_url {
        builder = builder.base_url(&url);
    }
    builder
        .build()
        .map_err(|e| AiError::Provider(e.to_string()))
}

/// Create OpenAI client using Completions API (not Responses API).
/// Responses API has issues with reasoning items in multi-turn conversations.
/// See: <https://community.openai.com/t/error-badrequesterror-400-item-of-type-reasoning-was-provided-without-its-required-following-item/1303809>
pub(super) fn create_openai_client(
    api_key: Option<String>,
    provider_id: &str,
    provider_url: Option<String>,
) -> Result<openai::CompletionsClient<HttpClient>, AiError> {
    let key = api_key.ok_or_else(|| AiError::MissingApiKey(provider_id.to_string()))?;
    let mut builder = openai::CompletionsClient::builder().api_key(&key);
    if let Some(url) = provider_url {
        builder = builder.base_url(&url);
    }
    builder
        .build()
        .map_err(|e| AiError::Provider(e.to_string()))
}

pub(super) fn create_openrouter_client(
    api_key: Option<String>,
    provider_id: &str,
    provider_url: Option<String>,
) -> Result<openrouter::Client<HttpClient>, AiError> {
    let key = api_key.ok_or_else(|| AiError::MissingApiKey(provider_id.to_string()))?;
    let mut builder = openrouter::Client::builder().api_key(&key);
    if let Some(url) = provider_url {
        builder = builder.base_url(&url);
    }
    builder
        .build()
        .map_err(|e| AiError::Provider(e.to_string()))
}

pub(super) fn create_ollama_client(
    provider_url: Option<String>,
) -> Result<ollama::Client<HttpClient>, AiError> {
    let mut builder = ollama::Client::builder().api_key(Nothing);
    if let Some(url) = provider_url {
        let normalized = url.trim_end_matches('/').trim_end_matches("/v1");
        builder = builder.base_url(normalized);
    }
    builder
        .build()
        .map_err(|e| AiError::Provider(e.to_string()))
}

/// Map low-level provider errors to clearer actionable messages.
pub(super) fn remap_provider_error(provider_id: &str, model_id: &str, error: AiError) -> AiError {
    match error {
        AiError::Provider(msg)
            if provider_id == "ollama" && msg.contains("missing field `model`") =>
        {
            AiError::Provider(format!(
                "Ollama returned an error payload for model '{}'. \
                Common causes: model not installed, context too large, or insufficient memory. \
                Check `ollama list` and Ollama logs. Original error: {}",
                model_id, msg
            ))
        }
        other => other,
    }
}

pub(super) fn ollama_model_matches(candidate: &str, selected: &str) -> bool {
    candidate == selected
        || candidate.trim_end_matches(":latest") == selected.trim_end_matches(":latest")
}

/// Validate selected Ollama model when `/api/tags` is reachable.
///
/// This is best-effort:
/// - If tags endpoint is unavailable/unparseable, we skip validation and continue.
/// - If tags are available and model is missing, we return a clear invalid-input error.
pub(super) async fn validate_ollama_model_if_possible(
    provider_url: Option<&str>,
    model_id: &str,
) -> Result<(), AiError> {
    let base = provider_url.unwrap_or("http://localhost:11434");
    let normalized = base.trim_end_matches('/');
    let tags_url = if normalized.ends_with("/v1") {
        format!("{}/api/tags", normalized.trim_end_matches("/v1"))
    } else {
        format!("{}/api/tags", normalized)
    };

    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(4))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            debug!(
                "Skipping Ollama model preflight (client build failed): {}",
                e
            );
            return Ok(());
        }
    };

    let response = match client.get(&tags_url).send().await {
        Ok(r) => r,
        Err(e) => {
            debug!("Skipping Ollama model preflight (tags fetch failed): {}", e);
            return Ok(());
        }
    };

    if !response.status().is_success() {
        debug!(
            "Skipping Ollama model preflight (tags status {} at {})",
            response.status(),
            tags_url
        );
        return Ok(());
    }

    let payload: serde_json::Value = match response.json().await {
        Ok(v) => v,
        Err(e) => {
            debug!("Skipping Ollama model preflight (invalid tags JSON): {}", e);
            return Ok(());
        }
    };

    let available: Vec<String> = payload
        .get("models")
        .and_then(|v| v.as_array())
        .map(|models| {
            models
                .iter()
                .filter_map(|m| m.get("name").and_then(|v| v.as_str()))
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default();

    if available.is_empty() {
        debug!("Skipping Ollama model preflight (no models in tags response)");
        return Ok(());
    }

    if available
        .iter()
        .any(|candidate| ollama_model_matches(candidate, model_id))
    {
        return Ok(());
    }

    let preview = available
        .iter()
        .take(5)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    Err(AiError::InvalidInput(format!(
        "Ollama model '{}' is not available. Install it with `ollama pull {}` or select an installed model in AI Providers settings. Available models: {}",
        model_id, model_id, preview
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ollama_model_match_without_latest_suffix() {
        assert!(ollama_model_matches("ministral-3:latest", "ministral-3"));
        assert!(ollama_model_matches("ministral-3", "ministral-3:latest"));
        assert!(!ollama_model_matches("qwen3:8b", "ministral-3"));
    }

    #[test]
    fn test_remap_provider_error_for_ollama_json_error() {
        let input = AiError::Provider(
            "CompletionError: JsonError: missing field `model` at line 1 column 44".to_string(),
        );
        let remapped = remap_provider_error("ollama", "ministral-3", input);
        match remapped {
            AiError::Provider(msg) => {
                assert!(msg.contains("Ollama returned an error payload"));
                assert!(msg.contains("ministral-3"));
            }
            _ => panic!("expected provider error"),
        }
    }
}
