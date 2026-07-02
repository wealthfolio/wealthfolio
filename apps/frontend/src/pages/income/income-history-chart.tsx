import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n/i18n-provider";
import type { IncomeByAccount } from "@/lib/types";
import { AnimatedToggleGroup, formatAmount } from "@wealthfolio/ui";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@wealthfolio/ui/components/ui/card";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@wealthfolio/ui/components/ui/chart";
import { EmptyPlaceholder } from "@wealthfolio/ui/components/ui/empty-placeholder";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { format, parseISO } from "date-fns";
import React, { useMemo, useState } from "react";
import { Area, Bar, BarChart, CartesianGrid, ComposedChart, XAxis, YAxis } from "recharts";

// Round a raw step up to a "nice" value (1, 2, 2.5, 5, 10 × 10ⁿ).
function niceStep(rawStep: number): number {
  if (rawStep <= 0) return 0;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const residual = rawStep / magnitude;
  let mult: number;
  if (residual <= 1) mult = 1;
  else if (residual <= 2) mult = 2;
  else if (residual <= 2.5) mult = 2.5;
  else if (residual <= 5) mult = 5;
  else mult = 10;
  return mult * magnitude;
}

// Ticks from 0 to just above maxValue — the top tick is the first nice step past
// the data so the plot isn't left with a tall empty band of headroom.
function getNiceTicks(maxValue: number, count = 5): number[] {
  if (maxValue <= 0) return [0];
  const step = niceStep(maxValue / (count - 1));
  const tickCount = Math.floor(maxValue / step) + 2;
  return Array.from({ length: tickCount }, (_, i) => i * step);
}

// Right-axis ticks that reuse the left axis's tick count so the gridlines align.
function getAlignedTicks(maxValue: number, tickCount: number): number[] {
  if (maxValue <= 0 || tickCount <= 1) return [0];
  const step = niceStep(maxValue / (tickCount - 1));
  return Array.from({ length: tickCount }, (_, i) => i * step);
}

