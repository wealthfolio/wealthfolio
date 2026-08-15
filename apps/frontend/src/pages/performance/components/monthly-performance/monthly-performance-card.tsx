import React, { useEffect, useMemo, useState } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Skeleton,
  Icons,
  cn,
} from "@wealthfolio/ui";
import { useTranslation } from "react-i18next";
import type { DateRange, ReturnData } from "@/lib/types";
import {
  calculateMonthlyReturns,
  buildMonthlyComparison,
  type MonthlyViewMode,
} from "../../monthly-performance-utils";
import { MonthlyPerformanceChart } from "./monthly-performance-chart";
import { MonthlyPerformanceTable } from "./monthly-performance-table";

export interface MonthlyPerformanceCardProps {
  portfolioSeries: ReturnData[] | undefined;
  portfolioName: string;
  benchmarkSeries?: ReturnData[] | undefined;
  benchmarkName?: string;
  dateRange?: DateRange | undefined;
  isLoading?: boolean;
  className?: string;
}

export const MonthlyPerformanceCard: React.FC<MonthlyPerformanceCardProps> = ({
  portfolioSeries,
  portfolioName,
  benchmarkSeries,
  benchmarkName,
  dateRange,
  isLoading,
  className,
}) => {
  const { t } = useTranslation();
  const [viewMode, setViewMode] = useState<MonthlyViewMode>("portfolio");
  const [selectedYear, setSelectedYear] = useState<number | null>(null);

  // Compute monthly comparison data across full history
  const comparisonData = useMemo(() => {
    if (!portfolioSeries?.length) return [];
    const portfolioMonthly = calculateMonthlyReturns(portfolioSeries);
    const benchmarkMonthly = benchmarkSeries?.length
      ? calculateMonthlyReturns(benchmarkSeries)
      : undefined;
    return buildMonthlyComparison(portfolioMonthly, benchmarkMonthly);
  }, [portfolioSeries, benchmarkSeries]);

  // Filter years according to the selected dateRange (while keeping each selected year complete)
  const filteredComparisonData = useMemo(() => {
    if (!comparisonData.length) return [];
    const startYear = dateRange?.from ? dateRange.from.getFullYear() : undefined;
    const endYear = dateRange?.to ? dateRange.to.getFullYear() : undefined;

    const filtered = comparisonData.filter((row) => {
      if (startYear !== undefined && row.year < startYear) return false;
      if (endYear !== undefined && row.year > endYear) return false;
      return true;
    });

    return filtered.length > 0 ? filtered : comparisonData;
  }, [comparisonData, dateRange]);

  // Set default selected year to latest available year in the filtered range
  useEffect(() => {
    if (filteredComparisonData.length > 0) {
      if (selectedYear === null || !filteredComparisonData.some((d) => d.year === selectedYear)) {
        setSelectedYear(filteredComparisonData[0].year);
      }
    }
  }, [filteredComparisonData, selectedYear]);

  const hasBenchmark = Boolean(benchmarkSeries && benchmarkSeries.length > 0 && benchmarkName);

  // If benchmark is removed and viewMode was benchmark/relative, reset to portfolio
  useEffect(() => {
    if (!hasBenchmark && (viewMode === "benchmark" || viewMode === "relative")) {
      setViewMode("portfolio");
    }
  }, [hasBenchmark, viewMode]);

  const activeYearData = useMemo(() => {
    if (!filteredComparisonData.length || selectedYear === null) return null;
    return filteredComparisonData.find((d) => d.year === selectedYear) ?? filteredComparisonData[0];
  }, [filteredComparisonData, selectedYear]);

  if (isLoading) {
    return (
      <Card className={cn("overflow-hidden", className)}>
        <CardHeader className="flex flex-row items-center justify-between pb-2 pt-5">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-8 w-44" />
        </CardHeader>
        <CardContent className="space-y-6 pt-2">
          <Skeleton className="h-48 w-full rounded-lg" />
          <div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!comparisonData.length || !activeYearData) {
    return null;
  }

  return (
    <Card className={cn("overflow-hidden", className)}>
      <CardHeader className="flex flex-col gap-3 pb-2 pt-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <CardTitle className="text-lg font-bold tracking-tight sm:text-xl">
            {t("performance:monthly.title")}
          </CardTitle>
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground inline-flex h-4 w-4 items-center justify-center transition-colors"
                aria-label={t("performance:monthly.info")}
              >
                <Icons.HelpCircle className="h-4 w-4" />
              </button>
            </PopoverTrigger>
            <PopoverContent side="top" align="start" className="max-w-xs text-xs">
              {t("performance:monthly.info")}
            </PopoverContent>
          </Popover>
        </div>

        {/* View Mode Toggle when Benchmark is present */}
        {hasBenchmark && (
          <div className="bg-muted/40 inline-flex items-center rounded-lg p-1 text-xs">
            <Button
              variant={viewMode === "portfolio" ? "secondary" : "ghost"}
              size="sm"
              className={cn(
                "h-7 rounded-md px-2.5 text-xs font-medium",
                viewMode === "portfolio" && "bg-background text-foreground shadow-xs",
              )}
              onClick={() => setViewMode("portfolio")}
            >
              {portfolioName || t("performance:monthly.view_portfolio")}
            </Button>
            <Button
              variant={viewMode === "benchmark" ? "secondary" : "ghost"}
              size="sm"
              className={cn(
                "h-7 rounded-md px-2.5 text-xs font-medium",
                viewMode === "benchmark" && "bg-background text-foreground shadow-xs",
              )}
              onClick={() => setViewMode("benchmark")}
            >
              {benchmarkName || t("performance:monthly.view_benchmark")}
            </Button>
            <Button
              variant={viewMode === "relative" ? "secondary" : "ghost"}
              size="sm"
              className={cn(
                "h-7 rounded-md px-2.5 text-xs font-medium",
                viewMode === "relative" && "bg-background text-foreground shadow-xs",
              )}
              onClick={() => setViewMode("relative")}
            >
              {t("performance:monthly.view_relative")}
            </Button>
          </div>
        )}
      </CardHeader>

      <CardContent className="space-y-4 pt-2">
        {/* Top Monthly Bar Chart */}
        <MonthlyPerformanceChart
          year={activeYearData.year}
          months={activeYearData.months}
          viewMode={viewMode}
          portfolioName={portfolioName}
          benchmarkName={benchmarkName}
        />

        {/* Bottom Monthly Table Matrix */}
        <MonthlyPerformanceTable
          data={filteredComparisonData}
          selectedYear={activeYearData.year}
          onSelectYear={setSelectedYear}
          viewMode={viewMode}
        />
      </CardContent>
    </Card>
  );
};
