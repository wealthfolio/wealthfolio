import { chartSliceColor } from "@wealthfolio/ui";

/** A category and its current value; 0 when it isn't held. */
export interface AllocationTargetColorInput {
  categoryId: string;
  currentValue: number;
}

export type AllocationTargetColorMap = ReadonlyMap<string, string>;

/**
 * Colours categories in the order the Insights donuts use, so a category keeps one colour
 * across the donuts, the target card, the target pages and the editor: the categories held,
 * largest first, then the rest by id. A category listed twice keeps its larger value.
 */
export function buildAllocationTargetColorMap(
  categories: readonly AllocationTargetColorInput[],
): AllocationTargetColorMap {
  const values = new Map<string, number>();
  for (const { categoryId, currentValue } of categories) {
    values.set(categoryId, Math.max(values.get(categoryId) ?? 0, currentValue));
  }
  const ordered = [...values].sort(([aId, a], [bId, b]) => b - a || aId.localeCompare(bId));
  return new Map(ordered.map(([categoryId], index) => [categoryId, chartSliceColor(index)]));
}

export function allocationTargetColorForRow(
  row: { categoryId: string },
  colors: AllocationTargetColorMap | undefined,
  fallbackIndex = 0,
): string {
  return colors?.get(row.categoryId) ?? chartSliceColor(fallbackIndex);
}
