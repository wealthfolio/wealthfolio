// AI Assistant Types Tests
// Tests for stream event parsing, error handling, and type utilities

import { describe, it, expect } from "vitest";
import {
  parseErrorCode,
  ERROR_CODE_MAP,
  type AiStreamEvent,
  type ChatThread,
  type ChatMessage,
  type ChatMessageContent,
  type ToolCall,
  type ToolResult,
  type UsageStats,
  type ChatError,
} from "./types";

/**
 * Helper to create a ChatMessageContent from simple text.
 */
function textContent(text: string): ChatMessageContent {
  return {
    schemaVersion: 1,
    parts: [{ type: "text", content: text }],
  };
}

/**
 * Helper to create a ChatMessage with text content.
 */
function createTextMessage(
  id: string,
  threadId: string,
  role: "user" | "assistant",
  text: string,
  createdAt: string,
): ChatMessage {
  return {
    id,
    threadId,
    role,
    content: textContent(text),
    createdAt,
  };
}

// ============================================================================
// Error Code Parsing Tests
// ============================================================================

describe("parseErrorCode", () => {
  it("should parse known error codes with correct messages", () => {
    const knownCodes = Object.keys(ERROR_CODE_MAP);

    for (const code of knownCodes) {
      const result = parseErrorCode(code);
      expect(result.code).toBe(code);
      expect(result.message).toBe(ERROR_CODE_MAP[code].message);
      expect(result.retryable).toBe(ERROR_CODE_MAP[code].retryable);
    }
  });

  it("should return non-retryable for providerNotConfigured", () => {
    const result = parseErrorCode("providerNotConfigured");
    expect(result.retryable).toBe(false);
    expect(result.message).toContain("not configured");
  });

  it("should return non-retryable for missingApiKey", () => {
    const result = parseErrorCode("missingApiKey");
    expect(result.retryable).toBe(false);
    expect(result.message).toContain("API key");
  });

  it("should return retryable for providerError", () => {
    const result = parseErrorCode("providerError");
    expect(result.retryable).toBe(true);
  });

  it("should return retryable for toolExecutionError", () => {
    const result = parseErrorCode("toolExecutionError");
    expect(result.retryable).toBe(true);
  });

  it("should return retryable for cancelled", () => {
    const result = parseErrorCode("cancelled");
    expect(result.retryable).toBe(true);
    expect(result.message).toContain("cancelled");
  });

  it("should return retryable for network errors", () => {
    const result = parseErrorCode("network");
    expect(result.retryable).toBe(true);
    expect(result.message).toContain("Network");
  });

  it("should handle unknown error codes with fallback message", () => {
    const result = parseErrorCode("unknownError123");
    expect(result.code).toBe("unknownError123");
    expect(result.retryable).toBe(true); // Default for unknown
    expect(result.message).toContain("unexpected error");
  });

  it("should use rawMessage when provided for unknown codes", () => {
    const result = parseErrorCode("customCode", "Custom error happened");
    expect(result.code).toBe("customCode");
    expect(result.message).toBe("Custom error happened");
    expect(result.retryable).toBe(true);
  });

  it("should ignore rawMessage for known codes", () => {
    const result = parseErrorCode("missingApiKey", "This should be ignored");
    expect(result.message).toBe(ERROR_CODE_MAP.missingApiKey.message);
  });
});

describe("ERROR_CODE_MAP", () => {
  it("should have all expected error codes", () => {
    const expectedCodes = [
      "providerNotConfigured",
      "missingApiKey",
      "modelNotFound",
      "toolNotFound",
      "toolNotAllowed",
      "toolExecutionError",
      "providerError",
      "threadNotFound",
      "invalidInput",
      "internal",
      "cancelled",
      "network",
    ];

    for (const code of expectedCodes) {
      expect(ERROR_CODE_MAP).toHaveProperty(code);
      expect(ERROR_CODE_MAP[code]).toHaveProperty("message");
      expect(ERROR_CODE_MAP[code]).toHaveProperty("retryable");
    }
  });

  it("should have non-empty messages for all codes", () => {
    for (const [, config] of Object.entries(ERROR_CODE_MAP)) {
      expect(config.message.length).toBeGreaterThan(0);
      expect(typeof config.retryable).toBe("boolean");
    }
  });
});

