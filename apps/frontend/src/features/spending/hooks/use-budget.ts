import i18n from "i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { QueryKeys } from "@/lib/query-keys";

import {
  assignCategoryToGroup,
  copyBudgetTargets,
  createBudgetGroup,
  deleteBudgetGroup,
  deleteBudgetRolloverSetting,
  deleteBudgetTarget,
  getBudget,
  resetBudgetGroups,
  updateBudgetGroup,
  upsertBudgetRolloverSetting,
  upsertBudgetTarget,
} from "../adapters/budget";
import type {
  NewBudgetGroup,
  NewBudgetRolloverSetting,
  NewBudgetTarget,
  UpdateBudgetGroup,
} from "../types/budget";

export function useBudget(periodKey?: string) {
  return useQuery({
    queryKey: [QueryKeys.SPENDING_BUDGET, periodKey ?? null],
    queryFn: () => getBudget(periodKey),
  });
}

export function useBudgetMutations(periodKey?: string) {
  const qc = useQueryClient();
  // Budget edits affect report rollups (group→category mapping changes how
  // spending sums roll up), so blow both buckets.
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: [QueryKeys.SPENDING_BUDGET] });
    qc.invalidateQueries({ queryKey: [QueryKeys.SPENDING_REPORT] });
    qc.invalidateQueries({ queryKey: [QueryKeys.SPENDING_INSIGHT] });
  };

  const upsertTarget = useMutation({
    mutationFn: (target: NewBudgetTarget) => upsertBudgetTarget(target, periodKey),
    onSuccess: invalidate,
    onError: () => toast.error(i18n.t("common:notifications.failed_to_save_budget_target")),
  });

  const removeTarget = useMutation({
    mutationFn: (id: string) => deleteBudgetTarget(id, periodKey),
    onSuccess: invalidate,
    onError: () => toast.error(i18n.t("common:notifications.failed_to_remove_budget_target")),
  });

  const upsertRollover = useMutation({
    mutationFn: (setting: NewBudgetRolloverSetting) =>
      upsertBudgetRolloverSetting(setting, periodKey),
    onSuccess: invalidate,
    onError: () => toast.error(i18n.t("common:notifications.failed_to_save_rollover_setting")),
  });

  const removeRollover = useMutation({
    mutationFn: (id: string) => deleteBudgetRolloverSetting(id, periodKey),
    onSuccess: invalidate,
    onError: () => toast.error(i18n.t("common:notifications.failed_to_remove_rollover_setting")),
  });

  const createGroup = useMutation({
    mutationFn: (group: NewBudgetGroup) => createBudgetGroup(group, periodKey),
    onSuccess: invalidate,
    onError: () => toast.error(i18n.t("common:notifications.failed_to_create_budget_group")),
  });

  const updateGroup = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateBudgetGroup }) =>
      updateBudgetGroup(id, patch, periodKey),
    onSuccess: invalidate,
    onError: () => toast.error(i18n.t("common:notifications.failed_to_update_budget_group")),
  });

  const removeGroup = useMutation({
    mutationFn: ({ id, reassignToGroupId }: { id: string; reassignToGroupId: string }) =>
      deleteBudgetGroup(id, reassignToGroupId, periodKey),
    onSuccess: invalidate,
    onError: (error) =>
      toast.error(
        error instanceof Error && error.message ? error.message : "Failed to delete budget group.",
      ),
  });

  const assignCategory = useMutation({
    mutationFn: ({ categoryId, groupId }: { categoryId: string; groupId: string }) =>
      assignCategoryToGroup(categoryId, groupId, periodKey),
    onSuccess: invalidate,
    onError: () => toast.error(i18n.t("common:notifications.failed_to_move_category")),
  });

  const resetGroups = useMutation({
    mutationFn: () => resetBudgetGroups(periodKey),
    onSuccess: invalidate,
    onError: () => toast.error(i18n.t("common:notifications.failed_to_reset_budget_groups")),
  });

  const copyFromMonth = useMutation({
    mutationFn: ({
      sourcePeriodKey,
      overwrite,
    }: {
      sourcePeriodKey: string;
      overwrite: boolean;
    }) => {
      const target = periodKey && periodKey !== "default" ? periodKey : sourcePeriodKey;
      return copyBudgetTargets(sourcePeriodKey, target, overwrite);
    },
    onSuccess: () => {
      invalidate();
      toast.success(i18n.t("common:notifications.plan_copied"));
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : "Failed to copy plan.";
      toast.error(message);
    },
  });

  return {
    upsertTarget,
    removeTarget,
    upsertRollover,
    removeRollover,
    createGroup,
    updateGroup,
    removeGroup,
    assignCategory,
    resetGroups,
    copyFromMonth,
  };
}
