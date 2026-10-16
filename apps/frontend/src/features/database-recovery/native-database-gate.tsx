import { DATABASE_STATE_CHANGED } from "../../adapters/tauri/events";
import { StartupScreen } from "@/components/startup-screen";
import { useProfile } from "@/features/profiles/profile-context";
import type { BackupFailure } from "@/pages/settings/exports/backup-error";
import { BackupAlert } from "@/pages/settings/exports/backup-ui";
import { reloadApplication } from "@/lib/reload-application";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { isWeb } from "@/adapters";
import { openDatabaseFileDialog } from "../../adapters/tauri/files";
import {
  discardDatabaseBackupImport,
  getDatabaseStartupStatus,
  inspectDatabaseBackup,
  recoverDatabaseFromImport,
  retryDatabaseStartup,
  type BackupImportPreview,
} from "../../adapters/tauri/settings";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { PasswordInput } from "@wealthfolio/ui/components/ui/password-input";
import { Label } from "@wealthfolio/ui/components/ui/label";
import { Icons } from "@wealthfolio/ui/components/ui/icons";

/** Native startup must succeed before database-dependent providers mount. */
export function NativeDatabaseGate({ children }: { children: ReactNode }) {
  return isWeb ? children : <NativeStartup>{children}</NativeStartup>;
}

