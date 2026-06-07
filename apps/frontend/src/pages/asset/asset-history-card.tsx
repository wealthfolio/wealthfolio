import { searchActivities } from "@/adapters";
import HistoryChart, {
  type HistoryChartActivity,
  type HistoryChartActivityMarker,
  type HistoryChartData,
} from "@/components/history-chart-symbol";
import type { TradeMarkerVariant } from "@/components/history-chart-marker";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { useSyncMarketDataMutation } from "@/hooks/use-sync-market-data";
import { QueryKeys } from "@/lib/query-keys";
import { ActivityDetails, ActivityType, DateRange, Quote, TimePeriod } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ActivityDateSheet } from "@/pages/activity/components/activity-date-sheet";
import { useQuery } from "@tanstack/react-query";
import {
  AmountDisplay,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  formatPercent,
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
  Icons,
  IntervalSelector,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@wealthfolio/ui";
import { format, subMonths } from "date-fns";
import React, { useCallback, useMemo, useState } from "react";
import { RefreshQuotesConfirmDialog } from "./refresh-quotes-confirm-dialog";

interface AssetHistoryProps {
  marketPrice: number;
  totalGainAmount: number;
  totalGainPercent: number;
  currency: string;
  quoteHistory: Quote[];
  assetId: string;
  avgCost?: number;
  className?: string;
}

const AssetHistoryCard: React.FC<AssetHistoryProps> = ({
  marketPrice,
  totalGainAmount,
  totalGainPercent,
  currency,
  quoteHistory,
  assetId,
  avgCost,
  className,
}) => {
  const syncMarketDataMutation = useSyncMarketDataMutation(true);
  const { isBalanceHidden } = useBalancePrivacy();
  const [refreshConfirmOpen, setRefreshConfirmOpen] = useState(false);
  const [showActivityMarkers, setShowActivityMarkers] = useState(false);
  const [selectedActivityDate, setSelectedActivityDate] = useState<string | null>(null);
  const [isActivitySheetOpen, setIsActivitySheetOpen] = useState(false);

  const handleRefreshQuotes = useCallback(() => {
    syncMarketDataMutation.mutate([assetId]);
  }, [syncMarketDataMutation, assetId]);

  const [selectedIntervalCode, setSelectedIntervalCode] = useState<TimePeriod>("3M");
  const [selectedIntervalDesc, setSelectedIntervalDesc] = useState<string>("past 3 months");
  const [dateRange, setDateRange] = useState<DateRange | undefined>({
    from: subMonths(new Date(), 3),
    to: new Date(),
  });

  const filteredData: FilteredData[] = useMemo(() => {
    if (!quoteHistory) return [];

    // Sort quotes chronologically (oldest first) for proper chart display
    const sortedQuotes = [...quoteHistory].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );

    if (!dateRange?.from || !dateRange?.to || selectedIntervalCode === "ALL") {
      return sortedQuotes.map((quote) => ({
        timestamp: quote.timestamp,
        totalValue: quote.close,
        currency: quote.currency || currency,
      }));
    }

    return sortedQuotes
      .filter((quote) => {
        const quoteDate = new Date(quote.timestamp);
        return (
          dateRange.from && dateRange.to && quoteDate >= dateRange.from && quoteDate <= dateRange.to
        );
      })
      .map((quote) => ({
        timestamp: quote.timestamp,
        totalValue: quote.close,
        currency: quote.currency || currency,
      }));
  }, [dateRange, quoteHistory, currency, selectedIntervalCode]);

  const activityDateFrom = dateRange?.from ? format(dateRange.from, "yyyy-MM-dd") : undefined;
  const activityDateTo = dateRange?.to ? format(dateRange.to, "yyyy-MM-dd") : undefined;
  const { data: tradeActivities = [], isLoading: isTradeActivitiesLoading } =
    useAssetTradeActivities({
      assetId,
      dateFrom: activityDateFrom,
      dateTo: activityDateTo,
      enabled: showActivityMarkers,
    });
  const { chartData, activityMarkers } = useMemo(
    () => buildChartActivityData(filteredData, showActivityMarkers ? tradeActivities : []),
    [filteredData, showActivityMarkers, tradeActivities],
  );
  const selectedDateActivities = useMemo(() => {
    if (!selectedActivityDate) return [];
    return tradeActivities.filter((activity) => dateKey(activity) === selectedActivityDate);
  }, [selectedActivityDate, tradeActivities]);

  const { ganAmount, percentage, calculatedAt } = useMemo(() => {
    const lastFilteredDate = filteredData.at(-1)?.timestamp;
    const startValue = filteredData[0]?.totalValue;
    const endValue = filteredData.at(-1)?.totalValue;
    const isValidStartValue = typeof startValue === "number" && startValue !== 0;

    if (selectedIntervalCode === "ALL") {
      if (typeof startValue === "number" && typeof endValue === "number") {
        return {
          ganAmount: endValue - startValue,
          percentage: isValidStartValue ? (endValue - startValue) / startValue : null,
          calculatedAt: lastFilteredDate,
        };
      }

      const lastQuoteDate =
        quoteHistory.length > 0 ? quoteHistory[quoteHistory.length - 1].timestamp : undefined;
      return {
        ganAmount: totalGainAmount,
        percentage: totalGainPercent,
        calculatedAt: lastQuoteDate,
      };
    }

    return {
      ganAmount:
        typeof startValue === "number" && typeof endValue === "number" ? endValue - startValue : 0,
      percentage:
        isValidStartValue && typeof endValue === "number"
          ? (endValue - startValue) / startValue
          : null,
      calculatedAt: lastFilteredDate,
    };
  }, [filteredData, selectedIntervalCode, quoteHistory, totalGainAmount, totalGainPercent]);

  const handleIntervalSelect = (
    code: TimePeriod,
    description: string,
    range: DateRange | undefined,
  ) => {
    setSelectedIntervalCode(code);
    setSelectedIntervalDesc(description);
    setDateRange(range);
  };

  return (
    <>
      <RefreshQuotesConfirmDialog
        open={refreshConfirmOpen}
        onOpenChange={setRefreshConfirmOpen}
        onConfirm={handleRefreshQuotes}
      />
      <Card className={`flex flex-col ${className}`}>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-md">
            <HoverCard>
              <HoverCardTrigger asChild className="cursor-pointer">
                <div>
                  <p className="pt-3 text-xl font-bold">
                    <AmountDisplay
                      value={marketPrice}
                      currency={currency}
                      isHidden={isBalanceHidden}
                    />
                  </p>
                  <p className={`text-sm ${ganAmount > 0 ? "text-success" : "text-destructive"}`}>
                    <AmountDisplay
                      value={ganAmount}
                      currency={currency}
                      isHidden={isBalanceHidden}
                    />{" "}
                    ({percentage == null ? "N/A" : formatPercent(percentage)}){" "}
                    {selectedIntervalDesc}
                  </p>
                </div>
              </HoverCardTrigger>
              <HoverCardContent align="start" className="w-80 shadow-none">
                <div className="flex flex-col space-y-4">
                  <div className="space-y-2">
                    <h4 className="flex text-sm font-light">
                      <Icons.Calendar className="mr-2 h-4 w-4" />
                      As of:{" "}
                      <Badge className="ml-1 font-medium" variant="secondary">
                        {calculatedAt ? `${format(new Date(calculatedAt), "PPpp")}` : "-"}
                      </Badge>
                    </h4>
                  </div>
                  <Button
                    onClick={() => setRefreshConfirmOpen(true)}
                    variant="outline"
                    size="sm"
                    className="rounded-full"
                    disabled={syncMarketDataMutation.isPending}
                  >
                    {syncMarketDataMutation.isPending ? (
                      <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Icons.Refresh className="mr-2 h-4 w-4" />
                    )}
                    {syncMarketDataMutation.isPending ? "Refreshing quotes..." : "Refresh Quotes"}
                  </Button>
                </div>
              </HoverCardContent>
            </HoverCard>
          </CardTitle>
          <div className="mt-2 flex items-center gap-1 self-start">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant={showActivityMarkers ? "default" : "secondary"}
                    size="icon-xs"
                    className={cn("rounded-full", !showActivityMarkers && "bg-secondary/50")}
                    onClick={() => setShowActivityMarkers((current) => !current)}
                    aria-label={
                      showActivityMarkers ? "Hide activity markers" : "Show activity markers"
                    }
                  >
                    <Icons.History className="size-5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{showActivityMarkers ? "Hide" : "Show"} activity markers</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </CardHeader>
        <CardContent className="relative flex-1 p-0">
          <HistoryChart
            data={chartData}
            activityMarkers={activityMarkers}
            avgCost={avgCost}
            onActivityMarkerClick={(marker) => {
              setSelectedActivityDate(dateKey(marker.point));
              setIsActivitySheetOpen(true);
            }}
          />
          <IntervalSelector
            onIntervalSelect={handleIntervalSelect}
            className="absolute bottom-2 left-1/2 -translate-x-1/2 transform"
            isLoading={syncMarketDataMutation.isPending}
            defaultValue="3M"
          />
        </CardContent>
      </Card>
      <ActivityDateSheet
        open={isActivitySheetOpen}
        onOpenChange={setIsActivitySheetOpen}
        date={selectedActivityDate}
        activities={selectedDateActivities}
        isLoading={isTradeActivitiesLoading}
      />
    </>
  );
};

