// PairingFlow
// Main component that orchestrates the pairing flow (issuer and claimer)
// =====================================================================

import {
  backupDatabase,
  backupDatabaseToPath,
  backupDatabaseToPendingExport,
  isWeb,
  logger,
  openFolderDialog,
  saveAppDataFileViaPicker,
} from "@/adapters";
import { getPlatform as getRuntimePlatform } from "@/hooks/use-platform";
import { Icons } from "@wealthfolio/ui";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { useEffect, useRef, useCallback, useState } from "react";
import { usePairingIssuer, usePairingClaimer, useSyncStatus } from "../../hooks";
import { DisplayCode } from "./display-code";
import { SASVerification } from "./sas-verification";
import { WaitingState } from "./waiting-state";
import { PairingResult } from "./pairing-result";
import { EnterCode } from "./enter-code";

interface PairingFlowProps {
  onComplete?: () => void;
  onCancel?: () => void;
  /** Title shown during the initial step (display_code for issuer, enter_code for claimer) */
  title?: string;
  /** Description shown during the initial step */
  description?: string;
  /** Override auto-detected role (e.g. REGISTERED state always needs claimer) */
  forceRole?: "issuer" | "claimer";
}

/** Inline title block rendered above the initial step content */
function StepHeader({ title, description }: { title?: string; description?: string }) {
  if (!title) return null;
  return (
    <div className="mb-1 text-center">
      <p className="text-foreground text-base font-semibold">{title}</p>
      {description && <p className="text-muted-foreground mt-1 text-sm">{description}</p>}
    </div>
  );
}

export function PairingFlow({
  onComplete,
  onCancel,
  title,
  description,
  forceRole,
}: PairingFlowProps) {
  const { device } = useSyncStatus();
  const initialRoleRef = useRef<"issuer" | "claimer" | null>(forceRole ?? null);
  if (initialRoleRef.current == null && device) {
    initialRoleRef.current = device.trustState === "trusted" ? "issuer" : "claimer";
  }
  const isTrusted =
    initialRoleRef.current != null
      ? initialRoleRef.current === "issuer"
      : device?.trustState === "trusted";

  if (isTrusted) {
    return (
      <IssuerFlow
        onComplete={onComplete}
        onCancel={onCancel}
        title={title}
        description={description}
      />
    );
  } else {
    return (
      <ClaimerFlow
        onComplete={onComplete}
        onCancel={onCancel}
        title={title}
        description={description}
      />
    );
  }
}

// Issuer Flow (trusted device - displays QR code)
function IssuerFlow({ onComplete, onCancel, title, description }: PairingFlowProps) {
  const {
    step,
    error,
    sas,
    pairingCode,
    expiresAt,
    startPairing,
    confirmSAS,
    rejectSAS,
    cancel,
    reset,
  } = usePairingIssuer();

  // Auto-start pairing when component mounts
  const hasAutoStarted = useRef(false);
  useEffect(() => {
    if (step === "idle" && !hasAutoStarted.current) {
      hasAutoStarted.current = true;
      logger.info("[IssuerFlow] Starting pairing...");
      startPairing();
    }
  }, [step, startPairing]);

  const handleDone = useCallback(() => {
    reset();
    onComplete?.();
  }, [reset, onComplete]);

  const handleCancel = useCallback(() => {
    cancel();
    onCancel?.();
  }, [cancel, onCancel]);

  const handleRetry = useCallback(() => {
    hasAutoStarted.current = false;
    reset();
  }, [reset]);

  switch (step) {
    case "idle":
      return <WaitingState title="Starting..." onCancel={onCancel} />;

    case "display_code":
      if (pairingCode && expiresAt) {
        return (
          <>
            <StepHeader title={title} description={description} />
            <DisplayCode code={pairingCode} expiresAt={expiresAt} onCancel={handleCancel} />
          </>
        );
      }
      return <WaitingState title="Generating code..." onCancel={handleCancel} showQRSkeleton />;

    case "verify_sas":
      if (sas) {
        return <SASVerification sas={sas} onConfirm={confirmSAS} onReject={rejectSAS} />;
      }
      return <WaitingState title="Computing security code..." onCancel={handleCancel} />;

    case "transferring":
      return (
        <WaitingState
          title="Finishing setup..."
          description="Preparing your data for the new device"
        />
      );

    case "success":
      return <PairingResult success onDone={handleDone} />;

    case "error":
      return (
        <PairingResult success={false} error={error} onRetry={handleRetry} onDone={handleCancel} />
      );

    case "expired":
      return (
        <PairingResult
          success={false}
          error="Session expired"
          onRetry={handleRetry}
          onDone={handleCancel}
        />
      );

    default:
      return null;
  }
}

