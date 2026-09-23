// useSyncActions
// React Query mutations for device sync operations.
// Each invalidates ['sync'] queries on success.
// Replaces: OPERATION_START/END, all useCallback wrappers for operations.
// ========================================================================

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { syncService } from "../services/sync-service";

export function useSyncActions() {
  const queryClient = useQueryClient();

  const invalidateSync = () => {
    queryClient.invalidateQueries({ queryKey: ["sync"] });
  };

  const enableSync = useMutation({
    mutationFn: () => syncService.enableSync(),
    onSuccess: invalidateSync,
  });

  const resetSync = useMutation({
    mutationFn: async () => {
      await syncService.resetSync();
      await syncService.clearSyncData();
    },
    onSuccess: invalidateSync,
  });

  const reinitializeSync = useMutation({
    mutationFn: () => syncService.reinitializeSync(),
    onSuccess: invalidateSync,
  });

  const handleRecovery = useMutation({
    mutationFn: () => syncService.handleRecovery(),
    onSuccess: invalidateSync,
  });

  const clearSyncData = useMutation({
    mutationFn: () => syncService.clearSyncData(),
    onSuccess: invalidateSync,
  });

  const startBgSync = useMutation({
    mutationFn: () => syncService.startBackgroundEngine(),
    onSuccess: invalidateSync,
  });

  const stopBgSync = useMutation({
    mutationFn: () => syncService.stopBackgroundEngine(),
    onSuccess: invalidateSync,
  });

  const generateSnapshot = useMutation({
    mutationFn: () => syncService.generateSnapshotNow(),
    onSuccess: invalidateSync,
  });

  const triggerSyncCycle = useMutation({
    mutationFn: () => syncService.triggerSyncCycle(),
    onSuccess: invalidateSync,
  });

  return {
    enableSync,
    resetSync,
    reinitializeSync,
    handleRecovery,
    clearSyncData,
    startBgSync,
    stopBgSync,
    generateSnapshot,
    triggerSyncCycle,
  };
}
