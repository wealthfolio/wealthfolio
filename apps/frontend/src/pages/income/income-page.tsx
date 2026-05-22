import { getIncomeSummary } from "@/adapters";
import { Badge } from "@wealthfolio/ui/components/ui/badge";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@wealthfolio/ui/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@wealthfolio/ui/components/ui/chart";
import { EmptyPlaceholder } from "@wealthfolio/ui/components/ui/empty-placeholder";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { AccountScopeSelector } from "@/components/account-filter-selector";
import type { AccountScope } from "@/lib/types";

import { QueryKeys } from "@/lib/query-keys";
import type { IncomeSummary } from "@/lib/types";
import { useQuery } from "@tanstack/react-query";
import { AmountDisplay, AnimatedToggleGroup, GainPercent, PrivacyAmount } from "@wealthfolio/ui";
import React, { useState } from "react";
import { Cell, Pie, PieChart } from "recharts";
import { IncomeHistoryChart } from "./income-history-chart";
import { IncomeMobileFilterSheet } from "./income-mobile-filter-sheet";

const periods = [
  { value: "YTD" as const, label: "Year to Date" },
  { value: "LAST_YEAR" as const, label: "Last Year" },
  { value: "TOTAL" as const, label: "All Time" },
];

const mobilePeriods = [
  { value: "YTD" as const, label: "YTD" },
  { value: "LAST_YEAR" as const, label: "Last Yr" },
  { value: "TOTAL" as const, label: "All" },
];

const IncomePeriodSelector: React.FC<{
  selectedPeriod: "TOTAL" | "YTD" | "LAST_YEAR";
  onPeriodSelect: (period: "TOTAL" | "YTD" | "LAST_YEAR") => void;
}> = ({ selectedPeriod, onPeriodSelect }) => (
  <>
    <div className="hidden sm:block">
      <AnimatedToggleGroup
        variant="secondary"
        size="sm"
        items={periods}
        value={selectedPeriod}
        onValueChange={onPeriodSelect}
      />
    </div>
    <div className="block sm:hidden">
      <AnimatedToggleGroup
        variant="secondary"
        size="xs"
        items={mobilePeriods}
        value={selectedPeriod}
        onValueChange={onPeriodSelect}
      />
    </div>
  </>
);

