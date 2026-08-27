import { useQuery } from "@tanstack/react-query";
import { calculateRebalancePlan, canonicalizeEligibleAssetIds } from "@/adapters";
import { accountScopeKey } from "../components/target-scope";
import type { AccountScope, RebalancePlan, ScenarioMode } from "@/lib/types";

export interface RebalancePlanParams {
  targetId: string;
  /** Cash to deploy (the editable amount). */
  cash: number;
  filter: AccountScope;
  scenarioMode: ScenarioMode;
  /** Snapshot of the portfolio source (available cash + holdings version) at calc time, for staleness detection. */
  sourceKey: string;
  /** Canonical optional allowlist of asset IDs eligible for buys. */
  eligibleAssetIds?: readonly string[];
}

export interface CachedRebalancePlan {
  plan: RebalancePlan;
  sourceKey: string;
}

/**
 * Caches a calculated rebalance plan keyed by its user-controlled inputs.
 * Never fetches automatically — the caller triggers it via `refetch()` (the
 * "Calculate / Recalculate" button). The cached plan survives unmount, so
 * navigating away from the rebalance view and back shows it without recomputing.
 */
export function useRebalancePlan(params: RebalancePlanParams) {
  const eligibleAssetIds = canonicalizeEligibleAssetIds(params.eligibleAssetIds);

  return useQuery({
    queryKey: [
      "rebalance-plan",
      params.targetId,
      accountScopeKey(params.filter),
      params.scenarioMode,
      params.cash,
      eligibleAssetIds ?? null,
    ],
    queryFn: async (): Promise<CachedRebalancePlan> => {
      const plan = await calculateRebalancePlan(
        params.targetId,
        params.cash,
        params.filter,
        params.scenarioMode,
        eligibleAssetIds,
      );
      return { plan, sourceKey: params.sourceKey };
    },
    enabled: false,
    staleTime: Infinity,
    gcTime: 30 * 60 * 1000,
  });
}
