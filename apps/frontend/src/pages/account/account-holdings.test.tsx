import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AccountType } from "@/lib/constants";
import type { Account, Holding } from "@/lib/types";
import AccountHoldings from "./account-holdings";

const mocks = vi.hoisted(() => ({
  useHoldingsWithClosedProbe: vi.fn(),
  useAccounts: vi.fn(),
  setVisibilityFilters: vi.fn(),
  isMobile: false,
  showConnectAccountLink: false,
}));

vi.mock("@/hooks/use-holdings", () => ({
  useHoldingsWithClosedProbe: mocks.useHoldingsWithClosedProbe,
}));

const account: Account = {
  id: "account-1",
  name: "Brokerage",
  accountType: AccountType.SECURITIES,
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

vi.mock("@/features/wealthfolio-connect/hooks/use-show-connect-account-link", () => ({
  useShowConnectAccountLink: () => mocks.showConnectAccountLink,
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
    mocks.showConnectAccountLink = false;
    mocks.useAccounts.mockReturnValue({ accounts: [account] });
  });

  it("keeps the visibility table available when only closed positions exist", () => {
    mocks.useHoldingsWithClosedProbe.mockReturnValue({
      holdings: [],
      isLoading: false,
      isComplete: true,
      hasHiddenClosedPositions: true,
    });

    render(<AccountHoldings accountId={account.id} showTitle={false} />);

    expect(screen.getByTestId("holdings-table")).toBeInTheDocument();
  });

  it("preserves the onboarding state for an account with no positions", () => {
    mocks.useHoldingsWithClosedProbe.mockReturnValue({
      holdings: [],
      isLoading: false,
      isComplete: true,
      hasHiddenClosedPositions: false,
    });

    render(<AccountHoldings accountId={account.id} showTitle={false} />);

    expect(screen.queryByTestId("holdings-table")).not.toBeInTheDocument();
  });

  it.each(["pending", "unavailable"])(
    "shows %s holdings as incomplete instead of onboarding",
    (status) => {
      mocks.useHoldingsWithClosedProbe.mockReturnValue({
        holdings: [],
        isLoading: false,
        isComplete: false,
        isError: status === "unavailable",
        incompleteAccounts: [{ accountId: account.id, status }],
        hasHiddenClosedPositions: false,
      });
      render(<AccountHoldings accountId={account.id} showTitle={false} />);
      expect(screen.getByRole("status")).toHaveTextContent(
        status === "pending" ? /calculations are incomplete/i : /holdings are unavailable/i,
      );
      expect(screen.queryByText(/get started/i)).not.toBeInTheDocument();
    },
  );

  it("resolves a hidden account's tracking mode", () => {
    const hiddenHoldingsAccount: Account = {
      ...account,
      isActive: false,
      trackingMode: "HOLDINGS",
    };
    mocks.useAccounts.mockImplementation((options?: { filterActive?: boolean }) => ({
      accounts: options?.filterActive === false ? [hiddenHoldingsAccount] : [],
    }));
    mocks.useHoldingsWithClosedProbe.mockReturnValue({
      holdings: [],
      isLoading: false,
      isComplete: true,
      hasHiddenClosedPositions: false,
    });

    render(<AccountHoldings accountId={account.id} showTitle={false} />);

    expect(
      screen.getByText(
        "Add your current holdings snapshot or import from a CSV file to get started.",
      ),
    ).toBeInTheDocument();
    expect(mocks.useHoldingsWithClosedProbe).toHaveBeenLastCalledWith(
      { type: "account", accountId: account.id },
      expect.objectContaining({ probeClosedWhenEmpty: false }),
    );
  });

  it("names the icon-only update holdings button", () => {
    mocks.useAccounts.mockReturnValue({ accounts: [{ ...account, trackingMode: "HOLDINGS" }] });
    mocks.useHoldingsWithClosedProbe.mockReturnValue({
      holdings: [{ id: "cash-usd", holdingType: "cash" } as Holding],
      isLoading: false,
      isComplete: true,
      hasHiddenClosedPositions: false,
    });

    render(<AccountHoldings accountId={account.id} onAddHoldings={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Update holdings" })).toBeInTheDocument();
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
      isComplete: true,
      hasHiddenClosedPositions: false,
    });

    render(<AccountHoldings accountId={account.id} showTitle={false} />);

    expect(screen.getByTestId("holdings-table-mobile")).toHaveAttribute(
      "data-hidden-positions",
      "false",
    );
  });

  describe("Connect account link", () => {
    beforeEach(() => {
      mocks.showConnectAccountLink = true;
      mocks.useHoldingsWithClosedProbe.mockReturnValue({
        holdings: [],
        isLoading: false,
        isComplete: true,
        hasHiddenClosedPositions: false,
      });
    });

    function renderEmptyAccount(overrides: Partial<Account>) {
      mocks.useAccounts.mockReturnValue({ accounts: [{ ...account, ...overrides }] });
      render(
        <MemoryRouter>
          <AccountHoldings accountId={account.id} showTitle={false} />
        </MemoryRouter>,
      );
    }

    it.each([["TRANSACTIONS"], ["HOLDINGS"]] as const)(
      "appears on an empty manual %s account",
      (trackingMode) => {
        renderEmptyAccount({ trackingMode });

        expect(screen.getByRole("link", { name: "Connect account" })).toHaveAttribute(
          "href",
          "/connect?placement=account_empty",
        );
      },
    );

    it("stays off a broker-synced account", () => {
      renderEmptyAccount({ provider: "SNAPTRADE", providerAccountId: "broker-1" });

      expect(screen.queryByRole("link", { name: "Connect account" })).not.toBeInTheDocument();
    });

    it("stays off a cash account", () => {
      renderEmptyAccount({ accountType: AccountType.CASH });

      expect(screen.queryByRole("link", { name: "Connect account" })).not.toBeInTheDocument();
    });

    it("stays off until the account is found", () => {
      mocks.useAccounts.mockReturnValue({ accounts: [] });
      render(
        <MemoryRouter>
          <AccountHoldings accountId={account.id} showTitle={false} />
        </MemoryRouter>,
      );

      expect(screen.queryByRole("link", { name: "Connect account" })).not.toBeInTheDocument();
    });

    it("stays off when the link is not shown", () => {
      mocks.showConnectAccountLink = false;
      renderEmptyAccount({});

      expect(screen.queryByRole("link", { name: "Connect account" })).not.toBeInTheDocument();
    });
  });
});
