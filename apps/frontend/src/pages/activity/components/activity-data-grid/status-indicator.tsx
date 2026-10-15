import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@wealthfolio/ui";
import { useTranslation } from "react-i18next";
import type { LocalTransaction } from "./types";
import { getProviderMappingReasons, isPendingReview } from "./types";

interface StatusIndicatorProps {
  transaction: LocalTransaction;
}

/**
 * Shows a visual indicator for transactions that are pending review
 * (synced from broker but not yet approved by the user)
 */
export function StatusIndicator({ transaction }: StatusIndicatorProps) {
  const { t } = useTranslation();

  if (!isPendingReview(transaction)) {
    return null;
  }

  const mappingReasons = getProviderMappingReasons(transaction);
  const genericReason = [
    t("activity:datagrid.status_tooltip_line1"),
    t("activity:datagrid.status_tooltip_line2"),
  ].join(" ");
  const accessibleLabel = `${t("activity:detail.needs_review")}: ${
    mappingReasons.length > 0 ? mappingReasons.join("; ") : genericReason
  }`;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={accessibleLabel}
              className="text-destructive focus-visible:ring-ring flex size-full cursor-help items-center justify-center rounded-sm focus-visible:outline-none focus-visible:ring-2"
            />
          }
        >
          <span aria-hidden="true">●</span>
        </TooltipTrigger>
        <TooltipContent side="right" className="max-w-80">
          {mappingReasons.length > 0 ? (
            <ul className="list-disc space-y-1 pl-4">
              {mappingReasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : (
            <>
              <p>{t("activity:datagrid.status_tooltip_line1")}</p>
              <p>{t("activity:datagrid.status_tooltip_line2")}</p>
            </>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
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

  const accessibleLabel = [
    t("activity:datagrid.status_tooltip_line1"),
    t("activity:datagrid.status_tooltip_line2"),
  ].join(" ");

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={accessibleLabel}
              className="text-destructive focus-visible:ring-ring w-full cursor-help rounded-sm text-center focus-visible:outline-none focus-visible:ring-2"
            />
          }
        >
          <span aria-hidden="true">●</span>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p>{t("activity:datagrid.status_tooltip_line1")}</p>
          <p>{t("activity:datagrid.status_tooltip_line2")}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