// ============================================================================
// Stream Event Type Tests
// ============================================================================

describe("AiStreamEvent type validation", () => {
  it("should accept valid SystemEvent structure", () => {
    const event: AiStreamEvent = {
      type: "system",
      threadId: "thread-123",
      runId: "run-456",
      messageId: "msg-789",
    };

    expect(event.type).toBe("system");
    expect(event.threadId).toBe("thread-123");
    expect(event.runId).toBe("run-456");
    expect(event.messageId).toBe("msg-789");
  });

  it("should accept valid TextDeltaEvent structure", () => {
    const event: AiStreamEvent = {
      type: "textDelta",
      threadId: "thread-123",
      runId: "run-456",
      messageId: "msg-789",
      delta: "Hello, ",
    };

    expect(event.type).toBe("textDelta");
    if (event.type === "textDelta") {
      expect(event.delta).toBe("Hello, ");
    }
  });

  it("should accept valid ReasoningDeltaEvent structure", () => {
    const event: AiStreamEvent = {
      type: "reasoningDelta",
      threadId: "thread-123",
      runId: "run-456",
      messageId: "msg-789",
      delta: "Let me think...",
    };

    expect(event.type).toBe("reasoningDelta");
    if (event.type === "reasoningDelta") {
      expect(event.delta).toBe("Let me think...");
    }
  });

  it("should accept valid ToolCallEvent structure", () => {
    const toolCall: ToolCall = {
      id: "tc-123",
      name: "get_holdings",
      arguments: { accountId: "acc-1" },
    };

    const event: AiStreamEvent = {
      type: "toolCall",
      threadId: "thread-123",
      runId: "run-456",
      messageId: "msg-789",
      toolCall,
    };

    expect(event.type).toBe("toolCall");
    if (event.type === "toolCall") {
      expect(event.toolCall.name).toBe("get_holdings");
      expect(event.toolCall.arguments).toEqual({ accountId: "acc-1" });
    }
  });

  it("should accept valid ToolResultEvent structure", () => {
    const result: ToolResult = {
      toolCallId: "tc-123",
      success: true,
      data: { holdings: [{ symbol: "AAPL", quantity: 10 }] },
      meta: { rowCount: 1, truncated: false },
    };

    const event: AiStreamEvent = {
      type: "toolResult",
      threadId: "thread-123",
      runId: "run-456",
      messageId: "msg-789",
      result,
    };

    expect(event.type).toBe("toolResult");
    if (event.type === "toolResult") {
      expect(event.result.success).toBe(true);
      expect(event.result.toolCallId).toBe("tc-123");
    }
  });

  it("should accept valid ErrorEvent structure", () => {
    const event: AiStreamEvent = {
      type: "error",
      threadId: "thread-123",
      runId: "run-456",
      code: "providerError",
      message: "API rate limit exceeded",
    };

    expect(event.type).toBe("error");
    if (event.type === "error") {
      expect(event.code).toBe("providerError");
      expect(event.message).toBe("API rate limit exceeded");
      expect(event.messageId).toBeUndefined();
    }
  });

  it("should accept ErrorEvent with optional messageId", () => {
    const event: AiStreamEvent = {
      type: "error",
      threadId: "thread-123",
      runId: "run-456",
      messageId: "msg-789",
      code: "toolExecutionError",
      message: "Tool failed",
    };

    if (event.type === "error") {
      expect(event.messageId).toBe("msg-789");
    }
  });

  it("should accept valid DoneEvent structure", () => {
    const message = createTextMessage(
      "msg-789",
      "thread-123",
      "assistant",
      "Here is your portfolio summary.",
      "2024-01-15T10:00:00Z",
    );

    const usage: UsageStats = {
      providerId: "anthropic",
      modelId: "claude-sonnet-5-5",
      modelCalls: 1,
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    };

    const event: AiStreamEvent = {
      type: "done",
      threadId: "thread-123",
      runId: "run-456",
      messageId: "msg-789",
      message,
      usage,
    };

    expect(event.type).toBe("done");
    if (event.type === "done") {
      expect(event.message.content.parts[0]).toEqual({
        type: "text",
        content: "Here is your portfolio summary.",
      });
      expect(event.usage?.totalTokens).toBe(150);
    }
  });

  it("should accept DoneEvent without usage stats", () => {
    const message = createTextMessage(
      "msg-789",
      "thread-123",
      "assistant",
      "Done.",
      "2024-01-15T10:00:00Z",
    );

    const event: AiStreamEvent = {
      type: "done",
      threadId: "thread-123",
      runId: "run-456",
      messageId: "msg-789",
      message,
    };

    if (event.type === "done") {
      expect(event.usage).toBeUndefined();
    }
  });
});

