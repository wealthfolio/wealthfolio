//! The device's built-in model as a rig completion model, so the streaming
//! agent loop drives it like any provider.
//!
//! One difference shapes this module. A cloud model returns a tool call and
//! its turn ends; the next request carries the tool's result. The device's
//! framework instead keeps one reply open and waits inside it for each tool's
//! output. So when the model asks for a tool, the transport ends rig's turn
//! with that call and parks the open reply; rig runs the tool through the
//! usual hooks and sends its next request, whose tool results the transport
//! hands to the parked reply, which then carries on.

use std::marker::PhantomData;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::stream::BoxStream;
use futures::StreamExt;
use rig::completion::options::{Mapping, OptionFields, OptionMap};
use rig::completion::{Accepts, CompletionRequest, ReplayTarget};
use rig::driver::{Exchange, Model, Opened, Opening, Transport};
use rig::error::{EncodeError, ProviderError};
use rig::message::{
    Api, AssistantContent, DocumentSourceKind, Message, ToolChoice, ToolResult, ToolResultContent,
    UserContent,
};
use rig::operation::{Block, CallFragment, Completion, Finish};
use rig::wire::document::{Reassemble, Serves};
use rig::wire::{Decoder, Descriptor, Flow, Mode, Out, Wire, WireEvent};

use crate::env::AiEnvironment;
use crate::error::AiError;
use crate::on_device::{
    OnDeviceError, OnDeviceErrorKind, OnDeviceEvent, OnDeviceModel, OnDeviceModelStatus,
    OnDeviceRequest, OnDeviceRole, OnDeviceSession, OnDeviceTool, OnDeviceTurn,
    ON_DEVICE_PROVIDER_ID,
};

/// The catalog's id for the model that runs on the device.
pub(crate) const ON_DEVICE_MODEL_ID: &str = "on-device";

const API: Api = Api::from_static("wealthfolio.on-device");

/// How long to wait for a further tool call after one arrives. The model asks
/// for several tools at the same instant, and they go to rig as one turn so
/// each does not count as a model call of its own.
const TOOL_CALL_BATCH_WINDOW: Duration = Duration::from_millis(150);

/// Given to the model as a tool's output once the turn may no longer call
/// tools, so it answers from what it has.
const TOOLS_OFF_OUTPUT: &str = "Tool calls are not available for the rest of this turn. \
    Answer the user now from the results you already have.";

/// The only tools the device's model is offered. Each tool's schema takes room
/// in a small context window, so these are the portfolio reads most questions
/// need, the spending summary and the draft of one transaction. Imports,
/// batches, searches and the other drafting tools are left to larger models.
const ON_DEVICE_TOOLS: &[&str] = &[
    "get_accounts",
    "get_holdings",
    "get_performance",
    "get_asset_allocation",
    "get_income",
    "get_cash_balances",
    SPENDING_TOOL,
    RECORD_TOOL,
];

/// The tools the device's model may use: [`ON_DEVICE_TOOLS`], less those the
/// user's own list for the provider leaves out. The settings save that list
/// for every tool group, including ones the device never gets.
pub(crate) fn on_device_tools(user_allowlist: Option<&[String]>) -> Vec<String> {
    ON_DEVICE_TOOLS
        .iter()
        .filter(|tool| user_allowlist.is_none_or(|allowed| allowed.iter().any(|a| a == *tool)))
        .map(|tool| (*tool).to_string())
        .collect()
}

/// The device's model when it can answer now.
pub(crate) fn available_on_device_model<E: AiEnvironment>(
    env: &E,
) -> Result<Arc<dyn OnDeviceModel>, AiError> {
    env.on_device_model()
        .filter(|model| model.status() == OnDeviceModelStatus::Available)
        .ok_or_else(|| {
            AiError::Provider("The on-device model is not available on this device.".to_string())
        })
}

/// Most tool calls one message may make. The model otherwise reads account
/// after account until the outputs no longer fit its context window.
const MAX_TOOL_CALLS_PER_MESSAGE: usize = 3;

const ROUTE_PORTFOLIO: &str = "portfolio";
const ROUTE_SPENDING: &str = "spending";
const ROUTE_RECORD: &str = "record";
const ROUTE_GENERAL: &str = "general";
const ROUTE_CHAT: &str = "chat";

/// The only tool a message routed as a transaction to record is offered.
/// Offered the reads too, the model looks up accounts and holdings first,
/// then often asks which account the user meant.
const RECORD_TOOL: &str = "record_activity";

/// The heading of the on-device prompt's section on [`RECORD_TOOL`], left out
/// of a reply that does not offer the tool.
const RECORDING_SECTION: &str = "## Recording a transaction";

/// `text` without the section under `heading`, up to the next heading.
fn without_section(text: &str, heading: &str) -> String {
    let Some(start) = text.find(heading) else {
        return text.to_string();
    };
    let body = start + heading.len();
    let end = text[body..]
        .find("\n## ")
        .map_or(text.len(), |next| body + next + 1);
    format!("{}{}", &text[..start], &text[end..])
}

/// The only tool a spending question is offered, and the one tool a
/// portfolio question is not: its "income" would answer questions about
/// dividends.
const SPENDING_TOOL: &str = "get_spending_insight";

/// Which tools a message is offered, as the model routed it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Route {
    /// Every tool the request offers, when the model could not say.
    AllTools,
    /// Every tool but [`SPENDING_TOOL`].
    Portfolio,
    /// Only this tool, when the request offers it.
    Only(&'static str),
    /// None: small talk and general questions.
    NoTools,
}

/// Asks the model which kind of message it got, before the real reply. Its
/// answer is one of the five labels.
const ROUTING_INSTRUCTIONS: &str = "\
Classify the latest message sent to a portfolio app's assistant. Reply with one label.
- portfolio: answering needs the user's own investment data: their accounts, holdings, \
positions, net worth, performance, returns, allocation, diversification, dividends or cash. \
Any question about \"my\", \"I\" or \"me\" and investments is portfolio.
- spending: the user's own spending, expenses, purchases, bills, budget, or what and when \
they spend most.
- record: a request to record, add or log a transaction the user describes, such as a buy, \
sell, dividend, deposit or withdrawal.
- general: a finance or other question that needs none of the user's own data.
- chat: a greeting, thanks, small talk, or a question about the assistant itself.
A short reply such as \"yes\" or \"ok\" takes the label of what the assistant just offered.
The message may be in any language; label what it asks for.

Examples:
\"hello\" -> chat
\"thanks a lot\" -> chat
\"what can you do?\" -> chat
\"what is an index fund?\" -> general
\"how are dividends taxed?\" -> general
\"show my holdings\" -> portfolio
\"how did I do this year?\" -> portfolio
\"am I diversified?\" -> portfolio
\"should I sell my Apple shares?\" -> portfolio
\"where does my money go each month?\" -> spending
\"how much did I spend on restaurants?\" -> spending
\"am I over budget?\" -> spending
\"record a buy of 5 MSFT at 410 today\" -> record
\"I sold 10 shares of Nike yesterday\" -> record
\"¿cuánto vale mi cartera?\" -> portfolio";

/// The rig model that answers from the device's built-in model.
pub(crate) type OnDeviceCompletionModel = Model<OnDeviceWire, OnDeviceRuntime>;

pub(crate) fn create_on_device_model(model: Arc<dyn OnDeviceModel>) -> OnDeviceCompletionModel {
    Model::new(
        OnDeviceWire,
        OnDeviceRuntime {
            model,
            parked: Arc::new(Mutex::new(None)),
        },
    )
}

/// The pass-through wire: the payload is the request, and each frame is one
/// step of the device model's reply.
#[derive(Clone, Debug)]
pub(crate) struct OnDeviceWire;

/// One step of a reply.
#[derive(Debug)]
pub(crate) enum OnDeviceFrame {
    Text(String),
    ToolCall {
        id: String,
        name: String,
        arguments: String,
    },
    End,
}

impl Wire for OnDeviceWire {
    type Op = Completion;
    type Payload = CompletionRequest;
    type Frame = OnDeviceFrame;
    type Event = OnDeviceFrame;
    type Decoder<'id> = OnDeviceDecoder<'id>;
    type Reassembler = NoDocument;

    fn describe(&self) -> Descriptor<'_> {
        Descriptor::new(ON_DEVICE_PROVIDER_ID)
            .model(ON_DEVICE_MODEL_ID)
            .replay(self)
    }

    fn encode(
        &self,
        request: CompletionRequest,
        _mode: Mode,
    ) -> Result<CompletionRequest, EncodeError> {
        Ok(request)
    }

    fn decoder<'id>(&self) -> OnDeviceDecoder<'id> {
        OnDeviceDecoder(PhantomData)
    }
}

