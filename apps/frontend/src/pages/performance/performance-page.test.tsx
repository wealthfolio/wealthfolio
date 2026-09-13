import { useAccountScopeStore } from "@/lib/account-scope-store";
import { QueryKeys } from "@/lib/query-keys";
import type { Account, AccountScope, TrackedItem } from "@/lib/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PerformancePage from "./performance-page";
import { ALL_PORTFOLIO_ITEM } from "./performance-selection";

const mocks = vi.hoisted(() => ({ performance: vi.fn(), getAccounts: vi.fn() }));
vi.mock("@/adapters", () => ({ getAccounts: mocks.getAccounts }));
vi.mock("@/hooks/use-portfolios", () => ({
  usePortfolios: () => ({ data: [{ id: "p", name: "Retirement" }] }),
}));
vi.mock("@/hooks/use-platform", () => ({ useIsMobileViewport: () => false }));
vi.mock("./hooks/use-performance-data", () => ({
  useCalculatePerformanceHistory: mocks.performance,
}));
vi.mock("@/components/account-filter-selector", () => ({ AccountScopeSelector: () => null }));
vi.mock("@/components/account-selector", () => ({
  AccountSelector: ({
    setSelectedAccount,
    onPortfolioSelect,
  }: {
    setSelectedAccount: (account: { id: string; name: string }) => void;
    onPortfolioSelect: (portfolio: { id: string; name: string }) => void;
  }) => (
    <>
      <button onClick={() => setSelectedAccount({ id: "a", name: "Brokerage" })}>
        Toggle comparison account
      </button>
      <button onClick={() => onPortfolioSelect({ id: "p", name: "Retirement" })}>
        Toggle comparison portfolio
      </button>
    </>
  ),
}));
vi.mock("@/components/account-selector-mobile", () => ({ AccountSelectorMobile: () => null }));
vi.mock("@/components/benchmark-symbol-selector", () => ({ BenchmarkSymbolSelector: () => null }));
vi.mock("@/components/benchmark-symbol-selector-mobile", () => ({
  BenchmarkSymbolSelectorMobile: () => null,
}));
vi.mock("@wealthfolio/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@wealthfolio/ui")>();
  const Container = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return {
    ...actual,
    Carousel: Container,
    CarouselContent: Container,
    CarouselItem: Container,
    DateRangeSelector: () => null,
  };
});

const accounts = [
  { id: "a", name: "Brokerage", accountType: "SECURITIES", isActive: true },
  { id: "b", name: "Hidden TFSA", accountType: "SECURITIES", isActive: false },
  { id: "card", name: "Credit Card", accountType: "CREDIT_CARD", isActive: true },
].map((account) => ({ ...account, isArchived: false, currency: "USD" })) as Account[];
const TWR_WARNING = "Some holdings are missing valuations for part of the period.";

const resultWithWarning = {
  id: ALL_PORTFOLIO_ITEM.id,
  type: "account",
  name: ALL_PORTFOLIO_ITEM.name,
  scope: { id: ALL_PORTFOLIO_ITEM.id, currency: "USD" },
  period: { startDate: "2026-01-01", endDate: "2026-03-01" },
  mode: "timeWeighted",
  returns: { twr: 0.1, annualizedTwr: 0.2, irr: null, annualizedIrr: null, valueReturn: null },
  attribution: {
    contributions: 0,
    distributions: 0,
    income: 0,
    realizedPnl: 0,
    unrealizedPnlChange: 0,
    fxEffect: 0,
    fees: 0,
    taxes: 0,
    residual: 0,
  },
  risk: { volatility: 0.05, maxDrawdown: -0.02 },
  dataQuality: { status: "partial", warnings: [TWR_WARNING], notApplicableReasons: [] },
  series: [{ date: "2026-01-01", value: 0 }],
};

const initialState = useAccountScopeStore.getState();

function setScope(scope: AccountScope) {
  act(() => useAccountScopeStore.getState().setScope(scope));
}

function savedItems(): TrackedItem[] {
  return JSON.parse(localStorage.getItem("performance:selectedItems") ?? "[]");
}

function renderPage(seedAccounts = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  if (seedAccounts) {
    client.setQueryData([QueryKeys.ACCOUNTS, false], accounts);
    client.setQueryData([QueryKeys.ACCOUNTS, true], accounts);
  }
  return {
    client,
    ...render(
      <StrictMode>
        <QueryClientProvider client={client}>
          <PerformancePage />
        </QueryClientProvider>
      </StrictMode>,
    ),
  };
}

