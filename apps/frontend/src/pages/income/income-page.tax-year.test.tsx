import type { IncomeSummary } from "@/lib/types";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import IncomePage from "./income-page";

const mocks = vi.hoisted(() => ({ useQuery: vi.fn(), chart: vi.fn() }));

vi.mock("@/adapters", () => ({ getIncomeSummary: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({ useQuery: mocks.useQuery }));
vi.mock("./income-history-chart", () => ({
  IncomeHistoryChart: (props: unknown) => {
    mocks.chart(props);
    return null;
  },
}));
vi.mock("@/components/account-filter-selector", () => ({ AccountScopeSelector: () => null }));
vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: false }),
}));

function summary(
  period: string,
  byMonth: Record<string, number>,
  monthlyAverage: number,
  yoyGrowth: number | null,
): IncomeSummary {
  const totalIncome = Object.values(byMonth).reduce((sum, amount) => sum + amount, 0);
  return {
    period,
    byMonth,
    byType: { DIVIDEND: totalIncome },
    byAsset: {},
    byCurrency: { USD: totalIncome },
    byCurrencyBase: { USD: totalIncome },
    byAccount: {},
    totalIncome,
    currency: "USD",
    monthlyAverage,
    yoyGrowth,
    unconvertedCurrencies: [],
  };
}

const calendarYears = [
  summary("ALL", { "2025-08": 120, "2026-08": 400 }, 520 / 15, null),
  summary("YTD", { "2026-08": 400 }, 40, null),
  summary("LAST_YEAR", { "2025-08": 120 }, 24, null),
  summary("TWO_YEARS_AGO", {}, 0, null),
];

// October 2026 with a 1 July tax year: 400 this tax year (four months) and 120
// last tax year (twelve months).
const withTaxYears = [
  ...calendarYears,
  summary("TAX_YTD", { "2026-08": 400 }, 100, 2.3333),
  summary("LAST_TAX_YEAR", { "2025-08": 120 }, 10, null),
  summary("TWO_TAX_YEARS_AGO", {}, 0, null),
];

function renderPage(summaries: IncomeSummary[]) {
  mocks.useQuery.mockReturnValue({ data: summaries, isLoading: false, error: null });
  render(<IncomePage />);
}

// The desktop and mobile toolbars each have a period selector.
const choose = (name: string) => userEvent.click(screen.getAllByRole("button", { name })[0]);

describe("IncomePage tax years", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("offers only calendar years when the tax year starts on 1 January", () => {
    renderPage(calendarYears);

    expect(screen.getAllByRole("button", { name: "Year to Date" })).not.toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Tax Year to Date" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Last Tax Year" })).not.toBeInTheDocument();
  });

  it("offers tax years beside calendar years", async () => {
    renderPage(withTaxYears);
    await choose("Tax Year to Date");

    expect(screen.getByText("This Tax Year Income")).toBeInTheDocument();
    // 100 a month against last tax year's 10.
    expect(screen.getByText("+900.00%")).toBeInTheDocument();

    await choose("Year to Date");
    expect(screen.getByText("This Year Income")).toBeInTheDocument();
  });

  it("shows no change when the tax year before had no income", async () => {
    renderPage(withTaxYears);
    await choose("Last Tax Year");

    expect(screen.getByText("Last Tax Year Income")).toBeInTheDocument();
    expect(screen.getAllByText("No comparison with the tax year before")).toHaveLength(2);
  });

  it("charts all 13 months of a 6 April tax year against the last tax year's part of each", async () => {
    // Today is 3 April 2027, in the tax year that started on 6 April 2026.
    const april = summary(
      "TAX_YTD",
      {
        "2026-04": 10,
        "2026-05": 1,
        "2026-06": 1,
        "2026-07": 1,
        "2026-08": 1,
        "2026-09": 1,
        "2026-10": 1,
        "2026-11": 1,
        "2026-12": 1,
        "2027-01": 1,
        "2027-02": 1,
        "2027-03": 1,
        "2027-04": 5,
      },
      2,
      null,
    );
    renderPage([
      // 1–5 April 2025 belongs to the tax year before, which ALL includes.
      summary("ALL", { "2025-04": 1010, "2026-04": 30 }, 1, null),
      summary("YTD", {}, 0, null),
      summary("LAST_YEAR", {}, 0, null),
      summary("TWO_YEARS_AGO", {}, 0, null),
      april,
      summary("LAST_TAX_YEAR", { "2025-04": 10, "2026-04": 20 }, 1, null),
      summary("TWO_TAX_YEARS_AGO", { "2025-04": 1000 }, 1, null),
    ]);
    await choose("Tax Year to Date");

    const { monthlyIncomeData, previousMonthlyIncomeData } = mocks.chart.mock.lastCall?.[0] as {
      monthlyIncomeData: [string, number][];
      previousMonthlyIncomeData: [string, number][];
    };
    expect(monthlyIncomeData).toHaveLength(13);
    expect(monthlyIncomeData[0]).toEqual(["2026-04", 10]);
    expect(previousMonthlyIncomeData[0]).toEqual(["2026-04", 10]);
    expect(previousMonthlyIncomeData[12]).toEqual(["2027-04", 20]);
  });
});
