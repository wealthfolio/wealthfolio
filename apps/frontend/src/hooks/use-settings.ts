import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Settings } from "@/lib/types";
import { getSettings, isWeb } from "@/adapters";
import { fetchWebCurrencySettings } from "@/lib/currency-cache";
import { QueryKeys } from "@/lib/query-keys";
import { useAuth } from "@/context/auth-context";

export function useSettings() {
  const { isAuthenticated, statusLoading } = useAuth();
  const queryClient = useQueryClient();

  return useQuery<Settings, Error>({
    queryKey: [QueryKeys.SETTINGS],
    queryFn: isWeb ? () => fetchWebCurrencySettings(queryClient, getSettings) : getSettings,
    enabled: !statusLoading && isAuthenticated,
  });
}