function NativeStartup({ children }: { children: ReactNode }) {
  const { t, i18n } = useTranslation();
  const profile = useProfile();
  const [listenerError, setListenerError] = useState<string | null>(null);
  const status = useQuery({
    queryKey: ["database-startup"],
    queryFn: getDatabaseStartupStatus,
    retry: false,
    // Reads are driven by the initial subscription and backend transitions.
    enabled: false,
  });
  const { refetch } = status;
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let pending = false;
    let unlisten: (() => void) | undefined;
    const refresh = async () => {
      if (cancelled) return;
      if (inFlight) {
        pending = true;
        return;
      }
      inFlight = true;
      try {
        await refetch();
      } finally {
        inFlight = false;
        if (pending && !cancelled) {
          pending = false;
          void refresh();
        }
      }
    };
    void import("@tauri-apps/api/event")
      .then(({ listen }) => listen(DATABASE_STATE_CHANGED, () => void refresh()))
      .then((stop) => {
        if (cancelled) stop();
        else {
          unlisten = stop;
          void refresh();
        }
      })
      .catch((cause) => {
        if (!cancelled) setListenerError(String(cause));
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [refetch]);
  const generation = useRef<string | null>(null);
  if (status.data?.ready && status.data.generation && generation.current === null) {
    generation.current = status.data.generation;
  }
  const generationChanged = Boolean(
    status.data?.ready && status.data.generation && generation.current !== status.data.generation,
  );
  useEffect(() => {
    if (generationChanged && !status.data?.maintenance) reloadApplication();
  }, [generationChanged, status.data?.maintenance]);
  const [selected, setSelected] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [preview, setPreview] = useState<BackupImportPreview | null>(null);
  const [busy, setBusy] = useState<"inspect" | "restore" | "retry" | null>(null);
  const [error, setError] = useState<BackupFailure | null>(null);
  const [copiedDetails, setCopiedDetails] = useState<string | null>(null);
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
  const inspect = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy("inspect");
    setError(null);
    try {
      const result = await inspectDatabaseBackup(selected, password || null, controller.signal);
      if (!controller.signal.aborted && result) {
        previewId.current = result.id;
        setPreview(result);
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError({ cause });
    } finally {
      setPassword("");
      setBusy(null);
    }
  };
  const cancel = async () => {
    operation.current?.abort();
    setPassword("");
    setPreview(null);
    if (previewId.current) {
      const id = previewId.current;
      previewId.current = null;
      await discardDatabaseBackupImport(id).catch(() => undefined);
    }
  };
  const restore = async () => {
    if (!preview || previewId.current !== preview.id) return;
    setBusy("restore");
    setError(null);
    previewId.current = null;
    try {
      await recoverDatabaseFromImport(preview.id);
    } catch (cause) {
      setError({ cause });
      setPreview(null);
    } finally {
      setBusy(null);
    }
  };

  const retry = async () => {
    setBusy("retry");
    setError(null);
    try {
      await retryDatabaseStartup();
    } catch (cause) {
      setError({ cause, message: t("settings:recovery_retry_failed") });
    } finally {
      setBusy(null);
    }
  };

  if (listenerError)
    return (
      <StartupScreen
        message={t("common:profiles.startupFailed")}
        error={t("common:profiles.reloadHelp")}
      >
        <Button onClick={() => reloadApplication()}>{t("common:retry")}</Button>
      </StartupScreen>
    );

  if (
    status.isFetchedAfterMount &&
    status.data?.ready &&
    !status.data.maintenance &&
    !status.isError &&
    !generationChanged
  )
    return children;
  const startupError = status.data?.error || (status.error ? String(status.error) : null);
  if (!startupError || status.data?.maintenance || /PROFILE_(LOCKED|STALE)/.test(startupError))
    return <StartupScreen />;

  const createdAt = preview?.summary.createdAt ? new Date(preview.summary.createdAt) : null;
  const formattedDate =
    createdAt && !Number.isNaN(createdAt.getTime())
      ? createdAt.toLocaleString(i18n.resolvedLanguage)
      : null;
  const copied = copiedDetails === startupError;
  const copyDetails = async () => {
    try {
      await navigator.clipboard.writeText(startupError);
      setCopiedDetails(startupError);
    } catch {
      setCopiedDetails(null);
    }
  };
  // A retry usually fails with the error already shown above; don't repeat it.
  const failure =
    error &&
    typeof error !== "string" &&
    (error.cause instanceof Error ? error.cause.message : error.cause) === startupError
      ? { ...error, cause: null }
      : error;
  return (
    <div className="bg-background text-foreground relative min-h-dvh">
      <div data-tauri-drag-region className="absolute inset-x-0 top-0 h-8" />
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-6 pb-[calc(3rem+env(safe-area-inset-bottom,0px))] pt-[calc(3rem+env(safe-area-inset-top,0px))]">
        <header className="flex flex-col items-center gap-5 text-center">
          <img src="/logo.png" alt="Wealthfolio" className="size-16 object-contain" />
          <div className="space-y-2">
            <h1 className="text-balance text-2xl font-semibold tracking-tight">
              {t("settings:recovery_title")}
            </h1>
            <p className="text-muted-foreground text-pretty text-sm leading-relaxed">
              {t(
                status.data?.canRecover
                  ? "settings:recovery_description"
                  : "settings:recovery_unavailable",
              )}
            </p>
          </div>
        </header>
        <details className="bg-muted/40 group rounded-2xl border">
          <summary className="text-muted-foreground flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-xs font-medium [&::-webkit-details-marker]:hidden">
            {t("settings:recovery_details")}
            <Icons.ChevronDown
              className="size-3.5 transition-transform group-open:rotate-180"
              aria-hidden
            />
          </summary>
          <div className="flex items-start gap-2 pb-3 pl-4 pr-2">
            <p className="max-h-40 min-w-0 flex-1 select-text overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
              {startupError}
            </p>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground -mt-1.5 shrink-0"
              aria-label={t(
                copied ? "settings:recovery_details_copied" : "settings:recovery_copy_details",
              )}
              onClick={() => void copyDetails()}
            >
              {copied ? <Icons.Check className="size-3.5" /> : <Icons.Copy className="size-3.5" />}
            </Button>
            <span role="status" className="sr-only">
              {copied ? t("settings:recovery_details_copied") : ""}
            </span>
          </div>
        </details>
        <div className="flex flex-col gap-3">
          {!preview && (
            <Button className="w-full" disabled={busy !== null} onClick={() => void retry()}>
              {busy === "retry" && <Icons.Spinner className="animate-spin" />}
              {t(busy === "retry" ? "settings:recovery_opening" : "settings:recovery_retry")}
            </Button>
          )}
          {status.data?.canRecover && (
            <div className="rounded-2xl border p-5">
              {preview ? (
                <section className="space-y-4" aria-label={t("settings:recovery_preview")}>
                  <h2 className="font-medium">{t("settings:recovery_preview")}</h2>
                  <div className="bg-muted/40 space-y-1 rounded-xl px-4 py-3 text-sm">
                    <p>
                      {t("settings:recovery_counts", {
                        accounts: preview.summary.accountCount,
                        activities: preview.summary.activityCount,
                      })}
                    </p>
                    {formattedDate && (
                      <p className="text-muted-foreground">
                        {t("settings:recovery_created", { date: formattedDate })}
                      </p>
                    )}
                  </div>
                  <p className="text-sm leading-relaxed">{t("settings:recovery_confirmation")}</p>
                  <p className="text-sm leading-relaxed">
                    {t(
                      status.data.recoveryEncrypted
                        ? "settings:recovery_encrypted"
                        : "settings:recovery_plain",
                    )}
                  </p>
                  <p className="text-muted-foreground text-sm leading-relaxed">
                    {t("settings:recovery_reconnect")}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      className="flex-1"
                      disabled={busy === "restore"}
                      onClick={() => void cancel()}
                    >
                      {t("settings:recovery_back")}
                    </Button>
                    <Button
                      className="flex-1"
                      disabled={busy !== null}
                      onClick={() => void restore()}
                    >
                      {busy === "restore" && <Icons.Spinner className="animate-spin" />}
                      {t(
                        busy === "restore"
                          ? "settings:recovery_restoring"
                          : "settings:recovery_restore",
                      )}
                    </Button>
                  </div>
                </section>
              ) : (
                <form className="space-y-4" onSubmit={inspect}>
                  <div className="space-y-2">
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full"
                      disabled={busy !== null}
                      onClick={() => void choose()}
                    >
                      {t(
                        selected
                          ? "settings:recovery_change_file"
                          : "settings:recovery_choose_file",
                      )}
                    </Button>
                    {selected && (
                      <p className="bg-muted/40 break-all rounded-xl px-4 py-2 font-mono text-xs">
                        {selected.split(/[\\/]/).pop()}
                      </p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="recovery-password">{t("settings:recovery_password")}</Label>
                    <PasswordInput
                      id="recovery-password"
                      showLabel={t("settings:backup_export_show")}
                      hideLabel={t("settings:backup_export_hide")}
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      value={password}
                      disabled={busy !== null}
                      onChange={(event) => setPassword(event.target.value)}
                    />
                    <p className="text-muted-foreground text-xs leading-relaxed">
                      {t("settings:recovery_password_help")}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      type="submit"
                      variant="secondary"
                      className="flex-1"
                      disabled={!selected || busy !== null}
                    >
                      {busy === "inspect" && <Icons.Spinner className="animate-spin" />}
                      {t(
                        busy === "inspect"
                          ? "settings:recovery_inspecting"
                          : "settings:recovery_inspect",
                      )}
                    </Button>
                    {busy === "inspect" && (
                      <Button type="button" variant="outline" onClick={() => void cancel()}>
                        {t("settings:recovery_cancel")}
                      </Button>
                    )}
                  </div>
                </form>
              )}
            </div>
          )}
          {failure && <BackupAlert error={failure} className="rounded-2xl" />}
          {profile && (
            <Button
              variant="ghost"
              className="w-full"
              disabled={busy === "restore" || busy === "retry" || !!status.data?.maintenance}
              onClick={() => {
                void cancel().then(profile.switchProfile);
              }}
            >
              {t("common:profiles.switch", { defaultValue: "Switch profile" })}
            </Button>
          )}
        </div>
      </main>
    </div>
  );
}
