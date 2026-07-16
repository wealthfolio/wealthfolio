import type { QueryClient } from "@tanstack/react-query";

import { QueryKeys } from "@/lib/query-keys";

export function invalidatePerformanceCaches(queryClient: QueryClient) {
  queryClient.invalidateQueries({ queryKey: [QueryKeys.PERFORMANCE_SUMMARY] });
  queryClient.invalidateQueries({ queryKey: [QueryKeys.PERFORMANCE_HISTORY] });
  queryClient.invalidateQueries({ queryKey: [QueryKeys.ACCOUNTS_SIMPLE_PERFORMANCE] });
  queryClient.invalidateQueries({ queryKey: [QueryKeys.HISTORY_VALUATION] });
  queryClient.invalidateQueries({ queryKey: [QueryKeys.latestValuations] });
  queryClient.invalidateQueries({ queryKey: [QueryKeys.CURRENT_VALUATION] });
  queryClient.invalidateQueries({ queryKey: [QueryKeys.HOLDINGS] });
  queryClient.invalidateQueries({ queryKey: [QueryKeys.HOLDING] });
  queryClient.invalidateQueries({ queryKey: [QueryKeys.ASSET_HOLDINGS] });
  queryClient.invalidateQueries({ queryKey: [QueryKeys.ASSET_LOTS] });
  queryClient.invalidateQueries({ queryKey: [QueryKeys.PORTFOLIO_ALLOCATIONS] });
  queryClient.invalidateQueries({ queryKey: [QueryKeys.ACCOUNTS_SUMMARY] });
  queryClient.invalidateQueries({ queryKey: [QueryKeys.NET_WORTH] });
  queryClient.invalidateQueries({ queryKey: [QueryKeys.NET_WORTH_HISTORY] });
}
