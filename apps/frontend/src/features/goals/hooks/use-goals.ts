import {
  createGoal,
  deleteGoal,
  getGoals,
  removeGoalCoverImage,
  setGoalCoverImage,
  updateGoal,
} from "@/adapters";
import { QueryKeys } from "@/lib/query-keys";
import type { Goal, NewGoal } from "@/lib/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
  const queryClient = useQueryClient();

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: [QueryKeys.GOALS] });
  };

  const createMutation = useMutation({
    mutationFn: (goal: NewGoal) => createGoal(goal),
    onSuccess: () => {
      invalidate();
      toast.success("Goal created successfully.");
    },
    onError: () => toast.error("Failed to create goal."),
  });

  const updateMutation = useMutation({
    mutationFn: (goal: Goal) => updateGoal(goal),
    onSuccess: (_, goal) => {
      invalidate();
      queryClient.invalidateQueries({ queryKey: QueryKeys.goal(goal.id) });
      toast.success("Goal updated successfully.");
    },
    onError: () => toast.error("Failed to update goal."),
  });

  const deleteMutation = useMutation({
    mutationFn: (goalId: string) => deleteGoal(goalId),
    onSuccess: () => {
      invalidate();
      toast.success("Goal deleted successfully.");
    },
    onError: () => toast.error("Failed to delete goal."),
  });

  const setCoverImageMutation = useMutation({
    mutationFn: ({
      goalId,
      contentBase64,
      fileExtension,
    }: {
      goalId: string;
      contentBase64: string;
      fileExtension: string;
    }) => setGoalCoverImage(goalId, contentBase64, fileExtension),
    onSuccess: (_, { goalId }) => {
      invalidate();
      queryClient.invalidateQueries({ queryKey: QueryKeys.goal(goalId) });
      toast.success("Cover image updated.");
    },
    onError: () => toast.error("Failed to update cover image."),
  });

  const removeCoverImageMutation = useMutation({
    mutationFn: (goalId: string) => removeGoalCoverImage(goalId),
    onSuccess: (_, goalId) => {
      invalidate();
      queryClient.invalidateQueries({ queryKey: QueryKeys.goal(goalId) });
      toast.success("Cover image removed.");
    },
    onError: () => toast.error("Failed to remove cover image."),
  });

  return {
    createMutation,
    updateMutation,
    deleteMutation,
    setCoverImageMutation,
    removeCoverImageMutation,
  };
}
