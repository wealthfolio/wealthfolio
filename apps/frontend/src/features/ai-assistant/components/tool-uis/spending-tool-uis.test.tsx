import { render, screen } from "@/test/render";
import type { ComponentType } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SpendingBudgetContentImpl,
  SpendingEventsContentImpl,
  SpendingTransactionsContentImpl,
} from "./spending-detail-tool-uis";
import {
  ListSpendingEventsContentImpl,
  SpendingContextContentImpl,
  SpendingInsightContentImpl,
  SpendingReportContentImpl,
} from "./spending-summary-tool-uis";

const privacy = vi.hoisted(() => ({ hidden: false }));

vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: privacy.hidden }),
}));
vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: { baseCurrency: "CAD" } }),
}));
vi.mock("@/hooks/use-taxonomies", () => ({
  useTaxonomy: (id: string) => ({
    data:
      id === "spending_categories"
        ? {
            taxonomy: { id },
            categories: [
              { id: "dining", taxonomyId: id, name: "Dining", color: "#B89A4C", parentId: null },
              {
                id: "coffee",
                taxonomyId: id,
                name: "Coffee",
                color: "#B89A4C",
                parentId: "dining",
              },
              { id: "travel", taxonomyId: id, name: "Trips", color: "#3171B2", parentId: null },
            ],
          }
        : { taxonomy: { id }, categories: [] },
  }),
}));

afterEach(() => {
  privacy.hidden = false;
});

const context = {
  enabled: true,
  availability: "available",
  accountIds: ["card"],
  accounts: [{ id: "card", name: "Visa", currency: "CAD", accountType: "CREDIT_CARD" }],
  baseCurrency: "CAD",
  timezone: "America/Toronto",
};

function renderTool(
  Component: ComponentType<never>,
  result: unknown,
  statusType: "complete" | "running" = "complete",
) {
  const props = {
    toolCallId: "call",
    toolName: "tool",
    type: "tool-call",
    args: {},
    argsText: "{}",
    status: { type: statusType },
    result,
    addResult: vi.fn(),
    resume: vi.fn(),
  };
  const Any = Component as unknown as ComponentType<typeof props>;
  return render(<Any {...props} />);
}

const amountBlock = (total: number) => ({ total, monthlyBreakdown: [] });

const insight = {
  context,
  insight: {
    period: {
      start: "2026-10-01T04:00:00Z",
      end: "2026-11-01T03:59:59.999Z",
      months: ["2026-10"],
      dayCount: 31,
    },
    prior: { start: "", end: "", months: [], dayCount: 31 },
    currency: "CAD",
    headline: {
      spent: 1000,
      income: 0,
      saved: 0,
      netCashflow: -1000,
      budget: 2000,
      remaining: 1000,
      priorSpent: 800,
      deltaVsPriorPct: 0.25,
      pace: {},
      status: "on_track",
    },
    groups: [
      {
        group: { id: "wants", name: "Wants" },
        budget: amountBlock(600),
        buffer: amountBlock(0),
        spent: 900,
        categories: [
          {
            taxonomyId: "spending_categories",
            categoryId: "food",
            name: "Food & Dining",
            color: "#B89A4C",
            budget: amountBlock(600),
            spent: 800,
            priorSpent: 500,
            deltaVsPriorPct: 0.6,
            overspent: true,
            txnCount: 12,
          },
          {
            taxonomyId: "spending_categories",
            categoryId: "shop",
            name: "Shopping",
            color: "#8E7CB3",
            budget: amountBlock(0),
            spent: 100,
            priorSpent: 300,
            deltaVsPriorPct: -0.667,
            overspent: false,
            txnCount: 2,
          },
          {
            taxonomyId: "spending_categories",
            categoryId: "fun",
            name: "Fun",
            color: null,
            budget: amountBlock(0),
            spent: 0,
            priorSpent: 0,
            deltaVsPriorPct: null,
            overspent: false,
            txnCount: 0,
          },
        ],
      },
    ],
    uncategorized: { spent: 100, priorSpent: 0, deltaVsPriorPct: null, txnCount: 1 },
    incomeBreakdown: [],
    savingsBreakdown: [],
    byDay: [],
    byDayByCategory: [],
    byMonth: [],
    calculationQuality: { missingFxTransactions: 2, missingFxCurrencies: ["USD"] },
  },
};

