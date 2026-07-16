"use client";

import { calculatePerformanceSummaries, performanceSummaryScopeKey } from "@/adapters";
import { useAccounts } from "@/hooks/use-accounts";
import { useCurrentAccountValuations } from "@/hooks/use-current-account-valuations";
import { AccountPurpose } from "@/lib/constants";
import { performanceSummaryReturn, performancePeriodPnl } from "@/lib/performance";
import { QueryKeys } from "@/lib/query-keys";
import { useSettingsContext } from "@/lib/settings-provider";
import type {
  Account,
  CurrentAccountValuation,
  DateRange,
  PerformanceSummaryScope,
  TrackingMode,
} from "@/lib/types";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { GainAmount, GainPercent, PrivacyAmount } from "@wealthfolio/ui";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Separator } from "@wealthfolio/ui/components/ui/separator";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@wealthfolio/ui/components/ui/tooltip";
import { format } from "date-fns";
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

interface AccountSummaryDisplayData {
  accountName: string;
  baseCurrency: string;
  totalValueBaseCurrency: number;
  totalGainLossAmountBaseCurrency: number | null;
  totalValueAccountCurrency?: number;
  totalGainLossAmountAccountCurrency?: number | null;
  accountCurrency?: string;
  totalGainLossPercent: number | null;
  accountId?: string;
  accountType?: string;
  accountGroup?: string | null;
  trackingMode?: TrackingMode;
  isGroup?: boolean;
  accountCount?: number;
  accounts?: AccountSummaryDisplayData[];
  displayInAccountCurrency?: boolean;
}

function addPerformanceScope(
  scopes: PerformanceSummaryScope[],
  seenScopeKeys: Set<string>,
  accountIds: string[],
) {
  const uniqueAccountIds = [...new Set(accountIds)].filter(Boolean);
  if (uniqueAccountIds.length === 0) return;

  const key = performanceSummaryScopeKey(uniqueAccountIds);
  if (seenScopeKeys.has(key)) return;

  seenScopeKeys.add(key);
  scopes.push({ accountIds: uniqueAccountIds });
}

function getDashboardAccountPerformanceScopes(
  accounts: Account[],
  accountsGrouped: boolean,
  expandedGroups: Record<string, boolean>,
): PerformanceSummaryScope[] {
  const scopes: PerformanceSummaryScope[] = [];
  const seenScopeKeys = new Set<string>();

  if (!accountsGrouped) {
    accounts.forEach((account) => addPerformanceScope(scopes, seenScopeKeys, [account.id]));
    return scopes;
  }

  const groupedAccountIds = new Map<string, string[]>();
  const standaloneAccountIds: string[] = [];

  for (const account of accounts) {
    const groupName = account.group ?? "Uncategorized";
    if (groupName === "Uncategorized") {
      standaloneAccountIds.push(account.id);
      continue;
    }

    groupedAccountIds.set(groupName, [...(groupedAccountIds.get(groupName) ?? []), account.id]);
  }

  for (const [groupName, accountIds] of groupedAccountIds) {
    if (accountIds.length === 1) {
      standaloneAccountIds.push(accountIds[0]);
      continue;
    }

    addPerformanceScope(scopes, seenScopeKeys, accountIds);

    if (expandedGroups[groupName]) {
      accountIds.forEach((accountId) => addPerformanceScope(scopes, seenScopeKeys, [accountId]));
    }
  }

  standaloneAccountIds.forEach((accountId) =>
    addPerformanceScope(scopes, seenScopeKeys, [accountId]),
  );

  return scopes;
}

const AccountSummarySkeleton = () => (
  <div className="flex w-full items-center justify-between gap-3">
    <div className="flex min-w-0 flex-1 flex-col gap-1 md:gap-1.5">
      <Skeleton className="h-5 w-40 rounded md:h-6" />
      <Skeleton className="h-4 w-32 rounded md:h-4" />
    </div>
    <div className="flex shrink-0 items-center gap-2 md:gap-3">
      <div className="flex min-h-12 flex-col items-end justify-center gap-1 md:gap-1.5">
        <Skeleton className="h-5 w-24 rounded md:h-6" />
        <Skeleton className="h-4 w-32 rounded md:h-4" />
      </div>
      <div className="flex items-center justify-center">
        <Skeleton className="h-5 w-5 rounded-full" />
      </div>
    </div>
  </div>
);

