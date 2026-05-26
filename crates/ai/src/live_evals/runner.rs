//! Eval runner — drives chat turns through `ChatService` and asserts traces.
//!
//! - Builds a `ChatService` against `MockEnvironment` (so eval cases run in
//!   process with no DB / network beyond the LLM call).
//! - Configures the active provider/model via env vars
//!   (`WF_EVAL_PROVIDER`, `WF_EVAL_MODEL`) — defaults to Ollama + the model
//!   passed in `RunnerConfig::default_model`.
//! - For each case: sends the prompt, captures the resulting tool-call trace
//!   from `AiStreamEvent`s, runs assertions, returns a `CaseResult`.
//!
//! NB: the mock environment's spending services panic on access (they're
//! `unimplemented!`). Cases that trigger spending tools will fail until we
//! extend the mock with real spending stubs. That work is out of scope here;
//! today's evals focus on agent behavior that doesn't reach spending state.

use std::sync::Arc;

use futures::StreamExt;
use serde_json::Value;

use crate::chat::{ChatConfig, ChatService};
use crate::env::test_env::MockEnvironment;
use crate::error::AiError;
use crate::live_evals::schema::{ArgAssertion, ArgPredicate, Case, ResponseRubric, Severity};
use crate::live_evals::trace::ToolTrace;
use crate::types::{ChatModelConfig, SendMessageRequest};

const DEFAULT_PROVIDER: &str = "ollama";
const DEFAULT_OLLAMA_URL: &str = "http://localhost:11434";
/// Real-LLM evals are flaky (network, cold-start, transient provider errors).
/// Retry the full chat turn this many times before declaring the case failed.
const MAX_ATTEMPTS: u32 = 3;
/// Backoff between retries — keeps us from hammering a struggling provider.
const RETRY_BACKOFF_MS: u64 = 750;

#[derive(Debug, Clone)]
pub struct RunnerConfig {
    pub provider: String,
    pub model: String,
    pub provider_url: Option<String>,
}

impl RunnerConfig {
    /// Build a config from `WF_EVAL_PROVIDER` / `WF_EVAL_MODEL` /
    /// `WF_EVAL_PROVIDER_URL` env vars, falling back to Ollama + `default_model`.
    pub fn from_env(default_model: &str) -> Self {
        let provider =
            std::env::var("WF_EVAL_PROVIDER").unwrap_or_else(|_| DEFAULT_PROVIDER.to_string());
        let model = std::env::var("WF_EVAL_MODEL").unwrap_or_else(|_| default_model.to_string());
        let provider_url = std::env::var("WF_EVAL_PROVIDER_URL").ok().or_else(|| {
            if provider == "ollama" {
                Some(DEFAULT_OLLAMA_URL.to_string())
            } else {
                None
            }
        });
        Self {
            provider,
            model,
            provider_url,
        }
    }
}

/// Result of running one eval case.
#[derive(Debug, Clone)]
pub struct CaseResult {
    pub id: String,
    pub severity: Severity,
    pub passed: bool,
    pub failures: Vec<AssertionFailure>,
    pub trace: ToolTrace,
}

#[derive(Debug, Clone)]
pub struct AssertionFailure {
    pub kind: AssertionKind,
    pub message: String,
}

#[derive(Debug, Clone, Copy)]
pub enum AssertionKind {
    /// Required tool didn't fire.
    ExpectedToolMissing,
    /// Required tool fired but args didn't match.
    ExpectedToolArgs,
    /// Forbidden tool fired.
    ForbiddenTool,
    /// Tool fired more than the configured cap.
    TooManyCalls,
    /// LLM-judge graded the response as failing.
    ResponseRubric,
    /// Stream returned an error event.
    StreamError,
}

/// Run a single case against the configured provider, retrying transient
/// failures up to `MAX_ATTEMPTS` times. Only retries on stream/transport
/// errors — assertion failures (wrong tool called, missing arg) are
/// deterministic and NOT retried.
pub async fn run_case(case: &Case, cfg: &RunnerConfig) -> CaseResult {
    let mut last: Option<CaseResult> = None;

    for attempt in 1..=MAX_ATTEMPTS {
        let result = run_case_once(case, cfg).await;

        if result.passed || !is_transient_failure(&result) {
            return result;
        }

        log::warn!(
            "case `{}` attempt {}/{} failed transiently — retrying after {}ms: {}",
            case.id,
            attempt,
            MAX_ATTEMPTS,
            RETRY_BACKOFF_MS,
            result
                .failures
                .first()
                .map(|f| f.message.as_str())
                .unwrap_or("unknown"),
        );
        last = Some(result);
        if attempt < MAX_ATTEMPTS {
            tokio::time::sleep(std::time::Duration::from_millis(RETRY_BACKOFF_MS)).await;
        }
    }

    last.expect("loop ran at least once")
}

