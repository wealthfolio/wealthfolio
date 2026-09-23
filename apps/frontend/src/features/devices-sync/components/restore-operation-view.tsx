// RestoreOperationView
// The Download and Apply steps of the setup wizard: the profile's restore
// operation, shown while joining a device or when recovering outside pairing.
// It only displays runtime state and forwards decisions.
// =========================================================================

import { useProfile } from "@/features/profiles/profile-context";
import { Icons } from "@wealthfolio/ui";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Checkbox } from "@wealthfolio/ui/components/ui/checkbox";
import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  isRestoreFinished,
  type RestoreController,
  type RestoreOperation,
} from "../hooks/use-restore-operation";
import { logSyncError } from "../utils/error-messages";
import { DeviceLink } from "./device-link";
import { FlowIcon, FlowScreen, type FlowTone } from "./flow-layout";
import { BackgroundNote } from "./flow-notes";
import { StepDetails, type StepDetail } from "./step-details";

interface RestoreOperationViewProps {
  operation: RestoreOperation;
  controller: RestoreController;
  /** Closes a finished, failed or cancelled restore. */
  onClose: () => void;
  onDone?: () => void;
}

export function RestoreOperationView({
  operation,
  controller,
  onClose,
  onDone,
}: RestoreOperationViewProps) {
  const { t, i18n } = useTranslation();
  const backupId = useId();
  const profileName = useProfile()?.profile?.name;
  // Backing up first is the safe default for a destructive replacement.
  const [backup, setBackup] = useState(true);
  const { operationId, phase } = operation;
  const busy =
    controller.approve.isPending ||
    controller.retry.isPending ||
    controller.cancel.isPending ||
    controller.start.isPending;

  const run = (label: string, action: () => Promise<unknown>) => {
    action().catch((err) => logSyncError(label, err));
  };
  const approve = () =>
    run("Restore approval failed", () => controller.approve.mutateAsync({ operationId, backup }));
  const retry = () => run("Restore retry failed", () => controller.retry.mutateAsync(operationId));
  const cancel = () =>
    run("Restore cancel failed", () => controller.cancel.mutateAsync(operationId));
  const startAgain = () =>
    run("Restore restart failed", () => controller.start.mutateAsync({ newAttempt: true }));

  if (phase === "ready") {
    return (
      <FlowScreen
        data-testid="restore-operation"
        data-phase={phase}
        tone="success"
        icon={<FlowIcon kind="success" />}
        title={t("sync:restore.ready.title")}
        description={t("sync:restore.ready.description")}
        actions={
          <Button className="w-full" onClick={onDone ?? onClose}>
            {t("sync:result.done")}
          </Button>
        }
      />
    );
  }

  const copiedAt = operation.snapshot ? new Date(operation.snapshot.createdAt) : null;
  const copiedAtLabel =
    copiedAt && !Number.isNaN(copiedAt.getTime())
      ? copiedAt.toLocaleString(i18n.resolvedLanguage, { dateStyle: "medium", timeStyle: "short" })
      : null;
  const header = (() => {
    switch (phase) {
      case "transferring":
        return {
          title: t("sync:restore.transferring.title"),
          description: t("sync:restore.transferring.description"),
        };
      case "waiting_for_snapshot":
        return {
          title: t("sync:restore.waiting.title"),
          description: t("sync:restore.waiting.description"),
        };
      case "awaiting_consent":
        return {
          title: profileName
            ? t("sync:restore.consent.titleNamed", { profile: profileName })
            : t("sync:restore.consent.title"),
          description: copiedAtLabel
            ? t("sync:restore.consent.descriptionDated", { date: copiedAtLabel })
            : t("sync:restore.consent.description"),
        };
      case "backing_up":
        return {
          title: t("sync:restore.backingUp.title"),
          description: t("sync:restore.backingUp.description"),
        };
      case "replacing":
        return {
          title: t("sync:restore.replacing.title"),
          description: t("sync:restore.replacing.description"),
        };
      case "failed":
        return {
          title: t(`sync:restore.errors.${operation.error?.code ?? "TRANSFER_FAILED"}`),
          description: null,
        };
      case "cancelled":
        return {
          title: t("sync:restore.cancelled.title"),
          description: t("sync:restore.cancelled.description"),
        };
    }
  })();

  // The real sub-steps of Download and Apply, from the restore's phase.
  const details: StepDetail[] | null =
    phase === "waiting_for_snapshot" || phase === "transferring"
      ? [
          {
            label: t("sync:wizard.details.waitForUpload"),
            state: phase === "waiting_for_snapshot" ? "active" : "done",
          },
          {
            label: t("sync:wizard.details.downloadAndVerify"),
            state: phase === "transferring" ? "active" : "pending",
          },
        ]
      : phase === "backing_up"
        ? [
            { label: t("sync:wizard.details.backup"), state: "active" },
            { label: t("sync:wizard.details.replace"), state: "pending" },
          ]
        : phase === "replacing"
          ? // The backup only ran if the user asked for it, so it is not listed.
            [{ label: t("sync:wizard.details.replace"), state: "active" }]
          : null;

  // Once approved, the backup and the replacement run to the end.
  const canCancel = ["transferring", "waiting_for_snapshot", "awaiting_consent"].includes(phase);

  const badge: { tone: FlowTone; icon: ReactNode } =
    phase === "awaiting_consent"
      ? { tone: "warning", icon: <Icons.AlertTriangle className="size-8" aria-hidden /> }
      : phase === "failed"
        ? { tone: "error", icon: <FlowIcon kind="error" /> }
        : phase === "cancelled"
          ? { tone: "neutral", icon: <Icons.Close className="size-8" aria-hidden /> }
          : { tone: "primary", icon: <FlowIcon kind="working" /> };

  const actions =
    phase === "awaiting_consent" ? (
      <>
        <Button className="w-full gap-2" onClick={approve} disabled={busy}>
          {controller.approve.isPending && (
            <Icons.Spinner className="size-4 animate-spin" aria-hidden />
          )}
          {backup ? t("sync:restore.consent.backupAndReplace") : t("sync:restore.consent.replace")}
        </Button>
        <Button variant="ghost" className="w-full" onClick={cancel} disabled={busy}>
          {t("sync:restore.cancelSetup")}
        </Button>
      </>
    ) : phase === "failed" || phase === "cancelled" ? (
      <>
        {phase === "failed" && operation.error?.retry !== "new_attempt" ? (
          <Button className="w-full gap-2" onClick={retry} disabled={busy}>
            {controller.retry.isPending && (
              <Icons.Spinner className="size-4 animate-spin" aria-hidden />
            )}
            {t("sync:restore.tryAgain")}
          </Button>
        ) : (
          <Button className="w-full gap-2" onClick={startAgain} disabled={busy}>
            {controller.start.isPending && (
              <Icons.Spinner className="size-4 animate-spin" aria-hidden />
            )}
            {phase === "cancelled" ? t("sync:restore.finishSetup") : t("sync:restore.startAgain")}
          </Button>
        )}
        <Button variant="ghost" className="w-full" onClick={onClose} disabled={busy}>
          {t("common:close")}
        </Button>
      </>
    ) : canCancel ? (
      <Button variant="ghost" className="w-full" onClick={cancel} disabled={busy}>
        {t("sync:restore.cancelSetup")}
      </Button>
    ) : null;

  return (
    <FlowScreen
      data-testid="restore-operation"
      data-phase={phase}
      stateKey={phase}
      tone={badge.tone}
      icon={badge.icon}
      title={header.title}
      description={header.description}
      live={phase !== "awaiting_consent"}
      working={badge.tone === "primary"}
      footnote={
        !isRestoreFinished(operation) && phase !== "awaiting_consent" ? (
          <BackgroundNote />
        ) : undefined
      }
      visual={
        phase === "transferring" ? (
          <DeviceLink source="other" flowing />
        ) : phase === "waiting_for_snapshot" ? (
          <DeviceLink source="other" />
        ) : undefined
      }
      actions={actions}
    >
      {phase === "awaiting_consent" ? (
        <label
          htmlFor={backupId}
          className="bg-muted/50 hover:bg-muted flex cursor-pointer items-center gap-3 rounded-xl p-4 text-sm transition-colors"
        >
          <Checkbox
            id={backupId}
            checked={backup}
            disabled={busy}
            onCheckedChange={(checked) => setBackup(checked === true)}
          />
          {t("sync:restore.consent.backupLabel")}
        </label>
      ) : details ? (
        <StepDetails details={details} />
      ) : phase === "failed" ? (
        <p
          role="alert"
          className="border-destructive/20 bg-destructive/5 rounded-xl border p-3 text-center text-sm leading-relaxed"
        >
          {t(`sync:restore.retryHint.${operation.error?.retry ?? "transfer"}`)}
        </p>
      ) : null}
    </FlowScreen>
  );
}
