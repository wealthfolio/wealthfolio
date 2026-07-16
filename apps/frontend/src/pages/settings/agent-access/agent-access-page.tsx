import { useTranslation } from "react-i18next";
import { getAgentAccessStatus, isDesktop, isWeb } from "@/adapters";
import { usePlatform } from "@/hooks/use-platform";
import { QueryKeys } from "@/lib/query-keys";
import { useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@wealthfolio/ui/components/ui/alert";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { EmptyPlaceholder } from "@wealthfolio/ui/components/ui/empty-placeholder";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Separator } from "@wealthfolio/ui/components/ui/separator";
import { SettingsHeader } from "../settings-header";
import { AuditLogTable } from "./components/audit-log-table";
import { McpHero } from "./components/mcp-hero";
import { McpModuleCard } from "./components/mcp-module-card";
import { McpServerCard } from "./components/mcp-server-card";
import { PatTable } from "./components/pat-table";
import { useMcpServer } from "./hooks/use-mcp-server";

function DesktopAgentAccess() {
  const { t } = useTranslation();
  const { status } = useMcpServer();
  const serverUrl =
    status?.running && status.port ? `http://127.0.0.1:${status.port}/mcp` : undefined;

  return (
    <>
      <McpModuleCard />
      {status?.enabled && (
        <>
          <McpServerCard />
          <PatTable serverUrl={serverUrl} />
          <AuditLogTable
            disabledNotice={
              !status.auditEnabled ? t("settings:agentAccess.audit_disabled_desktop") : undefined
            }
          />
        </>
      )}
    </>
  );
}

function WebAgentAccess() {
  const { t } = useTranslation();
  const {
    data: status,
    isError,
    refetch,
  } = useQuery({
    queryKey: [QueryKeys.AGENT_ACCESS_STATUS],
    queryFn: getAgentAccessStatus,
    enabled: isWeb,
  });

  // Full URL (origin + endpoint) for copy-paste configs; endpoint is relative.
  const serverUrl =
    status?.mcpEnabled && typeof window !== "undefined"
      ? new URL(status.endpoint, window.location.origin).toString()
      : undefined;

  return (
    <>
      {isError && (
        <Alert variant="destructive">
          <Icons.AlertTriangle className="h-4 w-4" />
          <AlertTitle>{t("settings:agentAccess.web_status_error_title")}</AlertTitle>
          <AlertDescription className="flex items-center justify-between gap-4">
            <span>{t("settings:agentAccess.web_status_error_description")}</span>
            <Button variant="outline" size="sm" onClick={() => void refetch()}>
              {t("common:retry")}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {status && (
        <McpHero
          active={status.mcpEnabled}
          title={
            status.mcpEnabled
              ? t("settings:agentAccess.web_title_enabled")
              : t("settings:agentAccess.web_title_off")
          }
          description={
            status.mcpEnabled
              ? t("settings:agentAccess.web_description_enabled", { endpoint: status.endpoint })
              : t("settings:agentAccess.web_description_off")
          }
          hint={
            status.mcpEnabled ? undefined : (
              <>
                {t("settings:agentAccess.web_hint_prefix")}{" "}
                <code className="font-mono">WF_MCP_ENABLED=true</code>{" "}
                {t("settings:agentAccess.web_hint_suffix")}
              </>
            )
          }
        />
      )}
      {status?.mcpEnabled && (
        <>
          <PatTable serverUrl={serverUrl} />
          <AuditLogTable
            disabledNotice={
              !status.auditEnabled ? t("settings:agentAccess.audit_disabled_web") : undefined
            }
          />
        </>
      )}
    </>
  );
}

export default function AgentAccessPage() {
  const { t } = useTranslation();
  const { isMobile, loading } = usePlatform();

  return (
    <div className="space-y-6">
      <SettingsHeader
        heading={t("settings:agentAccess.page_heading")}
        text={t("settings:agentAccess.page_text")}
      />
      <Separator />

      {loading ? null : isDesktop && isMobile ? (
        <EmptyPlaceholder>
          <EmptyPlaceholder.Icon name="Brain" />
          <EmptyPlaceholder.Title>
            {t("settings:agentAccess.mobile_unavailable_title")}
          </EmptyPlaceholder.Title>
          <EmptyPlaceholder.Description>
            {t("settings:agentAccess.mobile_unavailable_description")}
          </EmptyPlaceholder.Description>
        </EmptyPlaceholder>
      ) : isDesktop ? (
        <DesktopAgentAccess />
      ) : (
        <WebAgentAccess />
      )}
    </div>
  );
}
