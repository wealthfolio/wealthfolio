import { useHealthStatus } from "@/hooks/use-health";
import { cn } from "@/lib/utils";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@wealthfolio/ui";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { HealthSeverity } from "@/lib/types";

const SEVERITY_COLORS: Record<HealthSeverity, string> = {
  CRITICAL: "text-destructive-subtle-foreground",
  ERROR: "text-destructive-subtle-foreground",
  WARNING: "text-warning-subtle-foreground",
  INFO: "text-muted-foreground",
};

// A 32px tinted circle; on touch and narrow screens an invisible layer gives it a 48px tap area.
const BADGE_CLASS =
  "relative flex size-8 shrink-0 items-center justify-center rounded-full bg-current/15 pointer-coarse:after:absolute pointer-coarse:after:-inset-2 max-lg:after:absolute max-lg:after:-inset-2";

interface HealthStatusIndicatorProps {
  /** A notice about the figure itself (Net worth's stale valuations), shown in the same badge. */
  figureNotice?: ReactNode;
}

/**
 * Status badge beside a headline amount: health issues and any notice about that
 * figure share one badge. Hidden when there is nothing to report.
 */
export function HealthStatusIndicator({ figureNotice }: HealthStatusIndicatorProps) {
  const { t } = useTranslation();
  const { data: status, isLoading } = useHealthStatus();

  const counts = {
    critical: status?.issueCounts.CRITICAL ?? 0,
    error: status?.issueCounts.ERROR ?? 0,
    warning: status?.issueCounts.WARNING ?? 0,
    info: status?.issueCounts.INFO ?? 0,
  };
  const totalIssues =
    isLoading || !status ? 0 : counts.critical + counts.error + counts.warning + counts.info;

  if (totalIssues === 0 && !figureNotice) return null;

  // A figure notice is a warning, so it never shows as the quieter info colour.
  const highestSeverity: HealthSeverity =
    counts.critical > 0
      ? "CRITICAL"
      : counts.error > 0
        ? "ERROR"
        : counts.warning > 0 || figureNotice
          ? "WARNING"
          : "INFO";

  const summaryParts: string[] = [];
  if (counts.critical > 0)
    summaryParts.push(t("common:component.issue_critical", { count: counts.critical }));
  if (counts.error > 0)
    summaryParts.push(t("common:component.issue_error", { count: counts.error }));
  if (counts.warning > 0)
    summaryParts.push(t("common:component.issue_warning", { count: counts.warning }));
  if (counts.info > 0) summaryParts.push(t("common:component.issue_info", { count: counts.info }));
  const summaryText = summaryParts.join(", ");

  const badgeClassName = cn(BADGE_CLASS, SEVERITY_COLORS[highestSeverity]);

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          delay={300}
          render={
            totalIssues > 0 ? (
              <Link
                to="/health"
                title={t("common:component.data_status")}
                aria-label={`${t("common:component.health_issues")}: ${summaryText}`}
                className={badgeClassName}
              />
            ) : (
              // A button, so keyboard and screen-reader users reach the notice too.
              <button
                type="button"
                aria-label={t("common:component.data_status")}
                className={badgeClassName}
              />
            )
          }
        >
          <Icons.AlertTriangle className="size-4" />
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-70">
          <div className="space-y-2">
            {totalIssues > 0 && (
              <div className="space-y-1">
                <p className="font-medium">{t("common:component.health_issues")}</p>
                <p className="text-background/70 text-xs">{summaryText}</p>
              </div>
            )}
            {figureNotice}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
