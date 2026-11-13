import { describe, expect, it } from "vitest";

import { ImportFormat } from "@/lib/constants";
import type { Account, ImportMappingData } from "@/lib/types";

import { DEFAULT_ACTIVITY_IMPORT_PROFILE } from "./activity-import-profile";
import { createDefaultActivityMapping } from "./default-activity-template";
import { canProceedFromActivityMappingStep } from "./mapping-step-validation";

const accounts: Account[] = [
  { id: "acct-1", name: "Account 1", accountType: "SECURITIES" } as Account,
];

function mappingWith(fieldMappings: ImportMappingData["fieldMappings"]): ImportMappingData {
  return {
    ...createDefaultActivityMapping(),
    fieldMappings: {
      [ImportFormat.DATE]: "Date",
      [ImportFormat.ACTIVITY_TYPE]: "Action",
      [ImportFormat.QUANTITY]: "Qty",
      [ImportFormat.UNIT_PRICE]: "Price",
      ...fieldMappings,
    },
  };
}

describe("canProceedFromActivityMappingStep with fallback column lists", () => {
  it("accepts a valid account found only in a non-first fallback column", () => {
    const headers = ["Date", "Action", "Qty", "Price", "Symbol", "acct", "acct2"];
    const keptRows = [["2026-10-01", "BUY", "10", "9.99", "AAPL", "", "acct-1"]];

    expect(
      canProceedFromActivityMappingStep({
        importProfile: DEFAULT_ACTIVITY_IMPORT_PROFILE,
        mapping: mappingWith({
          [ImportFormat.SYMBOL]: "Symbol",
          [ImportFormat.ACCOUNT]: ["acct", "acct2"],
        }),
        headers,
        keptRows,
        accountId: "",
        accounts,
      }),
    ).toBe(true);
  });

  it("flags an unmapped symbol that appears only in a non-first fallback column", () => {
    const headers = ["Date", "Action", "Qty", "Price", "symbol", "ticker2"];
    const keptRows = [["2026-10-01", "BUY", "10", "9.99", "", "NOT A TICKER"]];

    expect(
      canProceedFromActivityMappingStep({
        importProfile: DEFAULT_ACTIVITY_IMPORT_PROFILE,
        mapping: mappingWith({ [ImportFormat.SYMBOL]: ["symbol", "ticker2"] }),
        headers,
        keptRows,
        accountId: "acct-1",
        accounts,
      }),
    ).toBe(false);
  });

  it("still accepts a valid ticker from a non-first fallback column", () => {
    const headers = ["Date", "Action", "Qty", "Price", "symbol", "ticker2"];
    const keptRows = [["2026-10-01", "BUY", "10", "9.99", "", "AAPL"]];

    expect(
      canProceedFromActivityMappingStep({
        importProfile: DEFAULT_ACTIVITY_IMPORT_PROFILE,
        mapping: mappingWith({ [ImportFormat.SYMBOL]: ["symbol", "ticker2"] }),
        headers,
        keptRows,
        accountId: "acct-1",
        accounts,
      }),
    ).toBe(true);
  });
});
