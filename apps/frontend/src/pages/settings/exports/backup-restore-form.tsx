import { BackupError, type BackupFailure } from "./backup-error";
import { getDatabaseBackupDownloadUrl, isWeb, openDatabaseBackupFolder } from "@/adapters";
import { usePlatform } from "@/hooks/use-platform";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useDateFormatting } from "@wealthfolio/ui";
import { ActionConfirm } from "@wealthfolio/ui/components/common";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Badge } from "@wealthfolio/ui/components/ui/badge";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@wealthfolio/ui/components/ui/card";
import { useBackupRestore } from "./use-backup-restore";
import { BackupExportDialog } from "./backup-export-dialog";
import { BackupImportDialog } from "./backup-import-dialog";

export function BackupRestoreForm() {
  const { t } = useTranslation();
  const formatting = useDateFormatting();
  const { platform } = usePlatform();
  const [folderError, setFolderError] = useState<BackupFailure | null>(null);
  const { backups, create, remove } = useBackupRestore();
  const [exporting, setExporting] = useState<{ filename: string; displayName: string } | null>(
    null,
  );
  const [restoring, setRestoring] = useState<{ filename?: string; displayName?: string } | null>(
    null,
  );
  const busy = create.isPending || remove.isPending || exporting !== null || restoring !== null;
  return (
    <Card className="overflow-hidden shadow-none">
      <CardHeader className="gap-4 space-y-0 p-5 sm:p-6">
        <div className="space-y-1.5">
          <CardTitle className="text-lg leading-6">{t("settings:backup_title")}</CardTitle>
          <CardDescription className="leading-relaxed">
            {t("settings:backup_managed_description")}
          </CardDescription>
        </div>
        <div className="grid gap-2 md:flex md:flex-wrap">
          <Button
            className="h-auto min-h-11 whitespace-normal md:h-11 md:whitespace-nowrap"
            disabled={busy}
            onClick={() => create.mutate()}
          >
            {create.isPending ? (
              <Icons.Spinner className="mr-2 size-4 animate-spin" aria-hidden />
            ) : (
              <Icons.Plus className="mr-2 size-4" aria-hidden />
            )}
            {t(create.isPending ? "settings:backup_creating_short" : "settings:backup_now")}
          </Button>
          {!isWeb && (
            <Button
              variant="outline"
              className="h-auto min-h-11 whitespace-normal md:h-11 md:whitespace-nowrap"
              disabled={busy}
              onClick={() => setRestoring({})}
            >
              <Icons.History className="mr-2 size-4" aria-hidden />
              {t("settings:backup_restore_from_file")}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4 p-0">
        {folderError && (
          <div role="alert" className="text-destructive px-5 text-sm sm:px-6">
            <BackupError error={folderError} />
          </div>
        )}
        <div className="flex items-center justify-between gap-3 border-t px-5 pt-5 sm:px-6">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            {t("settings:backup_saved_heading")}
            {backups.isSuccess && (
              <span className="text-muted-foreground text-xs tabular-nums">
                {backups.data.length}
              </span>
            )}
          </h3>
          {!isWeb && platform?.is_desktop && (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground -mr-2 h-8 px-2 text-xs"
              disabled={busy}
              onClick={() => {
                setFolderError(null);
                void openDatabaseBackupFolder().catch((cause) => setFolderError({ cause }));
              }}
            >
              <Icons.FolderOpen className="mr-1.5 size-3.5" aria-hidden />
              {t("settings:backup_open_folder")}
            </Button>
          )}
        </div>
        {backups.isPending ? (
          <div
            role="status"
            className="text-muted-foreground flex items-center justify-center gap-2 py-12 text-sm"
          >
            <Icons.Spinner className="size-4 animate-spin" aria-hidden />
            {t("settings:backup_loading")}
          </div>
        ) : backups.isError ? (
          <div role="alert" className="space-y-3 px-5 py-8 text-center text-sm sm:px-6">
            <BackupError error={{ cause: backups.error }} />
            <Button variant="outline" onClick={() => void backups.refetch()}>
              {t("common:retry")}
            </Button>
          </div>
        ) : backups.data.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-5 py-10 text-center">
            <div className="bg-muted text-muted-foreground mb-2 rounded-full p-3">
              <Icons.DatabaseBackup className="size-6" aria-hidden />
            </div>
            <p className="text-sm font-medium">{t("settings:backup_empty_title")}</p>
            <p className="text-muted-foreground max-w-sm text-sm leading-relaxed">
              {t("settings:backup_empty_description")}
            </p>
          </div>
        ) : (
          <ul className="divide-y" aria-label={t("settings:backup_saved_heading")}>
            {backups.data.map((backup) => {
              const date = new Date(backup.modifiedAt);
              const hasDate = !Number.isNaN(date.getTime());
              const displayName = hasDate
                ? t("settings:backup_display_name", {
                    date: formatting.formatDateTime(date, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }),
                  })
                : backup.filename;
              const ProtectionIcon =
                backup.protection === "encrypted"
                  ? Icons.Lock
                  : backup.protection === "unavailable"
                    ? Icons.AlertCircle
                    : Icons.LockOpen;
              return (
                <li key={backup.filename} className="px-5 py-4 sm:px-6">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
                        <p className="text-sm font-medium">
                          {hasDate
                            ? formatting.formatDate(date, { dateStyle: "medium" })
                            : t("settings:backup_unknown_date")}
                        </p>
                        <Badge
                          variant="outline"
                          className="text-muted-foreground bg-muted/60 gap-1 border-0 px-2 py-0.5 font-normal"
                        >
                          <ProtectionIcon aria-hidden />
                          {t(`settings:backup_protection_${backup.protection}`)}
                        </Badge>
                      </div>
                      <p className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                        {hasDate && (
                          <>
                            <span>{formatting.formatTime(date, { timeStyle: "short" })}</span>
                            <span aria-hidden>·</span>
                          </>
                        )}
                        <span>{formatBackupSize(backup.sizeBytes)}</span>
                        <span aria-hidden>·</span>
                        <span>{t(`settings:backup_reason_${backup.reason}`)}</span>
                      </p>
                    </div>
                    <div
                      className={`grid w-full shrink-0 items-center gap-1.5 sm:flex sm:w-auto ${
                        isWeb
                          ? "grid-cols-[minmax(0,1fr)_2.75rem]"
                          : "grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2.75rem]"
                      }`}
                    >
                      {!isWeb && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-auto min-h-11 min-w-0 whitespace-normal py-2 sm:h-9 sm:min-h-0 sm:whitespace-nowrap sm:py-0"
                          disabled={busy || backup.protection === "unavailable"}
                          onClick={() => setRestoring({ filename: backup.filename, displayName })}
                          aria-label={t("settings:backup_restore_item", {
                            filename: displayName,
                          })}
                        >
                          {t("settings:backup_restore_action")}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-auto min-h-11 min-w-0 whitespace-normal py-2 sm:h-9 sm:min-h-0 sm:whitespace-nowrap sm:py-0"
                        disabled={busy || backup.protection === "unavailable"}
                        onClick={() => setExporting({ filename: backup.filename, displayName })}
                        aria-label={t("settings:backup_export_item", { filename: displayName })}
                      >
                        <Icons.Download className="mr-1.5 size-3.5" aria-hidden />
                        {t("common:export")}
                      </Button>
                      <ActionConfirm
                        confirmTitle={t("settings:backup_delete_title")}
                        confirmMessage={t("settings:backup_delete_snapshot", {
                          filename: displayName,
                        })}
                        handleConfirm={() => remove.mutate(backup.filename)}
                        confirmButtonText={t("common:delete")}
                        cancelButtonText={t("common:cancel")}
                        pendingText={t("settings:backup_deleting")}
                        isPending={remove.isPending}
                        button={
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-muted-foreground hover:text-destructive size-11 p-0 sm:size-8"
                            title={t("common:delete")}
                            disabled={busy}
                            aria-label={t("settings:backup_delete_item", {
                              filename: displayName,
                            })}
                          >
                            <Icons.Trash className="size-4" aria-hidden />
                          </Button>
                        }
                      />
                    </div>
                  </div>
                  {isWeb && (
                    <details className="mt-2 text-xs">
                      <summary className="text-muted-foreground cursor-pointer">
                        {t("settings:backup_original_advanced")}
                      </summary>
                      <p className="text-muted-foreground my-2 leading-relaxed">
                        {t("settings:backup_original_warning")}
                      </p>
                      <a
                        className="underline underline-offset-4"
                        href={getDatabaseBackupDownloadUrl(backup.filename)}
                        aria-disabled={busy}
                        onClick={(event) => {
                          if (busy) event.preventDefault();
                        }}
                      >
                        {t("settings:backup_original_save")}
                      </a>
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <div className="bg-muted/30 text-muted-foreground flex items-start gap-2.5 border-t px-5 py-4 sm:px-6">
          <Icons.Info className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p className="text-xs leading-relaxed">{t("settings:backup_portable_help")}</p>
        </div>
      </CardContent>
      {exporting && (
        <BackupExportDialog
          key={exporting.filename}
          filename={exporting.filename}
          displayName={exporting.displayName}
          onClose={() => setExporting(null)}
        />
      )}
      {!isWeb && restoring && (
        <BackupImportDialog
          filename={restoring.filename}
          displayName={restoring.displayName}
          onClose={() => setRestoring(null)}
        />
      )}
    </Card>
  );
}

function formatBackupSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}
