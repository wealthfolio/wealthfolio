import { render, screen } from "@testing-library/react";
import { FormattingProvider } from "@wealthfolio/ui";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BudgetCategoryRow } from "../types/budget";
import { BudgetLineChartCard } from "./budget-line-chart-card";

const food: BudgetCategoryRow = {
  taxonomyId: "spending_categories",
  categoryId: "food",
  groupId: null,
  parentId: null,
  name: "Food",
  color: null,
  icon: null,
  target: 1000,
  actual: 1234.5,
  rolloverIn: 0,
  rolloverOut: 0,
  remaining: -234.5,
  overspent: true,
  hasDefaultTarget: true,
  hasMonthOverride: false,
  rolloverEnabled: false,
};

const savingsGoal: BudgetCategoryRow = {
  ...food,
  taxonomyId: "savings_categories",
  categoryId: "cat_savings",
  name: "Savings",
  target: 400,
  actual: 350,
  remaining: 50,
  overspent: false,
};

function setup(allocations: BudgetCategoryRow[] = [food]) {
  return render(
    <MemoryRouter>
      <FormattingProvider locale="en-US" timezone="UTC">
        <BudgetLineChartCard
          monthKey="2026-10"
          today={{ year: 2026, month: 10, day: 16 }}
          isCurrentMonth
          onPreviousMonth={vi.fn()}
          onNextMonth={vi.fn()}
          canGoNextMonth={false}
          activityRange={{ from: "2026-10-01", to: "2026-10-31" }}
          target={1000}
          spent={1234.5}
          currency="USD"
          historicalDailyAvg={0}
          allocations={allocations}
          spendingBreakdown={[{ categoryId: "food", amount: 1234.5, count: 3 }]}
          categoriesMeta={
            new Map([["food", { name: "Food", color: null, icon: null, parentId: null }]])
          }
          monthByDay={[{ date: "2026-10-05", income: 0, outflow: 1234.5 }]}
          historicalByDay={[]}
        />
      </FormattingProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  localStorage.removeItem("privacy-settings");
});

describe("BudgetLineChartCard with Hide Balance", () => {
  it("shows the pace pill amount and the ring's amounts when amounts are visible", () => {
    setup();

    expect(screen.getByText("$235 over budget")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /\$235/ })).toHaveAttribute(
      "title",
      "Food: 1,234.50 / 1,000.00",
    );
  });

  it("masks the pace pill amount and the ring's tooltip", () => {
    // The card and `PrivacyAmount` read the stored setting the privacy hook is built on.
    localStorage.setItem("privacy-settings", "true");
    const { container } = setup();

    expect(screen.getByText("•••• over budget")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /••••/ })).toHaveAttribute(
      "title",
      "Food: •••• / ••••",
    );
    expect(container.textContent).not.toMatch(/\$/);
  });
});

describe("BudgetLineChartCard spending rings", () => {
  it("rings only expense categories, not savings goals", () => {
    setup([food, savingsGoal]);

    expect(screen.getAllByRole("link", { name: /\$/ })).toHaveLength(1);
    expect(screen.getByRole("link", { name: /\$235/ })).toHaveAttribute(
      "title",
      "Food: 1,234.50 / 1,000.00",
    );
  });
});

describe("BudgetLineChartCard", () => {
  it.each([
    ["JPY", 1234, 1000, "food: 1,234 / 1,000"],
    ["KWD", 1.2345, 1, "food: 1.235 / 1.000"],
    ["EUR", 1234.5, 1000, "food: 1.234,50 / 1.000,00"],
  ])("formats a %s ring's tooltip in the currency's format", (currency, spent, target, title) => {
    render(
      <MemoryRouter>
        <FormattingProvider locale="US" currencyFormattingRegions={{ EUR: "DE" }}>
          <BudgetLineChartCard
            monthKey="2026-09"
            today={{ year: 2026, month: 9, day: 30 }}
            isCurrentMonth={false}
            onPreviousMonth={vi.fn()}
            onNextMonth={vi.fn()}
            canGoNextMonth={false}
            activityRange={{ from: "2026-09-01", to: "2026-09-30" }}
            target={target}
            spent={spent}
            currency={currency}
            historicalDailyAvg={0}
            allocations={[
              {
                taxonomyId: "spending_categories",
                categoryId: "food",
                target,
              } as BudgetCategoryRow,
            ]}
            spendingBreakdown={[{ categoryId: "food", amount: spent, count: 1 }]}
            categoriesMeta={new Map()}
            monthByDay={[]}
            historicalByDay={[]}
          />
        </FormattingProvider>
      </MemoryRouter>,
    );

    expect(screen.getByTitle(title)).toBeInTheDocument();
  });
});
