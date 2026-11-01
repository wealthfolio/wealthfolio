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

  it("matches account numbers whatever their spacing", () => {
    const banks = [
      makeAccount({ id: "acc-de", name: "Checking", accountNumber: "DE89 3704 0044 0532 0130 00" }),
      makeAccount({ id: "acc-nl", name: "Savings", accountNumber: "NL91ABNA0417164300" }),
    ];

    expect(
      autoMatchAccountMappings(["DE89370400440532013000", "nl91 abna 0417 1643 00"], banks, {}),
    ).toEqual({
      DE89370400440532013000: "acc-de",
      "nl91 abna 0417 1643 00": "acc-nl",
    });
  });

  it("keeps names matched as written, spaces included", () => {
    expect(autoMatchAccountMappings(["Retire ment", "TradingAccount"], accounts, {})).toEqual({});
  });

  it("skips a number that matches more than one account once spaces are removed", () => {
    const twins = [
      makeAccount({ id: "acc-5", name: "Card A", accountNumber: "1234 5678" }),
      makeAccount({ id: "acc-6", name: "Card B", accountNumber: "12345678" }),
    ];

    expect(autoMatchAccountMappings(["12 345 678"], twins, {})).toEqual({});
    // Written exactly as one account has it, it still matches that account.
    expect(autoMatchAccountMappings(["1234 5678"], twins, {})).toEqual({ "1234 5678": "acc-5" });
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