impl ReplayTarget for OnDeviceWire {
    fn api(&self) -> Api {
        API
    }

    fn provider(&self) -> &str {
        ON_DEVICE_PROVIDER_ID
    }

    fn model(&self) -> &str {
        ON_DEVICE_MODEL_ID
    }

    /// Text, tools and images. The chat sends images only when the device's
    /// model reads them.
    fn accepts(&self, _model: &str) -> Accepts {
        Accepts {
            tools: true,
            user_images: true,
            ..Accepts::TEXT
        }
    }

    /// The framework exposes none of these, and each is a tuning hint the
    /// reply is still correct without.
    fn map_options(&self, _request: &CompletionRequest, fields: OptionFields<'_>) -> OptionMap {
        const IGNORED: &str = "the on-device model has no such setting";
        let OptionFields {
            reasoning,
            cache,
            service_tier,
            verbosity,
            parallel_tool_calls,
            top_p,
            seed,
            stop,
            cache_key,
        } = fields;
        OptionMap {
            reasoning: Mapping::of(reasoning, |_| Mapping::Omit(IGNORED)),
            cache: Mapping::of(cache, |_| Mapping::Omit(IGNORED)),
            service_tier: Mapping::of(service_tier, |_| Mapping::Omit(IGNORED)),
            verbosity: Mapping::of(verbosity, |_| Mapping::Omit(IGNORED)),
            parallel_tool_calls: Mapping::of(parallel_tool_calls, |_| Mapping::Omit(IGNORED)),
            top_p: Mapping::of(top_p, |_| Mapping::Omit(IGNORED)),
            seed: Mapping::of(seed, |_| Mapping::Omit(IGNORED)),
            stop: Mapping::of_stop(stop, |_| Mapping::Omit(IGNORED)),
            cache_key: Mapping::unrouted(cache_key),
        }
    }

    fn states_finish_reason(&self) -> bool {
        false
    }

    fn catalog_priced(&self) -> bool {
        false
    }
}

/// A reply has no provider document to keep.
#[derive(Debug, Default)]
pub(crate) struct NoDocument;

impl Serves<Completion> for NoDocument {}

impl Reassemble<OnDeviceFrame> for NoDocument {
    fn absorb(&mut self, _frame: &OnDeviceFrame) {}

    fn finish(self) -> serde_json::Value {
        serde_json::Value::Null
    }
}

/// Writes each frame through the completion writer. The lifetime is the
/// brand of the reply being written.
pub(crate) struct OnDeviceDecoder<'id>(PhantomData<fn(&'id ()) -> &'id ()>);

impl<'id> Decoder<'id, Completion, OnDeviceFrame> for OnDeviceDecoder<'id> {
    type Event = OnDeviceFrame;

    fn classify(&self, frame: OnDeviceFrame) -> WireEvent<OnDeviceFrame> {
        WireEvent::Known(frame)
    }

    fn decode(
        &mut self,
        frame: OnDeviceFrame,
        mut out: Out<'id, Completion>,
    ) -> Result<Flow, ProviderError> {
        match frame {
            OnDeviceFrame::Text(text) => {
                out.run(Block::Text, &text)?;
            }
            OnDeviceFrame::ToolCall {
                id,
                name,
                arguments,
            } => {
                out.end_run()?;
                let index = out.fresh_index();
                out.fragment(
                    Some(index),
                    CallFragment {
                        id: Some(&id),
                        name: Some(&name),
                        ..CallFragment::default()
                    },
                )?;
                // A tool that takes nothing may come with no arguments at all.
                let arguments = serde_json::from_str(&arguments)
                    .unwrap_or_else(|_| serde_json::Value::Object(serde_json::Map::new()));
                out.announce(index, arguments)?;
                out.finish(index)?;
            }
            OnDeviceFrame::End => {
                out.end_run()?;
                return Ok(out.end(Finish::default()));
            }
        }
        Ok(Flow::More)
    }
}

/// The transport: the device's model itself.
#[derive(Clone)]
pub(crate) struct OnDeviceRuntime {
    model: Arc<dyn OnDeviceModel>,
    /// The reply waiting on tool outputs between two of rig's requests.
    /// Dropping it stops the model, so a turn rig abandons leaves nothing
    /// running once this runtime is gone.
    parked: Arc<Mutex<Option<ParkedReply>>>,
}

struct ParkedReply {
    session: Box<dyn OnDeviceSession>,
    /// The tool calls the model is waiting on, as (call id, tool name).
    waiting: Vec<(String, String)>,
    /// Tool calls passed on to the app so far for this message.
    calls: usize,
}

impl Transport<OnDeviceWire> for OnDeviceRuntime {
    fn send(&self, request: CompletionRequest, _exchange: Exchange) -> Opening<OnDeviceFrame> {
        let runtime = self.clone();
        Opening::new(async move { Ok(Opened::new(runtime.reply(request))) })
    }
}

impl OnDeviceRuntime {
    fn take_parked(&self) -> Option<ParkedReply> {
        match self.parked.lock() {
            Ok(mut parked) => parked.take(),
            Err(poisoned) => poisoned.into_inner().take(),
        }
    }

    fn park(&self, reply: ParkedReply) {
        match self.parked.lock() {
            Ok(mut parked) => *parked = Some(reply),
            Err(poisoned) => *poisoned.into_inner() = Some(reply),
        }
    }

    /// The frames answering `request`: the parked reply carried on when the
    /// request brings the tool outputs it waits on, otherwise a new reply.
    fn reply(
        self,
        request: CompletionRequest,
    ) -> BoxStream<'static, Result<OnDeviceFrame, ProviderError>> {
        let tools_off = matches!(request.tool_choice, Some(ToolChoice::None));
        let outputs = trailing_tool_outputs(&request);

        let state = match self.take_parked() {
            Some(mut reply)
                if !outputs.is_empty()
                    && reply
                        .waiting
                        .iter()
                        .all(|(id, _)| outputs.iter().any(|(call, _)| call == id)) =>
            {
                for (id, tool) in std::mem::take(&mut reply.waiting) {
                    if let Some((_, output)) = outputs.iter().find(|(call, _)| *call == id) {
                        reply
                            .session
                            .send_tool_output(&id, &on_device_output(&tool, output));
                    }
                }
                ReplyState::Running {
                    runtime: self,
                    reply,
                    tools_off,
                }
            }
            // A reply this request does not continue is dropped, which stops it.
            _ if !outputs.is_empty() => ReplyState::Failed(ProviderError::Provider(
                "The on-device reply was interrupted before its tools finished.".to_string(),
            )),
            _ => ReplyState::Starting {
                runtime: self,
                request: Box::new(request),
                tools_off,
            },
        };
        futures::stream::unfold(state, next_frames)
            .flat_map(futures::stream::iter)
            .boxed()
    }

    /// A new reply to `request`, or `None` when it holds no user message.
    /// Tools are offered only when the message needs the user's data.
    async fn start(&self, request: &CompletionRequest, tools_off: bool) -> Option<ParkedReply> {
        let route = if tools_off || request.tools.is_empty() {
            Route::NoTools
        } else {
            self.route(request).await
        };
        let mut request = request.clone();
        match route {
            Route::AllTools => {}
            Route::Portfolio => request.tools.retain(|tool| tool.name != SPENDING_TOOL),
            // Unless the user's tool list leaves that tool out.
            Route::Only(name) if request.tools.iter().any(|tool| tool.name == name) => {
                request.tools.retain(|tool| tool.name == name);
            }
            Route::Only(_) => {}
            Route::NoTools => request.tools.clear(),
        }
        // A prompt that describes a tool the reply lacks makes the model call
        // it anyway, or write a pretend draft as text.
        if !request.tools.iter().any(|tool| tool.name == RECORD_TOOL) {
            for message in &mut request.chat_history {
                if let Message::System { content } = message.as_ref() {
                    *message = Arc::new(Message::System {
                        content: without_section(content, RECORDING_SECTION),
                    });
                }
            }
        }
        let request = on_device_request(&request, self.model.context_size())?;
        Some(ParkedReply {
            session: self.model.start(request),
            waiting: Vec::new(),
            calls: 0,
        })
    }

    /// Which tools the latest message needs. The model says so in a short
    /// reply of its own first: offered tools on a greeting, it calls them
    /// anyway. When it cannot say, every tool is offered.
    async fn route(&self, request: &CompletionRequest) -> Route {
        let Some(prompt) = routing_prompt(request) else {
            return Route::AllTools;
        };
        let mut session = self.model.start(OnDeviceRequest {
            instructions: ROUTING_INSTRUCTIONS.to_string(),
            history: Vec::new(),
            prompt,
            images: Vec::new(),
            tools: Vec::new(),
            temperature: Some(0.0),
            max_output_tokens: None,
            choices: [
                ROUTE_PORTFOLIO,
                ROUTE_SPENDING,
                ROUTE_RECORD,
                ROUTE_GENERAL,
                ROUTE_CHAT,
            ]
            .map(str::to_string)
            .to_vec(),
        });
        let mut label = String::new();
        while let Some(event) = session.next().await {
            match event {
                Ok(OnDeviceEvent::Text(text)) => label.push_str(&text),
                Ok(OnDeviceEvent::Done) => break,
                Ok(OnDeviceEvent::ToolCall { .. }) | Err(_) => return Route::AllTools,
            }
        }
        // The label only; the message itself is never logged.
        log::debug!("On-device message routed as {}", label.trim());
        match label.trim() {
            ROUTE_PORTFOLIO => Route::Portfolio,
            ROUTE_SPENDING => Route::Only(SPENDING_TOOL),
            ROUTE_RECORD => Route::Only(RECORD_TOOL),
            ROUTE_GENERAL | ROUTE_CHAT => Route::NoTools,
            _ => Route::AllTools,
        }
    }
}

