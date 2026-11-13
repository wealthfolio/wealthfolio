import { describe, expect, it } from "vitest";
import { createDraftActivities, draftToActivityImport } from "./draft-utils";
import { parseNumericValue, parseSignedNumericValue } from "./review-draft-utils";
import {
  parseHoldingsSnapshots,
  parseHoldingsSnapshotsForValidation,
  parseNumericValue as parseHoldingsNumericValue,
} from "./holdings-import-utils";
import { analyzeMappedNumericColumns, analyzeNumericColumn } from "./numeric-format";

describe("numeric column detection", () => {
  it.each([
    [["1,000", "$25.50"], "."],
    [["1,000", "1,5"], ","],
    [["1.000", "1,5"], ","],
    [["1,234,567", "2,000"], "."],
    [["1.234.567", "2.000"], ","],
    [["-$1,500", "($2,500.25)"], "."],
    [["1,000e-2", "1,5e2"], ","],
    [["1234,567"], ","],
    [[".125"], "."],
    [["0.125", "1,000"], "."],
    [["0,125", "1.000"], ","],
    [["EUR 12,50", "1,000"], ","],
    [["-SEK 1,5", "1.000"], ","],
    [["12.50 USD", "1,000"], "."],
  ])("uses consistent evidence from %j", (values, decimalSeparator) => {
    expect(analyzeNumericColumn(values, "auto", "auto")).toEqual({ decimalSeparator });
    expect(analyzeNumericColumn([...values].reverse(), "auto", "auto")).toEqual({
      decimalSeparator,
    });
  });

  it("leaves all-ambiguous columns unresolved", () => {
    expect(analyzeNumericColumn(["1,000", "2,000"], "auto", "auto")).toEqual({
      decimalSeparator: "auto",
      issue: "ambiguous",
    });
    expect(analyzeNumericColumn(["1.000", "2.000"], "auto", "auto").issue).toBe("ambiguous");
  });

  it("does not choose whichever conflicting convention appears first", () => {
    for (const values of [
      ["25.50", "1,5"],
      ["1,5", "25.50"],
    ]) {
      expect(analyzeNumericColumn(values, "auto", "auto")).toEqual({
        decimalSeparator: "auto",
        issue: "conflicting",
      });
    }
  });

  it("ignores empty, integer, label and malformed cells as evidence", () => {
    expect(
      analyzeNumericColumn([undefined, "", "500", "Total 25.50", "1,23,45"], "auto", "auto"),
    ).toEqual({ decimalSeparator: "auto" });
  });

  it("respects explicit decimal and grouping settings", () => {
    expect(analyzeNumericColumn(["25.50"], ",", "auto")).toEqual({ decimalSeparator: "," });
    expect(analyzeNumericColumn(["1,5"], ".", "auto")).toEqual({ decimalSeparator: "." });
    expect(analyzeNumericColumn(["1,000"], "auto", ",")).toEqual({ decimalSeparator: "." });
    expect(analyzeNumericColumn(["1.000"], "auto", ".")).toEqual({ decimalSeparator: "," });
  });

  it.each(["none", " "])("does not infer punctuation grouping with thousands %j", (grouping) => {
    expect(analyzeNumericColumn(["1,000", "25.50"], "auto", grouping)).toEqual({
      decimalSeparator: "auto",
      issue: "conflicting",
    });
    expect(parseSignedNumericValue("1,000", "auto", grouping)).toBe("1.000");
  });

  it("uses the same effective fallback columns as activity parsing", () => {
    const columns = analyzeMappedNumericColumns(
      ["Amount", "Net", "Price", "Comment"],
      [
        ["1,000", "1,5", "1,5", "25.50"],
        ["", "25.50", "2,000", ""],
      ],
      { amount: ["Amount", "Net"], unitPrice: "Price", comment: "Comment" },
      "auto",
      "auto",
    );
    expect(columns).toEqual({
      amount: { decimalSeparator: "." },
      unitPrice: { decimalSeparator: "," },
    });
  });
});

describe("numeric parsing regression", () => {
  it.each([
    ["1,234,567", "1234567"],
    ["1.234.567", "1234567"],
    ["-$2,000,000", "-2000000"],
    ["($1,234,567)", "-1234567"],
    ["1,234,567e-2", "1234567e-2"],
    ["1.5e2 USD", "1.5e2"],
    ["-1.5E-2", "-1.5e-2"],
  ])("recognizes repeated grouping in %s", (input, expected) => {
    expect(parseSignedNumericValue(input, "auto", "auto")).toBe(expected);
  });

  it("retains the legacy interpretation when no column convention can be inferred", () => {
    expect(parseSignedNumericValue("1,000", "auto", "auto")).toBe("1.000");
    expect(parseSignedNumericValue("1.000", "auto", "auto")).toBe("1.000");
    expect(parseNumericValue("-$1,500", ".", "auto")).toBe("1500");
  });
});

const parseConfig = {
  dateFormat: "auto",
  decimalSeparator: "auto",
  thousandsSeparator: "auto",
  defaultCurrency: "USD",
};
const headers = ["Date", "Type", "Amount", "Quantity", "Price", "Fee", "Tax", "FX"];
const mapping = {
  fieldMappings: {
    date: "Date",
    activityType: "Type",
    amount: "Amount",
    quantity: "Quantity",
    unitPrice: "Price",
    fee: "Fee",
    tax: "Tax",
    fxRate: "FX",
  },
  activityMappings: { BUY: ["BUY"], DEPOSIT: ["DEPOSIT"], _SKIP_: ["IGNORE"] },
  symbolMappings: {},
  accountMappings: {},
};

