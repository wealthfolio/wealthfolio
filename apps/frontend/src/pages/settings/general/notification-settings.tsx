import { sendTestNotification } from "@/adapters";
import {
  disableWebPush,
  enableWebPush,
  getWebPushStatus,
  type WebPushStatus,
} from "@/lib/web-push";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@wealthfolio/ui/components/ui/card";
import { Label } from "@wealthfolio/ui/components/ui/label";
import { Switch } from "@wealthfolio/ui/components/ui/switch";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

/** Push notifications for this browser. Web server only; the page gates it. */
export function NotificationSettings() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<WebPushStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getWebPushStatus()
      .then((next) => !cancelled && setStatus(next))
      .catch(() => !cancelled && setStatus("unsupported"));
    return () => {
      cancelled = true;
    };
  }, []);

  const handleToggle = async (enabled: boolean) => {
    setBusy(true);
    try {
      const next = enabled ? await enableWebPush() : await disableWebPush();
      setStatus(next);
      if (enabled && next === "denied") {
        toast({
          title: t("settings:notifications_blocked_title"),
          description: t("settings:notifications_blocked_description"),
          variant: "destructive",
        });
      }
    } catch (error) {
      console.error("Failed to change notification setting:", error);
      toast({ title: t("settings:notifications_error_title"), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const handleTest = async () => {
    setBusy(true);
    try {
      await sendTestNotification(
        t("settings:notifications_test_title"),
        t("settings:notifications_test_body"),
      );
    } catch (error) {
      console.error("Failed to send a test notification:", error);
      toast({ title: t("settings:notifications_error_title"), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  if (status === null) return null;

  const description =
    status === "unsupported"
      ? t("settings:notifications_unsupported")
      : status === "denied"
        ? t("settings:notifications_blocked_description")
        : t("settings:notifications_description");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{t("settings:notifications_title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label htmlFor="web-push-enabled" className="text-base">
              {t("settings:notifications_enable")}
            </Label>
            <p className="text-muted-foreground text-xs">{description}</p>
          </div>
          <Switch
            id="web-push-enabled"
            checked={status === "enabled"}
            onCheckedChange={handleToggle}
            disabled={busy || status === "unsupported" || status === "denied"}
          />
        </div>
        {status === "enabled" && (
          <Button variant="outline" size="sm" onClick={handleTest} disabled={busy}>
            {t("settings:notifications_send_test")}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
