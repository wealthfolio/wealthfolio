import { describe, expect, it } from "vitest";

import type { AllocationWorksheetResult, CalculatedAdjustments } from "@/lib/types";

import {
  toCsv,
  toTsv,
  worksheetExportRows,
  wrapText,
  type WorksheetExportLabels,
} from "./allocation-worksheet-export";

const labels: WorksheetExportLabels = {
  title: "Rebalancing worksheet",
  target: "Target",
  calculatedAt: "Calculated at",
  accounts: "Accounts to change",
  mode: "Mode",
  modeValue: "Rebalance",
  rule: "Allocation rule",
  ruleValue: "Allocate by current holding proportions",
  trackedCash: "Recorded cash used",
  externalCash: "Cash not yet recorded",
  eligible: "Eligible securities",
  eligibleValue: "All recorded securities",
  scaling: [],
  note: "Note",
  category: "Category",
  symbol: "Symbol",
  security: "Security",
  account: "Account",
  amount: "Amount",
  quantity: "Estimated quantity",
  price: "Unit price",
  priceDate: "Price date",
  warnings: "Warnings",
  statusUnresolved: "Unresolved",
  unknownAccount: "Unknown account",
  total: "Total",
  cashLeft: "Cash remaining",
  limitationsTitle: "About this preview",
  limitations: "Nothing is submitted or executed.",
};

const quote = {
  id: "q",
  sourceType: "quote",
  value: 100,
  fromCurrency: "USD",
  toCurrency: "USD",
  timestamp: "2026-09-20T16:00:00Z",
  isStale: false,
};

function line(overrides: Record<string, unknown>) {
  return {
    lineId: "line",
    direction: "increase",
    accountId: "acc-1",
    quantity: 1,
    unitPrice: 100,
    estimatedAmount: 100,
    quoteSource: quote,
    categoryExposures: [{ categoryId: "us", categoryName: "US equity", weightBps: 10000 }],
    ...overrides,
  };
}

// Lines arrive in the order the calculation produced them, accounts mixed.
const result = {
  targetName: "Balanced",
  baseCurrency: "USD",
  calculatedAt: "2026-09-24T10:00:00Z",
  lines: [
    line({
      lineId: "l1",
      assetId: "vbiax",
      accountId: "acc-1",
      symbol: "VBIAX",
      name: "Balanced Index",
      estimatedAmount: 1200,
      quantity: 12,
      // Stored as a 32-bit float and widened.
      unitPrice: 99.999998,
      categoryExposures: [
        { categoryId: "us", categoryName: "US equity", weightBps: 6000 },
        { categoryId: "bond", categoryName: "Bonds", weightBps: 4000 },
      ],
    }),
    line({
      lineId: "l2",
      direction: "reduce",
      assetId: "bnd",
      accountId: "acc-2",
      symbol: "BND",
      name: "=HYPERLINK(evil)",
      estimatedAmount: 300.004,
      quantity: 4,
      unitPrice: 75,
      categoryExposures: [{ categoryId: "bond", categoryName: "Bonds", weightBps: 10000 }],
    }),
    line({
      lineId: "l3",
      assetId: "aapl",
      accountId: "acc-1",
      symbol: "AAPL",
      name: "Apple",
      estimatedAmount: 200,
      quantity: 1,
      unitPrice: 200,
    }),
  ],
  accountFunding: [
    { accountId: "acc-1", remaining: -100 },
    { accountId: "acc-2", remaining: 300 },
  ],
  warnings: [{ id: "w1", kind: "stale_quote", lineId: "l2", message: "BND quote is dated." }],
} as unknown as AllocationWorksheetResult;

const calculated = {
  unresolved: [
    { categoryId: "gold", categoryName: "Gold", amount: 50, reason: "no_eligible_security" },
  ],
} as unknown as CalculatedAdjustments;

function csvLines(overrides: Partial<WorksheetExportLabels> = {}) {
  const rows = worksheetExportRows(
    {
      result,
      calculated,
      accountNames: new Map([
        ["acc-1", "Brokerage"],
        ["acc-2", "Retirement"],
      ]),
      accountIds: ["acc-1", "acc-2"],
      trackedCashToUse: 900,
      externalCash: 300.5,
    },
    { ...labels, ...overrides },
  );
  // One CSV row per table row: a wrapped cell keeps its line breaks inside it.
  return rows.map((row) => toCsv([row]));
}

