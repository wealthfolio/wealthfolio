import type { IncomeSummary } from "@/lib/types";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import IncomePage from "./income-page";

const mocks = vi.hoisted(() => ({ useQuery: vi.fn() }));

vi.mock("@/adapters", () => ({ getIncomeSummary: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({ useQuery: mocks.useQuery }));
vi.mock("./income-history-chart", () => ({ IncomeHistoryChart: () => null }));
vi.mock("@/components/account-filter-selector", () => ({ AccountScopeSelector: () => null }));
vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: false }),
}));

function renderWith(unconvertedCurrencies: string[]) {
  const summary: IncomeSummary = {
    period: "ALL",
    byMonth: {},
    byType: { INTEREST: 2500 },
    byAsset: {},
    byCurrency: { USD: 2500, INR: 1234567.89, JPY: 50000 },
    byCurrencyBase: { USD: 2500 },
    byAccount: {},
    totalIncome: 2500,
    currency: "USD",
    monthlyAverage: 147.06,
    yoyGrowth: null,
    unconvertedCurrencies,
  };
  mocks.useQuery.mockReturnValue({ data: [summary], isLoading: false, error: null });
  render(<IncomePage />);
}

describe("IncomePage unconverted currencies", () => {
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

  it("names a currency left out of the totals", () => {
    renderWith(["INR"]);

    expect(
      screen.getByText(
        "Income in INR is left out of the totals because there is no exchange rate to USD.",
      ),
    ).toBeInTheDocument();
  });

  it("lists every currency left out of the totals", () => {
    renderWith(["INR", "JPY"]);

    expect(
      screen.getByText(
        "Income in INR and JPY is left out of the totals because there are no exchange rates to USD.",
      ),
    ).toBeInTheDocument();
  });

  it("shows no notice when every amount was converted", () => {
    renderWith([]);

    expect(screen.getByText("All Time Income")).toBeInTheDocument();
    expect(screen.queryByText(/left out of the totals/)).not.toBeInTheDocument();
  });
});
