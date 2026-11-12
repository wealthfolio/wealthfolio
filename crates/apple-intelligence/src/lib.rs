//! Apple Intelligence's on-device model, reached through a small Swift bridge
//! over Apple's FoundationModels framework.
//!
//! Nothing here uses the network: the model runs on the device. The crate is
//! empty on every target but macOS.

#![cfg(target_os = "macos")]

use std::ffi::{c_char, c_void, CStr, CString};
use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use wealthfolio_ai::on_device::{
    OnDeviceError, OnDeviceErrorKind, OnDeviceEvent, OnDeviceModel, OnDeviceModelStatus,
    OnDeviceRequest, OnDeviceSession,
};

type EventCallback = extern "C" fn(context: *mut c_void, event_json: *const c_char);

extern "C" {
    fn wf_apple_intelligence_status() -> i32;
    fn wf_apple_intelligence_context_size() -> i64;
    fn wf_apple_intelligence_supports_images() -> bool;
    fn wf_apple_intelligence_start(
        request_json: *const c_char,
        context: *mut c_void,
        callback: EventCallback,
    ) -> u64;
    fn wf_apple_intelligence_tool_result(
        session: u64,
        call_id: *const c_char,
        output: *const c_char,
    );
    fn wf_apple_intelligence_cancel(session: u64);
}

/// The device's model, or `None` where the system has no such framework.
/// A model that exists but is switched off or still downloading is returned,
/// so the app can say what to do about it.
pub fn model() -> Option<Arc<dyn OnDeviceModel>> {
    status_code_to_status(status_code()).map(|_| Arc::new(AppleIntelligence) as Arc<_>)
}

#[derive(Debug)]
struct AppleIntelligence;

fn status_code() -> i32 {
    #[allow(unsafe_code, reason = "FFI call with no arguments")]
    unsafe {
        wf_apple_intelligence_status()
    }
}

/// `None` for a system older than the framework. Codes mirror `StatusCode` in
/// `Bridge.swift`.
fn status_code_to_status(code: i32) -> Option<OnDeviceModelStatus> {
    match code {
        0 => Some(OnDeviceModelStatus::Available),
        1 => Some(OnDeviceModelStatus::DeviceNotEligible),
        2 => Some(OnDeviceModelStatus::NotEnabled),
        3 => Some(OnDeviceModelStatus::ModelNotReady),
        _ => None,
    }
}

impl OnDeviceModel for AppleIntelligence {
    fn status(&self) -> OnDeviceModelStatus {
        status_code_to_status(status_code()).unwrap_or(OnDeviceModelStatus::DeviceNotEligible)
    }

    fn context_size(&self) -> usize {
        #[allow(unsafe_code, reason = "FFI call with no arguments")]
        let size = unsafe { wf_apple_intelligence_context_size() };
        usize::try_from(size).unwrap_or(0)
    }

    fn supports_images(&self) -> bool {
        #[allow(unsafe_code, reason = "FFI call with no arguments")]
        unsafe {
            wf_apple_intelligence_supports_images()
        }
    }

    fn start(&self, request: OnDeviceRequest) -> Box<dyn OnDeviceSession> {
        let (sender, events) = unbounded_channel();
        let id = match serde_json::to_string(&request)
            .ok()
            .and_then(|json| CString::new(json).ok())
        {
            Some(json) => {
                // Swift owns the sender until it reports the final event; see
                // `on_event`.
                let context = Box::into_raw(Box::new(sender)).cast::<c_void>();
                #[allow(
                    unsafe_code,
                    reason = "`json` outlives the call, which copies it; `context` is freed by `on_event`"
                )]
                unsafe {
                    wf_apple_intelligence_start(json.as_ptr(), context, on_event)
                }
            }
            None => {
                let _ = sender.send(Err(OnDeviceError {
                    kind: OnDeviceErrorKind::Other,
                    message: "The request could not be sent to Apple Intelligence.".to_string(),
                }));
                0
            }
        };
        Box::new(Session { id, events })
    }
}

type EventSender = UnboundedSender<Result<OnDeviceEvent, OnDeviceError>>;

/// Called by Swift for every event of a reply, on its own threads.
extern "C" fn on_event(context: *mut c_void, event_json: *const c_char) {
    if context.is_null() || event_json.is_null() {
        return;
    }
    #[allow(
        unsafe_code,
        reason = "Swift passes a NUL-terminated string that lives for this call"
    )]
    let json = unsafe { CStr::from_ptr(event_json) }.to_string_lossy();
    let (event, last) = parse_event(&json);

    let sender = context.cast::<EventSender>();
    #[allow(
        unsafe_code,
        reason = "`context` is the sender `start` leaked; Swift calls back once more at most after a final event"
    )]
    unsafe {
        if let Some(event) = event {
            // A dropped session has stopped listening; nothing to deliver to.
            let _ = (*sender).send(event);
        }
        if last {
            // The reply is over and Swift never uses `context` again.
            drop(Box::from_raw(sender));
        }
    }
}

