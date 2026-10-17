import { AccountType, HoldingType } from "@/lib/constants";
import type { Account, Holding } from "@/lib/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { FormattingProvider, type CurrencyFormattingRegions } from "@wealthfolio/ui";
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

describe("HoldingsEditMode formatting", () => {
  it("formats row totals by currency, in its minor units, and updates while editing", () => {
    const client = new QueryClient();
    const editor = (regions: CurrencyFormattingRegions) => (
      <QueryClientProvider client={client}>
        <FormattingProvider locale="US" currencyFormattingRegions={regions}>
          <HoldingsEditMode
            holdings={holdings}
            account={account}
            isLoading={false}
            onClose={vi.fn()}
          />
        </FormattingProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(editor({ INR: "IN", JPY: "JP" }));

    expect(screen.getByText("12,34,560.00")).toBeInTheDocument();
    expect(screen.getByText("1,234,560.00")).toBeInTheDocument();
    expect(screen.getByText("1,234,560")).toBeInTheDocument();
    expect(screen.getByText("1,234,560.000")).toBeInTheDocument();

    const quantity = screen.getAllByRole("textbox")[0];
    fireEvent.change(quantity, { target: { value: "2,000" } });
    expect(screen.getByText("24,69,120.00")).toBeInTheDocument();

    rerender(editor({ INR: "DE", JPY: "JP" }));
    expect(screen.getByText("2.469.120,00")).toBeInTheDocument();
    expect(screen.getByText("1,234,560.00")).toBeInTheDocument();
    expect(screen.getByText("1,234,560")).toBeInTheDocument();
    expect(quantity).toHaveValue("2,000");
  });
});