interface FilteredData {
  timestamp: string;
  totalValue: number;
  currency: string;
}

interface UseAssetTradeActivitiesOptions {
  assetId: string;
  dateFrom?: string;
  dateTo?: string;
  enabled: boolean;
}

function useAssetTradeActivities({
  assetId,
  dateFrom,
  dateTo,
  enabled,
}: UseAssetTradeActivitiesOptions) {
  return useQuery({
    queryKey: [QueryKeys.ACTIVITY_DATA, "asset-trade-markers", assetId, dateFrom, dateTo],
    queryFn: () => fetchAssetTradeActivities({ assetId, dateFrom, dateTo }),
    enabled: enabled && assetId.length > 0,
  });
}

async function fetchAssetTradeActivities({
  assetId,
  dateFrom,
  dateTo,
}: {
  assetId: string;
  dateFrom?: string;
  dateTo?: string;
}) {
  const pageSize = 500;
  let page = 0;
  let totalRowCount = 0;
  const activities: ActivityDetails[] = [];

  do {
    const response = await searchActivities(
      page,
      pageSize,
      {
        symbol: assetId,
        dateFrom,
        dateTo,
        activityTypes: [ActivityType.BUY, ActivityType.SELL],
        needsReview: false,
      },
      "",
      { id: "date", desc: false },
    );
    activities.push(
      ...response.data.filter(
        (activity) =>
          activity.assetId === assetId &&
          (activity.activityType === ActivityType.BUY ||
            activity.activityType === ActivityType.SELL),
      ),
    );
    totalRowCount = response.meta.totalRowCount;
    page += 1;
  } while (page * pageSize < totalRowCount);

  return activities;
}

