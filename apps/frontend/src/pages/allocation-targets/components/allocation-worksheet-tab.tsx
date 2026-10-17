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
  useNumberFormatting,
} from "@wealthfolio/ui";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { getAssetTaxonomyAssignments, getHoldingsList, openFileSaveDialog } from "@/adapters";
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
  WorksheetMode,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { useAssets } from "@/pages/asset/hooks/use-assets";
import { useLatestQuotes } from "@/pages/asset/hooks/use-latest-quotes";
import { useExchangeRates } from "@/pages/settings/general/exchange-rates/use-exchange-rate";

import { useAllocationWorksheet } from "../hooks/use-allocation-worksheet";
import { useCalculatedAdjustments } from "../hooks/use-calculated-adjustments";
import { useEligibleHoldingsSelection } from "../hooks/use-eligible-holdings";
import { AmountsList, type AmountsRowModel } from "./allocation-worksheet-amounts-list";
import { createHighlightStore, HighlightStoreContext } from "./allocation-worksheet-highlight";
import { rowStatus } from "./allocation-worksheet-amounts";
import { ImpactRail } from "./allocation-worksheet-impact-rail";
import { csvFile, toCsv, toTsv, worksheetExportRows } from "./allocation-worksheet-export";
import { ReviewPanel } from "./allocation-worksheet-review";
import {
  adjustmentsFromCalculated,
  AMOUNT_EPSILON,
  decimalInputOrZero,
  eligibleAccountIdsForChange,
  externalContributionFor,
  formatDecimalInput,
  formatSignedAmount,
  generationInputsKey,
  impactClasses,
  parseDecimalInput,
  planningTotal,
  PRICE_MOVE_THRESHOLD,
  soleHoldingAccountId,
  UNCLASSIFIED_CATEGORY_ID,
  UNRESOLVED_REASON_KEYS,
  unitPriceMoved,
  type PositionAdjustment,
  type PositionAdjustments,
  type PositionCategoryExposure,
  type WorksheetEditMode,
  type WorksheetGenerationInputs,
  type WorksheetPosition,
} from "./allocation-worksheet-utils";
import { EligibleHoldingsSelector } from "./eligible-holdings-selector";
import { accountScopeKey } from "./target-scope";

const DISCLOSURE_STORAGE_KEY = "wealthfolio:rebalancing-worksheet-disclosure:v2";
const DRAFT_STORAGE_PREFIX = "wealthfolio:rebalancing-worksheet-draft:v3";
const DISCLOSURE_VERSION = 2;
const DRAFT_VERSION = 4;
const CASH_PRESETS = [0.25, 0.5, 0.75, 1] as const;
const AUTO_CALCULATE_DEBOUNCE_MS = 500;

type WorksheetPanel = "setup" | "amounts" | "review";

interface AllocationWorksheetTabProps {
  profile: AllocationTarget | null;
  driftReport: DriftReport | null;
  accountScope: AccountScope;
  sourceVersion: string;
  isSourceLoading: boolean;
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
  /** Every row's own issue, keyed by asset. */
  rowIssues: Map<string, PreparedWorksheetIssue>;
  /** Where each change with a choice of accounts sits, keyed by asset. */
  placedAccountIds: Map<string, string[]>;
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
        categoryId: UNCLASSIFIED_CATEGORY_ID,
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
                  categoryId: UNCLASSIFIED_CATEGORY_ID,
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
  const ruleSelected = rule === "current_holding_proportions";

