import { generateCalculatedAdjustments } from "@/adapters";
import type { AccountScope, AllocationRule, WorksheetCashInput, WorksheetMode } from "@/lib/types";
import { useMutation } from "@tanstack/react-query";

export interface CalculatedAdjustmentsRequest {
  targetId: string;
  filter: AccountScope;
  mode: WorksheetMode;
  rule: AllocationRule;
  cash: WorksheetCashInput;
  /** Accounts the worksheet may change. */
  selectedAccountIds: readonly string[];
  /** Omitted means every recorded security. An empty list is a valid selection. */
  eligibleAssetIds?: readonly string[];
}

/**
 * Generates the calculated adjustments the worksheet is prefilled with.
 *
 * A mutation rather than a query on purpose: adjustments are regenerated only on
 * an explicit user action (§5), never because an input changed.
 */
export function useCalculatedAdjustments() {
  return useMutation({
    mutationFn: ({
      targetId,
      filter,
      mode,
      rule,
      cash,
      selectedAccountIds,
      eligibleAssetIds,
    }: CalculatedAdjustmentsRequest) =>
      generateCalculatedAdjustments(
        targetId,
        mode,
        rule,
        cash,
        selectedAccountIds,
        filter,
        eligibleAssetIds,
      ),
  });
}