const AccountSummaryComponent = React.memo(
  ({
    item,
    isExpanded = false,
    onToggle,
    isLoadingValuation = false,
    isLoadingPerformance = false,
    displayInAccountCurrency = false,
    isNested = false,
  }: {
    item: AccountSummaryDisplayData;
    isExpanded?: boolean;
    onToggle?: () => void;
    isLoadingValuation?: boolean;
    isLoadingPerformance?: boolean;
    displayInAccountCurrency?: boolean;
    isNested?: boolean;
  }) => {
    const { t } = useTranslation();
    const isGroup = item.isGroup ?? false;
    const useAccountCurrency =
      displayInAccountCurrency || (item.displayInAccountCurrency && Boolean(item.accountCurrency));

    if (isLoadingValuation) {
      const skeletonContent = <AccountSummarySkeleton />;

      if (isNested) {
        return (
          <div className="flex w-full items-center justify-between gap-3">{skeletonContent}</div>
        );
      }

      if (isGroup) {
        return (
          <div className="flex w-full items-center justify-between gap-3 rounded-lg p-3 md:p-4">
            {skeletonContent}
          </div>
        );
      }

      return (
        <div className="border-border/40 bg-card/90 shadow-xs flex w-full items-center justify-between gap-3 rounded-xl border px-4 py-3 backdrop-blur-xl md:px-5 md:py-4">
          {skeletonContent}
        </div>
      );
    }

    const name = item.accountName;
    const accountId = item.accountId;

    const subText = isGroup
      ? t("dashboard:accounts_count", { count: item.accountCount })
      : useAccountCurrency
        ? (item.accountCurrency ?? item.baseCurrency)
        : item.baseCurrency;

    const totalValue = useAccountCurrency
      ? (item.totalValueAccountCurrency ?? 0)
      : item.totalValueBaseCurrency;
    const currency = useAccountCurrency
      ? (item.accountCurrency ?? item.baseCurrency)
      : item.baseCurrency;

    const gainAmountToDisplay = useAccountCurrency
      ? item.totalGainLossAmountAccountCurrency
      : item.totalGainLossAmountBaseCurrency;
    const gainDisplayCurrency = currency;
    const gainPercentToDisplay = item.totalGainLossPercent;
    const hasAnyGainData = gainAmountToDisplay != null || gainPercentToDisplay != null;
    // Distinguish "zero gain with data" from "no data at all" so standalone
    // cards hide the redundant 0/0% line while nested rows still show it.
    const isZeroGain =
      (gainAmountToDisplay ?? 0) === 0 && (gainPercentToDisplay ?? 0) === 0 && hasAnyGainData;

    // Has a non-zero gain but return % is unavailable (e.g. negative start value).
    // Only flag accounts with actual value — zero-value/empty accounts are not "bad data".
    const hasBadData =
      totalValue > 0 &&
      gainPercentToDisplay === null &&
      item.totalGainLossAmountBaseCurrency !== null &&
      item.totalGainLossAmountBaseCurrency !== 0;
    const warningMessages = hasBadData
      ? [
          item.trackingMode === "HOLDINGS"
            ? t("dashboard:summary.return_unavailable_holdings")
            : t("dashboard:summary.return_unavailable_activity"),
        ]
      : [];
    const shouldShowWarning = hasBadData;
    const shouldRenderGainMetrics = gainPercentToDisplay !== null && (isNested || !isZeroGain);
    // Nested rows always show a secondary line for visual consistency —
    // fall back to a "-" placeholder when gain metrics aren't available.
    const shouldRenderNestedPlaceholder = isNested && !shouldRenderGainMetrics;

    let secondaryMetricContent: React.ReactNode = null;
    let shouldExposeSecondaryMetric = false;

    if (isLoadingPerformance) {
      secondaryMetricContent = (
        <div
          aria-hidden="true"
          className="bg-muted/70 h-4 w-28 rounded"
          data-testid="account-summary-performance-placeholder"
        />
      );
      shouldExposeSecondaryMetric = true;
    } else if (shouldRenderNestedPlaceholder) {
      secondaryMetricContent = (
        <div
          className="text-muted-foreground text-xs font-medium md:text-sm md:font-medium"
          data-testid="account-summary-secondary-placeholder"
        >
          -
        </div>
      );
      shouldExposeSecondaryMetric = true;
    } else if (shouldRenderGainMetrics) {
      secondaryMetricContent = (
        <>
          {gainAmountToDisplay != null && (
            <>
              <GainAmount
                className="text-xs font-medium md:text-sm md:font-medium"
                value={gainAmountToDisplay}
                currency={gainDisplayCurrency}
                displayCurrency={false}
              />
              <Separator orientation="vertical" className="h-3 md:h-4" />
            </>
          )}
          <GainPercent
            className="text-xs font-medium md:text-sm md:font-medium"
            value={gainPercentToDisplay}
          />
        </>
      );
      shouldExposeSecondaryMetric = true;
    } else {
      secondaryMetricContent = <span aria-hidden="true" className="block h-4 w-28 opacity-0" />;
    }

    const content = (
      <>
        <div className="flex min-w-0 flex-1 flex-col gap-1 md:gap-1.5">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold leading-tight md:text-base md:font-semibold">
            <span className="truncate">{name}</span>
            {shouldShowWarning && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-block h-2 w-2 shrink-0 cursor-help rounded-full bg-amber-500" />
                </TooltipTrigger>
                <TooltipContent className="max-w-80">
                  <div className="space-y-1">
                    {warningMessages.slice(0, 3).map((message) => (
                      <p key={message}>{message}</p>
                    ))}
                  </div>
                </TooltipContent>
              </Tooltip>
            )}
          </h3>
          <p className="text-muted-foreground truncate text-xs md:text-sm">{subText}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2 md:gap-3">
          <div className="flex min-h-[3rem] flex-col items-end justify-center gap-1 md:gap-1.5">
            <p className="text-sm font-semibold leading-tight md:text-base md:font-semibold">
              <PrivacyAmount value={totalValue} currency={currency} />
            </p>
            {secondaryMetricContent && (
              <div
                className="flex items-center gap-1.5 md:gap-2"
                data-testid={
                  shouldExposeSecondaryMetric ? "account-summary-secondary-metric" : undefined
                }
              >
                {secondaryMetricContent}
              </div>
            )}
          </div>
          {isGroup ? (
            <div className="flex items-center justify-center">
              <Icons.ChevronDown
                className={`text-muted-foreground h-5 w-5 shrink-0 transition-transform duration-200 ${
                  isExpanded ? "rotate-180" : ""
                }`}
              />
            </div>
          ) : (
            !isLoadingValuation &&
            accountId && (
              <div className="flex items-center justify-center">
                <Icons.ChevronRight className="text-muted-foreground h-5 w-5 shrink-0" />
              </div>
            )
          )}
        </div>
      </>
    );

    if (isGroup) {
      return (
        <div
          onClick={onToggle}
          className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg p-3 transition-colors duration-150 md:p-4"
        >
          {content}
        </div>
      );
    }

    if (!isLoadingValuation && accountId) {
      if (isNested) {
        return (
          <Link
            to={`/accounts/${accountId}`}
            className="flex w-full cursor-pointer items-center justify-between gap-3"
          >
            {content}
          </Link>
        );
      }
      return (
        <Link
          to={`/accounts/${accountId}`}
          className="border-border/40 bg-card/90 shadow-xs flex w-full cursor-pointer items-center justify-between gap-3 rounded-xl border px-4 py-3 backdrop-blur-xl transition-all duration-150 hover:shadow-md md:px-5 md:py-4"
        >
          {content}
        </Link>
      );
    }

    return (
      <div className="border-border/40 bg-card/90 shadow-xs flex w-full items-center justify-between gap-3 rounded-xl border px-4 py-3 backdrop-blur-xl md:px-5 md:py-4">
        {content}
      </div>
    );
  },
);
AccountSummaryComponent.displayName = "AccountSummaryComponent";

