import { getAccounts } from "@/adapters";
import { AllocationBreadcrumb } from "@/components/allocation-breadcrumb";
import { useAccountsSimplePerformance } from "@/hooks/use-accounts-simple-performance";
import { useDrillDownState } from "@/hooks/use-drill-down-state";
import { QueryKeys } from "@/lib/query-keys";
import { useSettingsContext } from "@/lib/settings-provider";
import type { Account, AccountValueSource } from "@/lib/types";
import { useQuery } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DonutChart,
  EmptyPlaceholder,
  Skeleton,
} from "@wealthfolio/ui";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

interface DrillableAccountChartProps {
  isLoading?: boolean;
  accountIds?: string[];
  accountValuations?: AccountValueSource[];
  onAccountClick?: (accountId: string, accountName: string) => void;
}

/**
 * A semi-donut chart for account allocation with drill-down.
 * Root level shows account groups (or ungrouped accounts).
 * Drilled level shows individual accounts within the selected group.
 */
export function DrillableAccountChart({
  isLoading: isLoadingProp,
  accountIds,
  accountValuations,
  onAccountClick,
}: DrillableAccountChartProps) {
  const { t } = useTranslation();
  const { settings } = useSettingsContext();
  const baseCurrency = settings?.baseCurrency ?? "USD";
  const [activeIndex, setActiveIndex] = useState(0);
  const { path, drillDown, navigateTo, isAtRoot } = useDrillDownState();

  const { data: allAccounts = [], isLoading: isLoadingAccounts } = useQuery<Account[], Error>({
    queryKey: [QueryKeys.ACCOUNTS],
    queryFn: () => getAccounts(),
  });

  const accounts = accountIds ? allAccounts.filter((a) => accountIds.includes(a.id)) : allAccounts;

  const { data: performanceData, isLoading: isLoadingPerformance } = useAccountsSimplePerformance(
    accounts,
    { enabled: accountValuations === undefined },
  );

  const isLoading =
    isLoadingProp || isLoadingAccounts || (accountValuations === undefined && isLoadingPerformance);

  // Build account data with group info
  const accountsWithValues = useMemo(() => {
    const valuationData: AccountValueSource[] | undefined = accountValuations ?? performanceData;
    if (!accounts?.length || !valuationData) return [];

    return accounts
      .map((account) => {
        const valuation = valuationData.find((p) => p.accountId === account.id);
        if (!valuation) return null;

        const valueBase =
          valuation.totalValueBase != null
            ? Number(valuation.totalValueBase) || 0
            : (Number(valuation.totalValue) || 0) * (Number(valuation.fxRateToBase) || 1);
        if (valueBase <= 0) return null;

        return {
          id: account.id,
          name: account.name,
          group: account.group || account.name, // Use name as group if no group
          value: valueBase,
          currency: baseCurrency,
        };
      })
      .filter((a): a is NonNullable<typeof a> => a !== null);
  }, [accounts, accountValuations, performanceData, baseCurrency]);

  // Root level: grouped by account group
  const groupedData = useMemo(() => {
    const groupMap = new Map<string, { value: number; currency: string; accountIds: string[] }>();

    accountsWithValues.forEach((acc) => {
      const existing = groupMap.get(acc.group);
      if (existing) {
        existing.value += acc.value;
        existing.accountIds.push(acc.id);
      } else {
        groupMap.set(acc.group, {
          value: acc.value,
          currency: acc.currency,
          accountIds: [acc.id],
        });
      }
    });

    return Array.from(groupMap.entries())
      .map(([name, data]) => ({
        id: name,
        name,
        value: data.value,
        currency: data.currency,
        accountIds: data.accountIds,
      }))
      .sort((a, b) => b.value - a.value);
  }, [accountsWithValues]);

  // Drilled level: individual accounts in selected group
  const drilledData = useMemo(() => {
    if (path.length === 0) return [];

    const currentGroup = path[path.length - 1].name;

    return accountsWithValues
      .filter((acc) => acc.group === currentGroup)
      .map((acc) => ({
        id: acc.id,
        name: acc.name,
        value: acc.value,
        currency: acc.currency,
      }))
      .sort((a, b) => b.value - a.value);
  }, [path, accountsWithValues]);

  const data = isAtRoot ? groupedData : drilledData;

  const handleSectionClick = (
    sectionData: { name: string; value: number; currency: string },
    index: number,
  ) => {
    setActiveIndex(index);

    const clickedItem = data.find((d) => d.name === sectionData.name);
    if (!clickedItem) return;

    if (isAtRoot) {
      // Check if this group has multiple accounts
      const group = groupedData.find((g) => g.name === clickedItem.name);
      if (group && group.accountIds.length > 1) {
        // Drill down to show individual accounts
        drillDown(clickedItem.id, clickedItem.name);
        setActiveIndex(0);
      } else if (group?.accountIds.length === 1) {
        // Single account in group, trigger click handler directly
        onAccountClick?.(group.accountIds[0], clickedItem.name);
      }
    } else {
      // At account level, trigger parent handler
      onAccountClick?.(clickedItem.id, clickedItem.name);
    }
  };

  const handleBreadcrumbNavigate = (index: number) => {
    navigateTo(index);
    setActiveIndex(0);
  };

  if (isLoading) {
    return (
      <Card className="overflow-hidden backdrop-blur-sm">
        <CardHeader className="px-5 pb-1 pt-5">
          <Skeleton className="h-4 w-[120px]" />
        </CardHeader>
        <CardContent className="px-5 pb-5 pt-0">
          <div className="flex h-[160px] items-center justify-center">
            <Skeleton className="h-[120px] w-[120px] rounded-full" />
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden backdrop-blur-sm">
      <CardHeader className="px-5 pb-1 pt-5">
        {isAtRoot ? (
          <CardTitle className="text-muted-foreground text-[12px] font-semibold uppercase tracking-[0.18em]">
            {t("holdings:accounts")}
          </CardTitle>
        ) : (
          <AllocationBreadcrumb
            path={path}
            rootLabel={t("holdings:accounts")}
            onNavigate={handleBreadcrumbNavigate}
          />
        )}
      </CardHeader>
      <CardContent className="px-5 pb-5 pt-0">
        {data.length > 0 ? (
          <DonutChart
            data={data}
            activeIndex={activeIndex}
            onSectionClick={handleSectionClick}
            startAngle={180}
            endAngle={0}
          />
        ) : (
          <EmptyPlaceholder description={t("holdings:no_account_data")} />
        )}
      </CardContent>
    </Card>
  );
}