// ============================================================================
// Stream Event JSON Parsing Tests (simulating backend events)
// ============================================================================

describe("Stream Event JSON parsing", () => {
  it("should parse system event from JSON", () => {
    const json = `{
      "type": "system",
      "threadId": "thread-123",
      "runId": "run-456",
      "messageId": "msg-789"
    }`;

    const event = JSON.parse(json) as AiStreamEvent;
    expect(event.type).toBe("system");
    expect(event.threadId).toBe("thread-123");
  });

  it("should parse textDelta event from JSON", () => {
    const json = `{
      "type": "textDelta",
      "threadId": "thread-123",
      "runId": "run-456",
      "messageId": "msg-789",
      "delta": "Hello world"
    }`;

    const event = JSON.parse(json) as AiStreamEvent;
    expect(event.type).toBe("textDelta");
    if (event.type === "textDelta") {
      expect(event.delta).toBe("Hello world");
    }
  });

  it("should parse toolCall event from JSON", () => {
    const json = `{
      "type": "toolCall",
      "threadId": "thread-123",
      "runId": "run-456",
      "messageId": "msg-789",
      "toolCall": {
        "id": "tc-1",
        "name": "get_accounts",
        "arguments": {}
      }
    }`;

    const event = JSON.parse(json) as AiStreamEvent;
    expect(event.type).toBe("toolCall");
    if (event.type === "toolCall") {
      expect(event.toolCall.name).toBe("get_accounts");
    }
  });

  it("should parse toolResult event with metadata from JSON", () => {
    const json = `{
      "type": "toolResult",
      "threadId": "thread-123",
      "runId": "run-456",
      "messageId": "msg-789",
      "result": {
        "toolCallId": "tc-1",
        "success": true,
        "data": {"accounts": [{"id": "acc-1", "name": "Main"}]},
        "meta": {"rowCount": 1, "durationMs": 50}
      }
    }`;

    const event = JSON.parse(json) as AiStreamEvent;
    expect(event.type).toBe("toolResult");
    if (event.type === "toolResult") {
      expect(event.result.success).toBe(true);
      expect(event.result.meta?.rowCount).toBe(1);
      expect(event.result.meta?.durationMs).toBe(50);
    }
  });

  it("should parse error event from JSON", () => {
    const json = `{
      "type": "error",
      "threadId": "thread-123",
      "runId": "run-456",
      "code": "missingApiKey",
      "message": "API key is required"
    }`;

    const event = JSON.parse(json) as AiStreamEvent;
    expect(event.type).toBe("error");
    if (event.type === "error") {
      expect(event.code).toBe("missingApiKey");
    }
  });

  it("should parse done event from JSON", () => {
    const json = `{
      "type": "done",
      "threadId": "thread-123",
      "runId": "run-456",
      "messageId": "msg-789",
      "message": {
        "id": "msg-789",
        "threadId": "thread-123",
        "role": "assistant",
        "content": "Final response",
        "createdAt": "2024-01-15T10:00:00Z"
      },
      "usage": {
        "promptTokens": 100,
        "completionTokens": 25,
        "totalTokens": 125
      }
    }`;

    const event = JSON.parse(json) as AiStreamEvent;
    expect(event.type).toBe("done");
    if (event.type === "done") {
      expect(event.message.role).toBe("assistant");
      expect(event.usage?.totalTokens).toBe(125);
    }
  });
});

// ============================================================================
// Incremental Transcript Assembly Tests
// ============================================================================

