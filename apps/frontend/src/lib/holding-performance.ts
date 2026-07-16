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
