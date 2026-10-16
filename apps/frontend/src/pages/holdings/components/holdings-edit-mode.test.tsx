import { saveManualHoldings } from "@/adapters";
import { HoldingType, QuoteMode } from "@/lib/constants";
import type { Account, Holding } from "@/lib/types";
import { fireEvent, render, screen, waitFor } from "@/test/render";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FormattingProvider } from "@wealthfolio/ui";
import { describe, expect, it, vi } from "vitest";

import { HoldingsEditMode } from "./holdings-edit-mode";

vi.mock("@/adapters", () => ({
  getSnapshotByDate: vi.fn(),
  saveManualHoldings: vi.fn(),
  deleteSnapshot: vi.fn(),
}));

vi.mock("@/components/ticker-search", () => ({
  default: () => null,
}));

const account: Account = {
  id: "account-1",
  name: "Brokerage",
  accountType: "SECURITIES" as Account["accountType"],
  balance: 0,
  currency: "USD",
  isDefault: true,
  isActive: true,
  isArchived: false,
  trackingMode: "HOLDINGS" as Account["trackingMode"],
  createdAt: new Date(),
  updatedAt: new Date(),
};

const makeHolding = (overrides: Partial<Holding> = {}): Holding => ({
  id: "AAPL",
  accountId: "account-1",
  holdingType: HoldingType.SECURITY,
  quantity: 10,
  localCurrency: "USD",
  baseCurrency: "USD",
  marketValue: { local: 250, base: 250 },
  costBasis: { local: 250, base: 250 },
  weight: 100,
  asOfDate: "2026-01-01",
  instrument: {
    id: "AAPL",
    symbol: "AAPL",
    currency: "USD",
    quoteMode: QuoteMode.MARKET,
  },
  ...overrides,
});

const holdingFor = (symbol: string): Holding =>
  makeHolding({
    id: symbol,
    instrument: { id: symbol, symbol, currency: "USD", quoteMode: QuoteMode.MARKET },
  });

const renderHoldings = (holdings: Holding[], locale = "en-US") =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <HoldingsEditMode holdings={holdings} account={account} isLoading={false} onClose={vi.fn()} />
    </QueryClientProvider>,
    {
      wrapper: ({ children }) => (
        <FormattingProvider locale={locale}>{children}</FormattingProvider>
      ),
    },
  );

const renderEditMode = (holding: Holding = makeHolding()) => renderHoldings([holding]);

