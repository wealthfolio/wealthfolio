import { describe, expect, it } from "vitest";
import { createInstance } from "i18next";
import { worksheetCategoryLabel } from "./allocation-worksheet-labels";
import zhAllocation from "@/i18n/locales/zh/allocation.json";
import enAllocation from "@/i18n/locales/en/allocation.json";
import zhCommon from "@/i18n/locales/zh/common.json";
import zhCommonTaxonomies from "@/i18n/locales/zh/taxonomies.json";
import enCommon from "@/i18n/locales/en/common.json";
import enCommonTaxonomies from "@/i18n/locales/en/taxonomies.json";

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
  status: "Status",
  statusUnresolved: "Unresolved",
  statusCalculated: "Calculated",
  statusEdited: "Edited",
  direction: "Direction",
  increase: "Increase",
  reduce: "Reduce",
  deposit: "Deposit",
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
      depositsByAccount: { "acc-2": 300.5 },
      // BND was changed by hand after the calculation.
      editedAssetIds: new Set(["bnd"]),
      describeWarning: (warning) => warning.message,
    },
    { ...labels, ...overrides },
  );
  // One CSV row per table row: a wrapped cell keeps its line breaks inside it.
  return rows.map((row) => toCsv([row]));
}

describe("worksheet export", () => {
  it("localizes category displays without changing saved names or custom labels", async () => {
    const i18n = createInstance();
    await i18n.init({
      lng: "zh-CN",
      resources: {
        "zh-CN": { common: zhCommon, taxonomies: zhCommonTaxonomies, allocation: zhAllocation },
        en: { common: enCommon, taxonomies: enCommonTaxonomies, allocation: enAllocation },
      },
    });
    const localizedResult: AllocationWorksheetResult = {
      ...result,
      lines: [
        {
          ...result.lines[0],
          categoryExposures: [
            {
              categoryId: "EQUITY",
              categoryName: "Equity",
              weightBps: 6000,
              valueDelta: 720,
              isUnclassified: false,
            },
            {
              categoryId: "FIXED_INCOME",
              categoryName: "My bonds",
              weightBps: 4000,
              valueDelta: 480,
              isUnclassified: false,
            },
          ],
        },
        {
          ...result.lines[1],
          categoryExposures: [
            {
              categoryId: "EQUITY",
              categoryName: "Equity",
              weightBps: 10000,
              valueDelta: -300.004,
              isUnclassified: false,
            },
          ],
        },
      ],
    };
    const localizedCalculated = {
      ...calculated,
      unresolved: [
        { ...calculated.unresolved[0], categoryId: "EQUITY", categoryName: "Equity" },
        ...["Unknown", "Unclassified", "Unclassified exposure"].map((categoryName) => ({
          ...calculated.unresolved[0],
          categoryId: "__UNKNOWN__",
          categoryName,
        })),
        {
          ...calculated.unresolved[0],
          categoryId: "custom",
          categoryName: "Unclassified exposure",
        },
      ],
    };
    const before = JSON.stringify([localizedResult, localizedCalculated]);
    const exportRows = (localize = true) =>
      worksheetExportRows(
        {
          result: localizedResult,
          calculated: localizedCalculated,
          accountNames: new Map(),
          accountIds: [],
          trackedCashToUse: 0,
          externalCash: 0,
          depositsByAccount: {},
          editedAssetIds: undefined,
          describeWarning: (warning) => warning.message,
          categoryLabel: localize
            ? (id, name) => worksheetCategoryLabel(i18n.t, "asset_classes", id, name)
            : undefined,
        },
        labels,
      );
    const rows = exportRows();
    const text = toTsv(rows);
    expect(text).toContain(`${zhCommonTaxonomies.categoryNames.asset_classes.EQUITY} 60%`);
    expect(text).toContain("My bonds 40%");
    expect(
      rows.filter((row) => row[8] === zhCommonTaxonomies.categoryNames.asset_classes.EQUITY),
    ).toHaveLength(2);
    expect(text).toContain(zhCommonTaxonomies.unknown);
    expect(text).toContain(zhAllocation.worksheet.unclassified);
    expect(text).toContain(zhAllocation.worksheet.unclassifiedExposure);
    expect(text).toContain("Unclassified exposure"); // Same-name custom category stays verbatim.
    const csv = toCsv(exportRows(false));
    expect(csv).toContain("Unknown");
    expect(csv).toContain("Unclassified exposure");
    expect(csv).not.toContain(zhAllocation.worksheet.unclassifiedExposure);
    expect(csv).toContain("Equity 60%");
    expect(csv).toContain("My bonds 40%");
    expect(csv).not.toContain(zhCommonTaxonomies.categoryNames.asset_classes.EQUITY);
    await i18n.changeLanguage("en");
    const englishText = toTsv(exportRows());
    expect(englishText).toContain("Unknown");
    expect(englishText).toContain("Unclassified exposure");
    expect(englishText).not.toContain(zhAllocation.worksheet.unclassifiedExposure);
    expect(englishText).toContain("Equity 60%");
    expect(englishText).toContain("My bonds 40%");
    expect(englishText).not.toContain(zhCommonTaxonomies.categoryNames.asset_classes.EQUITY);
    expect(JSON.stringify([localizedResult, localizedCalculated])).toBe(before);
  });

  it("rejects an indicative preview until its changes are placed in accounts", () => {
    expect(() =>
      worksheetExportRows(
        {
          result: { ...result, lines: [{ ...result.lines[0], accountId: null }] },
          calculated: null,
          accountNames: new Map(),
          accountIds: [],
          trackedCashToUse: 0,
          externalCash: 0,
          depositsByAccount: {},
          editedAssetIds: undefined,
          describeWarning: (warning) => warning.message,
        },
        labels,
      ),
    ).toThrow("Place every adjustment in an account before exporting");
  });

  it("opens on the lines, grouped by account then symbol, with the reductions negative", () => {
    const lines = csvLines();

    expect(lines.slice(0, 4)).toEqual([
      `"Account","Symbol","Security","Status","Direction","Amount (USD)","Estimated quantity","Unit price (USD)","Category","Price date","Note"`,
      `"Brokerage","AAPL","Apple","Calculated","Increase","200.00","1","200","US equity","2026-09-20",""`,
      // A mixed fund carries both its classes; the stored price loses its float residue.
      `"Brokerage","VBIAX","Balanced Index","Calculated","Increase","1200.00","12","100","US equity 60% · Bonds 40%","2026-09-20",""`,
      // A name a spreadsheet would run stays text.
      `"Retirement","BND","'=HYPERLINK(evil)","Edited","Reduce","-300.00","-4","75","Bonds","2026-09-20","BND quote is dated."`,
    ]);
  });

  it("keeps unresolved amounts in the table, with no account or security", () => {
    expect(csvLines()[4]).toBe(`"","","","Unresolved","","50.00","","","Gold","",""`);
  });

  it("totals each account apart from the lines, with its deposit and the cash it has left", () => {
    const lines = csvLines();
    const header = lines.indexOf(`"Account","Deposit (USD)","Total (USD)","Cash remaining (USD)"`);

    expect(header).toBe(6);
    expect(lines.slice(header + 1, header + 3)).toEqual([
      `"Brokerage","0.00","1400.00","-100.00"`,
      `"Retirement","300.50","-300.00","300.00"`,
    ]);
  });

  it("rounds estimated quantities as the screens show them", () => {
    const rows = worksheetExportRows(
      {
        result: {
          ...result,
          lines: [
            line({ lineId: "a", symbol: "BND", quantity: 25.944175, estimatedAmount: 1821.8 }),
            line({ lineId: "b", symbol: "BTC", quantity: 0.000193, estimatedAmount: 16 }),
          ],
          warnings: [],
        } as unknown as AllocationWorksheetResult,
        calculated: null,
        accountNames: new Map([["acc-1", "Brokerage"]]),
        accountIds: ["acc-1"],
        trackedCashToUse: 0,
        externalCash: 0,
        depositsByAccount: {},
        editedAssetIds: undefined,
        describeWarning: (warning) => warning.message,
      },
      labels,
    );

    expect(rows.slice(1, 3).map((row) => row[6])).toEqual([25.94, 0.000193]);
    // Without a calculation there is nothing to call a line calculated or edited.
    expect(rows[1][3]).toBe("");
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
      "Wealthfolio calculates adjustments from your target and the securities you marked as eligible, split in proportion to what you already hold.";
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

  it("drops the bidi marks right-to-left text carries, and still guards a formula behind one", () => {
    // How an Arabic interpolation isolates a value: FSI before, PDI after.
    const table = [["⁨Brokerage⁩", "⁨=SUM(A1)⁩"]];
    expect(toCsv(table)).toBe(`"Brokerage","'=SUM(A1)"`);
    expect(toTsv(table)).toBe("Brokerage\t'=SUM(A1)");
  });
});
