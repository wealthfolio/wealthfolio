import i18n from "i18next";
import type { TFunction } from "i18next";
/**
 * Chat runtime hook for @assistant-ui/react integration.
 *
 * Uses useExternalStoreRuntime to integrate with database-backed thread storage.
 * Adapts the Wealthfolio AI streaming API to work with external message persistence.
 */

import {
  useExternalStoreRuntime,
  type ThreadMessageLike,
  type AppendMessage,
  type ExternalStoreAdapter,
  type AttachmentAdapter,
  type PendingAttachment,
  type CompleteAttachment,
} from "@assistant-ui/react";
import { useMemo, useCallback, useRef, useState } from "react";
import { useQueryClient, type InfiniteData } from "@tanstack/react-query";

import { streamChatResponse, type ChatModelConfig } from "../api";
import type { AiMessageAttachment, AiThread, ChatMessage, ChatThread, ThreadPage } from "../types";
import { QueryKeys } from "@/lib/query-keys";
import { generateId } from "@/lib/id";
import { AI_THREADS_KEY } from "./use-threads";
import { deleteAiThread, getAiThreadMessages, updateAiThread } from "@/adapters";
import { useHapticFeedback } from "@/hooks";

function deriveInitialThreadTitle(firstUserMessage: string): string {
  const normalized = firstUserMessage.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const maxChars = 50;
  if (normalized.length <= maxChars) return normalized;

  const truncated = normalized.slice(0, maxChars);
  const lastSpace = truncated.lastIndexOf(" ");
  const cut = lastSpace > maxChars / 2 ? truncated.slice(0, lastSpace) : truncated;
  return `${cut.trim()}...`;
}

/**
 * Extract error message from provider response.
 * Handles JSON error responses like:
 * - {"error":"message here"}
 * - {"error":{"message":"message here","type":"error_type"}}
 */
function extractErrorMessage(error: string): string {
  // Try to extract from "with message:" format first
  const messageMatch = /with message:\s*(.+)$/i.exec(error);
  const jsonStr = messageMatch?.[1] || error;

  // Try to parse as JSON
  try {
    // Find JSON object in the string
    const jsonMatch = /\{[\s\S]*\}/.exec(jsonStr);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      // Handle {"error":{"message":"..."}} format
      if (parsed.error?.message) {
        return parsed.error.message;
      }
      // Handle {"error":"..."} format
      if (typeof parsed.error === "string") {
        return parsed.error;
      }
      // Handle {"message":"..."} format
      if (parsed.message) {
        return parsed.message;
      }
    }
  } catch {
    // Not valid JSON, continue with string extraction
  }

  // Fallback: try simple regex for {"error":"..."}
  const simpleMatch = /"error":\s*"([^"]+)"/.exec(error);
  if (simpleMatch?.[1]) {
    return simpleMatch[1];
  }

  // Fallback: try regex for "message":"..."
  const msgMatch = /"message":\s*"([^"]+)"/.exec(error);
  if (msgMatch?.[1]) {
    return msgMatch[1];
  }

  return error;
}

/**
 * Format error messages with user-friendly copy and actionable guidance.
 */
export function formatErrorMessage(error: string, t: TFunction = i18n.t): string {
  const settingsLink = `[${t("ai:runtimeErrors.settingsLink")}](/settings/ai-providers)`;

  // First, extract the actual error message from nested formats
  const extractedError = extractErrorMessage(error);

  // Model doesn't support thinking (Ollama)
  if (extractedError.includes("does not support thinking")) {
    const modelMatch = /"([^"]+)"/.exec(extractedError);
    const modelName = modelMatch?.[1] || t("ai:runtimeErrors.thisModel");
    return t("ai:runtimeErrors.thinkingUnsupported", { settingsLink, modelName });
  }

  // Model not found errors
  if (extractedError.includes("not found") && extractedError.includes("model")) {
    const modelMatch = /model ['"]([^'"]+)['"]/i.exec(extractedError);
    const modelName = modelMatch?.[1] || t("ai:runtimeErrors.selectedModel");
    return t("ai:runtimeErrors.modelUnavailable", { settingsLink, modelName });
  }

  // Connection refused / provider not running
  if (extractedError.includes("Connection refused") || extractedError.includes("ECONNREFUSED")) {
    return t("ai:runtimeErrors.connectionRefused", { settingsLink });
  }

  // API key errors
  if (
    extractedError.includes("401") ||
    extractedError.includes("unauthorized") ||
    extractedError.includes("API key")
  ) {
    return t("ai:runtimeErrors.authentication", { settingsLink });
  }

  // Rate limit errors
  if (extractedError.includes("429") || extractedError.includes("rate limit")) {
    return t("ai:runtimeErrors.rateLimit");
  }

  // Timeout errors
  if (extractedError.includes("timeout") || extractedError.includes("ETIMEDOUT")) {
    return t("ai:runtimeErrors.timeout", { settingsLink });
  }

  // Generic provider error - use extracted message
  if (
    error.includes("Provider error") ||
    error.includes("CompletionError") ||
    error.includes("HttpError")
  ) {
    return t("ai:runtimeErrors.provider", { settingsLink, error: extractedError });
  }

  // Fallback for unknown errors
  return t("ai:runtimeErrors.unknown", { settingsLink, error: extractedError });
}

