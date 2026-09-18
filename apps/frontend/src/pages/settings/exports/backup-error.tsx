import { useTranslation } from "react-i18next";

export type BackupFailure = string | { cause: unknown };

/** Keep translated form validation inline and backend diagnostics opt-in. */
export function BackupError({ error }: { error: BackupFailure }) {
  const { t } = useTranslation();
  const message = typeof error === "string" ? error : t("settings:backup_action_failed");
  const cause = typeof error === "string" ? null : error.cause;
  const details = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";

  return (
    <>
      <span>{message}</span>
      {details.trim() && details !== message && (
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer">{t("settings:recovery_details")}</summary>
          <p className="mt-2 whitespace-pre-wrap break-words">{details}</p>
        </details>
      )}
    </>
  );
}
