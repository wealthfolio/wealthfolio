import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HoldingType, QuoteMode } from "@/lib/constants";
import type { Holding } from "@/lib/types";
import { HoldingsTable } from "./holdings-table";

vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: false }),
}));

vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: { baseCurrency: "USD" } }),
}));

vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => vi.fn(),
}));

const closedHolding: Holding = {
  id: "closed-xyz",
  accountId: "account-1",
  holdingType: HoldingType.SECURITY,
  isClosed: true,
  quantity: 0,
  localCurrency: "USD",
  baseCurrency: "USD",
  marketValue: { local: 0, base: 0 },
  costBasis: { local: 0, base: 0 },
  returnBasis: { local: 100, base: 100 },
  realizedGain: { local: 10, base: 10 },
  weight: 0,
  asOfDate: "2026-08-18",
  instrument: {
    id: "asset-xyz",
    symbol: "XYZ",
    name: "Acme Corporation",
    currency: "USD",
    quoteMode: QuoteMode.MARKET,
  },
};

describe("HoldingsTable search", () => {
  beforeEach(() => window.localStorage.clear());

  it("finds a closed position by instrument name", () => {
    render(
      <HoldingsTable holdings={[closedHolding]} isLoading={false} visibilityFilters={["closed"]} />,
    );

    const search = screen.getByPlaceholderText("Search ...");
    fireEvent.change(search, { target: { value: "Acme" } });
    fireEvent.keyDown(search, { key: "Enter" });

    expect(screen.queryByText("No results found.")).not.toBeInTheDocument();
    expect(screen.getByText("Acme Corporation")).toBeInTheDocument();
  });
});
