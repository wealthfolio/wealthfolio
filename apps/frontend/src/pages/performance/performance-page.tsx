import { BenchmarkSymbolSelector } from "@/components/benchmark-symbol-selector";
import {
  ANNUALIZED_RETURN_INFO as annualizedReturnInfo,
  MAX_DRAWDOWN_INFO as maxDrawdownInfo,
  MetricLabelWithInfo,
  MODIFIED_DIETZ_RETURN_INFO,
  PRICE_RETURN_INFO,
  SIMPLE_RETURN_INFO,
  TIME_WEIGHTED_RETURN_INFO,
  VOLATILITY_INFO as volatilityInfo,
} from "@/components/metric-display";
import { PerformanceChart } from "@/components/performance-chart";
import { PerformanceChartMobile } from "@/components/performance-chart-mobile";

import { PERFORMANCE_CHART_COLORS } from "@/components/performance-chart-colors";
import { EmptyPlaceholder } from "@wealthfolio/ui/components/ui/empty-placeholder";
import { useAccounts } from "@/hooks/use-accounts";
import { usePersistentState } from "@/hooks/use-persistent-state";
import { useIsMobileViewport } from "@/hooks/use-platform";
import { AccountPurpose, PORTFOLIO_SCOPE_ID } from "@/lib/constants";
import { DateRange, PerformanceMetrics, ReturnData, TrackedItem } from "@/lib/types";
import { cn } from "@/lib/utils";
import NumberFlow from "@number-flow/react";
import {
  AlertFeedback,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Carousel,
  CarouselContent,
  CarouselItem,
  DateRangeSelector,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  GainPercent,
  Icons,
  Separator,
} from "@wealthfolio/ui";
import { subMonths } from "date-fns";
import { useEffect, useMemo, useState } from "react";
import { AccountSelector } from "../../components/account-selector";
import { AccountSelectorMobile } from "../../components/account-selector-mobile";
import { BenchmarkSymbolSelectorMobile } from "../../components/benchmark-symbol-selector-mobile";
import { useCalculatePerformanceHistory } from "./hooks/use-performance-data";
import {
  ALL_PORTFOLIO_ITEM,
  migratePerformanceSelectedItemId,
  migratePerformanceSelectedItems,
} from "./performance-selection";

// Define the type expected by the chart
interface ChartDataItem {
  id: string;
  name: string;
  returns: ReturnData[];
}

// Define the actual structure returned by the hook
interface PerformanceDataFromHook extends PerformanceMetrics {
  name: string;
  type: "account" | "symbol";
}

type ReturnMethod = NonNullable<PerformanceMetrics["returnMethod"]>;

function returnMethodPresentation(method: ReturnMethod | undefined): {
  label: string;
  mobileLabel: string;
  infoText: string;
} {
  switch (method) {
    case "modifiedDietz":
      return {
        label: "Modified Dietz",
        mobileLabel: "Dietz",
        infoText: MODIFIED_DIETZ_RETURN_INFO,
      };
    case "simpleReturn":
      return {
        label: "Simple Return",
        mobileLabel: "Simple",
        infoText: SIMPLE_RETURN_INFO,
      };
    case "symbolPriceBased":
      return {
        label: "Price Return",
        mobileLabel: "Price",
        infoText: PRICE_RETURN_INFO,
      };
    case "timeWeighted":
      return {
        label: "Time-Weighted Return",
        mobileLabel: "TWR",
        infoText: TIME_WEIGHTED_RETURN_INFO,
      };
    case "moneyWeighted":
      return {
        label: "Money-Weighted Return",
        mobileLabel: "MWR",
        infoText: MODIFIED_DIETZ_RETURN_INFO,
      };
    case "notApplicable":
    default:
      return {
        label: "Return",
        mobileLabel: "Return",
        infoText: SIMPLE_RETURN_INFO,
      };
  }
}

function selectHeadlineReturn(performance: PerformanceMetrics): number {
  return Number(
    performance.periodReturn ??
      performance.cumulativeModifiedDietz ??
      performance.cumulativeTwr ??
      performance.simpleReturn ??
      0,
  );
}

