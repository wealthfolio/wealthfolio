import { calculatePerformanceSummary } from "@/adapters";
import { HistoryChart } from "@/components/history-chart";
import { useHapticFeedback } from "@/hooks";
import { useCurrentValuation } from "@/hooks/use-current-account-valuations";
import { useHoldings } from "@/hooks/use-holdings";
import { useValuationHistory } from "@/hooks/use-valuation-history";
import { useI18n } from "@/i18n/i18n-provider";
import { HoldingType, isAlternativeAssetKind } from "@/lib/constants";
import { performanceSummaryReturn, performancePeriodPnl } from "@/lib/performance";
import { QueryKeys } from "@/lib/query-keys";
import { useSettingsContext } from "@/lib/settings-provider";
import { DateRange, TimePeriod } from "@/lib/types";
import { PortfolioUpdateTrigger } from "@/pages/dashboard/portfolio-update-trigger";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { TimePeriod as UITimePeriod } from "@wealthfolio/ui";
import {
  GainAmount,
  GainPercent,
  getInitialIntervalData,
  IntervalSelector,
  usePersistentState,
} from "@wealthfolio/ui";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import { format } from "date-fns";
import { useEffect, useMemo, useState } from "react";
import { AccountsSummary } from "./accounts-summary";
import Balance from "./balance";
import SavingGoals from "./goals";
import TopHoldings from "./top-holdings";

const DEFAULT_INTERVAL: UITimePeriod = "3M";
const INTERVAL_STORAGE_KEY = "dashboard-interval";

function getDashboardChartMinDomainSpanRatio(period: UITimePeriod): number {
  switch (period) {
    case "1D":
    case "1W":
      return 0.035;
    case "1M":
    case "3M":
      return 0.08;
    case "6M":
    case "YTD":
    case "1Y":
      return 0.16;
    case "5Y":
    case "ALL":
      return 0.2;
    default:
      return 0.12;
  }
}

function getDashboardNetContributionMaxDomainSpanRatio(period: UITimePeriod): number | undefined {
  switch (period) {
    case "1D":
    case "1W":
      return undefined;
    case "1M":
    case "3M":
      return 1.4;
    case "6M":
    case "YTD":
    case "1Y":
      return 2.2;
    case "5Y":
    case "ALL":
      return 2.8;
    default:
      return 1.8;
  }
}

