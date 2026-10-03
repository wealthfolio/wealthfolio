import { BackupError, type BackupFailure } from "@/pages/settings/exports/backup-error";
import { reloadApplication } from "@/lib/reload-application";
import { useEffect, useId, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import {
  discardDatabaseBackupImport,
  getDatabaseEncryptionStatus,
  inspectDatabaseBackup,
  inspectSavedDatabaseBackup,
  openDatabaseFileDialog,
  restoreDatabaseBackupImport,
  type BackupImportPreview,
} from "@/adapters";
import { QueryKeys } from "@/lib/query-keys";
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

export function BackupImportDialog({
  filename,
  displayName,
  onClose,
}: {
  filename?: string;
  displayName?: string;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const reduceMotion = useReducedMotion();
  const [restored, setRestored] = useState(false);
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const scrollBody = useRef<HTMLDivElement>(null);
  const encryption = useQuery({
    queryKey: [QueryKeys.DATABASE_ENCRYPTION],
    queryFn: getDatabaseEncryptionStatus,
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [preview, setPreview] = useState<BackupImportPreview | null>(null);
  const [pending, setPending] = useState<"inspect" | "restore" | null>(null);
  const [error, setError] = useState<BackupFailure | null>(null);
  const operation = useRef<AbortController | null>(null);
  const previewId = useRef<string | null>(null);
  useEffect(
    () => () => {
      operation.current?.abort();
      if (previewId.current)
        void discardDatabaseBackupImport(previewId.current).catch(() => undefined);
    },
    [],
  );
  useEffect(() => {
    if (scrollBody.current) scrollBody.current.scrollTop = 0;
    if (preview) stepHeading.current?.focus();
  }, [preview]);
  useEffect(() => {
    if (!restored) return;
    const timer = setTimeout(() => reloadApplication(), 1200);
    return () => clearTimeout(timer);
  }, [restored]);
  const back = () => {
    if (pending) return;
    const oldId = previewId.current;
    previewId.current = null;
    setPreview(null);
    setError(null);
    stepHeading.current?.focus();
    if (oldId) void discardDatabaseBackupImport(oldId).catch(() => undefined);
  };
  const close = () => {
    if (pending === "restore") return;
    operation.current?.abort();
    setPassword("");
    onClose();
  };
  const inspect = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pending || (!filename && !selected)) return;
    const controller = new AbortController();
    operation.current = controller;
    setPending("inspect");
    setError(null);
    try {
      const result = filename
        ? await inspectSavedDatabaseBackup(filename, controller.signal)
        : await inspectDatabaseBackup(selected!, password || null, controller.signal);
      if (!controller.signal.aborted && result) {
        previewId.current = result.id;
        setPreview(result);
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError({ cause });
    } finally {
      setPassword("");
      setPending(null);
    }
  };
  const confirm = async () => {
    if (pending || previewId.current !== preview?.id || !encryption.data) return;
    setPending("restore");
    setError(null);
    previewId.current = null;
    try {
      await restoreDatabaseBackupImport(preview.id);
      setRestored(true);
    } catch (cause) {
      setError({ cause });
      setPreview(null);
      setPending(null);
    }
  };
  const choose = async () => {
    try {
      const path = await openDatabaseFileDialog();
      if (path) {
        setSelected(path);
        setPassword("");
        setError(null);
      }
    } catch (cause) {
      setError({ cause });
    }
  };
  const EncryptionIcon = encryption.data?.enabled ? Icons.Lock : Icons.LockOpen;
  const created = preview?.summary.createdAt ? new Date(preview.summary.createdAt) : null;
  const selectedName = filename ? (displayName ?? filename) : selected?.split(/[\\/]/).pop();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        className="flex flex-col gap-0 overflow-hidden p-0 sm:max-w-md"
        mobileClassName="h-[min(42rem,85dvh)]"
        showCloseButton={pending !== "restore"}
        onEscapeKeyDown={(event) => {
          if (pending === "restore") event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (pending === "restore") event.preventDefault();
        }}
      >
        <DialogHeader className={restored ? "sr-only" : "shrink-0 gap-3 px-6 pb-5 pt-7 text-left"}>
          <div className="flex gap-1.5 pr-12" aria-hidden>
            <span className="bg-primary h-1 w-8 rounded-full" />
            <span
              className={`h-1 w-8 rounded-full transition-colors ${preview ? "bg-primary" : "bg-muted"}`}
            />
          </div>
          <DialogTitle
            ref={stepHeading}
            tabIndex={-1}
            className="pr-10 text-xl leading-snug outline-none"
          >
            {t(
              restored
                ? "settings:backup_restored_title"
                : preview
                  ? "settings:backup_restore_title"
                  : "settings:backup_open_title",
            )}
          </DialogTitle>
          <DialogDescription
            className={restored || preview ? "sr-only" : "text-xs leading-relaxed"}
          >
            {t("settings:backup_import_description")}
          </DialogDescription>
        </DialogHeader>
        {restored ? (
          <div
            role="status"
            className="flex min-h-80 flex-1 flex-col items-center justify-center gap-6 px-6 pb-10 text-center"
          >
            <motion.div
              initial={reduceMotion ? false : { scale: 0.6, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: "spring", stiffness: 200, damping: 15 }}
              className="bg-success/10 text-success flex size-20 items-center justify-center rounded-full"
            >
              <Icons.CheckCircle className="size-10" aria-hidden />
            </motion.div>
            <h3 className="text-xl font-semibold">{t("settings:backup_restored_title")}</h3>
            <p className="text-muted-foreground max-w-xs text-sm leading-relaxed">
              {t("settings:backup_restore_success_help")}
            </p>
          </div>
        ) : (
          <form
            onSubmit={
              preview
                ? (event) => {
                    event.preventDefault();
                    void confirm();
                  }
                : inspect
            }
            className="flex min-h-0 flex-1 flex-col"
          >
            <div
              ref={scrollBody}
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pb-6 sm:max-h-[55dvh]"
            >
              <motion.div
                key={preview ? "review" : "open"}
                initial={false}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2 }}
                className="space-y-5"
              >
                {selectedName ? (
                  <div
                    className={
                      preview
                        ? "text-muted-foreground flex min-w-0 items-center gap-3"
                        : "bg-muted/50 flex min-w-0 items-center gap-3 rounded-xl border p-3"
                    }
                  >
                    <div
                      className={
                        preview
                          ? "shrink-0"
                          : "bg-background text-muted-foreground flex size-10 shrink-0 items-center justify-center rounded-lg"
                      }
                    >
                      <Icons.FileArchive className="size-5" aria-hidden />
                    </div>
                    <p
                      className="min-w-0 flex-1 truncate text-xs font-medium"
                      title={filename ?? selectedName}
                    >
                      {selectedName}
                    </p>
                    {!filename && !preview && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-11 shrink-0"
                        disabled={pending !== null}
                        onClick={() => void choose()}
                        aria-label={t("settings:recovery_change_file")}
                      >
                        <Icons.FolderOpen className="size-4" aria-hidden />
                      </Button>
                    )}
                  </div>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    className="h-24 w-full gap-3 rounded-xl border-dashed"
                    disabled={pending !== null}
                    onClick={() => void choose()}
                  >
                    <Icons.FolderOpen className="size-5" aria-hidden />
                    {t("settings:recovery_choose_file")}
                  </Button>
                )}
                {preview ? (
                  <>
                    <section className="space-y-3" aria-label={t("settings:recovery_preview")}>
                      <h3 className="text-muted-foreground text-xs font-medium">
                        {t("settings:recovery_preview")}
                      </h3>
                      <dl className="bg-muted/50 grid grid-cols-2 divide-x rounded-xl py-4">
                        {[
                          { label: t("common:accounts"), value: preview.summary.accountCount },
                          { label: t("common:activities"), value: preview.summary.activityCount },
                        ].map(({ label, value }) => (
                          <div key={label} className="flex flex-col gap-1 px-4">
                            <dt className="text-muted-foreground text-xs">{label}</dt>
                            <dd className="order-first text-2xl font-semibold tabular-nums tracking-tight">
                              {value.toLocaleString(i18n.resolvedLanguage)}
                            </dd>
                          </div>
                        ))}
                      </dl>
                      {created && !Number.isNaN(created.getTime()) && (
                        <p className="text-muted-foreground text-xs">
                          {t("settings:recovery_created", {
                            date: created.toLocaleString(i18n.resolvedLanguage),
                          })}
                        </p>
                      )}
                    </section>
                    <div className="border-destructive/20 bg-destructive/5 flex gap-3 rounded-xl border p-4">
                      <Icons.AlertTriangle
                        className="text-destructive mt-0.5 size-4 shrink-0"
                        aria-hidden
                      />
                      <div className="space-y-2">
                        <p className="text-sm font-medium leading-relaxed">
                          {t("settings:backup_replace_warning")}
                        </p>
                        <p className="text-muted-foreground text-xs leading-relaxed">
                          {t("settings:backup_restore_safeguard")}
                        </p>
                      </div>
                    </div>
                    <div className="text-muted-foreground space-y-3 text-xs leading-relaxed">
                      {encryption.data && (
                        <div className="flex gap-3">
                          <EncryptionIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
                          <p>
                            {t(
                              encryption.data.enabled
                                ? "settings:backup_destination_encrypted"
                                : "settings:backup_destination_plain",
                            )}
                          </p>
                        </div>
                      )}
                      <div className="flex gap-3">
                        <Icons.RefreshCw className="mt-0.5 size-4 shrink-0" aria-hidden />
                        <p>{t("settings:backup_import_reconnect")}</p>
                      </div>
                    </div>
                  </>
                ) : (
                  !filename && (
                    <div className="space-y-3">
                      <div className="space-y-2">
                        <Label htmlFor={`${id}-password`} className="text-sm">
                          {t("settings:recovery_password")}
                        </Label>
                        <PasswordInput
                          id={`${id}-password`}
                          aria-describedby={`${id}-password-help`}
                          showLabel={t("settings:backup_export_show")}
                          hideLabel={t("settings:backup_export_hide")}
                          autoComplete="off"
                          autoCapitalize="none"
                          spellCheck={false}
                          value={password}
                          disabled={pending !== null}
                          onChange={(event) => setPassword(event.target.value)}
                        />
                        <p id={`${id}-password-help`} className="text-muted-foreground text-xs">
                          {t("settings:backup_password_optional")}
                        </p>
                      </div>
                      <details className="text-muted-foreground text-xs leading-relaxed">
                        <summary className="cursor-pointer py-2">
                          {t("settings:backup_password_help_title")}
                        </summary>
                        <p className="pt-1">{t("settings:recovery_password_help")}</p>
                      </details>
                    </div>
                  )
                )}
                {encryption.isError && (
                  <p role="alert" className="text-destructive text-sm">
                    {t("settings:backup_encryption_status_failed")}
                  </p>
                )}
                {error && (
                  <div role="alert" className="text-destructive break-words text-sm">
                    <BackupError error={error} />
                  </div>
                )}
              </motion.div>
            </div>
            <DialogFooter className="bg-background shrink-0 border-t px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-4 sm:pb-6">
              <Button
                type="button"
                variant="ghost"
                disabled={pending === "restore"}
                onClick={preview ? back : close}
              >
                {preview && <Icons.ArrowLeft className="mr-2 size-4" aria-hidden />}
                {t(preview ? "common:back" : "common:cancel")}
              </Button>
              <Button
                type="submit"
                className="gap-2 sm:flex-1"
                disabled={pending !== null || (preview ? !encryption.data : !filename && !selected)}
              >
                {pending && <Icons.Spinner className="size-4 animate-spin" aria-hidden />}
                {t(
                  preview
                    ? pending === "restore"
                      ? "settings:recovery_restoring"
                      : "settings:backup_restore_title"
                    : pending === "inspect"
                      ? "settings:recovery_inspecting"
                      : "settings:recovery_inspect",
                )}
                {!pending && !preview && <Icons.ArrowRight className="size-4" aria-hidden />}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