enum ReplyState {
    /// Nothing has been asked of the model yet.
    Starting {
        runtime: OnDeviceRuntime,
        request: Box<CompletionRequest>,
        tools_off: bool,
    },
    Running {
        runtime: OnDeviceRuntime,
        reply: ParkedReply,
        tools_off: bool,
    },
    Failed(ProviderError),
    Ended,
}

type Frames = Vec<Result<OnDeviceFrame, ProviderError>>;

/// The next frames of a reply and the state after them, or `None` once it
/// has ended.
async fn next_frames(state: ReplyState) -> Option<(Frames, ReplyState)> {
    let (runtime, mut reply, tools_off) = match state {
        ReplyState::Starting {
            runtime,
            request,
            tools_off,
        } => {
            return Some(match runtime.start(&request, tools_off).await {
                Some(reply) => (
                    Vec::new(),
                    ReplyState::Running {
                        runtime,
                        reply,
                        tools_off,
                    },
                ),
                None => (
                    vec![Err(ProviderError::Provider(
                        "The on-device model needs a user message to answer.".to_string(),
                    ))],
                    ReplyState::Ended,
                ),
            });
        }
        ReplyState::Running {
            runtime,
            reply,
            tools_off,
        } => (runtime, reply, tools_off),
        ReplyState::Failed(error) => return Some((vec![Err(error)], ReplyState::Ended)),
        ReplyState::Ended => return None,
    };

    loop {
        match reply.session.next().await {
            Some(Ok(OnDeviceEvent::Text(delta))) => {
                return Some((
                    vec![Ok(OnDeviceFrame::Text(delta))],
                    ReplyState::Running {
                        runtime,
                        reply,
                        tools_off,
                    },
                ));
            }
            Some(Ok(OnDeviceEvent::ToolCall { id, .. }))
                if tools_off || reply.calls >= MAX_TOOL_CALLS_PER_MESSAGE =>
            {
                reply.session.send_tool_output(&id, TOOLS_OFF_OUTPUT);
            }
            Some(Ok(OnDeviceEvent::ToolCall {
                id,
                name,
                arguments,
            })) => {
                let mut frames = Vec::new();
                let mut push = |id: String, name: String, arguments, reply: &mut ParkedReply| {
                    reply.calls += 1;
                    reply.waiting.push((id.clone(), name.clone()));
                    frames.push(Ok(OnDeviceFrame::ToolCall {
                        id,
                        name,
                        arguments,
                    }));
                };
                push(id, name, arguments, &mut reply);
                // Calls the model made at the same instant join this turn.
                // Anything else cannot arrive while the model waits on a tool.
                while let Ok(Some(Ok(OnDeviceEvent::ToolCall {
                    id,
                    name,
                    arguments,
                }))) =
                    tokio::time::timeout(TOOL_CALL_BATCH_WINDOW, reply.session.next()).await
                {
                    if reply.calls >= MAX_TOOL_CALLS_PER_MESSAGE {
                        reply.session.send_tool_output(&id, TOOLS_OFF_OUTPUT);
                    } else {
                        push(id, name, arguments, &mut reply);
                    }
                }
                frames.push(Ok(OnDeviceFrame::End));
                runtime.park(reply);
                return Some((frames, ReplyState::Ended));
            }
            Some(Ok(OnDeviceEvent::Done)) => {
                return Some((vec![Ok(OnDeviceFrame::End)], ReplyState::Ended));
            }
            Some(Err(error)) => {
                return Some((vec![Err(provider_error(error))], ReplyState::Ended));
            }
            None => {
                return Some((vec![Err(ProviderError::Truncated)], ReplyState::Ended));
            }
        }
    }
}

/// The failure as rig reports it. A full context names itself in the words
/// rig classifies as a context overflow, so the chat shows that message.
fn provider_error(error: OnDeviceError) -> ProviderError {
    // The kind and the bridge's own fixed sentence; neither holds user data.
    log::warn!(
        "On-device reply failed ({:?}): {}",
        error.kind,
        error.message
    );
    match error.kind {
        OnDeviceErrorKind::ContextExceeded => ProviderError::Provider(
            "prompt is too long for the on-device model's context window".to_string(),
        ),
        _ => ProviderError::Provider(error.message),
    }
}

/// The outputs of the tool calls the last message answers, by call id.
fn trailing_tool_outputs(request: &CompletionRequest) -> Vec<(String, String)> {
    let Some(Message::User { content }) = request.chat_history.last().map(Arc::as_ref) else {
        return Vec::new();
    };
    content
        .iter()
        .filter_map(|part| match part {
            UserContent::ToolResult(result) => {
                Some((result.call.wire().into_owned(), tool_output_text(result)))
            }
            _ => None,
        })
        .collect()
}

