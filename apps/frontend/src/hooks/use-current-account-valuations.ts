import { useQuery } from "@tanstack/react-query";
import { getCurrentValuation } from "@/adapters";
import { QueryKeys } from "@/lib/query-keys";
import { AccountScope, CurrentValuationResponse } from "@/lib/types";

interface UseCurrentValuationOptions {
  includeAccounts?: boolean;
  enabled?: boolean;
}

function uniqueAccountIds(accountIds: string[]): string[] {
  return accountIds.filter((accountId, index) => accountIds.indexOf(accountId) === index);
}

function currentValuationScopeKey(filter: AccountScope): string {
  switch (filter.type) {
    case "all":
      return "all";
    case "account":
      return `account:${filter.accountId}`;
    case "portfolio":
      return `portfolio:${filter.portfolioId}`;
    case "accounts":
      return `accounts:${uniqueAccountIds(filter.accountIds).join(",")}`;
  }
}

function isScopeEnabled(filter: AccountScope): boolean {
  if (filter.type === "account") return filter.accountId.trim().length > 0;
  if (filter.type === "portfolio") return filter.portfolioId.trim().length > 0;
  if (filter.type === "accounts") return filter.accountIds.length > 0;
  return true;
}

export function useCurrentValuation(
  filter: AccountScope,
  options: UseCurrentValuationOptions = {},
) {
  const includeAccounts = options.includeAccounts ?? false;
  const enabled = (options.enabled ?? true) && isScopeEnabled(filter);

  const {
    data: currentValuation,
    isLoading,
    isFetching,
    error,
  } = useQuery<CurrentValuationResponse, Error>({
    queryKey: [
      QueryKeys.CURRENT_VALUATION,
      currentValuationScopeKey(filter),
      includeAccounts ? "with-accounts" : "summary-only",
    ],
    queryFn: () => getCurrentValuation({ filter, includeAccounts }),
    enabled,
  });

  return {
    currentValuation,
    isLoading,
    isFetching,
    error,
  };
}

export function useCurrentAccountValuations(
  accountIds: string[],
  options: { enabled?: boolean } = {},
) {
  const { currentValuation, isLoading, isFetching, error } = useCurrentValuation(
    { type: "accounts", accountIds },
    {
      includeAccounts: true,
      enabled: (options.enabled ?? true) && accountIds.length > 0,
    },
  );

  return {
    currentAccountValuations: currentValuation?.accounts,
    isLoading,
    isFetching,
    error,
  };
}
