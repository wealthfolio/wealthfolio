import { cn } from "@/lib/utils";
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
import { Bar, BarChart, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts";

function getNiceTicks(maxValue: number, count = 5): number[] {
  if (maxValue <= 0) return [0];
  const rawStep = maxValue / (count - 1);
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const residual = rawStep / magnitude;
  let niceStep: number;
  if (residual <= 1) niceStep = magnitude;
  else if (residual <= 2) niceStep = 2 * magnitude;
  else if (residual <= 5) niceStep = 5 * magnitude;
  else niceStep = 10 * magnitude;
  return Array.from({ length: count }, (_, i) => i * niceStep);
}

interface IncomeHistoryChartProps {
  monthlyIncomeData: [string, number][];
  previousMonthlyIncomeData: [string, number][];
  selectedPeriod: "ALL" | "YTD" | "LAST_YEAR";
  currency: string;
  isBalanceHidden: boolean;
  byAccount?: Record<string, IncomeByAccount>;
}

const viewModes = [
  { value: "combined" as const, label: "Combined" },
  { value: "byAccount" as const, label: "By Account" },
];

export const IncomeHistoryChart: React.FC<IncomeHistoryChartProps> = ({
  monthlyIncomeData,
  previousMonthlyIncomeData,
  selectedPeriod,
  currency,
  isBalanceHidden,
  byAccount,
}) => {
  const [isMobile, setIsMobile] = React.useState(false);
  const [viewMode, setViewMode] = useState<"combined" | "byAccount">("combined");

  React.useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768);
    };
    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  const chartData = monthlyIncomeData.map(([month, income], index) => {
    const cumulative = monthlyIncomeData.slice(0, index + 1).reduce((sum, [, value]) => {
      const numericValue = Number(value) || 0;
      return sum + numericValue;
    }, 0);

    const dataPoint = {
      month,
      income: Number(income) || 0,
      cumulative: cumulative,
      previousIncome: Number(previousMonthlyIncomeData[index]?.[1]) || 0,
    };

    return dataPoint;
  });

  const accounts = useMemo(
    () => (byAccount ? Object.values(byAccount).sort((a, b) => b.total - a.total) : []),
    [byAccount],
  );

  const showToggle = accounts.length > 1;
  const effectiveViewMode = showToggle ? viewMode : "combined";

  const byAccountChartData = useMemo(() => {
    if (!byAccount || accounts.length === 0) return [];
    return monthlyIncomeData.map(([month]) => {
      const point: Record<string, string | number> = { month };
      for (const acc of accounts) {
        point[acc.accountId] = acc.byMonth[month] ?? 0;
      }
      return point;
    });
  }, [monthlyIncomeData, byAccount, accounts]);

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
    selectedPeriod === "ALL" ? "All Time" : selectedPeriod === "YTD" ? "Year to Date" : "Last Year";

  const xAxisProps = {
    dataKey: "month" as const,
    tickLine: false,
    tickMargin: 8,
    axisLine: false,
    tick: { fontSize: isMobile ? 11 : 12 },
    tickFormatter: (value: string) => {
      const date = parseISO(`${value}-01`);
      return isMobile ? format(date, "MMM") : format(date, "MMM yy");
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
    return Math.max(
      ...chartData.map((d) => Math.max(d.income, d.previousIncome, isMobile ? d.cumulative : 0)),
    );
  })();
  const yTicks = getNiceTicks(dataMax);
  const tickStep = yTicks.length > 1 ? yTicks[1] : 0;

  const yAxisProps = {
    tickLine: false,
    axisLine: false,
    tick: { fontSize: isMobile ? 10 : 12 },
    width: isMobile ? 45 : 60,
    ticks: yTicks,
    domain: [0, yTicks[yTicks.length - 1] || 0] as [number, number],
    tickFormatter: (value: number) => {
      if (value === 0) return "0";
      if (tickStep >= 1000) {
        const k = value / 1000;
        return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
      }
      return value.toString();
    },
  };

  const tooltipLabelFormatter = (label: unknown) => {
    if (typeof label !== "string") return "";
    return format(parseISO(`${label}-01`), isMobile ? "MMM yyyy" : "MMMM yyyy");
  };

  return (
    <Card className="md:col-span-2">
      <CardHeader className="pb-4 md:pb-6">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-sm font-medium">Income History</CardTitle>
            <CardDescription className="text-xs md:text-sm">{periodDescription}</CardDescription>
          </div>
          {showToggle && (
            <>
              <div className="hidden sm:block">
                <AnimatedToggleGroup
                  variant="secondary"
                  size="sm"
                  items={viewModes}
                  value={viewMode}
                  onValueChange={setViewMode}
                />
              </div>
              <div className="block sm:hidden">
                <AnimatedToggleGroup
                  variant="secondary"
                  size="xs"
                  items={viewModes}
                  value={viewMode}
                  onValueChange={setViewMode}
                />
              </div>
            </>
          )}
        </div>
      </CardHeader>
      <CardContent className="px-4 pt-0 md:px-6">
        {chartData.length === 0 ? (
          <EmptyPlaceholder
            className="mx-auto flex h-[250px] max-w-[420px] items-center justify-center md:h-[300px]"
            icon={<Icons.Activity className="h-8 w-8 md:h-10 md:w-10" />}
            title="No income history available"
            description="There is no income history for the selected period. Try selecting a different time range or check back later."
          />
        ) : effectiveViewMode === "byAccount" ? (
          <ChartContainer
            config={accountChartConfig}
            className={cn("h-[280px] w-full md:h-[380px]")}
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
                label: "Monthly Income",
                color: "var(--chart-1)",
              },
              cumulative: {
                label: "Cumulative Income",
                color: "var(--chart-5)",
              },
              previousIncome: {
                label: "Previous Period Income",
                color: "var(--chart-5)",
              },
            }}
            className={cn("h-[280px] w-full md:h-[380px]")}
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
              {!isMobile && (
                <YAxis yAxisId="right" orientation="right" tickLine={false} axisLine={false} />
              )}
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
                                  ? "Monthly"
                                  : "Monthly Income"
                                : name === "previousIncome"
                                  ? "Previous"
                                  : name === "cumulative"
                                    ? "Cumulative"
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
              <Bar
                yAxisId="left"
                dataKey="income"
                fill="var(--color-income)"
                radius={[isMobile ? 4 : 8, isMobile ? 4 : 8, 0, 0]}
                barSize={isMobile ? 16 : 25}
              />
              <Line
                yAxisId={isMobile ? "left" : "right"}
                type="monotone"
                dataKey="cumulative"
                stroke="var(--color-cumulative)"
                strokeWidth={isMobile ? 1.5 : 2}
                dot={false}
              />
              <Line
                yAxisId="left"
                type="monotone"
                dataKey="previousIncome"
                stroke="var(--color-previousIncome)"
                strokeWidth={isMobile ? 1.5 : 2}
                dot={false}
                strokeDasharray="3 3"
                opacity={0.6}
              />
            </ComposedChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
};
