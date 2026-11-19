import { describe, expect, it } from "vitest";
import {
  CASH_NOT_TRACKED,
  CASH_TRACKED,
  getCashTrackingFromMeta,
  isCashNotTracked,
  setCashTrackingInMeta,
} from "./account-accounting";

const notTracked = JSON.stringify({ accounting: { cashTracking: CASH_NOT_TRACKED } });

describe("account cash tracking", () => {
  it.each([[undefined], [null], [""], ["not json"], ["[]"], ['{"accounting":null}']])(
    "reads meta %s as tracking cash",
    (meta) => {
      expect(getCashTrackingFromMeta(meta)).toBe(CASH_TRACKED);
    },
  );

  it("reads the stored code exactly, as core does", () => {
    expect(getCashTrackingFromMeta(notTracked)).toBe(CASH_NOT_TRACKED);
    expect(
      getCashTrackingFromMeta(JSON.stringify({ accounting: { cashTracking: "not_tracked" } })),
    ).toBe("not_tracked");
  });

  it("stores one spelling of the key and keeps the rest of the meta", () => {
    const meta = JSON.stringify({
      accounting: { costBasisMethod: "WAC", cash_tracking: CASH_TRACKED },
      allocation: { cashCategoryId: "EQUITY" },
    });
    expect(JSON.parse(setCashTrackingInMeta(meta, CASH_NOT_TRACKED))).toEqual({
      accounting: { costBasisMethod: "WAC", cashTracking: CASH_NOT_TRACKED },
      allocation: { cashCategoryId: "EQUITY" },
    });
  });

  it("counts only a transactions account holding securities as not tracking cash", () => {
    const account = { accountType: "SECURITIES", trackingMode: "TRANSACTIONS", meta: notTracked };
    expect(isCashNotTracked(account)).toBe(true);
    expect(isCashNotTracked({ ...account, accountType: "CRYPTOCURRENCY" })).toBe(true);
    expect(isCashNotTracked({ ...account, accountType: "CASH" })).toBe(false);
    expect(isCashNotTracked({ ...account, trackingMode: "HOLDINGS" })).toBe(false);
    expect(isCashNotTracked({ ...account, meta: undefined })).toBe(false);
  });
});
