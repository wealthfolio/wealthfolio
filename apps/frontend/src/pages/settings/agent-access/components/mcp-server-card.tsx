import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Button } from "@wealthfolio/ui/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@wealthfolio/ui/components/ui/card";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemSeparator,
  ItemTitle,
} from "@wealthfolio/ui/components/ui/item";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Label } from "@wealthfolio/ui/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@wealthfolio/ui/components/ui/popover";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import { Switch } from "@wealthfolio/ui/components/ui/switch";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";
import { buildClientConfig, DEFAULT_PRESET_ID, TOKEN_PLACEHOLDER } from "../mcp-client-config";
import { useMcpServer } from "../hooks/use-mcp-server";
import { ClientSetup, CopyIconButton } from "./client-setup";
import { copyText } from "@wealthfolio/ui/lib/clipboard";

/** Labeled button that copies the default client setup (token placeholder). */
function CopyConfigButton({ serverUrl }: { serverUrl: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await copyText(buildClientConfig(DEFAULT_PRESET_ID, serverUrl));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast({
        title: t("settings:agentAccess.copied_title"),
        description: t("settings:agentAccess.copied_config"),
      });
    } catch (error) {
      toast({
        title: t("settings:agentAccess.copy_failed_title"),
        description: t("settings:agentAccess.copy_failed_config"),
        variant: "destructive",
      });
      console.error("Failed to copy to clipboard:", error);
    }
  };
  return (
    <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={() => void handleCopy()}>
      {copied ? (
        <Icons.Check className="text-success h-3.5 w-3.5" />
      ) : (
        <Icons.Copy className="h-3.5 w-3.5" />
      )}
      {t("settings:agentAccess.copy_config")}
    </Button>
  );
}

/** Help popover: how to connect, then a client picker with its setup snippet. */
function ConnectHelp({ serverUrl }: { serverUrl: string }) {
  const { t } = useTranslation();
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" />}>
        <Icons.HelpCircle className="text-muted-foreground h-4 w-4" />
        <span className="sr-only">{t("settings:agentAccess.help_aria")}</span>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="max-h-[80vh] w-[28rem] max-w-[calc(100vw-2rem)] space-y-4 overflow-y-auto text-sm"
      >
        <div className="space-y-1.5">
          <p className="font-medium">{t("settings:agentAccess.help_title")}</p>
          <ol className="text-muted-foreground list-decimal space-y-1 ps-4 text-xs">
            <li>{t("settings:agentAccess.help_step_enable")}</li>
            <li>{t("settings:agentAccess.help_step_token")}</li>
            <li>
              {t("settings:agentAccess.help_step_add_prefix")}{" "}
              <span className="font-mono">{TOKEN_PLACEHOLDER}</span>{" "}
              {t("settings:agentAccess.help_step_add_suffix")}
            </li>
          </ol>
        </div>
        <ClientSetup serverUrl={serverUrl} />
      </PopoverContent>
    </Popover>
  );
}

/** A setting row: title and description at the start, its switch at the end. */
function SettingRow({
  id,
  title,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string;
  title: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <Item size="sm" className="px-0">
      <ItemContent>
        <ItemTitle>
          <Label htmlFor={id}>{title}</Label>
        </ItemTitle>
        <ItemDescription className="line-clamp-none">{description}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
      </ItemActions>
    </Item>
  );
}

export function McpServerCard() {
  const { t } = useTranslation();
  const {
    status,
    isLoading,
    isError,
    refetchStatus,
    setAutoStartMutation,
    startMutation,
    stopMutation,
    setAuditEnabledMutation,
  } = useMcpServer();

  if (isError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2} className="text-lg">
            {t("settings:agentAccess.server_card_title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-start gap-3">
            <Icons.AlertTriangle className="text-destructive mt-0.5 h-4 w-4 shrink-0" />
            <p className="text-muted-foreground text-sm">
              {t("settings:agentAccess.server_load_error")}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => void refetchStatus()}>
            {t("common:retry")}
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (isLoading || !status) {
    return (
      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2} className="text-lg">
            {t("settings:agentAccess.server_card_title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-8" />
          <Skeleton className="h-8" />
        </CardContent>
      </Card>
    );
  }

  const serverUrl =
    status.running && status.port ? `http://127.0.0.1:${status.port}/mcp` : undefined;

  return (
    <Card>
      <CardHeader className="max-sm:has-data-[slot=card-action]:grid-cols-1">
        <CardTitle role="heading" aria-level={2} className="flex items-center gap-2 text-lg">
          <span
            className={cn(
              "h-2.5 w-2.5 shrink-0 rounded-full",
              status.running ? "bg-success" : "bg-muted-foreground/40",
            )}
            aria-hidden
          />
          {t("settings:agentAccess.server_card_title")}
        </CardTitle>
        {serverUrl ? (
          <CardDescription className="flex flex-wrap items-center gap-1.5">
            <span className="shrink-0">{t("settings:agentAccess.server_running_at")}</span>
            <code className="bg-muted text-foreground truncate rounded px-1.5 py-0.5 font-mono text-xs">
              {serverUrl}
            </code>
            <CopyIconButton value={serverUrl} label={t("settings:agentAccess.server_url_label")} />
          </CardDescription>
        ) : (
          <CardDescription>{t("settings:agentAccess.server_stopped")}</CardDescription>
        )}
        <CardAction className="flex items-center gap-1.5 max-sm:col-start-1 max-sm:row-span-1 max-sm:row-start-3 max-sm:justify-self-start max-sm:pt-1.5">
          {serverUrl && <CopyConfigButton serverUrl={serverUrl} />}
          {status.running ? (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={stopMutation.isPending}
              onClick={() => stopMutation.mutate()}
            >
              <Icons.Square className="h-3.5 w-3.5" weight="fill" />
              {t("settings:agentAccess.stop")}
            </Button>
          ) : (
            <Button
              size="sm"
              className="gap-1.5"
              disabled={startMutation.isPending}
              onClick={() => startMutation.mutate()}
            >
              <Icons.PlayCircle className="h-3.5 w-3.5" weight="duotone" />
              {t("settings:agentAccess.start")}
            </Button>
          )}
          {serverUrl && <ConnectHelp serverUrl={serverUrl} />}
        </CardAction>
      </CardHeader>
      <CardContent>
        <SettingRow
          id="mcp-auto-start"
          title={t("settings:agentAccess.auto_start_title")}
          description={t("settings:agentAccess.auto_start_description")}
          checked={status.autoStart}
          disabled={setAutoStartMutation.isPending}
          onCheckedChange={(checked) => setAutoStartMutation.mutate(checked)}
        />
        <ItemSeparator />
        <SettingRow
          id="mcp-audit-enabled"
          title={t("settings:agentAccess.audit_title")}
          description={t("settings:agentAccess.audit_description")}
          checked={status.auditEnabled}
          disabled={setAuditEnabledMutation.isPending}
          onCheckedChange={(checked) => setAuditEnabledMutation.mutate(checked)}
        />

        <ItemSeparator />
        <p className="text-muted-foreground pt-3 text-xs">
          {t("settings:agentAccess.server_footer_note")}
        </p>
      </CardContent>
    </Card>
  );
}
