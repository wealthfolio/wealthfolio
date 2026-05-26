// AI Assistant Feature Types

import type { NewCategorizationRule } from "@/features/spending/types/rule";
import type { MergedProvider } from "@/lib/types";

// Re-export API types for convenience
export type {
  MergedProvider,
  MergedModel,
  AiProvidersResponse,
  ModelCapabilities,
  ModelCapabilityOverrides,
  ModelCapabilityOverrideUpdate,
  FetchedModel,
  ListModelsResponse,
  ProviderTuning,
  ProviderTuningOverrides,
} from "@/lib/types";

// ============================================================================
// Chat Thread Types
// ============================================================================

/**
 * Per-thread agent configuration snapshot.
 * Captures the model, prompt template, and tool allowlist at thread creation.
 * This enables deterministic replay and debugging of conversations.
 */
export interface AiThreadConfig {
  /** Schema version for backward compatibility */
  schemaVersion: number;
  /** Provider ID (e.g., "openai", "anthropic") */
  providerId: string;
  /** Model ID (e.g., "gpt-4o", "claude-3-sonnet") */
  modelId: string;
  /** Prompt template ID */
  promptTemplateId: string;
  /** Prompt template version */
  promptVersion: string;
  /** Locale for formatting and language */
  locale?: string;
  /** Detail level for responses */
  detailLevel?: string;
  /** Allowlist of tool names that can be used in this thread */
  toolsAllowlist?: string[];
}

export interface ChatThread {
  id: string;
  title: string;
  /** Whether this thread is pinned to the top of the list */
  isPinned: boolean;
  /** Tags for organizing and filtering threads */
  tags: string[];
  /** Per-thread agent configuration snapshot */
  config?: AiThreadConfig;
  createdAt: string;
  updatedAt: string;
}

/**
 * A single part of a message's content.
 * Maps to backend ChatMessagePart enum.
 */
export type ChatMessagePart =
  | { type: "system"; content: string }
  | { type: "text"; content: string }
  | { type: "reasoning"; content: string }
  | {
      type: "toolCall";
      toolCallId: string;
      name: string;
      arguments: Record<string, unknown>;
    }
  | {
      type: "toolResult";
      toolCallId: string;
      success: boolean;
      data: unknown;
      meta?: Record<string, unknown>;
      error?: string;
    }
  | { type: "error"; code: string; message: string };

/**
 * Structured message content from the backend.
 * Contains versioned parts array for forward compatibility.
 */
export interface ChatMessageContent {
  schemaVersion: number;
  parts: ChatMessagePart[];
  truncated?: boolean;
}

export interface ChatMessage {
  id: string;
  threadId: string;
  role: "user" | "assistant";
  /** Structured content with parts array */
  content: ChatMessageContent;
  createdAt: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  success: boolean;
  data: unknown;
  meta?: Record<string, unknown>;
  error?: string;
}

// ============================================================================
// AI Chat API Types (for adapter layer)
// ============================================================================

/**
 * Model configuration for AI chat requests.
 */
export interface AiChatModelConfig {
  /** Provider ID (e.g., "openai", "anthropic"). */
  provider?: string;
  /** Model ID (e.g., "gpt-4o", "claude-3-sonnet"). */
  model?: string;
  /** Override thinking/reasoning capability for this request. */
  thinking?: boolean;
}

/**
 * Request payload for sending an AI chat message.
 */
export interface AiSendMessageRequest {
  /** Thread ID (creates new thread if not provided). */
  threadId?: string;
  /** The message content. */
  content: string;
  /** Model configuration (provider and model selection). */
  config?: AiChatModelConfig;
  /** Override provider ID (uses default if not specified). @deprecated Use config.provider */
  providerId?: string;
  /** Override model ID (uses provider default if not specified). @deprecated Use config.model */
  modelId?: string;
  /** Tool allowlist for this request (uses all if not specified). */
  allowedTools?: string[];
  /** Parent message ID for edit operations. When set, AI context is truncated to this message. */
  parentMessageId?: string;
  /** File attachments (CSV, images, PDFs). */
  attachments?: AiMessageAttachment[];
}

