import { formatDistanceToNow } from "@/lib/utils";
import { useLocalizationSettings } from "@wealthfolio/ui";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@wealthfolio/ui/components/ui/tooltip";
import { useTranslation } from "react-i18next";
import { useAggregatedSyncStatus, useSyncBrokerData } from "../hooks";
import { hasBrokerSync } from "../lib/plan-capabilities";
import { useWealthfolioConnect } from "../providers/wealthfolio-connect-provider";
import type { AggregatedSyncStatus } from "../types";

interface SyncButtonProps {
  /** Optional class name for the button */
  className?: string;
  /** Show label text alongside icon */
  showLabel?: boolean;
  /** Button size */
  size?: "default" | "sm" | "icon";
}

const statusColors: Record<AggregatedSyncStatus, string> = {
  not_connected: "text-muted-foreground",
  restoring: "text-muted-foreground",
  unavailable: "text-warning",
  subscription_required: "text-warning",
  idle: "text-green-500",
  running: "text-blue-500",
  needs_review: "text-yellow-500",
  failed: "text-red-500",
};

/**
 * Contextual sync button that shows sync status and triggers sync.
 * Only visible when Connect is enabled and user has an active subscription.
 */
export function SyncButton({ className, showLabel = false, size = "icon" }: SyncButtonProps) {
  const localizationSettings = useLocalizationSettings();

  const { t } = useTranslation();
  const { isEnabled, isConnected, userInfo } = useWealthfolioConnect();
  const { status, lastSyncTime } = useAggregatedSyncStatus();
  const { mutate: syncBrokerData, isPending: isSyncing } = useSyncBrokerData();

  // Only show when Connect is enabled, connected, and plan includes broker sync
  if (!isEnabled || !isConnected || !hasBrokerSync(userInfo)) {
    return null;
  }

  const isRunning = status === "running" || isSyncing;
  const colorClass = statusColors[status];

  // Without a completed sync time (e.g. every latest attempt failed), name the
  // current state rather than claiming it never synced.
  const tooltipContent = lastSyncTime
    ? t("connect:status.lastSynced", {
        time: formatDistanceToNow(new Date(lastSyncTime), localizationSettings, {
          addSuffix: true,
        }),
      })
    : isRunning
      ? t("connect:status.syncingEllipsis")
      : status === "failed"
        ? t("connect:status.failed")
        : status === "needs_review"
          ? t("connect:status.needsReview")
          : t("connect:status.neverSynced");

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size={size}
            onClick={() => syncBrokerData()}
            disabled={isRunning}
            className={className}
          />
        }
      >
        {isRunning ? (
          <Icons.Spinner className="h-4 w-4 animate-spin" />
        ) : (
          <Icons.RefreshCw className={`h-4 w-4 ${colorClass}`} />
        )}
        {showLabel && (
          <span className="ml-2">
            {isRunning ? t("connect:sync.syncingShort") : t("connect:sync.sync")}
          </span>
        )}
      </TooltipTrigger>
      <TooltipContent>
        <p>{isRunning ? t("connect:sync.syncingShort") : tooltipContent}</p>
      </TooltipContent>
    </Tooltip>
  );
}
