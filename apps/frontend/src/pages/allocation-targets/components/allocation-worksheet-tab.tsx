import { useQueries } from "@tanstack/react-query";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Icons,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Skeleton,
  useAmountFormatting,
  useDateFormatting,
  useNumberFormatting,
} from "@wealthfolio/ui";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { getAssetTaxonomyAssignments, getHoldingsList, openFileSaveDialog } from "@/adapters";
import { useAccounts } from "@/hooks/use-accounts";
import { profilePreferenceKey } from "@/hooks/use-persistent-state";
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
  WorksheetWarning,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { useAssets } from "@/pages/asset/hooks/use-assets";
import { useLatestQuotes } from "@/pages/asset/hooks/use-latest-quotes";
import { useExchangeRates } from "@/pages/settings/general/exchange-rates/use-exchange-rate";

import { useAllocationWorksheet } from "../hooks/use-allocation-worksheet";
import { useCalculatedAdjustments } from "../hooks/use-calculated-adjustments";
import { useEligibleHoldingsSelection } from "../hooks/use-eligible-holdings";
import { useTargetConstraints } from "../hooks/use-target-constraints";
import { AddDepositButton } from "./allocation-worksheet-account-allocation";
import { AmountsList, type AmountsRowModel } from "./allocation-worksheet-amounts-list";
import { cashToUse, editableAmounts } from "./allocation-worksheet-cash";
import { createHighlightStore, HighlightStoreContext } from "./allocation-worksheet-highlight";
import { rowStatus, unitsFor, type PlacementProblem } from "./allocation-worksheet-amounts";
import { ImpactRail } from "./allocation-worksheet-impact-rail";
import { csvFile, toCsv, toTsv, worksheetExportRows } from "./allocation-worksheet-export";
import { ReviewPanel } from "./allocation-worksheet-review";
import {
  allocationTargetColorForRow,
  buildAllocationTargetColorMap,
} from "./allocation-target-colors";
import { SecuritiesCard } from "./allocation-worksheet-securities";
import { categoriesByAsset, type TargetCategories } from "./eligible-holdings";
import { WorksheetSetup, type CategoryReach } from "./allocation-worksheet-setup";
import { describeWarning, type WarningFormatting } from "./allocation-worksheet-warnings";
import {
  accountLabels,
  adjustmentsFromCalculated,
  AMOUNT_EPSILON,
  decimalInputOrZero,
  editedAssetIds,
  eligibleAccountIdsForChange,
  estimatedFunding,
  externalContributionFor,
  formatDecimalInput,
  formatSignedAmount,
  generationInputsKey,
  impactClasses,
  isAsCalculated,
  isShortOfFunding,
  parseDecimalInput,
  planningTotal,
  PRICE_MOVE_THRESHOLD,
  placementSlack,
  soleHoldingAccountId,
  standingRules,
  UNCLASSIFIED_CATEGORY_ID,
  UNRESOLVED_REASON_KEYS,
  unitPriceMoved,
  type PositionAdjustment,
  type PositionAdjustments,
  type RowPlacementLedger,
  type PositionCategoryExposure,
  type WorksheetEditMode,
  type WorksheetGenerationInputs,
  type WorksheetPosition,
} from "./allocation-worksheet-utils";
import { accountScopeKey } from "./target-scope";
import { copyText } from "@wealthfolio/ui/lib/clipboard";

const DISCLOSURE_STORAGE_KEY = "wealthfolio:rebalancing-worksheet-disclosure:v2";
const DRAFT_STORAGE_PREFIX = "wealthfolio:rebalancing-worksheet-draft:v3";
const DISCLOSURE_VERSION = 2;
const DRAFT_VERSION = 4;
/** No account's cash has been read yet. */
const NO_RECORDED_CASH: Readonly<Record<string, number>> = {};
const AUTO_CALCULATE_DEBOUNCE_MS = 500;

type WorksheetPanel = "setup" | "amounts" | "review";

interface AllocationWorksheetTabProps {
  backAction?: ReactNode;
  heading?: ReactNode;
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
  /** Cash to deploy set account by account; absent or `null` while one share applies. */
  cashByAccount?: Record<string, string> | null;
  externalCash: Record<string, string>;
  selectedAccountIds: string[];
  addedAssetIds: string[];
  adjustments: PositionAdjustments;
  generated: GeneratedAdjustments | null;
}

interface PreparedWorksheet {
  lines: AllocationWorksheetLineInput[];
  /** Position totals, independent of incomplete account placements. */
  positionLines: AllocationWorksheetLineInput[];
  issue?: PreparedWorksheetIssue;
  /** Every row's own issue, keyed by asset. */
  rowIssues: Map<string, PreparedWorksheetIssue>;
  /** Where each change with a choice of accounts sits, keyed by asset. */
  placedAccountIds: Map<string, string[]>;
  /** What each change places in each account, as entered or implied, keyed by asset. */
  placements: Map<string, RowPlacementLedger>;
  increaseTotal: number;
  reductionTotal: number;
}

interface PreparedWorksheetIssue {
  message: string;
  kind: "cash" | "position" | "allocation";
  assetId?: string;
  /** For an allocation issue, what exactly keeps the change out. */
  placement?: PlacementProblem;
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
  return profilePreferenceKey(`${DRAFT_STORAGE_PREFIX}:${targetId}:${accountScopeKey(scope)}`);
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
      (draft.cashByAccount != null && typeof draft.cashByAccount !== "object") ||
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
    <p className="text-muted-foreground text-2xs font-mono tracking-[0.16em] uppercase">
      {children}
    </p>
  );
}

interface FundingSummaryProps {
  result: AllocationWorksheetResult | null;
  /**
   * What each selected account has left by the page's own figures, until a
   * preview reports it: placing a change needs it most before every change is
   * placed, which is when the preview cannot run.
   */
  estimate: readonly { accountId: string; remaining: number }[] | undefined;
  accountNames: Map<string, string>;
  /** Covers an account's shortfall with a deposit, when the user asks. */
  onAddDeposit: (accountId: string, amount: number) => void;
  currency: string;
}

/**
 * What each account can fund and what the worksheet asks of it (§6). A shortage
 * is reported, never corrected: after prefill the worksheet is the source of
 * truth (§5).
 */
