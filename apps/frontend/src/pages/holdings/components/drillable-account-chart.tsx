import { getAccounts } from "@/adapters";
import { AllocationBreadcrumb } from "@/components/allocation-breadcrumb";
import { useAccountsSimplePerformance } from "@/hooks/use-accounts-simple-performance";
import { useDrillDownState } from "@/hooks/use-drill-down-state";
import { QueryKeys } from "@/lib/query-keys";
import { useSettingsContext } from "@/lib/settings-provider";
import type { Account } from "@/lib/types";
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

interface DrillableAccountChartProps {
  isLoading?: boolean;
  accountIds?: string[];
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
  onAccountClick,
}: DrillableAccountChartProps) {
  const { settings } = useSettingsContext();
  const baseCurrency = settings?.baseCurrency ?? "USD";
  const [activeIndex, setActiveIndex] = useState(0);
  const { path, drillDown, navigateTo, isAtRoot } = useDrillDownState();

  const { data: allAccounts = [], isLoading: isLoadingAccounts } = useQuery<Account[], Error>({
    queryKey: [QueryKeys.ACCOUNTS],
    queryFn: () => getAccounts(),
  });

  const accounts = accountIds ? allAccounts.filter((a) => accountIds.includes(a.id)) : allAccounts;

  const { data: performanceData, isLoading: isLoadingPerformance } =
    useAccountsSimplePerformance(accounts);

  const isLoading = isLoadingProp || isLoadingAccounts || isLoadingPerformance;

  // Build account data with group info
  const accountsWithValues = useMemo(() => {
    if (!accounts?.length || !performanceData) return [];

    return accounts
      .map((account) => {
        const perf = performanceData.find((p) => p.accountId === account.id);
        if (!perf) return null;

        const valueAcct = Number(perf.totalValue) || 0;
        if (valueAcct <= 0) return null;

        const fxRate = Number(perf.fxRateToBase) || 1;
        const valueBase = valueAcct * fxRate;
        const currency = perf.baseCurrency || account.currency || baseCurrency;

        return {
          id: account.id,
          name: account.name,
          group: account.group || account.name, // Use name as group if no group
          value: valueBase,
          currency,
        };
      })
      .filter((a): a is NonNullable<typeof a> => a !== null);
  }, [accounts, performanceData, baseCurrency]);

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
        <CardHeader>
          <Skeleton className="h-5 w-[140px]" />
        </CardHeader>
        <CardContent className="p-6">
          <div className="flex h-[160px] items-center justify-center">
            <Skeleton className="h-[120px] w-[120px] rounded-full" />
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden backdrop-blur-sm">
      <CardHeader>
        {isAtRoot ? (
          <CardTitle className="text-muted-foreground text-sm font-medium uppercase tracking-wider">
            Accounts
          </CardTitle>
        ) : (
          <AllocationBreadcrumb
            path={path}
            rootLabel="Accounts"
            onNavigate={handleBreadcrumbNavigate}
          />
        )}
      </CardHeader>
      <CardContent className="pt-0">
        {data.length > 0 ? (
          <DonutChart
            data={data}
            activeIndex={activeIndex}
            onSectionClick={handleSectionClick}
            startAngle={180}
            endAngle={0}
          />
        ) : (
          <EmptyPlaceholder description="No account data available." />
        )}
      </CardContent>
    </Card>
  );
}
