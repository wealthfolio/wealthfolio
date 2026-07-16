import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Switch } from "@wealthfolio/ui/components/ui/switch";
import { useMcpServer } from "../hooks/use-mcp-server";
import { McpHero } from "./mcp-hero";

/** Master feature toggle for AI Agent Access — gates the rest of the page. */
export function McpModuleCard() {
  const { t } = useTranslation();
  const { status, isLoading, setEnabledMutation } = useMcpServer();
  const enabled = status?.enabled ?? false;
  const running = status?.running ?? false;

  return (
    <McpHero
      active={enabled}
      title={
        enabled
          ? running
            ? t("settings:agentAccess.desktop_title_running")
            : t("settings:agentAccess.desktop_title_enabled")
          : t("settings:agentAccess.desktop_title_off")
      }
      description={
        enabled
          ? t("settings:agentAccess.desktop_description_enabled")
          : t("settings:agentAccess.desktop_description_off")
      }
      hint={t("settings:agentAccess.desktop_hint")}
      action={
        <label className="flex shrink-0 cursor-pointer select-none items-center gap-2">
          <span className="text-background/55 hidden text-xs font-medium uppercase tracking-widest sm:inline">
            {enabled
              ? t("settings:agentAccess.enabled_label")
              : t("settings:agentAccess.disabled_label")}
          </span>
          <Switch
            checked={enabled}
            onCheckedChange={(next) => setEnabledMutation.mutate(next)}
            disabled={isLoading || setEnabledMutation.isPending}
            className={cn(
              "data-[state=checked]:bg-warning data-[state=unchecked]:bg-background/15",
              "[&_[data-slot=switch-thumb]]:data-[state=checked]:bg-foreground",
              "[&_[data-slot=switch-thumb]]:data-[state=unchecked]:bg-background/40",
            )}
          />
        </label>
      }
    />
  );
}
