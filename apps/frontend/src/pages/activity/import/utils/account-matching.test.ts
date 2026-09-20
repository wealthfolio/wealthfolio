import { describe, expect, it } from "vitest";
import { AccountType } from "@/lib/constants";
import type { Account } from "@/lib/types";
import { autoMatchAccountMappings, collectCsvAccountValues } from "./account-matching";

function makeAccount(overrides: Partial<Account> & Pick<Account, "id" | "name">): Account {
  return {
    accountType: AccountType.SECURITIES,
    balance: 0,
    currency: "USD",
    isDefault: false,
    isActive: true,
    isArchived: false,
    trackingMode: "TRANSACTIONS",
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    ...overrides,
  };
}

const accounts: Account[] = [
  makeAccount({ id: "acc-1", name: "Trading Account", accountNumber: "Z12345" }),
  makeAccount({ id: "acc-2", name: "Retirement" }),
];

describe("collectCsvAccountValues", () => {
  const headers = ["Date", "Account", "Alt Account"];
  const rows = [
    ["2024-01-01", "Retirement", ""],
    ["2024-01-02", " Retirement ", ""],
    ["2024-01-03", "", "Trading Account"],
  ];

  it("returns distinct trimmed values for the mapped column", () => {
    expect(collectCsvAccountValues(rows, headers, "Account")).toEqual(["Retirement"]);
  });

  it("falls back to the next mapped column when the first is blank", () => {
    expect(collectCsvAccountValues(rows, headers, ["Account", "Alt Account"])).toEqual([
      "Retirement",
      "Trading Account",
    ]);
  });

  it("returns nothing when the column is unmapped or missing", () => {
    expect(collectCsvAccountValues(rows, headers, undefined)).toEqual([]);
    expect(collectCsvAccountValues(rows, headers, "Portfolio")).toEqual([]);
  });
});

describe("autoMatchAccountMappings", () => {
  it("matches account names regardless of case and spacing", () => {
    expect(autoMatchAccountMappings(["  trading   account "], accounts, {})).toEqual({
      "trading   account": "acc-1",
    });
  });

  it("matches account ids and broker account numbers", () => {
    expect(autoMatchAccountMappings(["acc-2", "z12345"], accounts, {})).toEqual({
      "acc-2": "acc-2",
      z12345: "acc-1",
    });
  });

  it("keeps existing mappings and leaves unknown values unmapped", () => {
    expect(
      autoMatchAccountMappings(["Retirement", "Unknown Broker"], accounts, {
        Retirement: "acc-1",
      }),
    ).toEqual({ Retirement: "acc-1" });
  });

  it("skips values claimed by more than one account", () => {
    const ambiguous = [
      makeAccount({ id: "acc-3", name: "Joint" }),
      makeAccount({ id: "acc-4", name: "joint" }),
    ];

    expect(autoMatchAccountMappings(["Joint"], ambiguous, {})).toEqual({});
  });

  it("returns the given mappings unchanged when nothing matches", () => {
    const existing = { Retirement: "acc-2" };

    expect(autoMatchAccountMappings(["Unknown"], accounts, existing)).toBe(existing);
    expect(autoMatchAccountMappings([], accounts, existing)).toBe(existing);
  });
});
