import { render, waitFor } from "@/test/render";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import type { AccountSelectOption } from "./components/forms/fields";
import ActivityManagerPage from "./activity-manager-page";

const mocks = vi.hoisted(() => ({
  rendered: [] as { accounts: AccountSelectOption[]; defaultValues: Record<string, unknown> }[],
  getAccounts: vi.fn(),
  getAssetHoldings: vi.fn(),
}));

vi.mock("@/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/adapters")>()),
  getAccounts: mocks.getAccounts,
  getAssetHoldings: mocks.getAssetHoldings,
}));
vi.mock("@/hooks/use-platform", () => ({ useIsMobileViewport: () => false }));
vi.mock("@/pages/layouts/mobile-stack/use-mobile-stack", () => ({
  useBackNavigation: () => vi.fn(),
}));
vi.mock("@/pages/asset/hooks/use-asset-profile", () => ({
  useAssetProfile: () => ({
    data: {
      id: "asset-btc",
      displayCode: "BTC",
      instrumentType: "CRYPTO",
      quoteCcy: "USD",
      quoteMode: "MARKET",
    },
  }),
}));
vi.mock("./components/activity-form-renderer", () => ({
  ActivityFormRenderer: (props: {
    accounts: AccountSelectOption[];
    defaultValues: Record<string, unknown>;
  }) => {
    mocks.rendered.push(props);
    return null;
  },
}));

// jsdom lacks the observers the page's layout uses.
class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("IntersectionObserver", NoopObserver);
vi.stubGlobal("ResizeObserver", NoopObserver);

const cryptoAccount = {
  id: "acc-crypto",
  name: "Exchange",
  accountType: "CRYPTOCURRENCY",
  currency: "USD",
  isActive: true,
  isArchived: false,
  trackingMode: "TRANSACTIONS",
};
const spendingAccount = {
  ...cryptoAccount,
  id: "acc-spending",
  name: "Spending",
  accountType: "CASH",
};

beforeEach(() => {
  mocks.rendered.length = 0;
  mocks.getAccounts.mockReset().mockResolvedValue([cryptoAccount]);
  mocks.getAssetHoldings.mockReset().mockResolvedValue([]);
});

function renderManager(
  url: string,
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <ActivityManagerPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

it("preselects the sole eligible account holding the asset, rather than a spending account", async () => {
  mocks.getAccounts.mockResolvedValue([spendingAccount, cryptoAccount]);
  mocks.getAssetHoldings.mockResolvedValue([{ accountId: cryptoAccount.id, quantity: 1.12345678 }]);
  renderManager("/activities/manage?type=SELL&assetId=asset-btc");

  await waitFor(() =>
    expect(mocks.rendered.at(-1)?.defaultValues.accountId).toBe(cryptoAccount.id),
  );
  expect(mocks.getAssetHoldings).toHaveBeenCalledWith("asset-btc");
  expect(mocks.rendered.at(-1)?.defaultValues.existingAssetId).toBe("asset-btc");
});

it("requires a choice when several eligible accounts hold the asset", async () => {
  mocks.getAccounts.mockResolvedValue([spendingAccount, cryptoAccount]);
  mocks.getAssetHoldings.mockResolvedValue([
    { accountId: cryptoAccount.id, quantity: 1 },
    { accountId: spendingAccount.id, quantity: 2 },
  ]);
  renderManager("/activities/manage?type=SELL&assetId=asset-btc");

  await waitFor(() => expect(mocks.getAssetHoldings).toHaveBeenCalled());
  await waitFor(() => expect(mocks.rendered.at(-1)?.accounts).toHaveLength(2));
  expect(mocks.rendered.at(-1)?.defaultValues.accountId).toBe("");
});

it("does not fall back to a sole spending account when the owning account cannot record sales", async () => {
  mocks.getAccounts.mockResolvedValue([
    spendingAccount,
    { ...cryptoAccount, trackingMode: "HOLDINGS" },
  ]);
  mocks.getAssetHoldings.mockResolvedValue([{ accountId: cryptoAccount.id, quantity: 1 }]);
  renderManager("/activities/manage?type=SELL&assetId=asset-btc");

  await waitFor(() => expect(mocks.rendered.at(-1)?.accounts).toHaveLength(1));
  expect(mocks.rendered.at(-1)?.defaultValues.accountId).toBe("");
});

it("preserves an explicit account and skips ownership lookup", async () => {
  mocks.getAccounts.mockResolvedValue([spendingAccount, cryptoAccount]);
  renderManager("/activities/manage?type=SELL&account=acc-crypto&assetId=asset-btc");

  await waitFor(() => expect(mocks.rendered.at(-1)?.accounts).toHaveLength(2));
  expect(mocks.rendered.at(-1)?.defaultValues.accountId).toBe(cryptoAccount.id);
  expect(mocks.getAssetHoldings).not.toHaveBeenCalled();
});

it("leaves the account unselected when ownership cannot be loaded", async () => {
  mocks.getAccounts.mockResolvedValue([spendingAccount]);
  mocks.getAssetHoldings.mockRejectedValue(new Error("Holdings unavailable"));
  renderManager("/activities/manage?type=SELL&assetId=asset-btc");
  await waitFor(() => expect(mocks.rendered.at(-1)?.accounts).toHaveLength(1));
  expect(mocks.rendered.at(-1)?.defaultValues.accountId).toBe("");
});

it("does not change the form's account default when holdings refresh during entry", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mocks.getAccounts.mockResolvedValue([spendingAccount, cryptoAccount]);
  mocks.getAssetHoldings.mockResolvedValue([{ accountId: cryptoAccount.id, quantity: 1 }]);
  renderManager("/activities/manage?type=SELL&assetId=asset-btc", client);
  await waitFor(() =>
    expect(mocks.rendered.at(-1)?.defaultValues.accountId).toBe(cryptoAccount.id),
  );
  client.setQueryData(
    ["assetHoldings", "asset-btc"],
    [{ accountId: spendingAccount.id, quantity: 1 }],
  );
  await waitFor(() =>
    expect(mocks.rendered.at(-1)?.defaultValues.accountId).toBe(cryptoAccount.id),
  );
});

it("hands a buy opened from a crypto asset its account type and instrument type", async () => {
  // Both decide that the trade's total stays exact and that its money fields
  // take 8 decimals.
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter
        initialEntries={["/activities/manage?type=BUY&account=acc-crypto&assetId=asset-btc"]}
      >
        <ActivityManagerPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  await waitFor(() => expect(mocks.rendered.at(-1)?.accounts).toHaveLength(1));
  const props = mocks.rendered.at(-1);
  expect(props?.accounts[0]?.accountType).toBe("CRYPTOCURRENCY");
  expect(props?.defaultValues.symbolInstrumentType).toBe("CRYPTO");
});
