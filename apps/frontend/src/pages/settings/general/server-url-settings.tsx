import { Button } from "@wealthfolio/ui/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@wealthfolio/ui/components/ui/card";
import { Input } from "@wealthfolio/ui/components/ui/input";
import { Label } from "@wealthfolio/ui/components/ui/label";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsContext } from "@/lib/settings-provider";

function isValidServerUrl(value: string): boolean {
  if (!value.trim()) return true; // Empty is valid (means default)
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function ServerUrlSettings() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useSettingsContext();
  const [serverUrl, setServerUrl] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [hasChanged, setHasChanged] = useState(false);

  useEffect(() => {
    if (settings) {
      setServerUrl(settings.serverUrl || "");
      setHasChanged(false);
    }
  }, [settings]);

  const handleChange = (value: string) => {
    setServerUrl(value);
    setHasChanged(value !== (settings?.serverUrl || ""));
  };

  const handleSave = async () => {
    const trimmed = serverUrl.trim();

    if (trimmed && !isValidServerUrl(trimmed)) {
      toast({
        title: t("common:error"),
        description:
          t("settings:server_url_invalid") ||
          "Please enter a valid URL (e.g. https://your-server.com)",
        variant: "destructive",
      });
      return;
    }

    // Normalize: remove trailing slash
    const normalized = trimmed.replace(/\/+$/, "");

    setIsSaving(true);
    try {
      await updateSettings({ serverUrl: normalized });
      setHasChanged(false);
      toast({
        title: t("settings:settings_saved") || "Settings saved",
        description:
          t("settings:server_url_saved") ||
          (normalized
            ? `Server URL set to ${normalized}. Restart may be required for all features.`
            : "Server URL reset to default. Restart may be required."),
        variant: "success",
        duration: 3000,
      });
    } catch (error) {
      toast({
        title: t("common:error") || "Error",
        description:
          t("settings:server_url_error") || "Failed to save server URL",
        variant: "destructive",
      });
      console.error("Failed to save server URL:", error);
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = async () => {
    setServerUrl("");
    setIsSaving(true);
    try {
      await updateSettings({ serverUrl: "" });
      setHasChanged(false);
      toast({
        title: t("settings:settings_saved") || "Settings saved",
        description:
          t("settings:server_url_reset") || "Server URL reset to default",
        variant: "success",
      });
    } catch (error) {
      toast({
        title: t("common:error") || "Error",
        description:
          t("settings:server_url_error") || "Failed to save server URL",
        variant: "destructive",
      });
      console.error("Failed to reset server URL:", error);
    } finally {
      setIsSaving(false);
    }
  };

  if (!settings) return null;

  const isValid = isValidServerUrl(serverUrl);
  const showReset = Boolean(settings.serverUrl);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">
          {t("settings:server_url_title") || "Server URL"}
        </CardTitle>
        <CardDescription>
          {t("settings:server_url_description") ||
            "Configure a custom server URL for self-hosting. Leave empty to use Wealthfolio's hosted server (https://api.wealthfolio.app). Requires app restart to fully apply."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="server-url" className="text-sm font-medium">
            {t("settings:server_url_label") || "Custom Server URL"}
          </Label>
          <div className="flex gap-2">
            <Input
              id="server-url"
              type="url"
              placeholder="https://your-server.com"
              value={serverUrl}
              onChange={(e) => handleChange(e.target.value)}
              className={!isValid ? "border-destructive" : ""}
            />
            <Button
              onClick={handleSave}
              disabled={!hasChanged || !isValid || isSaving}
              variant="default"
            >
              {isSaving
                ? t("common:saving") || "Saving..."
                : t("common:save") || "Save"}
            </Button>
            {showReset && (
              <Button
                onClick={handleReset}
                disabled={isSaving}
                variant="outline"
              >
                {t("common:reset") || "Reset"}
              </Button>
            )}
          </div>
          {!isValid && (
            <p className="text-destructive text-xs">
              {t("settings:server_url_invalid") ||
                "Please enter a valid URL starting with http:// or https://"}
            </p>
          )}
          {serverUrl && isValid && (
            <p className="text-muted-foreground text-xs">
              {t("settings:server_url_hint") ||
                "Example: https://api.example.com or http://localhost:3000"}
            </p>
          )}
        </div>
        <div className="bg-muted/50 rounded-lg p-3">
          <p className="text-muted-foreground text-xs">
            <strong>
              {t("settings:server_url_current") || "Current effective URL:"}
            </strong>{" "}
            {settings.serverUrl
              ? settings.serverUrl
              : "https://api.wealthfolio.app (default)"}
          </p>
          {settings.serverUrl && (
            <p className="text-muted-foreground mt-1 text-xs">
              {t("settings:server_url_restart_note") ||
                "Restart the app after changing the server URL to ensure all services use the new URL."}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