/**
 * A part of a message's content for the external store.
 * Preserves ordering from backend/streaming to render tool UIs inline.
 */
export type ExternalMessagePart =
  | { type: "text"; content: string }
  | { type: "reasoning"; content: string }
  | {
      type: "toolCall";
      toolCallId: string;
      name: string;
      arguments: Record<string, unknown>;
      result?: unknown;
      meta?: Record<string, unknown>;
    };

/**
 * Message stored in external state (matches DB format loosely).
 * Uses ordered parts array to preserve interleaved text/tool positions.
 */
export interface ExternalMessage {
  id: string;
  role: "user" | "assistant";
  parts: ExternalMessagePart[];
  createdAt: Date;
}

/**
 * JSON value types for tool arguments.
 */
type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue };
type JSONObject = Readonly<Record<string, JSONValue>>;

/**
 * Content part types for the runtime.
 */
type ContentPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      args: JSONObject;
      argsText: string;
      result?: unknown;
    };

/**
 * Thread list data for assistant-ui thread list adapter.
 */
interface ThreadListItemData {
  status: "regular";
  id: string;
  remoteId?: string;
  externalId?: string;
  title?: string;
}

/** Maximum attachment size in bytes (10 MB). */
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;

/** Accepted file types for the AI assistant. */
const ACCEPTED_FILE_TYPES =
  ".csv,text/csv,application/csv,image/png,image/jpeg,image/jpg,application/pdf";

/** Read a File as a base64 string (without the data: prefix). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      resolve(dataUrl.split(",")[1] ?? "");
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * Unified file attachment adapter for CSV, images, and PDFs.
 */
const fileAttachmentAdapter: AttachmentAdapter = {
  accept: ACCEPTED_FILE_TYPES,

  async add({ file }): Promise<PendingAttachment> {
    if (file.size > MAX_ATTACHMENT_SIZE) {
      throw new Error(`File "${file.name}" is too large (max 10 MB)`);
    }

    const isImage = file.type.startsWith("image/");
    return {
      id: generateId(),
      type: isImage ? "image" : "document",
      name: file.name,
      contentType: file.type || "application/octet-stream",
      file,
      status: { type: "requires-action", reason: "composer-send" },
    };
  },

  async remove(): Promise<void> {},

  async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
    const file = attachment.file;
    const isCsv =
      file.type === "text/csv" || file.type === "application/csv" || file.name.endsWith(".csv");
    const isImage = file.type.startsWith("image/");

    if (isCsv) {
      const csvText = await file.text();
      return {
        id: attachment.id,
        type: "document",
        name: attachment.name,
        contentType: "text/csv",
        status: { type: "complete" },
        content: [{ type: "text" as const, text: csvText }],
      };
    }

    // Images and PDFs: read as base64
    const base64 = await fileToBase64(file);
    return {
      id: attachment.id,
      type: isImage ? "image" : "document",
      name: attachment.name,
      contentType: attachment.contentType,
      status: { type: "complete" },
      content: isImage
        ? [{ type: "image" as const, image: `data:${file.type};base64,${base64}` }]
        : [{ type: "text" as const, text: base64 }],
    };
  },
};

