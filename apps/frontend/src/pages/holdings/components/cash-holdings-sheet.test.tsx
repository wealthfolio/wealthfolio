import { act, fireEvent, render, screen, waitFor, within } from "@/test/render";
import { getHoldingsList } from "@/adapters";
import { HoldingType } from "@/lib/constants";
import type {
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
vi.mock("@/adapters", () => ({ getHoldingsList: vi.fn() }));
vi.mock("@/hooks/use-balance-privacy", () => ({ useBalancePrivacy: () => privacy }));
vi.mock("@/hooks/use-accounts", () => ({
  useAccounts: () => ({
    accounts: [
      { id: "a", name: "Brokerage" },
      { id: "b", name: "Savings" },
      { id: "c", name: "Outside scope" },
    ],
  }),
}));
vi.mock("@/components/ticker-avatar", () => ({ TickerAvatar: () => null }));

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

const aggregate = { ...cash("all", 100), sourceAccountIds: ["a", "b"] };
const results = (
  holdings: Holding[],
  incompleteAccounts: IncompleteHoldingsAccount[] = [],
): HoldingsListResponse => ({ holdings, incompleteAccounts });

function mount(holding: Holding = aggregate, incompleteAccounts: IncompleteHoldingsAccount[] = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  const view = (selected: Holding) => (
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <CashHoldingsSheet
          holding={selected}
          onClose={onClose}
          incompleteAccounts={incompleteAccounts}
        />
      </QueryClientProvider>
    </MemoryRouter>
  );
  const rendered = render(view(holding));
  return { ...rendered, onClose, select: (selected: Holding) => rendered.rerender(view(selected)) };
}

beforeEach(() => {
  privacy.isBalanceHidden = false;
  vi.mocked(getHoldingsList).mockReset();
  vi.mocked(getHoldingsList).mockImplementation((filter: AccountScope) => {
    if (filter.type !== "account") throw new Error("Expected an account read");
    return Promise.resolve(
      results([
        cash(filter.accountId, filter.accountId === "a" ? 75 : 25),
        cash(filter.accountId, 999, "EUR"),
        { ...cash(filter.accountId, 888), holdingType: HoldingType.SECURITY },
      ]),
    );
  });
});

it("reads only contributing accounts, separates cash from securities and currencies, and links accounts", async () => {
  const { onClose } = mount();
  await screen.findByRole("link", { name: /Brokerage/ });
  expect(getHoldingsList).toHaveBeenCalledTimes(2);
  expect(getHoldingsList).toHaveBeenCalledWith({ type: "account", accountId: "a" });
  expect(getHoldingsList).toHaveBeenCalledWith({ type: "account", accountId: "b" });
  expect(screen.getByText("$100.00")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Brokerage/ })).toHaveTextContent("$75.00");
  expect(screen.getByRole("link", { name: /Savings/ })).toHaveTextContent("$25.00");
  expect(screen.queryByText(/999|888|Outside scope/)).not.toBeInTheDocument();
  const link = screen.getByRole("link", { name: /Savings/ });
  expect(link).toHaveAttribute("href", "/accounts/b");
  fireEvent.click(link);
  expect(onClose).toHaveBeenCalledOnce();
});

it("supports a single-account row without source account IDs and focuses the title", async () => {
  mount(cash("a", 75));
  await screen.findByRole("link", { name: /Brokerage/ });
  expect(getHoldingsList).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(screen.getByRole("heading", { name: "Cash (USD)" })).toHaveFocus());
});

it("uses normalized monetary values and combines cash in the same account and currency", async () => {
  // The backend normalizes GBp to GBP and monetary values to pounds, while
  // quantity retains the snapshot's original number of minor units.
  const normalized = {
    ...cash("a", 1000, "GBP"),
    id: "CASH-a-GBp",
    marketValue: { local: 10, base: 12.5 },
  };
  vi.mocked(getHoldingsList).mockResolvedValue(results([normalized, cash("a", 5, "GBP")]));
  mount(normalized);
  const account = await screen.findByRole("link", { name: /Brokerage/ });
  expect(account).toHaveTextContent("£15.00");
  expect(screen.getAllByRole("link")).toHaveLength(1);
  expect(screen.getByText("Total").parentElement).toHaveTextContent("£15.00");
});

