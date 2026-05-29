import { PORTFOLIO_SCOPE_ID } from "@/lib/constants";
import type { TrackedItem } from "@/lib/types";

const LEGACY_PORTFOLIO_ACCOUNT_ID = "TOTAL";

export const ALL_PORTFOLIO_ITEM: TrackedItem = {
  id: PORTFOLIO_SCOPE_ID,
  type: "account",
  name: "All Portfolio",
  accountScope: { type: "all" },
};

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
