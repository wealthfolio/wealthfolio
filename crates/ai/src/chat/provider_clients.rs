//! Provider-specific rig client constructors + error remapping.
//!
//! Each function builds a configured rig client for one provider (Anthropic,
//! Gemini, Groq, OpenAI Responses, OpenAI-compatible Chat Completions,
//! OpenRouter, Ollama). Kept here so the streaming agent
//! builder doesn't have to mix provider plumbing with response handling.

use log::debug;
use rig::http_client::ReqwestClient;
use rig::providers::{
    anthropic::{Anthropic, AnthropicConfig},
    gemini::{Gemini, GeminiConfig},
    ollama::{wire::OllamaConfig, Ollama},
    openai::{
        wire::{GROQ, OPENROUTER},
        OpenAI, OpenAIConfig,
    },
};
use std::time::Duration;

use crate::error::AiError;
use crate::provider_urls::ensure_openai_v1_base_url;

/// Every provider sends through the app's shared HTTP client (proxy and TLS
/// settings included).
fn http() -> ReqwestClient {
    ReqwestClient::from(wealthfolio_http::client())
}

fn require_key(api_key: Option<String>, provider_id: &str) -> Result<String, AiError> {
    api_key.ok_or_else(|| AiError::MissingApiKey(provider_id.to_string()))
}

pub(crate) fn create_anthropic_client(
    api_key: Option<String>,
    provider_id: &str,
    provider_url: Option<String>,
) -> Result<Anthropic, AiError> {
    let mut config = AnthropicConfig::new(require_key(api_key, provider_id)?);
    if let Some(url) = provider_url {
        config = config.with_base_url(url);
    }
    Ok(config.connect(http()))
}

pub(crate) fn create_gemini_client(
    api_key: Option<String>,
    provider_id: &str,
    provider_url: Option<String>,
) -> Result<Gemini, AiError> {
    let mut config = GeminiConfig::new(require_key(api_key, provider_id)?);
    if let Some(url) = provider_url {
        config = config.with_base_url(url);
    }
    Ok(config.connect(http()))
}

/// An OpenAI-shaped client for `dialect`, at `provider_url` when set.
fn openai_shaped_client(
    config: OpenAIConfig,
    provider_url: Option<String>,
) -> Result<OpenAI, AiError> {
    let config = match provider_url {
        Some(url) => config.with_base_url(ensure_openai_v1_base_url(&url)),
        None => config,
    };
    Ok(config.connect(http()))
}

pub(crate) fn create_groq_client(
    api_key: Option<String>,
    provider_id: &str,
    provider_url: Option<String>,
) -> Result<OpenAI, AiError> {
    let key = require_key(api_key, provider_id)?;
    openai_shaped_client(OpenAIConfig::with_key(&GROQ, key), provider_url)
}

/// An OpenAI client. Build models with `.responses(model)` for OpenAI itself,
/// which current GPT models need for tool calls, or `.chat(model)` for
/// OpenAI-compatible custom endpoints that only serve Chat Completions.
/// Responses requests set `store: false` (see
/// `request_params::openai_responses_params`), so reasoning travels between
/// tool calls as encrypted items instead of being kept by OpenAI.
pub(crate) fn create_openai_client(
    api_key: Option<String>,
    provider_id: &str,
    provider_url: Option<String>,
) -> Result<OpenAI, AiError> {
    let key = require_key(api_key, provider_id)?;
    openai_shaped_client(OpenAIConfig::new(key), provider_url)
}

pub(crate) fn create_openrouter_client(
    api_key: Option<String>,
    provider_id: &str,
    provider_url: Option<String>,
) -> Result<OpenAI, AiError> {
    let key = require_key(api_key, provider_id)?;
    openai_shaped_client(OpenAIConfig::with_key(&OPENROUTER, key), provider_url)
}

pub(crate) fn create_ollama_client(provider_url: Option<String>) -> Result<Ollama, AiError> {
    let mut config = OllamaConfig::new();
    if let Some(url) = provider_url {
        config = config.with_base_url(url.trim_end_matches('/').trim_end_matches("/v1"));
    }
    Ok(config.connect(http()))
}

