import {
  createContext,
  useCallback,
  useContext,
  useReducer,
  useRef,
  type ReactNode,
  type Dispatch,
} from "react";
import { useTranslation } from "react-i18next";
import { checkActivitiesImport, previewImportAssets, logger } from "@/adapters";
import type {
  ActivityImport,
  ImportAssetPreviewItem,
  ImportMappingData,
  ImportTemplateScope,
  NewAsset,
} from "@/lib/types";
import {
  applyAssetResolution,
  buildImportAssetCandidateFromDraft,
} from "../utils/asset-review-utils";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ImportStep = "upload" | "mapping" | "assets" | "review" | "confirm" | "result";

export interface ParseConfig {
  hasHeaderRow: boolean;
  headerRowIndex: number;
  delimiter: string; // ",", ";", "\t", "auto"
  skipTopRows: number;
  skipBottomRows: number;
  skipEmptyRows: boolean;
  dateFormat: string; // "auto" | "YYYY-MM-DD" | "DD/MM/YYYY" | etc.
  decimalSeparator: string; // "auto" | "." | ","
  thousandsSeparator: string; // "auto" | "," | "." | " " | "none"
  defaultCurrency: string;
}

export type DraftActivityStatus = "valid" | "warning" | "error" | "skipped" | "duplicate";
export type DraftCurrencySource = "csv" | "default" | "manual" | "resolved";

export interface DraftActivity {
  rowIndex: number;
  rawRow: string[];

  // Normalized fields
  activityDate: string;
  activityType: string;
  symbol?: string;
  assetId?: string;
  quantity?: string | null;
  unitPrice?: string | null;
  amount?: string | null;
  currency: string;
  currencySource?: DraftCurrencySource;
  fee?: string | null;
  tax?: string | null;
  accountId: string;
  comment?: string;
  subtype?: string;
  fxRate?: string | null;
  /** Whether this is an external transfer (for TRANSFER_IN/TRANSFER_OUT) */
  isExternal?: boolean;

  isin?: string;

  // Enriched by backend check
  exchangeMic?: string;
  symbolName?: string;
  quoteCcy?: string;
  instrumentType?: string;
  quoteMode?: string;
  providerId?: string;
  providerSymbol?: string;

  // Asset resolution (set during asset-review step)
  assetCandidateKey?: string;
  importAssetKey?: string;

  // Validation state
  status: DraftActivityStatus;
  errors: Record<string, string[]>;
  warnings: Record<string, string[]>;
  skipReason?: string;
  duplicateOfId?: string;
  duplicateOfLineNumber?: number;
  /** User explicitly requested to import this row despite it matching an existing activity. */
  forceImport?: boolean;
  isEdited: boolean;
}

export interface PendingImportAsset {
  key: string;
  draft: NewAsset;
  source: "auto" | "manual";
}

export interface ImportResultStats {
  total: number;
  imported: number;
  skipped: number;
  duplicates: number;
  errors: number;
}

export interface ImportResult {
  success: boolean;
  stats: ImportResultStats;
  importRunId?: string;
  errorMessage?: string;
}

