import { describe, expect, it } from "vitest";

import type { TaxonomyCategory } from "@/lib/types";

import type { BudgetCategoryRow, BudgetGroupRow } from "../types/budget";
import type { CategoryInsight, GroupInsight, SpendingInsight } from "../types/insight";
import type { CategoryBreakdownRow } from "../types/report";
import { insightToReportProjection, UNCATEGORIZED_CATEGORY_ID } from "./insight-projection";
import {
  buildMoneyFlowGraph,
  focusMoneyFlowGraph,
  isFocusable,
  moneyFlowInputFromReport,
  type MoneyFlowGraph,
  type MoneyFlowInput,
  type MoneyFlowLabels,
} from "./money-flow";

const labels: MoneyFlowLabels = {
  total: "Total",
  shortfall: "Shortfall",
  refunds: "Net refunds",
  saved: "Set aside",
  surplus: "Left over",
  uncategorized: "Uncategorized",
  uncategorizedIncome: "Uncategorized income",
  more: (count) => `+${count} more`,
};

const category = (
  id: string,
  name: string,
  color = "#123456",
  parentId: string | null = null,
): TaxonomyCategory => ({
  id,
  taxonomyId: "income_sources",
  parentId,
  name,
  key: id,
  color,
  sortOrder: 0,
  createdAt: "",
  updatedAt: "",
});

const row = (categoryId: string, amount: number): CategoryBreakdownRow => ({
  taxonomyId: "income_sources",
  categoryId,
  amount,
  count: 1,
});

const spend = (categoryId: string, actual: number, name = categoryId): BudgetCategoryRow => ({
  taxonomyId: "spending_categories",
  categoryId,
  groupId: null,
  parentId: null,
  name,
  color: "#abcdef",
  icon: null,
  target: 0,
  actual,
  rolloverIn: 0,
  rolloverOut: 0,
  remaining: 0,
  overspent: false,
  hasDefaultTarget: false,
  hasMonthOverride: false,
  rolloverEnabled: false,
});

const group = (id: string, categories: BudgetCategoryRow[], color: string | null = "#4F6B92") =>
  ({
    group: {
      id,
      name: id,
      key: id,
      color,
      icon: null,
      sortOrder: 0,
      isSystem: true,
      createdAt: "",
      updatedAt: "",
    },
    categoryTargetTotal: 0,
    buffer: 0,
    plannedTotal: 0,
    actual: categories.reduce((total, c) => total + c.actual, 0),
    rolloverIn: 0,
    rolloverOut: 0,
    remaining: 0,
    overspent: false,
    rolloverEnabled: false,
    categories,
  }) satisfies BudgetGroupRow;

/** The Finary-style month from the feature request: 2,500 in, 400 set aside. */
function finaryInput(overrides: Partial<MoneyFlowInput> = {}): MoneyFlowInput {
  return {
    incomeBreakdown: [row("salary", 2500)],
    savingsBreakdown: [row("stocks", 200), row("life", 200)],
    groupRows: [
      group("housing", [spend("rent", 1498), spend("charges", 120)]),
      group("daily", [spend("groceries", 300), spend("restaurants", 100)]),
      group("subscriptions", [spend("phone", 50), spend("sport", 32)]),
    ],
    uncategorizedSpent: 0,
    incomeCategories: [category("salary", "Salary")],
    savingsCategories: [category("stocks", "Stocks"), category("life", "Life insurance")],
    labels,
    ...overrides,
  };
}

const ids = (graph: MoneyFlowGraph) => graph.nodes.map((node) => node.id);
const node = (graph: MoneyFlowGraph, id: string) => graph.nodes.find((n) => n.id === id);

