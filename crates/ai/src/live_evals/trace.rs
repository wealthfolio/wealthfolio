//! Capture the tool-call trace from a chat turn.
//!
//! The runner subscribes to the `AiStreamEvent` stream emitted by
//! `ChatService::send_message` and records every `ToolCall` event. The
//! resulting `ToolTrace` is what we assert against expected/forbidden/max.

use crate::types::AiStreamEvent;
use serde_json::Value;

/// One observed tool invocation from the agent.
#[derive(Debug, Clone)]
pub struct CapturedToolCall {
    pub name: String,
    pub args: Value,
}

/// All tool calls fired during one chat turn, in order, plus the final text.
#[derive(Debug, Clone, Default)]
pub struct ToolTrace {
    pub tool_calls: Vec<CapturedToolCall>,
    pub final_text: String,
    /// True if the stream emitted an error event.
    pub had_error: bool,
    pub error_message: Option<String>,
}

impl ToolTrace {
    pub fn names(&self) -> Vec<&str> {
        self.tool_calls.iter().map(|c| c.name.as_str()).collect()
    }

    pub fn count(&self, name: &str) -> usize {
        self.tool_calls.iter().filter(|c| c.name == name).count()
    }

    pub fn first_with_name(&self, name: &str) -> Option<&CapturedToolCall> {
        self.tool_calls.iter().find(|c| c.name == name)
    }

    /// Append a stream event to the trace.
    pub fn ingest(&mut self, event: &AiStreamEvent) {
        match event {
            AiStreamEvent::ToolCall { tool_call, .. } => {
                self.tool_calls.push(CapturedToolCall {
                    name: tool_call.name.clone(),
                    args: tool_call.arguments.clone(),
                });
            }
            AiStreamEvent::TextDelta { delta, .. } => {
                self.final_text.push_str(delta);
            }
            AiStreamEvent::Error { message, .. } => {
                self.had_error = true;
                self.error_message = Some(message.clone());
            }
            _ => {}
        }
    }
}
