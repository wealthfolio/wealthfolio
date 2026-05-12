import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";

const addonRoot = new URL(".", import.meta.url);
const engineUrl = new URL("src/lib/cgt-engine.ts", addonRoot);
const taxDataUrl = new URL("src/lib/tax-data.ts", addonRoot);
const tempDir = await mkdtemp(path.join(tmpdir(), "australia-cgt-addon-"));
const compiledEnginePath = path.join(tempDir, "cgt-engine.mjs");
const compiledTaxDataPath = path.join(tempDir, "tax-data.mjs");

async function importEngine() {
  const { readFile } = await import("node:fs/promises");
  const taxDataSource = await readFile(taxDataUrl, "utf8");
  const compiledTaxData = ts.transpileModule(taxDataSource, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  });
  await writeFile(compiledTaxDataPath, compiledTaxData.outputText, "utf8");

  const source = (await readFile(engineUrl, "utf8")).replace(
    'from "./tax-data"',
    'from "./tax-data.mjs"',
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  });
  await writeFile(compiledEnginePath, compiled.outputText, "utf8");
  return import(`file://${compiledEnginePath}`);
}

const {
  buildHoldingParcels,
  buildCgtReport,
  calculateCurrentLawTaxableGain,
  calculateIndexedGain,
  calculateMinimumTaxTopUp,
  calculateTransitionGain,
  extractDividendTaxDetails,
  exportReportCsv,
} = await importEngine();
const {
  DEFAULT_ABS_QUARTERLY_CPI_URL,
  FRANKING_PERCENTAGE_METADATA_KEY,
  buildAmitAdjustmentsFromAmma,
  calculateCpiIndexationFactor,
  createAustraliaCgtAddonStore,
  createMemoryStorage,
  emptyAustraliaCgtAddonData,
  fetchAbsCpiSeries,
  mergeCpiSeries,
  parseAbsCpiCsv,
  refreshCachedAbsCpiSeries,
  withFrankingPercentageMetadata,
} = await import(`file://${compiledTaxDataPath}`);

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

test("current law halves an eligible long-held gain after losses", () => {
  const result = calculateCurrentLawTaxableGain({
    grossGain: 60,
    capitalLosses: 0,
    acquisitionDate: "2024-07-01",
    disposalDate: "2026-07-02",
    eligibleForDiscount: true,
  });

  assert.equal(result.taxableGain, 30);
  assert.equal(result.discountApplied, 30);
});

test("current law does not discount a short-held gain", () => {
  const result = calculateCurrentLawTaxableGain({
    grossGain: 60,
    capitalLosses: 0,
    acquisitionDate: "2026-01-01",
    disposalDate: "2026-06-30",
    eligibleForDiscount: true,
  });

  assert.equal(result.taxableGain, 60);
  assert.equal(result.discountApplied, 0);
});

test("current law applies capital losses before the discount", () => {
  const result = calculateCurrentLawTaxableGain({
    grossGain: 100,
    capitalLosses: 40,
    acquisitionDate: "2024-07-01",
    disposalDate: "2026-07-02",
    eligibleForDiscount: true,
  });

  assert.equal(result.netGainBeforeDiscount, 60);
  assert.equal(result.taxableGain, 30);
});

test("current law uses calendar months for the twelve-month discount", () => {
  const result = calculateCurrentLawTaxableGain({
    grossGain: 60,
    capitalLosses: 0,
    acquisitionDate: "2024-02-29",
    disposalDate: "2025-02-28",
    eligibleForDiscount: true,
  });

  assert.equal(result.discountEligible, false);
  assert.equal(result.taxableGain, 60);
});

test("current law excludes exact-anniversary disposals from the twelve-month discount", () => {
  const exactAnniversary = calculateCurrentLawTaxableGain({
    grossGain: 60,
    capitalLosses: 0,
    acquisitionDate: "2024-07-01",
    disposalDate: "2025-07-01",
    eligibleForDiscount: true,
  });
  const nextDay = calculateCurrentLawTaxableGain({
    grossGain: 60,
    capitalLosses: 0,
    acquisitionDate: "2024-07-01",
    disposalDate: "2025-07-02",
    eligibleForDiscount: true,
  });

  assert.equal(exactAnniversary.discountEligible, false);
  assert.equal(exactAnniversary.taxableGain, 60);
  assert.equal(nextDay.discountEligible, true);
  assert.equal(nextDay.taxableGain, 30);
});

test("indexation taxes the real gain after CPI uplift", () => {
  const result = calculateIndexedGain({
    costBase: 100,
    proceeds: 125,
    indexationFactor: 1.13,
  });

  assert.equal(result.indexedCostBase, 113);
  assert.equal(result.realCapitalGain, 12);
});