describe("activity column parsing", () => {
  it("parses currency-prefixed cells that supply decimal evidence", () => {
    const drafts = createDraftActivities(
      [
        ["2026-01-15", "DEPOSIT", "1,000"],
        ["2026-01-16", "DEPOSIT", "EUR 12,50"],
        ["2026-01-17", "DEPOSIT", "-SEK 1,5"],
      ],
      headers,
      mapping,
      parseConfig,
      "account-1",
    );
    expect(drafts.map((draft) => draft.amount)).toEqual(["1.000", "12.50", "1.5"]);
  });

  it("resolves each numeric field independently and preserves the import payload", () => {
    const drafts = createDraftActivities(
      [
        ["2026-01-15", "BUY", "$1,500", "1,000", "1.000", "1,000", "1,000", "1,000"],
        ["2026-01-16", "BUY", "$25.50", "25.50", "1,5", "2.50", "2,5", "1,5"],
      ],
      headers,
      mapping,
      parseConfig,
      "account-1",
    );
    expect(drafts[0]).toMatchObject({
      amount: "1500",
      quantity: "1000",
      unitPrice: "1000",
      fee: "1000",
      tax: "1.000",
      fxRate: "1.000",
    });
    expect(draftToActivityImport(drafts[0])).toMatchObject({
      amount: "1500",
      quantity: "1000",
      unitPrice: "1000",
      fee: "1000",
      tax: "1.000",
      fxRate: "1.000",
    });
  });

  it("excludes skipped rows from the evidence", () => {
    const drafts = createDraftActivities(
      [
        ["2026-01-15", "DEPOSIT", "1,000"],
        ["2026-01-16", "DEPOSIT", "25.50"],
        ["2026-01-17", "IGNORE", "1,5"],
        ["2026-01-18", "DEPOSIT", "1,5"],
      ],
      headers,
      mapping,
      parseConfig,
      "account-1",
      undefined,
      undefined,
      { skippedRowIndexes: [3] },
    );
    expect(drafts).toHaveLength(2);
    expect(drafts[0].amount).toBe("1000");
  });

  it("keeps explicit settings authoritative", () => {
    const [draft] = createDraftActivities(
      [
        ["2026-01-15", "DEPOSIT", "1,000"],
        ["2026-01-16", "DEPOSIT", "25.50"],
      ],
      headers,
      mapping,
      { ...parseConfig, decimalSeparator: "," },
      "account-1",
    );
    expect(draft.amount).toBe("1.000");
  });

  it("preserves direction inference and fallback mappings", () => {
    const drafts = createDraftActivities(
      [
        ["2026-01-15", "TRANSFER", "", "-$2,000"],
        ["2026-01-16", "TRANSFER", "25.50", ""],
      ],
      ["Date", "Type", "Amount", "Net"],
      {
        ...mapping,
        fieldMappings: { date: "Date", activityType: "Type", amount: ["Amount", "Net"] },
        activityMappings: { DEPOSIT: ["TRANSFER"] },
      },
      parseConfig,
      "account-1",
    );
    expect(drafts[0]).toMatchObject({ activityType: "WITHDRAWAL", amount: "2000" });
  });
});

describe("holdings column parsing", () => {
  it.each([
    ["EUR 12,50", "12.50"],
    ["SEK 1,5", "1.5"],
  ])("preserves the legacy holdings fallback for currency prefix %s", (input, expected) => {
    expect(parseHoldingsNumericValue(input, "auto", "auto")).toBe(expected);
  });

  it("matches the first duplicate header used by the holdings parser", () => {
    const snapshots = parseHoldingsSnapshots(
      ["Date", "Symbol", "Quantity", "Quantity"],
      [
        ["2026-01-15", "TEST", "1,000", "1,5"],
        ["2026-01-15", "OTHER", "25.50", "2,000"],
      ],
      { date: "Date", symbol: "Symbol", quantity: "Quantity" },
      parseConfig,
    );
    expect(snapshots[0].positions[0].quantity).toBe("1000");
  });

  it("uses the same column resolution for validation and final snapshots", () => {
    const rows = [
      ["2026-01-15", "TEST", "1,000", "$1,500"],
      ["2026-01-15", "OTHER", "25.50", "$25.50"],
      ["2026-01-15", "$CASH", "$5,000", ""],
    ];
    const fieldMappings = { date: "Date", symbol: "Symbol", quantity: "Quantity", avgCost: "Cost" };
    const snapshots = parseHoldingsSnapshots(
      ["Date", "Symbol", "Quantity", "Cost"],
      rows,
      fieldMappings,
      parseConfig,
    );
    const validation = parseHoldingsSnapshotsForValidation(
      ["Date", "Symbol", "Quantity", "Cost"],
      rows,
      fieldMappings,
      parseConfig,
    );
    expect(validation).toEqual(snapshots);
    expect(snapshots[0].positions[0]).toMatchObject({ quantity: "1000", avgCost: "1500" });
    expect(snapshots[0].cashBalances).toEqual({ USD: "5000" });
  });
});