// Claimer Flow (untrusted device - enters code and receives keys)
function ClaimerFlow({ onComplete, onCancel, title, description }: PairingFlowProps) {
  const {
    step,
    error,
    sas,
    overwriteInfo,
    isApprovingOverwrite,
    submitCode,
    approveOverwrite,
    cancel,
    retry,
  } = usePairingClaimer();
  const [isBackingUp, setIsBackingUp] = useState(false);
  const [backupError, setBackupError] = useState<string | null>(null);

  const handleCancel = useCallback(async () => {
    await cancel();
    onCancel?.();
  }, [cancel, onCancel]);

  const handleDone = useCallback(() => {
    onComplete?.();
  }, [onComplete]);

  const handleBackupThenApprove = useCallback(async () => {
    setIsBackingUp(true);
    setBackupError(null);
    try {
      if (isWeb) {
        await backupDatabase();
      } else {
        const runtimePlatform = await getRuntimePlatform();
        if (runtimePlatform.is_desktop) {
          const selectedDir = await openFolderDialog();
          if (!selectedDir) return;
          await backupDatabaseToPath(selectedDir);
        } else {
          if (runtimePlatform.os !== "ios") {
            throw new Error(
              "Backup before device sync is currently supported on desktop, web, and iOS only",
            );
          }
          const { relativePath, filename } = await backupDatabaseToPendingExport();
          const saved = await saveAppDataFileViaPicker(relativePath, filename);
          if (!saved) return;
        }
      }
      await approveOverwrite();
    } catch (err) {
      setBackupError(err instanceof Error ? err.message : "Backup failed");
    } finally {
      setIsBackingUp(false);
    }
  }, [approveOverwrite]);

  switch (step) {
    case "enter_code":
      return (
        <>
          <StepHeader title={title} description={description} />
          <EnterCode onSubmit={submitCode} onCancel={handleCancel} error={error} />
        </>
      );

    case "connecting":
      return <WaitingState title="Connecting..." onCancel={handleCancel} />;

    case "waiting_keys":
      return (
        <WaitingState title="Verify Security Code" securityCode={sas} onCancel={handleCancel} />
      );

    case "syncing":
      return (
        <WaitingState title="Syncing your data..." description="This may take a few seconds" />
      );

    case "overwrite_required":
      return (
        <PairingOverwriteConsent
          localRows={overwriteInfo?.localRows ?? 0}
          error={backupError}
          isBackingUp={isBackingUp}
          isApproving={isApprovingOverwrite}
          onCancel={handleCancel}
          onBackupThenApprove={handleBackupThenApprove}
          onApprove={approveOverwrite}
        />
      );

    case "success":
      return <PairingResult success onDone={handleDone} />;

    case "error":
      return <PairingResult success={false} error={error} onRetry={retry} onDone={handleCancel} />;

    default:
      return null;
  }
}

function PairingOverwriteConsent({
  localRows,
  error,
  isBackingUp,
  isApproving,
  onCancel,
  onBackupThenApprove,
  onApprove,
}: {
  localRows: number;
  error: string | null;
  isBackingUp: boolean;
  isApproving: boolean;
  onCancel: () => void;
  onBackupThenApprove: () => void;
  onApprove: () => void;
}) {
  const isBusy = isBackingUp || isApproving;
  const rowLabel = localRows === 1 ? "row" : "rows";

  return (
    <div className="flex flex-col items-center gap-6 px-4 py-2 text-center">
      <div className="border-warning/30 bg-warning/10 dark:border-warning/20 dark:bg-warning/15 flex h-14 w-14 items-center justify-center rounded-full border">
        <Icons.AlertTriangle className="h-6 w-6 text-amber-500" />
      </div>
      <div className="space-y-2">
        <h2 className="text-xl font-semibold">Replace data on this device?</h2>
        <p className="text-muted-foreground text-sm">
          Your local data will be replaced with data from your other connected device.
        </p>
        {localRows > 0 && (
          <p className="text-muted-foreground text-xs">
            {localRows} local {rowLabel} will be replaced.
          </p>
        )}
        {error && <p className="text-destructive text-sm">{error}</p>}
      </div>
      <div className="flex w-full flex-col gap-2 sm:flex-row sm:justify-center">
        <Button variant="ghost" onClick={onCancel} disabled={isBusy}>
          Not now
        </Button>
        <Button variant="outline" onClick={onBackupThenApprove} disabled={isBusy}>
          {isBackingUp ? (
            <>
              <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
              Backing up...
            </>
          ) : (
            "Back up first"
          )}
        </Button>
        <Button onClick={onApprove} disabled={isBusy}>
          {isApproving ? (
            <>
              <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
              Syncing...
            </>
          ) : (
            "Replace & Sync"
          )}
        </Button>
      </div>
    </div>
  );
}

// Re-export sub-components for flexibility
export { DisplayCode } from "./display-code";
export { SASVerification } from "./sas-verification";
export { WaitingState } from "./waiting-state";
export { PairingResult } from "./pairing-result";
