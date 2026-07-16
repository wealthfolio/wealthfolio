import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { makeAssistantToolUI } from "@assistant-ui/react";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  GainPercent,
  PrivacyAmount,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  formatPercent,
} from "@wealthfolio/ui";
import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { Bar, BarChart, ResponsiveContainer, Tooltip as ChartTooltip, XAxis } from "recharts";
import { CompactToolCard } from "./shared";

// ============================================================================
// Types
// ============================================================================

interface GetIncomeArgs {
  period?: string;
  displayMode?: "compact" | "full";
}

interface TopAssetDto {
  symbol: string;
  name: string;
  income: number;
}

interface GetIncomeOutput {
  totalIncome: number;
  currency: string;
  monthlyAverage: number;
  yoyGrowth?: number | null;
  byType: Record<string, number>;
  topAssets: TopAssetDto[];
  byMonth: Record<string, number>;
  period: string;
}

// ============================================================================
// Normalizer
// ============================================================================

function normalizeResult(result: unknown): GetIncomeOutput | null {
  if (!result) {
    return null;
  }

  if (typeof result === "string") {
    try {
      return normalizeResult(JSON.parse(result));
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
    return normalizeResult(candidate.data);
  }

  // Normalize snake_case to camelCase
  const totalIncome =
    (candidate.totalIncome as number | undefined) ??
    (candidate.total_income as number | undefined) ??
    0;

  const currency = (candidate.currency as string | undefined) ?? "USD";

  const monthlyAverage =
    (candidate.monthlyAverage as number | undefined) ??
    (candidate.monthly_average as number | undefined) ??
    0;

  const yoyGrowth =
    (candidate.yoyGrowth as number | undefined) ?? (candidate.yoy_growth as number | undefined);

  const byType =
    (candidate.byType as Record<string, number> | undefined) ??
    (candidate.by_type as Record<string, number> | undefined) ??
    {};

  const byMonth =
    (candidate.byMonth as Record<string, number> | undefined) ??
    (candidate.by_month as Record<string, number> | undefined) ??
    {};

  const topAssetsRaw =
    (candidate.topAssets as TopAssetDto[] | undefined) ??
    (candidate.top_assets as TopAssetDto[] | undefined) ??
    [];

  const topAssets = topAssetsRaw.map((asset) => {
    const raw = asset as unknown as Record<string, unknown>;
    return {
      symbol: (raw.display_code as string) ?? (raw.displayCode as string) ?? asset.symbol ?? "",
      name: asset.name ?? "",
      income: asset.income ?? 0,
    };
  });

  const period = (candidate.period as string | undefined) ?? "YTD";

  return {
    totalIncome,
    currency,
    monthlyAverage,
    yoyGrowth,
    byType,
    topAssets,
    byMonth,
    period,
  };
}

// ============================================================================
// Helpers
// ============================================================================

function getPeriodLabel(period: string, t: TFunction): string {
  switch (period) {
    case "YTD":
      return t("ai:income.yearToDate");
    case "LAST_YEAR":
      return t("ai:income.lastYear");
    case "ALL":
      return t("ai:income.allTime");
    default:
      return period;
  }
}

function getTypeLabel(type: string, t: TFunction): string {
  switch (type) {
    case "DIVIDEND":
      return t("ai:income.dividends");
    case "INTEREST":
      return t("ai:income.interest");
    case "OTHER_INCOME":
      return t("ai:income.other");
    default:
      return type;
  }
}

function formatMonthLabel(key: string): string {
  // key format: "2024-01" or "2024-1" or "Jan 2024"
  const parts = key.split("-");
  if (parts.length === 2) {
    const monthNames = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    const monthIndex = parseInt(parts[1], 10) - 1;
    if (monthIndex >= 0 && monthIndex < 12) {
      return monthNames[monthIndex];
    }
  }
  return key;
}

// ============================================================================
// Tool UI Component
// ============================================================================

export const IncomeToolUI = makeAssistantToolUI<GetIncomeArgs, GetIncomeOutput>({
  toolName: "get_income",
  render: (props) => {
    return <IncomeContent {...props} />;
  },
});

type IncomeContentProps = ToolCallMessagePartProps<GetIncomeArgs, GetIncomeOutput>;

const IncomeContent = memo(IncomeContentImpl);

function IncomeContentImpl({ args, result, status }: IncomeContentProps) {
  const { t } = useTranslation();
  const { isBalanceHidden } = useBalancePrivacy();
  const parsed = normalizeResult(result);

  const currency = parsed?.currency ?? "USD";

  const formatter = useMemo(
    () =>
      new Intl.NumberFormat(undefined, {
        style: "currency",
        currency,
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      }),
    [currency],
  );

  // Calculate type percentages
  const typeBreakdown = useMemo(() => {
    if (!parsed?.byType || parsed.totalIncome === 0) return [];
    return Object.entries(parsed.byType)
      .filter(([, value]) => value > 0)
      .map(([type, value]) => ({
        type,
        label: getTypeLabel(type, t),
        value,
        percentage: (value / parsed.totalIncome) * 100,
      }))
      .sort((a, b) => b.value - a.value);
  }, [parsed?.byType, parsed?.totalIncome, t]);

  // Prepare monthly chart data
  const monthlyData = useMemo(() => {
    if (!parsed?.byMonth) return [];
    return Object.entries(parsed.byMonth)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, value]) => ({
        month,
        label: formatMonthLabel(month),
        income: value,
      }));
  }, [parsed?.byMonth]);

  // Top assets with percentage of total
  const topAssetsSlice = useMemo(() => {
    if (!parsed?.topAssets?.length || !parsed.totalIncome) return [];
    return parsed.topAssets.slice(0, 5).map((asset) => ({
      ...asset,
      percentage: (asset.income / parsed.totalIncome) * 100,
    }));
  }, [parsed?.topAssets, parsed?.totalIncome]);

  // Total percentage covered by top assets (for stacked bar)
  const topAssetsTotal = useMemo(
    () => topAssetsSlice.reduce((sum, a) => sum + a.income, 0),
    [topAssetsSlice],
  );

  const isLoading = status?.type === "running";
  const isComplete = status?.type === "complete" || status?.type === "incomplete";
  const hasError = status?.type === "incomplete" && status.reason === "error";

  // Compact mode — just show a one-liner when used as a prerequisite
  if (args?.displayMode === "compact" && parsed && !isLoading) {
    return <CompactToolCard label={t("ai:income.fetched")} />;
  }

  const formatValue = (value: number) => {
    if (isBalanceHidden) return "******";
    return formatter.format(value);
  };

  // Loading skeleton
  if (isLoading) {
    return (
      <Card className="bg-muted/40 border-primary/10 w-full overflow-hidden">
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between gap-2">
            <div>
              <CardTitle className="text-sm font-medium">{t("ai:income.title")}</CardTitle>
              <Skeleton className="mt-1 h-3 w-16" />
            </div>
            <Skeleton className="h-8 w-28" />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Skeleton className="h-16 rounded-lg" />
            <Skeleton className="h-16 rounded-lg" />
          </div>
          <Skeleton className="h-28 w-full rounded-lg" />
          <Skeleton className="h-6 w-full rounded-md" />
          <div className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        </CardContent>
      </Card>
    );
  }

  // Error state
  if (hasError) {
    return (
      <Card className="border-destructive/30 bg-destructive/5 w-full">
        <CardContent className="py-4">
          <p className="text-destructive text-sm font-medium">{t("ai:income.error")}</p>
        </CardContent>
      </Card>
    );
  }

  // Empty state
  if (isComplete && (!parsed || parsed.totalIncome === 0)) {
    return (
      <Card className="bg-muted/40 border-primary/10 w-full">
        <CardContent className="py-4">
          <p className="text-muted-foreground text-sm">{t("ai:income.empty")}</p>
        </CardContent>
      </Card>
    );
  }

  if (!parsed) {
    return (
      <Card className="bg-muted/40 border-primary/10 w-full">
        <CardContent className="py-4">
          <p className="text-muted-foreground text-sm">{t("ai:income.unavailable")}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="bg-muted/40 border-primary/10 w-full overflow-hidden">
      {/* Header: title left, total amount right */}
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base font-medium">{t("ai:income.title")}</CardTitle>
            <div className="text-muted-foreground mt-1 flex items-center gap-2 text-xs">
              <span>{getPeriodLabel(parsed.period, t)}</span>
              {parsed.yoyGrowth !== undefined && parsed.yoyGrowth !== null && (
                <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                  <span className="mr-0.5">YoY</span>
                  <GainPercent value={parsed.yoyGrowth} />
                </Badge>
              )}
            </div>
          </div>
          <div className="text-right">
            <PrivacyAmount
              value={parsed.totalIncome}
              currency={currency}
              className="text-2xl font-bold"
            />
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Stat cards */}
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-background/60 rounded-lg border p-3">
            <span className="text-muted-foreground text-xs">{t("ai:income.monthlyAverage")}</span>
            <div className="mt-1 text-sm font-semibold tabular-nums">
              {formatValue(parsed.monthlyAverage)}
            </div>
          </div>
          {typeBreakdown.length > 0 && (
            <div className="bg-background/60 rounded-lg border p-3">
              <span className="text-muted-foreground text-xs">{t("ai:income.byType")}</span>
              <div className="mt-1 space-y-0.5">
                {typeBreakdown.map((item) => (
                  <div key={item.type} className="flex items-center justify-between text-xs">
                    <span className="text-sm font-semibold">{item.label}</span>
                    <span className="text-muted-foreground tabular-nums">
                      {item.percentage.toFixed(0)}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Monthly bar chart */}
        {monthlyData.length > 1 && (
          <div className="space-y-2">
            <p className="text-muted-foreground text-xs font-medium uppercase">
              {t("ai:income.monthlyIncome")}
            </p>
            <div className="h-24">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={monthlyData} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
                  <XAxis
                    dataKey="label"
                    axisLine={false}
                    tickLine={false}
                    tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                    interval={monthlyData.length > 12 ? Math.floor(monthlyData.length / 12) : 0}
                  />
                  <ChartTooltip
                    cursor={{ fill: "var(--muted)", opacity: 0.5 }}
                    content={({ active, payload }) => {
                      if (!active || !payload?.length) return null;
                      const data = payload[0].payload as (typeof monthlyData)[0];
                      return (
                        <div className="border-border/50 bg-background rounded-lg border px-2.5 py-1.5 text-xs shadow-xl">
                          <div className="text-muted-foreground">{data.month}</div>
                          <div className="font-medium">{formatValue(data.income)}</div>
                        </div>
                      );
                    }}
                  />
                  <Bar dataKey="income" fill="var(--chart-1)" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {/* Sources: stacked bar + table */}
        {topAssetsSlice.length > 0 && (
          <TooltipProvider>
            <div className="space-y-3">
              <p className="text-muted-foreground text-xs font-medium uppercase">
                {t("ai:income.sources")}
              </p>

              {/* Stacked bar */}
              <div className="flex h-5 w-full items-center gap-0.5 overflow-hidden rounded-md">
                {topAssetsSlice.map((asset, index) => {
                  const widthPercent =
                    topAssetsTotal > 0 ? (asset.income / topAssetsTotal) * 100 : 0;
                  if (widthPercent < 0.5) return null;
                  return (
                    <Tooltip key={asset.symbol} delayDuration={100}>
                      <TooltipTrigger asChild>
                        <div
                          className="flex h-full cursor-default items-center justify-center transition-opacity hover:opacity-80"
                          style={{
                            width: `${widthPercent}%`,
                            backgroundColor: `var(--chart-${(index % 9) + 1})`,
                            minWidth: widthPercent >= 1 ? "4px" : undefined,
                          }}
                        >
                          {widthPercent > 14 && (
                            <span className="text-background truncate px-1 text-[10px] font-medium">
                              {asset.symbol}
                            </span>
                          )}
                        </div>
                      </TooltipTrigger>
                      <TooltipContent side="top" align="center">
                        <div className="text-center">
                          <div className="font-medium">{asset.symbol}</div>
                          <div className="text-muted-foreground text-xs">
                            {formatValue(asset.income)} ({formatPercent(asset.percentage / 100)})
                          </div>
                        </div>
                      </TooltipContent>
                    </Tooltip>
                  );
                })}
              </div>

              {/* Table */}
              <div className="divide-border/60 divide-y">
                {topAssetsSlice.map((asset, index) => (
                  <div
                    key={asset.symbol}
                    className="flex items-center gap-2 py-2 text-xs first:pt-0 last:pb-0"
                  >
                    <div
                      className="h-2.5 w-2.5 flex-shrink-0 rounded-sm"
                      style={{ backgroundColor: `var(--chart-${(index % 9) + 1})` }}
                    />
                    <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
                      <span className="font-medium">{asset.symbol}</span>
                      <span className="text-muted-foreground truncate">{asset.name}</span>
                    </div>
                    <span className="text-muted-foreground flex-shrink-0 tabular-nums">
                      {formatPercent(asset.percentage / 100)}
                    </span>
                    <span className="flex-shrink-0 font-medium tabular-nums">
                      {formatValue(asset.income)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </TooltipProvider>
        )}
      </CardContent>
    </Card>
  );
}
