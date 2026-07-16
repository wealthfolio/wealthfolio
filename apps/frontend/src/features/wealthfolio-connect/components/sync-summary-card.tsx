import { Badge } from "@wealthfolio/ui/components/ui/badge";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@wealthfolio/ui/components/ui/card";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { formatDistanceToNow } from "date-fns";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { AggregatedSyncStatus } from "../types";

interface SyncSummaryCardProps {
  status: AggregatedSyncStatus;
  lastSyncTime: string | null;
  issueCount: number;
  isLoading: boolean;
  onSyncAll: () => void;
  isSyncing: boolean;
}

function buildStatusConfig(
  t: TFunction,
): Record<
  AggregatedSyncStatus,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> {
  return {
    not_connected: { label: t("connect:status.notConnected"), variant: "secondary" },
    idle: { label: t("connect:status.upToDate"), variant: "default" },
    running: { label: t("connect:status.syncingEllipsis"), variant: "outline" },
    needs_review: { label: t("connect:status.needsReview"), variant: "destructive" },
    failed: { label: t("connect:status.failed"), variant: "destructive" },
  };
}

export function SyncSummaryCard({
  status,
  lastSyncTime,
  issueCount,
  onSyncAll,
  isSyncing,
}: SyncSummaryCardProps) {
  const { t } = useTranslation();
  const statusConfig = useMemo(() => buildStatusConfig(t), [t]);
  const config = statusConfig[status];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-base font-medium">{t("connect:sync.statusTitle")}</CardTitle>
        <Badge variant={config.variant}>{config.label}</Badge>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <p className="text-muted-foreground text-sm">
              {lastSyncTime
                ? t("connect:status.lastSynced", {
                    time: formatDistanceToNow(new Date(lastSyncTime), { addSuffix: true }),
                  })
                : t("connect:status.neverSynced")}
            </p>
            {issueCount > 0 && (
              <p className="text-sm text-yellow-600 dark:text-yellow-400">
                {t("connect:sync.needAttention", { count: issueCount })}
              </p>
            )}
          </div>
          <Button onClick={onSyncAll} disabled={isSyncing || status === "running"} size="sm">
            {isSyncing || status === "running" ? (
              <>
                <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                {t("connect:sync.syncingShort")}
              </>
            ) : (
              <>
                <Icons.RefreshCw className="mr-2 h-4 w-4" />
                {t("connect:sync.syncAll")}
              </>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
