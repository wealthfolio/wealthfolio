import { HistoryChart } from "@/components/history-chart";
import { getPrivateAssetHistoricalSeries } from "@/adapters";
import { useHapticFeedback } from "@/hooks";
import { useNetWorth, useNetWorthHistory } from "@/hooks/use-alternative-assets";
import { useHoldings } from "@/hooks/use-holdings";
import { usePrivateAssetsEnabled } from "@/hooks/use-private-assets-enabled";
import { useValuationHistory } from "@/hooks/use-valuation-history";
import { HoldingType, isAlternativeAssetKind, type AssetKind } from "@/lib/constants";
import { QueryKeys } from "@/lib/query-keys";
import { useSettingsContext } from "@/lib/settings-provider";
import {
  DateRange,
  TimePeriod,
  type NetWorthHistoryPoint,
  type PrivateAssetHistoricalPoint,
} from "@/lib/types";
import { formatDateISO } from "@/lib/utils";
import { PortfolioUpdateTrigger } from "@/pages/dashboard/portfolio-update-trigger";
import { useQuery } from "@tanstack/react-query";
import type { TimePeriod as UITimePeriod } from "@wealthfolio/ui";
import {
  GainAmount,
  GainPercent,
  getInitialIntervalData,
  IntervalSelector,
  usePersistentState,
} from "@wealthfolio/ui";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import { useMemo, useState } from "react";
import { AccountsSummary } from "./accounts-summary";
import Balance from "./balance";
import SavingGoals from "./goals";
import TopHoldings from "./top-holdings";

const DEFAULT_INTERVAL: UITimePeriod = "3M";
const INTERVAL_STORAGE_KEY = "dashboard-interval";
const INVESTMENT_CATEGORY_KEYS = new Set(["cash", "investments", "privateAssets"]);

interface DashboardHistoryPoint {
  date: string;
  totalValue: number;
  netContribution: number;
  currency: string;
}

function parseDecimal(value: number | string | null | undefined) {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number.parseFloat(value) || 0;
  return 0;
}

function calculateDashboardPerformanceMetrics(
  history: DashboardHistoryPoint[],
  isAllTime = false,
): { gainLossAmount: number; simpleReturn: number } {
  if (!history.length) {
    return { gainLossAmount: 0, simpleReturn: 0 };
  }

  const first = history[0];
  const last = history[history.length - 1];

  const periodNetContribution = last.netContribution - first.netContribution;
  const marketValueChange = last.totalValue - first.totalValue;
  const gainLossAmount = marketValueChange - periodNetContribution;

  if (isAllTime) {
    const totalNetContribution = last.netContribution;
    const gain = last.totalValue - totalNetContribution;

    return {
      gainLossAmount: gain,
      simpleReturn: totalNetContribution !== 0 ? gain / totalNetContribution : 0,
    };
  }

  let twr = 1;
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1];
    const curr = history[i];
    const cashFlow = curr.netContribution - prev.netContribution;

    if (prev.totalValue === 0) {
      continue;
    }

    const dailyReturn = (curr.totalValue - cashFlow) / prev.totalValue;
    twr *= dailyReturn;
  }

  return {
    gainLossAmount,
    simpleReturn: twr - 1,
  };
}

function buildPrivateFlowLookup(history: PrivateAssetHistoricalPoint[]) {
  const sortedHistory = [...history].sort((a, b) => a.asOfDate.localeCompare(b.asOfDate));

  return (date: string) => {
    let carriedContributed = 0;
    let carriedDistributed = 0;

    for (const point of sortedHistory) {
      if (point.asOfDate > date) {
        break;
      }

      carriedContributed = point.totalContributed;
      carriedDistributed = point.totalDistributed;
    }

    return carriedContributed - carriedDistributed;
  };
}

