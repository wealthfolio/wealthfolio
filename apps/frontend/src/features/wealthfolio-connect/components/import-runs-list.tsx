import { Badge } from "@wealthfolio/ui/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@wealthfolio/ui/components/ui/card";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@wealthfolio/ui/components/ui/collapsible";
import { format } from "date-fns";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { ImportRun, ImportRunStatus } from "../types";
import { BROKER_SYNC_RUN_FAILED_MESSAGE } from "../lib/broker-sync-messages";

interface ImportRunsListProps {
  runs: ImportRun[];
  isLoading?: boolean;
}

function buildStatusConfig(
  t: TFunction,
): Record<
  ImportRunStatus,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> {
  return {
    RUNNING: { label: t("connect:runStatus.running"), variant: "outline" },
    APPLIED: { label: t("connect:runStatus.applied"), variant: "default" },
    NEEDS_REVIEW: { label: t("connect:runStatus.needsReview"), variant: "destructive" },
    FAILED: { label: t("connect:runStatus.failed"), variant: "destructive" },
    CANCELLED: { label: t("connect:runStatus.cancelled"), variant: "secondary" },
  };
}

export function ImportRunsList({ runs, isLoading }: ImportRunsListProps) {
  const { t } = useTranslation();
  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-medium">{t("connect:syncRuns.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8">
            <Icons.Spinner className="text-muted-foreground h-6 w-6 animate-spin" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (runs.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-medium">{t("connect:syncRuns.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">{t("connect:syncRuns.empty")}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-medium">{t("connect:syncRuns.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {runs.map((run) => (
          <ImportRunItem key={run.id} run={run} />
        ))}
      </CardContent>
    </Card>
  );
}

function ImportRunItem({ run }: { run: ImportRun }) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const statusConfig = useMemo(() => buildStatusConfig(t), [t]);
  const config = statusConfig[run.status];
  const hasWarnings = run.warnings && run.warnings.length > 0;

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <div className="rounded-lg border">
        <CollapsibleTrigger asChild>
          <button className="hover:bg-accent/50 flex w-full items-center justify-between p-3">
            <div className="flex items-center gap-3">
              <div className="text-left">
                <p className="text-sm font-medium">
                  {format(new Date(run.startedAt), "MMM d, yyyy HH:mm")}
                </p>
                <p className="text-muted-foreground text-xs">
                  {run.sourceSystem} · {run.mode.toLowerCase()}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {hasWarnings && (
                <span className="text-xs text-yellow-600 dark:text-yellow-400">
                  {t("connect:syncRuns.warningsCount", { count: run.warnings?.length ?? 0 })}
                </span>
              )}
              <Badge variant={config.variant}>{config.label}</Badge>
              <Icons.ChevronDown
                className={`h-4 w-4 transition-transform ${isOpen ? "rotate-180" : ""}`}
              />
            </div>
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="border-t px-3 py-3">
            {/* Summary stats */}
            {run.summary && (
              <div className="mb-3 grid grid-cols-4 gap-2 text-center">
                <div>
                  <p className="text-lg font-semibold">{run.summary.fetched}</p>
                  <p className="text-muted-foreground text-xs">{t("connect:syncRuns.fetched")}</p>
                </div>
                <div>
                  <p className="text-lg font-semibold text-green-600">{run.summary.inserted}</p>
                  <p className="text-muted-foreground text-xs">{t("connect:syncRuns.inserted")}</p>
                </div>
                <div>
                  <p className="text-lg font-semibold text-blue-600">{run.summary.updated}</p>
                  <p className="text-muted-foreground text-xs">{t("connect:syncRuns.updated")}</p>
                </div>
                <div>
                  <p className="text-lg font-semibold text-gray-500">{run.summary.skipped}</p>
                  <p className="text-muted-foreground text-xs">{t("connect:syncRuns.skipped")}</p>
                </div>
              </div>
            )}

            {/* Warnings */}
            {hasWarnings && (
              <div className="space-y-2">
                <p className="text-sm font-medium text-yellow-600 dark:text-yellow-400">
                  {t("connect:syncRuns.warningsLabel")}
                </p>
                <ul className="space-y-1">
                  {run.warnings?.slice(0, 5).map((warning, idx) => (
                    <li key={idx} className="text-muted-foreground text-sm">
                      • {warning}
                    </li>
                  ))}
                  {(run.warnings?.length ?? 0) > 5 && (
                    <li className="text-muted-foreground text-sm">
                      • {t("connect:syncRuns.andMore", { count: (run.warnings?.length ?? 0) - 5 })}
                    </li>
                  )}
                </ul>
                <Link
                  to={`/activities?account=${run.accountId}`}
                  className="text-primary mt-2 inline-flex items-center gap-1 text-sm hover:underline"
                >
                  {t("connect:syncRuns.reviewActivities")}
                  <Icons.ArrowRight className="h-3 w-3" />
                </Link>
              </div>
            )}

            {/* Error */}
            {run.error && (
              <div className="rounded-md bg-red-50 p-2 dark:bg-red-900/20">
                <p className="text-sm text-red-600 dark:text-red-400">
                  {BROKER_SYNC_RUN_FAILED_MESSAGE}
                </p>
              </div>
            )}

            {/* Timing info */}
            <p className="text-muted-foreground mt-2 text-xs">
              {t("connect:syncRuns.duration")}{" "}
              {run.finishedAt
                ? `${Math.round((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)}s`
                : t("connect:syncRuns.inProgress")}
            </p>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