describe("spending insight card", () => {
  it("ranks categories by spending against the budget", () => {
    renderTool(SpendingInsightContentImpl as ComponentType<never>, insight);

    expect(screen.getByText("Spending")).toBeInTheDocument();
    expect(screen.getByText("On track")).toBeInTheDocument();
    expect(screen.getByText("of CA$2,000.00 budget")).toBeInTheDocument();
    expect(screen.getByText(/25% vs previous period/)).toBeInTheDocument();

    const rows = screen.getAllByRole("row").slice(1);
    expect(rows.map((row) => row.querySelector("td")?.textContent)).toEqual([
      "Food & Diningover budget",
      "Shopping",
      "Uncategorized",
    ]);
    expect(rows[0]).toHaveTextContent("CA$800.00");
    expect(rows[0]).toHaveTextContent("↑ 60%");
    expect(rows[1]).toHaveTextContent("↓ 67%");
    expect(rows[2]).toHaveTextContent("new");
    expect(screen.getByText("+ 1 category with no spending")).toBeInTheDocument();
    expect(
      screen.getByText("Totals leave out 2 transactions with no exchange rate."),
    ).toBeInTheDocument();
  });

  it("masks amounts when balances are hidden", () => {
    privacy.hidden = true;
    renderTool(SpendingInsightContentImpl as ComponentType<never>, insight);

    expect(screen.queryByText(/CA\$/)).not.toBeInTheDocument();
    expect(screen.getByText("of ••••• budget")).toBeInTheDocument();
  });

  it("reads results saved in a reloaded chat", () => {
    renderTool(SpendingInsightContentImpl as ComponentType<never>, { data: insight, meta: {} });
    expect(screen.getByText("Food & Dining")).toBeInTheDocument();
  });

  it("says when Spending is off instead of showing totals", () => {
    renderTool(SpendingInsightContentImpl as ComponentType<never>, {
      ...insight,
      context: { ...context, availability: "disabled" },
    });
    expect(screen.getByText(/Spending tracking is off/)).toBeInTheDocument();
    expect(screen.queryByText("Food & Dining")).not.toBeInTheDocument();
  });

  it("shows a skeleton while the tool runs", () => {
    const { container } = renderTool(
      SpendingInsightContentImpl as ComponentType<never>,
      undefined,
      "running",
    );
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });
});

describe("spending period", () => {
  // Local midnight in UTC+14 is the previous day in any runtime timezone
  // behind UTC+10, so this fails unless the result's timezone is used.
  const kiritimati = { ...context, timezone: "Pacific/Kiritimati" };
  const start = "2026-09-30T10:00:00Z";
  const end = "2026-10-31T09:59:59.999Z";

  it("shows insight days in the timezone the result was computed in", () => {
    renderTool(SpendingInsightContentImpl as ComponentType<never>, {
      ...insight,
      context: kiritimati,
      insight: { ...insight.insight, period: { ...insight.insight.period, start, end } },
    });
    expect(screen.getByText("Oct 1, 2026 – Oct 31, 2026")).toBeInTheDocument();
  });

  it("shows report days in the timezone the result was computed in", () => {
    renderTool(SpendingReportContentImpl as ComponentType<never>, {
      context: kiritimati,
      period: { startDate: start, endDate: end, currency: "CAD" },
      report: {
        baseCurrency: "CAD",
        current: { income: 0, outflow: 0, saved: 0, net: 0, count: 0 },
        prior: { income: 0, outflow: 0, saved: 0, net: 0, count: 0 },
        spendingBreakdown: [],
        incomeBreakdown: [],
        savingsBreakdown: [],
        byDay: [],
        byDayByCategory: [],
      },
    });
    expect(screen.getByText("Oct 1, 2026 – Oct 31, 2026")).toBeInTheDocument();
  });
});

