import { render, screen } from "@testing-library/react";
import { FormattingProvider } from "@wealthfolio/ui";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { BudgetCategoryRow } from "../types/budget";
import { BudgetLineChartCard } from "./budget-line-chart-card";

vi.mock("@/components/dashboard-card", () => ({
  DashboardCard: ({ children }: { children: ReactNode }) => <section>{children}</section>,
}));

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
            allocations={[{ categoryId: "food", target } as BudgetCategoryRow]}
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
