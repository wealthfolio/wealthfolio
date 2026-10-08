import { createGoal, deleteGoal, getGoals, updateGoal } from "@/adapters";
import { QueryKeys } from "@/lib/query-keys";
import type { Goal, NewGoal } from "@/lib/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

export function useGoals() {
  const query = useQuery<Goal[], Error>({
    queryKey: [QueryKeys.GOALS],
    queryFn: getGoals,
  });

  const nonArchived = query.data?.filter((g) => g.statusLifecycle === "active");
  const atRisk =
    nonArchived?.filter((g) => g.statusHealth === "at_risk" || g.statusHealth === "off_track") ??
    [];
  const active =
    nonArchived?.filter((g) => g.statusHealth !== "at_risk" && g.statusHealth !== "off_track") ??
    [];
  const achieved = query.data?.filter((g) => g.statusLifecycle === "achieved") ?? [];
  const archived = query.data?.filter((g) => g.statusLifecycle === "archived") ?? [];

  return {
    goals: query.data ?? [],
    active,
    atRisk,
    achieved,
    archived,
    isLoading: query.isLoading,
    error: query.error,
  };
}

export function useGoalMutations() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: [QueryKeys.GOALS] });
  };

  const createMutation = useMutation({
    mutationFn: (goal: NewGoal) => createGoal(goal),
    onSuccess: () => {
      invalidate();
      toast.success(t("goals:goal_saved"));
    },
    onError: () => toast.error(t("goals:goal_error")),
  });

  // Callers toast success: the save-up plan save also syncs the goal summary through it.
  const updateMutation = useMutation({
    mutationFn: (goal: Goal) => updateGoal(goal),
    onSuccess: (_, goal) => {
      invalidate();
      queryClient.invalidateQueries({ queryKey: QueryKeys.goal(goal.id) });
    },
    onError: () => toast.error(t("goals:goal_error")),
  });

  const deleteMutation = useMutation({
    mutationFn: (goalId: string) => deleteGoal(goalId),
    onSuccess: () => {
      invalidate();
      toast.success(t("goals:goal_deleted"));
    },
    onError: () => toast.error(t("goals:goal_delete_error")),
  });

  return { createMutation, updateMutation, deleteMutation };
}