export interface ImportState {
  step: ImportStep;
  stepOrder: ImportStep[];
  file: File | null;
  parseConfig: ParseConfig;
  headers: string[];
  parsedRows: string[][];
  mapping: ImportMappingData | null;
  draftActivities: DraftActivity[];
  assetPreviewItems: ImportAssetPreviewItem[];
  pendingImportAssets: Record<string, PendingImportAsset>;
  selectedTemplateId: string | null;
  selectedTemplateScope: ImportTemplateScope | null;
  suppressLinkedTemplate: boolean;
  duplicates: Record<string, string>; // idempotencyKey -> existingActivityId
  importResult: ImportResult | null;
  accountId: string;
  holdingsCheckPassed: boolean;
  isValidating: boolean;
  validationError: string | null;
  draftRevision: number;
  lastValidatedRevision: number | null;
  isPreviewingAssets: boolean;
  assetPreviewError: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────────────────────

export const defaultParseConfig: ParseConfig = {
  hasHeaderRow: true,
  headerRowIndex: 0,
  delimiter: "auto",
  skipTopRows: 0,
  skipBottomRows: 0,
  skipEmptyRows: true,
  dateFormat: "auto",
  decimalSeparator: "auto",
  thousandsSeparator: "auto",
  defaultCurrency: "USD",
};

const INITIAL_STATE: ImportState = {
  step: "upload",
  stepOrder: ["upload", "mapping", "assets", "review", "confirm", "result"],
  file: null,
  parseConfig: defaultParseConfig,
  headers: [],
  parsedRows: [],
  mapping: null,
  draftActivities: [],
  assetPreviewItems: [],
  pendingImportAssets: {},
  selectedTemplateId: null,
  selectedTemplateScope: null,
  suppressLinkedTemplate: false,
  duplicates: {},
  importResult: null,
  accountId: "",
  holdingsCheckPassed: false,
  isValidating: false,
  validationError: null,
  draftRevision: 0,
  lastValidatedRevision: null,
  isPreviewingAssets: false,
  assetPreviewError: null,
};

// ─────────────────────────────────────────────────────────────────────────────
// Actions
// ─────────────────────────────────────────────────────────────────────────────

export type ImportAction =
  | { type: "SET_FILE"; payload: File }
  | { type: "SET_ACCOUNT_ID"; payload: string }
  | { type: "SET_PARSE_CONFIG"; payload: Partial<ParseConfig> }
  | { type: "SET_PARSED_DATA"; payload: { headers: string[]; rows: string[][] } }
  | { type: "SET_MAPPING"; payload: ImportMappingData }
  | { type: "SET_DRAFT_ACTIVITIES"; payload: DraftActivity[] }
  | { type: "SET_VALIDATED_DRAFT_ACTIVITIES"; payload: DraftActivity[] }
  | { type: "UPDATE_DRAFT"; payload: { rowIndex: number; updates: Partial<DraftActivity> } }
  | {
      type: "BULK_UPDATE_DRAFTS";
      payload: { rowIndexes: number[]; updates: Partial<DraftActivity> };
    }
  | {
      type: "BULK_SKIP_DRAFTS";
      payload: { rowIndexes: number[]; updates: Partial<DraftActivity> };
    }
  | { type: "SET_ASSET_PREVIEW_ITEMS"; payload: ImportAssetPreviewItem[] }
  | { type: "SET_PENDING_IMPORT_ASSET"; payload: PendingImportAsset }
  | { type: "REMOVE_PENDING_IMPORT_ASSET"; payload: string }
  | { type: "CLEAR_PENDING_IMPORT_ASSETS" }
  | {
      type: "SET_SELECTED_TEMPLATE";
      payload: { id: string | null; scope: ImportTemplateScope | null };
    }
  | { type: "SET_SUPPRESS_LINKED_TEMPLATE"; payload: boolean }
  | { type: "SET_DUPLICATES"; payload: Record<string, string> }
  | { type: "SET_IMPORT_RESULT"; payload: ImportResult }
  | { type: "SET_HOLDINGS_CHECK_PASSED"; payload: boolean }
  | { type: "SET_STEP"; payload: ImportStep }
  | { type: "SET_STEP_ORDER"; payload: ImportStep[] }
  | { type: "NEXT_STEP" }
  | { type: "PREV_STEP" }
  | { type: "SET_IS_VALIDATING"; payload: boolean }
  | { type: "SET_VALIDATION_ERROR"; payload: string | null }
  | { type: "MARK_VALIDATED"; payload: number }
  | { type: "SET_IS_PREVIEWING_ASSETS"; payload: boolean }
  | { type: "SET_ASSET_PREVIEW_ERROR"; payload: string | null }
  | { type: "RESET" };

// ─────────────────────────────────────────────────────────────────────────────
// Step Navigation Helpers
// ─────────────────────────────────────────────────────────────────────────────

const STEP_ORDER: ImportStep[] = ["upload", "mapping", "assets", "review", "confirm", "result"];

function getNextStep(current: ImportStep, stepOrder: ImportStep[]): ImportStep {
  const idx = stepOrder.indexOf(current);
  if (idx >= 0 && idx < stepOrder.length - 1) {
    return stepOrder[idx + 1];
  }
  return current;
}

function getPrevStep(current: ImportStep, stepOrder: ImportStep[]): ImportStep {
  const idx = stepOrder.indexOf(current);
  if (idx > 0) {
    return stepOrder[idx - 1];
  }
  return current;
}

function coerceStepForOrder(current: ImportStep, nextOrder: ImportStep[]): ImportStep {
  if (nextOrder.includes(current)) return current;
  if (current === "assets" && nextOrder.includes("review")) return "review";
  const currentDefaultIndex = STEP_ORDER.indexOf(current);
  return (
    nextOrder.find((step) => STEP_ORDER.indexOf(step) >= currentDefaultIndex) ??
    nextOrder[nextOrder.length - 1] ??
    current
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Reducer
// ─────────────────────────────────────────────────────────────────────────────

function importReducer(state: ImportState, action: ImportAction): ImportState {
  const applyUserDraftUpdates = (
    draft: DraftActivity,
    updates: Partial<DraftActivity>,
  ): DraftActivity => {
    const normalizedUpdates =
      "currency" in updates && !("currencySource" in updates)
        ? { ...updates, currencySource: "manual" as const }
        : updates;
    return { ...draft, ...normalizedUpdates, isEdited: true };
  };

  const updatesAffectAssetPreview = (updates: Partial<DraftActivity>) =>
    [
      "activityType",
      "symbol",
      "assetId",
      "exchangeMic",
      "quoteCcy",
      "instrumentType",
      "quoteMode",
      "providerId",
      "providerSymbol",
      "isin",
      "accountId",
      "assetCandidateKey",
      "importAssetKey",
    ].some((field) => field in updates);

  switch (action.type) {
    case "SET_FILE":
      return { ...state, file: action.payload };

    case "SET_ACCOUNT_ID":
      return { ...state, accountId: action.payload };

    case "SET_PARSE_CONFIG":
      return {
        ...state,
        parseConfig: { ...state.parseConfig, ...action.payload },
      };

    case "SET_PARSED_DATA":
      return {
        ...state,
        headers: action.payload.headers,
        parsedRows: action.payload.rows,
      };

    case "SET_MAPPING":
      return { ...state, mapping: action.payload };

    case "SET_DRAFT_ACTIVITIES":
      return {
        ...state,
        draftActivities: action.payload,
        draftRevision: state.draftRevision + 1,
        lastValidatedRevision: null,
        validationError: null,
      };

    case "SET_VALIDATED_DRAFT_ACTIVITIES":
      return { ...state, draftActivities: action.payload };

    case "UPDATE_DRAFT": {
      const { rowIndex, updates } = action.payload;
      const shouldClearAssetPreview = updatesAffectAssetPreview(updates);
      return {
        ...state,
        draftActivities: state.draftActivities.map((draft) =>
          draft.rowIndex === rowIndex ? applyUserDraftUpdates(draft, updates) : draft,
        ),
        ...(shouldClearAssetPreview
          ? {
              assetPreviewItems: [],
              pendingImportAssets: {},
              assetPreviewError: null,
            }
          : {}),
        draftRevision: state.draftRevision + 1,
        validationError: null,
      };
    }

    case "BULK_UPDATE_DRAFTS": {
      const { rowIndexes, updates } = action.payload;
      const indexSet = new Set(rowIndexes);
      const shouldClearAssetPreview = updatesAffectAssetPreview(updates);
      return {
        ...state,
        draftActivities: state.draftActivities.map((draft) =>
          indexSet.has(draft.rowIndex) ? applyUserDraftUpdates(draft, updates) : draft,
        ),
        ...(shouldClearAssetPreview
          ? {
              assetPreviewItems: [],
              pendingImportAssets: {},
              assetPreviewError: null,
            }
          : {}),
        draftRevision: state.draftRevision + 1,
        validationError: null,
      };
    }

    case "BULK_SKIP_DRAFTS": {
      const { rowIndexes, updates } = action.payload;
      const indexSet = new Set(rowIndexes);
      return {
        ...state,
        draftActivities: state.draftActivities.map((draft) =>
          indexSet.has(draft.rowIndex) ? { ...draft, ...updates } : draft,
        ),
        // draftRevision intentionally NOT incremented — skip/unskip doesn't invalidate validation
      };
    }

    case "SET_ASSET_PREVIEW_ITEMS":
      return { ...state, assetPreviewItems: action.payload };

    case "SET_PENDING_IMPORT_ASSET":
      return {
        ...state,
        pendingImportAssets: {
          ...state.pendingImportAssets,
          [action.payload.key]: action.payload,
        },
      };

    case "REMOVE_PENDING_IMPORT_ASSET": {
      const next = { ...state.pendingImportAssets };
      delete next[action.payload];
      return { ...state, pendingImportAssets: next };
    }

    case "CLEAR_PENDING_IMPORT_ASSETS":
      return { ...state, pendingImportAssets: {} };

    case "SET_SELECTED_TEMPLATE":
      return {
        ...state,
        selectedTemplateId: action.payload.id,
        selectedTemplateScope: action.payload.scope,
      };

    case "SET_SUPPRESS_LINKED_TEMPLATE":
      return {
        ...state,
        suppressLinkedTemplate: action.payload,
      };

    case "SET_DUPLICATES":
      return { ...state, duplicates: action.payload };

    case "SET_IMPORT_RESULT":
      return { ...state, importResult: action.payload };

    case "SET_HOLDINGS_CHECK_PASSED":
      return { ...state, holdingsCheckPassed: action.payload };

    case "SET_STEP":
      return { ...state, step: action.payload };

    case "SET_STEP_ORDER":
      return {
        ...state,
        stepOrder: action.payload,
        step: coerceStepForOrder(state.step, action.payload),
      };

    case "NEXT_STEP":
      return { ...state, step: getNextStep(state.step, state.stepOrder) };

    case "PREV_STEP": {
      const prevStepValue = getPrevStep(state.step, state.stepOrder);
      const clearDrafts =
        prevStepValue === "mapping" && (state.step === "assets" || state.step === "review");
      return {
        ...state,
        step: prevStepValue,
        ...(clearDrafts && {
          draftActivities: prevStepValue === "mapping" ? [] : state.draftActivities,
          assetPreviewItems: prevStepValue === "mapping" ? [] : state.assetPreviewItems,
          pendingImportAssets: prevStepValue === "mapping" ? {} : state.pendingImportAssets,
          isValidating: false,
          isPreviewingAssets: false,
          validationError: null,
          assetPreviewError: null,
          lastValidatedRevision: prevStepValue === "mapping" ? null : state.lastValidatedRevision,
        }),
      };
    }

    case "SET_IS_VALIDATING":
      return { ...state, isValidating: action.payload };

    case "SET_VALIDATION_ERROR":
      return { ...state, validationError: action.payload };

    case "MARK_VALIDATED":
      return { ...state, lastValidatedRevision: action.payload, validationError: null };

    case "SET_IS_PREVIEWING_ASSETS":
      return { ...state, isPreviewingAssets: action.payload };

    case "SET_ASSET_PREVIEW_ERROR":
      return { ...state, assetPreviewError: action.payload };

    case "RESET":
      return { ...INITIAL_STATE };

    default:
      return state;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Context
// ─────────────────────────────────────────────────────────────────────────────

export interface ValidationResult {
  ok: boolean;
  hasErrors: boolean;
}

interface ImportContextValue {
  state: ImportState;
  dispatch: Dispatch<ImportAction>;
  validateDrafts: (
    drafts: DraftActivity[],
    options?: { revision?: number },
  ) => Promise<ValidationResult>;
  previewAssets: (drafts: DraftActivity[], options?: { revision?: number }) => Promise<void>;
}

const ImportContext = createContext<ImportContextValue | null>(null);

// Inline helper — avoids a circular import with draft-utils (which imports DraftActivity from here)
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

// ─────────────────────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────────────────────

interface ImportProviderProps {
  children: ReactNode;
  initialAccountId?: string;
}

export function ImportProvider({ children, initialAccountId }: ImportProviderProps) {
  const { t } = useTranslation();
  const [state, dispatch] = useReducer(importReducer, {
    ...INITIAL_STATE,
    accountId: initialAccountId ?? "",
  });

  const validationRunRef = useRef(0);
  const previewRunRef = useRef(0);

  // Invalidate in-flight async work when navigating backward so stale
  // responses cannot repopulate state the user already left behind.
  const prevStepRef = useRef(state.step);
  if (state.step !== prevStepRef.current) {
    const steps: ImportStep[] = ["upload", "mapping", "assets", "review", "confirm", "result"];
    if (steps.indexOf(state.step) < steps.indexOf(prevStepRef.current)) {
      ++validationRunRef.current;
      ++previewRunRef.current;
    }
    prevStepRef.current = state.step;
  }

  // "Latest ref" pattern — keeps validateDrafts stable while reading current values
  const accountIdRef = useRef(state.accountId);
  accountIdRef.current = state.accountId;
  const draftRevisionRef = useRef(state.draftRevision);
  draftRevisionRef.current = state.draftRevision;

  const validateDrafts = useCallback(
    async (drafts: DraftActivity[], options?: { revision?: number }): Promise<ValidationResult> => {
      const run = ++validationRunRef.current;
      const requestedRevision = options?.revision ?? draftRevisionRef.current;
      dispatch({ type: "SET_IS_VALIDATING", payload: true });
      dispatch({ type: "SET_VALIDATION_ERROR", payload: null });
      try {
        const activitiesToValidate = drafts
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
                currency: draft.currencySource === "default" ? "" : draft.currency || "",
                fee: draft.fee,
                tax: draft.tax,
                isDraft: true,
                isValid: draft.status === "valid" || draft.status === "warning",
                lineNumber: draft.rowIndex + 1,
                comment: draft.comment,
                fxRate: draft.fxRate,
                subtype: draft.subtype,
              }) satisfies Partial<ActivityImport>,
          ) as ActivityImport[];

        let updatedDrafts = drafts;
        if (activitiesToValidate.length > 0) {
          const validated = await checkActivitiesImport({ activities: activitiesToValidate });
          if (run !== validationRunRef.current || draftRevisionRef.current > requestedRevision) {
            return { ok: false, hasErrors: false };
          }

          updatedDrafts = drafts.map((draft) => {
            const backendResult = validated.find((v) => v.lineNumber === draft.rowIndex + 1);
            if (!backendResult) {
              return {
                ...draft,
                duplicateOfId: undefined,
                duplicateOfLineNumber: undefined,
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

            const mergedErrors = mergeIssueMaps(draft.errors || {}, backendErrors);
            const retainedWarnings = { ...(draft.warnings || {}) };
            delete retainedWarnings._duplicate;
            const mergedWarnings = mergeIssueMaps(retainedWarnings, backendWarnings);
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

            const backendCurrency = backendResult.currency || undefined;
            const shouldMarkCurrencyResolved =
              Boolean(backendCurrency) &&
              (draft.currencySource !== "default" || backendCurrency !== draft.currency);

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
              currency: backendCurrency || draft.currency,
              currencySource: backendCurrency
                ? draft.currencySource === "csv" || draft.currencySource === "manual"
                  ? draft.currencySource
                  : shouldMarkCurrencyResolved
                    ? "resolved"
                    : draft.currencySource
                : draft.currencySource,
              instrumentType: backendResult.instrumentType,
              providerId: backendResult.providerId,
              providerSymbol: backendResult.providerSymbol,
              status: newStatus,
              // Clear forceImport when the row is no longer a duplicate
              // (e.g. user edited the row after marking it "import anyway").
              forceImport: newStatus === "duplicate" ? draft.forceImport : false,
            } as DraftActivity;
          });
        }
        if (run !== validationRunRef.current || draftRevisionRef.current > requestedRevision) {
          return { ok: false, hasErrors: false };
        }
        dispatch({ type: "SET_VALIDATED_DRAFT_ACTIVITIES", payload: updatedDrafts });
        dispatch({ type: "MARK_VALIDATED", payload: requestedRevision });
        const hasErrors = updatedDrafts.some((d) => d.status !== "skipped" && d.status === "error");
        return { ok: true, hasErrors };
      } catch (error) {
        logger.error(`Backend validation failed: ${error}`);
        if (run === validationRunRef.current && draftRevisionRef.current <= requestedRevision) {
          dispatch({
            type: "SET_VALIDATION_ERROR",
            payload: "Backend validation failed. Retry validation before importing.",
          });
        }
        return { ok: false, hasErrors: false };
      } finally {
        if (run === validationRunRef.current) {
          dispatch({ type: "SET_IS_VALIDATING", payload: false });
        }
      }
    },
    [dispatch],
  );

  const previewAssets = useCallback(
    async (drafts: DraftActivity[], options?: { revision?: number }) => {
      const run = ++previewRunRef.current;
      const requestedRevision = options?.revision ?? draftRevisionRef.current;
      const candidates = drafts
        .map(buildImportAssetCandidateFromDraft)
        .filter((c): c is NonNullable<typeof c> => c !== null)
        .filter((c, i, arr) => arr.findIndex((x) => x.key === c.key) === i);

      if (candidates.length === 0) return;

      dispatch({ type: "SET_IS_PREVIEWING_ASSETS", payload: true });
      dispatch({ type: "SET_ASSET_PREVIEW_ERROR", payload: null });
      try {
        const preview = await previewImportAssets({ candidates });
        if (run !== previewRunRef.current || draftRevisionRef.current > requestedRevision) return;
        dispatch({ type: "SET_ASSET_PREVIEW_ITEMS", payload: preview });
        dispatch({ type: "CLEAR_PENDING_IMPORT_ASSETS" });

        let nextDrafts = drafts;
        for (const item of preview) {
          if (!item.draft) continue;
          if (item.status === "EXISTING_ASSET") {
            nextDrafts = applyAssetResolution(nextDrafts, item.key, item.draft, {
              assetId: item.assetId,
            });
          }
          if (item.status === "AUTO_RESOLVED_NEW_ASSET") {
            nextDrafts = applyAssetResolution(nextDrafts, item.key, item.draft, {
              importAssetKey: item.key,
            });
            dispatch({
              type: "SET_PENDING_IMPORT_ASSET",
              payload: {
                key: item.key,
                draft: item.draft,
                source: "auto",
              } satisfies PendingImportAsset,
            });
          }
        }
        dispatch({ type: "SET_DRAFT_ACTIVITIES", payload: nextDrafts });
      } catch (error) {
        if (run !== previewRunRef.current || draftRevisionRef.current > requestedRevision) return;
        dispatch({
          type: "SET_ASSET_PREVIEW_ERROR",
          payload:
            error instanceof Error ? error.message : t("activity:import.errors.previewFailed"),
        });
      } finally {
        if (run === previewRunRef.current) {
          dispatch({ type: "SET_IS_PREVIEWING_ASSETS", payload: false });
        }
      }
    },
    [dispatch],
  );

  return (
    <ImportContext.Provider value={{ state, dispatch, validateDrafts, previewAssets }}>
      {children}
    </ImportContext.Provider>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Hooks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hook to access the full import context (state and dispatch).
 * Throws if used outside ImportProvider.
 */
export function useImportContext(): ImportContextValue {
  const ctx = useContext(ImportContext);
  if (!ctx) {
    throw new Error("useImportContext must be used within ImportProvider");
  }
  return ctx;
}

/**
 * Hook to access only the import state.
 * Useful for components that only need to read state.
 */
export function useImportState(): ImportState {
  const { state } = useImportContext();
  return state;
}

/**
 * Hook to access only the dispatch function.
 * Useful for components that only need to dispatch actions.
 */
export function useImportDispatch(): Dispatch<ImportAction> {
  const { dispatch } = useImportContext();
  return dispatch;
}
