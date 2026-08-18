import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { HoldingType, QuoteMode } from "@/lib/constants";
import type { Holding } from "@/lib/types";

import { HoldingsTableMobile } from "./holdings-table-mobile";

vi.mock("@/components/ticker-avatar", () => ({
  TickerAvatar: () => <div data-testid="ticker-avatar" />,
}));

vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: false }),
}));

vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => vi.fn(),
}));

vi.mock("./holdings-mobile-filter-sheet", () => ({
  HoldingsMobileFilterSheet: () => null,
}));

const cashHolding: Holding = {
  id: "cash-usd",
  accountId: "account-1",
  holdingType: HoldingType.CASH,
  instrument: {
    id: "cash:USD",
    symbol: "USD",
    name: "Cash (USD)",
    currency: "USD",
    quoteMode: QuoteMode.MANUAL,
  },
  quantity: 250,
  localCurrency: "USD",
  baseCurrency: "USD",
  marketValue: { local: 250, base: 250 },
  weight: 0.25,
  asOfDate: "2026-08-18",
};

describe("HoldingsTableMobile", () => {
  it("keeps its controls available while holdings load", () => {
    render(
      <HoldingsTableMobile
        holdings={[]}
        isLoading
        selectedTypes={[]}
        setSelectedTypes={vi.fn()}
        accountFilter={{ type: "all" }}
        onAccountScopeChange={vi.fn()}
        accounts={[]}
        portfolios={[]}
        toolbarActions={<button type="button">Open actions</button>}
      />,
    );

    expect(screen.getByPlaceholderText("Search...")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open holdings filters" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open actions" })).toBeInTheDocument();
    expect(screen.queryByText("No positions found")).not.toBeInTheDocument();
  });

  it("shows portfolio weight below a cash balance", () => {
    render(
      <HoldingsTableMobile
        holdings={[cashHolding]}
        isLoading={false}
        selectedTypes={[]}
        setSelectedTypes={vi.fn()}
        accountFilter={{ type: "all" }}
        onAccountScopeChange={vi.fn()}
        accounts={[]}
        portfolios={[]}
        showSearch={false}
        showFilterButton={false}
      />,
    );

    expect(screen.getByText("Weight 25.00%")).toBeInTheDocument();
  });

  it("suggests changing filters when closed positions are hidden", () => {
    render(
      <HoldingsTableMobile
        holdings={[]}
        isLoading={false}
        selectedTypes={[]}
        setSelectedTypes={vi.fn()}
        accountFilter={{ type: "all" }}
        onAccountScopeChange={vi.fn()}
        accounts={[]}
        portfolios={[]}
        hasHiddenPositions
      />,
    );

    expect(screen.getByText("Try adjusting your search or filter criteria.")).toBeInTheDocument();
    expect(
      screen.queryByText("Add activities to see your positions here."),
    ).not.toBeInTheDocument();
  });
});
