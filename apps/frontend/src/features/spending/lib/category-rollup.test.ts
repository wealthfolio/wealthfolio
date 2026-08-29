import { describe, expect, it } from "vitest";

import {
  SAVINGS_ROW_ID,
  buildWhereItWentRows,
  rollUpToTopLevel,
  sumByDayForTaxonomy,
  type CategoryMeta,
  type RollupMeta,
} from "./category-rollup";

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

describe("rollUpToTopLevel", () => {
  const savingsMeta = () =>
    new Map<string, RollupMeta>([
      ["cat_savings", { parentId: null }],
      ["cat_savings_livret", { parentId: "cat_savings" }],
      ["cat_savings_life_insurance", { parentId: "cat_savings" }],
    ]);

  it("sums subcategory amounts under their top-level parent", () => {
    const result = rollUpToTopLevel(
      [
        { categoryId: "cat_savings_livret", amount: 300 },
        { categoryId: "cat_savings_life_insurance", amount: 200 },
      ],
      savingsMeta(),
    );

    expect(result.get("cat_savings")).toBe(500);
  });

  it("keeps an already-top-level category id unchanged", () => {
    const result = rollUpToTopLevel([{ categoryId: "cat_savings", amount: 100 }], savingsMeta());

    expect(result.get("cat_savings")).toBe(100);
  });

  it("drops tops whose rolled-up total is zero or negative", () => {
    const result = rollUpToTopLevel(
      [
        { categoryId: "cat_savings_livret", amount: 100 },
        { categoryId: "cat_savings_livret", amount: -100 },
      ],
      savingsMeta(),
    );

    expect(result.has("cat_savings")).toBe(false);
  });
});

describe("sumByDayForTaxonomy", () => {
  it("sums same-day rows for the requested taxonomy", () => {
    const result = sumByDayForTaxonomy(
      [
        { date: "2026-06-08", taxonomyId: "savings_categories", amount: 300, categoryId: "a" },
        { date: "2026-06-08", taxonomyId: "savings_categories", amount: 306.84, categoryId: "b" },
        { date: "2026-06-10", taxonomyId: "savings_categories", amount: 200, categoryId: "c" },
      ],
      "savings_categories",
    );

    expect(result.get("2026-06-08")).toBeCloseTo(606.84);
    expect(result.get("2026-06-10")).toBe(200);
  });

  it("ignores rows from other taxonomies", () => {
    const result = sumByDayForTaxonomy(
      [{ date: "2026-06-08", taxonomyId: "spending_categories", amount: 50, categoryId: "a" }],
      "savings_categories",
    );

    expect(result.size).toBe(0);
  });
});
