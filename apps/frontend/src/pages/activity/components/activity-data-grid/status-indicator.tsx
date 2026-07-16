import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@wealthfolio/ui";
import { useTranslation } from "react-i18next";
import type { LocalTransaction } from "./types";
import { isPendingReview } from "./types";

interface StatusIndicatorProps {
  transaction: LocalTransaction;
}

/**
 * Shows a visual indicator for transactions that are pending review
 * (synced from broker but not yet approved by the user)
 */
export function StatusIndicator({ transaction }: StatusIndicatorProps) {
  if (!isPendingReview(transaction)) {
    return null;
  }

  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="text-destructive w-full cursor-help text-center">●</div>
    </div>
  );
}

interface StatusHeaderIndicatorProps {
  hasRowsToReview: boolean;
}

/**
 * Shows a visual indicator in the header when any visible rows need review
 */
export function StatusHeaderIndicator({ hasRowsToReview }: StatusHeaderIndicatorProps) {
  const { t } = useTranslation();

  if (!hasRowsToReview) {
    return null;
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="text-destructive w-full cursor-help text-center">●</div>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p>{t("activity:datagrid.status_tooltip_line1")}</p>
          <p>{t("activity:datagrid.status_tooltip_line2")}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
