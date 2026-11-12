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
  holdings: (Holding & { marketValue: { local: number | null; base: number } })[];
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
  const valued = investments.filter(
    (holding): holding is Holding & { marketValue: { local: number | null; base: number } } =>
      holding.marketValue.base != null,
  );
  const total = valued.reduce((sum, holding) => sum + holding.marketValue.base, 0);
  if (!Number.isFinite(total) || total <= 0) return null;
  const largest = valued
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

export const HOLDINGS_DONUT_MAX_SLICES = 7;

export type HoldingsDonutSlice =
  | { kind: "holding"; id: string; value: number; weight: number; holding: Holding }
  | { kind: "other"; id: "other"; value: number; weight: number; count: number }
  | { kind: "cash"; id: "cash"; value: number; weight: number; currencies: string[] };

export interface HoldingsDonut {
  slices: HoldingsDonutSlice[];
  total: number;
  holdingCount: number;
}

/**
 * Splits portfolio value into the largest holdings, the remaining holdings as one
 * "Other" slice, and cash. Weights share the Concentration card's base, so the two
 * cards agree. Returns null when a value is missing or negative, since a donut
 * cannot show a short position or a negative cash balance.
 */
export function getHoldingsDonut(
  holdings: Holding[],
  maxSlices = HOLDINGS_DONUT_MAX_SLICES,
): HoldingsDonut | null {
  const concentration = getConcentration(holdings);
  if (!concentration) return null;
  const { total } = concentration;
  const valued = holdings
    .filter(isInvestmentHolding)
    .map((holding) => ({ holding, value: holding.marketValue?.base ?? 0 }));
  const cashHoldings = valued.filter(({ holding }) => holding.holdingType === HoldingType.CASH);
  const cash = cashHoldings.reduce((sum, { value }) => sum + value, 0);
  const currencies = [
    ...new Set(
      cashHoldings.filter(({ value }) => value > 0).map(({ holding }) => holding.localCurrency),
    ),
  ];
  const positions = valued
    .filter(({ holding, value }) => holding.holdingType !== HoldingType.CASH && value > 0)
    .sort((a, b) => b.value - a.value);
  // A lone leftover holding is shown by name rather than as a one-item "Other".
  const shown = positions.length === maxSlices + 1 ? positions : positions.slice(0, maxSlices);
  const rest = positions.slice(shown.length);
  const slice = (value: number) => ({ value, weight: value / total });
  const slices: HoldingsDonutSlice[] = shown.map(({ holding, value }) => ({
    kind: "holding",
    id: holding.id,
    holding,
    ...slice(value),
  }));
  const restValue = rest.reduce((sum, { value }) => sum + value, 0);
  if (restValue > 0)
    slices.push({ kind: "other", id: "other", count: rest.length, ...slice(restValue) });
  if (cash > 0) slices.push({ kind: "cash", id: "cash", currencies, ...slice(cash) });
  return { slices, total, holdingCount: positions.length };
}

export interface ChipBox {
  /** Distance of chip centres from the chart centre. */
  radius: number;
  width: number;
  height: number;
}

function chipCentre(radius: number, degrees: number) {
  const radians = ((degrees - 90) * Math.PI) / 180;
  return { x: radius * Math.cos(radians), y: radius * Math.sin(radians) };
}

/**
 * Nudges chip angles apart until neighbouring chip boxes stop overlapping, keeping
 * their clockwise order. Chips beside the ring stack vertically, so they need less
 * angle than chips above or below it, which sit side by side.
 */
export function spreadChipAngles(
  angles: number[],
  box: ChipBox = { radius: 42, width: 24, height: 11 },
) {
  const spread = [...angles];
  if (spread.length < 2) return spread;
  const overlaps = (a: number, b: number) => {
    const first = chipCentre(box.radius, a);
    const second = chipCentre(box.radius, b);
    return Math.abs(first.x - second.x) < box.width && Math.abs(first.y - second.y) < box.height;
  };
  for (let pass = 0; pass < 400; pass += 1) {
    let moved = false;
    for (let index = 0; index < spread.length; index += 1) {
      const next = (index + 1) % spread.length;
      const nextAngle = spread[next] + (next === 0 ? 360 : 0);
      // Stop at an even split: a full ring has no room left to separate them.
      if (nextAngle - spread[index] >= 360 / spread.length) continue;
      if (overlaps(spread[index], nextAngle)) {
        spread[index] -= 0.5;
        spread[next] += 0.5;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return spread;
}
