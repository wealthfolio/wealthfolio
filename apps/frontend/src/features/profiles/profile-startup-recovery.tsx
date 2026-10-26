import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Icons } from "@wealthfolio/ui";
import { reloadApplication } from "@/lib/reload-application";
import { profileCommand, type ProfileState } from "./api";

interface ProfileStartupRecoveryProps {
  error: string;
  onStartNew: (state: ProfileState) => void;
}

export function ProfileStartupRecovery({ error, onStartNew }: ProfileStartupRecoveryProps) {
  const { t } = useTranslation("common");
  const [busy, setBusy] = useState(false);
  const [confirmNew, setConfirmNew] = useState(false);
  const [actionError, setActionError] = useState<string>();

  async function run(
    command: "retry_profile_startup" | "open_profile_data_folder" | "start_new_profile_setup",
  ) {
    if (busy) return;
    setBusy(true);
    setActionError(undefined);
    try {
      if (command === "start_new_profile_setup") {
        onStartNew(await profileCommand<ProfileState>(command));
      } else {
        await profileCommand(command);
        if (command === "retry_profile_startup") reloadApplication();
      }
    } catch (cause) {
      setActionError(String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="bg-background text-foreground flex min-h-dvh items-center justify-center px-5 py-16">
      <div data-tauri-drag-region className="absolute inset-x-0 top-0 h-8" />
      <div className="bg-card text-card-foreground border-border w-full max-w-lg rounded-2xl border p-6 shadow-sm sm:p-8">
        <header className="space-y-4">
          <div className="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-xl">
            <Icons.FolderOpen className="size-6" aria-hidden="true" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("profiles.registryRecoveryTitle")}
          </h1>
          <p className="text-muted-foreground text-sm leading-relaxed">
            {t("profiles.registryRecoveryHelp")}
          </p>
        </header>
        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <Button
            className="gap-2"
            disabled={busy}
            onClick={() => void run("retry_profile_startup")}
          >
            <Icons.RefreshCw className="size-4" aria-hidden="true" />
            {t("profiles.recoveryRetry")}
          </Button>
          <Button
            className="gap-2"
            variant="outline"
            disabled={busy}
            onClick={() => void run("open_profile_data_folder")}
          >
            <Icons.FolderOpen className="size-4" aria-hidden="true" />
            {t("profiles.openDataFolder")}
          </Button>
        </div>
        <section
          className="border-border mt-7 space-y-3 border-t pt-6"
          aria-labelledby="new-profile-title"
        >
          <h2 id="new-profile-title" className="font-medium">
            {t(confirmNew ? "profiles.recoveryNewConfirmTitle" : "profiles.recoveryNewTitle")}
          </h2>
          <p className="text-muted-foreground text-sm leading-relaxed">
            {t(confirmNew ? "profiles.recoveryNewConfirmHelp" : "profiles.recoveryNewHelp")}
          </p>
          {confirmNew ? (
            <div className="flex flex-col gap-3 sm:flex-row">
              <Button disabled={busy} onClick={() => void run("start_new_profile_setup")}>
                {t("profiles.recoveryNewContinue")}
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => setConfirmNew(false)}>
                {t("profiles.cancel")}
              </Button>
            </div>
          ) : (
            <Button
              variant="secondary"
              className="gap-2"
              disabled={busy}
              onClick={() => setConfirmNew(true)}
            >
              <Icons.Plus className="size-4" aria-hidden="true" />
              {t("profiles.recoveryNewAction")}
            </Button>
          )}
        </section>
        {actionError && (
          <p role="alert" className="text-destructive mt-5 text-sm">
            {t("profiles.recoveryActionFailed")}
          </p>
        )}
        <details className="border-border text-muted-foreground mt-6 border-t pt-4 text-xs">
          <summary className="focus-visible:ring-ring cursor-pointer rounded-sm py-1 focus-visible:ring-2 focus-visible:outline-none">
            {t("profiles.recoveryDetails")}
          </summary>
          <p className="mt-3 leading-relaxed">{t("profiles.registryRecoveryInstructions")}</p>
          <pre className="bg-muted text-foreground mt-3 max-h-40 overflow-auto rounded-lg p-3 font-mono text-xs break-words whitespace-pre-wrap">
            {actionError ?? error}
          </pre>
        </details>
      </div>
    </main>
  );
}
