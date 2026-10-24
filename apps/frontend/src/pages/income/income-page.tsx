import { getIncomeSummary } from "@/adapters";
import { Badge } from "@wealthfolio/ui/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@wealthfolio/ui/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@wealthfolio/ui/components/ui/chart";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@wealthfolio/ui/components/ui/empty";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { AccountScopeSelector } from "@/components/account-filter-selector";
import { useAccountScopeStore } from "@/lib/account-scope-store";

import { QueryKeys } from "@/lib/query-keys";
import type { IncomeSummary } from "@/lib/types";
import { useQuery } from "@tanstack/react-query";
import {
  AmountDisplay,
  AnimatedToggleGroup,
  GainPercent,
  PrivacyAmount,
  useAmountFormatting,
} from "@wealthfolio/ui";
import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { Cell, Pie, PieChart } from "recharts";
import { IncomeHistoryChart } from "./income-history-chart";
import { UnconvertedCurrenciesNotice } from "./unconverted-currencies-notice";

type IncomePeriod = "ALL" | "YTD" | "LAST_YEAR";

const IncomePeriodSelector: React.FC<{
  selectedPeriod: IncomePeriod;
  onPeriodSelect: (period: IncomePeriod) => void;
}> = ({ selectedPeriod, onPeriodSelect }) => {
  const { t } = useTranslation();

  const periods = [
    { value: "YTD" as const, label: t("income:year_to_date") },
    { value: "LAST_YEAR" as const, label: t("income:last_year") },
    { value: "ALL" as const, label: t("income:all_time") },
  ];

  const mobilePeriods = [
    { value: "YTD" as const, label: t("income:ytd") },
    { value: "LAST_YEAR" as const, label: t("income:last_yr") },
    { value: "ALL" as const, label: t("income:all") },
  ];

  return (
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
};

export default function IncomePage() {
  const { t } = useTranslation();
  const [selectedPeriod, setSelectedPeriod] = useState<IncomePeriod>("ALL");
  const { isBalanceHidden } = useBalancePrivacy();
  const amountFormatting = useAmountFormatting();

  const accountFilter = useAccountScopeStore((state) => state.scope);
  const setAccountScope = useAccountScopeStore((state) => state.setScope);

  const {
    data: incomeData,
    isLoading,
    error,
  } = useQuery<IncomeSummary[], Error>({
    queryKey: [QueryKeys.INCOME_SUMMARY, accountFilter],
    queryFn: () => getIncomeSummary(accountFilter),
  });

  // Keep the selector mounted as queries change so multi-selection can continue
  // through loading, empty, populated and error states.
  const filters = (
    <>
      <div className="pointer-events-auto fixed end-2 top-4 z-20 hidden items-center gap-2 md:flex lg:end-4">
        <AccountScopeSelector value={accountFilter} onChange={setAccountScope} />
        <IncomePeriodSelector selectedPeriod={selectedPeriod} onPeriodSelect={setSelectedPeriod} />
      </div>
      <div className="mb-6 flex items-center justify-end gap-2 md:hidden">
        <IncomePeriodSelector selectedPeriod={selectedPeriod} onPeriodSelect={setSelectedPeriod} />
        <AccountScopeSelector value={accountFilter} onChange={setAccountScope} />
      </div>
    </>
  );

  if (isLoading) {
    return (
      <>
        {filters}
        <IncomeDashboardSkeleton />
      </>
    );
  }

  if (error || !incomeData) {
    return (
      <>
        {filters}
        <div>
          {t("income:failed_to_load", { error: error?.message || t("income:unknown_error") })}
        </div>
      </>
    );
  }

  const periodSummary = incomeData.find((summary) => summary.period === selectedPeriod);
  const totalSummary = incomeData.find((summary) => summary.period === "ALL");

  if (!periodSummary || !totalSummary) {
    return (
      <>
        {filters}
        <Empty className="max-w-105 mx-auto flex items-center justify-center pt-12">
          <EmptyHeader>
            <EmptyMedia variant="icon">{<Icons.DollarSign className="size-10" />}</EmptyMedia>
            <EmptyTitle>{t("income:no_income_data")}</EmptyTitle>
            <EmptyDescription>{t("income:no_income_data_desc")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  const { totalIncome, currency, monthlyAverage, byType, byCurrency, byCurrencyBase } =
    periodSummary;
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
    .slice(selectedPeriod === "ALL" ? 0 : -12)
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

  // Compare the server-computed monthly averages. All Time has no previous period.
  const previousPeriod =
    selectedPeriod === "YTD"
      ? "LAST_YEAR"
      : selectedPeriod === "LAST_YEAR"
        ? "TWO_YEARS_AGO"
        : null;
  const previousMonthlyAverage =
    Number(incomeData.find((summary) => summary.period === previousPeriod)?.monthlyAverage) || 0;

  const currentMonthlyAverageNumber = Number(monthlyAverage) || 0;

  const monthlyAverageChange =
    previousMonthlyAverage > 0
      ? (currentMonthlyAverageNumber - previousMonthlyAverage) / previousMonthlyAverage
      : null;

  // Shown instead of a change when the earlier period has nothing to compare
  // with: no income, only income without an exchange rate, or an average that
  // rounds to zero.
  const noComparisonLabel =
    selectedPeriod === "LAST_YEAR"
      ? t("income:no_comparison_year_before")
      : t("income:no_comparison_last_year");

  // Only converted income gets a slice: income without an exchange rate has
  // none, and a zero-sized slice would still add padding to the pie.
  const currencyData = Object.entries(byCurrencyBase)
    .map(([currency, baseAmount]) => ({
      currency,
      amount: Number(byCurrency[currency]) || 0,
      baseAmount: Number(baseAmount) || 0,
    }))
    .filter(({ baseAmount }) => baseAmount > 0);

  return (
    <>
      {filters}
      <div className="space-y-6">
        <UnconvertedCurrenciesNotice
          currencies={periodSummary.unconvertedCurrencies}
          baseCurrency={currency}
        />
        <div className="grid gap-6 md:grid-cols-3">
          <Card className="border-warning/10 bg-warning/10">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">
                {selectedPeriod === "ALL"
                  ? t("income:all_time_income")
                  : selectedPeriod === "LAST_YEAR"
                    ? t("income:last_year_income")
                    : t("income:this_year_income")}
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
                          className="text-start text-xs"
                          animated={true}
                        />
                        <span className="text-muted-foreground ms-2 text-xs">
                          {t("income:year_over_year")}
                        </span>
                      </div>
                    ) : (
                      <p className="text-muted-foreground text-xs">
                        {selectedPeriod === "ALL"
                          ? t("income:cumulative_income")
                          : noComparisonLabel}
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
                    className="max-h-15.5 mx-auto aspect-square"
                  >
                    <PieChart>
                      <ChartTooltip
                        cursor={false}
                        content={
                          <ChartTooltipContent
                            hideLabel
                            // Slices are sized in the base currency; show each currency's own amount.
                            formatter={(_value, name, entry) => {
                              const slice = entry.payload as
                                | { amount?: number; fill?: string }
                                | undefined;
                              const color = slice?.fill ?? entry.color;
                              return (
                                <>
                                  <div
                                    className="border-border bg-(--color-bg) h-2.5 w-2.5 shrink-0 rounded-[2px]"
                                    style={
                                      {
                                        "--color-bg": color,
                                        "--color-border": color,
                                      } as React.CSSProperties
                                    }
                                  />
                                  <div className="flex flex-1 items-center justify-between gap-2 leading-none">
                                    <span className="text-muted-foreground">{name}</span>
                                    <span className="text-foreground font-mono font-medium tabular-nums">
                                      {isBalanceHidden
                                        ? "••••"
                                        : amountFormatting.formatDecimalAmount(
                                            Number(slice?.amount),
                                            String(name),
                                          )}
                                    </span>
                                  </div>
                                </>
                              );
                            }}
                          />
                        }
                      />
                      <Pie
                        data={currencyData}
                        dataKey="baseAmount"
                        nameKey="currency"
                        paddingAngle={4}
                      >
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
          <Card className="border-warning/10 bg-warning/10">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">{t("income:monthly_average")}</CardTitle>
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
              {monthlyAverageChange !== null ? (
                <div className="flex items-center text-xs">
                  <GainPercent value={monthlyAverageChange} className="text-start text-xs" />
                  <span className="text-muted-foreground ms-2 text-xs">
                    {t("income:since_last_period_label")}
                  </span>
                </div>
              ) : (
                <p className="text-muted-foreground text-xs">
                  {selectedPeriod === "ALL"
                    ? t("income:average_since_inception")
                    : noComparisonLabel}
                </p>
              )}
            </CardContent>
          </Card>
          <Card className="border-warning/10 bg-warning/10">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">{t("income:income_sources")}</CardTitle>
              <Icons.PieChart className="text-muted-foreground h-4 w-4" />
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {[
                  {
                    name: t("income:dividends"),
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
                    name: t("income:interest"),
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
              <CardTitle className="text-sm font-medium">
                {t("income:top_10_dividend_sources")}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex-1 overflow-auto">
              {topDividendStocks.length === 0 ? (
                <Empty className="h-75 max-w-105 mx-auto flex items-center justify-center">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      {<Icons.DollarSign className="size-10" />}
                    </EmptyMedia>
                    <EmptyTitle>{t("income:no_dividend_income_recorded")}</EmptyTitle>
                    <EmptyDescription>{t("income:no_dividend_sources_desc")}</EmptyDescription>
                  </EmptyHeader>
                </Empty>
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
                                symbol: t("income:other"),
                                companyName: t("income:other_sources_count", {
                                  count: otherStocks.length,
                                }),
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
                              backgroundColor: item.isOther
                                ? "var(--chart-stone)"
                                : colors[index % colors.length],
                            }}
                          >
                            {/* Tooltip */}
                            <div className="absolute bottom-full left-1/2 mb-2 hidden -translate-x-1/2 transform group-hover:block">
                              <div className="bg-popover text-popover-foreground min-w-45 rounded-lg border px-3 py-2 shadow-md">
                                <div className="text-sm font-medium">{item.symbol}</div>
                                <div className="text-muted-foreground text-xs">
                                  {item.companyName}
                                </div>
                                <div className="text-sm font-medium">
                                  <PrivacyAmount value={item.income} currency={currency} />
                                </div>
                                <div className="text-muted-foreground text-xs">
                                  {t("income:percent_of_total", {
                                    percent: percentage.toFixed(1),
                                  })}
                                </div>
                                {/* Tooltip arrow */}
                                <div className="border-t-border absolute left-1/2 top-full h-0 w-0 -translate-x-1/2 transform border-e-4 border-s-4 border-t-4 border-e-transparent border-s-transparent"></div>
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
                        <Badge className="bg-primary me-2 flex min-w-[3.4375rem] items-center justify-center rounded-sm text-xs">
                          {asset.symbol}
                        </Badge>
                        <span className="text-muted-foreground me-16 text-xs">
                          <bdi>{asset.name}</bdi>
                        </span>
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
                <Skeleton className="w-25 h-4" />
                <Skeleton className="h-4 w-4" />
              </CardHeader>
              <CardContent>
                <Skeleton className="w-37.5 h-8" />
                <Skeleton className="w-25 mt-2 h-4" />
              </CardContent>
            </Card>
          ))}
        </div>
        <div className="grid gap-6 md:grid-cols-2">
          <Card>
            <CardHeader>
              <Skeleton className="w-37.5 h-6" />
              <Skeleton className="w-25 h-4" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-75 w-full" />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <Skeleton className="w-50 h-6" />
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {[...Array(10)].map((_, index) => (
                  <div key={index} className="flex items-center justify-between">
                    <Skeleton className="w-25 h-4" />
                    <Skeleton className="h-4 w-20" />
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
