import { HoldingType, isAlternativeAssetKind } from "@/lib/constants";
import { INDIVIDUAL_SECURITIES_TAXONOMY_ID } from "@/lib/types";
import type { Asset, Holding, TaxonomyCategory } from "@/lib/types";

/** One selectable security of an individual securities target. */
export interface SecurityTargetRow {
  assetId: string;
  /** The label the editor shows. */
  name: string;
  /** What is held across the scope, in the base currency; 0 when only the target names it. */
  value: number;
}

/**
 * The securities a target can weigh: those held, without cash and alternative
 * assets, then those the saved target already names. The asset id doubles as
 * the category id, as the drift report does for an asset target.
 */
export function buildSecurityTargetRows(
  holdings: readonly Holding[],
  savedAssetIds: readonly string[],
  assets: readonly Asset[],
): SecurityTargetRow[] {
  const rows = new Map<string, SecurityTargetRow>();
  for (const holding of holdings) {
    const instrument = holding.instrument;
    if (holding.holdingType !== HoldingType.SECURITY || holding.isClosed || !instrument?.id) {
      continue;
    }
    if (holding.assetKind && isAlternativeAssetKind(holding.assetKind)) continue;
    const row = rows.get(instrument.id) ?? {
      assetId: instrument.id,
      name: instrument.symbol || instrument.name || instrument.id,
      value: 0,
    };
    row.value += Number(holding.marketValue?.base) || 0;
    rows.set(instrument.id, row);
  }

  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  for (const assetId of savedAssetIds) {
    if (rows.has(assetId)) continue;
    const asset = assetById.get(assetId);
    rows.set(assetId, {
      assetId,
      name: asset?.displayCode || asset?.instrumentSymbol || asset?.name || assetId,
      value: 0,
    });
  }

  return [...rows.values()].sort(
    (left, right) => right.value - left.value || left.name.localeCompare(right.name),
  );
}

/** The rows as the categories `TargetWeightEditor` takes. */
export function securityTargetCategories(rows: readonly SecurityTargetRow[]): TaxonomyCategory[] {
  return rows.map((row, sortOrder) => ({
    id: row.assetId,
    taxonomyId: INDIVIDUAL_SECURITIES_TAXONOMY_ID,
    parentId: null,
    name: row.name,
    key: row.assetId,
    color: "",
    sortOrder,
    createdAt: "",
    updatedAt: "",
  }));
}

/** Each security's share of the securities held, as a percentage 0-100. */
export function securityCurrentAllocation(
  rows: readonly SecurityTargetRow[],
): Record<string, number> {
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  return Object.fromEntries(
    rows.map((row) => [row.assetId, total > 0 ? (row.value / total) * 100 : 0]),
  );
}

/** Splits 100% evenly in basis points; the remainder goes to the last row (3 rows: 3333, 3333, 3334). */
export function equalWeightBps(count: number): number[] {
  if (count <= 0) return [];
  const share = Math.floor(10000 / count);
  return Array.from({ length: count }, (_, index) =>
    index === count - 1 ? 10000 - share * (count - 1) : share,
  );
}
