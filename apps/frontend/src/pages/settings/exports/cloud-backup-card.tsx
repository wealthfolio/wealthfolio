import { cn } from "@/lib/utils";
import { Fragment, useEffect, useRef, useState } from "react";
import { ShieldCheckIcon } from "@phosphor-icons/react/dist/csr/ShieldCheck";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useDateFormatting, useLocalizationSettings, buttonVariants } from "@wealthfolio/ui";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Badge } from "@wealthfolio/ui/components/ui/badge";
import { Card, CardContent, CardHeader } from "@wealthfolio/ui/components/ui/card";
import { Checkbox } from "@wealthfolio/ui/components/ui/checkbox";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { PasswordInput } from "@wealthfolio/ui/components/ui/password-input";
import { Label } from "@wealthfolio/ui/components/ui/label";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@wealthfolio/ui/components/ui/dialog";
import {
  captureCloudBackup,
  cloudBackupAction,
  downloadCloudBackup,
  previewCloudBackupRestore,
  isTauri,
  type CloudBackupOperation,
  type CloudBackupStatus,
  type BackupImportPreview,
} from "@/adapters";
import { formatDistanceToNow } from "@/lib/utils";
import { BackupImportDialog } from "./backup-import-dialog";
import type { BackupFailure } from "./backup-error";
import {
  BackupAlert,
  BackupCardHeader,
  BackupDeleteDialog,
  BackupEmpty,
  BackupFileTile,
  BackupList,
  BackupRow,
  BackupActions,
  BackupRowsSkeleton,
  InfoPopover,
  InlineFacts,
  PendingIcon,
} from "./backup-ui";
import { formatBackupSize } from "./backup-size";
import { backupDate, backupState, useCloudBackups } from "./use-cloud-backups";
import { Alert, AlertDescription } from "@wealthfolio/ui/components/ui/alert";

type Flow = "setup" | "resume" | "unlock" | "replace" | "pause" | "help";
/** The one operation in progress: `restore:<id>` and `download:<id>` name their row. */
type Pending =
  | "capture"
  | "manual"
  | "flow"
  | "delete"
  | `restore:${string}`
  | `download:${string}`;

/** An extra backup now, offered while automatic backups run here and have run at least once. */
function canBackUpNow(data: CloudBackupStatus) {
  const state = backupState(data);
  return (
    data.policy.uploadEntitled &&
    data.policy.enabled &&
    data.isSource &&
    data.sourceConsented !== false &&
    data.keyReady &&
    !!data.policy.lastBackupAt &&
    state !== "failed" &&
    state !== "running"
  );
}

function ProtectionStatus({ data }: { data: CloudBackupStatus }) {
  const { t } = useTranslation();
  const state = backupState(data);
  return (
    <Badge
      variant={state === "on" ? "success-subtle" : "outline"}
      className={`shrink-0 gap-1.5 border-0 px-2 py-0.5 text-[11px] font-medium ${state === "on" ? "" : "bg-muted/60 text-muted-foreground"}`}
    >
      <span
        aria-hidden
        className={`size-1.5 rounded-full ${state === "on" ? "bg-success" : "bg-current"}`}
      />
      {t(`settings:cloud_backup_state_${state}`)}
    </Badge>
  );
}

/** The next scheduled backup, or the retry after a failure; null when nothing is scheduled. */
function nextBackup(data: CloudBackupStatus) {
  const failed = data.capture?.state === "failed";
  const due = backupDate(failed ? (data.capture?.retryAt ?? null) : data.policy.nextDueAt);
  const scheduled =
    data.policy.uploadEntitled &&
    data.policy.enabled &&
    !(data.isSource && data.sourceConsented === false) &&
    backupState(data) !== "running";
  if (!scheduled || !due) return null;
  return {
    date: due,
    labelKey: failed ? "settings:cloud_backup_retry_label" : "settings:cloud_backup_next_label",
  } as const;
}

/** Last and next backup as one line; "not scheduled" is left to the status badge. */
function BackupTimes({ data }: { data: CloudBackupStatus }) {
  const { t } = useTranslation();
  const formatting = useDateFormatting();
  const format = (date: Date) =>
    formatting.formatDateTime(date, { dateStyle: "medium", timeStyle: "short" });
  const last = backupDate(data.policy.lastBackupAt);
  const next = nextBackup(data);
  const items = [
    {
      label: t("settings:cloud_backup_last_label"),
      value: last ? format(last) : t("settings:cloud_backup_none"),
    },
    ...(next ? [{ label: t(next.labelKey), value: format(next.date) }] : []),
  ];
  return <InlineFacts items={items} />;
}

