import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useDateFormatting } from "@wealthfolio/ui";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Badge } from "@wealthfolio/ui/components/ui/badge";
import { Card, CardContent, CardHeader } from "@wealthfolio/ui/components/ui/card";
import { Checkbox } from "@wealthfolio/ui/components/ui/checkbox";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { PasswordInput } from "@wealthfolio/ui/components/ui/password-input";
import { Label } from "@wealthfolio/ui/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@wealthfolio/ui/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@wealthfolio/ui/components/ui/dropdown-menu";
import {
  captureCloudBackup,
  cloudBackupAction,
  downloadCloudBackup,
  previewCloudBackupRestore,
  isDesktop,
  type CloudBackupOperation,
  type CloudBackupStatus,
  type BackupImportPreview,
} from "@/adapters";
import { BackupImportDialog } from "./backup-import-dialog";
import { usePlatform } from "@/hooks/use-platform";
import { backupDate, backupState, useCloudBackups } from "./use-cloud-backups";

type Flow = "setup" | "resume" | "unlock" | "replace" | "pause" | "help";

function ProtectionStatus({ data }: { data: CloudBackupStatus }) {
  const { t } = useTranslation();
  const state = backupState(data);
  return (
    <Badge
      variant="outline"
      className={`shrink-0 gap-1.5 border-0 px-2 py-0.5 text-[11px] font-medium ${state === "on" ? "bg-success/10 text-success" : "bg-muted/60 text-muted-foreground"}`}
    >
      <span
        aria-hidden
        className={`size-1.5 rounded-full ${state === "on" ? "bg-success" : "bg-current"}`}
      />
      {t(`settings:cloud_backup_state_${state}`)}
    </Badge>
  );
}

function BackupOverview({ data, profileName }: { data: CloudBackupStatus; profileName?: string }) {
  const { t } = useTranslation();
  const { isMobile } = usePlatform();
  const formatting = useDateFormatting();
  const last = backupDate(data.policy.lastBackupAt);
  const due = backupDate(
    data.capture?.state === "failed" ? (data.capture.retryAt ?? null) : data.policy.nextDueAt,
  );
  const state = backupState(data);
  return (
    <>
      <p className="text-muted-foreground text-sm leading-relaxed">
        {t(
          state === "on" && !isDesktop
            ? "settings:cloud_backup_hint_on_web"
            : state === "on" && isMobile
              ? "settings:cloud_backup_hint_on_mobile"
              : `settings:cloud_backup_hint_${state}`,
        )}
      </p>
      <dl className="grid grid-cols-2 gap-5 border-t pt-4">
        <div className="space-y-1">
          <dt className="text-muted-foreground text-xs">{t("settings:cloud_backup_last_label")}</dt>
          <dd className="text-sm font-medium leading-5">
            {last
              ? formatting.formatDateTime(last, { dateStyle: "medium", timeStyle: "short" })
              : t("settings:cloud_backup_none")}
          </dd>
        </div>
        <div className="space-y-1">
          <dt className="text-muted-foreground text-xs">
            {t(
              data.capture?.state === "failed"
                ? "settings:cloud_backup_retry_label"
                : "settings:cloud_backup_next_label",
            )}
          </dt>
          <dd className="text-sm font-medium leading-5">
            {data.policy.uploadEntitled &&
            data.policy.enabled &&
            !(data.isSource && data.sourceConsented === false) &&
            due &&
            state !== "running"
              ? formatting.formatDateTime(due, { dateStyle: "medium", timeStyle: "short" })
              : !data.policy.enabled ||
                  !data.policy.uploadEntitled ||
                  data.sourceConsented === false
                ? t("settings:cloud_backup_not_scheduled")
                : t(`settings:cloud_backup_state_${state}`)}
          </dd>
        </div>
      </dl>
      {data.policy.enabled && data.isSource && data.sourceConsented !== false && (
        <p className="text-muted-foreground flex items-center gap-2 text-xs">
          <Icons.Laptop className="size-3.5 shrink-0" aria-hidden />
          {t("settings:cloud_backup_source", {
            name: profileName ?? t("settings:cloud_backup_this_profile"),
          })}
        </p>
      )}
    </>
  );
}

