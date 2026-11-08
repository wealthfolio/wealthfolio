import { beforeEach, expect, it, vi } from "vitest";
import { getAssetHoldings, getAssetHoldingsScope } from "./portfolio";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("./platform", () => ({ invoke: mocks.invoke, logger: {} }));
beforeEach(() => mocks.invoke.mockReset());

it("keeps partial asset rows available to list consumers while strict consumers reject them", async () => {
  const scope = {
    holdings: [{ accountId: "healthy", quantity: 2 }],
    incompleteAccounts: [
      { accountId: "pending", status: "pending", reasonCode: "PROJECTION_PENDING" },
    ],
  };
  mocks.invoke.mockResolvedValue(scope);
  expect(await getAssetHoldingsScope("asset")).toEqual(scope);
  await expect(getAssetHoldings("asset")).rejects.toThrow("Holdings scope is incomplete");
  expect(mocks.invoke).toHaveBeenCalledWith("get_asset_holdings", { assetId: "asset" });
});

it("keeps the existing complete asset-holdings API for activity and expiry actions", async () => {
  const holdings = [{ accountId: "healthy", quantity: 2 }];
  mocks.invoke.mockResolvedValue({ holdings, incompleteAccounts: [] });
  expect(await getAssetHoldings("asset")).toEqual(holdings);
});
