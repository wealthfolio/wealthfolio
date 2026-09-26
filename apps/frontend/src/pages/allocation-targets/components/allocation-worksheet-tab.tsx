import { useQueries } from "@tanstack/react-query";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Card,
  CardContent,
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
  Icons,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  useAmountFormatting,
  useDateFormatting,
  useNumberFormatting,
} from "@wealthfolio/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { getAssetTaxonomyAssignments, getHoldingsList } from "@/adapters";
import { useAccounts } from "@/hooks/use-accounts";
import { usePortfolios } from "@/hooks/use-portfolios";
import { useSyncMarketDataMutation } from "@/hooks/use-sync-market-data";
import { useTaxonomy } from "@/hooks/use-taxonomies";
import { AccountPurpose, AccountType, HoldingType } from "@/lib/constants";
import { QueryKeys } from "@/lib/query-keys";
import type {
  Account,
  AccountScope,
  AllocationRule,
  AllocationTarget,
  AllocationWorksheetLineInput,
  AllocationWorksheetResult,
  Asset,
  AssetTaxonomyAssignment,
  CalculatedAdjustments,
  DriftReport,
  Holding,
  TaxonomyCategory,
  UnresolvedReason,
  WorksheetAccountFunding,
  WorksheetMode,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { useAssets } from "@/pages/asset/hooks/use-assets";
import { useLatestQuotes } from "@/pages/asset/hooks/use-latest-quotes";
import { useExchangeRates } from "@/pages/settings/general/exchange-rates/use-exchange-rate";

import { useAllocationWorksheet } from "../hooks/use-allocation-worksheet";
import { useCalculatedAdjustments } from "../hooks/use-calculated-adjustments";
import { useEligibleHoldingsSelection } from "../hooks/use-eligible-holdings";
import {
  allocationTargetColorForRow,
  buildAllocationTargetColorMap,
} from "./allocation-target-colors";
import {
  adjustmentsFromCalculated,
  allocationProgress,
  decimalInputOrZero,
  eligibleAccountIdsForChange,
  externalContributionFor,
  formatDecimalInput,
  generationInputsKey,
  parseDecimalInput,
  planningTotal,
  soleHoldingAccountId,
  type PositionAdjustment,
  type PositionAdjustments,
  type WorksheetEditMode,
  type WorksheetGenerationInputs,
} from "./allocation-worksheet-utils";
import { EligibleHoldingsSelector } from "./eligible-holdings-selector";
import { accountScopeKey } from "./target-scope";

const DISCLOSURE_STORAGE_KEY = "wealthfolio:rebalancing-worksheet-disclosure:v2";
const DRAFT_STORAGE_PREFIX = "wealthfolio:rebalancing-worksheet-draft:v3";
const DISCLOSURE_VERSION = 2;
const DRAFT_VERSION = 4;
const CASH_PRESETS = [0.25, 0.5, 0.75, 1] as const;
const AMOUNT_EPSILON = 0.01;
const AUTO_CALCULATE_DEBOUNCE_MS = 500;

const UNRESOLVED_REASON_KEYS: Record<UnresolvedReason, string> = {
  no_recorded_security: "allocation:worksheet.unresolvedNoRecordedSecurity",
  no_eligible_security: "allocation:worksheet.unresolvedNoEligibleSecurity",
  no_usable_price: "allocation:worksheet.unresolvedNoUsablePrice",
};

type WorksheetView = "position" | "review";
type FormatAmount = ReturnType<typeof useAmountFormatting>["formatAmount"];

interface AllocationWorksheetTabProps {
  profile: AllocationTarget | null;
  driftReport: DriftReport | null;
  accountScope: AccountScope;
  sourceVersion: string;
  isSourceLoading: boolean;
}

interface PositionAccountHolding {
  accountId: string;
  value: number;
  quantity: number;
}

interface PositionCategoryExposure {
  categoryId: string;
  categoryName: string;
  weightBps: number;
}

interface WorksheetPosition {
  assetId: string;
  symbol: string;
  name: string;
  value: number;
  quantity: number;
  currentPct: number;
  categoryIds: string[];
  categoryNames: string[];
  categoryExposures: PositionCategoryExposure[];
  accountHoldings: PositionAccountHolding[];
  isAdded: boolean;
}

/** The last calculated adjustments, and the inputs they were calculated from. */
interface GeneratedAdjustments {
  calculated: CalculatedAdjustments;
  inputsKey: string;
}

interface WorksheetDraft {
  version: number;
  savedAt: string;
  editMode: WorksheetEditMode;
  mode: WorksheetMode;
  rule: AllocationRule | null;
  /** `null` follows the cash the chosen accounts record. */
  trackedCash: string | null;
  externalCash: Record<string, string>;
  selectedAccountIds: string[];
  addedAssetIds: string[];
  adjustments: PositionAdjustments;
  generated: GeneratedAdjustments | null;
}

interface PreparedWorksheet {
  lines: AllocationWorksheetLineInput[];
  issue?: PreparedWorksheetIssue;
  increaseTotal: number;
  reductionTotal: number;
}

interface PreparedWorksheetIssue {
  message: string;
  kind: "cash" | "position" | "allocation";
  assetId?: string;
}

interface WorksheetCalculationError {
  title: string;
  description?: string;
}

function formatSignedAmount(value: number, currency: string, formatAmount: FormatAmount): string {
  if (!Number.isFinite(value) || Math.abs(value) < AMOUNT_EPSILON) return "—";
  return `${value > 0 ? "+" : "−"}${formatAmount(Math.abs(value), currency)}`;
}

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return "";
}

function worksheetDraftStorageKey(targetId: string, scope: AccountScope): string {
  return `${DRAFT_STORAGE_PREFIX}:${targetId}:${accountScopeKey(scope)}`;
}

function isPositionAdjustment(value: unknown): value is PositionAdjustment {
  if (!value || typeof value !== "object") return false;
  const adjustment = value as Partial<PositionAdjustment>;
  return (
    (adjustment.inputMode === "amount" || adjustment.inputMode === "after_percentage") &&
    typeof adjustment.inputValue === "string" &&
    !!adjustment.accountAmounts &&
    typeof adjustment.accountAmounts === "object"
  );
}

function isGeneratedAdjustments(value: unknown): value is GeneratedAdjustments {
  if (!value || typeof value !== "object") return false;
  const generated = value as Partial<GeneratedAdjustments>;
  return (
    typeof generated.inputsKey === "string" &&
    !!generated.calculated &&
    Array.isArray(generated.calculated.adjustments) &&
    Array.isArray(generated.calculated.unresolved) &&
    Array.isArray(generated.calculated.fundingShortfalls)
  );
}

function readWorksheetDraft(storageKey: string): WorksheetDraft | null {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    if (!parsed || typeof parsed !== "object") return null;
    const draft = parsed as Partial<WorksheetDraft>;
    if (
      draft.version !== DRAFT_VERSION ||
      (draft.editMode !== "amount" && draft.editMode !== "after_percentage") ||
      (draft.mode !== "invest_cash" && draft.mode !== "rebalance") ||
      (draft.rule !== null && draft.rule !== "current_holding_proportions") ||
      (draft.trackedCash !== null && typeof draft.trackedCash !== "string") ||
      !draft.externalCash ||
      typeof draft.externalCash !== "object" ||
      !Array.isArray(draft.selectedAccountIds) ||
      !Array.isArray(draft.addedAssetIds) ||
      !draft.adjustments ||
      typeof draft.adjustments !== "object" ||
      (draft.generated !== null && !isGeneratedAdjustments(draft.generated))
    ) {
      return null;
    }
    return draft as WorksheetDraft;
  } catch {
    return null;
  }
}

function positionChangeAmount(
  adjustment: PositionAdjustment | undefined,
  position: WorksheetPosition,
  basis: number,
): number {
  if (!adjustment || adjustment.inputValue.trim() === "") return 0;
  if (adjustment.inputMode === "amount") return parseDecimalInput(adjustment.inputValue);
  return (parseDecimalInput(adjustment.inputValue) / 100) * basis - position.value;
}

/**
 * The unit price the core will resolve a line at, in the base currency.
 *
 * Taken from the recorded holding rather than a quote, so it already carries
 * the currency conversion and any contract multiplier. A position with nothing
 * recorded has no price here, and the core reports the line instead.
 */
function unitPriceFor(position: WorksheetPosition): number | undefined {
  if (position.quantity <= 0 || position.value <= 0) return undefined;
  return position.value / position.quantity;
}

function buildPositions(
  holdings: Holding[],
  assets: Asset[],
  addedAssetIds: string[],
  report: DriftReport,
  taxonomyId: string,
  assignmentsByAsset: Map<string, AssetTaxonomyAssignment[]>,
  taxonomyCategories: TaxonomyCategory[],
): WorksheetPosition[] {
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const categoryById = new Map(taxonomyCategories.map((category) => [category.id, category]));
  const categoryValuesByAsset = new Map<
    string,
    Map<string, { categoryName: string; value: number }>
  >();
  for (const row of report.holdings?.rows ?? []) {
    if (row.isCash || !row.assetId) continue;
    const categories =
      categoryValuesByAsset.get(row.assetId) ??
      new Map<string, { categoryName: string; value: number }>();
    const current = categories.get(row.categoryId) ?? {
      categoryName: row.categoryName,
      value: 0,
    };
    current.value += row.value;
    categories.set(row.categoryId, current);
    categoryValuesByAsset.set(row.assetId, categories);
  }

  const positions = new Map<string, WorksheetPosition>();
  for (const holding of holdings) {
    const assetId = holding.instrument?.id;
    if (holding.holdingType !== HoldingType.SECURITY || !assetId || holding.quantity <= 0) continue;
    const asset = assetById.get(assetId);
    const categories =
      categoryValuesByAsset.get(assetId) ??
      new Map<string, { categoryName: string; value: number }>();
    const current: WorksheetPosition = positions.get(assetId) ?? {
      assetId,
      symbol: holding.instrument?.symbol ?? asset?.displayCode ?? assetId,
      name: holding.instrument?.name ?? asset?.name ?? holding.instrument?.symbol ?? assetId,
      value: 0,
      quantity: 0,
      currentPct: 0,
      categoryIds: [...categories.keys()],
      categoryNames: [...categories.values()].map((category) => category.categoryName),
      categoryExposures: [],
      accountHoldings: [],
      isAdded: false,
    };
    const value = Number(holding.marketValue.base) || 0;
    current.value += value;
    current.quantity += holding.quantity;
    const accountHolding = current.accountHoldings.find(
      (item) => item.accountId === holding.accountId,
    );
    if (accountHolding) {
      accountHolding.value += value;
      accountHolding.quantity += holding.quantity;
    } else {
      current.accountHoldings.push({
        accountId: holding.accountId,
        value,
        quantity: holding.quantity,
      });
    }
    positions.set(assetId, current);
  }

  for (const assetId of addedAssetIds) {
    if (positions.has(assetId)) continue;
    const asset = assetById.get(assetId);
    if (!asset) continue;
    const assignments = (assignmentsByAsset.get(assetId) ?? []).filter(
      (assignment) => assignment.taxonomyId === taxonomyId && assignment.weight > 0,
    );
    const assignedWeight = assignments.reduce((sum, assignment) => sum + assignment.weight, 0);
    const categoryExposures: PositionCategoryExposure[] = assignments.map((assignment) => ({
      categoryId: assignment.categoryId,
      categoryName: categoryById.get(assignment.categoryId)?.name ?? assignment.categoryId,
      weightBps: assignment.weight,
    }));
    if (assignedWeight < 10_000) {
      categoryExposures.push({
        categoryId: "__UNKNOWN__",
        categoryName: "Unclassified",
        weightBps: 10_000 - assignedWeight,
      });
    }
    positions.set(assetId, {
      assetId,
      symbol: asset.displayCode ?? asset.instrumentSymbol ?? asset.name ?? asset.id,
      name: asset.name ?? asset.displayCode ?? asset.instrumentSymbol ?? asset.id,
      value: 0,
      quantity: 0,
      currentPct: 0,
      categoryIds: categoryExposures.map((exposure) => exposure.categoryId),
      categoryNames: categoryExposures.map((exposure) => exposure.categoryName),
      categoryExposures,
      accountHoldings: [],
      isAdded: true,
    });
  }

  return [...positions.values()]
    .map((position) => {
      const categoryValues = categoryValuesByAsset.get(position.assetId);
      const classifiedValue = categoryValues
        ? [...categoryValues.values()].reduce((sum, category) => sum + category.value, 0)
        : 0;
      const categoryExposures =
        position.categoryExposures.length > 0
          ? position.categoryExposures
          : categoryValues && classifiedValue > 0
            ? [...categoryValues.entries()].map(([categoryId, category]) => ({
                categoryId,
                categoryName: category.categoryName,
                weightBps: Math.round((category.value / classifiedValue) * 10_000),
              }))
            : [
                {
                  categoryId: "__UNKNOWN__",
                  categoryName: "Unclassified",
                  weightBps: 10_000,
                },
              ];
      return {
        ...position,
        currentPct: report.totalValue > 0 ? (position.value / report.totalValue) * 100 : 0,
        categoryIds: categoryExposures.map((exposure) => exposure.categoryId),
        categoryNames: categoryExposures.map((exposure) => exposure.categoryName),
        categoryExposures,
        accountHoldings: [...position.accountHoldings].sort(
          (left, right) => right.value - left.value,
        ),
      };
    })
    .sort((left, right) => right.value - left.value || left.symbol.localeCompare(right.symbol));
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-muted-foreground font-mono text-[11px] uppercase tracking-[0.16em]">
      {children}
    </p>
  );
}

