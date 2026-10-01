import type {
  AccountScope,
  DriftReport,
  NewAllocationTargetWeight,
  NewAllocationTarget,
  AllocationTargetWeight,
  AllocationTarget,
  SaveAllocationTargetResult,
  AllocationTargetConstraint,
  AllocationRule,
  AllocationWorksheetLineInput,
  AllocationWorksheetResult,
  CalculatedAdjustments,
  WorksheetCashInput,
  WorksheetMode,
} from "@/lib/types";

import { invoke } from "./platform";

// ── Target CRUD ──────────────────────────────────────────────────────────────

export const listAllocationTargets = async (): Promise<AllocationTarget[]> => {
  return invoke<AllocationTarget[]>("list_allocation_targets");
};

export const getAllocationTarget = async (id: string): Promise<AllocationTarget | null> => {
  return invoke<AllocationTarget | null>("get_allocation_target", { id });
};

export const createAllocationTarget = async (
  input: NewAllocationTarget,
): Promise<AllocationTarget> => {
  return invoke<AllocationTarget>("create_allocation_target", { input });
};

export const updateAllocationTarget = async (
  id: string,
  input: NewAllocationTarget,
): Promise<AllocationTarget> => {
  return invoke<AllocationTarget>("update_allocation_target", { id, input });
};

export const archiveAllocationTarget = async (id: string): Promise<AllocationTarget> => {
  return invoke<AllocationTarget>("archive_allocation_target", { id });
};

export const deleteAllocationTarget = async (id: string): Promise<void> => {
  return invoke<void>("delete_allocation_target", { id });
};

// ── Weights ─────────────────────────────────────────────────────────────────────

export const listAllocationTargetWeights = async (
  targetId: string,
): Promise<AllocationTargetWeight[]> => {
  return invoke<AllocationTargetWeight[]>("list_allocation_target_weights", { targetId });
};

export const saveAllocationTargetWeights = async (
  targetId: string,
  weights: NewAllocationTargetWeight[],
): Promise<AllocationTargetWeight[]> => {
  return invoke<AllocationTargetWeight[]>("save_allocation_target_weights", { targetId, weights });
};

export const saveAllocationTargetWithWeights = async (
  id: string | null,
  input: NewAllocationTarget,
  weights: NewAllocationTargetWeight[],
): Promise<SaveAllocationTargetResult> => {
  return invoke<SaveAllocationTargetResult>("save_allocation_target_with_weights", {
    id,
    input,
    weights,
  });
};

// ── Drift ─────────────────────────────────────────────────────────────────────

export const getAllocationTargetDrift = async (
  targetId: string,
  filter: AccountScope,
  options?: { includeHoldings?: boolean },
): Promise<DriftReport> => {
  return invoke<DriftReport>("get_allocation_target_drift", {
    targetId,
    filter,
    includeHoldings: options?.includeHoldings ?? false,
  });
};

// ── Sell constraints ─────────────────────────────────────────────────────────

export const listTargetConstraints = async (
  targetId: string,
): Promise<AllocationTargetConstraint[]> => {
  return invoke<AllocationTargetConstraint[]>("list_target_constraints", { targetId });
};

export const saveTargetConstraints = async (
  targetId: string,
  constraints: AllocationTargetConstraint[],
): Promise<AllocationTargetConstraint[]> => {
  return invoke<AllocationTargetConstraint[]>("save_target_constraints", {
    targetId,
    constraints,
  });
};

// ── Calculated worksheet ──────────────────────────────────────────────────────

export function canonicalizeEligibleAssetIds(
  eligibleAssetIds?: readonly string[],
): string[] | undefined {
  if (eligibleAssetIds === undefined) return undefined;
  return [...new Set(eligibleAssetIds)].sort();
}

/**
 * Prefills the worksheet from the target. `eligibleAssetIds` omitted means every
 * recorded security; an empty list is a valid selection and is sent as such.
 */
export const generateCalculatedAdjustments = async (
  targetId: string,
  mode: WorksheetMode,
  rule: AllocationRule,
  cash: WorksheetCashInput,
  selectedAccountIds: readonly string[],
  filter: AccountScope,
  eligibleAssetIds?: readonly string[],
): Promise<CalculatedAdjustments> => {
  const payload: {
    targetId: string;
    mode: WorksheetMode;
    rule: AllocationRule;
    cash: WorksheetCashInput;
    selectedAccountIds: string[];
    filter: AccountScope;
    eligibleAssetIds?: string[];
  } = { targetId, mode, rule, cash, selectedAccountIds: [...selectedAccountIds], filter };
  const canonicalIds = canonicalizeEligibleAssetIds(eligibleAssetIds);
  if (canonicalIds !== undefined) payload.eligibleAssetIds = canonicalIds;
  return invoke<CalculatedAdjustments>("generate_calculated_adjustments", payload);
};

/** Validates the worksheet as the user has it and projects it. Never re-derives it. */
export const calculateAllocationWorksheet = async (
  targetId: string,
  cash: WorksheetCashInput,
  lines: AllocationWorksheetLineInput[],
  selectedAccountIds: readonly string[],
  filter: AccountScope,
): Promise<AllocationWorksheetResult> => {
  return invoke<AllocationWorksheetResult>("calculate_allocation_worksheet", {
    targetId,
    cash,
    lines,
    selectedAccountIds: [...selectedAccountIds],
    filter,
  });
};
