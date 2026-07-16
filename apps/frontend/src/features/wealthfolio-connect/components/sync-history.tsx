import { Badge } from "@wealthfolio/ui/components/ui/badge";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@wealthfolio/ui/components/ui/card";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import { format, formatDistanceToNow } from "date-fns";
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useImportRunsInfinite } from "../hooks";
import type { ImportRun, ImportRunStatus } from "../types";
import { BROKER_SYNC_RUN_FAILED_MESSAGE } from "../lib/broker-sync-messages";

function buildStatusConfig(t: TFunction): Record<
  ImportRunStatus,
  {
    label: string;
    variant: "default" | "secondary" | "destructive" | "outline";
    icon: typeof Icons.Check;
  }
> {
  return {
    RUNNING: { label: t("connect:status.syncing"), variant: "outline", icon: Icons.Spinner },
    APPLIED: { label: t("connect:syncHistory.success"), variant: "default", icon: Icons.Check },
    NEEDS_REVIEW: {
      label: t("connect:syncHistory.review"),
      variant: "destructive",
      icon: Icons.AlertTriangle,
    },
    FAILED: { label: t("connect:status.failed"), variant: "destructive", icon: Icons.X },
    CANCELLED: {
      label: t("connect:runStatus.cancelled"),
      variant: "secondary",
      icon: Icons.X,
    },
  };
}

interface SyncHistoryProps {
  pageSize?: number;
}

export function SyncHistory({ pageSize = 10 }: SyncHistoryProps) {
  const { t } = useTranslation();
  const { data, isLoading, isFetchingNextPage, hasNextPage, fetchNextPage } = useImportRunsInfinite(
    { pageSize },
  );

  const runs = useMemo(() => {
    if (!data?.pages) return [];
    return data.pages.flat();
  }, [data]);

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base font-semibold">
            <Icons.History className="h-5 w-5" />
            {t("connect:syncHistory.title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {[...Array(3)].map((_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </CardContent>
      </Card>
    );
  }

  if (runs.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base font-semibold">
            <Icons.History className="h-5 w-5" />
            {t("connect:syncHistory.title")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <Icons.Clock className="text-muted-foreground mb-3 h-10 w-10" />
            <p className="text-muted-foreground text-sm">{t("connect:syncHistory.emptyTitle")}</p>
            <p className="text-muted-foreground/70 mt-1 text-xs">
              {t("connect:syncHistory.emptyDescription")}
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base font-semibold">
            <Icons.History className="h-5 w-5" />
            {t("connect:syncHistory.title")}
          </CardTitle>
          <span className="text-muted-foreground text-xs">
            {t("connect:syncHistory.runCount", { count: runs.length })}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {runs.map((run) => (
          <SyncRunItem key={run.id} run={run} />
        ))}

        {hasNextPage && (
          <Button
            variant="ghost"
            className="w-full"
            onClick={() => fetchNextPage()}
            disabled={isFetchingNextPage}
          >
            {isFetchingNextPage ? (
              <>
                <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                {t("common:loading")}
              </>
            ) : (
              <>
                <Icons.ChevronDown className="mr-2 h-4 w-4" />
                {t("connect:syncHistory.loadMore")}
              </>
            )}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function SyncRunItem({ run }: { run: ImportRun }) {
  const { t } = useTranslation();
  const statusConfig = useMemo(() => buildStatusConfig(t), [t]);
  const config = statusConfig[run.status];
  const StatusIcon = config.icon;
  const hasWarnings = run.warnings && run.warnings.length > 0;

  const duration = useMemo(() => {
    if (!run.finishedAt) return null;
    const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
    if (ms < 1000) return t("connect:syncHistory.lessThanOneSecond");
    return `${Math.round(ms / 1000)}s`;
  }, [run.startedAt, run.finishedAt, t]);

  const timeAgo = useMemo(() => {
    return formatDistanceToNow(new Date(run.startedAt), { addSuffix: true });
  }, [run.startedAt]);

  return (
    <div className="hover:bg-muted/50 group rounded-lg border p-3 transition-colors">
      <div className="flex items-start justify-between gap-3">
        {/* Left: Status icon + info */}
        <div className="flex items-start gap-3">
          <div
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
              run.status === "APPLIED"
                ? "bg-green-100 text-green-600 dark:bg-green-900/30 dark:text-green-400"
                : run.status === "RUNNING"
                  ? "bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400"
                  : run.status === "NEEDS_REVIEW"
                    ? "bg-yellow-100 text-yellow-600 dark:bg-yellow-900/30 dark:text-yellow-400"
                    : run.status === "FAILED"
                      ? "bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400"
                      : "bg-muted text-muted-foreground"
            }`}
          >
            <StatusIcon className={`h-4 w-4 ${run.status === "RUNNING" ? "animate-spin" : ""}`} />
          </div>

          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{run.sourceSystem}</span>
              <Badge variant={config.variant} className="text-xs">
                {config.label}
              </Badge>
              {hasWarnings && (
                <span className="flex items-center gap-1 text-xs text-yellow-600 dark:text-yellow-400">
                  <Icons.AlertTriangle className="h-3 w-3" />
                  {run.warnings?.length}
                </span>
              )}
            </div>

            <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
              <span>{timeAgo}</span>
              <span className="text-muted-foreground/50">&middot;</span>
              <span>{format(new Date(run.startedAt), "MMM d, HH:mm")}</span>
              {duration && (
                <>
                  <span className="text-muted-foreground/50">&middot;</span>
                  <span>{duration}</span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Right: Summary stats */}
        {run.summary && (
          <div className="flex shrink-0 items-center gap-3 text-xs">
            <div className="text-center">
              <p className="font-semibold text-green-600 dark:text-green-400">
                +{run.summary.inserted}
              </p>
              <p className="text-muted-foreground">{t("connect:syncHistory.new")}</p>
            </div>
            <div className="text-center">
              <p className="font-semibold text-blue-600 dark:text-blue-400">
                {run.summary.updated}
              </p>
              <p className="text-muted-foreground">{t("connect:syncHistory.updated")}</p>
            </div>
            {run.summary.skipped > 0 && (
              <div className="text-center">
                <p className="text-muted-foreground font-semibold">{run.summary.skipped}</p>
                <p className="text-muted-foreground">{t("connect:syncHistory.skipped")}</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Error message */}
      {run.error && (
        <div className="mt-2 rounded-md bg-red-50 p-2 dark:bg-red-900/20">
          <p className="text-xs text-red-600 dark:text-red-400">{BROKER_SYNC_RUN_FAILED_MESSAGE}</p>
        </div>
      )}

      {/* Warnings preview */}
      {hasWarnings && (
        <div className="mt-2 space-y-1">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-yellow-600 dark:text-yellow-400">
              {t("connect:syncHistory.warningsCount", { count: run.warnings?.length ?? 0 })}
            </p>
            <Link
              to={`/activities?account=${run.accountId}&needsReview=true`}
              className="text-primary flex items-center gap-1 text-xs hover:underline"
            >
              {t("connect:syncHistory.review")}
              <Icons.ArrowRight className="h-3 w-3" />
            </Link>
          </div>
          <ul className="text-muted-foreground space-y-0.5 text-xs">
            {run.warnings?.slice(0, 2).map((warning, idx) => (
              <li key={idx} className="truncate">
                &bull; {warning}
              </li>
            ))}
            {(run.warnings?.length ?? 0) > 2 && (
              <li className="text-muted-foreground/70">
                &bull;{" "}
                {t("connect:syncHistory.andMore", { count: (run.warnings?.length ?? 0) - 2 })}
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
