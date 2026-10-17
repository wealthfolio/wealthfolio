//! Whole turns through `ChatService` against a scripted local provider.

use std::{sync::Arc, time::Duration};

use futures::StreamExt;
use serde_json::{json, Value};
use tokio::{io::AsyncWriteExt, net::TcpListener, task::JoinHandle};
use wealthfolio_core::accounts::Account;

use super::provider_clients::transport_tests::read_request;
use super::{ChatConfig, ChatService};
use crate::env::test_env::{MockAccountService, MockEnvironment, MockSettingsService};
use crate::env::AiEnvironment;
use crate::provider_model::AI_PROVIDER_SETTINGS_KEY;
use crate::stream_hook::MAX_MODEL_CALLS;
use crate::types::{
    AiStreamEvent, ChatMessageRole, ChatModelConfig, SendMessageRequest, UsageStats,
};

/// Answers chat requests with `replies` in order, as `(status, body)`, until
/// none arrives for three seconds (longer than the retry delay), and returns
/// the chat request bodies. Title requests get a 500 so the title falls back.
fn serve(replies: Vec<(u16, String)>) -> (String, JoinHandle<Vec<Value>>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let listener = TcpListener::from_std(listener).unwrap();
        let mut replies = replies.into_iter();
        let mut chats = Vec::new();
        while let Ok(Ok((mut socket, _))) =
            tokio::time::timeout(Duration::from_secs(3), listener.accept()).await
        {
            // A request the client dropped before sending (the title request
            // when the chat finishes first) arrives as an empty connection.
            let mut first = [0; 1];
            if socket.peek(&mut first).await.unwrap_or(0) == 0 {
                continue;
            }
            let request = read_request(&mut socket).await;
            let (_, body) = request.split_once("\r\n\r\n").unwrap();
            let reply = if body.trim().is_empty() {
                // Ollama's model-list preflight; it is best effort.
                Some((404, String::new()))
            } else if body.contains("Generate a very short plain-text title") {
                None
            } else {
                chats.push(serde_json::from_str(body).unwrap());
                replies.next()
            };
            let response = match reply {
                Some((200, body)) => format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                ),
                Some((status, body)) => format!(
                    "HTTP/1.1 {status} Error\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                ),
                None => "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string(),
            };
            socket.write_all(response.as_bytes()).await.unwrap();
        }
        chats
    });
    (url, server)
}

/// One Anthropic streamed message. `usage` is the `message_start` usage;
/// `output_tokens` is reported again at the end, as Anthropic does.
fn anthropic_reply(stop: &str, blocks: Vec<Value>, usage: Value, output_tokens: u64) -> String {
    let event = |v: Value| format!("data: {v}\n\n");
    let mut body = event(json!({"type":"message_start","message":{"id":"msg_fixture",
        "type":"message","role":"assistant","model":"claude-sonnet-5-5","content":[],
        "stop_reason":null,"stop_sequence":null,"usage":usage}}));
    for block in blocks {
        body += &event(block);
    }
    body += &event(json!({"type":"message_delta","delta":{"stop_reason":stop,
        "stop_sequence":null},"usage":{"output_tokens":output_tokens}}));
    body + &event(json!({"type":"message_stop"}))
}

fn text_blocks(text: &str) -> Vec<Value> {
    vec![
        json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
        json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":text}}),
        json!({"type":"content_block_stop","index":0}),
    ]
}

fn tool_use_blocks(id: &str, name: &str) -> Vec<Value> {
    parallel_tool_use_blocks(&[id], name)
}

/// One `tool_use` block per id, all calling `name`.
fn parallel_tool_use_blocks(ids: &[&str], name: &str) -> Vec<Value> {
    ids.iter()
        .enumerate()
        .flat_map(|(index, id)| {
            [
                json!({"type":"content_block_start","index":index,"content_block":{"type":"tool_use","id":id,"name":name,"input":{}}}),
                json!({"type":"content_block_delta","index":index,"delta":{"type":"input_json_delta","partial_json":"{}"}}),
                json!({"type":"content_block_stop","index":index}),
            ]
        })
        .collect()
}