function selectAnnualizedHeadlineReturn(performance: PerformanceMetrics): number {
  switch (performance.returnMethod) {
    case "modifiedDietz":
      return Number(
        performance.annualizedModifiedDietz ??
          performance.annualizedMwr ??
          performance.annualizedSimpleReturn ??
          performance.periodReturn ??
          0,
      );
    case "simpleReturn":
      return Number(performance.annualizedSimpleReturn ?? performance.periodReturn ?? 0);
    case "symbolPriceBased":
      return Number(performance.annualizedSimpleReturn ?? performance.simpleReturn ?? 0);
    case "timeWeighted":
      return Number(performance.annualizedTwr ?? performance.periodReturn ?? 0);
    default:
      return Number(
        performance.annualizedTwr ??
          performance.annualizedModifiedDietz ??
          performance.annualizedSimpleReturn ??
          performance.periodReturn ??
          0,
      );
  }
}

function PerformanceContent({
  chartData,
  isLoading,
  hasErrors,
  errorMessages,
  isMobile,
}: {
  chartData: ChartDataItem[] | undefined;
  isLoading: boolean;
  hasErrors: boolean;
  errorMessages: string[];
  isMobile: boolean;
}) {
  return (
    <div className="relative flex h-full w-full flex-col">
      {chartData && chartData.length > 0 && (
        <div className="min-h-0 w-full flex-1">
          {isMobile ? (
            <PerformanceChartMobile data={chartData} />
          ) : (
            <PerformanceChart data={chartData} />
          )}
        </div>
      )}

      {!chartData?.length && !isLoading && !hasErrors && (
        <EmptyPlaceholder
          className="mx-auto flex max-w-[420px] items-center justify-center"
          icon={<Icons.BarChart className="h-10 w-10" />}
          title="No performance data"
          description="Select accounts to compare their performance over time."
        />
      )}

      {/* Modern horizontal loader with improved UX */}
      {isLoading && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <div className="animate-subtle-pulse absolute inset-0 border-2 border-transparent">
            <div className="animate-progress-border bg-primary absolute left-0 top-0 h-[2px]"></div>
          </div>
          <div className="absolute bottom-4 right-4">
            <div className="bg-background/80 rounded-md border px-3 py-1.5 shadow-sm backdrop-blur-sm">
              <p className="text-muted-foreground flex items-center text-xs font-medium">
                <span className="bg-primary mr-2 inline-block h-2 w-2 animate-pulse rounded-full"></span>
                Calculating...
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Error display using AlertFeedback component */}
      {hasErrors && (
        <div className="w-full">
          <AlertFeedback title="Error calculating performance data" variant="error">
            <div>
              {errorMessages.map((error, index) => (
                <p key={index} className="text-sm">
                  {error}
                </p>
              ))}
            </div>
            <div className="mt-4 flex justify-end">
              <Button size="sm" onClick={() => window.location.reload()} variant="default">
                Retry
              </Button>
            </div>
          </AlertFeedback>
        </div>
      )}
    </div>
  );
}

const SelectedItemBadge = ({
  item,
  isSelected,
  onSelect,
  onDelete,
  color,
}: {
  item: TrackedItem;
  isSelected: boolean;
  onSelect: () => void;
  onDelete: (e: React.MouseEvent) => void;
  color?: string;
}) => {
  return (
    <Badge
      className={cn(
        "text-foreground group relative cursor-pointer rounded-md px-2.5 py-1.5 shadow-sm transition-all sm:px-3",
        "hover:bg-accent/80 hover:shadow-md",
        "focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
        isSelected && "bg-warning/20 hover:bg-warning/30",
      )}
      onClick={onSelect}
      role="button"
      variant="secondary"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      aria-pressed={isSelected}
    >
      <div className="flex items-center space-x-2 sm:space-x-3">
        <div
          className={cn(
            "h-3 w-1 rounded-full sm:h-4",
            color
              ? "transition-opacity group-hover:opacity-80"
              : item.type === "account"
                ? "bg-muted-foreground group-hover:bg-foreground transition-colors"
                : "bg-orange-500 transition-colors group-hover:bg-orange-600 dark:bg-orange-400",
          )}
          style={color ? { backgroundColor: color } : undefined}
        />
        <span className="group-hover:text-foreground text-xs font-medium transition-colors sm:text-sm">
          {item.name}
        </span>
      </div>
      <Button
        variant="ghost"
        size="icon-xs"
        className={cn(
          "ml-2 size-5 transition-all duration-150",
          "hover:bg-destructive/10 hover:text-destructive hover:scale-110",
          "focus-visible:ring-destructive/50 focus-visible:ring-2",
        )}
        onClick={onDelete}
        aria-label={`Remove ${item.name}`}
      >
        <Icons.Close className="h-3 w-3 sm:h-3.5 sm:w-3.5" />
      </Button>
    </Badge>
  );
};

