// PairingResult
// Shows success or error state after pairing
// ==========================================

import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui";
import { logSyncError, userFacingSyncErrorMessage } from "../../utils/error-messages";

interface PairingResultProps {
  success: boolean;
  error?: string | null;
  onRetry?: () => void;
  onDone?: () => void;
  retryLabel?: string;
  doneLabel?: string;
}

function formatError(error: string | null | undefined): string {
  return userFacingSyncErrorMessage(error);
}

export function PairingResult({
  success,
  error,
  onRetry,
  onDone,
  retryLabel,
  doneLabel,
}: PairingResultProps) {
  const { t } = useTranslation();
  const hasCalledDone = useRef(false);

  useEffect(() => {
    if (!error) return;
    logSyncError("Pairing failed", error);
  }, [error]);

  // Auto-close on success - call immediately
  useEffect(() => {
    if (success && onDone && !hasCalledDone.current) {
      hasCalledDone.current = true;
      // Small delay just to flash success state
      const timer = setTimeout(onDone, 800);
      return () => clearTimeout(timer);
    }
  }, [success, onDone]);

  if (success) {
    return (
      <div className="flex flex-col items-center px-4 py-6">
        <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30">
          <Icons.CheckCircle className="h-10 w-10 text-green-600 dark:text-green-500" />
        </div>
        <div className="mb-6 text-center">
          <p className="text-foreground text-lg font-semibold">{t("sync:result.allSet")}</p>
          <p className="text-muted-foreground mt-2 text-sm">
            {t("sync:result.connectedSuccessfully")}
          </p>
        </div>
        <Button className="w-full max-w-[200px]" onClick={onDone}>
          {t("sync:result.done")}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center px-4 py-6">
      <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/30">
        <Icons.XCircle className="h-10 w-10 text-red-600 dark:text-red-500" />
      </div>
      <div className="mb-6 text-center">
        <p className="text-foreground text-base font-semibold">
          {t("sync:result.connectionFailed")}
        </p>
        <p className="text-muted-foreground mt-2 max-h-40 max-w-[320px] overflow-y-auto whitespace-pre-wrap break-words text-sm">
          {formatError(error)}
        </p>
      </div>
      <div className="flex gap-3">
        {onRetry && (
          <Button variant="outline" onClick={onRetry}>
            {retryLabel ?? t("sync:result.tryAgain")}
          </Button>
        )}
        <Button variant={onRetry ? "ghost" : "default"} onClick={onDone}>
          {doneLabel ?? (onRetry ? t("common:cancel") : t("common:close"))}
        </Button>
      </div>
    </div>
  );
}
