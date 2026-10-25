import { getSnapshotByDate, saveManualHoldings } from "@/adapters";
import { AccountType, HoldingType } from "@/lib/constants";
import type { Account, Holding } from "@/lib/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FormattingProvider } from "@wealthfolio/ui";
import { Activity } from "react";
import { describe, expect, it, vi } from "vitest";
import { HoldingsEditMode } from "./holdings-edit-mode";

vi.mock("@/adapters", () => ({
  deleteSnapshot: vi.fn(),
  getSnapshotByDate: vi.fn(),
  saveManualHoldings: vi.fn(),
}));
vi.mock("@/components/ticker-avatar", () => ({ TickerAvatar: () => null }));
vi.mock("@/components/ticker-search", () => ({ default: () => null }));

const account: Account = {
  id: "account-1",
  name: "Brokerage",
  accountType: AccountType.SECURITIES,
  balance: 0,
  currency: "USD",
  isDefault: false,
  isActive: true,
  isArchived: false,
  trackingMode: "HOLDINGS",
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

const holdings: Holding[] = ["INR", "USD", "JPY", "KWD"].map((currency) => ({
  id: `asset-${currency}`,
  accountId: account.id,
  holdingType: HoldingType.SECURITY,
  quantity: 1000,
  localCurrency: currency,
  baseCurrency: "USD",
  costBasis: { local: 1234560, base: 1234560 },
  marketValue: { local: 1234560, base: 1234560 },
  weight: 1 / 3,
  asOfDate: "2026-09-01",
}));

const makeHolding = (overrides: Partial<Holding> = {}): Holding => ({
  id: "AAPL",
  accountId: account.id,
  holdingType: HoldingType.SECURITY,
  quantity: 10,
  localCurrency: "USD",
  baseCurrency: "USD",
  costBasis: { local: 250, base: 250 },
  marketValue: { local: 250, base: 250 },
  weight: 1,
  asOfDate: "2026-01-01",
  ...overrides,
});

const holdingFor = (symbol: string): Holding => makeHolding({ id: symbol });

const renderHoldings = (list: Holding[], locale = "US") =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <FormattingProvider locale={locale}>
        <HoldingsEditMode holdings={list} account={account} isLoading={false} onClose={vi.fn()} />
      </FormattingProvider>
    </QueryClientProvider>,
  );

const renderEditMode = (holding: Holding = makeHolding(), locale = "US") =>
  renderHoldings([holding], locale);

describe("HoldingsEditMode cost fields", () => {
  it("shows each row's cost basis in the editable Total", () => {
    renderHoldings(holdings);

    expect(screen.getByTestId("holding-total-cost-asset-INR")).toHaveValue("1234560");
    expect(screen.getByTestId("holding-average-cost-asset-INR")).toHaveValue("1234.56");
  });

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
    const displayedAverageCost = screen.getByTestId<HTMLInputElement>("holding-average-cost-AAPL");
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

  it.each([
    ["1000000000", "25", "0.000000025"],
    ["1000000000000", "25", "0.000000000025"],
    ["1000000000", "0.01", "0.00000000001"],
    ["999999999", "25", "0.000000025000000025"],
    ["1000000000", "1", "0.000000001"],
  ])(
    "persists an extreme average cost for %s shares over a %s total",
    async (shares, total, expectedAverageCost) => {
      const saveMock = vi.mocked(saveManualHoldings);
      saveMock.mockClear();
      renderEditMode();

      fireEvent.change(screen.getByTestId("holding-shares-AAPL"), {
        target: { value: shares },
      });
      fireEvent.change(screen.getByTestId("holding-total-cost-AAPL"), {
        target: { value: total },
      });

      fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
      await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
      expect(saveMock.mock.calls[0]?.[1]?.[0]?.averageCost).toBe(expectedAverageCost);
    },
  );

  it("shows and persists the precise average cost", async () => {
    const saveMock = vi.mocked(saveManualHoldings);
    saveMock.mockClear();
    renderEditMode();

    fireEvent.change(screen.getByTestId("holding-shares-AAPL"), {
      target: { value: "1000000000" },
    });
    fireEvent.change(screen.getByTestId("holding-total-cost-AAPL"), {
      target: { value: "25" },
    });

    // The field shows the derived value instead of rounding it to 8 decimals,
    // and the payload matches so the saved cost basis is 1e9 × 0.000000025 = 25.
    expect(screen.getByTestId("holding-average-cost-AAPL")).toHaveValue("0.000000025");

    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    expect(saveMock.mock.calls[0]?.[1]?.[0]?.averageCost).toBe("0.000000025");
  });
});

describe("HoldingsEditMode on a kept screen", () => {
  it("keeps snapshot edits when its phone screen is shown again", async () => {
    // A phone screen kept under another one is a hidden <Activity>, whose
    // effects run again when it is shown.
    vi.mocked(getSnapshotByDate).mockResolvedValue([makeHolding()]);
    const client = new QueryClient();
    const view = (hidden: boolean) => (
      <QueryClientProvider client={client}>
        <FormattingProvider locale="US">
          <Activity mode={hidden ? "hidden" : "visible"}>
            <HoldingsEditMode
              holdings={[]}
              account={account}
              isLoading={false}
              onClose={vi.fn()}
              existingSnapshotDate="2026-01-01"
            />
          </Activity>
        </FormattingProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(view(false));
    fireEvent.change(await screen.findByTestId("holding-shares-AAPL"), {
      target: { value: "20" },
    });

    rerender(view(true));
    rerender(view(false));

    expect(screen.getByTestId("holding-shares-AAPL")).toHaveValue("20");
  });
});
