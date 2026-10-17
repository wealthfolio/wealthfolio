import {
  Icons,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  useAmountFormatting,
  useDateFormatting,
  useNumberFormatting,
} from "@wealthfolio/ui";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { AllocationWorksheetLineResult, AllocationWorksheetResult } from "@/lib/types";
import { cn } from "@/lib/utils";

import {
  AMOUNT_EPSILON,
  formatDecimalInput,
  formatSignedAmount,
} from "./allocation-worksheet-utils";

/** A change the review cannot include yet, and why. */
export interface HeldLine {
  assetId: string;
  symbol: string;
  change: number;
  cause: string;
}

interface ReviewPanelProps {
  result: AllocationWorksheetResult | null;
  isStale: boolean;
  isCalculating: boolean;
  /** What keeps the worksheet from being previewed, when it is not a row. */
  worksheetIssue: string | undefined;
  heldLines: readonly HeldLine[];
  calculationError: { title: string; description?: string } | null;
  accountNames: ReadonlyMap<string, string>;
  currency: string;
  onOpenRow: (assetId: string) => void;
  /** Copy and export, which sit with the result they carry. */
  exportActions: ReactNode;
}

function signedLineAmount(line: AllocationWorksheetLineResult): number {
  return line.direction === "increase" ? line.estimatedAmount : -line.estimatedAmount;
}

/**
 * The worksheet as each account would take it: grouped by account, because an
 * account is what the user acts on, with the cash each one has left or lacks.
 * Changes that cannot be included yet are listed first, read-only, with the
 * way back to the row that fixes them.
 */
