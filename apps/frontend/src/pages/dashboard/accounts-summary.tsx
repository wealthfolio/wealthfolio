"use client";

import { calculatePerformanceSummary } from "@/adapters";
import { useAccounts } from "@/hooks/use-accounts";
import { useLatestValuations } from "@/hooks/use-latest-valuations";
import { QueryKeys } from "@/lib/query-keys";
import { useSettingsContext } from "@/lib/settings-provider";
import type { AccountValuation, DateRange } from "@/lib/types";
import { useQueries } from "@tanstack/react-query";
import { GainAmount, GainPercent, PrivacyAmount } from "@wealthfolio/ui";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Separator } from "@wealthfolio/ui/components/ui/separator";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@wealthfolio/ui/components/ui/tooltip";
import { format } from "date-fns";
import React, { useCallback, useMemo, useState } from "react";
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
  taxTreatment?: "TAXABLE" | "TAX_FREE" | "TAX_DEFERRED";
  isGroup?: boolean;
  accountCount?: number;
  accounts?: AccountSummaryDisplayData[];
  displayInAccountCurrency?: boolean;
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
    displayInAccountCurrency = false,
    isNested = false,
  }: {
    item: AccountSummaryDisplayData;
    isExpanded?: boolean;
    onToggle?: () => void;
    isLoadingValuation?: boolean;
    displayInAccountCurrency?: boolean;
    isNested?: boolean;
  }) => {
    const isGroup = item.isGroup ?? false;
    const useAccountCurrency =
      displayInAccountCurrency || (item.displayInAccountCurrency && Boolean(item.accountCurrency));

    if (!isGroup && isLoadingValuation) {
      const skeletonContent = <AccountSummarySkeleton />;

      if (isNested) {
        return (
          <div className="flex w-full items-center justify-between gap-3">{skeletonContent}</div>
        );
      }

      return (
        <div className="border-border bg-card shadow-xs flex w-full items-center justify-between gap-3 rounded-lg border px-4 py-3 md:px-5 md:py-4">
          {skeletonContent}
        </div>
      );
    }

    const name = item.accountName;
    const accountId = item.accountId;

    const subText = isGroup
      ? `${item.accountCount} ${item.accountCount === 1 ? "account" : "accounts"}`
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
      gainAmountToDisplay !== null &&
      gainAmountToDisplay !== 0;
    const shouldRenderGainMetrics = gainPercentToDisplay !== null && (isNested || !isZeroGain);
    // Nested rows always show a secondary line for visual consistency —
    // fall back to a "-" placeholder when gain metrics aren't available.
    const shouldRenderNestedPlaceholder = isNested && !shouldRenderGainMetrics;

    let secondaryMetricContent: React.ReactNode = null;

    if (shouldRenderNestedPlaceholder) {
      secondaryMetricContent = (
        <div
          className="text-muted-foreground text-xs font-medium md:text-sm md:font-medium"
          data-testid="account-summary-secondary-placeholder"
        >
          -
        </div>
      );
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
                showSign={false}
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
    }

    const content = (
      <>
        <div className="flex min-w-0 flex-1 flex-col gap-1 md:gap-1.5">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold leading-tight md:text-base md:font-semibold">
            <span className="truncate">{name}</span>
            {hasBadData && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-block h-2 w-2 shrink-0 cursor-help rounded-full bg-amber-500" />
                </TooltipTrigger>
                <TooltipContent>
                  Return % unavailable — activity history may be inconsistent (e.g. buys without
                  deposits)
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
                data-testid="account-summary-secondary-metric"
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
          className="border-border bg-card shadow-xs flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg border px-4 py-3 transition-all duration-150 hover:shadow-md md:px-5 md:py-4"
        >
          {content}
        </Link>
      );
    }

    return (
      <div className="border-border bg-card shadow-xs flex w-full items-center justify-between gap-3 rounded-lg border px-4 py-3 md:px-5 md:py-4">
        {content}
      </div>
    );
  },
);
AccountSummaryComponent.displayName = "AccountSummaryComponent";

const TAX_TREATMENT_LABELS: Record<"TAXABLE" | "TAX_FREE" | "TAX_DEFERRED", string> = {
  TAXABLE: "Taxable",
  TAX_DEFERRED: "Tax Deferred",
  TAX_FREE: "Tax Free",
};

