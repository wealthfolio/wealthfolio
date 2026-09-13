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
use crate::provider_urls::ensure_openai_v1_base_url;

pub(crate) fn create_anthropic_client(
    api_key: Option<String>,
    provider_id: &str,
    provider_url: Option<String>,
) -> Result<anthropic::Client<HttpClient>, AiError> {
    let key = api_key.ok_or_else(|| AiError::MissingApiKey(provider_id.to_string()))?;
    let mut builder = anthropic::Client::builder()
        .api_key(&key)
        .http_client(wealthfolio_http::client());
    if let Some(url) = provider_url {
        builder = builder.base_url(&url);
    }
    builder
        .build()
        .map_err(|e| AiError::Provider(e.to_string()))
}

pub(crate) fn create_gemini_client(
    api_key: Option<String>,
    provider_id: &str,
    provider_url: Option<String>,
) -> Result<gemini::Client<HttpClient>, AiError> {
    let key = api_key.ok_or_else(|| AiError::MissingApiKey(provider_id.to_string()))?;
    let mut builder = gemini::Client::builder()
        .api_key(&key)
        .http_client(wealthfolio_http::client());
    if let Some(url) = provider_url {
        builder = builder.base_url(&url);
    }
    builder
        .build()
        .map_err(|e| AiError::Provider(e.to_string()))
}

pub(crate) fn create_groq_client(
    api_key: Option<String>,
    provider_id: &str,
    provider_url: Option<String>,
) -> Result<groq::Client<HttpClient>, AiError> {
    let key = api_key.ok_or_else(|| AiError::MissingApiKey(provider_id.to_string()))?;
    let mut builder = groq::Client::builder()
        .api_key(&key)
        .http_client(wealthfolio_http::client());
    if let Some(url) = provider_url {
        let normalized = ensure_openai_v1_base_url(&url);
        builder = builder.base_url(&normalized);
    }
    builder
        .build()
        .map_err(|e| AiError::Provider(e.to_string()))
}

/// Create OpenAI client using Completions API (not Responses API).
/// Responses API has issues with reasoning items in multi-turn conversations.
/// See: <https://community.openai.com/t/error-badrequesterror-400-item-of-type-reasoning-was-provided-without-its-required-following-item/1303809>
pub(crate) fn create_openai_client(
    api_key: Option<String>,
    provider_id: &str,
    provider_url: Option<String>,
) -> Result<openai::CompletionsClient<HttpClient>, AiError> {
    let key = api_key.ok_or_else(|| AiError::MissingApiKey(provider_id.to_string()))?;
    let mut builder = openai::CompletionsClient::builder()
        .api_key(&key)
        .http_client(wealthfolio_http::client());
    if let Some(url) = provider_url {
        let normalized = ensure_openai_v1_base_url(&url);
        builder = builder.base_url(&normalized);
    }
    builder
        .build()
        .map_err(|e| AiError::Provider(e.to_string()))
}

pub(crate) fn create_openrouter_client(
    api_key: Option<String>,
    provider_id: &str,
    provider_url: Option<String>,
) -> Result<openrouter::Client<HttpClient>, AiError> {
    let key = api_key.ok_or_else(|| AiError::MissingApiKey(provider_id.to_string()))?;
    let mut builder = openrouter::Client::builder()
        .api_key(&key)
        .http_client(wealthfolio_http::client());
    if let Some(url) = provider_url {
        let normalized = ensure_openai_v1_base_url(&url);
        builder = builder.base_url(&normalized);
    }
    builder
        .build()
        .map_err(|e| AiError::Provider(e.to_string()))
}