test("transition assets split pre-2027 discount and post-2027 indexation components", () => {
  const result = calculateTransitionGain({
    originalCostBase: 800000,
    transitionValueAt2027: 1131371,
    proceeds: 1600000,
    acquisitionDate: "2022-07-01",
    disposalDate: "2032-07-01",
    post2027IndexationFactor: 1.131407822898059,
  });

  assert.equal(result.preCommencement.taxableGain, 165685.5);
  assert.equal(Math.round(result.postCommencement.realCapitalGain), 319958);
  assert.equal(Math.round(result.totalTaxableGain), 485644);
});

test("minimum tax tops low-rate capital gain tax up to 30 percent unless exempt", () => {
  const result = calculateMinimumTaxTopUp({
    realCapitalGain: 10000,
    taxOnGainBeforeTopUp: 1400,
    receivesIncomeSupport: false,
  });

  assert.equal(result.minimumTaxRequired, 3000);
  assert.equal(result.topUpTax, 1600);

  const exempt = calculateMinimumTaxTopUp({
    realCapitalGain: 10000,
    taxOnGainBeforeTopUp: 1400,
    receivesIncomeSupport: true,
  });

  assert.equal(exempt.topUpTax, 0);
});

test("report matches FIFO lots, includes fees, groups by Australian income year, and exports CSV", () => {
  const activities = [
    {
      id: "buy-1",
      activityType: "BUY",
      date: new Date("2024-07-01T10:00:00Z"),
      quantity: "10",
      unitPrice: "100",
      fee: "10",
      amount: "1000",
      currency: "AUD",
      assetSymbol: "VAS.AX",
      assetName: "Vanguard Australian Shares",
      accountName: "Australian Taxable",
    },
    {
      id: "buy-2",
      activityType: "BUY",
      date: new Date("2026-03-01T10:00:00Z"),
      quantity: "10",
      unitPrice: "120",
      fee: "10",
      amount: "1200",
      currency: "AUD",
      assetSymbol: "VAS.AX",
      assetName: "Vanguard Australian Shares",
      accountName: "Australian Taxable",
    },
    {
      id: "sell-1",
      activityType: "SELL",
      date: new Date("2026-08-01T10:00:00Z"),
      quantity: "12",
      unitPrice: "150",
      fee: "12",
      amount: "1800",
      currency: "AUD",
      assetSymbol: "VAS.AX",
      assetName: "Vanguard Australian Shares",
      accountName: "Australian Taxable",
    },
  ];

  const report = buildCgtReport(activities);

  assert.equal(report.closedLots.length, 2);
  assert.equal(report.closedLots[0].quantity, 10);
  assert.equal(report.closedLots[0].taxableGain, 240);
  assert.equal(report.closedLots[1].quantity, 2);
  assert.equal(report.closedLots[1].taxableGain, 56);
  assert.equal(report.incomeYears[0].incomeYear, "2026-27");
  assert.equal(report.incomeYears[0].taxableGain, 296);

  const csv = exportReportCsv(report);
  assert.match(csv, /incomeYear,symbol,account,quantity,acquisitionDate,disposalDate/);
  assert.match(csv, /"2026-27","VAS\.AX","Australian Taxable","10"/);
});

test("AMMA statements persist locally and derive AMIT cost base adjustments", () => {
  const storage = createMemoryStorage();
  const store = createAustraliaCgtAddonStore(storage, "test-addon");
  const ammaStatements = [
    {
      id: "VAS.AX:2026-27",
      holdingKey: "buy-1",
      incomeYear: "2026-27",
      taxableIncome: 300,
      cashDistribution: 280,
      frankingCredits: 20,
      amitCostBaseIncrease: 45,
      amitCostBaseDecrease: 15,
    },
  ];
  const data = {
    ammaStatements,
    cpiSeries: [],
    transitionSnapshots: [],
    amitAdjustments: buildAmitAdjustmentsFromAmma(ammaStatements),
    acquisitionOverrides: [],
  };

  store.save(data);

  assert.deepEqual(store.load().amitAdjustments, [
    {
      parcelId: "buy-1",
      incomeYear: "2026-27",
      amount: 30,
      sourceStatementId: "VAS.AX:2026-27",
    },
  ]);
});

