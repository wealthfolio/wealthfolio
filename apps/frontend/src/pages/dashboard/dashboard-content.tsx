import { formatZonedDateKey } from "@/features/spending/lib/timezone";
import { parseLocalDate } from "@/lib/utils";
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
import { GainAmount, GainPercent, getInitialIntervalData, IntervalSelector } from "@wealthfolio/ui";
import { usePersistentState } from "@/hooks/use-persistent-state";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import { format } from "date-fns";
import { useMemo } from "react";
import { PrivacyToggle } from "@/components/privacy-toggle";
import type { AccountScope } from "@/lib/types";
import { accountScopeKey } from "@/pages/allocation-targets/components/target-scope";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
  const { settings } = useSettingsContext();
  const todayISO = formatZonedDateKey(new Date(), settings?.timezone);
  const [selectedInterval, setSelectedInterval] = usePersistentState<UITimePeriod>(
    INTERVAL_STORAGE_KEY,
    DEFAULT_INTERVAL,
  );
  const dateRange = useMemo(
    () => getInitialIntervalData(selectedInterval, parseLocalDate(todayISO)).range,
    [selectedInterval, todayISO],
  );
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
      <div className="px-4 pb-1 pt-2 md:px-6 lg:px-8">
        <PortfolioUpdateTrigger
          lastCalculatedAt={portfolioSourceDataAsOf}
          notices={portfolioCurrentValuation?.summary.warnings}
        >
          <div className="flex items-start gap-2">
            <div className="min-w-0">
              <p className="text-muted-foreground mb-1 truncate text-xs" title={scopeLabel}>
                {scopeLabel ?? t("common:component.all_accounts")}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Balance
                  isLoading={isCurrentValuationLoading}
                  isUnavailable={isCurrentValuationUnavailable}
                  targetValue={totalValue}
                  currency={baseCurrency}
                  displayCurrency={true}
                />
                <PrivacyToggle className="hover:bg-muted/50 bg-transparent" />
              </div>
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
                        N/A
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
                        N/A
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
                {selectedInterval && (
                  <span className="lg:text-md text-muted-foreground ml-1 text-sm font-light">
                    {t(`ui:interval.${selectedInterval}`)}
                  </span>
                )}
              </div>
            </div>
          </div>
        </PortfolioUpdateTrigger>
      </div>

      <div
        className="flex grow flex-col"
        style={{
          backgroundImage: isNegative
            ? `linear-gradient(to top, color-mix(in srgb, var(--destructive) 30%, transparent), color-mix(in srgb, var(--destructive) 15%, transparent) 50%, transparent 100%)`
            : `linear-gradient(to top, color-mix(in srgb, var(--success) 30%, transparent), color-mix(in srgb, var(--success) 15%, transparent) 50%, transparent 100%)`,
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
              <IntervalSelector
                className="pointer-events-auto relative z-20 w-full max-w-screen-sm sm:max-w-screen-md md:max-w-2xl lg:max-w-3xl"
                onIntervalSelect={setSelectedInterval}
                onHaptic={triggerHaptic}
                isLoading={isValuationHistoryLoading}
                value={selectedInterval}
              />
            </div>
          )}
        </div>

        <div className="grow px-4 pb-[var(--mobile-nav-total-offset)] pt-14 md:px-6 md:pb-6 md:pt-12 lg:px-10 lg:pb-8 lg:pt-14">
          <div className="grid grid-cols-1 gap-8 lg:grid-cols-3 lg:gap-20">
            <div className="lg:col-span-2">
              <AccountsSummary
                accountIds={accountIds}
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
