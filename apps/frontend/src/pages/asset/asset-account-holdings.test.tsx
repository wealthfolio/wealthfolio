import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import { render, screen } from "@/test/render";
import { AssetAccountHoldings } from "./asset-account-holdings";
import type { Holding } from "@/lib/types";

const mocks = vi.hoisted(() => ({ getScope: vi.fn(), mobile: false }));
vi.mock("@/adapters", () => ({
  getAssetHoldingsScope: mocks.getScope,
  deleteSnapshot: vi.fn(),
  getSnapshotByDate: vi.fn(),
  getSnapshots: vi.fn(),
  saveManualHoldings: vi.fn(),
}));
vi.mock("@/hooks/use-accounts", () => ({
  useAccounts: () => ({
    accounts: [{ id: "healthy", name: "Healthy account", trackingMode: "TRANSACTIONS" }],
  }),
}));
vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: false }),
}));
vi.mock("@/hooks/use-platform", () => ({ useIsMobileViewport: () => mocks.mobile }));

beforeEach(() => {
  mocks.mobile = false;
  mocks.getScope.mockReset();
});

it.each([false, true])(
  "retains healthy asset rows and reports incomplete peers on mobile=%s",
  async (mobile) => {
    mocks.mobile = mobile;
    const holding = {
      id: "row",
      accountId: "healthy",
      quantity: 2,
      localCurrency: "CAD",
      marketValue: { local: 110, base: 110 },
      costBasis: { local: 100, base: 100 },
      totalGain: { local: 10, base: 10 },
      totalGainPct: 0.1,
    } as Holding;
    mocks.getScope.mockResolvedValue({
      holdings: [holding],
      incompleteAccounts: [
        { accountId: "other", status: "pending", reasonCode: "PROJECTION_PENDING" },
      ],
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AssetAccountHoldings assetId="asset" baseCurrency="CAD" />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("Healthy account")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/calculations are incomplete/i);
    expect(mocks.getScope).toHaveBeenCalledTimes(1);
  },
);
