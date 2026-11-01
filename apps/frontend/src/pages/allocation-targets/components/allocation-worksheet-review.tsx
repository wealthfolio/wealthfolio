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
import { useTranslation } from "react-i18next";

import type {
  AllocationWorksheetLineResult,
  AllocationWorksheetResult,
  WorksheetWarning,
} from "@/lib/types";
import { cn } from "@/lib/utils";

import { AddDepositButton } from "./allocation-worksheet-account-allocation";
import { displayUnits } from "./allocation-worksheet-amounts";
import {
  formatDecimalInput,
  formatSignedAmount,
  isShortOfFunding,
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
  /** What each account takes as a deposit not recorded yet. */
  depositsByAccount: Readonly<Record<string, number>>;
  /** Covers an account's shortfall with a deposit, when the user asks. */
  onAddDeposit: (accountId: string, amount: number) => void;
  currency: string;
  onOpenRow: (assetId: string) => void;
  /** A warning in the user's language and number format. */
  describeWarning: (warning: WorksheetWarning) => string;
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
  depositsByAccount,
  onAddDeposit,
  currency,
  onOpenRow,
  describeWarning,
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
      describeWarning(warning),
    ]);
  }
  const fundingByAccount = new Map(
    (result?.accountFunding ?? []).map((funding) => [funding.accountId, funding]),
  );
  const groups = new Map<string, AllocationWorksheetLineResult[]>();
  for (const line of result?.lines ?? []) {
    if (!line.accountId) continue;
    groups.set(line.accountId, [...(groups.get(line.accountId) ?? []), line]);
  }

  const held = (heldLines.length > 0 || worksheetIssue) && (
    <div className="border-warning-subtle-border bg-warning-subtle border-b px-4 py-4 sm:px-5">
      <p className="text-warning-subtle-foreground text-xs font-medium">
        {t("allocation:worksheet.heldTitle")}
      </p>
      {worksheetIssue && (
        <p className="text-warning-subtle-foreground/80 mt-1 text-xs leading-relaxed">
          {worksheetIssue}
        </p>
      )}
      {heldLines.length > 0 && (
        <ul className="divide-warning-subtle-border mt-2 divide-y">
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
            <span className="bg-muted text-muted-foreground text-2xs rounded-full px-2 py-0.5 font-mono">
              {t("allocation:worksheet.lineCount", { count: result.lines.length })}
            </span>
            {isStale && (
              <span className="bg-warning-subtle text-warning-subtle-foreground text-2xs rounded-full px-2 py-0.5 font-mono">
                {isCalculating
                  ? t("allocation:worksheet.updatingPreview")
                  : t("allocation:worksheet.previewOutOfDate")}
              </span>
            )}
          </div>
          <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
            {isStale ? t("allocation:worksheet.reviewStale") : t("allocation:worksheet.reviewHint")}
          </p>
          <p className="text-muted-foreground mt-1 text-xs tabular-nums" data-total-adjusted>
            {t("allocation:worksheet.totalAdjusted", {
              amount: formatAmount(result.increaseTotal + result.reductionTotal, currency),
            })}
          </p>
        </div>
      </div>

      {held}

      <div className={cn("transition-opacity", isStale && "pointer-events-none opacity-50")}>
        {[...groups].map(([accountId, lines]) => {
          const funding = fundingByAccount.get(accountId);
          const net = lines.reduce((sum, line) => sum + signedLineAmount(line), 0);
          const isShort = funding !== undefined && isShortOfFunding(funding.remaining);
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
                      <p className="text-end font-mono text-xs tabular-nums">
                        {formatSignedAmount(signedLineAmount(line), currency, formatAmount)}
                      </p>
                      <TooltipProvider delay={150}>
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <button
                                type="button"
                                className="text-muted-foreground border-muted-foreground/40 text-2xs w-fit cursor-help border-b border-dotted font-mono tabular-nums sm:justify-self-end"
                              />
                            }
                          >
                            {/* Rounded as Adjust positions shows it; the tooltip
                                says where the price comes from. */}
                            {t("allocation:worksheet.accountUnitsSummary", {
                              quantity: formatQuantity(displayUnits(Math.abs(line.quantity))),
                            })}
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
                        className="text-2xs text-warning-subtle-foreground truncate text-end"
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
                <p className="border-foreground border-t-[1.5px] pt-2 text-end font-mono text-xs font-semibold tabular-nums">
                  {formatSignedAmount(net, currency, formatAmount)}
                </p>
                <span className="hidden sm:block" />
                {funding && (
                  <p
                    className={cn(
                      "col-span-2 mt-1.5 justify-self-end text-end font-mono text-xs font-semibold tabular-nums sm:col-span-1",
                      isShort
                        ? "bg-warning-subtle text-warning-subtle-foreground rounded px-1.5 py-0.5"
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
                {/* The deposit the account's figures count on, said with them, and
                    a shortfall's way out: a deposit the user adds. */}
                {((depositsByAccount[accountId] ?? 0) > 0 || (funding && isShort)) && (
                  <p className="text-muted-foreground text-2xs col-span-full flex flex-wrap justify-end gap-x-3 text-end">
                    {(depositsByAccount[accountId] ?? 0) > 0 && (
                      <span>
                        {t("allocation:worksheet.depositIncluded", {
                          amount: formatAmount(depositsByAccount[accountId] ?? 0, currency),
                        })}
                      </span>
                    )}
                    {funding && isShort && (
                      <AddDepositButton
                        amount={-funding.remaining}
                        account={accountNames.get(accountId) ?? ""}
                        currency={currency}
                        onAdd={(amount) => onAddDeposit(accountId, amount)}
                      />
                    )}
                  </p>
                )}
              </div>
            </section>
          );
        })}
      </div>

      <p className="text-muted-foreground border-t px-4 py-3 text-xs leading-relaxed sm:px-5">
        {t("allocation:worksheet.reviewDisclaimer")}
      </p>
    </div>
  );
}
