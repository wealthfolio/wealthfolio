import { describe, expect, it } from "vitest";

import { cashToUse, editableAmounts, splitByShare } from "./allocation-worksheet-cash";

const accounts = [
  { accountId: "tfsa", recorded: 6240.18 },
  { accountId: "rrsp", recorded: 11872.4 },
  { accountId: "resp", recorded: 3410.25 },
];

describe("splitByShare", () => {
  it("spends the same share of every account and adds up to the total", () => {
    const parts = splitByShare(10000, accounts, 2);
    const total = Object.values(parts).reduce((sum, amount) => sum + amount, 0);
    expect(Math.round(total * 100)).toBe(1000000);
    // About 46.5% of each, to the cent; the leftover cent goes to the
    // largest remainder.
    expect(parts).toEqual({ tfsa: 2899.33, rrsp: 5516.19, resp: 1584.48 });
  });

  it("never asks an account for more than it records", () => {
    const parts = splitByShare(1_000_000, accounts, 2);
    expect(parts).toEqual({ tfsa: 6240.18, rrsp: 11872.4, resp: 3410.25 });
  });

  it("spends nothing from accounts that record nothing", () => {
    expect(splitByShare(500, [{ accountId: "a", recorded: 0 }], 2)).toEqual({ a: 0 });
  });
});

describe("cashToUse", () => {
  const recordedByAccount = { tfsa: 6240.18, rrsp: 11872.4, resp: 3410.25 };
  const base = {
    accountIds: ["tfsa", "rrsp", "resp"],
    recordedByAccount,
    fractionDigits: 2,
  };

  it("spends everything the accounts record until the user says otherwise", () => {
    const cash = cashToUse({ ...base, trackedCash: null, cashByAccount: null });
    expect(cash.byAccount).toEqual(recordedByAccount);
    expect(cash.total).toBeCloseTo(21522.83, 2);
    expect(cash.share).toBeCloseTo(1, 6);
  });

  it("spends a total as one share of each account, and flags a total above what they record", () => {
    const half = cashToUse({ ...base, trackedCash: "10761.415", cashByAccount: null });
    expect(half.share).toBeCloseTo(0.5, 3);
    expect(half.isTotalAboveRecorded).toBe(false);

    const tooMuch = cashToUse({ ...base, trackedCash: "30000", cashByAccount: null });
    expect(tooMuch.isTotalAboveRecorded).toBe(true);
    expect(tooMuch.total).toBeCloseTo(21522.83, 2);
  });

  it("adds up amounts set per account, and keeps each within what the account records", () => {
    const cash = cashToUse({
      ...base,
      trackedCash: null,
      cashByAccount: { tfsa: "1000", rrsp: "20000" },
    });
    // resp was not set: it spends what it records.
    expect(cash.byAccount).toEqual({ tfsa: 1000, rrsp: 11872.4, resp: 3410.25 });
    expect(cash.aboveRecordedAccountIds).toEqual(["rrsp"]);
    expect(cash.share).toBeNull();
    expect(cash.total).toBeCloseTo(16282.65, 2);
  });

  it("names an account whose amount cannot be read", () => {
    const cash = cashToUse({ ...base, trackedCash: null, cashByAccount: { tfsa: "12a" } });
    expect(cash.invalidAccountIds).toEqual(["tfsa"]);
    expect(cash.byAccount.tfsa).toBe(0);
  });

  it("counts nothing from an account whose cash is still being read", () => {
    const cash = cashToUse({
      ...base,
      recordedByAccount: { tfsa: 6240.18 },
      trackedCash: null,
      cashByAccount: null,
    });
    expect(cash.isKnown).toBe(false);
    expect(cash.total).toBeCloseTo(6240.18, 2);
  });
});

describe("editableAmounts", () => {
  it("writes each amount at the currency's precision", () => {
    expect(editableAmounts({ tfsa: 2833.6500000001, rrsp: 0 }, 2)).toEqual({
      tfsa: "2833.65",
      rrsp: "0",
    });
  });
});
