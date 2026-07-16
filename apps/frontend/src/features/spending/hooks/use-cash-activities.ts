import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { QueryKeys } from "@/lib/query-keys";

import {
  assignActivityCategory,
  bulkAssignCategories,
  clearActivitySplits,
  getActivityAssignments,
  getActivitySplits,
  listCashActivities,
  replaceActivitySplits,
  searchCashActivities,
  setActivityEvent,
  unassignActivityCategory,
  type BulkCategoryAssignment,
} from "../adapters/cash-activities";
import { invalidateSpendingCaches } from "../lib/invalidation";
import type {
  ActivityTaxonomyAssignment,
  ActivitySplit,
  CashActivityFilter,
  CashActivity,
  NewActivitySplit,
} from "../types/cash-activity";

/**
 * Returns cash activities enriched with their category assignments + event
 * tag. Backed by `cash_activities/list()` which JOINs both side-tables in a
 * single round-trip — see the service doc-comment for why the return shape
 * matches `search()` items.
 */
export function useCashActivities(filter?: CashActivityFilter) {
  return useQuery<CashActivity[], Error>({
    queryKey: [QueryKeys.SPENDING_TRANSACTIONS, filter ?? null],
    queryFn: () => listCashActivities(filter),
  });
}

export function useUncategorizedCount(startDate?: string, endDate?: string) {
  return useQuery<number, Error>({
    queryKey: [QueryKeys.SPENDING_TRANSACTIONS, "uncategorized-count", startDate, endDate],
    queryFn: async () => {
      const res = await searchCashActivities({
        status: "uncategorized",
        startDate,
        endDate,
        limit: 1,
        offset: 0,
      });
      return res.totalCount;
    },
    enabled: !!startDate && !!endDate,
  });
}

export function useActivityAssignments(activityId: string | null) {
  return useQuery<ActivityTaxonomyAssignment[], Error>({
    queryKey: [QueryKeys.SPENDING_TRANSACTIONS, "assignments", activityId],
    queryFn: () => (activityId ? getActivityAssignments(activityId) : Promise.resolve([])),
    enabled: !!activityId,
  });
}

export function useActivitySplits(activityId: string | null) {
  return useQuery<ActivitySplit[], Error>({
    queryKey: [QueryKeys.SPENDING_TRANSACTIONS, "splits", activityId],
    queryFn: () => (activityId ? getActivitySplits(activityId) : Promise.resolve([])),
    enabled: !!activityId,
  });
}

export function useAssignActivityCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      activityId,
      taxonomyId,
      categoryId,
    }: {
      activityId: string;
      taxonomyId: string;
      categoryId: string;
    }) => assignActivityCategory(activityId, taxonomyId, categoryId),
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({
        queryKey: [QueryKeys.SPENDING_TRANSACTIONS, "assignments", vars.activityId],
      });
      queryClient.invalidateQueries({
        queryKey: [QueryKeys.SPENDING_TRANSACTIONS, "splits", vars.activityId],
      });
      invalidateSpendingCaches(queryClient);
    },
    onError: () => toast.error("Failed to set category."),
  });
}

export function useBulkAssignCategories() {
  const queryClient = useQueryClient();
  return useMutation<ActivityTaxonomyAssignment[], Error, BulkCategoryAssignment[]>({
    mutationFn: (items: BulkCategoryAssignment[]) => bulkAssignCategories(items),
    onSuccess: () => {
      invalidateSpendingCaches(queryClient);
    },
    onError: () => toast.error("Failed to apply categories."),
  });
}

export function useUnassignActivityCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ activityId, taxonomyId }: { activityId: string; taxonomyId: string }) =>
      unassignActivityCategory(activityId, taxonomyId),
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({
        queryKey: [QueryKeys.SPENDING_TRANSACTIONS, "assignments", vars.activityId],
      });
      invalidateSpendingCaches(queryClient);
    },
    onError: () => toast.error("Failed to clear category."),
  });
}

export function useReplaceActivitySplits() {
  const queryClient = useQueryClient();
  return useMutation<ActivitySplit[], Error, { activityId: string; splits: NewActivitySplit[] }>({
    mutationFn: ({ activityId, splits }) => replaceActivitySplits(activityId, splits),
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({
        queryKey: [QueryKeys.SPENDING_TRANSACTIONS, "splits", vars.activityId],
      });
      queryClient.invalidateQueries({
        queryKey: [QueryKeys.SPENDING_TRANSACTIONS, "assignments", vars.activityId],
      });
      invalidateSpendingCaches(queryClient);
    },
    onError: () => toast.error("Failed to save split."),
  });
}

export function useClearActivitySplits() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, { activityId: string }>({
    mutationFn: ({ activityId }) => clearActivitySplits(activityId),
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({
        queryKey: [QueryKeys.SPENDING_TRANSACTIONS, "splits", vars.activityId],
      });
      invalidateSpendingCaches(queryClient);
    },
    onError: () => toast.error("Failed to clear split."),
  });
}

export function useSetActivityEvent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ activityId, eventId }: { activityId: string; eventId: string | null }) =>
      setActivityEvent(activityId, eventId),
    onSuccess: () => {
      invalidateSpendingCaches(queryClient);
    },
    onError: () => toast.error("Failed to set event."),
  });
}