test("tax data store writes a versioned envelope and reads legacy payloads", () => {
  const legacyKey = "test-addon:tax-data:v1";
  const legacyData = {
    ammaStatements: [
      {
        id: "legacy:2026-27",
        holdingKey: "legacy",
        parcelId: "legacy",
        incomeYear: "2026-27",
        taxableIncome: 12,
        cashDistribution: 10,
        frankingCredits: 2,
        amitCostBaseIncrease: 3,
        amitCostBaseDecrease: 1,
      },
    ],
  };
  const storage = createMemoryStorage({
    [legacyKey]: JSON.stringify(legacyData),
  });
  const store = createAustraliaCgtAddonStore(storage, "test-addon");

  assert.equal(store.load().ammaStatements[0].taxableIncome, 12);

  const nextData = emptyAustraliaCgtAddonData();
  store.save(nextData);
  assert.deepEqual(JSON.parse(storage.getItem(legacyKey)), {
    version: 1,
    payload: nextData,
  });
});

test("AMMA statements map explicit parcel IDs into AMIT adjustments", () => {
  const adjustments = buildAmitAdjustmentsFromAmma([
    {
      id: "VAS.AX:Australian Taxable:2026-27",
      holdingKey: "VAS.AX:Australian Taxable",
      parcelId: "buy-1",
      incomeYear: "2026-27",
      taxableIncome: 0,
      cashDistribution: 0,
      frankingCredits: 0,
      amitCostBaseIncrease: 45,
      amitCostBaseDecrease: 15,
    },
  ]);

  assert.deepEqual(adjustments, [
    {
      parcelId: "buy-1",
      incomeYear: "2026-27",
      amount: 30,
      sourceStatementId: "VAS.AX:Australian Taxable:2026-27",
    },
  ]);
});

test("AMMA-derived AMIT adjustments change disposal cost base and taxable gain", () => {
  const ammaStatements = [
    {
      id: "buy-1:2025-26",
      holdingKey: "VAS.AX:Australian Taxable",
      parcelId: "buy-1",
      incomeYear: "2025-26",
      taxableIncome: 300,
      cashDistribution: 280,
      frankingCredits: 20,
      amitCostBaseIncrease: 30,
      amitCostBaseDecrease: 0,
    },
  ];
  const report = buildCgtReport(
    [
      {
        id: "buy-1",
        activityType: "BUY",
        date: "2024-07-01",
        quantity: "10",
        unitPrice: "100",
        fee: "0",
        amount: "1000",
        currency: "AUD",
        assetSymbol: "VAS.AX",
        accountName: "Australian Taxable",
      },
      {
        id: "sell-1",
        activityType: "SELL",
        date: "2026-05-01",
        quantity: "10",
        unitPrice: "150",
        fee: "0",
        amount: "1500",
        currency: "AUD",
        assetSymbol: "VAS.AX",
        accountName: "Australian Taxable",
      },
    ],
    {
      amitAdjustments: buildAmitAdjustmentsFromAmma(ammaStatements),
    },
  );

  assert.equal(report.closedLots[0].amitCostBaseAdjustment, 30);
  assert.equal(report.closedLots[0].costBase, 1030);
  assert.equal(report.closedLots[0].taxableGain, 235);
});

test("ABS CPI series parses, merges, caches, and produces indexation factor", async () => {
  const parsed = parseAbsCpiCsv("quarter,value\n2027-Q3,120\n2032-Q3,135.6\n", "now");
  assert.equal(parsed.length, 2);
  assert.equal(calculateCpiIndexationFactor(parsed, "2027-Q3", "2032-Q3"), 1.13);
  assert.match(DEFAULT_ABS_QUARTERLY_CPI_URL, /ABS,CPI_Q/);

  const merged = mergeCpiSeries(parsed.slice(0, 1), [
    { quarter: "2032-Q3", value: 136, source: "MANUAL", fetchedAt: "later" },
  ]);
  assert.equal(merged[1].value, 136);

  const fetched = await fetchAbsCpiSeries(
    "https://example.test/cpi.csv",
    async () =>
      new Response("TIME_PERIOD,INDEX,OBS_VALUE\n2027-Q3,999901,120\n", {
        status: 200,
      }),
    () => "fetched",
  );
  assert.deepEqual(fetched, [
    { quarter: "2027-Q3", value: 120, source: "ABS", fetchedAt: "fetched" },
  ]);

  const refreshed = await refreshCachedAbsCpiSeries(
    {
      ammaStatements: [],
      cpiSeries: parsed.slice(0, 1),
      transitionSnapshots: [],
      amitAdjustments: [],
      acquisitionOverrides: [],
    },
    async () =>
      new Response("TIME_PERIOD,OBS_VALUE\n2032-Q3,135.6\n", {
        status: 200,
      }),
  );
  assert.equal(refreshed.cpiSeries.length, 2);
});