/// One Ollama native reply: a `get_accounts` call, or `text`.
fn ollama_reply(text: Option<&str>) -> String {
    let message = match text {
        Some(text) => json!({"role":"assistant","content":text}),
        None => json!({"role":"assistant","content":"",
            "tool_calls":[{"function":{"name":"get_accounts","arguments":{}}}]}),
    };
    format!(
        "{}\n",
        json!({"model":"fixture","created_at":"2026-10-16T00:00:00Z","done":true,
            "done_reason":"stop","message":message})
    )
}

fn environment(provider: &str, url: &str) -> Arc<MockEnvironment> {
    let settings = json!({ "schemaVersion": 2, "providers": {
        provider: { "enabled": true, "customUrl": url }
    } });
    let mut env = MockEnvironment::new().with_secret(&format!("ai_{provider}"), "fixture-key");
    env.settings_service = Arc::new(MockSettingsService {
        settings: std::sync::RwLock::new(std::collections::HashMap::from([(
            AI_PROVIDER_SETTINGS_KEY.to_string(),
            settings.to_string(),
        )])),
    });
    env.account_service = Arc::new(MockAccountService {
        accounts: vec![Account {
            id: "acct-1".to_string(),
            name: "Brokerage".to_string(),
            currency: "USD".to_string(),
            is_active: true,
            is_archived: false,
            ..Account::default()
        }],
    });
    Arc::new(env)
}

/// Send one message and collect every event of the turn.
async fn send(
    service: &ChatService<MockEnvironment>,
    provider: &str,
    model: &str,
    content: &str,
    thread_id: Option<String>,
) -> Vec<AiStreamEvent> {
    let mut stream = service
        .send_message(SendMessageRequest {
            thread_id,
            content: content.into(),
            config: Some(ChatModelConfig {
                provider: Some(provider.into()),
                model: Some(model.into()),
                thinking: Some(false),
            }),
            ..Default::default()
        })
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        let mut events = Vec::new();
        while let Some(event) = stream.next().await {
            events.push(event);
        }
        events
    })
    .await
    .unwrap()
}

fn done_usage(events: &[AiStreamEvent]) -> Option<UsageStats> {
    events.iter().find_map(|event| match event {
        AiStreamEvent::Done { usage, .. } => Some(usage.as_deref().cloned()),
        AiStreamEvent::Error { message, .. } => panic!("chat failed: {message}"),
        _ => None,
    })?
}

fn thread_id(events: &[AiStreamEvent]) -> String {
    events
        .iter()
        .find_map(|event| match event {
            AiStreamEvent::System { thread_id, .. } => Some(thread_id.clone()),
            _ => None,
        })
        .unwrap()
}

#[tokio::test]
async fn a_turn_records_the_usage_of_every_model_call() {
    let (url, server) = serve(vec![
        (
            200,
            anthropic_reply(
                "tool_use",
                tool_use_blocks("toolu_accounts", "get_accounts"),
                json!({"input_tokens":100,"cache_read_input_tokens":900,
                    "cache_creation_input_tokens":50,"output_tokens":1}),
                20,
            ),
        ),
        (
            200,
            anthropic_reply(
                "end_turn",
                text_blocks("Done"),
                json!({"input_tokens":120,"cache_read_input_tokens":950,
                    "cache_creation_input_tokens":0,"output_tokens":1}),
                30,
            ),
        ),
    ]);
    let env = environment("anthropic", &url);
    let service = ChatService::new(env.clone(), ChatConfig::default());

    let events = send(
        &service,
        "anthropic",
        "claude-sonnet-5-5",
        "List my accounts",
        None,
    )
    .await;
    assert_eq!(server.await.unwrap().len(), 2);

    let expected = UsageStats {
        provider_id: "anthropic".into(),
        model_id: "claude-sonnet-5-5".into(),
        model_calls: 2,
        input_tokens: Some(1050 + 1070),
        cached_input_tokens: Some(900 + 950),
        cache_write_input_tokens: Some(50),
        output_tokens: Some(20 + 30),
        reasoning_tokens: None,
        total_tokens: Some(2120 + 50),
    };
    assert_eq!(done_usage(&events), Some(expected.clone()));
    let saved = env
        .chat_repository()
        .get_messages_by_thread(&thread_id(&events))
        .unwrap()
        .into_iter()
        .find(|message| message.role == ChatMessageRole::Assistant)
        .unwrap();
    assert_eq!(saved.content.usage, Some(expected));
}

