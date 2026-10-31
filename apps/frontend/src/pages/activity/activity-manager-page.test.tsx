import { render, waitFor } from "@/test/render";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import type { AccountSelectOption } from "./components/forms/fields";
import ActivityManagerPage from "./activity-manager-page";

const mocks = vi.hoisted(() => ({
  rendered: [] as { accounts: AccountSelectOption[]; defaultValues: Record<string, unknown> }[],
}));

vi.mock("@/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/adapters")>()),
  getAccounts: vi.fn().mockResolvedValue([
    {
      id: "acc-crypto",
      name: "Exchange",
      accountType: "CRYPTOCURRENCY",
      currency: "USD",
      isActive: true,
      isArchived: false,
    },
  ]),
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
