import {
  HOLDINGS_MODE_MAX_DRAWDOWN_INFO_KEY,
  HOLDINGS_MODE_VOLATILITY_INFO_KEY,
  MAX_DRAWDOWN_INFO_KEY,
  MetricDisplay,
  MONEY_WEIGHTED_RETURN_INFO_KEY,
  RETURN_ON_COST_INFO_KEY,
  TIME_WEIGHTED_RETURN_INFO_KEY,
  VOLATILITY_INFO_KEY,
} from "@/components/metric-display";
import { Card, CardContent } from "@wealthfolio/ui/components/ui/card";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import { Icons } from "@wealthfolio/ui";
import { Alert, AlertDescription } from "@wealthfolio/ui/components/ui/alert";
import type { PerformanceResult, PerformanceReturnViewKey } from "@/lib/types";
import {
  type ChosenReturnView,
  performancePeriodPnl,
  performanceViewAnnualized,
  performanceViewReason,
  performanceViewReturn,
  shouldDisplayAnnualizedPerformanceReturn,
} from "@/lib/performance";
import { cn } from "@/lib/utils";
import React from "react";
import { useTranslation } from "react-i18next";

export interface PerformanceGridProps {
  performance?: PerformanceResult | null;
  isLoading?: boolean;
  performanceError?: string;
  className?: string;
  /** If true, shows holdings-mode return cards instead of transaction return cards. */
  isHoldingsMode?: boolean;
  /** The full history is selected: a holdings account reports ROI, else its TWR. */
  isAllTime?: boolean;
  /** The return method the person chose. */
  returnView?: ChosenReturnView;
}

