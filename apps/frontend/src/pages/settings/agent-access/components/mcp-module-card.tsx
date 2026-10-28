import { useTranslation } from "react-i18next";
import { FeatureStatusBanner } from "../../feature-status-banner";
import { useMcpServer } from "../hooks/use-mcp-server";

/** Master feature toggle for AI agent access — gates the rest of the page. */
export function McpModuleCard() {
  const { t } = useTranslation();
  const { status, isLoading, setEnabledMutation } = useMcpServer();
  const enabled = status?.enabled ?? false;
  const running = status?.running ?? false;

  return (
    <FeatureStatusBanner
      label={t("settings:agentAccess.hero_aria")}
      active={enabled}
      status={
        enabled
          ? running
            ? t("settings:agentAccess.desktop_title_running")
            : t("settings:agentAccess.desktop_title_enabled")
          : t("settings:agentAccess.desktop_title_off")
      }
      headline={
        enabled
          ? t("settings:agentAccess.desktop_description_enabled")
          : t("settings:agentAccess.desktop_description_off")
      }
      note={t("settings:agentAccess.desktop_hint")}
      toggle={{
        checked: enabled,
        onCheckedChange: (next) => setEnabledMutation.mutate(next),
        disabled: isLoading || setEnabledMutation.isPending,
        label: t("settings:nav.items.agent_access"),
        stateLabel: enabled
          ? t("settings:agentAccess.enabled_label")
          : t("settings:agentAccess.disabled_label"),
      }}
    />
  );
}
