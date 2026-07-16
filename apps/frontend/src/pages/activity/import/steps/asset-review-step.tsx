import { createAsset } from "@/adapters";
import TickerSearchInput from "@/components/ticker-search";
import { TickerAvatar } from "@/components/ticker-avatar";
import { CreateSecurityDialog } from "@/pages/asset/create-security-dialog";
import type { ImportAssetPreviewItem, NewAsset, SymbolSearchResult } from "@/lib/types";
import { getExchangeDisplayName } from "@/lib/constants";
import { normalizeCurrency } from "@/lib/utils";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { ProgressIndicator } from "@wealthfolio/ui/components/ui/progress-indicator";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ImportAlert } from "../components/import-alert";
import { useImportContext, type DraftActivity } from "../context";
import {
  applyAssetResolution,
  buildImportAssetCandidateFromDraft,
  buildNewAssetFromSearchResult,
} from "../utils/asset-review-utils";

interface AssetDialogState {
  open: boolean;
  key: string;
  symbol: string;
  mode: "create" | "edit";
  initialAsset?: Partial<NewAsset>;
}

function buildEditableAssetDraft(
  item: ImportAssetPreviewItem,
  candidateDraft: DraftActivity | undefined,
  fallbackCurrency: string,
): NewAsset {
  return {
    kind: item.draft?.kind || "INVESTMENT",
    name:
      item.draft?.name ||
      candidateDraft?.symbolName ||
      item.draft?.displayCode ||
      item.draft?.instrumentSymbol ||
      candidateDraft?.symbol,
    displayCode: item.draft?.displayCode || item.draft?.instrumentSymbol || candidateDraft?.symbol,
    isActive: true,
    quoteMode:
      item.draft?.quoteMode ||
      candidateDraft?.quoteMode ||
      (item.status === "EXISTING_ASSET" ? "MARKET" : "MANUAL"),
    quoteCcy:
      item.draft?.quoteCcy ||
      candidateDraft?.quoteCcy ||
      candidateDraft?.currency ||
      fallbackCurrency,
    instrumentType: item.draft?.instrumentType || candidateDraft?.instrumentType || "EQUITY",
    instrumentSymbol:
      item.draft?.instrumentSymbol || item.draft?.displayCode || candidateDraft?.symbol,
    instrumentExchangeMic:
      item.draft?.instrumentExchangeMic || candidateDraft?.exchangeMic || undefined,
    providerId: item.draft?.providerId,
    providerSymbol: item.draft?.providerSymbol,
    notes: item.draft?.notes,
  };
}

// ─── Needs Fixing Row ─────────────────────────────────────────────────────────

interface NeedsFixingRowProps {
  item: ImportAssetPreviewItem;
  symbol: string;
  symbolName?: string;
  count: number;
  onSearch: (item: ImportAssetPreviewItem, result?: SymbolSearchResult) => void;
  onMarkCustom: () => void;
  onCreateAsset: () => void;
}

// Errors that are self-evident from context (item is in "Needs Fixing") and add no info.
const REDUNDANT_ERROR_PATTERNS = [/could not find/i, /please search/i, /not found in market/i];