/** Every node carries exactly what flows through it — the Sankey's own invariant. */
function expectBalanced(graph: MoneyFlowGraph) {
  for (const n of graph.nodes) {
    const inflow = graph.links.filter((l) => l.target === n.id).reduce((t, l) => t + l.value, 0);
    const outflow = graph.links.filter((l) => l.source === n.id).reduce((t, l) => t + l.value, 0);
    if (inflow > 0) expect(inflow).toBeCloseTo(n.value, 6);
    if (outflow > 0) expect(outflow).toBeCloseTo(n.value, 6);
    expect(n.value).toBeGreaterThan(0);
  }
  for (const l of graph.links) {
    expect(node(graph, l.source)).toBeDefined();
    expect(node(graph, l.target)).toBeDefined();
    expect(node(graph, l.target)!.column).toBe(node(graph, l.source)!.column + 1);
  }
}

describe("buildMoneyFlowGraph", () => {
  it("flows income through the total into groups, savings and the surplus", () => {
    const graph = buildMoneyFlowGraph(finaryInput());

    expectBalanced(graph);
    expect(graph.totals).toEqual({ income: 2500, total: 2500 });
    expect(ids(graph)).toEqual([
      "income:salary",
      "total",
      "group:housing",
      "group:daily",
      "group:subscriptions",
      "saved",
      "category:rent",
      "category:charges",
      "category:groceries",
      "category:restaurants",
      "category:phone",
      "category:sport",
      "savings-category:life",
      "savings-category:stocks",
    ]);
    expect(graph.nodes.map((n) => n.column)).toEqual([0, 1, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3]);
    expect(node(graph, "category:rent")).toMatchObject({
      categoryId: "rent",
      parentId: "group:housing",
    });
    expect(node(graph, "savings-category:stocks")?.categoryId).toBeUndefined();
  });

  it("routes money that was not spent or saved to a left over node equal to net cashflow", () => {
    const graph = buildMoneyFlowGraph(finaryInput({ incomeBreakdown: [row("salary", 3000)] }));

    expectBalanced(graph);
    expect(node(graph, "surplus")).toMatchObject({ value: 500, column: 2, name: "Left over" });
    expect(ids(graph).indexOf("surplus")).toBe(ids(graph).indexOf("saved") + 1);
    expect(node(graph, "shortfall")).toBeUndefined();
  });

  it("covers spending beyond income with a shortfall source", () => {
    const graph = buildMoneyFlowGraph(finaryInput({ incomeBreakdown: [row("salary", 2000)] }));

    expectBalanced(graph);
    expect(node(graph, "shortfall")).toMatchObject({ value: 500, column: 0 });
    expect(graph.totals.total).toBe(2500);
    expect(ids(graph).slice(0, 3)).toEqual(["income:salary", "shortfall", "total"]);
  });

  it("turns net-refunded categories into an inflow so the net still matches the headline", () => {
    const graph = buildMoneyFlowGraph(
      finaryInput({
        incomeBreakdown: [row("salary", 3000)],
        groupRows: [
          group("housing", [spend("rent", 1500), spend("deposit", -300, "Deposit")]),
          group("daily", [spend("returns", -50, "Returns")]),
        ],
        uncategorizedSpent: -25,
      }),
    );

    expectBalanced(graph);
    expect(node(graph, "refunds")).toMatchObject({
      column: 0,
      value: 375,
      members: [
        { name: "Deposit", value: 300 },
        { name: "Returns", value: 50 },
        { name: "Uncategorized", value: 25 },
      ],
    });
    // A group with nothing but refunds draws no outflow; a mixed one says what it nets.
    expect(node(graph, "group:daily")).toBeUndefined();
    expect(node(graph, "group:housing")).toMatchObject({ value: 1500, netRefunds: 300 });
    // Headline net = income − net spent − saved = 3000 − (1500 − 375) − 400.
    expect(node(graph, "surplus")?.value).toBeCloseTo(1475, 6);
  });

  it("draws uncategorized spending as its own destination", () => {
    const graph = buildMoneyFlowGraph(finaryInput({ uncategorizedSpent: 90 }));

    expectBalanced(graph);
    expect(node(graph, "uncategorized")).toMatchObject({ value: 90, column: 2 });
    expect(node(graph, "shortfall")?.value).toBeCloseTo(90, 6);
  });

  it("starts at the total when nothing came in, without a 100% shortfall", () => {
    const graph = buildMoneyFlowGraph(finaryInput({ incomeBreakdown: [] }));

    expectBalanced(graph);
    expect(graph.nodes[0]).toMatchObject({ id: "total", column: 0, value: 2500 });
    expect(node(graph, "shortfall")).toBeUndefined();
    expect(node(graph, "category:rent")?.column).toBe(2);
  });

  it("keeps a small refund from turning a spending-only month into a shortfall", () => {
    const graph = buildMoneyFlowGraph(
      finaryInput({
        incomeBreakdown: [],
        groupRows: [group("daily", [spend("groceries", 500), spend("returns", -0.5)])],
      }),
    );

    expectBalanced(graph);
    expect(graph.nodes[0]).toMatchObject({ id: "total", column: 0, value: 900 });
    expect(node(graph, "refunds")).toBeUndefined();
    expect(node(graph, "shortfall")).toBeUndefined();
  });

  it("returns an empty graph when nothing moved", () => {
    const graph = buildMoneyFlowGraph(
      finaryInput({ incomeBreakdown: [], savingsBreakdown: [], groupRows: [] }),
    );

    expect(graph.nodes).toEqual([]);
    expect(graph.links).toEqual([]);
    expect(graph.totals.total).toBe(0);
  });

  it("ignores sub-cent FX noise instead of drawing hairline surplus or shortfall", () => {
    const graph = buildMoneyFlowGraph(
      finaryInput({ incomeBreakdown: [row("salary", 2500.001)], uncategorizedSpent: 0.004 }),
    );

    expect(node(graph, "surplus")).toBeUndefined();
    expect(node(graph, "shortfall")).toBeUndefined();
    expect(node(graph, "uncategorized")).toBeUndefined();
  });

  it("folds the smallest categories of a group into one node", () => {
    const graph = buildMoneyFlowGraph(
      finaryInput({
        groupRows: [
          group("daily", [
            spend("a", 600),
            spend("b", 500),
            spend("c", 400),
            spend("d", 300, "D"),
            spend("e", 200, "E"),
          ]),
        ],
      }),
      { maxCategoriesPerGroup: 3 },
    );

    expectBalanced(graph);
    const more = node(graph, "group:daily:more");
    expect(more).toMatchObject({
      kind: "more",
      name: "+2 more",
      value: 500,
      parentId: "group:daily",
      color: "#4F6B92",
      members: [
        { name: "D", value: 300 },
        { name: "E", value: 200 },
      ],
    });
    expect(isFocusable(more!)).toBe(true);
  });

  it("keeps a lone leftover visible rather than folding it into +1 more", () => {
    const graph = buildMoneyFlowGraph(
      finaryInput({
        groupRows: [group("daily", [spend("a", 600), spend("b", 500), spend("c", 400)])],
      }),
      { maxCategoriesPerGroup: 2 },
    );

    expect(ids(graph).filter((id) => id.startsWith("category:"))).toEqual([
      "category:a",
      "category:b",
      "category:c",
    ]);
    expect(node(graph, "group:daily:more")).toBeUndefined();
  });

  it("folds leaves too thin to read, even under the per-group limit", () => {
    const graph = buildMoneyFlowGraph(
      finaryInput({
        groupRows: [group("daily", [spend("a", 1000), spend("tiny1", 10), spend("tiny2", 5)])],
      }),
    );

    expect(node(graph, "group:daily:more")).toMatchObject({ value: 15, name: "+2 more" });
  });

  it("keeps the largest category named when every leaf is too thin to draw", () => {
    const graph = buildMoneyFlowGraph(
      finaryInput({
        incomeBreakdown: [row("salary", 100_000)],
        groupRows: [group("daily", [spend("a", 50), spend("b", 40, "B"), spend("c", 30, "C")])],
      }),
    );

    expect(node(graph, "category:a")).toBeDefined();
    expect(node(graph, "group:daily:more")).toMatchObject({ name: "+2 more", value: 70 });
  });

  it("folds extra income sources into one source node", () => {
    const graph = buildMoneyFlowGraph(
      finaryInput({
        incomeBreakdown: [row("a", 1000), row("b", 900), row("c", 300), row("d", 300)],
        incomeCategories: [category("a", "A"), category("b", "B"), category("c", "C")],
      }),
      { maxSources: 2 },
    );

    expectBalanced(graph);
    expect(node(graph, "income:more")).toMatchObject({ value: 600, column: 0 });
    expect(isFocusable(node(graph, "income:more")!)).toBe(false);
    // Unknown category ids keep their id as the name rather than vanishing.
    expect(node(graph, "income:more")?.members).toContainEqual({ name: "d", value: 300 });
  });

  it("names uncategorized income and savings rows", () => {
    const graph = buildMoneyFlowGraph(
      finaryInput({
        incomeBreakdown: [row(UNCATEGORIZED_CATEGORY_ID, 2500)],
        savingsBreakdown: [row(UNCATEGORIZED_CATEGORY_ID, 400)],
      }),
    );

    expect(node(graph, `income:${UNCATEGORIZED_CATEGORY_ID}`)?.name).toBe("Uncategorized income");
    expect(node(graph, `savings-category:${UNCATEGORIZED_CATEGORY_ID}`)?.name).toBe(
      "Uncategorized",
    );
  });

  it("names income and savings by the category each activity was assigned", () => {
    const graph = buildMoneyFlowGraph(
      finaryInput({
        incomeBreakdown: [row("salary", 2000), row("bonus", 500)],
        incomeCategories: [
          category("employment", "Employment", "#5A7A3E"),
          category("salary", "Salary", "#5A7A3E", "employment"),
          category("bonus", "Bonus", "#5A7A3E", "employment"),
        ],
        savingsBreakdown: [row("retirement", 300), row("emergency", 100)],
        savingsCategories: [
          category("savings", "Savings"),
          category("retirement", "Retirement", "#123456", "savings"),
          category("emergency", "Emergency", "#123456", "savings"),
        ],
      }),
    );

    expectBalanced(graph);
    expect(node(graph, "income:salary")).toMatchObject({ name: "Salary", value: 2000 });
    expect(node(graph, "income:bonus")).toMatchObject({ name: "Bonus", value: 500 });
    expect(node(graph, "income:employment")).toBeUndefined();
    expect(ids(graph).filter((id) => id.startsWith("savings-category:"))).toEqual([
      "savings-category:retirement",
      "savings-category:emergency",
    ]);
    expect(node(graph, "saved")?.color).toBe("#6B8E54");
  });

  it("stops at destinations when categories are left out", () => {
    const graph = buildMoneyFlowGraph(finaryInput(), { includeCategories: false });

    expectBalanced(graph);
    expect(graph.nodes.every((n) => n.column <= 2)).toBe(true);
    expect(node(graph, "group:housing")?.value).toBe(1618);
  });

  it("falls back to a category color when a group has none", () => {
    const graph = buildMoneyFlowGraph(
      finaryInput({ groupRows: [group("housing", [spend("rent", 1498)], null)] }),
    );

    expect(node(graph, "group:housing")?.color).toBe("#abcdef");
  });
});

