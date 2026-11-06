import { useQuery } from "@tanstack/react-query";
import { Settings } from "@/lib/types";
import { getSettings } from "@/adapters";
import { QueryKeys } from "@/lib/query-keys";
import { useAuth } from "@/context/auth-context";

export function useSettings() {
  const { isAuthenticated, statusLoading } = useAuth();

  return useQuery<Settings, Error>({
    queryKey: [QueryKeys.SETTINGS],
    queryFn: getSettings,
    enabled: !statusLoading && isAuthenticated,
  });
}
