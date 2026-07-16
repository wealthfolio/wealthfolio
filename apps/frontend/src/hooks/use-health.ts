import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { FixAction, HealthConfig, HealthStatus } from "@/lib/types";
import {
  dismissHealthIssue,
  executeHealthFix,
  getHealthConfig,
  getHealthStatus,
  restoreHealthIssue,
  runHealthChecks,
  updateHealthConfig,
} from "@/adapters";
import { QueryKeys } from "@/lib/query-keys";
import { useAuth } from "@/context/auth-context";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";

/**
 * Hook for fetching health status.
 */
export function useHealthStatus() {
  const { isAuthenticated, statusLoading } = useAuth();

  return useQuery<HealthStatus, Error>({
    queryKey: [QueryKeys.HEALTH_STATUS],
    queryFn: getHealthStatus,
    enabled: !statusLoading && isAuthenticated,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

/**
 * Hook for running health checks.
 */
export function useRunHealthChecks(options?: { navigate?: (path: string) => void }) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: runHealthChecks,
    onSuccess: (data: HealthStatus) => {
      queryClient.setQueryData([QueryKeys.HEALTH_STATUS], data);
      const issueCount = data.issues?.length ?? 0;
      if (issueCount === 0) {
        toast.success("All checks passed", { description: "No issues found." });
      } else {
        toast.error(`${issueCount} issue${issueCount > 1 ? "s" : ""} found`, {
          description: "Review the details in the Health Center.",
          action: options?.navigate
            ? { label: "View", onClick: () => options.navigate!("/health") }
            : undefined,
        });
      }
    },
    onError: (error: Error) => {
      toast.error("Health check failed", { description: error.message });
    },
  });
}

/**
 * Hook for dismissing a health issue.
 */
export function useDismissHealthIssue() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ issueId, dataHash }: { issueId: string; dataHash: string }) =>
      dismissHealthIssue(issueId, dataHash),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.HEALTH_STATUS] });
      toast.success("Issue dismissed");
    },
    onError: (error: Error) => {
      toast.error("Failed to dismiss issue", { description: error.message });
    },
  });
}

/**
 * Hook for restoring a dismissed health issue.
 */
export function useRestoreHealthIssue() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: restoreHealthIssue,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.HEALTH_STATUS] });
      toast.success("Issue restored");
    },
    onError: (error: Error) => {
      toast.error("Failed to restore issue", { description: error.message });
    },
  });
}

/**
 * Hook for executing a fix action.
 */
export function useExecuteHealthFix() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (action: FixAction) => {
      // Execute the fix
      await executeHealthFix(action);
      if (action.id === "rebuild_account_history") {
        return { status: undefined, actionId: action.id };
      }
      // Run health checks to get fresh status
      const status = await runHealthChecks();
      return { status, actionId: action.id };
    },
    onSuccess: ({ status, actionId }) => {
      // Update health status with fresh data from health checks
      if (status) {
        queryClient.setQueryData([QueryKeys.HEALTH_STATUS], status);
      }
      // Invalidate holdings so related pages refresh
      queryClient.invalidateQueries({ queryKey: [QueryKeys.HOLDINGS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.PORTFOLIO_ALLOCATIONS] });
      // Skip toast for sync actions — global event listeners handle feedback
      if (actionId === "rebuild_account_history") {
        toast.success("History rebuild started", {
          description: "Health will refresh after recalculation finishes.",
        });
      } else if (actionId !== "sync_prices" && actionId !== "retry_sync") {
        toast.success("Fix applied successfully");
      }
    },
    onError: (error: Error, action) => {
      if (action.id === "sync_prices" || action.id === "retry_sync") {
        toast.error("Market Data Sync Failed", {
          id: "market-sync-error",
          description: `${error.message}. Please try again later.`,
        });
      } else {
        toast.error("Fix failed", { description: error.message });
      }
    },
  });
}

/**
 * Hook for fetching health configuration.
 */
export function useHealthConfig() {
  const { isAuthenticated, statusLoading } = useAuth();

  return useQuery<HealthConfig, Error>({
    queryKey: [QueryKeys.HEALTH_CONFIG],
    queryFn: getHealthConfig,
    enabled: !statusLoading && isAuthenticated,
  });
}

/**
 * Hook for updating health configuration.
 */
export function useUpdateHealthConfig() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: updateHealthConfig,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.HEALTH_CONFIG] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.HEALTH_STATUS] });
      toast.success("Configuration updated");
    },
    onError: (error: Error) => {
      toast.error("Failed to update configuration", { description: error.message });
    },
  });
}
