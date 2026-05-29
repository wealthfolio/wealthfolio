import {
  HOLDINGS_MODE_MAX_DRAWDOWN_INFO,
  HOLDINGS_MODE_VOLATILITY_INFO,
  MAX_DRAWDOWN_INFO,
  MetricDisplay,
  MODIFIED_DIETZ_RETURN_INFO,
  TIME_WEIGHTED_RETURN_INFO,
  VOLATILITY_INFO,
} from "@/components/metric-display";
import { Card, CardContent } from "@wealthfolio/ui/components/ui/card";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import { Icons } from "@wealthfolio/ui";
import { Alert, AlertDescription } from "@wealthfolio/ui/components/ui/alert";
import { PerformanceMetrics } from "@/lib/types";
import { cn } from "@/lib/utils";
import React from "react";

export interface PerformanceGridProps {
  performance?: PerformanceMetrics | null;
  isLoading?: boolean;
  performanceError?: string;
  className?: string;
  /** If true, shows only Volatility/MaxDrawdown and hides flow-adjusted returns. */
  isHoldingsMode?: boolean;
}

export const PerformanceGrid: React.FC<PerformanceGridProps> = ({
  performance,
  isLoading,
  performanceError,
  className,
  isHoldingsMode = false,
}) => {
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
            <div className="grid grid-cols-2 gap-5">
              {[...Array(4)].map((_, index) => (
                <div
                  key={index}
                  className="border-muted/30 bg-muted/30 flex min-h-24 flex-col items-center justify-center space-y-2 rounded-md border p-4 md:p-6"
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

  // Destructure performance metrics, providing default 0 for potentially missing values
  // Note: Use nullish coalescing since destructuring defaults only apply to undefined, not null
  const {
    cumulativeTwr,
    annualizedTwr,
    cumulativeModifiedDietz,
    annualizedModifiedDietz,
    cumulativeMwr,
    annualizedMwr,
    volatility = 0,
    maxDrawdown = 0,
  } = performance;

  // Convert null to undefined for optional props that may be null from the API
  const twrValue = cumulativeTwr ?? undefined;
  const twrAnnualized = annualizedTwr ?? undefined;
  const modifiedDietzValue = cumulativeModifiedDietz ?? cumulativeMwr ?? undefined;
  const modifiedDietzAnnualized = annualizedModifiedDietz ?? annualizedMwr ?? undefined;

  // For HOLDINGS mode accounts:
  // - TWR/Modified Dietz are NOT available (require cash flow tracking)
  // - Volatility and Max Drawdown ARE available (computed from equity curve)
  if (isHoldingsMode) {
    return (
      <div className={cn("w-full", className)}>
        <Card className="border-none p-0 shadow-none">
          <CardContent className="p-0">
            <div className="grid grid-cols-2 gap-5">
              <MetricDisplay
                label="Volatility"
                value={volatility}
                infoText={HOLDINGS_MODE_VOLATILITY_INFO}
                isPercentage={false}
                className="border-muted/30 bg-muted/30 rounded-md border"
              />
              <MetricDisplay
                label="Max Drawdown"
                value={maxDrawdown * -1}
                infoText={HOLDINGS_MODE_MAX_DRAWDOWN_INFO}
                isPercentage={true}
                className="border-muted/30 bg-muted/30 rounded-md border"
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
          <div className="grid grid-cols-2 gap-5">
            <MetricDisplay
              label="Time Weighted Return"
              value={twrValue}
              annualizedValue={twrAnnualized}
              infoText={TIME_WEIGHTED_RETURN_INFO}
              isPercentage={true}
              className="border-muted/30 bg-muted/30 rounded-md border"
            />
            <MetricDisplay
              label="Modified Dietz"
              value={modifiedDietzValue}
              annualizedValue={modifiedDietzAnnualized}
              infoText={MODIFIED_DIETZ_RETURN_INFO}
              isPercentage={true}
              className="border-muted/30 bg-muted/30 rounded-md border"
            />
            <MetricDisplay
              label="Volatility"
              value={volatility}
              infoText={VOLATILITY_INFO}
              isPercentage={false}
              className="border-muted/30 bg-muted/30 rounded-md border"
            />
            <MetricDisplay
              label="Max Drawdown"
              value={maxDrawdown * -1}
              infoText={MAX_DRAWDOWN_INFO}
              isPercentage={true}
              className="border-muted/30 bg-muted/30 rounded-md border"
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

// Default export for easy import
export default PerformanceGrid;
