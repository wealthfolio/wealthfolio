import { useAccounts } from "@/hooks/use-accounts";
import { useReturnMethod } from "@/hooks/use-return-method";
import {
  performanceViewReturn,
  presentedReturn,
  type ChosenReturnView,
  type PresentedReturn,
} from "@/lib/performance";
import type {
  PerformanceAmounts,
  PerformanceResult,
  PerformanceReturnViewKey,
  PerformanceUnclassifiedTransfer,
} from "@/lib/types";
import { cn, formatDate } from "@/lib/utils";
import {
  AnimatedToggleGroup,
  GainAmount,
  GainPercent,
  PrivacyAmount,
  useDateFormatting,
  useNumberFormatting,
} from "@wealthfolio/ui";
import { Popover, PopoverContent, PopoverTrigger } from "@wealthfolio/ui/components/ui/popover";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

const VIEW_NAME_KEYS: Record<PerformanceReturnViewKey, string> = {
  twr: "performance:return_view.twr",
  moneyWeighted: "performance:return_view.money_weighted",
  returnOnCost: "performance:return_view.return_on_cost",
};

const VIEW_SHORT_NAME_KEYS: Record<PerformanceReturnViewKey, string> = {
  twr: "performance:return_view.twr_short",
  moneyWeighted: "performance:return_view.money_weighted_short",
  returnOnCost: "performance:return_view.return_on_cost_short",
};

const VIEW_EXPLAINER_KEYS: Record<PerformanceReturnViewKey, string> = {
  twr: "performance:return_view.twr_explainer",
  moneyWeighted: "performance:return_view.money_weighted_explainer",
  returnOnCost: "performance:return_view.return_on_cost_explainer",
};

/** Engine reason codes a person can meet, in plain words; others stay unshown. */
const REASON_KEYS: Record<string, string> = {
  MIXED_TWR_NOT_APPLICABLE: "performance:return_view.reason.mixed_twr",
  MIXED_MONEY_WEIGHTED_NOT_APPLICABLE: "performance:return_view.reason.mixed_twr",
  HOLDINGS_TWR_NOT_APPLICABLE: "performance:return_view.reason.holdings_full_history",
  HOLDINGS_MONEY_WEIGHTED_NOT_APPLICABLE: "performance:return_view.reason.holdings_money_weighted",
  RETURN_ON_COST_NOT_APPLICABLE: "performance:return_view.reason.roi_holdings_only",
  MONEY_WEIGHTED_UNKNOWN_FLOW: "performance:return_view.reason.unknown_flow",
  TWR_UNKNOWN_FLOW: "performance:return_view.reason.unknown_flow",
  MONEY_WEIGHTED_NO_CAPITAL: "performance:return_view.reason.no_capital",
  MONEY_WEIGHTED_NO_SOLUTION: "performance:return_view.reason.no_solution",
  MIXED_NON_POSITIVE_DENOMINATORS: "performance:return_view.reason.no_capital",
  COVERAGE_UNAVAILABLE: "performance:return_view.reason.coverage",
  TWO_VALUATION_POINTS_REQUIRED: "performance:return_view.reason.not_enough_history",
  TWR_NO_CHAIN: "performance:return_view.reason.not_enough_history",
  MIXED_COVERAGE_DIFFERS: "performance:return_view.reason.mixed_coverage",
};

/** Why a view is unavailable, in the person's language; null for reasons without one. */
export function returnReasonText(
  result: PerformanceResult | null | undefined,
  view: PerformanceReturnViewKey,
  t: TFunction,
): string | null {
  const code = result?.returns?.[view]?.unavailableReasonCode;
  const key = code ? REASON_KEYS[code] : undefined;
  return key ? t(key) : null;
}

export function returnViewName(view: PerformanceReturnViewKey, t: TFunction): string {
  return t(VIEW_NAME_KEYS[view]);
}

/** A label short enough to sit beside a figure: TWR, MWR, on cost. */
export function returnViewShortName(view: PerformanceReturnViewKey, t: TFunction): string {
  return t(VIEW_SHORT_NAME_KEYS[view]);
}

export function returnViewExplainer(view: PerformanceReturnViewKey, t: TFunction): string {
  return t(VIEW_EXPLAINER_KEYS[view]);
}

/** The two-option control that sets the return method shown across the app. */
export function ReturnMethodToggle({
  className,
  size,
}: {
  className?: string;
  size?: "default" | "compact";
}) {
  const { t } = useTranslation();
  const { returnView, setReturnView } = useReturnMethod();
  return (
    <AnimatedToggleGroup<ChosenReturnView>
      items={[
        { value: "twr", label: returnViewName("twr", t) },
        { value: "moneyWeighted", label: returnViewName("moneyWeighted", t) },
      ]}
      value={returnView}
      onValueChange={setReturnView}
      size={size}
      className={className}
      aria-label={t("performance:return_view.method_label")}
    />
  );
}