describe("spending report card", () => {
  it("shows cash flow and rolls subcategories up to their parent", () => {
    renderTool(SpendingReportContentImpl as ComponentType<never>, {
      context,
      period: {
        startDate: "2026-10-01T04:00:00Z",
        endDate: "2026-11-01T03:59:59.999Z",
        currency: "CAD",
      },
      report: {
        baseCurrency: "CAD",
        current: { income: 5000, outflow: 1200, saved: 500, fromSavings: 100, net: 3400, count: 9 },
        prior: { income: 0, outflow: 0, saved: 0, net: 0, count: 0 },
        spendingBreakdown: [
          { taxonomyId: "spending_categories", categoryId: "coffee", amount: 300, count: 3 },
          { taxonomyId: "spending_categories", categoryId: "dining", amount: 200, count: 2 },
          { taxonomyId: "spending_categories", categoryId: "travel", amount: 400, count: 1 },
        ],
        incomeBreakdown: [],
        savingsBreakdown: [],
        byDay: [],
        byDayByCategory: [],
      },
    });

    expect(screen.getByText("Cash flow")).toBeInTheDocument();
    expect(screen.getByText("CA$5,000.00")).toBeInTheDocument();
    expect(screen.getByText("CA$400.00")).toBeInTheDocument();
    expect(screen.getByText("CA$3,400.00")).toBeInTheDocument();
    expect(
      screen.getByText("Top spending: Dining CA$500.00 · Trips CA$400.00"),
    ).toBeInTheDocument();
  });
});

describe("spending transactions card", () => {
  it("lists payees, categories and signed amounts", () => {
    renderTool(SpendingTransactionsContentImpl as ComponentType<never>, {
      context,
      totalCount: 54,
      offset: 0,
      limit: 3,
      hasMore: true,
      items: [
        {
          id: "a",
          activityDate: "2026-10-24T16:00:00Z",
          notes: "Corner Bistro",
          currency: "CAD",
          netAmount: -84.2,
          cashFlowBucket: "spending",
          effectiveAllocations: [
            { taxonomyId: "spending_categories", categoryId: "coffee", amount: "60" },
            { taxonomyId: "spending_categories", categoryId: "travel", amount: "24.2" },
          ],
        },
        {
          id: "b",
          activityDate: "2026-10-22T16:00:00Z",
          notes: "",
          currency: "CAD",
          netAmount: -12,
          cashFlowBucket: "spending",
          effectiveAllocations: [],
        },
        {
          id: "c",
          activityDate: "2026-10-20T16:00:00Z",
          notes: "Refund",
          currency: "CAD",
          netAmount: 30,
          cashFlowBucket: "income",
          effectiveAllocations: [],
        },
      ],
    });

    expect(screen.getByText("Showing 3 of 54")).toBeInTheDocument();
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("Corner Bistro");
    expect(rows[0]).toHaveTextContent("Coffee");
    expect(rows[0]).toHaveTextContent("+1");
    expect(rows[0]).toHaveTextContent("−CA$84.20");
    expect(rows[1]).toHaveTextContent("No payee");
    expect(rows[1]).toHaveTextContent("Uncategorized");
    expect(rows[2]).toHaveTextContent("+CA$30.00");
  });
});

