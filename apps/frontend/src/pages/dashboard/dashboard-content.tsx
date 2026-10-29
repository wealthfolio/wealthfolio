import { formatZonedDateKey } from "@/features/spending/lib/timezone";
import { calculatePerformanceSummary } from "@/adapters";
import { HistoryChart } from "@/components/history-chart";
import { useHapticFeedback } from "@/hooks";
import { useCurrentValuation } from "@/hooks/use-current-account-valuations";
import { useHoldings } from "@/hooks/use-holdings";
import { useValuationHistory } from "@/hooks/use-valuation-history";
import { HoldingType, isAlternativeAssetKind } from "@/lib/constants";
import { performancePeriodPnl, performanceSummaryReturn } from "@/lib/performance";
import { QueryKeys } from "@/lib/query-keys";
import { useSettingsContext } from "@/lib/settings-provider";
import { PortfolioUpdateTrigger } from "@/pages/dashboard/portfolio-update-trigger";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { TimePeriod as UITimePeriod } from "@wealthfolio/ui";
import { GainAmount, GainPercent, IntervalSelector } from "@wealthfolio/ui";
import { SpendingDatePicker } from "@/features/spending/components/spending-date-picker";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import { format } from "date-fns";
import { useMemo } from "react";
import { PrivacyToggle } from "@/components/privacy-toggle";
import type { AccountScope } from "@/lib/types";
import { accountScopeKey } from "@/pages/allocation-targets/components/target-scope";
import { AccountsSummary } from "./accounts-summary";
import Balance from "./balance";
import SavingGoals from "./goals";
import TopHoldings from "./top-holdings";
import { useDashboardPeriod } from "./use-dashboard-period";

