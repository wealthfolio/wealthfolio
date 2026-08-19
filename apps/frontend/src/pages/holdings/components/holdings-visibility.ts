import { HoldingType } from "@/lib/constants";
import type { Holding } from "@/lib/types";

export type HoldingsVisibilityFilter = "open" | "closed";

export const DEFAULT_HOLDINGS_VISIBILITY: HoldingsVisibilityFilter[] = ["open"];
export const HOLDINGS_VISIBILITY_STORAGE_KEY = "holdings-visibility-filters-v3";

export function getEffectiveHoldingsVisibility(
  filters: HoldingsVisibilityFilter[],
  allowClosedPositions: boolean,
): HoldingsVisibilityFilter[] {
  const selectedFilter = filters[0];
  return selectedFilter === "closed" && allowClosedPositions
    ? ["closed"]
    : [...DEFAULT_HOLDINGS_VISIBILITY];
}

export function isCashHolding(holding: Holding): boolean {
  return holding.holdingType === HoldingType.CASH;
}

export function isClosedPosition(holding: Holding): boolean {
  return !isCashHolding(holding) && (holding.isClosed ?? holding.quantity === 0);
}

export function compareCashFirst(a: Holding, b: Holding): number {
  const aIsCash = isCashHolding(a);
  const bIsCash = isCashHolding(b);
  if (aIsCash === bIsCash) return 0;
  return aIsCash ? -1 : 1;
}

export function filterHoldingsByVisibility(
  holdings: Holding[],
  filters: HoldingsVisibilityFilter[],
): Holding[] {
  const showOpen = filters.includes("open");
  const showClosed = filters.includes("closed");

  return holdings.filter((holding) => {
    if (isClosedPosition(holding)) return showClosed;
    return showOpen;
  });
}

export function hasNonDefaultHoldingsVisibility(filters: HoldingsVisibilityFilter[]): boolean {
  return filters.length !== 1 || filters[0] !== "open";
}
