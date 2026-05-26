import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Account } from "@/lib/types";
import { getAccounts } from "@/adapters";
import { QueryKeys } from "@/lib/query-keys";
import { AccountPurpose, accountSupportsPurpose } from "@/lib/constants";

export function useAccounts(options?: {
  filterActive?: boolean;
  includeArchived?: boolean;
  accountPurpose?: AccountPurpose;
}) {
  const { filterActive = true, includeArchived = false, accountPurpose } = options ?? {};

  const {
    data: fetchedAccounts = [],
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