function buildChartActivityData(
  data: FilteredData[],
  activities: ActivityDetails[],
): {
  chartData: HistoryChartData[];
  activityMarkers: HistoryChartActivityMarker[];
} {
  if (activities.length === 0) {
    return { chartData: data, activityMarkers: [] };
  }

  const activitiesByDate = new Map<string, HistoryChartActivity[]>();
  for (const activity of activities) {
    const key = dateKey(activity);
    const chartActivity = {
      id: activity.id,
      variant: tradeMarkerVariant(activity.activityType),
      date: activity.date,
      quantity: activity.quantity,
      unitPrice: activity.unitPrice,
    };
    const existing = activitiesByDate.get(key);
    if (existing) {
      existing.push(chartActivity);
    } else {
      activitiesByDate.set(key, [chartActivity]);
    }
  }

  const chartData: HistoryChartData[] = [];
  const activityMarkers: HistoryChartActivityMarker[] = [];

  data.forEach((point) => {
    const activitiesForPoint = activitiesByDate.get(dateKey(point));

    if (!activitiesForPoint) {
      chartData.push(point);
      return;
    }

    const chartPoint = { ...point, activities: activitiesForPoint };
    chartData.push(chartPoint);
    for (const activity of activitiesForPoint) {
      activityMarkers.push({
        id: activity.id,
        point: chartPoint,
        variant: activity.variant,
      });
    }
  });

  return { chartData, activityMarkers };
}

function dateKey(value: { timestamp: string } | { date?: string | Date }) {
  const date = "timestamp" in value ? value.timestamp : value.date;
  if (!date) return "";
  if (typeof date === "string") return date.slice(0, 10);
  return format(date, "yyyy-MM-dd");
}

function tradeMarkerVariant(activityType: ActivityType): TradeMarkerVariant {
  return activityType === ActivityType.BUY ? "buy" : "sell";
}

export default AssetHistoryCard;
