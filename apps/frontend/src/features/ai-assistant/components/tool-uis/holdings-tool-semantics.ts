import { sumAmounts } from "@/lib/monetary-value";

export type ReturnType = "daily" | "pnl" | "return";

interface BaseHoldingPerformanceAmounts {
  costBasisBase?: number | null;
  totalGainBase?: number | null;
  totalReturnBase?: number | null;
  returnBasisBase?: number | null;
}

export interface BasePortfolioPerformance {
  totalPnl: number | null;
  totalPnlPct: number | null;
  totalReturn: number | null;
  totalReturnPct: number | null;
}

interface DailyHoldingPerformanceAmounts {
  dayChangePct?: number | null;
  marketValueBase: number | null;
}

export interface DailyPortfolioPerformance {
  changeAmount: number | null;
  changePct: number | null;
}

function percentageFromGrossBasis(amount: number, grossBasis: number): number | null {
  if (grossBasis > 0) return amount / grossBasis;
  return amount === 0 ? 0 : null;
}

export function calculateBasePortfolioPerformance(
  holdings: BaseHoldingPerformanceAmounts[],
): BasePortfolioPerformance {
  let basis = 0;
  let totalPnl = 0;
  let totalReturn = 0;
  let hasUnbasedPnl = false;
  let hasUnbasedReturn = false;
  const knownPnl = sumAmounts(holdings.map((holding) => holding.totalGainBase));
  const knownReturn = sumAmounts(holdings.map((holding) => holding.totalReturnBase));
  const missingBasis = holdings.some(
    (holding) =>
      (holding.returnBasisBase === undefined ? holding.costBasisBase : holding.returnBasisBase) ==
      null,
  );

  holdings.forEach((holding) => {
    const holdingBasis = Math.abs(holding.returnBasisBase ?? holding.costBasisBase ?? 0);
    const holdingPnl = holding.totalGainBase ?? 0;
    const holdingReturn = holding.totalReturnBase ?? 0;

    basis += holdingBasis;
    totalPnl += holdingPnl;
    totalReturn += holdingReturn;
    hasUnbasedPnl ||= holdingBasis === 0 && holdingPnl !== 0;
    hasUnbasedReturn ||= holdingBasis === 0 && holdingReturn !== 0;
  });

  return {
    totalPnl: knownPnl,
    totalPnlPct:
      knownPnl == null || missingBasis || hasUnbasedPnl
        ? null
        : percentageFromGrossBasis(totalPnl, basis),
    totalReturn: knownReturn,
    totalReturnPct:
      knownReturn == null || missingBasis || hasUnbasedReturn
        ? null
        : percentageFromGrossBasis(totalReturn, basis),
  };
}

export function calculateDailyPortfolioPerformance(
  holdings: DailyHoldingPerformanceAmounts[],
): DailyPortfolioPerformance {
  if (holdings.some((holding) => holding.marketValueBase == null || holding.dayChangePct == null)) {
    return { changeAmount: null, changePct: null };
  }
  let grossExposure = 0;
  let changeAmount = 0;
  let hasDailyPerformance = false;

  holdings.forEach((holding) => {
    if (holding.dayChangePct == null || holding.marketValueBase == null) return;

    const exposure = Math.abs(holding.marketValueBase);
    hasDailyPerformance = true;
    grossExposure += exposure;
    changeAmount += exposure * holding.dayChangePct;
  });

  return {
    changeAmount,
    changePct: grossExposure > 0 ? changeAmount / grossExposure : hasDailyPerformance ? 0 : null,
  };
}

export function getPortfolioChangePercent(
  returnType: ReturnType,
  dailyChangePct: number | null,
  totalPnlPct: number | null,
  totalReturnPct: number | null,
): number | null {
  if (returnType === "daily") return dailyChangePct;
  return returnType === "return" ? totalReturnPct : totalPnlPct;
}