test("AMIT adjustments alter parcel-level cost base before gain calculation", () => {
  const report = buildCgtReport(
    [
      {
        id: "buy-1",
        activityType: "BUY",
        date: "2024-07-01",
        quantity: "10",
        unitPrice: "100",
        fee: "0",
        amount: "1000",
        currency: "AUD",
        assetSymbol: "VAS.AX",
        accountName: "Australian Taxable",
      },
      {
        id: "sell-1",
        activityType: "SELL",
        date: "2026-08-01",
        quantity: "10",
        unitPrice: "150",
        fee: "0",
        amount: "1500",
        currency: "AUD",
        assetSymbol: "VAS.AX",
        accountName: "Australian Taxable",
      },
    ],
    {
      amitAdjustments: [{ parcelId: "buy-1", incomeYear: "2025-26", amount: 30 }],
    },
  );

  assert.equal(report.closedLots[0].costBase, 1030);
  assert.equal(report.closedLots[0].amitCostBaseAdjustment, 30);
  assert.equal(report.closedLots[0].taxableGain, 235);
  assert.equal(report.incomeYears[0].amitCostBaseAdjustment, 30);
});

test("AMIT adjustments after disposal year do not alter past disposals", () => {
  const report = buildCgtReport(
    [
      {
        id: "buy-1",
        activityType: "BUY",
        date: "2024-07-01",
        quantity: "10",
        unitPrice: "100",
        fee: "0",
        amount: "1000",
        currency: "AUD",
        assetSymbol: "VAS.AX",
        accountName: "Australian Taxable",
      },
      {
        id: "sell-1",
        activityType: "SELL",
        date: "2026-08-01",
        quantity: "10",
        unitPrice: "150",
        fee: "0",
        amount: "1500",
        currency: "AUD",
        assetSymbol: "VAS.AX",
        accountName: "Australian Taxable",
      },
    ],
    {
      amitAdjustments: [{ parcelId: "buy-1", incomeYear: "2027-28", amount: 30 }],
    },
  );

  assert.equal(report.closedLots[0].costBase, 1000);
  assert.equal(report.closedLots[0].amitCostBaseAdjustment, 0);
  assert.equal(report.closedLots[0].taxableGain, 250);
});

test("AMIT adjustments after a partial disposal apply to the surviving holding quantity", () => {
  const report = buildCgtReport(
    [
      {
        id: "buy-1",
        activityType: "BUY",
        date: "2024-07-01",
        quantity: "100",
        unitPrice: "10",
        fee: "0",
        amount: "1000",
        currency: "AUD",
        assetSymbol: "VAS.AX",
        accountName: "Australian Taxable",
      },
      {
        id: "sell-1",
        activityType: "SELL",
        date: "2026-05-01",
        quantity: "50",
        unitPrice: "15",
        fee: "0",
        amount: "750",
        currency: "AUD",
        assetSymbol: "VAS.AX",
        accountName: "Australian Taxable",
      },
      {
        id: "sell-2",
        activityType: "SELL",
        date: "2027-08-01",
        quantity: "50",
        unitPrice: "16",
        fee: "0",
        amount: "800",
        currency: "AUD",
        assetSymbol: "VAS.AX",
        accountName: "Australian Taxable",
      },
    ],
    {
      amitAdjustments: [{ parcelId: "buy-1", incomeYear: "2026-27", amount: 100 }],
    },
  );

  assert.equal(report.closedLots[0].amitCostBaseAdjustment, 0);
  assert.equal(report.closedLots[1].amitCostBaseAdjustment, 100);
  assert.equal(report.closedLots[1].costBase, 600);
  assert.equal(report.closedLots[1].taxableGain, 100);
});

test("transition snapshots produce parcel-level 2027 transition rows", () => {
  const report = buildCgtReport(
    [
      {
        id: "buy-1",
        activityType: "BUY",
        date: "2024-07-01",
        quantity: "10",
        unitPrice: "100",
        fee: "0",
        amount: "1000",
        currency: "AUD",
        assetSymbol: "VAS.AX",
        accountName: "Australian Taxable",
      },
    ],
    {
      transitionSnapshots: [
        {
          parcelId: "buy-1",
          symbol: "VAS.AX",
          account: "Australian Taxable",
          acquisitionDate: "2024-07-01",
          quantity: 10,
          marketValueAt2027: 1600,
          valuationMethod: "manual",
        },
      ],
    },
  );

  assert.equal(report.transitionLots.length, 1);
  assert.equal(report.transitionLots[0].marketValueAt2027, 1600);
  assert.equal(report.transitionLots[0].preCommencementTaxableGain, 300);
});