function NeedsFixingRow({
  item,
  symbol,
  symbolName,
  count,
  onSearch,
  onMarkCustom,
  onCreateAsset,
}: NeedsFixingRowProps) {
  const { t } = useTranslation();
  const meaningfulErrors = Object.values(item.errors ?? {})
    .flat()
    .filter((msg) => !REDUNDANT_ERROR_PATTERNS.some((re) => re.test(msg)));

  return (
    <div
      className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1.5 px-3 py-3 sm:grid-cols-[12rem_1fr_auto] sm:px-4 sm:py-3.5"
      data-testid="asset-review-row"
    >
      {/* Col 1: avatar + symbol + count */}
      <div className="flex items-center gap-2.5">
        <TickerAvatar symbol={symbol} className="size-7 shrink-0" />
        <div className="flex min-w-0 flex-col">
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-sm font-bold tracking-tight">{symbol}</span>
            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
              {count}×
            </span>
          </div>
          {symbolName && (
            <span className="text-muted-foreground truncate text-[11px]">{symbolName}</span>
          )}
        </div>
        <Icons.ArrowRight className="ml-auto h-3.5 w-3.5 shrink-0 text-amber-400 dark:text-amber-500/70" />
      </div>

      {/* Col 2: search input with icon */}
      <div className="relative [&_[role=combobox]]:h-9 [&_[role=combobox]]:min-h-0 [&_[role=combobox]]:py-1">
        <Icons.Search className="pointer-events-none absolute left-2.5 top-1/2 z-10 h-3.5 w-3.5 -translate-y-1/2 text-amber-400 dark:text-amber-500/70" />
        <TickerSearchInput
          defaultValue={symbol}
          placeholder={t("activity:import.assets.searchPlaceholder")}
          onSelectResult={(_sym, result) => onSearch(item, result)}
          className="w-full pl-8 text-xs"
        />
      </div>

      {/* Col 3: actions */}
      <div className="flex shrink-0 items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onMarkCustom}
          className="text-muted-foreground h-7 gap-1 px-2 text-[11px] hover:text-amber-700 dark:hover:text-amber-400"
        >
          <Icons.Tag className="h-3 w-3 shrink-0" />
          <span className="hidden sm:inline">{t("activity:import.assets.markCustom")}</span>
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onCreateAsset}
          className="h-7 gap-1 border-amber-300 px-2.5 text-[11px] text-amber-700 hover:bg-amber-50 hover:text-amber-800 dark:border-amber-500/40 dark:text-amber-300 dark:hover:bg-amber-500/10"
        >
          <Icons.Plus className="h-3 w-3 shrink-0" />
          <span className="hidden sm:inline">{t("activity:import.assets.createManually")}</span>
        </Button>
      </div>

      {/* Errors span all 3 columns */}
      {meaningfulErrors.length > 0 && (
        <p className="col-span-3 flex items-start gap-1.5 text-[11px] text-red-600 dark:text-red-400">
          <Icons.AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
          {meaningfulErrors.join(" ")}
        </p>
      )}
    </div>
  );
}

// ─── Auto-Resolved Row ────────────────────────────────────────────────────────

interface AutoResolvedRowProps {
  item: ImportAssetPreviewItem;
  symbol: string;
  count: number;
  isSuspicious: boolean;
  csvCurrency?: string;
  isSearchOpen: boolean;
  onToggleSearch: () => void;
  onSearch: (item: ImportAssetPreviewItem, result?: SymbolSearchResult) => void;
  onEdit: () => void;
}

function AutoResolvedRow({
  item,
  symbol,
  count,
  isSuspicious,
  csvCurrency,
  isSearchOpen,
  onToggleSearch,
  onSearch,
  onEdit,
}: AutoResolvedRowProps) {
  const { t } = useTranslation();
  const asset = item.draft;
  const assetName =
    asset?.name && asset.name.toUpperCase() !== symbol.toUpperCase() ? asset.name : undefined;
  const exchangeDisplay = asset?.instrumentExchangeMic
    ? getExchangeDisplayName(asset.instrumentExchangeMic)
    : undefined;
  const metaPills = [asset?.instrumentType, asset?.quoteCcy, exchangeDisplay].filter(Boolean);

  return (
    <div
      className="hover:bg-muted/30 grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1.5 px-3 py-3 transition-colors sm:grid-cols-[12rem_1fr_auto] sm:px-4 sm:py-3.5"
      data-testid="asset-review-row"
    >
      {/* Col 1: avatar + symbol + name */}
      <div className="flex items-center gap-2.5">
        <TickerAvatar symbol={symbol} className="size-7 shrink-0" />
        <div className="flex min-w-0 flex-col">
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-sm font-bold tracking-tight">{symbol}</span>
            <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold text-blue-700 dark:bg-blue-500/15 dark:text-blue-300">
              {count}×
            </span>
          </div>
          {assetName && (
            <span className="text-muted-foreground truncate text-[11px]">{assetName}</span>
          )}
        </div>
      </div>

      {/* Col 2: metadata pills OR search input */}
      {isSearchOpen ? (
        <TickerSearchInput
          defaultValue={symbol}
          placeholder={t("activity:import.assets.searchPlaceholder")}
          onSelectResult={(_sym, result) => onSearch(item, result)}
          className="h-8 w-full py-1 text-xs"
        />
      ) : (
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          {item.resolutionSource === "mark_custom" && (
            <span className="inline-flex items-center gap-1 rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-300">
              <Icons.Tag className="h-3 w-3 shrink-0" />
              {t("activity:import.assets.custom")}
            </span>
          )}
          {isSuspicious && (
            <span
              className="inline-flex items-center gap-1 rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700 dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-300"
              title={t("activity:import.assets.currencyMismatch", {
                csv: csvCurrency,
                resolved: asset?.quoteCcy,
              })}
            >
              <Icons.AlertTriangle className="h-3 w-3 shrink-0" />
              {csvCurrency} → {asset?.quoteCcy}
            </span>
          )}
          {metaPills.map((pill) => (
            <span
              key={pill}
              className="border-border bg-muted/50 text-muted-foreground rounded border px-1.5 py-0.5 text-[10px]"
            >
              {pill}
            </span>
          ))}
          {metaPills.length === 0 && item.resolutionSource !== "mark_custom" && (
            <span className="text-muted-foreground text-[11px] italic">
              {t("activity:import.assets.noMetadataResolved")}
            </span>
          )}
        </div>
      )}

      {/* Col 3: actions */}
      <div className="flex shrink-0 items-center gap-1">
        <Button
          size="sm"
          variant={isSearchOpen ? "secondary" : "ghost"}
          className="h-7 gap-1 px-2 text-[11px]"
          onClick={onToggleSearch}
        >
          <Icons.Search className="h-3 w-3" />
          <span className="hidden sm:inline">
            {isSearchOpen ? t("activity:import.assets.cancel") : t("activity:import.assets.remap")}
          </span>
        </Button>
        {!isSearchOpen && (
          <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-[11px]" onClick={onEdit}>
            <Icons.Pencil className="h-3 w-3" />
            <span className="hidden sm:inline">{t("activity:import.assets.edit")}</span>
          </Button>
        )}
      </div>
    </div>
  );
}

