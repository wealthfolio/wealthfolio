import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { QueryKeys } from "@/lib/query-keys";

import {
  createCategorizationRule,
  deleteCategorizationRule,
  importRulePreset,
  listCategorizationRules,
  listRulePresets,
  removeRulePreset,
  rerunCategorizationRules,
  updateCategorizationRule,
} from "../adapters/rules";
import { invalidateSpendingCaches } from "../lib/invalidation";
import type {
  CategorizationRule,
  ImportPresetResult,
  NewCategorizationRule,
  RemovePresetResult,
  RulePresetSummary,
  UpdateCategorizationRule,
} from "../types/rule";

export function useCategorizationRules() {
  return useQuery<CategorizationRule[], Error>({
    queryKey: [QueryKeys.SPENDING_RULES],
    queryFn: listCategorizationRules,
  });
}

export function useCategorizationRuleMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: [QueryKeys.SPENDING_RULES] });
  };

  const create = useMutation({
    mutationFn: (rule: NewCategorizationRule) => createCategorizationRule(rule),
    onSuccess: () => {
      invalidate();
      toast.success("Rule created.");
    },
    onError: () => toast.error("Failed to create rule."),
  });

  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateCategorizationRule }) =>
      updateCategorizationRule(id, patch),
    onSuccess: () => {
      invalidate();
      toast.success("Rule updated.");
    },
    onError: () => toast.error("Failed to update rule."),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteCategorizationRule(id),
    onSuccess: () => {
      invalidate();
      toast.success("Rule deleted.");
    },
    onError: () => toast.error("Failed to delete rule."),
  });

  const rerun = useMutation({
    mutationFn: (onlyUncategorized: boolean) => rerunCategorizationRules(onlyUncategorized),
    onSuccess: (count, onlyUncategorized) => {
      // Rerun touches every cash activity's category — refresh report/budget too.
      invalidateSpendingCaches(qc);
      const verb = onlyUncategorized ? "Categorized" : "Re-categorized";
      toast.success(`${verb} ${count} activit${count === 1 ? "y" : "ies"}.`);
    },
    onError: () => toast.error("Failed to re-run rules."),
  });

  return { create, update, remove, rerun };
}

export function useRulePresets() {
  return useQuery<RulePresetSummary[], Error>({
    queryKey: [QueryKeys.SPENDING_RULES, "presets"],
    queryFn: listRulePresets,
  });
}

export function useImportRulePreset() {
  const qc = useQueryClient();
  return useMutation<ImportPresetResult, Error, string>({
    mutationFn: (presetId: string) => importRulePreset(presetId),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: [QueryKeys.SPENDING_RULES] });
      qc.invalidateQueries({ queryKey: [QueryKeys.SPENDING_RULES, "presets"] });
      const skipped = result.skippedExisting + result.skippedUnknownCategory;
      const skippedSuffix = skipped > 0 ? `, ${skipped} skipped` : "";
      const updatedSuffix = result.updated > 0 ? `, ${result.updated} updated` : "";
      toast.success(
        `Imported ${result.added} rule${result.added === 1 ? "" : "s"}${updatedSuffix}${skippedSuffix}.`,
      );
    },
    onError: () => toast.error("Failed to import preset."),
  });
}

export function useRemoveRulePreset() {
  const qc = useQueryClient();
  return useMutation<RemovePresetResult, Error, string>({
    mutationFn: (presetId: string) => removeRulePreset(presetId),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: [QueryKeys.SPENDING_RULES] });
      qc.invalidateQueries({ queryKey: [QueryKeys.SPENDING_RULES, "presets"] });
      const keptSuffix =
        result.keptModified > 0
          ? `, ${result.keptModified} edited rule${result.keptModified === 1 ? "" : "s"} kept`
          : "";
      toast.success(
        `Removed ${result.removed} rule${result.removed === 1 ? "" : "s"}${keptSuffix}.`,
      );
    },
    onError: () => toast.error("Failed to remove preset."),
  });
}