it("does not substitute quantity for an unavailable monetary value", async () => {
  const missing = { ...cash("a", 100), marketValue: { local: null, base: null } };
  vi.mocked(getHoldingsList).mockResolvedValue(results([missing]));
  mount(missing);
  await screen.findByRole("link", { name: /Brokerage/ });
  expect(screen.queryAllByText("$100.00")).toHaveLength(0);
  expect(screen.queryByText(/%/)).not.toBeInTheDocument();
});

it("keeps signed negative balances and a net-zero total without allocation percentages", async () => {
  vi.mocked(getHoldingsList).mockImplementation((filter: AccountScope) =>
    Promise.resolve(
      results([
        cash(
          filter.type === "account" ? filter.accountId : "",
          filter.type === "account" && filter.accountId === "a" ? 75 : -75,
        ),
      ]),
    ),
  );
  mount();
  await screen.findByRole("link", { name: /Savings/ });
  expect(screen.getByRole("link", { name: /Savings/ })).toHaveTextContent("-$75.00");
  expect(screen.getByText("$0.00")).toBeInTheDocument();
  expect(screen.queryByText(/%/)).not.toBeInTheDocument();
});

it("withholds totals for incomplete accounts, including accounts absent from the aggregate", async () => {
  const pending: IncompleteHoldingsAccount = {
    accountId: "b",
    status: "pending",
    reasonCode: "PROJECTION_PENDING",
  };
  vi.mocked(getHoldingsList).mockImplementation((filter: AccountScope) =>
    Promise.resolve(
      filter.type === "account" && filter.accountId === "a"
        ? results([cash("a", 75)])
        : results([], [pending]),
    ),
  );
  mount({ ...aggregate, sourceAccountIds: ["a"] }, [pending]);
  await screen.findByRole("link", { name: /Brokerage/ });
  expect(getHoldingsList).toHaveBeenCalledWith({ type: "account", accountId: "b" });
  expect(screen.getByRole("status")).toHaveTextContent("Some account calculations are incomplete.");
  expect(screen.getByText("Total").parentElement).not.toHaveTextContent("$75.00");
  expect(screen.queryByText(/%/)).not.toBeInTheDocument();
});

it("isolates failed account reads, withholds totals, and supports retry", async () => {
  vi.mocked(getHoldingsList).mockRejectedValueOnce(new Error("Unavailable"));
  mount();
  await screen.findByRole("button", { name: "Retry" });
  expect(screen.getByRole("status")).toHaveTextContent("Some account holdings are unavailable.");
  expect(screen.getByRole("link", { name: /Savings/ })).toBeInTheDocument();
  expect(screen.getByText("Total").parentElement).not.toHaveTextContent("$25.00");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByRole("link", { name: /Brokerage/ });
  expect(screen.getByText("$100.00")).toBeInTheDocument();
});

it("keeps amounts hidden in the total and account links", async () => {
  privacy.isBalanceHidden = true;
  mount();
  await screen.findByRole("link", { name: /Brokerage/ });
  expect(screen.queryByText(/\$|75\.00|25\.00|100\.00/)).not.toBeInTheDocument();
  expect(screen.getByText("Total").parentElement).toHaveTextContent("••••");
});

it("does not display a previous currency while the next account read is pending", async () => {
  let finish!: (result: HoldingsListResponse) => void;
  const pending = new Promise<HoldingsListResponse>((resolve) => {
    finish = resolve;
  });
  vi.mocked(getHoldingsList).mockResolvedValueOnce(results([cash("a", 75)]));
  const { select } = mount(cash("a", 75));
  await screen.findByRole("link", { name: /Brokerage/ });
  vi.mocked(getHoldingsList).mockReturnValueOnce(pending);
  select(cash("b", 20, "EUR"));
  expect(screen.getByRole("heading", { name: "Cash (EUR)" })).toBeInTheDocument();
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
  act(() => finish(results([cash("b", 20, "EUR")])));
  expect(
    within(await screen.findByRole("link", { name: /Savings/ })).getByText("€20.00"),
  ).toBeInTheDocument();
});
