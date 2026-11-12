//! The model built into the device, such as Apple Intelligence.
//!
//! This crate also builds for the web server and for platforms without such a
//! model, so it only states what it needs from one. The runtime that has the
//! model supplies it through [`AiEnvironment::on_device_model`]; everywhere
//! else there is none and the provider is not offered.
//!
//! [`AiEnvironment::on_device_model`]: crate::env::AiEnvironment::on_device_model

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

/// Provider id of the device's built-in model in the catalog and in settings.
pub const ON_DEVICE_PROVIDER_ID: &str = "apple-intelligence";

/// Whether the device's model can answer right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OnDeviceModelStatus {
    Available,
    /// The hardware or the system version rules it out; nothing to turn on.
    DeviceNotEligible,
    /// The user has it switched off in the system's settings.
    NotEnabled,
    /// Still downloading, or switched off by a device profile.
    ModelNotReady,
}

/// One earlier message of the conversation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OnDeviceTurn {
    pub role: OnDeviceRole,
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OnDeviceRole {
    User,
    Assistant,
}

/// A tool the model may call, with its JSON Schema.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OnDeviceTool {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

/// One reply to generate.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnDeviceRequest {
    pub instructions: String,
    pub history: Vec<OnDeviceTurn>,
    pub prompt: String,
    /// Images sent with the prompt, each a base64-encoded image file. Only
    /// for a model whose [`OnDeviceModel::supports_images`] is true.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<String>,
    pub tools: Vec<OnDeviceTool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u64>,
    /// When not empty, the reply is exactly one of these and nothing else.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub choices: Vec<String>,
}

/// What a reply in progress reports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OnDeviceEvent {
    /// More of the answer's text.
    Text(String),
    /// The model wants this tool run. The reply waits until
    /// [`OnDeviceSession::send_tool_output`] answers `id`.
    ToolCall {
        id: String,
        name: String,
        /// The arguments as a JSON object.
        arguments: String,
    },
    /// The reply is complete.
    Done,
}

/// Why a reply failed. `message` is a plain sentence the user can read.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct OnDeviceError {
    pub kind: OnDeviceErrorKind,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnDeviceErrorKind {
    /// The conversation no longer fits the model's context window.
    ContextExceeded,
    /// The model or its guardrails declined to answer.
    Refused,
    UnsupportedLanguage,
    /// The model cannot run now; see [`OnDeviceModelStatus`].
    Unavailable,
    /// The model is answering something else.
    Busy,
    Cancelled,
    Other,
}

/// One reply in progress. Dropping it stops the reply.
#[async_trait]
pub trait OnDeviceSession: Send {
    /// The next event, or `None` once the reply has ended. Dropping the
    /// returned future before it completes must lose no event.
    async fn next(&mut self) -> Option<Result<OnDeviceEvent, OnDeviceError>>;

    /// Give the model the output of the tool call `call_id` it is waiting on.
    fn send_tool_output(&self, call_id: &str, output: &str);
}

/// The device's built-in model.
pub trait OnDeviceModel: Send + Sync + std::fmt::Debug {
    fn status(&self) -> OnDeviceModelStatus;

    /// The context window in tokens, shared by the prompt and the reply.
    fn context_size(&self) -> usize;

    /// Whether the model reads images sent with a prompt. PDFs are never
    /// read.
    fn supports_images(&self) -> bool {
        false
    }

    fn start(&self, request: OnDeviceRequest) -> Box<dyn OnDeviceSession>;
}
