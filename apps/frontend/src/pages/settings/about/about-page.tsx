import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { getAppInfo } from "@/adapters";
import { ExternalLink } from "@/components/external-link";
import { usePlatform } from "@/hooks/use-platform";
import { useCheckForUpdates } from "@/hooks/use-updater";
import { Button } from "@wealthfolio/ui/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@wealthfolio/ui/components/ui/card";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Separator } from "@wealthfolio/ui/components/ui/separator";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";
import { SettingsHeader } from "../settings-header";

export default function AboutSettingsPage() {
  const { t } = useTranslation();
  const [version, setVersion] = useState<string>("");
  const [dbPath, setDbPath] = useState<string>("");
  const [logsDir, setLogsDir] = useState<string>("");
  const { isMobile } = usePlatform();
  const checkUpdateMutation = useCheckForUpdates();

  useEffect(() => {
    // Use unified command for both desktop and web
    if (!isMobile) {
      getAppInfo().then((info) => {
        setVersion(info.version);
        setDbPath(info.dbPath || "");
        setLogsDir(info.logsDir);
      });
    } else {
      // On mobile, only get version
      getAppInfo().then((info) => {
        setVersion(info.version);
        setDbPath(info.dbPath || "");
      });
    }
  }, [isMobile]);

  const handleCheckForUpdates = () => {
    checkUpdateMutation.mutate();
  };

  const isCheckingUpdate = checkUpdateMutation.isPending;

  const handleCopy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast({
        title: t("settings:about_copied"),
        description: t("settings:about_copied_description", { label }),
      });
    } catch (error) {
      toast({
        title: t("settings:about_copy_failed"),
        description: t("settings:about_copy_failed_description", { label: label.toLowerCase() }),
        variant: "destructive",
      });
      console.error("Failed to copy to clipboard:", error);
    }
  };

  return (
    <div className="space-y-6">
      <SettingsHeader heading={t("settings:about_title")} text={t("settings:about_description")} />
      <Separator />

      <Card>
        <CardHeader className="flex flex-row items-center gap-4">
          <img
            src="/logo.svg"
            alt={t("settings:about_logo_alt")}
            className="h-12 w-12 rounded-md shadow"
          />
          <div className="flex flex-col">
            <CardTitle className="text-xl">Wealthfolio</CardTitle>
            <CardDescription>
              {t("settings:about_version", { version: version || "N/A" })}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-4">
            <p className="text-muted-foreground text-sm">{t("settings:about_tagline")}</p>
            <div className="flex flex-wrap items-center gap-2">
              {!isMobile && (
                <Button size="sm" onClick={handleCheckForUpdates} disabled={isCheckingUpdate}>
                  {t("settings:about_check_update_button")}
                </Button>
              )}
              <Button
                asChild
                variant="outline"
                size="sm"
                className="inline-flex items-center gap-2"
              >
                <ExternalLink href="https://wealthfolio.app">
                  <Icons.Globe className="h-4 w-4" />
                  {t("settings:about_website_button")}
                </ExternalLink>
              </Button>
              <Button
                asChild
                variant="outline"
                size="sm"
                className="inline-flex items-center gap-2"
              >
                <ExternalLink href="https://wealthfolio.app/docs/introduction/">
                  <Icons.FileText className="h-4 w-4" />
                  {t("settings:about_docs_button")}
                </ExternalLink>
              </Button>
              <Button
                asChild
                variant="outline"
                size="sm"
                className="inline-flex items-center gap-2"
              >
                <ExternalLink href="https://github.com/wealthfolio/wealthfolio">
                  <Icons.ExternalLink className="h-4 w-4" />
                  {t("settings:about_github_button")}
                </ExternalLink>
              </Button>
            </div>
          </div>

          {!isMobile && (
            <>
              <Separator />

              <div className="grid gap-4">
                <div className="space-y-1">
                  <p className="text-muted-foreground text-xs uppercase tracking-wide">
                    {t("settings:about_db_path")}
                  </p>
                  <div className="flex items-center gap-2">
                    <p className="bg-muted text-muted-foreground flex-1 truncate rounded-md px-3 py-2 font-mono text-xs">
                      {dbPath || t("settings:about_unavailable")}
                    </p>
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={!dbPath}
                      onClick={() => dbPath && handleCopy(dbPath, t("settings:about_db_path"))}
                    >
                      <Icons.Copy className="h-4 w-4" />
                      <span className="sr-only">{t("settings:about_copy_db_path")}</span>
                    </Button>
                  </div>
                </div>
                <div className="space-y-1">
                  <p className="text-muted-foreground text-xs uppercase tracking-wide">
                    {t("settings:about_logs_directory")}
                  </p>
                  <div className="flex items-center gap-2">
                    <p className="bg-muted text-muted-foreground flex-1 truncate rounded-md px-3 py-2 font-mono text-xs">
                      {logsDir || t("settings:about_unavailable")}
                    </p>
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={!logsDir}
                      onClick={() =>
                        logsDir && handleCopy(logsDir, t("settings:about_logs_directory"))
                      }
                    >
                      <Icons.Copy className="h-4 w-4" />
                      <span className="sr-only">{t("settings:about_copy_logs_dir")}</span>
                    </Button>
                  </div>
                </div>
              </div>
            </>
          )}

          <Separator />

          <div className="space-y-4">
            <p className="text-muted-foreground text-sm">
              {t("settings:about_support_message")}{" "}
              <span className="select-all font-mono font-semibold">support@wealthfolio.app</span>
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                asChild
                variant="outline"
                size="sm"
                className="inline-flex items-center gap-2"
              >
                <ExternalLink href="mailto:support@wealthfolio.app">
                  <Icons.ExternalLink className="h-4 w-4" />
                  {t("settings:about_email_button")}
                </ExternalLink>
              </Button>
              <Button
                asChild
                variant="outline"
                size="sm"
                className="inline-flex items-center gap-2"
              >
                <ExternalLink href="https://github.com/wealthfolio/wealthfolio/issues">
                  <Icons.AlertCircle className="h-4 w-4" />
                  {t("settings:about_report_issue_button")}
                </ExternalLink>
              </Button>
            </div>

            <Separator />

            <p className="text-muted-foreground text-sm">
              <ExternalLink
                href="https://wealthfolio.app/legal/privacy-policy"
                className="hover:text-foreground underline underline-offset-4"
              >
                {t("settings:about_privacy_policy")}
              </ExternalLink>
              <span className="mx-2">•</span>
              <ExternalLink
                href="https://wealthfolio.app/legal/terms-of-use"
                className="hover:text-foreground underline underline-offset-4"
              >
                {t("settings:about_terms_of_use")}
              </ExternalLink>
              <span className="mx-2">•</span>
              <ExternalLink
                href="https://wealthfolio.app"
                className="hover:text-foreground underline underline-offset-4"
              >
                {t("settings:about_website_button")}
              </ExternalLink>
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
