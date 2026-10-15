import type { BackupFailure } from "@/pages/settings/exports/backup-error";
import { reloadApplication } from "@/lib/reload-application";
import { useEffect, useId, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { useDateFormatting } from "@wealthfolio/ui";
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
import { BackupAlert, PendingIcon } from "./backup-ui";

export function BackupImportDialog({
  filename,
  displayName,
  onClose,
  onRetry,
  initialPreview,
}: {
  initialPreview?: BackupImportPreview;
  filename?: string;
  displayName?: string;
  onClose: () => void;
  /** Fetches a new caller preview after this one was used; the caller remounts the dialog. */
  onRetry?: () => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const formatting = useDateFormatting();
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
  const [preview, setPreview] = useState<BackupImportPreview | null>(initialPreview ?? null);
  const [pending, setPending] = useState<"inspect" | "restore" | null>(null);
  const [error, setError] = useState<BackupFailure | null>(null);
  const operation = useRef<AbortController | null>(null);
  const previewId = useRef<string | null>(initialPreview?.id ?? null);
  // StrictMode remounts once in development, so a caller's preview is discarded on close only.
  const callerPreviewId = useRef(initialPreview?.id);
  useEffect(
    () => () => {
      operation.current?.abort();
      if (previewId.current && previewId.current !== callerPreviewId.current)
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
    if (previewId.current) {
      void discardDatabaseBackupImport(previewId.current).catch(() => undefined);
      previewId.current = null;
    }
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
      if (!initialPreview) setPreview(null);
      setPending(null);
    }
  };
  const retry = async () => {
    if (pending || !onRetry) return;
    setPending("inspect");
    setError(null);
    try {
      await onRetry();
    } catch (cause) {
      setError({ cause });
    } finally {
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
  const selectedName = initialPreview
    ? (displayName ?? t("settings:cloud_backup_title"))
    : filename
      ? (displayName ?? filename)
      : selected?.split(/[\\/]/).pop();
  // A failed restore consumes its preview; a caller preview can only be checked again.
  const consumed = preview !== null && previewId.current !== preview.id;
  const canRetry = consumed && pending !== "restore" && !!initialPreview && !!onRetry;
  return (
    <Dialog
      open
      onOpenChange={(open, details) => {
        if (open) return;
        // A running restore can't be dismissed.
        if (pending === "restore") {
          details.cancel();
          return;
        }
        close();
      }}
    >
      <DialogContent
        className="flex flex-col gap-0 overflow-hidden p-0 sm:max-w-md"
        mobileClassName="h-[min(42rem,85dvh)]"
        showCloseButton={pending !== "restore"}
      >
        <DialogHeader className={restored ? "sr-only" : "shrink-0 px-6 pb-4 pt-6 text-left"}>
          <DialogTitle ref={stepHeading} tabIndex={-1} className="pr-8 outline-none">
            {t(
              restored
                ? "settings:backup_restored_title"
                : preview
                  ? "settings:backup_restore_title"
                  : "settings:backup_open_title",
            )}
          </DialogTitle>
          {/* Truncate a long file name; let the explanation wrap. */}
          <DialogDescription className={preview && selectedName ? "truncate" : undefined}>
            {preview && selectedName ? selectedName : t("settings:backup_import_description")}
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
                    void (canRetry ? retry() : confirm());
                  }
                : inspect
            }
            className="flex min-h-0 flex-1 flex-col"
          >
            <div
              ref={scrollBody}
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pb-6 sm:max-h-[60dvh]"
            >
              <motion.div
                key={preview ? "review" : "open"}
                initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2 }}
                className="space-y-4"
              >
                {preview ? (
                  <>
                    <section className="space-y-2" aria-label={t("settings:recovery_preview")}>
                      <dl className="bg-muted/50 grid grid-cols-2 divide-x rounded-lg py-3">
                        {[
                          { label: t("common:accounts"), value: preview.summary.accountCount },
                          { label: t("common:activities"), value: preview.summary.activityCount },
                        ].map(({ label, value }) => (
                          <div key={label} className="flex flex-col gap-0.5 px-4">
                            <dt className="text-muted-foreground text-xs">{label}</dt>
                            <dd className="order-first text-xl font-semibold tabular-nums tracking-tight">
                              {value.toLocaleString(i18n.resolvedLanguage)}
                            </dd>
                          </div>
                        ))}
                      </dl>
                      {created && !Number.isNaN(created.getTime()) && (
                        <p className="text-muted-foreground text-xs">
                          {t("settings:recovery_created", {
                            date: formatting.formatDateTime(created, {
                              dateStyle: "medium",
                              timeStyle: "short",
                            }),
                          })}
                        </p>
                      )}
                    </section>
                    <div className="border-warning/30 bg-warning/10 flex gap-3 rounded-lg border p-3">
                      <Icons.AlertTriangle
                        className="text-warning mt-0.5 size-4 shrink-0"
                        aria-hidden
                      />
                      <div className="space-y-1">
                        <p className="text-sm font-medium">
                          {t("settings:backup_replace_warning")}
                        </p>
                        <p className="text-muted-foreground text-xs leading-relaxed">
                          {t("settings:backup_restore_safeguard")}
                        </p>
                      </div>
                    </div>
                    <ul className="text-muted-foreground space-y-2 text-xs leading-relaxed">
                      {encryption.data && (
                        <li className="flex gap-2.5">
                          <EncryptionIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                          {t(
                            encryption.data.enabled
                              ? "settings:backup_destination_encrypted"
                              : "settings:backup_destination_plain",
                          )}
                        </li>
                      )}
                      <li className="flex gap-2.5">
                        <Icons.RefreshCw className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                        {t("settings:backup_import_reconnect")}
                      </li>
                    </ul>
                  </>
                ) : (
                  <>
                    {selectedName ? (
                      <div className="bg-muted/50 flex min-w-0 items-center gap-3 rounded-lg border p-3">
                        <Icons.FileArchive
                          className="text-muted-foreground size-5 shrink-0"
                          aria-hidden
                        />
                        <p
                          className="min-w-0 flex-1 truncate text-sm font-medium"
                          title={filename ?? selectedName}
                        >
                          {selectedName}
                        </p>
                        {!filename && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            className="pointer-coarse:size-11 shrink-0"
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
                        className="h-24 w-full gap-3 rounded-lg border-dashed"
                        disabled={pending !== null}
                        onClick={() => void choose()}
                      >
                        <Icons.FolderOpen className="size-5" aria-hidden />
                        {t("settings:recovery_choose_file")}
                      </Button>
                    )}
                    {!filename && (
                      <div className="space-y-2">
                        <Label htmlFor={`${id}-password`}>
                          {t(
                            selectedName?.endsWith(".wfrec")
                              ? "settings:cloud_backup_code"
                              : "settings:recovery_password",
                          )}
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
                        <details className="text-muted-foreground group text-xs leading-relaxed">
                          <summary className="inline-flex cursor-pointer list-none items-center gap-1 py-1 [&::-webkit-details-marker]:hidden">
                            <Icons.ChevronRight
                              className="size-3.5 transition-transform group-open:rotate-90"
                              aria-hidden
                            />
                            {t("settings:backup_password_help_title")}
                          </summary>
                          <p className="pt-1">
                            {t(
                              selectedName?.endsWith(".wfrec")
                                ? "settings:cloud_backup_save_code"
                                : "settings:recovery_password_help",
                            )}
                          </p>
                        </details>
                      </div>
                    )}
                  </>
                )}
                {encryption.isError && (
                  <BackupAlert error={t("settings:backup_encryption_status_failed")} />
                )}
                {error && <BackupAlert error={error} />}
              </motion.div>
            </div>
            <DialogFooter className="bg-background shrink-0 border-t px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-4 sm:pb-6">
              <Button
                type="button"
                variant="ghost"
                disabled={pending === "restore"}
                onClick={preview && !initialPreview ? back : close}
              >
                {preview && !initialPreview && <Icons.ArrowLeft aria-hidden />}
                {t(preview && !initialPreview ? "common:back" : "common:cancel")}
              </Button>
              <Button
                type="submit"
                disabled={
                  pending !== null ||
                  (preview ? !canRetry && (!encryption.data || consumed) : !filename && !selected)
                }
              >
                <PendingIcon
                  pending={pending !== null}
                  icon={canRetry ? <Icons.RotateCcw aria-hidden /> : undefined}
                />
                {t(
                  canRetry
                    ? pending === "inspect"
                      ? "settings:recovery_inspecting"
                      : "common:retry"
                    : preview
                      ? pending === "restore"
                        ? "settings:recovery_restoring"
                        : "settings:backup_restore_title"
                      : pending === "inspect"
                        ? "settings:recovery_inspecting"
                        : "settings:recovery_inspect",
                )}
                {!pending && !preview && <Icons.ArrowRight aria-hidden />}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
