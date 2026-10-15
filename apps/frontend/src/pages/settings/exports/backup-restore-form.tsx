import type { BackupFailure } from "./backup-error";
import { DatabaseIcon } from "@phosphor-icons/react/dist/csr/Database";
import { getDatabaseBackupDownloadUrl, isWeb, openDatabaseBackupFolder } from "@/adapters";
import { usePlatform } from "@/hooks/use-platform";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useDateFormatting, buttonVariants } from "@wealthfolio/ui";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Card, CardContent, CardHeader } from "@wealthfolio/ui/components/ui/card";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@wealthfolio/ui/components/ui/dialog";
import { useBackupRestore } from "./use-backup-restore";
import { BackupExportDialog } from "./backup-export-dialog";
import { BackupImportDialog } from "./backup-import-dialog";
import {
  BackupAlert,
  BackupCardHeader,
  BackupDeleteDialog,
  BackupEmpty,
  BackupList,
  BackupRow,
  BackupActions,
  BackupRowsSkeleton,
  InfoPopover,
  InlineFacts,
  PendingIcon,
} from "./backup-ui";
import { formatBackupSize } from "./backup-size";

interface SelectedBackup {
  filename: string;
  displayName: string;
}

export function BackupRestoreForm() {
  const { t, i18n } = useTranslation();
  const formatting = useDateFormatting();
  const { platform } = usePlatform();
  const [folderError, setFolderError] = useState<BackupFailure | null>(null);
  const { backups, create, remove } = useBackupRestore();
  const [exporting, setExporting] = useState<SelectedBackup | null>(null);
  const [restoring, setRestoring] = useState<{ filename?: string; displayName?: string } | null>(
    null,
  );
  const [deleting, setDeleting] = useState<SelectedBackup | null>(null);
  const [original, setOriginal] = useState<SelectedBackup | null>(null);
  const busy = create.isPending || remove.isPending || exporting !== null || restoring !== null;
  const canOpenFolder = !isWeb && !!platform?.is_desktop;
  const latest = backups.data?.reduce<Date | null>((newest, backup) => {
    const date = new Date(backup.modifiedAt);
    return !Number.isNaN(date.getTime()) && (!newest || date > newest) ? date : newest;
  }, null);
  return (
    <Card className="overflow-hidden rounded-2xl shadow-none">
      <CardHeader className="space-y-4 p-5 sm:p-6">
        <BackupCardHeader
          icon={<DatabaseIcon weight="duotone" aria-hidden />}
          title={t("settings:backup_title")}
          info={
            <InfoPopover
              label={t("common:component.more_info_about", {
                label: t("settings:backup_title"),
              })}
            >
              <p className="text-foreground font-medium">
                {t(isWeb ? "settings:backup_local_web" : "settings:backup_managed_description")}
              </p>
              <p>{t("settings:backup_portable_help")}</p>
            </InfoPopover>
          }
          subtitle={
            backups.isPending ? (
              <Skeleton className="mt-1 h-4 w-64 max-w-full" />
            ) : latest ? (
              <InlineFacts
                items={[
                  {
                    label: t("settings:cloud_backup_last_label"),
                    value: formatting.formatDateTime(latest, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }),
                  },
                ]}
              />
            ) : (
              <p className="text-muted-foreground text-sm">
                {t(isWeb ? "settings:backup_local_web" : "settings:backup_managed_description")}
              </p>
            )
          }
          action={
            <Button
              size="sm"
              className="pointer-coarse:h-11 aria-busy:opacity-100"
              disabled={busy}
              aria-busy={create.isPending}
              onClick={() => create.mutate()}
            >
              <PendingIcon pending={create.isPending} icon={<Icons.Plus aria-hidden />} />
              {t(create.isPending ? "settings:backup_creating_short" : "settings:backup_now")}
            </Button>
          }
          menu={
            !isWeb && (
              <BackupActions
                title={t("settings:backup_title")}
                label={t("common:layout.more_options")}
                disabled={busy}
                groups={[
                  [
                    {
                      icon: Icons.History,
                      label: t("settings:backup_restore_from_file"),
                      onSelect: () => setRestoring({}),
                    },
                    ...(canOpenFolder
                      ? [
                          {
                            icon: Icons.FolderOpen,
                            label: t("settings:backup_open_folder"),
                            onSelect: () => {
                              setFolderError(null);
                              void openDatabaseBackupFolder().catch((cause) =>
                                setFolderError({ cause }),
                              );
                            },
                          },
                        ]
                      : []),
                  ],
                ]}
              />
            )
          }
        />
        {folderError && <BackupAlert error={folderError} />}
      </CardHeader>
      <CardContent className="space-y-3 border-t p-5 sm:p-6">
        {backups.isPending ? (
          <BackupRowsSkeleton />
        ) : backups.isError ? (
          <BackupAlert
            error={{ cause: backups.error }}
            action={
              <Button
                variant="outline"
                size="sm"
                className="text-foreground"
                onClick={() => void backups.refetch()}
              >
                {t("common:retry")}
              </Button>
            }
          />
        ) : backups.data.length === 0 ? (
          <BackupEmpty
            title={t("settings:backup_empty_title")}
            description={t("settings:backup_empty_description")}
          />
        ) : (
          <BackupList items={backups.data} label={t("settings:backup_saved_heading")}>
            {(backup) => {
              const date = new Date(backup.modifiedAt);
              const hasDate = !Number.isNaN(date.getTime());
              const dateTime = hasDate
                ? formatting.formatDateTime(date, { dateStyle: "medium", timeStyle: "short" })
                : null;
              const selected = {
                filename: backup.filename,
                displayName: dateTime
                  ? t("settings:backup_display_name", { date: dateTime })
                  : backup.filename,
              };
              const unavailable = backup.protection === "unavailable";
              const ProtectionIcon =
                backup.protection === "encrypted"
                  ? Icons.Lock
                  : unavailable
                    ? Icons.AlertCircle
                    : Icons.LockOpen;
              return (
                <BackupRow
                  key={backup.filename}
                  title={
                    hasDate
                      ? formatting.formatDate(date, { dateStyle: "medium" })
                      : t("settings:backup_unknown_date")
                  }
                  meta={[
                    hasDate && formatting.formatTime(date, { timeStyle: "short" }),
                    <>
                      <ProtectionIcon className="size-3" aria-hidden />
                      {t(`settings:backup_protection_${backup.protection}`)}
                    </>,
                  ]}
                  details={[
                    formatBackupSize(backup.sizeBytes, i18n.language),
                    t(`settings:backup_reason_${backup.reason}`),
                  ]}
                  actions={
                    <BackupActions
                      title={dateTime ?? backup.filename}
                      label={t("settings:cloud_backup_item_options", {
                        date: dateTime ?? backup.filename,
                      })}
                      disabled={busy}
                      primary={
                        isWeb
                          ? {
                              icon: Icons.Download,
                              label: t("common:export"),
                              ariaLabel: t("settings:backup_export_item", {
                                filename: selected.displayName,
                              }),
                              onSelect: () => setExporting(selected),
                              disabled: unavailable,
                              withIcon: true,
                            }
                          : {
                              icon: Icons.History,
                              label: t("settings:backup_restore_action"),
                              ariaLabel: t("settings:backup_restore_item", {
                                filename: selected.displayName,
                              }),
                              onSelect: () => setRestoring(selected),
                              disabled: unavailable,
                            }
                      }
                      groups={[
                        [
                          isWeb
                            ? {
                                icon: Icons.FileArchive,
                                label: t("settings:backup_original_advanced"),
                                onSelect: () => setOriginal(selected),
                              }
                            : {
                                icon: Icons.Download,
                                label: t("common:export"),
                                onSelect: () => setExporting(selected),
                                disabled: unavailable,
                              },
                        ],
                        [
                          {
                            icon: Icons.Trash2,
                            label: t("common:delete"),
                            onSelect: () => setDeleting(selected),
                            destructive: true,
                          },
                        ],
                      ]}
                    />
                  }
                />
              );
            }}
          </BackupList>
        )}
      </CardContent>
      <BackupDeleteDialog
        open={deleting !== null}
        title={t("settings:backup_delete_title")}
        description={t("settings:backup_delete_snapshot", {
          filename: deleting?.displayName ?? "",
        })}
        pending={remove.isPending}
        pendingLabel={t("settings:backup_deleting")}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.filename, { onSettled: () => setDeleting(null) });
        }}
      />
      {isWeb && (
        <Dialog
          open={original !== null}
          onOpenChange={(open) => {
            if (!open) setOriginal(null);
          }}
        >
          <DialogContent
            className="sm:max-w-md"
            mobileClassName="h-auto max-h-[85dvh] overflow-y-auto"
          >
            <DialogHeader className="text-left">
              <DialogTitle>{t("settings:backup_original_advanced")}</DialogTitle>
              <DialogDescription>{t("settings:backup_original_warning")}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setOriginal(null)}>
                {t("common:cancel")}
              </Button>
              {original && (
                <a
                  href={getDatabaseBackupDownloadUrl(original.filename)}
                  onClick={() => setOriginal(null)}
                  className={buttonVariants()}
                >
                  <Icons.Download aria-hidden />
                  {t("settings:backup_original_save")}
                </a>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
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
