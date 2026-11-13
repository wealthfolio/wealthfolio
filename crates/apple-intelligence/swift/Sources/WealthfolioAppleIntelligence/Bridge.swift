import Foundation
import ImageIO

#if canImport(FoundationModels)
import FoundationModels
#endif

/// Receives one JSON event. Called any number of times, then exactly once with
/// a `done` or `error` event, after which `context` is never used again.
public typealias WFEventCallback = @convention(c) (UnsafeMutableRawPointer?, UnsafePointer<CChar>) -> Void

/// Mirrors `Status` in the Rust half of this crate.
private enum StatusCode: Int32 {
    case available = 0
    case deviceNotEligible = 1
    case notEnabled = 2
    case modelNotReady = 3
    /// The system is older than macOS 27, or the app was built without its SDK.
    case unsupportedSystem = 4
}

/// The app supports macOS 27's model only: macOS 26's has half the context
/// window (4,096 tokens), which the app's prompt and tools nearly fill, and
/// reads no images. FoundationModels 2.1.14 is the macOS 27 SDK's.
@_cdecl("wf_apple_intelligence_status")
public func wfAppleIntelligenceStatus() -> Int32 {
    #if canImport(FoundationModels, _version: 2.1.14)
    if #available(macOS 27.0, iOS 27.0, *) {
        switch SystemLanguageModel.default.availability {
        case .available: return StatusCode.available.rawValue
        case .unavailable(.deviceNotEligible): return StatusCode.deviceNotEligible.rawValue
        case .unavailable(.appleIntelligenceNotEnabled): return StatusCode.notEnabled.rawValue
        case .unavailable(.modelNotReady): return StatusCode.modelNotReady.rawValue
        @unknown default: return StatusCode.modelNotReady.rawValue
        }
    }
    #endif
    return StatusCode.unsupportedSystem.rawValue
}

/// The model's context window in tokens, or 0 where there is no model.
@_cdecl("wf_apple_intelligence_context_size")
public func wfAppleIntelligenceContextSize() -> Int64 {
    // Where the model is supported; see `wfAppleIntelligenceStatus`.
    #if canImport(FoundationModels, _version: 2.1.14)
    if #available(macOS 27.0, iOS 27.0, *) {
        return Int64(SystemLanguageModel.default.contextSize)
    }
    #endif
    return 0
}

/// Whether the model reads images sent with a prompt (macOS 27 and later).
@_cdecl("wf_apple_intelligence_supports_images")
public func wfAppleIntelligenceSupportsImages() -> Bool {
    // Built only with an SDK that has macOS 27's capabilities; see
    // `BridgeSession.streamResponse`.
    #if canImport(FoundationModels, _version: 2.1.14)
    if #available(macOS 27.0, iOS 27.0, *) {
        return SystemLanguageModel.default.capabilities.contains(.vision)
    }
    #endif
    return false
}

/// Starts one reply and returns its session id. Events arrive on `callback`,
/// which is always called with a final `done` or `error`.
@_cdecl("wf_apple_intelligence_start")
public func wfAppleIntelligenceStart(
    _ requestJSON: UnsafePointer<CChar>,
    _ context: UnsafeMutableRawPointer?,
    _ callback: WFEventCallback
) -> UInt64 {
    let json = String(cString: requestJSON)
    #if canImport(FoundationModels)
    if #available(macOS 26.0, iOS 26.0, *) {
        return BridgeSession.start(requestJSON: json, context: context, callback: callback)
    }
    #endif
    emit(["type": "error", "kind": "unavailable", "message": "Apple Intelligence needs a newer system."],
         to: callback, context: context)
    return 0
}

/// Answers the tool call `callID` of `session`, which is waiting on it.
@_cdecl("wf_apple_intelligence_tool_result")
public func wfAppleIntelligenceToolResult(
    _ session: UInt64, _ callID: UnsafePointer<CChar>, _ output: UnsafePointer<CChar>
) {
    #if canImport(FoundationModels)
    if #available(macOS 26.0, iOS 26.0, *) {
        BridgeSession.find(session)?.deliver(callID: String(cString: callID), output: String(cString: output))
    }
    #endif
}

/// Stops `session`. Its final event still arrives.
@_cdecl("wf_apple_intelligence_cancel")
public func wfAppleIntelligenceCancel(_ session: UInt64) {
    #if canImport(FoundationModels)
    if #available(macOS 26.0, iOS 26.0, *) {
        BridgeSession.find(session)?.cancel()
    }
    #endif
}