test("transition snapshots include aggregated open holding parcels", () => {
  const holdingParcels = buildHoldingParcels(
    [
      {
        id: "aggregated-VAS",
        quantity: 10,
        openDate: null,
        lots: null,
        accountName: "Australian Taxable",
        instrument: { symbol: "VAS.AX" },
        costBasis: { local: 1000, base: 1000 },
      },
    ],
    [
      {
        parcelId: "aggregated-VAS",
        symbol: "VAS.AX",
        account: "Australian Taxable",
        acquisitionDate: "2024-07-01",
        source: "manual",
      },
    ],
  );
  const report = buildCgtReport([], {
    holdingParcels,
    transitionSnapshots: [
      {
        parcelId: "aggregated-VAS",
        symbol: "VAS.AX",
        account: "Australian Taxable",
        acquisitionDate: "2024-07-01",
        quantity: 10,
        marketValueAt2027: 1600,
        valuationMethod: "manual",
      },
    ],
  });

  assert.equal(report.transitionLots.length, 1);
  assert.equal(report.transitionLots[0].parcelId, "aggregated-VAS");
  assert.equal(report.transitionLots[0].costBase, 1000);
  assert.equal(report.transitionLots[0].preCommencementTaxableGain, 300);
});

test("transition snapshots exclude post-transition AMIT adjustments", () => {
  const report = buildCgtReport(
    [
      {
        id: "buy-1",
        activityType: "BUY",
        date: "2024-07-01",
        quantity: "10",
        unitPrice: "100",
        fee: "0",
        amount: "1000",
        currency: "AUD",
        assetSymbol: "VAS.AX",
        accountName: "Australian Taxable",
      },
    ],
    {
      amitAdjustments: [
        {
          parcelId: "buy-1",
          incomeYear: "2027-28",
          amount: 200,
        },
      ],
      transitionSnapshots: [
        {
          parcelId: "buy-1",
          symbol: "VAS.AX",
          account: "Australian Taxable",
          acquisitionDate: "2024-07-01",
          quantity: 10,
          marketValueAt2027: 1600,
          valuationMethod: "manual",
        },
      ],
    },
  );

  assert.equal(report.transitionLots.length, 1);
  assert.equal(report.transitionLots[0].costBase, 1000);
  assert.equal(report.transitionLots[0].preCommencementTaxableGain, 300);
});

test("franking percentage is read from dividend activity metadata", () => {
  const metadata = withFrankingPercentageMetadata(undefined, 70);
  assert.equal(metadata[FRANKING_PERCENTAGE_METADATA_KEY], 70);

  const dividends = extractDividendTaxDetails([
    {
      id: "dividend-1",
      activityType: "DIVIDEND",
      date: "2026-09-01",
      quantity: null,
      unitPrice: null,
      amount: "100",
      fee: null,
      currency: "AUD",
      assetSymbol: "VAS.AX",
      accountName: "Australian Taxable",
      metadata,
    },
  ]);

  assert.equal(dividends[0].frankingPercentage, 70);
  assert.equal(dividends[0].frankedAmount, 70);
});

test("franking metadata displays fully and partly franked dividend examples", () => {
  const dividends = extractDividendTaxDetails([
    {
      id: "cba-dividend",
      activityType: "DIVIDEND",
      date: "2026-09-01",
      quantity: null,
      unitPrice: null,
      amount: "700",
      fee: null,
      currency: "AUD",
      assetSymbol: "CBA.AX",
      accountName: "Australian Taxable",
      metadata: withFrankingPercentageMetadata(undefined, 100),
    },
    {
      id: "wes-dividend",
      activityType: "DIVIDEND",
      date: "2026-10-01",
      quantity: null,
      unitPrice: null,
      amount: "500",
      fee: null,
      currency: "AUD",
      assetSymbol: "WES.AX",
      accountName: "Australian Taxable",
      metadata: withFrankingPercentageMetadata(undefined, 60),
    },
  ]);

  assert.equal(dividends[0].symbol, "CBA.AX");
  assert.equal(dividends[0].frankingPercentage, 100);
  assert.equal(dividends[0].frankedAmount, 700);
  assert.equal(dividends[1].symbol, "WES.AX");
  assert.equal(dividends[1].frankingPercentage, 60);
  assert.equal(dividends[1].frankedAmount, 300);
});

