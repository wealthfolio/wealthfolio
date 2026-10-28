import { useTranslation } from "react-i18next";
import { getAgentAccessStatus, isTauri, isWeb } from "@/adapters";
import { usePlatform } from "@/hooks/use-platform";
import { QueryKeys } from "@/lib/query-keys";
import { useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@wealthfolio/ui/components/ui/alert";
import { Button } from "@wealthfolio/ui/components/ui/button";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@wealthfolio/ui/components/ui/empty";
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
        heading={t("settings:nav.items.agent_access")}
        text={t("settings:agentAccess.page_text")}
      />
      <Separator />

      {loading ? null : isTauri && isMobile ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Icons.Brain />
            </EmptyMedia>
            <EmptyTitle>{t("settings:agentAccess.mobile_unavailable_title")}</EmptyTitle>
            <EmptyDescription>
              {t("settings:agentAccess.mobile_unavailable_description")}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : isTauri ? (
        <DesktopAgentAccess />
      ) : (
        <WebAgentAccess />
      )}
    </div>
  );
}
