import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";

import {
  checkActivitiesImport,
  createAsset,
  importActivities,
  logger,
  parseCsv,
  previewImportAssets,
  saveAccountImportMapping,
  updateToolResult,
} from "@/adapters";
import { draftToActivityImport } from "@/pages/activity/import/utils/draft-utils";
import type {
  ActivityImport,
  ImportAssetPreviewItem,
  ImportMappingData,
  NewAsset,
  ParseConfig,
  ParsedCsvResult,
} from "@/lib/types";
import type { DraftActivity, DraftActivityStatus } from "@/pages/activity/import/context";
import {
  applyAssetResolution,
  buildImportAssetCandidateFromDraft,
  buildNewAssetFromDraft,
} from "@/pages/activity/import/utils/asset-review-utils";
import { createDraftActivities, validateDraft } from "@/pages/activity/import/utils/draft-utils";

import type { ImportCsvMappingOutput } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ChatImportFilter = "all" | "valid" | "warning" | "error" | "duplicate" | "skipped";

export interface ChatImportStats {
  total: number;
  valid: number;
  warning: number;
  errors: number;
  duplicates: number;
  skipped: number;
  toImport: number;
}

interface ChatImportState {
  status: "initializing" | "ready" | "submitting" | "submitted" | "error";
  drafts: DraftActivity[];
  assetPreviewItems: ImportAssetPreviewItem[];
  createdAssetIdsByKey: Record<string, string>;
  filter: ChatImportFilter;
  accountId: string;
  error: string | null;
  importedCount: number;
}

type Action =
  | {
      type: "INIT_OK";
      payload: {
        drafts: DraftActivity[];
        assetPreviewItems: ImportAssetPreviewItem[];
        accountId: string;
      };
    }
  | { type: "INIT_ERROR"; payload: string }
  | { type: "SET_DRAFTS"; payload: DraftActivity[] }
  | { type: "MERGE_CREATED_ASSET_IDS"; payload: Record<string, string> }
  | {
      type: "BULK_UPDATE";
      payload: { rowIndexes: number[]; updates: Partial<DraftActivity> };
    }
  | { type: "SET_PREVIEW"; payload: ImportAssetPreviewItem[] }
  | { type: "SET_FILTER"; payload: ChatImportFilter }
  | { type: "SET_ACCOUNT"; payload: string }
  | { type: "UPDATE_DRAFT"; payload: { rowIndex: number; updates: Partial<DraftActivity> } }
  | { type: "SUBMITTING" }
  | { type: "SUBMITTED"; payload: number }
  | { type: "ERROR"; payload: string };

const INITIAL_STATE: ChatImportState = {
  status: "initializing",
  drafts: [],
  assetPreviewItems: [],
  createdAssetIdsByKey: {},
  filter: "all",
  accountId: "",
  error: null,
  importedCount: 0,
};

