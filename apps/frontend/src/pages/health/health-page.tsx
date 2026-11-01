import {
  useDismissHealthIssue,
  useExecuteHealthFix,
  useHealthStatus,
  useRunHealthChecks,
} from "@/hooks/use-health";
import { HOVER_SLOT } from "@/lib/hover-slot";
import type { HealthCategory, HealthIssue, HealthSeverity } from "@/lib/types";
import {
  Badge,
  Button,
  Icons,
  Page,
  PageContent,
  PageHeader,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  useDateFormatting,
  Spinner,
} from "@wealthfolio/ui";
import { cn } from "@wealthfolio/ui/lib/utils";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { IssueDetailSheet } from "./components/issue-detail-sheet";
import { translateIssueText } from "./translate-issue";
import { cardSurfaceClassName } from "@wealthfolio/ui/components/ui/card";

const SEVERITY_LABEL_KEYS: Record<HealthSeverity, string> = {
  INFO: "severity.info",
  WARNING: "severity.warning",
  ERROR: "severity.error",
  CRITICAL: "severity.critical",
};

const CATEGORY_LABEL_KEYS: Record<HealthCategory, string> = {
  PRICE_STALENESS: "category.prices",
  FX_INTEGRITY: "category.fxRates",
  CLASSIFICATION: "category.categories",
  DATA_CONSISTENCY: "category.data",
  ACCOUNT_CONFIGURATION: "category.accounts",
  SETTINGS_CONFIGURATION: "category.settings",
};

const SEVERITY_CONFIG: Record<
  HealthSeverity,
  { label: string; bgColor: string; textColor: string; dotColor: string }
> = {
  INFO: {
    label: "Info",
    bgColor: "bg-muted",
    textColor: "text-muted-foreground",
    dotColor: "bg-muted-foreground",
  },
  WARNING: {
    label: "Warning",
    bgColor: "bg-warning-subtle",
    textColor: "text-warning-subtle-foreground",
    dotColor: "bg-warning",
  },
  ERROR: {
    label: "Error",
    bgColor: "bg-destructive-subtle",
    textColor: "text-destructive-subtle-foreground",
    dotColor: "bg-destructive",
  },
  CRITICAL: {
    label: "Critical",
    bgColor: "bg-destructive-subtle",
    textColor: "text-destructive-subtle-foreground",
    dotColor: "bg-destructive",
  },
};

const CATEGORY_CONFIG: Record<HealthCategory, { label: string; icon: keyof typeof Icons }> = {
  PRICE_STALENESS: { label: "Prices", icon: "TrendingUp" },
  FX_INTEGRITY: { label: "FX Rates", icon: "ArrowLeftRight" },
  CLASSIFICATION: { label: "Categories", icon: "Tag" },
  DATA_CONSISTENCY: { label: "Data", icon: "Database" },
  ACCOUNT_CONFIGURATION: { label: "Accounts", icon: "Settings" },
  SETTINGS_CONFIGURATION: { label: "Settings", icon: "Settings" },
};

export function getCategoryConfig(issue: HealthIssue): { label: string; icon: keyof typeof Icons } {
  return CATEGORY_CONFIG[issue.category];
}

function SeverityDot({ severity }: { severity: HealthSeverity }) {
  const config = SEVERITY_CONFIG[severity];
  return <span className={cn("h-2 w-2 shrink-0 rounded-full", config.dotColor)} />;
}