describe("Incremental transcript assembly", () => {
  /**
   * Helper to simulate assembling a transcript from stream events.
   * In the real implementation, this logic lives in the chat-shell hooks.
   */
  function assembleTranscript(events: AiStreamEvent[]): {
    content: string;
    reasoning: string;
    toolCalls: ToolCall[];
    toolResults: ToolResult[];
    isComplete: boolean;
    error: ChatError | null;
  } {
    let content = "";
    let reasoning = "";
    const toolCalls: ToolCall[] = [];
    const toolResults: ToolResult[] = [];
    let isComplete = false;
    let error: ChatError | null = null;

    for (const event of events) {
      switch (event.type) {
        case "textDelta":
          content += event.delta;
          break;
        case "reasoningDelta":
          reasoning += event.delta;
          break;
        case "toolCall":
          toolCalls.push(event.toolCall);
          break;
        case "toolResult":
          toolResults.push(event.result);
          break;
        case "error":
          error = parseErrorCode(event.code, event.message);
          break;
        case "done":
          isComplete = true;
          break;
      }
    }

    return { content, reasoning, toolCalls, toolResults, isComplete, error };
  }

  it("should assemble simple text response", () => {
    const events: AiStreamEvent[] = [
      { type: "system", threadId: "t1", runId: "r1", messageId: "m1" },
      { type: "textDelta", threadId: "t1", runId: "r1", messageId: "m1", delta: "Hello, " },
      { type: "textDelta", threadId: "t1", runId: "r1", messageId: "m1", delta: "world!" },
      {
        type: "done",
        threadId: "t1",
        runId: "r1",
        messageId: "m1",
        message: {
          id: "m1",
          threadId: "t1",
          role: "assistant",
          content: textContent("Hello, world!"),
          createdAt: "2024-01-15T10:00:00Z",
        },
      },
    ];

    const result = assembleTranscript(events);
    expect(result.content).toBe("Hello, world!");
    expect(result.isComplete).toBe(true);
    expect(result.error).toBeNull();
  });

  it("should assemble response with reasoning", () => {
    const events: AiStreamEvent[] = [
      { type: "system", threadId: "t1", runId: "r1", messageId: "m1" },
      {
        type: "reasoningDelta",
        threadId: "t1",
        runId: "r1",
        messageId: "m1",
        delta: "Let me think ",
      },
      {
        type: "reasoningDelta",
        threadId: "t1",
        runId: "r1",
        messageId: "m1",
        delta: "about this...",
      },
      {
        type: "textDelta",
        threadId: "t1",
        runId: "r1",
        messageId: "m1",
        delta: "The answer is 42.",
      },
      {
        type: "done",
        threadId: "t1",
        runId: "r1",
        messageId: "m1",
        message: {
          id: "m1",
          threadId: "t1",
          role: "assistant",
          content: textContent("The answer is 42."),
          createdAt: "2024-01-15T10:00:00Z",
        },
      },
    ];

    const result = assembleTranscript(events);
    expect(result.reasoning).toBe("Let me think about this...");
    expect(result.content).toBe("The answer is 42.");
    expect(result.isComplete).toBe(true);
  });

  it("should assemble response with tool calls and results", () => {
    const events: AiStreamEvent[] = [
      { type: "system", threadId: "t1", runId: "r1", messageId: "m1" },
      { type: "textDelta", threadId: "t1", runId: "r1", messageId: "m1", delta: "Let me check " },
      {
        type: "toolCall",
        threadId: "t1",
        runId: "r1",
        messageId: "m1",
        toolCall: { id: "tc1", name: "get_holdings", arguments: {} },
      },
      {
        type: "toolResult",
        threadId: "t1",
        runId: "r1",
        messageId: "m1",
        result: {
          toolCallId: "tc1",
          success: true,
          data: { holdings: [{ symbol: "AAPL" }] },
        },
      },
      {
        type: "textDelta",
        threadId: "t1",
        runId: "r1",
        messageId: "m1",
        delta: "your holdings.",
      },
      {
        type: "done",
        threadId: "t1",
        runId: "r1",
        messageId: "m1",
        message: {
          id: "m1",
          threadId: "t1",
          role: "assistant",
          content: textContent("Let me check your holdings."),
          createdAt: "2024-01-15T10:00:00Z",
        },
      },
    ];

    const result = assembleTranscript(events);
    expect(result.content).toBe("Let me check your holdings.");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("get_holdings");
    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0].success).toBe(true);
    expect(result.isComplete).toBe(true);
  });

  it("should assemble response with multiple tool calls", () => {
    const events: AiStreamEvent[] = [
      { type: "system", threadId: "t1", runId: "r1", messageId: "m1" },
      {
        type: "toolCall",
        threadId: "t1",
        runId: "r1",
        messageId: "m1",
        toolCall: { id: "tc1", name: "get_accounts", arguments: {} },
      },
      {
        type: "toolResult",
        threadId: "t1",
        runId: "r1",
        messageId: "m1",
        result: { toolCallId: "tc1", success: true, data: { accounts: [] } },
      },
      {
        type: "toolCall",
        threadId: "t1",
        runId: "r1",
        messageId: "m1",
        toolCall: { id: "tc2", name: "get_holdings", arguments: { accountId: "all" } },
      },
      {
        type: "toolResult",
        threadId: "t1",
        runId: "r1",
        messageId: "m1",
        result: { toolCallId: "tc2", success: true, data: { holdings: [] } },
      },
      { type: "textDelta", threadId: "t1", runId: "r1", messageId: "m1", delta: "Summary" },
      {
        type: "done",
        threadId: "t1",
        runId: "r1",
        messageId: "m1",
        message: {
          id: "m1",
          threadId: "t1",
          role: "assistant",
          content: textContent("Summary"),
          createdAt: "2024-01-15T10:00:00Z",
        },
      },
    ];

    const result = assembleTranscript(events);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolResults).toHaveLength(2);
    expect(result.toolCalls[0].name).toBe("get_accounts");
    expect(result.toolCalls[1].name).toBe("get_holdings");
  });

  it("should handle error events", () => {
    const events: AiStreamEvent[] = [
      { type: "system", threadId: "t1", runId: "r1", messageId: "m1" },
      { type: "textDelta", threadId: "t1", runId: "r1", messageId: "m1", delta: "Starting..." },
      {
        type: "error",
        threadId: "t1",
        runId: "r1",
        code: "providerError",
        message: "Rate limit exceeded",
      },
    ];

    const result = assembleTranscript(events);
    expect(result.content).toBe("Starting...");
    expect(result.error).not.toBeNull();
    expect(result.error?.code).toBe("providerError");
    expect(result.error?.retryable).toBe(true);
    expect(result.isComplete).toBe(false);
  });

  it("should handle cancelled stream", () => {
    const events: AiStreamEvent[] = [
      { type: "system", threadId: "t1", runId: "r1", messageId: "m1" },
      { type: "textDelta", threadId: "t1", runId: "r1", messageId: "m1", delta: "Processing..." },
      {
        type: "error",
        threadId: "t1",
        runId: "r1",
        code: "cancelled",
        message: "Request cancelled",
      },
    ];

    const result = assembleTranscript(events);
    expect(result.error?.code).toBe("cancelled");
    expect(result.error?.retryable).toBe(true);
  });

  it("should handle tool failure gracefully", () => {
    const events: AiStreamEvent[] = [
      { type: "system", threadId: "t1", runId: "r1", messageId: "m1" },
      {
        type: "toolCall",
        threadId: "t1",
        runId: "r1",
        messageId: "m1",
        toolCall: { id: "tc1", name: "get_holdings", arguments: {} },
      },
      {
        type: "toolResult",
        threadId: "t1",
        runId: "r1",
        messageId: "m1",
        result: {
          toolCallId: "tc1",
          success: false,
          data: null,
          error: "Database connection failed",
        },
      },
      {
        type: "textDelta",
        threadId: "t1",
        runId: "r1",
        messageId: "m1",
        delta: "Sorry, I could not fetch your holdings.",
      },
      {
        type: "done",
        threadId: "t1",
        runId: "r1",
        messageId: "m1",
        message: {
          id: "m1",
          threadId: "t1",
          role: "assistant",
          content: textContent("Sorry, I could not fetch your holdings."),
          createdAt: "2024-01-15T10:00:00Z",
        },
      },
    ];

    const result = assembleTranscript(events);
    expect(result.toolResults[0].success).toBe(false);
    expect(result.toolResults[0].error).toBe("Database connection failed");
    expect(result.isComplete).toBe(true);
    expect(result.error).toBeNull(); // Stream completed, tool error is in result
  });

  it("should preserve event order for correct assembly", () => {
    const events: AiStreamEvent[] = [
      { type: "system", threadId: "t1", runId: "r1", messageId: "m1" },
      { type: "textDelta", threadId: "t1", runId: "r1", messageId: "m1", delta: "A" },
      { type: "textDelta", threadId: "t1", runId: "r1", messageId: "m1", delta: "B" },
      { type: "textDelta", threadId: "t1", runId: "r1", messageId: "m1", delta: "C" },
      { type: "textDelta", threadId: "t1", runId: "r1", messageId: "m1", delta: "D" },
      {
        type: "done",
        threadId: "t1",
        runId: "r1",
        messageId: "m1",
        message: {
          id: "m1",
          threadId: "t1",
          role: "assistant",
          content: textContent("ABCD"),
          createdAt: "2024-01-15T10:00:00Z",
        },
      },
    ];

    const result = assembleTranscript(events);
    expect(result.content).toBe("ABCD");
  });
});