/// One bridge event, and whether it is the reply's last.
fn parse_event(json: &str) -> (Option<Result<OnDeviceEvent, OnDeviceError>>, bool) {
    let value: serde_json::Value = serde_json::from_str(json).unwrap_or_default();
    let text = |key: &str| value[key].as_str().unwrap_or_default().to_string();
    match value["type"].as_str() {
        Some("text") => (Some(Ok(OnDeviceEvent::Text(text("delta")))), false),
        Some("toolCall") => (
            Some(Ok(OnDeviceEvent::ToolCall {
                id: text("id"),
                name: text("name"),
                arguments: text("arguments"),
            })),
            false,
        ),
        Some("done") => (Some(Ok(OnDeviceEvent::Done)), true),
        // Anything else ends the reply, so the sender is always freed.
        _ => {
            let kind = match value["kind"].as_str() {
                Some("contextExceeded") => OnDeviceErrorKind::ContextExceeded,
                Some("refused") => OnDeviceErrorKind::Refused,
                Some("unsupportedLanguage") => OnDeviceErrorKind::UnsupportedLanguage,
                Some("unavailable") => OnDeviceErrorKind::Unavailable,
                Some("busy") => OnDeviceErrorKind::Busy,
                Some("cancelled") => OnDeviceErrorKind::Cancelled,
                _ => OnDeviceErrorKind::Other,
            };
            let message = match value["message"].as_str() {
                Some(message) if !message.is_empty() => message.to_string(),
                _ => "Apple Intelligence could not complete the response.".to_string(),
            };
            (Some(Err(OnDeviceError { kind, message })), true)
        }
    }
}

struct Session {
    /// 0 when the reply never started.
    id: u64,
    events: UnboundedReceiver<Result<OnDeviceEvent, OnDeviceError>>,
}

#[async_trait]
impl OnDeviceSession for Session {
    async fn next(&mut self) -> Option<Result<OnDeviceEvent, OnDeviceError>> {
        self.events.recv().await
    }

