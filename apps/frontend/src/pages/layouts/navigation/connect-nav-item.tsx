import { SyncStatusIcon } from "@/features/wealthfolio-connect/components/sync-status-icon";
import { useAggregatedSyncStatus } from "@/features/wealthfolio-connect/hooks";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@wealthfolio/ui/components/ui/tooltip";
import { cn } from "@wealthfolio/ui/lib/utils";
import { formatDistanceToNow } from "date-fns";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router-dom";
import { isPathActive } from "./app-navigation";

interface ConnectNavItemProps {
  collapsed: boolean;
}

export function ConnectNavItem({ collapsed }: ConnectNavItemProps) {
  const { t } = useTranslation();
  const location = useLocation();
  const { status, lastSyncTime } = useAggregatedSyncStatus();
  const isActive = isPathActive(location.pathname, "/connect");

  const tooltipContent = lastSyncTime
    ? t("common:layout.connect_last_synced", {
        time: formatDistanceToNow(new Date(lastSyncTime), { addSuffix: true }),
      })
    : t("common:connect");

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={isActive ? "secondary" : "ghost"}
          asChild
          className={cn(
            "text-foreground [&_svg]:size-5! mb-1 h-12 rounded-md transition-all duration-300",
            collapsed ? "justify-center" : "justify-start",
          )}
        >
          <Link
            to="/connect"
            title={t("common:connect")}
            aria-current={isActive ? "page" : undefined}
          >
            <span aria-hidden="true">
              <SyncStatusIcon status={status} className="size-5" />
            </span>

            <span
              className={cn({
                "ml-2 flex flex-col items-start transition-opacity delay-100 duration-300 ease-in-out": true,
                "sr-only opacity-0": collapsed,
                "block opacity-100": !collapsed,
              })}
            >
              {t("common:connect")}
            </span>
          </Link>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">{tooltipContent}</TooltipContent>
    </Tooltip>
  );
}