export const PerformanceGrid: React.FC<PerformanceGridProps> = ({
  performance,
  isLoading,
  performanceError,
  className,
  isHoldingsMode = false,
  isAllTime = false,
  returnView = "twr",
}) => {
  const { t } = useTranslation();
  if (performanceError) {
    return (
      <div className={cn("w-full", className)}>
        <Alert
          variant="warning"
          className="flex flex-col items-center gap-2 text-center [&>svg]:static [&>svg+div]:translate-y-0 [&>svg~*]:ps-0"
        >
          <Icons.AlertTriangle className="size-5" />
          <AlertDescription className="text-xs">{performanceError}</AlertDescription>
        </Alert>
      </div>
    );
  }

  if (isLoading || !performance) {
    return (
      <div className={cn("w-full", className)}>
        <Card className="border-none p-0 shadow-none">
          <CardContent className="p-0">
            <div className="grid grid-cols-2 gap-3">
              {Array.from({ length: 4 }, (_, index) => (
                <div
                  key={index}
                  className="border-muted/30 bg-muted/30 flex min-h-16 flex-col items-center justify-center space-y-1 rounded-md border p-2.5"
                >
                  <Skeleton className="h-3 w-32" />
                  <Skeleton className="h-5 w-16" />
                  <Skeleton className="h-3 w-20" />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const twrValue = performanceViewReturn(performance, "twr") ?? undefined;
  const twrAnnualized = performanceViewAnnualized(performance, "twr") ?? undefined;
  const mwrValue = performanceViewReturn(performance, "moneyWeighted") ?? undefined;
  const mwrAnnualized = performanceViewAnnualized(performance, "moneyWeighted") ?? undefined;
  const shouldDisplayAnnualized = shouldDisplayAnnualizedPerformanceReturn(performance);
  const showAnnualizedTwr = shouldDisplayAnnualized && twrAnnualized !== undefined;
  const showAnnualizedMwr = shouldDisplayAnnualized && mwrAnnualized !== undefined;
  const twrDisplayValue = showAnnualizedTwr ? twrAnnualized : twrValue;
  const mwrDisplayValue = showAnnualizedMwr ? mwrAnnualized : mwrValue;
  const twrInfoText = showAnnualizedTwr
    ? `${t(TIME_WEIGHTED_RETURN_INFO_KEY)}${t("account:metric.twr_hover_hint")}`
    : t(TIME_WEIGHTED_RETURN_INFO_KEY);
  const mwrInfoText = showAnnualizedMwr
    ? `${t(MONEY_WEIGHTED_RETURN_INFO_KEY)}${t("account:metric.mwr_hover_hint")}`
    : t(MONEY_WEIGHTED_RETURN_INFO_KEY);
  // Holdings accounts report ROI over their full history; for a dated period
  // the chosen method, or the other one when the chosen one is unavailable.
  const otherView: ChosenReturnView = returnView === "twr" ? "moneyWeighted" : "twr";
  const holdingsView: PerformanceReturnViewKey = isAllTime
    ? "returnOnCost"
    : performanceViewReturn(performance, returnView) == null &&
        performanceViewReturn(performance, otherView) != null
      ? otherView
      : returnView;
  const holdingsReturn = performanceViewReturn(performance, holdingsView) ?? undefined;
  const periodPnl = performancePeriodPnl(performance) ?? undefined;
  const volatility = performance.risk.volatility ?? undefined;
  const maxDrawdown = performance.risk.maxDrawdown ?? undefined;
  const unavailableReason = performance.dataQuality.notApplicableReasons?.[0];
  const twrReason = performanceViewReason(performance, "twr") ?? unavailableReason;
  const mwrReason = performanceViewReason(performance, "moneyWeighted") ?? unavailableReason;
  const holdingsReason = performanceViewReason(performance, holdingsView) ?? unavailableReason;

  // For HOLDINGS mode accounts:
  // - TWR/IRR are NOT available (require cash flow tracking)
  // - Volatility and Max Drawdown ARE available (computed from equity curve)
  if (isHoldingsMode) {
    return (
      <div className={cn("w-full", className)}>
        <Card className="border-none p-0 shadow-none">
          <CardContent className="p-0">
            <div className="grid grid-cols-2 gap-3">
              <MetricDisplay
                label={
                  holdingsView === "returnOnCost"
                    ? t("account:metric.return_on_cost")
                    : holdingsView === "moneyWeighted"
                      ? t("account:metric.mwr")
                      : t("account:time_weighted_return")
                }
                value={holdingsReturn}
                emptyReason={holdingsReason}
                infoText={t(
                  holdingsView === "returnOnCost"
                    ? RETURN_ON_COST_INFO_KEY
                    : holdingsView === "moneyWeighted"
                      ? MONEY_WEIGHTED_RETURN_INFO_KEY
                      : TIME_WEIGHTED_RETURN_INFO_KEY,
                )}
                isPercentage={true}
                className="border-muted/30 bg-muted/30 min-h-16 rounded-md border p-2.5"
              />
              <MetricDisplay
                label={t("account:metric.total_pnl")}
                value={periodPnl}
                emptyReason={unavailableReason}
                infoText={t("account:metric.total_pnl_info")}
                isPercentage={false}
                currency={performance.scope.currency}
                className="border-muted/30 bg-muted/30 min-h-16 rounded-md border p-2.5"
              />
              <MetricDisplay
                label={t("account:volatility")}
                value={volatility}
                emptyReason={unavailableReason}
                infoText={t(HOLDINGS_MODE_VOLATILITY_INFO_KEY)}
                isPercentage={true}
                tone="neutral"
                className="border-muted/30 bg-muted/30 min-h-16 rounded-md border p-2.5"
              />
              <MetricDisplay
                label={t("account:max_drawdown")}
                value={maxDrawdown}
                emptyReason={unavailableReason}
                infoText={t(HOLDINGS_MODE_MAX_DRAWDOWN_INFO_KEY)}
                isPercentage={true}
                className="border-muted/30 bg-muted/30 min-h-16 rounded-md border p-2.5"
              />
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className={cn("w-full", className)}>
      <Card className="border-none p-0 shadow-none">
        <CardContent className="p-0">
          <div className="grid grid-cols-2 gap-3">
            <MetricDisplay
              label={
                showAnnualizedTwr
                  ? t("account:metric.annualized_twr")
                  : t("account:time_weighted_return")
              }
              value={twrDisplayValue}
              secondaryValue={showAnnualizedTwr ? twrValue : undefined}
              secondaryValueLabel={
                showAnnualizedTwr ? t("account:metric.cumulative_twr") : undefined
              }
              emptyReason={twrReason}
              infoText={twrInfoText}
              isPercentage={true}
              className="border-muted/30 bg-muted/30 min-h-16 rounded-md border p-2.5"
            />
            <MetricDisplay
              label={
                showAnnualizedMwr ? t("performance:metric.annualized_mwr") : t("account:metric.mwr")
              }
              value={mwrDisplayValue}
              secondaryValue={showAnnualizedMwr ? mwrValue : undefined}
              secondaryValueLabel={
                showAnnualizedMwr ? t("account:metric.cumulative_mwr") : undefined
              }
              emptyReason={mwrReason}
              infoText={mwrInfoText}
              isPercentage={true}
              className="border-muted/30 bg-muted/30 min-h-16 rounded-md border p-2.5"
            />
            <MetricDisplay
              label={t("account:volatility")}
              value={volatility}
              emptyReason={unavailableReason}
              infoText={t(VOLATILITY_INFO_KEY)}
              isPercentage={true}
              tone="neutral"
              className="border-muted/30 bg-muted/30 min-h-16 rounded-md border p-2.5"
            />
            <MetricDisplay
              label={t("account:max_drawdown")}
              value={maxDrawdown}
              emptyReason={unavailableReason}
              infoText={t(MAX_DRAWDOWN_INFO_KEY)}
              isPercentage={true}
              className="border-muted/30 bg-muted/30 min-h-16 rounded-md border p-2.5"
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

// Default export for easy import
export default PerformanceGrid;
