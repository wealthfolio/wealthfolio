import { useHealthStatus } from "@/hooks/use-health";
import { cn } from "@/lib/utils";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  buttonVariants,
} from "@wealthfolio/ui";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { HealthSeverity } from "@/lib/types";

const SEVERITY_COLORS: Record<HealthSeverity, string> = {
  CRITICAL: "text-destructive",
  ERROR: "text-destructive",
  WARNING: "text-yellow-500",
  INFO: "text-muted-foreground",
};

/**
 * Health status indicator for dashboard header.
 * Shows a warning icon when there are health issues, hidden when healthy.
 */
export function HealthStatusIndicator() {
  const { t } = useTranslation();
  const { data: status, isLoading } = useHealthStatus();

  // Don't render if loading or no issues
  if (isLoading || !status) return null;

  // Get counts with defaults for missing keys
  const counts = {
    critical: status.issueCounts.CRITICAL ?? 0,
    error: status.issueCounts.ERROR ?? 0,
    warning: status.issueCounts.WARNING ?? 0,
    info: status.issueCounts.INFO ?? 0,
  };

  const totalIssues = counts.critical + counts.error + counts.warning + counts.info;

  // Don't render if no issues
  if (totalIssues === 0) return null;

  // Determine highest severity
  const highestSeverity: HealthSeverity =
    counts.critical > 0
      ? "CRITICAL"
      : counts.error > 0
        ? "ERROR"
        : counts.warning > 0
          ? "WARNING"
          : "INFO";

  const severityColor = SEVERITY_COLORS[highestSeverity];

  // Build summary text
  const summaryParts: string[] = [];
  if (counts.critical > 0)
    summaryParts.push(t("common:component.issue_critical", { count: counts.critical }));
  if (counts.error > 0)
    summaryParts.push(t("common:component.issue_error", { count: counts.error }));
  if (counts.warning > 0)
    summaryParts.push(t("common:component.issue_warning", { count: counts.warning }));
  if (counts.info > 0) summaryParts.push(t("common:component.issue_info", { count: counts.info }));
  const summaryText = summaryParts.join(", ");

  return (
    <TooltipProvider>
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <Link
            to="/health"
            title={t("common:component.data_status")}
            className={cn(
              buttonVariants({ variant: "secondary", size: "icon-xs" }),
              "bg-secondary/50 rounded-full",
            )}
          >
            <Icons.AlertTriangle className={cn("size-5", severityColor)} />
          </Link>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <div className="space-y-1">
            <p className="font-medium">{t("common:component.health_issues")}</p>
            <p className="text-muted-foreground text-xs">{summaryText}</p>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
