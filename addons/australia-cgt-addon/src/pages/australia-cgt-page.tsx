import type { AddonContext } from "@wealthfolio/addon-sdk";
import { Button, Icons, Page, PageContent, PageHeader } from "@wealthfolio/ui";
import { useState } from "react";
import { AcquisitionOverrideForm } from "../components/acquisition-override-form";
import { AmmaForm } from "../components/amma-form";
import { CpiCachePanel } from "../components/cpi-cache-panel";
import { DividendFrankingTable } from "../components/dividend-franking-table";
import { HoldingParcelsTable } from "../components/holding-parcels-table";
import { IncomeYearSummaryTable } from "../components/income-year-summary-table";
import { MatchedLotsTable } from "../components/matched-lots-table";
import { ReviewWarnings } from "../components/review-warnings";
import { StoredTaxDataPanel } from "../components/stored-tax-data-panel";
import { SummaryCards } from "../components/summary-cards";
import { TransitionParcelsTable } from "../components/transition-parcels-table";
import { TransitionSnapshotForm } from "../components/transition-snapshot-form";
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

  const openSnapshotParcel = findOpenParcelContext(snapshotParcelId.trim(), holdingParcels);
  const openOverrideParcel = findOpenParcelContext(overrideParcelId.trim(), holdingParcels);
  const canSaveAmma = ammaParcelId.trim().length > 0 && (ammaIncrease !== 0 || ammaDecrease !== 0);
  const canSaveSnapshot =
    snapshotParcelId.trim().length > 0 &&
    (snapshotSymbol.trim().length > 0 || Boolean(openSnapshotParcel?.symbol)) &&
    (snapshotAccount.trim().length > 0 || Boolean(openSnapshotParcel?.account)) &&
    (snapshotAcquisitionDate.length > 0 || Boolean(openSnapshotParcel?.acquisitionDate)) &&
    (snapshotQuantity > 0 || (openSnapshotParcel?.quantity ?? 0) > 0) &&
    snapshotValue > 0;
  const canSaveOverride =
    overrideParcelId.trim().length > 0 &&
    (overrideSymbol.trim().length > 0 || Boolean(openOverrideParcel?.symbol)) &&
    (overrideAccount.trim().length > 0 || Boolean(openOverrideParcel?.account)) &&
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
          <SummaryCards report={report} />
          <ReviewWarnings report={report} />

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
              <AmmaForm
                canSave={canSaveAmma}
                cashDistribution={ammaCashDistribution}
                decrease={ammaDecrease}
                frankingCredits={ammaFrankingCredits}
                incomeYear={ammaIncomeYear}
                increase={ammaIncrease}
                parcelId={ammaParcelId}
                taxableIncome={ammaTaxableIncome}
                onCashDistributionChange={setAmmaCashDistribution}
                onDecreaseChange={setAmmaDecrease}
                onFrankingCreditsChange={setAmmaFrankingCredits}
                onIncomeYearChange={setAmmaIncomeYear}
                onIncreaseChange={setAmmaIncrease}
                onParcelIdChange={setAmmaParcelId}
                onSave={saveAmmaStatement}
                onTaxableIncomeChange={setAmmaTaxableIncome}
              />
              <CpiCachePanel
                cpiSeries={taxData.cpiSeries}
                refreshError={cpiRefreshError}
                onRefresh={refreshAbsCpi}
              />
              <TransitionSnapshotForm
                account={snapshotAccount}
                acquisitionDate={snapshotAcquisitionDate}
                canSave={canSaveSnapshot}
                marketValue={snapshotValue}
                parcelId={snapshotParcelId}
                quantity={snapshotQuantity}
                symbol={snapshotSymbol}
                onAccountChange={setSnapshotAccount}
                onAcquisitionDateChange={setSnapshotAcquisitionDate}
                onMarketValueChange={setSnapshotValue}
                onParcelIdChange={fillSnapshotParcel}
                onQuantityChange={setSnapshotQuantity}
                onSave={saveTransitionSnapshot}
                onSymbolChange={setSnapshotSymbol}
              />
              <AcquisitionOverrideForm
                account={overrideAccount}
                acquisitionDate={overrideDate}
                canSave={canSaveOverride}
                parcelId={overrideParcelId}
                symbol={overrideSymbol}
                onAccountChange={setOverrideAccount}
                onAcquisitionDateChange={setOverrideDate}
                onParcelIdChange={fillOverrideParcel}
                onSave={saveAcquisitionOverride}
                onSymbolChange={setOverrideSymbol}
              />
            </div>
            <StoredTaxDataPanel
              taxData={taxData}
              onClear={clearTaxData}
              onDeleteAcquisitionOverride={deleteAcquisitionOverride}
              onDeleteAmma={deleteAmmaStatement}
              onDeleteCpi={deleteCpiObservation}
              onDeleteSnapshot={deleteTransitionSnapshot}
            />
          </section>

          <IncomeYearSummaryTable report={report} />
          <TransitionParcelsTable report={report} />
          <DividendFrankingTable report={report} />
          <HoldingParcelsTable
            holdingParcels={holdingParcels}
            isLoading={holdingsQuery.isLoading}
          />
          <MatchedLotsTable report={report} />
        </div>
      </PageContent>
    </Page>
  );
}
