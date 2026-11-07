import { fireEvent, render, screen, within } from "@testing-library/react";
import { DirectionProvider, FormattingProvider, type TextDirection } from "@wealthfolio/ui";
import { cloneElement, isValidElement, type ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { spendingRangeToReportsRange } from "../../../lib/date-range-params";
import { comparisonRange } from "../../../lib/reports-period";
import type { BudgetSnapshot } from "../../../types/budget";
import type { MonthlyReport } from "../../../types/report";
import { WhereIAmStage } from "./where-i-am-stage";

vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: false }),
}));

vi.mock("../../../hooks/use-spending-settings", () => ({
  useSpendingSettings: () => ({ excludedCategoryIds: [] }),
}));

// jsdom has no layout: give the money flow chart a fixed size so it draws nodes.
vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactNode }) =>
      isValidElement(children)
        ? cloneElement(children as React.ReactElement<{ width: number; height: number }>, {
            width: 900,
            height: 500,
          })
        : null,
  };
});

function report(outflow: number): MonthlyReport {
  const summary = { income: 0, outflow, saved: 0, net: -outflow, count: 1 };
  return {
    baseCurrency: "USD",
    current: summary,
    prior: summary,
    spendingBreakdown: [],
    incomeBreakdown: [],
    savingsBreakdown: [],
    byDay: [],
    byDayByCategory: [],
  };
}

const timezone = "America/Toronto";
const range = spendingRangeToReportsRange(
  { from: new Date(2025, 2, 8), to: new Date(2025, 2, 10) },
  timezone,
);

function setup(custom: boolean, direction: TextDirection = "ltr") {
  render(
    <MemoryRouter>
      <DirectionProvider direction={direction}>
        <FormattingProvider locale="en-US" timezone={timezone}>
          <WhereIAmStage
            range={range}
            priorRange={custom ? comparisonRange(range, "prior", timezone, "MTD")! : undefined}
            currentReport={report(300)}
            priorReport={report(150)}
            months={[]}
            taxonomyCategories={[]}
            incomeCategories={[]}
            savingsCategories={[]}
            budget={undefined}
            currency="USD"
            isLoading={false}
          />
        </FormattingProvider>
      </DirectionProvider>
    </MemoryRouter>,
  );
}

