import { describe, expect, it } from "vitest";

import { SAVINGS_ROW_ID, buildWhereItWentRows, type CategoryMeta } from "./category-rollup";

const meta = (overrides: Record<string, CategoryMeta> = {}) =>
  new Map<string, CategoryMeta>([
    ["cat_groceries", { name: "Groceries", color: "#111", icon: null, parentId: null }],
    ["cat_rent", { name: "Rent", color: "#222", icon: null, parentId: null }],
    ...Object.entries(overrides),
  ]);

describe("buildWhereItWentRows", () => {
  it("appends a savings row when money was set aside this period", () => {
    const rows = buildWhereItWentRows({
      spendingBreakdown: [{ categoryId: "cat_groceries", amount: 100, count: 2 }],
      priorSpendingBreakdown: [],
      categoriesMeta: meta(),
      totalSaved: 500,
      priorSaved: 0,
      uncategorizedLabel: "Uncategorized",
      savingsLabel: "Saving",
    });

    const savings = rows.find((r) => r.id === SAVINGS_ROW_ID);
    expect(savings).toMatchObject({ name: "Saving", amount: 500 });
  });

  it("omits the savings row when nothing was saved", () => {
    const rows = buildWhereItWentRows({
      spendingBreakdown: [{ categoryId: "cat_groceries", amount: 100, count: 2 }],
      priorSpendingBreakdown: [],
      categoriesMeta: meta(),
      totalSaved: 0,
      priorSaved: 0,
      uncategorizedLabel: "Uncategorized",
      savingsLabel: "Saving",
    });

    expect(rows.find((r) => r.id === SAVINGS_ROW_ID)).toBeUndefined();
  });

  it("sorts the savings row by amount alongside spending categories", () => {
    const rows = buildWhereItWentRows({
      spendingBreakdown: [
        { categoryId: "cat_groceries", amount: 100, count: 2 },
        { categoryId: "cat_rent", amount: 1000, count: 1 },
      ],
      priorSpendingBreakdown: [],
      categoriesMeta: meta(),
      totalSaved: 500,
      priorSaved: 0,
      uncategorizedLabel: "Uncategorized",
      savingsLabel: "Saving",
    });

    expect(rows.map((r) => r.id)).toEqual(["cat_rent", SAVINGS_ROW_ID, "cat_groceries"]);
  });

  it("computes delta against the prior period's saved amount", () => {
    const rows = buildWhereItWentRows({
      spendingBreakdown: [],
      priorSpendingBreakdown: [],
      categoriesMeta: meta(),
      totalSaved: 600,
      priorSaved: 400,
      uncategorizedLabel: "Uncategorized",
      savingsLabel: "Saving",
    });

    const savings = rows.find((r) => r.id === SAVINGS_ROW_ID);
    expect(savings).toMatchObject({ delta: 200, deltaPct: 50 });
  });
});
