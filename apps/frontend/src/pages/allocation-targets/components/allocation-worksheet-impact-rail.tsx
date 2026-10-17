import { Button, Card, CardContent, Icons, useAmountFormatting } from "@wealthfolio/ui";
import { useTranslation } from "react-i18next";

import type { AllocationWorksheetResult, CalculatedAdjustments, DriftReport } from "@/lib/types";
import { cn } from "@/lib/utils";

import {
  activeTarget,
  categoryEmphasis,
  changeInCategory,
  trackHalfWindowBps,
  trackPosition,
  type Emphasis,
  type HighlightTarget,
} from "./allocation-worksheet-amounts";
import { useHighlight, useHighlightActions } from "./allocation-worksheet-highlight";
import {
  AMOUNT_EPSILON,
  formatSignedAmount,
  UNCLASSIFIED_CATEGORY_ID,
  UNRESOLVED_REASON_KEYS,
  type ImpactClass,
  type PositionCategoryExposure,
} from "./allocation-worksheet-utils";

/** What the rail needs to know about a worksheet row to show its part in each class. */
export interface ImpactRailRow {
  assetId: string;
  symbol: string;
  shares: readonly PositionCategoryExposure[];
  change: number;
  /** What the security holds of each class across the target's scope. */
  valueIn: Readonly<Record<string, number>>;
}

type UnresolvedAmount = CalculatedAdjustments["unresolved"][number];

interface ImpactRailProps {
  report: DriftReport;
  result: AllocationWorksheetResult | null;
  isStale: boolean;
  classes: readonly ImpactClass[];
  rows: readonly ImpactRailRow[];
  unresolved: readonly UnresolvedAmount[];
  issueMessage: string | undefined;
  calculationError: { title: string; description?: string } | null;
  isCalculating: boolean;
  firstUseOpen: boolean;
  onCalculate: () => void;
  onReviewIssue: () => void;
  onClassifySecurity: (lineId: string) => void;
}

function formatWeight(bps: number): string {
  return (bps / 100).toFixed(1);
}

function formatShare(bps: number): string {
  return `${Math.round(bps / 100)}%`;
}

function formatFraction(fraction: number): string {
  const percent = fraction * 100;
  return `${percent.toFixed(percent < 10 ? 1 : 0)}%`;
}

/**
 * How big a security is inside a class: its value there over the class's,
 * now and once its change lands. Answers whether the row weighs much in the
 * class, which its share of the row (100% for a single-class fund) does not.
 */
function shareOfClass(
  row: ImpactRailRow,
  item: ImpactClass,
  weightBps: number,
): string | undefined {
  const valueNow = row.valueIn[item.categoryId] ?? 0;
  const delta = changeInCategory(row.change, weightBps);
  const now = item.currentValue > 0 ? valueNow / item.currentValue : undefined;
  const after =
    Math.abs(delta) >= AMOUNT_EPSILON && item.projectedValue > 0
      ? Math.max(0, valueNow + delta) / item.projectedValue
      : undefined;
  if (after !== undefined) return `${formatFraction(now ?? 0)} → ${formatFraction(after)}`;
  return now === undefined ? undefined : formatFraction(now);
}