export const AccountsSummary = React.memo(
  ({
    dateRange,
    isAllTime,
    currentAccountValuations: currentAccountValuationsProp,
    isLoadingCurrentValuations: isLoadingCurrentValuationsProp,
  }: {
    dateRange?: DateRange;
    isAllTime?: boolean;
    currentAccountValuations?: CurrentAccountValuation[];
    isLoadingCurrentValuations?: boolean;
  }) => {
    const { t } = useTranslation();
    const { accountsGrouped, setAccountsGrouped, settings } = useSettingsContext();
    const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

    const {
      accounts: allAccounts,
      isLoading: isLoadingAccounts,
      isError: isErrorAccounts,
      error: errorAccounts,
    } = useAccounts({ accountPurpose: AccountPurpose.PERFORMANCE });

    const accounts = useMemo(() => allAccounts ?? [], [allAccounts]);

    const accountIds = useMemo(() => accounts?.map((acc) => acc.id) ?? [], [accounts]);

    const shouldFetchCurrentValuations = currentAccountValuationsProp === undefined;
    const {
      currentAccountValuations: fetchedCurrentAccountValuations,
      isLoading: isLoadingFetchedCurrentValuations,
    } = useCurrentAccountValuations(accountIds, {
      enabled: shouldFetchCurrentValuations,
    });
    const currentAccountValuations =
      currentAccountValuationsProp ?? fetchedCurrentAccountValuations;
    const isLoadingCurrentValuations =
      isLoadingCurrentValuationsProp ?? isLoadingFetchedCurrentValuations;

    const startDate =
      !isAllTime && dateRange?.from ? format(dateRange.from, "yyyy-MM-dd") : undefined;
    const endDate = !isAllTime && dateRange?.to ? format(dateRange.to, "yyyy-MM-dd") : undefined;
    const datesReady = isAllTime || (!!startDate && !!endDate);

    const performanceScopes = useMemo((): PerformanceSummaryScope[] => {
      return getDashboardAccountPerformanceScopes(accounts, accountsGrouped, expandedGroups);
    }, [accounts, accountsGrouped, expandedGroups]);
    const shouldFetchPerformance = datesReady && performanceScopes.length > 0;

    const {
      data: performanceSummaries,
      isLoading: isLoadingPerformanceQueries,
      isError: isPerformanceError,
      error: performanceError,
    } = useQuery({
      queryKey: [
        QueryKeys.PERFORMANCE_SUMMARY,
        "dashboard-accounts-batch",
        performanceScopes,
        startDate,
        endDate,
      ],
      queryFn: () =>
        calculatePerformanceSummaries(performanceScopes, startDate, endDate, "dashboard"),
      enabled: shouldFetchPerformance,
      placeholderData: keepPreviousData,
      staleTime: 30 * 1000,
      retry: 1,
    });

    const combinedAccountViews = useMemo((): AccountSummaryDisplayData[] => {
      if (!accounts || accounts.length === 0) return [];
      const valuationMap = new Map<string, CurrentAccountValuation>();
      if (currentAccountValuations) {
        currentAccountValuations.forEach((val: CurrentAccountValuation) =>
          valuationMap.set(val.accountId, val),
        );
      }
      return accounts.map((acc): AccountSummaryDisplayData => {
        const valuation = valuationMap.get(acc.id);
        const baseCurrency = settings?.baseCurrency ?? "USD";

        if (!valuation) {
          return {
            accountName: acc.name,
            totalValueBaseCurrency: 0,
            baseCurrency,
            accountCurrency: acc.currency,
            totalGainLossAmountBaseCurrency: null,
            totalGainLossPercent: null,
            accountId: acc.id,
            accountType: acc.accountType,
            accountGroup: acc.group ?? null,
            trackingMode: acc.trackingMode,
            isGroup: false,
          };
        }

        const perf = performanceSummaries?.[performanceSummaryScopeKey([acc.id])];
        const totalValueAccountCurrency = valuation.totalValue;
        const totalValueBaseCurrency = valuation.totalValueBase;

        const gainLossBaseCurrency = performancePeriodPnl(perf);
        const gainPercent = performanceSummaryReturn(perf);

        return {
          accountName: acc.name,
          totalValueBaseCurrency,
          baseCurrency,
          totalGainLossAmountBaseCurrency: gainLossBaseCurrency,
          totalValueAccountCurrency,
          accountCurrency: valuation.accountCurrency,
          totalGainLossAmountAccountCurrency:
            valuation.accountCurrency === valuation.baseCurrency ? gainLossBaseCurrency : null,
          totalGainLossPercent: gainPercent,
          accountId: acc.id,
          accountType: acc.accountType,
          accountGroup: acc.group ?? null,
          trackingMode: acc.trackingMode,
          isGroup: false,
        };
      });
    }, [accounts, currentAccountValuations, performanceSummaries, settings?.baseCurrency]);

    const toggleGroup = useCallback((groupName: string) => {
      setExpandedGroups((prev) => ({
        ...prev,
        [groupName]: !prev[groupName],
      }));
    }, []);

    const renderedContent = useMemo(() => {
      if (isLoadingAccounts) {
        return Array.from({ length: 4 }).map((_, index) => (
          <div
            key={`skeleton-${index}`}
            className="border-border/40 bg-card/90 shadow-xs rounded-xl border px-4 py-3 backdrop-blur-xl md:px-5 md:py-4"
          >
            <AccountSummarySkeleton />
          </div>
        ));
      }

      if (isErrorAccounts) {
        return (
          <div className="border-destructive/30 bg-destructive/5 rounded-xl border p-4 md:p-5">
            <div className="flex items-start gap-3">
              <div className="bg-destructive/10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full">
                <Icons.AlertTriangle className="text-destructive h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-destructive text-sm font-medium">
                  {t("dashboard:summary.failed_to_load")}
                </p>
                <p className="text-muted-foreground mt-1 break-words text-xs">
                  {errorAccounts?.message || t("dashboard:summary.unexpected_error")}
                </p>
                <p className="text-muted-foreground mt-2 text-xs">
                  {t("dashboard:summary.try_restarting")}
                </p>
              </div>
            </div>
          </div>
        );
      }

      if (!combinedAccountViews || combinedAccountViews.length === 0) {
        return (
          <div className="border-border/50 bg-success/10 rounded-xl border p-6 text-center md:p-8">
            <p className="text-sm">{t("dashboard:no_accounts_found")}</p>
            <Link
              to="/settings/accounts"
              className="text-muted-foreground hover:text-foreground mt-2 inline-flex items-center gap-1 text-xs underline-offset-4 hover:underline"
            >
              {t("dashboard:add_first_account")}
              <Icons.ChevronRight className="h-3 w-3" />
            </Link>
          </div>
        );
      }

      const isLoadingPerformance = isLoadingCurrentValuations || isLoadingPerformanceQueries;

      if (accountsGrouped) {
        const groups: Record<string, AccountSummaryDisplayData[]> = {};
        const standaloneAccounts: AccountSummaryDisplayData[] = [];

        combinedAccountViews.forEach((account) => {
          const groupName = account.accountGroup ?? "Uncategorized";
          if (groupName === "Uncategorized") {
            standaloneAccounts.push(account);
          } else {
            if (!groups[groupName]) {
              groups[groupName] = [];
            }
            groups[groupName].push(account);
          }
        });

        const actualGroups: AccountSummaryDisplayData[] = [];

        Object.entries(groups).forEach(([groupName, groupAccounts]) => {
          if (groupAccounts.length === 1) {
            standaloneAccounts.push(groupAccounts[0]);
          } else {
            const baseCurrency = groupAccounts[0]?.baseCurrency ?? settings?.baseCurrency ?? "USD";
            const groupAccountIds = groupAccounts
              .map((account) => account.accountId)
              .filter((id): id is string => Boolean(id));
            const groupPerformance =
              performanceSummaries?.[performanceSummaryScopeKey(groupAccountIds)];

            const totalValueBaseCurrency = groupAccounts.reduce(
              (sum, acc) => sum + Number(acc.totalValueBaseCurrency),
              0,
            );

            const totalGainLossAmountBase = performancePeriodPnl(groupPerformance);
            const groupTotalReturnPercentBase = performanceSummaryReturn(groupPerformance);

            actualGroups.push({
              accountName: groupName,
              totalValueBaseCurrency,
              baseCurrency,
              totalGainLossAmountBaseCurrency: totalGainLossAmountBase,
              totalGainLossPercent: groupTotalReturnPercentBase,
              accountCurrency: baseCurrency,
              totalValueAccountCurrency: totalValueBaseCurrency,
              totalGainLossAmountAccountCurrency: totalGainLossAmountBase,
              isGroup: true,
              accountCount: groupAccounts.length,
              accounts: groupAccounts,
              trackingMode: groupAccounts.every((account) => account.trackingMode === "HOLDINGS")
                ? "HOLDINGS"
                : undefined,
              displayInAccountCurrency: false,
            });
          }
        });

        actualGroups.sort(
          (a, b) => Number(b.totalValueBaseCurrency) - Number(a.totalValueBaseCurrency),
        );
        standaloneAccounts.sort(
          (a, b) => Number(b.totalValueBaseCurrency) - Number(a.totalValueBaseCurrency),
        );

        return (
          <>
            {actualGroups.map((group) => {
              const isExpanded = expandedGroups[group.accountName];
              const sortedAccounts = [...(group.accounts ?? [])].sort(
                (a, b) => Number(b.totalValueBaseCurrency) - Number(a.totalValueBaseCurrency),
              );

              return (
                <div
                  key={group.accountName}
                  className="border-border/40 bg-card/90 shadow-xs overflow-hidden rounded-xl border backdrop-blur-xl transition-shadow duration-150 hover:shadow-md"
                >
                  <div className="cursor-pointer">
                    <AccountSummaryComponent
                      item={group}
                      isExpanded={isExpanded}
                      onToggle={() => toggleGroup(group.accountName)}
                      isLoadingValuation={isLoadingCurrentValuations}
                      isLoadingPerformance={isLoadingPerformanceQueries}
                    />
                  </div>
                  {isExpanded && (
                    <div className="border-border/50 border-t">
                      <div className="divide-border/50 divide-y">
                        {sortedAccounts.map((account) => (
                          <div key={account.accountId} className="px-4 py-3 md:px-5 md:py-4">
                            <AccountSummaryComponent
                              item={account}
                              isLoadingValuation={isLoadingCurrentValuations}
                              isLoadingPerformance={isLoadingPerformance}
                              displayInAccountCurrency={
                                account.accountCurrency !== account.baseCurrency
                              }
                              isNested
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {standaloneAccounts.map((account) => (
              <AccountSummaryComponent
                key={account.accountId}
                item={account}
                isLoadingValuation={isLoadingCurrentValuations}
                isLoadingPerformance={isLoadingPerformance}
                displayInAccountCurrency={account.accountCurrency !== account.baseCurrency}
              />
            ))}
          </>
        );
      } else {
        const sortedAccounts = [...combinedAccountViews].sort(
          (a, b) => Number(b.totalValueBaseCurrency) - Number(a.totalValueBaseCurrency),
        );

        return sortedAccounts.map((account) => (
          <AccountSummaryComponent
            key={account.accountId}
            item={account}
            isLoadingValuation={isLoadingCurrentValuations}
            isLoadingPerformance={isLoadingPerformance}
            displayInAccountCurrency={account.accountCurrency !== account.baseCurrency}
          />
        ));
      }
    }, [
      combinedAccountViews,
      accountsGrouped,
      expandedGroups,
      toggleGroup,
      isLoadingAccounts,
      isLoadingCurrentValuations,
      isLoadingPerformanceQueries,
      performanceSummaries,
      isErrorAccounts,
      errorAccounts,
      settings?.baseCurrency,
      t,
    ]);

    return (
      <div className="mb-4 w-full space-y-0">
        <div className="flex flex-row items-center justify-between gap-2 pb-2">
          <h2 className="text-sm font-semibold tracking-tight">{t("dashboard:accounts")}</h2>
          <Button
            variant="ghost"
            className="text-muted-foreground hover:bg-success/10"
            size="sm"
            onClick={() => setAccountsGrouped(!accountsGrouped)}
            aria-label={accountsGrouped ? t("dashboard:list_view") : t("dashboard:group_view")}
            title={
              accountsGrouped
                ? t("dashboard:switch_to_list_view")
                : t("dashboard:switch_to_group_view")
            }
            disabled={isLoadingAccounts || combinedAccountViews.length === 0}
          >
            {accountsGrouped ? (
              <Icons.ListCollapse className="h-4 w-4" />
            ) : (
              <Icons.Group className="h-4 w-4" />
            )}
          </Button>
        </div>
        {isPerformanceError && (
          <div className="border-destructive/30 bg-destructive/5 mb-2 rounded-lg border p-3">
            <div className="flex items-start gap-2">
              <Icons.AlertTriangle className="text-destructive mt-0.5 h-4 w-4 shrink-0" />
              <div className="min-w-0">
                <p className="text-destructive text-sm font-medium">
                  {t("dashboard:summary.failed_to_load_performance")}
                </p>
                <p className="text-muted-foreground mt-1 break-words text-xs">
                  {performanceError?.message || t("dashboard:summary.values_without_returns")}
                </p>
              </div>
            </div>
          </div>
        )}
        <div className="space-y-2 md:space-y-3">{renderedContent}</div>
      </div>
    );
  },
);
AccountsSummary.displayName = "AccountsSummary";
