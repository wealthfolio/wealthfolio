import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryKeys } from "@/lib/query-keys";
import useGlobalEventListener from "./use-global-event-listener";

const mocks = vi.hoisted(() => ({
  updatePortfolio: vi.fn(),
  error: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock("@/adapters", () => {
  const listener = (name: string) =>
    vi.fn(async (callback: (event: { payload: unknown }) => void) => {
      mocks.listeners.set(name, callback);
      return vi.fn();
    });
  return {
    isTauri: false,
    updatePortfolio: mocks.updatePortfolio,
    logger: { error: mocks.error },
    ...Object.fromEntries(
      [
        "listenAssetClassificationsChanged",
        "listenBrokerSyncComplete",
        "listenBrokerSyncError",
        "listenDatabaseRestored",
        "listenMarketSyncComplete",
        "listenMarketSyncError",
        "listenMarketSyncStart",
        "listenPortfolioUpdateComplete",
        "listenGoalSummariesUpdated",
        "listenPortfolioUpdateError",
        "listenPortfolioUpdateStart",
      ].map((name) => [name, listener(name)]),
    ),
  };
});
vi.mock("@/context/portfolio-sync-context", () => ({ usePortfolioSyncOptional: () => null }));
vi.mock("@/hooks/use-platform", () => ({ useIsMobileViewport: () => false }));
vi.mock("@/lib/asset-logo-registry", () => ({ assetLogoRegistry: { reset: vi.fn() } }));
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("sonner", () => ({ toast: { loading: vi.fn(), dismiss: vi.fn(), error: vi.fn() } }));

function fire(name: string, payload: unknown = {}) {
  act(() => mocks.listeners.get(name)?.({ payload }));
}

const dayAdvance = {
  holdings: [],
  incompleteAccounts: [{ accountId: "due", status: "pending", reasonCode: "DAY_ADVANCE_PENDING" }],
};

async function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const hook = renderHook(() => useGlobalEventListener(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  await waitFor(() => expect(hook.result.current).toBe(true));
  expect(mocks.updatePortfolio).toHaveBeenCalledTimes(1);
  fire("listenPortfolioUpdateComplete");
  mocks.updatePortfolio.mockClear();
  return { client, ...hook };
}

describe("day-advance recovery through the existing portfolio job", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listeners.clear();
    mocks.updatePortfolio.mockResolvedValue(undefined);
  });

  it("requests one update across holdings and asset reads, then can advance another day", async () => {
    const { client } = await setup();
    act(() => {
      client.setQueryData([QueryKeys.HOLDINGS, "all"], dayAdvance);
      client.setQueryData([QueryKeys.ASSET_HOLDINGS, "asset"], dayAdvance);
    });
    expect(mocks.updatePortfolio).toHaveBeenCalledTimes(1);
    fire("listenPortfolioUpdateStart");
    act(() => client.setQueryData([QueryKeys.HOLDINGS, "account"], dayAdvance));
    expect(mocks.updatePortfolio).toHaveBeenCalledTimes(1);
    fire("listenPortfolioUpdateComplete");
    act(() =>
      client.setQueryData([QueryKeys.HOLDINGS, "all"], { holdings: [], incompleteAccounts: [] }),
    );
    expect(mocks.updatePortfolio).toHaveBeenCalledTimes(1);
    act(() => client.setQueryData([QueryKeys.HOLDINGS, "all"], dayAdvance));
    expect(mocks.updatePortfolio).toHaveBeenCalledTimes(2);
  });

  it("leaves unchanged, ordinary pending, unavailable, and unrelated reads alone", async () => {
    const { client } = await setup();
    act(() => {
      client.setQueryData([QueryKeys.HOLDINGS, "complete"], {
        holdings: [],
        incompleteAccounts: [],
      });
      for (const status of ["pending", "unavailable"]) {
        client.setQueryData([QueryKeys.HOLDINGS, status], {
          holdings: [],
          incompleteAccounts: [{ accountId: "other", status, reasonCode: "PROJECTION_PENDING" }],
        });
      }
      client.setQueryData(["unrelated"], dayAdvance);
    });
    expect(mocks.updatePortfolio).not.toHaveBeenCalled();
  });

  it("lets an existing job finish before requesting any still-due work", async () => {
    const { client } = await setup();
    fire("listenPortfolioUpdateStart");
    act(() => client.setQueryData([QueryKeys.HOLDINGS, "all"], dayAdvance));
    expect(mocks.updatePortfolio).not.toHaveBeenCalled();
    fire("listenPortfolioUpdateComplete");
    act(() => client.setQueryData([QueryKeys.HOLDINGS, "all"], dayAdvance));
    expect(mocks.updatePortfolio).toHaveBeenCalledTimes(1);
  });

  it("does not loop on a rejected job request and removes the query subscription on unmount", async () => {
    const { client, unmount } = await setup();
    mocks.updatePortfolio.mockRejectedValue(new Error("request failed"));
    act(() => client.setQueryData([QueryKeys.HOLDINGS, "all"], dayAdvance));
    await waitFor(() => expect(mocks.error).toHaveBeenCalled());
    act(() => client.setQueryData([QueryKeys.ASSET_HOLDINGS, "asset"], dayAdvance));
    expect(mocks.updatePortfolio).toHaveBeenCalledTimes(1);
    unmount();
    act(() => client.setQueryData([QueryKeys.HOLDINGS, "after-unmount"], dayAdvance));
    expect(mocks.updatePortfolio).toHaveBeenCalledTimes(1);
  });
});
