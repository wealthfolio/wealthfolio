import i18n from "i18next";
import { profilePreferenceKey } from "@/hooks/use-persistent-state";
import {
  isTauri,
  logger,
  isAutoUpdateCheckEnabled,
  checkForUpdates,
  installUpdate,
} from "@/adapters";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";
import type { UpdateInfo } from "@/lib/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

const UPDATE_QUERY_KEY = ["app-update"];
export const UPDATE_DISMISSED_KEY = "update-dismissed";

/** Clear the snooze state so the update dialog can reappear. */
function clearUpdateSnooze() {
  const key = profilePreferenceKey(UPDATE_DISMISSED_KEY);
  window.localStorage.setItem(key, JSON.stringify(null));
  // Notify usePersistentState instances on the same page
  window.dispatchEvent(
    new CustomEvent("persistent-state-change", {
      detail: { key, value: null },
    }),
  );
}

/**
 * Hook to check for updates on app startup.
 * Silently checks - only returns data if update available.
 * On desktop, also listens for menu-triggered update events.
 */
export function useCheckUpdateOnStartup() {
  const queryClient = useQueryClient();

  // Listen for menu-triggered update available events (desktop only)
  useEffect(() => {
    if (!isTauri) return;

    let unlisten: (() => void) | undefined;

    // Dynamic import for Tauri-specific functionality
    import("@tauri-apps/api/event").then(({ listen }) => {
      listen<UpdateInfo>("app:update-available", (event) => {
        clearUpdateSnooze();
        queryClient.setQueryData(UPDATE_QUERY_KEY, event.payload);
      }).then((fn) => {
        unlisten = fn;
      });
    });

    return () => unlisten?.();
  }, [queryClient]);

  return useQuery({
    queryKey: UPDATE_QUERY_KEY,
    queryFn: async () => {
      const enabled = await isAutoUpdateCheckEnabled();
      if (!enabled) return null;
      return checkForUpdates();
    },
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
}

/**
 * Hook for manual update check (e.g., from settings button).
 * Shows toast feedback for up-to-date or errors.
 */
export function useCheckForUpdates() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => checkForUpdates({ force: true }),
    onSuccess: (updateInfo: UpdateInfo | null) => {
      // Clear snooze so the dialog shows for manual checks
      clearUpdateSnooze();

      // Update the query cache so dialog can show
      queryClient.setQueryData(UPDATE_QUERY_KEY, updateInfo);

      if (!updateInfo) {
        toast({
          title: i18n.t("common:notifications.you_re_up_to_date"),
          description: i18n.t("common:notifications.you_already_have_the_latest_version_installed"),
        });
      }
      // If update available, the UpdateDialog will show via the query data
    },
    onError: (error: Error) => {
      logger.error("Update check failed: " + error.message);
      toast({
        title: i18n.t("common:notifications.update_check_failed"),
        description: i18n.t("common:notifications.update_check_error_description"),
        variant: "destructive",
      });
    },
  });
}

/**
 * Hook to clear the update data (dismiss dialog).
 */
export function useClearUpdate() {
  const queryClient = useQueryClient();
  return () => queryClient.setQueryData(UPDATE_QUERY_KEY, null);
}

export type UpdatePhase = "idle" | "downloading" | "installing" | "error";

export interface UpdateProgress {
  downloaded: number;
  total: number | null;
}

interface DownloadProgressEvent {
  downloaded: number;
  total: number | null;
  phase: "downloading" | "installing";
}

/**
 * Hook to install an available update (desktop only).
 * Tracks download progress and install phase via Tauri events.
 */
export function useInstallUpdate() {
  const [phase, setPhase] = useState<UpdatePhase>("idle");
  const [progress, setProgress] = useState<UpdateProgress>({ downloaded: 0, total: null });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauri) return;

    let unlisten: (() => void) | undefined;

    import("@tauri-apps/api/event").then(({ listen }) => {
      listen<DownloadProgressEvent>("app:update-download-progress", (event) => {
        setPhase(event.payload.phase);
        if (event.payload.phase === "downloading") {
          setProgress({ downloaded: event.payload.downloaded, total: event.payload.total });
        }
      }).then((fn) => {
        unlisten = fn;
      });
    });

    return () => unlisten?.();
  }, []);

  const mutation = useMutation({
    mutationFn: installUpdate,
    onMutate: () => {
      setPhase("downloading");
      setProgress({ downloaded: 0, total: null });
      setError(null);
    },
    onError: (err: Error) => {
      setPhase("error");
      setError(err.message);
    },
  });

  const reset = () => {
    setPhase("idle");
    setProgress({ downloaded: 0, total: null });
    setError(null);
  };

  return {
    install: () => mutation.mutate(),
    phase,
    progress,
    error,
    isPending: phase === "downloading" || phase === "installing",
    reset,
  };
}
