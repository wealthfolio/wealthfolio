import { HoldingType, isAlternativeAssetKind } from "@/lib/constants";
import type { Holding } from "@/lib/types";

function isInvestmentHolding(holding: Holding): boolean {
  return !holding.assetKind || !isAlternativeAssetKind(holding.assetKind);
}

export function getTopMovers(holdings: Holding[], mode: "amount" | "percent") {
  const metric = (holding: Holding) =>
    mode === "amount" ? holding.dayChange?.base : holding.dayChangePct;
  const ranked = holdings
    .filter(
      (holding) =>
        holding.holdingType === HoldingType.SECURITY &&
        isInvestmentHolding(holding) &&
        holding.instrument?.id &&
        metric(holding) != null &&
        Number.isFinite(metric(holding)) &&
        metric(holding) !== 0,
    )
    .sort((a, b) => metric(b)! - metric(a)!);
  return {
    gainers: ranked.filter((holding) => metric(holding)! > 0).slice(0, 3),
    losers: ranked
      .filter((holding) => metric(holding)! < 0)
      .reverse()
      .slice(0, 3),
  };
}

export interface Concentration {
  holdings: Holding[];
  total: number;
  topFiveWeight: number;
  largestWeight: number;
}

export function getConcentration(holdings: Holding[]): Concentration | null {
  const investments = holdings.filter(isInvestmentHolding);
  if (
    investments.some(
      (holding) =>
        holding.marketValue?.base == null ||
        !Number.isFinite(holding.marketValue.base) ||
        holding.marketValue.base < 0,
    )
  )
    return null;
  const total = investments.reduce((sum, holding) => sum + holding.marketValue.base, 0);
  if (!Number.isFinite(total) || total <= 0) return null;
  const largest = investments
    .filter(
      (holding) => holding.holdingType === HoldingType.SECURITY && holding.marketValue.base > 0,
    )
    .sort((a, b) => b.marketValue.base - a.marketValue.base)
    .slice(0, 5);
  return {
    holdings: largest,
    total,
    topFiveWeight: largest.reduce((sum, holding) => sum + holding.marketValue.base, 0) / total,
    largestWeight: (largest[0]?.marketValue.base ?? 0) / total,
  };
}