describe("focusMoneyFlowGraph", () => {
  it("zooms into one destination with every leaf", () => {
    const full = buildMoneyFlowGraph(
      finaryInput({
        groupRows: [
          group("daily", [spend("a", 600), spend("b", 500), spend("c", 400), spend("d", 300)]),
        ],
      }),
      { maxCategoriesPerGroup: Infinity, minLeafShare: 0 },
    );
    const focused = focusMoneyFlowGraph(full, "group:daily");

    expectBalanced(focused);
    expect(ids(focused)).toEqual([
      "group:daily",
      "category:a",
      "category:b",
      "category:c",
      "category:d",
    ]);
    expect(focused.nodes.map((n) => n.column)).toEqual([0, 1, 1, 1, 1]);
    expect(focused.totals).toBe(full.totals);
  });

  it("returns an empty graph for an unknown destination", () => {
    const focused = focusMoneyFlowGraph(buildMoneyFlowGraph(finaryInput()), "group:gone");

    expect(focused.nodes).toEqual([]);
  });
});

/**
 * The chart and the headline must agree on the period's net: Left over (or
 * Shortfall) equals the backend's `netCashflow`, read through the same
 * projection the page uses.
 */
describe("money flow against the spending insight", () => {
  const amounts = { total: 0, monthlyBreakdown: [] };
  const insightCategory = (categoryId: string, spent: number): CategoryInsight => ({
    taxonomyId: "spending_categories",
    categoryId,
    name: categoryId,
    color: "#A35742",
    icon: null,
    parentId: null,
    budget: amounts,
    spent,
    priorSpent: 0,
    deltaVsPriorPct: null,
    remaining: 0,
    overspent: false,
    pctOfTotalSpent: null,
    txnCount: 1,
  });
  const insightGroup = (id: string, categories: CategoryInsight[]): GroupInsight => ({
    group: {
      id,
      name: id,
      key: id,
      color: "#4F6B92",
      icon: null,
      sortOrder: 0,
      isSystem: true,
      createdAt: "",
      updatedAt: "",
    },
    budget: amounts,
    buffer: amounts,
    spent: categories.reduce((total, c) => total + c.spent, 0),
    priorSpent: 0,
    deltaVsPriorPct: null,
    remaining: 0,
    overspent: false,
    pctOfTotalSpent: null,
    categories,
  });

  function insight(income: number): SpendingInsight {
    const groups = [
      insightGroup("needs", [insightCategory("rent", 1500), insightCategory("deposit", -300)]),
      insightGroup("wants", [insightCategory("dining", 420.55)]),
    ];
    const uncategorized = 79.45;
    const saved = 600;
    const spent = groups.reduce((total, g) => total + g.spent, 0) + uncategorized;
    const period = { start: "", end: "", months: [], dayCount: 30 };
    return {
      period,
      prior: period,
      currency: "USD",
      headline: {
        spent,
        income,
        saved,
        netCashflow: income - spent - saved,
        budget: 0,
        remaining: 0,
        priorSpent: 0,
        deltaVsPriorPct: null,
        pace: {
          dailyAvg: 0,
          daysElapsed: 30,
          daysRemaining: 0,
          projectedSpend: 0,
          expectedSpendToDate: 0,
        },
        status: "on_track",
      },
      groups,
      uncategorized: {
        spent: uncategorized,
        priorSpent: 0,
        deltaVsPriorPct: null,
        pctOfTotalSpent: null,
        txnCount: 2,
      },
      incomeBreakdown: income
        ? [{ taxonomyId: "income_sources", categoryId: "salary", amount: income, count: 1 }]
        : [],
      savingsBreakdown: [
        { taxonomyId: "savings_categories", categoryId: "retirement", amount: saved, count: 1 },
      ],
      byDay: [],
      byDayByCategory: [],
      byMonth: [],
    };
  }

  function graphFor(source: SpendingInsight) {
    const { currentReport, budget } = insightToReportProjection(source, {
      formatCalendarDate: () => "",
    });
    return buildMoneyFlowGraph(
      moneyFlowInputFromReport(currentReport, budget, { income: [], savings: [] }, labels),
    );
  }

  it("leaves over exactly the headline net cashflow", () => {
    const source = insight(4000);
    const graph = graphFor(source);

    expectBalanced(graph);
    expect(source.headline.netCashflow).toBeGreaterThan(0);
    expect(node(graph, "surplus")?.value).toBeCloseTo(source.headline.netCashflow, 6);
  });

  it("falls short by exactly the headline net cashflow", () => {
    const source = insight(1000);
    const graph = graphFor(source);

    expectBalanced(graph);
    expect(source.headline.netCashflow).toBeLessThan(0);
    expect(node(graph, "shortfall")?.value).toBeCloseTo(-source.headline.netCashflow, 6);
  });
});
