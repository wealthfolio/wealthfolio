import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { makeAssistantToolUI } from "@assistant-ui/react";
import { Badge, Card, CardContent, CardHeader, CardTitle, Skeleton } from "@wealthfolio/ui";
import { memo, useMemo } from "react";
import { cn } from "@/lib/utils";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { useSettingsContext } from "@/lib/settings-provider";
import { CompactToolCard } from "./shared";

// ============================================================================
// Types
// ============================================================================

interface GetPerformanceArgs {
  accountId?: string;
  startDate?: string;
  endDate?: string;
  displayMode?: "compact" | "full";
}

interface PerformanceResult {
  id: string;
  periodStartDate?: string | null;
  periodEndDate?: string | null;
  currency: string;
  cumulativeTwr?: number | null;
  periodReturn?: number | null;
  gainLossAmount?: number | null;
  annualizedTwr?: number | null;
  simpleReturn: number;
  annualizedSimpleReturn: number;
  cumulativeModifiedDietz?: number | null;
  annualizedModifiedDietz?: number | null;
  cumulativeMwr?: number | null;
  annualizedMwr?: number | null;
  volatility: number;
  maxDrawdown: number;
  returnMethod?: string;
  isMixedTrackingMode?: boolean;
  warnings?: string[];
}

// ============================================================================
// Normalizer
// ============================================================================

/**
 * Safely converts an unknown value to a string.
 * Returns the fallback if the value is null, undefined, or not a primitive.
 */
