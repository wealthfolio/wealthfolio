import { useQuery } from "@tanstack/react-query";
import { AccountScope, Holding } from "@/lib/types";
import { getHoldingsList } from "@/adapters";
import { QueryKeys } from "@/lib/query-keys";

interface UseHoldingsOptions {
  includeClosed?: boolean;
  enabled?: boolean;
}

interface UseHoldingsWithClosedProbeOptions {
  includeClosed: boolean;
  probeClosedWhenEmpty: boolean;
}

export function useHoldings(accountFilter: AccountScope, options: UseHoldingsOptions = {}) {
  const includeClosed = options.includeClosed ?? false;
  const hasValidScope = (() => {
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
  const isEnabled = hasValidScope && (options.enabled ?? true);

  const {
    data: holdings = [],
    dataUpdatedAt,
    isLoading,
    isError,
    error,
  } = useQuery<Holding[], Error>({
    queryKey: [QueryKeys.HOLDINGS, accountFilter, { includeClosed }],
    queryFn: () => getHoldingsList(accountFilter, { includeClosed }),
    enabled: isEnabled,
  });

  return { holdings, dataUpdatedAt, isLoading, isError, error };
}

export function useHoldingsWithClosedProbe(
  accountFilter: AccountScope,
  options: UseHoldingsWithClosedProbeOptions,
) {
  const primaryQuery = useHoldings(accountFilter, { includeClosed: options.includeClosed });
  const shouldProbeClosedPositions =
    options.probeClosedWhenEmpty &&
    !options.includeClosed &&
    !primaryQuery.isLoading &&
    primaryQuery.holdings.length === 0;
  const closedProbeQuery = useHoldings(accountFilter, {
    includeClosed: true,
    enabled: shouldProbeClosedPositions,
  });

  return {
    ...primaryQuery,
    isLoading: primaryQuery.isLoading || (shouldProbeClosedPositions && closedProbeQuery.isLoading),
    hasHiddenClosedPositions: shouldProbeClosedPositions && closedProbeQuery.holdings.length > 0,
  };
}
