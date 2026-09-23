// useRestoreOperation
// The single frontend controller for the profile's restore operation.
// The backend runtime owns restoration; this hook only reads its state and
// forwards the user's decisions. Pairing and recovery both use it.
// ================================================================

import {
  approveDeviceSyncRestore,
  cancelDeviceSyncRestore,
  getDeviceSyncRestore,
  listenDeviceSyncRestore,
  logger,
  retryDeviceSyncRestore,
  startDeviceSyncRestore,
} from "@/adapters";
import type { BackendRestoreOperation } from "@/adapters";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useReducer } from "react";

export type RestoreOperation = BackendRestoreOperation;

export const RESTORE_OPERATION_QUERY_KEY = ["sync", "restore"] as const;

// Events are the primary signal; this read-only poll covers missed events.
const WORKING_POLL_INTERVAL_MS = 2_000;

// Whether the user wants to see an attempt: `true` once they started, opened or
// approved it, `false` once they hid it, unset for automatic checks. Kept
// outside React so it outlives remounts of the screens that show it.
const restoreVisibility = new Map<string, boolean>();

/** `undefined` when the user has neither asked for nor hidden this attempt. */
export function restoreVisibilityOf(operationId: string): boolean | undefined {
  return restoreVisibility.get(operationId);
}

/** Shows and hides restores for the user; hiding never cancels. */
export function useRestoreVisibility() {
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  return useMemo(
    () => ({
      show: (operationId: string) => {
        restoreVisibility.set(operationId, true);
        rerender();
      },
      hide: (operationId: string) => {
        restoreVisibility.set(operationId, false);
        rerender();
      },
    }),
    [],
  );
}

export function isRestoreWorking(operation: RestoreOperation | null | undefined): boolean {
  return (
    !!operation &&
    ["transferring", "waiting_for_snapshot", "backing_up", "replacing"].includes(operation.phase)
  );
}

export function isRestoreFinished(operation: RestoreOperation | null | undefined): boolean {
  return !!operation && ["ready", "failed", "cancelled"].includes(operation.phase);
}

/**
 * Keeps the newest state. Events from other tabs and windows can arrive out of
 * order, so an older revision never replaces a newer one.
 */
export function mergeRestoreOperation(
  current: RestoreOperation | null | undefined,
  incoming: RestoreOperation,
): RestoreOperation {
  if (!current) return incoming;
  if (current.operationId === incoming.operationId) {
    return incoming.revision >= current.revision ? incoming : current;
  }
  // A new attempt replaces a finished one; stale events of an older attempt do not.
  return incoming.revision > current.revision ||
    (isRestoreFinished(current) && !isRestoreFinished(incoming))
    ? incoming
    : current;
}

// Command results and events both carry revisions, so either can arrive late.
function applyRestoreOperation(queryClient: QueryClient, incoming: RestoreOperation | null) {
  if (!incoming) return;
  const previous = queryClient.getQueryData<RestoreOperation | null>(RESTORE_OPERATION_QUERY_KEY);
  const next = mergeRestoreOperation(previous, incoming);
  queryClient.setQueryData(RESTORE_OPERATION_QUERY_KEY, next);
  const becameReady =
    next.phase === "ready" &&
    (previous?.operationId !== next.operationId || previous.phase !== "ready");
  if (becameReady && next.replaced) {
    // Every screen reads data that was just replaced.
    void queryClient.invalidateQueries();
  } else if (becameReady) {
    void queryClient.invalidateQueries({ queryKey: ["sync"] });
  }
}

interface StartRestoreArgs {
  /** The user asked to finish setup; otherwise a recurring check. */
  newAttempt: boolean;
}

interface ApproveRestoreArgs {
  operationId: string;
  backup: boolean;
}

export function useRestoreOperation({ enabled = true }: { enabled?: boolean } = {}) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: RESTORE_OPERATION_QUERY_KEY,
    // A poll is the server's current answer. Revisions only order updates of
    // the same operation (they restart with the server), so a slow poll may not
    // roll back a newer event, but a different operation is taken as is.
    queryFn: async () => {
      const incoming = await getDeviceSyncRestore();
      const current = queryClient.getQueryData<RestoreOperation | null>(
        RESTORE_OPERATION_QUERY_KEY,
      );
      if (!incoming || current?.operationId !== incoming.operationId) return incoming;
      return mergeRestoreOperation(current, incoming);
    },
    enabled,
    refetchInterval: (current) =>
      isRestoreWorking(current.state.data) ? WORKING_POLL_INTERVAL_MS : false,
    retry: false,
  });

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let unlisten: (() => Promise<void>) | undefined;
    listenDeviceSyncRestore<RestoreOperation>((event) => {
      applyRestoreOperation(queryClient, event.payload);
    })
      .then((stop) => {
        if (disposed) void stop();
        else unlisten = stop;
      })
      .catch((err) => logger.warn(`[DeviceSync] Restore events unavailable: ${err}`));
    return () => {
      disposed = true;
      void unlisten?.();
    };
  }, [enabled, queryClient]);

  const settle = (operation: RestoreOperation | null) =>
    applyRestoreOperation(queryClient, operation);

  const start = useMutation({
    mutationFn: ({ newAttempt }: StartRestoreArgs) => startDeviceSyncRestore(newAttempt),
    onSuccess: (operation, { newAttempt }) => {
      // Every user-started attempt stays visible, wherever it was started.
      if (operation && newAttempt) restoreVisibility.set(operation.operationId, true);
      settle(operation);
    },
  });
  const approve = useMutation({
    mutationFn: ({ operationId, backup }: ApproveRestoreArgs) =>
      approveDeviceSyncRestore(operationId, backup),
    onSuccess: (operation) => {
      // Having approved it, the user follows it to the end.
      restoreVisibility.set(operation.operationId, true);
      settle(operation);
    },
  });
  const retry = useMutation({
    mutationFn: (operationId: string) => retryDeviceSyncRestore(operationId),
    onSuccess: settle,
  });
  const cancel = useMutation({
    mutationFn: (operationId: string) => cancelDeviceSyncRestore(operationId),
    onSuccess: settle,
  });

  return {
    operation: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error,
    /** Record a result obtained outside these mutations, such as pairing. */
    settle,
    start,
    approve,
    retry,
    cancel,
  };
}

export type RestoreController = ReturnType<typeof useRestoreOperation>;
