// The theme's chart colours, as the donuts use them, then stone; categories past
// the last take stone instead of repeating the leading colours.
const CALM_PALETTE = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
  "var(--chart-7)",
  "var(--chart-8)",
  "var(--chart-stone)",
];

const NAMED_COLORS: Record<string, string> = {
  equity: "var(--chart-1)",
  fixed: "var(--chart-2)",
  cash: "var(--chart-3)",
  commodities: "var(--chart-4)",
  real: "var(--chart-4)", // real assets / real estate
  property: "var(--chart-4)",
  crypto: "var(--chart-5)",
  digital: "var(--chart-5)",
  alternatives: "var(--chart-stone)",
};

export interface AllocationTargetColorRow {
  categoryId: string;
  categoryName: string;
}

export type AllocationTargetColorMap = ReadonlyMap<string, string>;

function categoryKey(id: string, name: string): string {
  return `${id} ${name}`.toLowerCase().replace(/[\s-]+/g, "_");
}

export function allocationTargetColor(id: string, name: string, index = 0): string {
  const key = categoryKey(id, name);
  const named = Object.entries(NAMED_COLORS).find(([needle]) => key.includes(needle));
  if (named) return named[1];
  return CALM_PALETTE[Math.min(index, CALM_PALETTE.length - 1)];
}

export function buildAllocationTargetColorMap(
  rows: readonly AllocationTargetColorRow[],
): AllocationTargetColorMap {
  const colors = new Map<string, string>();

  rows.forEach((row, index) => {
    if (!colors.has(row.categoryId)) {
      colors.set(row.categoryId, allocationTargetColor(row.categoryId, row.categoryName, index));
    }
  });

  return colors;
}

export function allocationTargetColorForRow(
  row: AllocationTargetColorRow,
  colors: AllocationTargetColorMap | undefined,
  fallbackIndex = 0,
): string {
  return (
    colors?.get(row.categoryId) ??
    allocationTargetColor(row.categoryId, row.categoryName, fallbackIndex)
  );
}
