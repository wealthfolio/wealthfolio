export interface AssetPerformanceInputs {
  holdingTotalGain: number | null;
  holdingTotalGainPercent: number | null;
  holdingTotalReturn: number | null;
  holdingRealizedGain: number | null;
  holdingUnrealizedGain: number | null;
  realizedGainFromLots: number | null;
  realizedCostBasisFromLots: number;
  openCostBasis: number | null;
  income: number | null;
}

export interface AssetPerformanceTotals {
  totalPnl: number | null;
  totalPnlPercent: number | null;
  totalReturn: number | null;
}

/**
 * Prefer the engine's total when it already includes realized lots. When the
 * current holding is open and realized lots are supplied separately, combine
 * them with the open unrealized result before displaying total P&L.
 */
export function resolveAssetPerformance(inputs: AssetPerformanceInputs): AssetPerformanceTotals {
  const backendIncludesLots =
    inputs.realizedGainFromLots == null ||
    (inputs.holdingRealizedGain != null &&
      Math.abs(inputs.holdingRealizedGain - inputs.realizedGainFromLots) <= 0.01);
  const combineLots =
    !backendIncludesLots &&
    inputs.realizedGainFromLots != null &&
    inputs.holdingUnrealizedGain != null;

  if (combineLots) {
    const totalPnl = inputs.realizedGainFromLots + inputs.holdingUnrealizedGain;
    const totalBasis = (inputs.openCostBasis ?? 0) + inputs.realizedCostBasisFromLots;
    return {
      totalPnl,
      totalPnlPercent: totalBasis > 0 ? totalPnl / totalBasis : null,
      totalReturn: totalPnl + (inputs.income ?? 0),
    };
  }

  const totalPnl = inputs.holdingTotalGain ?? inputs.realizedGainFromLots;
  return {
    totalPnl,
    totalPnlPercent:
      inputs.holdingTotalGainPercent ??
      (totalPnl != null && (inputs.openCostBasis ?? 0) > 0
        ? totalPnl / (inputs.openCostBasis ?? 0)
        : null),
    totalReturn:
      inputs.holdingTotalReturn ?? (totalPnl != null ? totalPnl + (inputs.income ?? 0) : null),
  };
}
