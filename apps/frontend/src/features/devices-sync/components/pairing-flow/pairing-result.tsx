// PairingResult
// Shows success or error state after pairing
// ==========================================

import { Button } from "@wealthfolio/ui/components/ui/button";
import { useEffect, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { logSyncError, userFacingSyncErrorMessage } from "../../utils/error-messages";
import { FlowIcon, FlowScreen } from "../flow-layout";

interface PairingResultProps {
  success: boolean;
  error?: string | null;
  onRetry?: () => void;
  onDone?: () => void;
  retryLabel?: string;
  doneLabel?: string;
  title?: string;
  description?: string;
  icon?: ReactNode;
}

export function PairingResult({
  success,
  error,
  onRetry,
  onDone,
  retryLabel,
  doneLabel,
  title,
  description,
  icon,
}: PairingResultProps) {
  const { t } = useTranslation();

  useEffect(() => {
    if (!error) return;
    logSyncError("Pairing failed", error);
  }, [error]);

  if (success) {
    return (
      <FlowScreen
        tone="success"
        icon={icon ?? <FlowIcon kind="success" />}
        title={title ?? t("sync:result.allSet")}
        description={description ?? t("sync:result.connectedSuccessfully")}
        actions={
          <Button className="w-full" onClick={onDone}>
            {doneLabel ?? t("sync:result.done")}
          </Button>
        }
      />
    );
  }

  return (
    <FlowScreen
      tone="error"
      icon={icon ?? <FlowIcon kind="error" />}
      title={title ?? t("sync:result.connectionFailed")}
      description={description ?? userFacingSyncErrorMessage(error)}
      actions={
        <>
          {onRetry && (
            <Button className="w-full" onClick={onRetry}>
              {retryLabel ?? t("sync:result.tryAgain")}
            </Button>
          )}
          <Button variant={onRetry ? "ghost" : "default"} className="w-full" onClick={onDone}>
            {doneLabel ?? (onRetry ? t("common:cancel") : t("common:close"))}
          </Button>
        </>
      }
    />
  );
}