  // One column of labels to read down, each control beside its label and its
  // description beside the control, to keep Setup short.
  return (
    <div id="worksheet-calculation" className="min-w-0 divide-y px-5 py-1 sm:px-6">
      <SetupRow label={t("allocation:worksheet.modeLabel")}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="border-border bg-muted/20 inline-flex shrink-0 rounded-full border p-1">
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
            <p className="text-muted-foreground min-w-0 flex-1 basis-56 text-xs leading-relaxed">
              {activeMode.hint}
            </p>
          )}
        </div>
      </SetupRow>

      {/* One rule ships, but it is still chosen explicitly (§4.2), like an account. */}
      <SetupRow label={t("allocation:worksheet.ruleLabel")}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <button
            type="button"
            aria-pressed={ruleSelected}
            onClick={() => onRuleChange("current_holding_proportions")}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-full border px-3.5 py-1.5 font-mono text-xs transition-colors",
              ruleSelected
                ? "border-foreground bg-foreground text-background"
                : "border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground",
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "flex h-3.5 w-3.5 items-center justify-center rounded-full border",
                ruleSelected ? "border-background" : "border-current/40",
              )}
            >
              {ruleSelected && <Icons.Check className="h-2.5 w-2.5" />}
            </span>
            {t("allocation:worksheet.ruleCurrentHoldingProportions")}
          </button>
          <p className="text-muted-foreground min-w-0 flex-1 basis-56 text-xs leading-relaxed">
            {t("allocation:worksheet.ruleCurrentHoldingProportionsHint")}
          </p>
        </div>
      </SetupRow>

      <SetupRow label={t("allocation:eligibleHoldings.label")}>
        <EligibleHoldingsSelector
          holdings={holdings}
          excludedAssetIds={excludedAssetIds}
          onToggle={onToggleAsset}
          onSelectAll={onSelectAllAssets}
          onClear={onClearAssets}
          accountNames={accountNames}
        />
      </SetupRow>
    </div>
  );
}

/** A Setup input: its label in a column of its own, one column on narrow screens. */
function SetupRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-x-6 gap-y-2 py-3.5 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)] sm:items-center">
      <Eyebrow>{label}</Eyebrow>
      <div className="min-w-0">{children}</div>
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
/**
 * What the calculation scaled or could not place (§4.6). Stated on screen and
 * in the export, so a scaled figure is never mistaken for the full amount.
 */
function calculationNotes(calculated: CalculatedAdjustments, t: TFunction): string[] {
  const percent = (factor: number) => formatDecimalInput(factor * 100, 1);
  const notes: string[] = [];
  if (calculated.scaling.cashFactor != null) {
    notes.push(
      t("allocation:worksheet.cashCoverage", { percent: percent(calculated.scaling.cashFactor) }),
    );
  }
  if (calculated.scaling.reductionFactor != null) {
    notes.push(
      t("allocation:worksheet.reductionsScaled", {
        percent: percent(calculated.scaling.reductionFactor),
      }),
    );
  }
  if (calculated.scaling.increaseFactor != null) {
    notes.push(
      t("allocation:worksheet.increasesScaled", {
        percent: percent(calculated.scaling.increaseFactor),
      }),
    );
  }
  const belowOneUnit = calculated.belowOneUnit ?? [];
  if (belowOneUnit.length > 0) {
    notes.push(
      t("allocation:worksheet.belowOneUnit", {
        symbols: belowOneUnit.map((security) => security.symbol).join(", "),
      }),
    );
  }
  return notes;
}

