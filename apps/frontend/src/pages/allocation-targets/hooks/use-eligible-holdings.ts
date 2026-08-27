import { useEffect, useMemo, useState } from "react";
import { canonicalizeEligibleAssetIds } from "@/adapters";
import type { Holding } from "@/lib/types";
import { getEligibleHoldings, type EligibleHolding } from "../components/eligible-holdings";

const EMPTY_EXCLUSIONS = new Set<string>();

export interface EligibleHoldingsSelection {
  eligibleHoldings: EligibleHolding[];
  excludedAssetIds: ReadonlySet<string>;
  selectedAssetIds: string[];
  eligibleAssetIds?: string[];
  hasEligibleHoldings: boolean;
  toggle: (assetId: string) => void;
  selectAll: () => void;
  clear: () => void;
}

export function useEligibleHoldingsSelection(
  holdings: Holding[],
  contextKey: string,
): EligibleHoldingsSelection {
  const eligibleHoldings = useMemo(() => getEligibleHoldings(holdings), [holdings]);
  const availableAssetIds = useMemo(
    () => new Set(eligibleHoldings.map((holding) => holding.assetId)),
    [eligibleHoldings],
  );
  const [selection, setSelection] = useState(() => ({
    contextKey,
    excludedAssetIds: EMPTY_EXCLUSIONS,
  }));

  useEffect(() => {
    setSelection((current) =>
      current.contextKey === contextKey
        ? current
        : { contextKey, excludedAssetIds: EMPTY_EXCLUSIONS },
    );
  }, [contextKey]);

  useEffect(() => {
    setSelection((current) => {
      if (current.contextKey !== contextKey) return current;
      const next = new Set(
        [...current.excludedAssetIds].filter((assetId) => availableAssetIds.has(assetId)),
      );
      if (
        next.size === current.excludedAssetIds.size &&
        [...next].every((assetId) => current.excludedAssetIds.has(assetId))
      ) {
        return current;
      }
      return { contextKey, excludedAssetIds: next };
    });
  }, [availableAssetIds, contextKey]);

  const excludedAssetIds =
    selection.contextKey === contextKey ? selection.excludedAssetIds : EMPTY_EXCLUSIONS;
  const selectedAssetIds = useMemo(
    () =>
      eligibleHoldings
        .map((holding) => holding.assetId)
        .filter((assetId) => !excludedAssetIds.has(assetId)),
    [eligibleHoldings, excludedAssetIds],
  );
  const eligibleAssetIds =
    selectedAssetIds.length === eligibleHoldings.length && eligibleHoldings.length > 0
      ? undefined
      : canonicalizeEligibleAssetIds(selectedAssetIds);

  function toggle(assetId: string) {
    setSelection((current) => {
      const next = new Set(
        current.contextKey === contextKey ? current.excludedAssetIds : EMPTY_EXCLUSIONS,
      );
      if (next.has(assetId)) next.delete(assetId);
      else next.add(assetId);
      return { contextKey, excludedAssetIds: next };
    });
  }

  return {
    eligibleHoldings,
    excludedAssetIds,
    selectedAssetIds,
    eligibleAssetIds,
    hasEligibleHoldings: selectedAssetIds.length > 0,
    toggle,
    selectAll: () => setSelection({ contextKey, excludedAssetIds: EMPTY_EXCLUSIONS }),
    clear: () => setSelection({ contextKey, excludedAssetIds: availableAssetIds }),
  };
}