export function ReviewPanel({
  result,
  isStale,
  isCalculating,
  worksheetIssue,
  heldLines,
  calculationError,
  accountNames,
  currency,
  onOpenRow,
  exportActions,
}: ReviewPanelProps) {
  const { t } = useTranslation();
  const { formatAmount, formatPrice } = useAmountFormatting();
  const { formatQuantity } = useNumberFormatting();
  const { formatDateTime } = useDateFormatting();

  const warningsByLine = new Map<string, string[]>();
  for (const warning of result?.warnings ?? []) {
    if (!warning.lineId) continue;
    warningsByLine.set(warning.lineId, [
      ...(warningsByLine.get(warning.lineId) ?? []),
      warning.message,
    ]);
  }
  const fundingByAccount = new Map(
    (result?.accountFunding ?? []).map((funding) => [funding.accountId, funding]),
  );
  const groups = new Map<string, AllocationWorksheetLineResult[]>();
  for (const line of result?.lines ?? []) {
    groups.set(line.accountId, [...(groups.get(line.accountId) ?? []), line]);
  }

  const held = (heldLines.length > 0 || worksheetIssue) && (
    <div className="border-b border-amber-400/40 bg-amber-50/40 px-4 py-4 sm:px-5 dark:bg-amber-950/10">
      <p className="text-xs font-medium text-amber-950 dark:text-amber-200">
        {t("allocation:worksheet.heldTitle")}
      </p>
      {worksheetIssue && (
        <p className="mt-1 text-xs leading-relaxed text-amber-950/80 dark:text-amber-100/80">
          {worksheetIssue}
        </p>
      )}
      {heldLines.length > 0 && (
        <ul className="mt-2 divide-y divide-amber-400/20">
          {heldLines.map((line) => (
            <li
              key={line.assetId}
              data-held-line={line.assetId}
              className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-2 text-xs"
            >
              <span className="min-w-0">
                <span className="font-mono font-semibold">{line.symbol}</span>{" "}
                <span className="font-mono tabular-nums">
                  {formatSignedAmount(line.change, currency, formatAmount)}
                </span>
                <span className="text-muted-foreground"> · {line.cause}</span>
              </span>
              <button
                type="button"
                onClick={() => onOpenRow(line.assetId)}
                className="shrink-0 underline underline-offset-4"
              >
                {t("allocation:worksheet.showPosition")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  if (!result) {
    return (
      <div>
        {held}
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
            {calculationError?.description ?? t("allocation:worksheet.reviewHint")}
          </p>
        </div>
        {exportActions}
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

      {held}

      <div className={cn("transition-opacity", isStale && "pointer-events-none opacity-50")}>
        {[...groups].map(([accountId, lines]) => {
          const funding = fundingByAccount.get(accountId);
          const net = lines.reduce((sum, line) => sum + signedLineAmount(line), 0);
          const isShort = funding !== undefined && funding.remaining < -AMOUNT_EPSILON;
          return (
            <section key={accountId} data-review-account={accountId} className="border-b">
              <div className="bg-muted/15 px-4 py-2.5 sm:px-5">
                <p className="min-w-0 text-xs">
                  <span className="font-semibold">
                    {accountNames.get(accountId) ?? t("allocation:worksheet.unknownAccount")}
                  </span>
                  <span className="text-muted-foreground">
                    {" · "}
                    {t("allocation:worksheet.lineCount", { count: lines.length })}
                  </span>
                </p>
              </div>
              <ul className="divide-y">
                {lines.map((line) => {
                  const warnings = warningsByLine.get(line.lineId) ?? [];
                  return (
                    <li
                      key={line.lineId}
                      className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-4 py-2.5 sm:grid-cols-[minmax(0,1fr)_8rem_7rem_9rem] sm:items-center sm:px-5"
                    >
                      <p className="min-w-0 truncate text-xs">
                        <span className="font-mono font-semibold">{line.symbol}</span>
                        <span className="text-muted-foreground"> · {line.name}</span>
                      </p>
                      <p className="text-right font-mono text-xs tabular-nums">
                        {formatSignedAmount(signedLineAmount(line), currency, formatAmount)}
                      </p>
                      <TooltipProvider delayDuration={150}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              className="text-muted-foreground border-muted-foreground/40 w-fit cursor-help border-b border-dotted font-mono text-[11px] tabular-nums sm:justify-self-end"
                            >
                              ≈ {formatQuantity(line.quantity)}
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
                      <p
                        className="truncate text-right text-[11px] text-amber-800 dark:text-amber-200"
                        title={warnings.join("\n")}
                      >
                        {warnings.length > 0 &&
                          t("allocation:worksheet.lineWarningCount", { count: warnings.length })}
                      </p>
                    </li>
                  );
                })}
              </ul>
              {/* Read like a sum: lines in normal weight, the total semibold under
                  a rule that sits exactly on the amounts column, then what the
                  account's own cash leaves or lacks. Every cell starts at the
                  same height, so the total lines up with its label. */}
              <div
                data-review-total
                className="border-foreground/25 grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 border-t px-4 pb-2.5 sm:grid-cols-[minmax(0,1fr)_8rem_7rem_9rem] sm:px-5"
              >
                <p className="pt-2 text-xs font-semibold">
                  {t("allocation:worksheet.accountTotal")}
                </p>
                <p className="border-foreground border-t-[1.5px] pt-2 text-right font-mono text-xs font-semibold tabular-nums">
                  {formatSignedAmount(net, currency, formatAmount)}
                </p>
                <span className="hidden sm:block" />
                {funding && (
                  <p
                    className={cn(
                      "col-span-2 mt-1.5 justify-self-end text-right font-mono text-xs font-semibold tabular-nums sm:col-span-1",
                      isShort
                        ? "rounded bg-amber-50 px-1.5 py-0.5 text-amber-800 dark:bg-amber-950/30 dark:text-amber-200"
                        : "text-foreground",
                    )}
                  >
                    {isShort
                      ? t("allocation:worksheet.fundingNeeded", {
                          amount: formatAmount(-funding.remaining, currency),
                        })
                      : t("allocation:worksheet.accountCashLeft", {
                          amount: formatAmount(funding.remaining, currency),
                        })}
                  </p>
                )}
              </div>
            </section>
          );
        })}
      </div>

      {exportActions}

      <p className="text-muted-foreground border-t px-4 py-3 text-xs leading-relaxed sm:px-5">
        {t("allocation:worksheet.reviewDisclaimer")}
      </p>
    </div>
  );
}