    fn send_tool_output(&self, call_id: &str, output: &str) {
        // A NUL cannot cross as a C string; the model would not read past it anyway.
        let (Ok(call_id), Ok(output)) = (
            CString::new(call_id),
            CString::new(output.replace('\0', "")),
        ) else {
            return;
        };
        #[allow(
            unsafe_code,
            reason = "both strings outlive the call, which copies them"
        )]
        unsafe {
            wf_apple_intelligence_tool_result(self.id, call_id.as_ptr(), output.as_ptr());
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        // Harmless for a reply that already ended: Swift no longer knows the id.
        #[allow(unsafe_code, reason = "FFI call with a plain integer")]
        unsafe {
            wf_apple_intelligence_cancel(self.id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wealthfolio_ai::on_device::OnDeviceTool;

    #[test]
    fn events_parse_and_only_the_end_is_final() {
        assert_eq!(
            parse_event(r#"{"type":"text","delta":"Hi"}"#),
            (Some(Ok(OnDeviceEvent::Text("Hi".into()))), false)
        );
        assert_eq!(
            parse_event(r#"{"type":"toolCall","id":"c1","name":"get_holdings","arguments":"{}"}"#),
            (
                Some(Ok(OnDeviceEvent::ToolCall {
                    id: "c1".into(),
                    name: "get_holdings".into(),
                    arguments: "{}".into(),
                })),
                false
            )
        );
        assert_eq!(
            parse_event(r#"{"type":"done"}"#),
            (Some(Ok(OnDeviceEvent::Done)), true)
        );
        let (event, last) =
            parse_event(r#"{"type":"error","kind":"contextExceeded","message":"Too long."}"#);
        assert!(last);
        assert_eq!(
            event,
            Some(Err(OnDeviceError {
                kind: OnDeviceErrorKind::ContextExceeded,
                message: "Too long.".into(),
            }))
        );
    }

    #[test]
    fn unreadable_event_ends_the_reply() {
        let (event, last) = parse_event("not json");
        assert!(last, "the sender must be freed");
        assert!(matches!(
            event,
            Some(Err(OnDeviceError {
                kind: OnDeviceErrorKind::Other,
                ..
            }))
        ));
    }

    #[test]
    fn unknown_status_code_means_no_model() {
        assert_eq!(status_code_to_status(4), None);
        assert_eq!(
            status_code_to_status(2),
            Some(OnDeviceModelStatus::NotEnabled)
        );
    }

    fn request(prompt: &str, tools: Vec<OnDeviceTool>) -> OnDeviceRequest {
        OnDeviceRequest {
            instructions: "You are a portfolio assistant. Use the tools to read the user's \
                data before answering. Answer briefly."
                .into(),
            history: Vec::new(),
            prompt: prompt.into(),
            images: Vec::new(),
            tools,
            temperature: Some(0.2),
            max_output_tokens: Some(400),
            choices: Vec::new(),
        }
    }

    #[tokio::test]
    #[ignore = "needs a Mac with Apple Intelligence turned on"]
    async fn live_reply_limited_to_choices_is_one_of_them() {
        let model = model().expect("this system has the framework");
        let mut request = request("Is the sky blue on a clear day?", Vec::new());
        request.instructions = "Answer the question with one label.".into();
        request.choices = vec!["yes".into(), "no".into()];
        let mut session = model.start(request);
        let mut text = String::new();
        while let Some(event) = session.next().await {
            if let OnDeviceEvent::Text(delta) = event.expect("the reply must not fail") {
                text.push_str(&delta);
            }
        }
        assert_eq!(text, "yes");
    }

    #[tokio::test]
    #[ignore = "needs a Mac with Apple Intelligence turned on"]
    async fn live_reply_streams_text() {
        let model = model().expect("this system has the framework");
        assert_eq!(model.status(), OnDeviceModelStatus::Available);
        assert!(model.context_size() >= 4096);

        let mut session = model.start(request("Say hello in five words.", Vec::new()));
        let mut text = String::new();
        let mut done = false;
        while let Some(event) = session.next().await {
            match event.expect("the reply must not fail") {
                OnDeviceEvent::Text(delta) => text.push_str(&delta),
                OnDeviceEvent::Done => done = true,
                OnDeviceEvent::ToolCall { .. } => panic!("no tools were offered"),
            }
        }
        assert!(done);
        assert!(!text.trim().is_empty());
    }

    #[tokio::test]
    #[ignore = "needs a Mac with Apple Intelligence turned on"]
    async fn live_reply_waits_for_a_tool_and_uses_its_output() {
        let model = model().expect("this system has the framework");
        let tools = vec![OnDeviceTool {
            name: "get_holdings".into(),
            description: "List the user's holdings with their market value.".into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": { "accountId": { "type": ["string", "null"] } },
                "required": [],
            }),
        }];
        let mut session = model.start(request("What is my biggest holding?", tools));
        let mut text = String::new();
        let mut calls = 0;
        while let Some(event) = session.next().await {
            match event.expect("the reply must not fail") {
                OnDeviceEvent::Text(delta) => text.push_str(&delta),
                OnDeviceEvent::ToolCall { id, name, .. } => {
                    assert_eq!(name, "get_holdings");
                    calls += 1;
                    session.send_tool_output(
                        &id,
                        r#"{"holdings":[{"symbol":"ZZTOP","marketValue":90000},{"symbol":"AAPL","marketValue":100}]}"#,
                    );
                }
                OnDeviceEvent::Done => {}
            }
        }
        assert!(calls >= 1, "the model must ask for the holdings");
        assert!(
            text.contains("ZZTOP"),
            "answer must come from the tool: {text}"
        );
    }

    #[tokio::test]
    #[ignore = "needs a Mac with Apple Intelligence turned on"]
    async fn live_dropping_a_session_that_waits_on_a_tool_ends_it() {
        let model = model().expect("this system has the framework");
        let tools = vec![OnDeviceTool {
            name: "get_holdings".into(),
            description: "List the user's holdings with their market value.".into(),
            parameters: serde_json::json!({ "type": "object", "properties": {}, "required": [] }),
        }];
        let mut session = model.start(request("What is my biggest holding?", tools));
        loop {
            match session.next().await {
                Some(Ok(OnDeviceEvent::ToolCall { .. })) => break,
                Some(Ok(_)) => {}
                other => panic!("expected a tool call, got {other:?}"),
            }
        }
        // The reply is parked on the tool. Dropping must not hang or crash,
        // and a new reply must still be served afterwards.
        drop(session);
        let mut next = model.start(request("Say hello in five words.", Vec::new()));
        let mut done = false;
        while let Some(event) = next.next().await {
            if matches!(event, Ok(OnDeviceEvent::Done)) {
                done = true;
            }
        }
        assert!(done);
    }
}