pub(crate) fn create_ollama_client(
    provider_url: Option<String>,
) -> Result<ollama::Client<HttpClient>, AiError> {
    let mut builder = ollama::Client::builder()
        .api_key(Nothing)
        .http_client(wealthfolio_http::client());
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
        assert_eq!(openai.base_url(), "http://localhost:8080/v1");

        let groq = create_groq_client(
            Some("test-key".to_string()),
            "groq",
            Some("https://api.groq.com/openai".to_string()),
        )
        .expect("groq client");
        assert_eq!(groq.base_url(), "https://api.groq.com/openai/v1");

        let openrouter = create_openrouter_client(
            Some("test-key".to_string()),
            "openrouter",
            Some("https://openrouter.ai/api/v1/".to_string()),
        )
        .expect("openrouter client");
        assert_eq!(openrouter.base_url(), "https://openrouter.ai/api/v1");
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
mod transport_tests {
    use super::*;
    use futures::StreamExt;
    use rig::{
        agent::MultiTurnStreamItem,
        client::AgentClientExt,
        streaming::StreamedAssistantContent,
        tool::{DynamicTool, ToolOutput},
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

    async fn read_request(socket: &mut tokio::net::TcpStream) -> String {
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
            "echo",
            "Echo fixture",
            serde_json::json!({
                "type":"object", "properties":{"value":{"type":"string"}}, "required":["value"]
            }),
            move |_, args| {
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
        let agent = client
            .agent("fixture")
            .dynamic_tools(vec![echo_tool(calls.clone())])
            .build();
        let mut stream = agent
            .runner("Run echo")
            .add_hook(crate::stream_hook::WealthfolioStreamHook::new())
            .max_turns(5)
            .stream()
            .await;
        let mut text = String::new();
        let mut tool_result_seen = false;
        tokio::time::timeout(Duration::from_secs(10), async {
            while let Some(item) = stream.next().await {
                match item.unwrap() {
                    MultiTurnStreamItem::StreamAssistantItem(StreamedAssistantContent::Text(t)) => {
                        text.push_str(&t.text)
                    }
                    MultiTurnStreamItem::StreamUserItem(_) => tool_result_seen = true,
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
        let agent = client
            .agent("fixture")
            .dynamic_tools(vec![echo_tool(calls.clone())])
            .build();
        let mut stream = agent.runner("Run echo").max_turns(2).stream().await;
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if matches!(
                    stream.next().await.unwrap().unwrap(),
                    MultiTurnStreamItem::StreamAssistantItem(StreamedAssistantContent::Text(_))
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
            "prepare_asset_classification",
            "Selection fixture",
            serde_json::json!({"type":"object","properties":{}}),
            |_, _| {
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
        let agent = client
            .agent("fixture")
            .dynamic_tools(vec![select, echo_tool(calls.clone())])
            .build();
        let hook = crate::stream_hook::WealthfolioStreamHook::new();
        let mut stream = agent
            .runner("Select asset")
            .add_hook(hook.clone())
            .max_turns(3)
            .stream()
            .await;
        let mut results = Vec::new();
        tokio::time::timeout(Duration::from_secs(10), async {
            while let Some(item) = stream.next().await {
                match item {
                    Ok(MultiTurnStreamItem::StreamUserItem(
                        rig::streaming::StreamedUserContent::ToolResult { tool_result, .. },
                    )) => results.push(tool_result.name),
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
        let agent = client
            .agent("openai/gpt-oss-120b")
            .dynamic_tools(vec![echo_tool(calls.clone())])
            .build();
        let mut stream = agent
            .runner("Analyze allocation")
            .add_hook(crate::stream_hook::WealthfolioStreamHook::for_provider(
                "groq",
            ))
            .max_turns(2)
            .stream()
            .await;
        let mut saw_reasoning = false;
        let mut text = String::new();
        tokio::time::timeout(Duration::from_secs(10), async {
            while let Some(item) = stream.next().await {
                match item.unwrap() {
                    MultiTurnStreamItem::StreamAssistantItem(
                        StreamedAssistantContent::Reasoning { .. }
                        | StreamedAssistantContent::ReasoningDelta { .. },
                    ) => saw_reasoning = true,
                    MultiTurnStreamItem::StreamAssistantItem(StreamedAssistantContent::Text(t)) => {
                        text.push_str(&t.text)
                    }
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
    fn provider_fixture(provider: &str, tools: bool) -> String {
        use serde_json::json;
        let event = |v: serde_json::Value| format!("data: {v}\n\n");
        match provider {
            "ollama" => format!(
                "{}\n",
                json!({"model":"fixture","created_at":"2026-09-11T00:00:00Z","done":true,"message":if tools {
                json!({"role":"assistant","content":"","thinking":"Use echo.","tool_calls":[{"function":{"name":"echo","arguments":{"value":"fixture"}}}]})
            } else { json!({"role":"assistant","content":"Complete"}) }})
            ),
            "gemini" => event(
                json!({"candidates":[{"content":{"role":"model","parts":if tools {
                json!([{"text":"Use echo.","thought":true},{"functionCall":{"name":"echo","args":{"value":"fixture"}},"thoughtSignature":"fixture-signature"}])
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
            ($client:expr) => {
                $client
                    .unwrap()
                    .agent("fixture")
                    .max_tokens(1024)
                    .dynamic_tools(vec![echo_tool(calls.clone())])
                    .build()
            };
        }
        let agent = match provider {
            "ollama" => agent!(create_ollama_client(url)),
            "gemini" => agent!(create_gemini_client(key, provider, url)),
            "anthropic" => agent!(create_anthropic_client(key, provider, url)),
            "openrouter" => agent!(create_openrouter_client(key, provider, url)),
            _ => agent!(create_openai_client(key, provider, url)),
        };
        let mut stream = agent
            .runner("Use echo")
            .add_hook(crate::stream_hook::WealthfolioStreamHook::for_provider(
                provider,
            ))
            .max_turns(2)
            .stream()
            .await;
        let mut text = String::new();
        tokio::time::timeout(Duration::from_secs(10), async {
            while let Some(item) = stream.next().await {
                if let MultiTurnStreamItem::StreamAssistantItem(StreamedAssistantContent::Text(t)) =
                    item.unwrap()
                {
                    text.push_str(&t.text);
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
            "anthropic" | "gemini" => assert!(
                serialized.contains("fixture-signature"),
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
    #[tokio::test]
    #[ignore = "requires a running Ollama and WF_TEST_OLLAMA_MODEL"]
    async fn live_ollama_streams_and_executes_tool() {
        let model = std::env::var("WF_TEST_OLLAMA_MODEL").expect("set WF_TEST_OLLAMA_MODEL");
        for thinking in [false, true] {
            let calls = Arc::new(AtomicUsize::new(0));
            let client = create_ollama_client(Some("http://127.0.0.1:11434".into())).unwrap();
            let agent = client.agent(&model)
                .preamble("You are testing a tool integration. When asked to echo a value, you MUST call the echo tool exactly once before answering. After receiving its result, reply with that value and do not call the tool again.")
                .temperature(0.0)
                .additional_params(serde_json::json!({"think":thinking,"options":{"num_ctx":8192,"num_predict":1024}}))
                .dynamic_tools(vec![echo_tool(calls.clone())])
                .build();
            let mut stream = agent
                .runner("Call echo with value regression-pass, then report its returned value.")
                .add_hook(crate::stream_hook::WealthfolioStreamHook::for_provider(
                    "ollama",
                ))
                .max_turns(3)
                .stream()
                .await;
            let mut text = String::new();
            let mut tool_result = false;
            tokio::time::timeout(Duration::from_secs(180), async {
                while let Some(item) = stream.next().await {
                    match item.expect("live Ollama request must succeed") {
                        MultiTurnStreamItem::StreamAssistantItem(
                            StreamedAssistantContent::Text(t),
                        ) => text.push_str(&t.text),
                        MultiTurnStreamItem::StreamUserItem(_) => tool_result = true,
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