function CloudBackupPromotion() {
  const { t } = useTranslation();
  return (
    <Card className="@container border-connect-brand/15 from-connect-brand/5 via-card to-card overflow-hidden rounded-xl bg-gradient-to-br shadow-none">
      <CardContent className="@min-[640px]:grid-cols-[auto_minmax(0,1fr)_auto] @min-[640px]:gap-x-4 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1 px-4 py-3">
        <div className="bg-connect-brand/10 text-connect-brand row-start-1 flex size-8 shrink-0 items-center justify-center rounded-lg">
          <Icons.ShieldCheck className="size-4" aria-hidden />
        </div>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold leading-5">
            {t("settings:cloud_backup_promotion_title")}
          </h2>
          <p className="text-muted-foreground mt-1 text-xs leading-5">
            {t("settings:cloud_backup_promotion_description")}
          </p>
        </div>
        <Link
          to="/settings/connect"
          className="text-connect-brand hover:text-foreground focus-visible:ring-ring @min-[640px]:col-start-3 @min-[640px]:row-start-1 col-start-2 inline-flex min-h-11 w-fit items-center gap-1.5 rounded-md text-xs font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
        >
          {t("settings:cloud_backup_promotion_action")}
          <Icons.ArrowRight className="size-3.5 shrink-0" aria-hidden />
        </Link>
      </CardContent>
    </Card>
  );
}