/// Returns true if the case failed *only* with stream/transport errors —
/// the kind worth retrying. Mixed failures (some assertion, some transport)
/// are treated as deterministic; if the trace is wrong, it'll be wrong on
/// retry too.
fn is_transient_failure(result: &CaseResult) -> bool {
    !result.failures.is_empty()
        && result
            .failures
            .iter()
            .all(|f| matches!(f.kind, AssertionKind::StreamError))
}

async fn run_case_once(case: &Case, cfg: &RunnerConfig) -> CaseResult {
    let env = Arc::new(MockEnvironment::new());
    let service = ChatService::new(env, ChatConfig::default());

    let thread = match service.create_thread().await {
        Ok(t) => t,
        Err(e) => {
            return fail_case(
                case,
                vec![AssertionFailure {
                    kind: AssertionKind::StreamError,
                    message: format!("create_thread failed: {e}"),
                }],
                ToolTrace::default(),
            );
        }
    };

    let request = SendMessageRequest {
        thread_id: Some(thread.id.clone()),
        content: case.prompt.clone(),
        attachments: None,
        config: Some(ChatModelConfig {
            provider: Some(cfg.provider.clone()),
            model: Some(cfg.model.clone()),
            thinking: None,
        }),
        provider_id: None,
        model_id: None,
        allowed_tools: None,
        parent_message_id: None,
    };

    let stream_result = service.send_message(request).await;
    let stream = match stream_result {
        Ok(s) => s,
        Err(e) => {
            return fail_case(
                case,
                vec![AssertionFailure {
                    kind: AssertionKind::StreamError,
                    message: format!("send_message failed: {e}"),
                }],
                ToolTrace::default(),
            );
        }
    };

    let trace = collect_trace(stream).await;
    let failures = assert_trace(case, &trace);
    let passed = failures.is_empty();

    CaseResult {
        id: case.id.clone(),
        severity: case.severity,
        passed,
        failures,
        trace,
    }
}

fn fail_case(case: &Case, failures: Vec<AssertionFailure>, trace: ToolTrace) -> CaseResult {
    CaseResult {
        id: case.id.clone(),
        severity: case.severity,
        passed: false,
        failures,
        trace,
    }
}

async fn collect_trace<S>(mut stream: S) -> ToolTrace
where
    S: futures::Stream<Item = crate::types::AiStreamEvent> + Unpin,
{
    let mut trace = ToolTrace::default();
    while let Some(event) = stream.next().await {
        trace.ingest(&event);
        if matches!(event, crate::types::AiStreamEvent::Done { .. }) {
            break;
        }
    }
    trace
}

/// Walk the case's expectations against the captured trace and return any
/// failures. An empty Vec means the case passed.
fn assert_trace(case: &Case, trace: &ToolTrace) -> Vec<AssertionFailure> {
    let mut failures = Vec::new();

    if trace.had_error {
        failures.push(AssertionFailure {
            kind: AssertionKind::StreamError,
            message: trace
                .error_message
                .clone()
                .unwrap_or_else(|| "stream errored".to_string()),
        });
    }

    // Trivial-pass guard: a case with only `forbidden_tools` (no `expected_tools`,
    // no response rubric) would silently pass when the agent does nothing
    // (no tool calls = no forbidden tools fired). That's not a passing trace,
    // it's a model that ignored the prompt. Catch it as a case-design bug.
    let has_positive_assertion = !case.expected_tools.is_empty()
        || case.expected_response.is_some()
        || !case.max_tool_calls.is_empty();
    if !has_positive_assertion && !case.forbidden_tools.is_empty() && trace.tool_calls.is_empty() {
        failures.push(AssertionFailure {
            kind: AssertionKind::ExpectedToolMissing,
            message: format!(
                "case has only forbidden_tools and the agent did nothing — \
                 add at least one `expected_tools` entry to prevent trivial pass. \
                 Case `{}`",
                case.id
            ),
        });
    }

    // Forbidden tools — any occurrence is a failure.
    for (tool_name, reason) in &case.forbidden_tools {
        if trace.count(tool_name) > 0 {
            failures.push(AssertionFailure {
                kind: AssertionKind::ForbiddenTool,
                message: format!("forbidden tool `{tool_name}` fired: {reason}"),
            });
        }
    }

    // Max-calls per tool.
    for (tool_name, max) in &case.max_tool_calls {
        let actual = trace.count(tool_name) as u32;
        if actual > *max {
            failures.push(AssertionFailure {
                kind: AssertionKind::TooManyCalls,
                message: format!("tool `{tool_name}` called {actual} times, max is {max}"),
            });
        }
    }

    // Expected tools (in order). For each, find the next match starting from
    // our cursor; if not found, that's a missing-tool failure.
    let mut cursor = 0usize;
    for expected in &case.expected_tools {
        let pos = trace.tool_calls[cursor..]
            .iter()
            .position(|c| c.name == expected.name);
        match pos {
            Some(rel) => {
                let abs = cursor + rel;
                let actual = &trace.tool_calls[abs];
                for (arg_name, assertion) in &expected.args {
                    if let Some(failure) =
                        check_arg(&expected.name, arg_name, assertion, &actual.args)
                    {
                        failures.push(failure);
                    }
                }
                cursor = abs + 1;
            }
            None => {
                failures.push(AssertionFailure {
                    kind: AssertionKind::ExpectedToolMissing,
                    message: format!(
                        "expected tool `{}` did not fire (after position {cursor})",
                        expected.name
                    ),
                });
            }
        }
    }

    // Response rubric — TODO once we have a judge model. For now log a warn.
    if case.expected_response.is_some() {
        log::warn!(
            "Case `{}` has an expected_response rubric but LLM-judge evaluation is not implemented yet — skipping.",
            case.id
        );
    }

    failures
}