/// Remove the provider's API key from error text before it is logged or
/// shown. Transport errors quote the request URL, and rig sends the Gemini key
/// as a URL query parameter.
pub(crate) fn redact_secret(message: String, secret: Option<&str>) -> String {
    match secret.filter(|secret| !secret.is_empty()) {
        Some(secret) if message.contains(secret) => message.replace(secret, "[redacted]"),
        _ => message,
    }
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

    let client = match wealthfolio_http::client_builder()
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
    fn test_openai_compatible_clients_normalize_base_url() {
        let openai = create_openai_client(
            Some("test-key".to_string()),
            "openai",
            Some("http://localhost:8080/".to_string()),
        )
        .expect("openai client");
        assert_eq!(openai.config().base_url, "http://localhost:8080/v1");

        let groq = create_groq_client(
            Some("test-key".to_string()),
            "groq",
            Some("https://api.groq.com/openai".to_string()),
        )
        .expect("groq client");
        assert_eq!(groq.config().base_url, "https://api.groq.com/openai/v1");

        let openrouter = create_openrouter_client(
            Some("test-key".to_string()),
            "openrouter",
            Some("https://openrouter.ai/api/v1/".to_string()),
        )
        .expect("openrouter client");
        assert_eq!(openrouter.config().base_url, "https://openrouter.ai/api/v1");
    }

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

#[cfg(test)]
pub(crate) mod transport_tests {
    use super::*;
    use futures::StreamExt;
    use rig::{
        agent::MultiTurnStreamItem,
        message::ToolName,
        streaming::{Item, StreamEvent},
        tool::{DynamicTool, ToolOutput},
        AgentBuilder,
    };
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    fn sse(delta: serde_json::Value, finish: Option<&str>) -> String {
        format!(
            "data: {}\n\n",
            serde_json::json!({
                "id":"fixture", "object":"chat.completion.chunk", "created":1,
                "model":"fixture", "choices":[{"index":0,"delta":delta,"finish_reason":finish}]
            })
        )
    }

    pub(crate) async fn read_request(socket: &mut tokio::net::TcpStream) -> String {
        let mut bytes = Vec::new();
        loop {
            let mut chunk = [0; 4096];
            let n = socket.read(&mut chunk).await.unwrap();
            assert_ne!(n, 0);
            bytes.extend_from_slice(&chunk[..n]);
            if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&bytes[..end]);
                let length: usize = headers
                    .lines()
                    .find_map(|line| {
                        let (key, value) = line.split_once(':')?;
                        key.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse().unwrap())
                    })
                    .unwrap_or(0);
                if bytes.len() >= end + 4 + length {
                    break;
                }
            }
        }
        String::from_utf8(bytes).unwrap()
    }

    fn echo_tool(calls: Arc<AtomicUsize>) -> DynamicTool {
        DynamicTool::new(
            ToolName::new("echo").unwrap(),
            "Echo fixture",
            serde_json::json!({
                "type":"object", "properties":{"value":{"type":"string"}}, "required":["value"]
            }),
            move |args| {
                calls.fetch_add(1, Ordering::SeqCst);
                Box::pin(async move { Ok(ToolOutput::json(args)) })
            },
        )
    }

    #[tokio::test]
    async fn custom_endpoint_streams_and_round_trips_structured_tool_results() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let mut requests = Vec::new();
            for tool_round in [true, true, true, true, false] {
                let (mut socket, _) = listener.accept().await.unwrap();
                requests.push(read_request(&mut socket).await);
                let body = if tool_round {
                    sse(
                        serde_json::json!({"role":"assistant","tool_calls":[{
                            "index":0,"id":"call_fixture","type":"function",
                            "function":{"name":"echo","arguments":"{\"value\":\"fixture-value\"}"}
                        }]}),
                        Some("tool_calls"),
                    )
                } else {
                    sse(
                        serde_json::json!({"role":"assistant","content":"Fixture complete"}),
                        Some("stop"),
                    )
                } + "data: [DONE]\n\n";
                let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
                socket.write_all(response.as_bytes()).await.unwrap();
            }
            requests
        });
        let calls = Arc::new(AtomicUsize::new(0));
        let client = create_openai_client(
            Some("fixture-key".into()),
            "openai",
            Some(format!("http://{address}")),
        )
        .unwrap();
        let agent = AgentBuilder::new(client.chat("fixture"))
            .dynamic_tools(vec![echo_tool(calls.clone())])
            .build();
        let mut stream = agent
            .prompt("Run echo")
            .add_hook(crate::stream_hook::WealthfolioStreamHook::new())
            .max_turns(5)
            .stream();
        let mut text = String::new();
        let mut tool_result_seen = false;
        tokio::time::timeout(Duration::from_secs(10), async {
            while let Some(item) = stream.next().await {
                match item.unwrap() {
                    MultiTurnStreamItem::StreamAssistantItem(Item::Event(StreamEvent::Text {
                        text: t,
                        ..
                    })) => text.push_str(&t),
                    MultiTurnStreamItem::ToolResult { .. } => tool_result_seen = true,
                    _ => {}
                }
            }
        })
        .await
        .unwrap();
        let requests = server.await.unwrap();
        assert!(requests
            .iter()
            .all(|r| r.starts_with("POST /v1/chat/completions ")));
        assert!(requests[1].contains("fixture-value"));
        assert!(requests[1].contains("call_fixture"));
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert!(requests[3].contains("Stop calling this tool"));
        assert!(requests[4].contains("fixture-value"));
        assert!(tool_result_seen);
        assert_eq!(text, "Fixture complete");
    }

    #[tokio::test]
    async fn duplicate_guard_matches_arguments_in_any_key_order() {
        // The same call with its keys in a different order is still a repeat.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let mut requests = Vec::new();
            let arguments = [
                r#"{"value":"fixture-value","note":"n"}"#,
                r#"{"note":"n","value":"fixture-value"}"#,
                r#"{"value":"fixture-value","note":"n"}"#,
            ];
            for round in 0..=arguments.len() {
                let (mut socket, _) = listener.accept().await.unwrap();
                requests.push(read_request(&mut socket).await);
                let body = match arguments.get(round) {
                    Some(arguments) => sse(
                        serde_json::json!({"role":"assistant","tool_calls":[{
                            "index":0,"id":format!("call_{round}"),"type":"function",
                            "function":{"name":"echo","arguments":arguments}
                        }]}),
                        Some("tool_calls"),
                    ),
                    None => sse(
                        serde_json::json!({"role":"assistant","content":"Fixture complete"}),
                        Some("stop"),
                    ),
                } + "data: [DONE]\n\n";
                let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
                socket.write_all(response.as_bytes()).await.unwrap();
            }
            requests
        });
        let calls = Arc::new(AtomicUsize::new(0));
        let client = create_openai_client(
            Some("fixture-key".into()),
            "openai",
            Some(format!("http://{address}")),
        )
        .unwrap();
        let agent = AgentBuilder::new(client.chat("fixture"))
            .dynamic_tools(vec![echo_tool(calls.clone())])
            .build();
        let mut stream = agent
            .prompt("Run echo")
            .add_hook(crate::stream_hook::WealthfolioStreamHook::new())
            .max_turns(5)
            .stream();
        tokio::time::timeout(Duration::from_secs(10), async {
            while let Some(item) = stream.next().await {
                item.unwrap();
            }
        })
        .await
        .unwrap();
        let requests = server.await.unwrap();
        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "the third call is a repeat"
        );
        assert!(requests[3].contains("Stop calling this tool"));
        assert!(requests[3].contains("fixture-value"));
    }

    #[tokio::test]
    async fn dropping_stream_cancels_before_later_tool_execution() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (continue_tx, continue_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            read_request(&mut socket).await;
            let first = sse(
                serde_json::json!({"role":"assistant","content":"Starting"}),
                None,
            );
            let last = sse(
                serde_json::json!({"tool_calls":[{
                    "index":0,"id":"cancelled_call","type":"function",
                    "function":{"name":"echo","arguments":"{\"value\":\"cancelled\"}"}
                }]}),
                Some("tool_calls"),
            ) + "data: [DONE]\n\n";
            let headers = format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", first.len()+last.len());
            socket.write_all(headers.as_bytes()).await.unwrap();
            socket.write_all(first.as_bytes()).await.unwrap();
            continue_rx.await.unwrap();
            let _ = socket.write_all(last.as_bytes()).await;
        });
        let calls = Arc::new(AtomicUsize::new(0));
        let client = create_openai_client(
            Some("fixture-key".into()),
            "openai",
            Some(format!("http://{address}")),
        )
        .unwrap();
        let agent = AgentBuilder::new(client.chat("fixture"))
            .dynamic_tools(vec![echo_tool(calls.clone())])
            .build();
        let mut stream = agent.prompt("Run echo").max_turns(2).stream();
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if matches!(
                    stream.next().await.unwrap().unwrap(),
                    MultiTurnStreamItem::StreamAssistantItem(Item::Event(StreamEvent::Text { .. }))
                ) {
                    break;
                }
            }
        })
        .await
        .unwrap();
        drop(stream);
        continue_tx.send(()).unwrap();
        server.await.unwrap();
        tokio::task::yield_now().await;
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn asset_selection_pause_drains_tool_batch_without_another_model_request() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            read_request(&mut socket).await;
            let body = sse(
                serde_json::json!({"role":"assistant","tool_calls":[
                    {"index":0,"id":"selection","type":"function","function":{"name":"prepare_asset_classification","arguments":"{}"}},
                    {"index":1,"id":"sibling","type":"function","function":{"name":"echo","arguments":"{\"value\":\"sibling-result\"}"}}
                ]}),
                Some("tool_calls"),
            ) + "data: [DONE]\n\n";
            let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
            socket.write_all(response.as_bytes()).await.unwrap();
            assert!(
                tokio::time::timeout(Duration::from_millis(300), listener.accept())
                    .await
                    .is_err(),
                "pause must prevent another model request"
            );
        });
        let calls = Arc::new(AtomicUsize::new(0));
        let select = DynamicTool::new(
            ToolName::new("prepare_asset_classification").unwrap(),
            "Selection fixture",
            serde_json::json!({"type":"object","properties":{}}),
            |_| {
                Box::pin(async {
                    Ok(ToolOutput::json(
                        serde_json::json!({"draftStatus":"needsAssetSelection"}),
                    ))
                })
            },
        );
        let client = create_openai_client(
            Some("fixture-key".into()),
            "openai",
            Some(format!("http://{address}")),
        )
        .unwrap();
        let agent = AgentBuilder::new(client.chat("fixture"))
            .dynamic_tools(vec![select, echo_tool(calls.clone())])
            .build();
        let hook = crate::stream_hook::WealthfolioStreamHook::new();
        let mut stream = agent
            .prompt("Select asset")
            .add_hook(hook.clone())
            .max_turns(3)
            .stream();
        let mut results = Vec::new();
        tokio::time::timeout(Duration::from_secs(10), async {
            while let Some(item) = stream.next().await {
                match item {
                    Ok(MultiTurnStreamItem::ToolResult { tool_result }) => {
                        results.push(tool_result.name.to_string())
                    }
                    Err(error) if hook.is_asset_selection_pause(&error) => break,
                    Err(error) => panic!("unexpected stream failure: {error}"),
                    _ => {}
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(results, ["prepare_asset_classification", "echo"]);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(hook.paused_for_asset_selection());
        server.await.unwrap();
    }
    #[tokio::test]
    async fn groq_tool_followup_omits_reasoning_content() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let mut requests = Vec::new();
            for tool_round in [true, false] {
                let (mut socket, _) = listener.accept().await.unwrap();
                requests.push(read_request(&mut socket).await);
                let body = if tool_round {
                    sse(
                        serde_json::json!({"role":"assistant","reasoning":"Use the allocation tool."}),
                        None,
                    ) + &sse(
                        serde_json::json!({"tool_calls":[{"index":0,"id":"call_fixture","type":"function","function":{"name":"echo","arguments":"{\"value\":\"fixture\"}"}}]}),
                        Some("tool_calls"),
                    )
                } else {
                    sse(
                        serde_json::json!({"role":"assistant","content":"Allocation complete"}),
                        Some("stop"),
                    )
                } + "data: [DONE]\n\n";
                let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
                socket.write_all(response.as_bytes()).await.unwrap();
            }
            requests
        });
        let client = create_groq_client(
            Some("fixture-key".into()),
            "groq",
            Some(format!("http://{address}")),
        )
        .unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let agent = AgentBuilder::new(client.completion("openai/gpt-oss-120b"))
            .dynamic_tools(vec![echo_tool(calls.clone())])
            .build();
        let mut stream = agent
            .prompt("Analyze allocation")
            .add_hook(crate::stream_hook::WealthfolioStreamHook::for_provider(
                "groq",
            ))
            .max_turns(2)
            .stream();
        let mut saw_reasoning = false;
        let mut text = String::new();
        tokio::time::timeout(Duration::from_secs(10), async {
            while let Some(item) = stream.next().await {
                match item.unwrap() {
                    MultiTurnStreamItem::StreamAssistantItem(Item::Event(
                        StreamEvent::Reasoning { .. }
                        | StreamEvent::End {
                            content: rig::message::AssistantContent::Reasoning(_),
                            ..
                        },
                    )) => saw_reasoning = true,
                    MultiTurnStreamItem::StreamAssistantItem(Item::Event(StreamEvent::Text {
                        text: t,
                        ..
                    })) => text.push_str(&t),
                    _ => {}
                }
            }
        })
        .await
        .unwrap();
        let requests = server.await.unwrap();
        assert!(
            saw_reasoning,
            "reasoning must remain visible to the application"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(text, "Allocation complete");
        let body: serde_json::Value =
            serde_json::from_str(requests[1].split_once("\r\n\r\n").unwrap().1).unwrap();
        let messages = body["messages"].as_array().unwrap();
        assert!(messages
            .iter()
            .all(|m| m.get("reasoning_content").is_none()));
        assert!(messages
            .iter()
            .any(|m| m["role"] == "assistant" && m["tool_calls"].is_array()));
        assert!(messages.iter().any(|m| m["role"] == "tool"));
    }
    /// Gemini signatures are base64; rig drops one that is not, since Gemini
    /// rejects the whole request over it.
    const GEMINI_SIGNATURE: &str = "Zml4dHVyZS1zaWduYXR1cmU=";

    fn provider_fixture(provider: &str, tools: bool) -> String {
        use serde_json::json;
        let event = |v: serde_json::Value| format!("data: {v}\n\n");
        match provider {
            "ollama" => format!(
                "{}\n",
                json!({"model":"fixture","created_at":"2026-09-11T00:00:00Z","done":true,"done_reason":"stop","message":if tools {
                json!({"role":"assistant","content":"","thinking":"Use echo.","tool_calls":[{"function":{"name":"echo","arguments":{"value":"fixture"}}}]})
            } else { json!({"role":"assistant","content":"Complete"}) }})
            ),
            "gemini" => event(
                json!({"candidates":[{"content":{"role":"model","parts":if tools {
                json!([{"text":"Use echo.","thought":true},{"functionCall":{"name":"echo","args":{"value":"fixture"}},"thoughtSignature":GEMINI_SIGNATURE}])
            } else {json!([{"text":"Complete"}])}},"finishReason":"STOP","index":0}]}),
            ),
            "anthropic" => {
                let mut body = event(
                    json!({"type":"message_start","message":{"id":"msg_fixture","type":"message","role":"assistant","model":"fixture","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}),
                );
                if tools {
                    for v in [
                        json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}),
                        json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Use echo."}}),
                        json!({"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"fixture-signature"}}),
                        json!({"type":"content_block_stop","index":0}),
                        json!({"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call_fixture","name":"echo","input":{}}}),
                        json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"value\":\"fixture\"}"}}),
                        json!({"type":"content_block_stop","index":1}),
                    ] {
                        body += &event(v);
                    }
                } else {
                    for v in [
                        json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
                        json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Complete"}}),
                        json!({"type":"content_block_stop","index":0}),
                    ] {
                        body += &event(v);
                    }
                }
                body += &event(
                    json!({"type":"message_delta","delta":{"stop_reason":if tools {"tool_use"} else {"end_turn"},"stop_sequence":null},"usage":{"output_tokens":1}}),
                );
                body + &event(json!({"type":"message_stop"}))
            }
            "openrouter" => {
                // OpenRouter streams reasoning as `reasoning` text plus signed
                // `reasoning_details` entries.
                let body = if tools {
                    sse(
                        json!({"role":"assistant","reasoning":"Use echo.","reasoning_details":[
                            {"type":"reasoning.text","text":"Use echo.","signature":"fixture-signature","format":"unknown","index":0}
                        ]}),
                        None,
                    ) + &sse(
                        json!({"tool_calls":[{"index":0,"id":"call_fixture","type":"function","function":{"name":"echo","arguments":"{\"value\":\"fixture\"}"}}]}),
                        Some("tool_calls"),
                    )
                } else {
                    sse(
                        json!({"role":"assistant","content":"Complete"}),
                        Some("stop"),
                    )
                };
                body + "data: [DONE]\n\n"
            }
            _ => {
                let body = if tools {
                    sse(
                        json!({"role":"assistant","reasoning_content":"Use echo."}),
                        None,
                    ) + &sse(
                        json!({"tool_calls":[{"index":0,"id":"call_fixture","type":"function","function":{"name":"echo","arguments":"{\"value\":\"fixture\"}"}}]}),
                        Some("tool_calls"),
                    )
                } else {
                    sse(
                        json!({"role":"assistant","content":"Complete"}),
                        Some("stop"),
                    )
                };
                body + "data: [DONE]\n\n"
            }
        }
    }

    async fn verify_provider_round_trip(provider: &'static str) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = Some(format!("http://{}", listener.local_addr().unwrap()));
        let server = tokio::spawn(async move {
            let mut requests = Vec::new();
            for tool_round in [true, false] {
                let (mut socket, _) = listener.accept().await.unwrap();
                requests.push(read_request(&mut socket).await);
                let body = provider_fixture(provider, tool_round);
                let mime = if provider == "ollama" {
                    "application/x-ndjson"
                } else {
                    "text/event-stream"
                };
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            }
            requests
        });
        let calls = Arc::new(AtomicUsize::new(0));
        let key = Some("fixture-key".to_string());
        macro_rules! agent {
            ($model:expr) => {
                AgentBuilder::new($model)
                    .max_tokens(1024)
                    .dynamic_tools(vec![echo_tool(calls.clone())])
                    .build()
            };
        }
        let agent = match provider {
            "ollama" => agent!(create_ollama_client(url)
                .unwrap()
                .native_completion("fixture")),
            "gemini" => agent!(create_gemini_client(key, provider, url)
                .unwrap()
                .completion("fixture")),
            "anthropic" => agent!(create_anthropic_client(key, provider, url)
                .unwrap()
                .completion("fixture")),
            "openrouter" => agent!(create_openrouter_client(key, provider, url)
                .unwrap()
                .completion("fixture")),
            _ => agent!(create_openai_client(key, provider, url)
                .unwrap()
                .chat("fixture")),
        };
        let mut stream = agent
            .prompt("Use echo")
            .add_hook(crate::stream_hook::WealthfolioStreamHook::for_provider(
                provider,
            ))
            .max_turns(2)
            .stream();
        let mut text = String::new();
        tokio::time::timeout(Duration::from_secs(10), async {
            while let Some(item) = stream.next().await {
                if let MultiTurnStreamItem::StreamAssistantItem(Item::Event(StreamEvent::Text {
                    text: t,
                    ..
                })) = item.unwrap()
                {
                    text.push_str(&t);
                }
            }
        })
        .await
        .unwrap();
        let requests = server.await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1, "{provider}");
        assert_eq!(text, "Complete", "{provider}");
        let body: serde_json::Value =
            serde_json::from_str(requests[1].split_once("\r\n\r\n").unwrap().1).unwrap();
        let expected_path = match provider {
            "ollama" => "POST /api/chat ",
            "anthropic" => "POST /v1/messages ",
            "gemini" => "POST /v1beta/models/fixture:streamGenerateContent",
            _ => "POST /v1/chat/completions ",
        };
        assert!(
            requests[0].starts_with(expected_path),
            "{provider} endpoint mismatch"
        );
        let serialized = body.to_string();
        assert!(
            serialized.contains("fixture"),
            "tool result must round-trip"
        );
        match provider {
            "anthropic" => assert!(
                serialized.contains("fixture-signature"),
                "{provider} must preserve reasoning signatures"
            ),
            "gemini" => assert!(
                serialized.contains(GEMINI_SIGNATURE),
                "{provider} must preserve reasoning signatures"
            ),
            "ollama" => assert!(
                serialized.contains("thinking"),
                "Ollama must retain thinking"
            ),
            "openrouter" => assert!(
                serialized.contains("Use echo.")
                    && (serialized.contains("reasoning_details")
                        || serialized.contains("\"reasoning\"")),
                "OpenRouter must preserve native reasoning"
            ),
            _ => assert!(
                serialized.contains("reasoning_content"),
                "Only Groq should omit reasoning history"
            ),
        }
    }

    #[tokio::test]
    async fn ollama_reasoning_tool_round_trip() {
        verify_provider_round_trip("ollama").await;
    }
    #[tokio::test]
    async fn gemini_reasoning_tool_round_trip() {
        verify_provider_round_trip("gemini").await;
    }
    #[tokio::test]
    async fn anthropic_reasoning_tool_round_trip() {
        verify_provider_round_trip("anthropic").await;
    }
    #[tokio::test]
    async fn openrouter_reasoning_tool_round_trip() {
        verify_provider_round_trip("openrouter").await;
    }
    #[tokio::test]
    async fn openai_reasoning_tool_round_trip() {
        verify_provider_round_trip("openai").await;
    }

    /// Serve `rounds` streamed responses and return the request bodies.
    async fn serve_rounds(
        listener: TcpListener,
        rounds: Vec<String>,
    ) -> Vec<(String, serde_json::Value)> {
        let mut requests = Vec::new();
        for body in rounds {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_request(&mut socket).await;
            let (head, json) = request.split_once("\r\n\r\n").unwrap();
            requests.push((head.to_string(), serde_json::from_str(json).unwrap()));
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        }
        requests
    }

    async fn run_echo_agent(agent: rig::Agent, provider: &str) -> String {
        let mut stream = agent
            .prompt("Use echo")
            .add_hook(crate::stream_hook::WealthfolioStreamHook::for_provider(
                provider,
            ))
            .max_turns(2)
            .stream();
        let mut text = String::new();
        tokio::time::timeout(Duration::from_secs(10), async {
            while let Some(item) = stream.next().await {
                if let MultiTurnStreamItem::StreamAssistantItem(Item::Event(StreamEvent::Text {
                    text: t,
                    ..
                })) = item.unwrap()
                {
                    text.push_str(&t);
                }
            }
        })
        .await
        .unwrap();
        text
    }

    #[tokio::test]
    async fn openai_responses_carry_encrypted_reasoning_across_tool_calls() {
        use serde_json::json;
        let event = |v: serde_json::Value| format!("data: {v}\n\n");
        let completed = |seq: u64| {
            event(
                json!({"type":"response.completed","sequence_number":seq,"response":{
                    "id":"resp_fixture","object":"response","created_at":0,"status":"completed",
                    "model":"gpt-6-astra","output":[],"tools":[]
                }}),
            )
        };
        let tool_round = event(
            json!({"type":"response.output_item.done","output_index":0,"sequence_number":1,
            "item":{"type":"reasoning","id":"rs_fixture","summary":[],"encrypted_content":"enc-fixture"}}),
        ) + &event(
            json!({"type":"response.output_item.done","output_index":1,"sequence_number":2,
            "item":{"type":"function_call","id":"fc_fixture","call_id":"call_fixture","name":"echo",
                "arguments":"{\"value\":\"fixture\"}","status":"completed"}}),
        ) + &completed(3);
        let answer_round = event(
            json!({"type":"response.output_text.delta","item_id":"msg_fixture",
            "output_index":0,"content_index":0,"sequence_number":1,"delta":"Complete"}),
        ) + &completed(2);

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(serve_rounds(listener, vec![tool_round, answer_round]));
        let calls = Arc::new(AtomicUsize::new(0));
        let model = create_openai_client(Some("fixture-key".into()), "openai", Some(url))
            .unwrap()
            .responses("gpt-6-astra");
        let agent = AgentBuilder::new(model)
            .additional_params(super::super::request_params::openai_responses_params(
                "gpt-6-astra",
                true,
            ))
            .dynamic_tools(vec![echo_tool(calls.clone())])
            .build();
        let text = run_echo_agent(agent, "openai").await;
        let requests = server.await.unwrap();

        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(text, "Complete");
        for (line, body) in &requests {
            assert!(line.starts_with("POST /v1/responses "), "{line}");
            assert_eq!(body["store"], json!(false));
            assert_eq!(body["include"], json!(["reasoning.encrypted_content"]));
            assert_eq!(body["reasoning"]["effort"], json!("medium"));
            assert!(body.get("temperature").is_none());
            // An omitted `strict` makes OpenAI attempt strict mode, which turns
            // every optional argument into a required one.
            for tool in body["tools"].as_array().unwrap() {
                assert_eq!(tool["strict"], json!(false), "{tool}");
            }
        }
        let input = requests[1].1["input"].as_array().unwrap();
        let item = |kind: &str| {
            input
                .iter()
                .find(|item| item["type"] == kind)
                .unwrap_or_else(|| panic!("no {kind} item in {input:?}"))
        };
        assert_eq!(item("reasoning")["id"], json!("rs_fixture"));
        assert_eq!(item("reasoning")["encrypted_content"], json!("enc-fixture"));
        assert_eq!(item("function_call")["call_id"], json!("call_fixture"));
        assert_eq!(
            item("function_call_output")["call_id"],
            json!("call_fixture")
        );
        assert!(item("function_call_output")["output"]
            .to_string()
            .contains("fixture"));
    }

    /// Answer every request until none arrives for a second. Title requests
    /// get a 500 so the title falls back; chat requests get `chat_body`.
    async fn serve_chat(
        listener: TcpListener,
        chat_body: String,
    ) -> Vec<(String, serde_json::Value)> {
        let mut chats = Vec::new();
        while let Ok(Ok((mut socket, _))) =
            tokio::time::timeout(Duration::from_secs(1), listener.accept()).await
        {
            // A request the client dropped before sending (the title request
            // when the chat finishes first) arrives as an empty connection.
            let mut first = [0; 1];
            if socket.peek(&mut first).await.unwrap_or(0) == 0 {
                continue;
            }
            let request = read_request(&mut socket).await;
            let (head, json) = request.split_once("\r\n\r\n").unwrap();
            if json.contains("Generate a very short plain-text title") {
                socket.write_all(b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
                continue;
            }
            chats.push((head.to_string(), serde_json::from_str(json).unwrap()));
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{chat_body}", chat_body.len()).as_bytes()).await.unwrap();
        }
        chats
    }

    /// Send one message through `ChatService` with the provider pointed at a
    /// local fixture server, and return the chat requests it made.
    async fn chat_through_service(
        provider: &str,
        model: &str,
        thinking: bool,
        provider_settings: serde_json::Value,
    ) -> Vec<(String, serde_json::Value)> {
        use crate::chat::{ChatConfig, ChatService};
        use crate::env::test_env::{MockEnvironment, MockSettingsService};
        use crate::provider_model::AI_PROVIDER_SETTINGS_KEY;
        use crate::types::{AiStreamEvent, ChatModelConfig, SendMessageRequest};

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let fixture = if provider == "google" {
            "gemini"
        } else {
            provider
        };
        let server = tokio::spawn(serve_chat(listener, provider_fixture(fixture, false)));

        let mut user = provider_settings;
        user["enabled"] = serde_json::json!(true);
        user["customUrl"] = serde_json::json!(url);
        let settings = serde_json::json!({ "schemaVersion": 2, "providers": { provider: user } });
        let mut env = MockEnvironment::new().with_secret(&format!("ai_{provider}"), "fixture-key");
        env.settings_service = Arc::new(MockSettingsService {
            settings: std::sync::RwLock::new(std::collections::HashMap::from([(
                AI_PROVIDER_SETTINGS_KEY.to_string(),
                settings.to_string(),
            )])),
        });
        let service = ChatService::new(Arc::new(env), ChatConfig::default());
        let mut stream = service
            .send_message(SendMessageRequest {
                content: "Hello".into(),
                config: Some(ChatModelConfig {
                    provider: Some(provider.into()),
                    model: Some(model.into()),
                    thinking: Some(thinking),
                }),
                ..Default::default()
            })
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(10), async {
            while let Some(event) = stream.next().await {
                if let AiStreamEvent::Error { message, .. } = event {
                    panic!("chat failed: {message}");
                }
            }
        })
        .await
        .unwrap();
        let chats = server.await.unwrap();
        assert_eq!(chats.len(), 1, "one chat request");
        chats
    }

    #[tokio::test]
    async fn chat_keeps_each_model_calls_reasoning_separate() {
        use crate::chat::{ChatConfig, ChatService};
        use crate::env::test_env::{MockEnvironment, MockSettingsService};
        use crate::provider_model::AI_PROVIDER_SETTINGS_KEY;
        use crate::types::{AiStreamEvent, ChatMessagePart, ChatModelConfig, SendMessageRequest};
        use serde_json::json;

        // Both model calls open their reasoning at part 0; stream parts are
        // numbered per call, so the second must not overwrite the first.
        let event = |v: serde_json::Value| format!("data: {v}\n\n");
        let message = |stop: &str, blocks: Vec<serde_json::Value>| {
            let mut body = event(json!({"type":"message_start","message":{"id":"msg_fixture",
                "type":"message","role":"assistant","model":"claude-opus-5-5","content":[],
                "stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}));
            for block in blocks {
                body += &event(block);
            }
            body += &event(json!({"type":"message_delta","delta":{"stop_reason":stop,
                "stop_sequence":null},"usage":{"output_tokens":1}}));
            body + &event(json!({"type":"message_stop"}))
        };
        let thinking = |text: &str| {
            vec![
                json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}),
                json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":text}}),
                json!({"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig"}}),
                json!({"type":"content_block_stop","index":0}),
            ]
        };
        let mut tool_turn = thinking("Plan A.");
        tool_turn.extend([
            json!({"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_accounts","name":"get_accounts","input":{}}}),
            json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{}"}}),
            json!({"type":"content_block_stop","index":1}),
        ]);
        let mut answer_turn = thinking("Plan B.");
        answer_turn.extend([
            json!({"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}),
            json!({"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Done"}}),
            json!({"type":"content_block_stop","index":1}),
        ]);
        let mut rounds = vec![
            message("tool_use", tool_turn),
            message("end_turn", answer_turn),
        ]
        .into_iter();

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            while let Ok(Ok((mut socket, _))) =
                tokio::time::timeout(Duration::from_secs(1), listener.accept()).await
            {
                let mut first = [0; 1];
                if socket.peek(&mut first).await.unwrap_or(0) == 0 {
                    continue;
                }
                let request = read_request(&mut socket).await;
                let is_title = request.contains("Generate a very short plain-text title");
                let next = if is_title { None } else { rounds.next() };
                let response = match next {
                    Some(body) => {
                        format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
                    }
                    None => "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string(),
                };
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });

        let settings = json!({ "schemaVersion": 2, "providers": {
            "anthropic": { "enabled": true, "customUrl": url }
        } });
        let mut env = MockEnvironment::new().with_secret("ai_anthropic", "fixture-key");
        env.settings_service = Arc::new(MockSettingsService {
            settings: std::sync::RwLock::new(std::collections::HashMap::from([(
                AI_PROVIDER_SETTINGS_KEY.to_string(),
                settings.to_string(),
            )])),
        });
        let service = ChatService::new(Arc::new(env), ChatConfig::default());
        let mut stream = service
            .send_message(SendMessageRequest {
                content: "List my accounts".into(),
                config: Some(ChatModelConfig {
                    provider: Some("anthropic".into()),
                    model: Some("claude-opus-5-5".into()),
                    thinking: Some(true),
                }),
                ..Default::default()
            })
            .await
            .unwrap();
        let mut reasoning_deltas = String::new();
        let mut final_parts = None;
        tokio::time::timeout(Duration::from_secs(10), async {
            while let Some(event) = stream.next().await {
                match event {
                    AiStreamEvent::ReasoningDelta { delta, .. } => {
                        reasoning_deltas.push_str(&delta)
                    }
                    AiStreamEvent::Done { message, .. } => {
                        final_parts = Some(message.content.parts)
                    }
                    AiStreamEvent::Error { message, .. } => panic!("chat failed: {message}"),
                    _ => {}
                }
            }
        })
        .await
        .unwrap();
        server.await.unwrap();

        assert_eq!(
            reasoning_deltas, "Plan A.Plan B.",
            "no reasoning is repeated"
        );
        let parts = final_parts.expect("the run finishes");
        let reasoning: Vec<&str> = parts
            .iter()
            .filter_map(|part| match part {
                ChatMessagePart::Reasoning { content } => Some(content.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(reasoning, ["Plan A.", "Plan B."]);
        let call_id = parts.iter().find_map(|part| match part {
            ChatMessagePart::ToolCall { tool_call_id, .. } => Some(tool_call_id.clone()),
            _ => None,
        });
        let result_id = parts.iter().find_map(|part| match part {
            ChatMessagePart::ToolResult { tool_call_id, .. } => Some(tool_call_id.clone()),
            _ => None,
        });
        assert_eq!(call_id.as_deref(), Some("toolu_accounts"));
        assert_eq!(result_id, call_id);
    }

    #[tokio::test]
    async fn chat_sends_adaptive_thinking_to_claude_5_and_drops_its_temperature() {
        let chats = chat_through_service(
            "anthropic",
            "claude-opus-5-5",
            true,
            serde_json::json!({ "tuningOverrides": { "temperature": 0.5 } }),
        )
        .await;
        let (line, body) = &chats[0];
        assert!(line.starts_with("POST /v1/messages "), "{line}");
        // rig 0.44 adds the preserved-thinking binding on Claude 5 models.
        assert_eq!(
            body["thinking"],
            serde_json::json!({"type":"adaptive","display":"summarized",
                "block_binding":{"prefix_mismatch_behavior":"drop_block"}})
        );
        assert!(
            line.contains("thinking-binding-controls-2026-08-01"),
            "{line}"
        );
        assert!(body.get("temperature").is_none());
        assert_eq!(body["max_tokens"], serde_json::json!(32000));
        assert!(!body["tools"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn chat_keeps_a_user_temperature_where_claude_accepts_it() {
        let chats = chat_through_service(
            "anthropic",
            "claude-sonnet-4-6",
            false,
            serde_json::json!({ "tuningOverrides": { "temperature": 0.5 } }),
        )
        .await;
        let body = &chats[0].1;
        assert!(body.get("thinking").is_none());
        assert_eq!(body["temperature"], serde_json::json!(0.5));
        assert_eq!(body["max_tokens"], serde_json::json!(16384));
    }

    #[tokio::test]
    async fn chat_sends_a_thinking_level_to_gemini_3_with_catalog_options() {
        let chats =
            chat_through_service("google", "gemini-3.8-flash", true, serde_json::json!({})).await;
        let (line, body) = &chats[0];
        assert!(
            line.contains("/models/gemini-3.8-flash:streamGenerateContent"),
            "{line}"
        );
        let config = &body["generationConfig"];
        assert_eq!(
            config["thinkingConfig"],
            serde_json::json!({"thinkingLevel":"high","includeThoughts":true})
        );
        assert!(config.get("temperature").is_none());
        assert_eq!(body["safetySettings"].as_array().unwrap().len(), 4);
    }

    #[tokio::test]
    async fn chat_keeps_the_budget_and_temperature_for_gemini_2_5() {
        let chats =
            chat_through_service("google", "gemini-2.5-flash", true, serde_json::json!({})).await;
        let config = &chats[0].1["generationConfig"];
        assert_eq!(
            config["thinkingConfig"],
            serde_json::json!({"thinkingBudget":8192,"includeThoughts":true})
        );
        assert_eq!(config["temperature"], serde_json::json!(0.2));
    }

    #[tokio::test]
    async fn chat_uses_chat_completions_for_an_openai_compatible_endpoint() {
        let chats =
            chat_through_service("openai", "gpt-6-astra", true, serde_json::json!({})).await;
        let (line, body) = &chats[0];
        assert!(line.starts_with("POST /v1/chat/completions "), "{line}");
        assert!(body.get("temperature").is_none());
        assert!(body.get("store").is_none());
        assert!(!body["tools"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn gemini_transport_errors_do_not_expose_the_api_key() {
        use crate::chat::{ChatConfig, ChatService};
        use crate::env::test_env::{MockEnvironment, MockSettingsService};
        use crate::provider_model::AI_PROVIDER_SETTINGS_KEY;
        use crate::types::{AiStreamEvent, ChatModelConfig, SendMessageRequest};

        // rig sends the Gemini key in the URL query, and a transport error
        // quotes the URL. Point the provider at a closed port.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        let settings = serde_json::json!({ "schemaVersion": 2, "providers": {
            "google": { "enabled": true, "customUrl": url }
        } });
        let mut env = MockEnvironment::new().with_secret("ai_google", "AIzaFixtureSecret");
        env.settings_service = Arc::new(MockSettingsService {
            settings: std::sync::RwLock::new(std::collections::HashMap::from([(
                AI_PROVIDER_SETTINGS_KEY.to_string(),
                settings.to_string(),
            )])),
        });
        let service = ChatService::new(Arc::new(env), ChatConfig::default());
        let mut stream = service
            .send_message(SendMessageRequest {
                content: "Hello".into(),
                config: Some(ChatModelConfig {
                    provider: Some("google".into()),
                    model: Some("gemini-3.8-flash".into()),
                    thinking: Some(false),
                }),
                ..Default::default()
            })
            .await
            .unwrap();
        let mut errors = Vec::new();
        tokio::time::timeout(Duration::from_secs(10), async {
            while let Some(event) = stream.next().await {
                if let AiStreamEvent::Error { message, .. } = event {
                    errors.push(message);
                }
            }
        })
        .await
        .unwrap();
        assert!(!errors.is_empty(), "the failed request surfaces an error");
        for message in &errors {
            assert!(!message.contains("AIzaFixtureSecret"), "{message}");
        }
        assert!(errors
            .iter()
            .any(|message| message.contains("key=[redacted]")));
    }

    #[tokio::test]
    async fn gemini_3_sends_thinking_level_without_a_budget() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(serve_rounds(
            listener,
            vec![
                provider_fixture("gemini", true),
                provider_fixture("gemini", false),
            ],
        ));
        let calls = Arc::new(AtomicUsize::new(0));
        let params =
            super::super::request_params::gemini_thinking_params("gemini-3.8-flash", true).unwrap();
        let model = create_gemini_client(Some("fixture-key".into()), "google", Some(url))
            .unwrap()
            .completion("gemini-3.8-flash");
        let agent = AgentBuilder::new(model)
            .additional_params(params)
            .dynamic_tools(vec![echo_tool(calls.clone())])
            .build();
        assert_eq!(run_echo_agent(agent, "google").await, "Complete");
        let requests = server.await.unwrap();
        for (_, body) in &requests {
            assert_eq!(
                body["generationConfig"]["thinkingConfig"],
                serde_json::json!({"thinkingLevel":"high","includeThoughts":true})
            );
            assert!(body["generationConfig"].get("temperature").is_none());
        }
        assert!(requests[1].1.to_string().contains(GEMINI_SIGNATURE));
    }

    #[tokio::test]
    async fn anthropic_adaptive_thinking_replays_signature_only_blocks() {
        use serde_json::json;
        // Claude 4.7 and later stream thinking blocks with empty text unless
        // `display` asks for a summary; the signature alone must go back with
        // the tool result.
        let event = |v: serde_json::Value| format!("data: {v}\n\n");
        let message = |stop: &str, blocks: Vec<serde_json::Value>| {
            let mut body = event(json!({"type":"message_start","message":{"id":"msg_fixture",
                "type":"message","role":"assistant","model":"claude-opus-5-5","content":[],
                "stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}));
            for block in blocks {
                body += &event(block);
            }
            body += &event(json!({"type":"message_delta","delta":{"stop_reason":stop,
                "stop_sequence":null},"usage":{"output_tokens":1}}));
            body + &event(json!({"type":"message_stop"}))
        };
        let tool_round = message(
            "tool_use",
            vec![
                json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}),
                json!({"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig-adaptive"}}),
                json!({"type":"content_block_stop","index":0}),
                json!({"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_fixture","name":"echo","input":{}}}),
                json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"value\":\"fixture\"}"}}),
                json!({"type":"content_block_stop","index":1}),
            ],
        );
        let answer_round = message(
            "end_turn",
            vec![
                json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
                json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Complete"}}),
                json!({"type":"content_block_stop","index":0}),
            ],
        );

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(serve_rounds(listener, vec![tool_round, answer_round]));
        let calls = Arc::new(AtomicUsize::new(0));
        let params =
            super::super::request_params::anthropic_thinking_params("claude-opus-5-5", true)
                .unwrap();
        let model = create_anthropic_client(Some("fixture-key".into()), "anthropic", Some(url))
            .unwrap()
            .completion("claude-opus-5-5");
        let agent = AgentBuilder::new(model)
            .max_tokens(1024)
            .additional_params(params)
            .dynamic_tools(vec![echo_tool(calls.clone())])
            .build();
        let text = run_echo_agent(agent, "anthropic").await;
        let requests = server.await.unwrap();

        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(text, "Complete");
        for (head, body) in &requests {
            // rig 0.44 adds Anthropic's preserved-thinking binding, with its
            // beta header, to adaptive thinking on Claude 5 models: a thinking
            // block from an edited history is dropped instead of failing the
            // request.
            assert_eq!(
                body["thinking"],
                json!({"type":"adaptive","display":"summarized",
                    "block_binding":{"prefix_mismatch_behavior":"drop_block"}})
            );
            assert!(
                head.contains("thinking-binding-controls-2026-08-01"),
                "{head}"
            );
            assert!(body.get("temperature").is_none());
            assert!(body.get("output_config").is_none());
        }
        let messages = requests[1].1["messages"].as_array().unwrap();
        let assistant = messages
            .iter()
            .find(|m| m["role"] == "assistant")
            .expect("assistant turn is replayed");
        let content = assistant["content"].as_array().unwrap();
        assert_eq!(content[0]["type"], json!("thinking"));
        assert_eq!(content[0]["signature"], json!("sig-adaptive"));
        assert_eq!(content[0]["thinking"], json!(""));
        assert_eq!(content[1]["type"], json!("tool_use"));
        assert!(messages.last().unwrap()["content"]
            .to_string()
            .contains("toolu_fixture"));
    }
    /// One real chat through `ChatService` with tools, on the provider's own
    /// endpoint. The key is read from `WF_LIVE_API_KEY` and never printed.
    #[tokio::test]
    #[ignore = "calls a real provider: set WF_LIVE_PROVIDER, WF_LIVE_MODEL and WF_LIVE_API_KEY"]
    async fn live_chat_calls_a_tool_through_the_service() {
        use crate::chat::{ChatConfig, ChatService};
        use crate::env::test_env::MockEnvironment;
        use crate::types::{AiStreamEvent, ChatModelConfig, SendMessageRequest};

        let provider = std::env::var("WF_LIVE_PROVIDER").expect("set WF_LIVE_PROVIDER");
        let model = std::env::var("WF_LIVE_MODEL").expect("set WF_LIVE_MODEL");
        let key = std::env::var("WF_LIVE_API_KEY").expect("set WF_LIVE_API_KEY");
        let thinking = std::env::var("WF_LIVE_THINKING").map_or(true, |v| v != "false");
        let env = MockEnvironment::new().with_secret(&format!("ai_{provider}"), &key);
        let service = ChatService::new(Arc::new(env), ChatConfig::default());
        let mut stream = service
            .send_message(SendMessageRequest {
                content: "Show me my holdings.".into(),
                config: Some(ChatModelConfig {
                    provider: Some(provider.clone()),
                    model: Some(model.clone()),
                    thinking: Some(thinking),
                }),
                ..Default::default()
            })
            .await
            .expect("send_message");

        let (mut tools, mut results, mut reasoning, mut text) = (Vec::new(), 0, 0, 0);
        tokio::time::timeout(Duration::from_secs(300), async {
            while let Some(event) = stream.next().await {
                match event {
                    AiStreamEvent::ToolCall { tool_call, .. } => tools.push(tool_call.name),
                    AiStreamEvent::ToolResult { result, .. } if result.success => results += 1,
                    AiStreamEvent::ReasoningDelta { delta, .. } => reasoning += delta.len(),
                    AiStreamEvent::TextDelta { delta, .. } => text += delta.len(),
                    AiStreamEvent::Error { code, message, .. } => {
                        panic!("{provider}/{model} thinking={thinking}: {code}: {message}")
                    }
                    _ => {}
                }
            }
        })
        .await
        .expect("live chat must finish within 300 seconds");
        println!(
            "{provider}/{model} thinking={thinking}: tools={tools:?} results={results} reasoning_chars={reasoning} text_chars={text}"
        );
        assert!(tools.iter().any(|name| name == "get_holdings"), "{tools:?}");
        assert!(results > 0, "a tool result reached the model");
        assert!(text > 0, "the model answered after the tool result");
    }

    #[tokio::test]
    #[ignore = "requires a running Ollama and WF_TEST_OLLAMA_MODEL"]
    async fn live_ollama_streams_and_executes_tool() {
        let model = std::env::var("WF_TEST_OLLAMA_MODEL").expect("set WF_TEST_OLLAMA_MODEL");
        for thinking in [false, true] {
            let calls = Arc::new(AtomicUsize::new(0));
            let client = create_ollama_client(Some("http://127.0.0.1:11434".into())).unwrap();
            let agent = AgentBuilder::new(client.native_completion(&model))
                .preamble("You are testing a tool integration. When asked to echo a value, you MUST call the echo tool exactly once before answering. After receiving its result, reply with that value and do not call the tool again.")
                .temperature(0.0)
                .additional_params(serde_json::json!({"think":thinking,"options":{"num_ctx":8192,"num_predict":1024}}))
                .dynamic_tools(vec![echo_tool(calls.clone())])
                .build();
            let mut stream = agent
                .prompt("Call echo with value regression-pass, then report its returned value.")
                .add_hook(crate::stream_hook::WealthfolioStreamHook::for_provider(
                    "ollama",
                ))
                .max_turns(3)
                .stream();
            let mut text = String::new();
            let mut tool_result = false;
            tokio::time::timeout(Duration::from_secs(180), async {
                while let Some(item) = stream.next().await {
                    match item.expect("live Ollama request must succeed") {
                        MultiTurnStreamItem::StreamAssistantItem(Item::Event(
                            StreamEvent::Text { text: t, .. },
                        )) => text.push_str(&t),
                        MultiTurnStreamItem::ToolResult { .. } => tool_result = true,
                        _ => {}
                    }
                }
            })
            .await
            .expect("live Ollama must finish within 180 seconds");
            assert_eq!(calls.load(Ordering::SeqCst), 1, "thinking={thinking}");
            assert!(tool_result, "thinking={thinking}");
            assert!(
                text.contains("regression-pass"),
                "final answer must use the tool result; thinking={thinking}"
            );
            println!("Ollama thinking={thinking}: streamed answer and one tool round trip passed");
        }
    }
}
