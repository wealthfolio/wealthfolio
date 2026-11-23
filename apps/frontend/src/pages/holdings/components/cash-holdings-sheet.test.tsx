import { act, fireEvent, render, screen, waitFor, within } from "@/test/render";
import { getAssetHoldingsScope } from "@/adapters";
import { HoldingType } from "@/lib/constants";
import type {
  Account,
  AccountScope,
  Holding,
  HoldingsListResponse,
  IncompleteHoldingsAccount,
} from "@/lib/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import { CashHoldingsSheet } from "./cash-holdings-sheet";

const privacy = vi.hoisted(() => ({ isBalanceHidden: false }));
vi.mock("@/adapters", () => ({ getAssetHoldingsScope: vi.fn() }));
vi.mock("@/hooks/use-balance-privacy", () => ({ useBalancePrivacy: () => privacy }));
const accounts = [
  { id: "a", name: "Brokerage" },
  { id: "b", name: "Savings" },
  { id: "c", name: "Outside scope" },
] as Account[];
const portfolio: AccountScope = { type: "portfolio", portfolioId: "pf" };
function cash(accountId: string, quantity: number, localCurrency = "USD"): Holding {
  return {
    id: `CASH-${accountId}-${localCurrency}`,
    accountId,
    holdingType: HoldingType.CASH,
    quantity,
    localCurrency,
    baseCurrency: "USD",
    marketValue: { local: quantity, base: quantity },
    weight: null,
    asOfDate: "2026-11-12",
  };
}
const results = (
  holdings: Holding[],
  incompleteAccounts: IncompleteHoldingsAccount[] = [],
): HoldingsListResponse => ({ holdings, incompleteAccounts });
function mount(currency = "USD", accountFilter: AccountScope = portfolio) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  const view = (currency: string, filter: AccountScope) => (
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <CashHoldingsSheet
          currency={currency}
          accountFilter={filter}
          accounts={accounts}
          onClose={onClose}
        />
      </QueryClientProvider>
    </MemoryRouter>
  );
  const rendered = render(view(currency, accountFilter));
  return {
    ...rendered,
    onClose,
    select: (currency: string, filter = accountFilter) => rendered.rerender(view(currency, filter)),
  };
}
beforeEach(() => {
  privacy.isBalanceHidden = false;
  vi.mocked(getAssetHoldingsScope)
    .mockReset()
    .mockResolvedValue(
      results([
        cash("a", 75),
        cash("b", 25),
        cash("a", 999, "EUR"),
        { ...cash("a", 888), holdingType: HoldingType.SECURITY },
      ]),
    );
});