/// Every `cache_control` marker in an Anthropic request body.
fn cache_markers(body: &Value) -> usize {
    let blocks = body["tools"]
        .as_array()
        .into_iter()
        .chain(body["system"].as_array())
        .flatten()
        .chain(
            body["messages"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|message| message["content"].as_array())
                .flatten(),
        );
    blocks
        .filter(|block| block.get("cache_control").is_some())
        .count()
}

#[tokio::test]
async fn the_cached_prefix_stays_the_same_from_turn_to_turn() {
    let usage = json!({"input_tokens":1,"output_tokens":1});
    let (url, server) = serve(vec![
        (
            200,
            anthropic_reply(
                "tool_use",
                tool_use_blocks("toolu_accounts", "get_accounts"),
                usage.clone(),
                1,
            ),
        ),
        (
            200,
            anthropic_reply("end_turn", text_blocks("One account."), usage.clone(), 1),
        ),
        (
            200,
            anthropic_reply("end_turn", text_blocks("USD."), usage, 1),
        ),
    ]);
    let env = environment("anthropic", &url);
    let service = ChatService::new(env, ChatConfig::default());

    let first = send(
        &service,
        "anthropic",
        "claude-sonnet-5-5",
        "List my accounts",
        None,
    )
    .await;
    done_usage(&first);
    let thread = Some(thread_id(&first));
    done_usage(
        &send(
            &service,
            "anthropic",
            "claude-sonnet-5-5",
            "Its currency?",
            thread,
        )
        .await,
    );
    let requests = server.await.unwrap();
    assert_eq!(requests.len(), 3);
    let (turn_one, turn_two) = (&requests[0], &requests[2]);

    // Turn one fetched the accounts, so turn two has more app context, and
    // a different time; neither may reach the system prompt or the tools.
    assert_eq!(turn_one["system"], turn_two["system"]);
    assert_eq!(turn_one["tools"], turn_two["tools"]);
    let system = turn_two["system"].to_string();
    assert!(!system.contains("Current datetime"), "{system}");
    assert!(!system.contains("acct-1"), "{system}");

    let last_block = turn_two["messages"].as_array().unwrap().last().unwrap()["content"]
        .as_array()
        .unwrap()
        .last()
        .unwrap()["text"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(last_block.starts_with("<app_context>"), "{last_block}");
    assert!(last_block.contains("Current datetime in user timezone"));
    assert!(last_block.contains("acct-1"), "{last_block}");

    // Tools, system prompt and the latest message.
    for request in &requests {
        assert_eq!(cache_markers(request), 3, "{request}");
    }
}

/// The scripted five-turn conversation that measures prompt caching: tool
/// turns and plain turns in one thread. Prints one row per turn and, when
/// `WF_LIVE_REPORT` names a file, appends the rows to it as JSON lines.
///
/// Set `WF_LIVE_PROVIDER` and `WF_LIVE_MODEL`; cloud providers also need
/// `WF_LIVE_API_KEY`, which is never printed.
#[tokio::test]
#[ignore = "calls a real provider: set WF_LIVE_PROVIDER, WF_LIVE_MODEL and, for cloud providers, WF_LIVE_API_KEY"]
async fn live_five_turn_cache_script() {
    const TURNS: [&str; 5] = [
        "Show me my holdings.",
        "Which of those is the largest position by value?",
        "List my accounts.",
        "Thanks. Summarize what you found in two sentences.",
        "What is my base currency?",
    ];
    let provider = std::env::var("WF_LIVE_PROVIDER").expect("set WF_LIVE_PROVIDER");
    let model = std::env::var("WF_LIVE_MODEL").expect("set WF_LIVE_MODEL");
    let label = std::env::var("WF_LIVE_LABEL").unwrap_or_default();
    let mut env = MockEnvironment::new();
    if let Ok(key) = std::env::var("WF_LIVE_API_KEY") {
        env = env.with_secret(&format!("ai_{provider}"), &key);
    }
    let service = ChatService::new(Arc::new(env), ChatConfig::default());

    let mut thread = None;
    let mut rows = Vec::new();
    for (turn, content) in TURNS.iter().enumerate() {
        let started = std::time::Instant::now();
        let mut stream = service
            .send_message(SendMessageRequest {
                thread_id: thread.clone(),
                content: (*content).into(),
                config: Some(ChatModelConfig {
                    provider: Some(provider.clone()),
                    model: Some(model.clone()),
                    thinking: None,
                }),
                ..Default::default()
            })
            .await
            .expect("send_message");
        let (mut first_output_ms, mut tools, mut usage) = (None, Vec::new(), None);
        tokio::time::timeout(Duration::from_secs(600), async {
            while let Some(event) = stream.next().await {
                match event {
                    AiStreamEvent::System { thread_id, .. } => thread = Some(thread_id),
                    AiStreamEvent::TextDelta { .. }
                    | AiStreamEvent::ReasoningDelta { .. }
                    | AiStreamEvent::ToolCall { .. }
                        if first_output_ms.is_none() =>
                    {
                        first_output_ms = Some(started.elapsed().as_millis());
                    }
                    AiStreamEvent::Done {
                        usage: done_usage,
                        message,
                        ..
                    } => {
                        usage = done_usage.map(|usage| *usage);
                        tools = message
                            .content
                            .parts
                            .iter()
                            .filter_map(|part| match part {
                                crate::types::ChatMessagePart::ToolCall { name, .. } => {
                                    Some(name.clone())
                                }
                                _ => None,
                            })
                            .collect();
                    }
                    AiStreamEvent::Error { code, message, .. } => {
                        panic!("{provider}/{model} turn {}: {code}: {message}", turn + 1)
                    }
                    _ => {}
                }
            }
        })
        .await
        .expect("each turn must finish within 600 seconds");
        let usage = usage.expect("done carries usage");
        let row = json!({
            "label": label, "provider": provider, "model": model, "turn": turn + 1,
            "tools": tools, "modelCalls": usage.model_calls,
            "inputTokens": usage.input_tokens, "cachedInputTokens": usage.cached_input_tokens,
            "cacheWriteInputTokens": usage.cache_write_input_tokens,
            "outputTokens": usage.output_tokens,
            "firstOutputMs": first_output_ms, "totalMs": started.elapsed().as_millis(),
        });
        println!("{row}");
        rows.push(row);
    }
    if let Ok(path) = std::env::var("WF_LIVE_REPORT") {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        for row in rows {
            writeln!(file, "{row}").unwrap();
        }
    }
}

fn anthropic_tool_turns(count: usize) -> Vec<(u16, String)> {
    (0..count)
        .map(|turn| {
            let id = format!("toolu_{turn}");
            let usage = json!({"input_tokens":1,"output_tokens":1});
            (
                200,
                anthropic_reply("tool_use", tool_use_blocks(&id, "get_accounts"), usage, 1),
            )
        })
        .collect()
}

fn anthropic_answer(text: &str) -> (u16, String) {
    let usage = json!({"input_tokens":1,"output_tokens":1});
    (
        200,
        anthropic_reply("end_turn", text_blocks(text), usage, 1),
    )
}

/// The assistant message saved for the turn, and its last text part.
fn saved_answer(env: &MockEnvironment, events: &[AiStreamEvent]) -> String {
    let message = env
        .chat_repository()
        .get_messages_by_thread(&thread_id(events))
        .unwrap()
        .into_iter()
        .find(|message| message.role == ChatMessageRole::Assistant)
        .expect("the turn is saved");
    message
        .content
        .parts
        .iter()
        .rev()
        .find_map(|part| match part {
            crate::types::ChatMessagePart::Text { content } => Some(content.clone()),
            _ => None,
        })
        .unwrap_or_default()
}

fn is_answering_call(request: &Value) -> bool {
    request["tool_choice"] == json!({"type":"none"})
        && request["system"].to_string().contains("Step limit reached")
}

#[tokio::test]
async fn the_last_allowed_model_call_must_answer() {
    let mut replies = anthropic_tool_turns(MAX_MODEL_CALLS - 1);
    replies.push(anthropic_answer("Here is what I found."));
    let (url, server) = serve(replies);
    let env = environment("anthropic", &url);
    let service = ChatService::new(env.clone(), ChatConfig::default());

    let events = send(
        &service,
        "anthropic",
        "claude-sonnet-5-5",
        "Check everything",
        None,
    )
    .await;
    done_usage(&events);
    let requests = server.await.unwrap();

    assert_eq!(requests.len(), MAX_MODEL_CALLS);
    let (last, earlier) = requests.split_last().unwrap();
    assert!(earlier.iter().all(|request| !is_answering_call(request)));
    assert!(is_answering_call(last), "{last}");
    // Anthropic keeps the tools, which the history's tool calls need.
    assert!(!last["tools"].as_array().unwrap().is_empty());
    assert_eq!(saved_answer(&env, &events), "Here is what I found.");
}

#[tokio::test]
async fn a_model_that_keeps_calling_tools_ends_with_the_fallback_answer() {
    let (url, server) = serve(anthropic_tool_turns(MAX_MODEL_CALLS));
    let env = environment("anthropic", &url);
    let service = ChatService::new(env.clone(), ChatConfig::default());

    let events = send(
        &service,
        "anthropic",
        "claude-sonnet-5-5",
        "Check everything",
        None,
    )
    .await;
    done_usage(&events);
    assert_eq!(server.await.unwrap().len(), MAX_MODEL_CALLS);

    let answer = saved_answer(&env, &events);
    assert!(answer.contains("reached the limit of steps"), "{answer}");
    let streamed: String = events
        .iter()
        .filter_map(|event| match event {
            AiStreamEvent::TextDelta { delta, .. } => Some(delta.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(streamed, answer);
}

#[tokio::test]
async fn an_announced_tool_call_at_the_limit_still_gets_the_fallback_answer() {
    let mut replies = anthropic_tool_turns(MAX_MODEL_CALLS - 1);
    let mut blocks = text_blocks("Let me check one more thing.");
    blocks.extend([
        json!({"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_last","name":"get_accounts","input":{}}}),
        json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{}"}}),
        json!({"type":"content_block_stop","index":1}),
    ]);
    let usage = json!({"input_tokens":1,"output_tokens":1});
    replies.push((200, anthropic_reply("tool_use", blocks, usage, 1)));
    let (url, server) = serve(replies);
    let env = environment("anthropic", &url);
    let service = ChatService::new(env.clone(), ChatConfig::default());

    let events = send(
        &service,
        "anthropic",
        "claude-sonnet-5-5",
        "Check everything",
        None,
    )
    .await;
    done_usage(&events);
    assert_eq!(server.await.unwrap().len(), MAX_MODEL_CALLS);

    let answer = saved_answer(&env, &events);
    assert!(
        answer.starts_with("Let me check one more thing.\n\n"),
        "{answer}"
    );
    assert!(answer.contains("reached the limit of steps"), "{answer}");
}

#[tokio::test]
async fn the_call_that_reaches_the_tool_call_cap_runs_and_the_next_model_call_answers() {
    let ids: Vec<String> = (0..20).map(|n| format!("toolu_{n}")).collect();
    let ids: Vec<&str> = ids.iter().map(String::as_str).collect();
    let usage = json!({"input_tokens":1,"output_tokens":1});
    let (url, server) = serve(vec![
        (
            200,
            anthropic_reply(
                "tool_use",
                parallel_tool_use_blocks(&ids, "get_accounts"),
                usage,
                1,
            ),
        ),
        anthropic_answer("One account."),
    ]);
    let env = environment("anthropic", &url);
    let service = ChatService::new(env.clone(), ChatConfig::default());

    let events = send(
        &service,
        "anthropic",
        "claude-sonnet-5-5",
        "Check everything",
        None,
    )
    .await;
    done_usage(&events);
    let requests = server.await.unwrap();

    assert_eq!(requests.len(), 2);
    assert!(is_answering_call(&requests[1]), "{}", requests[1]);
    assert_eq!(saved_answer(&env, &events), "One account.");
}

#[tokio::test]
async fn the_tool_call_cap_makes_the_next_model_call_answer() {
    let ids: Vec<String> = (0..21).map(|n| format!("toolu_{n}")).collect();
    let ids: Vec<&str> = ids.iter().map(String::as_str).collect();
    let usage = json!({"input_tokens":1,"output_tokens":1});
    let (url, server) = serve(vec![
        (
            200,
            anthropic_reply(
                "tool_use",
                parallel_tool_use_blocks(&ids, "get_accounts"),
                usage,
                1,
            ),
        ),
        anthropic_answer("One account."),
    ]);
    let env = environment("anthropic", &url);
    let service = ChatService::new(env.clone(), ChatConfig::default());

    let events = send(
        &service,
        "anthropic",
        "claude-sonnet-5-5",
        "Check everything",
        None,
    )
    .await;
    done_usage(&events);
    let requests = server.await.unwrap();

    assert_eq!(requests.len(), 2);
    assert!(!is_answering_call(&requests[0]));
    assert!(is_answering_call(&requests[1]), "{}", requests[1]);
    assert_eq!(saved_answer(&env, &events), "One account.");
}

#[tokio::test]
async fn ollama_answers_at_the_limit_without_tools() {
    let mut replies: Vec<(u16, String)> = (1..MAX_MODEL_CALLS)
        .map(|_| (200, ollama_reply(None)))
        .collect();
    replies.push((200, ollama_reply(Some("Here is what I found."))));
    let (url, server) = serve(replies);
    let env = environment("ollama", &url);
    let service = ChatService::new(env.clone(), ChatConfig::default());

    // A catalog model, so the agent has tools.
    let events = send(&service, "ollama", "gemma4:e4b", "Check everything", None).await;
    done_usage(&events);
    let requests = server.await.unwrap();

    assert_eq!(requests.len(), MAX_MODEL_CALLS);
    let tools = |request: &Value| request["tools"].as_array().map_or(0, Vec::len);
    assert!(tools(&requests[0]) > 0);
    // Ollama ignores tool_choice, so the answering call carries no tools.
    assert_eq!(tools(&requests[MAX_MODEL_CALLS - 1]), 0);
    assert!(requests[MAX_MODEL_CALLS - 1]
        .to_string()
        .contains("Step limit reached"));
    assert_eq!(saved_answer(&env, &events), "Here is what I found.");
}

fn anthropic_error(status: u16) -> (u16, String) {
    let body = json!({"type":"error","error":{"type":"api_error","message":"Try again"}});
    (status, body.to_string())
}

fn stream_error(events: &[AiStreamEvent]) -> Option<String> {
    events.iter().find_map(|event| match event {
        AiStreamEvent::Error { message, .. } => Some(message.clone()),
        _ => None,
    })
}

#[tokio::test]
async fn a_transient_error_before_any_output_is_retried_once() {
    let (url, server) = serve(vec![anthropic_error(503), anthropic_answer("Retried.")]);
    let env = environment("anthropic", &url);
    let service = ChatService::new(env.clone(), ChatConfig::default());

    let events = send(&service, "anthropic", "claude-sonnet-5-5", "Hello", None).await;
    done_usage(&events);

    let requests = server.await.unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0], requests[1], "the retry sends the same request");
    assert_eq!(saved_answer(&env, &events), "Retried.");
}

#[tokio::test]
async fn a_transient_error_after_output_is_not_retried() {
    let mut replies = anthropic_tool_turns(1);
    replies.push(anthropic_error(503));
    replies.push(anthropic_answer("Too late."));
    let (url, server) = serve(replies);
    let env = environment("anthropic", &url);
    let service = ChatService::new(env, ChatConfig::default());

    let events = send(&service, "anthropic", "claude-sonnet-5-5", "Hello", None).await;

    assert!(stream_error(&events).is_some(), "the turn fails");
    assert_eq!(
        server.await.unwrap().len(),
        2,
        "no retry after the tool ran"
    );
}

#[tokio::test]
async fn a_rejected_request_is_not_retried() {
    let (url, server) = serve(vec![anthropic_error(400), anthropic_answer("Never.")]);
    let env = environment("anthropic", &url);
    let service = ChatService::new(env, ChatConfig::default());

    let events = send(&service, "anthropic", "claude-sonnet-5-5", "Hello", None).await;

    assert!(stream_error(&events).is_some(), "the turn fails");
    assert_eq!(server.await.unwrap().len(), 1);
}