describe("HoldingsEditMode cost fields", () => {
  it("recomputes cost per share when total cost is edited", () => {
    renderEditMode();
    const averageCost = screen.getByTestId("holding-average-cost-AAPL");
    const totalCost = screen.getByTestId("holding-total-cost-AAPL");

    expect(averageCost).toHaveValue("25");
    expect(totalCost).toHaveValue("250");

    fireEvent.change(totalCost, { target: { value: "500" } });

    expect(averageCost).toHaveValue("50");
    expect(totalCost).toHaveValue("500");
  });

  it("recomputes total cost when cost per share is edited", () => {
    renderEditMode();
    const averageCost = screen.getByTestId("holding-average-cost-AAPL");
    const totalCost = screen.getByTestId("holding-total-cost-AAPL");

    fireEvent.change(averageCost, { target: { value: "30" } });

    expect(totalCost).toHaveValue("300");
    expect(averageCost).toHaveValue("30");
  });

  it("recomputes total cost from cost per share when shares change", () => {
    renderEditMode();
    const averageCost = screen.getByTestId("holding-average-cost-AAPL");
    const totalCost = screen.getByTestId("holding-total-cost-AAPL");
    const shares = screen.getByTestId("holding-shares-AAPL");

    fireEvent.change(shares, { target: { value: "20" } });

    expect(averageCost).toHaveValue("25");
    expect(totalCost).toHaveValue("500");
  });

  it("keeps a Total entered before shares and derives cost per share", () => {
    renderEditMode(makeHolding({ quantity: 0, costBasis: { local: 0, base: 0 } }));
    const averageCost = screen.getByTestId("holding-average-cost-AAPL");
    const totalCost = screen.getByTestId("holding-total-cost-AAPL");
    const shares = screen.getByTestId("holding-shares-AAPL");

    // Total is entered first, while shares are still zero.
    fireEvent.change(totalCost, { target: { value: "500" } });
    expect(totalCost).toHaveValue("500");
    expect(averageCost).toHaveValue("");

    // Entering shares should preserve the Total and derive cost per share.
    fireEvent.change(shares, { target: { value: "10" } });

    expect(totalCost).toHaveValue("500");
    expect(averageCost).toHaveValue("50");
  });

  it("keeps a Total edited last when shares change", () => {
    renderEditMode();
    const averageCost = screen.getByTestId("holding-average-cost-AAPL");
    const totalCost = screen.getByTestId("holding-total-cost-AAPL");
    const shares = screen.getByTestId("holding-shares-AAPL");

    fireEvent.change(totalCost, { target: { value: "500" } });
    expect(averageCost).toHaveValue("50");

    fireEvent.change(shares, { target: { value: "20" } });

    expect(totalCost).toHaveValue("500");
    expect(averageCost).toHaveValue("25");
  });

  it("keeps each row's cost fields independent", () => {
    renderHoldings([holdingFor("AAPL"), holdingFor("MSFT")]);

    const aaplAverage = screen.getByTestId("holding-average-cost-AAPL");
    const aaplTotal = screen.getByTestId("holding-total-cost-AAPL");
    const aaplShares = screen.getByTestId("holding-shares-AAPL");
    const msftAverage = screen.getByTestId("holding-average-cost-MSFT");
    const msftTotal = screen.getByTestId("holding-total-cost-MSFT");
    const msftShares = screen.getByTestId("holding-shares-MSFT");

    // Edit only the first row.
    fireEvent.change(aaplTotal, { target: { value: "500" } });
    fireEvent.change(aaplShares, { target: { value: "20" } });

    // The first row honours its own last-touched field (Total kept).
    expect(aaplTotal).toHaveValue("500");
    expect(aaplAverage).toHaveValue("25");

    // The second row kept its own values and its own default, so a shares edit
    // still re-derives Total from Avg Cost: the first row's intent did not leak.
    expect(msftTotal).toHaveValue("250");
    expect(msftAverage).toHaveValue("25");

    fireEvent.change(msftShares, { target: { value: "20" } });

    expect(msftTotal).toHaveValue("500");
    expect(msftAverage).toHaveValue("25");

    // Editing the second row left the first row alone.
    expect(aaplTotal).toHaveValue("500");
    expect(aaplAverage).toHaveValue("25");
  });

  it("persists the derived cost per share at full precision", async () => {
    const saveMock = vi.mocked(saveManualHoldings);
    saveMock.mockClear();
    renderEditMode();

    // Total 25 over 1e9 units needs 9 decimals per share (0.000000025); the
    // persisted value must reproduce the entered total when multiplied back.
    fireEvent.change(screen.getByTestId("holding-shares-AAPL"), {
      target: { value: "1000000000" },
    });
    fireEvent.change(screen.getByTestId("holding-total-cost-AAPL"), {
      target: { value: "25" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() =>
      expect(saveMock).toHaveBeenCalledWith(
        "account-1",
        [expect.objectContaining({ quantity: "1000000000", averageCost: "0.000000025" })],
        {},
        expect.any(String),
      ),
    );
  });

  it("keeps the persisted cost accurate regardless of share count", async () => {
    const saveMock = vi.mocked(saveManualHoldings);
    saveMock.mockClear();
    renderEditMode();

    // 25 ÷ 1000000001 is non-terminating, so a fixed 15-decimal average drifts
    // by ~3e-8 here; significant-digit precision must still reconstruct 25.
    fireEvent.change(screen.getByTestId("holding-shares-AAPL"), {
      target: { value: "1000000001" },
    });
    fireEvent.change(screen.getByTestId("holding-total-cost-AAPL"), {
      target: { value: "25" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    const savedAverageCost = Number(saveMock.mock.calls[0]?.[1]?.[0]?.averageCost);
    expect(savedAverageCost * 1000000001).toBeCloseTo(25, 8);
  });

  it("localizes the displayed cost but persists a canonical decimal", async () => {
    const saveMock = vi.mocked(saveManualHoldings);
    saveMock.mockClear();
    renderHoldings([holdingFor("AAPL")], "de-DE");

    fireEvent.change(screen.getByTestId("holding-shares-AAPL"), {
      target: { value: "1000000000" },
    });
    fireEvent.change(screen.getByTestId("holding-total-cost-AAPL"), {
      target: { value: "25" },
    });

    // Displayed with the user's locale (comma), not the canonical "."…
    const displayedAverageCost = screen.getByTestId(
      "holding-average-cost-AAPL",
    ) as HTMLInputElement;
    expect(displayedAverageCost.value).toContain(",");
    expect(displayedAverageCost.value).not.toContain(".");

    // …but saved with the canonical "." the backend parses.
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() =>
      expect(saveMock).toHaveBeenCalledWith(
        "account-1",
        [expect.objectContaining({ averageCost: "0.000000025" })],
        {},
        expect.any(String),
      ),
    );
  });
});
