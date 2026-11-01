import type { DriftReport, Holding } from "@/lib/types";

export interface EligibleHolding {
  assetId: string;
  symbol: string;
  name?: string | null;
  currency: string;
  exchangeMic?: string | null;
  instrumentType?: string | null;
  /** Accounts that hold this security. */
  accountIds: string[];
  /** What it is worth across those accounts, in the base currency. */
  value: number;
}

function compareText(a: string, b: string): number {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  return left < right ? -1 : left > right ? 1 : 0;
}

export function getEligibleHoldings(holdings: Holding[]): EligibleHolding[] {
  const rows = holdings
    .filter((holding) => holding.holdingType.toLowerCase() !== "cash")
    .flatMap((holding): EligibleHolding[] => {
      const instrument = holding.instrument;
      if (!instrument?.id) return [];
      return [
        {
          assetId: instrument.id,
          symbol: instrument.symbol,
          name: instrument.name,
          currency: instrument.currency,
          exchangeMic: instrument.exchangeMic,
          instrumentType: instrument.instrumentType,
          accountIds: [holding.accountId],
          value: holding.marketValue?.base ?? 0,
        },
      ];
    })
    .sort(
      (a, b) =>
        compareText(a.symbol, b.symbol) ||
        compareText(a.name ?? "", b.name ?? "") ||
        compareText(a.assetId, b.assetId),
    );

  // The same security can sit in several accounts. It is one choice, so the
  // rows merge and keep every account it is held in.
  const unique = new Map<string, EligibleHolding>();
  for (const row of rows) {
    const existing = unique.get(row.assetId);
    if (!existing) {
      unique.set(row.assetId, row);
      continue;
    }
    for (const accountId of row.accountIds) {
      if (!existing.accountIds.includes(accountId)) existing.accountIds.push(accountId);
    }
    existing.value += row.value;
  }
  return [...unique.values()];
}

export interface TargetCategories {
  /** The target's categories, below target first. */
  order: readonly { id: string; name: string; color?: string; isBelowTarget: boolean }[];
  /** The categories each security counts towards, keyed by asset, its largest share first. */
  byAsset: ReadonlyMap<string, readonly string[]>;
}

/** The categories each security counts towards, its largest share first. */
export function categoriesByAsset(
  rows: NonNullable<DriftReport["holdings"]>["rows"],
): Map<string, string[]> {
  const values = new Map<string, Map<string, number>>();
  for (const row of rows) {
    // Unknown is a category like any other here: the calculation reduces what
    // it holds when it sits above its target of nothing.
    if (row.isCash) continue;
    const byCategory = values.get(row.assetId) ?? new Map<string, number>();
    byCategory.set(row.categoryId, (byCategory.get(row.categoryId) ?? 0) + row.value);
    values.set(row.assetId, byCategory);
  }
  return new Map(
    [...values].map(([assetId, byCategory]) => [
      assetId,
      [...byCategory].sort((left, right) => right[1] - left[1]).map(([categoryId]) => categoryId),
    ]),
  );
}
