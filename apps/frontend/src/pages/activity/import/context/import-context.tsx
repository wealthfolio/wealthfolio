import type { LocalDraftErrorMessages } from "../utils/draft-validation-messages";
import enActivity from "@/i18n/locales/en/activity.json";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useRef,
  type ReactNode,
  type Dispatch,
} from "react";
import { checkActivitiesImport, previewImportAssets, logger } from "@/adapters";
import type {
  ActivityImport,
  ImportAssetCandidate,
  ImportAssetPreviewItem,
  ImportMappingData,
  ImportTemplateScope,
  NewAsset,
} from "@/lib/types";
import {
  applyAssetResolution,
  getImportAssetCandidates,
  getUnreviewedAssetCandidates,
} from "../utils/asset-review-utils";
import { assetPreviewError, type AssetPreviewError } from "../utils/asset-preview-error";

// Keep requests sequential and small; provider rate limiting stays in the backend.
const ASSET_PREVIEW_BATCH_SIZE = 5;

function buildAssetPreviewBatches(
  candidates: ImportAssetCandidate[],
  unchecked: ImportAssetCandidate[],
): ImportAssetCandidate[][] {
  // The core bond alias resolver checks conflicting ISIN/CUSIP claims across
  // its entire input. Keep all explicit bond inputs together, including known
  // matches needed as context on retry; do not reimplement those checks here.
  const bonds = candidates.filter(
    (candidate) => candidate.instrumentType?.trim().toUpperCase() === "BOND",
  );
  const bondKeys = new Set(bonds.map((candidate) => candidate.key));
  const batches: ImportAssetCandidate[][] = [];
  let batch: ImportAssetCandidate[] = [];
  let bondsQueued = false;
  const flush = () => {
    if (batch.length) batches.push(batch);
    batch = [];
  };
  for (const candidate of unchecked) {
    if (bondKeys.has(candidate.key)) {
      if (!bondsQueued) {
        flush();
        batches.push(bonds);
        bondsQueued = true;
      }
    } else {
      batch.push(candidate);
      if (batch.length === ASSET_PREVIEW_BATCH_SIZE) flush();
    }
  }
  flush();
  return batches;
}

export interface AssetPreviewProgress {
  total: number;
  completed: number;
  startedAt: number;
  finishedAt?: number;
}

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
  /** Whether a transfer or credit crosses the tracked-account boundary. */
  isExternal?: boolean;
  /** Draft-only provenance used to safely recompute an inferred credit boundary. */
  boundaryInference?: "expense-reversal";

  isin?: string;

  // Enriched by backend check
  exchangeMic?: string;
  symbolName?: string;
  quoteCcy?: string;
  instrumentType?: string;
  /** Provider quote type of the resolved asset (e.g. "MUTUALFUND"); classifies a new asset. */
  instrumentTypeLabel?: string;
  quoteMode?: string;
  providerId?: string;
  providerSymbol?: string;

  // Asset resolution (set during asset-review step)
  assetCandidateKey?: string;
  importAssetKey?: string;

  // Validation state
  status: DraftActivityStatus;
  errors: Record<string, string[]>;
  localErrorMessages?: LocalDraftErrorMessages;
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

type ImportValidationError = string | { key: "activity:import.review.backend_failed" };

export interface ImportState {
  step: ImportStep;
  stepOrder: ImportStep[];
  file: File | null;
  parseConfig: ParseConfig;
  headers: string[];
  parsedRows: string[][];
  // Indexes into parsedRows left out of this import in Mapping; not part of the template
  skippedRowIndexes: number[];
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
  validationError: ImportValidationError | null;
  draftRevision: number;
  lastValidatedRevision: number | null;
  isPreviewingAssets: boolean;
  assetPreviewError: AssetPreviewError | null;
  assetPreviewProgress: AssetPreviewProgress | null;
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
  skippedRowIndexes: [],
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
  assetPreviewProgress: null,
};

// ─────────────────────────────────────────────────────────────────────────────
// Actions
// ─────────────────────────────────────────────────────────────────────────────

