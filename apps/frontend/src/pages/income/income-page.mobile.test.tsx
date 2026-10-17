import { useAccountScopeStore } from "@/lib/account-scope-store";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import IncomePage from "./income-page";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { QueryKeys } from "@/lib/query-keys";
import type { IncomeSummary } from "@/lib/types";

const mocks = vi.hoisted(() => ({ getIncomeSummary: vi.fn() }));
vi.mock("@/adapters", () => ({ getIncomeSummary: mocks.getIncomeSummary }));
vi.mock("./income-history-chart", () => ({ IncomeHistoryChart: () => null }));
vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: false }),
}));
vi.mock("@/hooks", () => ({ useIsMobileViewport: () => true }));
vi.mock("@/hooks/use-accounts", () => ({
  useAccounts: () => ({
    accounts: [
      { id: "a", name: "Brokerage", currency: "USD" },
      { id: "b", name: "TFSA", currency: "USD" },
    ],
  }),
}));
vi.mock("@/hooks/use-portfolios", () => ({
  usePortfolios: () => ({ data: [{ id: "p", name: "Retirement" }] }),
}));

const initialState = useAccountScopeStore.getState();

async function openMobileSelector() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData([QueryKeys.INCOME_SUMMARY, useAccountScopeStore.getState().scope], []);
  const { container } = render(
    <QueryClientProvider client={client}>
      <IncomePage />
    </QueryClientProvider>,
  );
  const toolbar = container.querySelector<HTMLElement>(".md\\:hidden")!;
  await userEvent.click(within(toolbar).getByRole("combobox"));
  return within(screen.getByRole("dialog"));
}

function expectChecked(option: HTMLElement) {
  expect(option.querySelector(".opacity-100")).toBeInTheDocument();
}

describe("IncomePage mobile account scope", () => {
  beforeEach(() => {
    useAccountScopeStore.setState(initialState, true);
    mocks.getIncomeSummary.mockResolvedValue([]);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shows imported members and edits them without discarding the other selection", async () => {
    useAccountScopeStore.getState().setScope({ type: "accounts", accountIds: ["a", "b"] });
    const sheet = await openMobileSelector();
    expectChecked(sheet.getByRole("option", { name: /Brokerage/ }));
    expectChecked(sheet.getByRole("option", { name: /TFSA/ }));

    await userEvent.click(sheet.getByRole("option", { name: /Brokerage/ }));
    expect(useAccountScopeStore.getState().scope).toEqual({ type: "account", accountId: "b" });
    expectChecked(sheet.getByRole("option", { name: /TFSA/ }));

    await userEvent.click(sheet.getByRole("option", { name: /TFSA/ }));
    expect(useAccountScopeStore.getState().scope).toEqual({ type: "all" });
    expectChecked(sheet.getByRole("option", { name: /All Accounts/ }));
  });

  it("retains portfolio selection and can switch back to accounts", async () => {
    useAccountScopeStore.getState().setScope({ type: "portfolio", portfolioId: "p" });
    const sheet = await openMobileSelector();
    expectChecked(sheet.getByRole("option", { name: /Retirement/ }));
    await userEvent.click(sheet.getByRole("option", { name: /Brokerage/ }));
    expect(useAccountScopeStore.getState().scope).toEqual({ type: "account", accountId: "a" });
    expectChecked(sheet.getByRole("option", { name: /Brokerage/ }));
  });

  it("keeps the selector open while a new scope loads and transitions to populated income", async () => {
    let resolveIncome!: (value: IncomeSummary[]) => void;
    mocks.getIncomeSummary.mockReturnValue(
      new Promise<IncomeSummary[]>((resolve) => {
        resolveIncome = resolve;
      }),
    );
    useAccountScopeStore.getState().setScope({ type: "accounts", accountIds: ["a", "b"] });
    const sheet = await openMobileSelector();
    const dialog = screen.getByRole("dialog");
    await userEvent.click(sheet.getByRole("option", { name: /Brokerage/ }));
    await waitFor(() =>
      expect(mocks.getIncomeSummary).toHaveBeenCalledWith({ type: "account", accountId: "b" }),
    );
    expect(screen.getByRole("dialog")).toBe(dialog);
    expectChecked(sheet.getByRole("option", { name: /TFSA/ }));
    await act(async () =>
      resolveIncome([
        {
          period: "ALL",
          totalIncome: 100,
          currency: "USD",
          monthlyAverage: 10,
          yoyGrowth: null,
          byMonth: {},
          byType: {},
          byAsset: {},
          byCurrency: {},
          byCurrencyBase: {},
          byAccount: {},
          unconvertedCurrencies: [],
        },
      ]),
    );
    await waitFor(() => expect(screen.getByText("All Time Income")).toBeInTheDocument());
    expect(screen.getByRole("dialog")).toBe(dialog);
    expectChecked(sheet.getByRole("option", { name: /TFSA/ }));
  });

  it("keeps the selector available when a selected scope fails to load", async () => {
    mocks.getIncomeSummary.mockRejectedValue(new Error("offline"));
    const sheet = await openMobileSelector();
    const dialog = screen.getByRole("dialog");
    await userEvent.click(sheet.getByRole("option", { name: /Brokerage/ }));
    await screen.findByText(/offline/);
    expect(screen.getByRole("dialog")).toBe(dialog);
    expectChecked(sheet.getByRole("option", { name: /Brokerage/ }));
  });
});
