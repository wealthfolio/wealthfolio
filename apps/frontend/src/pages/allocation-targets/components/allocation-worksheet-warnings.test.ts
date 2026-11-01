import i18n from "i18next";
import { describe, expect, it } from "vitest";

import type { WorksheetWarning } from "@/lib/types";
import { describeWarning, type WarningFormatting } from "./allocation-worksheet-warnings";

const t = i18n.t.bind(i18n);
const result = {
  lines: [{ lineId: "line-spy", symbol: "SPY" }],
} as unknown as Parameters<typeof describeWarning>[1];
// A format unlike the core's: comma decimals and a currency suffix.
const format: WarningFormatting = {
  amount: (value) => `${value.toFixed(2).replace(".", ",")} $`,
  price: (value) => `${value.toFixed(2).replace(".", ",")} $`,
  percent: (fraction, digits) => `${(fraction * 100).toFixed(digits).replace(".", ",")} %`,
  date: (isoDate) => isoDate.split("-").reverse().join("/"),
  accountName: (accountId) => (accountId === "acc-roth" ? "Roth IRA" : accountId),
};

function warning(partial: Partial<WorksheetWarning>): WorksheetWarning {
  return {
    id: "w",
    kind: "external_contribution",
    lineId: null,
    message: "The core's English message",
    acknowledgementRequired: true,
    ...partial,
  };
}

describe("describeWarning", () => {
  it("words an account's shortfall with its name and the user's number format", () => {
    expect(
      describeWarning(
        warning({
          kind: "account_funding",
          facts: { amount: 198093.651204, limit: 25036.7702209473, accountId: "acc-roth" },
        }),
        result,
        format,
        t,
      ),
    ).toBe(
      "Increases of 198093,65 $ in Roth IRA exceed the 25036,77 $ it can fund on its own; no transfer between accounts is assumed.",
    );
  });

  it("names the security and states shares as percentages, not basis points", () => {
    expect(
      describeWarning(
        warning({ kind: "partial_classification", lineId: "line-spy", facts: { shareBps: 9999 } }),
        result,
        format,
        t,
      ),
    ).toBe("99,99 % of SPY is classified; the other 0,01 % counts as unclassified.");
  });

  it("formats amounts and dates the user's way", () => {
    expect(
      describeWarning(
        warning({ kind: "external_contribution", facts: { amount: 1000 } }),
        result,
        format,
        t,
      ),
    ).toBe("Includes 1000,00 $ of cash not yet recorded.");
    expect(
      describeWarning(
        warning({ kind: "stale_quote", lineId: "line-spy", facts: { asOf: "2026-09-30" } }),
        result,
        format,
        t,
      ),
    ).toBe("SPY uses a price from 30/09/2026.");
  });

  it("keeps the core's message when a figure it needs is missing", () => {
    expect(
      describeWarning(warning({ kind: "account_funding", facts: {} }), result, format, t),
    ).toBe("The core's English message");
  });
});