/**
 * Convert a ChatMessage from the database to ExternalMessage format.
 * Preserves part ordering for inline tool UI rendering.
 */
export function convertToExternalMessage(msg: ChatMessage): ExternalMessage {
  const parts: ExternalMessagePart[] = [];
  // Map toolCallId -> part index for attaching results
  const toolCallIndexes = new Map<string, number>();

  for (const part of msg.content.parts) {
    switch (part.type) {
      case "text":
        parts.push({ type: "text", content: part.content });
        break;
      case "reasoning":
        parts.push({ type: "reasoning", content: part.content });
        break;
      case "toolCall":
        toolCallIndexes.set(part.toolCallId, parts.length);
        parts.push({
          type: "toolCall",
          toolCallId: part.toolCallId,
          name: part.name,
          arguments: part.arguments,
        });
        break;
      case "toolResult": {
        // Attach result to its corresponding toolCall part
        const idx = toolCallIndexes.get(part.toolCallId);
        if (idx !== undefined) {
          const tcPart = parts[idx];
          if (tcPart?.type === "toolCall") {
            tcPart.result = part.success
              ? part.meta
                ? { data: part.data, meta: part.meta }
                : part.data
              : { error: part.error };
            tcPart.meta = part.meta;
          }
        }
        break;
      }
      case "error":
        // A reply cut off by a provider error, shown as it was live.
        parts.push({ type: "text", content: formatErrorMessage(part.message) });
        break;
    }
  }

  return {
    id: msg.id,
    role: msg.role,
    parts,
    createdAt: new Date(msg.createdAt),
  };
}

function buildThreadListItems(threads: ChatThread[]): ThreadListItemData[] {
  return threads.map((thread) => ({
    status: "regular",
    id: thread.id,
    remoteId: thread.id,
    title: thread.title || undefined,
  }));
}

function areThreadListItemsEqual(
  prevItems: ThreadListItemData[],
  nextItems: ThreadListItemData[],
): boolean {
  if (prevItems.length !== nextItems.length) return false;
  for (let i = 0; i < prevItems.length; i += 1) {
    const prev = prevItems[i];
    const next = nextItems[i];
    if (!prev || !next) return false;
    if (prev.id !== next.id || prev.title !== next.title) return false;
  }
  return true;
}

/**
 * Convert external message to assistant-ui ThreadMessageLike format.
 * Preserves part ordering for inline tool UI rendering.
 */
function convertMessage(msg: ExternalMessage): ThreadMessageLike {
  const parts: ContentPart[] = [];

  // Convert parts in order to preserve interleaved text/tool positioning
  for (const part of msg.parts) {
    switch (part.type) {
      case "text":
        if (part.content.length > 0) {
          parts.push({ type: "text", text: part.content });
        }
        break;
      case "reasoning":
        if (part.content.length > 0) {
          parts.push({ type: "reasoning", text: part.content });
        }
        break;
      case "toolCall":
        parts.push({
          type: "tool-call",
          toolCallId: part.toolCallId,
          toolName: part.name,
          args: part.arguments as JSONObject,
          argsText: JSON.stringify(part.arguments, null, 2),
          result: part.result,
        });
        break;
    }
  }

  return {
    id: msg.id,
    role: msg.role,
    content: parts,
    createdAt: msg.createdAt,
  };
}

/**
 * Hook to create a chat runtime for use with AssistantRuntimeProvider.
 *
 * Uses useExternalStoreRuntime to integrate with database-backed threads.
 * Messages are loaded from DB when switching threads and new messages are
 * streamed through the Wealthfolio AI API.
 *
 * @param config - Optional model configuration (provider and model selection)
 * @returns A runtime instance for use with AssistantRuntimeProvider
 */
