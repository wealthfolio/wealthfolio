import { useQuery } from "@tanstack/react-query";
import { AccountScope, Holding } from "@/lib/types";
import { getHoldingsList } from "@/adapters";
import { QueryKeys } from "@/lib/query-keys";

export function useHoldings(accountFilter: AccountScope) {
  const isEnabled = (() => {
    switch (accountFilter.type) {
      case "account":
        return accountFilter.accountId.trim().length > 0;
      case "accounts":
        return accountFilter.accountIds.length > 0;
      case "portfolio":
        return accountFilter.portfolioId.trim().length > 0;
      case "all":
        return true;
      default:
        return false;
    }
  })();

  const {
    data: holdings = [],
    dataUpdatedAt,
    isLoading,
    isError,
    error,
  } = useQuery<Holding[], Error>({
    queryKey: [QueryKeys.HOLDINGS, accountFilter],
    queryFn: () => getHoldingsList(accountFilter),
    enabled: isEnabled,
  });

  return { holdings, dataUpdatedAt, isLoading, isError, error };
}
