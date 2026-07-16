import { QueryKeys } from "@/lib/query-keys";
import type { QueryClient } from "@tanstack/react-query";

// Cloud/network-backed queries that should NOT be refetched on a portfolio change.
const CLOUD_SYNC_INVALIDATION_EXCLUSIONS = new Set<string>([
  QueryKeys.BROKER_CONNECTIONS,
  QueryKeys.BROKER_ACCOUNTS,
  QueryKeys.BROKER_SYNC_STATES,
  QueryKeys.IMPORT_RUNS,
  QueryKeys.USER_INFO,
  QueryKeys.SUBSCRIPTION_PLANS,
  QueryKeys.SUBSCRIPTION_PLANS_PUBLIC,
  QueryKeys.SYNCED_ACCOUNTS,
  QueryKeys.PLATFORMS,
]);

/**
 * Predicate for invalidating caches after a portfolio change (recalc, or
 * including/excluding an account). Invalidates everything except cloud/broker/
 * subscription queries that have their own lifecycle.
 */
export function shouldInvalidateAfterPortfolioUpdate(queryKey: readonly unknown[]): boolean {
  const rootKey = queryKey[0];

  if (typeof rootKey === "string" && CLOUD_SYNC_INVALIDATION_EXCLUSIONS.has(rootKey)) {
    return false;
  }

  if (rootKey === "sync") {
    return false;
  }

  return true;
}

export interface AssetClassificationsChangedPayload {
  assetIds?: string[];
  taxonomyIds?: string[];
}

export function invalidateAfterAssetClassificationsChanged(
  queryClient: QueryClient,
  payload?: AssetClassificationsChangedPayload | null,
) {
  const assetIds = Array.isArray(payload?.assetIds) ? payload.assetIds : [];

  if (assetIds.length > 0) {
    for (const assetId of assetIds) {
      queryClient.invalidateQueries({
        queryKey: QueryKeys.assetTaxonomyAssignments(assetId),
      });
    }
  } else {
    queryClient.invalidateQueries({
      queryKey: [QueryKeys.ASSET_TAXONOMY_ASSIGNMENTS],
    });
  }

  queryClient.invalidateQueries({ queryKey: [QueryKeys.PORTFOLIO_ALLOCATIONS] });
  queryClient.invalidateQueries({ queryKey: [QueryKeys.HOLDINGS] });
  queryClient.invalidateQueries({ queryKey: [QueryKeys.HOLDINGS_BY_ALLOCATION] });
  queryClient.invalidateQueries({ queryKey: [QueryKeys.ALLOCATION_TARGET_DRIFT] });
  queryClient.invalidateQueries({ queryKey: [QueryKeys.HEALTH_STATUS] });
}
