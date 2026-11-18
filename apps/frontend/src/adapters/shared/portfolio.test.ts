import { beforeEach, expect, it, vi } from "vitest";
import { calculatePerformanceSummary, getAssetHoldings, getAssetHoldingsScope } from "./portfolio";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), logger: { error: vi.fn() } }));
vi.mock("./platform", () => ({ invoke: mocks.invoke, logger: mocks.logger }));
beforeEach(() => mocks.invoke.mockReset());

it("keeps partial asset rows available to list consumers while strict consumers reject them", async () => {
  const scope = {
    holdings: [{ accountId: "healthy", quantity: 2 }],
    incompleteAccounts: [
      { accountId: "pending", status: "pending", reasonCode: "CALCULATION_REQUIRED" },
    ],
  };
  mocks.invoke.mockResolvedValue(scope);
  expect(await getAssetHoldingsScope("asset")).toEqual(scope);
  await expect(getAssetHoldings("asset")).rejects.toThrow("Holdings scope is incomplete");
  expect(mocks.invoke).toHaveBeenCalledWith("get_asset_holdings", { assetId: "asset" });
});

it("keeps strict consumers waiting for accounts mid-calculation", async () => {
  mocks.invoke.mockResolvedValue({
    holdings: [
      { accountId: "healthy", quantity: 2 },
      { accountId: "calculating", quantity: 1 },
    ],
    incompleteAccounts: [
      { accountId: "calculating", status: "pending", reasonCode: "PROJECTION_PENDING" },
    ],
  });
  // Option expiry records activities: a recent trade may be missing from
  // the last calculated holdings.
  await expect(getAssetHoldings("asset")).rejects.toThrow("Holdings scope is incomplete");
});

it("keeps the existing complete asset-holdings API for activity and expiry actions", async () => {
  const holdings = [{ accountId: "healthy", quantity: 2 }];
  mocks.invoke.mockResolvedValue({ holdings, incompleteAccounts: [] });
  expect(await getAssetHoldings("asset")).toEqual(holdings);
});

it("passes a reporting scope through the existing asset-holdings command", async () => {
  mocks.invoke.mockResolvedValue({ holdings: [], incompleteAccounts: [] });
  await getAssetHoldingsScope("cash:GBP", { type: "portfolio", portfolioId: "pf" });
  expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("get_asset_holdings", {
    assetId: "cash:GBP",
    filter: { type: "portfolio", portfolioId: "pf" },
  });
});

it("rejects a performance summary without a scope and keeps its values out of the log", async () => {
  mocks.logger.error.mockReset();
  mocks.invoke.mockResolvedValue({ totalValue: 98765.43, scope: {} });
  await expect(calculatePerformanceSummary({ itemType: "account", itemId: "a" })).rejects.toThrow(
    "Received invalid performance summary data from backend.",
  );
  expect(mocks.logger.error).toHaveBeenCalledOnce();
  expect(String(mocks.logger.error.mock.calls[0][0])).not.toContain("98765.43");
});