describe("Where I am subcategories", () => {
  const housing = {
    taxonomyId: "spending_categories",
    categoryId: "cat_housing",
    groupId: "needs",
    parentId: null,
    name: "Housing",
    color: "#A35742",
    icon: null,
    target: 0,
    actual: 300,
    rolloverIn: 0,
    rolloverOut: 0,
    remaining: 0,
    overspent: false,
    hasDefaultTarget: false,
    hasMonthOverride: false,
    rolloverEnabled: false,
  };
  const budget = {
    computed: {
      totals: { spendingPlanned: 0 },
      groupRows: [
        {
          group: { id: "needs", name: "Needs", key: "needs", color: "#4F6B92" },
          plannedTotal: 0,
          actual: 300,
          categories: [housing],
        },
      ],
    },
  } as unknown as BudgetSnapshot;

  const day = (date: string, categoryId: string, amount: number) => ({
    date,
    taxonomyId: "spending_categories",
    categoryId,
    amount,
    count: 1,
  });

  const stage = (stageRange: typeof range, extraBuckets: ReturnType<typeof day>[] = []) => (
    <MemoryRouter>
      <FormattingProvider locale="en-US" timezone={timezone}>
        <WhereIAmStage
          range={stageRange}
          currentReport={{
            ...report(300),
            // As the insight projection ships it: top-level rows, with the
            // subcategory detail only in the daily buckets.
            spendingBreakdown: [
              {
                taxonomyId: "spending_categories",
                categoryId: "cat_housing",
                amount: 300,
                count: 2,
              },
            ],
            byDayByCategory: [
              {
                date: "2025-03-08",
                taxonomyId: "spending_categories",
                categoryId: "cat_rent",
                amount: 250,
                count: 1,
              },
              {
                date: "2025-03-09",
                taxonomyId: "spending_categories",
                categoryId: "cat_housing",
                amount: 50,
                count: 1,
              },
              ...extraBuckets,
            ],
          }}
          priorReport={report(150)}
          months={[]}
          taxonomyCategories={[
            {
              id: "cat_housing",
              taxonomyId: "spending_categories",
              parentId: null,
              name: "Housing",
              key: "housing",
              color: "#A35742",
              sortOrder: 0,
              createdAt: "",
              updatedAt: "",
            },
            {
              id: "cat_rent",
              taxonomyId: "spending_categories",
              parentId: "cat_housing",
              name: "Rent",
              key: "rent",
              color: "#A35742",
              sortOrder: 0,
              createdAt: "",
              updatedAt: "",
            },
            {
              id: "cat_shopping",
              taxonomyId: "spending_categories",
              parentId: null,
              name: "Shopping",
              key: "shopping",
              color: "#8E7CB3",
              sortOrder: 0,
              createdAt: "",
              updatedAt: "",
            },
          ]}
          incomeCategories={[]}
          savingsCategories={[]}
          budget={budget}
          currency="USD"
          isLoading={false}
        />
      </FormattingProvider>
    </MemoryRouter>
  );

  it("lists a category's subcategories in the spending plan", () => {
    render(stage(range));
    const plan = within(document.getElementById("breakdown")!);

    fireEvent.click(plan.getByRole("button", { name: "Expand all" }));

    const rent = plan.getByText("Rent").closest("tr")!;
    expect(rent).toHaveTextContent("$250.00");
    // No prior-period amount per subcategory: unknown, not "new".
    expect(rent).toHaveTextContent("—");
    expect(rent).not.toHaveTextContent("new");
    expect(plan.getByText("Direct").closest("tr")).toHaveTextContent("$50.00");
  });

  it("leaves out a category whose spending netted to zero, as the insight does", () => {
    // Returned in full on later days: the backend total is exactly 0, so the
    // insight lists no Shopping row, while the float sum here is 7e-15.
    render(
      stage(range, [
        day("2025-03-08", "cat_shopping", 45.6),
        day("2025-03-09", "cat_shopping", 12.3),
        day("2025-03-10", "cat_shopping", -57.9),
      ]),
    );
    const plan = within(document.getElementById("breakdown")!);

    fireEvent.click(plan.getByRole("button", { name: "Expand all" }));

    expect(plan.queryByText("Shopping")).not.toBeInTheDocument();
    expect(plan.getAllByText("1 of 1 category shown").length).toBeGreaterThan(0);
  });

  it("starts a new date range at the overview", () => {
    const view = render(stage(range));
    fireEvent.click(screen.getByRole("button", { name: "Needs, $300. Show every category" }));
    fireEvent.click(screen.getByRole("button", { name: "Housing, $300. Show subcategories" }));
    expect(screen.getByRole("heading", { name: "Housing" })).toBeInTheDocument();

    view.rerender(
      stage(
        spendingRangeToReportsRange(
          { from: new Date(2025, 3, 1), to: new Date(2025, 3, 30) },
          timezone,
        ),
      ),
    );

    expect(screen.getByRole("heading", { name: "Money flow" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Housing" })).not.toBeInTheDocument();
  });
});

describe("Where I am comparison labels", () => {
  it("labels a custom span as a period and shows the actual prior dates across DST", () => {
    setup(true);
    expect(screen.getByText("SPENT THIS PERIOD")).toBeInTheDocument();
    expect(screen.getByText(/vs Mar 5, 2025 – Mar 7, 2025/)).toBeInTheDocument();
    expect(screen.queryByText("SPENT THIS MONTH")).not.toBeInTheDocument();
    expect(screen.queryByText(/vs Feb/)).not.toBeInTheDocument();
  });
  it("retains month labels for preset month selections", () => {
    setup(false);
    expect(screen.getByText("SPENT THIS MONTH")).toBeInTheDocument();
    expect(screen.getByText(/vs Feb/)).toBeInTheDocument();
  });
  it("keeps the whole short month in a right-to-left page", () => {
    // Formatted values carry bidi isolates there; cutting the string kept "Fe".
    setup(false, "rtl");
    expect(screen.getByText(/vs \u2068Feb\u2069/)).toBeInTheDocument();
  });
});

describe("Net cashflow with money brought back from savings", () => {
  function renderMonth(saved: number, fromSavings: number) {
    const base = report(1500);
    const month = {
      iso: "2025-03-01",
      label: "Mar",
      report: {
        ...base,
        current: {
          income: 1000,
          outflow: 1500,
          saved,
          fromSavings,
          net: 1000 - 1500 - saved + fromSavings,
          count: 4,
        },
      },
      isLoading: false,
    };
    render(
      <MemoryRouter>
        <FormattingProvider locale="en-US" timezone={timezone}>
          <WhereIAmStage
            range={range}
            currentReport={base}
            priorReport={report(150)}
            months={[month]}
            taxonomyCategories={[]}
            incomeCategories={[]}
            savingsCategories={[]}
            budget={undefined}
            currency="USD"
            isLoading={false}
          />
        </FormattingProvider>
      </MemoryRouter>,
    );
    // The label sits in the card's header row.
    return screen.getByText("NET CASHFLOW").parentElement!.parentElement!;
  }

  it("adds back what was drawn from savings, with no Net saved bar for a net withdrawal", () => {
    const card = renderMonth(200, 900);

    expect(card).toHaveTextContent(/\+\$200/);
    expect(within(card).queryByText("Net saved")).not.toBeInTheDocument();
  });

  it("shows only what stayed in savings as saved", () => {
    const card = renderMonth(900, 200);

    expect(card).toHaveTextContent(/−\$1,200/);
    const saved = within(card).getByText("Net saved").parentElement!;
    expect(saved).toHaveTextContent(/\$700/);
  });
});
