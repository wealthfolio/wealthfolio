import { useReturnMethod } from "@/hooks/use-return-method";
import {
  performanceViewReturn,
  presentedReturn,
  type ChosenReturnView,
  type PresentedReturn,
} from "@/lib/performance";
import type { PerformanceResult, PerformanceReturnViewKey } from "@/lib/types";
import { cn } from "@/lib/utils";
import { AnimatedToggleGroup, GainPercent, useNumberFormatting } from "@wealthfolio/ui";
import { Popover, PopoverContent, PopoverTrigger } from "@wealthfolio/ui/components/ui/popover";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

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
  HOLDINGS_TWR_NOT_APPLICABLE: "performance:return_view.reason.holdings_full_history",
  HOLDINGS_MONEY_WEIGHTED_NOT_APPLICABLE: "performance:return_view.reason.holdings_full_history",
  RETURN_ON_COST_NOT_APPLICABLE: "performance:return_view.reason.roi_holdings_only",
  MONEY_WEIGHTED_UNKNOWN_FLOW: "performance:return_view.reason.unknown_flow",
  TWR_UNKNOWN_FLOW: "performance:return_view.reason.unknown_flow",
  MONEY_WEIGHTED_NO_CAPITAL: "performance:return_view.reason.no_capital",
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
      <ReturnMethodToggle size="compact" className="w-full" />
    </>
  );
}
