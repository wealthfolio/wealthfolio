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

function setup() {
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
          allocations={[food]}
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
      "Food: 1234.50 / 1000.00",
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
