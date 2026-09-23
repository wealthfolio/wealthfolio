// Device setup wizards
// AddDeviceWizard runs on the trusted device that shares its data;
// JoinDeviceWizard runs on the new device that receives it.
// ====================================================================

import { logger } from "@/adapters";
import { Icons } from "@wealthfolio/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePairingClaimer, usePairingIssuer } from "../../hooks";
import { DeviceLink } from "../device-link";
import { EncryptedNote } from "../flow-notes";
import { RestoreOperationView } from "../restore-operation-view";
import { isRestoreFinished } from "../../hooks/use-restore-operation";
import { restoreWizardProgress, type WizardProgress } from "../device-setup-steps";
import { WizardLayout } from "../device-setup-wizard";
import { DisplayCode } from "./display-code";
import { EnterCode } from "./enter-code";
import { PairingResult } from "./pairing-result";
import { SASVerification, SASWaiting } from "./sas-verification";
import { WaitingState } from "./waiting-state";

interface DeviceWizardProps {
  /** The wizard finished; the dialog can close. */
  onComplete: () => void;
  /** The user left the wizard. */
  onCancel: () => void;
}

/** Trusted device: share a code, verify it, send the data. */
export function AddDeviceWizard({ onComplete, onCancel }: DeviceWizardProps) {
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
  // Whether this pairing reached the transfer, so a failure marks the right step.
  // Derived from the step during render; starting over clears it.
  const [transferStarted, setTransferStarted] = useState(false);
  if (step === "transferring" && !transferStarted) setTransferStarted(true);
  // Rejecting stops this pairing; the next one needs a new code.
  const [rejected, setRejected] = useState(false);

  // Start pairing once, when the wizard opens.
  const hasAutoStarted = useRef(false);
  useEffect(() => {
    if (step === "idle" && !hasAutoStarted.current) {
      hasAutoStarted.current = true;
      logger.info("[AddDeviceWizard] Starting pairing...");
      void startPairing();
    }
  }, [step, startPairing]);

  const handleDone = useCallback(() => {
    void reset();
    onComplete();
  }, [reset, onComplete]);

  const handleCancel = useCallback(() => {
    void cancel();
    onCancel();
  }, [cancel, onCancel]);

  const handleConfirm = useCallback(() => {
    void confirmSAS();
  }, [confirmSAS]);

  const handleReject = useCallback(() => {
    setRejected(true);
    void rejectSAS();
  }, [rejectSAS]);

  // The hook transfers again if the new device is still connected; otherwise
  // this starts a new pairing, and the transfer marker is set again only if
  // it transfers.
  const handleRetry = useCallback(() => {
    setTransferStarted(false);
    hasAutoStarted.current = false;
    void reset();
  }, [reset]);

  const handleNewCode = useCallback(() => {
    setRejected(false);
    setTransferStarted(false);
    hasAutoStarted.current = false;
    void reset();
  }, [reset]);

  const handleStartOver = useCallback(() => {
    setRejected(false);
    setTransferStarted(false);
    hasAutoStarted.current = true;
    void startPairing();
  }, [startPairing]);

  const progress: WizardProgress = rejected
    ? { step: "connect", failed: true }
    : step === "transferring"
      ? { step: "transfer" }
      : step === "success"
        ? { step: "done" }
        : step === "error"
          ? { step: transferStarted ? "transfer" : "connect", failed: true }
          : { step: "connect" };

  const screen = (() => {
    if (rejected) {
      return (
        <PairingResult
          success={false}
          icon={<Icons.ShieldAlert className="size-8" aria-hidden />}
          title={t("sync:sas.mismatchTitle")}
          description={t("sync:sas.mismatchDescription")}
          onRetry={handleStartOver}
          retryLabel={t("sync:displayCode.newCode")}
          onDone={onCancel}
          doneLabel={t("common:close")}
        />
      );
    }
    switch (step) {
      case "idle":
      case "display_code":
      case "expired":
        // Same screen from generation to expiry, so nothing jumps around.
        return (
          <DisplayCode
            title={t("sync:pairing.connectAnotherTitle")}
            description={t("sync:pairing.scanOrEnterDescription")}
            code={pairingCode}
            expiresAt={expiresAt}
            onCancel={handleCancel}
            onRenew={handleNewCode}
          />
        );
      case "verify_sas":
        return <SASVerification sas={sas} onConfirm={handleConfirm} onReject={handleReject} />;
      case "transferring":
        // The transfer runs in this window, so it offers no way to close until it ends.
        return (
          <WaitingState
            title={t("sync:pairing.transferringData")}
            description={t("sync:pairing.transferringDataDescription")}
            visual={<DeviceLink source="this" flowing />}
            footnote={<EncryptedNote />}
            // What this device does; the app cannot track these one by one.
            details={[
              { label: t("sync:wizard.details.encrypt"), icon: <Icons.Lock /> },
              { label: t("sync:wizard.details.upload"), icon: <Icons.Upload /> },
              { label: t("sync:wizard.details.sendKeys"), icon: <Icons.ShieldCheck /> },
            ]}
          />
        );
      case "success":
        // This device only sent its data; the new device reports Ready.
        return (
          <PairingResult
            success
            title={t("sync:result.devicesConnected")}
            description={t("sync:result.finishOnOtherDevice")}
            onDone={handleDone}
          />
        );
      case "error":
        return (
          <PairingResult
            success={false}
            error={error}
            onRetry={handleRetry}
            onDone={handleCancel}
          />
        );
    }
  })();

  return (
    <WizardLayout mode="add" progress={progress}>
      {screen}
    </WizardLayout>
  );
}