describe("spending budget card", () => {
  it("shows each group against its plan and flags overspending", () => {
    renderTool(SpendingBudgetContentImpl as ComponentType<never>, {
      context,
      budget: {
        computed: {
          currency: "CAD",
          periodKey: "2026-11",
          groupRows: [
            {
              group: { id: "g-needs", name: "Home" },
              plannedTotal: 4500,
              actual: 1210,
              overspent: false,
            },
            {
              group: { id: "g-wants", name: "Fun money" },
              plannedTotal: 800,
              actual: 910,
              overspent: true,
            },
            { group: { id: "g-empty", name: "Unused" }, plannedTotal: 0, actual: 0 },
          ],
          totals: { spendingPlanned: 5300, spendingActual: 2120, overspentCount: 1 },
        },
      },
    });

    expect(screen.getByText("November 2026")).toBeInTheDocument();
    expect(screen.getByText("CA$2,120.00 of CA$5,300.00")).toBeInTheDocument();
    expect(screen.getByText("CA$1,210.00 of CA$4,500.00")).toBeInTheDocument();
    expect(screen.getByText("CA$910.00 of CA$800.00 · CA$110.00 over")).toBeInTheDocument();
    expect(screen.queryByText("Unused")).not.toBeInTheDocument();
  });
});

describe("spending events card", () => {
  it("lists events newest first with their biggest category", () => {
    renderTool(SpendingEventsContentImpl as ComponentType<never>, {
      context,
      period: { currency: "CAD" },
      summaries: [
        {
          eventId: "wedding",
          eventName: "Sam's wedding",
          eventTypeId: "custom",
          eventTypeName: "Celebration",
          eventTypeColor: "#D4537E",
          startDate: "2026-08-22",
          endDate: "2026-08-22",
          totalSpending: 890,
          transactionCount: 1,
          currency: "CAD",
          byCategory: {},
          dailySpending: {},
        },
        {
          eventId: "lisbon",
          eventName: "Lisbon trip",
          eventTypeId: "custom-trip",
          eventTypeName: "Trip",
          eventTypeColor: null,
          startDate: "2026-09-04",
          endDate: "2026-09-12",
          totalSpending: 3420,
          transactionCount: 31,
          currency: "CAD",
          byCategory: {
            travel: {
              categoryId: "travel",
              categoryName: "Trips",
              color: null,
              amount: 3000,
              transactionCount: 20,
            },
            dining: {
              categoryId: "dining",
              categoryName: "Dining",
              color: null,
              amount: 420,
              transactionCount: 11,
            },
          },
          dailySpending: {},
          calculationQuality: { missingFxTransactions: 1, missingFxCurrencies: ["EUR"] },
        },
      ],
    });

    expect(screen.getByText("2 events")).toBeInTheDocument();
    const names = screen.getAllByText(/Lisbon trip|Sam's wedding/).map((n) => n.textContent);
    expect(names).toEqual(["Lisbon trip", "Sam's wedding"]);
    expect(screen.getByText(/31 transactions · mostly Trips/)).toBeInTheDocument();
    expect(screen.getByText(/1 transaction$/)).toBeInTheDocument();
    expect(
      screen.getByText("Totals leave out 1 transaction with no exchange rate."),
    ).toBeInTheDocument();
  });
});

describe("spending one-line rows", () => {
  it("summarizes the Spending context", () => {
    renderTool(SpendingContextContentImpl as ComponentType<never>, context);
    expect(screen.getByText("Spending · 1 account · CAD · America/Toronto")).toBeInTheDocument();
  });

  it("says when no accounts are included", () => {
    renderTool(SpendingContextContentImpl as ComponentType<never>, {
      ...context,
      availability: "no_accounts",
      accountIds: [],
    });
    expect(screen.getByText("Spending is on, but no accounts are included")).toBeInTheDocument();
  });

  it("counts events and event types", () => {
    renderTool(ListSpendingEventsContentImpl as ComponentType<never>, {
      events: [{ id: "e1" }, { id: "e2" }],
      eventTypes: [{ id: "t1" }],
    });
    expect(screen.getByText("2 events · 1 event type")).toBeInTheDocument();
  });
});
