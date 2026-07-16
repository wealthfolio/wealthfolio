import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@wealthfolio/ui/components/ui/tooltip";
import { formatDistanceToNow } from "date-fns";
import { useTranslation } from "react-i18next";
import { useWealthfolioConnect } from "../providers/wealthfolio-connect-provider";
import { hasBrokerSync } from "../lib/plan-capabilities";
import { useAggregatedSyncStatus, useSyncBrokerData } from "../hooks";
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

  const tooltipContent = lastSyncTime
    ? t("connect:status.lastSynced", {
        time: formatDistanceToNow(new Date(lastSyncTime), { addSuffix: true }),
      })
    : t("connect:status.neverSynced");

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size={size}
          onClick={() => syncBrokerData()}
          disabled={isRunning}
          className={className}
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
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        <p>{isRunning ? t("connect:sync.syncingShort") : tooltipContent}</p>
      </TooltipContent>
    </Tooltip>
  );
}
