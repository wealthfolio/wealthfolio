import { useQuery } from "@tanstack/react-query";

import { QueryKeys } from "@/lib/query-keys";

import { getSpendingInsight } from "../adapters/insight";
import type { SpendingInsight, SpendingInsightRequest } from "../types/insight";

export function useSpendingInsight(request: SpendingInsightRequest, enabled = true) {
  return useQuery<SpendingInsight, Error>({
    queryKey: [QueryKeys.SPENDING_INSIGHT, request],
    queryFn: () => getSpendingInsight(request),
    enabled,
  });
}