interface CalculationControlProps {
  mode: WorksheetMode;
  allowSells: boolean;
  onModeChange: (mode: WorksheetMode) => void;
  rule: AllocationRule | null;
  onRuleChange: (rule: AllocationRule) => void;
  holdings: Holding[];
  excludedAssetIds: ReadonlySet<string>;
  onToggleAsset: (assetId: string) => void;
  onSelectAllAssets: () => void;
  onClearAssets: () => void;
  accountNames: ReadonlyMap<string, string>;
  blockingIssue?: string;
  isCalculating: boolean;
  hasGenerated: boolean;
  isOutOfDate: boolean;
  error: string | null;
  onRecalculate: () => void;
  onReset: () => void;
}

function CalculationControl({
  mode,
  allowSells,
  onModeChange,
  rule,
  onRuleChange,
  holdings,
  excludedAssetIds,
  onToggleAsset,
  onSelectAllAssets,
  onClearAssets,
  accountNames,
  blockingIssue,
  isCalculating,
  hasGenerated,
  isOutOfDate,
  error,
  onRecalculate,
  onReset,
}: CalculationControlProps) {
  const { t } = useTranslation();
  const modes: { value: WorksheetMode; label: string; hint: string }[] = [
    {
      value: "invest_cash",
      label: t("allocation:worksheet.modeInvestCash"),
      hint: t("allocation:worksheet.modeInvestCashHint"),
    },
    {
      value: "rebalance",
      label: t("allocation:worksheet.modeRebalance"),
      hint: t("allocation:worksheet.modeRebalanceHint"),
    },
  ];
  const activeMode = modes.find((option) => option.value === mode);

  return (
    <div id="worksheet-calculation" className="min-w-0 space-y-5 p-5 sm:p-6 lg:border-r">
      <div>
        <Eyebrow>{t("allocation:worksheet.modeLabel")}</Eyebrow>
        <div className="border-border bg-muted/20 mt-2 inline-flex rounded-full border p-1">
          {modes.map((option) => {
            const disabled = option.value === "rebalance" && !allowSells;
            const button = (
              <button
                key={option.value}
                type="button"
                aria-pressed={mode === option.value}
                disabled={disabled}
                onClick={() => onModeChange(option.value)}
                className={cn(
                  "rounded-full px-4 py-1.5 font-mono text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                  mode === option.value
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {option.label}
              </button>
            );
            if (!disabled) return button;
            return (
              <TooltipProvider key={option.value} delayDuration={150}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span>{button}</span>
                  </TooltipTrigger>
                  <TooltipContent>{t("allocation:mode.enableSellsTip")}</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            );
          })}
        </div>
        {activeMode && (
          <p className="text-muted-foreground mt-2 text-xs leading-relaxed">{activeMode.hint}</p>
        )}
      </div>

      <div>
        <Eyebrow>{t("allocation:worksheet.ruleLabel")}</Eyebrow>
        <button
          type="button"
          aria-pressed={rule === "current_holding_proportions"}
          onClick={() => onRuleChange("current_holding_proportions")}
          className={cn(
            "mt-2 flex w-full items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors",
            rule === "current_holding_proportions"
              ? "border-foreground"
              : "border-border/70 hover:border-foreground/40 border-dashed",
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
              rule === "current_holding_proportions"
                ? "border-foreground bg-foreground text-background"
                : "border-border",
            )}
          >
            {rule === "current_holding_proportions" && <Icons.Check className="h-3 w-3" />}
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-medium">
              {t("allocation:worksheet.ruleCurrentHoldingProportions")}
            </span>
            <span className="text-muted-foreground mt-0.5 block text-xs leading-relaxed">
              {t("allocation:worksheet.ruleCurrentHoldingProportionsHint")}
            </span>
          </span>
        </button>
      </div>

      <EligibleHoldingsSelector
        holdings={holdings}
        excludedAssetIds={excludedAssetIds}
        onToggle={onToggleAsset}
        onSelectAll={onSelectAllAssets}
        onClear={onClearAssets}
        accountNames={accountNames}
      />

      <div className="space-y-3">
        {isOutOfDate && (
          <div
            role="status"
            className="rounded-lg border border-amber-400/50 bg-amber-50/60 px-3 py-2 dark:bg-amber-950/15"
          >
            <p className="text-xs leading-relaxed text-amber-950/80 dark:text-amber-100/80">
              {t("allocation:worksheet.inputsChanged")}
            </p>
          </div>
        )}
        {!hasGenerated && (
          <p className="text-muted-foreground text-xs leading-relaxed">
            {t("allocation:worksheet.notCalculatedDescription")}
          </p>
        )}
        {error && (
          <div
            role="alert"
            className="border-destructive/30 bg-destructive/5 rounded-lg border p-3"
          >
            <p className="text-destructive text-xs font-semibold">
              {t("allocation:worksheet.generateFailed")}
            </p>
            <p className="text-muted-foreground mt-1 text-xs leading-relaxed">{error}</p>
          </div>
        )}
        {blockingIssue && (
          <p className="text-muted-foreground text-xs leading-relaxed">{blockingIssue}</p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={!!blockingIssue || isCalculating} onClick={onRecalculate}>
            {isCalculating ? (
              <Icons.Spinner className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <Icons.RefreshCw className="mr-1.5 h-4 w-4" />
            )}
            {t("allocation:worksheet.recalculateFromTarget")}
          </Button>
          <Button size="sm" variant="ghost" disabled={!hasGenerated} onClick={onReset}>
            <Icons.Undo className="mr-1.5 h-4 w-4" />
            {t("allocation:worksheet.resetToCalculated")}
          </Button>
        </div>
      </div>
    </div>
  );
}

interface AccountsControlProps {
  accounts: Account[];
  selectedAccountIds: string[];
  onToggle: (accountId: string) => void;
  onSelectAll: () => void;
}

/** Which accounts the worksheet may change (§6). Cash accounts never appear. */
function AccountsControl({
  accounts,
  selectedAccountIds,
  onToggle,
  onSelectAll,
}: AccountsControlProps) {
  const { t } = useTranslation();
  const allSelected = selectedAccountIds.length === accounts.length;

  return (
    <div id="worksheet-accounts" className="min-w-0 p-5 sm:p-6 lg:border-r">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Eyebrow>{t("allocation:worksheet.accountsLabel")}</Eyebrow>
        <button
          type="button"
          disabled={allSelected}
          onClick={onSelectAll}
          className="text-foreground text-xs underline-offset-4 hover:underline disabled:pointer-events-none disabled:opacity-35"
        >
          {t("allocation:worksheet.selectAllAccounts")}
        </button>
      </div>
      <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
        {t("allocation:worksheet.accountsHint")}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {accounts.map((account) => {
          const selected = selectedAccountIds.includes(account.id);
          return (
            <button
              key={account.id}
              type="button"
              aria-pressed={selected}
              onClick={() => onToggle(account.id)}
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 font-mono text-xs transition-colors",
                selected
                  ? "border-foreground bg-foreground text-background"
                  : "border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground",
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "flex h-3.5 w-3.5 items-center justify-center rounded-full border",
                  selected ? "border-background" : "border-current/40",
                )}
              >
                {selected && <Icons.Check className="h-2.5 w-2.5" />}
              </span>
              {account.name}
            </button>
          );
        })}
      </div>
      {selectedAccountIds.length === 0 && (
        <p className="text-muted-foreground mt-2 text-xs">
          {t("allocation:worksheet.selectAccountIssue")}
        </p>
      )}
    </div>
  );
}

interface CashControlProps {
  /** What the chosen accounts record, as the core counts it. */
  availableCash: number | undefined;
  trackedCash: string | null;
  onTrackedCashChange: (value: string) => void;
  accounts: Account[];
  externalCash: Record<string, string>;
  onExternalCashChange: (accountId: string, value: string) => void;
  currency: string;
}

/**
 * The cash the worksheet may deploy, bounded by what the chosen accounts
 * actually record (§6).
 *
 * `availableCash` is unknown until the core has answered for this selection.
 * The drift report's figure is never substituted for it: that one spans the
 * whole scope and counts cash accounts, which hold no securities and cannot
 * fund one elsewhere with no transfer assumed.
 */
function CashControl({
  availableCash,
  trackedCash,
  onTrackedCashChange,
  accounts,
  externalCash,
  onExternalCashChange,
  currency,
}: CashControlProps) {
  const { t } = useTranslation();
  const { formatAmount, currencyFractionDigits } = useAmountFormatting();
  const fractionDigits = currencyFractionDigits(currency);
  // Nothing entered yet deploys all of it: the cash is already there, and
  // lowering it is one edit away.
  const displayValue =
    trackedCash ??
    (availableCash === undefined ? "" : formatDecimalInput(availableCash, fractionDigits));
  const selectedCash = Math.max(0, decimalInputOrZero(displayValue));
  const ceiling = availableCash ?? 0;
  const exceedsAvailable =
    availableCash !== undefined && selectedCash > availableCash + AMOUNT_EPSILON;
  const sliderPercentage = ceiling > 0 ? Math.min(100, (selectedCash / ceiling) * 100) : 0;

  return (
    <div id="worksheet-cash" className="min-w-0 p-5 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Eyebrow>{t("allocation:worksheet.cashToDeploy")}</Eyebrow>
        <span className="text-muted-foreground font-mono text-xs">
          {availableCash === undefined
            ? t("allocation:worksheet.cashAvailablePending")
            : t("allocation:worksheet.ofObservedCash", {
                amount: formatAmount(availableCash, currency),
              })}
        </span>
      </div>

      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-muted-foreground text-sm">{currency}</span>
        <input
          aria-label={t("allocation:worksheet.cashToDeploy")}
          value={displayValue}
          onChange={(event) => onTrackedCashChange(event.target.value)}
          onBlur={() => {
            if (exceedsAvailable) {
              onTrackedCashChange(formatDecimalInput(ceiling, fractionDigits));
            }
          }}
          inputMode="decimal"
          placeholder="0"
          className="placeholder:text-muted-foreground/50 min-w-0 flex-1 bg-transparent font-mono text-3xl font-semibold tabular-nums outline-none"
        />
      </div>

      {exceedsAvailable && (
        <p className="mt-2 text-[11px] leading-relaxed text-amber-800 dark:text-amber-200">
          {t("allocation:worksheet.exceedsObservedCashIssue", {
            amount: formatAmount(ceiling, currency),
          })}
        </p>
      )}

      <input
        aria-label={t("allocation:worksheet.cashSlider")}
        type="range"
        min={0}
        max={ceiling || 1}
        step={ceiling > 0 ? 10 ** -fractionDigits : 1}
        value={Math.min(selectedCash, ceiling)}
        disabled={ceiling <= 0}
        onChange={(event) =>
          onTrackedCashChange(Number.parseFloat(event.target.value).toFixed(fractionDigits))
        }
        className="lever-slider mt-3 block w-full disabled:cursor-not-allowed disabled:opacity-40"
        style={{ ["--lever-pct" as string]: `${sliderPercentage}%` }}
      />

      <div className="mt-3 flex flex-wrap gap-2">
        {CASH_PRESETS.map((fraction) => {
          const preset = ceiling * fraction;
          const isActive = Math.abs(preset - selectedCash) <= 0.5 + ceiling * 0.001;
          return (
            <button
              key={fraction}
              type="button"
              disabled={ceiling <= 0}
              onClick={() => onTrackedCashChange(preset.toFixed(fractionDigits))}
              className={cn(
                "rounded-full border px-3 py-1 font-mono text-xs transition-colors disabled:opacity-40",
                isActive
                  ? "border-foreground bg-foreground text-background"
                  : "border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground",
              )}
            >
              {fraction === 1
                ? t("allocation:worksheet.allCash")
                : `${Math.round(fraction * 100)}%`}
            </button>
          );
        })}
      </div>

      <div className="mt-5 border-t pt-4">
        <Eyebrow>{t("allocation:worksheet.externalCash")}</Eyebrow>
        <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
          {t(
            accounts.length > 1
              ? "allocation:worksheet.externalCashPerAccountHint"
              : "allocation:worksheet.externalCashHint",
          )}
        </p>
        <div className="mt-3 space-y-2">
          {accounts.map((account) => (
            <div
              key={account.id}
              className={cn(
                "flex items-center gap-3",
                accounts.length > 1 ? "justify-between" : "justify-start",
              )}
            >
              {accounts.length > 1 && (
                <span className="min-w-0 truncate text-xs font-medium">{account.name}</span>
              )}
              <div className="border-input bg-background focus-within:ring-ring flex h-9 w-44 shrink-0 items-center rounded-md border px-2.5 focus-within:ring-1">
                <span className="text-muted-foreground mr-1.5 text-xs">{currency}</span>
                <input
                  aria-label={
                    accounts.length > 1
                      ? t("allocation:worksheet.externalCashForAccount", { account: account.name })
                      : t("allocation:worksheet.externalCash")
                  }
                  value={externalCash[account.id] ?? ""}
                  onChange={(event) => onExternalCashChange(account.id, event.target.value)}
                  inputMode="decimal"
                  placeholder="0"
                  className="min-w-0 flex-1 bg-transparent text-right font-mono text-xs outline-none"
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

interface FundingSummaryProps {
  result: AllocationWorksheetResult | null;
  accountNames: Map<string, string>;
  currency: string;
}

/**
 * What each account can fund and what the worksheet asks of it (§6). A shortage
 * is reported, never corrected: after prefill the worksheet is the source of
 * truth (§5).
 */
function FundingSummary({ result, accountNames, currency }: FundingSummaryProps) {
  const { t } = useTranslation();
  const { formatAmount } = useAmountFormatting();

  return (
    <div className="min-w-0 p-5 sm:p-6">
      <Eyebrow>{t("allocation:worksheet.fundingLabel")}</Eyebrow>
      {!result ? (
        <p className="text-muted-foreground mt-2 text-xs leading-relaxed">
          {t("allocation:worksheet.fundingPending")}
        </p>
      ) : (
        <>
          <p className="mt-2 font-mono text-xl font-semibold leading-tight">
            {formatAmount(result.cashRemaining, currency)}
          </p>
          <p className="text-muted-foreground mt-1 text-xs">
            {t(
              result.cashRemaining < 0
                ? "allocation:worksheet.fundingShort"
                : "allocation:worksheet.fundingLeft",
            )}
          </p>
          <ul className="mt-4 divide-y">
            {result.accountFunding.map((funding) => (
              <li key={funding.accountId} className="py-2 text-xs">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate font-medium">
                    {accountNames.get(funding.accountId) ??
                      t("allocation:worksheet.unknownAccount")}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 font-mono tabular-nums",
                      funding.remaining < 0 && "text-amber-800 dark:text-amber-200",
                    )}
                  >
                    {formatAmount(funding.remaining, currency)}
                  </span>
                </div>
                {funding.remaining < 0 && (
                  <p className="mt-0.5 text-[11px] text-amber-800 dark:text-amber-200">
                    {t("allocation:worksheet.fundingNeeded", {
                      amount: formatAmount(-funding.remaining, currency),
                    })}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

interface CalculatedSummaryProps {
  calculated: CalculatedAdjustments;
  currency: string;
  accountNames: Map<string, string>;
}

/**
 * What the last calculation could not do in full (§4.4, §4.6): amounts it could
 * not place, limits that scaled it, cash it left over, and accounts that cannot
 * fund their increases on their own.
 */
function CalculatedSummary({ calculated, currency, accountNames }: CalculatedSummaryProps) {
  const { t } = useTranslation();
  const { formatAmount } = useAmountFormatting();
  const notes: string[] = [];
  if (calculated.scaling.reductionFactor != null) {
    notes.push(
      t("allocation:worksheet.reductionsScaled", {
        percent: formatDecimalInput(calculated.scaling.reductionFactor * 100, 1),
      }),
    );
  }
  if (calculated.scaling.increaseFactor != null) {
    notes.push(
      t("allocation:worksheet.increasesScaled", {
        percent: formatDecimalInput(calculated.scaling.increaseFactor * 100, 1),
      }),
    );
  }
  if (Math.abs(calculated.remainingCash) >= AMOUNT_EPSILON) {
    notes.push(
      t("allocation:worksheet.remainingCash", {
        amount: formatAmount(calculated.remainingCash, currency),
      }),
    );
  }
  for (const shortfall of calculated.fundingShortfalls) {
    notes.push(
      t("allocation:worksheet.accountShortfall", {
        account: accountNames.get(shortfall.accountId) ?? t("allocation:worksheet.unknownAccount"),
        required: formatAmount(shortfall.required, currency),
        available: formatAmount(shortfall.available, currency),
      }),
    );
  }

  if (notes.length === 0 && calculated.unresolved.length === 0) return null;

  return (
    <div className="bg-muted/10 border-b px-4 py-4 sm:px-5">
      <Eyebrow>{t("allocation:worksheet.calculatedSummary")}</Eyebrow>
      {notes.length > 0 && (
        <ul className="text-muted-foreground mt-2 space-y-1 text-xs leading-relaxed">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      {calculated.unresolved.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-medium">{t("allocation:worksheet.unresolvedTitle")}</p>
          <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
            {t("allocation:worksheet.unresolvedHint")}
          </p>
          <ul className="mt-2 divide-y">
            {calculated.unresolved.map((item) => (
              <li
                key={item.categoryId}
                className="flex items-baseline justify-between gap-3 py-1.5 text-xs"
              >
                <span className="min-w-0">
                  <span className="font-medium">{item.categoryName}</span>
                  <span className="text-muted-foreground">
                    {" · "}
                    {t(UNRESOLVED_REASON_KEYS[item.reason])}
                  </span>
                </span>
                <span className="shrink-0 font-mono tabular-nums">
                  {formatSignedAmount(item.amount, currency, formatAmount)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

interface AddPositionButtonProps {
  assets: Asset[];
  excludedAssetIds: Set<string>;
  onSelect: (assetId: string) => void;
}

function AddPositionButton({ assets, excludedAssetIds, onSelect }: AddPositionButtonProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const availableAssets = assets.filter((asset) => !excludedAssetIds.has(asset.id));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline">
          <Icons.Plus className="mr-1.5 h-4 w-4" />
          {t("allocation:worksheet.addPosition")}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[340px] max-w-[calc(100vw-2rem)] p-0" align="end">
        <Command>
          <CommandInput placeholder={t("allocation:worksheet.searchSecurities")} />
          <CommandList>
            <CommandEmpty>{t("allocation:worksheet.noMatchingSecurities")}</CommandEmpty>
            {availableAssets.map((asset) => {
              const symbol = asset.displayCode ?? asset.instrumentSymbol ?? asset.name ?? asset.id;
              return (
                <CommandItem
                  key={asset.id}
                  value={`${symbol} ${asset.name ?? ""}`}
                  onSelect={() => {
                    onSelect(asset.id);
                    setOpen(false);
                  }}
                  className="flex flex-col items-start gap-0.5 py-2"
                >
                  <span className="font-mono text-xs font-medium">{symbol}</span>
                  {asset.name && (
                    <span className="text-muted-foreground text-xs">{asset.name}</span>
                  )}
                </CommandItem>
              );
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

interface AccountAllocationProps {
  position: WorksheetPosition;
  changeAmount: number;
  accounts: Account[];
  adjustment: PositionAdjustment;
  currency: string;
  fundingByAccount: Map<string, WorksheetAccountFunding>;
  /** Resolved in the base currency, when the position records one. */
  unitPrice: number | undefined;
  wholeSharesOnly: boolean;
  /** The sole eligible account recording this security, which takes the change until the user splits it (§6). */
  impliedAccountId: string | undefined;
  onAmountChange: (accountId: string, value: string) => void;
}

/**
 * Where a change sits (§6). A single eligible account takes the whole change;
 * with several, the user places it and nothing is assigned by default.
 */
function AccountAllocation({
  position,
  changeAmount,
  accounts,
  adjustment,
  currency,
  fundingByAccount,
  unitPrice,
  wholeSharesOnly,
  impliedAccountId,
  onAmountChange,
}: AccountAllocationProps) {
  const { t } = useTranslation();
  const { formatAmount } = useAmountFormatting();
  const { formatQuantity } = useNumberFormatting();
  const requested = Math.abs(changeAmount);
  const hasEnteredAmount = accounts.some(
    (account) => (adjustment.accountAmounts[account.id] ?? "").trim() !== "",
  );
  const impliedHolder = hasEnteredAmount ? undefined : impliedAccountId;
  const amountFor = (accountId: string) =>
    impliedHolder === accountId
      ? requested
      : Math.max(0, decimalInputOrZero(adjustment.accountAmounts[accountId] ?? ""));
  const assigned =
    accounts.length === 1
      ? requested
      : accounts.reduce((sum, account) => sum + amountFor(account.id), 0);
  const { remaining, overallocated, isFullyAllocated } = allocationProgress(
    requested,
    assigned,
    AMOUNT_EPSILON,
  );
  const isReduce = changeAmount < 0;
  // Which accounts record the security is a fact about the portfolio, so it is
  // stated whether or not the user has since placed the change by hand. Only
  // the first sentence — that the app placed it — depends on that.
  const holderName = accounts.find((account) => account.id === impliedAccountId)?.name;
  const hint = isReduce
    ? "allocation:worksheet.reductionAccountAllocationHint"
    : accounts.length === 1
      ? "allocation:worksheet.singleAccountAllocationHint"
      : impliedHolder
        ? "allocation:worksheet.soleHolderAllocationHint"
        : impliedAccountId
          ? "allocation:worksheet.soleHolderSplitHint"
          : "allocation:worksheet.increaseAccountAllocationHint";

  return (
    <div
      data-account-allocation
      className="border-border/60 bg-muted/20 mt-3 rounded-xl border p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-mono text-[11px] font-medium uppercase tracking-[0.12em]">
            {t("allocation:worksheet.accountAllocation")}
          </p>
          <p className="text-muted-foreground mt-1 text-xs">{t(hint, { account: holderName })}</p>
        </div>
        <span
          className={cn(
            "rounded-full px-2.5 py-1 font-mono text-[11px]",
            isFullyAllocated
              ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-950/35 dark:text-emerald-200"
              : overallocated > AMOUNT_EPSILON
                ? "bg-red-100 text-red-900 dark:bg-red-950/35 dark:text-red-200"
                : "bg-amber-100 text-amber-900 dark:bg-amber-950/35 dark:text-amber-200",
          )}
        >
          {isFullyAllocated
            ? t("allocation:worksheet.fullyAllocated")
            : overallocated > AMOUNT_EPSILON
              ? t("allocation:worksheet.overAllocatedBy", {
                  amount: formatAmount(overallocated, currency),
                })
              : t("allocation:worksheet.remainingToAllocate", {
                  amount: formatAmount(remaining, currency),
                })}
        </span>
      </div>

      <div className="mt-3 divide-y">
        {accounts.length === 0 && (
          <p className="text-muted-foreground py-3 text-xs leading-relaxed">
            {t("allocation:worksheet.noEligibleAccounts")}
          </p>
        )}
        {accounts.map((account) => {
          const holding = position.accountHoldings.find((item) => item.accountId === account.id);
          const funding = fundingByAccount.get(account.id);
          const currentAmount = amountFor(account.id);
          const rowRemaining = Math.max(0, requested - (assigned - currentAmount));
          // The unit price is derived from the recorded holding rather than the
          // quote the core resolves against, so the floor gets a tolerance and
          // never drops a unit over the last decimal. A remainder that buys
          // nothing is still offered: the core reports such a line now, and
          // withholding the button only forces the same amount in by hand.
          const wholeUnitRemaining =
            wholeSharesOnly && unitPrice
              ? Math.floor(rowRemaining / unitPrice + 1e-9) * unitPrice
              : rowRemaining;
          const remainingToUse =
            wholeUnitRemaining > AMOUNT_EPSILON ? wholeUnitRemaining : rowRemaining;
          const currentUnits = unitPrice ? currentAmount / unitPrice : undefined;
          return (
            <div
              key={account.id}
              className="grid gap-2 py-3 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
            >
              <div className="min-w-0">
                <p className="flex min-w-0 items-center gap-1.5 text-xs font-medium">
                  <span className="truncate">{account.name}</span>
                  {impliedHolder === account.id && (
                    <span className="text-muted-foreground inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-normal">
                      <Icons.Check className="h-2.5 w-2.5" />
                      {t("allocation:worksheet.holdsThisSecurity")}
                    </span>
                  )}
                </p>
                <p className="text-muted-foreground mt-0.5 text-[11px]">
                  {holding &&
                    t("allocation:worksheet.accountHoldingSummary", {
                      amount: formatAmount(holding.value, currency),
                      quantity: formatQuantity(holding.quantity),
                    })}
                  {holding && !isReduce && " · "}
                  {!isReduce &&
                    t("allocation:worksheet.accountCashSummary", {
                      amount: formatAmount(funding?.availableCash ?? 0, currency),
                    })}
                </p>
                {funding && funding.remaining < -AMOUNT_EPSILON && (
                  <p className="mt-0.5 text-[11px] font-medium text-amber-800 dark:text-amber-200">
                    {t("allocation:worksheet.fundingNeeded", {
                      amount: formatAmount(-funding.remaining, currency),
                    })}
                  </p>
                )}
              </div>
              <div className="flex flex-col items-end gap-1">
                <div className="flex items-center gap-2">
                  {accounts.length === 1 ? (
                    <span className="font-mono text-sm font-semibold tabular-nums">
                      {formatAmount(requested, currency)}
                    </span>
                  ) : (
                    <>
                      <div className="border-input bg-background focus-within:ring-ring flex h-9 w-40 items-center rounded-md border px-2.5 focus-within:ring-1">
                        <span className="text-muted-foreground mr-1.5 text-xs">{currency}</span>
                        <input
                          aria-label={t("allocation:worksheet.accountAmountLabel", {
                            account: account.name,
                          })}
                          value={
                            impliedHolder === account.id
                              ? formatDecimalInput(requested, 6)
                              : (adjustment.accountAmounts[account.id] ?? "")
                          }
                          onChange={(event) => onAmountChange(account.id, event.target.value)}
                          inputMode="decimal"
                          placeholder="0"
                          className="min-w-0 flex-1 bg-transparent text-right font-mono text-xs outline-none"
                        />
                      </div>
                      {rowRemaining > AMOUNT_EPSILON && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 px-2 text-[11px]"
                          onClick={() =>
                            onAmountChange(account.id, formatDecimalInput(remainingToUse, 6))
                          }
                        >
                          {t("allocation:worksheet.useRemaining")}
                        </Button>
                      )}
                    </>
                  )}
                </div>
                {currentUnits !== undefined && currentAmount > AMOUNT_EPSILON && (
                  <span className="text-muted-foreground font-mono text-[10px] tabular-nums">
                    {t("allocation:worksheet.accountUnitsSummary", {
                      quantity: formatQuantity(
                        wholeSharesOnly ? Math.floor(currentUnits) : currentUnits,
                      ),
                    })}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface ImpactCategory {
  categoryId: string;
  categoryName: string;
  color: string;
  currentBps: number;
  projectedBps: number;
  targetBps: number;
  projectedDifferenceBps: number;
  effectiveBandBps: number;
}

function ImpactBar({
  label,
  categories,
  value,
  emphasis,
}: {
  label: string;
  categories: ImpactCategory[];
  value: (category: ImpactCategory) => number;
  emphasis?: boolean;
}) {
  return (
    <div className="flex items-center gap-3">
      <span
        className={cn(
          "w-16 shrink-0 font-mono text-[11px]",
          emphasis ? "text-foreground font-semibold" : "text-muted-foreground",
        )}
      >
        {label}
      </span>
      <div className="bg-muted/35 flex h-7 min-w-0 flex-1 overflow-hidden rounded-md">
        {categories.map((category) => {
          const width = value(category) / 100;
          if (width <= 0) return null;
          return (
            <div
              key={category.categoryId}
              className="flex min-w-0 items-center overflow-hidden pl-2 font-mono text-[10px] font-medium text-white/95"
              style={{ width: `${width}%`, background: category.color }}
              title={`${category.categoryName}: ${width.toFixed(1)}%`}
            >
              {width >= 14 ? `${width.toFixed(0)}%` : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface ReviewChangesProps {
  result: AllocationWorksheetResult | null;
  isStale: boolean;
  isCalculating: boolean;
  issue?: PreparedWorksheetIssue;
  calculationError: WorksheetCalculationError | null;
  accountNames: Map<string, string>;
  currency: string;
  onReviewIssue: () => void;
}

function ReviewChanges({
  result,
  isStale,
  isCalculating,
  issue,
  calculationError,
  accountNames,
  currency,
  onReviewIssue,
}: ReviewChangesProps) {
  const { t } = useTranslation();
  const { formatAmount, formatPrice } = useAmountFormatting();
  const { formatQuantity } = useNumberFormatting();
  const { formatDateTime } = useDateFormatting();
  const warningsByLine = new Map<string, string[]>();
  for (const warning of result?.warnings ?? []) {
    if (!warning.lineId) continue;
    const warnings = warningsByLine.get(warning.lineId) ?? [];
    warnings.push(warning.message);
    warningsByLine.set(warning.lineId, warnings);
  }

  if (!result) {
    return (
      <div className="px-5 py-14 text-center">
        {isCalculating ? (
          <Icons.Spinner className="text-muted-foreground mx-auto h-5 w-5 animate-spin" />
        ) : (
          <Icons.ListChecks className="text-muted-foreground mx-auto h-5 w-5" />
        )}
        <p className="mt-3 text-sm font-medium">
          {isCalculating
            ? t("allocation:worksheet.reviewUpdating")
            : t("allocation:worksheet.reviewEmpty")}
        </p>
        <p className="text-muted-foreground mx-auto mt-1 max-w-md text-xs leading-relaxed">
          {calculationError?.description ?? issue?.message ?? t("allocation:worksheet.reviewHint")}
        </p>
        {issue && (
          <Button size="sm" variant="outline" className="mt-4" onClick={onReviewIssue}>
            <Icons.AlertCircle className="mr-1.5 h-4 w-4" />
            {t("allocation:worksheet.reviewWorksheet")}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-4 sm:px-5">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-mono text-sm font-semibold">
              {t("allocation:worksheet.reviewChanges")}
            </h3>
            <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 font-mono text-[10px]">
              {t("allocation:worksheet.lineCount", { count: result.lines.length })}
            </span>
            {isStale && (
              <span className="rounded-full bg-amber-500/10 px-2 py-0.5 font-mono text-[10px] text-amber-800 dark:text-amber-200">
                {isCalculating
                  ? t("allocation:worksheet.updatingPreview")
                  : t("allocation:worksheet.previewOutOfDate")}
              </span>
            )}
          </div>
          <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
            {isStale ? t("allocation:worksheet.reviewStale") : t("allocation:worksheet.reviewHint")}
          </p>
        </div>
      </div>

      <div className={cn("transition-opacity", isStale && "pointer-events-none opacity-50")}>
        <div className="text-muted-foreground bg-muted/15 hidden grid-cols-[5.5rem_minmax(12rem,1.4fr)_minmax(9rem,1fr)_7rem_7rem_9rem] gap-3 border-b px-5 py-3 font-mono text-[10px] uppercase tracking-[0.14em] xl:grid">
          <span>{t("allocation:worksheet.direction")}</span>
          <span>{t("allocation:worksheet.security")}</span>
          <span>{t("allocation:worksheet.account")}</span>
          <span className="text-right">{t("allocation:worksheet.resolvedAmount")}</span>
          <span className="text-right">{t("allocation:worksheet.quantity")}</span>
          <span className="text-right">{t("allocation:worksheet.unitPrice")}</span>
        </div>

        <div className="divide-y">
          {result.lines.map((line) => {
            const warnings = warningsByLine.get(line.lineId) ?? [];
            return (
              <div
                key={line.lineId}
                className="grid gap-3 px-4 py-4 sm:px-5 xl:grid-cols-[5.5rem_minmax(12rem,1.4fr)_minmax(9rem,1fr)_7rem_7rem_9rem] xl:items-center"
              >
                <div>
                  <span className="bg-muted rounded-full px-2 py-1 font-mono text-[10px] font-medium">
                    {line.direction === "increase"
                      ? t("allocation:worksheet.increase")
                      : t("allocation:worksheet.reduce")}
                  </span>
                </div>
                <div className="min-w-0">
                  <p className="truncate font-mono text-xs font-semibold">
                    {line.symbol} · {line.name}
                  </p>
                  {warnings.length > 0 && (
                    <p
                      className="mt-1 flex items-center gap-1 text-[10px] text-amber-800 dark:text-amber-200"
                      title={warnings.join("\n")}
                    >
                      <Icons.AlertCircle className="h-3 w-3 shrink-0" />
                      {t("allocation:worksheet.lineWarningCount", { count: warnings.length })}
                    </p>
                  )}
                </div>
                <p className="truncate font-mono text-xs">
                  {accountNames.get(line.accountId) ?? t("allocation:worksheet.unknownAccount")}
                </p>
                <p className="font-mono text-xs font-semibold tabular-nums xl:text-right">
                  {formatAmount(line.estimatedAmount, currency)}
                </p>
                <p className="font-mono text-xs tabular-nums xl:text-right">
                  ≈ {formatQuantity(line.quantity)}
                </p>
                <div className="xl:text-right">
                  <TooltipProvider delayDuration={150}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className="border-muted-foreground/60 cursor-help border-b border-dotted font-mono text-xs tabular-nums"
                        >
                          {formatPrice(line.unitPrice, currency)}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="left" className="max-w-80 space-y-1 text-xs">
                        <p>
                          {t("allocation:worksheet.recordedPriceSource", {
                            price: formatPrice(
                              line.quoteSource.value,
                              line.quoteSource.fromCurrency,
                            ),
                            date: formatDateTime(line.quoteSource.timestamp),
                          })}
                        </p>
                        {line.fxSource ? (
                          <p>
                            {t("allocation:worksheet.fxConversionSource", {
                              from: line.fxSource.fromCurrency,
                              to: line.fxSource.toCurrency,
                              rate: formatDecimalInput(line.fxSource.value, 6),
                              date: formatDateTime(line.fxSource.timestamp),
                            })}
                          </p>
                        ) : (
                          <p>{t("allocation:worksheet.noFxConversion")}</p>
                        )}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <p className="text-muted-foreground border-t px-4 py-3 text-xs leading-relaxed sm:px-5">
        {t("allocation:worksheet.reviewDisclaimer")}
      </p>
    </div>
  );
}

interface ImpactRailProps {
  report: DriftReport;
  result: AllocationWorksheetResult | null;
  isStale: boolean;
  prepared: PreparedWorksheet;
  profile: AllocationTarget;
  calculationError: WorksheetCalculationError | null;
  isCalculating: boolean;
  firstUseOpen: boolean;
  onCalculate: () => void;
  onReviewIssue: () => void;
  onClassifySecurity: (lineId: string) => void;
}

function ImpactRail({
  report,
  result,
  isStale,
  prepared,
  profile,
  calculationError,
  isCalculating,
  firstUseOpen,
  onCalculate,
  onReviewIssue,
  onClassifySecurity,
}: ImpactRailProps) {
  const { t } = useTranslation();
  const { formatAmount } = useAmountFormatting();
  const driftByCategory = new Map(report.rows.map((row) => [row.categoryId, row]));
  const sourceRows =
    result?.categories ??
    report.rows.map((row) => ({
      categoryId: row.categoryId,
      categoryName: row.categoryName,
      currentBps: row.currentBps,
      projectedBps: row.currentBps,
      targetBps: row.targetBps,
      projectedDifferenceBps: row.driftBps,
    }));
  const visibleRows = sourceRows.filter(
    (row) => row.currentBps > 0 || row.projectedBps > 0 || row.targetBps > 0,
  );
  const colorMap = buildAllocationTargetColorMap(visibleRows);
  const categories: ImpactCategory[] = visibleRows.map((row, index) => ({
    ...row,
    color: allocationTargetColorForRow(row, colorMap, index),
    effectiveBandBps: driftByCategory.get(row.categoryId)?.effectiveBandBps ?? profile.driftBandBps,
  }));
  const outsideRange = categories.filter(
    (category) => Math.abs(category.projectedDifferenceBps) > category.effectiveBandBps,
  );
  const largestDifference = result?.maxDifferenceBpsAfter ?? report.maxDriftBps;
  const totalMoved = result ? result.increaseTotal + result.reductionTotal : 0;

  return (
    <Card className="overflow-hidden lg:sticky lg:top-4">
      <CardContent className="p-0">
        <div
          className={cn("p-5 transition-opacity sm:p-6", result && isStale && "opacity-50")}
          aria-busy={isCalculating}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Eyebrow>{t("allocation:worksheet.portfolioImpact")}</Eyebrow>
            {(isCalculating || (result && isStale)) && (
              <span className="rounded-full bg-[#557866]/10 px-2 py-1 font-mono text-[10px] text-[#365747] dark:text-[#9fc0ae]">
                {isCalculating
                  ? t("allocation:worksheet.updatingPreview")
                  : t("allocation:worksheet.previewOutOfDate")}
              </span>
            )}
          </div>

          <p className="mt-4 font-mono text-xl font-semibold leading-tight">
            {t("allocation:worksheet.outsideRangeImpact", {
              before: report.outOfBandCount,
              after: outsideRange.length,
            })}
          </p>
          <div className="text-muted-foreground mt-2 space-y-1 font-mono text-xs">
            <p>
              {t("allocation:worksheet.largestDifference", {
                amount: `${(largestDifference / 100).toFixed(1)}pp`,
              })}
            </p>
            {result && (
              <p>
                {t("allocation:worksheet.totalAdjusted", {
                  amount: formatAmount(totalMoved, report.baseCurrency),
                })}
              </p>
            )}
          </div>

          <div className="mt-5 space-y-2">
            <ImpactBar
              label={t("allocation:worksheet.currentLabel")}
              categories={categories}
              value={(category) => category.currentBps}
            />
            <ImpactBar
              label={t("allocation:worksheet.projectedLabel")}
              categories={categories}
              value={(category) => category.projectedBps}
              emphasis
            />
            <ImpactBar
              label={t("allocation:worksheet.target")}
              categories={categories}
              value={(category) => category.targetBps}
            />
          </div>
        </div>

        <div
          className={cn(
            "border-t px-5 py-4 transition-opacity sm:px-6",
            result && isStale && "opacity-55",
          )}
        >
          <p className="text-muted-foreground font-mono text-[11px] uppercase tracking-[0.14em]">
            {outsideRange.length > 0
              ? t("allocation:worksheet.outsideRange")
              : t("allocation:worksheet.withinRange")}
          </p>
          <div className="mt-2 divide-y">
            {outsideRange.slice(0, 5).map((category) => {
              const current = category.currentBps / 100;
              const projected = category.projectedBps / 100;
              const target = category.targetBps / 100;
              const bandStart = Math.max(0, target - category.effectiveBandBps / 100);
              const bandWidth = Math.min(100 - bandStart, category.effectiveBandBps / 50);
              return (
                <div key={category.categoryId} className="py-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-2 text-xs font-medium">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ background: category.color }}
                      />
                      <span className="truncate">{category.categoryName}</span>
                    </span>
                    <span className="shrink-0 font-mono text-xs tabular-nums">
                      {category.projectedDifferenceBps > 0 ? "+" : "−"}
                      {Math.abs(category.projectedDifferenceBps / 100).toFixed(1)}pp
                    </span>
                  </div>
                  <div className="relative mt-3 h-4">
                    <div className="bg-border absolute left-0 right-0 top-1.5 h-px" />
                    <div
                      className="dark:bg-muted absolute top-0 h-3 rounded-sm bg-[#e9e2c9]"
                      style={{ left: `${bandStart}%`, width: `${Math.max(2, bandWidth)}%` }}
                    />
                    <div
                      className="bg-foreground absolute top-0 h-3 w-0.5"
                      style={{ left: `${Math.min(100, target)}%` }}
                    />
                    <div
                      className="border-muted-foreground bg-background absolute top-1 h-2 w-2 -translate-x-1/2 rounded-full border"
                      style={{ left: `${Math.min(100, current)}%` }}
                    />
                    <div
                      className="absolute top-1 h-2 w-2 -translate-x-1/2 rounded-full"
                      style={{ left: `${Math.min(100, projected)}%`, background: category.color }}
                    />
                  </div>
                  <p className="text-muted-foreground mt-1 font-mono text-[10px]">
                    {current.toFixed(1)}% → {projected.toFixed(1)}% ·{" "}
                    {t("allocation:worksheet.target")} {target.toFixed(1)}%
                  </p>
                </div>
              );
            })}
            {outsideRange.length === 0 && (
              <p className="text-muted-foreground py-3 text-xs leading-relaxed">
                {t("allocation:worksheet.noOutsideRange")}
              </p>
            )}
          </div>
        </div>

        <div className="space-y-3 border-t p-5 sm:p-6">
          {calculationError && (
            <div
              role="alert"
              className="border-destructive/30 bg-destructive/5 rounded-lg border p-3"
            >
              <p className="text-destructive text-xs font-semibold">{calculationError.title}</p>
              {calculationError.description && (
                <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
                  {calculationError.description}
                </p>
              )}
            </div>
          )}
          {!calculationError && prepared.issue && (
            <p className="text-muted-foreground text-xs leading-relaxed">
              {prepared.issue.message}
            </p>
          )}
          {(prepared.issue || calculationError) && (
            <Button
              className="w-full"
              disabled={isCalculating || firstUseOpen}
              onClick={prepared.issue ? onReviewIssue : onCalculate}
            >
              {prepared.issue ? (
                <Icons.AlertCircle className="mr-1.5 h-4 w-4" />
              ) : (
                <Icons.BarChart className="mr-1.5 h-4 w-4" />
              )}
              {prepared.issue
                ? t("allocation:worksheet.reviewWorksheet")
                : t("allocation:worksheet.retryPreview")}
            </Button>
          )}

          {isCalculating && !prepared.issue && (
            <p className="text-muted-foreground flex items-center text-xs">
              <Icons.Spinner className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              {t("allocation:worksheet.updatingFromSources")}
            </p>
          )}

          {result && !isStale && result.warnings.length > 0 && (
            <details className="rounded-lg border border-amber-400/50 bg-amber-50/50 px-3 py-2 dark:bg-amber-950/15">
              <summary className="cursor-pointer text-xs font-medium text-amber-950 dark:text-amber-200">
                {t("allocation:worksheet.warningCount", { count: result.warnings.length })}
              </summary>
              <ul className="mt-2 space-y-2 text-xs text-amber-950/75 dark:text-amber-100/75">
                {result.warnings.map((warning) => (
                  <li key={warning.id}>
                    • {warning.message}
                    {(warning.kind === "partial_classification" ||
                      warning.kind === "unclassified_asset") &&
                      warning.lineId && (
                        <Button
                          variant="link"
                          size="sm"
                          className="ml-1 h-auto p-0 text-xs text-amber-900 underline dark:text-amber-200"
                          onClick={() => onClassifySecurity(warning.lineId!)}
                        >
                          {t("allocation:worksheet.classifySecurity")}
                        </Button>
                      )}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function AllocationWorksheetTab({
  profile,
  driftReport,
  accountScope,
  sourceVersion,
  isSourceLoading,
}: AllocationWorksheetTabProps) {
  const { t } = useTranslation();
  const { formatAmount } = useAmountFormatting();
  const navigate = useNavigate();
  const worksheet = useAllocationWorksheet();
  const calculator = useCalculatedAdjustments();
  const syncPrice = useSyncMarketDataMutation(true);
  const exchangeRates = useExchangeRates();
  const { assets, isLoading: assetsLoading } = useAssets();
  const taxonomy = useTaxonomy(profile?.taxonomyId ?? null);
  const { accounts: holdingAccounts, isLoading: accountsLoading } = useAccounts({
    accountPurpose: AccountPurpose.HOLDINGS,
  });
  // Cash accounts track cash rather than investments: they can neither receive
  // a security nor, with no transfer assumed, fund one elsewhere.
  const accounts = useMemo(
    () => holdingAccounts.filter((account) => account.accountType !== AccountType.CASH),
    [holdingAccounts],
  );
  const { data: portfolios = [] } = usePortfolios();

  const [view, setView] = useState<WorksheetView>("position");
  const [editMode, setEditMode] = useState<WorksheetEditMode>("amount");
  const [mode, setMode] = useState<WorksheetMode>("invest_cash");
  const [rule, setRule] = useState<AllocationRule | null>(null);
  // `null` follows the cash the chosen accounts record; a string is the
  // user's own figure.
  const [trackedCash, setTrackedCash] = useState<string | null>(null);
  const [observedCashByAccounts, setObservedCashByAccounts] = useState<{
    key: string;
    amount: number;
  } | null>(null);
  const [externalCash, setExternalCash] = useState<Record<string, string>>({});
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[] | null>(null);
  const [addedAssetIds, setAddedAssetIds] = useState<string[]>([]);
  const [adjustments, setAdjustments] = useState<PositionAdjustments>({});
  const [generated, setGenerated] = useState<GeneratedAdjustments | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [expandedAssetIds, setExpandedAssetIds] = useState<Set<string>>(new Set());
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [result, setResult] = useState<AllocationWorksheetResult | null>(null);
  const [isResultStale, setIsResultStale] = useState(false);
  const [calculationError, setCalculationError] = useState<WorksheetCalculationError | null>(null);
  const calculationVersionRef = useRef(0);
  const calculateRef = useRef<(() => Promise<void>) | null>(null);
  const autoCalculateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initializedScopeRef = useRef("");
  const draftStorageKey = profile ? worksheetDraftStorageKey(profile.id, accountScope) : null;
  const [firstUseOpen, setFirstUseOpen] = useState(() => {
    try {
      const stored = localStorage.getItem(DISCLOSURE_STORAGE_KEY);
      if (!stored) return true;
      const parsed: unknown = JSON.parse(stored);
      return !(
        parsed &&
        typeof parsed === "object" &&
        "version" in parsed &&
        parsed.version === DISCLOSURE_VERSION
      );
    } catch {
      return true;
    }
  });

  const scopedAccounts = useMemo(() => {
    if (accountScope.type === "account") {
      return accounts.filter((account) => account.id === accountScope.accountId);
    }
    if (accountScope.type === "accounts") {
      return accounts.filter((account) => accountScope.accountIds.includes(account.id));
    }
    if (accountScope.type === "portfolio") {
      const accountIds =
        portfolios.find((portfolio) => portfolio.id === accountScope.portfolioId)?.accountIds ?? [];
      return accounts.filter((account) => accountIds.includes(account.id));
    }
    return accounts;
  }, [accountScope, accounts, portfolios]);
  const scopedAccountIds = useMemo(
    () => scopedAccounts.map((account) => account.id),
    [scopedAccounts],
  );
  const scopedAccountKey = [...scopedAccountIds].sort().join("|");
  // Where changes may happen. Everything in scope until the user narrows it;
  // the target's weights are still measured against the whole scope.
  const changeAccounts = useMemo(
    () =>
      selectedAccountIds === null
        ? scopedAccounts
        : scopedAccounts.filter((account) => selectedAccountIds.includes(account.id)),
    [scopedAccounts, selectedAccountIds],
  );
  const changeAccountIds = useMemo(
    () => changeAccounts.map((account) => account.id),
    [changeAccounts],
  );
  const changeAccountKey = [...changeAccountIds].sort().join("|");
  // What the chosen accounts can deploy, as the core counts it: one rule per
  // account and in total. The drift report's figure spans the whole scope and
  // counts cash accounts the worksheet cannot use, so it never stands in —
  // until the core has answered for this selection the ceiling is unknown.
  const availableCash =
    observedCashByAccounts?.key === changeAccountKey
      ? Math.max(0, observedCashByAccounts.amount)
      : undefined;

  const holdingQueries = useQueries({
    queries: scopedAccounts.map((account) => {
      const filter: AccountScope = { type: "account", accountId: account.id };
      return {
        queryKey: [QueryKeys.HOLDINGS, filter],
        queryFn: () => getHoldingsList(filter),
      };
    }),
  });
  const scopedHoldings = holdingQueries.flatMap((query) => query.data ?? []);
  const holdingsLoading = holdingQueries.some((query) => query.isPending);
  const holdingsVersion = holdingQueries.map((query) => query.dataUpdatedAt).join("|");
  const addedAssignmentQueries = useQueries({
    queries: addedAssetIds.map((assetId) => ({
      queryKey: QueryKeys.assetTaxonomyAssignments(assetId),
      queryFn: () => getAssetTaxonomyAssignments(assetId),
    })),
  });
  const assignmentSourceVersion = addedAssignmentQueries
    .map((query) => query.dataUpdatedAt)
    .join("|");
  const assignmentsByAsset = new Map(
    addedAssetIds.map((assetId, index) => [assetId, addedAssignmentQueries[index]?.data ?? []]),
  );
  const changeHoldings = scopedHoldings.filter((holding) =>
    changeAccountIds.includes(holding.accountId),
  );
  const eligibility = useEligibleHoldingsSelection(
    changeHoldings,
    `${draftStorageKey ?? ""}:${[...changeAccountIds].sort().join(",")}`,
  );

  const eligibleAssets = useMemo(
    () =>
      assets
        .filter((asset) => asset.isActive !== false && asset.kind === "INVESTMENT")
        .sort((left, right) => {
          const leftLabel = left.displayCode ?? left.name ?? left.id;
          const rightLabel = right.displayCode ?? right.name ?? right.id;
          return leftLabel.localeCompare(rightLabel);
        }),
    [assets],
  );
  const positions =
    driftReport && profile
      ? buildPositions(
          changeHoldings,
          eligibleAssets,
          addedAssetIds,
          driftReport,
          profile.taxonomyId,
          assignmentsByAsset,
          taxonomy.data?.categories ?? [],
        )
      : [];
  const positionByAsset = new Map(positions.map((position) => [position.assetId, position]));
  const latestQuotes = useLatestQuotes(positions.map((position) => position.assetId));
  const accountById = useMemo(
    () => new Map(scopedAccounts.map((account) => [account.id, account])),
    [scopedAccounts],
  );
  const accountNames = useMemo(
    () => new Map(scopedAccounts.map((account) => [account.id, account.name])),
    [scopedAccounts],
  );
  const assetSourceVersion = useMemo(
    () => eligibleAssets.map((asset) => `${asset.id}:${asset.updatedAt}`).join("|"),
    [eligibleAssets],
  );

  useEffect(() => {
    if (
      !draftStorageKey ||
      !scopedAccountKey ||
      initializedScopeRef.current === draftStorageKey ||
      isSourceLoading ||
      assetsLoading ||
      accountsLoading ||
      holdingsLoading
    ) {
      return;
    }

    const draft = readWorksheetDraft(draftStorageKey);
    const validAccountIds = new Set(scopedAccountIds);
    const validAssetIds = new Set(eligibleAssets.map((asset) => asset.id));
    const restoredAdjustments: PositionAdjustments = {};
    for (const [assetId, value] of Object.entries(draft?.adjustments ?? {})) {
      if (!validAssetIds.has(assetId) || !isPositionAdjustment(value)) continue;
      restoredAdjustments[assetId] = {
        inputMode: value.inputMode,
        inputValue: value.inputValue,
        accountAmounts: Object.fromEntries(
          Object.entries(value.accountAmounts).filter(
            ([accountId, amount]) => validAccountIds.has(accountId) && typeof amount === "string",
          ),
        ),
      };
    }

    initializedScopeRef.current = draftStorageKey;
    setEditMode(draft?.editMode ?? "amount");
    setMode(draft?.mode === "rebalance" && profile?.allowSells ? "rebalance" : "invest_cash");
    setRule(draft?.rule ?? null);
    setTrackedCash(draft?.trackedCash ?? null);
    setSelectedAccountIds(
      draft?.selectedAccountIds
        ? draft.selectedAccountIds.filter((accountId) => validAccountIds.has(accountId))
        : null,
    );
    setExternalCash(
      Object.fromEntries(
        Object.entries(draft?.externalCash ?? {}).filter(
          ([accountId, amount]) => validAccountIds.has(accountId) && typeof amount === "string",
        ),
      ),
    );
    setAddedAssetIds(
      (draft?.addedAssetIds ?? []).filter(
        (assetId): assetId is string => typeof assetId === "string" && validAssetIds.has(assetId),
      ),
    );
    setAdjustments(restoredAdjustments);
    setGenerated(draft?.generated ?? null);
    setGenerateError(null);
    setExpandedAssetIds(new Set(Object.keys(restoredAdjustments)));
    setResult(null);
    setCalculationError(null);
    setCategoryFilter("all");
    setView("position");
  }, [
    accountsLoading,
    assetsLoading,
    draftStorageKey,
    eligibleAssets,
    holdingsLoading,
    isSourceLoading,
    profile?.allowSells,
    scopedAccountIds,
    scopedAccountKey,
  ]);

  useEffect(() => {
    if (!draftStorageKey || initializedScopeRef.current !== draftStorageKey) return;
    const timer = setTimeout(() => {
      const draft: WorksheetDraft = {
        version: DRAFT_VERSION,
        savedAt: new Date().toISOString(),
        editMode,
        mode,
        rule,
        trackedCash,
        externalCash,
        selectedAccountIds: changeAccountIds,
        addedAssetIds,
        adjustments,
        generated,
      };
      try {
        localStorage.setItem(draftStorageKey, JSON.stringify(draft));
      } catch {
        // Draft persistence is optional; the current worksheet remains usable.
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [
    addedAssetIds,
    adjustments,
    draftStorageKey,
    editMode,
    externalCash,
    generated,
    mode,
    rule,
    trackedCash,
    changeAccountIds,
  ]);

  // Validates and projects the worksheet as it stands. Mode, rule and eligible
  // securities are deliberately absent: they only matter when adjustments are
  // calculated, and that happens on an explicit action alone (§5).
  useEffect(() => {
    if (autoCalculateTimerRef.current) clearTimeout(autoCalculateTimerRef.current);
    calculationVersionRef.current += 1;
    setIsResultStale(true);
    setCalculationError(null);
    worksheet.reset();
    autoCalculateTimerRef.current = setTimeout(() => {
      void calculateRef.current?.();
    }, AUTO_CALCULATE_DEBOUNCE_MS);
    return () => {
      if (autoCalculateTimerRef.current) clearTimeout(autoCalculateTimerRef.current);
    };
    // The dependencies represent user input or source-data changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    adjustments,
    trackedCash,
    // The cash the accounts record is learned from the core, and the default
    // follows it.
    availableCash,
    externalCash,
    changeAccountIds,
    addedAssetIds,
    sourceVersion,
    latestQuotes.dataUpdatedAt,
    exchangeRates.dataUpdatedAt,
    assetSourceVersion,
    assignmentSourceVersion,
    taxonomy.dataUpdatedAt,
    holdingsVersion,
    firstUseOpen,
  ]);

  if (isSourceLoading || assetsLoading || accountsLoading || holdingsLoading) {
    return <Skeleton className="h-[38rem] w-full rounded-xl" />;
  }
  if (!profile || !driftReport) return null;

  const currency = driftReport.baseCurrency;
  const fundingByAccount = new Map(
    (result && !isResultStale ? result.accountFunding : []).map((funding) => [
      funding.accountId,
      funding,
    ]),
  );
  const rawTrackedCash = trackedCash === null ? null : parseDecimalInput(trackedCash);
  const trackedCashToUse =
    rawTrackedCash === null
      ? (availableCash ?? 0)
      : Number.isFinite(rawTrackedCash)
        ? Math.min(Math.max(0, rawTrackedCash), availableCash ?? Math.max(0, rawTrackedCash))
        : 0;
  const externalContribution = externalContributionFor(changeAccountIds, externalCash);
  const externalTotal = Object.values(externalContribution).reduce(
    (sum, amount) => sum + amount,
    0,
  );
  const basis = planningTotal(
    driftReport.totalValue,
    trackedCashToUse,
    externalTotal,
    driftReport.rows.some((row) => row.isCash),
  );

  // Asking for more cash than the accounts record is not an error: the cash
  // control caps it and points the rest at the contribution input.
  const cashIssue: PreparedWorksheetIssue | undefined =
    rawTrackedCash !== null && !Number.isFinite(rawTrackedCash)
      ? { message: t("allocation:worksheet.invalidCashInput"), kind: "cash" }
      : rawTrackedCash !== null && rawTrackedCash < 0
        ? { message: t("allocation:worksheet.cashMustBePositive"), kind: "cash" }
        : changeAccountIds.some((accountId) => {
              const amount = parseDecimalInput(externalCash[accountId] ?? "");
              return !Number.isFinite(amount) || amount < 0;
            })
          ? { message: t("allocation:worksheet.invalidExternalCash"), kind: "cash" }
          : undefined;

  const generationInputs: WorksheetGenerationInputs | null = rule
    ? {
        targetId: profile.id,
        targetVersion: profile.updatedAt,
        accountIds: changeAccountIds,
        mode,
        rule,
        trackedCashToUse,
        externalContribution,
        eligibleAssetIds: eligibility.eligibleAssetIds,
      }
    : null;
  const isOutOfDate = Boolean(
    generated && generationInputs && generated.inputsKey !== generationInputsKey(generationInputs),
  );
  const generationIssue = !rule
    ? t("allocation:worksheet.chooseRuleIssue")
    : changeAccountIds.length === 0
      ? t("allocation:worksheet.selectAccountIssue")
      : cashIssue?.message;

  const categories = driftReport.rows.filter(
    (row) => !row.isCash && row.categoryId !== "__UNKNOWN__",
  );
  const unresolvedByCategory = new Map(
    (generated?.calculated.unresolved ?? []).map((item) => [item.categoryId, item.amount]),
  );
  const visiblePositions = positions.filter(
    (position) => categoryFilter === "all" || position.categoryIds.includes(categoryFilter),
  );

  /**
   * The account an increase lands in without the user placing it (§6): the one
   * eligible account that already records the security. A second holder hands
   * the choice back.
   */
  function impliedAccountIdFor(
    position: WorksheetPosition,
    changeAmount: number,
  ): string | undefined {
    if (changeAmount <= 0) return undefined;
    return soleHoldingAccountId(
      position.accountHoldings
        .filter((holding) => holding.quantity > 0)
        .map((holding) => holding.accountId),
      accountsForChange(position, changeAmount).map((account) => account.id),
    );
  }

  function accountsForChange(position: WorksheetPosition, changeAmount: number): Account[] {
    return eligibleAccountIdsForChange(
      changeAmount,
      position.accountHoldings.map((holding) => holding.accountId),
      changeAccountIds,
    ).flatMap((accountId) => {
      const account = accountById.get(accountId);
      return account ? [account] : [];
    });
  }

  const prepared: PreparedWorksheet = (() => {
    const lines: AllocationWorksheetLineInput[] = [];
    let increaseTotal = 0;
    let reductionTotal = 0;
    let issue: PreparedWorksheetIssue | undefined = cashIssue;

    for (const position of positions) {
      const adjustment = adjustments[position.assetId];
      if (adjustment && !Number.isFinite(parseDecimalInput(adjustment.inputValue))) {
        issue ??= {
          message: t("allocation:worksheet.invalidPositionInput", { symbol: position.symbol }),
          kind: "position",
          assetId: position.assetId,
        };
        continue;
      }
      const changeAmount = positionChangeAmount(adjustment, position, basis);
      if (!adjustment || Math.abs(changeAmount) < AMOUNT_EPSILON) continue;

      if (changeAmount < 0 && !profile.allowSells) {
        issue ??= {
          message: t("allocation:worksheet.reductionsDisabledIssue", { symbol: position.symbol }),
          kind: "position",
          assetId: position.assetId,
        };
        continue;
      }
      if (changeAmount < 0 && Math.abs(changeAmount) > position.value + AMOUNT_EPSILON) {
        issue ??= {
          message: t("allocation:worksheet.reductionExceedsPositionIssue", {
            symbol: position.symbol,
            amount: formatAmount(position.value, currency),
          }),
          kind: "position",
          assetId: position.assetId,
        };
        continue;
      }

      const requestedAmount = Math.abs(changeAmount);
      if (changeAmount > 0) increaseTotal += requestedAmount;
      else reductionTotal += requestedAmount;

      const eligibleAccounts = accountsForChange(position, changeAmount);
      if (eligibleAccounts.length === 0) {
        issue ??= {
          message: t("allocation:worksheet.noEligibleAccountIssue", { symbol: position.symbol }),
          kind: "allocation",
          assetId: position.assetId,
        };
        continue;
      }

      const hasInvalidAccountAmount =
        eligibleAccounts.length > 1 &&
        eligibleAccounts.some((account) => {
          const value = adjustment.accountAmounts[account.id] ?? "";
          return value.trim() !== "" && !Number.isFinite(parseDecimalInput(value));
        });
      if (hasInvalidAccountAmount) {
        issue ??= {
          message: t("allocation:worksheet.invalidAccountAmount", { symbol: position.symbol }),
          kind: "allocation",
          assetId: position.assetId,
        };
        continue;
      }

      const impliedAccountId = impliedAccountIdFor(position, changeAmount);
      const hasEnteredAllocation = eligibleAccounts.some(
        (account) => (adjustment.accountAmounts[account.id] ?? "").trim() !== "",
      );
      const allocations =
        eligibleAccounts.length === 1
          ? [{ accountId: eligibleAccounts[0].id, amount: requestedAmount }]
          : impliedAccountId && !hasEnteredAllocation
            ? [{ accountId: impliedAccountId, amount: requestedAmount }]
            : eligibleAccounts
                .map((account) => ({
                  accountId: account.id,
                  amount: Math.max(
                    0,
                    decimalInputOrZero(adjustment.accountAmounts[account.id] ?? ""),
                  ),
                }))
                .filter((allocation) => allocation.amount >= AMOUNT_EPSILON);
      const allocatedAmount = allocations.reduce((sum, allocation) => sum + allocation.amount, 0);
      // Under a whole-unit policy the last fraction of a unit buys nothing, so
      // no account can take it. Demanding it be placed would leave the
      // worksheet permanently unreviewable; anything from a whole unit up still
      // has to be placed.
      const positionUnitPrice = unitPriceFor(position);
      const unplaceable =
        profile.wholeSharesOnly && positionUnitPrice ? Math.max(0.02, positionUnitPrice) : 0.02;
      if (
        eligibleAccounts.length > 1 &&
        (requestedAmount - allocatedAmount > unplaceable ||
          allocatedAmount - requestedAmount > 0.02)
      ) {
        issue ??= {
          message: t("allocation:worksheet.allocateAccountsIssue", {
            symbol: position.symbol,
            amount: formatAmount(requestedAmount, currency),
          }),
          kind: "allocation",
          assetId: position.assetId,
        };
        continue;
      }

      for (const allocation of allocations) {
        const accountHolding = position.accountHoldings.find(
          (holding) => holding.accountId === allocation.accountId,
        );
        const reducesEntireAccountHolding =
          changeAmount < 0 &&
          accountHolding !== undefined &&
          Math.abs(allocation.amount - accountHolding.value) <= 0.02;
        lines.push({
          lineId: `position:${position.assetId}:${allocation.accountId}:${changeAmount > 0 ? "increase" : "reduce"}`,
          direction: changeAmount > 0 ? "increase" : "reduce",
          assetId: position.assetId,
          accountId: allocation.accountId,
          inputMode: reducesEntireAccountHolding ? "quantity" : "amount",
          value: reducesEntireAccountHolding
            ? accountHolding.quantity
            : Number(allocation.amount.toFixed(6)),
        });
      }
    }

    return { lines, issue, increaseTotal, reductionTotal };
  })();
  const isPreviewUpdating =
    worksheet.isPending || (isResultStale && !prepared.issue && calculationError === null);
  const resultByAsset = new Map<string, { amount: number; quantity: number }>();
  if (result && !isResultStale) {
    for (const line of result.lines) {
      const current = resultByAsset.get(line.assetId) ?? { amount: 0, quantity: 0 };
      const sign = line.direction === "increase" ? 1 : -1;
      current.amount += sign * line.estimatedAmount;
      current.quantity += sign * line.quantity;
      resultByAsset.set(line.assetId, current);
    }
  }

  function updateAdjustment(assetId: string, next: PositionAdjustment | null) {
    setAdjustments((current) => {
      const updated = { ...current };
      if (!next) delete updated[assetId];
      else updated[assetId] = next;
      return updated;
    });
  }

  function updatePositionInput(position: WorksheetPosition, value: string) {
    updateAdjustment(position.assetId, {
      inputMode: editMode,
      inputValue: value,
      accountAmounts: {},
    });
    const nextChange =
      editMode === "amount"
        ? parseDecimalInput(value)
        : (parseDecimalInput(value) / 100) * basis - position.value;
    if (Math.abs(nextChange) >= AMOUNT_EPSILON) {
      setExpandedAssetIds((current) => new Set(current).add(position.assetId));
    }
  }

  function reducePositionToZero(position: WorksheetPosition) {
    updateAdjustment(position.assetId, {
      inputMode: editMode,
      inputValue: editMode === "amount" ? formatDecimalInput(-position.value, 6) : "0",
      accountAmounts: Object.fromEntries(
        position.accountHoldings.map((holding) => [
          holding.accountId,
          formatDecimalInput(holding.value, 6),
        ]),
      ),
    });
    setExpandedAssetIds((current) => new Set(current).add(position.assetId));
  }

  function switchEditMode(nextMode: WorksheetEditMode) {
    if (nextMode === editMode) return;
    setAdjustments((current) => {
      const updated: PositionAdjustments = {};
      for (const [assetId, adjustment] of Object.entries(current)) {
        const position = positionByAsset.get(assetId);
        if (!position) continue;
        const change = positionChangeAmount(adjustment, position, basis);
        updated[assetId] = {
          ...adjustment,
          inputMode: nextMode,
          inputValue:
            nextMode === "amount"
              ? formatDecimalInput(change, 6)
              : formatDecimalInput(basis > 0 ? ((position.value + change) / basis) * 100 : 0, 4),
        };
      }
      return updated;
    });
    setEditMode(nextMode);
  }

  function updateAccountAmount(assetId: string, accountId: string, value: string) {
    const adjustment = adjustments[assetId];
    if (!adjustment) return;
    updateAdjustment(assetId, {
      ...adjustment,
      accountAmounts: { ...adjustment.accountAmounts, [accountId]: value },
    });
  }

  function removeAddedPosition(assetId: string) {
    setAddedAssetIds((current) => current.filter((id) => id !== assetId));
    updateAdjustment(assetId, null);
    setExpandedAssetIds((current) => {
      const next = new Set(current);
      next.delete(assetId);
      return next;
    });
  }

  /** Replaces the worksheet with a calculated set. Only the two explicit actions call this. */
  function applyCalculated(calculated: CalculatedAdjustments) {
    const prefilled = adjustmentsFromCalculated(calculated);
    setEditMode("amount");
    setAdjustments(prefilled);
    setAddedAssetIds([]);
    setExpandedAssetIds(new Set(Object.keys(prefilled)));
    setResult(null);
    setCalculationError(null);
    setView("position");
  }

  async function recalculateFromTarget() {
    if (!generationInputs || generationIssue) return;
    setGenerateError(null);
    try {
      const calculated = await calculator.mutateAsync({
        targetId: generationInputs.targetId,
        filter: accountScope,
        mode: generationInputs.mode,
        rule: generationInputs.rule,
        cash: { trackedCashToUse, externalContribution },
        selectedAccountIds: changeAccountIds,
        eligibleAssetIds: generationInputs.eligibleAssetIds,
      });
      setGenerated({ calculated, inputsKey: generationInputsKey(generationInputs) });
      applyCalculated(calculated);
    } catch (error) {
      setGenerateError(errorMessage(error).replace(/^.*?Invalid input:\s*/i, "") || null);
    }
  }

  function resetToCalculated() {
    if (generated) applyCalculated(generated.calculated);
  }

  function reviewPreparedIssue() {
    const issue = prepared.issue;
    if (!issue) return;
    if (issue.assetId) {
      if (issue.kind === "allocation") {
        setExpandedAssetIds((current) => new Set(current).add(issue.assetId!));
      }
      requestAnimationFrame(() => {
        const element = document.getElementById(`worksheet-position-${issue.assetId}`);
        element?.scrollIntoView({ behavior: "smooth", block: "center" });
        const selector = issue.kind === "allocation" ? "[data-account-allocation] input" : "input";
        element?.querySelector<HTMLInputElement>(selector)?.focus({ preventScroll: true });
      });
      return;
    }
    const element = document.getElementById(
      issue.kind === "cash" ? "worksheet-cash" : "worksheet-positions",
    );
    element?.scrollIntoView({ behavior: "smooth", block: "center" });
    element?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
  }

  async function calculate() {
    // A worksheet with no adjustments is valid: it projects the allocation as
    // it stands today.
    if (prepared.issue || firstUseOpen) return;
    if (autoCalculateTimerRef.current) clearTimeout(autoCalculateTimerRef.current);
    setCalculationError(null);
    const calculationVersion = calculationVersionRef.current;
    try {
      const data = await worksheet.mutateAsync({
        targetId: profile!.id,
        filter: accountScope,
        cash: { trackedCashToUse, externalContribution },
        lines: prepared.lines,
        selectedAccountIds: changeAccountIds,
      });
      if (calculationVersion !== calculationVersionRef.current) return;
      setResult(data);
      setObservedCashByAccounts({ key: changeAccountKey, amount: data.observedTrackedCash });
      setIsResultStale(false);
      setCalculationError(null);
    } catch (error) {
      if (calculationVersion !== calculationVersionRef.current) return;
      const rawMessage = errorMessage(error);
      const affectedLine = prepared.lines.find((line) => rawMessage.includes(line.lineId));
      const affectedPosition = affectedLine ? positionByAsset.get(affectedLine.assetId) : undefined;
      let detail = rawMessage.replace(/^.*?Invalid input:\s*/i, "");
      if (affectedLine) {
        detail = detail.replace(
          `Worksheet line ${affectedLine.lineId}`,
          affectedPosition
            ? t("allocation:worksheet.positionErrorPrefix", { symbol: affectedPosition.symbol })
            : t("allocation:worksheet.positionErrorGeneric"),
        );
      }
      setCalculationError({
        title: t("allocation:worksheet.failed"),
        description: detail || undefined,
      });
    }
  }
  calculateRef.current = calculate;

  function acknowledgeFirstUse() {
    try {
      localStorage.setItem(
        DISCLOSURE_STORAGE_KEY,
        JSON.stringify({ version: DISCLOSURE_VERSION, acknowledgedAt: new Date().toISOString() }),
      );
    } catch {
      // The disclosure still gates the current session when storage is unavailable.
    }
    setFirstUseOpen(false);
  }

  return (
    <div className="space-y-4">
      <AlertDialog open={firstUseOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("allocation:worksheet.firstUseTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("allocation:worksheet.firstUseDisclosure")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={acknowledgeFirstUse}>
              {t("allocation:worksheet.continue")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Card className="overflow-hidden">
        <CardContent className="grid p-0 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.7fr)]">
          <AccountsControl
            accounts={scopedAccounts}
            selectedAccountIds={changeAccountIds}
            onToggle={(accountId) =>
              setSelectedAccountIds(
                changeAccountIds.includes(accountId)
                  ? changeAccountIds.filter((id) => id !== accountId)
                  : [...changeAccountIds, accountId],
              )
            }
            onSelectAll={() => setSelectedAccountIds(null)}
          />
          <CashControl
            availableCash={availableCash}
            trackedCash={trackedCash}
            onTrackedCashChange={setTrackedCash}
            accounts={changeAccounts}
            externalCash={externalCash}
            onExternalCashChange={(accountId, value) =>
              setExternalCash((current) => ({ ...current, [accountId]: value }))
            }
            currency={currency}
          />
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <CardContent className="grid p-0 lg:grid-cols-[minmax(0,1.4fr)_minmax(20rem,0.7fr)]">
          <CalculationControl
            mode={mode}
            allowSells={profile.allowSells}
            onModeChange={setMode}
            rule={rule}
            onRuleChange={setRule}
            holdings={scopedHoldings}
            excludedAssetIds={eligibility.excludedAssetIds}
            onToggleAsset={eligibility.toggle}
            onSelectAllAssets={eligibility.selectAll}
            onClearAssets={eligibility.clear}
            accountNames={accountNames}
            blockingIssue={generationIssue}
            isCalculating={calculator.isPending}
            hasGenerated={generated !== null}
            isOutOfDate={isOutOfDate}
            error={generateError}
            onRecalculate={() => void recalculateFromTarget()}
            onReset={resetToCalculated}
          />
          <FundingSummary
            result={isResultStale ? null : result}
            accountNames={accountNames}
            currency={currency}
          />
        </CardContent>
      </Card>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_23rem] xl:grid-cols-[minmax(0,1fr)_26rem]">
        <Card id="worksheet-positions" className="min-w-0 overflow-hidden">
          <CardContent className="p-0">
            <div className="space-y-3 border-b p-4 sm:p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="border-border bg-muted/20 flex rounded-full border p-1">
                    {(["position", "review"] as const).map((option) => (
                      <button
                        key={option}
                        type="button"
                        onClick={() => setView(option)}
                        className={cn(
                          "rounded-full px-4 py-1.5 font-mono text-xs transition-colors",
                          view === option
                            ? "bg-foreground text-background"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {option === "position"
                          ? t("allocation:worksheet.byPosition")
                          : t("allocation:worksheet.reviewChanges")}
                      </button>
                    ))}
                  </div>
                  {view === "position" && (
                    <div className="border-border bg-muted/20 flex rounded-full border p-1">
                      {(["amount", "after_percentage"] as const).map((option) => (
                        <button
                          key={option}
                          type="button"
                          onClick={() => switchEditMode(option)}
                          className={cn(
                            "rounded-full px-3.5 py-1.5 font-mono text-xs transition-colors",
                            editMode === option
                              ? "bg-foreground text-background"
                              : "text-muted-foreground hover:text-foreground",
                          )}
                        >
                          {option === "amount"
                            ? t("allocation:worksheet.changeAmount")
                            : t("allocation:worksheet.afterPercentage")}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <AddPositionButton
                  assets={eligibleAssets}
                  excludedAssetIds={new Set(positions.map((position) => position.assetId))}
                  onSelect={(assetId) => setAddedAssetIds((current) => [...current, assetId])}
                />
              </div>

              {view === "position" && categories.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-muted-foreground mr-1 font-mono text-[10px] uppercase tracking-[0.14em]">
                    {t("allocation:worksheet.allocationFocus")}
                  </span>
                  <button
                    type="button"
                    onClick={() => setCategoryFilter("all")}
                    className={cn(
                      "rounded-full border px-3 py-1 font-mono text-[11px]",
                      categoryFilter === "all"
                        ? "border-foreground bg-foreground text-background"
                        : "border-border text-muted-foreground",
                    )}
                  >
                    {t("allocation:worksheet.allCategories")}
                  </button>
                  {categories.map((category) => {
                    const unresolved = unresolvedByCategory.get(category.categoryId);
                    return (
                      <button
                        key={category.categoryId}
                        type="button"
                        onClick={() => setCategoryFilter(category.categoryId)}
                        className={cn(
                          "rounded-full border px-3 py-1 font-mono text-[11px]",
                          categoryFilter === category.categoryId
                            ? "border-foreground bg-foreground text-background"
                            : "border-border text-muted-foreground",
                        )}
                      >
                        {category.categoryName}
                        {unresolved !== undefined && (
                          <span
                            className="ml-1.5 text-amber-700 dark:text-amber-300"
                            title={t("allocation:worksheet.unresolvedTitle")}
                          >
                            {formatSignedAmount(unresolved, currency, formatAmount)}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Visible in both views: what the calculation could not place is
                exactly what the review is missing, and hiding it there leaves
                the leftover cash unexplained. */}
            {generated && (
              <CalculatedSummary
                calculated={generated.calculated}
                currency={currency}
                accountNames={accountNames}
              />
            )}

            {view === "position" ? (
              <div>
                <div className="text-muted-foreground bg-muted/15 hidden grid-cols-[minmax(12rem,1.6fr)_7rem_4rem_8.5rem_8.5rem_2rem] gap-3 border-b px-5 py-3 font-mono text-[10px] uppercase tracking-[0.14em] xl:grid">
                  <span>{t("allocation:worksheet.position")}</span>
                  <span className="text-right">{t("allocation:worksheet.currentValue")}</span>
                  <span className="text-right">{t("allocation:worksheet.now")}</span>
                  <span className="text-right">
                    {editMode === "amount"
                      ? t("allocation:worksheet.changeAmount")
                      : t("allocation:worksheet.projectedPercent")}
                  </span>
                  <span className="text-right">{t("allocation:worksheet.projectedChange")}</span>
                  <span />
                </div>

                {visiblePositions.length === 0 ? (
                  <div className="px-5 py-14 text-center">
                    <p className="text-sm font-medium">
                      {t("allocation:worksheet.noPositionsTitle")}
                    </p>
                    <p className="text-muted-foreground mx-auto mt-1 max-w-md text-xs leading-relaxed">
                      {t("allocation:worksheet.noPositionsDescription")}
                    </p>
                  </div>
                ) : (
                  <div className="divide-y">
                    {visiblePositions.map((position) => {
                      const adjustment = adjustments[position.assetId];
                      const resolvedChangeAmount = positionChangeAmount(
                        adjustment,
                        position,
                        basis,
                      );
                      const changeAmount = Number.isFinite(resolvedChangeAmount)
                        ? resolvedChangeAmount
                        : 0;
                      const resolved = resultByAsset.get(position.assetId);
                      // The core resolves an amount into whole units when the
                      // target asks for them, so the row projects what it
                      // resolved rather than what was typed.
                      const projectedValue = Math.max(
                        0,
                        position.value + (resolved ? resolved.amount : changeAmount),
                      );
                      const isExpanded = expandedAssetIds.has(position.assetId);
                      const quote = latestQuotes.data?.[position.assetId];
                      const asset = eligibleAssets.find((item) => item.id === position.assetId);
                      const displayInput = adjustment
                        ? adjustment.inputValue
                        : editMode === "amount"
                          ? ""
                          : formatDecimalInput(position.currentPct, 4);
                      return (
                        <div
                          id={`worksheet-position-${position.assetId}`}
                          key={position.assetId}
                          className="px-4 py-4 sm:px-5"
                        >
                          <div className="grid gap-3 xl:grid-cols-[minmax(12rem,1.6fr)_7rem_4rem_8.5rem_8.5rem_2rem] xl:items-center">
                            <div className="min-w-0">
                              <div className="flex min-w-0 items-baseline gap-2">
                                <span className="shrink-0 font-mono text-sm font-semibold">
                                  {position.symbol}
                                </span>
                                <span className="text-muted-foreground truncate text-xs">
                                  {position.name}
                                </span>
                              </div>
                              <p className="text-muted-foreground mt-1 truncate text-[11px]">
                                {position.categoryNames.length > 0
                                  ? position.categoryNames.join(" · ")
                                  : t("allocation:worksheet.unclassified")}
                                {position.accountHoldings.length > 0 &&
                                  ` · ${t("allocation:worksheet.accountCount", { count: position.accountHoldings.length })}`}
                              </p>
                              {resolved && (
                                <p className="text-muted-foreground mt-1 font-mono text-[10px]">
                                  {t("allocation:worksheet.resolvedPositionSummary", {
                                    value: formatAmount(projectedValue, currency),
                                    quantity: `${resolved.quantity > 0 ? "+" : "−"}${formatDecimalInput(Math.abs(resolved.quantity), 6)}`,
                                  })}
                                </p>
                              )}
                              {resolved &&
                                profile.wholeSharesOnly &&
                                Math.abs(resolved.amount - changeAmount) >= AMOUNT_EPSILON && (
                                  <p className="mt-1 text-[10px] text-amber-800 dark:text-amber-200">
                                    {t("allocation:worksheet.roundedToWholeShares", {
                                      amount: formatAmount(Math.abs(resolved.amount), currency),
                                      requested: formatAmount(Math.abs(changeAmount), currency),
                                    })}
                                  </p>
                                )}
                            </div>

                            <div className="flex items-center justify-between xl:block xl:text-right">
                              <span className="text-muted-foreground text-[10px] uppercase xl:hidden">
                                {t("allocation:worksheet.currentValue")}
                              </span>
                              <span className="font-mono text-xs tabular-nums">
                                {formatAmount(position.value, currency)}
                              </span>
                            </div>
                            <div className="flex items-center justify-between xl:block xl:text-right">
                              <span className="text-muted-foreground text-[10px] uppercase xl:hidden">
                                {t("allocation:worksheet.now")}
                              </span>
                              <span className="font-mono text-xs tabular-nums">
                                {position.currentPct.toFixed(1)}%
                              </span>
                            </div>
                            <div className="flex items-center justify-between gap-3 xl:justify-end">
                              <span className="text-muted-foreground text-[10px] uppercase xl:hidden">
                                {editMode === "amount"
                                  ? t("allocation:worksheet.changeAmount")
                                  : t("allocation:worksheet.projectedPercent")}
                              </span>
                              <div className="flex w-44 items-center gap-1 xl:w-full">
                                <div className="border-input bg-background flex h-9 min-w-0 flex-1 items-center rounded-md border px-2.5 focus-within:border-[#557866] focus-within:ring-1 focus-within:ring-[#557866]/30">
                                  <span className="text-muted-foreground mr-1.5 text-xs">
                                    {editMode === "amount" ? currency : ""}
                                  </span>
                                  <input
                                    aria-label={t("allocation:worksheet.positionInputLabel", {
                                      symbol: position.symbol,
                                    })}
                                    value={displayInput}
                                    onChange={(event) =>
                                      updatePositionInput(position, event.target.value)
                                    }
                                    onKeyDown={(event) => {
                                      if (
                                        editMode !== "after_percentage" ||
                                        (event.key !== "ArrowUp" && event.key !== "ArrowDown")
                                      ) {
                                        return;
                                      }
                                      event.preventDefault();
                                      const current = decimalInputOrZero(displayInput);
                                      const step = event.shiftKey ? 1 : 0.5;
                                      const next = Math.min(
                                        100,
                                        Math.max(
                                          0,
                                          current + (event.key === "ArrowUp" ? step : -step),
                                        ),
                                      );
                                      updatePositionInput(position, formatDecimalInput(next, 4));
                                    }}
                                    inputMode="decimal"
                                    placeholder={editMode === "amount" ? "±0" : undefined}
                                    className="min-w-0 flex-1 bg-transparent text-right font-mono text-xs outline-none"
                                  />
                                  {editMode === "after_percentage" && (
                                    <span className="text-muted-foreground ml-1 text-xs">%</span>
                                  )}
                                </div>
                                {position.value > AMOUNT_EPSILON && profile.allowSells && (
                                  <TooltipProvider delayDuration={150}>
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <Button
                                          type="button"
                                          variant="ghost"
                                          size="icon"
                                          className="h-8 w-8 shrink-0"
                                          disabled={projectedValue <= AMOUNT_EPSILON}
                                          aria-label={t(
                                            "allocation:worksheet.reducePositionToZero",
                                          )}
                                          onClick={() => reducePositionToZero(position)}
                                        >
                                          <Icons.MinusCircle className="h-4 w-4" />
                                        </Button>
                                      </TooltipTrigger>
                                      <TooltipContent>
                                        {t("allocation:worksheet.reducePositionToZero")}
                                      </TooltipContent>
                                    </Tooltip>
                                  </TooltipProvider>
                                )}
                              </div>
                            </div>
                            <div className="flex items-center justify-between xl:block xl:text-right">
                              <span className="text-muted-foreground text-[10px] uppercase xl:hidden">
                                {t("allocation:worksheet.projectedChange")}
                              </span>
                              <span className="font-mono text-xs font-medium tabular-nums">
                                {formatSignedAmount(changeAmount, currency, formatAmount)}
                              </span>
                            </div>
                            <div className="flex items-center justify-end gap-1">
                              {Math.abs(changeAmount) >= AMOUNT_EPSILON && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8"
                                  aria-label={t("allocation:worksheet.toggleAccountAllocation")}
                                  onClick={() =>
                                    setExpandedAssetIds((current) => {
                                      const next = new Set(current);
                                      if (next.has(position.assetId)) next.delete(position.assetId);
                                      else next.add(position.assetId);
                                      return next;
                                    })
                                  }
                                >
                                  <Icons.ChevronDown
                                    className={cn(
                                      "h-4 w-4 transition-transform",
                                      isExpanded && "rotate-180",
                                    )}
                                  />
                                </Button>
                              )}
                              {position.isAdded && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8"
                                  aria-label={t("allocation:worksheet.removePosition")}
                                  onClick={() => removeAddedPosition(position.assetId)}
                                >
                                  <Icons.X className="h-4 w-4" />
                                </Button>
                              )}
                            </div>
                          </div>

                          {quote?.quote ? (
                            <p className="text-muted-foreground mt-2 text-[10px]">
                              {t("allocation:worksheet.priceSourceInline", {
                                price: formatAmount(quote.quote.close, quote.quote.currency),
                                date: quote.quoteDate ?? quote.quote.timestamp,
                              })}
                              {quote.isStale ? ` · ${t("allocation:worksheet.dated")}` : ""}
                            </p>
                          ) : position.isAdded && latestQuotes.isFetched ? (
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                              <span className="text-destructive text-xs">
                                {t("allocation:worksheet.noQuoteShort")}
                              </span>
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 px-2 text-xs"
                                disabled={syncPrice.isPending}
                                onClick={() => {
                                  if (asset?.quoteMode === "MARKET") syncPrice.mutate([asset.id]);
                                  else navigate(`/holdings/${position.assetId}`);
                                }}
                              >
                                {asset?.quoteMode === "MARKET"
                                  ? t("allocation:worksheet.refreshPrice")
                                  : t("allocation:worksheet.addManualPrice")}
                              </Button>
                            </div>
                          ) : null}

                          {adjustment && isExpanded && Math.abs(changeAmount) >= AMOUNT_EPSILON && (
                            <AccountAllocation
                              position={position}
                              changeAmount={changeAmount}
                              accounts={accountsForChange(position, changeAmount)}
                              adjustment={adjustment}
                              currency={currency}
                              fundingByAccount={fundingByAccount}
                              unitPrice={unitPriceFor(position)}
                              wholeSharesOnly={profile.wholeSharesOnly}
                              impliedAccountId={impliedAccountIdFor(position, changeAmount)}
                              onAmountChange={(accountId, value) =>
                                updateAccountAmount(position.assetId, accountId, value)
                              }
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : (
              <ReviewChanges
                result={result}
                isStale={isResultStale}
                isCalculating={isPreviewUpdating}
                issue={prepared.issue}
                calculationError={calculationError}
                accountNames={accountNames}
                currency={currency}
                onReviewIssue={reviewPreparedIssue}
              />
            )}

            <div className="border-t px-4 py-3 sm:px-5">
              <details>
                <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-xs font-medium">
                  {t("allocation:worksheet.limitationsTitle")}
                </summary>
                <p className="text-muted-foreground mt-2 text-xs leading-relaxed">
                  {t("allocation:worksheet.fullDisclosure")}
                </p>
              </details>
            </div>
          </CardContent>
        </Card>

        <ImpactRail
          report={driftReport}
          result={result}
          isStale={isResultStale}
          prepared={prepared}
          profile={profile}
          calculationError={calculationError}
          isCalculating={isPreviewUpdating}
          firstUseOpen={firstUseOpen}
          onCalculate={() => void calculate()}
          onReviewIssue={reviewPreparedIssue}
          onClassifySecurity={(lineId) => {
            const assetId = result?.lines.find((line) => line.lineId === lineId)?.assetId;
            if (assetId) navigate(`/holdings/${assetId}`);
          }}
        />
      </div>
    </div>
  );
}
