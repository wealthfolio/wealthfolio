import { useTranslation } from "react-i18next";
import { Icons } from "@wealthfolio/ui/components/ui/icons";

export type BackupFailure = string | { cause: unknown; message?: string };

/** Keep translated form validation inline and backend diagnostics opt-in. */
export function BackupError({ error }: { error: BackupFailure }) {
  const { t } = useTranslation();
  const message =
    typeof error === "string" ? error : (error.message ?? t("settings:backup_action_failed"));
  const cause = typeof error === "string" ? null : error.cause;
  const details = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";

  return (
    <>
      <span>{message}</span>
      {details.trim() && details !== message && (
        <details className="group mt-1 text-xs">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 opacity-80 hover:opacity-100 [&::-webkit-details-marker]:hidden">
            <Icons.ChevronRight
              className="size-3.5 transition-transform group-open:rotate-90 rtl:rotate-180"
              aria-hidden
            />
            {t("settings:recovery_details")}
          </summary>
          <p className="mt-1.5 font-mono break-words whitespace-pre-wrap opacity-90">{details}</p>
        </details>
      )}
    </>
  );
}