test("parcel acquisition overrides cover aggregated holdings without lots", () => {
  const parcels = buildHoldingParcels(
    [
      {
        id: "aggregated-VAS",
        quantity: 25,
        openDate: null,
        lots: null,
        accountName: "Australian Taxable",
        instrument: { symbol: "VAS.AX" },
        costBasis: { local: 2500, base: 2500 },
      },
    ],
    [
      {
        parcelId: "aggregated-VAS",
        symbol: "VAS.AX",
        account: "Australian Taxable",
        acquisitionDate: "2021-07-01",
        source: "manual",
      },
    ],
  );

  assert.equal(parcels[0].acquisitionDate, "2021-07-01");
  assert.equal(parcels[0].costBase, 2500);
});

test("report accepts API timestamp date strings", () => {
  const report = buildCgtReport([
    {
      id: "buy-api",
      activityType: "BUY",
      date: "2024-07-01T10:00:00.000Z",
      quantity: "1",
      unitPrice: "100",
      fee: "0",
      amount: "100",
      currency: "AUD",
      assetSymbol: "API.AX",
      accountName: "Australian Taxable",
    },
    {
      id: "sell-api",
      activityType: "SELL",
      date: "2026-05-01T10:00:00.000Z",
      quantity: "1",
      unitPrice: "160",
      fee: "0",
      amount: "160",
      currency: "AUD",
      assetSymbol: "API.AX",
      accountName: "Australian Taxable",
    },
  ]);

  assert.equal(report.incomeYears[0].incomeYear, "2025-26");
  assert.equal(report.closedLots[0].acquisitionDate, "2024-07-01");
  assert.equal(report.closedLots[0].disposalDate, "2026-05-01");
  assert.equal(report.closedLots[0].taxableGain, 30);
});

test("report matches FIFO lots within the selling account only", () => {
  const report = buildCgtReport([
    {
      id: "taxable-buy",
      activityType: "BUY",
      date: "2024-07-01",
      quantity: "1",
      unitPrice: "100",
      fee: "0",
      amount: "100",
      currency: "AUD",
      assetSymbol: "VAS.AX",
      accountName: "Australian Taxable",
    },
    {
      id: "super-buy",
      activityType: "BUY",
      date: "2024-07-02",
      quantity: "1",
      unitPrice: "200",
      fee: "0",
      amount: "200",
      currency: "AUD",
      assetSymbol: "VAS.AX",
      accountName: "Super",
    },
    {
      id: "super-sell",
      activityType: "SELL",
      date: "2026-05-01",
      quantity: "1",
      unitPrice: "260",
      fee: "0",
      amount: "260",
      currency: "AUD",
      assetSymbol: "VAS.AX",
      accountName: "Super",
    },
  ]);

  assert.equal(report.closedLots.length, 1);
  assert.equal(report.closedLots[0].parcelId, "super-buy");
  assert.equal(report.closedLots[0].account, "Super");
  assert.equal(report.closedLots[0].costBase, 200);
  assert.equal(report.closedLots[0].taxableGain, 30);
  assert.equal(report.transitionLots.length, 0);
});

test("acquisition overrides do not rename imported BUY activity lots", () => {
  const report = buildCgtReport(
    [
      {
        id: "buy-1",
        activityType: "BUY",
        date: "2024-07-01",
        quantity: "1",
        unitPrice: "100",
        fee: "0",
        amount: "100",
        currency: "AUD",
        assetSymbol: "VAS.AX",
        accountName: "Australian Taxable",
      },
      {
        id: "sell-1",
        activityType: "SELL",
        date: "2026-08-01",
        quantity: "1",
        unitPrice: "160",
        fee: "0",
        amount: "160",
        currency: "AUD",
        assetSymbol: "VAS.AX",
        accountName: "Australian Taxable",
      },
    ],
    {
      acquisitionOverrides: [
        {
          parcelId: "aggregated-VAS",
          symbol: "VAS.AX",
          account: "Australian Taxable",
          acquisitionDate: "2021-07-01",
          source: "manual",
        },
      ],
    },
  );

  assert.equal(report.closedLots[0].parcelId, "buy-1");
  assert.equal(report.closedLots[0].acquisitionDate, "2024-07-01");
});

test("report excludes non-AUD CGT lots and surfaces them for review", () => {
  const report = buildCgtReport([
    {
      id: "usd-buy",
      activityType: "BUY",
      date: "2024-07-01",
      quantity: "1",
      unitPrice: "100",
      fee: "0",
      amount: "100",
      currency: "USD",
      assetSymbol: "AAPL",
      accountName: "Australian Taxable",
      fxRate: "1.5",
    },
    {
      id: "usd-sell",
      activityType: "SELL",
      date: "2026-08-01",
      quantity: "1",
      unitPrice: "160",
      fee: "0",
      amount: "160",
      currency: "USD",
      assetSymbol: "AAPL",
      accountName: "Australian Taxable",
      fxRate: "1.5",
    },
  ]);

  assert.equal(report.closedLots.length, 0);
  assert.equal(report.incomeYears.length, 0);
  assert.equal(report.unsupportedActivities.length, 2);
  assert.equal(report.unsupportedActivities[0].reason, "NON_AUD_CURRENCY");
});

