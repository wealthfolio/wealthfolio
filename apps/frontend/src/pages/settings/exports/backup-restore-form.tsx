import { Button } from "@wealthfolio/ui/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@wealthfolio/ui/components/ui/card";
import { DeleteConfirm } from "@wealthfolio/ui/components/common";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@wealthfolio/ui/components/ui/tooltip";
import type { DatabaseBackup } from "@/adapters";
import { Trans, useTranslation } from "react-i18next";
import { useBackupRestore } from "./use-backup-restore";

type TFunction = ReturnType<typeof useTranslation>["t"];

export const BackupRestoreForm = () => {
  const {
    performBackup,
    performRestore,
    deleteWebBackup,
    getWebBackupDownloadUrl,
    isBackingUp,
    isRestoring,
    isDeletingWebBackup,
    isLoadingWebBackups,
    webBackupsError,
    canBackup,
    canRestore,
    webBackups,
    platformMode,
  } = useBackupRestore();

  return platformMode === "desktop" ? (
    <DesktopBackupPanel
      performBackup={performBackup}
      performRestore={performRestore}
      isBackingUp={isBackingUp}
      isRestoring={isRestoring}
    />
  ) : platformMode === "mobile" ? (
    <MobileBackupPanel
      performBackup={performBackup}
      performRestore={performRestore}
      isBackingUp={isBackingUp}
      isRestoring={isRestoring}
      canBackup={canBackup}
      canRestore={canRestore}
    />
  ) : (
    <WebBackupPanel
      performBackup={performBackup}
      isBackingUp={isBackingUp}
      backups={webBackups}
      isLoadingBackups={isLoadingWebBackups}
      isDeletingBackup={isDeletingWebBackup}
      backupListError={webBackupsError}
      onDeleteBackup={deleteWebBackup}
      getDownloadUrl={getWebBackupDownloadUrl}
    />
  );
};

interface DesktopPanelProps {
  performBackup: () => Promise<void>;
  performRestore: () => Promise<void>;
  isBackingUp: boolean;
  isRestoring: boolean;
}

const DesktopBackupPanel = ({
  performBackup,
  performRestore,
  isBackingUp,
  isRestoring,
}: DesktopPanelProps) => {
  const { t } = useTranslation();
  const desktopNotes = [
    t("settings:backup_desktop_note_1"),
    t("settings:backup_desktop_note_2"),
    t("settings:backup_desktop_note_3"),
    t("settings:backup_desktop_note_4"),
  ];
  return (
    <div className="space-y-6">
      <PanelIntro />

      <div className="grid gap-4 md:grid-cols-2">
        <BackupCard
          title={t("settings:backup_create_title")}
          description={t("settings:backup_desktop_create_description")}
          isLoading={isBackingUp}
          disabled={isBackingUp || isRestoring}
          actionLabel={t("settings:backup_create_button")}
          onAction={performBackup}
        />

        <Card className="flex h-full flex-col">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Icons.DatabaseBackup className="h-5 w-5" />
              {t("settings:backup_restore_title")}
            </CardTitle>
            <CardDescription>{t("settings:backup_restore_description")}</CardDescription>
          </CardHeader>
          <CardContent className="mt-auto">
            <Button
              onClick={performRestore}
              disabled={isRestoring || isBackingUp}
              variant="outline"
              className="w-full"
            >
              {isRestoring ? (
                <>
                  <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                  {t("settings:backup_restoring")}
                </>
              ) : (
                <>
                  <Icons.Import className="mr-2 h-4 w-4" />
                  {t("settings:backup_restore_button")}
                </>
              )}
            </Button>
          </CardContent>
        </Card>
      </div>

      <ImportantNotes notes={desktopNotes} />
    </div>
  );
};

interface WebPanelProps {
  performBackup: () => Promise<void>;
  isBackingUp: boolean;
  backups: DatabaseBackup[];
  isLoadingBackups: boolean;
  isDeletingBackup: boolean;
  backupListError: string | null;
  onDeleteBackup: (filename: string) => Promise<void>;
  getDownloadUrl: (filename: string) => string;
}

