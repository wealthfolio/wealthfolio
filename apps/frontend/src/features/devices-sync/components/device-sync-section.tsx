// DeviceSyncSection
// Main UI for device sync - shows appropriate UI based on sync state
// State Machine: FRESH → REGISTERED → READY (+ STALE, RECOVERY)
// ==================================================================

import {
  backupDatabase,
  backupDatabaseToPath,
  backupDatabaseToPendingExport,
  isWeb,
  openFolderDialog,
  saveAppDataFileViaPicker,
} from "@/adapters";
import { getPlatform as getRuntimePlatform } from "@/hooks/use-platform";
import { useQueryClient } from "@tanstack/react-query";
import { Icons, Skeleton } from "@wealthfolio/ui";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@wealthfolio/ui/components/ui/alert-dialog";
import { Avatar, AvatarFallback } from "@wealthfolio/ui/components/ui/avatar";
import { Badge } from "@wealthfolio/ui/components/ui/badge";
import { Button } from "@wealthfolio/ui/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@wealthfolio/ui/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@wealthfolio/ui/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@wealthfolio/ui/components/ui/dropdown-menu";
import { Input } from "@wealthfolio/ui/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@wealthfolio/ui/components/ui/tooltip";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { toast } from "sonner";
import {
  useDevices,
  useRenameDevice,
  useRevokeDevice,
  useSyncActions,
  useSyncStatus,
  type PairingBootstrapState,
} from "../hooks";
import { syncService } from "../services/sync-service";
import { SyncStates, type Device } from "../types";
import { logSyncError, userFacingSyncErrorMessage } from "../utils/error-messages";
import { E2EESetupCard } from "./e2ee-setup-card";
import { PairingFlow, WaitingState } from "./pairing-flow";
import { RecoveryDialog } from "./recovery-dialog";

const PORTAL_DEVICES_URL = "https://connect.wealthfolio.app/settings/devices";

type BootstrapOwner = "none" | "pairing" | "pairing_failed" | "ready_state";

const platformIcons: Record<string, typeof Icons.Monitor> = {
  macos: Icons.Monitor,
  mac: Icons.Monitor,
  windows: Icons.Monitor,
  linux: Icons.Monitor,
  ios: Icons.Smartphone,
  android: Icons.Smartphone,
  server: Icons.Cloud,
  web: Icons.Cloud,
};

