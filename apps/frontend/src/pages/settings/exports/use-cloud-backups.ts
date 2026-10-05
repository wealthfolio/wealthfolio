import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  cloudBackupAction,
  isDesktop,
  type CloudBackupStatus,
  type CloudBackupCaptureStatus,
} from "@/adapters";
import { useProfile } from "@/features/profiles/profile-context";
import { useWealthfolioConnect } from "@/features/wealthfolio-connect/providers/wealthfolio-connect-provider";
import { usePlatform } from "@/hooks/use-platform";

export function useCloudBackups() {
  const { isConnected, isEnabled, isInitializing, user } = useWealthfolioConnect();
  const profile = useProfile()?.profile;
  const { isMobile, loading } = usePlatform();
  const supported = !isDesktop || !loading;
  const available = isEnabled && isConnected && supported;
  const identity = `${profile?.id ?? "legacy"}:${user?.id ?? "signed-out"}`;
  const status = useQuery({
    queryKey: ["cloud-backups", identity],
    queryFn: () => cloudBackupAction<CloudBackupStatus>({ action: "status" }),
    enabled: available,
    retry: false,
    staleTime: 30_000,
    gcTime: 0,
  });
  // Observe only the local runtime while this view is mounted. These reads never
  // refresh tokens or contact Connect; automatic capture retains its own timer.
  const capture = useQuery({
    queryKey: ["cloud-backup-runtime", identity],
    queryFn: () => cloudBackupAction<CloudBackupCaptureStatus>({ action: "runtimeStatus" }),
    enabled: available && !!status.data?.isSource && status.data?.sourceConsented !== false,
    retry: false,
    gcTime: 0,
    refetchInterval: 5_000,
  });
  const refetchStatus = status.refetch;
  const lastCapture = useRef({ identity, completed: capture.data?.completed });
  useEffect(() => {
    if (
      lastCapture.current.identity === identity &&
      lastCapture.current.completed !== undefined &&
      capture.data?.completed !== undefined &&
      lastCapture.current.completed !== capture.data.completed
    ) {
      void refetchStatus();
    }
    lastCapture.current = { identity, completed: capture.data?.completed };
  }, [identity, capture.data?.completed, refetchStatus]);
  return {
    available,
    promotionAvailable: isEnabled && supported && !isInitializing,
    identity,
    profile,
    isMobile: isDesktop && isMobile,
    status: {
      refetch: status.refetch,
      isPending: status.isPending,
      isError: status.isError,
      error: status.error,
      data: status.data ? { ...status.data, capture: capture.data } : undefined,
    },
  };
}

export function backupDate(value: string | null) {
  if (!value) return null;
  const date = new Date(value.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function backupState(data: CloudBackupStatus) {
  if (!data.policy.uploadEntitled) return "plan";
  if (!data.hasKey) return "new";
  if (!data.keyReady) return "locked";
  if (!data.policy.enabled || (data.isSource && data.sourceConsented === false)) return "paused";
  if (!data.isSource) return "other";
  if (data.capture?.state === "running") return "running";
  if (data.capture?.state === "failed") return "failed";
  if (!data.policy.lastBackupAt) return "waiting";
  const due = backupDate(data.policy.nextDueAt);
  return due && due.getTime() <= Date.now() ? "due" : "on";
}
