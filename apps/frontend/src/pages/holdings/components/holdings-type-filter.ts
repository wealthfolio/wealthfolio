import { HoldingType } from "@/lib/constants";
import type { Holding } from "@/lib/types";

// Sentinel for the synthetic cash pseudo-type. Must not collide with a real
// instrument_type taxonomy key ("CASH" is the key of the "Cash Balance" category).
export const CASH_HOLDING_TYPE_KEY = "__CASH__";

export interface HoldingTypeFilterOption {
  value: string;
  fallbackLabel: string;
}

export function getHoldingTypeFilterValue(holding: Holding): string | undefined {
  if (holding.holdingType === HoldingType.CASH) {
    return CASH_HOLDING_TYPE_KEY;
  }

  return holding.instrument?.classifications?.assetType?.key;
}

export function getHoldingTypeFilterOption(
  holding: Holding,
  cashLabel: string,
): HoldingTypeFilterOption | undefined {
  if (holding.holdingType === HoldingType.CASH) {
    return { value: CASH_HOLDING_TYPE_KEY, fallbackLabel: cashLabel };
  }

  const assetType = holding.instrument?.classifications?.assetType;
  return assetType ? { value: assetType.key, fallbackLabel: assetType.name } : undefined;
}

export function getHoldingTypeTranslationKey(value: string): string {
  // Cash is not a taxonomy category, so it keeps its own label rather than borrowing a
  // slot in the instrument type namespace that a real category could also claim.
  return value === CASH_HOLDING_TYPE_KEY ? "holdings:cash" : `holdings:instrument_types.${value}`;
}

export function filterHoldingsByType(holdings: Holding[], selectedTypes: string[]): Holding[] {
  if (selectedTypes.length === 0) return holdings;

  const selectedTypeSet = new Set(selectedTypes);
  return holdings.filter((holding) => {
    const type = getHoldingTypeFilterValue(holding);
    return type ? selectedTypeSet.has(type) : false;
  });
}
