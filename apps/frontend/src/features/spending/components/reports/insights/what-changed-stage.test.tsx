import { render, screen } from "@testing-library/react";
import { FormattingProvider } from "@wealthfolio/ui";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import type { TaxonomyCategory } from "@/lib/types";
import type { ReportsRange } from "../../../lib/reports-period";
import type { CategoryBreakdownRow, MonthlyReport } from "../../../types/report";
import { WhatChangedStage } from "./what-changed-stage";

vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: false }),
}));

const categories: TaxonomyCategory[] = [
  {
    id: "shopping",
    taxonomyId: "spending_categories",
    name: "Shopping",
    key: "shopping",
    color: "#123456",
    sortOrder: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
  {
    id: "food",
    taxonomyId: "spending_categories",
    name: "Food",
    key: "food",
    color: "#654321",
    sortOrder: 2,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
];

function report(
  outflow: number,
  count: number,
  spendingBreakdown: CategoryBreakdownRow[],
): MonthlyReport {
  return {
    current: { income: 0, outflow, saved: 0, net: -outflow, count },
    prior: { income: 0, outflow: 0, saved: 0, net: 0, count: 0 },
    spendingBreakdown,
    incomeBreakdown: [],
    savingsBreakdown: [],
    byDay: [],
    byDayByCategory: [],
  };
}

const range: ReportsRange = {
  start: new Date("2026-08-01T00:00:00Z"),
  end: new Date("2026-08-18T23:59:59Z"),
  days: 18,
  months: 1,
};

const priorRange: ReportsRange = {
  start: new Date("2026-07-01T00:00:00Z"),
  end: new Date("2026-07-18T23:59:59Z"),
  days: 18,
  months: 1,
};

describe("WhatChangedStage localization", () => {
  it("formats impact percentages with the formatting locale", () => {
    render(
      <MemoryRouter>
        <FormattingProvider locale="fr-FR" uiLocale="en" timezone="UTC">
          <WhatChangedStage
            range={range}
            priorRange={priorRange}
            timezone="UTC"
            currentReport={report(0, 0, [])}
            priorReport={report(100, 2, [
              {
                taxonomyId: "spending_categories",
                categoryId: "shopping",
                amount: 61,
                count: 1,
              },
              {
                taxonomyId: "spending_categories",
                categoryId: "food",
                amount: 39,
                count: 1,
              },
            ])}
            months={[]}
            taxonomyCategories={categories}
            currency="CAD"
            isLoading={false}
          />
        </FormattingProvider>
      </MemoryRouter>,
    );

    expect(screen.getByText(/^61[\u00a0\u202f ]%$/)).toBeInTheDocument();
  });
});
