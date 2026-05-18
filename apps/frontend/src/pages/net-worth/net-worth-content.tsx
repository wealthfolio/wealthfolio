import { useNetWorth, useNetWorthHistory } from "@/hooks/use-alternative-assets";
import { useSettingsContext } from "@/lib/settings-provider";
import type { DateRange } from "@/lib/types";
import { formatDateISO } from "@/lib/utils";
import Balance from "@/pages/dashboard/balance";
import {
  GainAmount,
  GainPercent,
  IntervalSelector,
  PrivacyAmount,
  getInitialIntervalData,
  usePersistentState,
  type TimePeriod,
} from "@wealthfolio/ui";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@wealthfolio/ui/components/ui/collapsible";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@wealthfolio/ui/components/ui/tooltip";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { NetWorthChart } from "./net-worth-chart";

// Goldish orange for net worth theme (matches chart)
const THEME_COLOR = "hsl(38 75% 50%)";
const THEME_COLOR_LIGHT = "hsl(38 75% 50% / 0.12)";

// Color classes for category items (Tailwind classes for dots)
const CATEGORY_COLORS: Record<string, string> = {
  cash: "bg-chart-9",
  investments: "bg-chart-1",
  properties: "bg-chart-2",
  vehicles: "bg-chart-3",
  collectibles: "bg-chart-4",
  preciousMetals: "bg-chart-5",
  otherAssets: "bg-muted-foreground",
  liabilities: "bg-destructive",
};

// CSS variable colors for the composition bar
const CATEGORY_CSS_COLORS: Record<string, string> = {
  cash: "var(--chart-9)",
  investments: "var(--chart-1)",
  properties: "var(--chart-2)",
  vehicles: "var(--chart-3)",
  collectibles: "var(--chart-4)",
  preciousMetals: "var(--chart-5)",
  otherAssets: "var(--muted-foreground)",
  liabilities: "var(--destructive)",
};

/**
 * Balance Sheet Component - Collapsible breakdown of assets and liabilities
 */
interface ParsedNetWorth {
  netWorth: number;
  assets: {
    total: number;
    breakdown: {
      category: string;
      name: string;
      value: number;
      assetId?: string;
    }[];
  };
  liabilities: {
    total: number;
    breakdown: {
      category: string;
      name: string;
      value: number;
      assetId?: string;
    }[];
  };
}

interface BalanceSheetProps {
  data: ParsedNetWorth | null;
  currency: string;
}

