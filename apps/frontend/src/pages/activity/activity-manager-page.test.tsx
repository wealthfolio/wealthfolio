import { act, render, waitFor } from "@/test/render";
import { QueryKeys } from "@/lib/query-keys";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import type { AccountSelectOption } from "./components/forms/fields";
import ActivityManagerPage from "./activity-manager-page";

const mocks = vi.hoisted(() => ({
  rendered: [] as { accounts: AccountSelectOption[]; defaultValues: Record<string, unknown> }[],
  getAccounts: vi.fn(),
  getAssetHoldingsScope: vi.fn(),
}));

vi.mock("@/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/adapters")>()),
  getAccounts: mocks.getAccounts,
  getAssetHoldingsScope: mocks.getAssetHoldingsScope,
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
const owned = (...holdings: { accountId: string; quantity: number }[]) => ({
  holdings,
  incompleteAccounts: [] as { accountId: string; status: string; reasonCode: string }[],
});

beforeEach(() => {
  mocks.rendered.length = 0;
  mocks.getAccounts.mockReset().mockResolvedValue([cryptoAccount]);
  mocks.getAssetHoldingsScope.mockReset().mockResolvedValue(owned());
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
  mocks.getAssetHoldingsScope.mockResolvedValue(
    owned({ accountId: cryptoAccount.id, quantity: 1.12345678 }),
  );
  renderManager("/activities/manage?type=SELL&assetId=asset-btc");

  await waitFor(() =>
    expect(mocks.rendered.at(-1)?.defaultValues.accountId).toBe(cryptoAccount.id),
  );
  expect(mocks.getAssetHoldingsScope).toHaveBeenCalledWith("asset-btc");
  expect(mocks.rendered.at(-1)?.defaultValues.existingAssetId).toBe("asset-btc");
});

it("requires a choice when several eligible accounts hold the asset", async () => {
  mocks.getAccounts.mockResolvedValue([spendingAccount, cryptoAccount]);
  mocks.getAssetHoldingsScope.mockResolvedValue(
    owned(
      { accountId: cryptoAccount.id, quantity: 1 },
      { accountId: spendingAccount.id, quantity: 2 },
    ),
  );
  renderManager("/activities/manage?type=SELL&assetId=asset-btc");

  await waitFor(() => expect(mocks.getAssetHoldingsScope).toHaveBeenCalled());
  await waitFor(() => expect(mocks.rendered.at(-1)?.accounts).toHaveLength(2));
  expect(mocks.rendered.at(-1)?.defaultValues.accountId).toBe("");
});

it("does not fall back to a sole spending account when the owning account cannot record sales", async () => {
  mocks.getAccounts.mockResolvedValue([
    spendingAccount,
    { ...cryptoAccount, trackingMode: "HOLDINGS" },
  ]);
  mocks.getAssetHoldingsScope.mockResolvedValue(
    owned({ accountId: cryptoAccount.id, quantity: 1 }),
  );
  renderManager("/activities/manage?type=SELL&assetId=asset-btc");

  await waitFor(() => expect(mocks.rendered.at(-1)?.accounts).toHaveLength(1));
  expect(mocks.rendered.at(-1)?.defaultValues.accountId).toBe("");
});

it("preserves an explicit account and skips ownership lookup", async () => {
  mocks.getAccounts.mockResolvedValue([spendingAccount, cryptoAccount]);
  renderManager("/activities/manage?type=SELL&account=acc-crypto&assetId=asset-btc");

  await waitFor(() => expect(mocks.rendered.at(-1)?.accounts).toHaveLength(2));
  expect(mocks.rendered.at(-1)?.defaultValues.accountId).toBe(cryptoAccount.id);
  expect(mocks.getAssetHoldingsScope).not.toHaveBeenCalled();
});

it("leaves the account unselected when ownership cannot be loaded", async () => {
  mocks.getAccounts.mockResolvedValue([spendingAccount]);
  mocks.getAssetHoldingsScope.mockRejectedValue(new Error("Holdings unavailable"));
  renderManager("/activities/manage?type=SELL&assetId=asset-btc");
  await waitFor(() => expect(mocks.rendered.at(-1)?.accounts).toHaveLength(1));
  expect(mocks.rendered.at(-1)?.defaultValues.accountId).toBe("");
});