function FundingSummary({
  result,
  estimate,
  accountNames,
  onAddDeposit,
  currency,
}: FundingSummaryProps) {
  const { t } = useTranslation();
  const { formatAmount } = useAmountFormatting();
  const rows = result ? result.accountFunding : estimate;
  const isEstimate = !result && estimate !== undefined;
  // What the accounts have left between them. A shortfall is stated on its own
  // account and never offset by another's surplus (§6).
  const left = (rows ?? []).reduce((sum, funding) => sum + Math.max(0, funding.remaining), 0);
  const amountOf = (amount: number) =>
    isEstimate ? `≈ ${formatAmount(amount, currency)}` : formatAmount(amount, currency);

  return (
    <div className="min-w-0 p-5 sm:p-6">
      <Eyebrow>{t("allocation:worksheet.fundingLabel")}</Eyebrow>
      {!rows ? (
        <p className="text-muted-foreground mt-2 text-xs leading-relaxed">
          {t("allocation:worksheet.fundingPending")}
        </p>
      ) : (
        <>
          <p className="mt-2 font-mono text-xl leading-tight font-semibold">{amountOf(left)}</p>
          <p className="text-muted-foreground mt-1 text-xs">
            {t(
              isEstimate
                ? "allocation:worksheet.fundingLeftEstimate"
                : "allocation:worksheet.fundingLeft",
            )}
          </p>
          <ul className="mt-4 divide-y">
            {rows.map((funding) => (
              <li key={funding.accountId} className="py-2 text-xs">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate font-medium">
                    {accountNames.get(funding.accountId) ??
                      t("allocation:worksheet.unknownAccount")}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 font-mono tabular-nums",
                      isShortOfFunding(funding.remaining) && "text-warning-subtle-foreground",
                    )}
                  >
                    {amountOf(funding.remaining)}
                  </span>
                </div>
                {isShortOfFunding(funding.remaining) && (
                  <p className="text-2xs text-warning-subtle-foreground mt-0.5 flex flex-wrap items-baseline justify-between gap-x-2">
                    <span>
                      {t("allocation:worksheet.fundingNeeded", {
                        amount: formatAmount(-funding.remaining, currency),
                      })}
                    </span>
                    <AddDepositButton
                      amount={-funding.remaining}
                      account={accountNames.get(funding.accountId) ?? ""}
                      currency={currency}
                      onAdd={(amount) => onAddDeposit(funding.accountId, amount)}
                    />
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
  presentation?: "review" | "notice" | "details";
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

function CalculatedSummary({
  calculated,
  currency,
  accountNames,
  presentation = "review",
}: CalculatedSummaryProps) {
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

  const unresolved = calculated.unresolved.length > 0 && (
    <ul className="divide-y">
      {calculated.unresolved.map((item) => (
        <li
          key={item.categoryId}
          className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-1.5 text-xs"
        >
          <span className="min-w-0">
            <span className="font-medium">{item.categoryName}</span>
            <span className="text-muted-foreground">
              {" · "}
              {t(UNRESOLVED_REASON_KEYS[item.reason])}
            </span>
          </span>
          <span className="shrink-0 tabular-nums">
            {formatSignedAmount(item.amount, currency, formatAmount)}
          </span>
        </li>
      ))}
    </ul>
  );

  if (presentation === "details") {
    if (notes.length === 0) return null;
    return (
      <details className="group border-t px-4 py-3 sm:px-5" data-calculation-details>
        <summary className="text-muted-foreground hover:text-foreground flex cursor-pointer list-none items-center gap-2 text-xs [&::-webkit-details-marker]:hidden">
          <Icons.ChevronDown className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-180" />
          {t("allocation:worksheet.calculationDetails")}
        </summary>
        <ul className="text-muted-foreground mt-3 space-y-1 text-xs leading-relaxed">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </details>
    );
  }

  if (presentation === "notice") {
    if (!unresolved) return null;
    return (
      <div
        className="flex items-start gap-2.5 border-b px-4 py-3 sm:px-5"
        id="worksheet-unresolved"
        role="note"
        aria-label={t("allocation:worksheet.unresolvedTitle")}
      >
        <Icons.AlertCircle className="text-warning-subtle-foreground mt-1.5 h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          {unresolved}
          <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
            {t("allocation:worksheet.unresolvedHint")}
          </p>
        </div>
      </div>
    );
  }

  if (notes.length === 0 && !unresolved) return null;
  return (
    <div className="bg-muted/10 border-b px-4 py-4 sm:px-5">
      <Eyebrow>{t("allocation:worksheet.calculatedSummary")}</Eyebrow>
      {notes.length > 0 && (
        <p className="text-muted-foreground mt-2 text-sm leading-relaxed">{notes.join(" ")}</p>
      )}
      {unresolved && (
        <div className="mt-3">
          <p className="text-xs font-medium">{t("allocation:worksheet.unresolvedTitle")}</p>
          <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
            {t("allocation:worksheet.unresolvedHint")}
          </p>
          <div className="mt-2">{unresolved}</div>
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
      <PopoverTrigger render={<Button size="sm" variant="ghost" />}>
        <Icons.Plus className="me-1.5 h-4 w-4" />
        {t("allocation:worksheet.addPosition")}
      </PopoverTrigger>
      <PopoverContent className="w-85 max-w-[calc(100vw-2rem)] p-0" align="start">
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

/**
 * The one way a category's amount is split across its securities (§4.2). It
 * is stated with the eligible securities, never applied out of sight; a second
 * rule would make it a choice again.
 */
const SPLIT_RULE: AllocationRule = "current_holding_proportions";

export function AllocationWorksheetTab({
  backAction,
  heading,
  profile,
  driftReport,
  accountScope,
  sourceVersion,
  isSourceLoading,
}: AllocationWorksheetTabProps) {
  const { t } = useTranslation();
  const { formatAmount, formatPrice, currencyFractionDigits } = useAmountFormatting();
  // The export writes numbers the way the user reads them (see toCsv).
  const { decimalSeparator, formatPercent } = useNumberFormatting();
  const { formatCalendarDate } = useDateFormatting();
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
  const worksheetRef = useRef<HTMLDivElement>(null);
  const shownPanelRef = useRef(panel);
  // A step opens at its top, wherever the last one was left: at once, since
  // the content was replaced rather than moved. Before paint, and before an
  // issue's own scroll to its row, which waits for the next frame.
  useLayoutEffect(() => {
    if (shownPanelRef.current === panel) return;
    shownPanelRef.current = panel;
    const worksheet = worksheetRef.current;
    if (worksheet && worksheet.getBoundingClientRect().top < 0) {
      worksheet.scrollIntoView({ behavior: "instant", block: "start" });
    }
  }, [panel]);
  const [editMode, setEditMode] = useState<WorksheetEditMode>("amount");
  const [mode, setMode] = useState<WorksheetMode>("invest_cash");
  // `null` follows the cash the chosen accounts record; a string is the
  // user's own figure.
  const [trackedCash, setTrackedCash] = useState<string | null>(null);
  // Cash to deploy set account by account; `null` while one share of every
  // account's cash applies (§6).
  const [cashByAccount, setCashByAccount] = useState<Record<string, string> | null>(null);
  // The amounts a total last replaced, so the user can take the total back.
  const [replacedCash, setReplacedCash] = useState<Record<string, string> | null>(null);
  // What each account records, as the core counted it from the current sources.
  const [recordedCash, setRecordedCash] = useState<{
    sourceKey: string;
    byAccount: Record<string, number>;
  } | null>(null);
  const [externalCash, setExternalCash] = useState<Record<string, string>>({});
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[] | null>(null);
  const [addedAssetIds, setAddedAssetIds] = useState<string[]>([]);
  const [adjustments, setAdjustments] = useState<PositionAdjustments>({});
  const [generated, setGenerated] = useState<GeneratedAdjustments | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [replaceEditsOpen, setReplaceEditsOpen] = useState(false);
  const [expandedAssetIds, setExpandedAssetIds] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<AllocationWorksheetResult | null>(null);
  const [isResultStale, setIsResultStale] = useState(false);
  const [calculationError, setCalculationError] = useState<WorksheetCalculationError | null>(null);
  // Read by the list and the rail only: pointing never renders the worksheet.
  const [highlightStore] = useState(createHighlightStore);
  const calculationVersionRef = useRef(0);
  const generationInputsKeyRef = useRef("");
  const needsPlacedPreviewRef = useRef(false);
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
  // What the chosen accounts can deploy, as the core counts it: one rule per
  // account and in total. The drift report's figure spans the whole scope and
  // counts cash accounts the worksheet cannot use, so it never stands in: an
  // account's cash stays unknown until the core has read it from these sources.
  const cashSourceKey = `${sourceVersion}:${holdingsVersion}:${exchangeRates.dataUpdatedAt}:${taxonomy.dataUpdatedAt}:${profile?.updatedAt ?? ""}`;
  const recordedByAccount =
    recordedCash?.sourceKey === cashSourceKey ? recordedCash.byAccount : NO_RECORDED_CASH;
  const availableCash =
    changeAccountIds.length > 0 &&
    changeAccountIds.every((accountId) => recordedByAccount[accountId] !== undefined)
      ? changeAccountIds.reduce(
          (sum, accountId) => sum + Math.max(0, recordedByAccount[accountId] ?? 0),
          0,
        )
      : undefined;
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
  const holdingsKey = `${draftStorageKey ?? ""}:${[...changeAccountIds].sort().join(",")}`;
  // What the calculation may increase, and apart from it what it may reduce:
  // the user knows which positions they would rather not sell this time.
  const eligibility = useEligibleHoldingsSelection(changeHoldings, holdingsKey);
  const sellability = useEligibleHoldingsSelection(changeHoldings, holdingsKey);
  // The target's never-reduced rules, which the calculation applies whatever
  // Setup says; Setup shows them rather than offering a choice it ignores.
  const { constraints } = useTargetConstraints(profile?.id);
  const rules = useMemo(() => standingRules(constraints), [constraints]);

  const cryptoAssetIds = useMemo(
    () =>
      new Set(assets.filter((asset) => asset.instrumentType === "CRYPTO").map((asset) => asset.id)),
    [assets],
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
  const accountNames = useMemo(() => accountLabels(scopedAccounts), [scopedAccounts]);
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
    setTrackedCash(draft?.trackedCash ?? null);
    setCashByAccount(
      draft?.cashByAccount
        ? Object.fromEntries(
            Object.entries(draft.cashByAccount).filter(
              ([accountId, amount]) => validAccountIds.has(accountId) && typeof amount === "string",
            ),
          )
        : null,
    );
    setReplacedCash(null);
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
        rule: SPLIT_RULE,
        trackedCash,
        cashByAccount,
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
    trackedCash,
    cashByAccount,
    changeAccountIds,
  ]);

  // The page's own sources, still arriving: a preview sent now would be
  // replaced as soon as they settle.
  const sourcesSettling =
    isSourceLoading ||
    assetsLoading ||
    accountsLoading ||
    holdingsLoading ||
    latestQuotes.isFetching;

  // Validates and projects the worksheet as it stands. Mode, rule and eligible
  // securities are deliberately absent: they only matter when adjustments are
  // calculated, and that happens on an explicit action alone (§5).
  useEffect(() => {
    if (autoCalculateTimerRef.current) clearTimeout(autoCalculateTimerRef.current);
    calculationVersionRef.current += 1;
    setIsResultStale(true);
    setCalculationError(null);
    worksheet.reset();
    if (sourcesSettling) return;
    // While the accounts' cash is unknown, the preview is what reads it, so it
    // goes out as soon as the sources settle; once known, edits wait for a pause.
    autoCalculateTimerRef.current = setTimeout(
      () => {
        void calculateRef.current?.();
      },
      availableCash === undefined ? 0 : AUTO_CALCULATE_DEBOUNCE_MS,
    );
    return () => {
      if (autoCalculateTimerRef.current) clearTimeout(autoCalculateTimerRef.current);
    };
    // The dependencies represent user input or source-data changes.
    // oxlint-disable-next-line react/exhaustive-deps
  }, [
    adjustments,
    trackedCash,
    cashByAccount,
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
    sourcesSettling,
  ]);

  // An estimated result can reveal a price that makes the account split valid.
  // Validate those account lines before Review/export, without another user edit.
  useEffect(() => {
    if (sourcesSettling || !needsPlacedPreviewRef.current) return;
    calculationVersionRef.current += 1;
    setIsResultStale(true);
    void calculateRef.current?.();
  }, [result, sourcesSettling]);

  const loadingHeading = (backAction || heading) && (
    <div className="flex flex-wrap items-center gap-3">
      {backAction}
      {heading}
    </div>
  );
  if (isSourceLoading || assetsLoading || accountsLoading || holdingsLoading) {
    return (
      <div className="space-y-5">
        {loadingHeading}
        <Skeleton className="h-[38rem] w-full rounded-xl" />
      </div>
    );
  }
  if (!profile || !driftReport)
    return loadingHeading ? <div className="mb-5">{loadingHeading}</div> : null;

  const currency = driftReport.baseCurrency;
  const fundingByAccount = new Map(
    (result && !isResultStale ? result.accountFunding : []).map((funding) => [
      funding.accountId,
      funding,
    ]),
  );
  const fractionDigits = currencyFractionDigits(currency);
  // Each account spends its own cash (§6): a total is spent as one share of
  // every account, or the user sets each account's amount.
  const cash = cashToUse({
    accountIds: changeAccountIds,
    recordedByAccount,
    trackedCash,
    cashByAccount,
    fractionDigits,
  });
  const rawTrackedCash = trackedCash === null ? null : parseDecimalInput(trackedCash);
  // Until the core has read what the accounts record, a total stands alone and
  // each account is checked against everything it records.
  const trackedCashToUse = cash.isKnown
    ? cash.total
    : rawTrackedCash !== null && Number.isFinite(rawTrackedCash)
      ? Math.max(0, rawTrackedCash)
      : 0;
  const trackedCashByAccount = cash.isKnown ? cash.byAccount : undefined;
  const externalContribution = externalContributionFor(changeAccountIds, externalCash);
  const cashInput = {
    trackedCashToUse,
    externalContribution,
    ...(trackedCashByAccount ? { trackedCashByAccount } : {}),
  };
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
    cashByAccount === null && rawTrackedCash !== null && rawTrackedCash < 0
      ? { message: t("allocation:worksheet.cashMustBePositive"), kind: "cash" }
      : cash.isTotalInvalid || cash.invalidAccountIds.length > 0
        ? { message: t("allocation:worksheet.invalidCashInput"), kind: "cash" }
        : changeAccountIds.some((accountId) => {
              const amount = parseDecimalInput(externalCash[accountId] ?? "");
              return !Number.isFinite(amount) || amount < 0;
            })
          ? { message: t("allocation:worksheet.invalidExternalCash"), kind: "cash" }
          : undefined;

  const generationInputs: WorksheetGenerationInputs = {
    targetId: profile.id,
    targetVersion: profile.updatedAt,
    accountIds: changeAccountIds,
    mode,
    rule: SPLIT_RULE,
    trackedCashToUse,
    trackedCashByAccount,
    externalContribution,
    eligibleAssetIds: eligibility.eligibleAssetIds,
    // Invest cash never reduces, so what it may reduce is no input there.
    sellableAssetIds: mode === "rebalance" ? sellability.eligibleAssetIds : undefined,
  };
  const currentGenerationInputsKey = generationInputsKey(generationInputs);
  generationInputsKeyRef.current = currentGenerationInputsKey;
  // The cash the accounts record comes back with the first preview, after the
  // worksheet opens. Until then what each account spends is unknown rather
  // than zero, and an unknown input has not changed.
  const cashKnown = cash.isKnown;
  const inputsChanged = Boolean(
    generated && cashKnown && generated.inputsKey !== currentGenerationInputsKey,
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
  const generationIssue =
    changeAccountIds.length === 0
      ? t("allocation:worksheet.selectAccountIssue")
      : // Calculating before the accounts' cash is read would deploy none of it.
        !cash.isKnown
        ? t("allocation:worksheet.cashReading")
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
    // A crypto account takes only crypto; it can still take more of what it
    // already holds. Technical eligibility, not a preference between accounts.
    const isCrypto = cryptoAssetIds.has(position.assetId);
    return eligibleAccountIdsForChange(
      changeAmount,
      position.accountHoldings.map((holding) => holding.accountId),
      changeAccountIds,
      (accountId) =>
        isCrypto || accountById.get(accountId)?.accountType !== AccountType.CRYPTOCURRENCY,
    ).flatMap((accountId) => {
      const account = accountById.get(accountId);
      const protectedReduction =
        changeAmount < 0 &&
        rules.blocksReduce(
          position.assetId,
          accountId,
          position.categoryExposures.map((exposure) => exposure.categoryId),
        );
      return account && !protectedReduction ? [account] : [];
    });
  }

  // Reuse core's resolved price for both placement validation and its controls.
  const resolvedPriceByAsset = new Map(
    (result?.lines ?? []).map((line) => [line.assetId, line.unitPrice]),
  );

  // Reductions follow Rebalance, which the target's own setting may withhold:
  // Invest cash only adds, in the calculation and by hand alike.
  const allowsReductions = profile.allowSells && mode === "rebalance";
  const minLineSize = decimalInputOrZero(profile.minTradeAmount ?? "");
  const prepared: PreparedWorksheet = (() => {
    const lines: AllocationWorksheetLineInput[] = [];
    const positionLines: AllocationWorksheetLineInput[] = [];
    let increaseTotal = 0;
    let reductionTotal = 0;
    let issue: PreparedWorksheetIssue | undefined = cashIssue;
    const rowIssues = new Map<string, PreparedWorksheetIssue>();
    const placedAccountIds = new Map<string, string[]>();
    const placements = new Map<string, RowPlacementLedger>();
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

      if (changeAmount < 0 && !allowsReductions) {
        flag({
          message: t(
            profile.allowSells
              ? "allocation:worksheet.reductionsNeedRebalanceIssue"
              : "allocation:worksheet.reductionsDisabledIssue",
            { symbol: position.symbol },
          ),
          kind: "position",
          assetId: position.assetId,
        });
        continue;
      }
      const reducibleValue = position.accountHoldings
        .filter(
          (holding) =>
            !rules.blocksReduce(
              position.assetId,
              holding.accountId,
              position.categoryExposures.map((exposure) => exposure.categoryId),
            ),
        )
        .reduce((total, holding) => total + holding.value, 0);
      if (changeAmount < 0 && Math.abs(changeAmount) > reducibleValue + AMOUNT_EPSILON) {
        flag({
          message: t("allocation:worksheet.reductionExceedsPositionIssue", {
            symbol: position.symbol,
            amount: formatAmount(reducibleValue, currency),
          }),
          kind: "position",
          assetId: position.assetId,
        });
        continue;
      }

      const requestedAmount = Math.abs(changeAmount);
      // Keep a full sale in units, just like its account-assigned lines below.
      // Converting its recorded value at a newer quote can exceed what is held.
      const reducesEntirePosition =
        changeAmount < 0 && Math.abs(requestedAmount - position.value) <= 0.02;
      positionLines.push({
        lineId: `position:${position.assetId}:preview`,
        direction: changeAmount > 0 ? "increase" : "reduce",
        assetId: position.assetId,
        inputMode: reducesEntirePosition ? "quantity" : "amount",
        value: reducesEntirePosition ? position.quantity : Number(requestedAmount.toFixed(6)),
      });
      if (changeAmount > 0) increaseTotal += requestedAmount;
      else reductionTotal += requestedAmount;

      const eligibleAccounts = accountsForChange(position, changeAmount);
      if (eligibleAccounts.length === 0) {
        flag({
          message: t("allocation:worksheet.noEligibleAccountIssue", { symbol: position.symbol }),
          kind: "allocation",
          assetId: position.assetId,
          placement: { reason: "no_account" },
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
      // What this change places, even before it is complete: other changes'
      // funding estimates count it.
      const sign = changeAmount > 0 ? 1 : -1;
      const ledger = {
        byAccount: new Map(
          allocations.map((allocation) => [allocation.accountId, sign * allocation.amount]),
        ),
        isValid: false,
      };
      placements.set(position.assetId, ledger);

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
          placement: { reason: "invalid" },
        });
        continue;
      }

      const allocatedAmount = allocations.reduce((sum, allocation) => sum + allocation.amount, 0);
      // A split a little off the change, either way, is accepted and stated
      // rather than demanded (placementSlack): the calculation sizes changes to
      // fractions of a cent while each account takes whole cents, and a few
      // dollars on a large change move nothing that matters. More than that
      // still blocks, so a change left half placed is not missed.
      const positionUnitPrice =
        resolvedPriceByAsset.get(position.assetId) ?? unitPriceFor(position);
      const slack = placementSlack(
        requestedAmount,
        allocatedAmount,
        profile.wholeSharesOnly ? positionUnitPrice : undefined,
      );
      const shortfall = requestedAmount - allocatedAmount;
      const excess = allocatedAmount - requestedAmount;
      // Each account rounds separately in core. A split must cover the whole
      // units requested, even when its dollar amounts add up or fit within 1%.
      const wholeUnits =
        profile.wholeSharesOnly && positionUnitPrice
          ? {
              requested: unitsFor(requestedAmount, positionUnitPrice, true),
              placed: allocations.reduce(
                (sum, allocation) => sum + unitsFor(allocation.amount, positionUnitPrice, true),
                0,
              ),
            }
          : null;
      const nothingPlaced = wholeUnits ? wholeUnits.placed === 0 : allocatedAmount < AMOUNT_EPSILON;
      const missingUnits = wholeUnits ? Math.max(0, wholeUnits.requested - wholeUnits.placed) : 0;
      if (
        eligibleAccounts.length > 1 &&
        (nothingPlaced || missingUnits > 0 || shortfall > slack.short || excess > slack.over)
      ) {
        flag({
          message: t("allocation:worksheet.allocateAccountsIssue", {
            symbol: position.symbol,
            amount: formatAmount(requestedAmount, currency),
          }),
          kind: "allocation",
          assetId: position.assetId,
          placement:
            excess > slack.over
              ? { reason: "over", amount: excess }
              : nothingPlaced
                ? { reason: "not_placed" }
                : {
                    reason: "left",
                    amount: Math.max(shortfall, missingUnits * (positionUnitPrice ?? 0)),
                  },
        });
        continue;
      }
      ledger.isValid = true;
      placedAccountIds.set(
        position.assetId,
        allocations.map((allocation) => allocation.accountId),
      );

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

    return {
      lines,
      positionLines,
      issue,
      rowIssues,
      placedAccountIds,
      placements,
      increaseTotal,
      reductionTotal,
    };
  })();
  const isIndicative =
    prepared.issue?.kind === "allocation" &&
    [...prepared.rowIssues.values()].every(
      (issue) => issue.kind === "allocation" && issue.placement?.reason !== "no_account",
    );
  const isPlacedResult = Boolean(result && result.lines.every((line) => line.accountId));
  needsPlacedPreviewRef.current = Boolean(result && !isPlacedResult && !prepared.issue);
  const isPreviewUpdating =
    worksheet.isPending ||
    (isResultStale && (!prepared.issue || isIndicative) && calculationError === null);
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
  // The core sends each warning's figures; they are worded here, in the
  // user's language and number format.
  const warningFormat: WarningFormatting = {
    amount: (value) => formatAmount(value, currency),
    price: (value) => formatPrice(value, currency),
    percent: (fraction, digits) => formatPercent(fraction, { digits }),
    date: (isoDate) => formatCalendarDate(isoDate),
    accountName: (accountId) => accountNames.get(accountId) ?? accountId,
  };
  const wordWarning = (warning: WorksheetWarning) =>
    describeWarning(warning, { lines: result?.lines ?? [] }, warningFormat, t);
  const warningsByAsset = new Map<string, string[]>();
  for (const warning of result && !isResultStale ? result.warnings : []) {
    const assetId = warning.lineId ? lineAssetIds.get(warning.lineId) : undefined;
    if (assetId)
      warningsByAsset.set(assetId, [...(warningsByAsset.get(assetId) ?? []), wordWarning(warning)]);
  }
  // What each chosen account brings to its own changes (§6), once its cash is
  // read: the cash it deploys and its contribution.
  const fundingBase: Record<string, number> | undefined = cash.isKnown
    ? Object.fromEntries(
        changeAccountIds.map((accountId) => [
          accountId,
          (cash.byAccount[accountId] ?? 0) + (externalContribution[accountId] ?? 0),
        ]),
      )
    : undefined;
  // Each selected account's funding after everything placed so far, the
  // page's own estimate for Funding left until a preview reports it.
  const fundingEstimate = fundingBase
    ? [...estimatedFunding(fundingBase, prepared.placements, "", changeAccountIds)]
        .map(([accountId, estimate]) => ({
          accountId,
          remaining: estimate.capacity - estimate.deficit,
        }))
        .sort((left, right) =>
          (accountNames.get(left.accountId) ?? "").localeCompare(
            accountNames.get(right.accountId) ?? "",
          ),
        )
    : undefined;
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
      canReduceToZero: position.accountHoldings.every(
        (holding) =>
          !rules.blocksReduce(
            position.assetId,
            holding.accountId,
            position.categoryExposures.map((exposure) => exposure.categoryId),
          ),
      ),
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
        isExcluded: (changeAmount < 0 ? sellability : eligibility).excludedAssetIds.has(
          position.assetId,
        ),
        placedAccountIds: prepared.placedAccountIds.get(position.assetId) ?? [],
      }),
      asset: eligibleAssets.find((item) => item.id === position.assetId),
      isExpanded: expandedAssetIds.has(position.assetId),
      placement: (() => {
        if (Math.abs(changeAmount) < AMOUNT_EPSILON) return undefined;
        const accounts = accountsForChange(position, changeAmount);
        return {
          accounts,
          impliedAccountId: impliedAccountIdFor(position, changeAmount),
          unitPrice,
          // Only an open allocation reads them.
          fundingEstimates:
            fundingBase && expandedAssetIds.has(position.assetId)
              ? estimatedFunding(
                  fundingBase,
                  prepared.placements,
                  position.assetId,
                  accounts.map((account) => account.id),
                )
              : undefined,
          deployedByAccount: fundingBase,
          problem: prepared.rowIssues.get(position.assetId)?.placement,
        };
      })(),
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
    const current = adjustments[position.assetId];
    const directionOf = (adjustment: PositionAdjustment | undefined) => {
      const amount = positionChangeAmount(adjustment, position, basis);
      if (!Number.isFinite(amount) || Math.abs(amount) < AMOUNT_EPSILON) return undefined;
      return amount > 0 ? 1 : -1;
    };
    // The amounts already placed stay while the total is edited; the status
    // says how far apart they are.
    const next: PositionAdjustment = {
      ...current,
      inputMode: editMode,
      inputValue: value,
      accountAmounts: current?.accountAmounts ?? {},
    };
    const placedFor = current?.placedDirection ?? directionOf(current);
    const direction = directionOf(next) ?? placedFor;
    // A change that turns around draws on other accounts' holdings, so its
    // split is set aside rather than carried over, and comes back if it turns
    // back again.
    if (placedFor && direction && direction !== placedFor) {
      next.accountAmounts = current?.setAsideAccountAmounts ?? {};
      next.setAsideAccountAmounts = current?.accountAmounts;
      next.placedWhole = undefined;
    } else {
      // A change placed whole in one account, as the calculation places a
      // security in the only account that holds it, follows its total there:
      // otherwise the preview would keep the old amount, or stop at "left to
      // allocate". A split across accounts, or a partial placement, stays as
      // entered. A cleared or unreadable total has nothing to compare the
      // placement with, so whether it was whole carries over from the last
      // total that could be read.
      const placed = Object.entries(current?.accountAmounts ?? {}).filter(
        ([, amount]) => amount.trim() !== "",
      );
      const before = Math.abs(positionChangeAmount(current, position, basis));
      const placedWhole =
        placed.length === 1 &&
        (before >= AMOUNT_EPSILON
          ? Math.abs(decimalInputOrZero(placed[0][1]) - before) < AMOUNT_EPSILON
          : current?.placedWhole === true);
      const after = positionChangeAmount(next, position, basis);
      if (placedWhole && Number.isFinite(after) && Math.abs(after) >= AMOUNT_EPSILON) {
        next.accountAmounts = { [placed[0][0]]: formatDecimalInput(Math.abs(after), 6) };
      }
      next.placedWhole = placedWhole;
    }
    next.placedDirection = direction;
    updateAdjustment(position.assetId, next);
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

  /**
   * Covers an account's shortfall with a deposit, the same cash not recorded
   * yet that Setup takes, rounded up to the cent. The user asks for it; the
   * app never adds one on its own, since placing the change elsewhere may be
   * the better answer.
   */
  function addDeposit(accountId: string, amount: number) {
    const scale = 10 ** fractionDigits;
    const rounded = Math.ceil(amount * scale - 1e-6) / scale;
    if (rounded <= 0) return;
    setExternalCash((current) => {
      const now = Math.max(0, decimalInputOrZero(current[accountId] ?? ""));
      return { ...current, [accountId]: formatDecimalInput(now + rounded, fractionDigits) };
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

  /**
   * Replaces the worksheet's amounts with a calculated set. Only the two
   * explicit actions call this. Added securities stay: the user chose them as
   * part of the scope, and the calculation gives what is not held nothing, so
   * their amounts start empty.
   */
  function applyCalculated(calculated: CalculatedAdjustments) {
    const prefilled = adjustmentsFromCalculated(calculated);
    setEditMode("amount");
    setAdjustments(prefilled);
    setExpandedAssetIds(new Set());
    setResult(null);
    setCalculationError(null);
    setPanel("amounts");
  }

  async function recalculateFromTarget() {
    if (generationIssue) return;
    setGenerateError(null);
    // Reuse the preview's version guard: a late calculation cannot overwrite
    // newer edits, sources or another target. Mode and eligibility also matter
    // to generation, even though they do not invalidate edited previews.
    const calculationVersion = calculationVersionRef.current;
    const inputsKey = currentGenerationInputsKey;
    const isCurrent = () =>
      calculationVersion === calculationVersionRef.current &&
      inputsKey === generationInputsKeyRef.current;
    try {
      const calculated = await calculator.mutateAsync({
        targetId: generationInputs.targetId,
        filter: accountScope,
        mode: generationInputs.mode,
        rule: generationInputs.rule,
        cash: cashInput,
        selectedAccountIds: changeAccountIds,
        eligibleAssetIds: generationInputs.eligibleAssetIds,
        sellableAssetIds: generationInputs.sellableAssetIds,
      });
      if (!isCurrent()) {
        if (inputsKey === generationInputsKeyRef.current)
          setGenerateError(t("allocation:worksheet.calculationInterrupted"));
        return;
      }
      setGenerated({ calculated, inputsKey });
      applyCalculated(calculated);
    } catch (error) {
      if (!isCurrent()) {
        if (inputsKey === generationInputsKeyRef.current)
          setGenerateError(t("allocation:worksheet.calculationInterrupted"));
        return;
      }
      setGenerateError(errorMessage(error).replace(/^.*?Invalid input:\s*/i, "") || null);
    }
  }

  function resetToCalculated() {
    if (generated) applyCalculated(generated.calculated);
  }

  function reviewPreparedIssue() {
    if (prepared.issue) {
      openIssue(prepared.issue);
    } else if (unresolvedAmounts.length > 0) {
      setPanel("amounts");
      requestAnimationFrame(() => {
        document
          .getElementById("worksheet-unresolved")
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    }
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
    if (firstUseOpen) return;
    // Placement is separate from portfolio impact: while accounts are incomplete,
    // preview each position's total without inventing an account assignment.
    // Invalid amounts still need correction; an empty preview can read cash first.
    const cashOnly = Boolean(prepared.issue) && (!isIndicative || !cash.isKnown);
    if (cashOnly && cash.isKnown) return;
    if (autoCalculateTimerRef.current) clearTimeout(autoCalculateTimerRef.current);
    setCalculationError(null);
    const calculationVersion = calculationVersionRef.current;
    try {
      const data = await worksheet.mutateAsync({
        targetId: profile!.id,
        filter: accountScope,
        cash: cashOnly ? { trackedCashToUse: 0, externalContribution: {} } : cashInput,
        lines: cashOnly ? [] : isIndicative ? prepared.positionLines : prepared.lines,
        selectedAccountIds: changeAccountIds,
      });
      // What the accounts record depends on the sources alone and is filed
      // under their key, so it stands even when an edit overtook this preview.
      setRecordedCash((current) => ({
        sourceKey: cashSourceKey,
        byAccount: {
          ...(current?.sourceKey === cashSourceKey ? current.byAccount : {}),
          ...data.recordedCashByAccount,
        },
      }));
      if (calculationVersion !== calculationVersionRef.current) return;
      if (!cashOnly) {
        setResult(data);
        setIsResultStale(false);
      }
      setCalculationError(null);
    } catch (error) {
      if (calculationVersion !== calculationVersionRef.current) return;
      const rawMessage = errorMessage(error);
      const affectedLine = [...prepared.lines, ...prepared.positionLines].find((line) =>
        rawMessage.includes(line.lineId),
      );
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

  // Warnings and an out-of-date worksheet travel with the file; only a change
  // the review cannot include, or a result being recomputed, holds it back.
  const canExport = Boolean(
    isPlacedResult && !isResultStale && !prepared.issue && !calculationError,
  );
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
    try {
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
          depositsByAccount: externalContribution,
          editedAssetIds: calculated ? editedAssetIds(adjustments, calculated) : undefined,
          describeWarning: wordWarning,
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
          status: t("allocation:worksheet.exportStatus"),
          statusUnresolved: t("allocation:worksheet.exportStatusUnresolved"),
          statusCalculated: t("allocation:worksheet.exportStatusCalculated"),
          statusEdited: t("allocation:worksheet.exportStatusEdited"),
          direction: t("allocation:worksheet.exportDirection"),
          increase: t("allocation:worksheet.allowIncrease"),
          reduce: t("allocation:worksheet.allowReduce"),
          deposit: t("allocation:worksheet.depositAdd"),
          unknownAccount: t("allocation:worksheet.unknownAccount"),
          total: t("allocation:worksheet.accountTotal"),
          cashLeft: t("allocation:result.cashRemaining"),
          limitationsTitle: t("allocation:worksheet.limitationsTitle"),
          limitations: t("allocation:worksheet.fullDisclosure"),
        },
      );
      if (format === "csv") {
        // The runtime's own save: a native dialog in the app, a download on the web.
        await openFileSaveDialog(
          csvFile(toCsv(table, decimalSeparator)),
          `rebalancing-worksheet-${result.calculatedAt.slice(0, 10)}.csv`,
        );
      } else {
        await copyText(toTsv(table, decimalSeparator));
        toast.success(t("allocation:worksheet.tableCopied"));
      }
    } catch {
      toast.error(
        t(
          format === "csv"
            ? "allocation:worksheet.exportFailed"
            : "allocation:worksheet.copyFailed",
        ),
      );
    }
  }
  // Amber like the out-of-date notice it answers.
  const recalculateButton = (
    <Button
      size="sm"
      variant="outline"
      disabled={!!generationIssue || calculator.isPending}
      onClick={() => void recalculateFromTarget()}
      className="border-warning bg-warning-subtle text-warning-subtle-foreground hover:bg-warning-subtle/70 hover:text-warning-subtle-foreground font-semibold"
    >
      {calculator.isPending ? (
        <Icons.Spinner className="me-1.5 h-4 w-4 animate-spin" />
      ) : (
        <Icons.RefreshCw className="me-1.5 h-4 w-4" />
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

  // The securities card groups securities by the target's categories, the
  // ones below target first since they receive the increases.
  const colorByCategory = buildAllocationTargetColorMap(driftReport.rows);
  const targetCategories: TargetCategories | undefined = driftReport.holdings
    ? {
        order: driftReport.rows
          .filter((row) => !row.isCash)
          .map((row) => ({
            id: row.categoryId,
            name: row.categoryName,
            // The allocation page's colours, so a category reads the same everywhere.
            color: allocationTargetColorForRow(row, colorByCategory),
            isBelowTarget: row.valueDelta < 0,
          }))
          .sort((left, right) => Number(right.isBelowTarget) - Number(left.isBelowTarget)),
        byAsset: categoriesByAsset(driftReport.holdings.rows),
      }
    : undefined;

  // What the target's rules take out of the calculation's hands in the
  // selected accounts: a reduction where every account holding the security
  // is covered, an increase wherever it is covered.
  const categoriesOf = (assetId: string) => targetCategories?.byAsset.get(assetId) ?? [];
  const reduceProtected = new Set(
    eligibility.eligibleHoldings
      .filter((holding) =>
        holding.accountIds.every((accountId) =>
          rules.blocksReduce(holding.assetId, accountId, categoriesOf(holding.assetId)),
        ),
      )
      .map((holding) => holding.assetId),
  );
  const increaseProtected = new Set(
    eligibility.eligibleHoldings
      .filter((holding) => rules.blocksIncrease(holding.assetId, categoriesOf(holding.assetId)))
      .map((holding) => holding.assetId),
  );

  // What each category's gap can reach in the selected accounts, with the
  // securities as they are set: the gap card says it beside the amount.
  const reach = new Map<string, CategoryReach>(
    (targetCategories?.order ?? []).map((category) => {
      const held = eligibility.eligibleHoldings.filter((holding) =>
        (targetCategories?.byAsset.get(holding.assetId) ?? []).includes(category.id),
      );
      // Two assets can share a symbol; the note names each symbol once.
      const symbols = (holdings: typeof held) => [
        ...new Set(holdings.map((holding) => holding.symbol)),
      ];
      return [
        category.id,
        {
          held: symbols(held),
          increase: symbols(
            held.filter(
              (holding) =>
                !eligibility.excludedAssetIds.has(holding.assetId) &&
                !increaseProtected.has(holding.assetId),
            ),
          ),
          reduce: symbols(
            held.filter(
              (holding) =>
                !sellability.excludedAssetIds.has(holding.assetId) &&
                !reduceProtected.has(holding.assetId),
            ),
          ),
        },
      ];
    }),
  );

  // The target's limits, said once with the securities they shape.
  const minLine = minLineSize;
  const targetLimits = [
    profile.wholeSharesOnly ? t("allocation:worksheet.limitWholeUnits") : null,
    minLine > 0
      ? t("allocation:worksheet.limitMinLine", { amount: formatAmount(minLine, currency) })
      : null,
    profile.maxTurnoverBps
      ? t("allocation:worksheet.limitTurnover", { percent: profile.maxTurnoverBps / 100 })
      : null,
  ].filter((limit): limit is string => limit !== null);

  /**
   * A total is spent as one share of every account. Amounts the user set per
   * account give way to it, and stay one Undo away.
   */
  function changeCashTotal(value: string | null) {
    if (cashByAccount !== null) {
      setReplacedCash(cashByAccount);
      setCashByAccount(null);
    }
    setTrackedCash(value);
  }

  /** Setting one account's amount sets every account's, and the total follows their sum. */
  function changeAccountCash(accountId: string, value: string) {
    setReplacedCash(null);
    setCashByAccount((current) => ({
      ...(current ?? editableAmounts(cash.byAccount, fractionDigits)),
      [accountId]: value,
    }));
  }

  /** Back to one share of every account, at the total the accounts add up to now. */
  function useSameCashShare() {
    setReplacedCash(null);
    setCashByAccount(null);
    setTrackedCash(
      cash.isKnown && cash.total < cash.recordedTotal - AMOUNT_EPSILON
        ? formatDecimalInput(cash.total, fractionDigits)
        : null,
    );
  }

  function undoReplacedCash() {
    if (!replacedCash) return;
    setCashByAccount(replacedCash);
    setReplacedCash(null);
  }

  const nextNeedsCalculation = !generated || isOutOfDate;
  const setupChangedMessage =
    generated && isOutOfDate
      ? inputsChanged
        ? t("allocation:worksheet.setupChanged")
        : t("allocation:worksheet.setupPricesChanged", { percent: PRICE_MOVE_THRESHOLD * 100 })
      : null;

  /**
   * Setup's one action leads to Adjust positions, calculating on the way when
   * there is nothing yet or the inputs changed. Edits made since the last
   * calculation are replaced only once the user says so (§5).
   */
  function goToAdjust() {
    // An added security is scope, not an edit; an amount typed for it is.
    const hasEdits = generated !== null && !isAsCalculated(adjustments, generated.calculated);
    if (!nextNeedsCalculation) {
      setPanel("amounts");
    } else if (hasEdits) {
      setReplaceEditsOpen(true);
    } else {
      void recalculateFromTarget();
    }
  }

  const setupActions = (
    <div className="space-y-3">
      {generateError && (
        <div role="alert">
          <p className="text-destructive text-xs font-semibold">
            {t("allocation:worksheet.generateFailed")}
          </p>
          <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">{generateError}</p>
        </div>
      )}
      {setupChangedMessage && (
        <p
          role="status"
          className="text-warning-subtle-foreground flex items-start gap-2 text-xs leading-relaxed"
        >
          <Icons.AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {setupChangedMessage}
        </p>
      )}
      <Button
        className="w-full"
        disabled={nextNeedsCalculation && (!!generationIssue || calculator.isPending)}
        onClick={goToAdjust}
      >
        {calculator.isPending && <Icons.Spinner className="me-1.5 h-4 w-4 animate-spin" />}
        {t("allocation:worksheet.nextPanel", {
          panel: t("allocation:worksheet.stepAmounts"),
        })}
        {!calculator.isPending && <Icons.ArrowRight className="ms-1.5 h-4 w-4" />}
      </Button>
      {!generated && (
        <>
          {!generationIssue && (
            <p className="text-muted-foreground text-center text-xs">
              {t("allocation:worksheet.calculateHint")}
            </p>
          )}
          <button
            type="button"
            onClick={() => setPanel("amounts")}
            className="text-muted-foreground hover:text-foreground block w-full text-center text-xs underline-offset-4 hover:underline"
          >
            {t("allocation:worksheet.enterManually")}
          </button>
        </>
      )}
    </div>
  );

  return (
    <div ref={worksheetRef} className="min-w-0 space-y-4">
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

      <AlertDialog open={replaceEditsOpen} onOpenChange={setReplaceEditsOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("allocation:worksheet.replaceEditsTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("allocation:worksheet.replaceEditsDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPanel("amounts")}>
              {t("allocation:worksheet.keepEdits")}
            </AlertDialogCancel>
            <AlertDialogAction onClick={() => void recalculateFromTarget()}>
              {t("allocation:worksheet.recalculate")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <div
        className="flex min-w-0 flex-col gap-x-3 gap-y-2 sm:flex-row sm:items-start"
        data-worksheet-header
      >
        {backAction && (
          <div className="flex min-h-10 shrink-0 items-center gap-3">
            {backAction}
            <span className="bg-border hidden h-5 w-px sm:block" />
          </div>
        )}
        <div className="@container/worksheet-heading min-w-0 flex-1">
          <div className="grid min-w-0 grid-cols-1 gap-x-6 gap-y-2 @[36rem]/worksheet-heading:grid-cols-[auto_minmax(0,1fr)]">
            {heading && <div className="flex min-h-10 min-w-0 items-center">{heading}</div>}
            <WorksheetStepper
              panel={panel}
              onSelect={setPanel}
              setupChanged={setupChangedMessage}
            />
          </div>
        </div>
      </div>

      {/* Where amounts are read, a stale worksheet says so first. Setup offers the
          same action at the bottom, after the inputs that changed. */}
      {isOutOfDate && panel !== "setup" && (
        <div
          role="status"
          className="border-warning-subtle-border bg-warning-subtle flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-2.5"
        >
          <p className="text-warning-subtle-foreground/80 min-w-0 flex-1 text-xs leading-relaxed">
            {outOfDateMessage}
          </p>
          {recalculateButton}
        </div>
      )}

      {panel === "setup" ? (
        <WorksheetSetup
          profile={profile}
          driftReport={driftReport}
          currency={currency}
          accounts={scopedAccounts}
          selectedAccountIds={changeAccountIds}
          onToggleAccount={(accountId) =>
            setSelectedAccountIds(
              changeAccountIds.includes(accountId)
                ? changeAccountIds.filter((id) => id !== accountId)
                : [...changeAccountIds, accountId],
            )
          }
          onSelectAllAccounts={() => setSelectedAccountIds(null)}
          onClearAccounts={() => setSelectedAccountIds([])}
          mode={mode}
          onModeChange={setMode}
          recordedByAccount={recordedByAccount}
          cash={cash}
          trackedCash={trackedCash}
          cashByAccount={cashByAccount}
          onTotalChange={changeCashTotal}
          onAccountCashChange={changeAccountCash}
          onUseSameShare={useSameCashShare}
          replacedCash={replacedCash ? { onUndo: undoReplacedCash } : null}
          externalCash={externalCash}
          onExternalCashChange={(accountId, value) =>
            setExternalCash((current) => ({ ...current, [accountId]: value }))
          }
          reach={reach}
          protectedAccountIds={rules.protectedAccountIds}
          eligibleSecurities={
            <SecuritiesCard
              holdings={changeHoldings}
              categories={targetCategories}
              increaseExcluded={eligibility.excludedAssetIds}
              reduceExcluded={sellability.excludedAssetIds}
              increaseProtected={increaseProtected}
              reduceProtected={reduceProtected}
              onToggleIncrease={eligibility.toggle}
              onToggleReduce={sellability.toggle}
              onSetIncrease={eligibility.setIncluded}
              onSetReduce={sellability.setIncluded}
              isRebalance={mode === "rebalance"}
              assets={eligibleAssets}
              addedAssetIds={addedAssetIds}
              onAdd={(assetId) => setAddedAssetIds((current) => [...current, assetId])}
              onRemove={removeAddedPosition}
              limits={targetLimits}
              currency={currency}
            />
          }
          blockingIssues={[
            changeAccountIds.length === 0 ? t("allocation:worksheet.selectAccountIssue") : null,
            changeAccountIds.length > 0 && !cash.isKnown
              ? t("allocation:worksheet.cashReading")
              : null,
            cashIssue?.message ?? null,
          ].filter((issue): issue is string => issue !== null)}
          actions={setupActions}
        />
      ) : (
        <HighlightStoreContext.Provider value={highlightStore}>
          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_23rem] xl:grid-cols-[minmax(0,1fr)_26rem]">
            <Card id="worksheet-positions" className="min-w-0 overflow-hidden">
              <CardContent className="p-0">
                {panel === "amounts" && (
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 sm:px-5">
                    <div className="border-border bg-muted/20 flex rounded-full border p-1">
                      {(["amount", "after_percentage"] as const).map((option) => (
                        <button
                          key={option}
                          type="button"
                          onClick={() => switchEditMode(option)}
                          className={cn(
                            "rounded-full px-3.5 py-1.5 text-xs transition-colors",
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
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button size="icon" variant="ghost" aria-label={t("common:actions")} />
                          }
                        >
                          <Icons.MoreHorizontal className="h-4 w-4" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={resetToCalculated}>
                            <Icons.Undo className="me-1.5 h-4 w-4" />
                            {t("allocation:worksheet.resetToCalculated")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                )}

                {/* Unplaced amounts stay visible; calculation notes sit below
                    the editable positions, with the full summary on Review. */}
                {generated && (
                  <CalculatedSummary
                    presentation={panel === "amounts" ? "notice" : "review"}
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
                        allowSells={allowsReductions}
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
                          onAddDeposit: addDeposit,
                          onPriceAction: (assetId, asset) => {
                            if (asset?.quoteMode === "MARKET") syncPrice.mutate([asset.id]);
                            else navigate(`/holdings/${assetId}`);
                          },
                        }}
                      />
                    )}
                    {generated && (
                      <CalculatedSummary
                        presentation="details"
                        calculated={generated.calculated}
                        currency={currency}
                        accountNames={accountNames}
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
                    describeWarning={wordWarning}
                    result={prepared.issue || !isPlacedResult ? null : result}
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
                    depositsByAccount={externalContribution}
                    onAddDeposit={addDeposit}
                    currency={currency}
                    onOpenRow={(assetId) => {
                      const issue = prepared.rowIssues.get(assetId);
                      if (issue) openIssue(issue);
                    }}
                  />
                )}

                {disclosure}
              </CardContent>
            </Card>

            <div className="space-y-4 lg:sticky lg:top-4">
              <ImpactRail
                describeWarning={wordWarning}
                report={driftReport}
                result={result}
                isStale={isResultStale}
                isIndicative={isIndicative}
                classes={classes}
                rows={amountsRows.map((row) => ({
                  assetId: row.position.assetId,
                  symbol: row.position.symbol,
                  shares: row.position.categoryExposures,
                  change: resultByAsset.get(row.position.assetId)?.amount ?? row.changeAmount,
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
              {/* The step's own action, under the summary it follows from, as on
                  Setup: in view while the list scrolls, one primary at a time. */}
              <div className="space-y-3">
                {panel === "amounts" ? (
                  <Button className="w-full" onClick={() => setPanel("review")}>
                    {t("allocation:worksheet.nextPanel", {
                      panel: t("allocation:worksheet.stepReview"),
                    })}
                    <Icons.ArrowRight className="ms-1.5 h-4 w-4" />
                  </Button>
                ) : (
                  <>
                    <p
                      className={cn(
                        "text-xs leading-relaxed",
                        prepared.issue ? "text-warning-subtle-foreground" : "text-muted-foreground",
                      )}
                    >
                      {exportMessage}
                    </p>
                    <div className="grid gap-2">
                      <Button disabled={!canExport} onClick={() => void exportWorksheet("csv")}>
                        <Icons.Download className="me-1.5 h-4 w-4" />
                        {t("allocation:worksheet.exportCsv")}
                      </Button>
                      <Button
                        variant="outline"
                        disabled={!canExport}
                        onClick={() => void exportWorksheet("copy")}
                      >
                        <Icons.Copy className="me-1.5 h-4 w-4" />
                        {t("allocation:worksheet.copyForSpreadsheet")}
                      </Button>
                    </div>
                  </>
                )}
                <button
                  type="button"
                  onClick={() => setPanel(panel === "review" ? "amounts" : "setup")}
                  className="text-muted-foreground hover:text-foreground flex w-full items-center justify-center gap-1.5 text-xs underline-offset-4 hover:underline"
                >
                  <Icons.ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                  {t("allocation:worksheet.previousPanel", {
                    panel:
                      panel === "review"
                        ? t("allocation:worksheet.stepAmounts")
                        : t("allocation:worksheet.stepSetup"),
                  })}
                </button>
              </div>
              {/* Review states each account's cash in its own group. */}
              {panel === "amounts" && (
                <Card className="overflow-hidden">
                  <CardContent className="p-0">
                    <FundingSummary
                      result={isResultStale ? null : result}
                      estimate={fundingEstimate}
                      onAddDeposit={addDeposit}
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
  /** Why Setup no longer matches the calculation, when it does not. */
  setupChanged: string | null;
}

/**
 * Every step is a button: any panel, ahead or behind, opens on the current
 * worksheet, and nothing is calculated on the way.
 */
function WorksheetStepper({ panel, onSelect, setupChanged }: WorksheetStepperProps) {
  const { t } = useTranslation();
  const steps: { id: WorksheetPanel; label: string; note?: ReactNode }[] = [
    {
      id: "setup",
      label: t("allocation:worksheet.stepSetup"),
      note: setupChanged ? (
        <span title={setupChanged} className="bg-warning h-1.5 w-1.5 rounded-full">
          <span className="sr-only">{setupChanged}</span>
        </span>
      ) : undefined,
    },
    { id: "amounts", label: t("allocation:worksheet.stepAmounts") },
    { id: "review", label: t("allocation:worksheet.stepReview") },
  ];

  return (
    <nav
      aria-label={t("allocation:worksheet.title")}
      className="border-border bg-muted/20 row-start-2 inline-flex max-w-full flex-wrap justify-self-start rounded-full border p-1 @[36rem]/worksheet-heading:col-start-2 @[36rem]/worksheet-heading:row-start-1"
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
          <span className="text-2xs font-mono opacity-60">{index + 1}</span>
          {step.label}
          {step.note}
        </button>
      ))}
    </nav>
  );
}
