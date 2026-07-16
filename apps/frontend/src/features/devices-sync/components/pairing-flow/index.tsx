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
import { useTranslation } from "react-i18next";
import { usePairingIssuer, usePairingClaimer, useSyncStatus } from "../../hooks";
import type { PairingBootstrapState } from "../../hooks";
import { logSyncError, userFacingSyncErrorMessage } from "../../utils/error-messages";
import { DisplayCode } from "./display-code";
import { SASVerification } from "./sas-verification";
import { WaitingState } from "./waiting-state";
import { PairingResult } from "./pairing-result";
import { EnterCode } from "./enter-code";

interface PairingFlowProps {
  onComplete?: () => void;
  onCancel?: () => void;
  onBootstrapStateChange?: (state: PairingBootstrapState) => void;
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
    <div className="mb-5 text-center">
      <p className="text-foreground text-base font-semibold leading-6">{title}</p>
      {description && (
        <p className="text-muted-foreground mt-1.5 text-sm leading-5">{description}</p>
      )}
    </div>
  );
}

export function PairingFlow({
  onComplete,
  onCancel,
  onBootstrapStateChange,
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
        onBootstrapStateChange={onBootstrapStateChange}
        title={title}
        description={description}
      />
    );
  } else {
    return (
      <ClaimerFlow
        onComplete={onComplete}
        onCancel={onCancel}
        onBootstrapStateChange={onBootstrapStateChange}
        title={title}
        description={description}
      />
    );
  }
}

// Issuer Flow (trusted device - displays QR code)
function IssuerFlow({ onComplete, onCancel, title, description }: PairingFlowProps) {
  const { t } = useTranslation();
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
      return <WaitingState title={t("sync:pairing.starting")} onCancel={onCancel} />;

    case "display_code":
      if (pairingCode && expiresAt) {
        return (
          <>
            <StepHeader title={title} description={description} />
            <DisplayCode code={pairingCode} expiresAt={expiresAt} onCancel={handleCancel} />
          </>
        );
      }
      return (
        <WaitingState
          title={t("sync:pairing.generatingCode")}
          onCancel={handleCancel}
          showQRSkeleton
        />
      );

    case "verify_sas":
      if (sas) {
        return <SASVerification sas={sas} onConfirm={confirmSAS} onReject={rejectSAS} />;
      }
      return (
        <WaitingState title={t("sync:pairing.computingSecurityCode")} onCancel={handleCancel} />
      );

    case "transferring":
      return (
        <WaitingState
          title={t("sync:pairing.finishingSetup")}
          description={t("sync:pairing.finishingSetupDescription")}
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
          error={t("sync:pairing.sessionExpired")}
          onRetry={handleRetry}
          onDone={handleCancel}
        />
      );

    default:
      return null;
  }
}

// Claimer Flow (untrusted device - enters code and receives keys)
function ClaimerFlow({
  onComplete,
  onCancel,
  onBootstrapStateChange,
  title,
  description,
}: PairingFlowProps) {
  const { t } = useTranslation();
  const {
    step,
    error,
    sas,
    overwriteInfo,
    isApprovingOverwrite,
    bootstrapFlowState,
    submitCode,
    approveOverwrite,
    cancel,
    retry,
  } = usePairingClaimer();
  const [isBackingUp, setIsBackingUp] = useState(false);
  const [backupError, setBackupError] = useState<string | null>(null);

  useEffect(() => {
    onBootstrapStateChange?.(bootstrapFlowState);
    return () => onBootstrapStateChange?.("idle");
  }, [bootstrapFlowState, onBootstrapStateChange]);

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
            throw new Error(t("sync:errors.backupPlatformUnsupported"));
          }
          const { relativePath, filename } = await backupDatabaseToPendingExport();
          const saved = await saveAppDataFileViaPicker(relativePath, filename);
          if (!saved) return;
        }
      }
      await approveOverwrite();
    } catch (err) {
      logSyncError("Pairing overwrite backup failed", err);
      setBackupError(userFacingSyncErrorMessage(err, t("sync:backup.failedTitle")));
    } finally {
      setIsBackingUp(false);
    }
  }, [approveOverwrite, t]);

  switch (step) {
    case "enter_code":
      return (
        <>
          <StepHeader title={title} description={description} />
          <EnterCode onSubmit={submitCode} onCancel={handleCancel} error={error} />
        </>
      );

    case "connecting":
      return <WaitingState title={t("sync:pairing.connecting")} onCancel={handleCancel} />;

    case "waiting_keys":
      return (
        <WaitingState
          title={t("sync:pairing.verifySecurityCode")}
          securityCode={sas}
          onCancel={handleCancel}
        />
      );

    case "syncing":
      return (
        <WaitingState
          title={t("sync:pairing.syncingData")}
          description={t("sync:pairing.syncingDataDescription")}
        />
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
  const { t } = useTranslation();
  const isBusy = isBackingUp || isApproving;

  return (
    <div className="flex flex-col items-center gap-6 px-4 py-2 text-center">
      <div className="border-warning/30 bg-warning/10 dark:border-warning/20 dark:bg-warning/15 flex h-14 w-14 items-center justify-center rounded-full border">
        <Icons.AlertTriangle className="h-6 w-6 text-amber-500" />
      </div>
      <div className="space-y-2">
        <h2 className="text-xl font-semibold">{t("sync:overwrite.replaceDataTitle")}</h2>
        <p className="text-muted-foreground text-sm">
          {t("sync:overwrite.replaceDataDescription")}
        </p>
        {localRows > 0 && (
          <p className="text-muted-foreground text-xs">
            {t("sync:overwrite.localRowsReplaced", { count: localRows })}
          </p>
        )}
        {error && <p className="text-destructive text-sm">{error}</p>}
      </div>
      <div className="flex w-full flex-col gap-2 sm:flex-row sm:justify-center">
        <Button variant="ghost" onClick={onCancel} disabled={isBusy}>
          {t("sync:overwrite.notNow")}
        </Button>
        <Button variant="outline" onClick={onBackupThenApprove} disabled={isBusy}>
          {isBackingUp ? (
            <>
              <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
              {t("sync:backup.backingUp")}
            </>
          ) : (
            t("sync:backup.backUpFirst")
          )}
        </Button>
        <Button onClick={onApprove} disabled={isBusy}>
          {isApproving ? (
            <>
              <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
              {t("sync:overwrite.syncing")}
            </>
          ) : (
            t("sync:overwrite.replaceAndSync")
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
