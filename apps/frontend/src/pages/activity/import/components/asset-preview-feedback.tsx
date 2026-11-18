import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNumberFormatting } from "@wealthfolio/ui";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Progress } from "@wealthfolio/ui/components/ui/progress";
import { copyText } from "@wealthfolio/ui/lib/clipboard";
import type { AssetPreviewProgress } from "../context/import-context";
import type { AssetPreviewError } from "../utils/asset-preview-error";
import { ImportAlert } from "./import-alert";

interface AssetPreviewFeedbackProps {
  total: number;
  remaining: number;
  isChecking: boolean;
  progress: AssetPreviewProgress | null;
  error: AssetPreviewError | null;
  onRetry: () => void;
}

const ERROR_KEYS = {
  timeout: ["timeoutTitle", "timeoutDescription"],
  network: ["networkTitle", "networkDescription"],
  provider: ["providerTitle", "providerDescription"],
  too_large: ["tooLargeTitle", "tooLargeDescription"],
  failed: ["previewFailedTitle", "failedDescription"],
} as const;

export function AssetPreviewFeedback({
  total,
  remaining,
  isChecking,
  progress,
  error,
  onRetry,
}: AssetPreviewFeedbackProps) {
  const { t } = useTranslation();
  const numbers = useNumberFormatting();
  const labelId = useId();
  const [now, setNow] = useState(Date.now);
  const [copyResult, setCopyResult] = useState<"copied" | "copyFailed" | null>(null);
  useEffect(() => {
    if (!isChecking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [isChecking, progress?.startedAt]);
  useEffect(() => setCopyResult(null), [error]);

  if (!isChecking && !error && remaining === 0) return null;

  const completed = total - remaining;
  const elapsed = progress
    ? Math.max(0, Math.floor(((progress.finishedAt ?? now) - progress.startedAt) / 1000))
    : 0;
  const slow = isChecking && elapsed >= 30;
  const format = (value: number) => numbers.formatDecimal(value, { maximumFractionDigits: 0 });
  const titleKey = error
    ? ERROR_KEYS[error.kind][0]
    : slow
      ? "slowTitle"
      : isChecking
        ? "checkingTitle"
        : "continueCheckingTitle";
  const descriptionKey = error
    ? ERROR_KEYS[error.kind][1]
    : slow
      ? "slowDescription"
      : isChecking
        ? "checkingDescription"
        : "partialDescription";
  const diagnostics = [
    "step=asset_preview",
    `result=${error?.kind ?? "incomplete"}`,
    ...(error?.httpStatus ? [`http_status=${error.httpStatus}`] : []),
    `assets_checked=${completed}/${total}`,
    `elapsed_seconds=${elapsed}`,
  ].join("\n");

  return (
    <div className="space-y-3" data-testid="asset-preview-feedback">
      <ImportAlert
        role={error ? "alert" : "status"}
        variant={error || slow ? "warning" : "info"}
        icon={isChecking ? Icons.Clock : undefined}
        title={t(`activity:import.assets.${titleKey}`)}
        description={t(`activity:import.assets.${descriptionKey}`)}
        className="mb-0"
      >
        {!isChecking && (remaining > 0 || error) && (
          <Button
            size="sm"
            className="mt-3 h-auto min-h-9 max-w-full whitespace-normal"
            onClick={onRetry}
          >
            <Icons.RefreshCw className="me-2 size-4" aria-hidden="true" />
            {remaining > 0
              ? t("activity:import.assets.retryRemaining", { remaining: format(remaining) })
              : t("activity:import.assets.retry")}
          </Button>
        )}
      </ImportAlert>
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span id={labelId} role="status" aria-live="polite">
            {t("activity:import.assets.checked", {
              completed: format(completed),
              total: format(total),
            })}
          </span>
          <span className="text-muted-foreground text-xs">
            {t("activity:import.assets.elapsed", { seconds: format(elapsed) })}
          </span>
        </div>
        <Progress value={completed} max={total} aria-labelledby={labelId} className="h-2" />
        <p className="text-muted-foreground text-xs">
          {t("activity:import.assets.savedDescription")}
        </p>
        {isChecking && completed > 0 && (
          <p className="text-muted-foreground text-xs">
            {t("activity:import.assets.editingPaused")}
          </p>
        )}
      </div>
      {error && (
        <details className="text-sm">
          <summary className="cursor-pointer py-2">
            {t("activity:import.assets.technicalDetails")}
          </summary>
          <div className="space-y-3">
            <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs" dir="ltr">
              {diagnostics}
            </pre>
            <p className="text-muted-foreground text-xs">
              {t("activity:import.assets.selfHostedHelp")}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                try {
                  await copyText(diagnostics);
                  setCopyResult("copied");
                } catch {
                  setCopyResult("copyFailed");
                }
              }}
            >
              <Icons.Copy className="me-2 size-4" aria-hidden="true" />
              {t("activity:import.assets.copyDiagnostics")}
            </Button>
            {copyResult && <p role="status">{t(`activity:import.assets.${copyResult}`)}</p>}
          </div>
        </details>
      )}
    </div>
  );
}
