export interface AssetPerformanceInputs {
  holdingTotalGain: number | null;
  holdingTotalGainPercent: number | null;
  holdingTotalReturn: number | null;
  holdingTotalReturnPercent: number | null;
  holdingRealizedGain: number | null;
  holdingUnrealizedGain: number | null;
  realizedGainFromLots: number | null;
  realizedCostBasisFromLots: number;
  realizedLotsComparable: boolean;
  openCostBasis: number | null;
  holdingReturnBasis: number | null;
  income: number | null;
}

export interface AssetPerformanceTotals {
  totalPnl: number | null;
  totalPnlPercent: number | null;
  totalReturn: number | null;
  totalReturnPercent: number | null;
}

/**
 * Prefer the engine's total when it already includes realized lots. When the
 * current position and realized lots are supplied separately, combine them
 * before displaying total P&L.
 */
export function resolveAssetPerformance(inputs: AssetPerformanceInputs): AssetPerformanceTotals {
  const combineLots =
    inputs.realizedLotsComparable &&
    inputs.realizedGainFromLots != null &&
    (inputs.holdingRealizedGain == null ||
      Math.abs(inputs.holdingRealizedGain - inputs.realizedGainFromLots) > 0.01);

  if (combineLots) {
    const totalPnl = inputs.realizedGainFromLots + (inputs.holdingUnrealizedGain ?? 0);
    const totalBasis = Math.abs(
      (inputs.holdingReturnBasis ?? inputs.openCostBasis ?? 0) + inputs.realizedCostBasisFromLots,
    );
    const totalReturn = totalPnl + (inputs.income ?? 0);
    return {
      totalPnl,
      totalPnlPercent: totalBasis !== 0 ? totalPnl / totalBasis : null,
      totalReturn,
      totalReturnPercent: totalBasis !== 0 ? totalReturn / totalBasis : null,
    };
  }

  const hasBackendTotal = inputs.holdingTotalGain != null;
  const totalPnl = inputs.holdingTotalGain ?? inputs.realizedGainFromLots;
  const fallbackBasis = Math.abs(
    (inputs.holdingReturnBasis ?? inputs.openCostBasis ?? 0) +
      (hasBackendTotal ? 0 : inputs.realizedCostBasisFromLots),
  );
  return {
    totalPnl,
    totalPnlPercent:
      (hasBackendTotal ? inputs.holdingTotalGainPercent : null) ??
      (!hasBackendTotal && totalPnl != null && fallbackBasis !== 0
        ? totalPnl / fallbackBasis
        : null),
    totalReturn:
      inputs.holdingTotalReturn ?? (totalPnl != null ? totalPnl + (inputs.income ?? 0) : null),
    totalReturnPercent:
      (inputs.holdingTotalReturn != null ? inputs.holdingTotalReturnPercent : null) ??
      (inputs.holdingTotalReturn == null && totalPnl != null && fallbackBasis !== 0
        ? (totalPnl + (inputs.income ?? 0)) / fallbackBasis
        : null),
  };
}
