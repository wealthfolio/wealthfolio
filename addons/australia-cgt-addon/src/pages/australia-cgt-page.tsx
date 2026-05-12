import type { AddonContext } from "@wealthfolio/addon-sdk";
import { Button, Icons, Page, PageContent, PageHeader } from "@wealthfolio/ui";
import { useState } from "react";
import { useAustraliaCgtReport } from "../hooks/use-australia-cgt-report";
import { useAustraliaCgtTaxData } from "../hooks/use-australia-cgt-tax-data";
import { calculateMinimumTaxTopUp } from "../lib/cgt-engine";
import { downloadCsv } from "../lib/export-csv";
import { formatAud } from "../lib/format";
import {
  findOpenParcelContext,
  findParcelContext,
  holdingKeyForParcel,
} from "../lib/parcel-options";
import {
  buildAmitAdjustmentsFromAmma,
  mergeCpiSeries,
  refreshCachedAbsCpiSeries,
} from "../lib/tax-data";

export function AustraliaCgtPage({ ctx }: { ctx: AddonContext }) {
  const [ordinaryIncomeTaxOnGain, setOrdinaryIncomeTaxOnGain] = useState(1400);
  const [minimumTaxExempt, setMinimumTaxExempt] = useState(false);
  const { taxData, saveTaxData, clearTaxData } = useAustraliaCgtTaxData();
  const [ammaParcelId, setAmmaParcelId] = useState("");
  const [ammaIncomeYear, setAmmaIncomeYear] = useState("2026-27");
  const [ammaTaxableIncome, setAmmaTaxableIncome] = useState(0);
  const [ammaCashDistribution, setAmmaCashDistribution] = useState(0);
  const [ammaFrankingCredits, setAmmaFrankingCredits] = useState(0);
  const [ammaIncrease, setAmmaIncrease] = useState(0);
  const [ammaDecrease, setAmmaDecrease] = useState(0);
  const [snapshotParcelId, setSnapshotParcelId] = useState("");
  const [snapshotSymbol, setSnapshotSymbol] = useState("");
  const [snapshotAccount, setSnapshotAccount] = useState("");
  const [snapshotAcquisitionDate, setSnapshotAcquisitionDate] = useState("");
  const [snapshotQuantity, setSnapshotQuantity] = useState(0);
  const [snapshotValue, setSnapshotValue] = useState(0);
  const [overrideParcelId, setOverrideParcelId] = useState("");
  const [overrideSymbol, setOverrideSymbol] = useState("");
  const [overrideAccount, setOverrideAccount] = useState("");
  const [overrideDate, setOverrideDate] = useState("2024-07-01");
  const [cpiRefreshError, setCpiRefreshError] = useState<string | null>(null);

  const {
    activitiesQuery,
    holdingsQuery,
    report,
    holdingParcels,
    allParcelOptions,
    openParcelOptions,
  } = useAustraliaCgtReport(ctx, taxData);
  const canSaveAmma = ammaParcelId.trim().length > 0 && (ammaIncrease !== 0 || ammaDecrease !== 0);
  const canSaveSnapshot =
    snapshotParcelId.trim().length > 0 &&
    (snapshotSymbol.trim().length > 0 ||
      Boolean(findOpenParcelContext(snapshotParcelId.trim(), holdingParcels)?.symbol)) &&
    (snapshotAccount.trim().length > 0 ||
      Boolean(findOpenParcelContext(snapshotParcelId.trim(), holdingParcels)?.account)) &&
    (snapshotAcquisitionDate.length > 0 ||
      Boolean(findOpenParcelContext(snapshotParcelId.trim(), holdingParcels)?.acquisitionDate)) &&
    (snapshotQuantity > 0 ||
      (findOpenParcelContext(snapshotParcelId.trim(), holdingParcels)?.quantity ?? 0) > 0) &&
    snapshotValue > 0;
  const canSaveOverride =
    overrideParcelId.trim().length > 0 &&
    (overrideSymbol.trim().length > 0 ||
      Boolean(findOpenParcelContext(overrideParcelId.trim(), holdingParcels)?.symbol)) &&
    (overrideAccount.trim().length > 0 ||
      Boolean(findOpenParcelContext(overrideParcelId.trim(), holdingParcels)?.account)) &&
    overrideDate.length > 0;

  const fillSnapshotParcel = (parcelId: string) => {
    setSnapshotParcelId(parcelId);
    const parcel = findOpenParcelContext(parcelId.trim(), holdingParcels);
    if (!parcel) {
      setSnapshotSymbol("");
      setSnapshotAccount("");
      setSnapshotAcquisitionDate("");
      setSnapshotQuantity(0);
      return;
    }
    setSnapshotSymbol(parcel.symbol);
    setSnapshotAccount(parcel.account);
    setSnapshotAcquisitionDate(parcel.acquisitionDate);
    setSnapshotQuantity(parcel.quantity);
  };

  const fillOverrideParcel = (parcelId: string) => {
    setOverrideParcelId(parcelId);
    const parcel = findOpenParcelContext(parcelId.trim(), holdingParcels);
    if (!parcel) {
      setOverrideSymbol("");
      setOverrideAccount("");
      return;
    }
    setOverrideSymbol(parcel.symbol);
    setOverrideAccount(parcel.account);
    setOverrideDate(parcel.acquisitionDate);
  };

  const saveAmmaStatement = () => {
    const parcelId = ammaParcelId.trim();
    if (!parcelId) return;
    const parcel = findParcelContext(parcelId, holdingParcels, report);
    const holdingKey = holdingKeyForParcel(parcel) || parcelId;
    const statement = {
      id: `${parcelId}:${ammaIncomeYear}`,
      holdingKey,
      parcelId,
      incomeYear: ammaIncomeYear,
      taxableIncome: ammaTaxableIncome,
      cashDistribution: ammaCashDistribution,
      frankingCredits: ammaFrankingCredits,
      amitCostBaseIncrease: ammaIncrease,
      amitCostBaseDecrease: ammaDecrease,
    };
    const ammaStatements = [
      ...taxData.ammaStatements.filter((candidate) => candidate.id !== statement.id),
      statement,
    ];
    saveTaxData({
      ...taxData,
      ammaStatements,
      amitAdjustments: buildAmitAdjustmentsFromAmma(ammaStatements),
    });
  };

  const deleteAmmaStatement = (statementId: string) => {
    const ammaStatements = taxData.ammaStatements.filter(
      (statement) => statement.id !== statementId,
    );
    saveTaxData({
      ...taxData,
      ammaStatements,
      amitAdjustments: buildAmitAdjustmentsFromAmma(ammaStatements),
    });
  };

  const deleteCpiObservation = (quarter: string) => {
    saveTaxData({
      ...taxData,
      cpiSeries: taxData.cpiSeries.filter((observation) => observation.quarter !== quarter),
    });
  };

  const saveCpiSample = () => {
    saveTaxData({
      ...taxData,
      cpiSeries: mergeCpiSeries(taxData.cpiSeries, [
        {
          quarter: "2027-Q3",
          value: 120,
          source: "MANUAL",
          fetchedAt: new Date().toISOString(),
        },
      ]),
    });
  };

  const refreshAbsCpi = async () => {
    setCpiRefreshError(null);
    try {
      saveTaxData(await refreshCachedAbsCpiSeries(taxData));
    } catch (error) {
      setCpiRefreshError(error instanceof Error ? error.message : "ABS CPI refresh failed");
    }
  };

  const saveTransitionSnapshot = () => {
    const parcelId = snapshotParcelId.trim();
    if (!parcelId) return;
    const parcel = findOpenParcelContext(parcelId, holdingParcels);
    const snapshot = {
      parcelId,
      symbol: snapshotSymbol.trim() || parcel?.symbol || "",
      account: snapshotAccount.trim() || parcel?.account || "",
      acquisitionDate: snapshotAcquisitionDate || parcel?.acquisitionDate || "",
      quantity: snapshotQuantity || parcel?.quantity || 0,
      marketValueAt2027: snapshotValue,
      valuationMethod: "manual" as const,
    };
    saveTaxData({
      ...taxData,
      transitionSnapshots: [
        ...taxData.transitionSnapshots.filter(
          (candidate) => candidate.parcelId !== snapshot.parcelId,
        ),
        snapshot,
      ],
    });
  };

  const deleteTransitionSnapshot = (parcelId: string) => {
    saveTaxData({
      ...taxData,
      transitionSnapshots: taxData.transitionSnapshots.filter(
        (snapshot) => snapshot.parcelId !== parcelId,
      ),
    });
  };

  const saveAcquisitionOverride = () => {
    const parcelId = overrideParcelId.trim();
    if (!parcelId) return;
    const parcel = findOpenParcelContext(parcelId, holdingParcels);
    const override = {
      parcelId,
      symbol: overrideSymbol.trim() || parcel?.symbol || "",
      account: overrideAccount.trim() || parcel?.account || "",
      acquisitionDate: overrideDate,
      source: "manual" as const,
    };
    saveTaxData({
      ...taxData,
      acquisitionOverrides: [
        ...taxData.acquisitionOverrides.filter(
          (candidate) => candidate.parcelId !== override.parcelId,
        ),
        override,
      ],
    });
  };

  const deleteAcquisitionOverride = (parcelId: string) => {
    saveTaxData({
      ...taxData,
      acquisitionOverrides: taxData.acquisitionOverrides.filter(
        (override) => override.parcelId !== parcelId,
      ),
    });
  };

  const latestIncomeYear = report.incomeYears.at(-1);
  const minimumTax = calculateMinimumTaxTopUp({
    realCapitalGain: latestIncomeYear?.taxableGain ?? 0,
    taxOnGainBeforeTopUp: ordinaryIncomeTaxOnGain,
    receivesIncomeSupport: minimumTaxExempt,
  });

  const header = (
    <PageHeader
      actions={
        <Button
          disabled={report.closedLots.length === 0}
          onClick={() => downloadCsv(report)}
          variant="outline"
        >
          <Icons.Download className="mr-2 h-4 w-4" />
          Export CSV
        </Button>
      }
    >
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <Icons.Percent className="text-primary h-5 w-5" />
          <h1 className="text-xl font-semibold">Australia CGT Planner</h1>
        </div>
        <p className="text-muted-foreground text-sm">
          Planning estimates for simple AUD activity, with limitations surfaced for review.
        </p>
      </div>
    </PageHeader>
  );

  if (activitiesQuery.isLoading) {
    return (
      <Page>
        {header}
        <PageContent>
          <div className="flex min-h-[40vh] items-center justify-center">
            <Icons.Loader className="text-primary h-8 w-8 animate-spin" />
          </div>
        </PageContent>
      </Page>
    );
  }

  if (activitiesQuery.error) {
    return (
      <Page>
        {header}
        <PageContent>
          <div className="border-destructive/30 bg-destructive/10 text-destructive rounded-md border p-4 text-sm">
            Failed to load Wealthfolio activities: {(activitiesQuery.error as Error).message}
          </div>
        </PageContent>
      </Page>
    );
  }

  return (
    <Page>
      {header}
      <PageContent>
        <div className="flex flex-col gap-6">
          <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            <div className="rounded-md border p-4">
              <p className="text-muted-foreground text-xs font-medium uppercase">Closed lots</p>
              <p className="mt-2 text-2xl font-semibold">{report.closedLots.length}</p>
            </div>
            <div className="rounded-md border p-4">
              <p className="text-muted-foreground text-xs font-medium uppercase">Proceeds</p>
              <p className="mt-2 text-2xl font-semibold">
                {formatAud(report.incomeYears.reduce((sum, year) => sum + year.proceeds, 0))}
              </p>
            </div>
            <div className="rounded-md border p-4">
              <p className="text-muted-foreground text-xs font-medium uppercase">Gross gains</p>
              <p className="mt-2 text-2xl font-semibold">
                {formatAud(report.incomeYears.reduce((sum, year) => sum + year.grossGain, 0))}
              </p>
            </div>
            <div className="rounded-md border p-4">
              <p className="text-muted-foreground text-xs font-medium uppercase">Losses applied</p>
              <p className="mt-2 text-2xl font-semibold">
                {formatAud(
                  report.incomeYears.reduce((sum, year) => sum + year.capitalLossesApplied, 0),
                )}
              </p>
            </div>
            <div className="rounded-md border p-4">
              <p className="text-muted-foreground text-xs font-medium uppercase">Taxable gains</p>
              <p className="mt-2 text-2xl font-semibold">
                {formatAud(report.incomeYears.reduce((sum, year) => sum + year.taxableGain, 0))}
              </p>
            </div>
          </section>

          {report.unmatchedSells.length > 0 ? (
            <section className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
              <div className="flex items-start gap-3">
                <Icons.AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
                <div>
                  <h2 className="font-semibold">Unmatched sells need review</h2>
                  <p className="mt-1">
                    {report.unmatchedSells.length} disposal
                    {report.unmatchedSells.length === 1 ? "" : "s"} could not be fully matched to
                    earlier buy lots. Totals exclude the unmatched quantity until the missing
                    acquisition history is added.
                  </p>
                </div>
              </div>
            </section>
          ) : null}

          {report.unsupportedActivities.length > 0 ? (
            <section className="rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-950 dark:border-red-700 dark:bg-red-950 dark:text-red-100">
              <div className="flex items-start gap-3">
                <Icons.AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
                <div>
                  <h2 className="font-semibold">Non-AUD activities excluded</h2>
                  <p className="mt-1">
                    {report.unsupportedActivities.length} BUY/SELL activit
                    {report.unsupportedActivities.length === 1 ? "y was" : "ies were"} excluded
                    because this addon does not convert foreign-currency CGT amounts to AUD yet.
                  </p>
                </div>
              </div>
            </section>
          ) : null}

          {report.ignoredActivities.length > 0 ? (
            <section className="rounded-md border border-slate-300 bg-slate-50 p-4 text-sm text-slate-950 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100">
              <div className="flex items-start gap-3">
                <Icons.AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
                <div>
                  <h2 className="font-semibold">Some activity types are not modelled</h2>
                  <p className="mt-1">
                    {report.ignoredActivities.length} non-BUY/SELL activit
                    {report.ignoredActivities.length === 1 ? "y is" : "ies are"} not included in CGT
                    lot matching. Review transfers, splits, and corporate actions manually.
                  </p>
                </div>
              </div>
            </section>
          ) : null}

          <section className="rounded-md border p-4">
            <div className="mb-4 flex flex-col gap-1">
              <h2 className="text-base font-semibold">Budget 2026-27 Scenario Inputs</h2>
              <p className="text-muted-foreground text-sm">
                Provisional planning inputs for announced settings from 1 July 2027. The main report
                remains a current-law estimate and does not yet calculate post-2027 indexed
                disposals end to end.
              </p>
            </div>
            <div className="grid gap-4 md:grid-cols-3">
              <label className="flex flex-col gap-2 text-sm">
                Tax on gain before minimum-tax top-up
                <input
                  className="rounded-md border bg-transparent px-3 py-2"
                  inputMode="decimal"
                  type="number"
                  value={ordinaryIncomeTaxOnGain}
                  onChange={(event) => setOrdinaryIncomeTaxOnGain(Number(event.target.value))}
                />
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  checked={minimumTaxExempt}
                  type="checkbox"
                  onChange={(event) => setMinimumTaxExempt(event.target.checked)}
                />
                Income-support minimum-tax exemption
              </label>
              <div className="rounded-md bg-slate-50 p-3 text-sm dark:bg-slate-900">
                <p className="text-muted-foreground">
                  Illustrative minimum-tax top-up on latest taxable gain
                </p>
                <p className="mt-1 text-lg font-semibold">{formatAud(minimumTax.topUpTax)}</p>
              </div>
            </div>
          </section>

          <section className="rounded-md border p-4">
            <div className="mb-4 flex flex-col gap-1">
              <h2 className="text-base font-semibold">Addon Tax Data</h2>
              <p className="text-muted-foreground text-sm">
                Local addon-only records for AMMA, CPI, 2027 parcel values, AMIT adjustments, and
                aggregated-holding acquisition dates.
              </p>
            </div>
            <datalist id="australia-cgt-all-parcels">
              {allParcelOptions.map((parcel) => (
                <option
                  key={parcel.parcelId}
                  label={`${parcel.symbol} · ${parcel.account} · ${parcel.acquisitionDate}`}
                  value={parcel.parcelId}
                />
              ))}
            </datalist>
            <datalist id="australia-cgt-open-parcels">
              {openParcelOptions.map((parcel) => (
                <option
                  key={parcel.parcelId}
                  label={`${parcel.symbol} · ${parcel.account} · ${parcel.acquisitionDate}`}
                  value={parcel.parcelId}
                />
              ))}
            </datalist>
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="rounded-md bg-slate-50 p-3 text-sm dark:bg-slate-900">
                <h3 className="font-medium">AMMA / AMIT</h3>
                <p className="text-muted-foreground mt-1 text-xs">
                  Choose a parcel from the matched lots or holding parcels below, then enter the
                  AMIT cost-base movement from the AMMA statement.
                </p>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <input
                    aria-label="AMMA parcel ID"
                    className="rounded-md border bg-transparent px-3 py-2"
                    list="australia-cgt-all-parcels"
                    placeholder="Parcel ID"
                    value={ammaParcelId}
                    onChange={(event) => setAmmaParcelId(event.target.value)}
                  />
                  <input
                    aria-label="AMMA income year"
                    className="rounded-md border bg-transparent px-3 py-2"
                    value={ammaIncomeYear}
                    onChange={(event) => setAmmaIncomeYear(event.target.value)}
                  />
                  <input
                    aria-label="AMMA taxable income"
                    className="rounded-md border bg-transparent px-3 py-2"
                    inputMode="decimal"
                    type="number"
                    value={ammaTaxableIncome}
                    onChange={(event) => setAmmaTaxableIncome(Number(event.target.value))}
                  />
                  <input
                    aria-label="AMMA cash distribution"
                    className="rounded-md border bg-transparent px-3 py-2"
                    inputMode="decimal"
                    type="number"
                    value={ammaCashDistribution}
                    onChange={(event) => setAmmaCashDistribution(Number(event.target.value))}
                  />
                  <input
                    aria-label="AMMA franking credits"
                    className="rounded-md border bg-transparent px-3 py-2"
                    inputMode="decimal"
                    type="number"
                    value={ammaFrankingCredits}
                    onChange={(event) => setAmmaFrankingCredits(Number(event.target.value))}
                  />
                  <input
                    aria-label="AMIT cost base increase"
                    className="rounded-md border bg-transparent px-3 py-2"
                    inputMode="decimal"
                    type="number"
                    value={ammaIncrease}
                    onChange={(event) => setAmmaIncrease(Number(event.target.value))}
                  />
                  <input
                    aria-label="AMIT cost base decrease"
                    className="rounded-md border bg-transparent px-3 py-2"
                    inputMode="decimal"
                    type="number"
                    value={ammaDecrease}
                    onChange={(event) => setAmmaDecrease(Number(event.target.value))}
                  />
                </div>
                <Button
                  className="mt-3"
                  disabled={!canSaveAmma}
                  onClick={saveAmmaStatement}
                  variant="outline"
                >
                  Save AMMA statement
                </Button>
              </div>

              <div className="rounded-md bg-slate-50 p-3 text-sm dark:bg-slate-900">
                <h3 className="font-medium">CPI Cache</h3>
                <p className="text-muted-foreground mt-2">
                  Cached observations: {taxData.cpiSeries.length}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button onClick={refreshAbsCpi} variant="outline">
                    Refresh ABS CPI
                  </Button>
                  <Button onClick={saveCpiSample} variant="ghost">
                    Insert demo CPI row
                  </Button>
                </div>
                <p className="text-muted-foreground mt-2 text-xs">
                  Demo CPI is synthetic test data. Use Refresh ABS CPI for real cache values.
                </p>
                {cpiRefreshError ? (
                  <p className="text-destructive mt-2">{cpiRefreshError}</p>
                ) : null}
              </div>

              <div className="rounded-md bg-slate-50 p-3 text-sm dark:bg-slate-900">
                <h3 className="font-medium">30 June 2027 Parcel Value</h3>
                <p className="text-muted-foreground mt-1 text-xs">
                  Selecting a known parcel fills symbol, account, acquired date, and quantity; edit
                  them only when the parcel was aggregated outside Wealthfolio.
                </p>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <input
                    aria-label="Snapshot parcel ID"
                    className="rounded-md border bg-transparent px-3 py-2"
                    list="australia-cgt-open-parcels"
                    placeholder="Parcel ID"
                    value={snapshotParcelId}
                    onChange={(event) => fillSnapshotParcel(event.target.value)}
                  />
                  <input
                    aria-label="Snapshot symbol"
                    className="rounded-md border bg-transparent px-3 py-2"
                    placeholder="Symbol"
                    value={snapshotSymbol}
                    onChange={(event) => setSnapshotSymbol(event.target.value)}
                  />
                  <input
                    aria-label="Snapshot account"
                    className="rounded-md border bg-transparent px-3 py-2"
                    placeholder="Account"
                    value={snapshotAccount}
                    onChange={(event) => setSnapshotAccount(event.target.value)}
                  />
                  <input
                    aria-label="Snapshot acquisition date"
                    className="rounded-md border bg-transparent px-3 py-2"
                    type="date"
                    value={snapshotAcquisitionDate}
                    onChange={(event) => setSnapshotAcquisitionDate(event.target.value)}
                  />
                  <input
                    aria-label="Snapshot quantity"
                    className="rounded-md border bg-transparent px-3 py-2"
                    inputMode="decimal"
                    type="number"
                    value={snapshotQuantity}
                    onChange={(event) => setSnapshotQuantity(Number(event.target.value))}
                  />
                  <input
                    aria-label="Snapshot market value"
                    className="rounded-md border bg-transparent px-3 py-2"
                    inputMode="decimal"
                    type="number"
                    value={snapshotValue}
                    onChange={(event) => setSnapshotValue(Number(event.target.value))}
                  />
                </div>
                <Button
                  className="mt-3"
                  disabled={!canSaveSnapshot}
                  onClick={saveTransitionSnapshot}
                  variant="outline"
                >
                  Save 2027 snapshot
                </Button>
              </div>

              <div className="rounded-md bg-slate-50 p-3 text-sm dark:bg-slate-900">
                <h3 className="font-medium">Aggregated Holding Acquisition</h3>
                <p className="text-muted-foreground mt-1 text-xs">
                  Use this when Wealthfolio has a holding but not the original parcel acquisition
                  date. A selected parcel fills the matching symbol and account.
                </p>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <input
                    aria-label="Override parcel ID"
                    className="rounded-md border bg-transparent px-3 py-2"
                    list="australia-cgt-open-parcels"
                    placeholder="Parcel ID"
                    value={overrideParcelId}
                    onChange={(event) => fillOverrideParcel(event.target.value)}
                  />
                  <input
                    aria-label="Override symbol"
                    className="rounded-md border bg-transparent px-3 py-2"
                    placeholder="Symbol"
                    value={overrideSymbol}
                    onChange={(event) => setOverrideSymbol(event.target.value)}
                  />
                  <input
                    aria-label="Override account"
                    className="rounded-md border bg-transparent px-3 py-2"
                    placeholder="Account"
                    value={overrideAccount}
                    onChange={(event) => setOverrideAccount(event.target.value)}
                  />
                  <input
                    aria-label="Override acquisition date"
                    className="rounded-md border bg-transparent px-3 py-2"
                    type="date"
                    value={overrideDate}
                    onChange={(event) => setOverrideDate(event.target.value)}
                  />
                </div>
                <Button
                  className="mt-3"
                  disabled={!canSaveOverride}
                  onClick={saveAcquisitionOverride}
                  variant="outline"
                >
                  Save acquisition date
                </Button>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-3 text-sm">
              <span>AMMA statements: {taxData.ammaStatements.length}</span>
              <span>AMIT adjustments: {taxData.amitAdjustments.length}</span>
              <span>2027 snapshots: {taxData.transitionSnapshots.length}</span>
              <span>Acquisition overrides: {taxData.acquisitionOverrides.length}</span>
              <Button onClick={clearTaxData} size="sm" variant="ghost">
                Clear local tax data
              </Button>
            </div>
            <div className="mt-4 grid gap-3 lg:grid-cols-2">
              <div className="bg-background rounded-md border p-3">
                <h3 className="text-sm font-medium">Stored AMMA statements</h3>
                <div className="mt-2 divide-y text-sm">
                  {taxData.ammaStatements.map((statement) => (
                    <div
                      key={statement.id}
                      className="flex items-center justify-between gap-3 py-2"
                    >
                      <div>
                        <p className="font-medium">
                          {statement.parcelId ?? statement.holdingKey} · {statement.incomeYear}
                        </p>
                        <p className="text-muted-foreground text-xs">
                          Taxable {formatAud(statement.taxableIncome)} · Cash{" "}
                          {formatAud(statement.cashDistribution)} · Franking{" "}
                          {formatAud(statement.frankingCredits)} · AMIT{" "}
                          {formatAud(
                            statement.amitCostBaseIncrease - statement.amitCostBaseDecrease,
                          )}
                        </p>
                      </div>
                      <Button
                        aria-label={`Delete AMMA ${statement.id}`}
                        onClick={() => deleteAmmaStatement(statement.id)}
                        size="sm"
                        variant="ghost"
                      >
                        Delete
                      </Button>
                    </div>
                  ))}
                  {taxData.ammaStatements.length === 0 ? (
                    <p className="text-muted-foreground py-2 text-xs">No AMMA statements saved.</p>
                  ) : null}
                </div>
              </div>

              <div className="bg-background rounded-md border p-3">
                <h3 className="text-sm font-medium">Stored CPI observations</h3>
                <div className="mt-2 divide-y text-sm">
                  {taxData.cpiSeries.map((observation) => (
                    <div
                      key={observation.quarter}
                      className="flex items-center justify-between gap-3 py-2"
                    >
                      <p>
                        {observation.quarter} · {observation.value} · {observation.source}
                      </p>
                      <Button
                        aria-label={`Delete CPI ${observation.quarter}`}
                        onClick={() => deleteCpiObservation(observation.quarter)}
                        size="sm"
                        variant="ghost"
                      >
                        Delete
                      </Button>
                    </div>
                  ))}
                  {taxData.cpiSeries.length === 0 ? (
                    <p className="text-muted-foreground py-2 text-xs">No CPI observations saved.</p>
                  ) : null}
                </div>
              </div>

              <div className="bg-background rounded-md border p-3">
                <h3 className="text-sm font-medium">Stored 2027 snapshots</h3>
                <div className="mt-2 divide-y text-sm">
                  {taxData.transitionSnapshots.map((snapshot) => (
                    <div
                      key={snapshot.parcelId}
                      className="flex items-center justify-between gap-3 py-2"
                    >
                      <div>
                        <p className="font-medium">{snapshot.parcelId}</p>
                        <p className="text-muted-foreground text-xs">
                          {snapshot.symbol} · {snapshot.account} ·{" "}
                          {formatAud(snapshot.marketValueAt2027)}
                        </p>
                      </div>
                      <Button
                        aria-label={`Delete snapshot ${snapshot.parcelId}`}
                        onClick={() => deleteTransitionSnapshot(snapshot.parcelId)}
                        size="sm"
                        variant="ghost"
                      >
                        Delete
                      </Button>
                    </div>
                  ))}
                  {taxData.transitionSnapshots.length === 0 ? (
                    <p className="text-muted-foreground py-2 text-xs">No snapshots saved.</p>
                  ) : null}
                </div>
              </div>

              <div className="bg-background rounded-md border p-3">
                <h3 className="text-sm font-medium">Stored acquisition overrides</h3>
                <div className="mt-2 divide-y text-sm">
                  {taxData.acquisitionOverrides.map((override) => (
                    <div
                      key={override.parcelId}
                      className="flex items-center justify-between gap-3 py-2"
                    >
                      <div>
                        <p className="font-medium">{override.parcelId}</p>
                        <p className="text-muted-foreground text-xs">
                          {override.symbol} · {override.account} · {override.acquisitionDate}
                        </p>
                      </div>
                      <Button
                        aria-label={`Delete acquisition override ${override.parcelId}`}
                        onClick={() => deleteAcquisitionOverride(override.parcelId)}
                        size="sm"
                        variant="ghost"
                      >
                        Delete
                      </Button>
                    </div>
                  ))}
                  {taxData.acquisitionOverrides.length === 0 ? (
                    <p className="text-muted-foreground py-2 text-xs">
                      No acquisition overrides saved.
                    </p>
                  ) : null}
                </div>
              </div>
            </div>
          </section>

          <section className="rounded-md border">
            <div className="border-b p-4">
              <h2 className="text-base font-semibold">Income Year Summary</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead className="bg-muted/40 text-muted-foreground text-left">
                  <tr>
                    <th className="px-4 py-3 font-medium">Income year</th>
                    <th className="px-4 py-3 text-right font-medium">Proceeds</th>
                    <th className="px-4 py-3 text-right font-medium">Cost base</th>
                    <th className="px-4 py-3 text-right font-medium">Gross gain</th>
                    <th className="px-4 py-3 text-right font-medium">Losses applied</th>
                    <th className="px-4 py-3 text-right font-medium">Loss carry-forward</th>
                    <th className="px-4 py-3 text-right font-medium">Discount</th>
                    <th className="px-4 py-3 text-right font-medium">Taxable gain</th>
                  </tr>
                </thead>
                <tbody>
                  {report.incomeYears.map((year) => (
                    <tr key={year.incomeYear} className="border-t">
                      <td className="px-4 py-3 font-medium">{year.incomeYear}</td>
                      <td className="px-4 py-3 text-right">{formatAud(year.proceeds)}</td>
                      <td className="px-4 py-3 text-right">{formatAud(year.costBase)}</td>
                      <td className="px-4 py-3 text-right">{formatAud(year.grossGain)}</td>
                      <td className="px-4 py-3 text-right">
                        {formatAud(year.capitalLossesApplied)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {formatAud(year.capitalLossCarryForward)}
                      </td>
                      <td className="px-4 py-3 text-right">{formatAud(year.discountApplied)}</td>
                      <td className="px-4 py-3 text-right">{formatAud(year.taxableGain)}</td>
                    </tr>
                  ))}
                  {report.incomeYears.length === 0 ? (
                    <tr>
                      <td className="text-muted-foreground px-4 py-8 text-center" colSpan={8}>
                        No matched BUY/SELL lots found yet.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-md border">
            <div className="border-b p-4">
              <h2 className="text-base font-semibold">2027 Transition Parcels</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="bg-muted/40 text-muted-foreground text-left">
                  <tr>
                    <th className="px-4 py-3 font-medium">Parcel</th>
                    <th className="px-4 py-3 font-medium">Symbol</th>
                    <th className="px-4 py-3 text-right font-medium">Quantity</th>
                    <th className="px-4 py-3 text-right font-medium">Cost base</th>
                    <th className="px-4 py-3 text-right font-medium">2027 value</th>
                    <th className="px-4 py-3 text-right font-medium">Pre-2027 taxable</th>
                  </tr>
                </thead>
                <tbody>
                  {report.transitionLots.map((lot) => (
                    <tr key={lot.parcelId} className="border-t">
                      <td className="px-4 py-3">{lot.parcelId}</td>
                      <td className="px-4 py-3">{lot.symbol}</td>
                      <td className="px-4 py-3 text-right">{lot.quantity}</td>
                      <td className="px-4 py-3 text-right">{formatAud(lot.costBase)}</td>
                      <td className="px-4 py-3 text-right">{formatAud(lot.marketValueAt2027)}</td>
                      <td className="px-4 py-3 text-right">
                        {formatAud(lot.preCommencementTaxableGain)}
                      </td>
                    </tr>
                  ))}
                  {report.transitionLots.length === 0 ? (
                    <tr>
                      <td className="text-muted-foreground px-4 py-8 text-center" colSpan={6}>
                        No 2027 parcel snapshots saved yet.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-md border">
            <div className="border-b p-4">
              <h2 className="text-base font-semibold">Dividend Franking Metadata</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead className="bg-muted/40 text-muted-foreground text-left">
                  <tr>
                    <th className="px-4 py-3 font-medium">Symbol</th>
                    <th className="px-4 py-3 font-medium">Income year</th>
                    <th className="px-4 py-3 text-right font-medium">Amount</th>
                    <th className="px-4 py-3 text-right font-medium">Franking percent</th>
                    <th className="px-4 py-3 text-right font-medium">Franked amount</th>
                  </tr>
                </thead>
                <tbody>
                  {report.dividends.map((dividend) => (
                    <tr key={dividend.activityId} className="border-t">
                      <td className="px-4 py-3">{dividend.symbol}</td>
                      <td className="px-4 py-3">{dividend.incomeYear}</td>
                      <td className="px-4 py-3 text-right">{formatAud(dividend.amount)}</td>
                      <td className="px-4 py-3 text-right">
                        {dividend.frankingPercentage === null
                          ? "Missing"
                          : `${dividend.frankingPercentage}%`}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {dividend.frankedAmount === null
                          ? "Missing"
                          : formatAud(dividend.frankedAmount)}
                      </td>
                    </tr>
                  ))}
                  {report.dividends.length === 0 ? (
                    <tr>
                      <td className="text-muted-foreground px-4 py-8 text-center" colSpan={5}>
                        No dividend activities with franking metadata found.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-md border">
            <div className="border-b p-4">
              <h2 className="text-base font-semibold">Holding Parcels</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead className="bg-muted/40 text-muted-foreground text-left">
                  <tr>
                    <th className="px-4 py-3 font-medium">Parcel</th>
                    <th className="px-4 py-3 font-medium">Symbol</th>
                    <th className="px-4 py-3 font-medium">Acquired</th>
                    <th className="px-4 py-3 text-right font-medium">Quantity</th>
                    <th className="px-4 py-3 text-right font-medium">Cost base</th>
                  </tr>
                </thead>
                <tbody>
                  {holdingParcels.map((parcel) => (
                    <tr key={parcel.parcelId} className="border-t">
                      <td className="px-4 py-3">{parcel.parcelId}</td>
                      <td className="px-4 py-3">{parcel.symbol}</td>
                      <td className="px-4 py-3">{parcel.acquisitionDate}</td>
                      <td className="px-4 py-3 text-right">{parcel.quantity}</td>
                      <td className="px-4 py-3 text-right">{formatAud(parcel.costBase)}</td>
                    </tr>
                  ))}
                  {holdingParcels.length === 0 ? (
                    <tr>
                      <td className="text-muted-foreground px-4 py-8 text-center" colSpan={5}>
                        {holdingsQuery.isLoading
                          ? "Loading holding parcels..."
                          : "No holdings found."}
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-md border">
            <div className="border-b p-4">
              <h2 className="text-base font-semibold">Matched Lots</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[920px] text-sm">
                <thead className="bg-muted/40 text-muted-foreground text-left">
                  <tr>
                    <th className="px-4 py-3 font-medium">Symbol</th>
                    <th className="px-4 py-3 font-medium">Account</th>
                    <th className="px-4 py-3 text-right font-medium">Quantity</th>
                    <th className="px-4 py-3 font-medium">Acquired</th>
                    <th className="px-4 py-3 font-medium">Disposed</th>
                    <th className="px-4 py-3 text-right font-medium">AMIT adj.</th>
                    <th className="px-4 py-3 text-right font-medium">Gain</th>
                    <th className="px-4 py-3 text-right font-medium">Discount</th>
                    <th className="px-4 py-3 text-right font-medium">Taxable</th>
                  </tr>
                </thead>
                <tbody>
                  {report.closedLots.map((lot, index) => (
                    <tr
                      key={`${lot.symbol}-${lot.acquisitionDate}-${lot.disposalDate}-${index}`}
                      className="border-t"
                    >
                      <td className="px-4 py-3 font-medium">{lot.symbol}</td>
                      <td className="px-4 py-3">{lot.account}</td>
                      <td className="px-4 py-3 text-right">{lot.quantity}</td>
                      <td className="px-4 py-3">{lot.acquisitionDate}</td>
                      <td className="px-4 py-3">{lot.disposalDate}</td>
                      <td className="px-4 py-3 text-right">
                        {formatAud(lot.amitCostBaseAdjustment)}
                      </td>
                      <td
                        className={
                          lot.grossGain < 0
                            ? "px-4 py-3 text-right text-red-600"
                            : "px-4 py-3 text-right"
                        }
                      >
                        {formatAud(lot.grossGain)}
                      </td>
                      <td className="px-4 py-3 text-right">{formatAud(lot.discountApplied)}</td>
                      <td className="px-4 py-3 text-right">{formatAud(lot.taxableGain)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </PageContent>
    </Page>
  );
}
