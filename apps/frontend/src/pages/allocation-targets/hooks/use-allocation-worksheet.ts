import { calculateAllocationWorksheet } from "@/adapters";
import type { AccountScope, AllocationWorksheetLineInput, WorksheetCashInput } from "@/lib/types";
import { useMutation } from "@tanstack/react-query";

export interface AllocationWorksheetRequest {
  targetId: string;
  filter: AccountScope;
  cash: WorksheetCashInput;
  lines: AllocationWorksheetLineInput[];
  /** Accounts the worksheet may change. */
  selectedAccountIds: readonly string[];
}

/** Validates the edited worksheet and projects it. It never regenerates the adjustments. */
export function useAllocationWorksheet() {
  return useMutation({
    mutationFn: ({
      targetId,
      filter,
      cash,
      lines,
      selectedAccountIds,
    }: AllocationWorksheetRequest) =>
      calculateAllocationWorksheet(targetId, cash, lines, selectedAccountIds, filter),
  });
}
