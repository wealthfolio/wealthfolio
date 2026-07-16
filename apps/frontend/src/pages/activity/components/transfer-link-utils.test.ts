import { describe, expect, it } from "vitest";
import { ActivityType } from "@/lib/constants";
import {
  isSameAccountCashFxConversion,
  nonCashTransferAssetKey,
  type TransferLinkActivityLike,
} from "./transfer-link-utils";

function transfer(overrides: Partial<TransferLinkActivityLike> = {}): TransferLinkActivityLike {
  return {
    accountId: "acc-a",
    activityType: ActivityType.TRANSFER_OUT,
    amount: "100",
    currency: "USD",
    ...overrides,
  };
}

describe("transfer link utils", () => {
  it("accepts same-account cross-currency cash transfers with explicit amounts", () => {
    expect(
      isSameAccountCashFxConversion(
        transfer({ activityType: ActivityType.TRANSFER_OUT, amount: "69.6", currency: "USD" }),
        transfer({ activityType: ActivityType.TRANSFER_IN, amount: "94.4", currency: "CAD" }),
      ),
    ).toBe(true);
  });

  it("rejects same-account FX candidates without explicit cash amounts", () => {
    expect(
      isSameAccountCashFxConversion(
        transfer({
          activityType: ActivityType.TRANSFER_OUT,
          amount: null,
          quantity: "69.6",
          unitPrice: "1",
          currency: "USD",
        }),
        transfer({
          activityType: ActivityType.TRANSFER_IN,
          amount: null,
          quantity: "94.4",
          unitPrice: "1",
          currency: "CAD",
        }),
      ),
    ).toBe(false);
  });

  it("rejects same-account same-currency cash transfers", () => {
    expect(
      isSameAccountCashFxConversion(
        transfer({ activityType: ActivityType.TRANSFER_OUT, currency: "USD" }),
        transfer({ activityType: ActivityType.TRANSFER_IN, currency: "usd" }),
      ),
    ).toBe(false);
  });

  it("rejects same-account security transfers", () => {
    expect(
      isSameAccountCashFxConversion(
        transfer({
          activityType: ActivityType.TRANSFER_OUT,
          assetId: "AAPL",
          currency: "USD",
        }),
        transfer({
          activityType: ActivityType.TRANSFER_IN,
          assetId: "AAPL",
          currency: "CAD",
        }),
      ),
    ).toBe(false);
  });

  it("treats broker cash placeholders as cash but not a persisted CASH asset id", () => {
    expect(nonCashTransferAssetKey(transfer({ assetId: "$CASH-USD" }))).toBeUndefined();
    expect(nonCashTransferAssetKey(transfer({ assetSymbol: "Cash" }))).toBeUndefined();
    expect(nonCashTransferAssetKey(transfer({ assetId: "CASH" }))).toBe("CASH");
  });
});
