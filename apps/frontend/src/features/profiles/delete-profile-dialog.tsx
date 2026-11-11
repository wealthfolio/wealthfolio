import { profileErrorMessage } from "./error-messages";
import { useTranslation } from "react-i18next";
import { useState } from "react";
import { backupDatabase, isWeb } from "@/adapters";
import { Button, Input, Label, stripBidiControls } from "@wealthfolio/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@wealthfolio/ui/components/ui/dialog";
import { PasswordInput } from "@wealthfolio/ui/components/ui/password-input";
import { BackupExportDialog } from "@/pages/settings/exports/backup-export-dialog";
import { ProfileAvatar } from "./profile-avatar";
import type { ProfileSummary } from "./api";

interface DeleteProfileDialogProps {
  profile: ProfileSummary;
  error?: string;
  onClose: () => void;
  onDelete: (confirmation: string, proof: string) => void;
}

export function DeleteProfileDialog({
  profile,
  onClose,
  onDelete,
  error: deletionError,
}: DeleteProfileDialogProps) {
  const { t } = useTranslation("common");
  const [confirmation, setConfirmation] = useState("");
  // The label shows the name isolated in a right-to-left language, so a name copied
  // from it carries bidi isolation marks: compare without them.
  const nameConfirmed = stripBidiControls(confirmation) === stripBidiControls(profile.name);
  const [proof, setProof] = useState("");
  const [exporting, setExporting] = useState(false);
  const [backup, setBackup] = useState<string>();
  const [error, setError] = useState("");
  const [proofEdited, setProofEdited] = useState(false);
  const invalidProof = Boolean(deletionError?.includes("PROFILE_PASSWORD_INVALID"));
  const cooldown = deletionError?.match(/PROFILE_COOLDOWN: Try again in (\d+) seconds/);
  const deletionMessage =
    !deletionError || invalidProof
      ? ""
      : cooldown
        ? profileErrorMessage(deletionError, t)
        : deletionError.includes("PROFILE_STALE") || deletionError.includes("PROFILE_LOCKED")
          ? t("profiles.errors.deleteLocked")
          : t("profiles.errors.delete");
  if (backup) return <BackupExportDialog filename={backup} onClose={() => setBackup(undefined)} />;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !exporting) onClose();
      }}
    >
      <DialogContent
        className="gap-6 rounded-3xl sm:!max-w-md"
        mobileClassName="overflow-y-auto [--overlay-max-height:90dvh]"
      >
        <DialogHeader className="gap-3 text-start">
          <span className="profile-lock-avatar mx-auto mb-1 w-fit [--avatar-rim:3px]">
            <ProfileAvatar id={profile.avatarId} className="size-14 rounded-full" />
          </span>
          <DialogTitle>
            {t(isWeb ? "profiles.deleteTitleServer" : "profiles.deleteTitleDevice", {
              name: profile.name,
            })}
          </DialogTitle>
          <DialogDescription>
            {t("profiles.deleteWarning")}
            <span className="mt-2 block">
              {t("profiles.deletePreserved")}
              {isWeb && <> {t("profiles.deleteServerWarning")}</>}
            </span>
          </DialogDescription>
        </DialogHeader>
        <Button
          type="button"
          variant="outline"
          disabled={exporting}
          onClick={async () => {
            setExporting(true);
            setError("");
            try {
              setBackup((await backupDatabase()).filename);
            } catch {
              setError("backup");
            } finally {
              setExporting(false);
            }
          }}
        >
          {exporting ? t("profiles.preparingBackup") : t("profiles.exportBackup")}
        </Button>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (nameConfirmed && (!profile.lockEnabled || proof)) {
              setProofEdited(false);
              onDelete(profile.name, proof);
            }
          }}
          className="space-y-4"
        >
          <div className="space-y-2">
            <Label htmlFor="delete-profile-name">
              {t("profiles.confirmDeletion", { name: profile.name })}
            </Label>
            <Input
              id="delete-profile-name"
              autoComplete="off"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              disabled={exporting}
            />
          </div>
          {profile.lockEnabled && (
            <div className="space-y-2">
              <Label htmlFor="delete-profile-proof">{t("profiles.currentProof")}</Label>
              <PasswordInput
                id="delete-profile-proof"
                showLabel={t("profiles.showProof")}
                hideLabel={t("profiles.hideProof")}
                autoComplete="off"
                value={proof}
                onChange={(event) => {
                  setProof(event.target.value);
                  setProofEdited(true);
                }}
                aria-invalid={invalidProof && !proofEdited}
                aria-describedby={
                  invalidProof && !proofEdited ? "delete-profile-proof-error" : undefined
                }
                disabled={exporting}
              />
              {invalidProof && !proofEdited && (
                <p
                  id="delete-profile-proof-error"
                  role="alert"
                  className="text-destructive text-sm"
                >
                  {t("profiles.errors.incorrectProof")}
                </p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={exporting}>
              {t("profiles.cancel")}
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={exporting || !nameConfirmed || (profile.lockEnabled && !proof)}
            >
              {t("profiles.delete")}
            </Button>
          </DialogFooter>
          {(error || deletionMessage) && (
            <p role="alert" className="text-destructive text-sm">
              {error ? t("profiles.errors.backup") : deletionMessage}
            </p>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
