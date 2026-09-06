import { usePortfolios } from "@/hooks/use-portfolios";
import { useAccountScopeStore } from "@/lib/account-scope-store";
import { PORTFOLIO_SCOPE_ID } from "@/lib/constants";
import type { TrackedItem } from "@/lib/types";
import { accountScopeKey } from "@/pages/allocation-targets/components/target-scope";
import { useEffect } from "react";
import { trackedItemForScope } from "../performance-selection";

interface PerformanceScopeBridgeOptions {
  accounts: readonly { id: string; name: string }[];
  isAccountsLoading: boolean;
  selectedItems: TrackedItem[];
  setSelectedItems: (items: TrackedItem[]) => void;
  setSelectedItemId: (itemId: string | null) => void;
  sortItems: (items: TrackedItem[]) => TrackedItem[];
}

/**
 * One-way bridge from the shared account scope into the performance comparison
 * list: a scope picked elsewhere becomes a tracked series and is highlighted.
 * Nothing here writes back to the shared scope.
 */
export function usePerformanceScopeBridge({
  accounts,
  isAccountsLoading,
  selectedItems,
  setSelectedItems,
  setSelectedItemId,
  sortItems,
}: PerformanceScopeBridgeOptions) {
  const scope = useAccountScopeStore((state) => state.scope);
  const { data: portfolios = [] } = usePortfolios();

  useEffect(() => {
    if (isAccountsLoading) return;

    const scopeKey = accountScopeKey(scope);
    const { bridgedScopeKey, bridgedItemId, setBridged } = useAccountScopeStore.getState();
    // Only react to an actual scope change, so remounting this page never
    // rewrites a list the user curated here.
    if (scopeKey === bridgedScopeKey) return;

    // Scopes the performance view cannot chart (e.g. an account outside the
    // performance purpose, or a deleted one) are skipped; retried when data settles.
    const item = trackedItemForScope(scope, accounts, portfolios);
    if (!item) return;

    const withoutPrevious =
      bridgedItemId && bridgedItemId !== item.id
        ? selectedItems.filter((candidate) => candidate.id !== bridgedItemId)
        : selectedItems;
    const alreadyTracked = withoutPrevious.some((candidate) => candidate.id === item.id);

    if (!alreadyTracked) {
      setSelectedItems(sortItems([...withoutPrevious, item]));
    } else if (withoutPrevious !== selectedItems) {
      setSelectedItems(withoutPrevious);
    }
    setSelectedItemId(item.id);
    // Only own items this bridge inserted; adopted ones stay under user control.
    setBridged(scopeKey, alreadyTracked || item.id === PORTFOLIO_SCOPE_ID ? null : item.id);
  }, [
    accounts,
    isAccountsLoading,
    portfolios,
    scope,
    selectedItems,
    setSelectedItemId,
    setSelectedItems,
    sortItems,
  ]);
}