/** Shown only when it explains more than the badge, dates and action already say. */
function BackupHint({ data }: { data: CloudBackupStatus }) {
  const { t } = useTranslation();
  const state = backupState(data);
  if (!["failed", "other", "waiting", "due", "running"].includes(state)) return null;
  return (
    <p className="text-muted-foreground text-sm leading-relaxed">
      {t(`settings:cloud_backup_hint_${state}`)}
    </p>
  );
}

function RecoveryDeadline({ data }: { data: CloudBackupStatus }) {
  const { t } = useTranslation();
  const formatting = useDateFormatting();
  const deadline = backupDate(data.policy.readGraceExpiresAt ?? null);
  if (data.policy.uploadEntitled || !data.history.length || !deadline) return null;
  return (
    <Alert variant="warning" role="status" className="p-3">
      <Icons.AlertTriangle aria-hidden />
      <AlertDescription className="leading-relaxed">
        {t("settings:cloud_backup_recovery_deadline", {
          date: formatting.formatDateTime(deadline, { dateStyle: "medium", timeStyle: "short" }),
        })}
      </AlertDescription>
    </Alert>
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

/** State, last and next backup as short phrases, plus the status dot color. */
function describeBackupStatus(
  data: CloudBackupStatus,
  t: TFunction,
  localization: ReturnType<typeof useLocalizationSettings>,
) {
  const state = backupState(data);
  const relative = (date: Date) => formatDistanceToNow(date, localization, { addSuffix: true });
  const last = backupDate(data.policy.lastBackupAt);
  // An overdue backup or retry has no upcoming time; "Next backup 2 hours ago" reads wrong.
  const next = nextBackup(data);
  const upcoming = next && next.date.getTime() > Date.now() ? next : null;
  return {
    isOn: state === "on",
    state: t(`settings:cloud_backup_state_${state}`),
    last: last ? `${t("settings:cloud_backup_last_label")} ${relative(last)}` : null,
    next: upcoming ? `${t(upcoming.labelKey)} ${relative(upcoming.date)}` : null,
    dot:
      state === "on" ? "bg-success" : state === "failed" ? "bg-destructive" : "bg-muted-foreground",
  };
}

function BackupStatusLine({ dot, parts }: { dot: string; parts: (string | null)[] }) {
  return (
    <p className="text-muted-foreground flex items-start gap-1.5 text-xs">
      <span className={`mt-[5px] size-1.5 shrink-0 rounded-full ${dot}`} aria-hidden />
      <span>
        {parts.filter(Boolean).map((part, index) => (
          <Fragment key={index}>
            {index > 0 && <span aria-hidden> · </span>}
            <span>{part}</span>
          </Fragment>
        ))}
      </span>
    </p>
  );
}

function sortNewestFirst(history: CloudBackupStatus["history"]) {
  return [...history].sort(
    (a, b) =>
      (backupDate(b.publishedAt)?.getTime() ?? 0) - (backupDate(a.publishedAt)?.getTime() ?? 0),
  );
}

/** Read-only Connect overview in one row; the backup settings own consent and recovery. */
export function CloudBackupSummary() {
  const { t } = useTranslation();
  const localization = useLocalizationSettings();
  const { available, status } = useCloudBackups();
  if (!available) return null;
  const data = status.data;
  if (data && !data.policy.uploadEntitled && !data.history.length) return <CloudBackupPromotion />;
  const summary = data && describeBackupStatus(data, t, localization);
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center gap-3">
          <div className="bg-muted flex size-8 shrink-0 items-center justify-center rounded-lg">
            <ShieldCheckIcon
              weight="duotone"
              className="text-muted-foreground size-4"
              aria-hidden
            />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="flex items-center gap-2 text-base font-semibold">
              {t("settings:cloud_backup_title")}
              {!!data?.history.length && (
                <span className="text-muted-foreground text-sm font-normal tabular-nums">
                  {data.history.length}
                </span>
              )}
            </h3>
            {status.isPending ? (
              <OverviewSkeleton />
            ) : status.isError || !summary ? (
              <p className="text-muted-foreground text-xs">{t("settings:cloud_backup_failed")}</p>
            ) : (
              // The next run matters only when it differs from the routine schedule.
              <BackupStatusLine
                dot={summary.dot}
                parts={
                  summary.isOn
                    ? [summary.state, summary.last]
                    : [summary.state, summary.next ?? summary.last]
                }
              />
            )}
          </div>
          <Link
            to="/settings/exports"
            aria-label={t("settings:cloud_backup_manage")}
            className={cn(
              buttonVariants({ variant: "ghost", size: "sm" }),
              "text-muted-foreground hover:text-foreground pointer-coarse:h-11 shrink-0",
            )}
          >
            <span className="hidden sm:inline">{t("settings:cloud_backup_manage")}</span>
            <Icons.ChevronRight className="size-4" aria-hidden />
          </Link>
        </div>
        {data && <RecoveryDeadline data={data} />}
      </CardContent>
    </Card>
  );
}

const COMPACT_HISTORY_LIMIT = 3;

/** List variant of the summary for the Connect page's side column: status line, latest copies. */
export function CloudBackupCompactSummary() {
  const { t, i18n } = useTranslation();
  const formatting = useDateFormatting();
  const localization = useLocalizationSettings();
  const { available, status } = useCloudBackups();
  if (!available) return null;
  const data = status.data;
  if (data && !data.policy.uploadEntitled && !data.history.length) return <CloudBackupPromotion />;
  const summary = data && describeBackupStatus(data, t, localization);
  const latest = sortNewestFirst(data?.history ?? []).slice(0, COMPACT_HISTORY_LIMIT);

  return (
    <Card className="overflow-hidden">
      <div className="border-b px-4 py-2.5">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <ShieldCheckIcon weight="duotone" className="text-muted-foreground size-5" aria-hidden />
          {t("settings:cloud_backup_title")}
          {!!data?.history.length && (
            <span className="text-muted-foreground text-sm font-normal tabular-nums">
              {data.history.length}
            </span>
          )}
        </h2>
        {summary && (
          <div className="mt-0.5 pl-7">
            {/* "On" is implied by a scheduled next backup; other states name themselves. */}
            <BackupStatusLine
              dot={summary.dot}
              parts={summary.isOn && summary.next ? [summary.next] : [summary.state, summary.next]}
            />
          </div>
        )}
      </div>
      {status.isPending ? (
        <div className="px-4 py-3">
          <OverviewSkeleton />
        </div>
      ) : status.isError || !data ? (
        <p className="text-muted-foreground px-4 py-3 text-sm">
          {t("settings:cloud_backup_failed")}
        </p>
      ) : (
        <>
          <div className="px-4 pt-3 empty:hidden">
            <RecoveryDeadline data={data} />
          </div>
          {latest.length === 0 ? (
            <p className="text-muted-foreground px-4 py-3 text-sm">
              {t("settings:cloud_backup_none")}
            </p>
          ) : (
            <ul className="divide-y" aria-label={t("settings:cloud_backup_history")}>
              {latest.map((point) => {
                const date = backupDate(point.publishedAt);
                const details = [
                  date && formatting.formatTime(date, { timeStyle: "short" }),
                  formatBackupSize(point.sizeBytes, i18n.language),
                  point.metadata?.device_name,
                ].filter(Boolean);
                return (
                  <li key={point.backupId} className="flex min-h-14 items-center gap-3 px-4 py-2.5">
                    <BackupFileTile />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {date
                          ? formatting.formatDate(date, { dateStyle: "medium" })
                          : t("settings:backup_unknown_date")}
                      </p>
                      <p className="text-muted-foreground truncate text-xs">
                        {details.join(" · ")}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
      <Link
        to="/settings/exports"
        className="text-muted-foreground hover:bg-muted/40 hover:text-foreground flex min-h-11 items-center justify-between border-t px-4 text-sm"
      >
        {t("settings:cloud_backup_manage")}
        <Icons.ChevronRight className="size-4" aria-hidden />
      </Link>
    </Card>
  );
}

function OverviewSkeleton() {
  const { t } = useTranslation();
  return (
    <div role="status" className="pt-1">
      <span className="sr-only">{t("common:loading")}</span>
      <Skeleton className="h-4 w-64 max-w-full" aria-hidden />
    </div>
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
  const canRestore = isTauri && !isMobile;
  const active = useRef(true);
  const [flow, setFlow] = useState<Flow>();
  const [resumeAfterReplace, setResumeAfterReplace] = useState(false);
  const [code, setCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [copied, setCopied] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<BackupFailure | null>(null);
  const [reauth, setReauth] = useState(false);
  const [accessRunning, setAccessRunning] = useState(false);
  const [accessResult, setAccessResult] = useState<"unavailable" | "notLinked" | "error">();
  const [preview, setPreview] = useState<{ backupId: string; value: BackupImportPreview }>();
  const [deleteId, setDeleteId] = useState<string | null | undefined>();
  // One operation at a time; only the control that started it shows progress.
  const busy = pending !== null;
  const data = status.data;
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  function showFlow(value: Flow) {
    setResumeAfterReplace(value === "replace" && flow === "resume");
    setError(null);
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
    setError(null);
    setReauth(false);
  }
  function showDelete(backupId: string | null) {
    setError(null);
    setReauth(false);
    setDeleteId(backupId);
  }
  function closeDelete() {
    setDeleteId(undefined);
    setError(null);
    setReauth(false);
  }
  function failed(cause: unknown) {
    if (!active.current) return;
    const recentLogin = String(cause).includes("BACKUP_REAUTHENTICATION_REQUIRED");
    setReauth(recentLogin);
    setError({
      cause,
      message: t(
        recentLogin
          ? "settings:cloud_backup_reauth"
          : String(cause).includes("BACKUP_MANUAL_LIMIT")
            ? "settings:cloud_backup_manual_limit"
            : "settings:cloud_backup_failed",
      ),
    });
  }
  async function run(operation: CloudBackupOperation) {
    setPending(operation.action === "delete" ? "delete" : "flow");
    setError(null);
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
        setFlow(undefined);
      }
      if (operation.action === "enable") {
        setRecoveryCode("");
        setFlow(undefined);
        // Enabling wakes the profile scheduler; its first capture has separate status.
      }
      if (operation.action === "delete") setDeleteId(undefined);
      if (operation.action === "disable") setFlow(undefined);
    } catch (cause) {
      failed(cause);
    } finally {
      if (active.current) {
        await status.refetch();
        if (active.current) setPending(null);
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
  async function perform(key: Pending, action: () => Promise<unknown>) {
    setPending(key);
    setError(null);
    try {
      await action();
    } catch (cause) {
      failed(cause);
    } finally {
      if (active.current) {
        await status.refetch();
        if (active.current) setPending(null);
      }
    }
  }
  async function openPreview(backupId: string) {
    const value = await previewCloudBackupRestore(backupId);
    if (active.current) setPreview({ backupId, value });
  }
  const history = [...(data?.history ?? [])].sort(
    (a, b) =>
      (backupDate(b.publishedAt)?.getTime() ?? 0) - (backupDate(a.publishedAt)?.getTime() ?? 0),
  );
  const errorNotice = error && (
    <BackupAlert
      error={error}
      action={
        reauth && (
          <Link to="/settings/connect" className="block font-medium underline underline-offset-4">
            {t("settings:cloud_backup_sign_in")}
          </Link>
        )
      }
    />
  );
  const setupLabel = (value: CloudBackupStatus) =>
    t(
      !value.hasKey
        ? "settings:cloud_backup_setup"
        : !value.keyReady
          ? "settings:cloud_backup_unlock"
          : "settings:cloud_backup_resume",
    );
  /** The one next step for this state; the locked state keeps its two actions in the body. */
  const primaryAction = (value: CloudBackupStatus) => {
    const state = backupState(value);
    if (
      value.policy.uploadEntitled &&
      (!value.policy.enabled || !value.isSource || value.sourceConsented === false) &&
      (!value.hasKey || value.keyReady)
    )
      return (
        <Button
          size="sm"
          className="pointer-coarse:h-11"
          disabled={busy}
          onClick={() => showFlow(!value.hasKey ? "setup" : "resume")}
        >
          {setupLabel(value)}
        </Button>
      );
    if (
      value.policy.uploadEntitled &&
      value.policy.enabled &&
      value.isSource &&
      value.sourceConsented !== false &&
      value.keyReady &&
      (!value.policy.lastBackupAt || state === "failed")
    )
      return (
        <Button
          size="sm"
          className="pointer-coarse:h-11 aria-busy:opacity-100"
          disabled={busy || state === "running"}
          aria-busy={pending === "capture"}
          onClick={() => void perform("capture", () => captureCloudBackup())}
        >
          <PendingIcon pending={pending === "capture"} icon={<Icons.RefreshCw aria-hidden />} />
          {t(
            state === "failed" ? "settings:cloud_backup_retry_now" : "settings:cloud_backup_retry",
          )}
        </Button>
      );
    return undefined;
  };
  const locked = !!data?.hasKey && !data.keyReady;
  return (
    <Card
      className="overflow-hidden rounded-2xl shadow-none"
      aria-label={t("settings:cloud_backup_title")}
    >
      <CardHeader className="space-y-4 p-5 sm:p-6">
        <BackupCardHeader
          brand
          icon={<ShieldCheckIcon weight="duotone" aria-hidden />}
          title={t("settings:cloud_backup_title")}
          info={
            <InfoPopover
              label={t("common:component.more_info_about", {
                label: t("settings:cloud_backup_title"),
              })}
            >
              <p className="text-foreground flex items-center gap-1.5 font-medium">
                <Icons.Lock className="size-3.5 shrink-0" aria-hidden />
                {t("settings:cloud_backup_private")}
              </p>
              <p>
                {t(
                  !isTauri
                    ? "settings:cloud_backup_hint_on_web"
                    : isMobile
                      ? "settings:cloud_backup_schedule_mobile"
                      : "settings:cloud_backup_schedule",
                )}
              </p>
              <p>{t("settings:cloud_backup_exclusions")}</p>
              {data?.policy.enabled && data.isSource && data.sourceConsented !== false && (
                <p className="flex items-center gap-1.5">
                  <Icons.Laptop className="size-3.5 shrink-0" aria-hidden />
                  {t("settings:cloud_backup_source", {
                    name: profile?.name ?? t("settings:cloud_backup_this_profile"),
                  })}
                </p>
              )}
            </InfoPopover>
          }
          badge={data && <ProtectionStatus data={data} />}
          subtitle={
            status.isPending ? (
              <OverviewSkeleton />
            ) : data?.hasKey ? (
              <BackupTimes data={data} />
            ) : (
              data && (
                <p className="text-muted-foreground text-sm">{t("settings:cloud_backup_scope")}</p>
              )
            )
          }
          action={data && primaryAction(data)}
          menu={
            data?.hasKey && (
              <BackupActions
                title={t("settings:cloud_backup_title")}
                label={t("settings:cloud_backup_options")}
                disabled={busy}
                pending={pending === "manual"}
                groups={[
                  [
                    ...(canBackUpNow(data)
                      ? [
                          {
                            icon: Icons.Upload,
                            label: t("settings:backup_now"),
                            onSelect: () =>
                              void perform("manual", async () => {
                                const point = await captureCloudBackup(true);
                                if (!active.current) return;
                                // No point: the slot was busy, eligibility changed, or the
                                // attempt was cancelled. The status refresh shows which.
                                toast(
                                  point
                                    ? { title: t("settings:backup_saved"), variant: "success" }
                                    : { title: t("settings:cloud_backup_not_started") },
                                );
                              }),
                          },
                        ]
                      : []),
                    ...(data.keyReady
                      ? [
                          {
                            icon: Icons.RefreshCw,
                            label: t("settings:cloud_backup_reissue"),
                            onSelect: () => showFlow("replace"),
                          },
                        ]
                      : []),
                    ...(data.policy.enabled
                      ? [
                          {
                            icon: Icons.PauseCircle,
                            label: t("settings:cloud_backup_disable"),
                            onSelect: () => showFlow("pause"),
                          },
                        ]
                      : []),
                  ],
                  history.length > 0
                    ? [
                        {
                          icon: Icons.Trash2,
                          label: t("settings:cloud_backup_delete_all"),
                          onSelect: () => showDelete(null),
                          destructive: true,
                        },
                      ]
                    : [],
                ]}
              />
            )
          }
        />
        {status.isError &&
          (String(status.error).includes("BACKUPS_UNAVAILABLE") ||
          String(status.error).includes("404") ? (
            <p className="bg-muted/40 text-muted-foreground rounded-lg p-3 text-sm">
              {t("settings:cloud_backup_unavailable")}
            </p>
          ) : (
            <BackupAlert
              error={{ cause: status.error, message: t("settings:cloud_backup_failed") }}
              action={
                <Button
                  size="sm"
                  variant="outline"
                  className="text-foreground"
                  onClick={() => void status.refetch()}
                >
                  {t("common:retry")}
                </Button>
              }
            />
          ))}
        {data && (
          <>
            <RecoveryDeadline data={data} />
            <BackupHint data={data} />
            {locked && (
              <div className="bg-muted/40 space-y-3 rounded-lg p-4">
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
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    className="pointer-coarse:h-11"
                    disabled={busy || accessRunning}
                    onClick={() => showFlow("unlock")}
                  >
                    {setupLabel(data)}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="pointer-coarse:h-11 aria-busy:opacity-100"
                    disabled={busy || accessRunning}
                    aria-busy={accessRunning}
                    onClick={() => void connectAccess()}
                  >
                    <PendingIcon pending={accessRunning} />
                    {t(accessResult ? "common:retry" : "settings:cloud_backup_access_check")}
                  </Button>
                </div>
              </div>
            )}
            {!data.policy.uploadEntitled && (
              <p className="text-muted-foreground text-sm">{t("settings:cloud_backup_paid")}</p>
            )}
          </>
        )}
        {!flow && deleteId === undefined && !preview && errorNotice}
      </CardHeader>
      {(data || status.isPending) && (
        <CardContent className="space-y-3 border-t p-5 sm:p-6">
          {!data ? (
            <BackupRowsSkeleton />
          ) : history.length === 0 ? (
            <BackupEmpty
              title={t("settings:cloud_backup_none")}
              description={t("settings:cloud_backup_empty")}
            />
          ) : (
            <BackupList items={history} label={t("settings:cloud_backup_history")}>
              {(point) => {
                const date = backupDate(point.publishedAt);
                const restoring = pending === `restore:${point.backupId}`;
                const downloading = pending === `download:${point.backupId}`;
                const dateTime = date
                  ? formatting.formatDateTime(date, { dateStyle: "medium", timeStyle: "short" })
                  : t("settings:backup_unknown_date");
                const download = {
                  icon: Icons.Download,
                  label: t("settings:cloud_backup_download"),
                  onSelect: () =>
                    void perform(`download:${point.backupId}`, () =>
                      downloadCloudBackup(point.backupId),
                    ),
                };
                const remove = {
                  icon: Icons.Trash2,
                  label: t("settings:cloud_backup_delete"),
                  onSelect: () => showDelete(point.backupId),
                  destructive: true,
                };
                return (
                  <BackupRow
                    key={point.backupId}
                    title={
                      date
                        ? formatting.formatDate(date, { dateStyle: "medium" })
                        : t("settings:backup_unknown_date")
                    }
                    meta={[
                      date && formatting.formatTime(date, { timeStyle: "short" }),
                      formatBackupSize(point.sizeBytes, i18n.language),
                    ]}
                    details={[point.metadata?.device_name, point.metadata?.profile_name]}
                    actions={
                      <BackupActions
                        title={dateTime}
                        label={t("settings:cloud_backup_item_options", { date: dateTime })}
                        primary={
                          canRestore
                            ? {
                                icon: Icons.History,
                                label: t("settings:cloud_backup_restore"),
                                onSelect: () =>
                                  void perform(`restore:${point.backupId}`, () =>
                                    openPreview(point.backupId),
                                  ),
                                disabled: !data.keyReady,
                                pending: restoring,
                              }
                            : { ...download, pending: downloading, withIcon: true }
                        }
                        groups={canRestore ? [[download], [remove]] : [[remove]]}
                        disabled={busy}
                        pending={canRestore && downloading}
                      />
                    }
                  />
                );
              }}
            </BackupList>
          )}
          {!isTauri && history.length > 0 && (
            <Button
              variant="link"
              size="sm"
              className="text-muted-foreground h-auto whitespace-normal p-0 text-left text-xs font-normal"
              onClick={() => showFlow("help")}
            >
              {t("settings:cloud_backup_restore_help")}
              <Icons.ArrowRight className="size-3.5" aria-hidden />
            </Button>
          )}
          {isMobile && history.length > 0 && (
            <p className="text-muted-foreground text-xs">
              {t("settings:cloud_backup_mobile_restore")}
            </p>
          )}
        </CardContent>
      )}
      <Dialog
        open={flow !== undefined}
        onOpenChange={(open) => {
          if (!open && !(recoveryCode && !confirmed)) closeFlow();
        }}
      >
        <DialogContent
          className="sm:max-w-md"
          mobileClassName="h-auto max-h-[85dvh] overflow-y-auto"
          showCloseButton={!busy && !recoveryCode}
        >
          <DialogHeader className="pr-6 text-left">
            <DialogTitle>
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
                                : isTauri
                                  ? "settings:cloud_backup_resume_description"
                                  : "settings:cloud_backup_resume_description_web"
                            : "settings:cloud_backup_setup_description",
                { name: profile?.name ?? t("settings:cloud_backup_this_profile") },
              )}
            </DialogDescription>
          </DialogHeader>
          {flow === "help" ? (
            <div className="bg-muted/40 space-y-3 rounded-lg p-4">
              <p className="text-sm">{t("settings:cloud_backup_restore_help_steps")}</p>
              <code className="bg-background block break-all rounded-md border p-3 font-mono text-xs">
                wealthfolio-server db restore backup.wfrec --profile {profile?.id ?? "PROFILE_ID"}{" "}
                --recovery-code-stdin
              </code>
            </div>
          ) : flow === "pause" ? null : recoveryCode ? (
            <div className="space-y-3">
              <div className="bg-muted/40 rounded-lg border p-4">
                <Label className="text-muted-foreground text-xs">
                  {t("settings:cloud_backup_code")}
                </Label>
                <pre className="mt-2 select-all whitespace-pre-wrap break-all font-mono text-sm leading-6">
                  {recoveryCode}
                </pre>
                <Button
                  variant="outline"
                  size="sm"
                  className="pointer-coarse:h-11 mt-3"
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(recoveryCode)
                      .then(() => {
                        if (active.current) setCopied(true);
                      })
                      .catch((cause) => {
                        if (active.current)
                          setError({ cause, message: t("settings:cloud_backup_copy_failed") });
                      });
                  }}
                >
                  {copied ? <Icons.Check aria-hidden /> : <Icons.Copy aria-hidden />}
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
            <div className="space-y-3">
              <label className="hover:bg-muted/40 flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm leading-5 transition-colors">
                <Checkbox
                  checked={confirmed}
                  onCheckedChange={(value) => setConfirmed(value === true)}
                  className="mt-0.5"
                />
                {t("settings:cloud_backup_confirm")}
              </label>
              <Button
                variant="link"
                size="sm"
                className="text-muted-foreground h-auto p-0 text-xs font-normal"
                disabled={busy}
                onClick={() => showFlow("replace")}
              >
                {t("settings:cloud_backup_need_code")}
              </Button>
            </div>
          ) : flow === "setup" ? (
            <div className="space-y-3">
              <div className="bg-muted/40 flex items-center gap-3 rounded-lg p-3">
                <Icons.Laptop className="text-muted-foreground size-5 shrink-0" aria-hidden />
                <div>
                  <p className="text-sm font-medium leading-5">
                    {profile?.name ?? t("settings:cloud_backup_this_profile")}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {t(
                      isTauri
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
          <DialogFooter>
            {!recoveryCode && (
              <Button variant="ghost" disabled={busy} onClick={closeFlow}>
                {t(flow === "help" ? "common:close" : "common:cancel")}
              </Button>
            )}
            {flow !== "help" && (
              <Button
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
                <PendingIcon pending={pending === "flow"} />
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
      <BackupDeleteDialog
        open={deleteId !== undefined}
        title={t(
          deleteId === null
            ? "settings:cloud_backup_delete_all"
            : "settings:cloud_backup_delete_title",
        )}
        description={t("settings:cloud_backup_delete_confirm")}
        pending={pending === "delete"}
        pendingLabel={t("settings:backup_deleting")}
        error={errorNotice}
        onCancel={closeDelete}
        onConfirm={() => void run({ action: "delete", backupId: deleteId ?? null })}
      />
      {preview && (
        <BackupImportDialog
          key={preview.value.id}
          initialPreview={preview.value}
          displayName={t("settings:cloud_backup_title")}
          onRetry={() => openPreview(preview.backupId)}
          onClose={() => setPreview(undefined)}
        />
      )}
    </Card>
  );
}
