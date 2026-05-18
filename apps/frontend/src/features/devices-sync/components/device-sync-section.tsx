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
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  useDevices,
  useRenameDevice,
  useRevokeDevice,
  useSyncActions,
  useSyncStatus,
} from "../hooks";
import { syncService } from "../services/sync-service";
import { SyncStates, type Device } from "../types";
import { E2EESetupCard } from "./e2ee-setup-card";
import { PairingFlow, WaitingState } from "./pairing-flow";
import { RecoveryDialog } from "./recovery-dialog";

const PORTAL_DEVICES_URL = "https://connect.wealthfolio.app/settings/devices";

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

  // Bootstrap overwrite state — set when bootstrapSync returns overwrite_required
  const [overwriteRisk, setOverwriteRisk] = useState<{
    localRows: number;
    nonEmptyTables: { table: string; rows: number }[];
  } | null>(null);

  const isBackgroundRunning = status.engineStatus?.backgroundRunning ?? false;

  const handlePairingComplete = useCallback(() => {
    setIsPairingOpen(false);
    setIsPreparing(false);
    setPrepareError(null);
    queryClient.invalidateQueries({ queryKey: ["sync", "device", "current"] });
    status.refetch();
  }, [queryClient, status.refetch]);

  const handlePairingCancel = useCallback(() => {
    setIsPairingOpen(false);
    setIsPreparing(false);
    setPrepareError(null);
  }, []);

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
        toast.success("Background sync paused");
      } else {
        await actions.startBgSync.mutateAsync();
        toast.success("Background sync resumed");
      }
    } catch (err) {
      toast.error("Failed to update background sync", {
        description: err instanceof Error ? err.message : "An unexpected error occurred",
      });
    }
  }, [actions, isBackgroundRunning]);

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
            throw new Error(
              "Backup before device sync is currently supported on desktop, web, and iOS only",
            );
          }
          const { relativePath, filename } = await backupDatabaseToPendingExport();
          const saved = await saveAppDataFileViaPicker(relativePath, filename);
          if (!saved) {
            return false;
          }
          backupLocation = filename;
        }
      }

      toast.success("Backup saved", {
        description: `A backup was saved as ${backupLocation}.`,
      });
      return true;
    } catch (err) {
      toast.error("Backup failed", {
        description: err instanceof Error ? err.message : "An unexpected error occurred",
      });
      return false;
    } finally {
      setIsBackingUpBeforeBootstrap(false);
    }
  }, []);

  const handleApplyBootstrapOverwrite = useCallback(async () => {
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
    } catch (err) {
      toast.error("Unable to continue sync", {
        description: err instanceof Error ? err.message : "An unexpected error occurred",
      });
    }
  }, [actions]);

  const handleBackupThenApplyOverwrite = useCallback(async () => {
    const saved = await handleBackupBeforeBootstrap();
    if (!saved) {
      return;
    }
    await handleApplyBootstrapOverwrite();
  }, [handleApplyBootstrapOverwrite, handleBackupBeforeBootstrap]);

  const runBootstrapCheck = useCallback(
    async (showToast: boolean, autoOpenDialog = false) => {
      try {
        const result = await actions.bootstrapSync.mutateAsync({ allowOverwrite: false });
        if (result.status === "overwrite_required") {
          setOverwriteRisk({
            localRows: result.localRows,
            nonEmptyTables: result.nonEmptyTables,
          });
          if (autoOpenDialog) {
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
        if (showToast) {
          if (result.status === "waiting_snapshot") {
            toast.message("Waiting for your other device", {
              description: "We’ll finish syncing as soon as a fresh snapshot is available.",
            });
          } else {
            toast.success("Sync retry started", {
              description: "Checking for an updated snapshot and applying pending sync changes.",
            });
          }
        }
      } catch (err) {
        if (showToast) {
          toast.error("Could not retry sync", {
            description: err instanceof Error ? err.message : "An unexpected error occurred",
          });
        }
      }
    },
    [actions],
  );

  const handleRetryBootstrap = useCallback(async () => {
    await runBootstrapCheck(true);
  }, [runBootstrapCheck]);

  const handleUploadSnapshotNow = useCallback(async () => {
    setIsUploadingSnapshot(true);
    try {
      const result = await actions.generateSnapshot.mutateAsync();
      if (result.status === "uploaded") {
        toast.success("Snapshot uploaded", {
          description: "Newly connected devices can now finish syncing from this snapshot.",
        });
        return;
      }
      if (result.status === "skipped") {
        toast.message("Snapshot upload skipped", {
          description: result.message,
        });
        return;
      }
      if (result.status === "cancelled") {
        toast.message("Snapshot upload cancelled", {
          description: result.message,
        });
        return;
      }
      toast.message("Snapshot upload result", {
        description: result.message,
      });
    } catch (err) {
      toast.error("Snapshot upload failed", {
        description: err instanceof Error ? err.message : "An unexpected error occurred",
      });
    } finally {
      setIsUploadingSnapshot(false);
    }
  }, [actions]);

  const runReinitAndOpenPairing = useCallback(async () => {
    setIsPreparing(true);
    setPrepareError(null);
    setIsPairingOpen(true);
    try {
      await actions.reinitializeSync.mutateAsync();
      setIsPreparing(false);
    } catch (err) {
      setPrepareError(err instanceof Error ? err.message : "An unexpected error occurred");
    }
  }, [actions.reinitializeSync]);

  const openClaimerPairingFlow = useCallback(() => {
    setPrepareError(null);
    setIsPreparing(false);
    setIsPairingOpen(true);
  }, []);

  const beginPairingFlow = useCallback(async () => {
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
      setIsPairingOpen(true);
    } catch (err) {
      setPrepareError(err instanceof Error ? err.message : "An unexpected error occurred");
      setIsPairingOpen(true);
    }
  }, [actions.reinitializeSync, otherConnectedDevices]);

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
    actions.bootstrapSync.isPending,
    overwriteRisk,
    isPairingOpen,
    runBootstrapCheck,
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
          <CardTitle className="text-base font-medium">Device Sync</CardTitle>
          <CardDescription>Failed to initialize device sync.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center py-6 text-center">
            <Icons.AlertCircle className="text-destructive mb-3 h-10 w-10 opacity-70" />
            <p className="text-destructive text-sm font-medium">Initialization Failed</p>
            <p className="text-muted-foreground mt-1 max-w-sm text-xs">{status.error.message}</p>
            <Button variant="outline" className="mt-4" onClick={handleRefresh}>
              <Icons.RefreshCw className="mr-2 h-4 w-4" />
              Retry
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  // FRESH state - Show enable sync card
  if (status.syncState === SyncStates.FRESH) {
    return <E2EESetupCard onPairingNeeded={() => setIsPairingOpen(true)} />;
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
            <h3 className="text-base font-semibold">Device Sync</h3>
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
            <h3 className="text-base font-semibold">Connected Devices</h3>
          </div>

          <div className="mt-4">
            <ConnectedDevicesList
              onResetSync={() => actions.resetSync.mutateAsync()}
              onLinkDevice={() => setIsPairingOpen(true)}
              mode="unpaired"
              trustedDeviceCount={status.trustedDevices.length}
            />
          </div>
        </CardContent>

        {/* Pairing Dialog */}
        <Dialog open={isPairingOpen} onOpenChange={setIsPairingOpen}>
          <DialogContent
            className="md:max-w-lg"
            mobileClassName="pb-8"
            showCloseButton={false}
            onEscapeKeyDown={(e) => e.preventDefault()}
            onInteractOutside={(e) => e.preventDefault()}
          >
            <DialogHeader className="sr-only">
              <DialogTitle>Connect This Device</DialogTitle>
            </DialogHeader>
            <PairingFlow
              onComplete={handlePairingComplete}
              onCancel={handlePairingCancel}
              title="Connect This Device"
              description="Enter the code from your other connected device"
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
            <h3 className="text-base font-semibold">Device Sync</h3>
          </div>

          <div className="flex flex-col items-center justify-center py-4 text-center sm:py-6">
            <div className="mb-3 rounded-full bg-amber-100 p-2.5 sm:mb-4 sm:p-3 dark:bg-amber-900/30">
              <Icons.RefreshCw className="h-5 w-5 text-amber-600 sm:h-6 sm:w-6 dark:text-amber-400" />
            </div>
            <p className="text-foreground text-sm font-medium">Keys need updating</p>
            <p className="text-muted-foreground mt-1 max-w-xs text-xs">
              Security settings changed on another device. Connect this device again to keep
              syncing.
            </p>
            <Button className="mt-3 sm:mt-4" onClick={() => setIsPairingOpen(true)}>
              <Icons.Link className="mr-2 h-4 w-4" />
              Update This Device
            </Button>
          </div>
        </CardContent>

        {/* Pairing Dialog */}
        <Dialog open={isPairingOpen} onOpenChange={setIsPairingOpen}>
          <DialogContent
            className="md:max-w-lg"
            mobileClassName="pb-8"
            showCloseButton={false}
            onEscapeKeyDown={(e) => e.preventDefault()}
            onInteractOutside={(e) => e.preventDefault()}
          >
            <DialogHeader className="sr-only">
              <DialogTitle>Update This Device</DialogTitle>
            </DialogHeader>
            <PairingFlow
              onComplete={handlePairingComplete}
              onCancel={handlePairingCancel}
              title="Update This Device"
              description="Enter the code from your other connected device"
              forceRole="claimer"
            />
          </DialogContent>
        </Dialog>
      </Card>
    );
  }

  // READY state - Show connected devices
  const isTrusted = status.device?.trustState === "trusted";
  // Show banner only when the engine actually reports it's stuck.
  // Don't use bootstrapRequired alone — it's derived from last_bootstrap_at
  // which can be NULL for devices bootstrapped before that column was added.
  const isWaitingForRemoteSnapshot =
    status.engineStatus?.lastCycleStatus === "wait_snapshot" ||
    status.engineStatus?.lastCycleStatus === "stale_cursor";
  const dialogTitle = isTrusted ? "Connect Another Device" : "Connect This Device";
  const dialogDescription = isTrusted
    ? "Scan or enter this code on your other device"
    : "Enter the code from your other connected device";
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
              <h3 className="text-base font-semibold">Connected Devices</h3>
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
                    Updating...
                  </>
                ) : isBackgroundRunning ? (
                  <>
                    <Icons.PauseCircle className="h-4 w-4" />
                    Pause Sync
                  </>
                ) : (
                  <>
                    <Icons.PlayCircle className="h-4 w-4" />
                    Resume Sync
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
                Manage devices
                <Icons.ArrowRight className="ml-1 h-3.5 w-3.5" />
              </Button>
            </div>
          </div>

          {/* Content */}
          <div className="mt-4">
            {actions.bootstrapSync.isPending && (
              <div className="bg-muted/60 text-muted-foreground mb-3 flex items-center gap-2 rounded-md px-3 py-2 text-xs">
                <Icons.Loader className="h-3.5 w-3.5 animate-spin" />
                Sync bootstrap in progress...
              </div>
            )}
            {actions.bootstrapSync.error && (
              <div className="bg-destructive/10 text-destructive mb-3 flex items-center gap-2 rounded-md px-3 py-2 text-xs">
                <Icons.AlertCircle className="h-3.5 w-3.5" />
                {actions.bootstrapSync.error instanceof Error
                  ? actions.bootstrapSync.error.message
                  : String(actions.bootstrapSync.error)}
              </div>
            )}
            {isWaitingForRemoteSnapshot && (
              <div className="bg-muted/60 text-muted-foreground mb-3 rounded-md px-3 py-3 text-xs">
                <div className="flex items-start gap-2">
                  <Icons.Cloud className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-foreground font-medium">
                      {isTrusted
                        ? "Your other device is still finishing setup."
                        : "Your setup is almost done."}
                    </p>
                    <p className="mt-1 leading-relaxed">
                      {isTrusted
                        ? "You can speed things up now, or wait and we'll continue automatically in the background."
                        : "Please finish setup on your other connected device first. This page will update automatically."}
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
                            Checking...
                          </>
                        ) : (
                          <>
                            <Icons.RefreshCw className="mr-2 h-3.5 w-3.5" />
                            Check again
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
                              Preparing...
                            </>
                          ) : (
                            <>
                              <Icons.Upload className="mr-2 h-3.5 w-3.5" />
                              Speed up setup
                            </>
                          )}
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}
            {overwriteRisk && (
              <div className="mb-3 rounded-md border border-amber-200 bg-amber-50/80 px-3 py-3 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-900/20 dark:text-amber-200">
                <div className="flex items-start gap-2">
                  <Icons.AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">This device already has data</p>
                    <p className="mt-1 leading-relaxed">
                      To finish syncing, the data on this device will be replaced with data from
                      your other device.
                    </p>
                    <div className="mt-2">
                      <Button size="sm" onClick={() => setShowBootstrapOverwriteDialog(true)}>
                        Continue
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
        <Dialog
          open={isPairingOpen}
          onOpenChange={(open) => {
            setIsPairingOpen(open);
            if (!open) {
              setIsPreparing(false);
              setPrepareError(null);
            }
          }}
        >
          <DialogContent
            className="md:max-w-lg"
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
                title="Getting this device ready..."
                description="This will only take a moment."
              />
            ) : isPreparing && prepareError ? (
              <div className="flex flex-col items-center px-4 py-6">
                <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/30">
                  <Icons.XCircle className="h-10 w-10 text-red-600 dark:text-red-500" />
                </div>
                <div className="mb-6 text-center">
                  <p className="text-foreground text-base font-semibold">
                    We couldn&apos;t finish getting this device ready.
                  </p>
                  <p className="text-muted-foreground mt-2 max-w-[240px] text-sm">{prepareError}</p>
                </div>
                <div className="flex gap-3">
                  <Button variant="outline" onClick={() => void beginPairingFlow()}>
                    Try Again
                  </Button>
                  <Button variant="ghost" onClick={handlePairingCancel}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <PairingFlow
                onComplete={handlePairingComplete}
                onCancel={handlePairingCancel}
                title={dialogTitle}
                description={dialogDescription}
              />
            )}
          </DialogContent>
        </Dialog>

        <AlertDialog
          open={showBootstrapOverwriteDialog && !!overwriteRisk}
          onOpenChange={setShowBootstrapOverwriteDialog}
        >
          <AlertDialogContent className="max-sm:bg-background/90 gap-8 text-center max-sm:bottom-6 max-sm:left-4 max-sm:right-4 max-sm:top-auto max-sm:w-auto max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-3xl max-sm:shadow-2xl max-sm:backdrop-blur-2xl sm:max-w-lg">
            <AlertDialogHeader className="items-center gap-4 px-8 text-center">
              <div className="border-warning/30 bg-warning/10 dark:border-warning/20 dark:bg-warning/15 flex h-14 w-14 items-center justify-center rounded-full border">
                <Icons.AlertTriangle className="h-6 w-6 text-amber-500" />
              </div>
              <AlertDialogTitle className="text-center text-xl">
                Replace data on this device?
              </AlertDialogTitle>
              <AlertDialogDescription className="text-center text-sm">
                Your local data will be replaced with data from your other connected device.
              </AlertDialogDescription>
            </AlertDialogHeader>

            <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
              <Button
                variant="ghost"
                onClick={() => setShowBootstrapOverwriteDialog(false)}
                disabled={isBackingUpBeforeBootstrap || actions.bootstrapSync.isPending}
              >
                Not now
              </Button>
              <Button
                variant="outline"
                onClick={handleBackupThenApplyOverwrite}
                disabled={isBackingUpBeforeBootstrap || actions.bootstrapSync.isPending}
              >
                {isBackingUpBeforeBootstrap ? (
                  <>
                    <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                    Backing up...
                  </>
                ) : (
                  "Back up first"
                )}
              </Button>
              <Button
                onClick={handleApplyBootstrapOverwrite}
                disabled={isBackingUpBeforeBootstrap || actions.bootstrapSync.isPending}
              >
                {actions.bootstrapSync.isPending ? (
                  <>
                    <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                    Syncing...
                  </>
                ) : (
                  "Replace & Sync"
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
                Set up sync again from this device?
              </AlertDialogTitle>
              <AlertDialogDescription className="text-center text-sm">
                We&apos;ll keep the data on this device and use it to restart sync. Other connected
                devices may need to be connected again.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
              <Button variant="ghost" onClick={() => setShowReinitConfirmDialog(false)}>
                Not now
              </Button>
              <Button onClick={() => void handleReinitConfirm()}>Continue</Button>
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
  return (
    <div className="flex flex-col items-center justify-center py-4 text-center sm:py-6">
      <div className="bg-muted/50 mb-3 rounded-full p-2.5 sm:mb-4 sm:p-3">
        <Icons.ShieldAlert className="h-5 w-5 opacity-60 sm:h-6 sm:w-6" />
      </div>
      <p className="text-foreground text-sm font-medium">This device is not connected yet</p>
      <p className="text-muted-foreground mt-1 max-w-xs text-xs">
        {trustedDeviceCount !== undefined && trustedDeviceCount > 0
          ? `Enter the code from one of your ${trustedDeviceCount} other connected device${trustedDeviceCount > 1 ? "s" : ""}.`
          : "Enter the code from your other connected device to sync your data."}
      </p>
      <Button className="mt-3 sm:mt-4" onClick={onStartPairing}>
        <Icons.Link className="mr-2 h-4 w-4" />
        Connect This Device
      </Button>
    </div>
  );
}

// Prompt for orphaned state (keys exist but no trusted devices)
function OrphanedKeysPrompt({ onReinitialize }: { onReinitialize: () => Promise<void> }) {
  const [isReinitializing, setIsReinitializing] = useState(false);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);

  const handleReinitialize = async () => {
    setIsReinitializing(true);
    try {
      await onReinitialize();
      setShowConfirmDialog(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : "An unexpected error occurred";
      toast.error("Failed to reinitialize sync", { description: message });
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
        <p className="text-foreground text-sm font-medium">Use This Device to Restore Sync</p>
        <p className="text-muted-foreground mt-1 max-w-xs text-xs">
          No other connected device is available. We&apos;ll restart sync using the data already on
          this device.
        </p>
        <Button
          className="mt-3 sm:mt-4"
          variant="outline"
          onClick={() => setShowConfirmDialog(true)}
          disabled={isReinitializing}
        >
          <Icons.RefreshCw className="mr-2 h-4 w-4" />
          Use This Device to Restore Sync
        </Button>
      </div>

      <AlertDialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Use This Device to Restore Sync</AlertDialogTitle>
            <AlertDialogDescription>
              We&apos;ll restart sync using the data already on this device.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isReinitializing}>Cancel</AlertDialogCancel>
            <Button onClick={handleReinitialize} disabled={isReinitializing}>
              {isReinitializing ? (
                <>
                  <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                  Restarting...
                </>
              ) : (
                "Use This Device to Restore Sync"
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// Helper to format relative time
function formatLastSeen(lastSeenAt: string | null): string {
  if (!lastSeenAt) return "Never";
  const now = new Date();
  const lastSeen = new Date(lastSeenAt);
  const diffMs = now.getTime() - lastSeen.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 5) return "Online";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
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
        <p className="text-sm font-medium">Failed to load devices</p>
        <p className="text-muted-foreground mt-1 text-xs">
          {error instanceof Error ? error.message : "Please try refreshing"}
        </p>
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
            Connect Another Device
          </Button>
        </div>
      )}
    </div>
  );
}

function PairThisDeviceItem({ onPair }: { onPair: () => void }) {
  const { clearSyncData } = useSyncActions();
  const [showResetAlert, setShowResetAlert] = useState(false);
  const [isResetting, setIsResetting] = useState(false);

  const handleDisconnect = async () => {
    setIsResetting(true);
    try {
      await clearSyncData.mutateAsync();
      setShowResetAlert(false);
    } catch (err) {
      toast.error("Failed to disconnect", {
        description: err instanceof Error ? err.message : "An unexpected error occurred",
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
              <span className="truncate text-sm font-medium">This device</span>
              <Badge
                variant="outline"
                className="text-warning border-warning/20 bg-warning/20 h-5 shrink-0 text-[10px]"
              >
                Not connected
              </Badge>
            </div>
            <div className="text-muted-foreground flex items-center gap-1 text-xs">
              <Icons.ShieldAlert className="h-3 w-3 text-amber-600 dark:text-amber-500" />
              Connect this device to start syncing.
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button size="default" className="w-full shrink-0 sm:w-auto" onClick={onPair}>
            <Icons.Link className="mr-2 h-4 w-4" />
            Connect This Device
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="text-muted-foreground h-8 w-8 shrink-0"
              >
                <Icons.MoreVertical className="h-4 w-4" />
                <span className="sr-only">Options</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onSelect={() => setShowResetAlert(true)}
                className="text-destructive focus:text-destructive"
              >
                <Icons.LogOut className="mr-2 h-4 w-4" />
                Disconnect
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <AlertDialog open={showResetAlert} onOpenChange={setShowResetAlert}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect this device?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove sync from this device. You can set it up again later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isResetting}>Cancel</AlertDialogCancel>
            <Button variant="destructive" onClick={handleDisconnect} disabled={isResetting}>
              {isResetting ? (
                <>
                  <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                  Disconnecting...
                </>
              ) : (
                "Disconnect"
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
  if (!engineStatus) return null;

  const { backgroundRunning, lastCycleStatus, lastError, consecutiveFailures } = engineStatus;

  let color: string;
  let label: string;

  if (lastError || consecutiveFailures > 2) {
    color = "bg-red-500";
    label = "Sync error";
  } else if (!backgroundRunning) {
    color = "bg-gray-400";
    label = "Sync paused";
  } else if (lastCycleStatus === "ok") {
    color = "bg-green-500";
    label = "Synced";
  } else {
    color = "bg-yellow-500";
    label = "Syncing";
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
  // Current device is always "Online", others show relative time
  const lastSeenText = device.isCurrent ? "Online" : formatLastSeen(device.lastSeenAt);

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
      const message = err instanceof Error ? err.message : "An unexpected error occurred";
      toast.error("Failed to unpair device", { description: message });
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
          {lastSeenText === "Online" && (
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
                    · This device
                  </span>
                )}
              </div>
              <div className="text-muted-foreground mt-0.5 flex items-center gap-1 text-xs">
                {isTrusted && (
                  <>
                    <Icons.ShieldCheck className="h-3 w-3 text-green-600 dark:text-green-500" />
                    <span>Connected</span>
                  </>
                )}
                {isUntrusted && (
                  <>
                    <Icons.ShieldAlert className="h-3 w-3 text-amber-600 dark:text-amber-500" />
                    <span className="text-amber-600 dark:text-amber-500">Needs setup</span>
                  </>
                )}
                {isRevoked && (
                  <>
                    <Icons.XCircle className="h-3 w-3" />
                    <span>Revoked</span>
                  </>
                )}
                {lastSeenText !== "Online" && !device.isCurrent && (
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
                Pair
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
                  <span className="sr-only">Device actions</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={handleStartRename}>
                  <Icons.Pencil className="mr-2 h-4 w-4" />
                  Rename
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => setShowUnpairAlert(true)}
                  className="text-destructive focus:text-destructive"
                >
                  <Icons.LogOut className="mr-2 h-4 w-4" />
                  {device.isCurrent ? "Unpair" : "Revoke"}
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
              {isLastTrustedDevice ? "Unpair your last device?" : "Unpair device?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {isLastTrustedDevice
                ? "This is your only connected device. You'll need to connect a device again to continue syncing your data."
                : `This will remove "${device.displayName}" from your account. The device will need to be connected again to sync data.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isUnpairing}>Cancel</AlertDialogCancel>
            <Button variant="destructive" onClick={handleUnpair} disabled={isUnpairing}>
              {isUnpairing ? (
                <>
                  <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                  Unpairing...
                </>
              ) : (
                "Unpair"
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
