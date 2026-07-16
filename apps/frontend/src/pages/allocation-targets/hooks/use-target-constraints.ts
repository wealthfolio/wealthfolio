import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { listTargetConstraints, saveTargetConstraints } from "@/adapters";
import type { AllocationTargetConstraint } from "@/lib/types";

export function useTargetConstraints(targetId: string | undefined) {
  const queryClient = useQueryClient();
  const queryKey = ["target-constraints", targetId];

  const query = useQuery({
    queryKey,
    queryFn: () => listTargetConstraints(targetId!),
    enabled: !!targetId,
    staleTime: Infinity,
  });

  const saveMutation = useMutation({
    mutationFn: (constraints: AllocationTargetConstraint[]) =>
      saveTargetConstraints(targetId!, constraints),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKey, data);
    },
  });

  return {
    constraints: query.data ?? [],
    isLoading: query.isLoading,
    saveConstraints: saveMutation.mutateAsync,
    isSaving: saveMutation.isPending,
  };
}