private func emit(_ event: [String: Any], to callback: WFEventCallback, context: UnsafeMutableRawPointer?) {
    let data = (try? JSONSerialization.data(withJSONObject: event)) ?? Data("{\"type\":\"error\"}".utf8)
    String(decoding: data, as: UTF8.self).withCString { callback(context, $0) }
}

#if canImport(FoundationModels)

private struct BridgeRequest {
    struct Turn {
        let isUser: Bool
        let text: String
    }
    struct ToolSpec {
        let name: String
        let description: String
        let parameters: [String: Any]
    }

    let instructions: String
    let history: [Turn]
    let prompt: String
    /// Image files sent with the prompt.
    let images: [Data]
    let tools: [ToolSpec]
    let temperature: Double?
    let maxOutputTokens: Int?
    /// When not empty, the reply is exactly one of these.
    let choices: [String]

    init?(json: String) {
        guard let object = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any],
            let prompt = object["prompt"] as? String
        else { return nil }
        self.prompt = prompt
        images = ((object["images"] as? [String]) ?? []).compactMap { Data(base64Encoded: $0) }
        instructions = (object["instructions"] as? String) ?? ""
        history = ((object["history"] as? [[String: Any]]) ?? []).compactMap { turn in
            guard let text = turn["text"] as? String, !text.isEmpty else { return nil }
            return Turn(isUser: (turn["role"] as? String) == "user", text: text)
        }
        tools = ((object["tools"] as? [[String: Any]]) ?? []).compactMap { tool in
            guard let name = tool["name"] as? String else { return nil }
            return ToolSpec(
                name: name,
                description: (tool["description"] as? String) ?? "",
                parameters: (tool["parameters"] as? [String: Any]) ?? [:])
        }
        temperature = object["temperature"] as? Double
        maxOutputTokens = object["maxOutputTokens"] as? Int
        choices = (object["choices"] as? [String]) ?? []
    }
}

/// One reply in progress. The framework runs tools itself, so a tool call
/// waits here until the app has run the tool and sent its output back.
@available(macOS 26.0, iOS 26.0, *)
private final class BridgeSession: @unchecked Sendable {
    private static let registryLock = NSLock()
    nonisolated(unsafe) private static var sessions: [UInt64: BridgeSession] = [:]
    nonisolated(unsafe) private static var nextID: UInt64 = 1

    private let id: UInt64
    private let context: UnsafeMutableRawPointer?
    private let callback: WFEventCallback

    /// Guards everything below, and orders the events sent to the app.
    private let lock = NSLock()
    private var waiting: [String: CheckedContinuation<String, any Error>] = [:]
    private var finished = false
    private var cancelled = false
    private var task: Task<Void, Never>?

    private init(id: UInt64, context: UnsafeMutableRawPointer?, callback: WFEventCallback) {
        self.id = id
        self.context = context
        self.callback = callback
    }

    static func start(requestJSON: String, context: UnsafeMutableRawPointer?, callback: WFEventCallback) -> UInt64 {
        registryLock.lock()
        let id = nextID
        nextID += 1
        let session = BridgeSession(id: id, context: context, callback: callback)
        sessions[id] = session
        registryLock.unlock()

        let task = Task.detached { await session.run(requestJSON: requestJSON) }
        session.lock.lock()
        session.task = task
        let cancelled = session.cancelled
        session.lock.unlock()
        if cancelled { task.cancel() }
        return id
    }

    static func find(_ id: UInt64) -> BridgeSession? {
        registryLock.lock()
        defer { registryLock.unlock() }
        return sessions[id]
    }

