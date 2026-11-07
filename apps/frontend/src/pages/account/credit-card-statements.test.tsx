import { act, fireEvent, render, screen, waitFor } from "@/test/render";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccountType } from "@/lib/constants";
import type { Account } from "@/lib/types";
import { QueryKeys } from "@/lib/query-keys";
import { CreditCardStatements } from "./credit-card-statements";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/adapters", () => ({ getCreditCardStatements: mocks.get }));
vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: { timezone: "America/Sao_Paulo" } }),
}));

const account = {
  id: "card/1",
  accountType: AccountType.CREDIT_CARD,
  currency: "BRL",
  meta: '{"creditCardBilling":{"closingDay":10,"dueDay":20}}',
} as Account;
const statements = [
  {
    startDate: "2026-11-11",
    closingDate: "2026-12-10",
    dueDate: "2026-12-20",
    isClosed: false,
    balances: [{ currency: "BRL", balance: "132.05" }],
  },
  {
    startDate: "2026-10-11",
    closingDate: "2026-11-10",
    dueDate: "2026-11-20",
    isClosed: true,
    balances: [
      { currency: "BRL", balance: "62.05" },
      { currency: "USD", balance: "9.99" },
    ],
  },
  {
    startDate: "2026-09-11",
    closingDate: "2026-10-10",
    dueDate: "2026-10-20",
    isClosed: true,
    balances: [{ currency: "BRL", balance: "100" }],
  },
];

function mount(card = account) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <CreditCardStatements account={card} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  mocks.get.mockReset().mockResolvedValue(statements);
});

describe("CreditCardStatements", () => {
  it("hides statement amounts when the shared privacy toggle is used", async () => {
    mount();
    await screen.findByText(/132\.05/);
    act(() =>
      window.dispatchEvent(
        new CustomEvent("wf:privacy-changed", {
          detail: { isBalanceHidden: true },
        }),
      ),
    );
    expect(screen.queryByText(/132\.05|62\.05|9\.99/)).not.toBeInTheDocument();
    expect(screen.getAllByText("••••")).toHaveLength(4);
  });
  it("offers setup without reading a history for an unconfigured card", () => {
    mount({ ...account, meta: undefined });
    expect(screen.getByRole("link")).toHaveAttribute("href", "/settings/accounts");
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("shows separate open and closed balances with links to their transactions", async () => {
    mount();
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(3));
    expect(mocks.get).toHaveBeenCalledWith("card/1");
    const hrefs = screen.getAllByRole("link").map((link) => link.getAttribute("href"));
    expect(hrefs).toContain("/activities?account=card%2F1&from=2026-10-11&to=2026-11-10");
    expect(screen.getByText(/132\.05/)).toBeInTheDocument();
    expect(screen.getByText(/62\.05/)).toBeInTheDocument();
    expect(screen.getByText(/9\.99/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Current balance" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Last closed statement" })).toBeInTheDocument();
    expect(screen.getByText("Balance at closing. Later payments aren’t deducted.")).toBeVisible();
    expect(screen.getAllByRole("link", { name: /View transactions/ })).toHaveLength(2);
    expect(screen.getByRole("link", { name: "Manage billing" })).toHaveAttribute(
      "href",
      "/settings/accounts",
    );
  });

  it("keeps history and calculation details collapsed without hiding the balance warning", async () => {
    mount();
    await screen.findByRole("heading", { name: "Current balance" });
    const help = screen.getByText("How balances are calculated").closest("details");
    const history = screen.getByText("Previous statements").closest("details");
    expect(help).not.toHaveAttribute("open");
    expect(history).not.toHaveAttribute("open");
    expect(screen.getByText("Balance at closing. Later payments aren’t deducted.")).toBeVisible();
    fireEvent.click(screen.getByText("How balances are calculated"));
    expect(help).toHaveAttribute("open");
    fireEvent.click(screen.getByText("Previous statements"));
    expect(history).toHaveAttribute("open");
    expect(screen.getByText(/100\.00/)).toBeVisible();
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  it("shows an error with a working retry instead of a zero balance", async () => {
    mocks.get.mockRejectedValueOnce(new Error("unavailable"));
    mount();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(3));
  });

  it("refreshes balances when the existing portfolio invalidation runs", async () => {
    const client = mount();
    await screen.findByText(/132\.05/);
    mocks.get.mockResolvedValue([
      { ...statements[0], balances: [{ currency: "BRL", balance: "145.17" }] },
    ]);
    await client.invalidateQueries({ queryKey: [QueryKeys.CREDIT_CARD_STATEMENTS] });
    expect(await screen.findByText(/145\.17/)).toBeInTheDocument();
  });
});