export function DashboardContent() {
  const { language } = useI18n();
  const isChinese = language === "zh-CN";
  // Use the same persisted state as IntervalSelector for the interval code
  const [intervalCode] = usePersistentState<UITimePeriod>(INTERVAL_STORAGE_KEY, DEFAULT_INTERVAL);

  // Derive initial values from the persisted interval code
  const [dateRange, setDateRange] = useState<DateRange | undefined>(
    () => getInitialIntervalData(intervalCode, language).range,
  );
  const [selectedIntervalDescription, setSelectedIntervalDescription] = useState<string>(
    () => getInitialIntervalData(intervalCode, language).description,
  );
  const [selectedInterval, setSelectedInterval] = useState<UITimePeriod>(() => intervalCode);
  const [isAllTime, setIsAllTime] = useState<boolean>(() => intervalCode === "ALL");

  const { holdings: allHoldings, isLoading: isHoldingsLoading } = useHoldings({ type: "all" });
  const {
    currentValuation: portfolioCurrentValuation,
    isLoading: isCurrentValuationLoading,
    error: currentValuationError,
  } = useCurrentValuation({ type: "all" }, { includeAccounts: true });
  const { triggerHaptic } = useHapticFeedback();

  // Filter holdings for display (exclude alternative assets and cash for TopHoldings)
  const holdings = useMemo(() => {
    if (!allHoldings) return [];
    return allHoldings.filter((h) => {
      // Exclude cash holdings from display
      if (h.holdingType === HoldingType.CASH) return false;
      // Exclude alternative assets from display
      if (h.assetKind && isAlternativeAssetKind(h.assetKind)) return false;
      return true;
    });
  }, [allHoldings]);

  const totalValue = portfolioCurrentValuation?.summary.totalValueBase ?? 0;

  const valuationHistoryRange = isAllTime ? undefined : dateRange;
  const { valuationHistory, isLoading: isValuationHistoryLoading } =
    useValuationHistory(valuationHistoryRange);

  const { settings } = useSettingsContext();
  const baseCurrency = settings?.baseCurrency ?? "USD";

  const startDate =
    !isAllTime && dateRange?.from ? format(dateRange.from, "yyyy-MM-dd") : undefined;
  const endDate = !isAllTime && dateRange?.to ? format(dateRange.to, "yyyy-MM-dd") : undefined;
  const datesReady = isAllTime || (!!startDate && !!endDate);

  const { data: portfolioPerformance, isLoading: isPortfolioPerformanceLoading } = useQuery({
    queryKey: [QueryKeys.PERFORMANCE_SUMMARY, "dashboard", "all", startDate, endDate],
    queryFn: () =>
      calculatePerformanceSummary({
        itemType: "account",
        itemId: "portfolio:all",
        startDate,
        endDate,
        filter: { type: "all" },
        profile: "dashboard",
      }),
    enabled: datesReady,
    placeholderData: keepPreviousData,
    staleTime: 30 * 1000,
    retry: 1,
  });

  const gainLossAmount = performancePeriodPnl(portfolioPerformance);
  const simpleReturn = performanceSummaryReturn(portfolioPerformance);
  const isCurrentValuationUnavailable =
    !isCurrentValuationLoading && !portfolioCurrentValuation && Boolean(currentValuationError);
  const portfolioSourceDataAsOf =
    portfolioCurrentValuation?.summary.sourceDataAsOf ??
    (!isCurrentValuationUnavailable
      ? valuationHistory?.[valuationHistory.length - 1]?.calculatedAt
      : undefined);

  const chartData = useMemo(() => {
    return (
      valuationHistory?.map((item) => ({
        date: item.valuationDate,
        totalValue: item.totalValueBase,
        netContribution: item.netContributionBase,
        currency: item.baseCurrency ?? baseCurrency,
      })) ?? []
    );
  }, [valuationHistory, baseCurrency]);

  const chartMinDomainSpanRatio = useMemo(
    () => getDashboardChartMinDomainSpanRatio(selectedInterval),
    [selectedInterval],
  );
  const chartNetContributionMaxDomainSpanRatio = useMemo(
    () => getDashboardNetContributionMaxDomainSpanRatio(selectedInterval),
    [selectedInterval],
  );

  const isNegative = totalValue < 0;

  useEffect(() => {
    setSelectedIntervalDescription(getInitialIntervalData(selectedInterval, language).description);
  }, [language, selectedInterval]);

  // Callback for IntervalSelector
  const handleIntervalSelect = (
    code: TimePeriod,
    description: string,
    range: DateRange | undefined,
  ) => {
    setSelectedInterval(code);
    setSelectedIntervalDescription(description);
    setDateRange(range);
    setIsAllTime(code === "ALL");
  };

  return (
    <div className="flex min-h-full flex-col">
      <div className="px-4 pb-1 pt-2 md:px-6 lg:px-8">
        <PortfolioUpdateTrigger
          lastCalculatedAt={portfolioSourceDataAsOf}
          notices={portfolioCurrentValuation?.summary.warnings}
        >
          <div className="flex items-start gap-2">
            <div>
              <Balance
                isLoading={isCurrentValuationLoading}
                isUnavailable={isCurrentValuationUnavailable}
                targetValue={totalValue}
                currency={baseCurrency}
                displayCurrency={true}
                language={language}
              />
              <div className="text-md flex min-h-5 items-center space-x-3">
                {isPortfolioPerformanceLoading ? (
                  <div className="flex items-center gap-3">
                    <Skeleton className="h-4 w-24" />
                    <div className="border-secondary my-1 border-r pr-2" />
                    <Skeleton className="h-4 w-16" />
                  </div>
                ) : (
                  <>
                    {gainLossAmount == null ? (
                      <span className="text-muted-foreground lg:text-md text-sm font-light">
                        {isChinese ? "暂无" : "N/A"}
                      </span>
                    ) : (
                      <GainAmount
                        className="lg:text-md text-sm font-light"
                        value={gainLossAmount}
                        currency={baseCurrency}
                        displayCurrency={false}
                      />
                    )}
                    <div className="border-secondary my-1 border-r pr-2" />
                    {simpleReturn == null ? (
                      <span className="text-muted-foreground lg:text-md text-sm font-light">
                        {isChinese ? "暂无" : "N/A"}
                      </span>
                    ) : (
                      <GainPercent
                        className="lg:text-md text-sm font-light"
                        value={simpleReturn}
                        animated={true}
                      />
                    )}
                  </>
                )}
                {selectedIntervalDescription && (
                  <span className="lg:text-md text-muted-foreground ml-1 text-sm font-light">
                    {selectedIntervalDescription}
                  </span>
                )}
              </div>
            </div>
          </div>
        </PortfolioUpdateTrigger>
      </div>

      <div
        className={`bg-linear-to-t flex grow flex-col ${
          isNegative
            ? "from-destructive/30 via-destructive/15 to-transparent"
            : "from-success/30 via-success/15 to-transparent"
        }`}
      >
        <div className="h-[280px]">
          <HistoryChart
            data={chartData}
            isLoading={isValuationHistoryLoading}
            scaleMode="fit-visible"
            minDomainSpanRatio={chartMinDomainSpanRatio}
            netContributionMaxDomainSpanRatio={chartNetContributionMaxDomainSpanRatio}
          />
          {valuationHistory && chartData.length > 0 && (
            <div className="flex w-full -translate-y-6 justify-center">
              <IntervalSelector
                className="pointer-events-auto relative z-20 w-full max-w-screen-sm sm:max-w-screen-md md:max-w-2xl lg:max-w-3xl"
                onIntervalSelect={handleIntervalSelect}
                onHaptic={triggerHaptic}
                isLoading={isValuationHistoryLoading}
                storageKey={INTERVAL_STORAGE_KEY}
                defaultValue={DEFAULT_INTERVAL}
                language={language}
              />
            </div>
          )}
        </div>

        <div className="grow px-4 pb-[var(--mobile-nav-total-offset)] pt-12 md:px-6 md:pb-6 md:pt-6 lg:px-10 lg:pb-8 lg:pt-8">
          <div className="grid grid-cols-1 gap-8 lg:grid-cols-3 lg:gap-20">
            <div className="lg:col-span-2">
              <AccountsSummary
                dateRange={dateRange}
                isAllTime={isAllTime}
                currentAccountValuations={portfolioCurrentValuation?.accounts}
                isLoadingCurrentValuations={isCurrentValuationLoading}
              />
            </div>
            <div className="space-y-6 lg:col-span-1">
              <TopHoldings
                holdings={holdings}
                isLoading={isHoldingsLoading}
                baseCurrency={baseCurrency}
              />
              <SavingGoals />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default DashboardContent;