export default function IncomePage() {
  const [selectedPeriod, setSelectedPeriod] = useState<"TOTAL" | "YTD" | "LAST_YEAR">("TOTAL");
  const { isBalanceHidden } = useBalancePrivacy();
  const [isFilterSheetOpen, setIsFilterSheetOpen] = useState(false);

  const [accountFilter, setAccountScope] = useState<AccountScope>({ type: "all" });

  const incomeFilter = accountFilter.type === "all" ? undefined : accountFilter;

  const {
    data: incomeData,
    isLoading,
    error,
  } = useQuery<IncomeSummary[], Error>({
    queryKey: [QueryKeys.INCOME_SUMMARY, incomeFilter ?? "ALL"],
    queryFn: () => getIncomeSummary(incomeFilter),
  });

  if (isLoading) {
    return <IncomeDashboardSkeleton />;
  }

  if (error || !incomeData) {
    return <div>Failed to load income summary: {error?.message || "Unknown error"}</div>;
  }

  const periodSummary = incomeData.find((summary) => summary.period === selectedPeriod);
  const totalSummary = incomeData.find((summary) => summary.period === "TOTAL");

  if (!periodSummary || !totalSummary) {
    return (
      <>
        <div className="pointer-events-auto fixed right-2 top-4 z-20 hidden items-center gap-2 md:flex lg:right-4">
          <AccountScopeSelector value={accountFilter} onChange={setAccountScope} />
          <IncomePeriodSelector
            selectedPeriod={selectedPeriod}
            onPeriodSelect={setSelectedPeriod}
          />
        </div>
        <div className="flex items-center justify-end gap-2 md:hidden">
          <IncomePeriodSelector
            selectedPeriod={selectedPeriod}
            onPeriodSelect={setSelectedPeriod}
          />
          <Button
            variant="outline"
            size="icon"
            className="bg-secondary/30 relative h-9 w-9 rounded-full border-none"
            onClick={() => setIsFilterSheetOpen(true)}
          >
            <Icons.ListFilter className="h-4 w-4" />
            {accountFilter.type !== "all" && (
              <span className="bg-destructive absolute -right-1 -top-1 h-2 w-2 rounded-full" />
            )}
          </Button>
        </div>
        <EmptyPlaceholder
          className="mx-auto flex max-w-[420px] items-center justify-center pt-12"
          icon={<Icons.DollarSign className="h-10 w-10" />}
          title="No income data available"
          description="There is no income data for the selected period. Try selecting a different time range or check back later."
        />
        <IncomeMobileFilterSheet
          open={isFilterSheetOpen}
          onOpenChange={setIsFilterSheetOpen}
          accountFilter={accountFilter}
          onAccountScopeChange={setAccountScope}
        />
      </>
    );
  }

  const { totalIncome, currency, monthlyAverage, byType, byCurrency } = periodSummary;
  const dividendIncome = byType.DIVIDEND || 0;
  const interestIncome = byType.INTEREST || 0;
  const dividendPercentage = totalIncome > 0 ? (dividendIncome / totalIncome) * 100 : 0;
  const interestPercentage = totalIncome > 0 ? (interestIncome / totalIncome) * 100 : 0;

  const topDividendStocks = Object.values(periodSummary.byAsset)
    .filter((asset) => asset.income > 0)
    .sort((a, b) => b.income - a.income)
    .slice(0, 10);

  const monthlyIncomeData: [string, number][] = Object.entries(periodSummary.byMonth)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(selectedPeriod === "TOTAL" ? 0 : -12)
    .map(([month, income]) => [month, Number(income) || 0]);

  const getPreviousPeriodData = (currentMonth: string): number => {
    const [year, month] = currentMonth.split("-");
    const previousYear = parseInt(year) - 1;
    const previousMonth = month;

    if (selectedPeriod === "YTD") {
      return totalSummary.byMonth[`${previousYear}-${month}`] || 0;
    } else if (selectedPeriod === "LAST_YEAR") {
      return (
        incomeData.find((summary) => summary.period === "TWO_YEARS_AGO")?.byMonth[
          `${previousYear}-${month}`
        ] || 0
      );
    }

    const previousYearMonth = `${previousYear}-${previousMonth}`;
    const previousIncome = totalSummary.byMonth[previousYearMonth];
    return Number(previousIncome) || 0;
  };

  const previousMonthlyIncomeData: [string, number][] = monthlyIncomeData.map(([month]) => [
    month,
    getPreviousPeriodData(month),
  ]);

  const previousMonthlyAverage =
    previousMonthlyIncomeData.length > 0
      ? previousMonthlyIncomeData.reduce((sum, [, value]) => {
          const numericValue = Number(value) || 0;
          return sum + numericValue;
        }, 0) / previousMonthlyIncomeData.length
      : 0;

  const currentMonthlyAverageNumber = Number(monthlyAverage) || 0;

  const monthlyAverageChange =
    previousMonthlyAverage > 0
      ? (currentMonthlyAverageNumber - previousMonthlyAverage) / previousMonthlyAverage
      : 0;

  const currencyData = Object.entries(byCurrency).map(([currency, amount]) => ({
    currency,
    amount: Number(amount) || 0,
  }));

  return (
    <>
      {/* Desktop: fixed header with account selector + period toggle */}
      <div className="pointer-events-auto fixed right-2 top-4 z-20 hidden items-center gap-2 md:flex lg:right-4">
        <AccountScopeSelector value={accountFilter} onChange={setAccountScope} />
        <IncomePeriodSelector selectedPeriod={selectedPeriod} onPeriodSelect={setSelectedPeriod} />
      </div>

      <div className="space-y-6">
        {/* Mobile: filter icon button + period toggle */}
        <div className="flex items-center justify-end gap-2 md:hidden">
          <IncomePeriodSelector
            selectedPeriod={selectedPeriod}
            onPeriodSelect={setSelectedPeriod}
          />
          <Button
            variant="outline"
            size="icon"
            className="bg-secondary/30 relative h-9 w-9 rounded-full border-none"
            onClick={() => setIsFilterSheetOpen(true)}
          >
            <Icons.ListFilter className="h-4 w-4" />
            {accountFilter.type !== "all" && (
              <span className="bg-destructive absolute -right-1 -top-1 h-2 w-2 rounded-full" />
            )}
          </Button>
        </div>
        <div className="grid gap-6 md:grid-cols-3">
          <Card className="border-yellow-500/10 bg-yellow-500/10">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">
                {selectedPeriod === "TOTAL"
                  ? "All Time Income"
                  : selectedPeriod === "LAST_YEAR"
                    ? "Last Year Income"
                    : "This Year Income"}
              </CardTitle>
              <Icons.DollarSign className="text-muted-foreground h-4 w-4" />
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-2xl font-bold">
                    <AmountDisplay
                      value={totalIncome}
                      currency={currency}
                      isHidden={isBalanceHidden}
                    />
                  </div>
                  <div className="justify-start text-xs">
                    {periodSummary.yoyGrowth !== null ? (
                      <div className="flex items-center text-xs">
                        <GainPercent
                          value={periodSummary.yoyGrowth}
                          className="text-left text-xs"
                          animated={true}
                        />
                        <span className="text-muted-foreground ml-2 text-xs">
                          Year-over-year growth
                        </span>
                      </div>
                    ) : (
                      <p className="text-muted-foreground text-xs">
                        Cumulative income since inception
                      </p>
                    )}
                  </div>
                </div>
                <div className="h-16 w-16">
                  <ChartContainer
                    config={currencyData.reduce(
                      (acc: Record<string, { label: string; color: string }>, item, index) => {
                        acc[item.currency] = {
                          label: item.currency,
                          color: `var(--chart-${index})`,
                        };
                        return acc;
                      },
                      {},
                    )}
                    className="mx-auto aspect-square max-h-[62px]"
                  >
                    <PieChart>
                      <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel />} />
                      <Pie data={currencyData} dataKey="amount" nameKey="currency" paddingAngle={4}>
                        {currencyData.map((_entry, index) => (
                          <Cell key={`cell-${index}`} fill={`var(--chart-${index + 2})`} />
                        ))}
                      </Pie>
                    </PieChart>
                  </ChartContainer>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className="border-yellow-500/10 bg-yellow-500/10">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Monthly Average</CardTitle>
              <Icons.DollarSign className="text-muted-foreground h-4 w-4" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                <AmountDisplay
                  value={currentMonthlyAverageNumber}
                  currency={currency}
                  isHidden={isBalanceHidden}
                />
              </div>
              <div className="flex items-center text-xs">
                <GainPercent value={monthlyAverageChange} className="text-left text-xs" />
                <span className="text-muted-foreground ml-2 text-xs">Since last period</span>
              </div>
            </CardContent>
          </Card>
          <Card className="border-yellow-500/10 bg-yellow-500/10">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Income Sources</CardTitle>
              <Icons.PieChart className="text-muted-foreground h-4 w-4" />
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {[
                  {
                    name: "Dividends",
                    amount: (
                      <AmountDisplay
                        value={dividendIncome}
                        currency={currency}
                        isHidden={isBalanceHidden}
                      />
                    ),
                    percentage: dividendPercentage,
                  },
                  {
                    name: "Interest",
                    amount: (
                      <AmountDisplay
                        value={interestIncome}
                        currency={currency}
                        isHidden={isBalanceHidden}
                      />
                    ),
                    percentage: interestPercentage,
                  },
                ].map((source, index) => {
                  const chartColor = `var(--chart-${index + 1})`;
                  return (
                    <div key={index} className="flex items-center">
                      <div className="w-full">
                        <div className="mb-0 flex justify-between">
                          <span className="text-xs">{source.name}</span>
                          <span className="text-muted-foreground text-xs">{source.amount}</span>
                        </div>
                        <div
                          className="relative h-4 w-full rounded-full"
                          style={{
                            backgroundColor: `color-mix(in srgb, ${chartColor} 20%, transparent)`,
                          }}
                        >
                          <div
                            className="text-background flex h-4 items-center justify-center rounded-full text-xs"
                            style={{
                              width: `${source.percentage}%`,
                              backgroundColor: chartColor,
                            }}
                          >
                            {source.percentage > 0 ? `${source.percentage.toFixed(1)}%` : ""}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </div>
        <div className="grid gap-6 md:grid-cols-3">
          <IncomeHistoryChart
            monthlyIncomeData={monthlyIncomeData}
            previousMonthlyIncomeData={previousMonthlyIncomeData}
            selectedPeriod={selectedPeriod}
            currency={currency}
            isBalanceHidden={isBalanceHidden}
            byAccount={periodSummary.byAccount}
          />
          <Card className="flex flex-col">
            <CardHeader>
              <CardTitle className="text-sm font-medium">Top 10 Dividend Sources</CardTitle>
            </CardHeader>
            <CardContent className="flex-1 overflow-auto">
              {topDividendStocks.length === 0 ? (
                <EmptyPlaceholder
                  className="mx-auto flex h-[300px] max-w-[420px] items-center justify-center"
                  icon={<Icons.DollarSign className="h-10 w-10" />}
                  title="No dividend income recorded"
                  description="There are no dividend sources for the selected period. Try selecting a different time range or check back later."
                />
              ) : (
                <div className="space-y-6">
                  {/* Horizontal Bar Chart - Separated Bars */}
                  <div className="flex w-full space-x-0.5">
                    {(() => {
                      const top5Stocks = topDividendStocks.slice(0, 5);
                      const otherStocks = topDividendStocks.slice(5);
                      const otherTotal = otherStocks.reduce((sum, asset) => sum + asset.income, 0);

                      const chartItems = [
                        ...top5Stocks.map((asset) => ({
                          symbol: asset.symbol,
                          companyName: asset.name,
                          income: asset.income,
                          isOther: false,
                        })),
                        ...(otherTotal > 0
                          ? [
                              {
                                symbol: "Other",
                                companyName: `${otherStocks.length} other sources`,
                                income: otherTotal,
                                isOther: true,
                              },
                            ]
                          : []),
                      ];

                      const colors = [
                        "var(--chart-1)",
                        "var(--chart-2)",
                        "var(--chart-3)",
                        "var(--chart-4)",
                        "var(--chart-5)",
                        "var(--chart-6)",
                      ];

                      return chartItems.map((item, index) => {
                        const percentage =
                          dividendIncome > 0 ? (item.income / dividendIncome) * 100 : 0;

                        return (
                          <div
                            key={index}
                            className="group relative h-5 cursor-pointer rounded-lg transition-all duration-300 ease-in-out hover:brightness-110"
                            style={{
                              width: `${percentage}%`,
                              backgroundColor: colors[index % colors.length],
                            }}
                          >
                            {/* Tooltip */}
                            <div className="absolute bottom-full left-1/2 mb-2 hidden -translate-x-1/2 transform group-hover:block">
                              <div className="bg-popover text-popover-foreground min-w-[180px] rounded-lg border px-3 py-2 shadow-md">
                                <div className="text-sm font-medium">{item.symbol}</div>
                                <div className="text-muted-foreground text-xs">
                                  {item.companyName}
                                </div>
                                <div className="text-sm font-medium">
                                  <PrivacyAmount value={item.income} currency={currency} />
                                </div>
                                <div className="text-muted-foreground text-xs">
                                  {percentage.toFixed(1)}% of total
                                </div>
                                {/* Tooltip arrow */}
                                <div className="border-t-border absolute left-1/2 top-full h-0 w-0 -translate-x-1/2 transform border-l-4 border-r-4 border-t-4 border-l-transparent border-r-transparent"></div>
                              </div>
                            </div>
                          </div>
                        );
                      });
                    })()}
                  </div>

                  {topDividendStocks.map((asset) => (
                    <div key={asset.assetId} className="flex items-center justify-between">
                      <div className="flex items-center">
                        <Badge className="bg-primary mr-2 flex min-w-[55px] items-center justify-center rounded-sm text-xs">
                          {asset.symbol}
                        </Badge>
                        <span className="text-muted-foreground mr-16 text-xs">{asset.name}</span>
                      </div>
                      <div className="text-success text-sm">
                        <PrivacyAmount value={asset.income} currency={currency} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <IncomeMobileFilterSheet
        open={isFilterSheetOpen}
        onOpenChange={setIsFilterSheetOpen}
        accountFilter={accountFilter}
        onAccountScopeChange={setAccountScope}
      />
    </>
  );
}

function IncomeDashboardSkeleton() {
  return (
    <div className="bg-background flex h-full flex-col">
      <main className="flex-1 space-y-6 px-4 py-6 md:px-6">
        <div className="grid gap-6 md:grid-cols-3">
          {[...Array(3)].map((_, index) => (
            <Card key={index}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <Skeleton className="h-4 w-[100px]" />
                <Skeleton className="h-4 w-4" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-8 w-[150px]" />
                <Skeleton className="mt-2 h-4 w-[100px]" />
              </CardContent>
            </Card>
          ))}
        </div>
        <div className="grid gap-6 md:grid-cols-2">
          <Card>
            <CardHeader>
              <Skeleton className="h-6 w-[150px]" />
              <Skeleton className="h-4 w-[100px]" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-[300px] w-full" />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <Skeleton className="h-6 w-[200px]" />
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {[...Array(10)].map((_, index) => (
                  <div key={index} className="flex items-center justify-between">
                    <Skeleton className="h-4 w-[100px]" />
                    <Skeleton className="h-4 w-[80px]" />
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
