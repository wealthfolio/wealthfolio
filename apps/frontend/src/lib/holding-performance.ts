import type { Holding } from "@/lib/types";

export type HoldingPerformanceMetric =
  | "unrealizedGain"
  | "realizedGain"
  | "totalGain"
  | "totalReturn";

export type HoldingPerformanceMode = "daily" | "pnl" | "return";

type HoldingPerformanceValues = Pick<
  Holding,
  "costBasis" | "unrealizedGain" | "realizedGain" | "totalGain" | "totalReturn" | "returnBasis"
>;

type HoldingPerformanceModeValues = HoldingPerformanceValues & Pick<Holding, "dayChangePct">;

function percentFromBasis(amount: number, basis: number): number | null {
  const exposure = Math.abs(basis);
  if (exposure > 0) return amount / exposure;
  return amount === 0 ? 0 : null;
}

/** Returns the FX-inclusive performance percentage for a base-currency amount. */
export function getBaseHoldingPerformancePercent(
  holding: HoldingPerformanceValues,
  metric: HoldingPerformanceMetric,
): number | null {
  if (metric === "unrealizedGain") {
    if (holding.unrealizedGain == null || holding.costBasis == null) return null;
    return percentFromBasis(holding.unrealizedGain.base, holding.costBasis.base);
  }

  if (metric === "realizedGain") {
    if (holding.realizedGain == null || holding.returnBasis == null) return null;
    const disposedBasis = holding.returnBasis.base - (holding.costBasis?.base ?? 0);
    return percentFromBasis(holding.realizedGain.base, disposedBasis);
  }

  const amount = metric === "totalReturn" ? holding.totalReturn : holding.totalGain;
  if (amount == null || holding.returnBasis == null) return null;
  return percentFromBasis(amount.base, holding.returnBasis.base);
}

/** Selects the percentage matching base-currency values for a performance mode. */
export function getBaseHoldingPerformancePercentForMode(
  holding: HoldingPerformanceModeValues,
  mode: HoldingPerformanceMode,
): number | null {
  if (mode === "daily") return holding.dayChangePct ?? null;
  if (mode === "return") {
    return (
      getBaseHoldingPerformancePercent(holding, "totalReturn") ??
      getBaseHoldingPerformancePercent(holding, "totalGain")
    );
  }
  return (
    getBaseHoldingPerformancePercent(holding, "totalGain") ??
    getBaseHoldingPerformancePercent(holding, "unrealizedGain")
  );
}

/**
 * Computes the annualized return from a percentage return and a duration/openDate.
 *
 * Formula: (1 + returnPct) ^ (365.25 / days) - 1
 */
export function computeAnnualizedReturn(
  returnPct: number | null | undefined,
  openDate: string | Date | null | undefined,
  endDate?: string | Date | null,
): number | null {
  if (returnPct == null || openDate == null) return null;

  const openMs = typeof openDate === "string" ? new Date(openDate).getTime() : openDate.getTime();
  if (Number.isNaN(openMs)) return null;

  const endMs = endDate
    ? typeof endDate === "string"
      ? new Date(endDate).getTime()
      : endDate.getTime()
    : Date.now();
  if (Number.isNaN(endMs)) return null;

  const days = (endMs - openMs) / (1000 * 60 * 60 * 24);
  if (days < 2) return null;

  const years = days / 365.25;
  const base = 1 + returnPct;

  // Protect against negative base (total loss > 100%) — undefined for power
  if (base <= 0) return null;

  return Math.pow(base, 1 / years) - 1;
}

export interface DatedCashFlow {
  date: string | Date;
  amount: number;
}

/**
 * Standard XIRR solver for dated cash flows using bisection.
 * Returns the annualized Internal Rate of Return (IRR / TRI).
 */