/**
 * A file attachment sent with an AI chat message.
 */
export interface AiMessageAttachment {
  /** Original filename. */
  name: string;
  /** MIME type (e.g., "text/csv", "image/png", "application/pdf"). */
  contentType: string;
  /** File content: plain text for CSV, base64-encoded for images/PDFs. */
  data: string;
}

/**
 * AI thread structure from the backend API.
 */
export interface AiThread {
  id: string;
  title: string;
  isPinned: boolean;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Paginated response for AI threads.
 */
export interface ThreadPage {
  threads: AiThread[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * Request parameters for listing AI threads.
 */
export interface ListThreadsRequest {
  cursor?: string;
  limit?: number;
  search?: string;
}

// ============================================================================
// Stream Event Types (from backend)
// ============================================================================

/**
 * Base fields present in all stream events for correlation.
 */
interface AiStreamEventBase {
  /** Thread ID for this conversation */
  threadId: string;
  /** Run ID for this streaming session (uuid7) */
  runId: string;
}

/**
 * System event - sent first in the stream with metadata.
 */
interface SystemEvent extends AiStreamEventBase {
  type: "system";
  /** The message ID being generated */
  messageId: string;
}

/**
 * Text delta event - partial text content.
 */
interface TextDeltaEvent extends AiStreamEventBase {
  type: "textDelta";
  /** The message ID this delta belongs to */
  messageId: string;
  /** The text content delta */
  delta: string;
}

/**
 * Reasoning delta event - partial reasoning/thinking content (optional).
 */
interface ReasoningDeltaEvent extends AiStreamEventBase {
  type: "reasoningDelta";
  /** The message ID this delta belongs to */
  messageId: string;
  /** The reasoning content delta */
  delta: string;
}

/**
 * Tool call event - model wants to call a tool.
 */
interface ToolCallEvent extends AiStreamEventBase {
  type: "toolCall";
  /** The message ID this tool call belongs to */
  messageId: string;
  /** The tool call details (structured JSON) */
  toolCall: ToolCall;
}

/**
 * Tool result event - tool execution completed.
 */
interface ToolResultEvent extends AiStreamEventBase {
  type: "toolResult";
  /** The message ID this result belongs to */
  messageId: string;
  /** The tool result (structured JSON) */
  result: ToolResult;
}

/**
 * Error event - something went wrong.
 */
interface ErrorEvent extends AiStreamEventBase {
  type: "error";
  /** The message ID (if available) */
  messageId?: string;
  /** Error code for programmatic handling */
  code: string;
  /** Human-readable error message */
  message: string;
}

/**
 * Done event - stream completed (terminal).
 */
interface DoneEvent extends AiStreamEventBase {
  type: "done";
  /** The message ID of the completed message */
  messageId: string;
  /** The final complete message */
  message: ChatMessage;
  /** Usage statistics (if available) */
  usage?: UsageStats;
}

/**
 * Thread title updated event - emitted when the thread title is generated/updated.
 */
interface ThreadTitleUpdatedEvent extends AiStreamEventBase {
  type: "threadTitleUpdated";
  /** The new thread title */
  title: string;
}

/**
 * Token usage statistics.
 */
export interface UsageStats {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * Union type for all stream events.
 * All events include threadId, runId for correlation across reconnects.
 */
export type AiStreamEvent =
  | SystemEvent
  | TextDeltaEvent
  | ReasoningDeltaEvent
  | ToolCallEvent
  | ToolResultEvent
  | ErrorEvent
  | DoneEvent
  | ThreadTitleUpdatedEvent;

// ============================================================================
// UI State Types
// ============================================================================

/**
 * Error information for display in the UI.
 * Contains both a user-friendly message and error code for programmatic handling.
 */
export interface ChatError {
  /** Error code for programmatic handling (e.g., "missingApiKey", "providerError") */
  code: string;
  /** User-friendly error message */
  message: string;
  /** Whether the error is retryable */
  retryable: boolean;
}

/**
 * Maps error codes to user-friendly messages and retry eligibility.
 * Error codes come from the backend AiAssistantError enum.
 */
export const ERROR_CODE_MAP: Record<string, { message: string; retryable: boolean }> = {
  providerNotConfigured: {
    message: "AI provider is not configured. Please set up a provider in Settings.",
    retryable: false,
  },
  missingApiKey: {
    message: "API key is missing. Please add your API key in Settings.",
    retryable: false,
  },
  modelNotFound: {
    message: "The selected model is not available. Please choose a different model.",
    retryable: false,
  },
  toolNotFound: {
    message: "A required tool is not available. Please try again.",
    retryable: true,
  },
  toolNotAllowed: {
    message: "A tool is not allowed for this conversation. Please try again.",
    retryable: true,
  },
  toolExecutionError: {
    message: "A tool failed to execute. Please try again.",
    retryable: true,
  },
  providerError: {
    message: "The AI provider returned an error. Please try again.",
    retryable: true,
  },
  threadNotFound: {
    message: "Conversation not found. Please start a new conversation.",
    retryable: false,
  },
  invalidInput: {
    message: "Invalid input. Please check your message and try again.",
    retryable: false,
  },
  internal: {
    message: "An unexpected error occurred. Please try again.",
    retryable: true,
  },
  cancelled: {
    message: "Response was cancelled.",
    retryable: true,
  },
  network: {
    message: "Network error. Please check your connection and try again.",
    retryable: true,
  },
};

/**
 * Parse an error code and return a ChatError with user-friendly message.
 */
export function parseErrorCode(code: string, rawMessage?: string): ChatError {
  const mapped = ERROR_CODE_MAP[code];
  if (mapped) {
    return { code, message: mapped.message, retryable: mapped.retryable };
  }
  // Fallback for unknown error codes
  return {
    code,
    message: rawMessage ?? "An unexpected error occurred. Please try again.",
    retryable: true,
  };
}

export interface ChatState {
  threads: ChatThread[];
  activeThreadId: string | null;
  messages: ChatMessage[];
  isStreaming: boolean;
  streamingMessageId: string | null;
  error: ChatError | null;
}

export interface ProviderSettingsState {
  providers: MergedProvider[];
  isLoading: boolean;
  error: string | null;
}

// ============================================================================
// Type Aliases (for backward compatibility with adapter layer)
// ============================================================================

/** @alias ToolCall - for adapter layer compatibility */
export type AiToolCall = ToolCall;

/** @alias ToolResult - for adapter layer compatibility */
export type AiToolResult = ToolResult;

/** @alias ChatMessage - for adapter layer compatibility */
export type AiChatMessage = ChatMessage;

/** @alias UsageStats - for adapter layer compatibility */
export type AiUsageStats = UsageStats;

// ============================================================================
// Record Activities Tool Types
// ============================================================================

export interface RecordActivitiesIntent {
  activityType: string;
  symbol?: string;
  activityDate: string;
  quantity?: number;
  unitPrice?: number;
  amount?: number;
  fee?: number;
  account?: string;
  subtype?: string;
  notes?: string;
}

export interface RecordActivitiesArgs {
  activities: RecordActivitiesIntent[];
}

export interface RecordActivitiesValidationError {
  field: string;
  message: string;
}

export interface RecordActivitiesRowValidation {
  isValid: boolean;
  missingFields: string[];
  errors: RecordActivitiesValidationError[];
}

export interface RecordActivitiesDraft {
  activityType: string;
  activityDate: string;
  symbol?: string;
  assetId?: string;
  assetName?: string;
  quantity?: number;
  unitPrice?: number;
  amount?: number;
  fee?: number;
  currency: string;
  accountId?: string;
  accountName?: string;
  subtype?: string;
  notes?: string;
  priceSource: string;
  pricingMode: string;
  isCustomAsset: boolean;
  assetKind?: string;
}

export interface RecordActivitiesResolvedAsset {
  assetId: string;
  symbol: string;
  name: string;
  currency: string;
  exchange?: string;
  exchangeMic?: string;
  instrumentType?: string;
}

export interface RecordActivitiesSubtypeOption {
  value: string;
  label: string;
}

export interface RecordActivitiesAccountOption {
  id: string;
  name: string;
  currency: string;
}

export interface RecordActivitiesDraftRow {
  rowIndex: number;
  draft: RecordActivitiesDraft;
  validation: RecordActivitiesRowValidation;
  errors: string[];
  resolvedAsset?: RecordActivitiesResolvedAsset;
  availableSubtypes: RecordActivitiesSubtypeOption[];
}

export interface RecordActivitiesValidationSummary {
  totalRows: number;
  validRows: number;
  errorRows: number;
}

export interface RecordActivitiesSubmissionStatus {
  rowIndex: number;
  status: "submitted" | "error";
  error?: string;
}

export interface RecordActivitiesOutput {
  drafts: RecordActivitiesDraftRow[];
  validation: RecordActivitiesValidationSummary;
  availableAccounts: RecordActivitiesAccountOption[];
  resolvedAssets?: RecordActivitiesResolvedAsset[];
  submitted?: boolean;
  createdCount?: number;
  errorCount?: number;
  rowStatuses?: RecordActivitiesSubmissionStatus[];
  submittedAt?: string;
}

// ============================================================================
// Import CSV Tool Types — mapping-only output
// ============================================================================

/**
 * Rough confidence badge for the mapping returned by the AI.
 * - High: saved template hit OR all core fields mapped
 * - Medium: most core fields mapped
 * - Low: few core fields mapped — user likely needs to review mapping
 */
export type MappingConfidence = "HIGH" | "MEDIUM" | "LOW";

/**
 * Account option exposed to the chat tool UI.
 */
export interface ImportCsvAccountOption {
  id: string;
  name: string;
  currency: string;
  accountType?: string;
}

/**
 * Arguments the LLM provides when calling the import_csv tool.
 */
export interface ImportCsvArgs {
  csvContent: string;
  accountId?: string | null;
  fieldMappings?: Record<string, string> | null;
  activityMappings?: Record<string, string[]> | null;
  symbolMappings?: Record<string, string> | null;
  accountMappings?: Record<string, string> | null;
  delimiter?: string | null;
  skipTopRows?: number | null;
  skipBottomRows?: number | null;
  dateFormat?: string | null;
  decimalSeparator?: string | null;
  thousandsSeparator?: string | null;
  defaultCurrency?: string | null;
}

/**
 * Persisted patch applied via `updateToolResult` once the user confirms an import.
 */
export interface ImportCsvSubmissionResult {
  submitted?: boolean;
  importedCount?: number;
  importRunId?: string;
  submittedAt?: string;
}

/**
 * Output from the import_csv tool — mapping inference only.
 *
 * The chat tool UI uses this to drive the backend pipeline
 * (parse_csv → check_activities_import → import_activities). No drafts,
 * no validation, no normalization happens in the AI tool itself.
 *
 * Mirrors `crates/ai/src/tools/import_csv.rs::ImportCsvMappingOutput`.
 */
export interface ImportCsvMappingOutput extends ImportCsvSubmissionResult {
  /** CSV content read from tool ARGS (not echoed in result — avoids double-storing). */
  csvContent: string;
  /** The mapping the AI (or saved template) settled on. Same shape as manual import. */
  appliedMapping: import("@/lib/types").ImportMappingData;
  /** Parse config the frontend should use. */
  parseConfig: import("@/lib/types").ParseConfig;
  /** AI's inferred account (null if ambiguous — chat UI will prompt). */
  accountId?: string | null;
  /** Headers detected by parse_csv. */
  detectedHeaders: string[];
  /** First few data rows (≤10) for UI preview. */
  sampleRows: string[][];
  /** Total number of rows parsed (before truncation). */
  totalRows: number;
  /** Rough confidence for the mapping. */
  mappingConfidence: MappingConfidence;
  /** Accounts available for selection. */
  availableAccounts: ImportCsvAccountOption[];
  /** True when the mapping came from a saved template (no LLM inference). */
  usedSavedProfile?: boolean;
}

// ============================================================================
// Propose Transaction Categories tool
// ============================================================================

export interface ProposeCategoriesArgs {
  activityIds?: string[];
  accountIds?: string[];
  status?: "uncategorized" | "all" | "needs_review";
  startDate?: string;
  endDate?: string;
  limit?: number;
  aiProposals?: {
    activityId: string;
    taxonomyId: string;
    categoryKey: string;
    confidence?: number;
    reason?: string;
  }[];
}

export interface ListCategorizationContextArgs {
  activityIds?: string[];
  accountIds?: string[];
  status?: "uncategorized" | "all" | "needs_review";
  startDate?: string;
  endDate?: string;
  limit?: number;
}

export interface ListCategorizationContextOutput {
  taxonomies: ProposeTaxonomySummary[];
  examples: ProposeCategoryExample[];
  unproposed: ProposeCategoryUnproposed[];
  summary: {
    total: number;
    deterministicallyProposed: number;
    needsAiJudgement: number;
  };
}

export interface ProposeCategoryOption {
  categoryId: string;
  key: string;
  name: string;
  path: string;
  color: string;
}

export interface ProposeTaxonomySummary {
  taxonomyId: string;
  taxonomyName: string;
  categories: ProposeCategoryOption[];
}

export interface ProposeCategoryExample {
  categoryId: string;
  categoryPath: string;
  notes: string;
}

export interface ProposeCategoryProposal {
  activityId: string;
  activityDate: string;
  amount: number;
  currency: string;
  notes: string | null;
  taxonomyId: string;
  categoryId: string;
  categoryPath: string;
  confidence: number;
  source: "rule" | "history" | "ai" | "manual";
  explanation: string;
}

export interface ProposeCategoryUnproposed {
  activityId: string;
  activityDate: string;
  amount: number;
  currency: string;
  notes: string | null;
  reason: string;
}

export interface ProposeCategoriesSummary {
  total: number;
  proposed: number;
  unproposed: number;
  avgConfidence: number;
}

export interface ProposeCategoriesOutput {
  proposals: ProposeCategoryProposal[];
  unproposed: ProposeCategoryUnproposed[];
  summary: ProposeCategoriesSummary;
  taxonomies: ProposeTaxonomySummary[];
  examples: ProposeCategoryExample[];
  /** "draft" when awaiting review, "applied" after the user clicks Apply. */
  draftStatus?: "draft" | "applied";
  /** Frontend-applied state, persisted via updateToolResult. */
  submitted?: boolean;
  appliedCount?: number;
  submittedAt?: string;
}

// ============================================================================
// Create Categorization Rule tool
// ============================================================================

export interface CreateCategorizationRuleArgs {
  name?: string;
  pattern: string;
  matchType?: "contains" | "starts_with" | "exact" | "regex";
  taxonomyId: string;
  categoryKey: string;
  activityType?: string;
  accountId?: string;
}

export interface CreateCategorizationRuleOutput {
  draftStatus?: "draft" | "created";
  ruleId?: string | null;
  rule?: NewCategorizationRule;
  categoryPath?: string;
  accountName?: string | null;
  message?: string;
  submitted?: boolean;
  submittedAt?: string;
  ruleName?: string;
  pattern?: string;
  matchType?: string;
}