fn check_arg(
    tool_name: &str,
    arg_name: &str,
    assertion: &ArgAssertion,
    actual_args: &Value,
) -> Option<AssertionFailure> {
    let value = actual_args.get(arg_name);
    let fail = |msg: String| {
        Some(AssertionFailure {
            kind: AssertionKind::ExpectedToolArgs,
            message: format!("`{tool_name}.{arg_name}`: {msg}"),
        })
    };

    match assertion {
        ArgAssertion::Sentinel(sentinel) => match sentinel.as_str() {
            "not_empty" => match value {
                Some(Value::Array(a)) if !a.is_empty() => None,
                Some(Value::String(s)) if !s.is_empty() => None,
                Some(Value::Object(o)) if !o.is_empty() => None,
                _ => fail(format!("expected non-empty, got {:?}", value)),
            },
            "absent_or_empty" => match value {
                None | Some(Value::Null) => None,
                Some(Value::Array(a)) if a.is_empty() => None,
                Some(Value::String(s)) if s.is_empty() => None,
                Some(Value::Object(o)) if o.is_empty() => None,
                Some(v) => fail(format!("expected absent/empty, got {v}")),
            },
            "present" => match value {
                None | Some(Value::Null) => fail("expected present, got missing/null".to_string()),
                _ => None,
            },
            other => {
                // Treat as exact-string match.
                match value {
                    Some(Value::String(s)) if s == other => None,
                    _ => fail(format!("expected exact \"{other}\", got {:?}", value)),
                }
            }
        },
        ArgAssertion::Predicate(ArgPredicate::Contains(needle)) => match value {
            Some(v) => {
                let serialized = v.to_string();
                if serialized.contains(needle) {
                    None
                } else {
                    fail(format!(
                        "expected to contain \"{needle}\", got {serialized}"
                    ))
                }
            }
            None => fail(format!("expected to contain \"{needle}\", got missing")),
        },
        ArgAssertion::Predicate(ArgPredicate::Exact(expected)) => match value {
            Some(v) if v == expected => None,
            _ => fail(format!("expected {expected}, got {:?}", value)),
        },
        ArgAssertion::Predicate(ArgPredicate::Regex(pattern)) => match value {
            Some(v) => {
                let serialized = v.to_string();
                match regex::Regex::new(pattern) {
                    Ok(re) if re.is_match(&serialized) => None,
                    Ok(_) => fail(format!("expected to match /{pattern}/, got {serialized}")),
                    Err(e) => fail(format!("invalid regex /{pattern}/: {e}")),
                }
            }
            None => fail(format!("expected to match /{pattern}/, got missing")),
        },
    }
}

#[allow(dead_code)]
fn unused_marker(_: &ResponseRubric) {}

/// Convenience: was this a P0 failure?
pub fn is_blocking(result: &CaseResult) -> bool {
    !result.passed && matches!(result.severity, Severity::P0)
}

#[allow(dead_code)]
fn _drop_aierror(_: AiError) {}
