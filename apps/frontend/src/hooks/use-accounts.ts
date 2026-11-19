import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Account } from "@/lib/types";
import { getAccounts } from "@/adapters";
import { QueryKeys } from "@/lib/query-keys";
import { AccountPurpose, accountSupportsPurpose } from "@/lib/constants";

// One empty list while accounts load: a new `[]` each render would change the
// memoized result every render, and forms that reset on it never settle.
const NO_ACCOUNTS: Account[] = [];

export function useAccounts(options?: {
  filterActive?: boolean;
  includeArchived?: boolean;
  accountPurpose?: AccountPurpose;
}) {
  const { filterActive = true, includeArchived = false, accountPurpose } = options ?? {};

  const {
    data: fetchedAccounts = NO_ACCOUNTS,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery<Account[], Error>({
    queryKey: [QueryKeys.ACCOUNTS, includeArchived],
    queryFn: () => getAccounts(includeArchived),
  });

  const filteredAccounts = useMemo(() => {
    let accounts = fetchedAccounts;

    // Filter inactive if requested
    if (filterActive) {
      accounts = accounts.filter((a) => a.isActive);
    }

    if (accountPurpose) {
      accounts = accounts.filter((a) => accountSupportsPurpose(a, accountPurpose));
    }

    return accounts;
  }, [accountPurpose, fetchedAccounts, filterActive]);

  return { accounts: filteredAccounts, isLoading, isError, error, refetch };
}
