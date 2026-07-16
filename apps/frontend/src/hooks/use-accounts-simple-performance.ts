import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { calculateAccountsSimplePerformance } from "@/adapters";
import { Account, SimplePerformanceResult } from "@/lib/types";
import { QueryKeys } from "@/lib/query-keys";

export const useAccountsSimplePerformance = (
  accounts: Account[] | undefined,
  options: { enabled?: boolean } = {},
) => {
  const accountIds = useMemo(() => accounts?.map((acc) => acc.id) ?? [], [accounts]);

  const { data, isLoading, isFetching, isError, error } = useQuery<
    SimplePerformanceResult[],
    Error
  >({
    queryKey: QueryKeys.accountsSimplePerformance(accountIds),
    queryFn: () => {
      return calculateAccountsSimplePerformance(accountIds);
    },
    enabled: (options.enabled ?? true) && accountIds.length > 0,
  });

  return {
    data,
    isLoading,
    isFetching,
    isError,
    error,
  };
};