function getDashboardChartMinDomainSpanRatio(period: UITimePeriod | null): number {
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

function getDashboardNetContributionMaxDomainSpanRatio(
  period: UITimePeriod | null,
): number | undefined {
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

interface DashboardContentProps {
  scope?: AccountScope;
  scopeLabel?: string;
  accountIds?: string[];
}

export function DashboardContent({
  scope = { type: "all" },
  scopeLabel,
  accountIds,
}: DashboardContentProps) {
  const { settings } = useSettingsContext();
  const todayISO = formatZonedDateKey(new Date(), settings?.timezone);
  const period = useDashboardPeriod(todayISO);
  const { code: selectedInterval, range: dateRange } = period;
  const isAllTime = selectedInterval === "ALL";

  const { holdings: allHoldings, isLoading: isHoldingsLoading } = useHoldings(scope);
  const {
    currentValuation: portfolioCurrentValuation,
    isLoading: isCurrentValuationLoading,
    error: currentValuationError,
  } = useCurrentValuation(scope, { includeAccounts: true });
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
  const { valuationHistory, isLoading: isValuationHistoryLoading } = useValuationHistory(
    valuationHistoryRange,
    scope,
  );

  const baseCurrency = settings?.baseCurrency ?? "USD";

  const startDate =
    !isAllTime && dateRange?.from ? format(dateRange.from, "yyyy-MM-dd") : undefined;
  const endDate = !isAllTime && dateRange?.to ? format(dateRange.to, "yyyy-MM-dd") : undefined;
  const datesReady = isAllTime || (!!startDate && !!endDate);

  const scopeKey = accountScopeKey(scope);
  const { data: portfolioPerformance, isLoading: isPortfolioPerformanceLoading } = useQuery({
    queryKey: [QueryKeys.PERFORMANCE_SUMMARY, "dashboard", scopeKey, startDate, endDate],
    queryFn: () =>
      calculatePerformanceSummary({
        itemType: "account",
        itemId: scope.type === "all" ? "portfolio:all" : scopeKey,
        startDate,
        endDate,
        filter: scope,
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
      valuationHistory
        // A day the engine could not fully convert carries a partial value;
        // it is not plotted rather than drawn as if it were complete.
        ?.filter((item) => item.valueStatus !== "unavailable")
        .map((item) => ({
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

  return (
    <div className="flex min-h-full flex-col">
      <div className="px-4 pt-2 pb-1 md:px-6 lg:px-8">
        <div className="min-w-0">
          {scope.type === "portfolio" && scopeLabel && (
            <p className="text-muted-foreground mb-1 truncate text-xs" title={scopeLabel}>
              {scopeLabel}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <PortfolioUpdateTrigger
              lastCalculatedAt={portfolioSourceDataAsOf}
              notices={portfolioCurrentValuation?.summary.warnings}
            >
              <Balance
                isLoading={isCurrentValuationLoading}
                isUnavailable={isCurrentValuationUnavailable}
                targetValue={totalValue}
                currency={baseCurrency}
                displayCurrency={true}
              />
            </PortfolioUpdateTrigger>
            <PrivacyToggle variant="ghost" />
          </div>
          <div className="text-md flex min-h-5 flex-wrap items-center gap-x-3">
            {isPortfolioPerformanceLoading ? (
              <div className="flex items-center gap-3">
                <Skeleton className="h-4 w-24" />
                <div className="border-secondary my-1 border-e pe-2" />
                <Skeleton className="h-4 w-16" />
              </div>
            ) : (
              <>
                {gainLossAmount == null ? (
                  <span className="text-muted-foreground lg:text-md text-sm font-light">N/A</span>
                ) : (
                  <GainAmount
                    className="lg:text-md text-sm font-light"
                    value={gainLossAmount}
                    currency={baseCurrency}
                    displayCurrency={false}
                  />
                )}
                {/* Stretch: the row centres its items, so an empty divider has no height. */}
                <div className="border-secondary my-1 self-stretch border-e pe-2" />
                {simpleReturn == null ? (
                  <span className="text-muted-foreground lg:text-md text-sm font-light">N/A</span>
                ) : (
                  <GainPercent
                    className="lg:text-md text-sm font-light"
                    value={simpleReturn}
                    animated={true}
                  />
                )}
              </>
            )}
            <span className="lg:text-md text-muted-foreground ms-1 text-sm font-light">
              {period.label}
            </span>
          </div>
        </div>
      </div>

      <div
        className="flex grow flex-col"
        style={{
          backgroundImage: isNegative
            ? `linear-gradient(to top, color-mix(in srgb, var(--loss) 30%, transparent), color-mix(in srgb, var(--loss) 15%, transparent) 50%, transparent 100%)`
            : `linear-gradient(to top, color-mix(in srgb, var(--gain) 30%, transparent), color-mix(in srgb, var(--gain) 15%, transparent) 50%, transparent 100%)`,
        }}
      >
        <div className="h-70">
          <HistoryChart
            data={chartData}
            isLoading={isValuationHistoryLoading}
            scaleMode="fit-visible"
            minDomainSpanRatio={chartMinDomainSpanRatio}
            netContributionMaxDomainSpanRatio={chartNetContributionMaxDomainSpanRatio}
          />
          {valuationHistory && chartData.length > 0 && (
            <div className="flex w-full justify-center">
              <div className="pointer-events-auto relative z-20 flex w-full max-w-screen-sm min-w-0 items-center justify-center gap-1.5 pe-4 sm:max-w-screen-md md:max-w-2xl md:pe-0 lg:max-w-3xl">
                <IntervalSelector
                  className="w-auto"
                  onIntervalSelect={period.selectPreset}
                  onHaptic={triggerHaptic}
                  isLoading={isValuationHistoryLoading}
                  value={selectedInterval}
                />
                <SpendingDatePicker
                  customMonth={period.customMonth}
                  customRange={period.customRange}
                  maxMonth={period.maxMonth}
                  onCustomMonthChange={period.selectMonth}
                  onCustomRangeChange={period.selectRange}
                />
              </div>
            </div>
          )}
        </div>

        {/* Two columns once the content area, not the window (the sidebar may be open),
            fits Accounts beside the 24rem right column. */}
        <div className="@container grow px-4 pt-14 pb-[var(--mobile-nav-total-offset)] md:px-6 md:pt-12 md:pb-6 lg:px-10 lg:pt-14 lg:pb-8">
          <div className="grid grid-cols-1 gap-8 @min-[53rem]:grid-cols-[minmax(0,2fr)_minmax(24rem,1fr)] @min-[53rem]:gap-20">
            <div>
              <AccountsSummary
                accountIds={accountIds}
                dateRange={dateRange}
                isAllTime={isAllTime}
                currentAccountValuations={portfolioCurrentValuation?.accounts}
                isLoadingCurrentValuations={isCurrentValuationLoading}
              />
            </div>
            <div className="space-y-6">
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