interface ReturnPercentProps {
  result: PerformanceResult | null | undefined;
  className?: string;
  variant?: "text" | "badge";
  animated?: boolean;
  /** Classes for the "Not available" text shown when no return can be shown. */
  unavailableClassName?: string;
}

/**
 * A return in the method the person chose. The figure opens a popover that
 * names the method, explains it in one line, shows both methods side by side
 * and lets the person switch.
 */
export function ReturnPercent({
  result,
  className,
  variant = "text",
  animated = false,
  unavailableClassName,
}: ReturnPercentProps) {
  const { t } = useTranslation();
  const { formatPercent } = useNumberFormatting();
  const { returnView } = useReturnMethod();
  const presented = presentedReturn(result, returnView);
  const shownView = presented?.view ?? returnView;
  const valueText = presented
    ? formatPercent(presented.value, { signDisplay: "exceptZero" })
    : t("performance:not_available");

  return (
    <Popover>
      <PopoverTrigger
        // A dotted underline says the figure opens more; the name carries the value.
        className="focus-visible:ring-ring decoration-muted-foreground/50 inline-flex items-center rounded-md underline decoration-dotted underline-offset-4 focus-visible:ring-2 focus-visible:outline-none"
        aria-label={t("performance:return_view.trigger_label", {
          method: returnViewName(shownView, t),
          value: valueText,
        })}
      >
        {presented ? (
          <>
            <GainPercent
              className={className}
              value={presented.value}
              variant={variant}
              animated={animated}
            />
            {/* Only a stand-in is labelled: the chosen method needs no reminder. */}
            {presented.isFallback && (
              <span className="text-muted-foreground ms-1.5 text-xs">
                {returnViewShortName(presented.view, t)}
              </span>
            )}
          </>
        ) : (
          <span className={cn("text-muted-foreground", unavailableClassName)}>
            {t("performance:not_available")}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 space-y-3 p-4 text-sm">
        <ReturnPopoverBody result={result} presented={presented} chosen={returnView} />
      </PopoverContent>
    </Popover>
  );
}

function ReturnPopoverBody({
  result,
  presented,
  chosen,
}: {
  result: PerformanceResult | null | undefined;
  presented: PresentedReturn | null;
  chosen: ChosenReturnView;
}) {
  const { t } = useTranslation();
  const shownView = presented?.view ?? chosen;
  const unavailableReason = returnReasonText(result, chosen, t);
  const rows: PerformanceReturnViewKey[] = ["twr", "moneyWeighted"];
  if (performanceViewReturn(result, "returnOnCost") != null) rows.push("returnOnCost");

  return (
    <>
      <div className="space-y-1">
        <p className="font-medium">{returnViewName(shownView, t)}</p>
        <p className="text-muted-foreground">{returnViewExplainer(shownView, t)}</p>
      </div>
      {(presented?.isFallback || !presented) && (
        <p className="text-muted-foreground">
          {t("performance:return_view.chosen_unavailable", {
            method: returnViewName(chosen, t),
          })}
          {unavailableReason ? ` ${unavailableReason}` : ""}
        </p>
      )}
      {result?.unclassifiedTransfers?.length ? (
        <UnclassifiedTransfers transfers={result.unclassifiedTransfers} />
      ) : null}
      <dl className="space-y-1">
        {rows.map((view) => {
          const value = performanceViewReturn(result, view);
          return (
            <div key={view} className="flex items-center justify-between gap-3">
              <dt>{returnViewName(view, t)}</dt>
              <dd>
                {value == null ? (
                  <span className="text-muted-foreground">{t("performance:not_available")}</span>
                ) : (
                  <GainPercent value={value} />
                )}
              </dd>
            </div>
          );
        })}
      </dl>
      {result && <ReturnAmounts result={result} />}
      <ReturnMethodToggle size="compact" className="w-full [&>button]:flex-1" />
    </>
  );
}

/** Transfers shown before pointing to Health for the rest. */
const SHOWN_TRANSFERS = 3;

/**
 * The transfers that withhold the period's return: each one's date, account
 * and amount, and where to settle them.
 */
function UnclassifiedTransfers({ transfers }: { transfers: PerformanceUnclassifiedTransfer[] }) {
  const { t } = useTranslation();
  const dateFormatting = useDateFormatting();
  const { formatDecimal } = useNumberFormatting();
  const { accounts } = useAccounts({ filterActive: false, includeArchived: true });
  const accountName = (id: string) => accounts.find((account) => account.id === id)?.name;
  const hidden = transfers.length - SHOWN_TRANSFERS;

  return (
    <div className="space-y-1.5">
      <p className="text-muted-foreground">
        {t("performance:return_view.unclassified_transfers.intro")}
      </p>
      <ul className="space-y-1">
        {transfers.slice(0, SHOWN_TRANSFERS).map((transfer) => (
          <li key={transfer.activityId} className="flex items-baseline justify-between gap-3">
            <span className="min-w-0">
              <span className="block">{formatDate(transfer.date, dateFormatting)}</span>
              <span className="text-muted-foreground block truncate text-xs">
                {accountName(transfer.accountId)}
              </span>
            </span>
            {transfer.amount != null && (
              <PrivacyAmount
                className="shrink-0 tabular-nums"
                value={transfer.outflow ? -transfer.amount : transfer.amount}
                currency={transfer.currency}
              />
            )}
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <p className="text-muted-foreground text-xs">
          {formatDecimal(hidden, { signDisplay: "always", maximumFractionDigits: 0 })}
        </p>
      )}
      <Link to="/health" className="text-xs underline underline-offset-4">
        {t("common:notifications.review_the_details_in_the_health_center")}
      </Link>
    </div>
  );
}

const AMOUNT_ROWS: {
  field: Exclude<keyof PerformanceAmounts, "startDate" | "flows" | "parts">;
  label: string;
}[] = [
  { field: "startValue", label: "performance:return_view.amounts.start_value" },
  { field: "moneyIn", label: "performance:return_view.amounts.money_in" },
  { field: "moneyOut", label: "performance:return_view.amounts.money_out" },
  { field: "capital", label: "performance:return_view.amounts.capital" },
  { field: "gain", label: "performance:return_view.amounts.gain" },
  { field: "endValue", label: "performance:return_view.amounts.end_value" },
];

const PART_LABELS = {
  TRANSACTIONS: "performance:return_view.amounts.part_transactions",
  HOLDINGS: "performance:return_view.amounts.part_holdings",
} as const;

/**
 * The dates the figure covers and the amounts it is built from. A mixed
 * portfolio also shows its two halves, whose gains and capital add up to
 * its ROI.
 */
function ReturnAmounts({ result }: { result: PerformanceResult }) {
  const { t } = useTranslation();
  const dateFormatting = useDateFormatting();
  const { amounts, period } = result;
  const currency = result.scope.currency;
  const flowsMissing = amounts?.flows === "missing";
  const rows = AMOUNT_ROWS.filter(
    ({ field }) =>
      amounts?.[field] != null || (flowsMissing && (field === "moneyIn" || field === "moneyOut")),
  );
  // The amounts open later than the period for an account that earned
  // income before any money was put in.
  const startDate = amounts?.startDate ?? period.startDate;
  const hasPeriod = Boolean(startDate && period.endDate);
  if (!hasPeriod && rows.length === 0) return null;
  const estimated =
    amounts?.flows === "inferred" && (amounts.moneyIn != null || amounts.moneyOut != null);

  return (
    <div className="space-y-1 border-t pt-3 text-xs">
      {hasPeriod && (
        <p className="text-muted-foreground">
          {t("account:from_to", {
            start: formatDate(startDate, dateFormatting),
            end: formatDate(period.endDate, dateFormatting),
          })}
        </p>
      )}
      {rows.length > 0 && (
        <dl className="space-y-1">
          {rows.map(({ field, label }) => {
            const value = amounts?.[field];
            return (
              <div key={field} className="flex items-center justify-between gap-3">
                <dt className="text-muted-foreground">{t(label)}</dt>
                <dd className="tabular-nums">
                  {value == null ? (
                    <span className="text-muted-foreground">
                      {t("performance:return_view.amounts.unknown")}
                    </span>
                  ) : field === "gain" ? (
                    <GainAmount value={value} currency={currency} />
                  ) : (
                    <PrivacyAmount value={value} currency={currency} />
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      )}
      {estimated && (
        <p className="text-muted-foreground">{t("performance:return_view.amounts.estimated")}</p>
      )}
      {amounts?.parts?.length ? (
        <table className="mt-2 w-full">
          <thead>
            <tr className="text-muted-foreground align-bottom">
              <th className="text-start font-normal">
                {t("performance:return_view.amounts.by_tracking")}
              </th>
              <th className="ps-3 text-end font-normal">
                {t("performance:return_view.amounts.gain")}
              </th>
              <th className="ps-3 text-end font-normal">
                {t("performance:return_view.amounts.capital")}
              </th>
            </tr>
          </thead>
          <tbody>
            {amounts.parts.map((part) => (
              <tr key={part.tracking}>
                <th className="text-start font-normal">{t(PART_LABELS[part.tracking])}</th>
                <td className="ps-3 text-end tabular-nums">
                  <GainAmount value={part.gain} currency={currency} />
                </td>
                <td className="ps-3 text-end tabular-nums">
                  <PrivacyAmount value={part.capital} currency={currency} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}