    private func run(requestJSON: String) async {
        do {
            guard let request = BridgeRequest(json: requestJSON) else {
                throw BridgeError(kind: "invalidRequest", message: "The request could not be read.")
            }
            let tools = try request.tools.map { try BridgedTool(spec: $0, session: self) }

            var entries: [Transcript.Entry] = [
                .instructions(
                    Transcript.Instructions(
                        segments: [.text(Transcript.TextSegment(content: request.instructions))],
                        toolDefinitions: tools.map {
                            Transcript.ToolDefinition(
                                name: $0.name, description: $0.description, parameters: $0.parameters)
                        }))
            ]
            for turn in request.history {
                let segment = Transcript.Segment.text(Transcript.TextSegment(content: turn.text))
                entries.append(
                    turn.isUser
                        ? .prompt(Transcript.Prompt(segments: [segment]))
                        : .response(Transcript.Response(assetIDs: [], segments: [segment])))
            }

            // The default content filter blocks about half the plain answers
            // about a holding's value ("May contain sensitive content"). The
            // permissive one is Apple's setting for answers built from text
            // the user already has, which the user's own portfolio data is.
            let session = LanguageModelSession(
                model: SystemLanguageModel(guardrails: .permissiveContentTransformations), tools: tools,
                transcript: Transcript(entries: entries))
            let options = GenerationOptions(
                temperature: request.temperature, maximumResponseTokens: request.maxOutputTokens)

            if !request.choices.isEmpty {
                // The model can only produce one of the choices, so the app
                // reads a label and never free text.
                let schema = try GenerationSchema(
                    root: DynamicGenerationSchema(name: "Choice", anyOf: request.choices),
                    dependencies: [])
                let reply = try await session.respond(to: request.prompt, schema: schema, options: options)
                let choice = (try? reply.content.value(String.self)) ?? ""
                send(["type": "text", "delta": choice])
                finish(["type": "done"])
                return
            }

            // The framework reports the whole answer so far; the app takes deltas.
            var sent = String.UnicodeScalarView()
            let stream: LanguageModelSession.ResponseStream<String>
            if request.images.isEmpty {
                stream = session.streamResponse(to: request.prompt, options: options)
            } else {
                stream = try Self.streamResponse(
                    session: session, prompt: request.prompt, images: request.images, options: options)
            }
            for try await snapshot in stream {
                try Task.checkCancellation()
                // Compared by Unicode scalars, not characters: a snapshot can
                // end inside a character that the next one extends (a skin
                // tone, an Arabic vowel mark), and a character-wise prefix
                // would send that character twice.
                let content = snapshot.content.unicodeScalars
                let delta = Self.delta(from: sent, to: content)
                sent = content
                if !delta.isEmpty { send(["type": "text", "delta": delta]) }
            }
            finish(["type": "done"])
        } catch {
            finish(Self.event(for: error))
        }
    }

    /// What `content` adds after `sent`. A snapshot that rewrites earlier
    /// text, which the framework does not do, sends only its new end.
    static func delta(from sent: String.UnicodeScalarView, to content: String.UnicodeScalarView) -> String {
        var common = 0
        for (old, new) in zip(sent, content) {
            guard old == new else { break }
            common += 1
        }
        return String(String.UnicodeScalarView(content.dropFirst(common)))
    }

