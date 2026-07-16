import {
  HOLDINGS_MODE_MAX_DRAWDOWN_INFO,
  HOLDINGS_MODE_VOLATILITY_INFO,
  IRR_RETURN_INFO,
  MAX_DRAWDOWN_INFO,
  MetricDisplay,
  TIME_WEIGHTED_RETURN_INFO,
  VALUE_RETURN_INFO,
  VOLATILITY_INFO,
} from "@/components/metric-display";
import { Card, CardContent } from "@wealthfolio/ui/components/ui/card";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import { Icons } from "@wealthfolio/ui";
import { Alert, AlertDescription } from "@wealthfolio/ui/components/ui/alert";
import { PerformanceResult } from "@/lib/types";
import {
  performancePeriodPnl,
  performanceSummaryReturn,
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
}

export const PerformanceGrid: React.FC<PerformanceGridProps> = ({
  performance,
  isLoading,
  performanceError,
  className,
  isHoldingsMode = false,
}) => {
  const { t } = useTranslation();
  if (performanceError) {
    return (
      <div className={cn("w-full", className)}>
        <Alert
          variant="warning"
          className="flex flex-col items-center gap-2 text-center [&>svg+div]:translate-y-0 [&>svg]:static [&>svg~*]:pl-0"
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

  const twrValue = performance.returns.twr ?? undefined;
  const twrAnnualized = performance.returns.annualizedTwr ?? undefined;
  const irrValue = performance.returns.irr ?? undefined;
  const irrAnnualized = performance.returns.annualizedIrr ?? undefined;
  const shouldDisplayAnnualized = shouldDisplayAnnualizedPerformanceReturn(performance);
  const showAnnualizedTwr = shouldDisplayAnnualized && twrAnnualized !== undefined;
  const showAnnualizedIrr = shouldDisplayAnnualized && irrAnnualized !== undefined;
  const twrDisplayValue = showAnnualizedTwr ? twrAnnualized : twrValue;
  const irrDisplayValue = showAnnualizedIrr ? irrAnnualized : irrValue;
  const twrInfoText = showAnnualizedTwr
    ? `${TIME_WEIGHTED_RETURN_INFO}${t("account:metric.twr_hover_hint")}`
    : TIME_WEIGHTED_RETURN_INFO;
  const irrInfoText = showAnnualizedIrr
    ? `${IRR_RETURN_INFO}${t("account:metric.irr_hover_hint")}`
    : IRR_RETURN_INFO;
  const holdingsValueReturn = performanceSummaryReturn(performance) ?? undefined;
  const periodPnl = performancePeriodPnl(performance) ?? undefined;
  const volatility = performance.risk.volatility ?? undefined;
  const maxDrawdown = performance.risk.maxDrawdown ?? undefined;
  const unavailableReason = performance.dataQuality.notApplicableReasons?.[0];

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
                label={t("account:metric.value_return")}
                value={holdingsValueReturn}
                emptyReason={unavailableReason}
                infoText={VALUE_RETURN_INFO}
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
                infoText={HOLDINGS_MODE_VOLATILITY_INFO}
                isPercentage={true}
                tone="neutral"
                className="border-muted/30 bg-muted/30 min-h-16 rounded-md border p-2.5"
              />
              <MetricDisplay
                label={t("account:max_drawdown")}
                value={maxDrawdown}
                emptyReason={unavailableReason}
                infoText={HOLDINGS_MODE_MAX_DRAWDOWN_INFO}
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
              emptyReason={unavailableReason}
              infoText={twrInfoText}
              isPercentage={true}
              className="border-muted/30 bg-muted/30 min-h-16 rounded-md border p-2.5"
            />
            <MetricDisplay
              label={
                showAnnualizedIrr ? t("account:metric.annualized_irr") : t("account:metric.irr")
              }
              value={irrDisplayValue}
              secondaryValue={showAnnualizedIrr ? irrValue : undefined}
              secondaryValueLabel={showAnnualizedIrr ? t("account:metric.period_irr") : undefined}
              emptyReason={unavailableReason}
              infoText={irrInfoText}
              isPercentage={true}
              className="border-muted/30 bg-muted/30 min-h-16 rounded-md border p-2.5"
            />
            <MetricDisplay
              label={t("account:volatility")}
              value={volatility}
              emptyReason={unavailableReason}
              infoText={VOLATILITY_INFO}
              isPercentage={true}
              tone="neutral"
              className="border-muted/30 bg-muted/30 min-h-16 rounded-md border p-2.5"
            />
            <MetricDisplay
              label={t("account:max_drawdown")}
              value={maxDrawdown}
              emptyReason={unavailableReason}
              infoText={MAX_DRAWDOWN_INFO}
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
