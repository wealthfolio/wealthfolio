import type { Holding } from "@/lib/types";

export interface EligibleHolding {
  assetId: string;
  symbol: string;
  name?: string | null;
  currency: string;
  exchangeMic?: string | null;
  instrumentType?: string | null;
  /** Accounts that hold this security. */
  accountIds: string[];
}

const GROUP_ORDER = ["EQUITY", "BOND", "CRYPTO", "OPTION", "METAL", "FX"];

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
  }
  return [...unique.values()];
}

function groupKey(row: EligibleHolding): string {
  const key = row.instrumentType?.trim().toUpperCase();
  return key && GROUP_ORDER.includes(key) ? key : "OTHER";
}

function groupSortKey(key: string): [number, string] {
  const index = GROUP_ORDER.indexOf(key);
  return [index === -1 ? GROUP_ORDER.length : index, key];
}

export function groupEligibleHoldings(
  holdings: EligibleHolding[],
): { key: string; holdings: EligibleHolding[] }[] {
  const grouped = new Map<string, EligibleHolding[]>();
  for (const holding of holdings) {
    const key = groupKey(holding);
    grouped.set(key, [...(grouped.get(key) ?? []), holding]);
  }

  return [...grouped.entries()]
    .sort(([a], [b]) => {
      const [aOrder, aName] = groupSortKey(a);
      const [bOrder, bName] = groupSortKey(b);
      return aOrder - bOrder || compareText(aName, bName);
    })
    .map(([key, rows]) => ({ key, holdings: rows }));
}
