import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { makeAssistantToolUI } from "@assistant-ui/react";
import { Badge, Card, CardContent, CardHeader, CardTitle, Skeleton } from "@wealthfolio/ui";
import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { useSettingsContext } from "@/lib/settings-provider";
import { CompactToolCard } from "./shared";
import {
  normalizePerformanceToolResult,
  performanceToolPeriodPnl,
  type PerformanceToolResult as PerformanceResult,
} from "./performance-tool-semantics";

// ============================================================================
// Types
// ============================================================================

interface GetPerformanceArgs {
  accountId?: string;
  startDate?: string;
  endDate?: string;
  displayMode?: "compact" | "full";
}

function summaryReturn(result: PerformanceResult): number | null {
  if (result.summaryPercentStatus !== "complete") return null;
  return result.summaryPercent ?? null;
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
  const { t } = useTranslation();
  return (
    <Card className="border-destructive/30 bg-destructive/5">
      <CardContent className="py-4">
        <p className="text-destructive text-sm font-medium">{t("ai:performance.error")}</p>
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
  const { t } = useTranslation();
  const { settings } = useSettingsContext();
  const baseCurrency = settings?.baseCurrency ?? "USD";
  const { isBalanceHidden } = useBalancePrivacy();
  const parsed = useMemo(
    () => normalizePerformanceToolResult(result, baseCurrency),
    [baseCurrency, result],
  );

  const isLoading = status?.type === "running";
  const isIncomplete = status?.type === "incomplete";

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
      : t("ai:performance.start");
    const end = parsed.periodEndDate
      ? new Date(parsed.periodEndDate).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
        })
      : t("ai:performance.today");
    return `${start} - ${end}`;
  }, [parsed?.periodStartDate, parsed?.periodEndDate, t]);

  // Compact mode — just show a one-liner when used as a prerequisite
  if (args?.displayMode === "compact" && parsed && !isLoading) {
    return <CompactToolCard label={t("ai:performance.fetched")} />;
  }

  // Show loading skeleton while running
  if (isLoading) {
    return <PerformanceLoadingSkeleton />;
  }

  // Show error state for incomplete/failed status
  if (isIncomplete) {
    return <ErrorState message={t("ai:performance.interrupted")} />;
  }

  // Show empty state if no valid data
  if (!parsed) {
    return <EmptyState />;
  }

  const typedArgs = args as GetPerformanceArgs | undefined;
  const accountLabel = parsed.id ?? typedArgs?.accountId ?? "Portfolio";
  // Hide UUID-like IDs (e.g., "29628C36-3333-46A2-A1FB-B4D8514D0A74")
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    accountLabel,
  );
  const summaryReturnValue = summaryReturn(parsed);
  const periodPnlAmount = performanceToolPeriodPnl(parsed);
  const suppressReturnMetrics = parsed.summaryPercentStatus !== "complete";
  const annualizedReturn = suppressReturnMetrics
    ? null
    : (parsed.annualizedTwr ?? parsed.annualizedValueReturn);
  const irr = suppressReturnMetrics ? null : parsed.irr;
  const annualizedIrr = suppressReturnMetrics ? null : parsed.annualizedIrr;
  const annualizedLabel =
    parsed.annualizedTwr == null
      ? t("ai:performance.annualizedReturn")
      : t("ai:performance.annualizedTwr");
  const isPositiveReturn = summaryReturnValue == null ? null : summaryReturnValue >= 0;
  const TrendIcon = isPositiveReturn ? Icons.TrendingUp : Icons.TrendingDown;

  return (
    <Card className="bg-muted/40 border-primary/10">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <CardTitle className="text-base">{t("ai:performance.title")}</CardTitle>
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
            {summaryReturnValue != null && (
              <TrendIcon
                className={cn("size-6", isPositiveReturn ? "text-success" : "text-destructive")}
              />
            )}
            <span
              className={cn(
                "text-3xl font-bold tabular-nums",
                summaryReturnValue == null
                  ? "text-muted-foreground"
                  : isPositiveReturn
                    ? "text-success"
                    : "text-destructive",
              )}
            >
              {summaryReturnValue == null
                ? t("ai:performance.notAvailableUpper")
                : formatPercentSigned(summaryReturnValue)}
            </span>
          </div>
          {periodPnlAmount != null && (
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
              {formatCurrency(periodPnlAmount)}
            </span>
          )}
        </div>

        {/* Metrics Grid */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <MetricCard
            label={annualizedLabel}
            value={
              annualizedReturn == null
                ? t("ai:performance.notAvailable")
                : formatPercentSigned(annualizedReturn)
            }
            isPositive={annualizedReturn == null ? null : annualizedReturn >= 0}
          />
          <MetricCard
            label={t("ai:performance.irr")}
            value={irr == null ? t("ai:performance.notAvailable") : formatPercentSigned(irr)}
            subValue={
              annualizedIrr == null
                ? undefined
                : t("ai:performance.irrAnn", { value: formatPercentSigned(annualizedIrr) })
            }
            isPositive={irr == null ? null : irr >= 0}
          />
          <MetricCard
            label={t("ai:performance.volatility")}
            value={
              parsed.volatility == null
                ? t("ai:performance.notAvailable")
                : formatPercent(parsed.volatility)
            }
            isPositive={null}
          />
          <MetricCard
            label={t("ai:performance.maxDrawdown")}
            value={
              parsed.maxDrawdown == null
                ? t("ai:performance.notAvailable")
                : formatPercent(parsed.maxDrawdown)
            }
            isPositive={parsed.maxDrawdown == null ? null : false}
          />
        </div>

        {/* Currency Badge */}
        {parsed.currency && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            {!!parsed.notApplicableReasons?.length && (
              <span className="text-muted-foreground text-xs">
                {parsed.notApplicableReasons[0]}
              </span>
            )}
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
