import { describe, it, expect } from "vitest";
import { AccountType } from "@/lib/constants";
import type { Account } from "@/lib/types";
import {
  accountSupportsActivityType,
  canAddHoldings,
  canImportCSV,
  getActivityRestrictionLevel,
  getAllowedActivityTypes,
  restrictionAllowsType,
} from "./activity-restrictions";

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: "acc-1",
    name: "Test Account",
    accountType: AccountType.SECURITIES,
    balance: 0,
    currency: "USD",
    isDefault: false,
    isActive: true,
    isArchived: false,
    trackingMode: "TRANSACTIONS",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("getAllowedActivityTypes", () => {
  it("allows every picker type, including EXCHANGE and TRANSFER, when no account is selected", () => {
    const types = getAllowedActivityTypes(undefined);
    expect(types).toContain("EXCHANGE");
    expect(types).toContain("TRANSFER");
    expect(types).toContain("BUY");
    expect(types).toContain("ADJUSTMENT");
  });

  it("allows every picker type for a TRANSACTIONS-mode account", () => {
    const types = getAllowedActivityTypes(makeAccount({ trackingMode: "TRANSACTIONS" }));
    expect(types).toContain("EXCHANGE");
    expect(types).toContain("TRANSFER");
  });

  it("allows every picker type for a NOT_SET-mode account", () => {
    const types = getAllowedActivityTypes(makeAccount({ trackingMode: "NOT_SET" }));
    expect(types).toContain("EXCHANGE");
  });

  it("blocks everything for a liability (credit card) account", () => {
    expect(getAllowedActivityTypes(makeAccount({ accountType: AccountType.CREDIT_CARD }))).toEqual(
      [],
    );
  });

  it("blocks everything for a connected (synced) HOLDINGS account", () => {
    const types = getAllowedActivityTypes(
      makeAccount({ trackingMode: "HOLDINGS", providerAccountId: "provider-123" }),
    );
    expect(types).toEqual([]);
  });

  it("restricts a manual HOLDINGS account to income/cash types, excluding EXCHANGE and TRANSFER", () => {
    const types = getAllowedActivityTypes(makeAccount({ trackingMode: "HOLDINGS" }));
    expect(types).toContain("DEPOSIT");
    expect(types).not.toContain("EXCHANGE");
    expect(types).not.toContain("TRANSFER");
    expect(types).not.toContain("BUY");
  });
});

describe("accountSupportsActivityType", () => {
  it("reflects getAllowedActivityTypes for the given account", () => {
    const transactionsAccount = makeAccount({ trackingMode: "TRANSACTIONS" });
    expect(accountSupportsActivityType(transactionsAccount, "EXCHANGE")).toBe(true);

    const holdingsAccount = makeAccount({ trackingMode: "HOLDINGS" });
    expect(accountSupportsActivityType(holdingsAccount, "EXCHANGE")).toBe(false);
    expect(accountSupportsActivityType(holdingsAccount, "DEPOSIT")).toBe(true);
  });
});

describe("canAddHoldings", () => {
  it("is false with no account", () => {
    expect(canAddHoldings(undefined)).toBe(false);
  });

  it("is false for liability accounts", () => {
    expect(canAddHoldings(makeAccount({ accountType: AccountType.CREDIT_CARD }))).toBe(false);
  });

  it("is true only for HOLDINGS tracking mode", () => {
    expect(canAddHoldings(makeAccount({ trackingMode: "HOLDINGS" }))).toBe(true);
    expect(canAddHoldings(makeAccount({ trackingMode: "TRANSACTIONS" }))).toBe(false);
  });

  it("keeps connected holdings read-only outside remediation", () => {
    expect(
      canAddHoldings(makeAccount({ trackingMode: "HOLDINGS", providerAccountId: "provider-123" })),
    ).toBe(false);
  });
});

describe("canImportCSV", () => {
  it("is true with no account", () => {
    expect(canImportCSV(undefined)).toBe(true);
  });

  it("is false only for connected (synced) HOLDINGS accounts", () => {
    expect(
      canImportCSV(makeAccount({ trackingMode: "HOLDINGS", providerAccountId: "provider-123" })),
    ).toBe(false);
    expect(canImportCSV(makeAccount({ trackingMode: "HOLDINGS" }))).toBe(true);
    expect(canImportCSV(makeAccount({ trackingMode: "TRANSACTIONS" }))).toBe(true);
  });
});

describe("getActivityRestrictionLevel", () => {
  it("is none with no account", () => {
    expect(getActivityRestrictionLevel(undefined)).toBe("none");
  });

  it("is blocked for liability accounts", () => {
    expect(getActivityRestrictionLevel(makeAccount({ accountType: AccountType.CREDIT_CARD }))).toBe(
      "blocked",
    );
  });

  it("is blocked for connected HOLDINGS accounts and limited for manual ones", () => {
    expect(
      getActivityRestrictionLevel(
        makeAccount({ trackingMode: "HOLDINGS", providerAccountId: "provider-123" }),
      ),
    ).toBe("blocked");
    expect(getActivityRestrictionLevel(makeAccount({ trackingMode: "HOLDINGS" }))).toBe("limited");
  });

  it("is none for TRANSACTIONS accounts", () => {
    expect(getActivityRestrictionLevel(makeAccount({ trackingMode: "TRANSACTIONS" }))).toBe("none");
  });
});

describe("restrictionAllowsType", () => {
  it("allows everything when undefined or none", () => {
    expect(restrictionAllowsType(undefined, "EXCHANGE")).toBe(true);
    expect(restrictionAllowsType("none", "EXCHANGE")).toBe(true);
  });

  it("blocks everything when blocked", () => {
    expect(restrictionAllowsType("blocked", "DEPOSIT")).toBe(false);
  });

  it("limited allows only income/cash types, excluding EXCHANGE", () => {
    expect(restrictionAllowsType("limited", "DEPOSIT")).toBe(true);
    expect(restrictionAllowsType("limited", "EXCHANGE")).toBe(false);
    expect(restrictionAllowsType("limited", "TRANSFER")).toBe(false);
  });
});