test("report surfaces ignored activity types for review", () => {
  const report = buildCgtReport([
    {
      id: "split-1",
      activityType: "SPLIT",
      date: "2025-01-01",
      quantity: "2",
      unitPrice: null,
      fee: null,
      amount: null,
      currency: "AUD",
      assetSymbol: "VAS.AX",
      accountName: "Australian Taxable",
    },
  ]);

  assert.equal(report.ignoredActivities.length, 1);
  assert.equal(report.ignoredActivities[0].activityType, "SPLIT");
});

test("closed lots are sorted by disposal date, symbol, and account", () => {
  const report = buildCgtReport([
    {
      id: "z-buy",
      activityType: "BUY",
      date: "2024-07-01",
      quantity: "1",
      unitPrice: "100",
      fee: "0",
      amount: "100",
      currency: "AUD",
      assetSymbol: "ZZZ.AX",
      accountName: "Australian Taxable",
    },
    {
      id: "a-buy",
      activityType: "BUY",
      date: "2024-07-01",
      quantity: "1",
      unitPrice: "100",
      fee: "0",
      amount: "100",
      currency: "AUD",
      assetSymbol: "AAA.AX",
      accountName: "Australian Taxable",
    },
    {
      id: "z-sell",
      activityType: "SELL",
      date: "2026-08-02",
      quantity: "1",
      unitPrice: "160",
      fee: "0",
      amount: "160",
      currency: "AUD",
      assetSymbol: "ZZZ.AX",
      accountName: "Australian Taxable",
    },
    {
      id: "a-sell",
      activityType: "SELL",
      date: "2026-08-01",
      quantity: "1",
      unitPrice: "160",
      fee: "0",
      amount: "160",
      currency: "AUD",
      assetSymbol: "AAA.AX",
      accountName: "Australian Taxable",
    },
  ]);

  assert.deepEqual(
    report.closedLots.map((lot) => lot.symbol),
    ["AAA.AX", "ZZZ.AX"],
  );
});

test("income year summary applies capital losses before discount", () => {
  const report = buildCgtReport([
    {
      id: "gain-buy",
      activityType: "BUY",
      date: "2024-07-01",
      quantity: "1",
      unitPrice: "100",
      fee: "0",
      amount: "100",
      currency: "AUD",
      assetSymbol: "GAIN.AX",
      accountName: "Australian Taxable",
    },
    {
      id: "loss-buy",
      activityType: "BUY",
      date: "2024-07-01",
      quantity: "1",
      unitPrice: "100",
      fee: "0",
      amount: "100",
      currency: "AUD",
      assetSymbol: "LOSS.AX",
      accountName: "Australian Taxable",
    },
    {
      id: "gain-sell",
      activityType: "SELL",
      date: "2026-05-01",
      quantity: "1",
      unitPrice: "200",
      fee: "0",
      amount: "200",
      currency: "AUD",
      assetSymbol: "GAIN.AX",
      accountName: "Australian Taxable",
    },
    {
      id: "loss-sell",
      activityType: "SELL",
      date: "2026-05-01",
      quantity: "1",
      unitPrice: "60",
      fee: "0",
      amount: "60",
      currency: "AUD",
      assetSymbol: "LOSS.AX",
      accountName: "Australian Taxable",
    },
  ]);

  assert.equal(report.incomeYears[0].grossGain, 60);
  assert.equal(report.incomeYears[0].capitalLossesApplied, 40);
  assert.equal(report.incomeYears[0].discountApplied, 30);
  assert.equal(report.incomeYears[0].taxableGain, 30);
});