export function ImpactRail({
  report,
  result,
  isStale,
  classes,
  rows,
  unresolved,
  issueMessage,
  calculationError,
  isCalculating,
  firstUseOpen,
  onCalculate,
  onReviewIssue,
  onClassifySecurity,
}: ImpactRailProps) {
  const { t } = useTranslation();
  const { formatAmount } = useAmountFormatting();
  const pointedOrSelected = useHighlight((state) => activeTarget(state));
  const selected = useHighlight((state) => state.selected);
  const { clearSelection } = useHighlightActions();

  const outsideRangeCount = classes.filter(
    (item) => Math.abs(item.projectedDifferenceBps) > item.effectiveBandBps,
  ).length;
  const largestDifference = result?.maxDifferenceBpsAfter ?? report.maxDriftBps;
  const totalMoved = result ? result.increaseTotal + result.reductionTotal : 0;

  const rowById = new Map(rows.map((row) => [row.assetId, row]));
  const activeRow =
    pointedOrSelected?.kind === "row" ? rowById.get(pointedOrSelected.assetId) : undefined;
  // A row that left the worksheet lights nothing.
  const active = pointedOrSelected?.kind === "row" && !activeRow ? null : pointedOrSelected;
  const selectedLabel =
    selected?.kind === "row"
      ? rowById.get(selected.assetId)?.symbol
      : selected?.kind === "category"
        ? classes.find((item) => item.categoryId === selected.categoryId)?.categoryName
        : undefined;
  const unclassifiedBps =
    activeRow?.shares.find((share) => share.categoryId === UNCLASSIFIED_CATEGORY_ID)?.weightBps ??
    0;
  const unresolvedByCategory = new Map(unresolved.map((item) => [item.categoryId, item]));
  const halfWindow = trackHalfWindowBps(classes);

  return (
    <Card className="overflow-hidden">
      <CardContent className="p-0">
        {selectedLabel && (
          <div className="bg-background flex items-center justify-between gap-2 border-b px-5 py-2 text-xs sm:px-6">
            <span className="min-w-0 truncate">
              {t("allocation:worksheet.selectedLabel")}{" "}
              <span className="font-mono font-semibold">{selectedLabel}</span>
            </span>
            <button
              type="button"
              onClick={clearSelection}
              className="shrink-0 underline underline-offset-4"
            >
              {t("allocation:worksheet.clearSelection")}
            </button>
          </div>
        )}

        <div
          className={cn(
            "p-5 pb-3 transition-opacity sm:p-6 sm:pb-3",
            result && isStale && "opacity-50",
          )}
          aria-busy={isCalculating}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-muted-foreground font-mono text-[11px] uppercase tracking-[0.16em]">
              {t("allocation:worksheet.portfolioImpact")}
            </p>
            {/* Updating is routine; an out-of-date preview is amber, as everywhere else. */}
            {(isCalculating || (result && isStale)) && (
              <span
                className={cn(
                  "rounded-full px-2 py-1 font-mono text-[10px]",
                  isCalculating
                    ? "bg-muted text-muted-foreground"
                    : "bg-amber-100 text-amber-900 dark:bg-amber-950/35 dark:text-amber-200",
                )}
              >
                {isCalculating
                  ? t("allocation:worksheet.updatingPreview")
                  : t("allocation:worksheet.previewOutOfDate")}
              </span>
            )}
          </div>

          <p className="mt-4 font-mono text-xl font-semibold leading-tight">
            {t("allocation:worksheet.outsideRangeImpact", {
              before: report.outOfBandCount,
              after: outsideRangeCount,
            })}
          </p>
          <div className="text-muted-foreground mt-2 space-y-1 font-mono text-xs">
            <p>
              {/* In %, like every other difference on the allocation pages. */}
              {t("allocation:worksheet.largestDifference", {
                amount: `${(largestDifference / 100).toFixed(1)}%`,
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
          {activeRow && unclassifiedBps > 0 && (
            <p className="mt-2 text-xs text-amber-800 dark:text-amber-200">
              {unclassifiedBps >= 10_000
                ? t("allocation:worksheet.rowUnclassified", { symbol: activeRow.symbol })
                : t("allocation:worksheet.rowPartlyClassified", {
                    share: formatShare(unclassifiedBps),
                    symbol: activeRow.symbol,
                  })}
            </p>
          )}
        </div>

        <div
          className={cn(
            "space-y-0.5 px-3 pb-4 transition-opacity sm:px-4",
            result && isStale && "opacity-55",
          )}
        >
          {/* The marks on each track, named with the worksheet's own vocabulary. The
              segment from current to projected reads as the move. */}
          <p
            data-track-legend
            className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 px-2 pb-1.5 text-[10px]"
          >
            <span className="inline-flex items-center gap-1">
              <span className="inline-flex items-center">
                <span className="border-muted-foreground h-2 w-2 rounded-full border" />
                <span className="bg-muted-foreground h-px w-2.5" />
                <span className="bg-muted-foreground h-2 w-2 rounded-full" />
              </span>
              {t("allocation:worksheet.legendCurrent")} →{" "}
              {t("allocation:worksheet.legendProjected")}
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="bg-foreground h-3 w-0.5" />
              {t("allocation:worksheet.legendTarget")}
            </span>
          </p>
          {classes.map((item) => {
            const share = activeRow?.shares.find(
              (entry) => entry.categoryId === item.categoryId && entry.weightBps > 0,
            );
            const unresolvedAmount = unresolvedByCategory.get(item.categoryId);
            return (
              <ImpactClassRow
                key={item.categoryId}
                item={item}
                halfWindow={halfWindow}
                emphasis={categoryEmphasis(active, item.categoryId, activeRow?.shares)}
                isSelected={
                  selected?.kind === "category" && selected.categoryId === item.categoryId
                }
                shareText={(() => {
                  const inClass =
                    activeRow && share ? shareOfClass(activeRow, item, share.weightBps) : undefined;
                  return activeRow && inClass
                    ? t("allocation:worksheet.rowShareOfClass", {
                        symbol: activeRow.symbol,
                        share: inClass,
                        category: item.categoryName,
                      })
                    : undefined;
                })()}
                shareAmount={
                  activeRow && share && Math.abs(activeRow.change) >= AMOUNT_EPSILON
                    ? formatSignedAmount(
                        changeInCategory(activeRow.change, share.weightBps),
                        report.baseCurrency,
                        formatAmount,
                      )
                    : undefined
                }
                note={
                  !activeRow && unresolvedAmount
                    ? t("allocation:worksheet.unresolvedInClass", {
                        amount: formatSignedAmount(
                          unresolvedAmount.amount,
                          report.baseCurrency,
                          formatAmount,
                        ),
                        reason: t(UNRESOLVED_REASON_KEYS[unresolvedAmount.reason]),
                      })
                    : undefined
                }
              />
            );
          })}
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
          {!calculationError && issueMessage && (
            <p className="text-muted-foreground text-xs leading-relaxed">{issueMessage}</p>
          )}
          {(issueMessage || calculationError) && (
            <Button
              className="w-full"
              disabled={isCalculating || firstUseOpen}
              onClick={issueMessage ? onReviewIssue : onCalculate}
            >
              {issueMessage ? (
                <Icons.AlertCircle className="mr-1.5 h-4 w-4" />
              ) : (
                <Icons.BarChart className="mr-1.5 h-4 w-4" />
              )}
              {issueMessage
                ? t("allocation:worksheet.goToIssue")
                : t("allocation:worksheet.retryPreview")}
            </Button>
          )}

          {isCalculating && !issueMessage && (
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

interface ImpactClassRowProps {
  item: ImpactClass;
  /** Shared by every class, so distances to target compare across them. */
  halfWindow: number;
  emphasis: Emphasis;
  isSelected: boolean;
  /** The active row's share of this class, e.g. "60% of VBIAX". */
  shareText: string | undefined;
  /** The active row's change that lands in this class. */
  shareAmount: string | undefined;
  note: string | undefined;
}

function ImpactClassRow({
  item,
  halfWindow,
  emphasis,
  isSelected,
  shareText,
  shareAmount,
  note,
}: ImpactClassRowProps) {
  const { t } = useTranslation();
  const { point, unpoint, toggleSelected } = useHighlightActions();
  const target: HighlightTarget = { kind: "category", categoryId: item.categoryId };

  // The range no longer moves the calculation, which aims at the exact target;
  // it only says whether the class stays flagged, so it is a mark, not a band.
  const isOutsideRange = Math.abs(item.projectedDifferenceBps) > item.effectiveBandBps;
  const currentAt = trackPosition(item.currentBps, item.targetBps, halfWindow);
  const projectedAt = trackPosition(item.projectedBps, item.targetBps, halfWindow);

  return (
    <button
      type="button"
      data-impact-class={item.categoryId}
      data-emphasis={emphasis}
      aria-pressed={isSelected}
      onPointerEnter={(event) => event.pointerType !== "touch" && point(target)}
      onPointerLeave={(event) => event.pointerType !== "touch" && unpoint(target)}
      onFocus={() => point(target)}
      onBlur={() => unpoint(target)}
      onClick={() => toggleSelected(target)}
      className={cn(
        "block w-full rounded-md px-2 py-2 text-left transition-[opacity,background-color]",
        (emphasis === "active" || emphasis === "lit") && "bg-muted/60",
        emphasis === "dim" && "opacity-40",
        isSelected && "ring-foreground ring-[1.5px] ring-inset",
      )}
    >
      <span className="flex items-center justify-between gap-2 text-xs">
        <span className="flex min-w-0 items-center gap-2">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: item.color }} />
          <span className="truncate">{item.categoryName}</span>
        </span>
        {/* Only the projected figure turns amber when it stays outside its range:
            the target is not the problem. */}
        <span
          className="text-muted-foreground shrink-0 font-mono text-[11px] tabular-nums"
          title={t("allocation:worksheet.classFiguresTitle")}
        >
          {formatWeight(item.currentBps)} →{" "}
          <span
            data-outside-range={isOutsideRange || undefined}
            className={cn(
              "font-semibold",
              isOutsideRange ? "text-amber-700 dark:text-amber-300" : "text-foreground",
            )}
          >
            {formatWeight(item.projectedBps)}
          </span>{" "}
          / {formatWeight(item.targetBps)}
        </span>
      </span>
      <span className="relative mt-1.5 block h-3" aria-hidden>
        <span className="bg-border/60 absolute left-0 right-0 top-[5.5px] h-px" />
        {/* The move, in the class's colour, so no legend is needed to read it. */}
        <span
          className="absolute top-[5px] h-0.5"
          style={{
            left: `${Math.min(currentAt, projectedAt)}%`,
            width: `${Math.abs(projectedAt - currentAt)}%`,
            background: item.color,
          }}
        />
        {/* The one fixed mark in the column, taller than the dots. */}
        <span className="bg-foreground absolute -top-0.5 left-1/2 h-4 w-0.5 -translate-x-1/2" />
        <span
          className="border-muted-foreground bg-background absolute top-[2px] h-2 w-2 -translate-x-1/2 rounded-full border"
          style={{ left: `${currentAt}%` }}
        />
        {/* A plain dot in its class colour, which links it to the rows; the amber
            projected figure says when it stays outside its range. */}
        <span
          className="absolute top-[2px] h-2 w-2 -translate-x-1/2 rounded-full"
          style={{ left: `${projectedAt}%`, background: item.color }}
        />
      </span>
      {shareText && (
        <span className="mt-1.5 flex justify-between gap-2 text-[11px]">
          <span className="font-semibold">{shareText}</span>
          {shareAmount && <span className="font-mono tabular-nums">{shareAmount}</span>}
        </span>
      )}
      {note && (
        <span className="mt-1.5 block text-[11px] text-amber-800 dark:text-amber-200">{note}</span>
      )}
    </button>
  );
}
