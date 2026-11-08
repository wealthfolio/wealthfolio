import type { Holding } from "@/lib/types";
import { subtractAmounts } from "./monetary-value";

export type HoldingPerformanceMetric =
  | "unrealizedGain"
  | "realizedGain"
  | "totalGain"
  | "totalReturn";

export type HoldingPerformanceMode = "daily" | "unrealized" | "pnl" | "return";

type HoldingPerformanceValues = Pick<
  Holding,
  "costBasis" | "unrealizedGain" | "realizedGain" | "totalGain" | "totalReturn" | "returnBasis"
>;

type HoldingPerformanceModeValues = HoldingPerformanceValues & Pick<Holding, "dayChangePct">;

function percentFromBasis(amount: number | null, basis: number | null): number | null {
  if (amount == null || basis == null) return null;
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
    const disposedBasis = subtractAmounts(holding.returnBasis.base, holding.costBasis?.base);
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
  if (mode === "unrealized") {
    return getBaseHoldingPerformancePercent(holding, "unrealizedGain");
  }
  if (mode === "daily") return holding.dayChangePct ?? null;
  if (mode === "return") {
    return getBaseHoldingPerformancePercent(holding, "totalReturn");
  }
  return getBaseHoldingPerformancePercent(holding, "totalGain");
}