describe("worksheet export", () => {
  it("opens on the lines, grouped by account then symbol, with the reductions negative", () => {
    const lines = csvLines();

    expect(lines.slice(0, 4)).toEqual([
      `"Account","Symbol","Security","Amount (USD)","Estimated quantity","Unit price (USD)","Category","Price date","Note"`,
      `"Brokerage","AAPL","Apple","200.00","1","200","US equity","2026-09-20",""`,
      // A mixed fund carries both its classes; the stored price loses its float residue.
      `"Brokerage","VBIAX","Balanced Index","1200.00","12","100","US equity 60% · Bonds 40%","2026-09-20",""`,
      // A name a spreadsheet would run stays text.
      `"Retirement","BND","'=HYPERLINK(evil)","-300.00","-4","75","Bonds","2026-09-20","BND quote is dated."`,
    ]);
  });

  it("keeps unresolved amounts in the table, with no account or security", () => {
    expect(csvLines()[4]).toBe(`"","","","50.00","","","Gold","","Unresolved"`);
  });

  it("totals each account apart from the lines, with the cash it has left", () => {
    const lines = csvLines();
    const header = lines.indexOf(`"Account","Total (USD)","Cash remaining (USD)"`);

    expect(header).toBe(6);
    expect(lines.slice(header + 1, header + 3)).toEqual([
      `"Brokerage","1400.00","-100.00"`,
      `"Retirement","-300.00","300.00"`,
    ]);
  });

  it("ends with what it was calculated from, the warnings and the limitations, label then value", () => {
    const lines = csvLines({
      scaling: ["Increases were scaled to 80% to fit the available funding."],
      outOfDate: "Inputs changed after this calculation.",
    });
    const title = lines.indexOf(`"Rebalancing worksheet"`);

    expect(title).toBeGreaterThan(8);
    expect(lines[title + 1]).toBe(`"Target","","Balanced"`);
    // Local time to the minute, not the raw timestamp.
    expect(lines[title + 2]).toMatch(/^"Calculated at","","2026-09-2\d \d{2}:\d{2}"$/);
    expect(lines.slice(title + 3)).toEqual([
      `"Accounts to change","","Brokerage, Retirement"`,
      `"Mode","","Rebalance"`,
      `"Allocation rule","","Allocate by current holding proportions"`,
      `"Eligible securities","","All recorded securities"`,
      `"Recorded cash used (USD)","","900.00"`,
      `"Cash not yet recorded (USD)","","300.50"`,
      `"Note","","Increases were scaled to 80% to fit the available funding."`,
      `"Note","","Inputs changed after this calculation."`,
      `"Warnings","","BND quote is dated."`,
      `"About this preview","","Nothing is submitted or executed."`,
    ]);
  });

  it("breaks a long sentence inside its cell so it does not widen the table", () => {
    const sentence =
      "Wealthfolio calculates adjustments from your target, the securities you marked as eligible, and the allocation rule you chose.";
    const wrapped = wrapText(sentence);

    expect(wrapped.split("\n").every((line) => line.length <= 70)).toBe(true);
    expect(wrapped.replaceAll("\n", " ")).toBe(sentence);
    // Written without spaces, it still breaks.
    expect(wrapText("計".repeat(80)).split("\n").length).toBeGreaterThan(1);
    // The clipboard keeps one line per cell.
    expect(toTsv([["a", wrapped]])).toBe(`a\t${sentence}`);
  });

  it("writes numbers with the user's decimal mark, and semicolons where it is a comma", () => {
    const table = [["Fortuneo Pea, PEA", { decimal: -1234.5, digits: 2 }, 59.81, 4]];

    expect(toCsv(table, ",")).toBe(`"Fortuneo Pea, PEA";"-1234,50";"59,81";"4"`);
    expect(toTsv(table, ",")).toBe("Fortuneo Pea, PEA\t-1234,50\t59,81\t4");
    expect(toCsv(table)).toBe(`"Fortuneo Pea, PEA","-1234.50","59.81","4"`);
  });

  it("keeps a text a spreadsheet would run as a formula as text, in both formats", () => {
    const table = [["=SUM(A1)", -300, "plain", { decimal: -300, digits: 2 }]];
    expect(toCsv(table)).toBe(`"'=SUM(A1)","-300","plain","-300.00"`);
    expect(toTsv(table)).toBe("'=SUM(A1)\t-300\tplain\t-300.00");
    expect(toCsv([['say "hi"']])).toBe(`"say ""hi"""`);
    expect(toTsv([["two\tcells\nhere"]])).toBe("two cells here");
  });
});