export default function PerformancePage() {
  const isMobile = useIsMobileViewport();
  const [storedSelectedItems, setSelectedItems] = usePersistentState<TrackedItem[]>(
    "performance:selectedItems",
    [ALL_PORTFOLIO_ITEM],
  );
  const [storedSelectedItemId, setSelectedItemId] = usePersistentState<string | null>(
    "performance:selectedItemId",
    null,
  );
  const [dateRange, setDateRange] = usePersistentState<DateRange | undefined>(
    "performance:dateRange",
    {
      from: subMonths(new Date(), 12),
      to: new Date(),
    },
  );
  const { accounts, isLoading: isAccountsLoading } = useAccounts({
    accountPurpose: AccountPurpose.PERFORMANCE,
  });

  // State for mobile dropdown menu
  const [accountSheetOpen, setAccountSheetOpen] = useState(false);
  const [benchmarkSheetOpen, setBenchmarkSheetOpen] = useState(false);
  const selectedItems = useMemo(
    () => migratePerformanceSelectedItems(storedSelectedItems),
    [storedSelectedItems],
  );
  const selectedItemId = migratePerformanceSelectedItemId(storedSelectedItemId);

  useEffect(() => {
    if (selectedItems !== storedSelectedItems) {
      setSelectedItems(selectedItems);
    }
  }, [selectedItems, setSelectedItems, storedSelectedItems]);

  useEffect(() => {
    if (selectedItemId !== storedSelectedItemId) {
      setSelectedItemId(selectedItemId);
    }
  }, [selectedItemId, setSelectedItemId, storedSelectedItemId]);

  useEffect(() => {
    if (isAccountsLoading) {
      return;
    }
    const reportAccountIds = new Set(accounts.map((account) => account.id));
    // User-created portfolios resolve to account ids at calc time, so we keep
    // them regardless of `reportAccountIds`; the backend filter handles it.
    const isPortfolioItem = (item: TrackedItem) => item.accountScope?.type === "portfolio";
    setSelectedItems((current) => {
      const next = current.filter(
        (item) =>
          item.type !== "account" ||
          item.id === PORTFOLIO_SCOPE_ID ||
          isPortfolioItem(item) ||
          reportAccountIds.has(item.id),
      );
      if (next.length === current.length) {
        return current;
      }
      return next.length > 0 ? next : [ALL_PORTFOLIO_ITEM];
    });
    const selectedItemStillPresent =
      !selectedItemId ||
      selectedItems.some(
        (item) =>
          item.id === selectedItemId &&
          (item.type !== "account" ||
            item.id === PORTFOLIO_SCOPE_ID ||
            isPortfolioItem(item) ||
            reportAccountIds.has(item.id)),
      );
    if (!selectedItemStillPresent) {
      setSelectedItemId(null);
    }
  }, [
    accounts,
    isAccountsLoading,
    selectedItemId,
    selectedItems,
    setSelectedItemId,
    setSelectedItems,
  ]);

  // Helper function to sort comparison items (accounts first, then symbols)
  const sortComparisonItems = (items: TrackedItem[]): TrackedItem[] => {
    return [...items].sort((a, b) => {
      // Sort by type first (accounts before symbols)
      if (a.type !== b.type) {
        return a.type === "account" ? -1 : 1;
      }
      // If same type, maintain original order
      return 0;
    });
  };

  // Use the custom hook for parallel data fetching with effective date calculation
  const {
    data: performanceData,
    isLoading: isLoadingPerformance,
    hasErrors,
    errorMessages,
    displayDateRange,
  } = useCalculatePerformanceHistory({
    selectedItems,
    dateRange,
  });

  // Calculate derived chart data
  const chartData = useMemo(() => {
    if (!performanceData || !selectedItems) return [];

    return (
      performanceData
        // Update type predicate to use the more accurate type
        .filter(
          (item): item is PerformanceDataFromHook =>
            item !== null && typeof item.id === "string" && Array.isArray(item.returns),
        )
        .map(
          (perfItem): ChartDataItem => ({
            id: perfItem.id,
            name: perfItem.name, // Can now safely access name from perfItem
            returns: perfItem.returns,
          }),
        )
    );
  }, [performanceData, selectedItems]);

  const chartColorMap = useMemo(() => {
    const map = new Map<string, string>();
    chartData.forEach((series, index) => {
      map.set(series.id, PERFORMANCE_CHART_COLORS[index % PERFORMANCE_CHART_COLORS.length]);
    });
    return map;
  }, [chartData]);

  // Calculate selected item data
  const selectedItemData = useMemo(() => {
    if (!performanceData?.length || !selectedItems) return null;
    const targetId = selectedItemId ?? performanceData.find((item) => item !== null)?.id; // Find first non-null item ID if none selected
    if (!targetId) return null;
    const found = performanceData.find((item) => item?.id === targetId);
    if (!found) return null;
    const name = selectedItems.find((item) => item.id === found.id)?.name ?? "Unknown";
    return {
      id: found.id,
      name: name,
      totalReturn: selectHeadlineReturn(found),
      annualizedReturn: selectAnnualizedHeadlineReturn(found),
      volatility: Number(found.volatility),
      maxDrawdown: Number(found.maxDrawdown),
      ...returnMethodPresentation(found.returnMethod),
      warnings: found.warnings ?? [],
    };
  }, [selectedItemId, performanceData, selectedItems]);

  const handleAccountSelect = (account: { id: string; name: string }) => {
    const accountId = String(account.id);
    const exists = selectedItems.some((item) => item.id === accountId);

    if (exists) {
      const nextItems = sortComparisonItems(selectedItems.filter((item) => item.id !== accountId));
      setSelectedItems(nextItems);
      if (selectedItemId === accountId) {
        setSelectedItemId(null);
      }
      return;
    }

    const newItem: TrackedItem = {
      id: accountId,
      type: "account",
      name: account.name,
      accountScope:
        accountId === PORTFOLIO_SCOPE_ID ? { type: "all" } : { type: "account", accountId },
    };

    setSelectedItems(sortComparisonItems([...selectedItems, newItem]));
    setSelectedItemId(accountId);
  };

  const handlePortfolioSelect = (portfolio: { id: string; name: string }) => {
    const portfolioId = String(portfolio.id);
    const exists = selectedItems.some((item) => item.id === portfolioId);

    if (exists) {
      const nextItems = sortComparisonItems(
        selectedItems.filter((item) => item.id !== portfolioId),
      );
      setSelectedItems(nextItems);
      if (selectedItemId === portfolioId) {
        setSelectedItemId(null);
      }
      return;
    }

    // Tracked as an "account" so it lands in the chart's account-series path,
    // but the scope filter expands it to the portfolio's member account ids
    // at calc time (handled by the Rust `calculate_performance_history` cmd).
    const newItem: TrackedItem = {
      id: portfolioId,
      type: "account",
      name: portfolio.name,
      accountScope: { type: "portfolio", portfolioId },
    };

    setSelectedItems(sortComparisonItems([...selectedItems, newItem]));
    setSelectedItemId(portfolioId);
  };

  const handleSymbolSelect = (symbol: { id: string; name: string }) => {
    const symbolId = String(symbol.id);
    const exists = selectedItems.some((item) => item.id === symbolId);
    if (exists) return;

    const newSymbol: TrackedItem = {
      id: symbolId,
      type: "symbol",
      name: symbol.name,
    };

    setSelectedItems(sortComparisonItems([...selectedItems, newSymbol]));
    setSelectedItemId(symbolId);
  };

  const handleBadgeSelect = (item: TrackedItem) => {
    setSelectedItemId(selectedItemId === item.id ? null : item.id);
  };

  const handleBadgeDelete = (e: React.MouseEvent, item: TrackedItem) => {
    e.stopPropagation();
    if (item.type === "account") {
      handleAccountSelect({ id: item.id, name: item.name });
    } else {
      setSelectedItems((prev) => sortComparisonItems(prev.filter((i) => i.id !== item.id)));
    }
    if (selectedItemId === item.id) {
      setSelectedItemId(null);
    }
  };

  return (
    <>
      {/* Date range selector - fixed position in header area */}
      <div className="pointer-events-auto fixed right-2 top-4 z-20 hidden md:block lg:right-4">
        <DateRangeSelector value={dateRange} onChange={setDateRange} />
      </div>

      <div className="flex h-full flex-col space-y-4">
        <div className="flex justify-end md:hidden">
          <DateRangeSelector value={dateRange} onChange={setDateRange} />
        </div>

        {/* Mobile: Carousel + Plus button in same row */}
        <div className="flex items-center gap-2 md:hidden">
          {/* Selected items badges carousel */}
          {selectedItems.length > 0 && (
            <Carousel
              opts={{
                align: "start",
                loop: false,
              }}
              className="flex-1"
            >
              <CarouselContent className="-ml-2">
                {selectedItems.map((item) => (
                  <CarouselItem key={item.id} className="basis-auto pl-2">
                    <SelectedItemBadge
                      item={item}
                      isSelected={selectedItemId === item.id}
                      onSelect={() => handleBadgeSelect(item)}
                      onDelete={(e) => handleBadgeDelete(e, item)}
                      color={chartColorMap.get(item.id)}
                    />
                  </CarouselItem>
                ))}
              </CarouselContent>
            </Carousel>
          )}

          {/* Mobile: Plus button with dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                className="bg-secondary/30 hover:bg-muted/80 size-9 flex-shrink-0 rounded-md border-[1.5px] border-none"
                aria-label="Add item"
              >
                <Icons.Plus className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onSelect={() => setAccountSheetOpen(true)} className="py-4 md:py-2">
                <Icons.Briefcase className="mr-2 h-4 w-4" />
                Add Account
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => setBenchmarkSheetOpen(true)}
                className="py-4 md:py-2"
              >
                <Icons.TrendingUp className="mr-2 h-4 w-4" />
                Add Benchmark
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Desktop: Full layout with separator */}
        <div className="hidden md:flex md:flex-row md:items-center">
          {/* Selected items badges - horizontal scroll carousel */}
          {selectedItems.length > 0 && (
            <div className="flex items-center gap-3">
              <Carousel
                opts={{
                  align: "start",
                  loop: false,
                }}
                className="w-full max-w-[calc(100vw-24rem)] md:max-w-[calc(100vw-28rem)]"
              >
                <CarouselContent className="-ml-2">
                  {selectedItems.map((item) => (
                    <CarouselItem key={item.id} className="basis-auto pl-2">
                      <SelectedItemBadge
                        item={item}
                        isSelected={selectedItemId === item.id}
                        onSelect={() => handleBadgeSelect(item)}
                        onDelete={(e) => handleBadgeDelete(e, item)}
                        color={chartColorMap.get(item.id)}
                      />
                    </CarouselItem>
                  ))}
                </CarouselContent>
              </Carousel>

              {/* Separator */}
              <Separator orientation="vertical" className="h-6 flex-shrink-0" />
            </div>
          )}

          {/* Desktop: Full text buttons */}
          <div className="flex flex-shrink-0 items-center gap-2">
            <AccountSelector
              setSelectedAccount={handleAccountSelect}
              variant="button"
              buttonText="Add account"
              includePortfolio={true}
              accountPurpose={AccountPurpose.PERFORMANCE}
              onPortfolioSelect={handlePortfolioSelect}
            />
            <BenchmarkSymbolSelector onSelect={handleSymbolSelect} />
          </div>
        </div>

        {/* Mobile sheets controlled by dropdown - rendered but hidden by Sheet component */}
        <AccountSelectorMobile
          setSelectedAccount={(account) => {
            handleAccountSelect(account);
            setAccountSheetOpen(false);
          }}
          includePortfolio={true}
          accountPurpose={AccountPurpose.PERFORMANCE}
          open={accountSheetOpen}
          onOpenChange={setAccountSheetOpen}
          className="hidden"
          onPortfolioSelect={(portfolio) => {
            handlePortfolioSelect(portfolio);
            setAccountSheetOpen(false);
          }}
        />
        <BenchmarkSymbolSelectorMobile
          onSelect={(symbol) => {
            handleSymbolSelect(symbol);
            setBenchmarkSheetOpen(false);
          }}
          open={benchmarkSheetOpen}
          onOpenChange={setBenchmarkSheetOpen}
          className="hidden"
        />

        <div className="flex h-[calc(100vh-19rem)] flex-col md:h-[calc(100vh-12rem)]">
          <Card className="flex min-h-0 flex-1 flex-col">
            <CardHeader className={cn("pb-2", isMobile ? "px-3 py-3" : "pb-1")}>
              <div className={cn("space-y-3", isMobile ? "space-y-2" : "sm:space-y-4")}>
                <div className="flex flex-col space-y-3 sm:flex-row sm:items-center sm:justify-between sm:space-y-0">
                  <div>
                    <CardTitle className={cn("text-lg sm:text-xl", isMobile && "text-sm")}>
                      Performance
                    </CardTitle>
                    <CardDescription
                      className={cn("text-xs sm:text-sm", isMobile && "text-[10px]")}
                    >
                      {displayDateRange}
                    </CardDescription>
                  </div>
                  {performanceData && performanceData.length > 0 && (
                    <>
                      {/* Mobile compact metrics - horizontal scroll */}
                      {isMobile ? (
                        <Carousel
                          opts={{
                            align: "start",
                            loop: false,
                          }}
                          className="w-full"
                        >
                          <CarouselContent className="-ml-2 md:-ml-4">
                            <CarouselItem className="basis-[38%] pl-2 md:pl-4">
                              <div className="bg-muted/30 flex flex-col gap-0.5 rounded-lg px-3 py-2">
                                <span className="text-muted-foreground text-[9px] font-medium uppercase tracking-wide">
                                  {selectedItemData?.mobileLabel ?? "Return"}
                                </span>
                                <span
                                  className={cn(
                                    "text-base font-bold",
                                    selectedItemData && selectedItemData.totalReturn >= 0
                                      ? "text-success"
                                      : "text-destructive",
                                  )}
                                >
                                  <GainPercent
                                    value={selectedItemData?.totalReturn ?? 0}
                                    animated={true}
                                    className="text-base"
                                  />
                                </span>
                              </div>
                            </CarouselItem>

                            <CarouselItem className="basis-[38%] pl-2 md:pl-4">
                              <div className="bg-muted/30 flex flex-col gap-0.5 rounded-lg px-3 py-2">
                                <span className="text-muted-foreground text-[9px] font-medium uppercase tracking-wide">
                                  Annualized
                                </span>
                                <span
                                  className={cn(
                                    "text-base font-bold",
                                    selectedItemData && selectedItemData.annualizedReturn >= 0
                                      ? "text-success"
                                      : "text-destructive",
                                  )}
                                >
                                  <GainPercent
                                    value={selectedItemData?.annualizedReturn ?? 0}
                                    animated={true}
                                    className="text-base"
                                  />
                                </span>
                              </div>
                            </CarouselItem>

                            <CarouselItem className="basis-[38%] pl-2 md:pl-4">
                              <div className="bg-muted/30 flex flex-col gap-0.5 rounded-lg px-3 py-2">
                                <span className="text-muted-foreground text-[9px] font-medium uppercase tracking-wide">
                                  Volatility
                                </span>
                                <span className="text-foreground text-base font-bold">
                                  <NumberFlow
                                    value={selectedItemData?.volatility ?? 0}
                                    animated={true}
                                    format={{
                                      style: "percent",
                                      maximumFractionDigits: 2,
                                    }}
                                  />
                                </span>
                              </div>
                            </CarouselItem>

                            <CarouselItem className="basis-[38%] pl-2 md:pl-4">
                              <div className="bg-muted/30 flex flex-col gap-0.5 rounded-lg px-3 py-2">
                                <span className="text-muted-foreground text-[9px] font-medium uppercase tracking-wide">
                                  Max Drawdown
                                </span>
                                <span className="text-destructive text-base font-bold">
                                  <NumberFlow
                                    value={(selectedItemData?.maxDrawdown ?? 0) * -1}
                                    animated={true}
                                    format={{
                                      style: "percent",
                                      maximumFractionDigits: 2,
                                    }}
                                  />
                                </span>
                              </div>
                            </CarouselItem>
                          </CarouselContent>
                        </Carousel>
                      ) : (
                        /* Desktop metrics */
                        <div className="grid grid-cols-2 gap-3 rounded-lg p-2 backdrop-blur-sm sm:gap-4 md:grid-cols-4 md:gap-6">
                          <div className="flex flex-col items-center space-y-0.5 sm:space-y-1">
                            <MetricLabelWithInfo
                              label={selectedItemData?.label ?? "Return"}
                              infoText={selectedItemData?.infoText ?? SIMPLE_RETURN_INFO}
                            />
                            <div className="flex items-baseline justify-center">
                              <span
                                className={`text-base sm:text-lg ${
                                  selectedItemData && selectedItemData.totalReturn >= 0
                                    ? "text-success"
                                    : "text-destructive"
                                }`}
                              >
                                <GainPercent
                                  value={selectedItemData?.totalReturn ?? 0}
                                  animated={true}
                                  className="text-base sm:text-lg"
                                />
                              </span>
                            </div>
                          </div>

                          <div className="flex flex-col items-center space-y-0.5 sm:space-y-1">
                            <MetricLabelWithInfo
                              label="Annualized Return"
                              infoText={annualizedReturnInfo}
                            />
                            <div className="flex items-baseline justify-center">
                              <span
                                className={`text-base sm:text-lg ${
                                  selectedItemData && selectedItemData.annualizedReturn >= 0
                                    ? "text-success"
                                    : "text-destructive"
                                }`}
                              >
                                <GainPercent
                                  value={selectedItemData?.annualizedReturn ?? 0}
                                  animated={true}
                                  className="text-base sm:text-lg"
                                />
                              </span>
                            </div>
                          </div>

                          <div className="flex flex-col items-center space-y-0.5 sm:space-y-1">
                            <MetricLabelWithInfo label="Volatility" infoText={volatilityInfo} />
                            <div className="flex items-baseline justify-center">
                              <span className="text-foreground text-base sm:text-lg">
                                <NumberFlow
                                  value={selectedItemData?.volatility ?? 0}
                                  animated={true}
                                  format={{
                                    style: "percent",
                                    maximumFractionDigits: 2,
                                  }}
                                />
                              </span>
                            </div>
                          </div>

                          <div className="flex flex-col items-center space-y-0.5 sm:space-y-1">
                            <MetricLabelWithInfo label="Max Drawdown" infoText={maxDrawdownInfo} />
                            <div className="flex items-baseline justify-center">
                              <span className="text-destructive text-base sm:text-lg">
                                <NumberFlow
                                  value={(selectedItemData?.maxDrawdown ?? 0) * -1}
                                  animated={true}
                                  format={{
                                    style: "percent",
                                    maximumFractionDigits: 2,
                                  }}
                                />
                              </span>
                            </div>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            </CardHeader>
            <CardContent className={cn("min-h-0 flex-1", isMobile ? "p-2" : "p-3 sm:p-6")}>
              {!!selectedItemData?.warnings.length && (
                <AlertFeedback title="Performance calculation note" variant="warning">
                  <div>
                    {selectedItemData.warnings.map((warning) => (
                      <p key={warning} className="text-sm">
                        {warning}
                      </p>
                    ))}
                  </div>
                </AlertFeedback>
              )}
              <PerformanceContent
                chartData={chartData}
                isLoading={isLoadingPerformance}
                hasErrors={hasErrors}
                errorMessages={errorMessages}
                isMobile={isMobile}
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
