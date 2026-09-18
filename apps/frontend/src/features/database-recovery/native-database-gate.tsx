import { BackupError, type BackupFailure } from "@/pages/settings/exports/backup-error";
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

/** Native startup must succeed before database-dependent providers mount. */
export function NativeDatabaseGate({ children }: { children: ReactNode }) {
  return isWeb ? children : <NativeStartup>{children}</NativeStartup>;
}

function NativeStartup({ children }: { children: ReactNode }) {
  const { t, i18n } = useTranslation();
  const status = useQuery({
    queryKey: ["database-startup"],
    queryFn: getDatabaseStartupStatus,
    retry: false,
    staleTime: 0,
    refetchInterval: (query) =>
      query.state.data?.maintenance ||
      (!query.state.data?.ready && !query.state.data?.error && !query.state.error)
        ? 500
        : 5000,
    refetchOnWindowFocus: true,
  });
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
      await status.refetch();
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
      setError({ cause });
    } finally {
      await status.refetch();
      setBusy(null);
    }
  };

  if (
    status.isFetchedAfterMount &&
    status.data?.ready &&
    !status.data.maintenance &&
    !status.isError &&
    !generationChanged
  )
    return children;
  const startupError = status.data?.error || (status.error ? String(status.error) : null);
  if (!startupError || status.data?.maintenance)
    return (
      <main
        className="text-paper flex min-h-screen flex-col items-center justify-center gap-6 bg-[#09090b] p-6 text-center"
        role="status"
      >
        <img src="/logo-gold.png" alt="Wealthfolio" width={100} height={100} />
        <p>{t("settings:recovery_opening")}</p>
      </main>
    );

  const createdAt = preview?.summary.createdAt ? new Date(preview.summary.createdAt) : null;
  const formattedDate =
    createdAt && !Number.isNaN(createdAt.getTime())
      ? createdAt.toLocaleString(i18n.resolvedLanguage)
      : null;
  return (
    <div className="bg-background text-foreground min-h-screen">
      <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-5 p-6">
        <h1 className="text-2xl font-semibold">{t("settings:recovery_title")}</h1>
        <p className="text-muted-foreground">
          {t(
            status.data?.canRecover
              ? "settings:recovery_description"
              : "settings:recovery_unavailable",
          )}
        </p>
        <details className="text-sm">
          <summary className="cursor-pointer">{t("settings:recovery_details")}</summary>
          <p className="mt-2 break-words">{startupError}</p>
        </details>
        {!preview && (
          <Button variant="outline" disabled={busy !== null} onClick={() => void retry()}>
            {t(busy === "retry" ? "settings:recovery_opening" : "settings:recovery_retry")}
          </Button>
        )}
        {status.data?.canRecover && (
          <>
            {preview ? (
              <section className="space-y-4" aria-label={t("settings:recovery_preview")}>
                <h2 className="font-medium">{t("settings:recovery_preview")}</h2>
                <p>
                  {t("settings:recovery_counts", {
                    accounts: preview.summary.accountCount,
                    activities: preview.summary.activityCount,
                  })}
                </p>
                {formattedDate && (
                  <p className="text-sm">
                    {t("settings:recovery_created", { date: formattedDate })}
                  </p>
                )}
                <p>{t("settings:recovery_confirmation")}</p>
                <p>
                  {t(
                    status.data.recoveryEncrypted
                      ? "settings:recovery_encrypted"
                      : "settings:recovery_plain",
                  )}
                </p>
                <p className="text-muted-foreground text-sm">{t("settings:recovery_reconnect")}</p>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    disabled={busy === "restore"}
                    onClick={() => void cancel()}
                  >
                    {t("settings:recovery_back")}
                  </Button>
                  <Button disabled={busy !== null} onClick={() => void restore()}>
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
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => void choose()}
                >
                  {t(selected ? "settings:recovery_change_file" : "settings:recovery_choose_file")}
                </Button>
                {selected && <p className="break-all text-sm">{selected.split(/[\\/]/).pop()}</p>}
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
                  <p className="text-muted-foreground text-sm">
                    {t("settings:recovery_password_help")}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button type="submit" disabled={!selected || busy !== null}>
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
          </>
        )}
        {error && (
          <div role="alert" className="text-destructive break-words text-sm">
            <BackupError error={error} />
          </div>
        )}
      </main>
    </div>
  );
}