export function useChatRuntime(config?: ChatModelConfig) {
  const queryClient = useQueryClient();

  // External message state (from DB or streaming)
  const [messages, setMessages] = useState<ExternalMessage[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [currentThreadId, setCurrentThreadIdState] = useState<string | null>(null);
  const [switchingThreadId, setSwitchingThreadId] = useState<string | null>(null);
  const [threadListItems, setThreadListItems] = useState<ThreadListItemData[]>([]);
  const [isThreadListLoading, setIsThreadListLoading] = useState(false);

  // Thread ID ref - persists across streaming calls
  const threadIdRef = useRef<string | null>(null);

  // Parent message ID ref - set during edit to truncate AI context
  const editParentIdRef = useRef<string | null>(null);

  // Abort controller for cancelling streams
  const abortControllerRef = useRef<AbortController | null>(null);

  // Haptic feedback for streaming start
  const { triggerHapticPattern } = useHapticFeedback();
  const hapticTriggeredRef = useRef(false);

  const setCurrentThreadId = useCallback((threadId: string | null) => {
    threadIdRef.current = threadId;
    setCurrentThreadIdState(threadId);
  }, []);

  const setThreadTitleInCaches = useCallback(
    (threadId: string, title: string) => {
      // Update thread detail cache, if present.
      queryClient.setQueryData<ChatThread | null>(QueryKeys.aiThread(threadId), (old) =>
        old ? { ...old, title } : old,
      );

      // Update any cached thread list pages (base + search variants).
      queryClient.setQueriesData<InfiniteData<ThreadPage>>({ queryKey: AI_THREADS_KEY }, (old) => {
        if (!old?.pages?.length) return old;

        let changed = false;
        const pages = old.pages.map((page) => {
          let pageChanged = false;
          const threads = page.threads.map((t) => {
            if (t.id !== threadId) return t;
            if (t.title === title) return t;
            pageChanged = true;
            return { ...t, title };
          });
          if (!pageChanged) return page;
          changed = true;
          return { ...page, threads };
        });

        return changed ? { ...old, pages } : old;
      });
    },
    [queryClient],
  );

  const updateThreadListState = useCallback((threads: ChatThread[], isLoading: boolean) => {
    const nextItems = buildThreadListItems(threads);
    setThreadListItems((prevItems) =>
      areThreadListItemsEqual(prevItems, nextItems) ? prevItems : nextItems,
    );
    setIsThreadListLoading((prev) => (prev === isLoading ? prev : isLoading));
  }, []);

  // Handle new user message - streams response from AI backend
  const handleNew = useCallback(
    async (message: AppendMessage) => {
      // Extract text content from the message
      const textContent = message.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("\n");

      // Build structured attachment payloads for the backend
      const attachmentPayloads: AiMessageAttachment[] = [];
      const attachmentNames: string[] = [];
      if (message.attachments && message.attachments.length > 0) {
        for (const attachment of message.attachments) {
          attachmentNames.push(attachment.name);
          if (!attachment.content) continue;

          const isCsv =
            attachment.contentType === "text/csv" ||
            attachment.contentType === "application/csv" ||
            attachment.name.endsWith(".csv");
          const isImage = attachment.contentType?.startsWith("image/");

          if (isCsv) {
            // CSV: content stored as text part (plain text)
            const csvText = attachment.content
              .filter((c): c is { type: "text"; text: string } => c.type === "text")
              .map((c) => c.text)
              .join("\n");
            if (csvText) {
              attachmentPayloads.push({
                name: attachment.name,
                contentType: "text/csv",
                data: csvText,
              });
            }
          } else if (isImage) {
            // Image: content stored as image part (data URL with base64)
            const imgContent = attachment.content.find(
              (c): c is { type: "image"; image: string } => c.type === "image",
            );
            if (imgContent) {
              const raw = imgContent.image.includes(",")
                ? imgContent.image.split(",")[1]!
                : imgContent.image;
              attachmentPayloads.push({
                name: attachment.name,
                contentType: attachment.contentType ?? "image/png",
                data: raw,
              });
            }
          } else {
            // PDF and other binary: content stored as text part (base64)
            const b64Content = attachment.content.find(
              (c): c is { type: "text"; text: string } => c.type === "text",
            );
            if (b64Content) {
              attachmentPayloads.push({
                name: attachment.name,
                contentType: attachment.contentType ?? "application/octet-stream",
                data: b64Content.text,
              });
            }
          }
        }
      }

      // Text content only — attachments sent separately in structured field
      const contentForAi = textContent;
      const hasContent = contentForAi.trim() || attachmentPayloads.length > 0;
      if (!hasContent) return;
      const initialThreadTitle = deriveInitialThreadTitle(
        textContent || attachmentNames[0] || "New chat",
      );

      // Build user message parts - show text and attachment indicator separately
      const userMessageParts: ExternalMessagePart[] = [];
      if (textContent.trim()) {
        userMessageParts.push({ type: "text", content: textContent });
      }
      // Add attachment indicator for display (not the full CSV content)
      for (const name of attachmentNames) {
        userMessageParts.push({ type: "text", content: `📎 ${name}` });
      }

      // Create user message for UI display
      const userMessage: ExternalMessage = {
        id: generateId(),
        role: "user",
        parts:
          userMessageParts.length > 0 ? userMessageParts : [{ type: "text", content: "(empty)" }],
        createdAt: new Date(),
      };

      // Add user message to state
      setMessages((prev) => [...prev, userMessage]);

      // Create placeholder assistant message
      const assistantMessageId = generateId();
      const assistantMessage: ExternalMessage = {
        id: assistantMessageId,
        role: "assistant",
        parts: [],
        createdAt: new Date(),
      };

      setMessages((prev) => [...prev, assistantMessage]);
      setIsRunning(true);

      // Create abort controller
      abortControllerRef.current = new AbortController();
      const { signal } = abortControllerRef.current;

      // Streaming state - ordered parts array preserves interleaved text/tool positions
      // We track indexes for text/reasoning to append deltas, and toolCallId -> index for results
      const streamParts: ExternalMessagePart[] = [];
      let textPartIndex: number | null = null;
      let reasoningPartIndex: number | null = null;
      const toolCallIndexes = new Map<string, number>();

      // RAF-based throttling to batch rapid updates (prevents 100s of re-renders)
      let rafId: number | null = null;
      let updatePending = false;

      const flushUpdate = () => {
        rafId = null;
        updatePending = false;

        setMessages((prev) => {
          const updated = [...prev];
          const idx = updated.findIndex((m) => m.id === assistantMessageId);
          if (idx !== -1) {
            updated[idx] = {
              ...updated[idx],
              parts: [...streamParts],
            };
          }
          return updated;
        });
      };

      const updateAssistantMessage = () => {
        updatePending = true;
        if (rafId === null) {
          rafId = requestAnimationFrame(flushUpdate);
        }
      };

      try {
        for await (const event of streamChatResponse(
          {
            content: contentForAi,
            config,
            threadId: threadIdRef.current ?? undefined,
            parentMessageId: editParentIdRef.current ?? undefined,
            attachments: attachmentPayloads.length > 0 ? attachmentPayloads : undefined,
          },
          signal,
        )) {
          if (signal.aborted) break;

          // Replace a part with a new object so downstream memoization can detect changes
          // by reference instead of deep-comparing content. Other unchanged parts keep
          // their identity, allowing memoized tool UIs to skip re-renders during text streaming.
          const replacePart = (index: number, next: ExternalMessagePart) => {
            streamParts[index] = next;
          };

          switch (event.type) {
            case "system":
              // Capture thread ID from system event
              if (event.threadId) {
                const newThreadId = event.threadId;
                setCurrentThreadId(newThreadId);

                // Optimistically add the new thread to the cache immediately
                // This ensures the thread appears in the sidebar right away
                queryClient.setQueryData<InfiniteData<ThreadPage>>(AI_THREADS_KEY, (old) => {
                  // Create placeholder thread - title will be updated when title generation completes
                  const placeholderThread: AiThread = {
                    id: newThreadId,
                    title: initialThreadTitle,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    isPinned: false,
                    tags: [],
                  };

                  if (!old?.pages?.length) {
                    // No existing data - create initial structure with the new thread
                    return {
                      pages: [
                        {
                          threads: [placeholderThread],
                          nextCursor: null,
                          hasMore: false,
                        },
                      ],
                      pageParams: [undefined],
                    };
                  }

                  // Check if thread already exists in any page
                  const threadExists = old.pages.some((page) =>
                    page.threads.some((t) => t.id === newThreadId),
                  );
                  if (threadExists) return old;

                  // Add new thread to the beginning of the first page
                  const newPages = [...old.pages];
                  if (newPages[0]) {
                    newPages[0] = {
                      ...newPages[0],
                      threads: [placeholderThread, ...newPages[0].threads],
                    };
                  }

                  return { ...old, pages: newPages };
                });
                // Don't invalidate here - it would overwrite optimistic update with stale data
                // The title will be updated when the stream completes via invalidation in "done" handler
              }
              break;

            case "threadTitleUpdated": {
              const nextTitle = event.title?.trim();
              if (event.threadId && nextTitle) {
                setThreadTitleInCaches(event.threadId, nextTitle);
              }
              break;
            }

            case "textDelta":
              // Trigger haptic pattern when streaming starts (first text delta)
              if (!hapticTriggeredRef.current) {
                hapticTriggeredRef.current = true;
                triggerHapticPattern(3, 80);
              }
              // Append to existing text part or create new one
              if (textPartIndex !== null) {
                const part = streamParts[textPartIndex];
                if (part?.type === "text") {
                  replacePart(textPartIndex, {
                    type: "text",
                    content: part.content + event.delta,
                  });
                }
              } else {
                textPartIndex = streamParts.length;
                streamParts.push({ type: "text", content: event.delta });
              }
              reasoningPartIndex = null;
              updateAssistantMessage();
              break;

            case "reasoningDelta":
              // Append to existing reasoning part or create new one
              if (reasoningPartIndex !== null) {
                const part = streamParts[reasoningPartIndex];
                if (part?.type === "reasoning") {
                  replacePart(reasoningPartIndex, {
                    type: "reasoning",
                    content: part.content + event.delta,
                  });
                }
              } else {
                reasoningPartIndex = streamParts.length;
                streamParts.push({ type: "reasoning", content: event.delta });
              }
              textPartIndex = null;
              updateAssistantMessage();
              break;

            case "toolCall":
              // Add tool call part and track its index for result attachment
              toolCallIndexes.set(event.toolCall.id, streamParts.length);
              streamParts.push({
                type: "toolCall",
                toolCallId: event.toolCall.id,
                name: event.toolCall.name,
                arguments: event.toolCall.arguments,
              });
              // Reset text part index so subsequent text appears after this tool
              textPartIndex = null;
              reasoningPartIndex = null;
              updateAssistantMessage();
              break;

            case "toolResult": {
              // Attach result to its corresponding toolCall part
              const tcIdx = toolCallIndexes.get(event.result.toolCallId);
              if (tcIdx !== undefined) {
                const part = streamParts[tcIdx];
                if (part?.type === "toolCall") {
                  const nextResult = event.result.success
                    ? event.result.meta
                      ? { data: event.result.data, meta: event.result.meta }
                      : event.result.data
                    : { error: event.result.error };
                  replacePart(tcIdx, {
                    ...part,
                    result: nextResult,
                    meta: event.result.meta,
                  });
                }
              }
              updateAssistantMessage();
              break;
            }

            case "done":
              // The streamParts array already has all content in order
              // Just invalidate threads to refresh from DB (updates title if generated)
              setTimeout(() => {
                queryClient.invalidateQueries({ queryKey: AI_THREADS_KEY });
              }, 1000);
              break;

            case "error":
              console.error("Stream error:", event.message);
              // Show formatted error to user in the assistant message
              streamParts.push({
                type: "text",
                content: formatErrorMessage(event.message),
              });
              updateAssistantMessage();
              break;
          }
        }
      } catch (error) {
        if (!signal.aborted) {
          console.error("Streaming error:", error);
          // Show formatted error to user in the assistant message
          const errorMessage = error instanceof Error ? error.message : String(error);
          streamParts.push({
            type: "text",
            content: formatErrorMessage(errorMessage),
          });
          updateAssistantMessage();
        }
      } finally {
        // Cancel pending RAF and flush any remaining updates
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
        if (updatePending) {
          flushUpdate();
        }
        setIsRunning(false);
        abortControllerRef.current = null;
      }
    },
    [config, queryClient, setCurrentThreadId, setThreadTitleInCaches],
  );

  // Handle cancel
  const handleCancel = useCallback(async () => {
    abortControllerRef.current?.abort();
  }, []);

  // Handle message edit - truncate history to parent, then re-run
  const handleEdit = useCallback(
    async (message: AppendMessage) => {
      setMessages((prev) => {
        const parentIndex = prev.findIndex((m) => m.id === message.parentId);
        return parentIndex >= 0 ? prev.slice(0, parentIndex + 1) : [];
      });
      editParentIdRef.current = message.parentId ?? null;
      await handleNew(message);
      editParentIdRef.current = null;
    },
    [handleNew],
  );

  const handleSwitchToNewThread = useCallback(async () => {
    await handleCancel();
    setCurrentThreadId(null);
    setMessages([]);
  }, [handleCancel, setCurrentThreadId]);

  const handleSwitchToThread = useCallback(
    async (threadId: string) => {
      if (threadId === threadIdRef.current || switchingThreadId) return;

      setSwitchingThreadId(threadId);
      await handleCancel();

      try {
        const dbMessages = await getAiThreadMessages(threadId);
        const externalMessages = dbMessages.map(convertToExternalMessage);
        setMessages(externalMessages);
        setCurrentThreadId(threadId);
      } catch (error) {
        console.error("Failed to load thread:", error);
        throw error;
      } finally {
        setSwitchingThreadId(null);
      }
    },
    [handleCancel, setCurrentThreadId, switchingThreadId],
  );

  const handleRenameThread = useCallback(
    async (threadId: string, newTitle: string) => {
      try {
        const updatedThread = await updateAiThread({ id: threadId, title: newTitle });
        queryClient.setQueryData(QueryKeys.aiThread(updatedThread.id), updatedThread);
        queryClient.invalidateQueries({ queryKey: AI_THREADS_KEY });
      } catch (error) {
        console.error("Failed to rename thread:", error);
        throw error;
      }
    },
    [queryClient],
  );

  const handleDeleteThread = useCallback(
    async (threadId: string) => {
      try {
        await deleteAiThread(threadId);
        queryClient.invalidateQueries({ queryKey: AI_THREADS_KEY });
        queryClient.removeQueries({ queryKey: QueryKeys.aiThread(threadId) });

        if (threadIdRef.current === threadId) {
          await handleSwitchToNewThread();
        }
      } catch (error) {
        console.error("Failed to delete thread:", error);
        throw error;
      }
    },
    [handleSwitchToNewThread, queryClient],
  );

  // Wrapper for setMessages that accepts readonly arrays
  const handleSetMessages = useCallback((newMessages: readonly ExternalMessage[]) => {
    setMessages([...newMessages]);
  }, []);

  // Build the external store adapter
  const adapter = useMemo<ExternalStoreAdapter<ExternalMessage>>(
    () => ({
      isRunning,
      messages,
      setMessages: handleSetMessages,
      convertMessage,
      onNew: handleNew,
      onEdit: handleEdit,
      onCancel: handleCancel,
      adapters: {
        attachments: fileAttachmentAdapter,
        threadList: {
          threadId: currentThreadId ?? undefined,
          isLoading: isThreadListLoading,
          threads: threadListItems,
          onSwitchToThread: handleSwitchToThread,
          onSwitchToNewThread: handleSwitchToNewThread,
          onRename: handleRenameThread,
          onDelete: handleDeleteThread,
        },
      },
    }),
    [
      isRunning,
      messages,
      handleSetMessages,
      handleNew,
      handleEdit,
      handleCancel,
      currentThreadId,
      isThreadListLoading,
      threadListItems,
      handleSwitchToThread,
      handleSwitchToNewThread,
      handleRenameThread,
      handleDeleteThread,
    ],
  );

  const runtime = useExternalStoreRuntime(adapter);

  // Extended API for thread management
  return useMemo(
    () => ({
      ...runtime,
      currentThreadId,
      switchingThreadId,
      setThreadListState: updateThreadListState,
      /** Load messages for a thread from the database */
      loadThread: async (threadId: string, dbMessages: ExternalMessage[]) => {
        setCurrentThreadId(threadId);
        setMessages(dbMessages);
      },
      /** Start a new thread (clears messages and thread ID) */
      startNewThread: () => {
        handleSwitchToNewThread();
      },
      /** Get current thread ID */
      getCurrentThreadId: () => threadIdRef.current,
    }),
    [
      runtime,
      currentThreadId,
      switchingThreadId,
      updateThreadListState,
      setCurrentThreadId,
      handleSwitchToNewThread,
    ],
  );
}

/**
 * Type for the extended runtime returned by useChatRuntime.
 */
export type ChatRuntime = ReturnType<typeof useChatRuntime>;