function reducer(state: ChatImportState, action: Action): ChatImportState {
  switch (action.type) {
    case "INIT_OK":
      return {
        ...state,
        status: "ready",
        drafts: action.payload.drafts,
        assetPreviewItems: action.payload.assetPreviewItems,
        createdAssetIdsByKey: {},
        accountId: action.payload.accountId,
        error: null,
      };
    case "INIT_ERROR":
      return { ...state, status: "error", error: action.payload };
    case "SET_DRAFTS":
      return {
        ...state,
        drafts: action.payload,
        status: state.status === "error" ? "ready" : state.status,
        error: state.status === "error" ? null : state.error,
      };
    case "MERGE_CREATED_ASSET_IDS":
      return {
        ...state,
        createdAssetIdsByKey: {
          ...state.createdAssetIdsByKey,
          ...action.payload,
        },
      };
    case "SET_PREVIEW":
      return { ...state, assetPreviewItems: action.payload };
    case "SET_FILTER":
      return { ...state, filter: action.payload };
    case "SET_ACCOUNT":
      return {
        ...state,
        accountId: action.payload,
        // Propagate the new account AND clear the "Account is required"
        // validation error so the revalidate roundtrip doesn't trail behind
        // the UI. Other errors (symbol/date/amount) are preserved.
        drafts: state.drafts.map((d) => {
          const nextErrors = { ...(d.errors ?? {}) };
          delete nextErrors.accountId;
          return { ...d, accountId: action.payload, errors: nextErrors };
        }),
      };
    case "UPDATE_DRAFT": {
      return {
        ...state,
        // Clear any previous confirm error — user is actively editing so
        // the old error is stale. Also reset status to "ready" so the
        // Confirm button re-enables.
        status: state.status === "error" ? "ready" : state.status,
        error: state.status === "error" ? null : state.error,
        drafts: state.drafts.map((d) => {
          if (d.rowIndex !== action.payload.rowIndex) return d;
          const merged = { ...d, ...action.payload.updates, isEdited: true };
          const v = validateDraft(merged);
          return {
            ...merged,
            status: merged.status === "skipped" ? "skipped" : v.status,
            errors: v.errors,
            warnings: { ...(merged.warnings ?? {}), ...v.warnings },
          };
        }),
      };
    }
    case "BULK_UPDATE": {
      const indexSet = new Set(action.payload.rowIndexes);
      return {
        ...state,
        status: state.status === "error" ? "ready" : state.status,
        error: state.status === "error" ? null : state.error,
        drafts: state.drafts.map((d) => {
          if (!indexSet.has(d.rowIndex)) return d;
          const merged = { ...d, ...action.payload.updates };
          if (merged.status === "skipped") return merged;
          const v = validateDraft(merged);
          return { ...merged, status: v.status, errors: v.errors, warnings: v.warnings };
        }),
      };
    }
    case "SUBMITTING":
      return { ...state, status: "submitting", error: null };
    case "SUBMITTED":
      return { ...state, status: "submitted", importedCount: action.payload };
    case "ERROR":
      return { ...state, status: "error", error: action.payload };
    default:
      return state;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wrap a string of CSV content as a File so it flows through the existing
 * `parseCsv` adapter (which expects a File to cover both tauri + web paths).
 */
function csvStringAsFile(csvContent: string, name = "import.csv"): File {
  return new File([csvContent], name, { type: "text/csv" });
}

function applyCreatedAssetIdsToDrafts(
  drafts: DraftActivity[],
  createdAssetIdsByKey: Record<string, string>,
): DraftActivity[] {
  if (Object.keys(createdAssetIdsByKey).length === 0) {
    return drafts;
  }

  return drafts.map((draft) => {
    if (draft.assetId) {
      return draft;
    }
    const key = draft.importAssetKey || draft.assetCandidateKey;
    const assetId = key ? createdAssetIdsByKey[key] : undefined;
    if (!assetId) {
      return draft;
    }
    return {
      ...draft,
      assetId,
      importAssetKey: undefined,
    };
  });
}

/**
 * Count how many of the AI's field mappings reference headers that actually
 * exist in the parsed CSV. If the match rate is below 2, the AI's skipTopRows
 * (or similar config) likely shifted the parse window and the field mappings
 * are stale — we should re-run auto-detect against the actual parsed headers.
 */
const CORE_FIELDS = ["date", "activityType", "symbol", "quantity", "unitPrice", "amount"];

function countFieldMappingHits(
  fieldMappings: Record<string, unknown>,
  parsedHeaders: string[],
): number {
  const headerSet = new Set(parsedHeaders);
  let hits = 0;
  for (const field of CORE_FIELDS) {
    const value = fieldMappings[field];
    if (!value) continue;
    if (typeof value === "string" && headerSet.has(value)) hits++;
    if (Array.isArray(value) && value.some((v) => headerSet.has(v))) hits++;
  }
  return hits;
}

/**
 * Simple frontend auto-detect: match headers to common patterns.
 * Mirrors the Rust `auto_detect_field_mappings` so the frontend can
 * self-heal when the AI's parse config was wrong.
 */
const HEADER_PATTERNS: [string, string[]][] = [
  ["date", ["date", "trade date", "activity date", "transaction date", "settlement date"]],
  [
    "activityType",
    ["type", "activity type", "transaction type", "action", "activity", "operation"],
  ],
  ["symbol", ["symbol", "ticker", "stock", "security", "asset", "instrument"]],
  ["quantity", ["quantity", "qty", "shares", "units", "volume"]],
  ["unitPrice", ["price", "unit price", "share price", "cost per share", "avg price"]],
  [
    "amount",
    ["total", "amount", "value", "net amount", "gross amount", "market value", "proceeds", "cost"],
  ],
  ["currency", ["currency", "ccy", "currency code"]],
  ["fee", ["fee", "fees", "commission", "commissions"]],
  ["account", ["account", "account id", "account name", "portfolio"]],
  ["comment", ["comment", "comments", "note", "notes", "description", "memo"]],
  ["fxRate", ["fx rate", "exchange rate", "forex rate"]],
  ["subtype", ["subtype", "sub type"]],
];

function autoDetectFieldMappings(headers: string[]): Record<string, string> {
  const mappings: Record<string, string> = {};
  const used = new Set<string>();
  for (const [field, patterns] of HEADER_PATTERNS) {
    for (const header of headers) {
      if (used.has(header)) continue;
      const lower = header.toLowerCase();
      if (patterns.some((p) => lower === p || lower.includes(p))) {
        mappings[field] = header;
        used.add(header);
        break;
      }
    }
  }
  return mappings;
}

/**
 * Normalize a ParseConfig coming from the Rust tool (may contain `null` values
 * for optional fields) into the frontend's defaults-filled shape.
 */
function normalizeParseConfig(input: ParseConfig): ParseConfig {
  return {
    hasHeaderRow: input.hasHeaderRow ?? true,
    headerRowIndex: input.headerRowIndex ?? 0,
    delimiter: input.delimiter ?? "auto",
    quoteChar: input.quoteChar ?? '"',
    skipTopRows: input.skipTopRows ?? 0,
    skipBottomRows: input.skipBottomRows ?? 0,
    skipEmptyRows: input.skipEmptyRows ?? true,
    dateFormat: input.dateFormat ?? "auto",
    decimalSeparator: input.decimalSeparator ?? "auto",
    thousandsSeparator: input.thousandsSeparator ?? "auto",
    defaultCurrency: input.defaultCurrency ?? "USD",
  };
}

function resolveAvailableAccountId(
  value: string | null | undefined,
  accounts: ImportCsvMappingOutput["availableAccounts"],
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;

  return (
    accounts.find((account) => account.id === trimmed)?.id ??
    accounts.find((account) => account.name.toLowerCase() === trimmed.toLowerCase())?.id
  );
}

function normalizeAccountMappings(
  mappings: Record<string, string>,
  accounts: ImportCsvMappingOutput["availableAccounts"],
): Record<string, string> {
  const normalized: Record<string, string> = {};

  for (const account of accounts) {
    normalized[account.id] = account.id;
    normalized[account.name] = account.id;
    normalized[account.name.toLowerCase()] = account.id;
  }

  for (const [rawValue, mappedValue] of Object.entries(mappings)) {
    const key = rawValue.trim();
    if (!key) continue;

    const accountId =
      resolveAvailableAccountId(mappedValue, accounts) ?? resolveAvailableAccountId(key, accounts);
    if (accountId) {
      normalized[key] = accountId;
    }
  }

  return normalized;
}

/**
 * Merge backend check results (errors, warnings, duplicates, enrichment) into
 * the local drafts. Matches the manual wizard's validate flow, minus the
 * dispatch plumbing.
 */
function mergeIssueMaps(
  current: Record<string, string[]>,
  incoming: Record<string, string[]>,
): Record<string, string[]> {
  const merged: Record<string, string[]> = { ...current };
  for (const [key, messages] of Object.entries(incoming)) {
    const existing = merged[key] ?? [];
    const next = [...existing];
    for (const message of messages) {
      if (!next.includes(message)) next.push(message);
    }
    merged[key] = next;
  }
  return merged;
}

function applyBackendValidation(
  drafts: DraftActivity[],
  validated: ActivityImport[],
): DraftActivity[] {
  return drafts.map((draft) => {
    const localValidation = validateDraft(draft);
    const backendResult = validated.find((v) => v.lineNumber === draft.rowIndex + 1);
    if (!backendResult) {
      return {
        ...draft,
        errors: localValidation.errors,
        warnings: localValidation.warnings,
        duplicateOfId: undefined,
        duplicateOfLineNumber: undefined,
        status: draft.status === "skipped" ? "skipped" : localValidation.status,
      };
    }

    const backendErrors: Record<string, string[]> = {};
    if (backendResult.errors) {
      for (const [key, value] of Object.entries(backendResult.errors)) {
        backendErrors[key] = Array.isArray(value) ? value : [String(value)];
      }
    }
    const backendWarnings: Record<string, string[]> = {};
    if (backendResult.warnings) {
      for (const [key, value] of Object.entries(backendResult.warnings)) {
        backendWarnings[key] = Array.isArray(value) ? value : [String(value)];
      }
    }
    if (!backendResult.isValid && Object.keys(backendErrors).length === 0) {
      backendErrors.general = ["Validation failed"];
    }

    const mergedErrors = mergeIssueMaps(localValidation.errors, backendErrors);
    const mergedWarnings = mergeIssueMaps(localValidation.warnings, backendWarnings);
    const hasErrors = Object.keys(mergedErrors).length > 0;
    const hasWarnings = Object.keys(mergedWarnings).length > 0;

    const newStatus: DraftActivityStatus =
      draft.status === "skipped"
        ? draft.status
        : hasErrors
          ? "error"
          : backendResult.duplicateOfLineNumber !== undefined ||
              backendResult.duplicateOfId !== undefined ||
              backendWarnings._duplicate?.length
            ? "duplicate"
            : hasWarnings
              ? "warning"
              : "valid";

    return {
      ...draft,
      assetId: backendResult.assetId,
      errors: mergedErrors,
      warnings: mergedWarnings,
      duplicateOfId: backendResult.duplicateOfId,
      duplicateOfLineNumber: backendResult.duplicateOfLineNumber,
      symbolName: backendResult.symbolName,
      exchangeMic: backendResult.exchangeMic,
      quoteCcy: backendResult.quoteCcy,
      instrumentType: backendResult.instrumentType,
      providerId: backendResult.providerId,
      providerSymbol: backendResult.providerSymbol,
      status: newStatus,
      // Preserve forceImport if the user explicitly set it. Clearing it
      // only when status changes away from "duplicate" would force the
      // user to re-select + force-import after every revalidation cycle.
      forceImport: draft.forceImport ?? false,
    } as DraftActivity;
  });
}

function buildActivitiesToValidate(
  drafts: DraftActivity[],
  defaultCurrency: string,
): ActivityImport[] {
  return drafts
    .filter((d) => d.status !== "skipped" && d.activityType)
    .map(
      (draft) =>
        ({
          accountId: draft.accountId,
          activityType: (draft.activityType || "UNKNOWN") as ActivityImport["activityType"],
          date: draft.activityDate || "",
          symbol: draft.symbol || "",
          assetId: draft.assetId,
          exchangeMic: draft.exchangeMic,
          quoteCcy: draft.quoteCcy,
          instrumentType: draft.instrumentType,
          quoteMode: draft.quoteMode as ActivityImport["quoteMode"],
          providerId: draft.providerId,
          providerSymbol: draft.providerSymbol,
          isin: draft.isin,
          quantity: draft.quantity,
          unitPrice: draft.unitPrice,
          amount: draft.amount,
          currency: draft.currency || defaultCurrency,
          fee: draft.fee,
          isDraft: true,
          isValid:
            draft.status === "valid" ||
            draft.status === "warning" ||
            (draft.status === "duplicate" && !!draft.forceImport),
          lineNumber: draft.rowIndex + 1,
          comment: draft.comment,
          fxRate: draft.fxRate,
          subtype: draft.subtype,
          forceImport: draft.forceImport ?? false,
        }) satisfies Partial<ActivityImport>,
    ) as ActivityImport[];
}

function computeStats(drafts: DraftActivity[]): ChatImportStats {
  const stats: ChatImportStats = {
    total: drafts.length,
    valid: 0,
    warning: 0,
    errors: 0,
    duplicates: 0,
    skipped: 0,
    toImport: 0,
  };
  for (const d of drafts) {
    switch (d.status) {
      case "valid":
        stats.valid++;
        stats.toImport++;
        break;
      case "warning":
        stats.warning++;
        stats.toImport++;
        break;
      case "duplicate":
        stats.duplicates++;
        if (d.forceImport) stats.toImport++;
        break;
      case "error":
        stats.errors++;
        break;
      case "skipped":
        stats.skipped++;
        break;
    }
  }
  return stats;
}

function isImportableDraft(draft: DraftActivity): boolean {
  return (
    draft.status === "valid" ||
    draft.status === "warning" ||
    (draft.status === "duplicate" && !!draft.forceImport)
  );
}

function filterDrafts(drafts: DraftActivity[], filter: ChatImportFilter): DraftActivity[] {
  if (filter === "all") return drafts;
  return drafts.filter((d) => {
    if (filter === "valid") return d.status === "valid";
    if (filter === "warning") return d.status === "warning";
    if (filter === "error") return d.status === "error";
    if (filter === "duplicate") return d.status === "duplicate";
    if (filter === "skipped") return d.status === "skipped";
    return true;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────────────

interface UseChatImportSessionOptions {
  mapping: ImportCsvMappingOutput | null;
  threadId?: string | null;
  toolCallId?: string;
  /** Flag from the persisted tool result — skips initialization if already submitted. */
  submittedFromResult?: boolean;
  submittedCountFromResult?: number;
}

export interface UseChatImportSessionResult {
  status: ChatImportState["status"];
  error: string | null;
  drafts: DraftActivity[];
  filteredDrafts: DraftActivity[];
  stats: ChatImportStats;
  filter: ChatImportFilter;
  setFilter: (filter: ChatImportFilter) => void;
  accountId: string;
  setAccountId: (accountId: string) => void;
  assetPreviewItems: ImportAssetPreviewItem[];
  submitted: boolean;
  importedCount: number;
  canConfirm: boolean;
  isSubmitting: boolean;
  editDraft: (rowIndex: number, updates: Partial<DraftActivity>) => void;
  skipRow: (rowIndex: number) => void;
  forceImport: (rowIndex: number) => void;
  bulkSkip: (rowIndexes: number[]) => void;
  bulkUnskip: (rowIndexes: number[]) => void;
  bulkForceImport: (rowIndexes: number[]) => void;
  applyAssetResolution: (key: string, draft: NewAsset, options: { assetId?: string }) => void;
  revalidate: () => Promise<void>;
  confirm: () => Promise<void>;
}

export function useChatImportSession({
  mapping,
  threadId,
  toolCallId,
  submittedFromResult,
  submittedCountFromResult,
}: UseChatImportSessionOptions): UseChatImportSessionResult {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);

  const mappingRef = useRef(mapping);
  mappingRef.current = mapping;

  // On mount (once per mapping), bootstrap drafts + preview items.
  const initializedRef = useRef(false);
  useEffect(() => {
    if (initializedRef.current) return;
    if (!mapping) return;

    // If the tool result already says submitted, short-circuit.
    if (submittedFromResult) {
      initializedRef.current = true;
      dispatch({ type: "SUBMITTED", payload: submittedCountFromResult ?? 0 });
      return;
    }

    initializedRef.current = true;
    let cancelled = false;

    (async () => {
      try {
        if (!mapping.csvContent) {
          dispatch({
            type: "INIT_ERROR",
            payload: "No CSV content available. The AI tool result may be incomplete.",
          });
          return;
        }

        const baseParseConfig = normalizeParseConfig(mapping.parseConfig);
        const csvFile = csvStringAsFile(mapping.csvContent);

        // Parse with the AI's config first.
        let parsed: ParsedCsvResult = await parseCsv(csvFile, baseParseConfig);
        if (cancelled) return;
        let parseConfig = baseParseConfig;

        const applied = mapping.appliedMapping;
        const aiFieldMappings = (applied.fieldMappings ?? {}) as Record<string, unknown>;
        let hits = countFieldMappingHits(aiFieldMappings, parsed.headers);

        // LLMs sometimes strip preamble from csvContent but still pass
        // skipTopRows > 0 — which then skips the header row too. If the
        // AI's field mappings don't match the parsed headers AND skipTopRows
        // is set, retry with skipTopRows: 0.
        if (hits < 2 && (baseParseConfig.skipTopRows ?? 0) > 0) {
          parseConfig = { ...baseParseConfig, skipTopRows: 0 };
          parsed = await parseCsv(csvStringAsFile(mapping.csvContent), parseConfig);
          if (cancelled) return;
          hits = countFieldMappingHits(aiFieldMappings, parsed.headers);
        }

        const effectiveFieldMappings: Record<string, string | string[]> =
          hits >= 2
            ? (aiFieldMappings as Record<string, string | string[]>)
            : autoDetectFieldMappings(parsed.headers);

        const accountMappings = normalizeAccountMappings(
          applied.accountMappings ?? {},
          mapping.availableAccounts,
        );
        const validAccountIds = new Set(mapping.availableAccounts.map((account) => account.id));

        // Prefer AI's inferred account → saved mapping's account → single
        // available account, but only when the ID/name exists in this app
        // session. Stale account IDs from older demo DBs must not validate.
        const inferredAccountId =
          resolveAvailableAccountId(mapping.accountId, mapping.availableAccounts) ??
          resolveAvailableAccountId(applied.accountId, mapping.availableAccounts) ??
          "";
        const accountId =
          inferredAccountId ||
          (mapping.availableAccounts.length === 1 ? mapping.availableAccounts[0].id : "");

        const drafts = createDraftActivities(
          parsed.rows,
          parsed.headers,
          {
            fieldMappings: effectiveFieldMappings,
            activityMappings: applied.activityMappings ?? {},
            symbolMappings: applied.symbolMappings ?? {},
            accountMappings,
            symbolMappingMeta: applied.symbolMappingMeta ?? {},
          },
          {
            dateFormat: parsed.detectedConfig.dateFormat ?? parseConfig.dateFormat ?? "auto",
            decimalSeparator:
              parsed.detectedConfig.decimalSeparator ?? parseConfig.decimalSeparator ?? "auto",
            thousandsSeparator:
              parsed.detectedConfig.thousandsSeparator ?? parseConfig.thousandsSeparator ?? "auto",
            defaultCurrency:
              parsed.detectedConfig.defaultCurrency ?? parseConfig.defaultCurrency ?? "USD",
          },
          accountId,
          validAccountIds,
        );

        if (drafts.length === 0) {
          dispatch({
            type: "INIT_ERROR",
            payload:
              parsed.rows.length === 0
                ? "The CSV file contains no data rows."
                : "No activities could be extracted. The column mapping may be incorrect.",
          });
          return;
        }

        // Only run backend validation + asset preview once every imported
        // row has an account. The user can pick one from the dropdown, which
        // triggers revalidation with that account ID.
        const hasAccounts = drafts.every(
          (draft) => draft.status === "skipped" || !!draft.accountId,
        );
        const activitiesToValidate = hasAccounts
          ? buildActivitiesToValidate(drafts, parseConfig.defaultCurrency ?? "USD")
          : [];
        const candidates = hasAccounts
          ? drafts
              .map(buildImportAssetCandidateFromDraft)
              .filter((c): c is NonNullable<typeof c> => c !== null)
              .filter((c, i, arr) => arr.findIndex((x) => x.key === c.key) === i)
          : [];

        // Backend validation + asset preview are best-effort. If they fail,
        // proceed with local-only validation. The user can still review,
        // edit, and import.
        let validated: ActivityImport[] = [];
        let preview: ImportAssetPreviewItem[] = [];
        try {
          [validated, preview] = await Promise.all([
            activitiesToValidate.length > 0
              ? checkActivitiesImport({ activities: activitiesToValidate })
              : Promise.resolve([] as ActivityImport[]),
            candidates.length > 0
              ? previewImportAssets({ candidates })
              : Promise.resolve([] as ImportAssetPreviewItem[]),
          ]);
        } catch (err) {
          logger.warn(
            "[ChatImport] Backend validation failed (proceeding with local validation):",
            err instanceof Error ? err.message : String(err),
          );
        }
        if (cancelled) return;

        let nextDrafts = drafts;
        if (validated.length > 0) {
          nextDrafts = applyBackendValidation(nextDrafts, validated);
        }
        for (const item of preview) {
          if (!item.draft) continue;
          if (item.status === "EXISTING_ASSET") {
            nextDrafts = applyAssetResolution(nextDrafts, item.key, item.draft, {
              assetId: item.assetId,
            });
          } else if (item.status === "AUTO_RESOLVED_NEW_ASSET") {
            nextDrafts = applyAssetResolution(nextDrafts, item.key, item.draft, {
              importAssetKey: item.key,
            });
          }
        }

        dispatch({
          type: "INIT_OK",
          payload: { drafts: nextDrafts, assetPreviewItems: preview, accountId },
        });
      } catch (err) {
        if (cancelled) return;
        const message =
          err instanceof Error
            ? err.message
            : typeof err === "string"
              ? err
              : "Failed to prepare CSV import.";
        logger.error("[ChatImport] Init failed:", message);
        dispatch({ type: "INIT_ERROR", payload: message });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [mapping, submittedFromResult, submittedCountFromResult]);

  const revalidate = useCallback(async () => {
    const current = mappingRef.current;
    if (!current) return;
    try {
      const defaultCurrency = current.parseConfig.defaultCurrency ?? "USD";
      const activitiesToValidate = buildActivitiesToValidate(state.drafts, defaultCurrency);
      if (activitiesToValidate.length === 0) return;
      const validated = await checkActivitiesImport({ activities: activitiesToValidate });
      const merged = applyBackendValidation(state.drafts, validated);
      dispatch({ type: "SET_DRAFTS", payload: merged });
    } catch (err) {
      dispatch({
        type: "ERROR",
        payload: err instanceof Error ? err.message : "Failed to revalidate.",
      });
    }
  }, [state.drafts]);

  const editDraft = useCallback((rowIndex: number, updates: Partial<DraftActivity>) => {
    dispatch({ type: "UPDATE_DRAFT", payload: { rowIndex, updates } });
  }, []);

  const skipRow = useCallback((rowIndex: number) => {
    dispatch({
      type: "UPDATE_DRAFT",
      payload: { rowIndex, updates: { status: "skipped", skipReason: "Manual" } },
    });
  }, []);

  const forceImport = useCallback((rowIndex: number) => {
    dispatch({
      type: "UPDATE_DRAFT",
      payload: { rowIndex, updates: { forceImport: true } },
    });
  }, []);

  const bulkSkip = useCallback((rowIndexes: number[]) => {
    dispatch({
      type: "BULK_UPDATE",
      payload: { rowIndexes, updates: { status: "skipped" as const, skipReason: "Manual" } },
    });
  }, []);

  const bulkUnskip = useCallback((rowIndexes: number[]) => {
    dispatch({
      type: "BULK_UPDATE",
      payload: { rowIndexes, updates: { status: "valid" as const, skipReason: undefined } },
    });
  }, []);

  const bulkForceImport = useCallback((rowIndexes: number[]) => {
    dispatch({
      type: "BULK_UPDATE",
      payload: { rowIndexes, updates: { forceImport: true } },
    });
  }, []);

  const draftsRef = useRef(state.drafts);
  draftsRef.current = state.drafts;

  const applyAssetResolutionCb = useCallback(
    (key: string, assetDraft: NewAsset, options: { assetId?: string }) => {
      const next = applyAssetResolution(draftsRef.current, key, assetDraft, {
        assetId: options.assetId,
        importAssetKey: options.assetId ? undefined : key,
      });
      dispatch({ type: "SET_DRAFTS", payload: next });
    },
    [],
  );

  // Track the draftRevision at the time we kicked off each background
  // revalidate so late responses can't overwrite fresher state.
  const revalidateRunRef = useRef(0);

  const setAccountId = useCallback(
    (accountId: string) => {
      dispatch({ type: "SET_ACCOUNT", payload: accountId });

      // After the account changes, re-ask the backend to validate — the
      // rows had "Account is required" errors at init, and the backend
      // may also enrich symbols / flag duplicates differently under the
      // new account.
      const current = mappingRef.current;
      if (!current || !accountId) return;

      const run = ++revalidateRunRef.current;
      (async () => {
        try {
          const defaultCurrency = current.parseConfig.defaultCurrency ?? "USD";
          const nextDrafts = state.drafts.map((d) => {
            const nextErrors = { ...(d.errors ?? {}) };
            delete nextErrors.accountId;
            return { ...d, accountId, errors: nextErrors };
          });
          const activitiesToValidate = buildActivitiesToValidate(nextDrafts, defaultCurrency);
          if (activitiesToValidate.length === 0) return;
          const validated = await checkActivitiesImport({ activities: activitiesToValidate });
          if (run !== revalidateRunRef.current) return;
          const merged = applyBackendValidation(nextDrafts, validated);
          dispatch({ type: "SET_DRAFTS", payload: merged });
        } catch (err) {
          if (run !== revalidateRunRef.current) return;
          dispatch({
            type: "ERROR",
            payload: err instanceof Error ? err.message : "Failed to revalidate.",
          });
        }
      })();
    },
    [state.drafts],
  );

  const setFilter = useCallback((filter: ChatImportFilter) => {
    dispatch({ type: "SET_FILTER", payload: filter });
  }, []);

  const confirm = useCallback(async () => {
    const current = mappingRef.current;
    if (!current) return;

    dispatch({ type: "SUBMITTING" });
    const newlyCreatedAssetIdsByKey: Record<string, string> = {};

    try {
      // Step 1: re-run backend validation on importable drafts so we catch
      // any issues the local-only validateDraft missed (quoteCcy, asset
      // resolution, duplicates, etc.).
      const locallyImportable = state.drafts.filter(
        (d) =>
          d.status === "valid" ||
          d.status === "warning" ||
          (d.status === "duplicate" && d.forceImport),
      );
      if (locallyImportable.length === 0) {
        dispatch({ type: "ERROR", payload: "Nothing to import." });
        return;
      }

      const defaultCurrency = current.parseConfig.defaultCurrency ?? "USD";
      const toValidate = buildActivitiesToValidate(locallyImportable, defaultCurrency);
      const validated = await checkActivitiesImport({ activities: toValidate });

      // Merge backend results back so the grid reflects the latest state.
      const mergedDrafts = applyBackendValidation(state.drafts, validated);
      dispatch({ type: "SET_DRAFTS", payload: mergedDrafts });

      // Step 2: filter again after backend validation — only import rows the
      // backend also considers valid.
      const confirmedDrafts = mergedDrafts.filter(
        (d) =>
          d.status === "valid" ||
          d.status === "warning" ||
          (d.status === "duplicate" && d.forceImport),
      );
      if (confirmedDrafts.length === 0) {
        dispatch({
          type: "ERROR",
          payload: "All activities have validation errors. Fix them and try again.",
        });
        return;
      }

      // Step 3: create pending assets, then import the validated activities.
      const createdAssetIdsByKey = { ...state.createdAssetIdsByKey };
      const pendingAssets = new Map<string, NewAsset>();

      for (const item of state.assetPreviewItems) {
        if (item.status !== "AUTO_RESOLVED_NEW_ASSET" || !item.draft) {
          continue;
        }
        if (!createdAssetIdsByKey[item.key]) {
          pendingAssets.set(item.key, item.draft);
        }
      }

      for (const draft of confirmedDrafts) {
        if (draft.assetId) {
          continue;
        }
        const key = draft.importAssetKey || draft.assetCandidateKey;
        if (!key || createdAssetIdsByKey[key] || pendingAssets.has(key)) {
          continue;
        }
        const assetDraft = buildNewAssetFromDraft(draft);
        if (assetDraft) {
          pendingAssets.set(key, assetDraft);
        }
      }

      for (const [key, assetDraft] of pendingAssets.entries()) {
        const created = await createAsset(assetDraft);
        createdAssetIdsByKey[key] = created.id;
        newlyCreatedAssetIdsByKey[key] = created.id;
      }

      if (Object.keys(newlyCreatedAssetIdsByKey).length > 0) {
        dispatch({ type: "MERGE_CREATED_ASSET_IDS", payload: newlyCreatedAssetIdsByKey });
      }

      const draftsWithCreatedAssets = applyCreatedAssetIdsToDrafts(
        mergedDrafts,
        createdAssetIdsByKey,
      );
      if (draftsWithCreatedAssets !== mergedDrafts) {
        dispatch({ type: "SET_DRAFTS", payload: draftsWithCreatedAssets });
      }

      const confirmedDraftsWithAssets = applyCreatedAssetIdsToDrafts(
        confirmedDrafts,
        createdAssetIdsByKey,
      );
      const activitiesToImport = confirmedDraftsWithAssets.map(draftToActivityImport);
      const result = await importActivities({ activities: activitiesToImport });
      const importedCount = result.summary?.imported ?? 0;

      // If the backend reports failure, stay on the grid with errors.
      if (!result.summary?.success || importedCount === 0) {
        // Merge any per-row errors from the import result back into drafts.
        if (result.activities?.length) {
          const postImportDrafts = applyBackendValidation(
            draftsWithCreatedAssets,
            result.activities,
          );
          dispatch({ type: "SET_DRAFTS", payload: postImportDrafts });
        }
        dispatch({
          type: "ERROR",
          payload:
            result.summary?.errorMessage ?? "Import failed. Review the errors and try again.",
        });
        return;
      }

      // Step 4: success path — save template + persist tool result.
      if (state.accountId) {
        try {
          const accountName =
            current.availableAccounts.find((a) => a.id === state.accountId)?.name ?? "";
          const mappingToSave: ImportMappingData = {
            ...current.appliedMapping,
            accountId: state.accountId,
            name: current.appliedMapping.name || `AI Import — ${accountName}`.trim(),
          };
          await saveAccountImportMapping(mappingToSave);
        } catch (err) {
          logger.error("Failed to save import template:", err);
        }
      }

      if (threadId && toolCallId) {
        try {
          await updateToolResult({
            threadId,
            toolCallId,
            resultPatch: {
              submitted: true,
              importedCount,
              importRunId: result.importRunId,
              submittedAt: new Date().toISOString(),
            },
          });
        } catch (err) {
          logger.error("Failed to update tool result:", err);
        }
      }

      dispatch({ type: "SUBMITTED", payload: importedCount });
    } catch (err) {
      if (Object.keys(newlyCreatedAssetIdsByKey).length > 0) {
        dispatch({ type: "MERGE_CREATED_ASSET_IDS", payload: newlyCreatedAssetIdsByKey });
      }
      dispatch({
        type: "ERROR",
        payload: err instanceof Error ? err.message : "Failed to import activities.",
      });
    }
  }, [
    state.drafts,
    state.accountId,
    state.assetPreviewItems,
    state.createdAssetIdsByKey,
    threadId,
    toolCallId,
  ]);

  const stats = useMemo(() => computeStats(state.drafts), [state.drafts]);
  const filteredDrafts = useMemo(
    () => filterDrafts(state.drafts, state.filter),
    [state.drafts, state.filter],
  );
  const importableDrafts = useMemo(() => state.drafts.filter(isImportableDraft), [state.drafts]);
  const canConfirm =
    state.status === "ready" &&
    importableDrafts.length > 0 &&
    importableDrafts.every((draft) => Boolean(draft.accountId?.trim()));
  const isSubmitting = state.status === "submitting";
  const submitted = state.status === "submitted";

  return {
    status: state.status,
    error: state.error,
    drafts: state.drafts,
    filteredDrafts,
    stats,
    filter: state.filter,
    setFilter,
    accountId: state.accountId,
    setAccountId,
    assetPreviewItems: state.assetPreviewItems,
    submitted,
    importedCount: state.importedCount,
    canConfirm,
    isSubmitting,
    editDraft,
    skipRow,
    forceImport,
    bulkSkip,
    bulkUnskip,
    bulkForceImport,
    applyAssetResolution: applyAssetResolutionCb,
    revalidate,
    confirm,
  };
}
