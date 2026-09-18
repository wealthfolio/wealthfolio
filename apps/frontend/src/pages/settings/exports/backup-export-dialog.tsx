import { BackupError, type BackupFailure } from "@/pages/settings/exports/backup-error";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { exportDatabaseBackup } from "@/adapters";
import { Button } from "@wealthfolio/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@wealthfolio/ui/components/ui/dialog";
import { PasswordInput } from "@wealthfolio/ui/components/ui/password-input";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Label } from "@wealthfolio/ui/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@wealthfolio/ui/components/ui/radio-group";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";
import { generateBackupPassword, isValidBackupPassword } from "./backup-password";

interface BackupExportDialogProps {
  filename: string;
  displayName?: string;
  onClose: () => void;
}

/** Mount once for the selected snapshot; closing drops all password form state. */
export function BackupExportDialog({ filename, displayName, onClose }: BackupExportDialogProps) {
  const { t } = useTranslation();
  const id = useId();
  const operation = useRef<AbortController | null>(null);
  useEffect(() => () => operation.current?.abort(), []);
  const [unencrypted, setUnencrypted] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<BackupFailure | null>(null);
  const clear = () => {
    setPassword("");
    setConfirmation("");
  };
  const close = () => {
    operation.current?.abort();
    clear();
    onClose();
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!unencrypted && !isValidBackupPassword(password)) {
      setError(t("settings:backup_export_password_invalid"));
      return;
    }
    if (!unencrypted && password !== confirmation) {
      setError(t("settings:backup_export_password_mismatch"));
      return;
    }
    setPending(true);
    const controller = new AbortController();
    operation.current = controller;
    try {
      const saved = await exportDatabaseBackup(
        filename,
        unencrypted ? null : password,
        unencrypted,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (saved) toast({ title: t("settings:backup_export_ready"), variant: "success" });
      close();
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError({ cause });
    } finally {
      clear();
      setPending(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("settings:backup_export_dialog_title")}</DialogTitle>
          <DialogDescription>{t("settings:backup_export_description")}</DialogDescription>
        </DialogHeader>
        <div className="bg-muted/50 flex min-w-0 items-center gap-3 rounded-lg p-3">
          <Icons.FileArchive className="text-muted-foreground size-5 shrink-0" aria-hidden />
          <p className="min-w-0 break-words text-sm font-medium" title={filename}>
            {displayName ?? filename}
          </p>
        </div>
        <form onSubmit={submit} className="space-y-4">
          <RadioGroup
            className="grid gap-2 sm:grid-cols-2"
            disabled={pending}
            value={unencrypted ? "plain" : "protected"}
            onValueChange={(value) => {
              setUnencrypted(value === "plain");
              clear();
              setError(null);
            }}
          >
            <div className="has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-muted/50 flex items-center gap-2 rounded-lg border p-3">
              <RadioGroupItem value="protected" id={`${id}-protected`} />
              <Label className="flex-1 cursor-pointer leading-relaxed" htmlFor={`${id}-protected`}>
                {t("settings:backup_export_protected")}
              </Label>
            </div>
            <div className="has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-muted/50 flex items-center gap-2 rounded-lg border p-3">
              <RadioGroupItem value="plain" id={`${id}-plain`} />
              <Label className="flex-1 cursor-pointer leading-relaxed" htmlFor={`${id}-plain`}>
                {t("settings:backup_export_plain")}
              </Label>
            </div>
          </RadioGroup>
          {unencrypted ? (
            <p className="bg-muted/50 rounded-lg p-3 text-sm leading-relaxed" role="note">
              {t("settings:backup_export_plain_warning")}
            </p>
          ) : (
            <>
              <div className="grid gap-4">
                <div className="space-y-2">
                  <Label htmlFor={`${id}-password`}>{t("settings:backup_export_password")}</Label>
                  <PasswordInput
                    id={`${id}-password`}
                    showLabel={t("settings:backup_export_show")}
                    hideLabel={t("settings:backup_export_hide")}
                    autoComplete="new-password"
                    spellCheck={false}
                    autoCapitalize="none"
                    disabled={pending}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    aria-describedby={`${id}-help`}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`${id}-confirmation`}>
                    {t("settings:backup_export_confirm_password")}
                  </Label>
                  <PasswordInput
                    id={`${id}-confirmation`}
                    showLabel={t("settings:backup_export_show")}
                    hideLabel={t("settings:backup_export_hide")}
                    autoComplete="new-password"
                    spellCheck={false}
                    autoCapitalize="none"
                    disabled={pending}
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value)}
                  />
                </div>
              </div>
              <div className="flex items-center gap-2 md:flex-wrap">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-w-0 max-md:h-auto max-md:min-h-11 max-md:shrink max-md:whitespace-normal max-md:py-2"
                  disabled={pending}
                  onClick={() => {
                    const generated = generateBackupPassword();
                    setPassword(generated);
                    setConfirmation(generated);
                  }}
                >
                  <Icons.Sparkles className="mr-1.5 size-3.5" aria-hidden />
                  {t("settings:backup_export_generate")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="max-md:size-11 max-md:p-0"
                  aria-label={t("settings:backup_export_copy")}
                  title={t("settings:backup_export_copy")}
                  disabled={pending || !password}
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(password);
                      toast({ title: t("settings:backup_export_copied") });
                    } catch (cause) {
                      setError({ cause });
                    }
                  }}
                >
                  <Icons.Copy className="size-4 md:mr-1.5 md:size-3.5" aria-hidden />
                  <span className="hidden md:inline">{t("settings:backup_export_copy")}</span>
                </Button>
              </div>
              <p id={`${id}-help`} className="text-muted-foreground text-xs leading-relaxed">
                {t("settings:backup_export_password_help")}
              </p>
            </>
          )}
          {error && (
            <div role="alert" className="text-destructive text-sm">
              <BackupError error={error} />
            </div>
          )}
          <DialogFooter className="border-t pt-4">
            <Button type="button" variant="outline" onClick={close}>
              {t("common:cancel")}
            </Button>
            <Button type="submit" disabled={pending}>
              {t(
                pending
                  ? "settings:backup_export_busy"
                  : unencrypted
                    ? "settings:backup_export_plain_button"
                    : "common:export",
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
