import { render, screen } from "@testing-library/react";
import { FormattingProvider } from "@wealthfolio/ui";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { BreakdownTable } from "./breakdown-table";
import type { ParsedNetWorth } from "./utils";

vi.mock("@/components/dashboard-card", () => ({
  DashboardCard: ({ children }: { children: ReactNode }) => <section>{children}</section>,
}));
vi.mock("./compact-amount", () => ({
  CompactAmount: ({ value }: { value: number }) => <span>{value}</span>,
}));

const data: ParsedNetWorth = {
  netWorth: 1000,
  assets: {
    total: 1000,
    breakdown: [
      { category: "investments", name: "Investments", value: 333 },
      { category: "cash", name: "Cash", value: 667 },
    ],
  },
  liabilities: { total: 0, breakdown: [] },
};

describe("net worth breakdown regional percentages", () => {
  it.each([
    ["ES", "33,3 %", "66,7 %"],
    ["US", "33.3%", "66.7%"],
  ])("uses %s for category shares", (locale, investments, cash) => {
    render(
      <FormattingProvider locale={locale}>
        <BreakdownTable
          data={data}
          history={[]}
          currency="USD"
          periodLabel="past month"
          onSelect={vi.fn()}
        />
      </FormattingProvider>,
    );
    expect(screen.getByText(investments)).toBeInTheDocument();
    expect(screen.getByText(cash)).toBeInTheDocument();
  });
});
