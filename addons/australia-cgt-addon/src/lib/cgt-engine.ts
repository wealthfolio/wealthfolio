import {
  type AmitCostBaseAdjustment,
  type ParcelAcquisitionOverride,
  type TransitionMarketValueSnapshot,
  getFrankingPercentage,
} from "./tax-data";

export interface CurrentLawGainInput {
  grossGain: number;
  capitalLosses: number;
  acquisitionDate: string | Date;
  disposalDate: string | Date;
  eligibleForDiscount: boolean;
}

export interface CurrentLawGainResult {
  grossGain: number;
  capitalLossesApplied: number;
  netGainBeforeDiscount: number;
  discountEligible: boolean;
  discountApplied: number;
  taxableGain: number;
}

export interface IndexedGainInput {
  costBase: number;
  proceeds: number;
  indexationFactor: number;
}

export interface IndexedGainResult {
  costBase: number;
  proceeds: number;
  indexationFactor: number;
  indexedCostBase: number;
  realCapitalGain: number;
}

export interface TransitionGainInput {
  originalCostBase: number;
  transitionValueAt2027: number;
  proceeds: number;
  acquisitionDate: string | Date;
  disposalDate: string | Date;
  post2027IndexationFactor: number;
}

export interface TransitionGainResult {
  preCommencement: CurrentLawGainResult;
  postCommencement: IndexedGainResult;
  totalTaxableGain: number;
}

export interface MinimumTaxInput {
  realCapitalGain: number;
  taxOnGainBeforeTopUp: number;
  receivesIncomeSupport: boolean;
}

export interface MinimumTaxResult {
  minimumTaxRequired: number;
  topUpTax: number;
  exempt: boolean;
}

export interface WealthfolioCgtActivity {
  id: string;
  activityType: string;
  date: string | Date;
  quantity: string | number | null;
  unitPrice: string | number | null;
  amount: string | number | null;
  fee: string | number | null;
  currency: string;
  assetSymbol: string;
  assetName?: string;
  accountId?: string;
  accountName: string;
  fxRate?: string | number | null;
  metadata?: Record<string, unknown>;
}

export interface ClosedLot {
  parcelId: string;
  symbol: string;
  assetName?: string;
  account: string;
  incomeYear: string;
  acquisitionDate: string;
  disposalDate: string;
  quantity: number;
  proceeds: number;
  costBase: number;
  amitCostBaseAdjustment: number;
  grossGain: number;
  preLossTaxableGainEstimate: number;
  preLossDiscountEstimate: number;
  discountEligible: boolean;
  method: "FIFO";
}

export interface IncomeYearSummary {
  incomeYear: string;
  proceeds: number;
  costBase: number;
  amitCostBaseAdjustment: number;
  grossGain: number;
  grossCapitalGains: number;
  capitalLossesApplied: number;
  capitalLossCarryForward: number;
  discountApplied: number;
  taxableGain: number;
}

export interface CgtReport {
  closedLots: ClosedLot[];
  incomeYears: IncomeYearSummary[];
  unmatchedSells: UnmatchedSell[];
  unsupportedActivities: UnsupportedActivity[];
  ignoredActivities: IgnoredActivity[];
  dividends: DividendTaxDetail[];
  transitionLots: TransitionLot[];
}

export interface UnmatchedSell {
  symbol: string;
  account: string;
  date: string;
  quantity: number;
  proceeds: number;
}

export interface UnsupportedActivity {
  activityId: string;
  activityType: string;
  symbol: string;
  account: string;
  date: string;
  currency: string;
  reason: "NON_AUD_CURRENCY";
}

export interface IgnoredActivity {
  activityId: string;
  activityType: string;
  symbol: string;
  account: string;
  date: string;
}

interface OpenLot {
  parcelId: string;
  symbol: string;
  assetName?: string;
  account: string;
  acquisitionDate: string;
  remainingQuantity: number;
  unitCostBase: number;
  originalQuantity: number;
  disposals: Array<{ incomeYear: string; quantity: number }>;
}