/** New device: enter the code, wait for verification, then receive the data. */
export function JoinDeviceWizard({
  onComplete,
  onCancel,
  title,
}: DeviceWizardProps & {
  /** Replaces "Connect this device", e.g. when updating a stale device. */
  title?: string;
}) {
  const { t } = useTranslation();
  const { step, error, sas, operation, restore, submitCode, cancel, retry } = usePairingClaimer();

  const handleCancel = useCallback(async () => {
    await cancel();
    onCancel();
  }, [cancel, onCancel]);

  const progress: WizardProgress | null = operation
    ? restoreWizardProgress(operation)
    : { step: "connect", failed: step === "error" };

  const screen = (() => {
    switch (step) {
      case "enter_code":
      case "connecting":
        // One screen while the code is checked, so a mistyped code can be fixed in place.
        return (
          <EnterCode
            title={title ?? t("sync:pairing.connectThisDeviceTitle")}
            description={t("sync:pairing.enterCodeDescription")}
            onSubmit={submitCode}
            onCancel={handleCancel}
            isLoading={step === "connecting"}
            error={error}
          />
        );
      case "waiting_keys":
        return <SASWaiting sas={sas} onCancel={handleCancel} />;
      case "confirming":
      case "restoring":
        // The restore takes over once the runtime reports it.
        return operation ? (
          <RestoreOperationView
            operation={operation}
            controller={restore}
            onClose={onCancel}
            onDone={onComplete}
          />
        ) : (
          <WaitingState
            title={t("sync:pairing.securingConnection")}
            description={t("sync:pairing.securingConnectionDescription")}
            visual={<DeviceLink source="other" />}
            footnote={<EncryptedNote />}
            // Hides only: a confirmation still in flight finishes in the background.
            onCancel={onCancel}
          />
        );
      case "error":
        return (
          <PairingResult success={false} error={error} onRetry={retry} onDone={handleCancel} />
        );
    }
  })();

  return (
    <WizardLayout
      mode="join"
      progress={progress}
      // Closing hides a running restore; the section banner reopens it.
      onHide={operation && !isRestoreFinished(operation) ? onCancel : undefined}
    >
      {screen}
    </WizardLayout>
  );
}

// Re-export sub-components for flexibility
export { DisplayCode } from "./display-code";
export { SASVerification, SASWaiting } from "./sas-verification";
export { WaitingState } from "./waiting-state";
export { PairingResult } from "./pairing-result";
