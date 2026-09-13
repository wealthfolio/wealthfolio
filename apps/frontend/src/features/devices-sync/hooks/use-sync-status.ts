// useSyncStatus
// React Query hook for polling device sync state and engine status.
// Replaces: state detection useEffect, refreshState(), ENGINE_STATUS action.
// ==========================================================================

import { useWealthfolioConnect } from "@/features/wealthfolio-connect";
import { isSubscriptionStatusActive } from "@/features/wealthfolio-connect/lib/plan-capabilities";
import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { syncService } from "../services/sync-service";
import { SyncError, SyncStates } from "../types";

export function useSyncStatus() {
  const { isConnected, isEnabled, userInfo } = useWealthfolioConnect();

  const hasSubscription = isSubscriptionStatusActive(userInfo?.team?.subscription_status);

  const enabled = !!isEnabled && !!isConnected && !!hasSubscription;

  // Query 1: sync state (always active when authenticated)
  const statusQuery = useQuery({
    queryKey: ["sync", "status", enabled ? "enabled" : "disabled"],
    queryFn: async () => {
      try {
        return await syncService.detectState();
      } catch (err) {
        // Not signed in — return null defaults, not error
        if (SyncError.isNoAccessToken(err)) return null;
        throw err;
      }
    },
    enabled,
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  // Query 2: engine status (only when READY)
  const engineQuery = useQuery({
    queryKey: ["sync", "engine", enabled ? "enabled" : "disabled"],
    queryFn: () => syncService.getEngineStatus(),
    enabled: statusQuery.data?.state === SyncStates.READY,
    refetchInterval: 15_000,
    staleTime: 5_000,
  });

  const data = statusQuery.data;

  const refetch = useCallback(() => {
    statusQuery.refetch();
    engineQuery.refetch();
  }, [statusQuery.refetch, engineQuery.refetch]);

  return {
    syncState: data?.state ?? SyncStates.FRESH,
    device: data?.device ?? null,
    identity: data?.identity ?? null,
    trustedDevices: data?.trustedDevices ?? [],
    serverKeyVersion: data?.serverKeyVersion ?? null,
    engineStatus: engineQuery.data ?? null,
    engineIsFetching: engineQuery.isFetching,
    isLoading: statusQuery.isLoading,
    error: statusQuery.error ? SyncError.from(statusQuery.error) : null,
    refetch,
  };
}