describe("PerformancePage shared scope", () => {
  beforeEach(() => {
    localStorage.clear();
    useAccountScopeStore.setState(initialState, true);
    mocks.performance.mockReturnValue({
      data: [],
      isLoading: false,
      hasErrors: false,
      errorMessages: [],
    });
    mocks.getAccounts.mockResolvedValue(accounts);
  });

  it("retains and requests a hidden account selected elsewhere", async () => {
    setScope({ type: "account", accountId: "b" });
    renderPage();
    await waitFor(() =>
      expect(savedItems().map((item) => item.id)).toEqual([ALL_PORTFOLIO_ITEM.id, "b"]),
    );
    expect(mocks.performance).toHaveBeenLastCalledWith(
      expect.objectContaining({ selectedItems: savedItems() }),
    );
    expect(JSON.parse(localStorage.getItem("performance:selectedItemId")!)).toBe("b");
  });

  it("requests mixed scopes and credit-card-only scopes instead of leaving the old focus", async () => {
    renderPage();
    setScope({ type: "account", accountId: "a" });
    setScope({ type: "accounts", accountIds: ["a", "card"] });
    await waitFor(() =>
      expect(savedItems().at(-1)?.accountScope).toEqual({
        type: "accounts",
        accountIds: ["a", "card"],
      }),
    );
    expect(JSON.parse(localStorage.getItem("performance:selectedItemId")!)).toBe("accounts:a,card");
    setScope({ type: "account", accountId: "card" });
    await waitFor(() =>
      expect(savedItems().map((item) => item.id)).toEqual([ALL_PORTFOLIO_ITEM.id, "card"]),
    );
    expect(JSON.parse(localStorage.getItem("performance:selectedItemId")!)).toBe("card");
  });

  it("preserves saved comparisons when the account inventory fails to load", async () => {
    const selected: TrackedItem = {
      id: "b",
      type: "account",
      name: "Hidden TFSA",
      accountScope: { type: "account", accountId: "b" },
    };
    localStorage.setItem("performance:selectedItems", JSON.stringify([selected]));
    localStorage.setItem("performance:selectedItemId", JSON.stringify("b"));
    mocks.getAccounts.mockRejectedValue(new Error("offline"));
    const { client } = renderPage(false);
    await waitFor(() =>
      expect(client.getQueryState([QueryKeys.ACCOUNTS, true])?.status).toBe("error"),
    );
    expect(savedItems()).toEqual([selected]);
    expect(JSON.parse(localStorage.getItem("performance:selectedItemId")!)).toBe("b");
  });

  it("applies the pending scope after the full account inventory loads", async () => {
    let resolveAccounts!: (value: Account[]) => void;
    mocks.getAccounts.mockReturnValue(
      new Promise<Account[]>((resolve) => {
        resolveAccounts = resolve;
      }),
    );
    setScope({ type: "account", accountId: "b" });
    renderPage(false);
    expect(savedItems().some((item) => item.id === "b")).toBe(false);
    await act(async () => resolveAccounts(accounts));
    await waitFor(() => expect(savedItems().some((item) => item.id === "b")).toBe(true));
  });

  it("removes a saved multi-account comparison after a member is deleted, including on remount", async () => {
    const deletedScope: TrackedItem = {
      id: "accounts:a,deleted",
      type: "account",
      name: "Brokerage + Deleted",
      accountScope: { type: "accounts", accountIds: ["a", "deleted"] },
    };
    localStorage.setItem(
      "performance:selectedItems",
      JSON.stringify([ALL_PORTFOLIO_ITEM, deletedScope]),
    );
    localStorage.setItem("performance:selectedItemId", JSON.stringify(deletedScope.id));
    const page = renderPage();
    await waitFor(() => expect(savedItems()).toEqual([ALL_PORTFOLIO_ITEM]));
    expect(JSON.parse(localStorage.getItem("performance:selectedItemId")!)).toBeNull();
    expect(mocks.performance).toHaveBeenLastCalledWith(
      expect.objectContaining({ selectedItems: [ALL_PORTFOLIO_ITEM] }),
    );
    page.unmount();
    renderPage();
    expect(savedItems()).toEqual([ALL_PORTFOLIO_ITEM]);
  });

  it("prunes a deleted member before requesting performance after inventory refresh", async () => {
    setScope({ type: "accounts", accountIds: ["a", "b"] });
    const { client } = renderPage();
    await waitFor(() => expect(savedItems().at(-1)?.id).toBe("accounts:a,b"));
    mocks.performance.mockClear();
    act(() =>
      client.setQueryData(
        [QueryKeys.ACCOUNTS, true],
        accounts.filter((account) => account.id !== "b"),
      ),
    );
    await waitFor(() => expect(savedItems()).toEqual([ALL_PORTFOLIO_ITEM]));
    for (const [request] of mocks.performance.mock.calls) {
      expect(request.selectedItems).toEqual([ALL_PORTFOLIO_ITEM]);
    }
    expect(JSON.parse(localStorage.getItem("performance:selectedItemId")!)).toBeNull();
  });

  it("keeps archived members for the backend to filter rather than treating them as deleted", async () => {
    setScope({ type: "accounts", accountIds: ["a", "b"] });
    const { client } = renderPage();
    await waitFor(() => expect(savedItems().at(-1)?.id).toBe("accounts:a,b"));
    const before = savedItems();
    act(() =>
      client.setQueryData(
        [QueryKeys.ACCOUNTS, true],
        accounts.map((account) => ({ ...account, isArchived: account.id === "b" })),
      ),
    );
    await waitFor(() =>
      expect(mocks.performance).toHaveBeenLastCalledWith(
        expect.objectContaining({ selectedItems: before }),
      ),
    );
    expect(savedItems()).toEqual(before);
  });

  it.each([
    {
      scope: { type: "account", accountId: "a" } as AccountScope,
      id: "a",
      picker: "Toggle comparison account",
      name: "Brokerage",
    },
    {
      scope: { type: "portfolio", portfolioId: "p" } as AccountScope,
      id: "p",
      picker: "Toggle comparison portfolio",
      name: "Retirement",
    },
  ])(
    "preserves a manually re-added $scope.type after removal through its picker",
    async ({ scope, id, picker }) => {
      setScope(scope);
      renderPage();
      await waitFor(() => expect(savedItems().some((item) => item.id === id)).toBe(true));
      await userEvent.click(screen.getByRole("button", { name: picker }));
      expect(useAccountScopeStore.getState().bridgedItemId).toBeNull();
      expect(useAccountScopeStore.getState().scope).toEqual(scope);
      await userEvent.click(screen.getByRole("button", { name: picker }));
      setScope({ type: "account", accountId: "card" });
      expect(savedItems().map((item) => item.id)).toEqual([ALL_PORTFOLIO_ITEM.id, id, "card"]);
    },
  );

  it.each([
    {
      scope: { type: "account", accountId: "a" } as AccountScope,
      id: "a",
      picker: "Toggle comparison account",
      name: "Brokerage",
    },
    {
      scope: { type: "portfolio", portfolioId: "p" } as AccountScope,
      id: "p",
      picker: "Toggle comparison portfolio",
      name: "Retirement",
    },
  ])(
    "preserves a manually re-added $scope.type after badge removal and remount",
    async ({ scope, id, picker, name }) => {
      setScope(scope);
      const page = renderPage();
      await waitFor(() => expect(savedItems().some((item) => item.id === id)).toBe(true));
      await userEvent.click(screen.getAllByRole("button", { name: `Remove ${name}` })[0]);
      expect(useAccountScopeStore.getState().bridgedItemId).toBeNull();
      page.unmount();
      renderPage();
      expect(savedItems().some((item) => item.id === id)).toBe(false);
      await userEvent.click(screen.getByRole("button", { name: picker }));
      setScope({ type: "account", accountId: "card" });
      expect(savedItems().map((item) => item.id)).toEqual([ALL_PORTFOLIO_ITEM.id, id, "card"]);
    },
  );

  it("keeps a newly bridged selection when StrictMode replays mount-time pruning", async () => {
    localStorage.setItem(
      "performance:selectedItems",
      JSON.stringify([
        ALL_PORTFOLIO_ITEM,
        {
          id: "accounts:a,deleted",
          type: "account",
          name: "Deleted scope",
          accountScope: { type: "accounts", accountIds: ["a", "deleted"] },
        },
      ]),
    );
    localStorage.setItem("performance:selectedItemId", JSON.stringify("accounts:a,deleted"));
    setScope({ type: "account", accountId: "b" });
    renderPage();
    await waitFor(() =>
      expect(savedItems().map((item) => item.id)).toEqual([ALL_PORTFOLIO_ITEM.id, "b"]),
    );
    expect(JSON.parse(localStorage.getItem("performance:selectedItemId")!)).toBe("b");
    expect(useAccountScopeStore.getState().bridgedItemId).toBe("b");
  });

  it("opens the TWR calculation notes from the desktop strip warning icon", async () => {
    mocks.performance.mockReturnValue({
      data: [resultWithWarning],
      isLoading: false,
      hasErrors: false,
      errorMessages: [],
      displayDateRange: "",
    });
    renderPage();
    const trigger = await screen.findByRole("button", {
      name: /calculation note for/i,
    });
    expect(screen.queryByText(TWR_WARNING)).toBeNull();
    await userEvent.click(trigger);
    expect(await screen.findByText(TWR_WARNING)).toBeInTheDocument();
  });

  it("does not request unvalidated persisted scopes during a cold load", async () => {
    const staleItem: TrackedItem = {
      id: "accounts:a,deleted",
      type: "account",
      name: "Deleted scope",
      accountScope: { type: "accounts", accountIds: ["a", "deleted"] },
    };
    localStorage.setItem("performance:selectedItems", JSON.stringify([staleItem]));
    let resolveAccounts!: (value: Account[]) => void;
    mocks.getAccounts.mockReturnValue(
      new Promise<Account[]>((resolve) => {
        resolveAccounts = resolve;
      }),
    );
    mocks.performance.mockClear();
    renderPage(false);
    expect(savedItems()).toEqual([staleItem]);
    expect(mocks.performance).toHaveBeenLastCalledWith(
      expect.objectContaining({ selectedItems: [] }),
    );
    await act(async () => resolveAccounts(accounts));
    await waitFor(() => expect(savedItems()).toEqual([ALL_PORTFOLIO_ITEM]));
    for (const [request] of mocks.performance.mock.calls) {
      expect(request.selectedItems.some((item: TrackedItem) => item.id === staleItem.id)).toBe(
        false,
      );
    }
  });
});
