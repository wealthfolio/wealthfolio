import { describe, expect, it } from "vitest";
import { PORTFOLIO_SCOPE_ID } from "@/lib/constants";
import type { TrackedItem } from "@/lib/types";
import {
  ALL_PORTFOLIO_ITEM,
  migratePerformanceSelectedItemId,
  migratePerformanceSelectedItems,
} from "./performance-selection";

describe("performance selection migration", () => {
  it("migrates the legacy TOTAL portfolio item to the scoped portfolio item", () => {
    const staleItems: TrackedItem[] = [
      {
        id: "TOTAL",
        type: "account",
        name: "All Portfolio",
      },
    ];

    expect(migratePerformanceSelectedItems(staleItems)).toEqual([ALL_PORTFOLIO_ITEM]);
    expect(migratePerformanceSelectedItemId("TOTAL")).toBe(PORTFOLIO_SCOPE_ID);
  });

  it("keeps stable references when no migration is needed", () => {
    const items: TrackedItem[] = [
      ALL_PORTFOLIO_ITEM,
      {
        id: "acc-1",
        type: "account",
        name: "Brokerage",
        accountScope: { type: "account", accountId: "acc-1" },
      },
    ];

    expect(migratePerformanceSelectedItems(items)).toBe(items);
    expect(migratePerformanceSelectedItemId(PORTFOLIO_SCOPE_ID)).toBe(PORTFOLIO_SCOPE_ID);
  });
});