const TAX_TREATMENT_ORDER: Array<"TAXABLE" | "TAX_DEFERRED" | "TAX_FREE"> = [
  "TAXABLE",
  "TAX_DEFERRED",
  "TAX_FREE",
];

const GroupTaxTreatmentSummary = React.memo(
  ({ accounts, baseCurrency }: { accounts: AccountSummaryDisplayData[]; baseCurrency: string }) => {
    const totals = useMemo(() => {
      const map = new Map<"TAXABLE" | "TAX_FREE" | "TAX_DEFERRED", number>();
      for (const account of accounts) {
        const treatment = account.taxTreatment ?? "TAXABLE";
        map.set(treatment, (map.get(treatment) ?? 0) + Number(account.totalValueBaseCurrency ?? 0));
      }
      return map;
    }, [accounts]);

    const entries = TAX_TREATMENT_ORDER.map((treatment) => ({
      treatment,
      value: totals.get(treatment) ?? 0,
    })).filter((entry) => entry.value > 0);

    if (entries.length === 0) {
      return null;
    }

    return (
      <div className="border-border/50 bg-muted/20 border-t px-4 py-3 md:px-5 md:py-3">
        <p className="text-muted-foreground mb-2 text-xs font-medium uppercase tracking-wider">
          Tax Treatment Breakdown
        </p>
        <div className="flex flex-col gap-1">
          {entries.map((entry) => (
            <div
              key={entry.treatment}
              className="flex items-center justify-between gap-2 text-xs md:text-sm"
            >
              <span className="text-muted-foreground">{TAX_TREATMENT_LABELS[entry.treatment]}</span>
              <PrivacyAmount value={entry.value} currency={baseCurrency} />
            </div>
          ))}
        </div>
      </div>
    );
  },
);
GroupTaxTreatmentSummary.displayName = "GroupTaxTreatmentSummary";