it("loads the scoped breakdown in one call, separates cash from securities and currencies, and links accounts", async () => {
  const { onClose } = mount();
  const brokerage = await screen.findByRole("link", { name: /Brokerage/ });
  expect(getAssetHoldingsScope).toHaveBeenCalledExactlyOnceWith("cash:USD", portfolio);
  expect(screen.getByLabelText("Total")).toHaveTextContent("$100");
  expect(brokerage).toHaveTextContent("$75");
  expect(screen.getByRole("link", { name: /Savings/ })).toHaveTextContent("$25");
  expect(screen.queryByText(/999|888|Outside scope/)).not.toBeInTheDocument();
  const link = screen.getByRole("link", { name: /Savings/ });
  expect(link).toHaveAttribute("href", "/accounts/b");
  fireEvent.click(link);
  expect(onClose).toHaveBeenCalledOnce();
});
it("supports single-account scopes and focuses the title", async () => {
  vi.mocked(getAssetHoldingsScope).mockResolvedValue(results([cash("a", 75)]));
  mount("USD", { type: "account", accountId: "a" });
  await screen.findByRole("link", { name: /Brokerage/ });
  expect(getAssetHoldingsScope).toHaveBeenCalledExactlyOnceWith("cash:USD", {
    type: "account",
    accountId: "a",
  });
  await waitFor(() => expect(screen.getByRole("heading", { name: "Cash (USD)" })).toHaveFocus());
});
it("uses normalized monetary values and combines cash in the same account and currency", async () => {
  const normalized = {
    ...cash("a", 1000, "GBP"),
    id: "CASH-a-GBp",
    marketValue: { local: 10, base: 12.5 },
  };
  vi.mocked(getAssetHoldingsScope).mockResolvedValue(results([normalized, cash("a", 5, "GBP")]));
  mount("GBP");
  const account = await screen.findByRole("link", { name: /Brokerage/ });
  expect(account).toHaveTextContent("£15");
  expect(screen.getAllByRole("link")).toHaveLength(1);
  expect(screen.getByLabelText("Total")).toHaveTextContent("£15");
});
it("does not substitute quantity for an unavailable monetary value", async () => {
  vi.mocked(getAssetHoldingsScope).mockResolvedValue(
    results([{ ...cash("a", 100), marketValue: { local: null, base: null } }]),
  );
  mount();
  await screen.findByRole("link", { name: /Brokerage/ });
  expect(screen.getByLabelText("Total")).toHaveTextContent("—");
  expect(screen.queryByText(/%/)).not.toBeInTheDocument();
});
it("keeps signed negative balances and a net-zero total without allocation percentages", async () => {
  vi.mocked(getAssetHoldingsScope).mockResolvedValue(results([cash("a", 75), cash("b", -75)]));
  mount();
  await screen.findByRole("link", { name: /Savings/ });
  expect(screen.getByRole("link", { name: /Savings/ })).toHaveTextContent("-$75");
  expect(screen.getByLabelText("Total")).toHaveTextContent("$0");
  expect(screen.queryByText(/%/)).not.toBeInTheDocument();
});
it("keeps partial rows but withholds totals for incomplete accounts", async () => {
  const pending: IncompleteHoldingsAccount = {
    accountId: "b",
    status: "pending",
    reasonCode: "CALCULATION_REQUIRED",
  };
  vi.mocked(getAssetHoldingsScope).mockResolvedValue(results([cash("a", 75)], [pending]));
  mount();
  await screen.findByRole("link", { name: /Brokerage/ });
  expect(screen.getByRole("status")).toHaveTextContent("Some account calculations are incomplete.");
  expect(screen.getByLabelText("Total")).toHaveTextContent("—");
  expect(screen.queryByText(/%/)).not.toBeInTheDocument();
});
it("totals accounts mid-calculation from their last balances", async () => {
  const calculating: IncompleteHoldingsAccount = {
    accountId: "b",
    status: "pending",
    reasonCode: "PROJECTION_PENDING",
  };
  vi.mocked(getAssetHoldingsScope).mockResolvedValue(
    results([cash("a", 75), cash("b", 25)], [calculating]),
  );
  mount();
  await screen.findByRole("link", { name: /Brokerage/ });
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Total")).toHaveTextContent("$100");
});
it("shows failed reads without a total and retries the single scoped request", async () => {
  vi.mocked(getAssetHoldingsScope).mockRejectedValueOnce(new Error("Unavailable"));
  mount();
  await screen.findByRole("button", { name: "Retry" });
  expect(screen.getByRole("status")).toHaveTextContent("Some account holdings are unavailable.");
  expect(screen.getByLabelText("Total")).toHaveTextContent("—");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByRole("link", { name: /Brokerage/ });
  expect(screen.getByLabelText("Total")).toHaveTextContent("$100");
  expect(getAssetHoldingsScope).toHaveBeenCalledTimes(2);
});
it("keeps amounts hidden in the total and account links", async () => {
  privacy.isBalanceHidden = true;
  mount();
  await screen.findByRole("link", { name: /Brokerage/ });
  expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
  expect(screen.getByLabelText("Total")).toHaveTextContent("••••");
});
it("does not display a previous currency or account scope while the next read is pending", async () => {
  let finish!: (result: HoldingsListResponse) => void;
  const pending = new Promise<HoldingsListResponse>((resolve) => {
    finish = resolve;
  });
  const { select } = mount();
  await screen.findByRole("link", { name: /Brokerage/ });
  vi.mocked(getAssetHoldingsScope).mockReturnValueOnce(pending);
  select("EUR", { type: "account", accountId: "b" });
  expect(screen.getByRole("heading", { name: "Cash (EUR)" })).toBeInTheDocument();
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
  act(() => finish(results([cash("b", 20, "EUR")])));
  expect(
    within(await screen.findByRole("link", { name: /Savings/ })).getByText("€20"),
  ).toBeInTheDocument();
  expect(getAssetHoldingsScope).toHaveBeenLastCalledWith("cash:EUR", {
    type: "account",
    accountId: "b",
  });
});