export type ImportAction =
  | { type: "SET_FILE"; payload: File }
  | { type: "SET_ACCOUNT_ID"; payload: string }
  | { type: "SET_PARSE_CONFIG"; payload: Partial<ParseConfig> }
  | { type: "SET_PARSED_DATA"; payload: { headers: string[]; rows: string[][] } }
  | { type: "SET_SKIPPED_ROWS"; payload: number[] }
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
  | { type: "SET_VALIDATION_ERROR"; payload: ImportValidationError | null }
  | { type: "MARK_VALIDATED"; payload: number }
  | {
      type: "START_ASSET_PREVIEW";
      payload: { revision: number; retry: boolean; progress: AssetPreviewProgress };
    }
  | {
      type: "APPLY_ASSET_PREVIEW_BATCH";
      payload: { revision: number; items: ImportAssetPreviewItem[] };
    }
  | {
      type: "FINISH_ASSET_PREVIEW";
      payload: { finishedAt: number; error: AssetPreviewError | null };
    }
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
    // A quote type belongs to the asset it was resolved for, not to an edited identity.
    const identityChanged = (
      ["symbol", "exchangeMic", "instrumentType", "providerId", "providerSymbol", "isin"] as const
    ).some((field) => field in updates && updates[field] !== draft[field]);
    const labelUpdate =
      identityChanged && !("instrumentTypeLabel" in updates)
        ? { instrumentTypeLabel: undefined }
        : {};
    // Validation sends the name as reviewed, so it must not follow the row to another asset.
    const nameIdentityChanged = (
      ["symbol", "exchangeMic", "providerId", "providerSymbol", "isin"] as const
    ).some((field) => field in updates && updates[field] !== draft[field]);
    const nameUpdate =
      nameIdentityChanged && !("symbolName" in updates) ? { symbolName: undefined } : {};
    return { ...draft, ...normalizedUpdates, ...labelUpdate, ...nameUpdate, isEdited: true };
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
        // A new parse can renumber rows, so skips from the old rows no longer apply
        skippedRowIndexes: [],
      };

    case "SET_SKIPPED_ROWS":
      return { ...state, skippedRowIndexes: action.payload };

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
          assetPreviewProgress: null,
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

    case "START_ASSET_PREVIEW":
      if (state.draftRevision !== action.payload.revision) return state;
      return {
        ...state,
        isPreviewingAssets: true,
        assetPreviewError: null,
        assetPreviewProgress: action.payload.progress,
        assetPreviewItems: action.payload.retry ? state.assetPreviewItems : [],
        pendingImportAssets: action.payload.retry ? state.pendingImportAssets : {},
      };

    case "APPLY_ASSET_PREVIEW_BATCH": {
      if (state.draftRevision !== action.payload.revision) return state;
      const previews = new Map(state.assetPreviewItems.map((item) => [item.key, item]));
      const pending = { ...state.pendingImportAssets };
      let drafts = state.draftActivities;
      let completed = 0;
      for (const item of action.payload.items) {
        // A result must never replace an already reviewed or manually edited match.
        if (previews.has(item.key)) continue;
        previews.set(item.key, item);
        completed += 1;
        if (!item.draft) continue;
        if (item.status === "EXISTING_ASSET") {
          drafts = applyAssetResolution(drafts, item.key, item.draft, { assetId: item.assetId });
        } else if (item.status === "AUTO_RESOLVED_NEW_ASSET") {
          drafts = applyAssetResolution(drafts, item.key, item.draft, { importAssetKey: item.key });
          pending[item.key] = { key: item.key, draft: item.draft, source: "auto" };
        }
      }
      return {
        ...state,
        assetPreviewItems: [...previews.values()],
        pendingImportAssets: pending,
        draftActivities: drafts,
        // Enrichment is part of this preview, not a user edit invalidating its next batch.
        lastValidatedRevision: null,
        assetPreviewProgress: state.assetPreviewProgress
          ? {
              ...state.assetPreviewProgress,
              completed: state.assetPreviewProgress.completed + completed,
            }
          : null,
      };
    }

    case "FINISH_ASSET_PREVIEW":
      return {
        ...state,
        isPreviewingAssets: false,
        assetPreviewError: action.payload.error,
        assetPreviewProgress: state.assetPreviewProgress
          ? { ...state.assetPreviewProgress, finishedAt: action.payload.finishedAt }
          : null,
      };

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
  previewAssets: (
    drafts: DraftActivity[],
    options?: { revision?: number; retry?: boolean },
  ) => Promise<void>;
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
  const [state, dispatch] = useReducer(importReducer, {
    ...INITIAL_STATE,
    accountId: initialAccountId ?? "",
  });

  const validationRunRef = useRef(0);
  const previewRunRef = useRef(0);
  const isActiveRef = useRef(true);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    isActiveRef.current = true;
    return () => {
      // React Activity also cleans up effects when a kept phone screen hides.
      // Let the pending request settle its preserved state, but stop scheduling
      // further batches while hidden or after a permanent unmount.
      isActiveRef.current = false;
    };
  }, []);

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
                symbolName: draft.symbolName,
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
            const usesGeneralFallback =
              !backendResult.isValid && Object.keys(backendErrors).length === 0;
            if (usesGeneralFallback) {
              backendErrors.general = [enActivity.validation_failed];
            }

            const mergedErrors = mergeIssueMaps(draft.errors || {}, backendErrors);
            let localErrorMessages = draft.localErrorMessages;
            if (
              usesGeneralFallback &&
              !draft.errors?.general?.includes(enActivity.validation_failed)
            ) {
              const generalMessages = [...(draft.localErrorMessages?.general ?? [])];
              generalMessages[mergedErrors.general.length - 1] = {
                key: "activity:validation_failed",
                originalMessage: enActivity.validation_failed,
              };
              localErrorMessages = { ...draft.localErrorMessages, general: generalMessages };
            }
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
              localErrorMessages,
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
            payload: { key: "activity:import.review.backend_failed" },
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
    async (drafts: DraftActivity[], options?: { revision?: number; retry?: boolean }) => {
      const run = ++previewRunRef.current;
      const requestedRevision = options?.revision ?? draftRevisionRef.current;
      const retry = options?.retry ?? false;
      const candidates = getImportAssetCandidates(drafts);
      const unchecked = retry
        ? getUnreviewedAssetCandidates(drafts, stateRef.current.assetPreviewItems)
        : candidates;
      const uncheckedKeys = new Set(unchecked.map((candidate) => candidate.key));
      const isCurrent = () =>
        run === previewRunRef.current && draftRevisionRef.current <= requestedRevision;

      dispatch({
        type: "START_ASSET_PREVIEW",
        payload: {
          revision: requestedRevision,
          retry,
          progress: {
            total: candidates.length,
            completed: candidates.length - unchecked.length,
            startedAt: Date.now(),
          },
        },
      });
      let failure: AssetPreviewError | null = null;
      try {
        for (const batch of buildAssetPreviewBatches(candidates, unchecked)) {
          if (!isCurrent() || !isActiveRef.current) return;
          const preview = await previewImportAssets({ candidates: batch });
          if (!isCurrent()) return;
          // An incomplete response cannot count as a completed batch or unlock review.
          const expectedKeys = new Set(batch.map((candidate) => candidate.key));
          if (
            !Array.isArray(preview) ||
            preview.length !== batch.length ||
            preview.some(
              (item) =>
                !item ||
                !expectedKeys.has(item.key) ||
                !["EXISTING_ASSET", "AUTO_RESOLVED_NEW_ASSET", "NEEDS_FIXING"].includes(
                  item.status,
                ) ||
                (item.status === "EXISTING_ASSET" && !item.assetId) ||
                (item.status === "AUTO_RESOLVED_NEW_ASSET" && !item.draft),
            ) ||
            new Set(preview.map((item) => item.key)).size !== batch.length
          ) {
            throw new Error("Incomplete asset preview response");
          }
          dispatch({
            type: "APPLY_ASSET_PREVIEW_BATCH",
            payload: {
              revision: requestedRevision,
              // Reviewed bonds can be request context without replacing edits
              // or counting their already completed results a second time.
              items: preview.filter((item) => uncheckedKeys.has(item.key)),
            },
          });
        }
      } catch (error) {
        if (!isCurrent()) return;
        failure = assetPreviewError(error);
      } finally {
        if (run === previewRunRef.current) {
          dispatch({
            type: "FINISH_ASSET_PREVIEW",
            payload: { finishedAt: Date.now(), error: failure },
          });
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