function CalculatedSummary({ calculated, currency, accountNames }: CalculatedSummaryProps) {
  const { t } = useTranslation();
  const { formatAmount } = useAmountFormatting();
  const notes = calculationNotes(calculated, t);
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
      {/* One paragraph rather than a line per note, to give the list below the room. */}
      {notes.length > 0 && (
        <p className="text-muted-foreground mt-2 text-[13px] leading-relaxed">{notes.join(" ")}</p>
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
        <Button size="sm" variant="ghost">
          <Icons.Plus className="mr-1.5 h-4 w-4" />
          {t("allocation:worksheet.addPosition")}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[340px] max-w-[calc(100vw-2rem)] p-0" align="start">
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

export function AllocationWorksheetTab({
  profile,
  driftReport,
  accountScope,
  sourceVersion,
  isSourceLoading,
}: AllocationWorksheetTabProps) {
  const { t } = useTranslation();
  const { formatAmount } = useAmountFormatting();
  // The export writes numbers the way the user reads them (see toCsv).
  const { decimalSeparator } = useNumberFormatting();
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

  const [panel, setPanel] = useState<WorksheetPanel>("setup");
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
  const [result, setResult] = useState<AllocationWorksheetResult | null>(null);
  const [isResultStale, setIsResultStale] = useState(false);
  const [calculationError, setCalculationError] = useState<WorksheetCalculationError | null>(null);
  // Read by the list and the rail only: pointing never renders the worksheet.
  const [highlightStore] = useState(createHighlightStore);
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
    setExpandedAssetIds(new Set());
    setResult(null);
    setCalculationError(null);
    // Every visit starts on Setup, where the worksheet's inputs are read first.
    setPanel("setup");
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
  // The cash the accounts record comes back with the first preview, after the
  // worksheet opens. Until then a default that follows it is unknown rather
  // than zero, and an unknown input has not changed.
  const cashKnown = trackedCash !== null || availableCash !== undefined;
  const inputsChanged = Boolean(
    generated &&
    generationInputs &&
    cashKnown &&
    generated.inputsKey !== generationInputsKey(generationInputs),
  );
  // A calculated line whose price moved by more than PRICE_MOVE_THRESHOLD no
  // longer matches what was calculated. An addition to §5's list of inputs;
  // only the user's action recalculates.
  const pricesChanged = Boolean(
    generated &&
    result &&
    generated.calculated.adjustments.some((adjustment) => {
      const line = result.lines.find((item) => item.assetId === adjustment.assetId);
      return line !== undefined && unitPriceMoved(line.unitPrice, adjustment.unitPrice);
    }),
  );
  const isOutOfDate = inputsChanged || pricesChanged;
  const outOfDateMessage = inputsChanged
    ? t("allocation:worksheet.inputsChanged")
    : t("allocation:worksheet.pricesChanged", { percent: PRICE_MOVE_THRESHOLD * 100 });
  const generationIssue = !rule
    ? t("allocation:worksheet.chooseRuleIssue")
    : changeAccountIds.length === 0
      ? t("allocation:worksheet.selectAccountIssue")
      : cashIssue?.message;

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
    const rowIssues = new Map<string, PreparedWorksheetIssue>();
    const placedAccountIds = new Map<string, string[]>();
    // The first issue blocks the preview; every row keeps its own for its status.
    const flag = (rowIssue: PreparedWorksheetIssue) => {
      issue ??= rowIssue;
      if (rowIssue.assetId) rowIssues.set(rowIssue.assetId, rowIssue);
    };

    for (const position of positions) {
      const adjustment = adjustments[position.assetId];
      if (adjustment && !Number.isFinite(parseDecimalInput(adjustment.inputValue))) {
        flag({
          message: t("allocation:worksheet.invalidPositionInput", { symbol: position.symbol }),
          kind: "position",
          assetId: position.assetId,
        });
        continue;
      }
      const changeAmount = positionChangeAmount(adjustment, position, basis);
      if (!adjustment || Math.abs(changeAmount) < AMOUNT_EPSILON) continue;

      if (changeAmount < 0 && !profile.allowSells) {
        flag({
          message: t("allocation:worksheet.reductionsDisabledIssue", { symbol: position.symbol }),
          kind: "position",
          assetId: position.assetId,
        });
        continue;
      }
      if (changeAmount < 0 && Math.abs(changeAmount) > position.value + AMOUNT_EPSILON) {
        flag({
          message: t("allocation:worksheet.reductionExceedsPositionIssue", {
            symbol: position.symbol,
            amount: formatAmount(position.value, currency),
          }),
          kind: "position",
          assetId: position.assetId,
        });
        continue;
      }

      const requestedAmount = Math.abs(changeAmount);
      if (changeAmount > 0) increaseTotal += requestedAmount;
      else reductionTotal += requestedAmount;

      const eligibleAccounts = accountsForChange(position, changeAmount);
      if (eligibleAccounts.length === 0) {
        flag({
          message: t("allocation:worksheet.noEligibleAccountIssue", { symbol: position.symbol }),
          kind: "allocation",
          assetId: position.assetId,
        });
        continue;
      }

      const hasInvalidAccountAmount =
        eligibleAccounts.length > 1 &&
        eligibleAccounts.some((account) => {
          const value = adjustment.accountAmounts[account.id] ?? "";
          return value.trim() !== "" && !Number.isFinite(parseDecimalInput(value));
        });
      if (hasInvalidAccountAmount) {
        flag({
          message: t("allocation:worksheet.invalidAccountAmount", { symbol: position.symbol }),
          kind: "allocation",
          assetId: position.assetId,
        });
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
        flag({
          message: t("allocation:worksheet.allocateAccountsIssue", {
            symbol: position.symbol,
            amount: formatAmount(requestedAmount, currency),
          }),
          kind: "allocation",
          assetId: position.assetId,
        });
        continue;
      }
      if (eligibleAccounts.length > 1) {
        placedAccountIds.set(
          position.assetId,
          allocations.map((allocation) => allocation.accountId),
        );
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

    return { lines, issue, rowIssues, placedAccountIds, increaseTotal, reductionTotal };
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

  const lineAssetIds = new Map((result?.lines ?? []).map((line) => [line.lineId, line.assetId]));
  const warningsByAsset = new Map<string, string[]>();
  for (const warning of result && !isResultStale ? result.warnings : []) {
    const assetId = warning.lineId ? lineAssetIds.get(warning.lineId) : undefined;
    if (assetId)
      warningsByAsset.set(assetId, [...(warningsByAsset.get(assetId) ?? []), warning.message]);
  }
  // The price the core resolved a line at, when the preview has one: the unit
  // a step adds is then the unit the core places.
  const resolvedPriceByAsset = new Map(
    (result?.lines ?? []).map((line) => [line.assetId, line.unitPrice]),
  );
  const amountsRows: AmountsRowModel[] = positions.map((position) => {
    const unitPrice = resolvedPriceByAsset.get(position.assetId) ?? unitPriceFor(position);
    const adjustment = adjustments[position.assetId];
    const rawChangeAmount = positionChangeAmount(adjustment, position, basis);
    const changeAmount = Number.isFinite(rawChangeAmount) ? rawChangeAmount : 0;
    const resolved = resultByAsset.get(position.assetId);
    const quote = latestQuotes.data?.[position.assetId];
    // The core resolves an amount into whole units when the target asks for them,
    // so the row projects what it resolved rather than what was typed.
    const projectedValue = Math.max(
      0,
      position.value + (resolved ? resolved.amount : changeAmount),
    );
    return {
      position,
      adjustment,
      displayInput: adjustment
        ? adjustment.inputValue
        : editMode === "amount"
          ? ""
          : formatDecimalInput(position.currentPct, 4),
      changeAmount,
      isChanged:
        adjustment !== undefined &&
        (!Number.isFinite(rawChangeAmount) || Math.abs(rawChangeAmount) >= AMOUNT_EPSILON),
      projectedValue,
      projectedPct: basis > 0 ? (projectedValue / basis) * 100 : 0,
      unitPrice,
      status: rowStatus({
        issue: prepared.rowIssues.get(position.assetId),
        needsPrice: position.isAdded && latestQuotes.isFetched && !quote?.quote,
        warnings: warningsByAsset.get(position.assetId) ?? [],
        roundedAmount:
          resolved &&
          profile.wholeSharesOnly &&
          Math.abs(resolved.amount - changeAmount) >= AMOUNT_EPSILON
            ? resolved.amount
            : undefined,
        stalePriceDate:
          quote?.quote && quote.isStale ? (quote.quoteDate ?? quote.quote.timestamp) : undefined,
        isExcluded: eligibility.excludedAssetIds.has(position.assetId),
        placedAccountIds: prepared.placedAccountIds.get(position.assetId) ?? [],
      }),
      asset: eligibleAssets.find((item) => item.id === position.assetId),
      isExpanded: expandedAssetIds.has(position.assetId),
      placement:
        Math.abs(changeAmount) >= AMOUNT_EPSILON
          ? {
              accounts: accountsForChange(position, changeAmount),
              impliedAccountId: impliedAccountIdFor(position, changeAmount),
              unitPrice,
            }
          : undefined,
    };
  });
  const flaggedAssetIds = new Set([...warningsByAsset.keys(), ...prepared.rowIssues.keys()]);
  const unresolvedAmounts = generated?.calculated.unresolved ?? [];
  // Across the whole scope, like the class totals it is compared with, rather
  // than only the accounts the worksheet may change.
  const valueInClassByAsset = new Map<string, Record<string, number>>();
  for (const row of driftReport.holdings?.rows ?? []) {
    if (row.isCash || !row.assetId) continue;
    const values = valueInClassByAsset.get(row.assetId) ?? {};
    values[row.categoryId] = (values[row.categoryId] ?? 0) + row.value;
    valueInClassByAsset.set(row.assetId, values);
  }
  const classes = impactClasses(driftReport, result, profile.driftBandBps);

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
    highlightStore.getState().forgetRow(assetId);
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
    setExpandedAssetIds(new Set());
    setResult(null);
    setCalculationError(null);
    setPanel("amounts");
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
    if (prepared.issue) openIssue(prepared.issue);
  }

  /** Opens the panel that owns an issue and puts the cursor where it is fixed. */
  function openIssue(issue: PreparedWorksheetIssue) {
    // The issue sits on the panel that owns it; the element exists once it renders.
    setPanel(issue.kind === "cash" ? "setup" : "amounts");
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
    requestAnimationFrame(() => {
      const element = document.getElementById(
        issue.kind === "cash" ? "worksheet-cash" : "worksheet-positions",
      );
      element?.scrollIntoView({ behavior: "smooth", block: "center" });
      element?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
    });
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

  const changedCount = amountsRows.filter((row) => row.isChanged).length;
  // Warnings and an out-of-date worksheet travel with the file; only a change
  // the review cannot include, or a result being recomputed, holds it back.
  const canExport = Boolean(result && !isResultStale && !prepared.issue && !calculationError);
  const exportMessage = prepared.issue
    ? t("allocation:worksheet.exportHeld")
    : !result
      ? t("allocation:worksheet.exportNothing")
      : isResultStale
        ? t("allocation:worksheet.reviewUpdating")
        : calculationError
          ? calculationError.title
          : [
              t("allocation:worksheet.exportIncludes"),
              isOutOfDate
                ? inputsChanged
                  ? t("allocation:worksheet.exportOutOfDateNote")
                  : t("allocation:worksheet.exportPricesChangedNote", {
                      percent: PRICE_MOVE_THRESHOLD * 100,
                    })
                : "",
            ]
              .filter(Boolean)
              .join(" ");

  async function exportWorksheet(format: "copy" | "csv") {
    if (!result || !canExport) return;
    const calculated = generated?.calculated ?? null;
    const scaling = calculated ? calculationNotes(calculated, t) : [];
    const table = worksheetExportRows(
      {
        result,
        calculated,
        accountNames,
        accountIds: changeAccountIds,
        trackedCashToUse,
        externalCash: externalTotal,
      },
      {
        title: t("allocation:worksheet.title"),
        target: t("allocation:worksheet.exportTarget"),
        calculatedAt: t("allocation:worksheet.exportCalculatedAt"),
        accounts: t("allocation:worksheet.accountsLabel"),
        mode: t("allocation:worksheet.modeLabel"),
        // What the worksheet was calculated from, or that it was entered by hand.
        modeValue: !calculated
          ? t("allocation:worksheet.exportNotCalculated")
          : calculated.mode === "rebalance"
            ? t("allocation:worksheet.modeRebalance")
            : t("allocation:worksheet.modeInvestCash"),
        rule: t("allocation:worksheet.ruleLabel"),
        ruleValue: calculated
          ? t("allocation:worksheet.ruleCurrentHoldingProportions")
          : t("allocation:worksheet.exportNotCalculated"),
        trackedCash: t("allocation:worksheet.exportTrackedCash"),
        externalCash: t("allocation:worksheet.externalCash"),
        eligible: t("allocation:worksheet.exportEligible"),
        eligibleValue:
          eligibility.eligibleAssetIds === undefined
            ? t("allocation:worksheet.exportAllRecorded")
            : String(eligibility.eligibleAssetIds.length),
        scaling,
        outOfDate: !isOutOfDate
          ? undefined
          : inputsChanged
            ? t("allocation:worksheet.exportOutOfDate")
            : t("allocation:worksheet.exportPricesChanged", {
                percent: PRICE_MOVE_THRESHOLD * 100,
              }),
        note: t("allocation:worksheet.exportNote"),
        category: t("allocation:worksheet.exportCategory"),
        symbol: t("activity:table_symbol"),
        security: t("allocation:worksheet.security"),
        account: t("allocation:worksheet.account"),
        amount: t("allocation:worksheet.exportAmount"),
        quantity: t("allocation:worksheet.exportQuantity"),
        price: t("allocation:worksheet.unitPrice"),
        priceDate: t("allocation:worksheet.exportPriceDate"),
        warnings: t("allocation:worksheet.exportWarnings"),
        statusUnresolved: t("allocation:worksheet.exportStatusUnresolved"),
        unknownAccount: t("allocation:worksheet.unknownAccount"),
        total: t("allocation:worksheet.accountTotal"),
        cashLeft: t("allocation:result.cashRemaining"),
        limitationsTitle: t("allocation:worksheet.limitationsTitle"),
        limitations: t("allocation:worksheet.fullDisclosure"),
      },
    );
    if (format === "csv") {
      // The runtime's own save: a native dialog in the app, a download on the web.
      try {
        await openFileSaveDialog(
          csvFile(toCsv(table, decimalSeparator)),
          `rebalancing-worksheet-${result.calculatedAt.slice(0, 10)}.csv`,
        );
      } catch {
        toast.error(t("allocation:worksheet.exportFailed"));
      }
      return;
    }
    try {
      await navigator.clipboard.writeText(toTsv(table, decimalSeparator));
      toast.success(t("allocation:worksheet.tableCopied"));
    } catch {
      toast.error(t("allocation:worksheet.copyFailed"));
    }
  }
  // Amber like the out-of-date notice it answers.
  const recalculateButton = (
    <Button
      size="sm"
      variant="outline"
      disabled={!!generationIssue || calculator.isPending}
      onClick={() => void recalculateFromTarget()}
      className="border-amber-500/70 bg-amber-50 font-semibold text-amber-900 hover:bg-amber-100 hover:text-amber-950 dark:border-amber-500/50 dark:bg-amber-950/40 dark:text-amber-200 dark:hover:bg-amber-950/60 dark:hover:text-amber-100"
    >
      {calculator.isPending ? (
        <Icons.Spinner className="mr-1.5 h-4 w-4 animate-spin" />
      ) : (
        <Icons.RefreshCw className="mr-1.5 h-4 w-4" />
      )}
      {t("allocation:worksheet.recalculateFromTarget")}
    </Button>
  );
  const disclosure = (
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
  );

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

      <WorksheetStepper
        panel={panel}
        onSelect={setPanel}
        changedCount={changedCount}
        isOutOfDate={isOutOfDate}
      />

      {/* Where amounts are read, a stale worksheet says so first. Setup offers the
          same action at the bottom, after the inputs that changed. */}
      {isOutOfDate && panel !== "setup" && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-400/50 bg-amber-50/60 px-4 py-2.5 dark:bg-amber-950/15"
        >
          <p className="min-w-0 flex-1 text-xs leading-relaxed text-amber-950/80 dark:text-amber-100/80">
            {outOfDateMessage}
          </p>
          {recalculateButton}
        </div>
      )}

      {panel === "setup" ? (
        <>
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
            <CardContent className="p-0">
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
              />
              <div className="bg-muted/30 flex flex-wrap items-center justify-between gap-3 border-t px-5 py-4 sm:px-6">
                <div className="min-w-0 flex-1 basis-80 space-y-2">
                  {generateError && (
                    <div role="alert">
                      <p className="text-destructive text-xs font-semibold">
                        {t("allocation:worksheet.generateFailed")}
                      </p>
                      <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
                        {generateError}
                      </p>
                    </div>
                  )}
                  {!generated ? (
                    <p className="text-muted-foreground text-xs leading-relaxed">
                      {generationIssue ?? t("allocation:worksheet.notCalculatedDescription")}
                    </p>
                  ) : (
                    // Beside the button that answers it, so both read at a glance.
                    isOutOfDate && (
                      <p
                        role="status"
                        className="rounded-lg border border-amber-400/60 bg-amber-50/80 px-3.5 py-2.5 text-xs leading-relaxed text-amber-950/80 dark:bg-amber-950/15 dark:text-amber-100/80"
                      >
                        {generationIssue ?? outOfDateMessage}
                      </p>
                    )
                  )}
                </div>
                {/* Top to bottom: the inputs, then recalculating when they changed,
                    then moving on. Calculating never happens on the way. */}
                {generated ? (
                  <div className="flex flex-wrap items-center gap-2">
                    {isOutOfDate && recalculateButton}
                    <Button onClick={() => setPanel("amounts")}>
                      {t("allocation:worksheet.nextPanel", {
                        panel: t("allocation:worksheet.stepAmounts"),
                      })}
                      <Icons.ArrowRight className="ml-1.5 h-4 w-4" />
                    </Button>
                  </div>
                ) : (
                  <Button
                    disabled={!!generationIssue || calculator.isPending}
                    onClick={() => void recalculateFromTarget()}
                  >
                    {calculator.isPending && (
                      <Icons.Spinner className="mr-1.5 h-4 w-4 animate-spin" />
                    )}
                    {t("allocation:worksheet.calculateFromTarget")}
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        </>
      ) : (
        <HighlightStoreContext.Provider value={highlightStore}>
          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_23rem] xl:grid-cols-[minmax(0,1fr)_26rem]">
            <Card id="worksheet-positions" className="min-w-0 overflow-hidden">
              <CardContent className="p-0">
                {panel === "amounts" && (
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4 sm:p-5">
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
                    {generated && (
                      <Button size="sm" variant="ghost" onClick={resetToCalculated}>
                        <Icons.Undo className="mr-1.5 h-4 w-4" />
                        {t("allocation:worksheet.resetToCalculated")}
                      </Button>
                    )}
                  </div>
                )}

                {/* On both panels: what the calculation could not place is
                    exactly what the review is missing, and hiding it there leaves
                    the leftover cash unexplained. */}
                {generated && (
                  <CalculatedSummary
                    calculated={generated.calculated}
                    currency={currency}
                    accountNames={accountNames}
                  />
                )}

                {panel === "amounts" ? (
                  <div>
                    {positions.length === 0 ? (
                      <div className="px-5 py-14 text-center">
                        <p className="text-sm font-medium">
                          {t("allocation:worksheet.noPositionsTitle")}
                        </p>
                        <p className="text-muted-foreground mx-auto mt-1 max-w-md text-xs leading-relaxed">
                          {t("allocation:worksheet.noPositionsDescription")}
                        </p>
                      </div>
                    ) : (
                      <AmountsList
                        rows={amountsRows}
                        flaggedAssetIds={flaggedAssetIds}
                        classColors={new Map(classes.map((item) => [item.categoryId, item.color]))}
                        accountNames={accountNames}
                        unresolvedCategoryIds={
                          new Set(unresolvedAmounts.map((item) => item.categoryId))
                        }
                        editMode={editMode}
                        currency={currency}
                        allowSells={profile.allowSells}
                        wholeSharesOnly={profile.wholeSharesOnly}
                        fundingByAccount={fundingByAccount}
                        isPriceSyncing={syncPrice.isPending}
                        actions={{
                          onInputChange: updatePositionInput,
                          onReduceToZero: reducePositionToZero,
                          onRemove: removeAddedPosition,
                          onToggleExpanded: (assetId) =>
                            setExpandedAssetIds((current) => {
                              const next = new Set(current);
                              if (next.has(assetId)) next.delete(assetId);
                              else next.add(assetId);
                              return next;
                            }),
                          onAccountAmountChange: updateAccountAmount,
                          onPriceAction: (assetId, asset) => {
                            if (asset?.quoteMode === "MARKET") syncPrice.mutate([asset.id]);
                            else navigate(`/holdings/${assetId}`);
                          },
                        }}
                      />
                    )}
                    <div className="border-t px-2 py-1.5 sm:px-3">
                      <AddPositionButton
                        assets={eligibleAssets}
                        excludedAssetIds={new Set(positions.map((position) => position.assetId))}
                        onSelect={(assetId) => setAddedAssetIds((current) => [...current, assetId])}
                      />
                    </div>
                  </div>
                ) : (
                  <ReviewPanel
                    result={result}
                    isStale={isResultStale}
                    isCalculating={isPreviewUpdating}
                    worksheetIssue={
                      prepared.issue && !prepared.issue.assetId ? prepared.issue.message : undefined
                    }
                    heldLines={amountsRows.flatMap((row) => {
                      const issue = prepared.rowIssues.get(row.position.assetId);
                      return issue
                        ? [
                            {
                              assetId: row.position.assetId,
                              symbol: row.position.symbol,
                              change: row.changeAmount,
                              cause: issue.message,
                            },
                          ]
                        : [];
                    })}
                    calculationError={calculationError}
                    accountNames={accountNames}
                    currency={currency}
                    onOpenRow={(assetId) => {
                      const issue = prepared.rowIssues.get(assetId);
                      if (issue) openIssue(issue);
                    }}
                    exportActions={
                      <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 sm:px-5">
                        <p
                          className={cn(
                            "min-w-0 flex-1 text-xs leading-relaxed",
                            prepared.issue
                              ? "text-amber-800 dark:text-amber-200"
                              : "text-muted-foreground",
                          )}
                        >
                          {exportMessage}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!canExport}
                            onClick={() => void exportWorksheet("copy")}
                          >
                            <Icons.Copy className="mr-1.5 h-4 w-4" />
                            {t("allocation:worksheet.copyTable")}
                          </Button>
                          <Button
                            size="sm"
                            disabled={!canExport}
                            onClick={() => void exportWorksheet("csv")}
                          >
                            <Icons.Download className="mr-1.5 h-4 w-4" />
                            {t("allocation:worksheet.exportCsv")}
                          </Button>
                        </div>
                      </div>
                    }
                  />
                )}

                {disclosure}

                <div className="flex items-center justify-between gap-3 border-t px-4 py-3 sm:px-5">
                  <Button
                    variant="ghost"
                    onClick={() => setPanel(panel === "review" ? "amounts" : "setup")}
                  >
                    <Icons.ArrowLeft className="mr-1.5 h-4 w-4" />
                    {t("allocation:worksheet.previousPanel", {
                      panel:
                        panel === "review"
                          ? t("allocation:worksheet.stepAmounts")
                          : t("allocation:worksheet.stepSetup"),
                    })}
                  </Button>
                  {panel === "amounts" && (
                    <Button onClick={() => setPanel("review")}>
                      {t("allocation:worksheet.nextPanel", {
                        panel: t("allocation:worksheet.stepReview"),
                      })}
                      <Icons.ArrowRight className="ml-1.5 h-4 w-4" />
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>

            <div className="space-y-4 lg:sticky lg:top-4">
              <ImpactRail
                report={driftReport}
                result={result}
                isStale={isResultStale}
                classes={classes}
                rows={amountsRows.map((row) => ({
                  assetId: row.position.assetId,
                  symbol: row.position.symbol,
                  shares: row.position.categoryExposures,
                  change: row.changeAmount,
                  valueIn: valueInClassByAsset.get(row.position.assetId) ?? {},
                }))}
                unresolved={unresolvedAmounts}
                issueMessage={prepared.issue?.message}
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
              {/* Review states each account's cash in its own group. */}
              {panel === "amounts" && (
                <Card className="overflow-hidden">
                  <CardContent className="p-0">
                    <FundingSummary
                      result={isResultStale ? null : result}
                      accountNames={accountNames}
                      currency={currency}
                    />
                  </CardContent>
                </Card>
              )}
            </div>
          </div>
        </HighlightStoreContext.Provider>
      )}
    </div>
  );
}

interface WorksheetStepperProps {
  panel: WorksheetPanel;
  onSelect: (panel: WorksheetPanel) => void;
  changedCount: number;
  isOutOfDate: boolean;
}

/**
 * Every step is a button: any panel, ahead or behind, opens on the current
 * worksheet, and nothing is calculated on the way.
 */
function WorksheetStepper({ panel, onSelect, changedCount, isOutOfDate }: WorksheetStepperProps) {
  const { t } = useTranslation();
  const steps: { id: WorksheetPanel; label: string; note?: ReactNode }[] = [
    {
      id: "setup",
      label: t("allocation:worksheet.stepSetup"),
      note: isOutOfDate ? (
        <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true" />
      ) : undefined,
    },
    {
      id: "amounts",
      label: t("allocation:worksheet.stepAmounts"),
      note:
        changedCount > 0 ? (
          <span className="font-mono text-[11px] opacity-70">
            {t("allocation:worksheet.lineCount", { count: changedCount })}
          </span>
        ) : undefined,
    },
    { id: "review", label: t("allocation:worksheet.stepReview") },
  ];

  return (
    <nav
      aria-label={t("allocation:worksheet.title")}
      className="border-border bg-muted/20 inline-flex flex-wrap rounded-full border p-1"
    >
      {steps.map((step, index) => (
        <button
          key={step.id}
          type="button"
          aria-current={panel === step.id ? "step" : undefined}
          onClick={() => onSelect(step.id)}
          className={cn(
            "flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs transition-colors",
            panel === step.id
              ? "bg-foreground text-background"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <span className="font-mono text-[10px] opacity-60">{index + 1}</span>
          {step.label}
          {step.note}
        </button>
      ))}
    </nav>
  );
}
