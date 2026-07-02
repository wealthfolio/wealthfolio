import { useEffect, useState } from "react";

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
import { useI18n } from "@/i18n/i18n-provider";
import { SettingsHeader } from "../settings-header";

export default function AboutSettingsPage() {
  const { language } = useI18n();
  const isChinese = language === "zh-CN";
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
        title: isChinese ? "已复制" : "Copied",
        description: isChinese ? `${label} 已复制到剪贴板。` : `${label} copied to clipboard.`,
      });
    } catch (error) {
      toast({
        title: isChinese ? "复制失败" : "Copy failed",
        description: isChinese ? `无法复制 ${label}。` : `Could not copy ${label.toLowerCase()}.`,
        variant: "destructive",
      });
      console.error("Failed to copy to clipboard:", error);
    }
  };

  return (
    <div className="space-y-6">
      <SettingsHeader heading="About" text="Application information" />
      <Separator />

      <Card>
        <CardHeader className="flex flex-row items-center gap-4">
          <img src="/logo.svg" alt="Wealthfolio logo" className="h-12 w-12 rounded-md shadow" />
          <div className="flex flex-col">
            <CardTitle className="text-xl">Wealthfolio</CardTitle>
            <CardDescription>Version {version || "N/A"}</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-4">
            <p className="text-muted-foreground text-sm">
              A beautiful, simple, and secure personal finance and investment tracker that helps you
              take control of your wealth.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {!isMobile && (
                <Button size="sm" onClick={handleCheckForUpdates} disabled={isCheckingUpdate}>
                  Check for Update
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
                  Website
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
                  Docs
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
                  GitHub
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
                    Database path
                  </p>
                  <div className="flex items-center gap-2">
                    <p className="bg-muted text-muted-foreground flex-1 truncate rounded-md px-3 py-2 font-mono text-xs">
                      {dbPath || "Unavailable"}
                    </p>
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={!dbPath}
                      onClick={() => dbPath && handleCopy(dbPath, "Database path")}
                    >
                      <Icons.Copy className="h-4 w-4" />
                      <span className="sr-only">Copy database path</span>
                    </Button>
                  </div>
                </div>
                <div className="space-y-1">
                  <p className="text-muted-foreground text-xs uppercase tracking-wide">
                    Logs directory
                  </p>
                  <div className="flex items-center gap-2">
                    <p className="bg-muted text-muted-foreground flex-1 truncate rounded-md px-3 py-2 font-mono text-xs">
                      {logsDir || "Unavailable"}
                    </p>
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={!logsDir}
                      onClick={() => logsDir && handleCopy(logsDir, "Logs directory")}
                    >
                      <Icons.Copy className="h-4 w-4" />
                      <span className="sr-only">Copy logs directory</span>
                    </Button>
                  </div>
                </div>
              </div>
            </>
          )}

          <Separator />

          <div className="space-y-4">
            <p className="text-muted-foreground text-sm">
              {isChinese
                ? "有问题或发现了错误？请发送邮件至"
                : "Have questions or found a bug? Please email us at"}{" "}
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
                  Email Us
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
                  Report Issue
                </ExternalLink>
              </Button>
            </div>

            <Separator />

            <p className="text-muted-foreground text-sm">
              <ExternalLink
                href="https://wealthfolio.app/legal/privacy-policy"
                className="hover:text-foreground underline underline-offset-4"
              >
                Privacy Policy
              </ExternalLink>
              <span className="mx-2">•</span>
              <ExternalLink
                href="https://wealthfolio.app/legal/terms-of-use"
                className="hover:text-foreground underline underline-offset-4"
              >
                Terms of Use
              </ExternalLink>
              <span className="mx-2">•</span>
              <ExternalLink
                href="https://wealthfolio.app"
                className="hover:text-foreground underline underline-offset-4"
              >
                Website
              </ExternalLink>
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
