import { useQuery } from "@tanstack/react-query";
import { AccountScope, HoldingsListResponse } from "@/lib/types";
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

  const { data, dataUpdatedAt, isLoading, isFetching, isError, error } = useQuery<
    HoldingsListResponse,
    Error
  >({
    queryKey: [QueryKeys.HOLDINGS, accountFilter, { includeClosed }],
    queryFn: () => getHoldingsList(accountFilter, { includeClosed }),
    enabled: isEnabled,
  });

  const holdings = data?.holdings ?? [];
  const incompleteAccounts = data?.incompleteAccounts ?? [];
  const isUnavailable =
    isError || incompleteAccounts.some((account) => account.status === "unavailable");
  const isComplete = data !== undefined && incompleteAccounts.length === 0 && !isUnavailable;
  const isUpdating = incompleteAccounts.some((account) => account.status === "pending");
  const scopeError = error ?? (isUnavailable ? new Error("Holdings are unavailable") : null);
  return {
    holdings,
    incompleteAccounts,
    isComplete,
    isUpdating,
    isUnavailable,
    dataUpdatedAt,
    isLoading,
    isFetching,
    isError: isUnavailable,
    error: scopeError,
  };
}

export function useHoldingsWithClosedProbe(
  accountFilter: AccountScope,
  options: UseHoldingsWithClosedProbeOptions,
) {
  const primaryQuery = useHoldings(accountFilter, { includeClosed: options.includeClosed });
  const shouldProbeClosedPositions =
    options.probeClosedWhenEmpty &&
    !options.includeClosed &&
    primaryQuery.isComplete &&
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