function BalanceSheet({ data, currency }: BalanceSheetProps) {
  const [assetsOpen, setAssetsOpen] = useState(true);
  const [liabilitiesOpen, setLiabilitiesOpen] = useState(true);

  if (!data) return null;

  const hasLiabilities = data.liabilities.total > 0 || data.liabilities.breakdown.length > 0;

  return (
    <div className="border-border bg-card shadow-xs rounded-lg border">
      {/* Assets Section */}
      <Collapsible open={assetsOpen} onOpenChange={setAssetsOpen}>
        <CollapsibleTrigger className="hover:bg-muted/50 flex w-full items-center justify-between px-4 py-3 transition-colors md:px-5">
          <div className="flex items-center gap-2">
            <Icons.ChevronRight
              className={`text-muted-foreground h-4 w-4 transition-transform ${assetsOpen ? "rotate-90" : ""}`}
            />
            <span className="text-sm font-semibold">Assets</span>
          </div>
          <span className="text-success text-sm font-semibold">
            <PrivacyAmount value={data.assets.total} currency={currency} />
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="divide-border divide-y border-t">
            {data.assets.breakdown.map((item) => (
              <div
                key={item.category}
                className="flex items-center justify-between px-4 py-2.5 pl-10 md:px-5 md:pl-11"
              >
                <div className="flex items-center gap-3">
                  <div
                    className={`h-2 w-2 shrink-0 rounded-full ${CATEGORY_COLORS[item.category] || "bg-muted-foreground"}`}
                  />
                  <span className="text-muted-foreground text-sm">{item.name}</span>
                  <span className="text-muted-foreground/70 text-xs">
                    {data.assets.total > 0 &&
                      `${((item.value / data.assets.total) * 100).toFixed(1)}%`}
                  </span>
                </div>
                <span className="text-muted-foreground text-sm">
                  <PrivacyAmount value={item.value} currency={currency} />
                </span>
              </div>
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* Liabilities Section */}
      {hasLiabilities && (
        <Collapsible open={liabilitiesOpen} onOpenChange={setLiabilitiesOpen}>
          <CollapsibleTrigger className="hover:bg-muted/50 flex w-full items-center justify-between border-t px-4 py-3 transition-colors md:px-5">
            <div className="flex items-center gap-2">
              <Icons.ChevronRight
                className={`text-muted-foreground h-4 w-4 transition-transform ${liabilitiesOpen ? "rotate-90" : ""}`}
              />
              <span className="text-sm font-semibold">Liabilities</span>
            </div>
            <span className="text-destructive text-sm font-semibold">
              -<PrivacyAmount value={data.liabilities.total} currency={currency} />
            </span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="divide-border divide-y border-t">
              {data.liabilities.breakdown.map((item, index) => (
                <div
                  key={item.assetId || index}
                  className="flex items-center justify-between px-4 py-2.5 pl-10 md:px-5 md:pl-11"
                >
                  <div className="flex items-center gap-3">
                    <div
                      className={`h-2 w-2 shrink-0 rounded-full ${CATEGORY_COLORS.liabilities}`}
                    />
                    <span className="text-muted-foreground text-sm">{item.name}</span>
                  </div>
                  <span className="text-muted-foreground text-sm">
                    -<PrivacyAmount value={item.value} currency={currency} />
                  </span>
                </div>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* Net Worth Summary */}
      <div className="bg-muted/30 flex items-center justify-between border-t px-4 py-3 md:px-5">
        <span className="text-sm font-bold">Net Worth</span>
        <span className="text-sm font-bold">
          <PrivacyAmount value={data.netWorth} currency={currency} />
        </span>
      </div>
    </div>
  );
}

/**
 * Composition Widget - Visual breakdown of asset categories
 */
interface CompositionItem {
  category: string;
  name: string;
  value: number;
  percentage: number;
}

interface CompositionWidgetProps {
  data: ParsedNetWorth | null;
  isLoading?: boolean;
}

function CompositionWidget({ data, isLoading }: CompositionWidgetProps) {
  const items = useMemo((): CompositionItem[] => {
    if (!data || data.assets.total === 0) return [];

    return data.assets.breakdown
      .filter((item) => item.value > 0)
      .map((item) => ({
        category: item.category,
        name: item.name,
        value: item.value,
        percentage: (item.value / data.assets.total) * 100,
      }))
      .sort((a, b) => b.value - a.value);
  }, [data]);

  if (isLoading) {
    return (
      <div className="w-full">
        <h2 className="text-md pb-2 font-semibold tracking-tight">Composition</h2>
        <div className="border-border bg-card shadow-xs rounded-lg border p-4 md:p-5">
          <Skeleton className="mb-4 h-2.5 w-full rounded-full" />
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-2">
                <Skeleton className="h-2.5 w-2.5 rounded-full" />
                <Skeleton className="h-3 w-16" />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!data || items.length === 0) return null;

  return (
    <div className="w-full">
      <h2 className="text-md pb-2 font-semibold tracking-tight">Composition</h2>
      <div className="border-border bg-card shadow-xs rounded-lg border p-4 md:p-5">
        {/* Stacked horizontal bar */}
        <div className="mb-4 flex h-2.5 w-full overflow-hidden rounded-full">
          {items.map((item, index) => (
            <TooltipProvider key={item.category} delayDuration={0}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div
                    className="h-full transition-opacity hover:opacity-80"
                    style={{
                      width: `${item.percentage}%`,
                      backgroundColor:
                        CATEGORY_CSS_COLORS[item.category] || "var(--muted-foreground)",
                      marginLeft: index > 0 ? "1px" : 0,
                    }}
                  />
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">
                  <span className="font-medium">{item.name}</span>
                  <span className="text-muted-foreground ml-2">{item.percentage.toFixed(1)}%</span>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ))}
        </div>

        {/* Legend grid */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
          {items.map((item) => (
            <div key={item.category} className="flex items-center gap-2">
              <div
                className={`h-2.5 w-2.5 shrink-0 rounded-full ${CATEGORY_COLORS[item.category] || "bg-muted-foreground"}`}
              />
              <span className="text-muted-foreground truncate text-xs">{item.name}</span>
              <span className="text-muted-foreground/60 ml-auto text-xs tabular-nums">
                {item.percentage.toFixed(0)}%
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const DEFAULT_INTERVAL: TimePeriod = "ALL";
const INTERVAL_STORAGE_KEY = "networth-interval";

/**
 * Net Worth Content - Embeddable content for the combined portfolio page
 */
interface NetWorthContentProps {
  onAddAsset?: () => void;
  onAddLiability?: () => void;
}

export function NetWorthContent({ onAddAsset, onAddLiability }: NetWorthContentProps) {
  const { settings } = useSettingsContext();
  const { data: netWorthData, isLoading, isError, error } = useNetWorth();

  // Use the same persisted state as IntervalSelector for the interval code
  const [intervalCode] = usePersistentState<TimePeriod>(INTERVAL_STORAGE_KEY, DEFAULT_INTERVAL);

  // Derive initial values from the persisted interval code
  const [dateRange, setDateRange] = useState<DateRange | undefined>(
    () => getInitialIntervalData(intervalCode).range,
  );
  const [selectedIntervalDescription, setSelectedIntervalDescription] = useState<string>(
    () => getInitialIntervalData(intervalCode).description,
  );

  // Compute ISO date strings for the history query
  const historyDates = useMemo(() => {
    if (!dateRange?.from) return null;
    const endDate = dateRange.to ?? new Date();
    return {
      startDate: formatDateISO(dateRange.from),
      endDate: formatDateISO(endDate),
    };
  }, [dateRange]);

  // Fetch net worth history for chart
  const { data: historyData, isLoading: isHistoryLoading } = useNetWorthHistory({
    startDate: historyDates?.startDate ?? "",
    endDate: historyDates?.endDate ?? "",
    enabled: !!historyDates,
  });

  // Interval selector callback
  const handleIntervalSelect = (
    _code: TimePeriod,
    description: string,
    range: DateRange | undefined,
  ) => {
    setSelectedIntervalDescription(description);
    setDateRange(range);
  };

  // Parse numeric values from the response
  const parsedData = useMemo((): ParsedNetWorth | null => {
    if (!netWorthData) return null;

    return {
      netWorth: parseFloat(netWorthData.netWorth) || 0,
      assets: {
        total: parseFloat(netWorthData.assets.total) || 0,
        breakdown: (netWorthData.assets.breakdown || []).map((item) => ({
          category: item.category,
          name: item.name,
          value: parseFloat(item.value) || 0,
          assetId: item.assetId,
        })),
      },
      liabilities: {
        total: parseFloat(netWorthData.liabilities.total) || 0,
        breakdown: (netWorthData.liabilities.breakdown || []).map((item) => ({
          category: item.category,
          name: item.name,
          value: parseFloat(item.value) || 0,
          assetId: item.assetId,
        })),
      },
    };
  }, [netWorthData]);

  // Calculate net worth change using simple delta (industry standard for net worth tracking)
  const { gainLossAmount, gainLossPercent } = useMemo(() => {
    if (!historyData || historyData.length < 2) {
      return { gainLossAmount: 0, gainLossPercent: 0 };
    }

    const first = historyData[0];
    const last = historyData[historyData.length - 1];

    const firstNetWorth = parseFloat(first.netWorth) || 0;
    const lastNetWorth = parseFloat(last.netWorth) || 0;

    // Simple delta: how much did total wealth change?
    const change = lastNetWorth - firstNetWorth;

    // Percent change relative to starting net worth
    // Use absolute value for negative starting net worth to get meaningful percentage
    const base = firstNetWorth !== 0 ? Math.abs(firstNetWorth) : 1;
    const percent = change / base;

    return { gainLossAmount: change, gainLossPercent: percent };
  }, [historyData]);

  const currency = netWorthData?.currency || settings?.baseCurrency || "USD";
  const hasStaleValuations = netWorthData && netWorthData.staleAssets.length > 0;

  // Error state
  if (isError && error) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center p-8">
        <div className="text-center">
          <div className="bg-destructive/10 mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full">
            <Icons.AlertTriangle className="text-destructive h-6 w-6" />
          </div>
          <p className="text-destructive text-lg font-medium">Failed to load net worth</p>
          <p className="text-muted-foreground mt-2 text-sm">{error?.message}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col">
      {/* Top section: Net Worth value */}
      <div className="px-4 pb-1 pt-2 md:px-6 md:pb-2 lg:px-8">
        <div className="flex items-start gap-2">
          <div>
            <div className="flex items-center gap-3">
              <Balance
                isLoading={isLoading}
                targetValue={parsedData?.netWorth ?? 0}
                currency={currency}
                displayCurrency={true}
              />
              {hasStaleValuations && (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="bg-warning/10 flex h-8 w-8 items-center justify-center rounded-full">
                        <Icons.AlertCircle className="text-warning h-4 w-4" />
                      </div>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-[280px]">
                      <p className="mb-2 text-xs font-medium">Stale valuations (90+ days):</p>
                      <ul className="space-y-1 text-xs">
                        {netWorthData?.staleAssets.map((asset) => (
                          <li
                            key={asset.assetId}
                            className="flex items-center justify-between gap-2"
                          >
                            <span className="truncate">{asset.name ?? asset.assetId}</span>
                            <span className="text-muted-foreground shrink-0">
                              {asset.daysStale}d ago
                            </span>
                          </li>
                        ))}
                      </ul>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
            </div>
            <div className="text-md flex space-x-3">
              {isHistoryLoading ? (
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
                    currency={currency}
                    displayCurrency={false}
                  />
                  <div className="border-secondary my-1 border-r pr-2" />
                  <GainPercent
                    className="lg:text-md text-sm font-light"
                    value={gainLossPercent}
                    animated={true}
                  />
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
      </div>

      {/* Wrapper: chart + content with continuous gradient (same structure as investments) */}
      <div
        className="flex grow flex-col"
        style={{
          backgroundImage:
            (parsedData?.netWorth ?? 0) < 0
              ? `linear-gradient(to top, color-mix(in srgb, var(--destructive) 30%, transparent), color-mix(in srgb, var(--destructive) 15%, transparent) 50%, transparent 100%)`
              : `linear-gradient(to top, ${THEME_COLOR.replace(")", " / 0.30)")}, ${THEME_COLOR.replace(")", " / 0.15)")} 50%, transparent 100%)`,
        }}
      >
        {/* Chart section */}
        <div className="h-[280px]">
          {isHistoryLoading ? (
            <div className="flex h-full items-center justify-center">
              <Skeleton className="h-full w-full" />
            </div>
          ) : historyData && historyData.length > 0 ? (
            <NetWorthChart data={historyData} isLoading={isHistoryLoading} />
          ) : (
            <div className="flex h-full flex-col items-center justify-center">
              <Icons.TrendingUp className="text-muted-foreground/30 mb-3 h-12 w-12" />
              <p className="text-muted-foreground text-sm">No history data available</p>
            </div>
          )}
          {historyData && historyData.length > 0 && (
            <div className="flex w-full justify-center">
              <IntervalSelector
                className="pointer-events-auto relative z-20 w-full max-w-screen-sm sm:max-w-screen-md md:max-w-2xl lg:max-w-3xl"
                onIntervalSelect={handleIntervalSelect}
                isLoading={isHistoryLoading}
                storageKey={INTERVAL_STORAGE_KEY}
                defaultValue={DEFAULT_INTERVAL}
              />
            </div>
          )}
        </div>

        {/* Content section */}
        <div className="grow px-4 pb-[calc(var(--mobile-nav-ui-height)+max(var(--mobile-nav-gap),env(safe-area-inset-bottom)))] pt-12 md:px-6 md:pb-6 md:pt-6 lg:px-10 lg:pb-8 lg:pt-8">
          <div className="grid grid-cols-1 gap-8 lg:grid-cols-3 lg:gap-20">
            {/* Left column: Breakdown */}
            <div className="lg:col-span-2">
              <div className="mb-4 mt-8 w-full lg:mt-0">
                <h2 className="text-md pb-2 font-semibold tracking-tight">Breakdown</h2>

                {isLoading ? (
                  <div className="border-border bg-card shadow-xs rounded-lg border p-4 md:p-5">
                    <div className="space-y-4">
                      {Array.from({ length: 3 }).map((_, i) => (
                        <div key={i} className="flex items-center justify-between">
                          <Skeleton className="h-4 w-32" />
                          <Skeleton className="h-4 w-24" />
                        </div>
                      ))}
                    </div>
                  </div>
                ) : parsedData ? (
                  <BalanceSheet data={parsedData} currency={currency} />
                ) : (
                  <div
                    className="rounded-lg border border-orange-200/50 p-6 text-center md:p-8 dark:border-orange-800/50"
                    style={{ backgroundColor: THEME_COLOR_LIGHT }}
                  >
                    <p className="text-sm">No assets found.</p>
                    <Link
                      to="/holdings"
                      className="text-muted-foreground hover:text-foreground mt-2 inline-flex items-center gap-1 text-xs underline-offset-4 hover:underline"
                    >
                      Add your first asset
                      <Icons.ChevronRight className="h-3 w-3" />
                    </Link>
                  </div>
                )}
              </div>
            </div>

            {/* Right column: Info cards */}
            <div className="space-y-4 lg:col-span-1">
              {/* Composition widget */}
              <CompositionWidget data={parsedData} isLoading={isLoading} />

              {/* Stale valuations warning */}
              {hasStaleValuations && (
                <div className="border-warning/30 bg-warning/5 rounded-lg border p-4 md:p-5">
                  <div className="flex items-start gap-3">
                    <div className="bg-warning/10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full">
                      <Icons.AlertCircle className="text-warning h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">Update your valuations</p>
                      <p className="text-muted-foreground mt-1 text-xs">
                        {netWorthData?.staleAssets.length} asset
                        {netWorthData?.staleAssets.length !== 1 ? "s have" : " has"} not been
                        updated in over 90 days.
                      </p>
                      <div className="mt-3 space-y-1.5">
                        {netWorthData?.staleAssets.map((asset) => (
                          <Link
                            key={asset.assetId}
                            to={`/holdings/${encodeURIComponent(asset.assetId)}?tab=history`}
                            className="hover:bg-warning/10 flex items-center justify-between rounded-md px-2 py-1.5 transition-colors"
                          >
                            <span className="truncate text-xs font-medium">
                              {asset.name ?? asset.assetId}
                            </span>
                            <span className="text-muted-foreground ml-2 shrink-0 text-xs">
                              {asset.daysStale}d ago
                            </span>
                          </Link>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Quick links */}
              <div
                className="rounded-lg border border-orange-200/50 p-4 md:p-5 dark:border-orange-800/50"
                style={{ backgroundColor: THEME_COLOR_LIGHT }}
              >
                <p className="text-sm font-medium">Manage your assets</p>
                <div className="mt-3 space-y-2">
                  <Link
                    to="/holdings"
                    className="text-muted-foreground hover:text-foreground flex items-center gap-2 text-sm transition-colors"
                  >
                    <Icons.ChevronRight className="h-4 w-4" />
                    View all holdings
                  </Link>
                  <Link
                    to="/settings/accounts"
                    className="text-muted-foreground hover:text-foreground flex items-center gap-2 text-sm transition-colors"
                  >
                    <Icons.ChevronRight className="h-4 w-4" />
                    Manage accounts
                  </Link>
                  <button
                    onClick={onAddAsset}
                    className="text-muted-foreground hover:text-foreground flex items-center gap-2 text-sm transition-colors"
                  >
                    <Icons.Plus className="h-4 w-4" />
                    Add asset
                  </button>
                  <button
                    onClick={onAddLiability}
                    className="text-muted-foreground hover:text-foreground flex items-center gap-2 text-sm transition-colors"
                  >
                    <Icons.Plus className="h-4 w-4" />
                    Add liability
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default NetWorthContent;