interface IncomeYearAccumulator extends IncomeYearSummary {
  capitalLosses: number;
  nonDiscountGains: number;
  discountEligibleGains: number;
}

export interface CgtReportOptions {
  amitAdjustments?: AmitCostBaseAdjustment[];
  transitionSnapshots?: TransitionMarketValueSnapshot[];
  acquisitionOverrides?: ParcelAcquisitionOverride[];
  holdingParcels?: HoldingParcel[];
}

export interface DividendTaxDetail {
  activityId: string;
  symbol: string;
  account: string;
  incomeYear: string;
  amount: number;
  frankingPercentage: number | null;
  frankedAmount: number | null;
}

export interface TransitionLot {
  parcelId: string;
  symbol: string;
  account: string;
  acquisitionDate: string;
  quantity: number;
  costBase: number;
  marketValueAt2027: number;
  preCommencementTaxableGain: number;
  valuationMethod: TransitionMarketValueSnapshot["valuationMethod"];
}

export interface HoldingLike {
  id: string;
  quantity: number;
  openDate?: string | Date | null;
  lots?: Array<{
    id: string;
    acquisitionDate: string;
    quantity: number;
    costBasis: number;
  }> | null;
  accountId?: string;
  accountName?: string;
  instrument?: {
    symbol?: string | null;
    name?: string | null;
  } | null;
  costBasis?: {
    local: number;
    base: number;
  } | null;
}

export interface HoldingParcel {
  parcelId: string;
  symbol: string;
  account: string;
  acquisitionDate: string;
  quantity: number;
  costBase: number;
}

function toDate(value: string | Date): Date {
  if (value instanceof Date) {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }
  const [year, month, day] = value
    .slice(0, 10)
    .split("-")
    .map((part) => Number.parseInt(part, 10));
  return new Date(Date.UTC(year, month - 1, day));
}

