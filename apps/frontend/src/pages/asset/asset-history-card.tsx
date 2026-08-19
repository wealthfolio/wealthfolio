import { searchActivities } from "@/adapters";
import HistoryChart, {
  type HistoryChartActivity,
  type HistoryChartActivityMarker,
  type HistoryChartData,
} from "@/components/history-chart-symbol";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { useSyncMarketDataMutation } from "@/hooks/use-sync-market-data";
import { QueryKeys } from "@/lib/query-keys";
import { ActivityDetails, DateRange, Quote, TimePeriod } from "@/lib/types";
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
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
  Icons,
  IntervalSelector,
  PriceDisplay,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  useDateFormatting,
  useNumberFormatting,
} from "@wealthfolio/ui";
import { format, subMonths } from "date-fns";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ASSET_MARKER_ACTIVITY_TYPES,
  activityMarkerLabel,
  activityMarkerTone,
  activityMarkerVariant,
  isAssetMarkerActivity,
} from "./asset-history-markers";
import { RefreshQuotesConfirmDialog } from "./refresh-quotes-confirm-dialog";

const SHOW_ACTIVITY_MARKERS_STORAGE_KEY = "history-chart-show-activity-markers";

interface AssetHistoryProps {
  marketPrice: number;
  totalGainAmount: number;
  totalGainPercent: number;
  currency: string;
  quoteHistory: Quote[];
  assetId: string;
  averageCost?: number;
  className?: string;
}

const AssetHistoryCard: React.FC<AssetHistoryProps> = ({
  marketPrice,
  totalGainAmount,
  totalGainPercent,
  currency,
  quoteHistory,
  assetId,
  averageCost,
  className,
}) => {
  const numberFormatting = useNumberFormatting();
  const dateFormatting = useDateFormatting();

  const { t } = useTranslation();
  const syncMarketDataMutation = useSyncMarketDataMutation(true);
  const { isBalanceHidden } = useBalancePrivacy();
  const [refreshConfirmOpen, setRefreshConfirmOpen] = useState(false);
  const [showActivityMarkers, setShowActivityMarkers] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(SHOW_ACTIVITY_MARKERS_STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(SHOW_ACTIVITY_MARKERS_STORAGE_KEY, String(showActivityMarkers));
    } catch {
      // localStorage unavailable (e.g. private browsing); the toggle just won't persist.
    }
  }, [showActivityMarkers]);
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
  const { data: markerActivities = [], isLoading: isMarkerActivitiesLoading } =
    useAssetMarkerActivities({
      assetId,
      dateFrom: activityDateFrom,
      dateTo: activityDateTo,
      enabled: showActivityMarkers,
    });
  const { chartData, activityMarkers } = useMemo(
    () => buildChartActivityData(filteredData, showActivityMarkers ? markerActivities : []),
    [filteredData, showActivityMarkers, markerActivities],
  );
  const selectedDateActivities = useMemo(() => {
    if (!selectedActivityDate) return [];
    return markerActivities.filter((activity) => dateKey(activity) === selectedActivityDate);
  }, [selectedActivityDate, markerActivities]);

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
                    <PriceDisplay
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
                    (
                    {percentage == null
                      ? t("asset:historyCard.na")
                      : numberFormatting.formatPercent(percentage)}
                    ) {selectedIntervalDesc}
                  </p>
                </div>
              </HoverCardTrigger>
              <HoverCardContent align="start" className="w-80 shadow-none">
                <div className="flex flex-col space-y-4">
                  <div className="space-y-2">
                    <h4 className="flex text-sm font-light">
                      <Icons.Calendar className="mr-2 h-4 w-4" />
                      {t("asset:historyCard.as_of")}{" "}
                      <Badge className="ml-1 font-medium" variant="secondary">
                        {calculatedAt ? dateFormatting.formatDateTime(new Date(calculatedAt)) : "-"}
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
                    {syncMarketDataMutation.isPending
                      ? t("asset:historyCard.refreshing_quotes")
                      : t("asset:historyCard.refresh_quotes")}
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
                      showActivityMarkers
                        ? t("asset:historyCard.hide_activity_markers")
                        : t("asset:historyCard.show_activity_markers")
                    }
                  >
                    <Icons.History className="size-5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>
                    {showActivityMarkers
                      ? t("asset:historyCard.hide")
                      : t("asset:historyCard.show")}{" "}
                    {t("asset:historyCard.activity_markers_suffix")}
                  </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </CardHeader>
        <CardContent className="relative flex-1 p-0">
          <HistoryChart
            data={chartData}
            activityMarkers={activityMarkers}
            averageCost={showActivityMarkers && !isBalanceHidden ? averageCost : undefined}
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
        isLoading={isMarkerActivitiesLoading}
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

function useAssetMarkerActivities({
  assetId,
  dateFrom,
  dateTo,
  enabled,
}: UseAssetTradeActivitiesOptions) {
  return useQuery({
    queryKey: [QueryKeys.ACTIVITY_DATA, "asset-activity-markers", assetId, dateFrom, dateTo],
    queryFn: () => fetchAssetMarkerActivities({ assetId, dateFrom, dateTo }),
    enabled: enabled && assetId.length > 0,
  });
}

async function fetchAssetMarkerActivities({
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
        activityTypes: [...ASSET_MARKER_ACTIVITY_TYPES],
        needsReview: false,
      },
      "",
      { id: "date", desc: false },
    );
    activities.push(
      ...response.data.filter((activity) => isAssetMarkerActivity(activity, assetId)),
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
      variant: activityMarkerVariant(activity.activityType),
      markerLabel: activityMarkerLabel(activity.activityType),
      markerTone: activityMarkerTone(activity.activityType),
      activityType: activity.activityType,
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
        markerLabel: activity.markerLabel,
        markerTone: activity.markerTone,
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

export default AssetHistoryCard;