export function DashboardContent() {
  // Use the same persisted state as IntervalSelector for the interval code
  const [intervalCode] = usePersistentState<UITimePeriod>(INTERVAL_STORAGE_KEY, DEFAULT_INTERVAL);

  // Derive initial values from the persisted interval code
  const [dateRange, setDateRange] = useState<DateRange | undefined>(
    () => getInitialIntervalData(intervalCode).range,
  );
  const [selectedIntervalDescription, setSelectedIntervalDescription] = useState<string>(
    () => getInitialIntervalData(intervalCode).description,
  );
  const [isAllTime, setIsAllTime] = useState<boolean>(() => intervalCode === "ALL");

  const { holdings: allHoldings, isLoading: isHoldingsLoading } = useHoldings({ type: "all" });
  const { valuationHistory } = useValuationHistory(dateRange);
  const { data: netWorthData, isLoading: isNetWorthLoading } = useNetWorth();
  const privateAssetsEnabled = usePrivateAssetsEnabled();
  const { triggerHaptic } = useHapticFeedback();

  const historyDates = useMemo(() => {
    const endDate = dateRange?.to ?? new Date();
    const startDate = dateRange?.from ?? new Date("1970-01-01");

    return {
      startDate: formatDateISO(startDate),
      endDate: formatDateISO(endDate),
    };
  }, [dateRange]);

  const { data: netWorthHistory, isLoading: isNetWorthHistoryLoading } = useNetWorthHistory({
    startDate: historyDates.startDate,
    endDate: historyDates.endDate,
    enabled: Boolean(historyDates.startDate && historyDates.endDate),
  });

  const privateHistoryQuery = useQuery<PrivateAssetHistoricalPoint[], Error>({
    queryKey: QueryKeys.privateAssetHistory(true),
    queryFn: () => getPrivateAssetHistoricalSeries(true),
    enabled: privateAssetsEnabled,
  });

  // Filter holdings for display (exclude alternative assets and cash for TopHoldings)
  const holdings = useMemo(() => {
    if (!allHoldings) return [];
    return allHoldings.filter((h) => {
      // Exclude cash holdings from display
      if (h.holdingType === HoldingType.CASH) return false;
      // Exclude alternative assets from display
      if (h.assetKind && isAlternativeAssetKind(h.assetKind as AssetKind)) return false;
      return true;
    });
  }, [allHoldings]);

  const currentValuation = useMemo(() => {
    return valuationHistory && valuationHistory.length > 0
      ? valuationHistory[valuationHistory.length - 1]
      : null;
  }, [valuationHistory]);

  const { settings } = useSettingsContext();
  const baseCurrency = settings?.baseCurrency ?? "USD";

  const dashboardHistory = useMemo((): DashboardHistoryPoint[] => {
    if (!netWorthHistory?.length) {
      return [];
    }

    const getPrivateNetContribution = privateAssetsEnabled
      ? buildPrivateFlowLookup(privateHistoryQuery.data ?? [])
      : () => 0;

    return netWorthHistory.map((point: NetWorthHistoryPoint) => ({
      date: point.date,
      totalValue:
        parseDecimal(point.portfolioValue) +
        (privateAssetsEnabled ? parseDecimal(point.privateAssetsValue) : 0),
      netContribution: parseDecimal(point.netContribution) + getPrivateNetContribution(point.date),
      currency: point.currency || baseCurrency,
    }));
  }, [baseCurrency, netWorthHistory, privateAssetsEnabled, privateHistoryQuery.data]);

  const { gainLossAmount, simpleReturn } = useMemo(
    () => calculateDashboardPerformanceMetrics(dashboardHistory, isAllTime),
    [dashboardHistory, isAllTime],
  );

  const chartData = useMemo(() => {
    return dashboardHistory.map((item) => ({
      date: item.date,
      totalValue: item.totalValue,
      netContribution: item.netContribution,
      currency: item.currency || baseCurrency,
    }));
  }, [baseCurrency, dashboardHistory]);

  const privateAssetsValue = useMemo(() => {
    if (!privateAssetsEnabled) return 0;
    return parseDecimal(
      netWorthData?.assets.breakdown?.find((item) => item.category === "privateAssets")?.value,
    );
  }, [netWorthData, privateAssetsEnabled]);

  const currentPublicHoldingsValue = useMemo(() => {
    if (!allHoldings) return null;

    return allHoldings
      .filter((holding) => !(holding.assetKind && isAlternativeAssetKind(holding.assetKind)))
      .reduce((sum, holding) => sum + (holding.marketValue?.base ?? 0), 0);
  }, [allHoldings]);

  // Keep the headline balance current while chart/performance use the selected
  // historical interval.
  const totalValue = useMemo(() => {
    if (currentPublicHoldingsValue !== null) {
      return currentPublicHoldingsValue + privateAssetsValue;
    }

    if (!netWorthData) return 0;

    return (netWorthData.assets.breakdown ?? [])
      .filter((item) => INVESTMENT_CATEGORY_KEYS.has(item.category))
      .reduce((sum, item) => sum + parseDecimal(item.value), 0);
  }, [currentPublicHoldingsValue, netWorthData, privateAssetsValue]);

  const isNegative = totalValue < 0;
  const isChartLoading =
    isNetWorthHistoryLoading || (privateAssetsEnabled && privateHistoryQuery.isLoading);

  // Callback for IntervalSelector
  const handleIntervalSelect = (
    code: TimePeriod,
    description: string,
    range: DateRange | undefined,
  ) => {
    setSelectedIntervalDescription(description);
    setDateRange(range);
    setIsAllTime(code === "ALL");
  };

  return (
    <div className="flex min-h-full flex-col">
      <div className="px-4 pb-1 pt-2 md:px-6 md:pb-2 lg:px-8">
        <PortfolioUpdateTrigger lastCalculatedAt={currentValuation?.calculatedAt}>
          <div className="flex items-start gap-2">
            <div>
              <Balance
                isLoading={isHoldingsLoading || isNetWorthLoading}
                targetValue={totalValue}
                currency={baseCurrency}
                displayCurrency={true}
              />
              <div className="text-md flex space-x-3">
                {isChartLoading && chartData.length === 0 ? (
                  <div className="flex items-center gap-3 pt-1">
                    <Skeleton className="h-4 w-24" />
                    <div className="border-secondary my-1 border-r pr-2" />
                    <Skeleton className="h-4 w-16" />
                  </div>
                ) : (
                  <>
                    <GainAmount
                      className="lg:text-md text-sm font-light"
                      value={gainLossAmount}
                      currency={baseCurrency}
                      displayCurrency={false}
                    ></GainAmount>
                    <div className="border-secondary my-1 border-r pr-2" />
                    <GainPercent
                      className="lg:text-md text-sm font-light"
                      value={simpleReturn}
                      animated={true}
                    ></GainPercent>
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
          <HistoryChart data={chartData} isLoading={isChartLoading} />
          {chartData.length > 0 && (
            <div className="flex w-full justify-center">
              <IntervalSelector
                className="pointer-events-auto relative z-20 w-full max-w-screen-sm sm:max-w-screen-md md:max-w-2xl lg:max-w-3xl"
                onIntervalSelect={handleIntervalSelect}
                onHaptic={triggerHaptic}
                isLoading={isChartLoading}
                storageKey={INTERVAL_STORAGE_KEY}
                defaultValue={DEFAULT_INTERVAL}
              />
            </div>
          )}
        </div>

        <div className="grow px-4 pb-[calc(var(--mobile-nav-ui-height)+max(var(--mobile-nav-gap),env(safe-area-inset-bottom)))] pt-12 md:px-6 md:pb-6 md:pt-6 lg:px-10 lg:pb-8 lg:pt-8">
          <div className="grid grid-cols-1 gap-8 lg:grid-cols-3 lg:gap-20">
            <div className="lg:col-span-2">
              <AccountsSummary dateRange={dateRange} isAllTime={isAllTime} />
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