function safeString(value: unknown, fallback: string): string {
  if (value == null) return fallback;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

/**
 * Normalizes the result to handle both wrapped and unwrapped formats,
 * as well as snake_case vs camelCase field names from the backend.
 */
function normalizeResult(result: unknown, fallbackCurrency: string): PerformanceResult | null {
  if (!result) {
    return null;
  }

  if (typeof result === "string") {
    try {
      return normalizeResult(JSON.parse(result), fallbackCurrency);
    } catch {
      return null;
    }
  }

  if (typeof result !== "object" || result === null) {
    return null;
  }

  const candidate = result as Record<string, unknown>;

  // Handle wrapped format: { data: ..., meta: ... }
  if ("data" in candidate && typeof candidate.data === "object") {
    return normalizeResult(candidate.data, fallbackCurrency);
  }

  // Extract and normalize fields (handle both camelCase and snake_case)
  return {
    id: safeString(candidate.id ?? candidate.Id, ""),
    periodStartDate:
      (candidate.periodStartDate as string | undefined) ??
      (candidate.period_start_date as string | undefined) ??
      null,
    periodEndDate:
      (candidate.periodEndDate as string | undefined) ??
      (candidate.period_end_date as string | undefined) ??
      null,
    currency:
      (candidate.currency as string | undefined) ??
      (candidate.Currency as string | undefined) ??
      fallbackCurrency,
    cumulativeTwr:
      candidate.cumulativeTwr != null || candidate.cumulative_twr != null
        ? Number(candidate.cumulativeTwr ?? candidate.cumulative_twr)
        : null,
    periodReturn:
      candidate.periodReturn != null || candidate.period_return != null
        ? Number(candidate.periodReturn ?? candidate.period_return)
        : null,
    gainLossAmount:
      candidate.gainLossAmount != null || candidate.gain_loss_amount != null
        ? Number(candidate.gainLossAmount ?? candidate.gain_loss_amount)
        : null,
    annualizedTwr:
      candidate.annualizedTwr != null || candidate.annualized_twr != null
        ? Number(candidate.annualizedTwr ?? candidate.annualized_twr)
        : null,
    simpleReturn: Number(candidate.simpleReturn ?? candidate.simple_return ?? 0),
    annualizedSimpleReturn: Number(
      candidate.annualizedSimpleReturn ?? candidate.annualized_simple_return ?? 0,
    ),
    cumulativeModifiedDietz:
      candidate.cumulativeModifiedDietz != null ||
      candidate.cumulative_modified_dietz != null ||
      candidate.cumulativeMwr != null ||
      candidate.cumulative_mwr != null
        ? Number(
            candidate.cumulativeModifiedDietz ??
              candidate.cumulative_modified_dietz ??
              candidate.cumulativeMwr ??
              candidate.cumulative_mwr,
          )
        : null,
    annualizedModifiedDietz:
      candidate.annualizedModifiedDietz != null ||
      candidate.annualized_modified_dietz != null ||
      candidate.annualizedMwr != null ||
      candidate.annualized_mwr != null
        ? Number(
            candidate.annualizedModifiedDietz ??
              candidate.annualized_modified_dietz ??
              candidate.annualizedMwr ??
              candidate.annualized_mwr,
          )
        : null,
    cumulativeMwr:
      candidate.cumulativeMwr != null || candidate.cumulative_mwr != null
        ? Number(candidate.cumulativeMwr ?? candidate.cumulative_mwr)
        : null,
    annualizedMwr:
      candidate.annualizedMwr != null || candidate.annualized_mwr != null
        ? Number(candidate.annualizedMwr ?? candidate.annualized_mwr)
        : null,
    volatility: Number(candidate.volatility ?? candidate.Volatility ?? 0),
    maxDrawdown: Number(candidate.maxDrawdown ?? candidate.max_drawdown ?? 0),
    returnMethod:
      (candidate.returnMethod as string | undefined) ??
      (candidate.return_method as string | undefined),
    isMixedTrackingMode: Boolean(
      candidate.isMixedTrackingMode ?? candidate.is_mixed_tracking_mode ?? false,
    ),
    warnings: Array.isArray(candidate.warnings) ? (candidate.warnings as string[]) : [],
  };
}

// ============================================================================
// Components
// ============================================================================

function PerformanceLoadingSkeleton() {
  return (
    <Card className="bg-muted/40 border-primary/10">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-5 w-16" />
          </div>
          <Skeleton className="h-4 w-32" />
        </div>
      </CardHeader>
      <CardContent className="max-h-[320px] space-y-4">
        {/* Main return display skeleton */}
        <div className="flex items-baseline gap-3">
          <Skeleton className="h-10 w-28" />
          <Skeleton className="h-6 w-24" />
        </div>
        {/* Metrics grid skeleton */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="bg-background/60 flex flex-col gap-1 rounded-lg border p-3">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-5 w-20" />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// Empty state - don't render anything, let LLM explain
function EmptyState() {
  return null;
}

function ErrorState({ message }: { message?: string }) {
  return (
    <Card className="border-destructive/30 bg-destructive/5">
      <CardContent className="py-4">
        <p className="text-destructive text-sm font-medium">Failed to load performance data</p>
        {message && <p className="text-muted-foreground mt-1 text-xs">{message}</p>}
      </CardContent>
    </Card>
  );
}

interface MetricCardProps {
  label: string;
  value: string;
  subValue?: string;
  isPositive?: boolean | null;
  isPrivate?: boolean;
}

function MetricCard({ label, value, subValue, isPositive, isPrivate }: MetricCardProps) {
  const colorClass =
    isPositive === true
      ? "text-success"
      : isPositive === false
        ? "text-destructive"
        : "text-foreground";

  return (
    <div className="bg-background/60 flex flex-col gap-1 rounded-lg border p-3">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className={cn("text-sm font-semibold tabular-nums", isPrivate ? "" : colorClass)}>
        {value}
      </span>
      {subValue && <span className="text-muted-foreground text-xs tabular-nums">{subValue}</span>}
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

type PerformanceToolUIContentProps = ToolCallMessagePartProps<
  GetPerformanceArgs,
  PerformanceResult
>;

function PerformanceToolUIContentImpl({ args, result, status }: PerformanceToolUIContentProps) {
  const { settings } = useSettingsContext();
  const baseCurrency = settings?.baseCurrency ?? "USD";
  const { isBalanceHidden } = useBalancePrivacy();
  const parsed = useMemo(() => normalizeResult(result, baseCurrency), [baseCurrency, result]);

  const isLoading = status?.type === "running";
  const isIncomplete = status?.type === "incomplete";
  const isComplete = status?.type === "complete";

  // Compact mode — just show a one-liner when used as a prerequisite
  if (args?.displayMode === "compact" && parsed && !isLoading) {
    return <CompactToolCard label="Fetched performance metrics" />;
  }

  // Format values
  const { formatCurrency, formatPercent, formatPercentSigned } = useMemo(() => {
    const currency = parsed?.currency ?? baseCurrency;
    return {
      formatCurrency: (value: number) =>
        isBalanceHidden
          ? "\u2022\u2022\u2022\u2022\u2022"
          : new Intl.NumberFormat(undefined, {
              style: "currency",
              currency,
              minimumFractionDigits: 0,
              maximumFractionDigits: 0,
            }).format(value),
      formatPercent: (value: number) =>
        new Intl.NumberFormat(undefined, {
          style: "percent",
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }).format(value),
      formatPercentSigned: (value: number) =>
        new Intl.NumberFormat(undefined, {
          style: "percent",
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
          signDisplay: "exceptZero",
        }).format(value),
    };
  }, [parsed?.currency, isBalanceHidden, baseCurrency]);

  // Format date range
  const periodLabel = useMemo(() => {
    if (!parsed?.periodStartDate && !parsed?.periodEndDate) return null;
    const start = parsed.periodStartDate
      ? new Date(parsed.periodStartDate).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
        })
      : "Start";
    const end = parsed.periodEndDate
      ? new Date(parsed.periodEndDate).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
        })
      : "Today";
    return `${start} - ${end}`;
  }, [parsed?.periodStartDate, parsed?.periodEndDate]);

  // Show loading skeleton while running
  if (isLoading) {
    return <PerformanceLoadingSkeleton />;
  }

  // Show error state for incomplete/failed status
  if (isIncomplete) {
    return <ErrorState message="The request was interrupted or failed." />;
  }

  // Show empty state if no valid data
  if (!parsed || (!isComplete && !parsed.cumulativeTwr && !parsed.gainLossAmount)) {
    return <EmptyState />;
  }

  const typedArgs = args as GetPerformanceArgs | undefined;
  const accountLabel = parsed.id ?? typedArgs?.accountId ?? "Portfolio";
  // Hide UUID-like IDs (e.g., "29628C36-3333-46A2-A1FB-B4D8514D0A74")
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    accountLabel,
  );
  const headlineReturn = parsed.periodReturn ?? parsed.cumulativeTwr ?? parsed.simpleReturn;
  const isPositiveReturn = headlineReturn >= 0;
  const TrendIcon = isPositiveReturn ? Icons.TrendingUp : Icons.TrendingDown;

  return (
    <Card className="bg-muted/40 border-primary/10">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <CardTitle className="text-base">Performance</CardTitle>
            {accountLabel !== "Portfolio" && !isUuid && (
              <Badge variant="outline" className="text-xs uppercase">
                {accountLabel}
              </Badge>
            )}
          </div>
          {periodLabel && (
            <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <Icons.CalendarIcon className="size-3.5" />
              <span>{periodLabel}</span>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="max-h-[320px] space-y-4 overflow-y-auto">
        {/* Primary Return Display */}
        <div className="flex flex-wrap items-baseline gap-3">
          <div className="flex items-center gap-2">
            <TrendIcon
              className={cn("size-6", isPositiveReturn ? "text-success" : "text-destructive")}
            />
            <span
              className={cn(
                "text-3xl font-bold tabular-nums",
                isPositiveReturn ? "text-success" : "text-destructive",
              )}
            >
              {formatPercentSigned(headlineReturn)}
            </span>
          </div>
          {parsed.gainLossAmount != null && (
            <span
              className={cn(
                "text-lg font-medium tabular-nums",
                isBalanceHidden
                  ? "text-muted-foreground"
                  : isPositiveReturn
                    ? "text-success"
                    : "text-destructive",
              )}
            >
              {formatCurrency(parsed.gainLossAmount)}
            </span>
          )}
        </div>

        {/* Metrics Grid */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <MetricCard
            label="Annualized TWR"
            value={parsed.annualizedTwr == null ? "n/a" : formatPercentSigned(parsed.annualizedTwr)}
            isPositive={parsed.annualizedTwr == null ? null : parsed.annualizedTwr >= 0}
          />
          <MetricCard
            label="Modified Dietz"
            value={
              parsed.cumulativeModifiedDietz == null
                ? "n/a"
                : formatPercentSigned(parsed.cumulativeModifiedDietz)
            }
            subValue={
              parsed.annualizedModifiedDietz == null
                ? undefined
                : `${formatPercentSigned(parsed.annualizedModifiedDietz)} ann.`
            }
            isPositive={
              parsed.cumulativeModifiedDietz == null ? null : parsed.cumulativeModifiedDietz >= 0
            }
          />
          <MetricCard
            label="Volatility"
            value={formatPercent(parsed.volatility)}
            isPositive={null}
          />
          <MetricCard
            label="Max Drawdown"
            value={formatPercent(parsed.maxDrawdown)}
            isPositive={parsed.maxDrawdown > 0 ? false : null}
          />
        </div>

        {/* Currency Badge */}
        {parsed.currency && (
          <div className="flex justify-end">
            <Badge variant="secondary" className="text-xs uppercase">
              {parsed.currency}
            </Badge>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================================
// Export
// ============================================================================

const PerformanceToolUIContent = memo(PerformanceToolUIContentImpl);

export const PerformanceToolUI = makeAssistantToolUI<GetPerformanceArgs, PerformanceResult>({
  toolName: "get_performance",
  render: (props) => {
    return <PerformanceToolUIContent {...props} />;
  },
});
