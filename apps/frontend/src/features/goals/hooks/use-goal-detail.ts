import {
  getGoal,
  getGoalFunding,
  getGoalPlan,
  previewSaveUpOverview,
  getRetirementOverview,
  getSaveUpOverview,
  saveGoalFunding,
  saveGoalPlan,
  refreshGoalSummary,
} from "@/adapters";
import { QueryKeys } from "@/lib/query-keys";
import { invalidateRetirementGoal } from "./use-goals";
import type {
  Goal,
  GoalFundingRule,
  GoalFundingRuleInput,
  GoalPlan,
  RetirementOverview,
  SaveGoalPlan,
  SaveUpOverviewDTO,
  SaveUpPreviewInputDTO,
} from "@/lib/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

export function useGoalDetail(goalId: string | undefined) {
  const goal = useQuery<Goal, Error>({
    queryKey: QueryKeys.goal(goalId ?? ""),
    queryFn: () => getGoal(goalId!),
    enabled: !!goalId,
  });

  const plan = useQuery<GoalPlan | null, Error>({
    queryKey: QueryKeys.goalPlan(goalId ?? ""),
    queryFn: () => getGoalPlan(goalId!),
    enabled: !!goalId,
  });

  const funding = useQuery<GoalFundingRule[], Error>({
    queryKey: QueryKeys.goalFunding(goalId ?? ""),
    queryFn: () => getGoalFunding(goalId!),
    enabled: !!goalId,
  });

  const fundingRules = useMemo(() => funding.data ?? [], [funding.data]);

  return {
    goal: goal.data,
    plan: plan.data,
    fundingRules,
    isLoading: goal.isLoading || plan.isLoading || funding.isLoading,
    error: goal.error || plan.error || funding.error,
  };
}

export function useGoalPlanMutations(goalId: string) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const invalidateGoal = () => {
    queryClient.invalidateQueries({ queryKey: QueryKeys.goalPlan(goalId) });
    queryClient.invalidateQueries({ queryKey: QueryKeys.goal(goalId) });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.GOALS] });
    queryClient.invalidateQueries({ queryKey: QueryKeys.saveUpOverview(goalId) });
    queryClient.invalidateQueries({ queryKey: QueryKeys.retirementOverview(goalId) });
  };

  const savePlanMutation = useMutation({
    mutationFn: (plan: SaveGoalPlan) => saveGoalPlan(plan),
    onSuccess: () => {
      invalidateGoal();
      toast.success(t("goals:plan_saved"));
    },
    onError: () => toast.error(t("goals:plan_error")),
  });

  const saveFundingMutation = useMutation({
    mutationFn: (rules: GoalFundingRuleInput[]) => saveGoalFunding(goalId, rules),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QueryKeys.goalFunding(goalId) });
      invalidateGoal();
      invalidateRetirementGoal(queryClient);
      toast.success(t("goals:funding_saved"));
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : t("goals:funding_error")),
  });

  const refreshSummaryMutation = useMutation({
    mutationFn: () => refreshGoalSummary(goalId),
    onSuccess: () => {
      invalidateGoal();
    },
  });

  return { savePlanMutation, saveFundingMutation, refreshSummaryMutation };
}

export function useRetirementOverview(goalId: string | undefined) {
  return useQuery<RetirementOverview, Error>({
    queryKey: QueryKeys.retirementOverview(goalId ?? ""),
    queryFn: () => getRetirementOverview(goalId!),
    enabled: !!goalId,
  });
}

export function useSaveUpOverview(goalId: string | undefined) {
  return useQuery<SaveUpOverviewDTO, Error>({
    queryKey: QueryKeys.saveUpOverview(goalId ?? ""),
    queryFn: () => getSaveUpOverview(goalId!),
    enabled: !!goalId,
  });
}

export function useSaveUpPreview(input: SaveUpPreviewInputDTO | null) {
  return useQuery<SaveUpOverviewDTO, Error>({
    queryKey: [QueryKeys.SAVE_UP_PREVIEW, input],
    queryFn: () => previewSaveUpOverview(input!),
    enabled: !!input,
  });
}