// ============================================================================
// ChatThread Type Tests
// ============================================================================

describe("ChatThread type", () => {
  it("should represent a basic thread", () => {
    const thread: ChatThread = {
      id: "thread-123",
      title: "My Portfolio",
      isPinned: false,
      tags: [],
      createdAt: "2024-01-15T10:00:00Z",
      updatedAt: "2024-01-15T10:00:00Z",
    };

    expect(thread.id).toBe("thread-123");
    expect(thread.isPinned).toBe(false);
    expect(thread.tags).toHaveLength(0);
  });

  it("should represent a pinned thread with tags and config", () => {
    const thread: ChatThread = {
      id: "thread-456",
      title: "Important Analysis",
      isPinned: true,
      tags: ["portfolio", "analysis"],
      config: {
        schemaVersion: 1,
        providerId: "openai",
        modelId: "gpt-4o",
        promptTemplateId: "wealthfolio-assistant-v1",
        promptVersion: "1.0.0",
        locale: "en-US",
        toolsAllowlist: ["get_holdings", "get_accounts"],
      },
      createdAt: "2024-01-15T10:00:00Z",
      updatedAt: "2024-01-16T15:30:00Z",
    };

    expect(thread.isPinned).toBe(true);
    expect(thread.tags).toContain("portfolio");
    expect(thread.tags).toContain("analysis");
    expect(thread.config?.providerId).toBe("openai");
    expect(thread.config?.toolsAllowlist).toHaveLength(2);
  });
});

