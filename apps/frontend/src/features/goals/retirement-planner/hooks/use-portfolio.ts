import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { getAccounts, getCurrentValuation } from "@/adapters";
import { useHoldings } from "@/hooks/use-holdings";
import { QueryKeys } from "@/lib/query-keys";
import type { Holding } from "@/lib/types";

export function usePortfolioData(accountIds?: string[]) {
  const accountsQuery = useQuery({
    queryKey: [QueryKeys.ACCOUNTS],
    queryFn: () => getAccounts(),
    staleTime: 10 * 60 * 1000,
  });

  const accounts = accountsQuery.data ?? [];
  const allActiveAccounts = accounts.filter((a) => a.isActive && !a.isArchived);

  const activeAccountIds = (
    accountIds !== undefined ? allActiveAccounts.filter((a) => accountIds.includes(a.id)) : []
  ).map((a) => a.id);

  const currentValuationQuery = useQuery({
    queryKey: [QueryKeys.CURRENT_VALUATION, "fire", activeAccountIds],
    queryFn: () =>
      getCurrentValuation({
        filter: { type: "accounts", accountIds: activeAccountIds },
        includeAccounts: false,
      }),
    enabled: activeAccountIds.length > 0,
    staleTime: 5 * 60 * 1000,
  });

  const {
    holdings: holdingsForAccounts,
    isLoading: isHoldingsLoading,
    error: holdingsError,
  } = useHoldings({ type: "accounts", accountIds: activeAccountIds });

  const holdings = useMemo((): Holding[] => {
    const bySymbol = new Map<string, Holding>();
    for (const h of holdingsForAccounts) {
      const key = h.instrument?.symbol ?? h.id;
      const existing = bySymbol.get(key);
      if (existing) {
        existing.marketValue = {
          local: existing.marketValue.local + h.marketValue.local,
          base: existing.marketValue.base + h.marketValue.base,
        };
        existing.quantity = existing.quantity + h.quantity;
      } else {
        bySymbol.set(key, { ...h });
      }
    }
    return Array.from(bySymbol.values());
  }, [holdingsForAccounts]);

  const totalValue = currentValuationQuery.data?.summary.totalValueBase ?? 0;

  const activeAccounts = accounts.filter((a) => activeAccountIds.includes(a.id));

  return {
    holdings,
    activeAccountIds,
    accounts,
    activeAccounts,
    totalValue,
    isLoading: accountsQuery.isLoading || currentValuationQuery.isLoading || isHoldingsLoading,
    error: currentValuationQuery.error || holdingsError,
  };
}