function HealthIssueRow({
  issue,
  onClick,
  onDismiss,
  onFix,
  isDismissing,
  isFixing,
}: {
  issue: HealthIssue;
  onClick: () => void;
  onDismiss: () => void;
  onFix: () => void;
  isDismissing: boolean;
  isFixing: boolean;
}) {
  const { t } = useTranslation();
  const categoryConfig = getCategoryConfig(issue);
  const CategoryIcon = Icons[categoryConfig.icon];
  const categoryLabel = t(`health:${CATEGORY_LABEL_KEYS[issue.category]}`);
  const hasDiagnosticActions =
    issue.diagnostics?.some((diagnostic) => diagnostic.actions.length > 0) ?? false;
  const showQuickFix = Boolean(issue.fixAction && !hasDiagnosticActions);

  return (
    <div
      className="hover:bg-muted/50 group/row flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors"
      onClick={onClick}
    >
      <SeverityDot severity={issue.severity} />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="line-clamp-2 text-sm font-medium sm:line-clamp-1">
            {translateIssueText(t, issue, "title")}
          </span>
          {issue.affectedCount > 0 && (
            <Badge variant="secondary" className="text-2xs h-5 shrink-0 px-1.5 font-medium">
              {issue.affectedCount}
            </Badge>
          )}
        </div>
        <p className="text-muted-foreground mt-0.5 line-clamp-1 text-xs">
          {translateIssueText(t, issue, "message")}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {/* On a phone the title needs the room; the issue's sheet names its category. */}
        <Tooltip>
          <TooltipTrigger
            render={
              <Badge
                variant="outline"
                className="text-muted-foreground text-2xs hidden h-6 gap-1 px-2 font-normal sm:inline-flex"
              />
            }
          >
            <CategoryIcon className="h-3 w-3" />
            {categoryLabel}
          </TooltipTrigger>
          <TooltipContent side="top">{categoryLabel}</TooltipContent>
        </Tooltip>

        {showQuickFix && (
          <Button
            size="sm"
            variant="secondary"
            className="h-7 px-2.5 text-xs"
            onClick={(e: React.MouseEvent) => {
              e.stopPropagation();
              onFix();
            }}
            disabled={isFixing}
          >
            {isFixing ? (
              <Spinner className="h-3 w-3" />
            ) : (
              <>
                <Icons.Wand2 className="me-1 h-3 w-3" />
                {t("health:actions.fix")}
              </>
            )}
          </Button>
        )}
        <Button
          size="icon"
          variant="ghost"
          // Shown on touch screens, which can't hover to reveal it.
          className={cn("text-muted-foreground h-7 w-7", HOVER_SLOT)}
          onClick={(e: React.MouseEvent) => {
            e.stopPropagation();
            onDismiss();
          }}
          disabled={isDismissing}
          aria-label={t("health:detail.dismiss")}
        >
          {isDismissing ? <Spinner className="h-3.5 w-3.5" /> : <Icons.X className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  );
}

function StatusSummary({
  counts,
  selectedSeverity,
  onSeverityClick,
}: {
  counts: Partial<Record<HealthSeverity, number>>;
  selectedSeverity: HealthSeverity | null;
  onSeverityClick: (severity: HealthSeverity | null) => void;
}) {
  const { t } = useTranslation();
  const totalIssues = Object.values(counts).reduce((a, b) => (a ?? 0) + (b ?? 0), 0);

  if (totalIssues === 0) {
    return null;
  }

  const severities: HealthSeverity[] = ["CRITICAL", "ERROR", "WARNING", "INFO"];

  return (
    <div className="flex items-center gap-1">
      {severities.map((severity) => {
        const count = counts[severity] ?? 0;
        if (count === 0) return null;
        const config = SEVERITY_CONFIG[severity];
        const severityLabel = t(`health:${SEVERITY_LABEL_KEYS[severity]}`);
        const isActive = selectedSeverity === severity;

        return (
          <button
            key={severity}
            onClick={() => onSeverityClick(isActive ? null : severity)}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-all",
              config.bgColor,
              config.textColor,
              isActive && "ring-2 ring-current ring-offset-1",
            )}
          >
            <SeverityDot severity={severity} />
            <span>{count}</span>
            <span className="hidden sm:inline">{severityLabel}</span>
          </button>
        );
      })}
      {selectedSeverity && (
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground ms-1 h-7 px-2 text-xs"
          onClick={() => onSeverityClick(null)}
        >
          {t("health:actions.clear")}
        </Button>
      )}
    </div>
  );
}

function HealthyState() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center py-20">
      <div className="text-success-subtle-foreground mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-current/15">
        <Icons.CheckCircle className="h-8 w-8" />
      </div>
      <h2 className="mb-2 text-lg font-semibold">{t("health:healthy.title")}</h2>
      <p className="text-muted-foreground max-w-sm text-center text-sm">
        {t("health:healthy.description")}
      </p>
    </div>
  );
}