/** Read-only Connect overview; the backup settings own consent and recovery. */
export function CloudBackupSummary() {
  const { t } = useTranslation();
  const formatting = useDateFormatting();
  const { available, profile, status } = useCloudBackups();
  if (!available) return null;
  if (status.data && !status.data.policy.uploadEntitled && !status.data.history.length)
    return <CloudBackupPromotion />;
  return (
    <Card className="overflow-hidden rounded-2xl shadow-none">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0 p-5 pb-3 sm:p-6 sm:pb-3">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <Icons.ShieldCheck className="text-muted-foreground size-5" aria-hidden />
          {t("settings:cloud_backup_title")}
        </h2>
        {status.data && <ProtectionStatus data={status.data} />}
      </CardHeader>
      <CardContent className="space-y-4 p-5 pt-0 sm:p-6 sm:pt-0">
        {status.isPending ? (
          <p role="status" className="text-muted-foreground text-sm">
            {t("common:loading")}
          </p>
        ) : status.isError ? (
          <p className="text-muted-foreground text-sm">{t("settings:cloud_backup_failed")}</p>
        ) : (
          status.data && (
            <>
              <BackupOverview data={status.data} profileName={profile?.name} />
              {status.data.history.length > 0 && (
                <details className="group text-xs">
                  <summary className="text-muted-foreground flex cursor-pointer list-none items-center gap-2">
                    <Icons.ChevronRight
                      className="size-4 transition-transform group-open:rotate-90"
                      aria-hidden
                    />
                    {t("settings:cloud_backup_saved_count", { count: status.data.history.length })}
                  </summary>
                  <ul
                    className="mt-3 divide-y pl-6"
                    aria-label={t("settings:cloud_backup_history")}
                  >
                    {[...status.data.history]
                      .sort(
                        (a, b) =>
                          (backupDate(b.publishedAt)?.getTime() ?? 0) -
                          (backupDate(a.publishedAt)?.getTime() ?? 0),
                      )
                      .slice(0, 3)
                      .map((point) => {
                        const date = backupDate(point.publishedAt);
                        return (
                          <li
                            key={point.backupId}
                            className="text-muted-foreground flex items-center gap-2 py-2 text-xs"
                          >
                            <Icons.CheckCircle className="size-3.5 shrink-0" aria-hidden />
                            {date
                              ? formatting.formatDateTime(date, {
                                  dateStyle: "medium",
                                  timeStyle: "short",
                                })
                              : t("settings:backup_unknown_date")}
                          </li>
                        );
                      })}
                  </ul>
                </details>
              )}
            </>
          )
        )}
        <Button variant="outline" className="min-h-11 w-full sm:w-auto" asChild>
          <Link to="/settings/exports">
            {t("settings:cloud_backup_manage")}
            <Icons.ArrowRight className="ml-2 size-4" aria-hidden />
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}

export function CloudBackupCard() {
  const backup = useCloudBackups();
  if (!backup.available) return backup.promotionAvailable ? <CloudBackupPromotion /> : null;
  const needsSubscription = backup.status.data && !backup.status.data.policy.uploadEntitled;
  if (needsSubscription && !backup.status.data?.history.length) return <CloudBackupPromotion />;
  return (
    <div className="space-y-6">
      {needsSubscription && <CloudBackupPromotion />}
      <CloudBackupPanel key={backup.identity} backup={backup} />
    </div>
  );
}

function CloudBackupPanel({ backup }: { backup: ReturnType<typeof useCloudBackups> }) {
  const { t, i18n } = useTranslation();
  const formatting = useDateFormatting();
  const { status, profile, isMobile } = backup;
  const canRestore = isDesktop && !isMobile;
  const active = useRef(true);
  const [flow, setFlow] = useState<Flow>();
  const [resumeAfterReplace, setResumeAfterReplace] = useState(false);
  const [code, setCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [copied, setCopied] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reauth, setReauth] = useState(false);
  const [accessRunning, setAccessRunning] = useState(false);
  const [accessResult, setAccessResult] = useState<"unavailable" | "notLinked" | "error">();
  const [preview, setPreview] = useState<BackupImportPreview>();
  const [deleteId, setDeleteId] = useState<string | null | undefined>();
  const data = status.data;
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  function showFlow(value: Flow) {
    setResumeAfterReplace(value === "replace" && flow === "resume");
    setError("");
    setReauth(false);
    setConfirmed(false);
    setCode("");
    setCopied(false);
    setFlow(value);
  }
  function closeFlow() {
    if (busy) return;
    setFlow(undefined);
    setCode("");
    setRecoveryCode("");
    setConfirmed(false);
    setError("");
    setReauth(false);
  }
  function showDelete(backupId: string | null) {
    setError("");
    setReauth(false);
    setDeleteId(backupId);
  }
  function failed(cause: unknown) {
    if (!active.current) return;
    const recentLogin = String(cause).includes("BACKUP_REAUTHENTICATION_REQUIRED");
    setReauth(recentLogin);
    setError(t(recentLogin ? "settings:cloud_backup_reauth" : "settings:cloud_backup_failed"));
  }
  async function run(operation: CloudBackupOperation) {
    setBusy(true);
    setError("");
    setReauth(false);
    try {
      const result = await cloudBackupAction<{ recoveryCode?: string }>(operation);
      if (!active.current) return;
      if (result.recoveryCode) {
        setRecoveryCode(result.recoveryCode);
        setConfirmed(false);
        setCopied(false);
      }
      if (operation.action === "recover") {
        setCode("");
        setFlow(data?.policy.uploadEntitled ? "resume" : undefined);
      }
      if (operation.action === "enable") {
        setRecoveryCode("");
        setFlow(undefined);
        // Source consent is committed before capture. A failed first upload stays retryable.
        await captureCloudBackup();
      }
      if (operation.action === "delete") setDeleteId(undefined);
      if (operation.action === "disable") setFlow(undefined);
    } catch (cause) {
      failed(cause);
    } finally {
      if (active.current) {
        await status.refetch();
        if (active.current) setBusy(false);
      }
    }
  }
  async function connectAccess() {
    setAccessRunning(true);
    setAccessResult(undefined);
    try {
      const result = await cloudBackupAction<"ready" | "unavailable" | "notLinked">({
        action: "access",
      });
      if (!active.current) return;
      if (result !== "ready") setAccessResult(result);
      await status.refetch();
    } catch (cause) {
      if (active.current)
        setAccessResult(
          /DEVICE_NOT_TRUSTED|DEVICE_REVOKED|DEVICE_NOT_FOUND|DEVICE_MISMATCH|PAIRING_REQUIRED|KEY_VERSION|MEMBERSHIP_CHANGED/.test(
            String(cause),
          )
            ? "notLinked"
            : "error",
        );
    } finally {
      if (active.current) setAccessRunning(false);
    }
  }
  async function perform(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (cause) {
      failed(cause);
    } finally {
      if (active.current) {
        await status.refetch();
        if (active.current) setBusy(false);
      }
    }
  }
  const history = [...(data?.history ?? [])].sort(
    (a, b) =>
      (backupDate(b.publishedAt)?.getTime() ?? 0) - (backupDate(a.publishedAt)?.getTime() ?? 0),
  );
  const errorNotice = error && (
    <div
      role="alert"
      className="border-destructive/20 bg-destructive/5 text-destructive rounded-lg border p-3 text-sm"
    >
      {error}
      {reauth && (
        <Link
          to="/settings/connect"
          className="mt-2 block font-medium underline underline-offset-4"
        >
          {t("settings:cloud_backup_sign_in")}
        </Link>
      )}
    </div>
  );
  return (
    <Card
      className="overflow-hidden rounded-2xl shadow-none"
      aria-label={t("settings:cloud_backup_title")}
    >
      <CardHeader className="space-y-5 p-5 sm:p-6">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="bg-connect-brand/10 text-connect-brand flex size-10 shrink-0 items-center justify-center rounded-xl">
              <Icons.ShieldCheck className="size-5" aria-hidden />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <h2 className="text-base font-semibold tracking-tight">
                  {t("settings:cloud_backup_title")}
                </h2>
                {data && <ProtectionStatus data={data} />}
              </div>
              <p className="text-muted-foreground mt-1 flex items-center gap-1.5 text-xs">
                <Icons.Lock className="size-3" aria-hidden />
                {t("settings:cloud_backup_private")}
              </p>
            </div>
          </div>
          {data?.hasKey && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-11 shrink-0"
                  aria-label={t("settings:cloud_backup_options")}
                  disabled={busy}
                >
                  <Icons.MoreHorizontal className="size-5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {data.keyReady && (
                  <DropdownMenuItem onSelect={() => showFlow("replace")}>
                    {t("settings:cloud_backup_reissue")}
                  </DropdownMenuItem>
                )}
                {data.policy.enabled && (
                  <DropdownMenuItem onSelect={() => showFlow("pause")}>
                    {t("settings:cloud_backup_disable")}
                  </DropdownMenuItem>
                )}
                {history.length > 0 && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onSelect={() => showDelete(null)}
                    >
                      {t("settings:cloud_backup_delete_all")}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        {!data?.hasKey && (
          <p className="text-muted-foreground text-sm leading-relaxed">
            {t("settings:cloud_backup_scope")}
          </p>
        )}
        {status.isPending ? (
          <div role="status" className="text-muted-foreground flex items-center gap-2 py-3 text-sm">
            <Icons.Spinner className="size-4 animate-spin" aria-hidden />
            {t("common:loading")}
          </div>
        ) : status.isError ? (
          <div className="bg-muted/40 space-y-3 rounded-xl p-4">
            <p className="text-sm">
              {t(
                String(status.error).includes("BACKUPS_UNAVAILABLE") ||
                  String(status.error).includes("404")
                  ? "settings:cloud_backup_unavailable"
                  : "settings:cloud_backup_failed",
              )}
            </p>
            <Button size="sm" variant="outline" onClick={() => void status.refetch()}>
              {t("common:retry")}
            </Button>
          </div>
        ) : (
          data && (
            <>
              {data.hasKey ? (
                <BackupOverview data={data} profileName={profile?.name} />
              ) : (
                <p className="text-muted-foreground text-sm">
                  {t("settings:cloud_backup_hint_new")}
                </p>
              )}
              {data.hasKey && !data.keyReady && (
                <div className="space-y-2">
                  <p role="status" className="text-muted-foreground text-sm">
                    {t(
                      accessRunning
                        ? "settings:cloud_backup_access_running"
                        : accessResult === "unavailable"
                          ? "settings:cloud_backup_access_missing"
                          : accessResult === "notLinked"
                            ? "settings:cloud_backup_access_link"
                            : accessResult === "error"
                              ? "settings:cloud_backup_access_failed"
                              : "settings:cloud_backup_access_hint",
                    )}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || accessRunning}
                    onClick={() => void connectAccess()}
                  >
                    {t(accessResult ? "common:retry" : "settings:cloud_backup_access_check")}
                  </Button>
                </div>
              )}
              {((data.policy.uploadEntitled &&
                (!data.policy.enabled || !data.isSource || data.sourceConsented === false)) ||
                (data.hasKey && !data.keyReady)) && (
                <Button
                  className="min-h-11 w-fit rounded-lg"
                  disabled={busy}
                  onClick={() =>
                    showFlow(!data.hasKey ? "setup" : !data.keyReady ? "unlock" : "resume")
                  }
                >
                  {t(
                    !data.hasKey
                      ? "settings:cloud_backup_setup"
                      : !data.keyReady
                        ? "settings:cloud_backup_unlock"
                        : "settings:cloud_backup_resume",
                  )}
                </Button>
              )}
              {data.policy.uploadEntitled &&
                data.policy.enabled &&
                data.isSource &&
                data.sourceConsented !== false &&
                data.keyReady &&
                (!data.policy.lastBackupAt || backupState(data) === "failed") && (
                  <Button
                    className="min-h-11 w-fit rounded-lg"
                    variant="outline"
                    disabled={busy || backupState(data) === "running"}
                    onClick={() => void perform(() => captureCloudBackup())}
                  >
                    {busy && <Icons.Spinner className="mr-2 size-4 animate-spin" aria-hidden />}
                    {t(
                      backupState(data) === "failed"
                        ? "settings:cloud_backup_retry_now"
                        : "settings:cloud_backup_retry",
                    )}
                  </Button>
                )}
              {!data.policy.uploadEntitled && (
                <p className="text-muted-foreground text-sm">{t("settings:cloud_backup_paid")}</p>
              )}
              {busy && (
                <p role="status" className="text-muted-foreground flex items-center gap-2 text-sm">
                  <Icons.Spinner className="size-4 animate-spin" aria-hidden />
                  {t("settings:cloud_backup_working")}
                </p>
              )}
            </>
          )
        )}
        {!flow && deleteId === undefined && errorNotice}
      </CardHeader>
      {data && (
        <CardContent className="bg-background/25 space-y-4 border-t p-5 sm:p-6">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold">{t("settings:cloud_backup_history")}</h3>
            <span className="text-muted-foreground text-xs tabular-nums">
              {t("settings:cloud_backup_saved_count", { count: history.length })}
            </span>
          </div>
          {history.length === 0 ? (
            <div className="flex items-start gap-3 rounded-xl border border-dashed p-4">
              <Icons.History className="text-muted-foreground mt-0.5 size-5 shrink-0" aria-hidden />
              <div>
                <p className="text-sm font-medium leading-5">{t("settings:cloud_backup_none")}</p>
                <p className="text-muted-foreground mt-1 text-sm">
                  {t("settings:cloud_backup_empty")}
                </p>
              </div>
            </div>
          ) : (
            <ul className="divide-y" aria-label={t("settings:cloud_backup_history")}>
              {history.map((point, index) => {
                const date = backupDate(point.publishedAt);
                return (
                  <li
                    key={point.backupId}
                    className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-2 py-3 first:pt-0 last:pb-0 min-[360px]:flex sm:gap-3"
                  >
                    <div className="text-muted-foreground hidden size-9 shrink-0 items-center justify-center rounded-lg border sm:flex">
                      <Icons.DatabaseBackup className="size-4" aria-hidden />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium leading-5">
                          {date
                            ? formatting.formatDate(date, { dateStyle: "medium" })
                            : t("settings:backup_unknown_date")}
                        </p>
                        {index === 0 && (
                          <Badge variant="secondary" className="font-normal">
                            {t("settings:cloud_backup_latest")}
                          </Badge>
                        )}
                      </div>
                      <p className="text-muted-foreground mt-1 text-xs">
                        {date && <>{formatting.formatTime(date, { timeStyle: "short" })} · </>}
                        {new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }).format(
                          point.sizeBytes / 1048576,
                        )}{" "}
                        MB · {t("settings:backup_protection_encrypted")}
                        {point.metadata?.device_name && <> · {point.metadata.device_name}</>}
                        {point.metadata?.profile_name && <> · {point.metadata.profile_name}</>}
                      </p>
                    </div>
                    {canRestore && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="col-span-2 row-start-2 min-h-11 w-fit shrink-0 justify-self-start rounded-lg min-[360px]:w-auto"
                        disabled={busy || !data.keyReady}
                        onClick={() =>
                          void perform(async () => {
                            const next = await previewCloudBackupRestore(point.backupId);
                            if (active.current) setPreview(next);
                          })
                        }
                      >
                        {t("settings:cloud_backup_restore")}
                      </Button>
                    )}
                    {!canRestore && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="col-span-2 row-start-2 min-h-11 w-fit shrink-0 justify-self-start rounded-lg min-[360px]:w-auto"
                        disabled={busy}
                        onClick={() => void perform(() => downloadCloudBackup(point.backupId))}
                      >
                        <Icons.Download className="mr-1.5 size-4" aria-hidden />
                        {t("settings:cloud_backup_download")}
                      </Button>
                    )}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="col-start-2 row-start-1 min-h-11 shrink-0"
                          disabled={busy}
                          aria-label={t("settings:cloud_backup_item_options", {
                            date: date
                              ? formatting.formatDateTime(date)
                              : t("settings:backup_unknown_date"),
                          })}
                        >
                          <Icons.MoreHorizontal className="size-4" aria-hidden />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {canRestore && (
                          <DropdownMenuItem
                            onSelect={() => void perform(() => downloadCloudBackup(point.backupId))}
                          >
                            <Icons.Download className="mr-2 size-4" />
                            {t("settings:cloud_backup_download")}
                          </DropdownMenuItem>
                        )}
                        {canRestore && <DropdownMenuSeparator />}
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onSelect={() => showDelete(point.backupId)}
                        >
                          {t("settings:cloud_backup_delete")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </li>
                );
              })}
            </ul>
          )}
          {!isDesktop && history.length > 0 && (
            <Button
              variant="link"
              className="text-muted-foreground h-auto whitespace-normal p-0 text-left text-xs font-normal"
              onClick={() => showFlow("help")}
            >
              {t("settings:cloud_backup_restore_help")}
              <Icons.ArrowRight className="ml-1.5 size-3.5 shrink-0" aria-hidden />
            </Button>
          )}
          {isMobile && history.length > 0 && (
            <p className="text-muted-foreground text-xs">
              {t("settings:cloud_backup_mobile_restore")}
            </p>
          )}
          <details className="group text-xs">
            <summary className="text-muted-foreground flex cursor-pointer list-none items-center gap-2">
              <Icons.ChevronRight
                className="size-4 transition-transform group-open:rotate-90"
                aria-hidden
              />
              {t("settings:cloud_backup_details")}
            </summary>
            <div className="text-muted-foreground mt-3 space-y-3 pl-6 text-sm leading-relaxed">
              <p>{t("settings:cloud_backup_scope")}</p>
              <p>
                {t(
                  isMobile
                    ? "settings:cloud_backup_schedule_mobile"
                    : "settings:cloud_backup_schedule",
                )}
              </p>
              <p>{t("settings:cloud_backup_exclusions")}</p>
            </div>
          </details>
        </CardContent>
      )}
      <Dialog
        open={flow !== undefined}
        onOpenChange={(open) => {
          if (!open && !(recoveryCode && !confirmed)) closeFlow();
        }}
      >
        <DialogContent
          className="gap-5 rounded-2xl p-6 sm:max-w-[440px]"
          mobileClassName="h-auto max-h-[85dvh] overflow-y-auto"
          showCloseButton={!busy && !recoveryCode}
        >
          <DialogHeader className="gap-3 pr-6 text-left">
            <div className="bg-connect-brand/10 text-connect-brand mb-1 flex size-10 items-center justify-center rounded-xl">
              <Icons.ShieldCheck className="size-5" aria-hidden />
            </div>
            <DialogTitle className="text-xl font-semibold leading-6 tracking-tight">
              {t(
                flow === "help"
                  ? "settings:cloud_backup_restore_help"
                  : flow === "pause"
                    ? "settings:cloud_backup_disable"
                    : recoveryCode
                      ? "settings:cloud_backup_save_title"
                      : flow === "replace"
                        ? "settings:cloud_backup_reissue"
                        : flow === "unlock"
                          ? "settings:cloud_backup_unlock"
                          : flow === "resume"
                            ? "settings:cloud_backup_resume"
                            : "settings:cloud_backup_setup",
              )}
            </DialogTitle>
            <DialogDescription>
              {t(
                flow === "help"
                  ? "settings:cloud_backup_offline"
                  : flow === "pause"
                    ? "settings:cloud_backup_pause_description"
                    : recoveryCode
                      ? "settings:cloud_backup_save_code"
                      : flow === "replace"
                        ? "settings:cloud_backup_replace_description"
                        : flow === "unlock"
                          ? "settings:cloud_backup_unlock_description"
                          : flow === "resume"
                            ? data?.policy.enabled && !data.isSource
                              ? "settings:cloud_backup_move_description"
                              : isMobile
                                ? "settings:cloud_backup_resume_description_mobile"
                                : isDesktop
                                  ? "settings:cloud_backup_resume_description"
                                  : "settings:cloud_backup_resume_description_web"
                            : "settings:cloud_backup_setup_description",
                { name: profile?.name ?? t("settings:cloud_backup_this_profile") },
              )}
            </DialogDescription>
          </DialogHeader>
          {flow === "help" ? (
            <div className="bg-muted/40 space-y-4 rounded-xl p-4">
              <p className="text-sm">{t("settings:cloud_backup_restore_help_steps")}</p>
              <code className="bg-background block break-all rounded-md border p-3 text-xs [font-family:inherit]">
                wealthfolio-server db restore backup.wfrec --profile {profile?.id ?? "PROFILE_ID"}{" "}
                --recovery-code-stdin
              </code>
            </div>
          ) : flow === "pause" ? null : recoveryCode ? (
            <div className="space-y-4">
              <div className="bg-muted/40 rounded-xl border p-4">
                <Label className="text-muted-foreground text-xs">
                  {t("settings:cloud_backup_code")}
                </Label>
                <pre className="mt-3 select-all whitespace-pre-wrap break-all text-sm leading-6 [font-family:inherit]">
                  {recoveryCode}
                </pre>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-4 min-h-11"
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(recoveryCode)
                      .then(() => {
                        if (active.current) setCopied(true);
                      })
                      .catch(() => {
                        if (active.current) setError(t("settings:cloud_backup_copy_failed"));
                      });
                  }}
                >
                  {copied ? (
                    <Icons.Check className="mr-2 size-4" />
                  ) : (
                    <Icons.Copy className="mr-2 size-4" />
                  )}
                  {t(copied ? "common:profiles.copied" : "common:profiles.copyCode")}
                </Button>
              </div>
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm">
                <Checkbox
                  checked={confirmed}
                  onCheckedChange={(value) => setConfirmed(value === true)}
                  className="mt-0.5"
                />
                {t("settings:cloud_backup_confirm")}
              </label>
            </div>
          ) : flow === "unlock" ? (
            <div className="space-y-2">
              <Label htmlFor="cloud-recovery-code">{t("settings:cloud_backup_code")}</Label>
              <PasswordInput
                id="cloud-recovery-code"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                showLabel={t("settings:backup_export_show")}
                hideLabel={t("settings:backup_export_hide")}
              />
            </div>
          ) : flow === "resume" ? (
            <div className="space-y-4">
              <label className="bg-muted/30 hover:bg-muted/50 flex cursor-pointer items-start gap-3 rounded-xl border p-4 text-sm leading-5 transition-colors">
                <Checkbox
                  checked={confirmed}
                  onCheckedChange={(value) => setConfirmed(value === true)}
                  className="mt-0.5"
                />
                {t("settings:cloud_backup_confirm")}
              </label>
              <Button
                variant="link"
                className="text-muted-foreground h-auto p-0 text-xs font-normal"
                disabled={busy}
                onClick={() => showFlow("replace")}
              >
                {t("settings:cloud_backup_need_code")}
              </Button>
            </div>
          ) : flow === "setup" ? (
            <div className="space-y-4">
              <div className="bg-muted/40 flex items-center gap-3 rounded-xl p-4">
                <Icons.Laptop className="text-muted-foreground size-5 shrink-0" aria-hidden />
                <div>
                  <p className="text-sm font-medium leading-5">
                    {profile?.name ?? t("settings:cloud_backup_this_profile")}
                  </p>
                  <p className="text-muted-foreground mt-1 text-xs">
                    {t(
                      isDesktop
                        ? "settings:cloud_backup_setup_device"
                        : "settings:cloud_backup_setup_device_web",
                    )}
                  </p>
                </div>
              </div>
              <p className="text-muted-foreground text-sm">
                {t("settings:cloud_backup_exclusions")}
              </p>
            </div>
          ) : null}
          {errorNotice}
          <DialogFooter className="flex-row items-center justify-end gap-2 border-t pt-5 max-sm:[&_button]:min-h-11">
            {!recoveryCode && (
              <Button variant="ghost" className="rounded-lg" disabled={busy} onClick={closeFlow}>
                {t(flow === "help" ? "common:close" : "common:cancel")}
              </Button>
            )}
            {flow !== "help" && (
              <Button
                className="min-h-11 rounded-lg"
                disabled={
                  busy ||
                  ((recoveryCode || flow === "resume") && !confirmed) ||
                  (flow === "unlock" && !code.trim())
                }
                onClick={() => {
                  if (flow === "pause") void run({ action: "disable" });
                  else if (flow === "unlock") void run({ action: "recover", code });
                  else if (flow === "replace" && recoveryCode) {
                    if (resumeAfterReplace) {
                      setRecoveryCode("");
                      setFlow("resume");
                      setResumeAfterReplace(false);
                    } else closeFlow();
                  } else if (recoveryCode || flow === "resume")
                    void run({ action: "enable", confirmed });
                  else void run({ action: flow === "replace" ? "reissue" : "setup" });
                }}
              >
                {busy && <Icons.Spinner className="mr-2 size-4 animate-spin" aria-hidden />}
                {t(
                  flow === "pause"
                    ? "settings:cloud_backup_disable"
                    : flow === "unlock"
                      ? "settings:cloud_backup_unlock"
                      : flow === "replace" && recoveryCode
                        ? "common:finish"
                        : recoveryCode || flow === "resume"
                          ? "settings:cloud_backup_enable"
                          : flow === "replace"
                            ? "settings:cloud_backup_reissue"
                            : "common:profiles.continue",
                )}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={deleteId !== undefined}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setDeleteId(undefined);
            setError("");
            setReauth(false);
          }
        }}
      >
        <DialogContent
          className="rounded-2xl"
          mobileClassName="h-auto max-h-[85dvh] overflow-y-auto"
        >
          <DialogHeader className="text-left">
            <DialogTitle className="text-xl font-semibold leading-6 tracking-tight">
              {t(
                deleteId === null
                  ? "settings:cloud_backup_delete_all"
                  : "settings:cloud_backup_delete_title",
              )}
            </DialogTitle>
            <DialogDescription>{t("settings:cloud_backup_delete_confirm")}</DialogDescription>
          </DialogHeader>
          {errorNotice}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setDeleteId(undefined);
                setError("");
                setReauth(false);
              }}
            >
              {t("common:cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => void run({ action: "delete", backupId: deleteId ?? null })}
            >
              {t("settings:cloud_backup_delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {preview && (
        <BackupImportDialog
          initialPreview={preview}
          displayName={t("settings:cloud_backup_title")}
          onClose={() => setPreview(undefined)}
        />
      )}
    </Card>
  );
}
