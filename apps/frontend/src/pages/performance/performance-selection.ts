import { PORTFOLIO_SCOPE_ID } from "@/lib/constants";
import type { AccountScope, TrackedItem } from "@/lib/types";
import { accountScopeKey } from "@/pages/allocation-targets/components/target-scope";

const LEGACY_PORTFOLIO_ACCOUNT_ID = "TOTAL";

export const ALL_PORTFOLIO_ITEM: TrackedItem = {
  id: PORTFOLIO_SCOPE_ID,
  type: "account",
  name: "All Portfolio",
  accountScope: { type: "all" },
};

interface NamedRecord {
  id: string;
  name: string;
}

/**
 * Maps a shared account scope onto the single tracked series that represents it.
 * Ids match what `handleAccountSelect`/`handlePortfolioSelect` produce, so an
 * item the user already added is reused instead of duplicated. Returns null when
 * the scope cannot be named yet (data still loading, or account deleted).
 */
export function trackedItemForScope(
  scope: AccountScope,
  accounts: readonly NamedRecord[],
  portfolios: readonly NamedRecord[],
): TrackedItem | null {
  if (scope.type === "all") return ALL_PORTFOLIO_ITEM;

  if (scope.type === "account") {
    const account = accounts.find((candidate) => candidate.id === scope.accountId);
    return account
      ? { id: account.id, type: "account", name: account.name, accountScope: scope }
      : null;
  }

  if (scope.type === "portfolio") {
    const portfolio = portfolios.find((candidate) => candidate.id === scope.portfolioId);
    return portfolio
      ? { id: portfolio.id, type: "account", name: portfolio.name, accountScope: scope }
      : null;
  }

  const names = scope.accountIds.map(
    (accountId) => accounts.find((candidate) => candidate.id === accountId)?.name,
  );
  if (names.length === 0 || names.some((name) => !name)) return null;

  return {
    id: accountScopeKey(scope),
    type: "account",
    name: names.join(" + "),
    accountScope: scope,
  };
}

export function migratePerformanceSelectedItemId(itemId: string | null): string | null {
  return itemId === LEGACY_PORTFOLIO_ACCOUNT_ID ? PORTFOLIO_SCOPE_ID : itemId;
}

export function migratePerformanceSelectedItems(items: TrackedItem[]): TrackedItem[] {
  let changed = false;

  const migrated = items.map((item) => {
    if (
      item.type === "account" &&
      (item.id === LEGACY_PORTFOLIO_ACCOUNT_ID || item.id === PORTFOLIO_SCOPE_ID)
    ) {
      changed =
        changed ||
        item.id !== ALL_PORTFOLIO_ITEM.id ||
        item.name !== ALL_PORTFOLIO_ITEM.name ||
        item.accountScope?.type !== "all";
      return ALL_PORTFOLIO_ITEM;
    }

    return item;
  });

  return changed ? migrated : items;
}
