import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AccountType } from "@/lib/constants";
import type { Account, Holding } from "@/lib/types";
import AccountHoldings from "./account-holdings";

const mocks = vi.hoisted(() => ({
  useHoldingsWithClosedProbe: vi.fn(),
  useAccounts: vi.fn(),
  setVisibilityFilters: vi.fn(),
  isMobile: false,
}));

vi.mock("@/hooks/use-holdings", () => ({
  useHoldingsWithClosedProbe: mocks.useHoldingsWithClosedProbe,
}));

const account: Account = {
  id: "account-1",
  name: "Brokerage",
  accountType: AccountType.SECURITIES,
  balance: 0,
  currency: "USD",
  isDefault: false,
  isActive: true,
  isArchived: false,
  trackingMode: "TRANSACTIONS",
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

vi.mock("@/hooks/use-accounts", () => ({
  useAccounts: mocks.useAccounts,
}));

vi.mock("@/hooks/use-platform", () => ({
  useIsMobileViewport: () => mocks.isMobile,
}));

vi.mock("@/hooks/use-persistent-state", () => ({
  usePersistentState: () => [["open"], mocks.setVisibilityFilters],
}));

vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => vi.fn(),
}));

vi.mock("@/pages/holdings/components/holdings-table", () => ({
  HoldingsTable: () => <div data-testid="holdings-table" />,
}));

vi.mock("@/pages/holdings/components/holdings-table-mobile", () => ({
  HoldingsTableMobile: ({ hasHiddenPositions }: { hasHiddenPositions?: boolean }) => (
    <div data-testid="holdings-table-mobile" data-hidden-positions={String(hasHiddenPositions)} />
  ),
}));

describe("AccountHoldings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isMobile = false;
    mocks.useAccounts.mockReturnValue({ accounts: [account] });
  });

  it("keeps the visibility table available when only closed positions exist", () => {
    mocks.useHoldingsWithClosedProbe.mockReturnValue({
      holdings: [],
      isLoading: false,
      hasHiddenClosedPositions: true,
    });

    render(<AccountHoldings accountId={account.id} showTitle={false} />);

    expect(screen.getByTestId("holdings-table")).toBeInTheDocument();
  });

  it("preserves the onboarding state for an account with no positions", () => {
    mocks.useHoldingsWithClosedProbe.mockReturnValue({
      holdings: [],
      isLoading: false,
      hasHiddenClosedPositions: false,
    });

    render(<AccountHoldings accountId={account.id} showTitle={false} />);

    expect(screen.queryByTestId("holdings-table")).not.toBeInTheDocument();
  });

  it("shows cash-only results under the default open status", () => {
    const cashHolding = {
      id: "cash-usd",
      holdingType: "cash",
    } as Holding;
    mocks.isMobile = true;
    mocks.useHoldingsWithClosedProbe.mockReturnValue({
      holdings: [cashHolding],
      isLoading: false,
      hasHiddenClosedPositions: false,
    });

    render(<AccountHoldings accountId={account.id} showTitle={false} />);

    expect(screen.getByTestId("holdings-table-mobile")).toHaveAttribute(
      "data-hidden-positions",
      "false",
    );
  });
});