export function computeXirr(cashFlows: DatedCashFlow[]): number | null {
  if (!cashFlows || cashFlows.length < 2) return null;

  const validFlows = cashFlows
    .map((cf) => ({
      timestamp: typeof cf.date === "string" ? new Date(cf.date).getTime() : cf.date.getTime(),
      amount: Number(cf.amount),
    }))
    .filter((cf) => !Number.isNaN(cf.timestamp) && Number.isFinite(cf.amount) && cf.amount !== 0)
    .sort((a, b) => a.timestamp - b.timestamp);

  if (validFlows.length < 2) return null;

  const hasPositive = validFlows.some((cf) => cf.amount > 0);
  const hasNegative = validFlows.some((cf) => cf.amount < 0);
  if (!hasPositive || !hasNegative) return null;

  const originTime = validFlows[0].timestamp;
  const lastTime = validFlows[validFlows.length - 1].timestamp;
  const totalDays = (lastTime - originTime) / (1000 * 60 * 60 * 24);
  if (totalDays < 2) return null;

  const npv = (rate: number): number | null => {
    if (rate <= -0.999999999) return null;
    const base = 1 + rate;
    let total = 0;
    for (const flow of validFlows) {
      const years = (flow.timestamp - originTime) / (1000 * 60 * 60 * 24 * 365.25);
      total += flow.amount / Math.pow(base, years);
    }
    return Number.isFinite(total) ? total : null;
  };

  let low = -0.999999;
  let high = 10.0;
  let npvLow = npv(low);
  if (npvLow == null) return null;
  let npvHigh = npv(high);

  let expanded = 0;
  while (npvHigh != null && Math.sign(npvLow) === Math.sign(npvHigh) && expanded < 16) {
    high *= 2;
    npvHigh = npv(high);
    expanded++;
  }

  if (npvHigh == null || Math.sign(npvLow) === Math.sign(npvHigh)) {
    return null;
  }

  for (let iter = 0; iter < 128; iter++) {
    const mid = (low + high) / 2;
    const npvMid = npv(mid);
    if (npvMid == null) return null;

    if (Math.abs(npvMid) < 1e-7 || Math.abs(high - low) < 1e-10) {
      return mid;
    }

    if (Math.sign(npvLow) === Math.sign(npvMid)) {
      low = mid;
      npvLow = npvMid;
    } else {
      high = mid;
    }
  }

  return (low + high) / 2;
}

export interface PerformanceMetrics {
  twr: number | null;
  annualizedTwr: number | null;
  displayTwr: number | null;
  twrLabelKey: "twr" | "annualized_twr";

  irr: number | null;
  annualizedIrr: number | null;
  displayIrr: number | null;
  irrLabelKey: "irr" | "annualized_irr";

  daysHeld: number | null;
  isAnnualized: boolean;
}

/**
 * Computes TWR and IRR metrics for a holding or lot following the standard rule:
 * - Periods under 1 year (365 days) are shown as selected-period returns (TWR / IRR).
 * - Periods of 1 year or longer are shown annualized (Annualized TWR / Annualized IRR).
 */
export function computeHoldingPerformance({
  totalReturnPct,
  openDate,
  endDate,
  cashFlows,
}: {
  totalReturnPct: number | null | undefined;
  openDate: string | Date | null | undefined;
  endDate?: string | Date | null;
  cashFlows?: DatedCashFlow[];
}): PerformanceMetrics {
  const openMs = openDate
    ? typeof openDate === "string"
      ? new Date(openDate).getTime()
      : openDate.getTime()
    : NaN;

  const endMs = endDate
    ? typeof endDate === "string"
      ? new Date(endDate).getTime()
      : endDate.getTime()
    : Date.now();

  const daysHeld =
    !Number.isNaN(openMs) && !Number.isNaN(endMs) && endMs >= openMs
      ? (endMs - openMs) / (1000 * 60 * 60 * 24)
      : null;

  const isAnnualized = daysHeld != null && daysHeld >= 365;

  const twr = totalReturnPct != null && Number.isFinite(totalReturnPct) ? totalReturnPct : null;
  const annualizedTwr = computeAnnualizedReturn(twr, openDate, endDate);
  const displayTwr = isAnnualized && annualizedTwr != null ? annualizedTwr : twr;
  const twrLabelKey = isAnnualized ? "annualized_twr" : "twr";

  // Calculate IRR (TRI)
  let calculatedAnnualizedIrr: number | null = null;
  if (cashFlows && cashFlows.length >= 2) {
    calculatedAnnualizedIrr = computeXirr(cashFlows);
  }

  const annualizedIrr = calculatedAnnualizedIrr ?? annualizedTwr;

  let periodIrr: number | null = null;
  if (annualizedIrr != null && daysHeld != null && daysHeld >= 2) {
    const years = daysHeld / 365.25;
    const base = 1 + annualizedIrr;
    if (base > 0) {
      periodIrr = Math.pow(base, years) - 1;
    }
  } else {
    periodIrr = twr;
  }

  const displayIrr = isAnnualized && annualizedIrr != null ? annualizedIrr : (periodIrr ?? twr);
  const irrLabelKey = isAnnualized ? "annualized_irr" : "irr";

  return {
    twr,
    annualizedTwr,
    displayTwr,
    twrLabelKey,
    irr: periodIrr,
    annualizedIrr,
    displayIrr,
    irrLabelKey,
    daysHeld,
    isAnnualized,
  };
}
