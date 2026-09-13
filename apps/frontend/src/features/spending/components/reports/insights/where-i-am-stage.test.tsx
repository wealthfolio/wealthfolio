import { render, screen } from "@testing-library/react";
import { FormattingProvider } from "@wealthfolio/ui";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { WhereIAmStage } from "./where-i-am-stage";
import type { MonthlyReport } from "../../../types/report";
import { comparisonRange } from "../../../lib/reports-period";
import { spendingRangeToReportsRange } from "../../../lib/date-range-params";

vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: false }),
}));

function report(outflow: number): MonthlyReport {
  const summary = { income: 0, outflow, saved: 0, net: -outflow, count: 1 };
  return {
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

function setup(custom: boolean) {
  render(
    <MemoryRouter>
      <FormattingProvider locale="en-US" timezone={timezone}>
        <WhereIAmStage
          range={range}
          priorRange={custom ? comparisonRange(range, "prior", timezone)! : undefined}
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
    </MemoryRouter>,
  );
}

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
});
