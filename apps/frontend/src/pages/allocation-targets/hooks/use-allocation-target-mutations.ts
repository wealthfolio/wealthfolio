import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { QueryKeys } from "@/lib/query-keys";
import {
  deleteAllocationTarget,
  listAllocationTargetAssetWeights,
  listAllocationTargetWeights,
  saveAllocationTargetWithWeights,
} from "@/adapters";
import type {
  AllocationTarget,
  NewAllocationTarget,
  NewAllocationTargetAssetWeight,
  NewAllocationTargetWeight,
} from "@/lib/types";

function upsertTarget(targets: AllocationTarget[] | undefined, target: AllocationTarget) {
  if (!targets) return [target];
  const existingIndex = targets.findIndex((item) => item.id === target.id);
  if (existingIndex === -1) return [...targets, target];
  return targets.map((item) => (item.id === target.id ? target : item));
}

function invalidateAllocationTargetDrift(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: [QueryKeys.ALLOCATION_TARGET_DRIFT] });
}

export function useDeleteAllocationTarget() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteAllocationTarget(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.ALLOCATION_TARGETS] });
      invalidateAllocationTargetDrift(queryClient);
    },
  });
}

export function useAllocationTargetWeights(targetId: string | null) {
  return useQuery({
    queryKey: QueryKeys.allocationTargetWeights(targetId ?? ""),
    queryFn: () => listAllocationTargetWeights(targetId!),
    enabled: !!targetId,
  });
}

export function useAllocationTargetAssetWeights(targetId: string | null) {
  return useQuery({
    queryKey: QueryKeys.allocationTargetAssetWeights(targetId ?? ""),
    queryFn: () => listAllocationTargetAssetWeights(targetId!),
    enabled: !!targetId,
  });
}

export function useSaveAllocationTargetWithWeights() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      input,
      weights,
      assetWeights,
    }: {
      id: string | null;
      input: NewAllocationTarget;
      weights: NewAllocationTargetWeight[];
      assetWeights?: NewAllocationTargetAssetWeight[];
    }) => saveAllocationTargetWithWeights(id, input, weights, assetWeights),
    onSuccess: ({ target, weights, assetWeights }) => {
      queryClient.setQueryData<AllocationTarget[]>([QueryKeys.ALLOCATION_TARGETS], (targets) =>
        upsertTarget(targets, target),
      );
      queryClient.setQueryData(QueryKeys.allocationTargetWeights(target.id), weights);
      queryClient.setQueryData(QueryKeys.allocationTargetAssetWeights(target.id), assetWeights);
      queryClient.invalidateQueries({ queryKey: [QueryKeys.ALLOCATION_TARGETS] });
      queryClient.invalidateQueries({ queryKey: QueryKeys.allocationTargetWeights(target.id) });
      queryClient.invalidateQueries({
        queryKey: QueryKeys.allocationTargetAssetWeights(target.id),
      });
      invalidateAllocationTargetDrift(queryClient);
    },
  });
}