const formatBackupSize = (sizeBytes: number): string => {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"] as const;
  const exponent = Math.min(Math.floor(Math.log(sizeBytes) / Math.log(1024)), units.length - 1);
  const value = sizeBytes / 1024 ** exponent;
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
};

const formatBackupDate = (modifiedAt: string, t: TFunction): string => {
  const date = new Date(modifiedAt);
  if (Number.isNaN(date.getTime())) {
    return t("settings:backup_unknown_date");
  }

  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
};

const WebBackupPanel = ({
  performBackup,
  isBackingUp,
  backups,
  isLoadingBackups,
  isDeletingBackup,
  backupListError,
  onDeleteBackup,
  getDownloadUrl,
}: WebPanelProps) => {
  const { t } = useTranslation();
  const webNotes = [
    t("settings:backup_web_note_1"),
    t("settings:backup_web_note_2"),
    t("settings:backup_web_note_3"),
    t("settings:backup_web_note_4"),
  ];
  return (
    <div className="space-y-4">
      <PanelIntro />

      <Card>
        <CardHeader className="gap-4 space-y-0 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2 text-lg">
              <Icons.DatabaseBackup className="h-5 w-5" />
              {t("settings:backup_web_list_title")}
            </CardTitle>
            <CardDescription>{t("settings:backup_web_list_description")}</CardDescription>
          </div>
          <Button
            onClick={performBackup}
            disabled={isBackingUp}
            size="sm"
            className="w-full sm:w-auto"
          >
            {isBackingUp ? (
              <>
                <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                {t("settings:backup_creating_short")}
              </>
            ) : (
              <>
                <Icons.Download className="mr-2 h-4 w-4" />
                {t("settings:backup_create_title")}
              </>
            )}
          </Button>
        </CardHeader>
        <CardContent>
          {isLoadingBackups ? (
            <div className="text-muted-foreground flex items-center gap-2 rounded-md border border-dashed p-4 text-sm">
              <Icons.Spinner className="h-4 w-4 animate-spin" />
              {t("settings:backup_loading")}
            </div>
          ) : backupListError ? (
            <div className="border-destructive/30 bg-destructive/5 text-destructive flex items-start gap-2 rounded-md border p-4 text-sm">
              <Icons.AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-medium">{t("settings:backup_load_error")}</p>
                <p className="mt-1">{backupListError}</p>
              </div>
            </div>
          ) : backups.length === 0 ? (
            <div className="rounded-md border border-dashed p-6 text-center">
              <Icons.DatabaseBackup className="text-muted-foreground mx-auto h-6 w-6" />
              <p className="mt-3 text-sm font-medium">{t("settings:backup_empty_title")}</p>
              <p className="text-muted-foreground mt-1 text-sm">
                {t("settings:backup_empty_description")}
              </p>
            </div>
          ) : (
            <div className="divide-border divide-y rounded-md border">
              {backups.map((backup) => (
                <div
                  key={backup.filename}
                  className="grid gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium leading-5">{backup.filename}</p>
                    <p className="text-muted-foreground text-xs">
                      {formatBackupSize(backup.sizeBytes)} -{" "}
                      {formatBackupDate(backup.modifiedAt, t)}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button asChild size="icon" variant="ghost" className="h-8 w-8">
                          <a href={getDownloadUrl(backup.filename)} download={backup.filename}>
                            <Icons.Download className="h-4 w-4" />
                            <span className="sr-only">
                              {t("settings:backup_download_item", { filename: backup.filename })}
                            </span>
                          </a>
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t("common:download")}</TooltipContent>
                    </Tooltip>
                    <DeleteConfirm
                      deleteConfirmTitle={t("settings:backup_delete_title")}
                      deleteConfirmMessage={
                        <Trans
                          i18nKey="settings:backup_delete_message"
                          values={{ filename: backup.filename }}
                          components={{ fn: <span className="break-all font-medium" /> }}
                        />
                      }
                      handleDeleteConfirm={() => void onDeleteBackup(backup.filename)}
                      isPending={isDeletingBackup}
                      button={
                        <Button
                          size="icon"
                          variant="ghost"
                          disabled={isDeletingBackup}
                          className="text-muted-foreground hover:text-destructive h-8 w-8"
                        >
                          <Icons.Trash className="h-4 w-4" />
                          <span className="sr-only">
                            {t("settings:backup_delete_item", { filename: backup.filename })}
                          </span>
                        </Button>
                      }
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <ImportantNotes notes={webNotes} />
    </div>
  );
};

interface MobilePanelProps {
  performBackup: () => Promise<void>;
  performRestore: () => Promise<void>;
  isBackingUp: boolean;
  isRestoring: boolean;
  canBackup: boolean;
  canRestore: boolean;
}

const MobileBackupPanel = ({
  performBackup,
  performRestore,
  isBackingUp,
  isRestoring,
  canBackup,
  canRestore,
}: MobilePanelProps) => {
  const { t } = useTranslation();
  const mobileNotes = [
    t("settings:backup_mobile_note_1"),
    t("settings:backup_mobile_note_2"),
    t("settings:backup_mobile_note_3"),
    t("settings:backup_mobile_note_4"),
  ];
  return (
    <div className="space-y-6">
      <PanelIntro />

      <div className="grid gap-4 md:grid-cols-2">
        <BackupCard
          title={t("settings:backup_create_title")}
          description={
            canBackup
              ? t("settings:backup_mobile_create_description")
              : t("settings:backup_mobile_create_unavailable")
          }
          isLoading={isBackingUp}
          disabled={!canBackup || isBackingUp}
          actionLabel={t("settings:backup_create_button")}
          onAction={performBackup}
        />

        <Card className="flex h-full flex-col">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Icons.DatabaseBackup className="h-5 w-5" />
              {t("settings:backup_restore_title")}
            </CardTitle>
            <CardDescription>
              {canRestore
                ? t("settings:backup_restore_description")
                : t("settings:backup_mobile_restore_unavailable")}
            </CardDescription>
          </CardHeader>
          <CardContent className="mt-auto">
            <Button
              onClick={performRestore}
              disabled={!canRestore || isRestoring || isBackingUp}
              variant="outline"
              className="w-full"
            >
              {isRestoring ? (
                <>
                  <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                  {t("settings:backup_restoring")}
                </>
              ) : (
                <>
                  <Icons.Import className="mr-2 h-4 w-4" />
                  {t("settings:backup_restore_button")}
                </>
              )}
            </Button>
          </CardContent>
        </Card>
      </div>

      <ImportantNotes notes={mobileNotes} />
    </div>
  );
};

const PanelIntro = () => {
  const { t } = useTranslation();
  return (
    <div>
      <h3 className="text-lg font-semibold">{t("settings:backup_title")}</h3>
      <p className="text-muted-foreground text-sm">{t("settings:backup_description")}</p>
    </div>
  );
};

interface BackupCardProps {
  title: string;
  description: string;
  onAction: () => Promise<void>;
  isLoading: boolean;
  actionLabel: string;
  disabled?: boolean;
}

const BackupCard = ({
  title,
  description,
  onAction,
  isLoading,
  actionLabel,
  disabled,
}: BackupCardProps) => {
  const { t } = useTranslation();
  return (
    <Card className="flex h-full flex-col">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Icons.DatabaseZap className="h-5 w-5" />
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="mt-auto">
        <Button onClick={onAction} disabled={disabled ?? isLoading} className="w-full">
          {isLoading ? (
            <>
              <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
              {t("settings:backup_creating")}
            </>
          ) : (
            <>
              <Icons.Download className="mr-2 h-4 w-4" />
              {actionLabel}
            </>
          )}
        </Button>
      </CardContent>
    </Card>
  );
};

const ImportantNotes = ({ notes }: { notes: readonly string[] }) => {
  const { t } = useTranslation();
  return (
    <div className="bg-muted/30 rounded-md border p-4">
      <div className="flex items-start gap-3">
        <Icons.Info className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0 text-sm">
          <p className="font-medium">{t("settings:backup_notes_heading")}</p>
          <ul className="text-muted-foreground mt-2 list-inside list-disc space-y-1">
            {notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
};