// ─── Ready Asset Row ──────────────────────────────────────────────────────────

interface ReadyAssetRowProps {
  item: ImportAssetPreviewItem;
  symbol: string;
  count: number;
  isSearchOpen: boolean;
  onToggleSearch: () => void;
  onSearch: (item: ImportAssetPreviewItem, result?: SymbolSearchResult) => void;
  onEdit: () => void;
}

function ReadyAssetRow({
  item,
  symbol,
  count,
  isSearchOpen,
  onToggleSearch,
  onSearch,
  onEdit,
}: ReadyAssetRowProps) {
  const { t } = useTranslation();
  const asset = item.draft;
  const assetName =
    asset?.name && asset.name.toUpperCase() !== symbol.toUpperCase() ? asset.name : undefined;
  const exchangeDisplay = asset?.instrumentExchangeMic
    ? getExchangeDisplayName(asset.instrumentExchangeMic)
    : undefined;
  const metaPills = [asset?.instrumentType, asset?.quoteCcy, exchangeDisplay].filter(Boolean);

  return (
    <div
      className="hover:bg-muted/30 grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1.5 px-3 py-3 transition-colors sm:grid-cols-[12rem_1fr_auto] sm:px-4 sm:py-3.5"
      data-testid="asset-review-row"
    >
      {/* Col 1: avatar + symbol + name */}
      <div className="flex items-center gap-2.5">
        <TickerAvatar symbol={symbol} className="size-7 shrink-0" />
        <div className="flex min-w-0 flex-col">
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-sm font-bold tracking-tight">{symbol}</span>
            <span className="bg-success/15 text-success rounded px-1.5 py-0.5 text-[10px] font-semibold">
              {count}×
            </span>
          </div>
          {assetName && (
            <span className="text-muted-foreground truncate text-[11px]">{assetName}</span>
          )}
        </div>
      </div>

      {/* Col 2: metadata pills OR search input */}
      {isSearchOpen ? (
        <TickerSearchInput
          defaultValue={symbol}
          placeholder={t("activity:import.assets.searchPlaceholder")}
          onSelectResult={(_sym, result) => onSearch(item, result)}
          className="h-8 w-full py-1 text-xs"
        />
      ) : (
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          {metaPills.map((pill) => (
            <span
              key={pill}
              className="border-border bg-muted/50 text-muted-foreground rounded border px-1.5 py-0.5 text-[10px]"
            >
              {pill}
            </span>
          ))}
          {metaPills.length === 0 && (
            <span className="text-muted-foreground text-[11px] italic">
              {t("activity:import.assets.noMetadata")}
            </span>
          )}
        </div>
      )}

      {/* Col 3: actions */}
      <div className="flex shrink-0 items-center gap-1">
        <Button
          size="sm"
          variant={isSearchOpen ? "secondary" : "ghost"}
          className="h-7 gap-1 px-2 text-[11px]"
          onClick={onToggleSearch}
        >
          <Icons.Search className="h-3 w-3" />
          <span className="hidden sm:inline">
            {isSearchOpen ? t("activity:import.assets.cancel") : t("activity:import.assets.remap")}
          </span>
        </Button>
        {!isSearchOpen && (
          <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-[11px]" onClick={onEdit}>
            <Icons.Pencil className="h-3 w-3" />
            <span className="hidden sm:inline">{t("activity:import.assets.edit")}</span>
          </Button>
        )}
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function AssetReviewStep() {
  const { state, dispatch, previewAssets } = useImportContext();
  const { t } = useTranslation();
  const { draftActivities, assetPreviewItems, isPreviewingAssets } = state;
  const [activeSearchKey, setActiveSearchKey] = useState<string | null>(null);
  const [assetDialog, setAssetDialog] = useState<AssetDialogState>({
    open: false,
    key: "",
    symbol: "",
    mode: "create",
  });
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const toggleSection = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const candidateMap = useMemo(() => {
    const next = new Map<string, { count: number; draft: DraftActivity }>();
    for (const draft of draftActivities) {
      const candidate = buildImportAssetCandidateFromDraft(draft);
      if (!candidate) continue;
      const existing = next.get(candidate.key);
      if (existing) {
        existing.count += 1;
      } else {
        next.set(candidate.key, { count: 1, draft });
      }
    }
    return next;
  }, [draftActivities]);

  const updatePreviewItem = useCallback(
    (key: string, update: Partial<ImportAssetPreviewItem>) => {
      dispatch({
        type: "SET_ASSET_PREVIEW_ITEMS",
        payload: assetPreviewItems.map((item) =>
          item.key === key ? { ...item, ...update } : item,
        ),
      });
    },
    [assetPreviewItems, dispatch],
  );

  const handleSearchSelection = useCallback(
    (item: ImportAssetPreviewItem, result?: SymbolSearchResult) => {
      if (!result) return;

      const fallbackCurrency =
        candidateMap.get(item.key)?.draft.currency || state.parseConfig.defaultCurrency;
      const assetDraft = buildNewAssetFromSearchResult(result, fallbackCurrency);

      let nextDrafts = draftActivities;
      if (result.isExisting && result.existingAssetId) {
        nextDrafts = applyAssetResolution(nextDrafts, item.key, assetDraft, {
          assetId: result.existingAssetId,
        });
        dispatch({ type: "REMOVE_PENDING_IMPORT_ASSET", payload: item.key });
        // If another preview item already covers this assetId, just remove the current one
        // instead of duplicating it in the Existing Assets section.
        const alreadyExists = assetPreviewItems.some(
          (p) => p.key !== item.key && p.assetId === result.existingAssetId,
        );
        if (alreadyExists) {
          dispatch({
            type: "SET_ASSET_PREVIEW_ITEMS",
            payload: assetPreviewItems.filter((p) => p.key !== item.key),
          });
        } else {
          updatePreviewItem(item.key, {
            status: "EXISTING_ASSET",
            resolutionSource: "manual_search_existing",
            assetId: result.existingAssetId,
            draft: { ...assetDraft, id: result.existingAssetId },
            reviewSymbol: result.symbol,
            errors: undefined,
          });
        }
      } else {
        nextDrafts = applyAssetResolution(nextDrafts, item.key, assetDraft, {
          importAssetKey: item.key,
        });
        dispatch({
          type: "SET_PENDING_IMPORT_ASSET",
          payload: { key: item.key, draft: assetDraft, source: "auto" },
        });
        updatePreviewItem(item.key, {
          status: "AUTO_RESOLVED_NEW_ASSET",
          resolutionSource: "manual_search_new",
          assetId: undefined,
          draft: assetDraft,
          reviewSymbol: result.symbol,
          errors: undefined,
        });
      }
      dispatch({ type: "SET_DRAFT_ACTIVITIES", payload: nextDrafts });
      setActiveSearchKey(null);
    },
    [candidateMap, dispatch, draftActivities, state.parseConfig.defaultCurrency, updatePreviewItem],
  );

  const handleMarkCustom = useCallback(
    (item: ImportAssetPreviewItem) => {
      const candidate = candidateMap.get(item.key);
      const symbol = candidate?.draft.symbol || item.key;
      const fallbackCurrency = candidate?.draft.currency || state.parseConfig.defaultCurrency;
      const assetDraft = buildNewAssetFromSearchResult(
        {
          symbol,
          shortName: symbol,
          longName: symbol,
          exchange: "MANUAL",
          index: "MANUAL",
          quoteType: "EQUITY",
          score: 0,
          typeDisplay: "Custom Asset",
          dataSource: "MANUAL",
          quoteMode: "MANUAL",
        },
        fallbackCurrency,
      );
      const nextDrafts = applyAssetResolution(draftActivities, item.key, assetDraft, {
        importAssetKey: item.key,
      });
      dispatch({ type: "SET_DRAFT_ACTIVITIES", payload: nextDrafts });
      dispatch({
        type: "SET_PENDING_IMPORT_ASSET",
        payload: { key: item.key, draft: assetDraft, source: "auto" },
      });
      updatePreviewItem(item.key, {
        status: "AUTO_RESOLVED_NEW_ASSET",
        resolutionSource: "mark_custom",
        assetId: undefined,
        draft: assetDraft,
        reviewSymbol: undefined,
        errors: undefined,
      });
    },
    [candidateMap, dispatch, draftActivities, state.parseConfig.defaultCurrency, updatePreviewItem],
  );

  const handleMarkAllCustom = useCallback(() => {
    let nextDrafts = draftActivities;
    const updatedItems = assetPreviewItems.map((item) => {
      if (item.status !== "NEEDS_FIXING") return item;
      const candidate = candidateMap.get(item.key);
      const symbol = candidate?.draft.symbol || item.key;
      const fallbackCurrency = candidate?.draft.currency || state.parseConfig.defaultCurrency;
      const assetDraft = buildNewAssetFromSearchResult(
        {
          symbol,
          shortName: symbol,
          longName: symbol,
          exchange: "MANUAL",
          index: "MANUAL",
          quoteType: "EQUITY",
          score: 0,
          typeDisplay: "Custom Asset",
          dataSource: "MANUAL",
          quoteMode: "MANUAL",
        },
        fallbackCurrency,
      );
      nextDrafts = applyAssetResolution(nextDrafts, item.key, assetDraft, {
        importAssetKey: item.key,
      });
      dispatch({
        type: "SET_PENDING_IMPORT_ASSET",
        payload: { key: item.key, draft: assetDraft, source: "auto" },
      });
      return {
        ...item,
        status: "AUTO_RESOLVED_NEW_ASSET" as const,
        resolutionSource: "mark_custom",
        assetId: undefined,
        draft: assetDraft,
        reviewSymbol: undefined,
        errors: undefined,
      };
    });
    dispatch({ type: "SET_DRAFT_ACTIVITIES", payload: nextDrafts });
    dispatch({ type: "SET_ASSET_PREVIEW_ITEMS", payload: updatedItems });
  }, [
    assetPreviewItems,
    candidateMap,
    dispatch,
    draftActivities,
    state.parseConfig.defaultCurrency,
  ]);

  const handleManualCreate = useCallback(
    async (payload: NewAsset) => {
      const created = await createAsset(payload);
      const assetDraft: NewAsset = {
        ...payload,
        id: created.id,
        name: created.name || payload.name,
        displayCode: created.displayCode || payload.displayCode,
        quoteCcy: created.quoteCcy || payload.quoteCcy,
        instrumentType: created.instrumentType || payload.instrumentType,
        instrumentSymbol: created.instrumentSymbol || payload.instrumentSymbol,
        instrumentExchangeMic: created.instrumentExchangeMic || payload.instrumentExchangeMic,
        providerId: payload.providerId,
        providerSymbol: payload.providerSymbol,
      };

      const nextDrafts = applyAssetResolution(draftActivities, assetDialog.key, assetDraft, {
        assetId: created.id,
      });
      dispatch({ type: "SET_DRAFT_ACTIVITIES", payload: nextDrafts });
      dispatch({ type: "REMOVE_PENDING_IMPORT_ASSET", payload: assetDialog.key });
      updatePreviewItem(assetDialog.key, {
        status: "EXISTING_ASSET",
        resolutionSource: "manual_created",
        assetId: created.id,
        draft: assetDraft,
        reviewSymbol: undefined,
        errors: undefined,
      });
      setActiveSearchKey(null);
      setAssetDialog({ open: false, key: "", symbol: "", mode: "create" });
    },
    [assetDialog.key, dispatch, draftActivities, updatePreviewItem],
  );

  const handleManualEdit = useCallback(
    (payload: NewAsset) => {
      const nextDrafts = applyAssetResolution(draftActivities, assetDialog.key, payload, {
        importAssetKey: assetDialog.key,
      });

      dispatch({ type: "SET_DRAFT_ACTIVITIES", payload: nextDrafts });
      dispatch({
        type: "SET_PENDING_IMPORT_ASSET",
        payload: { key: assetDialog.key, draft: payload, source: "manual" },
      });
      updatePreviewItem(assetDialog.key, {
        status: "AUTO_RESOLVED_NEW_ASSET",
        resolutionSource: "manual_edit",
        assetId: undefined,
        draft: payload,
        reviewSymbol: undefined,
        errors: undefined,
      });
      setActiveSearchKey(null);
      setAssetDialog({ open: false, key: "", symbol: "", mode: "create" });
    },
    [assetDialog.key, dispatch, draftActivities, updatePreviewItem],
  );

  const needsFixing = assetPreviewItems.filter((item) => item.status === "NEEDS_FIXING");
  const autoResolvedItems = assetPreviewItems.filter(
    (item) => item.status === "AUTO_RESOLVED_NEW_ASSET",
  );
  const existingItems = assetPreviewItems.filter((item) => item.status === "EXISTING_ASSET");

  // ── Empty state ──────────────────────────────────────────────────────────────
  if (candidateMap.size === 0) {
    return (
      <ImportAlert
        variant="success"
        title={t("activity:import.assets.noAssetsTitle")}
        description={t("activity:import.assets.noAssetsDescription")}
      />
    );
  }

  // ── Loading state ────────────────────────────────────────────────────────────
  if (isPreviewingAssets || (assetPreviewItems.length === 0 && !state.assetPreviewError)) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <ProgressIndicator
          message={t("activity:import.assets.resolvingMessage")}
          description={t("activity:import.assets.resolvingDescription")}
          className="border-none shadow-none"
        />
      </div>
    );
  }

  // ── Error state ──────────────────────────────────────────────────────────────
  if (state.assetPreviewError) {
    return (
      <ImportAlert
        variant="destructive"
        title={t("activity:import.assets.previewFailedTitle")}
        description={state.assetPreviewError}
      >
        <div className="mt-3">
          <Button size="sm" variant="outline" onClick={() => void previewAssets(draftActivities)}>
            {t("activity:import.assets.retry")}
          </Button>
        </div>
      </ImportAlert>
    );
  }

  return (
    <div className="space-y-4">
      {/* ── Summary banner ────────────────────────────────────────────────── */}
      {needsFixing.length === 0 && autoResolvedItems.length === 0 && (
        <ImportAlert
          variant="success"
          title={t("activity:import.assets.allResolvedTitle")}
          description={t("activity:import.assets.allResolvedDescription")}
        />
      )}

      {/* ── Needs Fixing section ──────────────────────────────────────────── */}
      {needsFixing.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-amber-200 bg-amber-50/40 dark:border-amber-500/20 dark:bg-amber-500/[0.04]">
          {/* Section header */}
          <div className="flex items-center gap-3 border-b border-amber-200 bg-amber-50/60 px-4 py-2.5 dark:border-amber-500/20 dark:bg-amber-500/[0.06]">
            {/* Left: icon + text — clicking collapses */}
            <button
              type="button"
              className="flex flex-1 items-start gap-2 text-left"
              onClick={() => toggleSection("needsFixing")}
            >
              <Icons.AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
              <div className="flex-1">
                <span className="text-xs font-semibold uppercase tracking-wider text-amber-800 dark:text-amber-300">
                  {t("activity:import.assets.needsFixing")}
                </span>
                <p className="text-muted-foreground mt-0.5 text-[11px]">
                  {t("activity:import.assets.needsFixingDescription")}
                </p>
              </div>
            </button>
            {/* Right: Mark All Custom + count + chevron */}
            <div className="flex shrink-0 items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handleMarkAllCustom}
                className="h-7 gap-1 border-amber-300 px-2.5 text-[11px] text-amber-700 hover:bg-amber-50 hover:text-amber-800 dark:border-amber-500/40 dark:text-amber-300 dark:hover:bg-amber-500/10"
              >
                <Icons.Tag className="h-3 w-3 shrink-0" />
                {t("activity:import.assets.markAllCustom")}
              </Button>
              <span className="rounded-full bg-amber-200 px-2 py-0.5 text-[10px] font-bold text-amber-900 dark:bg-amber-500/20 dark:text-amber-200">
                {needsFixing.length}
              </span>
              <button type="button" onClick={() => toggleSection("needsFixing")}>
                <Icons.ChevronDown
                  className={`h-3.5 w-3.5 text-amber-500 transition-transform dark:text-amber-400/70 ${collapsed.has("needsFixing") ? "" : "rotate-180"}`}
                />
              </button>
            </div>
          </div>

          {/* Items */}
          {!collapsed.has("needsFixing") && (
            <div className="divide-border divide-y">
              {needsFixing.map((item) => {
                const candidate = candidateMap.get(item.key);
                const symbol = item.reviewSymbol || candidate?.draft.symbol || item.key;
                const symbolName = item.draft?.name || candidate?.draft.symbolName;
                const count = candidate?.count ?? 0;
                return (
                  <NeedsFixingRow
                    key={item.key}
                    item={item}
                    symbol={symbol}
                    symbolName={symbolName}
                    count={count}
                    onSearch={handleSearchSelection}
                    onMarkCustom={() => handleMarkCustom(item)}
                    onCreateAsset={() =>
                      setAssetDialog({
                        open: true,
                        key: item.key,
                        symbol,
                        mode: "create",
                      })
                    }
                  />
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── New Assets section (auto-resolved, needs confirmation) ────────── */}
      {autoResolvedItems.length > 0 &&
        (() => {
          const isItemSuspicious = (item: (typeof autoResolvedItems)[number]) => {
            const csvCcy = candidateMap.get(item.key)?.draft.currency;
            const assetCcy = item.draft?.quoteCcy;
            return Boolean(
              csvCcy && assetCcy && normalizeCurrency(csvCcy) !== normalizeCurrency(assetCcy),
            );
          };
          const sortedItems = [...autoResolvedItems].sort((a, b) => {
            const aSusp = isItemSuspicious(a) ? 0 : 1;
            const bSusp = isItemSuspicious(b) ? 0 : 1;
            if (aSusp !== bSusp) return aSusp - bSusp;
            return (a.draft?.instrumentExchangeMic ?? "").localeCompare(
              b.draft?.instrumentExchangeMic ?? "",
            );
          });
          const suspiciousCount = sortedItems.filter(isItemSuspicious).length;
          return (
            <div className="overflow-hidden rounded-lg border border-blue-200 bg-blue-50/40 dark:border-blue-400/20 dark:bg-blue-500/[0.06]">
              {/* Section header */}
              <button
                type="button"
                className="flex w-full items-start gap-2 border-b border-blue-200 bg-blue-50/60 px-4 py-2.5 text-left dark:border-blue-400/20 dark:bg-blue-500/10"
                onClick={() => toggleSection("newAssets")}
              >
                <Icons.Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-600 dark:text-blue-400" />
                <div className="flex-1">
                  <span className="text-xs font-semibold uppercase tracking-wider text-blue-800 dark:text-blue-300">
                    {t("activity:import.assets.newAssets")}
                  </span>
                  <p className="text-muted-foreground mt-0.5 text-[11px]">
                    {t("activity:import.assets.newAssetsDescription")}
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  {suspiciousCount > 0 && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800 dark:bg-amber-500/20 dark:text-amber-300">
                      <Icons.AlertTriangle className="h-3 w-3" />
                      {suspiciousCount}
                    </span>
                  )}
                  <span className="rounded-full bg-blue-200 px-2 py-0.5 text-[10px] font-bold text-blue-900 dark:bg-blue-500/20 dark:text-blue-200">
                    {autoResolvedItems.length}
                  </span>
                </div>
                <Icons.ChevronDown
                  className={`mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-500 transition-transform dark:text-blue-400/70 ${collapsed.has("newAssets") ? "" : "rotate-180"}`}
                />
              </button>

              {/* Items */}
              {!collapsed.has("newAssets") && (
                <div className="divide-border divide-y">
                  {sortedItems.map((item) => {
                    const candidate = candidateMap.get(item.key);
                    const symbol =
                      item.reviewSymbol ||
                      item.draft?.displayCode ||
                      item.draft?.instrumentSymbol ||
                      candidate?.draft.symbol ||
                      item.key;
                    const count = candidate?.count ?? 0;
                    const csvCcy = candidate?.draft.currency;
                    const assetCcy = item.draft?.quoteCcy;
                    const isSuspicious = Boolean(
                      csvCcy &&
                      assetCcy &&
                      normalizeCurrency(csvCcy) !== normalizeCurrency(assetCcy),
                    );
                    return (
                      <AutoResolvedRow
                        key={item.key}
                        item={item}
                        symbol={symbol}
                        count={count}
                        isSuspicious={isSuspicious}
                        csvCurrency={csvCcy}
                        isSearchOpen={activeSearchKey === item.key}
                        onToggleSearch={() =>
                          setActiveSearchKey((cur) => (cur === item.key ? null : item.key))
                        }
                        onSearch={(i, result) => handleSearchSelection(i, result)}
                        onEdit={() =>
                          setAssetDialog({
                            open: true,
                            key: item.key,
                            symbol: item.draft?.instrumentSymbol || item.draft?.displayCode || "",
                            mode: "edit",
                            initialAsset: buildEditableAssetDraft(
                              item,
                              candidate?.draft,
                              state.parseConfig.defaultCurrency,
                            ),
                          })
                        }
                      />
                    );
                  })}
                </div>
              )}
            </div>
          );
        })()}

      {/* ── Existing Assets section ───────────────────────────────────────── */}
      {existingItems.length > 0 && (
        <div className="border-success/30 bg-success/[0.04] overflow-hidden rounded-lg border">
          {/* Section header */}
          <button
            type="button"
            className="border-success/30 bg-success/[0.06] flex w-full items-start gap-2 border-b px-4 py-2.5 text-left"
            onClick={() => toggleSection("existingAssets")}
          >
            <Icons.CheckCircle className="text-success mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div className="flex-1">
              <span className="text-success text-xs font-semibold uppercase tracking-wider">
                {t("activity:import.assets.existingAssets")}
              </span>
              <p className="text-muted-foreground mt-0.5 text-[11px]">
                {t("activity:import.assets.existingAssetsDescription")}
              </p>
            </div>
            <span className="bg-success/20 text-success rounded-full px-2 py-0.5 text-[10px] font-bold">
              {existingItems.length}
            </span>
            <Icons.ChevronDown
              className={`text-success/60 mt-0.5 h-3.5 w-3.5 shrink-0 transition-transform ${collapsed.has("existingAssets") ? "" : "rotate-180"}`}
            />
          </button>

          {/* Items */}
          {!collapsed.has("existingAssets") && (
            <div className="divide-border divide-y">
              {existingItems.map((item) => {
                const candidate = candidateMap.get(item.key);
                const symbol =
                  item.reviewSymbol ||
                  item.draft?.displayCode ||
                  item.draft?.instrumentSymbol ||
                  candidate?.draft.symbol ||
                  item.key;
                const count = candidate?.count ?? 0;
                return (
                  <ReadyAssetRow
                    key={item.key}
                    item={item}
                    symbol={symbol}
                    count={count}
                    isSearchOpen={activeSearchKey === item.key}
                    onToggleSearch={() =>
                      setActiveSearchKey((cur) => (cur === item.key ? null : item.key))
                    }
                    onSearch={(i, result) => {
                      handleSearchSelection(i, result);
                    }}
                    onEdit={() =>
                      setAssetDialog({
                        open: true,
                        key: item.key,
                        symbol: item.draft?.instrumentSymbol || item.draft?.displayCode || "",
                        mode: "edit",
                        initialAsset: buildEditableAssetDraft(
                          item,
                          candidate?.draft,
                          state.parseConfig.defaultCurrency,
                        ),
                      })
                    }
                  />
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Asset dialog ─────────────────────────────────────────────────── */}
      <CreateSecurityDialog
        open={assetDialog.open}
        onOpenChange={(open) => setAssetDialog((current) => ({ ...current, open }))}
        title={
          assetDialog.mode === "edit"
            ? t("activity:import.assets.editDialogTitle")
            : t("activity:import.assets.createDialogTitle")
        }
        description={
          assetDialog.mode === "edit"
            ? t("activity:import.assets.editDialogDescription")
            : t("activity:import.assets.createDialogDescription")
        }
        submitLabel={
          assetDialog.mode === "edit"
            ? t("activity:import.assets.useEditedAsset")
            : t("activity:import.assets.createAsset")
        }
        initialAsset={assetDialog.initialAsset}
        onSubmit={(payload) =>
          void (assetDialog.mode === "edit"
            ? handleManualEdit(payload)
            : handleManualCreate(payload))
        }
      />
    </div>
  );
}

export default AssetReviewStep;