export function DeviceSyncSection() {
  const { t } = useTranslation();
  const status = useSyncStatus();
  const actions = useSyncActions();
  const queryClient = useQueryClient();
  const { data: myDevices } = useDevices("my");
  const otherConnectedDevices = (myDevices ?? []).filter(
    (d) => d.trustState !== "revoked" && !d.isCurrent,
  ).length;

  const [isPairingOpen, setIsPairingOpen] = useState(false);
  const [isPreparing, setIsPreparing] = useState(false);
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const [showReinitConfirmDialog, setShowReinitConfirmDialog] = useState(false);
  const [showRecoveryDialog, setShowRecoveryDialog] = useState(false);
  const [showBootstrapOverwriteDialog, setShowBootstrapOverwriteDialog] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isBackingUpBeforeBootstrap, setIsBackingUpBeforeBootstrap] = useState(false);
  const [isUploadingSnapshot, setIsUploadingSnapshot] = useState(false);
  const [bootstrapOwner, setBootstrapOwner] = useState<BootstrapOwner>("none");
  const [suppressReadyStateBootstrapPrompt, setSuppressReadyStateBootstrapPrompt] = useState(false);

  // Bootstrap overwrite state — set when bootstrapSync returns overwrite_required
  const [overwriteRisk, setOverwriteRisk] = useState<{
    localRows: number;
    nonEmptyTables: { table: string; rows: number }[];
  } | null>(null);

  const isBackgroundRunning = status.engineStatus?.backgroundRunning ?? false;
  const isCurrentDeviceTrusted = status.device?.trustState === "trusted";
  const bootstrapOwnerRef = useRef<BootstrapOwner>(bootstrapOwner);
  const isPairingOpenRef = useRef(isPairingOpen);
  const isCurrentDeviceTrustedRef = useRef(isCurrentDeviceTrusted);
  const suppressReadyStateBootstrapPromptRef = useRef(suppressReadyStateBootstrapPrompt);

  useEffect(() => {
    bootstrapOwnerRef.current = bootstrapOwner;
  }, [bootstrapOwner]);

  useEffect(() => {
    isPairingOpenRef.current = isPairingOpen;
  }, [isPairingOpen]);

  useEffect(() => {
    isCurrentDeviceTrustedRef.current = isCurrentDeviceTrusted;
  }, [isCurrentDeviceTrusted]);

  useEffect(() => {
    suppressReadyStateBootstrapPromptRef.current = suppressReadyStateBootstrapPrompt;
  }, [suppressReadyStateBootstrapPrompt]);

  const releasePairingBootstrapOwner = useCallback(() => {
    if (bootstrapOwnerRef.current === "pairing" || bootstrapOwnerRef.current === "pairing_failed") {
      bootstrapOwnerRef.current = "none";
    }
    setBootstrapOwner((owner) =>
      owner === "pairing" || owner === "pairing_failed" ? "none" : owner,
    );
  }, []);

  const canRunReadyStateBootstrap = useCallback((ignorePromptSuppression = false) => {
    return (
      bootstrapOwnerRef.current === "none" &&
      !isPairingOpenRef.current &&
      isCurrentDeviceTrustedRef.current &&
      (ignorePromptSuppression || !suppressReadyStateBootstrapPromptRef.current)
    );
  }, []);

  const closeReadyStateBootstrapPrompt = useCallback(() => {
    setShowBootstrapOverwriteDialog(false);
    setOverwriteRisk(null);
    setBootstrapOwner((owner) => (owner === "ready_state" ? "none" : owner));
  }, []);

  const openPairingDialog = useCallback(() => {
    isPairingOpenRef.current = true;
    closeReadyStateBootstrapPrompt();
    setIsPairingOpen(true);
  }, [closeReadyStateBootstrapPrompt]);

  const handlePairingDialogOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        openPairingDialog();
        return;
      }
      isPairingOpenRef.current = false;
      setIsPairingOpen(false);
    },
    [openPairingDialog],
  );

  const handleReadyPairingDialogOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        openPairingDialog();
        return;
      }
      isPairingOpenRef.current = false;
      setIsPairingOpen(false);
      setIsPreparing(false);
      setPrepareError(null);
    },
    [openPairingDialog],
  );

  const handlePairingComplete = useCallback(() => {
    setSuppressReadyStateBootstrapPrompt(true);
    setShowBootstrapOverwriteDialog(false);
    setOverwriteRisk(null);
    releasePairingBootstrapOwner();
    isPairingOpenRef.current = false;
    setIsPairingOpen(false);
    setIsPreparing(false);
    setPrepareError(null);
    queryClient.invalidateQueries({ queryKey: ["sync", "device", "current"] });
    status.refetch();
  }, [queryClient, releasePairingBootstrapOwner, status.refetch]);

  const handlePairingCancel = useCallback(() => {
    releasePairingBootstrapOwner();
    isPairingOpenRef.current = false;
    setIsPairingOpen(false);
    setIsPreparing(false);
    setPrepareError(null);
  }, [releasePairingBootstrapOwner]);

  const handlePairingBootstrapStateChange = useCallback(
    (state: PairingBootstrapState) => {
      if (state === "active" || state === "failed") {
        setShowBootstrapOverwriteDialog(false);
        setOverwriteRisk(null);
      }
      if (state === "idle") {
        releasePairingBootstrapOwner();
        return;
      }
      bootstrapOwnerRef.current = state === "active" ? "pairing" : "pairing_failed";
      setBootstrapOwner((owner) => {
        if (state === "active") return "pairing";
        if (state === "failed") return "pairing_failed";
        return owner === "pairing" ? "none" : owner;
      });
    },
    [releasePairingBootstrapOwner],
  );

  const handleRefresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["sync", "device", "current"] });
    status.refetch();
  }, [queryClient, status.refetch]);

  const handleRefreshDevices = useCallback(() => {
    setIsRefreshing(true);
    queryClient.invalidateQueries({ queryKey: ["sync", "devices"] });
    setTimeout(() => setIsRefreshing(false), 600);
  }, [queryClient]);

  const handleToggleEngine = useCallback(async () => {
    try {
      if (isBackgroundRunning) {
        await actions.stopBgSync.mutateAsync();
        toast.success(t("sync:engine.backgroundPaused"));
      } else {
        await actions.startBgSync.mutateAsync();
        toast.success(t("sync:engine.backgroundResumed"));
      }
    } catch (err) {
      logSyncError("Failed to update background sync", err);
      toast.error(t("sync:engine.updateFailed"), {
        description: userFacingSyncErrorMessage(err),
      });
    }
  }, [actions, isBackgroundRunning, t]);

  const handleBackupBeforeBootstrap = useCallback(async (): Promise<boolean> => {
    setIsBackingUpBeforeBootstrap(true);
    try {
      let backupLocation: string;

      if (isWeb) {
        const { filename } = await backupDatabase();
        backupLocation = filename;
      } else {
        const runtimePlatform = await getRuntimePlatform();
        if (runtimePlatform.is_desktop) {
          const selectedDir = await openFolderDialog();
          if (!selectedDir) {
            return false;
          }
          backupLocation = await backupDatabaseToPath(selectedDir);
        } else {
          if (runtimePlatform.os !== "ios") {
            throw new Error(t("sync:errors.backupPlatformUnsupported"));
          }
          const { relativePath, filename } = await backupDatabaseToPendingExport();
          const saved = await saveAppDataFileViaPicker(relativePath, filename);
          if (!saved) {
            return false;
          }
          backupLocation = filename;
        }
      }

      toast.success(t("sync:backup.savedTitle"), {
        description: t("sync:backup.savedDescription", { location: backupLocation }),
      });
      return true;
    } catch (err) {
      logSyncError("Backup before bootstrap failed", err);
      toast.error(t("sync:backup.failedTitle"), {
        description: userFacingSyncErrorMessage(err),
      });
      return false;
    } finally {
      setIsBackingUpBeforeBootstrap(false);
    }
  }, [t]);

  const handleApplyBootstrapOverwrite = useCallback(async () => {
    setBootstrapOwner("ready_state");
    try {
      const result = await actions.bootstrapSync.mutateAsync({ allowOverwrite: true });
      if (result.status === "error") {
        throw new Error(result.message);
      }
      if (result.status === "not_ready") {
        throw new Error(result.message);
      }
      setOverwriteRisk(null);
      setShowBootstrapOverwriteDialog(false);
      setBootstrapOwner((owner) => (owner === "ready_state" ? "none" : owner));
    } catch (err) {
      logSyncError("Bootstrap overwrite failed", err);
      toast.error(t("sync:bootstrap.unableToContinueTitle"), {
        description: userFacingSyncErrorMessage(err),
      });
    }
  }, [actions, t]);

  const handleBackupThenApplyOverwrite = useCallback(async () => {
    const saved = await handleBackupBeforeBootstrap();
    if (!saved) {
      return;
    }
    await handleApplyBootstrapOverwrite();
  }, [handleApplyBootstrapOverwrite, handleBackupBeforeBootstrap]);

  const handleBootstrapOverwriteDialogOpenChange = useCallback(
    (open: boolean) => {
      if (open && !canRunReadyStateBootstrap()) return;
      setShowBootstrapOverwriteDialog(open);
      setBootstrapOwner((owner) => {
        if (open) return owner === "none" ? "ready_state" : owner;
        return owner === "ready_state" ? "none" : owner;
      });
    },
    [canRunReadyStateBootstrap],
  );

  const runBootstrapCheck = useCallback(
    async (showToast: boolean, autoOpenDialog = false, ignorePromptSuppression = false) => {
      if (!canRunReadyStateBootstrap(ignorePromptSuppression)) return;

      try {
        const result = await actions.bootstrapSync.mutateAsync({ allowOverwrite: false });
        if (!canRunReadyStateBootstrap(ignorePromptSuppression)) return;
        if (result.status === "overwrite_required") {
          if (ignorePromptSuppression) {
            setSuppressReadyStateBootstrapPrompt(false);
          }
          setOverwriteRisk({
            localRows: result.localRows,
            nonEmptyTables: result.nonEmptyTables,
          });
          if (autoOpenDialog) {
            setBootstrapOwner("ready_state");
            setShowBootstrapOverwriteDialog(true);
          }
          return;
        }

        if (result.status === "error") {
          throw new Error(result.message);
        }
        if (result.status === "not_ready") {
          throw new Error(result.message);
        }

        setOverwriteRisk(null);
        setBootstrapOwner((owner) => (owner === "ready_state" ? "none" : owner));
        if (showToast) {
          if (result.status === "waiting_snapshot") {
            toast.message(t("sync:bootstrap.waitingOtherDeviceTitle"), {
              description: t("sync:bootstrap.waitingOtherDeviceDescription"),
            });
          } else {
            toast.success(t("sync:bootstrap.retryStartedTitle"), {
              description: t("sync:bootstrap.retryStartedDescription"),
            });
          }
        }
      } catch (err) {
        logSyncError("Bootstrap retry failed", err);
        if (showToast) {
          toast.error(t("sync:bootstrap.couldNotRetryTitle"), {
            description: userFacingSyncErrorMessage(err),
          });
        }
      }
    },
    [actions, canRunReadyStateBootstrap, t],
  );

  const handleRetryBootstrap = useCallback(async () => {
    setSuppressReadyStateBootstrapPrompt(false);
    if (bootstrapOwnerRef.current === "pairing_failed") {
      bootstrapOwnerRef.current = "none";
    }
    setBootstrapOwner((owner) => (owner === "pairing_failed" ? "none" : owner));
    await runBootstrapCheck(true, true, true);
  }, [runBootstrapCheck]);

  const handleUploadSnapshotNow = useCallback(async () => {
    setIsUploadingSnapshot(true);
    try {
      const result = await actions.generateSnapshot.mutateAsync();
      if (result.status === "uploaded") {
        toast.success(t("sync:snapshot.uploadedTitle"), {
          description: t("sync:snapshot.uploadedDescription"),
        });
        return;
      }
      if (result.status === "skipped") {
        toast.message(t("sync:snapshot.skippedTitle"), {
          description: result.message,
        });
        return;
      }
      if (result.status === "cancelled") {
        toast.message(t("sync:snapshot.cancelledTitle"), {
          description: result.message,
        });
        return;
      }
      toast.message(t("sync:snapshot.resultTitle"), {
        description: result.message,
      });
    } catch (err) {
      logSyncError("Snapshot upload failed", err);
      toast.error(t("sync:snapshot.failedTitle"), {
        description: userFacingSyncErrorMessage(err),
      });
    } finally {
      setIsUploadingSnapshot(false);
    }
  }, [actions, t]);

  const runReinitAndOpenPairing = useCallback(async () => {
    setBootstrapOwner((owner) => (owner === "pairing_failed" ? "none" : owner));
    setIsPreparing(true);
    setPrepareError(null);
    openPairingDialog();
    try {
      await actions.reinitializeSync.mutateAsync();
      setIsPreparing(false);
    } catch (err) {
      logSyncError("Pairing preparation failed", err);
      setPrepareError(userFacingSyncErrorMessage(err));
    }
  }, [actions.reinitializeSync, openPairingDialog]);

  const openClaimerPairingFlow = useCallback(() => {
    setBootstrapOwner((owner) => (owner === "pairing_failed" ? "none" : owner));
    setPrepareError(null);
    setIsPreparing(false);
    openPairingDialog();
  }, [openPairingDialog]);

  const beginPairingFlow = useCallback(async () => {
    setBootstrapOwner((owner) => (owner === "pairing_failed" ? "none" : owner));
    setPrepareError(null);
    setIsPreparing(true);

    try {
      const pairingSource = await syncService.getPairingSourceStatus();
      if (pairingSource.status === "restore_required") {
        if (otherConnectedDevices === 0) {
          await actions.reinitializeSync.mutateAsync();
          setIsPreparing(false);
          return;
        }

        setIsPreparing(false);
        setShowReinitConfirmDialog(true);
        return;
      }

      setIsPreparing(false);
      openPairingDialog();
    } catch (err) {
      logSyncError("Pairing source check failed", err);
      setPrepareError(userFacingSyncErrorMessage(err));
      openPairingDialog();
    }
  }, [actions.reinitializeSync, openPairingDialog, otherConnectedDevices]);

  const handleLinkAnotherDevice = useCallback(() => {
    void beginPairingFlow();
  }, [beginPairingFlow]);

  const handleReinitConfirm = useCallback(async () => {
    setShowReinitConfirmDialog(false);
    await runReinitAndOpenPairing();
  }, [runReinitAndOpenPairing]);

  // Keep recovery dialog strictly in sync with RECOVERY state.
  useEffect(() => {
    setShowRecoveryDialog(status.syncState === SyncStates.RECOVERY);
  }, [status.syncState]);

  useEffect(() => {
    if (status.syncState !== SyncStates.READY) return;
    if (!isCurrentDeviceTrusted) return;
    if (bootstrapOwner !== "none") return;
    if (actions.bootstrapSync.isPending) return;
    if (overwriteRisk) return;
    if (isPairingOpen) return;
    if (status.engineIsFetching) return;

    const engineNeedsBootstrap =
      status.engineStatus?.lastCycleStatus === "wait_snapshot" ||
      status.engineStatus?.lastCycleStatus === "stale_cursor" ||
      status.engineStatus?.bootstrapRequired === true;

    if (!engineNeedsBootstrap) return;

    const timer = window.setTimeout(() => {
      void runBootstrapCheck(false, true);
    }, 2000);

    return () => {
      window.clearTimeout(timer);
    };
  }, [
    status.syncState,
    status.engineStatus?.lastCycleStatus,
    status.engineStatus?.bootstrapRequired,
    status.engineIsFetching,
    isCurrentDeviceTrusted,
    bootstrapOwner,
    actions.bootstrapSync.isPending,
    overwriteRisk,
    isPairingOpen,
    runBootstrapCheck,
  ]);

  useEffect(() => {
    if (!suppressReadyStateBootstrapPrompt) return;
    if (status.engineIsFetching || !status.engineStatus) return;

    const engineNeedsBootstrap =
      status.engineStatus.lastCycleStatus === "wait_snapshot" ||
      status.engineStatus.lastCycleStatus === "stale_cursor" ||
      status.engineStatus.bootstrapRequired === true;

    if (!engineNeedsBootstrap) {
      setSuppressReadyStateBootstrapPrompt(false);
    }
  }, [
    suppressReadyStateBootstrapPrompt,
    status.engineIsFetching,
    status.engineStatus?.lastCycleStatus,
    status.engineStatus?.bootstrapRequired,
    status.engineStatus,
  ]);

  // Loading state (detecting)
  if (status.isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-32" />
          <Skeleton className="mt-2 h-4 w-64" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    );
  }

  // Error during state detection
  if (status.error && status.syncState === SyncStates.FRESH) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-medium">{t("sync:section.deviceSync")}</CardTitle>
          <CardDescription>{t("sync:errorState.failedToInitialize")}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center py-6 text-center">
            <Icons.AlertCircle className="text-destructive mb-3 h-10 w-10 opacity-70" />
            <p className="text-destructive text-sm font-medium">
              {t("sync:errorState.initializationFailed")}
            </p>
            <p className="text-muted-foreground mt-1 max-w-sm text-xs">
              {userFacingSyncErrorMessage(status.error)}
            </p>
            <Button variant="outline" className="mt-4" onClick={handleRefresh}>
              <Icons.RefreshCw className="mr-2 h-4 w-4" />
              {t("common:retry")}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  // FRESH state - Show enable sync card
  if (status.syncState === SyncStates.FRESH) {
    return <E2EESetupCard onPairingNeeded={openPairingDialog} />;
  }

  // ORPHANED state - Keys exist on server but no trusted devices to pair with
  if (status.syncState === SyncStates.ORPHANED) {
    return (
      <Card>
        <CardContent className="p-4">
          {/* Header row - matches other cards pattern */}
          <div className="flex items-center gap-2">
            <div className="bg-muted flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
              <Icons.Smartphone className="text-muted-foreground h-4 w-4" />
            </div>
            <h3 className="text-base font-semibold">{t("sync:section.deviceSync")}</h3>
          </div>
          <OrphanedKeysPrompt
            onReinitialize={async () => {
              await actions.reinitializeSync.mutateAsync();
            }}
          />
        </CardContent>
      </Card>
    );
  }

  // REGISTERED state - Needs pairing with existing trusted device
  if (status.syncState === SyncStates.REGISTERED) {
    return (
      <Card>
        <CardContent className="p-4">
          {/* Header row - matches other cards pattern */}
          <div className="flex items-center gap-2">
            <div className="bg-muted flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
              <Icons.Smartphone className="text-muted-foreground h-4 w-4" />
            </div>
            <h3 className="text-base font-semibold">{t("sync:section.connectedDevices")}</h3>
          </div>

          <div className="mt-4">
            <ConnectedDevicesList
              onResetSync={() => actions.resetSync.mutateAsync()}
              onLinkDevice={openPairingDialog}
              mode="unpaired"
              trustedDeviceCount={status.trustedDevices.length}
            />
          </div>
        </CardContent>

        {/* Pairing Dialog */}
        <Dialog open={isPairingOpen} onOpenChange={handlePairingDialogOpenChange}>
          <DialogContent
            className="sm:max-w-[420px]"
            mobileClassName="pb-8"
            showCloseButton={false}
            onEscapeKeyDown={(e) => e.preventDefault()}
            onInteractOutside={(e) => e.preventDefault()}
          >
            <DialogHeader className="sr-only">
              <DialogTitle>{t("sync:pairing.connectThisDeviceTitle")}</DialogTitle>
            </DialogHeader>
            <PairingFlow
              onComplete={handlePairingComplete}
              onCancel={handlePairingCancel}
              onBootstrapStateChange={handlePairingBootstrapStateChange}
              title={t("sync:pairing.connectThisDeviceTitle")}
              description={t("sync:pairing.enterCodeDescription")}
              forceRole="claimer"
            />
          </DialogContent>
        </Dialog>
      </Card>
    );
  }

  // STALE state - Keys are out of date, needs re-pairing
  if (status.syncState === SyncStates.STALE) {
    return (
      <Card>
        <CardContent className="p-4">
          {/* Header row - matches other cards pattern */}
          <div className="flex items-center gap-2">
            <div className="bg-muted flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
              <Icons.Smartphone className="text-muted-foreground h-4 w-4" />
            </div>
            <h3 className="text-base font-semibold">{t("sync:section.deviceSync")}</h3>
          </div>

          <div className="flex flex-col items-center justify-center py-4 text-center sm:py-6">
            <div className="mb-3 rounded-full bg-amber-100 p-2.5 sm:mb-4 sm:p-3 dark:bg-amber-900/30">
              <Icons.RefreshCw className="h-5 w-5 text-amber-600 sm:h-6 sm:w-6 dark:text-amber-400" />
            </div>
            <p className="text-foreground text-sm font-medium">
              {t("sync:stale.keysNeedUpdating")}
            </p>
            <p className="text-muted-foreground mt-1 max-w-xs text-xs">
              {t("sync:stale.keysNeedUpdatingDescription")}
            </p>
            <Button className="mt-3 sm:mt-4" onClick={openPairingDialog}>
              <Icons.Link className="mr-2 h-4 w-4" />
              {t("sync:stale.updateThisDevice")}
            </Button>
          </div>
        </CardContent>

        {/* Pairing Dialog */}
        <Dialog open={isPairingOpen} onOpenChange={handlePairingDialogOpenChange}>
          <DialogContent
            className="sm:max-w-[420px]"
            mobileClassName="pb-8"
            showCloseButton={false}
            onEscapeKeyDown={(e) => e.preventDefault()}
            onInteractOutside={(e) => e.preventDefault()}
          >
            <DialogHeader className="sr-only">
              <DialogTitle>{t("sync:stale.updateThisDevice")}</DialogTitle>
            </DialogHeader>
            <PairingFlow
              onComplete={handlePairingComplete}
              onCancel={handlePairingCancel}
              onBootstrapStateChange={handlePairingBootstrapStateChange}
              title={t("sync:stale.updateThisDevice")}
              description={t("sync:pairing.enterCodeDescription")}
              forceRole="claimer"
            />
          </DialogContent>
        </Dialog>
      </Card>
    );
  }

  // READY state - Show connected devices
  const isTrusted = isCurrentDeviceTrusted;
  // Show banner only when the engine actually reports it's stuck.
  // Don't use bootstrapRequired alone — it's derived from last_bootstrap_at
  // which can be NULL for devices bootstrapped before that column was added.
  const isWaitingForRemoteSnapshot =
    status.engineStatus?.lastCycleStatus === "wait_snapshot" ||
    status.engineStatus?.lastCycleStatus === "stale_cursor";
  const dialogTitle = isTrusted
    ? t("sync:pairing.connectAnotherTitle")
    : t("sync:pairing.connectThisDeviceTitle");
  const dialogDescription = isTrusted
    ? t("sync:pairing.scanOrEnterDescription")
    : t("sync:pairing.enterCodeDescription");
  const isTogglingEngine = actions.startBgSync.isPending || actions.stopBgSync.isPending;

  return (
    <>
      <Card>
        <CardContent className="p-4">
          {/* Header row - matches Broker connections / Accounts pattern */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className="bg-muted flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
                <Icons.Smartphone className="text-muted-foreground h-4 w-4" />
              </div>
              <h3 className="text-base font-semibold">{t("sync:section.connectedDevices")}</h3>
              <SyncStatusDot engineStatus={status.engineStatus} />
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:text-foreground h-8 w-8 sm:hidden"
                onClick={handleToggleEngine}
                disabled={isTogglingEngine}
              >
                {isTogglingEngine ? (
                  <Icons.Loader className="h-4 w-4 animate-spin" />
                ) : isBackgroundRunning ? (
                  <Icons.PauseCircle className="h-4 w-4" />
                ) : (
                  <Icons.PlayCircle className="h-4 w-4" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-foreground hidden sm:inline-flex"
                onClick={handleToggleEngine}
                disabled={isTogglingEngine}
              >
                {isTogglingEngine ? (
                  <>
                    <Icons.Loader className="h-4 w-4 animate-spin" />
                    {t("sync:engine.updating")}
                  </>
                ) : isBackgroundRunning ? (
                  <>
                    <Icons.PauseCircle className="h-4 w-4" />
                    {t("sync:engine.pauseSync")}
                  </>
                ) : (
                  <>
                    <Icons.PlayCircle className="h-4 w-4" />
                    {t("sync:engine.resumeSync")}
                  </>
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:text-foreground h-8 w-8"
                onClick={handleRefreshDevices}
                disabled={isRefreshing}
              >
                <Icons.RefreshCw className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`} />
              </Button>
              {/* Mobile: icon only */}
              <Button
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:text-foreground sm:hidden"
                onClick={() => window.open(PORTAL_DEVICES_URL, "_blank")}
              >
                <Icons.ExternalLink className="h-4 w-4" />
              </Button>
              {/* Desktop: full text */}
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-foreground hidden sm:inline-flex"
                onClick={() => window.open(PORTAL_DEVICES_URL, "_blank")}
              >
                {t("sync:section.manageDevices")}
                <Icons.ArrowRight className="ml-1 h-3.5 w-3.5" />
              </Button>
            </div>
          </div>

          {/* Content */}
          <div className="mt-4">
            {actions.bootstrapSync.isPending && (
              <div className="bg-muted/60 text-muted-foreground mb-3 flex items-center gap-2 rounded-md px-3 py-2 text-xs">
                <Icons.Loader className="h-3.5 w-3.5 animate-spin" />
                {t("sync:bootstrap.inProgress")}
              </div>
            )}
            {actions.bootstrapSync.error && (
              <div className="bg-destructive/10 text-destructive mb-3 flex items-center gap-2 rounded-md px-3 py-2 text-xs">
                <Icons.AlertCircle className="h-3.5 w-3.5" />
                {userFacingSyncErrorMessage(actions.bootstrapSync.error)}
              </div>
            )}
            {isWaitingForRemoteSnapshot && (
              <div className="bg-muted/60 text-muted-foreground mb-3 rounded-md px-3 py-3 text-xs">
                <div className="flex items-start gap-2">
                  <Icons.Cloud className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-foreground font-medium">
                      {isTrusted
                        ? t("sync:waitingSnapshot.otherDeviceFinishing")
                        : t("sync:waitingSnapshot.setupAlmostDone")}
                    </p>
                    <p className="mt-1 leading-relaxed">
                      {isTrusted
                        ? t("sync:waitingSnapshot.trustedHint")
                        : t("sync:waitingSnapshot.untrustedHint")}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleRetryBootstrap}
                        disabled={actions.bootstrapSync.isPending}
                      >
                        {actions.bootstrapSync.isPending ? (
                          <>
                            <Icons.Spinner className="mr-2 h-3.5 w-3.5 animate-spin" />
                            {t("sync:waitingSnapshot.checking")}
                          </>
                        ) : (
                          <>
                            <Icons.RefreshCw className="mr-2 h-3.5 w-3.5" />
                            {t("sync:waitingSnapshot.checkAgain")}
                          </>
                        )}
                      </Button>
                      {isTrusted && (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={handleUploadSnapshotNow}
                          disabled={isUploadingSnapshot}
                        >
                          {isUploadingSnapshot ? (
                            <>
                              <Icons.Spinner className="mr-2 h-3.5 w-3.5 animate-spin" />
                              {t("sync:waitingSnapshot.preparing")}
                            </>
                          ) : (
                            <>
                              <Icons.Upload className="mr-2 h-3.5 w-3.5" />
                              {t("sync:waitingSnapshot.speedUpSetup")}
                            </>
                          )}
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}
            {overwriteRisk && !isPairingOpen && (
              <div className="mb-3 rounded-md border border-amber-200 bg-amber-50/80 px-3 py-3 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-900/20 dark:text-amber-200">
                <div className="flex items-start gap-2">
                  <Icons.AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{t("sync:bootstrap.hasDataTitle")}</p>
                    <p className="mt-1 leading-relaxed">{t("sync:bootstrap.hasDataDescription")}</p>
                    <div className="mt-2">
                      <Button
                        size="sm"
                        onClick={() => handleBootstrapOverwriteDialogOpenChange(true)}
                      >
                        {t("sync:bootstrap.continue")}
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            )}
            {!status.device ? (
              <Skeleton className="h-16 w-full rounded-lg" />
            ) : !isTrusted ? (
              <ConnectedDevicesList
                onResetSync={() => actions.resetSync.mutateAsync()}
                onLinkDevice={openClaimerPairingFlow}
                mode="unpaired"
                trustedDeviceCount={status.trustedDevices.length}
              />
            ) : (
              <ConnectedDevicesList
                onResetSync={() => actions.resetSync.mutateAsync()}
                onLinkDevice={handleLinkAnotherDevice}
              />
            )}
          </div>
        </CardContent>

        {/* Pairing Dialog */}
        <Dialog open={isPairingOpen} onOpenChange={handleReadyPairingDialogOpenChange}>
          <DialogContent
            className="sm:max-w-[420px]"
            mobileClassName="pb-8"
            showCloseButton={false}
            onEscapeKeyDown={(e) => e.preventDefault()}
            onInteractOutside={(e) => e.preventDefault()}
          >
            <DialogHeader className="sr-only">
              <DialogTitle>{dialogTitle}</DialogTitle>
            </DialogHeader>
            {isPreparing && !prepareError ? (
              <WaitingState
                title={t("sync:pairing.gettingReadyTitle")}
                description={t("sync:pairing.gettingReadyDescription")}
              />
            ) : isPreparing && prepareError ? (
              <div className="flex flex-col items-center px-4 py-6">
                <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/30">
                  <Icons.XCircle className="h-10 w-10 text-red-600 dark:text-red-500" />
                </div>
                <div className="mb-6 text-center">
                  <p className="text-foreground text-base font-semibold">
                    {t("sync:pairing.prepareFailed")}
                  </p>
                  <p className="text-muted-foreground mt-2 max-w-[240px] text-sm">{prepareError}</p>
                </div>
                <div className="flex gap-3">
                  <Button variant="outline" onClick={() => void beginPairingFlow()}>
                    {t("sync:pairing.tryAgain")}
                  </Button>
                  <Button variant="ghost" onClick={handlePairingCancel}>
                    {t("common:cancel")}
                  </Button>
                </div>
              </div>
            ) : (
              <PairingFlow
                onComplete={handlePairingComplete}
                onCancel={handlePairingCancel}
                onBootstrapStateChange={handlePairingBootstrapStateChange}
                title={dialogTitle}
                description={dialogDescription}
              />
            )}
          </DialogContent>
        </Dialog>

        <AlertDialog
          open={
            showBootstrapOverwriteDialog &&
            bootstrapOwner === "ready_state" &&
            !isPairingOpen &&
            !!overwriteRisk
          }
          onOpenChange={handleBootstrapOverwriteDialogOpenChange}
        >
          <AlertDialogContent className="max-sm:bg-background/90 gap-8 text-center max-sm:bottom-6 max-sm:left-4 max-sm:right-4 max-sm:top-auto max-sm:w-auto max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-3xl max-sm:shadow-2xl max-sm:backdrop-blur-2xl sm:max-w-lg">
            <AlertDialogHeader className="items-center gap-4 px-8 text-center">
              <div className="border-warning/30 bg-warning/10 dark:border-warning/20 dark:bg-warning/15 flex h-14 w-14 items-center justify-center rounded-full border">
                <Icons.AlertTriangle className="h-6 w-6 text-amber-500" />
              </div>
              <AlertDialogTitle className="text-center text-xl">
                {t("sync:overwrite.replaceDataTitle")}
              </AlertDialogTitle>
              <AlertDialogDescription className="text-center text-sm">
                {t("sync:overwrite.replaceDataDescription")}
              </AlertDialogDescription>
              {overwriteRisk && overwriteRisk.localRows > 0 && (
                <p className="text-muted-foreground text-center text-xs">
                  {t("sync:overwrite.localRowsReplaced", { count: overwriteRisk.localRows })}
                </p>
              )}
            </AlertDialogHeader>

            <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
              <Button
                variant="ghost"
                onClick={() => handleBootstrapOverwriteDialogOpenChange(false)}
                disabled={isBackingUpBeforeBootstrap || actions.bootstrapSync.isPending}
              >
                {t("sync:overwrite.notNow")}
              </Button>
              <Button
                variant="outline"
                onClick={handleBackupThenApplyOverwrite}
                disabled={isBackingUpBeforeBootstrap || actions.bootstrapSync.isPending}
              >
                {isBackingUpBeforeBootstrap ? (
                  <>
                    <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                    {t("sync:backup.backingUp")}
                  </>
                ) : (
                  t("sync:backup.backUpFirst")
                )}
              </Button>
              <Button
                onClick={handleApplyBootstrapOverwrite}
                disabled={isBackingUpBeforeBootstrap || actions.bootstrapSync.isPending}
              >
                {actions.bootstrapSync.isPending ? (
                  <>
                    <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                    {t("sync:overwrite.syncing")}
                  </>
                ) : (
                  t("sync:overwrite.replaceAndSync")
                )}
              </Button>
            </div>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog open={showReinitConfirmDialog} onOpenChange={setShowReinitConfirmDialog}>
          <AlertDialogContent className="max-sm:bg-background/90 gap-8 text-center max-sm:bottom-6 max-sm:left-4 max-sm:right-4 max-sm:top-auto max-sm:w-auto max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-3xl max-sm:shadow-2xl max-sm:backdrop-blur-2xl sm:max-w-lg">
            <AlertDialogHeader className="items-center gap-4 px-8 text-center">
              <div className="border-warning/30 bg-warning/10 dark:border-warning/20 dark:bg-warning/15 flex h-14 w-14 items-center justify-center rounded-full border">
                <Icons.AlertTriangle className="h-6 w-6 text-amber-500" />
              </div>
              <AlertDialogTitle className="text-center text-xl">
                {t("sync:reinit.title")}
              </AlertDialogTitle>
              <AlertDialogDescription className="text-center text-sm">
                {t("sync:reinit.description")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
              <Button variant="ghost" onClick={() => setShowReinitConfirmDialog(false)}>
                {t("sync:reinit.notNow")}
              </Button>
              <Button onClick={() => void handleReinitConfirm()}>
                {t("sync:reinit.continue")}
              </Button>
            </div>
          </AlertDialogContent>
        </AlertDialog>
      </Card>

      {/* Recovery Dialog */}
      <RecoveryDialog open={showRecoveryDialog} onOpenChange={setShowRecoveryDialog} />
    </>
  );
}

// Prompt for untrusted device
function UntrustedDevicePrompt({
  onStartPairing,
  trustedDeviceCount,
}: {
  onStartPairing: () => void;
  trustedDeviceCount?: number;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center py-4 text-center sm:py-6">
      <div className="bg-muted/50 mb-3 rounded-full p-2.5 sm:mb-4 sm:p-3">
        <Icons.ShieldAlert className="h-5 w-5 opacity-60 sm:h-6 sm:w-6" />
      </div>
      <p className="text-foreground text-sm font-medium">{t("sync:untrusted.notConnectedYet")}</p>
      <p className="text-muted-foreground mt-1 max-w-xs text-xs">
        {trustedDeviceCount !== undefined && trustedDeviceCount > 0
          ? t("sync:untrusted.enterCodeFromDevices", { count: trustedDeviceCount })
          : t("sync:untrusted.enterCodeGeneric")}
      </p>
      <Button className="mt-3 sm:mt-4" onClick={onStartPairing}>
        <Icons.Link className="mr-2 h-4 w-4" />
        {t("sync:untrusted.connectThisDevice")}
      </Button>
    </div>
  );
}

// Prompt for orphaned state (keys exist but no trusted devices)
function OrphanedKeysPrompt({ onReinitialize }: { onReinitialize: () => Promise<void> }) {
  const { t } = useTranslation();
  const [isReinitializing, setIsReinitializing] = useState(false);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);

  const handleReinitialize = async () => {
    setIsReinitializing(true);
    try {
      await onReinitialize();
      setShowConfirmDialog(false);
    } catch (err) {
      logSyncError("Reinitialize sync failed", err);
      toast.error(t("sync:toasts.reinitFailed"), { description: userFacingSyncErrorMessage(err) });
    } finally {
      setIsReinitializing(false);
    }
  };

  return (
    <>
      <div className="flex flex-col items-center justify-center py-4 text-center sm:py-6">
        <div className="mb-3 rounded-full bg-amber-100 p-2.5 sm:mb-4 sm:p-3 dark:bg-amber-900/30">
          <Icons.AlertTriangle className="h-5 w-5 text-amber-600 sm:h-6 sm:w-6 dark:text-amber-400" />
        </div>
        <p className="text-foreground text-sm font-medium">{t("sync:orphaned.restoreTitle")}</p>
        <p className="text-muted-foreground mt-1 max-w-xs text-xs">
          {t("sync:orphaned.restoreDescription")}
        </p>
        <Button
          className="mt-3 sm:mt-4"
          variant="outline"
          onClick={() => setShowConfirmDialog(true)}
          disabled={isReinitializing}
        >
          <Icons.RefreshCw className="mr-2 h-4 w-4" />
          {t("sync:orphaned.restoreTitle")}
        </Button>
      </div>

      <AlertDialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("sync:orphaned.restoreTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("sync:orphaned.confirmDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isReinitializing}>{t("common:cancel")}</AlertDialogCancel>
            <Button onClick={handleReinitialize} disabled={isReinitializing}>
              {isReinitializing ? (
                <>
                  <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                  {t("sync:orphaned.restarting")}
                </>
              ) : (
                t("sync:orphaned.restoreTitle")
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// Whether a device counts as currently online based on last-seen time
function isLastSeenOnline(lastSeenAt: string | null): boolean {
  if (!lastSeenAt) return false;
  const diffMins = Math.floor((Date.now() - new Date(lastSeenAt).getTime()) / 60000);
  return diffMins < 5;
}

// Helper to format relative time
function formatLastSeen(lastSeenAt: string | null, t: TFunction): string {
  if (!lastSeenAt) return t("sync:status.never");
  const now = new Date();
  const lastSeen = new Date(lastSeenAt);
  const diffMs = now.getTime() - lastSeen.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 5) return t("sync:status.online");
  if (diffMins < 60) return t("sync:status.minutesAgo", { count: diffMins });
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return t("sync:status.hoursAgo", { count: diffHours });
  const diffDays = Math.floor(diffHours / 24);
  return t("sync:status.daysAgo", { count: diffDays });
}

// Connected devices list component
function ConnectedDevicesList({
  onResetSync,
  onLinkDevice,
  mode = "trusted",
  trustedDeviceCount,
}: {
  onResetSync: () => Promise<void>;
  onLinkDevice: () => void;
  mode?: "trusted" | "unpaired";
  trustedDeviceCount?: number;
}) {
  const { t } = useTranslation();
  const { data: devices, isLoading, error } = useDevices("my");

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-14 w-full rounded-lg" />
        <Skeleton className="h-14 w-full rounded-lg" />
      </div>
    );
  }

  if (error || !devices) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border p-6 text-center">
        <Icons.AlertCircle className="text-destructive mb-2 h-8 w-8 opacity-70" />
        <p className="text-sm font-medium">{t("sync:errorState.failedToLoadDevices")}</p>
        <p className="text-muted-foreground mt-1 text-xs">{t("sync:errorState.tryRefreshing")}</p>
      </div>
    );
  }

  if (mode === "unpaired" && devices.length === 0) {
    return (
      <UntrustedDevicePrompt
        onStartPairing={onLinkDevice}
        trustedDeviceCount={trustedDeviceCount}
      />
    );
  }

  // Sort: current device first, then by lastSeenAt (most recent first)
  const sortedDevices = [...devices].sort((a, b) => {
    if (a.isCurrent && !b.isCurrent) return -1;
    if (!a.isCurrent && b.isCurrent) return 1;
    const aTime = a.lastSeenAt ? new Date(a.lastSeenAt).getTime() : 0;
    const bTime = b.lastSeenAt ? new Date(b.lastSeenAt).getTime() : 0;
    return bTime - aTime;
  });

  const trustedDevices = devices.filter((d: Device) => d.trustState === "trusted");
  const isLastTrustedDevice = trustedDevices.length <= 1;
  const visibleDevices =
    mode === "unpaired" ? sortedDevices.filter((device) => !device.isCurrent) : sortedDevices;

  return (
    <div>
      {/* Devices list */}
      <div className="space-y-2">
        {mode === "unpaired" && <PairThisDeviceItem onPair={onLinkDevice} />}
        {visibleDevices.map((device) => (
          <DeviceCard
            key={device.id}
            device={device}
            isLastTrustedDevice={isLastTrustedDevice && device.trustState === "trusted"}
            onResetSync={onResetSync}
            onPair={onLinkDevice}
          />
        ))}
      </div>

      {/* Link Device button - matches "Sync to Local" pattern */}
      {mode === "trusted" && (
        <div className="mt-4">
          <Button onClick={onLinkDevice} size="sm">
            <Icons.Link className="mr-2 h-4 w-4" />
            {t("sync:connect.connectAnotherDevice")}
          </Button>
        </div>
      )}
    </div>
  );
}

function PairThisDeviceItem({ onPair }: { onPair: () => void }) {
  const { t } = useTranslation();
  const { clearSyncData } = useSyncActions();
  const [showResetAlert, setShowResetAlert] = useState(false);
  const [isResetting, setIsResetting] = useState(false);

  const handleDisconnect = async () => {
    setIsResetting(true);
    try {
      await clearSyncData.mutateAsync();
      setShowResetAlert(false);
    } catch (err) {
      logSyncError("Disconnect device failed", err);
      toast.error(t("sync:toasts.disconnectFailed"), {
        description: userFacingSyncErrorMessage(err),
      });
    } finally {
      setIsResetting(false);
    }
  };

  return (
    <>
      <div className="bg-muted/30 flex flex-col gap-3 rounded-lg border border-dashed p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Avatar className="h-9 w-9 shrink-0 rounded-lg">
            <AvatarFallback className="rounded-lg">
              <Icons.Smartphone className="text-muted-foreground h-4 w-4" />
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium">{t("sync:status.thisDevice")}</span>
              <Badge
                variant="outline"
                className="text-warning border-warning/20 bg-warning/20 h-5 shrink-0 text-[10px]"
              >
                {t("sync:status.notConnected")}
              </Badge>
            </div>
            <div className="text-muted-foreground flex items-center gap-1 text-xs">
              <Icons.ShieldAlert className="h-3 w-3 text-amber-600 dark:text-amber-500" />
              {t("sync:untrusted.connectToStartSyncing")}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button size="default" className="w-full shrink-0 sm:w-auto" onClick={onPair}>
            <Icons.Link className="mr-2 h-4 w-4" />
            {t("sync:connect.connectThisDevice")}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="text-muted-foreground h-8 w-8 shrink-0"
              >
                <Icons.MoreVertical className="h-4 w-4" />
                <span className="sr-only">{t("sync:section.options")}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onSelect={() => setShowResetAlert(true)}
                className="text-destructive focus:text-destructive"
              >
                <Icons.LogOut className="mr-2 h-4 w-4" />
                {t("sync:connect.disconnect")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <AlertDialog open={showResetAlert} onOpenChange={setShowResetAlert}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("sync:disconnectDialog.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("sync:disconnectDialog.description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isResetting}>{t("common:cancel")}</AlertDialogCancel>
            <Button variant="destructive" onClick={handleDisconnect} disabled={isResetting}>
              {isResetting ? (
                <>
                  <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                  {t("sync:disconnectDialog.disconnecting")}
                </>
              ) : (
                t("sync:disconnectDialog.disconnect")
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function SyncStatusDot({
  engineStatus,
}: {
  engineStatus: ReturnType<typeof useSyncStatus>["engineStatus"];
}) {
  const { t } = useTranslation();
  if (!engineStatus) return null;

  const { backgroundRunning, lastCycleStatus, lastError, consecutiveFailures } = engineStatus;

  let color: string;
  let label: string;

  if (lastError || consecutiveFailures > 2) {
    color = "bg-red-500";
    label = t("sync:status.syncError");
  } else if (!backgroundRunning) {
    color = "bg-gray-400";
    label = t("sync:status.syncPaused");
  } else if (lastCycleStatus === "ok") {
    color = "bg-green-500";
    label = t("sync:status.synced");
  } else {
    color = "bg-yellow-500";
    label = t("sync:status.syncing");
  }

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${color}`} />
        </TooltipTrigger>
        <TooltipContent side="right" className="text-xs">
          {label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// Individual device card
function DeviceCard({
  device,
  isLastTrustedDevice,
  onResetSync,
  onPair,
}: {
  device: Device;
  isLastTrustedDevice: boolean;
  onResetSync: () => Promise<void>;
  onPair: () => void;
}) {
  const { t } = useTranslation();
  const renameDevice = useRenameDevice();
  const revokeDevice = useRevokeDevice();
  const { clearSyncData } = useSyncActions();

  const [isRenaming, setIsRenaming] = useState(false);
  const [newName, setNewName] = useState("");
  const [showUnpairAlert, setShowUnpairAlert] = useState(false);
  const [isUnpairing, setIsUnpairing] = useState(false);

  const platform = device.platform?.toLowerCase() || "unknown";
  const Icon = platformIcons[platform] || Icons.Monitor;
  const isTrusted = device.trustState === "trusted";
  const isUntrusted = device.trustState === "untrusted";
  const isRevoked = device.trustState === "revoked";
  // Current device is always online, others show relative time
  const isOnline = device.isCurrent || isLastSeenOnline(device.lastSeenAt);
  const lastSeenText = device.isCurrent
    ? t("sync:status.online")
    : formatLastSeen(device.lastSeenAt, t);

  const handleStartRename = () => {
    setNewName(device.displayName);
    setIsRenaming(true);
  };

  const handleRename = async () => {
    if (newName.trim() && newName !== device.displayName) {
      await renameDevice.mutateAsync({ deviceId: device.id, name: newName.trim() });
    }
    setIsRenaming(false);
  };

  const handleCancelRename = () => {
    setIsRenaming(false);
    setNewName("");
  };

  const handleUnpair = async () => {
    setIsUnpairing(true);
    try {
      if (isLastTrustedDevice) {
        await onResetSync();
      } else {
        await revokeDevice.mutateAsync(device.id);
        if (device.isCurrent) {
          await clearSyncData.mutateAsync();
        }
      }
      setShowUnpairAlert(false);
    } catch (err) {
      logSyncError("Unpair device failed", err);
      toast.error(t("sync:toasts.unpairFailed"), { description: userFacingSyncErrorMessage(err) });
    } finally {
      setIsUnpairing(false);
    }
  };

  return (
    <>
      <div className="hover:bg-muted/40 group flex items-center gap-4 rounded-xl border px-4 py-3 transition-colors">
        {/* Device icon with online indicator */}
        <div className="relative shrink-0">
          <div className="bg-muted/60 flex h-10 w-10 items-center justify-center rounded-full">
            <Icon className="text-foreground/70 h-[18px] w-[18px]" />
          </div>
          {isOnline && (
            <span className="border-background absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 bg-green-500" />
          )}
        </div>

        {/* Info */}
        <div className="min-w-0 flex-1">
          {isRenaming ? (
            <div className="flex items-center gap-2">
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="h-7 w-full max-w-40 text-sm"
                maxLength={64}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleRename();
                  if (e.key === "Escape") handleCancelRename();
                }}
              />
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 shrink-0"
                onClick={handleRename}
                disabled={renameDevice.isPending}
              >
                {renameDevice.isPending ? (
                  <Icons.Spinner className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Icons.Check className="h-3.5 w-3.5" />
                )}
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 shrink-0"
                onClick={handleCancelRename}
              >
                <Icons.Close className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : (
            <>
              <div className="flex items-baseline gap-1.5">
                <span className="truncate text-sm font-medium">{device.displayName}</span>
                {device.isCurrent && (
                  <span className="text-muted-foreground shrink-0 text-xs font-normal">
                    {t("sync:status.thisDeviceSuffix")}
                  </span>
                )}
              </div>
              <div className="text-muted-foreground mt-0.5 flex items-center gap-1 text-xs">
                {isTrusted && (
                  <>
                    <Icons.ShieldCheck className="h-3 w-3 text-green-600 dark:text-green-500" />
                    <span>{t("sync:status.connected")}</span>
                  </>
                )}
                {isUntrusted && (
                  <>
                    <Icons.ShieldAlert className="h-3 w-3 text-amber-600 dark:text-amber-500" />
                    <span className="text-amber-600 dark:text-amber-500">
                      {t("sync:status.needsSetup")}
                    </span>
                  </>
                )}
                {isRevoked && (
                  <>
                    <Icons.XCircle className="h-3 w-3" />
                    <span>{t("sync:status.revoked")}</span>
                  </>
                )}
                {!isOnline && !device.isCurrent && (
                  <>
                    <span className="text-muted-foreground/30 mx-0.5">·</span>
                    <span>{lastSeenText}</span>
                  </>
                )}
              </div>
            </>
          )}
        </div>

        {/* Right actions */}
        {!isRenaming && (
          <div className="flex shrink-0 items-center gap-2">
            {isUntrusted && !device.isCurrent && (
              <Button variant="outline" size="sm" onClick={onPair}>
                {t("sync:connect.pair")}
              </Button>
            )}

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground h-7 w-7 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 max-md:opacity-100"
                >
                  <Icons.MoreVertical className="h-4 w-4" />
                  <span className="sr-only">{t("sync:section.deviceActions")}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={handleStartRename}>
                  <Icons.Pencil className="mr-2 h-4 w-4" />
                  {t("sync:connect.rename")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => setShowUnpairAlert(true)}
                  className="text-destructive focus:text-destructive"
                >
                  <Icons.LogOut className="mr-2 h-4 w-4" />
                  {device.isCurrent ? t("sync:connect.unpair") : t("sync:connect.revoke")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>

      {/* Unpair confirmation */}
      <AlertDialog open={showUnpairAlert} onOpenChange={setShowUnpairAlert}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {isLastTrustedDevice
                ? t("sync:unpairDialog.titleLast")
                : t("sync:unpairDialog.title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {isLastTrustedDevice
                ? t("sync:unpairDialog.descriptionLast")
                : t("sync:unpairDialog.description", { name: device.displayName })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isUnpairing}>{t("common:cancel")}</AlertDialogCancel>
            <Button variant="destructive" onClick={handleUnpair} disabled={isUnpairing}>
              {isUnpairing ? (
                <>
                  <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                  {t("sync:unpairDialog.unpairing")}
                </>
              ) : (
                t("sync:unpairDialog.unpair")
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
