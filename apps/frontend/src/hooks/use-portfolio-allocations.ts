import { useQuery } from "@tanstack/react-query";
import { AccountScope, PortfolioAllocations } from "@/lib/types";
import { getPortfolioAllocations } from "@/adapters";
import { QueryKeys } from "@/lib/query-keys";

export function usePortfolioAllocations(accountFilter: AccountScope) {
  const isEnabled = accountFilter.type !== "account" || accountFilter.accountId.trim().length > 0;

  const {
    data: allocations,
    isLoading,
    isError,
    error,
  } = useQuery<PortfolioAllocations, Error>({
    queryKey: [QueryKeys.PORTFOLIO_ALLOCATIONS, accountFilter],
    queryFn: () => getPortfolioAllocations(accountFilter),
    enabled: isEnabled,
  });

  return { allocations, isLoading, isError, error };
}