function roundCurrency(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function positive(value: number): number {
  return Math.max(0, value);
}

function numberValue(value: string | number | null | undefined): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function sumAmitAdjustment(
  parcelId: string,
  disposalIncomeYear: string,
  quantity: number,
  originalQuantity: number,
  priorDisposals: Array<{ incomeYear: string; quantity: number }>,
  adjustmentsByParcel: Map<string, AmitCostBaseAdjustment[]>,
): number {
  if (originalQuantity === 0) return 0;
  return roundCurrency(
    (adjustmentsByParcel.get(parcelId) ?? [])
      .filter(
        (adjustment) =>
          incomeYearSortKey(adjustment.incomeYear) <= incomeYearSortKey(disposalIncomeYear),
      )
      .reduce((sum, adjustment) => {
        const disposedBeforeAdjustment = priorDisposals
          .filter(
            (disposal) =>
              incomeYearSortKey(disposal.incomeYear) < incomeYearSortKey(adjustment.incomeYear),
          )
          .reduce((disposed, disposal) => disposed + disposal.quantity, 0);
        const adjustmentQuantity = originalQuantity - disposedBeforeAdjustment;
        if (adjustmentQuantity <= 0) return sum;
        return sum + adjustment.amount * (quantity / adjustmentQuantity);
      }, 0),
  );
}

function lotPoolKey(symbol: string, accountIdOrName: string): string {
  return `${symbol}\u0000${accountIdOrName}`;
}

function activityAccountKey(activity: WealthfolioCgtActivity): string {
  return activity.accountId ?? activity.accountName;
}

function incomeYearSortKey(incomeYear: string): number {
  const startYear = Number.parseInt(incomeYear.slice(0, 4), 10);
  return Number.isFinite(startYear) ? startYear : 0;
}

function isAudCurrency(currency: string): boolean {
  return currency.trim().toUpperCase() === "AUD";
}

function buildAmitAdjustmentsByParcel(
  adjustments: AmitCostBaseAdjustment[] | undefined,
): Map<string, AmitCostBaseAdjustment[]> {
  const byParcel = new Map<string, AmitCostBaseAdjustment[]>();
  for (const adjustment of adjustments ?? []) {
    const parcelAdjustments = byParcel.get(adjustment.parcelId) ?? [];
    parcelAdjustments.push(adjustment);
    byParcel.set(adjustment.parcelId, parcelAdjustments);
  }
  return byParcel;
}

function isoDate(value: string | Date): string {
  if (typeof value === "string") return value.slice(0, 10);
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getAustralianIncomeYear(date: string | Date): string {
  const parsed = toDate(date);
  const year = parsed.getUTCFullYear();
  const month = parsed.getUTCMonth() + 1;
  const startYear = month >= 7 ? year : year - 1;
  const endYearShort = String(startYear + 1).slice(-2);
  return `${startYear}-${endYearShort}`;
}

const PRE_TRANSITION_INCOME_YEAR = "2026-27";

function isHeldAtLeastTwelveMonths(acquisitionDate: string | Date, disposalDate: string | Date) {
  const acquisition = toDate(acquisitionDate);
  const disposal = toDate(disposalDate);
  const threshold = new Date(acquisition);
  threshold.setUTCMonth(threshold.getUTCMonth() + 12);
  return disposal.getTime() > threshold.getTime();
}

export function calculateCurrentLawTaxableGain(input: CurrentLawGainInput): CurrentLawGainResult {
  const grossGain = positive(input.grossGain);
  const lossesApplied = Math.min(grossGain, positive(input.capitalLosses));
  const netGainBeforeDiscount = roundCurrency(grossGain - lossesApplied);
  const discountEligible =
    input.eligibleForDiscount &&
    netGainBeforeDiscount > 0 &&
    isHeldAtLeastTwelveMonths(input.acquisitionDate, input.disposalDate);
  const discountApplied = discountEligible ? roundCurrency(netGainBeforeDiscount * 0.5) : 0;
  const taxableGain = roundCurrency(netGainBeforeDiscount - discountApplied);

  return {
    grossGain,
    capitalLossesApplied: lossesApplied,
    netGainBeforeDiscount,
    discountEligible,
    discountApplied,
    taxableGain,
  };
}

export function calculateIndexedGain(input: IndexedGainInput): IndexedGainResult {
  const indexedCostBase = roundCurrency(input.costBase * input.indexationFactor);
  const realCapitalGain = roundCurrency(positive(input.proceeds - indexedCostBase));

  return {
    costBase: input.costBase,
    proceeds: input.proceeds,
    indexationFactor: input.indexationFactor,
    indexedCostBase,
    realCapitalGain,
  };
}

export function calculateTransitionGain(input: TransitionGainInput): TransitionGainResult {
  const preCommencement = calculateCurrentLawTaxableGain({
    grossGain: input.transitionValueAt2027 - input.originalCostBase,
    capitalLosses: 0,
    acquisitionDate: input.acquisitionDate,
    disposalDate: "2027-07-01",
    eligibleForDiscount: true,
  });
  const postCommencement = calculateIndexedGain({
    costBase: input.transitionValueAt2027,
    proceeds: input.proceeds,
    indexationFactor: input.post2027IndexationFactor,
  });

  return {
    preCommencement,
    postCommencement,
    totalTaxableGain: roundCurrency(preCommencement.taxableGain + postCommencement.realCapitalGain),
  };
}

export function calculateMinimumTaxTopUp(input: MinimumTaxInput): MinimumTaxResult {
  const minimumTaxRequired = roundCurrency(positive(input.realCapitalGain) * 0.3);
  const exempt = input.receivesIncomeSupport || minimumTaxRequired === 0;
  const topUpTax = exempt
    ? 0
    : roundCurrency(positive(minimumTaxRequired - positive(input.taxOnGainBeforeTopUp)));

  return {
    minimumTaxRequired,
    topUpTax,
    exempt,
  };
}

export function extractDividendTaxDetails(
  activities: WealthfolioCgtActivity[],
): DividendTaxDetail[] {
  return activities
    .filter((activity) => activity.activityType === "DIVIDEND" && isAudCurrency(activity.currency))
    .map((activity) => {
      const amount = positive(numberValue(activity.amount));
      const frankingPercentage = getFrankingPercentage(activity.metadata);
      return {
        activityId: activity.id,
        symbol: activity.assetSymbol,
        account: activity.accountName,
        incomeYear: getAustralianIncomeYear(activity.date),
        amount,
        frankingPercentage,
        frankedAmount:
          frankingPercentage === null ? null : roundCurrency(amount * (frankingPercentage / 100)),
      };
    });
}

export function buildTransitionLots(
  openLots: OpenLot[],
  options: CgtReportOptions,
): TransitionLot[] {
  const snapshotsByParcel = new Map(
    (options.transitionSnapshots ?? []).map((snapshot) => [snapshot.parcelId, snapshot]),
  );
  const adjustmentsByParcel = buildAmitAdjustmentsByParcel(options.amitAdjustments);

  const transitionLots = openLots.flatMap((lot) => {
    const snapshot = snapshotsByParcel.get(lot.parcelId);
    if (!snapshot) return [];
    const transitionQuantity = Math.min(positive(snapshot.quantity), lot.remainingQuantity);
    if (transitionQuantity <= 0) return [];
    const remainingCostBase = roundCurrency(transitionQuantity * lot.unitCostBase);
    const adjustment = sumAmitAdjustment(
      lot.parcelId,
      PRE_TRANSITION_INCOME_YEAR,
      transitionQuantity,
      lot.originalQuantity,
      lot.disposals,
      adjustmentsByParcel,
    );
    const adjustedCostBase = roundCurrency(remainingCostBase + adjustment);
    const preCommencement = calculateCurrentLawTaxableGain({
      grossGain: snapshot.marketValueAt2027 - adjustedCostBase,
      capitalLosses: 0,
      acquisitionDate: lot.acquisitionDate,
      disposalDate: "2027-07-01",
      eligibleForDiscount: true,
    });

    return [
      {
        parcelId: lot.parcelId,
        symbol: lot.symbol,
        account: lot.account,
        acquisitionDate: lot.acquisitionDate,
        quantity: transitionQuantity,
        costBase: adjustedCostBase,
        marketValueAt2027: snapshot.marketValueAt2027,
        preCommencementTaxableGain: preCommencement.taxableGain,
        valuationMethod: snapshot.valuationMethod,
      },
    ];
  });

  const coveredParcelIds = new Set(transitionLots.map((lot) => lot.parcelId));
  const holdingTransitionLots = (options.holdingParcels ?? []).flatMap((parcel) => {
    if (coveredParcelIds.has(parcel.parcelId) || parcel.quantity <= 0) return [];
    const snapshot = snapshotsByParcel.get(parcel.parcelId);
    if (!snapshot) return [];
    const transitionQuantity = Math.min(positive(snapshot.quantity), parcel.quantity);
    if (transitionQuantity <= 0) return [];
    const unitCostBase = parcel.quantity > 0 ? parcel.costBase / parcel.quantity : 0;
    const transitionCostBase = roundCurrency(transitionQuantity * unitCostBase);
    const adjustment = sumAmitAdjustment(
      parcel.parcelId,
      PRE_TRANSITION_INCOME_YEAR,
      transitionQuantity,
      parcel.quantity,
      [],
      adjustmentsByParcel,
    );
    const adjustedCostBase = roundCurrency(transitionCostBase + adjustment);
    const preCommencement = calculateCurrentLawTaxableGain({
      grossGain: snapshot.marketValueAt2027 - adjustedCostBase,
      capitalLosses: 0,
      acquisitionDate: parcel.acquisitionDate,
      disposalDate: "2027-07-01",
      eligibleForDiscount: true,
    });

    return [
      {
        parcelId: parcel.parcelId,
        symbol: parcel.symbol,
        account: parcel.account,
        acquisitionDate: parcel.acquisitionDate,
        quantity: transitionQuantity,
        costBase: adjustedCostBase,
        marketValueAt2027: snapshot.marketValueAt2027,
        preCommencementTaxableGain: preCommencement.taxableGain,
        valuationMethod: snapshot.valuationMethod,
      },
    ];
  });

  return [...transitionLots, ...holdingTransitionLots];
}

export function buildHoldingParcels(
  holdings: HoldingLike[],
  acquisitionOverrides: ParcelAcquisitionOverride[] = [],
): HoldingParcel[] {
  const overridesByParcel = new Map(
    acquisitionOverrides.map((override) => [override.parcelId, override]),
  );

  return holdings.flatMap((holding) => {
    const symbol = holding.instrument?.symbol ?? holding.id;
    const account = holding.accountName ?? holding.accountId ?? "Unknown account";
    const lots = holding.lots ?? [];
    if (lots.length > 0) {
      return lots.map((lot) => ({
        parcelId: lot.id,
        symbol,
        account,
        acquisitionDate: lot.acquisitionDate,
        quantity: lot.quantity,
        costBase: lot.costBasis,
      }));
    }

    const override = overridesByParcel.get(holding.id);
    const acquisitionDate = override?.acquisitionDate ?? isoDate(holding.openDate ?? new Date());
    return [
      {
        parcelId: holding.id,
        symbol,
        account,
        acquisitionDate,
        quantity: holding.quantity,
        costBase: override?.costBase ?? holding.costBasis?.local ?? 0,
      },
    ];
  });
}

export function buildCgtReport(
  activities: WealthfolioCgtActivity[],
  options: CgtReportOptions = {},
): CgtReport {
  const sortedActivities = [...activities].sort(
    (a, b) => toDate(a.date).getTime() - toDate(b.date).getTime(),
  );
  const lotsByAccountSymbol = new Map<string, OpenLot[]>();
  const buyCountsBySymbolAccount = new Map<string, number>();
  const adjustmentsByParcel = buildAmitAdjustmentsByParcel(options.amitAdjustments);
  const closedLots: ClosedLot[] = [];
  const unmatchedSells: UnmatchedSell[] = [];
  const unsupportedActivities: UnsupportedActivity[] = [];
  const ignoredActivities: IgnoredActivity[] = [];

  for (const activity of sortedActivities) {
    if (activity.activityType === "DIVIDEND") {
      if (!isAudCurrency(activity.currency)) {
        unsupportedActivities.push({
          activityId: activity.id,
          activityType: activity.activityType,
          symbol: activity.assetSymbol,
          account: activity.accountName,
          date: isoDate(activity.date),
          currency: activity.currency,
          reason: "NON_AUD_CURRENCY",
        });
      }
      continue;
    }

    if (activity.activityType !== "BUY" && activity.activityType !== "SELL") {
      ignoredActivities.push({
        activityId: activity.id,
        activityType: activity.activityType,
        symbol: activity.assetSymbol,
        account: activity.accountName,
        date: isoDate(activity.date),
      });
      continue;
    }

    if (!isAudCurrency(activity.currency)) {
      unsupportedActivities.push({
        activityId: activity.id,
        activityType: activity.activityType,
        symbol: activity.assetSymbol,
        account: activity.accountName,
        date: isoDate(activity.date),
        currency: activity.currency,
        reason: "NON_AUD_CURRENCY",
      });
      continue;
    }

    const symbol = activity.assetSymbol;
    const quantity = positive(numberValue(activity.quantity));
    if (!symbol || quantity === 0) continue;

    const fee = positive(numberValue(activity.fee));
    const unitPrice = positive(numberValue(activity.unitPrice));
    const totalAmount = positive(numberValue(activity.amount)) || unitPrice * quantity;
    const poolKey = lotPoolKey(symbol, activityAccountKey(activity));
    const accountSymbolLots = lotsByAccountSymbol.get(poolKey) ?? [];

    if (activity.activityType === "BUY") {
      const buyIndex = buyCountsBySymbolAccount.get(poolKey) ?? 0;
      accountSymbolLots.push({
        parcelId: activity.id,
        symbol,
        assetName: activity.assetName,
        account: activity.accountName,
        acquisitionDate: isoDate(activity.date),
        remainingQuantity: quantity,
        unitCostBase: (totalAmount + fee) / quantity,
        originalQuantity: quantity,
        disposals: [],
      });
      buyCountsBySymbolAccount.set(poolKey, buyIndex + 1);
      lotsByAccountSymbol.set(poolKey, accountSymbolLots);
      continue;
    }

    let quantityToSell = quantity;
    const unitProceeds = (totalAmount - fee) / quantity;

    while (quantityToSell > 0 && accountSymbolLots.length > 0) {
      const lot = accountSymbolLots[0];
      const matchedQuantity = Math.min(quantityToSell, lot.remainingQuantity);
      const proceeds = roundCurrency(matchedQuantity * unitProceeds);
      const costBase = roundCurrency(matchedQuantity * lot.unitCostBase);
      const amitCostBaseAdjustment = sumAmitAdjustment(
        lot.parcelId,
        getAustralianIncomeYear(activity.date),
        matchedQuantity,
        lot.originalQuantity,
        lot.disposals,
        adjustmentsByParcel,
      );
      const adjustedCostBase = roundCurrency(costBase + amitCostBaseAdjustment);
      const grossGain = roundCurrency(proceeds - adjustedCostBase);
      const currentLawGain = calculateCurrentLawTaxableGain({
        grossGain,
        capitalLosses: 0,
        acquisitionDate: lot.acquisitionDate,
        disposalDate: activity.date,
        eligibleForDiscount: true,
      });

      closedLots.push({
        parcelId: lot.parcelId,
        symbol,
        assetName: lot.assetName ?? activity.assetName,
        account: lot.account,
        incomeYear: getAustralianIncomeYear(activity.date),
        acquisitionDate: lot.acquisitionDate,
        disposalDate: isoDate(activity.date),
        quantity: roundCurrency(matchedQuantity),
        proceeds,
        costBase: adjustedCostBase,
        amitCostBaseAdjustment,
        grossGain,
        preLossTaxableGainEstimate: currentLawGain.taxableGain,
        preLossDiscountEstimate: currentLawGain.discountApplied,
        discountEligible: currentLawGain.discountEligible,
        method: "FIFO",
      });

      lot.remainingQuantity = roundCurrency(lot.remainingQuantity - matchedQuantity);
      lot.disposals.push({
        incomeYear: getAustralianIncomeYear(activity.date),
        quantity: matchedQuantity,
      });
      quantityToSell = roundCurrency(quantityToSell - matchedQuantity);
      if (lot.remainingQuantity === 0) {
        accountSymbolLots.shift();
      }
    }

    if (quantityToSell > 0) {
      unmatchedSells.push({
        symbol,
        account: activity.accountName,
        date: isoDate(activity.date),
        quantity: roundCurrency(quantityToSell),
        proceeds: roundCurrency(quantityToSell * unitProceeds),
      });
    }
  }

  const summaries = new Map<string, IncomeYearAccumulator>();
  for (const lot of closedLots) {
    const summary = summaries.get(lot.incomeYear) ?? {
      incomeYear: lot.incomeYear,
      proceeds: 0,
      costBase: 0,
      amitCostBaseAdjustment: 0,
      grossGain: 0,
      grossCapitalGains: 0,
      capitalLossesApplied: 0,
      capitalLossCarryForward: 0,
      discountApplied: 0,
      taxableGain: 0,
      capitalLosses: 0,
      nonDiscountGains: 0,
      discountEligibleGains: 0,
    };
    summary.proceeds = roundCurrency(summary.proceeds + lot.proceeds);
    summary.costBase = roundCurrency(summary.costBase + lot.costBase);
    summary.amitCostBaseAdjustment = roundCurrency(
      summary.amitCostBaseAdjustment + lot.amitCostBaseAdjustment,
    );
    summary.grossGain = roundCurrency(summary.grossGain + lot.grossGain);

    if (lot.grossGain < 0) {
      summary.capitalLosses += Math.abs(lot.grossGain);
    } else if (lot.discountEligible) {
      summary.discountEligibleGains += lot.grossGain;
    } else {
      summary.nonDiscountGains += lot.grossGain;
    }

    summaries.set(lot.incomeYear, summary);
  }

  let carriedForwardLosses = 0;
  const sortedSummaries = [...summaries.values()].sort((a, b) =>
    a.incomeYear.localeCompare(b.incomeYear),
  );

  for (const summary of sortedSummaries) {
    const capitalLosses = positive(summary.capitalLosses);
    const nonDiscountGains = positive(summary.nonDiscountGains);
    const discountEligibleGains = positive(summary.discountEligibleGains);
    const availableLosses = roundCurrency(carriedForwardLosses + capitalLosses);
    const lossesAppliedToNonDiscountGains = Math.min(nonDiscountGains, availableLosses);
    const remainingLosses = availableLosses - lossesAppliedToNonDiscountGains;
    const lossesAppliedToDiscountGains = Math.min(discountEligibleGains, remainingLosses);
    const remainingNonDiscountGains = nonDiscountGains - lossesAppliedToNonDiscountGains;
    const remainingDiscountGains = discountEligibleGains - lossesAppliedToDiscountGains;

    summary.grossCapitalGains = roundCurrency(nonDiscountGains + discountEligibleGains);
    summary.capitalLossesApplied = roundCurrency(
      lossesAppliedToNonDiscountGains + lossesAppliedToDiscountGains,
    );
    summary.capitalLossCarryForward = roundCurrency(remainingLosses - lossesAppliedToDiscountGains);
    summary.discountApplied = roundCurrency(remainingDiscountGains * 0.5);
    summary.taxableGain = roundCurrency(remainingNonDiscountGains + remainingDiscountGains * 0.5);
    carriedForwardLosses = summary.capitalLossCarryForward;
  }

  const incomeYears = sortedSummaries
    .map(
      ({
        capitalLosses: _capitalLosses,
        nonDiscountGains: _nonDiscountGains,
        discountEligibleGains: _discountEligibleGains,
        ...summary
      }) => summary,
    )
    .sort((a, b) => a.incomeYear.localeCompare(b.incomeYear));
  const sortedClosedLots = [...closedLots].sort(
    (a, b) =>
      a.disposalDate.localeCompare(b.disposalDate) ||
      a.symbol.localeCompare(b.symbol) ||
      a.account.localeCompare(b.account),
  );

  return {
    closedLots: sortedClosedLots,
    incomeYears,
    unmatchedSells,
    unsupportedActivities,
    ignoredActivities,
    dividends: extractDividendTaxDetails(activities),
    transitionLots: buildTransitionLots([...lotsByAccountSymbol.values()].flat(), options),
  };
}

export function exportReportCsv(report: CgtReport): string {
  const header = [
    "incomeYear",
    "symbol",
    "account",
    "quantity",
    "acquisitionDate",
    "disposalDate",
    "proceeds",
    "costBase",
    "amitCostBaseAdjustment",
    "grossGain",
    "lotCapitalLoss",
    "preLossDiscountEstimate",
    "preLossTaxableGainEstimate",
    "method",
  ];
  const rows = report.closedLots.map((lot) =>
    [
      lot.incomeYear,
      lot.symbol,
      lot.account,
      lot.quantity,
      lot.acquisitionDate,
      lot.disposalDate,
      lot.proceeds,
      lot.costBase,
      lot.amitCostBaseAdjustment,
      lot.grossGain,
      lot.grossGain < 0 ? Math.abs(lot.grossGain) : 0,
      lot.preLossDiscountEstimate,
      lot.preLossTaxableGainEstimate,
      lot.method,
    ]
      .map((value) => `"${String(value).replaceAll('"', '""')}"`)
      .join(","),
  );

  return [header.join(","), ...rows].join("\n");
}
