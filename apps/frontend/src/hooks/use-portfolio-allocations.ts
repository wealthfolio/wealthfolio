import { useQuery } from "@tanstack/react-query";
import { AccountScope, PortfolioAllocations } from "@/lib/types";
import { getPortfolioAllocations } from "@/adapters";
import { QueryKeys } from "@/lib/query-keys";

export function usePortfolioAllocations(filter: AccountScope | string) {
  const accountFilter: AccountScope =
    typeof filter === "string" ? { type: "account", accountId: filter } : filter;

  const {
    data: allocations,
    isLoading,
    isError,
    error,
  } = useQuery<PortfolioAllocations, Error>({
    queryKey: [QueryKeys.PORTFOLIO_ALLOCATIONS, accountFilter],
    queryFn: () => getPortfolioAllocations(accountFilter),
    enabled: typeof filter === "string" ? !!filter : true,
  });

  return { allocations, isLoading, isError, error };
}