export const AccountsSummary = React.memo(
  ({ dateRange, isAllTime }: { dateRange?: DateRange; isAllTime?: boolean }) => {
    const { accountsGrouped, setAccountsGrouped, settings } = useSettingsContext();
    const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

    const {
      accounts: allAccounts,
      isLoading: isLoadingAccounts,
      isError: isErrorAccounts,
      error: errorAccounts,
    } = useAccounts();

    const accounts = allAccounts ?? [];

    const accountIds = useMemo(() => accounts?.map((acc) => acc.id) ?? [], [accounts]);

    const { latestValuations, isLoading: isLoadingValuations } = useLatestValuations(accountIds);

    const startDate =
      !isAllTime && dateRange?.from ? format(dateRange.from, "yyyy-MM-dd") : undefined;
    const endDate = !isAllTime && dateRange?.to ? format(dateRange.to, "yyyy-MM-dd") : undefined;
    const datesReady = isAllTime || (!!startDate && !!endDate);

    const performanceQueries = useQueries({
      queries: accounts.map((acc) => ({
        queryKey: [
          QueryKeys.PERFORMANCE_SUMMARY,
          "account",
          acc.id,
          startDate,
          endDate,
          acc.trackingMode,
        ],
        queryFn: () =>
          calculatePerformanceSummary({
            itemType: "account",
            itemId: acc.id,
            startDate,
            endDate,
            trackingMode:
              acc.trackingMode === "HOLDINGS" || acc.trackingMode === "TRANSACTIONS"
                ? acc.trackingMode
                : undefined,
          }),
        enabled: datesReady,
        staleTime: 30 * 1000,
        retry: false,
      })),
    });

    const isLoadingPerformanceQueries = performanceQueries.some((q) => q.isLoading);

    const combinedAccountViews = useMemo((): AccountSummaryDisplayData[] => {
      if (!accounts || accounts.length === 0) return [];
      const valuationMap = new Map<string, AccountValuation>();
      if (latestValuations) {
        latestValuations.forEach((val: AccountValuation) => valuationMap.set(val.accountId, val));
      }
      return accounts.map((acc, i): AccountSummaryDisplayData => {
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
            taxTreatment: (acc.taxTreatment ?? "TAXABLE") as
              | "TAXABLE"
              | "TAX_FREE"
              | "TAX_DEFERRED",
            isGroup: false,
          };
        }

        const perf = performanceQueries[i]?.data;
        const fxRate = valuation.fxRateToBase ?? 1;
        const totalValueAccountCurrency = valuation.totalValue;
        const totalValueBaseCurrency = totalValueAccountCurrency * fxRate;

        const gainLossAccountCurrency = perf?.periodGain ?? null;
        const gainLossBaseCurrency =
          gainLossAccountCurrency !== null ? gainLossAccountCurrency * fxRate : null;
        const gainPercent = perf?.periodReturn ?? null;

        return {
          accountName: acc.name,
          totalValueBaseCurrency,
          baseCurrency,
          totalGainLossAmountBaseCurrency: gainLossBaseCurrency,
          totalValueAccountCurrency,
          accountCurrency: valuation.accountCurrency,
          totalGainLossAmountAccountCurrency: gainLossAccountCurrency,
          totalGainLossPercent: gainPercent,
          accountId: acc.id,
          accountType: acc.accountType,
          accountGroup: acc.group ?? null,
          taxTreatment: (acc.taxTreatment ?? "TAXABLE") as "TAXABLE" | "TAX_FREE" | "TAX_DEFERRED",
          isGroup: false,
        };
      });
    }, [accounts, latestValuations, performanceQueries, settings?.baseCurrency]);

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
            className="border-border bg-card shadow-xs rounded-lg border px-4 py-3 md:px-5 md:py-4"
          >
            <AccountSummarySkeleton />
          </div>
        ));
      }

      if (isErrorAccounts) {
        return (
          <div className="border-destructive/30 bg-destructive/5 rounded-lg border p-4 md:p-5">
            <div className="flex items-start gap-3">
              <div className="bg-destructive/10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full">
                <Icons.AlertTriangle className="text-destructive h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-destructive text-sm font-medium">Failed to load accounts</p>
                <p className="text-muted-foreground mt-1 break-words text-xs">
                  {errorAccounts?.message || "An unexpected error occurred"}
                </p>
                <p className="text-muted-foreground mt-2 text-xs">
                  Try restarting the app. If this persists, your database may need to be reset.
                </p>
              </div>
            </div>
          </div>
        );
      }

      if (!combinedAccountViews || combinedAccountViews.length === 0) {
        return (
          <div className="border-border/50 bg-success/10 rounded-lg border p-6 text-center md:p-8">
            <p className="text-sm">No accounts found.</p>
            <Link
              to="/settings/accounts"
              className="text-muted-foreground hover:text-foreground mt-2 inline-flex items-center gap-1 text-xs underline-offset-4 hover:underline"
            >
              Add your first account
              <Icons.ChevronRight className="h-3 w-3" />
            </Link>
          </div>
        );
      }

      const isLoadingPerformance = isLoadingValuations || isLoadingPerformanceQueries;

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
            const groupCurrencies = new Set(
              groupAccounts
                .map((acc) => acc.accountCurrency ?? acc.baseCurrency)
                .filter((currency): currency is string => Boolean(currency)),
            );
            const groupDisplaysAccountCurrency = groupCurrencies.size === 1;
            const groupDisplayCurrency = groupDisplaysAccountCurrency
              ? (groupAccounts[0]?.accountCurrency ??
                groupAccounts[0]?.baseCurrency ??
                baseCurrency)
              : baseCurrency;

            const totalValueBaseCurrency = groupAccounts.reduce(
              (sum, acc) => sum + Number(acc.totalValueBaseCurrency),
              0,
            );

            const totalGainLossAmountBase = groupAccounts.reduce(
              (sum, acc) => sum + Number(acc.totalGainLossAmountBaseCurrency ?? 0),
              0,
            );

            // Market-value-weighted average — only over accounts with a computable return.
            // Accounts with null return (negative start value) are excluded and the
            // denominator is reweighted to their combined value, so they don't dilute the result.
            const knownReturnAccounts = groupAccounts.filter(
              (acc) => acc.totalGainLossPercent !== null,
            );
            const knownReturnTotalValue = knownReturnAccounts.reduce(
              (sum, acc) => sum + Number(acc.totalValueBaseCurrency),
              0,
            );
            const groupTotalReturnPercentBase =
              knownReturnAccounts.length > 0 && knownReturnTotalValue > 0
                ? knownReturnAccounts.reduce(
                    (sum, acc) =>
                      sum +
                      acc.totalGainLossPercent! *
                        (Number(acc.totalValueBaseCurrency) / knownReturnTotalValue),
                    0,
                  )
                : null;

            const totalValueAccountCurrency = groupDisplaysAccountCurrency
              ? groupAccounts.reduce(
                  (sum, acc) =>
                    sum + Number(acc.totalValueAccountCurrency ?? acc.totalValueBaseCurrency),
                  0,
                )
              : undefined;

            const totalGainLossAmountAccountCurrency = groupDisplaysAccountCurrency
              ? groupAccounts.reduce(
                  (sum, acc) => sum + Number(acc.totalGainLossAmountAccountCurrency ?? 0),
                  0,
                )
              : undefined;

            actualGroups.push({
              accountName: groupName,
              totalValueBaseCurrency,
              baseCurrency,
              totalGainLossAmountBaseCurrency: totalGainLossAmountBase,
              totalGainLossPercent: groupTotalReturnPercentBase,
              accountCurrency: groupDisplayCurrency,
              totalValueAccountCurrency,
              totalGainLossAmountAccountCurrency: totalGainLossAmountAccountCurrency ?? null,
              isGroup: true,
              accountCount: groupAccounts.length,
              accounts: groupAccounts,
              displayInAccountCurrency: groupDisplaysAccountCurrency,
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
                  className="border-border bg-card shadow-xs overflow-hidden rounded-lg border transition-shadow duration-150 hover:shadow-md"
                >
                  <div className="cursor-pointer">
                    <AccountSummaryComponent
                      item={group}
                      isExpanded={isExpanded}
                      onToggle={() => toggleGroup(group.accountName)}
                    />
                  </div>
                  {isExpanded && (
                    <>
                      <div className="border-border/50 border-t">
                        <div className="divide-border/50 divide-y">
                          {sortedAccounts.map((account) => (
                            <div key={account.accountId} className="px-4 py-3 md:px-5 md:py-4">
                              <AccountSummaryComponent
                                item={account}
                                isLoadingValuation={isLoadingPerformance}
                                displayInAccountCurrency
                                isNested
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                      <GroupTaxTreatmentSummary
                        accounts={sortedAccounts}
                        baseCurrency={group.baseCurrency}
                      />
                    </>
                  )}
                </div>
              );
            })}
            {standaloneAccounts.map((account) => (
              <AccountSummaryComponent
                key={account.accountId}
                item={account}
                isLoadingValuation={isLoadingPerformance}
                displayInAccountCurrency
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
            isLoadingValuation={isLoadingPerformance}
            displayInAccountCurrency
          />
        ));
      }
    }, [
      combinedAccountViews,
      accountsGrouped,
      expandedGroups,
      toggleGroup,
      isLoadingAccounts,
      isLoadingValuations,
      isLoadingPerformanceQueries,
      isErrorAccounts,
      errorAccounts,
      settings?.baseCurrency,
    ]);

    return (
      <div className="mb-4 w-full space-y-0">
        <div className="flex flex-row items-center justify-between gap-2 pb-2">
          <h2 className="text-md font-semibold tracking-tight">Accounts</h2>
          <Button
            variant="ghost"
            className="text-muted-foreground hover:bg-success/10"
            size="sm"
            onClick={() => setAccountsGrouped(!accountsGrouped)}
            aria-label={accountsGrouped ? "List view" : "Group view"}
            title={accountsGrouped ? "Switch to list view" : "Switch to group view"}
            disabled={isLoadingAccounts || combinedAccountViews.length === 0}
          >
            {accountsGrouped ? (
              <Icons.ListCollapse className="h-4 w-4" />
            ) : (
              <Icons.Group className="h-4 w-4" />
            )}
          </Button>
        </div>
        <div className="space-y-2 md:space-y-3">{renderedContent}</div>
      </div>
    );
  },
);
AccountsSummary.displayName = "AccountsSummary";