export default function HealthPage() {
  const formatting = useDateFormatting();
  const { t } = useTranslation();
  const [selectedSeverity, setSelectedSeverity] = useState<HealthSeverity | null>(null);
  const [selectedIssue, setSelectedIssue] = useState<HealthIssue | null>(null);

  const { data: status, isLoading, error } = useHealthStatus();
  const runChecksMutation = useRunHealthChecks();
  const dismissMutation = useDismissHealthIssue();
  const fixMutation = useExecuteHealthFix();

  const handleRefresh = () => {
    runChecksMutation.mutate();
  };

  const filteredIssues = status?.issues.filter((issue) => {
    if (selectedSeverity && issue.severity !== selectedSeverity) return false;
    return true;
  });

  const headerActions = (
    <div className="flex items-center gap-2">
      <Button
        variant="ghost"
        size="sm"
        onClick={handleRefresh}
        disabled={runChecksMutation.isPending}
        className="h-8"
        aria-label={t("common:refresh")}
      >
        {runChecksMutation.isPending ? (
          <Spinner className="h-4 w-4" />
        ) : (
          <Icons.RefreshCw className="h-4 w-4" />
        )}
      </Button>
    </div>
  );

  if (error) {
    return (
      <Page>
        <PageHeader
          heading={t("health:page.heading")}
          text={t("health:page.text")}
          actions={headerActions}
        />
        <PageContent className="pt-4">
          <div className="flex min-h-75 flex-col items-center justify-center">
            <div className="text-destructive-subtle-foreground mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-current/15">
              <Icons.AlertCircle className="h-6 w-6" />
            </div>
            <h2 className="mb-1 text-base font-medium">{t("health:loadError.title")}</h2>
            <p className="text-muted-foreground mb-4 text-sm">{error.message}</p>
            <Button size="sm" variant="outline" onClick={handleRefresh}>
              <Icons.RefreshCw className="me-2 h-3.5 w-3.5" />
              {t("health:loadError.retry")}
            </Button>
          </div>
        </PageContent>
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader
        heading={t("health:page.heading")}
        text={t("health:page.text")}
        actions={headerActions}
      />
      <PageContent className="mt-6">
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-10 w-48 rounded-lg" />
            <Skeleton className="h-14 rounded-lg" />
            <Skeleton className="h-14 rounded-lg" />
            <Skeleton className="h-14 rounded-lg" />
          </div>
        ) : status ? (
          <div className="space-y-4">
            {/* Summary Bar */}
            <div className="flex items-center justify-between">
              <StatusSummary
                counts={status.issueCounts}
                selectedSeverity={selectedSeverity}
                onSeverityClick={setSelectedSeverity}
              />
              {status.checkedAt && (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span className="text-muted-foreground flex cursor-default items-center gap-1.5 text-xs" />
                    }
                  >
                    {status.isStale && <Icons.AlertCircle className="text-warning h-3 w-3" />}
                    {t("health:updatedAt", {
                      time: formatting.formatTime(status.checkedAt, {
                        hour: "2-digit",
                        minute: "2-digit",
                      }),
                    })}
                  </TooltipTrigger>
                  <TooltipContent>{formatting.formatDateTime(status.checkedAt)}</TooltipContent>
                </Tooltip>
              )}
            </div>

            {/* Issues List */}
            <div className={cardSurfaceClassName}>
              {filteredIssues && filteredIssues.length > 0 ? (
                <div className="divide-y">
                  {filteredIssues.map((issue) => (
                    <HealthIssueRow
                      key={issue.id}
                      issue={issue}
                      onClick={() => setSelectedIssue(issue)}
                      onDismiss={() =>
                        dismissMutation.mutate({
                          issueId: issue.id,
                          dataHash: issue.dataHash,
                        })
                      }
                      onFix={() => issue.fixAction && fixMutation.mutate(issue.fixAction)}
                      isDismissing={dismissMutation.isPending}
                      isFixing={fixMutation.isPending}
                    />
                  ))}
                </div>
              ) : (
                <HealthyState />
              )}
            </div>
          </div>
        ) : null}
      </PageContent>

      <IssueDetailSheet
        issue={selectedIssue}
        open={selectedIssue !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedIssue(null);
        }}
        onDismiss={() => {
          if (selectedIssue) {
            dismissMutation.mutate({
              issueId: selectedIssue.id,
              dataHash: selectedIssue.dataHash,
            });
          }
        }}
        onFix={() => {
          if (selectedIssue?.fixAction) {
            fixMutation.mutate(selectedIssue.fixAction);
          }
        }}
        onRunFixAction={(action) => fixMutation.mutate(action)}
        isDismissing={dismissMutation.isPending}
        isFixing={fixMutation.isPending}
      />
    </Page>
  );
}
