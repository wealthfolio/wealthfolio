import { fireEvent, render, screen } from "@/test/render";
import { HoldingType, QuoteMode } from "@/lib/constants";
import type { Holding } from "@/lib/types";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { HoldingsTableMobile } from "./holdings-table-mobile";

vi.mock("@/components/ticker-avatar", () => ({
  TickerAvatar: () => <div data-testid="ticker-avatar" />,
}));
vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: false }),
}));
vi.mock("./holdings-mobile-filter-sheet", () => ({ HoldingsMobileFilterSheet: () => null }));
vi.mock("./cash-holdings-sheet", () => ({
  CashHoldingsSheet: ({ currency, onClose }: { currency: string; onClose: () => void }) => (
    <div role="dialog" aria-label={`Cash (${currency})`}>
      <button onClick={onClose}>Close cash</button>
    </div>
  ),
}));

const security = {
  id: "holding-1",
  holdingType: "security",
  localCurrency: "USD",
  instrument: { id: "asset/with space", symbol: "TEST", name: "Test investment" },
} as Holding;
const cash = {
  id: "$CASH-USD",
  holdingType: "cash",
  localCurrency: "USD",
  instrument: { id: "$CASH-USD", symbol: "$CASH-USD" },
} as Holding;

function Detail() {
  const { state } = useLocation();
  const { holding } = state as { holding: Holding };
  return <div role="status">{holding.id}</div>;
}

it("opens cash details and preserves security link navigation", () => {
  render(
    <MemoryRouter initialEntries={["/holdings"]}>
      <Routes>
        <Route
          path="/holdings"
          element={
            <HoldingsTableMobile
              holdings={[security, cash]}
              isLoading={false}
              selectedTypes={[]}
              setSelectedTypes={vi.fn()}
              accountFilter={{ type: "all" }}
              onAccountScopeChange={vi.fn()}
              accounts={[]}
              portfolios={[]}
              showAccountScope={false}
              showSearch={false}
              showFilterButton={false}
            />
          }
        />
        <Route path="/holdings/:id" element={<Detail />} />
      </Routes>
    </MemoryRouter>,
  );
  const link = screen.getByRole("link", { name: /TEST/ });
  expect(link).toHaveAttribute("href", "/holdings/asset%2Fwith%20space");
  expect(screen.getAllByRole("link")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Details for Cash (USD)" }));
  expect(screen.getByRole("dialog", { name: "Cash (USD)" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Close cash" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  fireEvent.click(link);
  expect(screen.getByRole("status")).toHaveTextContent("holding-1");
});

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
  it("does not reopen cash details when a removed balance returns", () => {
    const view = (holdings: Holding[]) => (
      <HoldingsTableMobile
        holdings={holdings}
        isLoading={false}
        selectedTypes={[]}
        setSelectedTypes={vi.fn()}
        accountFilter={{ type: "all" }}
        onAccountScopeChange={vi.fn()}
        accounts={[]}
        portfolios={[]}
        showAccountScope={false}
        showSearch={false}
        showFilterButton={false}
      />
    );
    const { rerender } = render(view([cashHolding]));
    fireEvent.click(screen.getByRole("button", { name: "Details for Cash (USD)" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    rerender(view([]));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    rerender(view([cashHolding]));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Details for Cash (USD)" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

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