    /// Sends the tool call to the app and waits for the tool's output.
    func runTool(name: String, arguments: String) async throws -> String {
        let callID = UUID().uuidString
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                lock.lock()
                if cancelled || finished {
                    lock.unlock()
                    continuation.resume(throwing: CancellationError())
                    return
                }
                waiting[callID] = continuation
                emit(["type": "toolCall", "id": callID, "name": name, "arguments": arguments],
                     to: callback, context: context)
                lock.unlock()
            }
        } onCancel: {
            self.cancel()
        }
    }

    func deliver(callID: String, output: String) {
        lock.lock()
        let continuation = waiting.removeValue(forKey: callID)
        lock.unlock()
        continuation?.resume(returning: output)
    }

    func cancel() {
        lock.lock()
        cancelled = true
        let stranded = waiting
        waiting.removeAll()
        let task = self.task
        lock.unlock()
        task?.cancel()
        for continuation in stranded.values {
            continuation.resume(throwing: CancellationError())
        }
    }

    private func send(_ event: [String: Any]) {
        lock.lock()
        if !finished { emit(event, to: callback, context: context) }
        lock.unlock()
    }

    private func finish(_ event: [String: Any]) {
        lock.lock()
        let first = !finished
        finished = true
        let stranded = waiting
        waiting.removeAll()
        if first { emit(event, to: callback, context: context) }
        lock.unlock()
        for continuation in stranded.values {
            continuation.resume(throwing: CancellationError())
        }
        Self.registryLock.lock()
        Self.sessions[id] = nil
        Self.registryLock.unlock()
    }

    /// The reply to `prompt` with `images` attached. Image input needs the
    /// macOS 27 SDK at build time (FoundationModels 2.1.14 is the version this
    /// was built against) and macOS 27 at run time; otherwise it fails.
    private static func streamResponse(
        session: LanguageModelSession, prompt: String, images: [Data], options: GenerationOptions
    ) throws -> LanguageModelSession.ResponseStream<String> {
        #if canImport(FoundationModels, _version: 2.1.14)
        if #available(macOS 27.0, iOS 27.0, *) {
            let attachments = try images.map { data in
                guard let source = CGImageSourceCreateWithData(data as CFData, nil),
                    let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
                else {
                    throw BridgeError(kind: "invalidRequest", message: "An attached image could not be read.")
                }
                return Attachment(image)
            }
            return session.streamResponse(options: options) {
                attachments
                prompt
            }
        }
        #endif
        throw BridgeError(kind: "invalidRequest", message: "Images need a newer system.")
    }

    /// The app shows `message` as is, so it is a plain sentence; `kind` is
    /// what the app branches on.
    private static func event(for error: any Error) -> [String: Any] {
        func failure(_ kind: String, _ message: String) -> [String: Any] {
            ["type": "error", "kind": kind, "message": message]
        }
        if error is CancellationError {
            return failure("cancelled", "The reply was stopped.")
        }
        if let error = error as? BridgeError {
            return failure(error.kind, error.message)
        }
        if let error = error as? LanguageModelSession.ToolCallError {
            if error.underlyingError is CancellationError {
                return failure("cancelled", "The reply was stopped.")
            }
            return failure("other", "The tool \(error.tool.name) could not be run.")
        }
        // macOS 27's error type; built only with an SDK that has it.
        #if canImport(FoundationModels, _version: 2.1.14)
        if #available(macOS 27.0, iOS 27.0, *), let error = error as? LanguageModelError {
            switch error {
            case .contextSizeExceeded:
                return failure("contextExceeded", "This conversation is longer than the on-device model can hold.")
            case .guardrailViolation:
                return failure("refused", "Apple Intelligence's content filter blocked that.")
            case .refusal:
                return failure("refused", "Apple Intelligence declined to answer that.")
            case .unsupportedLanguageOrLocale:
                return failure("unsupportedLanguage", "Apple Intelligence does not support this language yet.")
            case .rateLimited:
                return failure("busy", "Apple Intelligence is busy. Try again shortly.")
            default:
                break
            }
        }
        #endif
        if let error = error as? LanguageModelSession.GenerationError {
            switch error {
            case .exceededContextWindowSize:
                return failure("contextExceeded", "This conversation is longer than the on-device model can hold.")
            case .guardrailViolation:
                return failure("refused", "Apple Intelligence's content filter blocked that.")
            case .refusal:
                return failure("refused", "Apple Intelligence declined to answer that.")
            case .unsupportedLanguageOrLocale:
                return failure("unsupportedLanguage", "Apple Intelligence does not support this language yet.")
            case .assetsUnavailable:
                return failure("unavailable", "Apple Intelligence is currently unavailable.")
            case .rateLimited, .concurrentRequests:
                return failure("busy", "Apple Intelligence is busy. Try again shortly.")
            default:
                break
            }
        }
        // Which error it was, for the log: its type and case name only, never
        // its description, which can quote the conversation.
        let caseName = Mirror(reflecting: error).children.first?.label.map { ".\($0)" } ?? ""
        return failure(
            "other",
            "Apple Intelligence could not complete the response (\(type(of: error))\(caseName)).")
    }
}

private struct BridgeError: Error {
    let kind: String
    let message: String
}

/// One of the app's tools, as the framework sees it. Calling it hands the
/// call to the app, which owns the tool and decides whether it may run.
@available(macOS 26.0, iOS 26.0, *)
private struct BridgedTool: Tool {
    let name: String
    let description: String
    let parameters: GenerationSchema
    let session: BridgeSession

    init(spec: BridgeRequest.ToolSpec, session: BridgeSession) throws {
        name = spec.name
        description = spec.description
        do {
            parameters = try ToolSchemaConverter.schema(for: spec.parameters, toolName: spec.name)
        } catch {
            throw BridgeError(kind: "invalidRequest", message: "The tool \(spec.name) has a schema the model cannot use.")
        }
        self.session = session
    }

    func call(arguments: GeneratedContent) async throws -> String {
        try await session.runTool(name: name, arguments: arguments.jsonString)
    }
}

#endif