// ============================================================================
// ChatMessage Type Tests
// ============================================================================

describe("ChatMessage type", () => {
  it("should represent a user message", () => {
    const message: ChatMessage = {
      id: "msg-1",
      threadId: "thread-1",
      role: "user",
      content: textContent("What are my holdings?"),
      createdAt: "2024-01-15T10:00:00Z",
    };

    expect(message.role).toBe("user");
    expect(message.content.parts[0]).toEqual({ type: "text", content: "What are my holdings?" });
  });

  it("should represent an assistant message with tool calls", () => {
    const message: ChatMessage = {
      id: "msg-2",
      threadId: "thread-1",
      role: "assistant",
      content: {
        schemaVersion: 1,
        parts: [
          { type: "text", content: "Here are your holdings:" },
          {
            type: "toolCall",
            toolCallId: "tc-1",
            name: "get_holdings",
            arguments: { accountId: "all" },
          },
          {
            type: "toolResult",
            toolCallId: "tc-1",
            success: true,
            data: { holdings: [{ symbol: "AAPL", quantity: 100 }] },
            meta: { rowCount: 1 },
          },
        ],
      },
      createdAt: "2024-01-15T10:01:00Z",
    };

    expect(message.role).toBe("assistant");
    const toolCalls = message.content.parts.filter((p) => p.type === "toolCall");
    const toolResults = message.content.parts.filter((p) => p.type === "toolResult");
    expect(toolCalls).toHaveLength(1);
    expect(toolResults).toHaveLength(1);
    expect((toolResults[0] as { success: boolean }).success).toBe(true);
  });
});