it.each([0, 5 * 60 * 1000])(
  "waits for fresh ownership with cached holdings and staleTime=%s",
  async (staleTime) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime } } });
    client.setQueryData([QueryKeys.ACCOUNTS], [spendingAccount, cryptoAccount]);
    client.setQueryData(
      [QueryKeys.ASSET_HOLDINGS, "asset-btc", "scope"],
      owned({ accountId: spendingAccount.id, quantity: 1 }),
    );
    mocks.getAccounts.mockResolvedValue([spendingAccount, cryptoAccount]);
    let resolveHoldings: (scope: ReturnType<typeof owned>) => void = () => {};
    mocks.getAssetHoldingsScope.mockReturnValue(
      new Promise((resolve) => {
        resolveHoldings = resolve;
      }),
    );
    renderManager("/activities/manage?type=SELL&assetId=asset-btc", client);
    await waitFor(() => expect(mocks.getAssetHoldingsScope).toHaveBeenCalledTimes(1));
    expect(mocks.rendered).toHaveLength(0);
    await act(async () => {
      resolveHoldings(owned({ accountId: cryptoAccount.id, quantity: 1 }));
    });
    await waitFor(() =>
      expect(mocks.rendered.at(-1)?.defaultValues.accountId).toBe(cryptoAccount.id),
    );
  },
);

it("does not use cached ownership when its refresh fails", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 5 * 60 * 1000 } },
  });
  client.setQueryData(
    [QueryKeys.ASSET_HOLDINGS, "asset-btc", "scope"],
    owned({ accountId: cryptoAccount.id, quantity: 1 }),
  );
  mocks.getAssetHoldingsScope.mockRejectedValue(new Error("Refresh failed"));
  renderManager("/activities/manage?type=SELL&assetId=asset-btc", client);
  await waitFor(() => expect(mocks.getAssetHoldingsScope).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(mocks.rendered.at(-1)?.defaultValues.accountId).toBe(""));
});

it("does not change the form's account default when holdings refresh during entry", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mocks.getAccounts.mockResolvedValue([spendingAccount, cryptoAccount]);
  mocks.getAssetHoldingsScope.mockResolvedValue(
    owned({ accountId: cryptoAccount.id, quantity: 1 }),
  );
  renderManager("/activities/manage?type=SELL&assetId=asset-btc", client);
  await waitFor(() =>
    expect(mocks.rendered.at(-1)?.defaultValues.accountId).toBe(cryptoAccount.id),
  );
  client.setQueryData(
    [QueryKeys.ASSET_HOLDINGS, "asset-btc", "scope"],
    owned({ accountId: spendingAccount.id, quantity: 1 }),
  );
  await waitFor(() =>
    expect(mocks.rendered.at(-1)?.defaultValues.accountId).toBe(cryptoAccount.id),
  );
});

it("waits for an account that is still recalculating before choosing the owner", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Accounts are usually loaded long before Sell opens.
  client.setQueryData([QueryKeys.ACCOUNTS], [spendingAccount, cryptoAccount]);
  mocks.getAccounts.mockResolvedValue([spendingAccount, cryptoAccount]);
  mocks.getAssetHoldingsScope.mockResolvedValue({
    holdings: [],
    incompleteAccounts: [
      { accountId: cryptoAccount.id, status: "pending", reasonCode: "PROJECTION_PENDING" },
    ],
  });
  renderManager("/activities/manage?type=SELL&assetId=asset-btc", client);
  await waitFor(() => expect(mocks.getAssetHoldingsScope).toHaveBeenCalledTimes(1));
  // Let the page settle on that first answer: it keeps loading, with no form yet.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(mocks.rendered).toHaveLength(0);

  // The portfolio update's completion refreshes every holdings query.
  mocks.getAssetHoldingsScope.mockResolvedValue(
    owned({ accountId: cryptoAccount.id, quantity: 1 }),
  );
  await act(async () => {
    await client.invalidateQueries({ queryKey: [QueryKeys.ASSET_HOLDINGS] });
  });
  await waitFor(() =>
    expect(mocks.rendered.at(-1)?.defaultValues.accountId).toBe(cryptoAccount.id),
  );
});

it("leaves the account unselected when an account's holdings are unavailable", async () => {
  mocks.getAccounts.mockResolvedValue([spendingAccount, cryptoAccount]);
  mocks.getAssetHoldingsScope.mockResolvedValue({
    holdings: [{ accountId: cryptoAccount.id, quantity: 1 }],
    incompleteAccounts: [
      {
        accountId: spendingAccount.id,
        status: "unavailable",
        reasonCode: "ACCOUNTING_UNAVAILABLE",
      },
    ],
  });
  renderManager("/activities/manage?type=SELL&assetId=asset-btc");
  await waitFor(() => expect(mocks.rendered.at(-1)?.accounts).toHaveLength(2));
  expect(mocks.rendered.at(-1)?.defaultValues.accountId).toBe("");
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