fn tool_output_text(result: &ToolResult) -> String {
    result
        .content
        .iter()
        .filter_map(|content| match content {
            ToolResultContent::Text(text) => Some(text.text.clone()),
            ToolResultContent::Json { value, .. } => Some(value.to_string()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Tokens of the context window kept free for the outputs of the tools one
/// message calls.
const TOOL_OUTPUT_RESERVE: usize = 3000;

/// Tokens kept free for the reply when the request sets no limit.
const DEFAULT_REPLY_TOKENS: usize = 1024;

/// Tokens counted for each image sent with the prompt. The model resizes
/// images itself: on macOS 27.2 one took 67 to 195 tokens at sizes from
/// 320x180 to 4000x3000.
const IMAGE_TOKENS: usize = 300;

/// A safe over-estimate of the tokens `text` takes. The model's own count is
/// about one token per 4.5 bytes of English and is not available on every
/// system version, so the estimate errs towards dropping history early.
fn estimated_tokens(text: &str) -> usize {
    text.len().div_ceil(3)
}

/// The newest of `turns` that fit in `room` tokens, in their original order.
fn newest_turns_that_fit(turns: Vec<OnDeviceTurn>, mut room: usize) -> Vec<OnDeviceTurn> {
    let mut kept: Vec<OnDeviceTurn> = turns
        .into_iter()
        .rev()
        .take_while(|turn| {
            let cost = estimated_tokens(&turn.text);
            let fits = cost <= room;
            room = room.saturating_sub(cost);
            fits
        })
        .collect();
    kept.reverse();
    // An answer whose question was left out would open the conversation.
    let first_question = kept
        .iter()
        .position(|turn| turn.role == OnDeviceRole::User)
        .unwrap_or(kept.len());
    kept.drain(..first_question);
    kept
}

/// `request` as the device's model takes it: the system text, the earlier
/// turns as plain text, and the last user message as the prompt. Older turns
/// are left out when the model's `context_size` cannot hold them.
fn on_device_request(request: &CompletionRequest, context_size: usize) -> Option<OnDeviceRequest> {
    let mut instructions = Vec::new();
    let mut turns = Vec::new();
    for message in &request.chat_history {
        match message.as_ref() {
            Message::System { content } => instructions.push(content.clone()),
            Message::User { content } => {
                let text = content
                    .iter()
                    .filter_map(|part| match part {
                        UserContent::Text(text) => Some(text.text.as_str()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n\n");
                turns.push(OnDeviceTurn {
                    role: OnDeviceRole::User,
                    text,
                });
            }
            Message::Assistant(assistant) => {
                let text = assistant
                    .content
                    .iter()
                    .filter_map(|part| match part {
                        AssistantContent::Text(text) => Some(text.text.as_str()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n\n");
                turns.push(OnDeviceTurn {
                    role: OnDeviceRole::Assistant,
                    text,
                });
            }
        }
    }
    turns.retain(|turn| !turn.text.trim().is_empty());

    let prompt = match turns.pop() {
        Some(turn) if turn.role == OnDeviceRole::User => turn.text,
        _ => return None,
    };
    // Only the prompt's own images: earlier turns go to the model as text.
    let images = match request.chat_history.last().map(Arc::as_ref) {
        Some(Message::User { content }) => content
            .iter()
            .filter_map(|part| match part {
                UserContent::Image(image) => match &image.data {
                    DocumentSourceKind::Base64(data) => Some(data.clone()),
                    _ => None,
                },
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    };

    let tools: Vec<OnDeviceTool> = request
        .tools
        .iter()
        .map(|tool| {
            let name = tool.name.to_string();
            let mut parameters = tool.parameters.clone();
            if let Some(fields) = on_device_fields(&name) {
                keep_only_fields(&mut parameters, fields);
            }
            OnDeviceTool {
                description: on_device_description(&name)
                    .map_or_else(|| tool.description.clone(), str::to_string),
                parameters: with_property_order(parameters),
                name,
            }
        })
        .collect();

    let instructions = instructions.join("\n\n");
    let reply_tokens = request
        .max_tokens
        .and_then(|tokens| usize::try_from(tokens).ok())
        .unwrap_or(DEFAULT_REPLY_TOKENS);
    let tool_tokens: usize = tools
        .iter()
        .map(|tool| {
            estimated_tokens(&tool.name)
                + estimated_tokens(&tool.description)
                + estimated_tokens(&tool.parameters.to_string())
        })
        .sum();
    let taken = estimated_tokens(&instructions)
        + estimated_tokens(&prompt)
        + images.len() * IMAGE_TOKENS
        + reply_tokens
        + tool_tokens
        + if tools.is_empty() {
            0
        } else {
            TOOL_OUTPUT_RESERVE
        };
    let history = newest_turns_that_fit(turns, context_size.saturating_sub(taken));

    Some(OnDeviceRequest {
        instructions,
        history,
        prompt,
        images,
        tools,
        temperature: request.temperature,
        max_output_tokens: request.max_tokens,
        choices: Vec::new(),
    })
}

/// A shorter description of `tool` for the device's model, where the tool's
/// own is written for larger models. `record_activity`'s asks for an account
/// lookup first; after one, the device's model asks which account to use even
/// when the user named it, and never drafts. The tool resolves account names
/// itself, and the draft lets the user change any field.
fn on_device_description(tool: &str) -> Option<&'static str> {
    match tool {
        "record_activity" => Some(
            "Create an editable draft of one transaction the user described, for the user to \
            review and confirm in the app. Nothing is saved until the user confirms. Fill in only \
            what the user said: activityType; symbol exactly as the user wrote it, such as \
            \"Apple\" or \"MSFT\"; quantity, the number of shares or units; unitPrice, the price \
            of one share; activityDate as YYYY-MM-DD; account only if the user named one, as they \
            wrote it; amount only for cash activities such as a deposit, withdrawal, dividend or \
            fee. Call it directly; do not look up accounts first.",
        ),
        SPENDING_TOOL => Some(
            "Read the user's spending for a period: total spent, income, budget left, the change \
            from the period before, the categories they spend most on, the days they spent most \
            and their spending by day of the week. startDate and endDate are YYYY-MM-DD. When \
            the user names no period, use the first day of the current month to today.",
        ),
        _ => None,
    }
}

/// The only arguments of `tool` the device's model is offered. It decides to
/// write or skip each optional argument, and with all of `record_activity`'s
/// fourteen it skipped the price in most drafts. The rest stay editable in the
/// draft.
fn on_device_fields(tool: &str) -> Option<&'static [&'static str]> {
    match tool {
        "record_activity" => Some(&[
            "activityType",
            "symbol",
            "activityDate",
            "quantity",
            "unitPrice",
            "amount",
            "account",
        ]),
        SPENDING_TOOL => Some(&["startDate", "endDate"]),
        _ => None,
    }
}

/// A tool's output as the device's model gets it. The app still shows the
/// whole output; the model gets the part it answers from, where the whole
/// would not fit its context window.
fn on_device_output(tool: &str, output: &str) -> String {
    match tool {
        SPENDING_TOOL => spending_summary(output).unwrap_or_else(|| output.to_string()),
        _ => output.to_string(),
    }
}

/// Categories, days and weekdays a spending summary lists, largest first.
const SPENDING_TOP_CATEGORIES: usize = 5;
const SPENDING_TOP_DAYS: usize = 3;

/// The spending insight cut to its totals, its largest categories, its
/// costliest days and its spending per weekday. The full insight lists every
/// category of every day and does not fit. Percentages are whole numbers,
/// which the model would otherwise misread from fractions. `None` when the
/// output is not an insight, such as an error, which then passes unchanged.
fn spending_summary(output: &str) -> Option<String> {
    use chrono::{Datelike, NaiveDate};
    use serde_json::{json, Map, Value};

    let value: Value = serde_json::from_str(output).ok()?;
    match value.pointer("/context/availability")?.as_str()? {
        "available" => {}
        "disabled" => {
            return Some(
                json!({"spendingAvailable": false, "reason": "Spending is turned off in the app's settings."})
                    .to_string(),
            )
        }
        _ => {
            return Some(
                json!({"spendingAvailable": false, "reason": "No accounts are included in Spending yet."})
                    .to_string(),
            )
        }
    }
    let insight = value.get("insight")?;
    let headline = insight.get("headline")?;
    let money = |value: Option<&Value>| value.and_then(Value::as_f64).map(round_cents);
    let percent = |value: Option<&Value>| {
        value
            .and_then(Value::as_f64)
            .map(|fraction| (fraction * 100.0).round())
    };
    let day = |field: &str| {
        insight
            .pointer(&format!("/period/{field}"))
            .and_then(Value::as_str)
            .map(|date| date.chars().take(10).collect::<String>())
    };

    let mut categories: Vec<&Value> = insight
        .get("groups")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|group| group.get("categories").and_then(Value::as_array))
        .flatten()
        .filter(|category| category.get("spent").and_then(Value::as_f64) > Some(0.0))
        .collect();
    categories.sort_by(|a, b| {
        let spent = |category: &Value| category.get("spent").and_then(Value::as_f64);
        spent(b)
            .partial_cmp(&spent(a))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let top_categories: Vec<Value> = categories
        .into_iter()
        .take(SPENDING_TOP_CATEGORIES)
        .map(|category| {
            json!({
                "category": category.get("name"),
                "spent": money(category.get("spent")),
                "shareOfSpendingPercent": percent(category.get("pctOfTotalSpent")),
                "changeFromPriorPercent": percent(category.get("deltaVsPriorPct")),
                "overBudget": category.get("overspent"),
            })
        })
        .collect();

    let mut days: Vec<(NaiveDate, f64)> = insight
        .get("byDay")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|bucket| {
            let date = NaiveDate::parse_from_str(bucket.get("date")?.as_str()?, "%Y-%m-%d").ok()?;
            let spent = bucket.get("spent")?.as_f64()?;
            (spent > 0.0).then_some((date, spent))
        })
        .collect();
    let mut by_weekday: Vec<(chrono::Weekday, f64)> = Vec::new();
    for (date, spent) in &days {
        match by_weekday
            .iter_mut()
            .find(|(day, _)| *day == date.weekday())
        {
            Some((_, total)) => *total += spent,
            None => by_weekday.push((date.weekday(), *spent)),
        }
    }
    by_weekday.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    days.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    let mut summary = Map::new();
    summary.insert("spendingAvailable".into(), json!(true));
    summary.insert("from".into(), json!(day("start")));
    summary.insert("to".into(), json!(day("end")));
    summary.insert("currency".into(), json!(insight.get("currency")));
    summary.insert("spent".into(), json!(money(headline.get("spent"))));
    summary.insert("income".into(), json!(money(headline.get("income"))));
    summary.insert(
        "spentInPriorPeriod".into(),
        json!(money(headline.get("priorSpent"))),
    );
    summary.insert(
        "changeFromPriorPercent".into(),
        json!(percent(headline.get("deltaVsPriorPct"))),
    );
    if money(headline.get("budget")).is_some_and(|budget| budget > 0.0) {
        summary.insert("budget".into(), json!(money(headline.get("budget"))));
        summary.insert("budgetLeft".into(), json!(money(headline.get("remaining"))));
    }
    summary.insert("topCategories".into(), json!(top_categories));
    if let Some(uncategorized) = money(insight.pointer("/uncategorized/spent")) {
        if uncategorized > 0.0 {
            summary.insert("uncategorizedSpent".into(), json!(uncategorized));
        }
    }
    summary.insert(
        "topDays".into(),
        json!(days
            .iter()
            .take(SPENDING_TOP_DAYS)
            .map(|(date, spent)| json!({
                "date": date.format("%Y-%m-%d").to_string(),
                "weekday": date.format("%A").to_string(),
                "spent": round_cents(*spent),
            }))
            .collect::<Vec<_>>()),
    );
    summary.insert(
        "spentByWeekday".into(),
        json!(by_weekday
            .iter()
            .map(|(weekday, spent)| json!({
                "weekday": weekday_name(*weekday),
                "spent": round_cents(*spent),
            }))
            .collect::<Vec<_>>()),
    );
    let months = insight.get("byMonth").and_then(Value::as_array);
    if months.is_some_and(|months| months.len() > 1) {
        summary.insert(
            "spentByMonth".into(),
            json!(months
                .into_iter()
                .flatten()
                .map(|month| json!({
                    "month": month.get("month"),
                    "spent": money(month.get("spent")),
                }))
                .collect::<Vec<_>>()),
        );
    }
    if insight
        .pointer("/calculationQuality/missingFxTransactions")
        .and_then(Value::as_u64)
        .is_some_and(|missing| missing > 0)
    {
        summary.insert(
            "note".into(),
            json!("Some transactions in other currencies could not be converted and are left out."),
        );
    }
    Some(Value::Object(summary).to_string())
}

fn round_cents(amount: f64) -> f64 {
    (amount * 100.0).round() / 100.0
}

fn weekday_name(weekday: chrono::Weekday) -> &'static str {
    match weekday {
        chrono::Weekday::Mon => "Monday",
        chrono::Weekday::Tue => "Tuesday",
        chrono::Weekday::Wed => "Wednesday",
        chrono::Weekday::Thu => "Thursday",
        chrono::Weekday::Fri => "Friday",
        chrono::Weekday::Sat => "Saturday",
        chrono::Weekday::Sun => "Sunday",
    }
}

/// Drop the top-level properties of `schema` not in `fields`, and their
/// `required` entries.
fn keep_only_fields(schema: &mut serde_json::Value, fields: &[&str]) {
    if let Some(properties) = schema
        .get_mut("properties")
        .and_then(serde_json::Value::as_object_mut)
    {
        properties.retain(|name, _| fields.contains(&name.as_str()));
    }
    if let Some(required) = schema
        .get_mut("required")
        .and_then(serde_json::Value::as_array_mut)
    {
        required.retain(|name| name.as_str().is_some_and(|name| fields.contains(&name)));
    }
}

/// `schema` with each object's property names listed in order under
/// `x-wf-order`. The model writes a tool's arguments in that order, which the
/// bridge would otherwise lose when it parses the schema.
fn with_property_order(mut schema: serde_json::Value) -> serde_json::Value {
    fn annotate(value: &mut serde_json::Value) {
        match value {
            serde_json::Value::Object(map) => {
                let order = map.get("properties").and_then(|properties| {
                    properties
                        .as_object()
                        .map(|fields| fields.keys().cloned().collect::<Vec<_>>())
                });
                for child in map.values_mut() {
                    annotate(child);
                }
                if let Some(order) = order {
                    map.insert("x-wf-order".to_string(), serde_json::json!(order));
                }
            }
            serde_json::Value::Array(items) => items.iter_mut().for_each(annotate),
            _ => {}
        }
    }
    annotate(&mut schema);
    schema
}

/// What the model is shown to decide whether the latest message needs the
/// user's data: the user's own words, and what the assistant last said, which
/// a reply such as "yes please" depends on. `None` without a user message.
fn routing_prompt(request: &CompletionRequest) -> Option<String> {
    /// Enough of a message to tell what it asks for.
    const SHOWN_CHARS: usize = 400;
    let shown = |text: &str| -> String { text.chars().take(SHOWN_CHARS).collect() };

    let mut earlier = request.chat_history.iter().rev();
    let Message::User { content } = earlier.next()?.as_ref() else {
        return None;
    };
    // The app's own context block follows the user's words in the message.
    let own_words = content.iter().find_map(|part| match part {
        UserContent::Text(text) => Some(text.text.as_str()),
        _ => None,
    })?;
    let last_reply = earlier.find_map(|message| match message.as_ref() {
        Message::Assistant(assistant) => assistant.content.iter().find_map(|part| match part {
            AssistantContent::Text(text) if !text.text.trim().is_empty() => {
                Some(text.text.as_str())
            }
            _ => None,
        }),
        _ => None,
    });

    let mut prompt = String::new();
    if let Some(reply) = last_reply {
        prompt.push_str(&format!("The assistant just said: \"{}\"\n", shown(reply)));
    }
    prompt.push_str(&format!("Latest message: \"{}\"", shown(own_words)));
    Some(prompt)
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use async_trait::async_trait;
    use rig::agent::MultiTurnStreamItem;
    use rig::message::{CallId, ToolName};
    use rig::streaming::{Item, StreamEvent};
    use rig::tool::{DynamicTool, ToolOutput};
    use rig::AgentBuilder;
    use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};

    #[derive(Clone)]
    enum Step {
        Event(OnDeviceEvent),
        Fail(OnDeviceError),
        /// The model waits here until this many tool outputs have arrived.
        AwaitOutputs(usize),
    }

    fn text(text: &str) -> Step {
        Step::Event(OnDeviceEvent::Text(text.into()))
    }

    fn call(id: &str, name: &str, arguments: &str) -> Step {
        Step::Event(OnDeviceEvent::ToolCall {
            id: id.into(),
            name: name.into(),
            arguments: arguments.into(),
        })
    }

    fn done() -> Step {
        Step::Event(OnDeviceEvent::Done)
    }

    #[derive(Default)]
    struct Log {
        /// Replies started, without the routing questions.
        requests: Vec<OnDeviceRequest>,
        /// Routing questions asked.
        routing: Vec<OnDeviceRequest>,
        outputs: Vec<(String, String)>,
        dropped: usize,
    }

    /// A scripted device model: each started reply plays the next script.
    struct FakeModel {
        scripts: Mutex<VecDeque<Vec<Step>>>,
        /// How a routing question is answered: as a portfolio question
        /// unless a test says otherwise.
        route: Mutex<Vec<Step>>,
        log: Arc<Mutex<Log>>,
    }

    impl std::fmt::Debug for FakeModel {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("FakeModel")
        }
    }

    impl FakeModel {
        fn new(scripts: Vec<Vec<Step>>) -> (Arc<Self>, Arc<Mutex<Log>>) {
            let log = Arc::new(Mutex::new(Log::default()));
            let model = Arc::new(Self {
                scripts: Mutex::new(scripts.into()),
                route: Mutex::new(vec![text(ROUTE_PORTFOLIO), done()]),
                log: log.clone(),
            });
            (model, log)
        }

        fn routes_as(&self, steps: Vec<Step>) {
            *self.route.lock().unwrap() = steps;
        }
    }

    impl OnDeviceModel for FakeModel {
        fn status(&self) -> OnDeviceModelStatus {
            OnDeviceModelStatus::Available
        }

        fn context_size(&self) -> usize {
            8192
        }

        fn start(&self, request: OnDeviceRequest) -> Box<dyn OnDeviceSession> {
            let (arrived_tx, arrived) = unbounded_channel();
            if !request.choices.is_empty() {
                self.log.lock().unwrap().routing.push(request);
                return Box::new(FakeSession {
                    steps: self.route.lock().unwrap().clone().into(),
                    arrived,
                    arrived_tx,
                    // Its own log: a routing question is not a reply.
                    log: Arc::new(Mutex::new(Log::default())),
                });
            }
            self.log.lock().unwrap().requests.push(request);
            let steps = self.scripts.lock().unwrap().pop_front().unwrap_or_default();
            Box::new(FakeSession {
                steps: steps.into(),
                arrived,
                arrived_tx,
                log: self.log.clone(),
            })
        }
    }

    struct FakeSession {
        steps: VecDeque<Step>,
        arrived: UnboundedReceiver<()>,
        arrived_tx: UnboundedSender<()>,
        log: Arc<Mutex<Log>>,
    }

    #[async_trait]
    impl OnDeviceSession for FakeSession {
        async fn next(&mut self) -> Option<Result<OnDeviceEvent, OnDeviceError>> {
            loop {
                match self.steps.front()? {
                    Step::AwaitOutputs(0) => {
                        self.steps.pop_front();
                    }
                    Step::AwaitOutputs(_) => {
                        // Nothing is taken off the script before the output
                        // arrives, so a caller may drop this future.
                        self.arrived.recv().await?;
                        if let Some(Step::AwaitOutputs(left)) = self.steps.front_mut() {
                            *left -= 1;
                        }
                    }
                    _ => {
                        return match self.steps.pop_front()? {
                            Step::Event(event) => Some(Ok(event)),
                            Step::Fail(error) => Some(Err(error)),
                            Step::AwaitOutputs(_) => unreachable!("handled above"),
                        }
                    }
                }
            }
        }

        fn send_tool_output(&self, call_id: &str, output: &str) {
            self.log
                .lock()
                .unwrap()
                .outputs
                .push((call_id.to_string(), output.to_string()));
            let _ = self.arrived_tx.send(());
        }
    }

    impl Drop for FakeSession {
        fn drop(&mut self) {
            self.log.lock().unwrap().dropped += 1;
        }
    }

    fn runtime(model: Arc<FakeModel>) -> OnDeviceRuntime {
        create_on_device_model(model).transport
    }

    /// The frames of one reply, as short labels.
    async fn frames(runtime: &OnDeviceRuntime, request: CompletionRequest) -> Vec<String> {
        runtime
            .clone()
            .reply(request)
            .map(|frame| match frame {
                Ok(OnDeviceFrame::Text(text)) => format!("text:{text}"),
                Ok(OnDeviceFrame::ToolCall { id, name, .. }) => format!("call:{id}:{name}"),
                Ok(OnDeviceFrame::End) => "end".to_string(),
                Err(error) => format!("error:{error}"),
            })
            .collect()
            .await
    }

    fn tool_results(results: &[(&str, &str)]) -> CompletionRequest {
        CompletionRequest::new(Message::User {
            content: results
                .iter()
                .map(|(id, output)| {
                    UserContent::tool_result(
                        CallId::from_wire(*id),
                        ToolName::new("echo").unwrap(),
                        vec![ToolResultContent::text(*output)],
                    )
                })
                .collect(),
        })
    }

    /// A conversation ending in `message`, which the app followed with its
    /// own context block, with one tool on offer.
    fn request_with_a_tool(message: &str) -> CompletionRequest {
        let mut request = CompletionRequest::new(message);
        request.chat_history = vec![
            Arc::new(Message::System {
                content: "Rules".into(),
            }),
            Arc::new(Message::user("hi")),
            Arc::new(Message::assistant("Hello! I can show your holdings.")),
            Arc::new(Message::User {
                content: vec![
                    UserContent::text(message),
                    UserContent::text("<app_context>Base currency: USD</app_context>"),
                ],
            }),
        ];
        request.tools = ["echo", RECORD_TOOL, SPENDING_TOOL]
            .map(|name| {
                Arc::new(rig::completion::ToolDefinition::new(
                    ToolName::new(name).unwrap(),
                    "Fixture",
                    serde_json::json!({
                        "type": "object",
                        "properties": { "symbol": {}, "quantity": {}, "account": {} }
                    }),
                ))
            })
            .to_vec();
        request
    }

    #[tokio::test]
    async fn a_transaction_to_record_is_offered_only_the_record_tool() {
        let (model, log) = FakeModel::new(vec![vec![text("Draft ready."), done()]]);
        model.routes_as(vec![text(ROUTE_RECORD), done()]);
        let runtime = runtime(model);

        frames(&runtime, request_with_a_tool("bought 3 AAPL at 340")).await;
        let log = log.lock().unwrap();
        let tools = &log.requests[0].tools;
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, RECORD_TOOL);
        // The device gets its own description and the declared field order.
        assert_eq!(
            tools[0].description,
            on_device_description(RECORD_TOOL).unwrap()
        );
        assert_eq!(
            tools[0].parameters["x-wf-order"],
            serde_json::json!(["symbol", "quantity", "account"])
        );
    }

    #[test]
    fn the_device_is_offered_only_the_listed_record_fields() {
        let mut schema = serde_json::json!({
            "type": "object",
            "properties": { "activityType": {}, "symbol": {}, "fxRate": {}, "notes": {} },
            "required": ["activityType", "fxRate"]
        });
        keep_only_fields(&mut schema, on_device_fields(RECORD_TOOL).unwrap());
        assert_eq!(
            schema,
            serde_json::json!({
                "type": "object",
                "properties": { "activityType": {}, "symbol": {} },
                "required": ["activityType"]
            })
        );
    }

    #[tokio::test]
    async fn small_talk_is_answered_without_offering_tools() {
        let (model, log) = FakeModel::new(vec![vec![text("You're welcome."), done()]]);
        model.routes_as(vec![text(ROUTE_CHAT), done()]);
        let runtime = runtime(model);

        assert_eq!(
            frames(&runtime, request_with_a_tool("thanks")).await,
            ["text:You're welcome.", "end"]
        );
        let log = log.lock().unwrap();
        assert!(log.requests[0].tools.is_empty());
        // The model routes on the user's own words and what it last said,
        // not on the context block the app appends.
        let routing = &log.routing[0];
        assert_eq!(
            routing.prompt,
            "The assistant just said: \"Hello! I can show your holdings.\"\n\
             Latest message: \"thanks\""
        );
        assert_eq!(
            routing.choices,
            [
                ROUTE_PORTFOLIO,
                ROUTE_SPENDING,
                ROUTE_RECORD,
                ROUTE_GENERAL,
                ROUTE_CHAT
            ]
        );
        assert!(routing.tools.is_empty() && routing.history.is_empty());
    }

    #[tokio::test]
    async fn a_portfolio_question_is_offered_the_tools_but_spending() {
        let (model, log) = FakeModel::new(vec![vec![text("Here."), done()]]);
        let runtime = runtime(model);

        frames(&runtime, request_with_a_tool("show my holdings")).await;
        let log = log.lock().unwrap();
        assert_eq!(log.routing.len(), 1);
        let names: Vec<&str> = log.requests[0]
            .tools
            .iter()
            .map(|tool| tool.name.as_str())
            .collect();
        assert_eq!(names, ["echo", RECORD_TOOL]);
    }

    #[tokio::test]
    async fn a_spending_question_is_offered_only_the_spending_tool() {
        let (model, log) = FakeModel::new(vec![vec![text("Here."), done()]]);
        model.routes_as(vec![text(ROUTE_SPENDING), done()]);
        let runtime = runtime(model);

        frames(&runtime, request_with_a_tool("when do I spend the most?")).await;
        let log = log.lock().unwrap();
        let tools = &log.requests[0].tools;
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, SPENDING_TOOL);
        assert_eq!(
            tools[0].description,
            on_device_description(SPENDING_TOOL).unwrap()
        );
    }

    #[test]
    fn the_device_gets_its_tools_within_the_users_list() {
        assert_eq!(on_device_tools(None).len(), ON_DEVICE_TOOLS.len());
        // The settings save whole groups, including tools the device never gets.
        let allowed =
            ["get_holdings", "search_activities", "get_spending_insight"].map(str::to_string);
        assert_eq!(
            on_device_tools(Some(&allowed)),
            ["get_holdings", "get_spending_insight"]
        );
        assert!(on_device_tools(Some(&[])).is_empty());
    }

    fn insight_output(availability: &str) -> String {
        serde_json::json!({
            "context": { "enabled": true, "availability": availability },
            "insight": {
                "currency": "USD",
                "period": { "start": "2026-11-01T00:00:00Z", "end": "2026-11-12T23:59:59Z" },
                "headline": {
                    "spent": 1234.567, "income": 3000.0, "priorSpent": 1000.0,
                    "deltaVsPriorPct": 0.2346, "budget": 0.0, "remaining": 0.0
                },
                "groups": [
                    { "categories": [
                        { "name": "Groceries", "spent": 400.0, "pctOfTotalSpent": 0.324,
                          "deltaVsPriorPct": null, "overspent": false },
                        { "name": "Unused", "spent": 0.0 }
                    ] },
                    { "categories": [
                        { "name": "Rent", "spent": 800.0, "pctOfTotalSpent": 0.648,
                          "deltaVsPriorPct": 0.0, "overspent": false }
                    ] }
                ],
                "uncategorized": { "spent": 34.567 },
                "byDay": [
                    { "date": "2026-11-01", "spent": 800.0, "income": 0.0 },
                    { "date": "2026-11-07", "spent": 30.0, "income": 0.0 },
                    { "date": "2026-11-08", "spent": 0.0, "income": 3000.0 },
                    { "date": "2026-11-09", "spent": 404.567, "income": 0.0 }
                ],
                "byDayByCategory": [ { "date": "2026-11-01", "amount": 800.0 } ],
                "byMonth": [ { "month": "2026-11", "spent": 1234.567 } ],
                "calculationQuality": { "missingFxTransactions": 0 }
            }
        })
        .to_string()
    }

    #[test]
    fn the_spending_insight_reaches_the_device_cut_to_its_summary() {
        let summary: serde_json::Value = serde_json::from_str(&on_device_output(
            SPENDING_TOOL,
            &insight_output("available"),
        ))
        .unwrap();
        assert_eq!(
            summary,
            serde_json::json!({
                "spendingAvailable": true,
                "from": "2026-11-01",
                "to": "2026-11-12",
                "currency": "USD",
                "spent": 1234.57,
                "income": 3000.0,
                "spentInPriorPeriod": 1000.0,
                "changeFromPriorPercent": 23.0,
                "topCategories": [
                    { "category": "Rent", "spent": 800.0, "shareOfSpendingPercent": 65.0,
                      "changeFromPriorPercent": 0.0, "overBudget": false },
                    { "category": "Groceries", "spent": 400.0, "shareOfSpendingPercent": 32.0,
                      "changeFromPriorPercent": null, "overBudget": false }
                ],
                "uncategorizedSpent": 34.57,
                "topDays": [
                    { "date": "2026-11-01", "weekday": "Sunday", "spent": 800.0 },
                    { "date": "2026-11-09", "weekday": "Monday", "spent": 404.57 },
                    { "date": "2026-11-07", "weekday": "Saturday", "spent": 30.0 }
                ],
                "spentByWeekday": [
                    { "weekday": "Sunday", "spent": 800.0 },
                    { "weekday": "Monday", "spent": 404.57 },
                    { "weekday": "Saturday", "spent": 30.0 }
                ]
            })
        );
    }

    #[test]
    fn spending_turned_off_reaches_the_device_as_its_reason() {
        let summary: serde_json::Value = serde_json::from_str(&on_device_output(
            SPENDING_TOOL,
            &insight_output("disabled"),
        ))
        .unwrap();
        assert_eq!(summary["spendingAvailable"], false);
        assert_eq!(
            summary["reason"],
            "Spending is turned off in the app's settings."
        );
        // Errors and other tools' outputs pass unchanged.
        assert_eq!(
            on_device_output(SPENDING_TOOL, "Unable to calculate Spending insight"),
            "Unable to calculate Spending insight"
        );
        assert_eq!(on_device_output("get_holdings", "{\"a\":1}"), "{\"a\":1}");
    }

    #[tokio::test]
    async fn the_model_gets_the_spending_summary_as_the_tools_output() {
        let (model, log) = FakeModel::new(vec![vec![
            call("c1", SPENDING_TOOL, "{}"),
            Step::AwaitOutputs(1),
            text("Rent."),
            done(),
        ]]);
        model.routes_as(vec![text(ROUTE_SPENDING), done()]);
        let runtime = runtime(model);

        frames(&runtime, request_with_a_tool("where does my money go?")).await;
        frames(
            &runtime,
            tool_results(&[("c1", &insight_output("available"))]),
        )
        .await;
        let log = log.lock().unwrap();
        let (_, output) = &log.outputs[0];
        assert!(output.contains("\"topDays\""));
        assert!(!output.contains("byDayByCategory"));
    }

    #[tokio::test]
    async fn tools_are_offered_when_the_model_cannot_route() {
        let (model, log) = FakeModel::new(vec![vec![text("Here."), done()]]);
        model.routes_as(vec![Step::Fail(OnDeviceError {
            kind: OnDeviceErrorKind::Refused,
            message: "Declined.".into(),
        })]);
        let runtime = runtime(model);

        assert_eq!(
            frames(&runtime, request_with_a_tool("What's in my TFSA?")).await,
            ["text:Here.", "end"]
        );
        assert_eq!(log.lock().unwrap().requests[0].tools.len(), 3);
    }

    #[tokio::test]
    async fn a_request_without_tools_is_not_routed() {
        let (model, log) = FakeModel::new(vec![vec![text("Title"), done()]]);
        let runtime = runtime(model);

        frames(&runtime, CompletionRequest::new("Name this chat")).await;
        assert!(log.lock().unwrap().routing.is_empty());
    }

    #[tokio::test]
    async fn calls_past_the_limit_are_answered_without_running_them() {
        let mut script = Vec::new();
        for call_number in 1..=MAX_TOOL_CALLS_PER_MESSAGE + 1 {
            script.push(call(&format!("c{call_number}"), "echo", "{}"));
            script.push(Step::AwaitOutputs(1));
        }
        script.extend([text("Answer"), done()]);
        let (model, log) = FakeModel::new(vec![script]);
        let runtime = runtime(model);

        assert_eq!(
            frames(&runtime, CompletionRequest::new("Go")).await,
            ["call:c1:echo", "end"]
        );
        for call_number in 1..MAX_TOOL_CALLS_PER_MESSAGE {
            let id = format!("c{call_number}");
            assert_eq!(
                frames(&runtime, tool_results(&[(id.as_str(), "out")])).await,
                [format!("call:c{}:echo", call_number + 1), "end".to_string()]
            );
        }
        // The last allowed call is answered; the one after it never reaches
        // the app.
        let last = format!("c{MAX_TOOL_CALLS_PER_MESSAGE}");
        assert_eq!(
            frames(&runtime, tool_results(&[(last.as_str(), "out")])).await,
            ["text:Answer", "end"]
        );
        let outputs = &log.lock().unwrap().outputs;
        assert_eq!(
            outputs.last(),
            Some(&(
                format!("c{}", MAX_TOOL_CALLS_PER_MESSAGE + 1),
                TOOLS_OFF_OUTPUT.to_string()
            ))
        );
    }

    #[tokio::test]
    async fn reply_streams_text_then_ends() {
        let (model, log) = FakeModel::new(vec![vec![text("Hel"), text("lo"), done()]]);
        let runtime = runtime(model);

        assert_eq!(
            frames(&runtime, CompletionRequest::new("Hi")).await,
            ["text:Hel", "text:lo", "end"]
        );
        assert_eq!(log.lock().unwrap().requests[0].prompt, "Hi");
    }

    #[tokio::test]
    async fn calls_made_together_are_one_turn_and_one_reply_answers() {
        let (model, log) = FakeModel::new(vec![vec![
            call("c1", "echo", "{}"),
            call("c2", "echo", "{}"),
            Step::AwaitOutputs(2),
            text("Both done"),
            done(),
        ]]);
        let runtime = runtime(model);

        assert_eq!(
            frames(&runtime, CompletionRequest::new("Go")).await,
            ["call:c1:echo", "call:c2:echo", "end"]
        );
        assert_eq!(
            frames(&runtime, tool_results(&[("c1", "one"), ("c2", "two")])).await,
            ["text:Both done", "end"]
        );

        let log = log.lock().unwrap();
        assert_eq!(log.requests.len(), 1, "the same reply must carry on");
        assert_eq!(
            log.outputs,
            [("c1".into(), "one".into()), ("c2".into(), "two".into())]
        );
    }

    #[tokio::test]
    async fn a_call_after_tools_are_withdrawn_is_answered_without_running_it() {
        let (model, log) = FakeModel::new(vec![vec![
            call("c1", "echo", "{}"),
            Step::AwaitOutputs(1),
            call("c2", "echo", "{}"),
            Step::AwaitOutputs(1),
            text("Answer"),
            done(),
        ]]);
        let runtime = runtime(model);
        frames(&runtime, CompletionRequest::new("Go")).await;

        let mut last = tool_results(&[("c1", "one")]);
        last.tool_choice = Some(ToolChoice::None);
        assert_eq!(frames(&runtime, last).await, ["text:Answer", "end"]);
        assert_eq!(
            log.lock().unwrap().outputs,
            [
                ("c1".into(), "one".into()),
                ("c2".into(), TOOLS_OFF_OUTPUT.into())
            ]
        );
    }

    #[tokio::test]
    async fn tool_results_with_no_reply_waiting_fail() {
        let (model, log) = FakeModel::new(Vec::new());
        let runtime = runtime(model);

        let frames = frames(&runtime, tool_results(&[("c1", "one")])).await;
        assert_eq!(frames.len(), 1);
        assert!(frames[0].starts_with("error:"), "{frames:?}");
        assert!(log.lock().unwrap().requests.is_empty());
    }

    #[tokio::test]
    async fn a_new_message_stops_the_reply_left_waiting() {
        let (model, log) = FakeModel::new(vec![
            vec![call("c1", "echo", "{}"), Step::AwaitOutputs(1), done()],
            vec![text("Fresh"), done()],
        ]);
        let runtime = runtime(model);
        frames(&runtime, CompletionRequest::new("First")).await;
        assert_eq!(log.lock().unwrap().dropped, 0, "the reply is parked");

        assert_eq!(
            frames(&runtime, CompletionRequest::new("Second")).await,
            ["text:Fresh", "end"]
        );
        let log = log.lock().unwrap();
        assert_eq!(log.requests.len(), 2);
        assert_eq!(log.dropped, 2, "the parked reply and the finished one");
        assert!(log.outputs.is_empty());
    }

    #[tokio::test]
    async fn dropping_the_model_stops_a_waiting_reply() {
        let (model, log) = FakeModel::new(vec![vec![
            call("c1", "echo", "{}"),
            Step::AwaitOutputs(1),
            done(),
        ]]);
        let runtime = runtime(model);
        frames(&runtime, CompletionRequest::new("Go")).await;
        assert_eq!(log.lock().unwrap().dropped, 0);

        drop(runtime);
        assert_eq!(log.lock().unwrap().dropped, 1);
    }

    #[tokio::test]
    async fn a_full_context_is_reported_as_a_context_overflow() {
        let (model, _log) = FakeModel::new(vec![vec![Step::Fail(OnDeviceError {
            kind: OnDeviceErrorKind::ContextExceeded,
            message: "Too long.".into(),
        })]]);
        let error = runtime(model)
            .reply(CompletionRequest::new("Hi"))
            .next()
            .await
            .expect("one frame")
            .expect_err("the failure");
        assert!(error.report().is_context_overflow(), "{error}");
    }

    #[test]
    fn older_turns_are_left_out_when_the_window_cannot_hold_them() {
        let turn = |role, text: &str| OnDeviceTurn {
            role,
            text: text.to_string(),
        };
        let old = "old ".repeat(300);
        let recent = "recent ".repeat(20);
        let mut request = CompletionRequest::new("Latest question");
        request.chat_history = vec![
            Arc::new(Message::System {
                content: "Rules".into(),
            }),
            Arc::new(Message::user(old.clone())),
            Arc::new(Message::assistant("old answer")),
            Arc::new(Message::user(recent.clone())),
            Arc::new(Message::assistant("recent answer")),
            Arc::new(Message::user("Latest question")),
        ];

        let roomy = on_device_request(&request, 100_000).unwrap();
        assert_eq!(roomy.instructions, "Rules");
        assert_eq!(roomy.prompt, "Latest question");
        assert_eq!(roomy.history.len(), 4);

        // Room for the reply, the prompt and the two newest turns only.
        let tight = on_device_request(&request, DEFAULT_REPLY_TOKENS + 80).unwrap();
        assert_eq!(tight.prompt, "Latest question");
        assert_eq!(
            tight.history,
            [
                turn(OnDeviceRole::User, &recent),
                turn(OnDeviceRole::Assistant, "recent answer")
            ]
        );
    }

    #[tokio::test]
    async fn agent_runs_the_tool_and_the_same_reply_answers() {
        let (model, log) = FakeModel::new(vec![vec![
            call("c1", "echo", r#"{"value":"ping"}"#),
            Step::AwaitOutputs(1),
            text("It said ping."),
            done(),
        ]]);
        let tool_runs = Arc::new(AtomicUsize::new(0));
        let runs = tool_runs.clone();
        let echo = DynamicTool::new(
            ToolName::new("echo").unwrap(),
            "Echo fixture",
            serde_json::json!({
                "type": "object",
                "properties": { "value": { "type": "string" } },
                "required": ["value"]
            }),
            move |args| {
                runs.fetch_add(1, Ordering::SeqCst);
                Box::pin(async move { Ok(ToolOutput::json(args)) })
            },
        );
        let agent = AgentBuilder::new(create_on_device_model(model).with_idle_timeout(None))
            .preamble("House rules")
            .dynamic_tools(vec![echo])
            .build();

        let mut stream = agent.prompt("Call echo").max_turns(3).stream();
        let mut answer = String::new();
        while let Some(item) = stream.next().await {
            if let MultiTurnStreamItem::StreamAssistantItem(Item::Event(StreamEvent::Text {
                text,
                ..
            })) = item.expect("the turn must not fail")
            {
                answer.push_str(&text);
            }
        }

        assert_eq!(answer, "It said ping.");
        assert_eq!(tool_runs.load(Ordering::SeqCst), 1);
        let log = log.lock().unwrap();
        assert_eq!(log.requests.len(), 1, "one reply serves the whole turn");
        let request = &log.requests[0];
        assert_eq!(request.instructions, "House rules");
        assert_eq!(request.prompt, "Call echo");
        assert_eq!(request.tools.len(), 1);
        assert_eq!(request.tools[0].name, "echo");
        assert_eq!(log.outputs.len(), 1);
        assert_eq!(log.outputs[0].0, "c1");
        assert!(log.outputs[0].1.contains("ping"), "{:?}", log.outputs);
    }

    #[test]
    fn a_section_is_left_out_up_to_the_next_heading() {
        let prompt = "Intro\n\n## Recording a transaction\n- Draft it.\n\n## Images\n- Read it.\n";
        assert_eq!(
            without_section(prompt, RECORDING_SECTION),
            "Intro\n\n## Images\n- Read it.\n"
        );
        assert_eq!(
            without_section(
                "Intro\n## Recording a transaction\n- last",
                RECORDING_SECTION
            ),
            "Intro\n"
        );
        assert_eq!(
            without_section("No such part", RECORDING_SECTION),
            "No such part"
        );
        // The shipped prompt has the section, so the match cannot go stale.
        assert!(crate::SYSTEM_PROMPT_ON_DEVICE.contains(RECORDING_SECTION));
    }

    #[tokio::test]
    async fn a_reply_without_the_record_tool_is_not_told_how_to_record() {
        let with_rules = |message: &str| {
            let mut request = request_with_a_tool(message);
            request.chat_history[0] = Arc::new(Message::System {
                content: format!("Rules\n\n{RECORDING_SECTION}\n- Draft it.\n\n## Style\n- Brief."),
            });
            request
        };
        let (model, log) = FakeModel::new(vec![
            vec![text("A trade."), done()],
            vec![text("Draft ready."), done()],
        ]);
        let runtime = runtime(model.clone());

        model.routes_as(vec![text(ROUTE_GENERAL), done()]);
        frames(&runtime, with_rules("what does this show?")).await;
        model.routes_as(vec![text(ROUTE_RECORD), done()]);
        frames(&runtime, with_rules("record this")).await;

        let log = log.lock().unwrap();
        assert!(!log.requests[0].instructions.contains(RECORDING_SECTION));
        assert!(log.requests[0].instructions.contains("## Style"));
        assert!(log.requests[1].instructions.contains(RECORDING_SECTION));
    }

    fn image(data: &str) -> UserContent {
        UserContent::Image(rig::message::Image {
            data: DocumentSourceKind::Base64(data.into()),
            media_type: Some(rig::message::ImageMediaType::PNG),
            detail: None,
            native: None,
        })
    }

    #[tokio::test]
    async fn only_the_prompts_own_images_reach_the_device() {
        let (model, log) = FakeModel::new(vec![vec![text("A buy."), done()]]);
        let runtime = runtime(model);
        let mut request = CompletionRequest::new("record this");
        request.chat_history = vec![
            Arc::new(Message::User {
                content: vec![UserContent::text("what is this?"), image("OLD")],
            }),
            Arc::new(Message::assistant("A statement.")),
            Arc::new(Message::User {
                content: vec![UserContent::text("record this"), image("NEW")],
            }),
        ];

        frames(&runtime, request).await;
        let log = log.lock().unwrap();
        let sent = &log.requests[0];
        assert_eq!(sent.images, ["NEW"]);
        assert_eq!(sent.prompt, "record this");
        assert_eq!(sent.history.len(), 2, "earlier turns go as text");
    }

    #[test]
    fn each_image_takes_room_from_the_history() {
        let turn = |text: &str| {
            Arc::new(Message::User {
                content: vec![UserContent::text(text)],
            })
        };
        let mut request = CompletionRequest::new("now");
        let long = "x".repeat(600);
        request.chat_history = vec![turn(&long), Arc::new(Message::assistant("ok")), turn("now")];
        // Room for the long turn without an image, and not with one.
        let room = estimated_tokens("now") + DEFAULT_REPLY_TOKENS + estimated_tokens(&long) + 10;
        assert_eq!(on_device_request(&request, room).unwrap().history.len(), 2);

        request.chat_history[2] = Arc::new(Message::User {
            content: vec![UserContent::text("now"), image("IMG")],
        });
        let with_image = on_device_request(&request, room).unwrap();
        assert_eq!(with_image.images, ["IMG"]);
        assert!(with_image.history.is_empty());
    }

    #[tokio::test]
    async fn agent_passes_the_prompts_image_to_the_device() {
        let (model, log) = FakeModel::new(vec![vec![text("Seen."), done()]]);
        let agent = AgentBuilder::new(create_on_device_model(model).with_idle_timeout(None))
            .preamble("House rules")
            .build();

        let prompt = Message::User {
            content: vec![UserContent::text("what is this?"), image("PNGDATA")],
        };
        let mut stream = agent.prompt(prompt).max_turns(1).stream();
        while let Some(item) = stream.next().await {
            item.expect("the turn must not fail");
        }

        let log = log.lock().unwrap();
        assert_eq!(log.requests[0].images, ["PNGDATA"]);
    }
}
