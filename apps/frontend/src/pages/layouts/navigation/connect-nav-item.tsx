import { SyncStatusIcon } from "@/features/wealthfolio-connect/components/sync-status-icon";
import { useAggregatedSyncStatus } from "@/features/wealthfolio-connect/hooks";
import { formatDistanceToNow } from "@/lib/utils";
import { useLocalizationSettings, buttonVariants } from "@wealthfolio/ui";
import { Tooltip, TooltipContent, TooltipTrigger } from "@wealthfolio/ui/components/ui/tooltip";
import { cn } from "@wealthfolio/ui/lib/utils";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router-dom";
import { isPathActive } from "./app-navigation";

interface ConnectNavItemProps {
  collapsed: boolean;
}

export function ConnectNavItem({ collapsed }: ConnectNavItemProps) {
  const localizationSettings = useLocalizationSettings();

  const { t } = useTranslation();
  const location = useLocation();
  const { status, lastSyncTime } = useAggregatedSyncStatus();
  const isActive = isPathActive(location.pathname, "/connect");

  const tooltipContent =
    status === "restoring"
      ? t("connect:session.restoring", { defaultValue: "Restoring Connect…" })
      : status === "unavailable"
        ? t("connect:session.unavailable", { defaultValue: "Connect is temporarily unavailable" })
        : status === "subscription_required"
          ? t("connect:subscription.syncPausedTooltip")
          : lastSyncTime
            ? t("common:layout.connect_last_synced", {
                time: formatDistanceToNow(new Date(lastSyncTime), localizationSettings, {
                  addSuffix: true,
                }),
              })
            : t("common:connect");

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          to="/connect"
          title={tooltipContent}
          aria-label={
            status === "subscription_required" || status === "restoring" || status === "unavailable"
              ? `${t("common:connect")}: ${tooltipContent}`
              : undefined
          }
          aria-current={isActive ? "page" : undefined}
          className={cn(
            buttonVariants({ variant: isActive ? "secondary" : "ghost" }),
            cn(
              "text-foreground [&_svg]:size-5! mb-1 h-12 rounded-md transition-all duration-300",
              collapsed ? "justify-center" : "justify-start",
            ),
          )}
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
      </TooltipTrigger>
      <TooltipContent side="right">{tooltipContent}</TooltipContent>
    </Tooltip>
  );
}