test("income year summary carries unapplied capital losses forward", () => {
  const report = buildCgtReport([
    {
      id: "loss-buy",
      activityType: "BUY",
      date: "2023-07-01",
      quantity: "1",
      unitPrice: "200",
      fee: "0",
      amount: "200",
      currency: "AUD",
      assetSymbol: "AAA.AX",
      accountName: "Australian Taxable",
    },
    {
      id: "loss-sell",
      activityType: "SELL",
      date: "2024-08-01",
      quantity: "1",
      unitPrice: "120",
      fee: "0",
      amount: "120",
      currency: "AUD",
      assetSymbol: "AAA.AX",
      accountName: "Australian Taxable",
    },
    {
      id: "gain-buy",
      activityType: "BUY",
      date: "2024-07-01",
      quantity: "1",
      unitPrice: "100",
      fee: "0",
      amount: "100",
      currency: "AUD",
      assetSymbol: "BBB.AX",
      accountName: "Australian Taxable",
    },
    {
      id: "gain-sell",
      activityType: "SELL",
      date: "2025-08-01",
      quantity: "1",
      unitPrice: "200",
      fee: "0",
      amount: "200",
      currency: "AUD",
      assetSymbol: "BBB.AX",
      accountName: "Australian Taxable",
    },
  ]);

  assert.equal(report.incomeYears[0].incomeYear, "2024-25");
  assert.equal(report.incomeYears[0].capitalLossCarryForward, 80);
  assert.equal(report.incomeYears[0].taxableGain, 0);
  assert.equal(report.incomeYears[1].incomeYear, "2025-26");
  assert.equal(report.incomeYears[1].capitalLossesApplied, 80);
  assert.equal(report.incomeYears[1].capitalLossCarryForward, 0);
  assert.equal(report.incomeYears[1].taxableGain, 10);
});

test("report matches lots by account id when account names duplicate", () => {
  const report = buildCgtReport([
    {
      id: "account-a-buy",
      activityType: "BUY",
      date: "2024-07-01",
      quantity: "1",
      unitPrice: "100",
      fee: "0",
      amount: "100",
      currency: "AUD",
      assetSymbol: "VAS.AX",
      accountName: "Brokerage",
      accountId: "account-a",
    },
    {
      id: "account-b-buy",
      activityType: "BUY",
      date: "2024-07-01",
      quantity: "1",
      unitPrice: "200",
      fee: "0",
      amount: "200",
      currency: "AUD",
      assetSymbol: "VAS.AX",
      accountName: "Brokerage",
      accountId: "account-b",
    },
    {
      id: "account-b-sell",
      activityType: "SELL",
      date: "2026-08-01",
      quantity: "1",
      unitPrice: "260",
      fee: "0",
      amount: "260",
      currency: "AUD",
      assetSymbol: "VAS.AX",
      accountName: "Brokerage",
      accountId: "account-b",
    },
  ]);

  assert.equal(report.closedLots.length, 1);
  assert.equal(report.closedLots[0].parcelId, "account-b-buy");
  assert.equal(report.closedLots[0].costBase, 200);
  assert.equal(report.closedLots[0].taxableGain, 30);
});

test("report surfaces unmatched sell quantities for review", () => {
  const report = buildCgtReport([
    {
      id: "buy-one",
      activityType: "BUY",
      date: "2025-01-01",
      quantity: "1",
      unitPrice: "100",
      fee: "0",
      amount: "100",
      currency: "AUD",
      assetSymbol: "SHORT.AX",
      accountName: "Australian Taxable",
    },
    {
      id: "sell-two",
      activityType: "SELL",
      date: "2026-05-01",
      quantity: "2",
      unitPrice: "150",
      fee: "0",
      amount: "300",
      currency: "AUD",
      assetSymbol: "SHORT.AX",
      accountName: "Australian Taxable",
    },
  ]);

  assert.equal(report.closedLots.length, 1);
  assert.equal(report.unmatchedSells.length, 1);
  assert.equal(report.unmatchedSells[0].symbol, "SHORT.AX");
  assert.equal(report.unmatchedSells[0].quantity, 1);
});

test("CSV export labels per-lot losses as lotCapitalLoss", () => {
  const csv = exportReportCsv({
    closedLots: [
      {
        parcelId: "loss-buy",
        symbol: "LOSS.AX",
        account: "Australian Taxable",
        incomeYear: "2025-26",
        acquisitionDate: "2024-07-01",
        disposalDate: "2026-05-01",
        quantity: 1,
        proceeds: 60,
        costBase: 100,
        amitCostBaseAdjustment: 0,
        grossGain: -40,
        taxableGain: 0,
        discountApplied: 0,
        discountEligible: false,
        method: "FIFO",
      },
    ],
    incomeYears: [],
    unmatchedSells: [],
    dividends: [],
    transitionLots: [],
    unsupportedActivities: [],
    ignoredActivities: [],
  });

  assert.match(csv.split("\n")[0], /lotCapitalLoss/);
  assert.doesNotMatch(csv.split("\n")[0], /capitalLossesApplied/);
});

let failures = 0;

for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`not ok - ${name}`);
    console.error(error);
  }
}

await rm(tempDir, { recursive: true, force: true });

if (failures > 0) {
  process.exitCode = 1;
}