function formatK(value: number, isChinese: boolean): string {
  if (value === 0) return "0";
  if (isChinese) {
    try {
      return new Intl.NumberFormat("zh-CN", {
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(value);
    } catch {
      return value.toString();
    }
  }
  if (Math.abs(value) >= 1000) {
    const k = value / 1000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
  }
  return value.toString();
}

interface IncomeHistoryChartProps {
  monthlyIncomeData: [string, number][];
  previousMonthlyIncomeData: [string, number][];
  selectedPeriod: "ALL" | "YTD" | "LAST_YEAR";
  currency: string;
  isBalanceHidden: boolean;
  byAccount?: Record<string, IncomeByAccount>;
}

function getViewModes(isChinese: boolean) {
  return [
    { value: "combined" as const, label: isChinese ? "合并" : "Combined" },
    { value: "byAccount" as const, label: isChinese ? "按账户" : "By Account" },
  ];
}

function formatIncomeMonth(
  date: Date,
  isMobile: boolean,
  isChinese: boolean,
  includeYear = false,
): string {
  if (isChinese) {
    return new Intl.DateTimeFormat("zh-CN", {
      month: includeYear || !isMobile ? "long" : "short",
      year: includeYear ? "numeric" : isMobile ? undefined : "2-digit",
    }).format(date);
  }
  if (includeYear) return format(date, isMobile ? "MMM yyyy" : "MMMM yyyy");
  return isMobile ? format(date, "MMM") : format(date, "MMM yy");
}

export const IncomeHistoryChart: React.FC<IncomeHistoryChartProps> = ({
  monthlyIncomeData,
  previousMonthlyIncomeData,
  selectedPeriod,
  currency,
  isBalanceHidden,
  byAccount,
}) => {
  const { language } = useI18n();
  const isChinese = language === "zh-CN";
  const [isMobile, setIsMobile] = React.useState(false);
  const [viewMode, setViewMode] = useState<"combined" | "byAccount">("combined");
  const localizedViewModes = useMemo(() => getViewModes(isChinese), [isChinese]);

  React.useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768);
    };
    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  // Compute cumulative over the full series first, then drop leading months that
  // have no activity at all so the chart doesn't waste horizontal space on a flat
  // run of zeros before the first income.
  const fullChartData = monthlyIncomeData.map(([month, income], index) => {
    const cumulative = monthlyIncomeData.slice(0, index + 1).reduce((sum, [, value]) => {
      return sum + (Number(value) || 0);
    }, 0);

    return {
      month,
      income: Number(income) || 0,
      cumulative,
      previousIncome: Number(previousMonthlyIncomeData[index]?.[1]) || 0,
    };
  });

  const firstActiveIndex = (() => {
    const idx = fullChartData.findIndex((d) => d.income !== 0 || d.previousIncome !== 0);
    return idx === -1 ? 0 : idx;
  })();

  const chartData = fullChartData.slice(firstActiveIndex);
  const trimmedMonths = chartData.map((d) => d.month);

  const accounts = useMemo(
    () => (byAccount ? Object.values(byAccount).sort((a, b) => b.total - a.total) : []),
    [byAccount],
  );

  const showToggle = accounts.length > 1;
  const effectiveViewMode = showToggle ? viewMode : "combined";

  const byAccountChartData = useMemo(() => {
    if (!byAccount || accounts.length === 0) return [];
    return trimmedMonths.map((month) => {
      const point: Record<string, string | number> = { month };
      for (const acc of accounts) {
        point[acc.accountId] = acc.byMonth[month] ?? 0;
      }
      return point;
    });
  }, [trimmedMonths, byAccount, accounts]);

  const accountChartConfig = useMemo(
    () =>
      Object.fromEntries(
        accounts.map((acc, i) => [
          acc.accountId,
          { label: acc.accountName, color: `var(--chart-${(i % 9) + 1})` },
        ]),
      ),
    [accounts],
  );

  const periodDescription =
    selectedPeriod === "ALL"
      ? isChinese
        ? "全部时间"
        : "All Time"
      : selectedPeriod === "YTD"
        ? isChinese
          ? "今年至今"
          : "Year to Date"
        : isChinese
          ? "去年"
          : "Last Year";

  // Render evenly-spaced labels (every Nth month) instead of letting Recharts
  // auto-thin, which produced irregular 2-then-3-month gaps.
  const xTickStep = Math.max(1, Math.ceil(trimmedMonths.length / (isMobile ? 5 : 9)));
  const xTicks = trimmedMonths.filter((_, i) => i % xTickStep === 0);

  const xAxisProps = {
    dataKey: "month" as const,
    tickLine: false,
    tickMargin: 8,
    axisLine: false,
    ticks: xTicks,
    interval: 0 as const,
    tick: { fontSize: isMobile ? 11 : 12 },
    tickFormatter: (value: string) => {
      const date = parseISO(`${value}-01`);
      return formatIncomeMonth(date, isMobile, isChinese);
    },
  };

  const dataMax = (() => {
    if (effectiveViewMode === "byAccount" && byAccountChartData.length > 0) {
      return Math.max(
        ...byAccountChartData.map((row) =>
          accounts.reduce((sum, acc) => sum + (Number(row[acc.accountId]) || 0), 0),
        ),
      );
    }
    if (chartData.length === 0) return 0;
    return Math.max(...chartData.map((d) => Math.max(d.income, d.previousIncome)));
  })();
  const yTicks = getNiceTicks(dataMax);

  // Right axis (cumulative) — match the left axis tick count so the gridlines
  // line up, and format with the same "k" convention.
  const cumulativeMax = chartData.length ? Math.max(...chartData.map((d) => d.cumulative)) : 0;
  const rightTicks = getAlignedTicks(cumulativeMax, yTicks.length);

  const yAxisProps = {
    tickLine: false,
    axisLine: false,
    tick: { fontSize: isMobile ? 10 : 12 },
    width: isMobile ? 45 : 60,
    ticks: yTicks,
    domain: [0, yTicks[yTicks.length - 1] || 0] as [number, number],
    tickFormatter: (value: number) => formatK(value, isChinese),
  };

  const tooltipLabelFormatter = (label: unknown) => {
    if (typeof label !== "string") return "";
    return formatIncomeMonth(parseISO(`${label}-01`), isMobile, isChinese, true);
  };

  return (
    <Card className="flex flex-col md:col-span-2">
      <CardHeader className="pb-4 md:pb-6">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-sm font-medium">
              {isChinese ? "收入历史" : "Income History"}
            </CardTitle>
            <CardDescription className="text-xs md:text-sm">{periodDescription}</CardDescription>
          </div>
          {showToggle && (
            <>
              <div className="hidden sm:block">
                <AnimatedToggleGroup
                  variant="secondary"
                  size="sm"
                  items={localizedViewModes}
                  value={viewMode}
                  onValueChange={setViewMode}
                />
              </div>
              <div className="block sm:hidden">
                <AnimatedToggleGroup
                  variant="secondary"
                  size="xs"
                  items={localizedViewModes}
                  value={viewMode}
                  onValueChange={setViewMode}
                />
              </div>
            </>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col px-4 pt-0 md:px-6">
        {chartData.length === 0 ? (
          <EmptyPlaceholder
            className="mx-auto flex h-[250px] max-w-[420px] items-center justify-center md:h-[300px]"
            icon={<Icons.Activity className="h-8 w-8 md:h-10 md:w-10" />}
            title={isChinese ? "暂无收入历史" : "No income history available"}
            description={
              isChinese
                ? "所选期间没有收入历史。请尝试其他时间范围或稍后再查看。"
                : "There is no income history for the selected period. Try selecting a different time range or check back later."
            }
          />
        ) : effectiveViewMode === "byAccount" ? (
          <ChartContainer
            config={accountChartConfig}
            className={cn("h-full min-h-[280px] w-full flex-1 md:min-h-[380px]")}
            data-no-swipe-drag
          >
            <BarChart
              key={selectedPeriod}
              data={byAccountChartData}
              margin={{
                left: isMobile ? -16 : 0,
                right: isMobile ? 4 : 8,
                top: 12,
                bottom: 4,
              }}
            >
              <CartesianGrid vertical={false} strokeDasharray="3 3" opacity={0.3} />
              <XAxis {...xAxisProps} />
              <YAxis {...yAxisProps} />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    className="min-w-[150px] md:min-w-[180px]"
                    formatter={(value, name, entry) => {
                      const formattedValue = isBalanceHidden
                        ? "••••"
                        : formatAmount(Number(value), currency);
                      const label = accountChartConfig[name as string]?.label ?? String(name);
                      return (
                        <>
                          <div
                            className="border-border bg-(--color-bg) h-2.5 w-2.5 shrink-0 rounded-[2px]"
                            style={
                              {
                                "--color-bg": entry.color,
                                "--color-border": entry.color,
                              } as React.CSSProperties
                            }
                          />
                          <div className="flex flex-1 items-center justify-between gap-2">
                            <span className="text-muted-foreground text-xs md:text-sm">
                              {label}
                            </span>
                            <span className="text-foreground font-mono text-xs font-medium tabular-nums md:text-sm">
                              {formattedValue}
                            </span>
                          </div>
                        </>
                      );
                    }}
                    labelFormatter={tooltipLabelFormatter}
                  />
                }
              />
              {!isMobile && <ChartLegend content={<ChartLegendContent />} />}
              {accounts.map((acc, i) => (
                <Bar
                  key={acc.accountId}
                  dataKey={acc.accountId}
                  stackId="income"
                  fill={`var(--chart-${(i % 9) + 1})`}
                  stroke={`var(--chart-${(i % 9) + 1})`}
                  barSize={isMobile ? 16 : 25}
                  radius={i === accounts.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]}
                />
              ))}
            </BarChart>
          </ChartContainer>
        ) : (
          <ChartContainer
            config={{
              income: {
                label: isChinese ? "月度收入" : "Monthly Income",
                color: "var(--chart-1)",
              },
              cumulative: {
                label: isChinese ? "累计收入" : "Cumulative Income",
                color: "var(--chart-2)",
              },
              previousIncome: {
                label: isChinese ? "上一期间收入" : "Previous Period Income",
                color: "var(--chart-stone)",
              },
            }}
            className={cn("h-full min-h-[280px] w-full flex-1 md:min-h-[380px]")}
            data-no-swipe-drag
          >
            <ComposedChart
              data={chartData}
              margin={{
                left: isMobile ? -16 : 0,
                right: isMobile ? 4 : 8,
                top: 12,
                bottom: 4,
              }}
            >
              <CartesianGrid vertical={false} strokeDasharray="3 3" opacity={0.3} />
              <XAxis {...xAxisProps} />
              <YAxis yAxisId="left" {...yAxisProps} />
              <YAxis
                yAxisId="right"
                orientation="right"
                hide={isMobile}
                tickLine={false}
                axisLine={false}
                width={isMobile ? 0 : 48}
                ticks={rightTicks}
                domain={[0, rightTicks[rightTicks.length - 1] || 0]}
                tick={{ fontSize: 12, fill: "var(--chart-2)" }}
                tickFormatter={(value: number) => formatK(value, isChinese)}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    className="min-w-[150px] md:min-w-[180px]"
                    formatter={(value, name, entry) => {
                      const formattedValue = isBalanceHidden
                        ? "••••"
                        : formatAmount(Number(value), currency);
                      return (
                        <>
                          <div
                            className="border-border bg-(--color-bg) h-2.5 w-2.5 shrink-0 rounded-[2px]"
                            style={
                              {
                                "--color-bg": entry.color,
                                "--color-border": entry.color,
                              } as React.CSSProperties
                            }
                          />
                          <div className="flex flex-1 items-center justify-between gap-2">
                            <span className="text-muted-foreground text-xs md:text-sm">
                              {name === "income"
                                ? isMobile
                                  ? isChinese
                                    ? "月度"
                                    : "Monthly"
                                  : isChinese
                                    ? "月度收入"
                                    : "Monthly Income"
                                : name === "previousIncome"
                                  ? isChinese
                                    ? "上一期"
                                    : "Previous"
                                  : name === "cumulative"
                                    ? isChinese
                                      ? "累计"
                                      : "Cumulative"
                                    : name}
                            </span>
                            <span className="text-foreground font-mono text-xs font-medium tabular-nums md:text-sm">
                              {formattedValue}
                            </span>
                          </div>
                        </>
                      );
                    }}
                    labelFormatter={tooltipLabelFormatter}
                  />
                }
              />
              {!isMobile && <ChartLegend content={<ChartLegendContent payload={[]} />} />}
              <defs>
                <linearGradient id="incomeCumulativeFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--color-cumulative)" stopOpacity={0.18} />
                  <stop offset="100%" stopColor="var(--color-cumulative)" stopOpacity={0} />
                </linearGradient>
              </defs>
              {/* Cumulative — a single Area drawn first so its fill sits behind the
                  bars as background context, with its own stroke acting as the line.
                  One element means exactly one legend/tooltip entry. */}
              <Area
                yAxisId="right"
                type="monotone"
                dataKey="cumulative"
                stroke="var(--color-cumulative)"
                strokeWidth={isMobile ? 1.5 : 2.25}
                fill="url(#incomeCumulativeFill)"
                dot={false}
              />
              {/* Prior vs. current period as grouped bars (prior on the left).
                  Prior period is the calmer neutral so the current reads as primary. */}
              <Bar
                yAxisId="left"
                dataKey="previousIncome"
                fill="var(--color-previousIncome)"
                radius={[isMobile ? 3 : 4, isMobile ? 3 : 4, 0, 0]}
                barSize={isMobile ? 11 : 18}
              />
              <Bar
                yAxisId="left"
                dataKey="income"
                fill="var(--color-income)"
                radius={[isMobile ? 3 : 4, isMobile ? 3 : 4, 0, 0]}
                barSize={isMobile ? 11 : 18}
              />
            </ComposedChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
};
